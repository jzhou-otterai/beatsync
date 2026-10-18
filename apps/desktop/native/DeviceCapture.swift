// beatsync-audio-capture
//
// Reads the "Beatsync" virtual audio device (driver/BeatsyncDriver.c). Apps play into
// its output; the driver loops that back to its input, which this helper reads and
// writes to stdout as interleaved signed 16-bit little-endian PCM.
//
// Usage:
//   beatsync-audio-capture probe              Report whether the device is installed
//   beatsync-audio-capture capture [--route]  Stream PCM. --route makes Beatsync the Mac's
//                                             output while capturing and restores the
//                                             previous output on exit.
//
// stderr carries newline-delimited JSON events for the parent process:
//   {"event":"probe","installed":true,"microphone":"granted"}
//   {"event":"format","sampleRate":48000,"channels":2}
//   {"event":"routed","previousOutput":"MacBook Pro Speakers"}
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

func getProperty<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) -> OSStatus {
    var addr = address(selector)
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
