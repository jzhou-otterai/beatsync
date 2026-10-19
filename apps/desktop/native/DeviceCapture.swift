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
// stdin takes commands, one per line:
//   monitor-offset-ms -20    shift the local copy later (+) or earlier (-) to line it up
//                            with the room by ear; applies immediately
//   delay-ms 450             a new delay for the local copy (the room's buffer changed);
//                            the timing offset stays on top
//
// stderr carries newline-delimited JSON events for the parent process:
//   {"event":"probe","installed":true,"microphone":"granted"}
//   {"event":"format","sampleRate":48000,"channels":2}
//   {"event":"routed","previousOutput":"MacBook Pro Speakers"}
//   {"event":"monitoring","device":"MacBook Pro Speakers","delayMs":450}   (buffer + offset;
//       re-sent whenever delay-ms or monitor-offset-ms changes it)
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

func setProperty<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: T, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> OSStatus {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
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
let monitorOffsetMs: Double = {
    guard let i = args.firstIndex(of: "--offset-ms"), args.index(after: i) < args.endIndex else { return 0 }
    return Double(args[args.index(after: i)]) ?? 0
}()
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
    /// Delay computed from the room's buffer and the speakers' reported latency.
    /// Changes at runtime when the room's buffer does (`delay-ms`).
    private(set) var baseFrames: Int
    /// The user's by-ear timing offset (`monitor-offset-ms`), on top of the base
    private var offsetFrames = 0
    /// Current delay: `baseFrames + offsetFrames`
    private(set) var targetFrames: Int
    private let sampleRate: Double
    /// Local volume (the Beatsync device's volume/mute controls). Only this copy is
    /// scaled; the room always gets full-level audio.
    private var targetGain: Float = 1
    private var currentGain: Float = 1

    func setGain(_ gain: Float) {
        lock.lock(); defer { lock.unlock() }
        targetGain = gain
    }
    private let tolerance: Double

    // Diagnostics (BEATSYNC_DEBUG=1): what actually reached the speakers since the last report
    private var underruns = 0
    private var peakOut: Float = 0
    private var framesOut = 0

    /// Shift playback later (+) or earlier (-) relative to the base delay
    func setOffset(ms: Double) {
        lock.lock(); defer { lock.unlock() }
        let clamped = max(-DelayLine.maxOffsetMs, min(DelayLine.maxOffsetMs, ms))
        offsetFrames = Int(clamped / 1000 * sampleRate)
        retarget()
    }

    /// Change the base delay (the room's buffer changed); the timing offset stays on top
    func setBaseFrames(_ frames: Int) {
        lock.lock(); defer { lock.unlock() }
        baseFrames = max(0, frames)
        retarget()
    }

    /// Apply `baseFrames + offsetFrames` right away instead of waiting for drift correction.
    /// Longer: replay slightly older audio, which the ring still holds, so there's no gap.
    /// Shorter: skip ahead. Caller holds the lock.
    private func retarget() {
        let newTarget = max(0, min(baseFrames + offsetFrames, capacity - 1))
        let delta = newTarget - targetFrames
        targetFrames = newTarget
        guard started else { return } // not playing yet: it'll fill to the new target
        readFrame = min(writeFrame, max(writeFrame - capacity + 1, readFrame - delta))
        fillEma = Double(writeFrame - readFrame)
    }

    /// Snapshot and reset the diagnostic counters
    func takeStats() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let stats: [String: Any] = [
            "event": "monitor-stats", "fillFrames": writeFrame - readFrame, "targetFrames": targetFrames, "baseFrames": baseFrames,
            "started": started, "underruns": underruns, "framesOut": framesOut,
            "peakOut": Double(peakOut), "gain": Double(currentGain), "targetGain": Double(targetGain),
        ]
        underruns = 0; peakOut = 0; framesOut = 0
        return stats
    }

    /// Room for timing offsets in either direction, beyond the base delay
    static let maxOffsetMs = 500.0

    init(targetFrames: Int, sampleRate: Double) {
        baseFrames = targetFrames
        self.targetFrames = targetFrames
        self.sampleRate = sampleRate
        // Room for the longest buffer the app allows (2 s), the largest later-shift the
        // timing offset allows, and a second of headroom, so the delay can grow at runtime
        // without reallocating on the audio thread
        capacity = max(targetFrames, Int(sampleRate * 2)) + Int(sampleRate * (1 + DelayLine.maxOffsetMs / 1000))
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
                if started { underruns += 1 }
                started = false
                out(i, 0, 0)
                continue
            }
            let pos = readFrame % capacity
            // Glide toward the new volume over a few ms so slider moves don't click
            currentGain += (targetGain - currentGain) * 0.005
            let l = ring[pos * 2] * currentGain, r = ring[pos * 2 + 1] * currentGain
            peakOut = max(peakOut, abs(l), abs(r))
            framesOut += 1
            out(i, l, r)
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
            delayLine?.setOffset(ms: monitorOffsetMs)
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
// output). They should feel exactly like the speakers' own volume, so instead of
// scaling audio in software (which would be capped by whatever the speakers are set
// to, on a different curve), Beatsync's volume drives the speakers' hardware volume
// control. Mute and the room volume still apply in software to the local copy only.

/// Elements carrying the speakers' volume: the master control, or else each channel
func volumeElements(_ device: AudioObjectID) -> [AudioObjectPropertyElement] {
    for candidates in [[kAudioObjectPropertyElementMain], [1, 2]] as [[AudioObjectPropertyElement]] {
        let settable = candidates.allSatisfy { element in
            var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioObjectPropertyScopeOutput, mElement: element)
            var isSettable: DarwinBoolean = false
            return AudioObjectHasProperty(device, &addr) && AudioObjectIsPropertySettable(device, &addr, &isSettable) == noErr && isSettable.boolValue
        }
        if settable { return candidates }
    }
    return []
}

func readVolume(_ device: AudioObjectID, element: AudioObjectPropertyElement) -> Float32? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioObjectPropertyScopeOutput, mElement: element)
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    return AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

let speakerVolumeElements = monitorDevice.map(volumeElements) ?? []

func beatsyncVolume() -> Float32 {
    var scalar: Float32 = 1
    _ = getProperty(deviceID, kAudioDevicePropertyVolumeScalar, &scalar, scope: kAudioObjectPropertyScopeOutput)
    return scalar
}

func beatsyncMuted() -> Bool {
    var muted: UInt32 = 0
    _ = getProperty(deviceID, kAudioDevicePropertyMute, &muted, scope: kAudioObjectPropertyScopeOutput)
    return muted != 0
}

// Only the Mac's own volume keys/mute act on the local copy. The room-wide volume is for
// the other devices, so 100% here always means the speakers' own maximum.
func updateLocalGain() {
    guard let delayLine else { return }
    let volume = beatsyncVolume()
    if let monitorDevice, !speakerVolumeElements.isEmpty {
        // Full native range: Beatsync at 100% is the speakers at 100%
        for element in speakerVolumeElements {
            _ = setProperty(monitorDevice, kAudioDevicePropertyVolumeScalar, volume, scope: kAudioObjectPropertyScopeOutput, element: element)
        }
        delayLine.setGain(beatsyncMuted() ? 0 : 1)
    } else {
        // Speakers without a settable volume: scale in software (driver's dB curve)
        delayLine.setGain(beatsyncMuted() ? 0 : volume * volume)
    }
}

if let monitorDevice, delayLine != nil {
    // Start from where the speakers already are, so nothing jumps when streaming starts
    if let current = speakerVolumeElements.first.flatMap({ readVolume(monitorDevice, element: $0) }) {
        _ = setProperty(deviceID, kAudioDevicePropertyVolumeScalar, current, scope: kAudioObjectPropertyScopeOutput)
    }
    updateLocalGain()
    for selector in [kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyMute] {
        var controlAddress = address(selector, kAudioObjectPropertyScopeOutput)
        AudioObjectAddPropertyListenerBlock(deviceID, &controlAddress, DispatchQueue.main) { _, _ in
            updateLocalGain()
        }
    }
}

// How far behind the Mac sounds, as reported in "monitoring" events: the room's buffer
// plus the timing offset. (Internally the delay line's target is that minus the
// speakers' own output latency, which the hardware adds back.) Main queue only.
var monitorBufferMs = monitorDelayMs
var monitorOffsetNowMs = max(-DelayLine.maxOffsetMs, min(DelayLine.maxOffsetMs, monitorOffsetMs))

func emitMonitoring() {
    guard let monitorDevice else { return }
    emit([
        "event": "monitoring",
        "device": stringProperty(monitorDevice, kAudioObjectPropertyName) ?? "this Mac",
        "delayMs": Int((monitorBufferMs + monitorOffsetNowMs).rounded()),
    ])
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
        emitMonitoring()
    } else {
        emit(["event": "error", "code": "monitor-failed", "message": "Couldn't play on this Mac's speakers too (OSStatus \(status))"])
    }
}

// BEATSYNC_DEBUG=1: report every 2s what the local copy is doing (stderr JSON)
var statsTimer: DispatchSourceTimer?
if ProcessInfo.processInfo.environment["BEATSYNC_DEBUG"] == "1", let delayLine {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler { emit(delayLine.takeStats()) }
    timer.resume()
    statsTimer = timer
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

// Read commands from stdin; exit when the parent closes it (e.g. it crashed)
DispatchQueue.global().async {
    while let line = readLine() {
        let parts = line.split(separator: " ")
        if parts.count == 2, parts[0] == "monitor-offset-ms", let value = Double(parts[1]) {
            delayLine?.setOffset(ms: value)
            DispatchQueue.main.async {
                monitorOffsetNowMs = max(-DelayLine.maxOffsetMs, min(DelayLine.maxOffsetMs, value))
                emitMonitoring()
            }
        } else if parts.count == 2, parts[0] == "delay-ms", let value = Double(parts[1]),
                  let monitorDevice, let delayLine {
            // Same computation as at startup: buffer minus the speakers' output latency
            let rate = deviceSampleRate(monitorDevice)
            let targetMs = value - Double(outputLatencyFrames(monitorDevice)) / rate * 1000
            delayLine.setBaseFrames(Int(max(0, targetMs) / 1000 * rate))
            DispatchQueue.main.async {
                monitorBufferMs = value
                emitMonitoring()
            }
        }
    }
    DispatchQueue.main.async {
        AudioDeviceStop(deviceID, procID)
        AudioDeviceDestroyIOProcID(deviceID, procID)
        shutdown()
    }
}

dispatchMain()
