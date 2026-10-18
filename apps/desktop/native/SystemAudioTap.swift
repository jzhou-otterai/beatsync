// beatsync-audio-tap
//
// Captures macOS system audio with a Core Audio process tap (macOS 14.2+) and
// writes it to stdout as interleaved signed 16-bit little-endian PCM.
//
// stderr carries newline-delimited JSON events for the parent process:
//   {"event":"format","sampleRate":48000,"channels":2}
//   {"event":"error","message":"..."}
//
// Usage: beatsync-audio-tap [--mute]
//   --mute   silence the Mac's own speakers while tapping (the Mac becomes a "sender only")
//
// The process exits when stdin closes, so it never outlives the Electron app.

import AudioToolbox
import CoreAudio
import Foundation

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

func fail(_ message: String, _ status: OSStatus = 0) -> Never {
    emit(["event": "error", "message": status == 0 ? message : "\(message) (OSStatus \(status))"])
    exit(1)
}

func getProperty<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) -> OSStatus {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<T>.size)
    return withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, $0) }
}

func defaultOutputDeviceUID() -> String {
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var status = getProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, &deviceID)
    guard status == noErr else { fail("Could not read default output device", status) }
    var uid: Unmanaged<CFString>?
    status = getProperty(deviceID, kAudioDevicePropertyDeviceUID, &uid)
    guard status == noErr, let uid else { fail("Could not read output device UID", status) }
    return uid.takeRetainedValue() as String
}

// MARK: - Setup

guard #available(macOS 14.2, *) else { fail("System audio capture requires macOS 14.2 or later") }

let mute = CommandLine.arguments.contains("--mute")

// Global stereo tap of every process. Excluding nothing is fine: the desktop app
// itself never plays the stream back.
let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.name = "Beatsync System Audio"
tapDescription.isPrivate = true
tapDescription.muteBehavior = mute ? .muted : .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tapDescription, &tapID)
guard status == noErr else { fail("Failed to create process tap — is System Audio Recording permission granted?", status) }

var tapFormat = AudioStreamBasicDescription()
status = getProperty(tapID, kAudioTapPropertyFormat, &tapFormat)
guard status == noErr else { fail("Failed to read tap format", status) }

let isFloat = tapFormat.mFormatFlags & kAudioFormatFlagIsFloat != 0
let isNonInterleaved = tapFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
guard isFloat, tapFormat.mBitsPerChannel == 32 else { fail("Unexpected tap format (expected 32-bit float)") }
let channels = Int(tapFormat.mChannelsPerFrame)

// A tap is read through an aggregate device that contains it. The real output
// device is included as the clock source.
let outputUID = defaultOutputDeviceUID()
let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "Beatsync Tap",
    kAudioAggregateDeviceUIDKey: "gg.beatsync.tap.\(UUID().uuidString)",
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[
        kAudioSubTapDriftCompensationKey: true,
        kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
    ]],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
guard status == noErr else {
    AudioHardwareDestroyProcessTap(tapID)
    fail("Failed to create aggregate device", status)
}

func teardown() {
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
}

// The tap's own format can claim 48kHz while the aggregate actually runs at the
// output device's clock (e.g. 44.1kHz on MacBook speakers). Frames arrive at the
// aggregate's rate, so that is the rate to report.
func aggregateSampleRate() -> Double {
    var rate: Float64 = 0
    let status = getProperty(aggregateID, kAudioDevicePropertyNominalSampleRate, &rate)
    return status == noErr && rate > 0 ? rate : tapFormat.mSampleRate
}

var reportedSampleRate = aggregateSampleRate()
emit(["event": "format", "sampleRate": reportedSampleRate, "channels": channels])

// Re-announce if the rate changes mid-stream (output device switched, rate changed in Audio MIDI Setup)
var rateAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyNominalSampleRate,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
AudioObjectAddPropertyListenerBlock(aggregateID, &rateAddress, DispatchQueue.main) { _, _ in
    let rate = aggregateSampleRate()
    if rate != reportedSampleRate {
        reportedSampleRate = rate
        emit(["event": "format", "sampleRate": rate, "channels": channels])
    }
}

// MARK: - IO

let stdout = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "gg.beatsync.tap.write")
let ioQueue = DispatchQueue(label: "gg.beatsync.tap.io", qos: .userInteractive)

@inline(__always) func toInt16(_ sample: Float) -> Int16 {
    let clamped = max(-1.0, min(1.0, sample))
    return Int16(clamped * 32767.0)
}

var procID: AudioDeviceIOProcID?
status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { _, inputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    guard buffers.count > 0, let first = buffers[0].mData else { return }

    let frames: Int
    var pcm: Data
    if isNonInterleaved {
        // One buffer per channel
        frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
        pcm = Data(count: frames * channels * MemoryLayout<Int16>.size)
        pcm.withUnsafeMutableBytes { raw in
            let out = raw.bindMemory(to: Int16.self)
            for ch in 0..<min(channels, buffers.count) {
                guard let src = buffers[ch].mData?.assumingMemoryBound(to: Float.self) else { continue }
                for i in 0..<frames { out[i * channels + ch] = toInt16(src[i]).littleEndian }
            }
        }
    } else {
        let sampleCount = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
        frames = sampleCount / channels
        let src = first.assumingMemoryBound(to: Float.self)
        pcm = Data(count: sampleCount * MemoryLayout<Int16>.size)
        pcm.withUnsafeMutableBytes { raw in
            let out = raw.bindMemory(to: Int16.self)
            for i in 0..<sampleCount { out[i] = toInt16(src[i]).littleEndian }
        }
    }
    guard frames > 0 else { return }

    writeQueue.async {
        do {
            try stdout.write(contentsOf: pcm)
        } catch {
            // Parent went away
            teardown()
            exit(0)
        }
    }
}
guard status == noErr, let procID else {
    teardown()
    fail("Failed to create IO proc", status)
}

status = AudioDeviceStart(aggregateID, procID)
guard status == noErr else {
    AudioDeviceDestroyIOProcID(aggregateID, procID)
    teardown()
    fail("Failed to start capture", status)
}

func shutdown() -> Never {
    AudioDeviceStop(aggregateID, procID)
    AudioDeviceDestroyIOProcID(aggregateID, procID)
    teardown()
    exit(0)
}

// Exit cleanly on SIGTERM/SIGINT so the tap (and any muting) is released
signal(SIGPIPE, SIG_IGN)
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown() }
    source.resume()
    _ = Unmanaged.passRetained(source) // keep alive
}

// Exit when the parent closes our stdin (e.g. it crashed)
DispatchQueue.global().async {
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { DispatchQueue.main.async { shutdown() } ; return }
    }
}

dispatchMain()
