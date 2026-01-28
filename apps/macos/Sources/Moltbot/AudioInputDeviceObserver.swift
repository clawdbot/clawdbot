import CoreAudio
import Foundation
import OSLog

final class AudioInputDeviceObserver {
    private let logger = Logger(subsystem: "bot.molt", category: "audio.devices")
    private var isActive = false
    private var devicesListener: AudioObjectPropertyListenerBlock?
    private var defaultInputListener: AudioObjectPropertyListenerBlock?

    static func defaultInputDeviceUID() -> String? {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            systemObject,
            &address,
            0,
            nil,
            &size,
            &deviceID)
        guard status == noErr, deviceID != 0 else { return nil }
        return self.deviceUID(for: deviceID)
    }

    static func aliveInputDeviceUIDs() -> Set<String> {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size)
        guard status == noErr, size > 0 else { return [] }

        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var deviceIDs = [AudioObjectID](repeating: 0, count: count)
        status = AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &deviceIDs)
        guard status == noErr else { return [] }

        var output = Set<String>()
        for deviceID in deviceIDs {
            guard self.deviceIsAlive(deviceID) else { continue }
            guard self.deviceHasInput(deviceID) else { continue }
            if let uid = self.deviceUID(for: deviceID) {
                output.insert(uid)
            }
        }
        return output
    }

    static func defaultInputDeviceSummary() -> String {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            systemObject,
            &address,
            0,
            nil,
            &size,
            &deviceID)
        guard status == noErr, deviceID != 0 else {
            return "defaultInput=unknown"
        }
        let uid = self.deviceUID(for: deviceID) ?? "unknown"
        let name = self.deviceName(for: deviceID) ?? "unknown"
        return "defaultInput=\(name) (\(uid))"
    }

    func start(onChange: @escaping @Sendable () -> Void) {
        guard !self.isActive else { return }
        self.isActive = true

        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        let queue = DispatchQueue.main

        var devicesAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let devicesListener: AudioObjectPropertyListenerBlock = { _, _ in
            self.logDefaultInputChange(reason: "devices")
            onChange()
        }
        let devicesStatus = AudioObjectAddPropertyListenerBlock(
            systemObject,
            &devicesAddress,
            queue,
            devicesListener)

        var defaultInputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let defaultInputListener: AudioObjectPropertyListenerBlock = { _, _ in
            self.logDefaultInputChange(reason: "default")
            onChange()
        }
        let defaultStatus = AudioObjectAddPropertyListenerBlock(
            systemObject,
            &defaultInputAddress,
            queue,
            defaultInputListener)

        if devicesStatus != noErr || defaultStatus != noErr {
            self.logger.error("audio device observer install failed devices=\(devicesStatus) default=\(defaultStatus)")
        }

        self.logger.info("audio device observer started (\(Self.defaultInputDeviceSummary(), privacy: .public))")

        self.devicesListener = devicesListener
        self.defaultInputListener = defaultInputListener
    }

    func stop() {
        guard self.isActive else { return }
        self.isActive = false
        let systemObject = AudioObjectID(kAudioObjectSystemObject)

        if let devicesListener {
            var devicesAddress = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDevices,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            _ = AudioObjectRemovePropertyListenerBlock(
                systemObject,
                &devicesAddress,
                DispatchQueue.main,
                devicesListener)
        }

        if let defaultInputListener {
            var defaultInputAddress = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDefaultInputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            _ = AudioObjectRemovePropertyListenerBlock(
                systemObject,
                &defaultInputAddress,
                DispatchQueue.main,
                defaultInputListener)
        }

        self.devicesListener = nil
        self.defaultInputListener = nil
    }

    private static func deviceUID(for deviceID: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var uid: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid)
        guard status == noErr, let uid else { return nil }
        return uid.takeUnretainedValue() as String
    }

    private static func deviceName(for deviceID: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &name)
        guard status == noErr, let name else { return nil }
        return name.takeUnretainedValue() as String
    }

    private static func deviceIsAlive(_ deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &alive)
        return status == noErr && alive != 0
    }

    private static func deviceHasInput(_ deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size)
        guard status == noErr, size > 0 else { return false }

        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size),
            alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let bufferList = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, bufferList)
        guard status == noErr else { return false }

        let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
        return buffers.contains(where: { $0.mNumberChannels > 0 })
    }

    private func logDefaultInputChange(reason: StaticString) {
        self.logger.info("audio input changed (\(reason)) (\(Self.defaultInputDeviceSummary(), privacy: .public))")
    }
}
