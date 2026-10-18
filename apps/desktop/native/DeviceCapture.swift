// beatsync-audio-capture
//
// Reads the "Beatsync" virtual audio device (driver/BeatsyncDriver.c). Apps play into
// its output; the driver loops that back to its input, which this helper reads and
// writes to stdout as interleaved signed 16-bit little-endian PCM.
//
// Usage:
//   beatsync-audio-capture probe              Report whether the device is installed
//   beatsync-audio-capture capture [--route] [--monitor --delay-ms N]
//       Stream PCM. --route makes Beatsync the Mac's output while capturing and restores
//       the previous output on exit. --monitor also plays the audio on the Mac's real
//       output (the one Beatsync replaced), held back by N ms so it lands in sync with
//       the room's speakers. The Beatsync device's volume/mute controls (the Mac's
//       volume keys) scale only this local copy, never what the room hears.
//
// stderr carries newline-delimited JSON events for the parent process:
//   {"event":"probe","installed":true,"microphone":"granted"}
//   {"event":"format","sampleRate":48000,"channels":2}
//   {"event":"routed","previousOutput":"MacBook Pro Speakers"}
//   {"event":"monitoring","device":"MacBook Pro Speakers","delayMs":380}
//   {"event":"error","code":"...","message":"..."}
//
// Capture exits when stdin closes, so it never outlives the Electron app.

import AVFoundation
import CoreAudio
import Foundation

let kDeviceUID = "BeatsyncDevice_UID"

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

func fail(_ code: String, _ message: String, _ status: OSStatus = 0) -> Never {
    emit(["event": "error", "code": code, "message": status == 0 ? message : "\(message) (OSStatus \(status))"])
    exit(1)
}

// MARK: - Core Audio helpers

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func getProperty<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> OSStatus {
    var addr = address(selector, scope)
    var size = UInt32(MemoryLayout<T>.size)
    return withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(objectID, &addr, 0, nil, &size, $0) }
}

func setProperty<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: T) -> OSStatus {
    var addr = address(selector)
    var v = value
    return withUnsafePointer(to: &v) { AudioObjectSetPropertyData(objectID, &addr, 0, nil, UInt32(MemoryLayout<T>.size), $0) }
}

func stringProperty(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var value: Unmanaged<CFString>?
    guard getProperty(objectID, selector, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

func findBeatsyncDevice() -> AudioObjectID? {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devices) == noErr else { return nil }
    return devices.first { stringProperty($0, kAudioDevicePropertyDeviceUID) == kDeviceUID }
}

func defaultOutputDevice() -> AudioObjectID {
    var device = AudioObjectID(kAudioObjectUnknown)
    _ = getProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, &device)
    return device
}

func microphoneStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "undetermined"
    @unknown default: return "undetermined"
    }
}

// MARK: - probe

let args = CommandLine.arguments.dropFirst()
let command = args.first ?? "capture"

if command == "probe" {
    emit(["event": "probe", "installed": findBeatsyncDevice() != nil, "microphone": microphoneStatus()])
    exit(0)
}

guard command == "capture" else { fail("usage", "Unknown command \(command)") }
let route = args.contains("--route")
let monitor = args.contains("--monitor")
let monitorDelayMs: Double = {
    guard let i = args.firstIndex(of: "--delay-ms"), args.index(after: i) < args.endIndex else { return 400 }
    return Double(args[args.index(after: i)]) ?? 400
}()

// MARK: - capture: preconditions

guard let deviceID = findBeatsyncDevice() else {
    fail("not-installed", "The Beatsync audio device isn't installed")
}

// Reading any input device needs Microphone permission. Without it macOS hands us
// silence rather than an error, so check up front and say so.
if microphoneStatus() == "undetermined" {
    let done = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }
    done.wait()
}
guard microphoneStatus() == "granted" else {
    fail("microphone-denied", "Microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone, then start again")
}

// MARK: - capture: routing

var previousOutput: AudioObjectID?
if route {
    let current = defaultOutputDevice()
    if current != deviceID {
        let status = setProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, deviceID)
        if status == noErr {
            previousOutput = current
            emit(["event": "routed", "previousOutput": stringProperty(current, kAudioObjectPropertyName) ?? "previous output"])
        } else {
            emit(["event": "error", "code": "route-failed", "message": "Couldn't switch the Mac's output to Beatsync (OSStatus \(status))"])
        }
    }
}

func restoreOutput() {
    // Only put things back if the user hasn't picked something else in the meantime
    guard let previousOutput, defaultOutputDevice() == deviceID else { return }
    _ = setProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, previousOutput)
}

// MARK: - capture: local playback ("monitor")

/// Single-producer/single-consumer delay line between the Beatsync input (capture
/// queue) and the Mac's real output (its IO thread). Holds audio back by
/// `targetFrames`, and keeps that delay steady against the slow drift between the two
/// devices' clocks by dropping or repeating a single frame now and then (inaudible).
final class DelayLine {
    private var ring: [Float]
    private let capacity: Int
    private var writeFrame = 0
    private var readFrame = 0
    private var started = false
    private var fillEma: Double = 0
    private let lock = NSLock()
    let targetFrames: Int
    /// Local volume (the Beatsync device's volume/mute controls). Only this copy is
    /// scaled; the room always gets full-level audio.
    private var targetGain: Float = 1
    private var currentGain: Float = 1

    func setGain(_ gain: Float) {
        lock.lock(); defer { lock.unlock() }
        targetGain = gain
    }
    private let tolerance: Double

    init(targetFrames: Int, sampleRate: Double) {
        self.targetFrames = targetFrames
        capacity = targetFrames + Int(sampleRate) // a second of headroom
        ring = [Float](repeating: 0, count: capacity * 2)
        tolerance = sampleRate * 0.005 // ±5ms
    }

    func write(_ src: UnsafePointer<Float>, frames: Int) {
        lock.lock(); defer { lock.unlock() }
        for i in 0..<frames {
            let pos = (writeFrame + i) % capacity
            ring[pos * 2] = src[i * 2]
            ring[pos * 2 + 1] = src[i * 2 + 1]
        }
        writeFrame += frames
        // Reader stalled (e.g. output device went away): drop the oldest audio
        if writeFrame - readFrame > capacity { readFrame = writeFrame - targetFrames }
    }

    /// Calls `out(frameIndex, left, right)` for each requested frame
    func read(frames: Int, _ out: (Int, Float, Float) -> Void) {
        lock.lock(); defer { lock.unlock() }
        let available = writeFrame - readFrame
        if !started {
            guard available >= targetFrames else {
                for i in 0..<frames { out(i, 0, 0) }
                return
            }
            started = true
            fillEma = Double(available)
        }

        fillEma += 0.02 * (Double(available) - fillEma)
        var repeatFirst = false
        if fillEma > Double(targetFrames) + tolerance, available > frames {
            readFrame += 1 // running behind: skip one frame
            fillEma -= 1
        } else if fillEma < Double(targetFrames) - tolerance {
            repeatFirst = true // running ahead: hold one frame
            fillEma += 1
        }

        for i in 0..<frames {
            guard readFrame < writeFrame else {
                // Underrun: go quiet and rebuild the full delay before playing again
                started = false
                out(i, 0, 0)
                continue
            }
            let pos = readFrame % capacity
            // Glide toward the new volume over a few ms so slider moves don't click
            currentGain += (targetGain - currentGain) * 0.005
            out(i, ring[pos * 2] * currentGain, ring[pos * 2 + 1] * currentGain)
            if !(repeatFirst && i == 0) { readFrame += 1 }
        }
    }
}

/// Total output latency of a device in frames: hardware + safety offset + IO buffer + stream
func outputLatencyFrames(_ device: AudioObjectID) -> Int {
    var latency: UInt32 = 0, safety: UInt32 = 0, bufferFrames: UInt32 = 0
    _ = getProperty(device, kAudioDevicePropertyLatency, &latency, scope: kAudioObjectPropertyScopeOutput)
    _ = getProperty(device, kAudioDevicePropertySafetyOffset, &safety, scope: kAudioObjectPropertyScopeOutput)
    _ = getProperty(device, kAudioDevicePropertyBufferFrameSize, &bufferFrames)
    return Int(latency + safety + bufferFrames)
}

func deviceSampleRate(_ device: AudioObjectID) -> Float64 {
    var rate: Float64 = 0
    _ = getProperty(device, kAudioDevicePropertyNominalSampleRate, &rate)
    return rate
}

// Where the Mac would be playing if Beatsync weren't there
let monitorDevice: AudioObjectID? = {
    guard monitor else { return nil }
    if let previousOutput { return previousOutput }
    let current = defaultOutputDevice()
    return current != deviceID && current != kAudioObjectUnknown ? current : nil
}()

var delayLine: DelayLine?
if let monitorDevice {
    // Run Beatsync at the speakers' rate so frames pass straight through, no resampling
    let speakerRate = deviceSampleRate(monitorDevice)
    if speakerRate == 44100 || speakerRate == 48000 {
        if deviceSampleRate(deviceID) != speakerRate {
            _ = setProperty(deviceID, kAudioDevicePropertyNominalSampleRate, speakerRate)
            for _ in 0..<20 where deviceSampleRate(deviceID) != speakerRate { usleep(50_000) }
        }
        if deviceSampleRate(deviceID) == speakerRate {
            let targetMs = monitorDelayMs - Double(outputLatencyFrames(monitorDevice)) / speakerRate * 1000
            delayLine = DelayLine(targetFrames: max(0, Int(targetMs / 1000 * speakerRate)), sampleRate: speakerRate)
        }
    }
    if delayLine == nil {
        emit(["event": "error", "code": "monitor-unsupported", "message": "Can't play on this Mac too: its output runs at \(Int(speakerRate)) Hz (Beatsync supports 44.1 and 48 kHz)"])
    }
}

// MARK: - capture: format

func nominalSampleRate() -> Float64 {
    var rate: Float64 = 0
    _ = getProperty(deviceID, kAudioDevicePropertyNominalSampleRate, &rate)
    return rate
}

let channels = 2
var reportedSampleRate = nominalSampleRate()
emit(["event": "format", "sampleRate": reportedSampleRate, "channels": channels])

var rateAddress = address(kAudioDevicePropertyNominalSampleRate)
AudioObjectAddPropertyListenerBlock(deviceID, &rateAddress, DispatchQueue.main) { _, _ in
    let rate = nominalSampleRate()
    if rate != reportedSampleRate {
        reportedSampleRate = rate
        emit(["event": "format", "sampleRate": rate, "channels": channels])
    }
}

// MARK: - capture: IO

let stdout = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "gg.beatsync.capture.write")
let ioQueue = DispatchQueue(label: "gg.beatsync.capture.io", qos: .userInteractive)

func shutdown() -> Never {
    stopMonitor()
    restoreOutput()
    exit(0)
}

@inline(__always) func toInt16(_ sample: Float) -> Int16 {
    Int16(max(-1.0, min(1.0, sample)) * 32767.0)
}

var procID: AudioDeviceIOProcID?
var status = AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, ioQueue) { _, inputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    guard buffers.count > 0, let raw = buffers[0].mData else { return }

    // The driver's stream is interleaved stereo float32
    let sampleCount = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
    guard sampleCount > 0 else { return }
    let src = raw.assumingMemoryBound(to: Float.self)
    delayLine?.write(src, frames: sampleCount / 2)
    var pcm = Data(count: sampleCount * MemoryLayout<Int16>.size)
    pcm.withUnsafeMutableBytes { out in
        let dst = out.bindMemory(to: Int16.self)
        for i in 0..<sampleCount { dst[i] = toInt16(src[i]).littleEndian }
    }

    writeQueue.async {
        do {
            try stdout.write(contentsOf: pcm)
        } catch {
            DispatchQueue.main.async { shutdown() } // parent went away
        }
    }
}
guard status == noErr, let procID else {
    restoreOutput()
    fail("io-failed", "Couldn't open the Beatsync device", status)
}

status = AudioDeviceStart(deviceID, procID)
guard status == noErr else {
    restoreOutput()
    fail("io-failed", "Couldn't start reading the Beatsync device", status)
}

// The Mac's volume keys / Sound menu act on the Beatsync device (it's the default
// output). Mirror those controls onto the local copy only.
func localGain() -> Float {
    var scalar: Float32 = 1
    var muted: UInt32 = 0
    _ = getProperty(deviceID, kAudioDevicePropertyVolumeScalar, &scalar, scope: kAudioObjectPropertyScopeOutput)
    _ = getProperty(deviceID, kAudioDevicePropertyMute, &muted, scope: kAudioObjectPropertyScopeOutput)
    return muted != 0 ? 0 : scalar * scalar // same curve as the driver's dB mapping
}

if let delayLine {
    delayLine.setGain(localGain())
    for selector in [kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyMute] {
        var controlAddress = address(selector, kAudioObjectPropertyScopeOutput)
        AudioObjectAddPropertyListenerBlock(deviceID, &controlAddress, DispatchQueue.main) { _, _ in
            delayLine.setGain(localGain())
        }
    }
}

// Play the delayed copy on the Mac's real output
let monitorQueue = DispatchQueue(label: "gg.beatsync.capture.monitor", qos: .userInteractive)
var monitorProcID: AudioDeviceIOProcID?
if let monitorDevice, let delayLine {
    let status = AudioDeviceCreateIOProcIDWithBlock(&monitorProcID, monitorDevice, monitorQueue) { _, _, _, outputData, _ in
        let buffers = UnsafeMutableAudioBufferListPointer(outputData)
        guard buffers.count > 0 else { return }
        // Interleaved (one buffer, N channels) or one buffer per channel; either way float32
        let interleavedChannels = Int(buffers[0].mNumberChannels)
        let frames = Int(buffers[0].mDataByteSize) / (MemoryLayout<Float>.size * max(1, interleavedChannels))
        let left = buffers[0].mData?.assumingMemoryBound(to: Float.self)
        let right = buffers.count > 1 ? buffers[1].mData?.assumingMemoryBound(to: Float.self) : nil
        delayLine.read(frames: frames) { i, l, r in
            if buffers.count == 1, let left {
                left[i * interleavedChannels] = l
                if interleavedChannels > 1 { left[i * interleavedChannels + 1] = r }
            } else {
                left?[i] = l
                right?[i] = r
            }
        }
    }
    if status == noErr, let monitorProcID, AudioDeviceStart(monitorDevice, monitorProcID) == noErr {
        let delayMs = Int(Double(delayLine.targetFrames) / deviceSampleRate(monitorDevice) * 1000)
        emit(["event": "monitoring", "device": stringProperty(monitorDevice, kAudioObjectPropertyName) ?? "this Mac", "delayMs": delayMs])
    } else {
        emit(["event": "error", "code": "monitor-failed", "message": "Couldn't play on this Mac's speakers too (OSStatus \(status))"])
    }
}

func stopMonitor() {
    guard let monitorDevice, let monitorProcID else { return }
    AudioDeviceStop(monitorDevice, monitorProcID)
    AudioDeviceDestroyIOProcID(monitorDevice, monitorProcID)
}

// Exit cleanly on SIGTERM/SIGINT so the previous output is restored
signal(SIGPIPE, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        AudioDeviceStop(deviceID, procID)
        AudioDeviceDestroyIOProcID(deviceID, procID)
        shutdown()
    }
    source.resume()
    signalSources.append(source)
}

// Exit when the parent closes our stdin (e.g. it crashed)
DispatchQueue.global().async {
    while !FileHandle.standardInput.availableData.isEmpty {}
    DispatchQueue.main.async {
        AudioDeviceStop(deviceID, procID)
        AudioDeviceDestroyIOProcID(deviceID, procID)
        shutdown()
    }
}

dispatchMain()
