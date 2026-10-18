// Beatsync virtual audio device (Core Audio AudioServerPlugIn).
//
// Publishes a stereo output device named "Beatsync". Whatever macOS plays to it is
// looped back to the device's input stream, where the Beatsync Speaker app reads it
// and streams it to the room. The Mac's real speakers are never touched: users pick
// "Beatsync" as the output (system-wide or per app), the same way they'd pick AirPlay.
//
// Object tree:
//   kObjectID_PlugIn (1)
//   └── kObjectID_Device (2)
//       ├── kObjectID_Stream_Input (3)   loopback of what was played
//       └── kObjectID_Stream_Output (4)  what apps play into
//
// The device clock is derived from the host clock (mach_absolute_time), and audio
// passes through a ring buffer indexed by sample time. Everything here runs inside
// coreaudiod, so it stays small and avoids allocation on the IO path.

#include <CoreAudio/AudioServerPlugIn.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <string.h>

#pragma mark - Constants

enum {
    kObjectID_PlugIn = kAudioObjectPlugInObject,
    kObjectID_Device = 2,
    kObjectID_Stream_Input = 3,
    kObjectID_Stream_Output = 4,
};

#define kPlugIn_BundleID "gg.beatsync.driver"
#define kDevice_Name "Beatsync"
#define kDevice_Manufacturer "Beatsync"
#define kDevice_UID "BeatsyncDevice_UID"
#define kDevice_ModelUID "BeatsyncDevice_ModelUID"

#define kChannels 2
#define kBytesPerSample sizeof(Float32)
#define kBytesPerFrame (kChannels * kBytesPerSample)
// One zero-timestamp period; also the ring buffer length (~340ms at 48kHz)
#define kRingFrames 16384

static const Float64 kSupportedSampleRates[] = {44100.0, 48000.0};
#define kNumSupportedSampleRates (sizeof(kSupportedSampleRates) / sizeof(kSupportedSampleRates[0]))

#pragma mark - State

static pthread_mutex_t gStateMutex = PTHREAD_MUTEX_INITIALIZER;
static AudioServerPlugInHostRef gHost = NULL;
static _Atomic UInt32 gRefCount = 0;

static Float64 gSampleRate = 48000.0;
static bool gInputActive = true;
static bool gOutputActive = true;

// IO clock
static UInt32 gIOClientCount = 0;
static Float64 gHostTicksPerFrame = 0;
static UInt64 gAnchorHostTime = 0;
static UInt64 gNumberTimeStamps = 0;

// Loopback ring buffer, indexed by sample time modulo kRingFrames. Only touched on
// the device's IO thread (one per device in coreaudiod), so it needs no lock.
static Float32 gRing[kRingFrames * kChannels];
// Sample time one past the last frame written by WriteMix; reads beyond it (or more
// than a ring length behind it) return silence instead of replaying stale audio.
static Float64 gWriteEndSampleTime = 0;

#pragma mark - Helpers

static void UpdateHostTicksPerFrame(void) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    Float64 hostTicksPerSecond = 1.0e9 * (Float64)timebase.denom / (Float64)timebase.numer;
    gHostTicksPerFrame = hostTicksPerSecond / gSampleRate;
}

static bool IsSupportedSampleRate(Float64 rate) {
    for (UInt32 i = 0; i < kNumSupportedSampleRates; i++) {
        if (kSupportedSampleRates[i] == rate) return true;
    }
    return false;
}

static AudioStreamBasicDescription MakeFormat(Float64 sampleRate) {
    AudioStreamBasicDescription f = {0};
    f.mSampleRate = sampleRate;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
    f.mBytesPerPacket = kBytesPerFrame;
    f.mFramesPerPacket = 1;
    f.mBytesPerFrame = kBytesPerFrame;
    f.mChannelsPerFrame = kChannels;
    f.mBitsPerChannel = 32;
    return f;
}

#define RETURN_IF_TOO_SMALL(type)                                                   \
    if (inDataSize < sizeof(type)) return kAudioHardwareBadPropertySizeError;

#pragma mark - Forward declarations

static HRESULT Driver_QueryInterface(void* inDriver, REFIID inUUID, LPVOID* outInterface);
static ULONG Driver_AddRef(void* inDriver);
static ULONG Driver_Release(void* inDriver);
static OSStatus Driver_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost);
static OSStatus Driver_CreateDevice(AudioServerPlugInDriverRef, CFDictionaryRef, const AudioServerPlugInClientInfo*, AudioObjectID*);
static OSStatus Driver_DestroyDevice(AudioServerPlugInDriverRef, AudioObjectID);
static OSStatus Driver_AddDeviceClient(AudioServerPlugInDriverRef, AudioObjectID, const AudioServerPlugInClientInfo*);
static OSStatus Driver_RemoveDeviceClient(AudioServerPlugInDriverRef, AudioObjectID, const AudioServerPlugInClientInfo*);
static OSStatus Driver_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef, AudioObjectID, UInt64, void*);
static OSStatus Driver_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef, AudioObjectID, UInt64, void*);
static Boolean Driver_HasProperty(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*);
static OSStatus Driver_IsPropertySettable(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, Boolean*);
static OSStatus Driver_GetPropertyDataSize(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, UInt32, const void*, UInt32*);
static OSStatus Driver_GetPropertyData(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, UInt32, const void*, UInt32, UInt32*, void*);
static OSStatus Driver_SetPropertyData(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, UInt32, const void*, UInt32, const void*);
static OSStatus Driver_StartIO(AudioServerPlugInDriverRef, AudioObjectID, UInt32);
static OSStatus Driver_StopIO(AudioServerPlugInDriverRef, AudioObjectID, UInt32);
static OSStatus Driver_GetZeroTimeStamp(AudioServerPlugInDriverRef, AudioObjectID, UInt32, Float64*, UInt64*, UInt64*);
static OSStatus Driver_WillDoIOOperation(AudioServerPlugInDriverRef, AudioObjectID, UInt32, UInt32, Boolean*, Boolean*);
static OSStatus Driver_BeginIOOperation(AudioServerPlugInDriverRef, AudioObjectID, UInt32, UInt32, UInt32, const AudioServerPlugInIOCycleInfo*);
static OSStatus Driver_DoIOOperation(AudioServerPlugInDriverRef, AudioObjectID, AudioObjectID, UInt32, UInt32, UInt32, const AudioServerPlugInIOCycleInfo*, void*, void*);
static OSStatus Driver_EndIOOperation(AudioServerPlugInDriverRef, AudioObjectID, UInt32, UInt32, UInt32, const AudioServerPlugInIOCycleInfo*);

static AudioServerPlugInDriverInterface gDriverInterface = {
    NULL,
    Driver_QueryInterface,
    Driver_AddRef,
    Driver_Release,
    Driver_Initialize,
    Driver_CreateDevice,
    Driver_DestroyDevice,
    Driver_AddDeviceClient,
    Driver_RemoveDeviceClient,
    Driver_PerformDeviceConfigurationChange,
    Driver_AbortDeviceConfigurationChange,
    Driver_HasProperty,
    Driver_IsPropertySettable,
    Driver_GetPropertyDataSize,
    Driver_GetPropertyData,
    Driver_SetPropertyData,
    Driver_StartIO,
    Driver_StopIO,
    Driver_GetZeroTimeStamp,
    Driver_WillDoIOOperation,
    Driver_BeginIOOperation,
    Driver_DoIOOperation,
    Driver_EndIOOperation,
};
static AudioServerPlugInDriverInterface* gDriverInterfacePtr = &gDriverInterface;
static AudioServerPlugInDriverRef gDriverRef = &gDriverInterfacePtr;

#pragma mark - Factory

// Named in Info.plist under CFPlugInFactories
void* BeatsyncDriver_Create(CFAllocatorRef inAllocator, CFUUIDRef inRequestedTypeUUID) {
    (void)inAllocator;
    if (CFEqual(inRequestedTypeUUID, kAudioServerPlugInTypeUUID)) {
        return gDriverRef;
    }
    return NULL;
}

#pragma mark - IUnknown

static HRESULT Driver_QueryInterface(void* inDriver, REFIID inUUID, LPVOID* outInterface) {
    if (inDriver != gDriverRef || outInterface == NULL) return kAudioHardwareBadObjectError;

    CFUUIDRef requested = CFUUIDCreateFromUUIDBytes(NULL, inUUID);
    HRESULT result = E_NOINTERFACE;
    if (CFEqual(requested, IUnknownUUID) || CFEqual(requested, kAudioServerPlugInDriverInterfaceUUID)) {
        atomic_fetch_add(&gRefCount, 1);
        *outInterface = gDriverRef;
        result = S_OK;
    }
    CFRelease(requested);
    return result;
}

static ULONG Driver_AddRef(void* inDriver) {
    if (inDriver != gDriverRef) return 0;
    return atomic_fetch_add(&gRefCount, 1) + 1;
}

static ULONG Driver_Release(void* inDriver) {
    if (inDriver != gDriverRef) return 0;
    UInt32 current = atomic_load(&gRefCount);
    if (current == 0) return 0;
    return atomic_fetch_sub(&gRefCount, 1) - 1;
}

#pragma mark - Basic operations

static OSStatus Driver_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost) {
    if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
    gHost = inHost;
    UpdateHostTicksPerFrame();
    return kAudioHardwareNoError;
}

static OSStatus Driver_CreateDevice(AudioServerPlugInDriverRef d, CFDictionaryRef desc, const AudioServerPlugInClientInfo* ci, AudioObjectID* out) {
    (void)d; (void)desc; (void)ci; (void)out;
    return kAudioHardwareUnsupportedOperationError;
}

static OSStatus Driver_DestroyDevice(AudioServerPlugInDriverRef d, AudioObjectID id) {
    (void)d; (void)id;
    return kAudioHardwareUnsupportedOperationError;
}

static OSStatus Driver_AddDeviceClient(AudioServerPlugInDriverRef d, AudioObjectID id, const AudioServerPlugInClientInfo* ci) {
    (void)ci;
    if (d != gDriverRef) return kAudioHardwareBadObjectError;
    if (id != kObjectID_Device) return kAudioHardwareBadObjectError;
    return kAudioHardwareNoError;
}

static OSStatus Driver_RemoveDeviceClient(AudioServerPlugInDriverRef d, AudioObjectID id, const AudioServerPlugInClientInfo* ci) {
    (void)ci;
    if (d != gDriverRef) return kAudioHardwareBadObjectError;
    if (id != kObjectID_Device) return kAudioHardwareBadObjectError;
    return kAudioHardwareNoError;
}

// Sample rate changes go through RequestDeviceConfigurationChange; the new rate is
// carried in inChangeAction and applied here while IO is stopped.
static OSStatus Driver_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef d, AudioObjectID id, UInt64 inChangeAction, void* inChangeInfo) {
    (void)inChangeInfo;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;
    Float64 newRate = (Float64)inChangeAction;
    if (!IsSupportedSampleRate(newRate)) return kAudioDeviceUnsupportedFormatError;

    pthread_mutex_lock(&gStateMutex);
    gSampleRate = newRate;
    UpdateHostTicksPerFrame();
    pthread_mutex_unlock(&gStateMutex);
    return kAudioHardwareNoError;
}

static OSStatus Driver_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef d, AudioObjectID id, UInt64 a, void* i) {
    (void)d; (void)id; (void)a; (void)i;
    return kAudioHardwareNoError;
}

static OSStatus RequestSampleRate(Float64 newRate) {
    if (!IsSupportedSampleRate(newRate)) return kAudioDeviceUnsupportedFormatError;
    if (newRate == gSampleRate) return kAudioHardwareNoError;
    return gHost->RequestDeviceConfigurationChange(gHost, kObjectID_Device, (UInt64)newRate, NULL);
}

#pragma mark - Property dispatch

static bool IsStream(AudioObjectID id) {
    return id == kObjectID_Stream_Input || id == kObjectID_Stream_Output;
}

static Boolean Driver_HasProperty(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress* addr) {
    (void)pid;
    if (d != gDriverRef || addr == NULL) return false;
    switch (id) {
        case kObjectID_PlugIn:
            switch (addr->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioObjectPropertyManufacturer:
                case kAudioObjectPropertyOwnedObjects:
                case kAudioPlugInPropertyBundleID:
                case kAudioPlugInPropertyDeviceList:
                case kAudioPlugInPropertyTranslateUIDToDevice:
                case kAudioPlugInPropertyResourceBundle:
                    return true;
            }
            return false;

        case kObjectID_Device:
            switch (addr->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioObjectPropertyName:
                case kAudioObjectPropertyManufacturer:
                case kAudioObjectPropertyOwnedObjects:
                case kAudioDevicePropertyDeviceUID:
                case kAudioDevicePropertyModelUID:
                case kAudioDevicePropertyTransportType:
                case kAudioDevicePropertyRelatedDevices:
                case kAudioDevicePropertyClockDomain:
                case kAudioDevicePropertyDeviceIsAlive:
                case kAudioDevicePropertyDeviceIsRunning:
                case kAudioDevicePropertyDeviceCanBeDefaultDevice:
                case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
                case kAudioDevicePropertyLatency:
                case kAudioDevicePropertyStreams:
                case kAudioObjectPropertyControlList:
                case kAudioDevicePropertySafetyOffset:
                case kAudioDevicePropertyNominalSampleRate:
                case kAudioDevicePropertyAvailableNominalSampleRates:
                case kAudioDevicePropertyIsHidden:
                case kAudioDevicePropertyPreferredChannelsForStereo:
                case kAudioDevicePropertyZeroTimeStampPeriod:
                    return true;
            }
            return false;

        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output:
            switch (addr->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioObjectPropertyOwnedObjects:
                case kAudioStreamPropertyIsActive:
                case kAudioStreamPropertyDirection:
                case kAudioStreamPropertyTerminalType:
                case kAudioStreamPropertyStartingChannel:
                case kAudioStreamPropertyLatency:
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat:
                case kAudioStreamPropertyAvailableVirtualFormats:
                case kAudioStreamPropertyAvailablePhysicalFormats:
                    return true;
            }
            return false;
    }
    return false;
}

static OSStatus Driver_IsPropertySettable(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress* addr, Boolean* outIsSettable) {
    if (!Driver_HasProperty(d, id, pid, addr)) return kAudioHardwareUnknownPropertyError;
    if (outIsSettable == NULL) return kAudioHardwareIllegalOperationError;

    *outIsSettable = false;
    if (id == kObjectID_Device && addr->mSelector == kAudioDevicePropertyNominalSampleRate) {
        *outIsSettable = true;
    } else if (IsStream(id)) {
        switch (addr->mSelector) {
            case kAudioStreamPropertyIsActive:
            case kAudioStreamPropertyVirtualFormat:
            case kAudioStreamPropertyPhysicalFormat:
                *outIsSettable = true;
                break;
        }
    }
    return kAudioHardwareNoError;
}

// Streams owned by the device in the requested scope
static UInt32 DeviceStreams(AudioObjectPropertyScope scope, AudioObjectID* out) {
    UInt32 n = 0;
    if (scope == kAudioObjectPropertyScopeGlobal || scope == kAudioObjectPropertyScopeInput) out[n++] = kObjectID_Stream_Input;
    if (scope == kAudioObjectPropertyScopeGlobal || scope == kAudioObjectPropertyScopeOutput) out[n++] = kObjectID_Stream_Output;
    return n;
}

static OSStatus Driver_GetPropertyDataSize(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress* addr, UInt32 qs, const void* qd, UInt32* outDataSize) {
    (void)qs; (void)qd;
    if (!Driver_HasProperty(d, id, pid, addr)) return kAudioHardwareUnknownPropertyError;
    if (outDataSize == NULL) return kAudioHardwareIllegalOperationError;

    AudioObjectID streams[2];
    switch (addr->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
            *outDataSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwner:
            *outDataSize = sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyName:
        case kAudioObjectPropertyManufacturer:
        case kAudioPlugInPropertyBundleID:
        case kAudioPlugInPropertyResourceBundle:
        case kAudioDevicePropertyDeviceUID:
        case kAudioDevicePropertyModelUID:
            *outDataSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwnedObjects:
            if (id == kObjectID_PlugIn) *outDataSize = sizeof(AudioObjectID);
            else if (id == kObjectID_Device) *outDataSize = DeviceStreams(addr->mScope, streams) * sizeof(AudioObjectID);
            else *outDataSize = 0;
            return kAudioHardwareNoError;
        case kAudioPlugInPropertyDeviceList:
        case kAudioPlugInPropertyTranslateUIDToDevice:
        case kAudioDevicePropertyRelatedDevices:
            *outDataSize = sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyStreams:
            *outDataSize = DeviceStreams(addr->mScope, streams) * sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyControlList:
            *outDataSize = 0;
            return kAudioHardwareNoError;
        case kAudioDevicePropertyNominalSampleRate:
            *outDataSize = sizeof(Float64);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyAvailableNominalSampleRates:
            *outDataSize = kNumSupportedSampleRates * sizeof(AudioValueRange);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyPreferredChannelsForStereo:
            *outDataSize = 2 * sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyVirtualFormat:
        case kAudioStreamPropertyPhysicalFormat:
            *outDataSize = sizeof(AudioStreamBasicDescription);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyAvailableVirtualFormats:
        case kAudioStreamPropertyAvailablePhysicalFormats:
            *outDataSize = kNumSupportedSampleRates * sizeof(AudioStreamRangedDescription);
            return kAudioHardwareNoError;
        default:
            // Everything else is a UInt32
            *outDataSize = sizeof(UInt32);
            return kAudioHardwareNoError;
    }
}

static OSStatus GetPlugInProperty(const AudioObjectPropertyAddress* addr, UInt32 qs, const void* qd, UInt32 inDataSize, UInt32* outSize, void* out) {
    switch (addr->mSelector) {
        case kAudioObjectPropertyBaseClass:
            RETURN_IF_TOO_SMALL(AudioClassID);
            *(AudioClassID*)out = kAudioObjectClassID;
            *outSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyClass:
            RETURN_IF_TOO_SMALL(AudioClassID);
            *(AudioClassID*)out = kAudioPlugInClassID;
            *outSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwner:
            RETURN_IF_TOO_SMALL(AudioObjectID);
            *(AudioObjectID*)out = kAudioObjectUnknown;
            *outSize = sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyManufacturer:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR(kDevice_Manufacturer);
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioPlugInPropertyBundleID:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR(kPlugIn_BundleID);
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioPlugInPropertyResourceBundle:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR("");
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwnedObjects:
        case kAudioPlugInPropertyDeviceList:
            *outSize = 0;
            if (inDataSize >= sizeof(AudioObjectID)) {
                *(AudioObjectID*)out = kObjectID_Device;
                *outSize = sizeof(AudioObjectID);
            }
            return kAudioHardwareNoError;
        case kAudioPlugInPropertyTranslateUIDToDevice: {
            RETURN_IF_TOO_SMALL(AudioObjectID);
            if (qs != sizeof(CFStringRef) || qd == NULL) return kAudioHardwareBadPropertySizeError;
            CFStringRef uid = *(const CFStringRef*)qd;
            *(AudioObjectID*)out = (uid && CFStringCompare(uid, CFSTR(kDevice_UID), 0) == kCFCompareEqualTo)
                                       ? kObjectID_Device
                                       : kAudioObjectUnknown;
            *outSize = sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        }
    }
    return kAudioHardwareUnknownPropertyError;
}

static OSStatus GetDeviceProperty(const AudioObjectPropertyAddress* addr, UInt32 inDataSize, UInt32* outSize, void* out) {
    AudioObjectID streams[2];
    switch (addr->mSelector) {
        case kAudioObjectPropertyBaseClass:
            RETURN_IF_TOO_SMALL(AudioClassID);
            *(AudioClassID*)out = kAudioObjectClassID;
            *outSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyClass:
            RETURN_IF_TOO_SMALL(AudioClassID);
            *(AudioClassID*)out = kAudioDeviceClassID;
            *outSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwner:
            RETURN_IF_TOO_SMALL(AudioObjectID);
            *(AudioObjectID*)out = kObjectID_PlugIn;
            *outSize = sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyName:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR(kDevice_Name);
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyManufacturer:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR(kDevice_Manufacturer);
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyDeviceUID:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR(kDevice_UID);
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyModelUID:
            RETURN_IF_TOO_SMALL(CFStringRef);
            *(CFStringRef*)out = CFSTR(kDevice_ModelUID);
            *outSize = sizeof(CFStringRef);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwnedObjects:
        case kAudioDevicePropertyStreams: {
            UInt32 n = DeviceStreams(addr->mScope, streams);
            UInt32 fit = inDataSize / sizeof(AudioObjectID);
            if (fit < n) n = fit;
            memcpy(out, streams, n * sizeof(AudioObjectID));
            *outSize = n * sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        }
        case kAudioObjectPropertyControlList:
            *outSize = 0;
            return kAudioHardwareNoError;
        case kAudioDevicePropertyTransportType:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = kAudioDeviceTransportTypeVirtual;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyRelatedDevices:
            *outSize = 0;
            if (inDataSize >= sizeof(AudioObjectID)) {
                *(AudioObjectID*)out = kObjectID_Device;
                *outSize = sizeof(AudioObjectID);
            }
            return kAudioHardwareNoError;
        case kAudioDevicePropertyClockDomain:
        case kAudioDevicePropertyLatency:
        case kAudioDevicePropertySafetyOffset:
        case kAudioDevicePropertyIsHidden:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = 0;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyDeviceIsAlive:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = 1;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyDeviceIsRunning:
            RETURN_IF_TOO_SMALL(UInt32);
            pthread_mutex_lock(&gStateMutex);
            *(UInt32*)out = gIOClientCount > 0 ? 1 : 0;
            pthread_mutex_unlock(&gStateMutex);
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyDeviceCanBeDefaultDevice:
            // An output for apps to play into; never offered as the default microphone
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = addr->mScope == kAudioObjectPropertyScopeInput ? 0 : 1;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
            // Keep alert sounds on the real speakers
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = 0;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyNominalSampleRate:
            RETURN_IF_TOO_SMALL(Float64);
            pthread_mutex_lock(&gStateMutex);
            *(Float64*)out = gSampleRate;
            pthread_mutex_unlock(&gStateMutex);
            *outSize = sizeof(Float64);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyAvailableNominalSampleRates: {
            UInt32 n = inDataSize / sizeof(AudioValueRange);
            if (n > kNumSupportedSampleRates) n = kNumSupportedSampleRates;
            AudioValueRange* ranges = (AudioValueRange*)out;
            for (UInt32 i = 0; i < n; i++) {
                ranges[i].mMinimum = kSupportedSampleRates[i];
                ranges[i].mMaximum = kSupportedSampleRates[i];
            }
            *outSize = n * sizeof(AudioValueRange);
            return kAudioHardwareNoError;
        }
        case kAudioDevicePropertyPreferredChannelsForStereo:
            if (inDataSize < 2 * sizeof(UInt32)) return kAudioHardwareBadPropertySizeError;
            ((UInt32*)out)[0] = 1;
            ((UInt32*)out)[1] = 2;
            *outSize = 2 * sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioDevicePropertyZeroTimeStampPeriod:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = kRingFrames;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
    }
    return kAudioHardwareUnknownPropertyError;
}

static OSStatus GetStreamProperty(AudioObjectID id, const AudioObjectPropertyAddress* addr, UInt32 inDataSize, UInt32* outSize, void* out) {
    bool isInput = id == kObjectID_Stream_Input;
    switch (addr->mSelector) {
        case kAudioObjectPropertyBaseClass:
            RETURN_IF_TOO_SMALL(AudioClassID);
            *(AudioClassID*)out = kAudioObjectClassID;
            *outSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyClass:
            RETURN_IF_TOO_SMALL(AudioClassID);
            *(AudioClassID*)out = kAudioStreamClassID;
            *outSize = sizeof(AudioClassID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwner:
            RETURN_IF_TOO_SMALL(AudioObjectID);
            *(AudioObjectID*)out = kObjectID_Device;
            *outSize = sizeof(AudioObjectID);
            return kAudioHardwareNoError;
        case kAudioObjectPropertyOwnedObjects:
            *outSize = 0;
            return kAudioHardwareNoError;
        case kAudioStreamPropertyIsActive:
            RETURN_IF_TOO_SMALL(UInt32);
            pthread_mutex_lock(&gStateMutex);
            *(UInt32*)out = isInput ? gInputActive : gOutputActive;
            pthread_mutex_unlock(&gStateMutex);
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyDirection:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = isInput ? 1 : 0;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyTerminalType:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = isInput ? kAudioStreamTerminalTypeLine : kAudioStreamTerminalTypeSpeaker;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyStartingChannel:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = 1;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyLatency:
            RETURN_IF_TOO_SMALL(UInt32);
            *(UInt32*)out = 0;
            *outSize = sizeof(UInt32);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyVirtualFormat:
        case kAudioStreamPropertyPhysicalFormat:
            RETURN_IF_TOO_SMALL(AudioStreamBasicDescription);
            pthread_mutex_lock(&gStateMutex);
            *(AudioStreamBasicDescription*)out = MakeFormat(gSampleRate);
            pthread_mutex_unlock(&gStateMutex);
            *outSize = sizeof(AudioStreamBasicDescription);
            return kAudioHardwareNoError;
        case kAudioStreamPropertyAvailableVirtualFormats:
        case kAudioStreamPropertyAvailablePhysicalFormats: {
            UInt32 n = inDataSize / sizeof(AudioStreamRangedDescription);
            if (n > kNumSupportedSampleRates) n = kNumSupportedSampleRates;
            AudioStreamRangedDescription* formats = (AudioStreamRangedDescription*)out;
            for (UInt32 i = 0; i < n; i++) {
                formats[i].mFormat = MakeFormat(kSupportedSampleRates[i]);
                formats[i].mSampleRateRange.mMinimum = kSupportedSampleRates[i];
                formats[i].mSampleRateRange.mMaximum = kSupportedSampleRates[i];
            }
            *outSize = n * sizeof(AudioStreamRangedDescription);
            return kAudioHardwareNoError;
        }
    }
    return kAudioHardwareUnknownPropertyError;
}

static OSStatus Driver_GetPropertyData(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress* addr, UInt32 qs, const void* qd, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
    if (!Driver_HasProperty(d, id, pid, addr)) return kAudioHardwareUnknownPropertyError;
    if (outDataSize == NULL || outData == NULL) return kAudioHardwareIllegalOperationError;

    switch (id) {
        case kObjectID_PlugIn: return GetPlugInProperty(addr, qs, qd, inDataSize, outDataSize, outData);
        case kObjectID_Device: return GetDeviceProperty(addr, inDataSize, outDataSize, outData);
        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output: return GetStreamProperty(id, addr, inDataSize, outDataSize, outData);
    }
    return kAudioHardwareBadObjectError;
}

static OSStatus Driver_SetPropertyData(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress* addr, UInt32 qs, const void* qd, UInt32 inDataSize, const void* inData) {
    (void)qs; (void)qd;
    if (!Driver_HasProperty(d, id, pid, addr)) return kAudioHardwareUnknownPropertyError;
    if (inData == NULL) return kAudioHardwareIllegalOperationError;

    if (id == kObjectID_Device && addr->mSelector == kAudioDevicePropertyNominalSampleRate) {
        RETURN_IF_TOO_SMALL(Float64);
        return RequestSampleRate(*(const Float64*)inData);
    }

    if (IsStream(id)) {
        switch (addr->mSelector) {
            case kAudioStreamPropertyIsActive: {
                RETURN_IF_TOO_SMALL(UInt32);
                bool active = *(const UInt32*)inData != 0;
                pthread_mutex_lock(&gStateMutex);
                bool* target = id == kObjectID_Stream_Input ? &gInputActive : &gOutputActive;
                bool changed = *target != active;
                *target = active;
                pthread_mutex_unlock(&gStateMutex);
                if (changed) {
                    AudioObjectPropertyAddress changedAddr = {kAudioStreamPropertyIsActive, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
                    gHost->PropertiesChanged(gHost, id, 1, &changedAddr);
                }
                return kAudioHardwareNoError;
            }
            case kAudioStreamPropertyVirtualFormat:
            case kAudioStreamPropertyPhysicalFormat: {
                RETURN_IF_TOO_SMALL(AudioStreamBasicDescription);
                const AudioStreamBasicDescription* f = (const AudioStreamBasicDescription*)inData;
                if (f->mFormatID != kAudioFormatLinearPCM || f->mChannelsPerFrame != kChannels || f->mBitsPerChannel != 32 ||
                    !(f->mFormatFlags & kAudioFormatFlagIsFloat)) {
                    return kAudioDeviceUnsupportedFormatError;
                }
                return RequestSampleRate(f->mSampleRate);
            }
        }
    }
    return kAudioHardwareUnknownPropertyError;
}

#pragma mark - IO

static OSStatus Driver_StartIO(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 clientID) {
    (void)clientID;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;

    pthread_mutex_lock(&gStateMutex);
    if (gIOClientCount == 0) {
        gNumberTimeStamps = 0;
        gAnchorHostTime = mach_absolute_time();
        gWriteEndSampleTime = 0;
        memset(gRing, 0, sizeof(gRing));
    }
    gIOClientCount++;
    pthread_mutex_unlock(&gStateMutex);
    return kAudioHardwareNoError;
}

static OSStatus Driver_StopIO(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 clientID) {
    (void)clientID;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;

    pthread_mutex_lock(&gStateMutex);
    if (gIOClientCount > 0) gIOClientCount--;
    pthread_mutex_unlock(&gStateMutex);
    return kAudioHardwareNoError;
}

// The device clock ticks once per kRingFrames frames of host time.
static OSStatus Driver_GetZeroTimeStamp(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 clientID, Float64* outSampleTime, UInt64* outHostTime, UInt64* outSeed) {
    (void)clientID;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;

    pthread_mutex_lock(&gStateMutex);
    UInt64 now = mach_absolute_time();
    Float64 ticksPerPeriod = gHostTicksPerFrame * (Float64)kRingFrames;
    UInt64 nextPeriodHostTime = gAnchorHostTime + (UInt64)((Float64)(gNumberTimeStamps + 1) * ticksPerPeriod);
    if (nextPeriodHostTime <= now) gNumberTimeStamps++;

    *outSampleTime = (Float64)(gNumberTimeStamps * kRingFrames);
    *outHostTime = gAnchorHostTime + (UInt64)((Float64)gNumberTimeStamps * ticksPerPeriod);
    *outSeed = 1;
    pthread_mutex_unlock(&gStateMutex);
    return kAudioHardwareNoError;
}

static OSStatus Driver_WillDoIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 clientID, UInt32 op, Boolean* outWillDo, Boolean* outWillDoInPlace) {
    (void)clientID;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;
    bool willDo = op == kAudioServerPlugInIOOperationReadInput || op == kAudioServerPlugInIOOperationWriteMix;
    if (outWillDo) *outWillDo = willDo;
    if (outWillDoInPlace) *outWillDoInPlace = true;
    return kAudioHardwareNoError;
}

static OSStatus Driver_BeginIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 c, UInt32 op, UInt32 frames, const AudioServerPlugInIOCycleInfo* info) {
    (void)c; (void)op; (void)frames; (void)info;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;
    return kAudioHardwareNoError;
}

static OSStatus Driver_EndIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 c, UInt32 op, UInt32 frames, const AudioServerPlugInIOCycleInfo* info) {
    (void)c; (void)op; (void)frames; (void)info;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;
    return kAudioHardwareNoError;
}

static OSStatus Driver_DoIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, AudioObjectID streamID, UInt32 clientID, UInt32 op, UInt32 frames, const AudioServerPlugInIOCycleInfo* info, void* ioMainBuffer, void* ioSecondaryBuffer) {
    (void)clientID; (void)ioSecondaryBuffer;
    if (d != gDriverRef || id != kObjectID_Device) return kAudioHardwareBadObjectError;
    if (ioMainBuffer == NULL || frames == 0) return kAudioHardwareNoError;
    Float32* buffer = (Float32*)ioMainBuffer;

    if (op == kAudioServerPlugInIOOperationWriteMix && streamID == kObjectID_Stream_Output) {
        // Apps' mixed output for this cycle → ring buffer at its output sample time
        Float64 start = info->mOutputTime.mSampleTime;
        if (start < 0) return kAudioHardwareNoError;
        UInt64 pos = (UInt64)start % kRingFrames;
        UInt32 first = frames;
        if (pos + first > kRingFrames) first = (UInt32)(kRingFrames - pos);
        memcpy(&gRing[pos * kChannels], buffer, first * kBytesPerFrame);
        memcpy(&gRing[0], buffer + first * kChannels, (frames - first) * kBytesPerFrame);
        gWriteEndSampleTime = start + frames;
    } else if (op == kAudioServerPlugInIOOperationReadInput && streamID == kObjectID_Stream_Input) {
        // Loopback: hand readers what was played at this (earlier) sample time
        Float64 start = info->mInputTime.mSampleTime;
        Float64 writeEnd = gWriteEndSampleTime;
        for (UInt32 i = 0; i < frames; i++) {
            Float64 t = start + i;
            bool fresh = t >= 0 && t < writeEnd && t >= writeEnd - kRingFrames;
            UInt64 pos = fresh ? (UInt64)t % kRingFrames : 0;
            for (UInt32 ch = 0; ch < kChannels; ch++) {
                buffer[i * kChannels + ch] = fresh ? gRing[pos * kChannels + ch] : 0.0f;
            }
        }
    }
    return kAudioHardwareNoError;
}
