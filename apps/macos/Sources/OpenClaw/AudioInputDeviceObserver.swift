import CoreAudio
import Foundation
import OSLog

struct AudioInputDeviceDescriptor: Equatable, Identifiable, Sendable {
    let uid: String
    let name: String

    var id: String {
        self.uid
    }
}

struct AudioInputDeviceResolution: Equatable, Sendable {
    let selectedUID: String?
    let resolvedUID: String?
    let fellBackToSystemDefault: Bool

    var shouldBindSelectedDevice: Bool {
        self.selectedUID != nil && !self.fellBackToSystemDefault && self.resolvedUID != nil
    }

    func shouldRestart(availableUIDs: Set<String>, defaultUID: String?) -> Bool {
        guard let resolvedUID, availableUIDs.contains(resolvedUID) else { return true }
        guard self.selectedUID == nil || self.fellBackToSystemDefault else { return false }
        return defaultUID != resolvedUID
    }
}

enum AudioInputDeviceSelectionResolver {
    static func resolve(
        selectedUID: String?,
        availableUIDs: Set<String>,
        defaultUID: String?) -> AudioInputDeviceResolution
    {
        let selected = selectedUID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSelection = selected?.isEmpty == false ? selected : nil
        let usableDefault = defaultUID.flatMap { availableUIDs.contains($0) ? $0 : nil }

        guard let normalizedSelection else {
            return AudioInputDeviceResolution(
                selectedUID: nil,
                resolvedUID: usableDefault,
                fellBackToSystemDefault: false)
        }
        if availableUIDs.contains(normalizedSelection) {
            return AudioInputDeviceResolution(
                selectedUID: normalizedSelection,
                resolvedUID: normalizedSelection,
                fellBackToSystemDefault: false)
        }
        return AudioInputDeviceResolution(
            selectedUID: normalizedSelection,
            resolvedUID: usableDefault,
            fellBackToSystemDefault: true)
    }
}

final class AudioInputDeviceObserver: @unchecked Sendable {
    private let logger = Logger(subsystem: "ai.openclaw", category: "audio.devices")
    private var isActive = false
    private var devicesListener: AudioObjectPropertyListenerBlock?
    private var defaultInputListener: AudioObjectPropertyListenerBlock?

    static func defaultInputDeviceUID() -> String? {
        guard let deviceID = self.defaultInputDeviceID() else { return nil }
        return self.deviceUID(for: deviceID)
    }

    static func aliveInputDeviceUIDs() -> Set<String> {
        var output = Set<String>()
        for deviceID in self.deviceIDs() {
            guard self.deviceIsAlive(deviceID) else { continue }
            guard self.deviceHasInput(deviceID) else { continue }
            if let uid = self.deviceUID(for: deviceID) {
                output.insert(uid)
            }
        }
        return output
    }

    static func availableInputDevices() -> [AudioInputDeviceDescriptor] {
        self.deviceIDs().compactMap { deviceID in
            guard self.deviceIsAlive(deviceID), self.deviceHasInput(deviceID) else { return nil }
            guard let uid = self.deviceUID(for: deviceID), let name = self.deviceName(for: deviceID) else { return nil }
            return AudioInputDeviceDescriptor(uid: uid, name: name)
        }.sorted { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    static func inputDeviceID(forUID uid: String) -> AudioObjectID? {
        self.deviceIDs().first { deviceID in
            self.deviceIsAlive(deviceID) && self.deviceHasInput(deviceID) && self.deviceUID(for: deviceID) == uid
        }
    }

    static func resolveSelection(_ selectedUID: String?) -> AudioInputDeviceResolution {
        AudioInputDeviceSelectionResolver.resolve(
            selectedUID: selectedUID,
            availableUIDs: self.aliveInputDeviceUIDs(),
            defaultUID: self.defaultInputDeviceUID())
    }

    /// Returns true when the system default input device exists and is alive with input channels.
    /// Use this preflight before accessing `AVAudioEngine.inputNode` to avoid SIGABRT on Macs
    /// without a built-in microphone (Mac mini, Mac Pro, Mac Studio) or when an external mic
    /// is disconnected.
    static func hasUsableDefaultInputDevice() -> Bool {
        guard let uid = self.defaultInputDeviceUID() else { return false }
        return self.aliveInputDeviceUIDs().contains(uid)
    }

    static func defaultInputDeviceSummary() -> String {
        guard let deviceID = self.defaultInputDeviceID() else {
            return "defaultInput=unknown"
        }
        let uid = self.deviceUID(for: deviceID) ?? "unknown"
        let name = self.deviceName(for: deviceID) ?? "unknown"
        return "defaultInput=\(name) (\(uid))"
    }

    private static func defaultInputDeviceID() -> AudioObjectID? {
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
        return deviceID
    }

    private static func deviceIDs() -> [AudioObjectID] {
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
        return status == noErr ? deviceIDs : []
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
