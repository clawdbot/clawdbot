import AudioToolbox
@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import OpenClawKit
import OSLog

@MainActor
final class MacRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    private static let frameBufferSize: AVAudioFrameCount = 2048

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime.capture")
    private let selectedInputUID: @MainActor () -> String?
    private let deliveryGate = TalkGenerationDeliveryGate()

    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var audioInputObserver: AudioInputDeviceObserver?
    private var audioOutputObserver: MacRealtimeTalkOutputRouteObserver?
    private var activeInputResolution: AudioInputDeviceResolution?
    private var targetSampleRate: Double?
    private var onAudio: (@Sendable (RealtimeTalkAudioFrame) -> Void)?
    private var onFailure: (@MainActor (String) -> Void)?
    private var tapInstalled = false
    private var suppressInputDuringOutput = true
    private var outputRouteDecisionState = MacRealtimeTalkOutputRouteDecisionState()
    private var outputRouteObservationGeneration: UInt64 = 0
    #if DEBUG
    private var testOutputRouteCallbackHandled: (@Sendable () -> Void)?
    #endif

    var suppressesInputDuringOutput: Bool {
        self.suppressInputDuringOutput
    }

    init(selectedInputUID: @escaping @MainActor () -> String? = {
        AppStateStore.shared.voiceWakeMicID
    }) {
        self.selectedInputUID = selectedInputUID
    }

    @MainActor deinit {
        self.stop()
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        guard targetSampleRate.isFinite, targetSampleRate > 0 else {
            throw MacRealtimeTalkAudioCaptureError.invalidTargetSampleRate
        }

        self.stop()
        self.targetSampleRate = targetSampleRate
        self.onAudio = onAudio
        self.onFailure = onFailure
        self.startOutputRouteObserver()
        do {
            try self.startCaptureEngine(targetSampleRate: targetSampleRate, onAudio: onAudio)
            self.startDeviceObserver()
        } catch {
            self.stop()
            throw error
        }
    }

    func stop() {
        // Close delivery before removing the tap. A callback already running on Core Audio's
        // queue must finish before stop returns, and later callbacks must drop their frames.
        self.deliveryGate.deactivate()
        self.audioInputObserver?.stop()
        self.audioInputObserver = nil
        self.retireOutputRouteObserver()
        self.teardownEngine()
        self.targetSampleRate = nil
        self.onAudio = nil
        self.onFailure = nil
    }

    private func startCaptureEngine(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {
        let selection = AudioInputDeviceObserver.resolveSelection(self.selectedInputUID())
        // AVAudioEngine materializes inputNode from the system default before CurrentDevice can bind.
        // Without a usable default, accessing inputNode can SIGABRT even when another UID is alive.
        guard selection.resolvedUID != nil, AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }

        do {
            try self.configureEngine(
                selection: selection,
                targetSampleRate: targetSampleRate,
                onAudio: onAudio,
                enableVoiceProcessing: true)
        } catch {
            self.logger.warning(
                "realtime processed input setup failed; retrying without voice processing: " +
                    "\(error.localizedDescription, privacy: .public)")
            self.deliveryGate.deactivate()
            self.teardownEngine()
            try self.configureEngine(
                selection: selection,
                targetSampleRate: targetSampleRate,
                onAudio: onAudio,
                enableVoiceProcessing: false)
        }
    }

    private func configureEngine(
        selection: AudioInputDeviceResolution,
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        enableVoiceProcessing: Bool) throws
    {
        let engine = AVAudioEngine()
        self.audioEngine = engine
        let input = engine.inputNode
        self.inputNode = input

        if enableVoiceProcessing {
            try input.setVoiceProcessingEnabled(true)
        }

        let activeResolution = self.bindSelectedInputIfNeeded(selection, to: input)
        guard activeResolution.resolvedUID != nil else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }

        let format = input.outputFormat(forBus: 0)
        guard format.commonFormat == .pcmFormatFloat32,
              !format.isInterleaved,
              format.channelCount > 0,
              format.sampleRate > 0
        else {
            throw MacRealtimeTalkAudioCaptureError.invalidInputFormat
        }

        let deliveryToken = self.deliveryGate.activate()
        input.installTap(
            onBus: 0,
            bufferSize: Self.frameBufferSize,
            format: format,
            block: MacRealtimeTalkTapHandlerFactory.make(
                targetSampleRate: targetSampleRate,
                deliveryGate: self.deliveryGate,
                deliveryToken: deliveryToken,
                onAudio: onAudio))
        self.tapInstalled = true
        engine.prepare()
        try engine.start()
        self.activeInputResolution = activeResolution
    }

    private func bindSelectedInputIfNeeded(
        _ selection: AudioInputDeviceResolution,
        to input: AVAudioInputNode) -> AudioInputDeviceResolution
    {
        guard selection.shouldBindSelectedDevice, let selectedUID = selection.resolvedUID else {
            return selection
        }
        guard let audioUnit = input.audioUnit,
              var deviceID = AudioInputDeviceObserver.inputDeviceID(forUID: selectedUID)
        else {
            self.logger.warning("realtime selected input could not be resolved; using system default")
            return self.defaultFallback(for: selection)
        }

        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioObjectID>.size))
        guard status == noErr else {
            self.logger.warning(
                "realtime selected input binding failed status=\(status); using system default")
            return self.defaultFallback(for: selection)
        }
        self.logger.info(
            "realtime selected input bound uid=\(selectedUID, privacy: .private(mask: .hash))")
        return selection
    }

    private func defaultFallback(
        for selection: AudioInputDeviceResolution) -> AudioInputDeviceResolution
    {
        AudioInputDeviceResolution(
            selectedUID: selection.selectedUID,
            resolvedUID: AudioInputDeviceObserver.resolveSelection(nil).resolvedUID,
            fellBackToSystemDefault: selection.selectedUID != nil)
    }

    private func startDeviceObserver() {
        let observer = AudioInputDeviceObserver()
        observer.start { [weak self] in
            Task { @MainActor [weak self] in
                self?.audioInputDevicesDidChange()
            }
        }
        self.audioInputObserver = observer
    }

    private func startOutputRouteObserver() {
        let observer = MacRealtimeTalkOutputRouteObserver()
        let onChange = self.replaceOutputRouteObserver(observer)
        observer.start(onChange: onChange)
    }

    private func replaceOutputRouteObserver(
        _ observer: MacRealtimeTalkOutputRouteObserver) -> @Sendable (MacRealtimeTalkOutputRoute?) -> Void
    {
        self.outputRouteObservationGeneration &+= 1
        let generation = self.outputRouteObservationGeneration
        self.audioOutputObserver = observer
        #if DEBUG
        let onHandled = self.testOutputRouteCallbackHandled
        self.testOutputRouteCallbackHandled = nil
        #endif
        return { [weak self, observerID = ObjectIdentifier(observer)] route in
            Task { @MainActor [weak self] in
                #if DEBUG
                defer { onHandled?() }
                #endif
                guard let self,
                      generation == self.outputRouteObservationGeneration,
                      self.audioOutputObserver.map(ObjectIdentifier.init) == observerID
                else { return }
                self.updateOutputRoute(route)
            }
        }
    }

    private func retireOutputRouteObserver() {
        self.outputRouteObservationGeneration &+= 1
        self.audioOutputObserver?.stop()
        self.audioOutputObserver = nil
        self.suppressInputDuringOutput = true
        self.outputRouteDecisionState.reset()
    }

    private func updateOutputRoute(_ route: MacRealtimeTalkOutputRoute?) {
        guard let decision = self.outputRouteDecisionState.update(route: route) else { return }
        self.suppressInputDuringOutput = decision.suppressesInputDuringOutput
        self.logger.info(
            "realtime output route decision \(decision.redactedDescription, privacy: .public)")
    }

    private func audioInputDevicesDidChange() {
        guard let targetSampleRate, let onAudio else { return }
        let desiredResolution = AudioInputDeviceObserver.resolveSelection(self.selectedInputUID())
        guard desiredResolution != self.activeInputResolution ||
            self.activeInputResolution?.shouldRestart(
                availableUIDs: AudioInputDeviceObserver.aliveInputDeviceUIDs(),
                defaultUID: AudioInputDeviceObserver.defaultInputDeviceUID()) == true
        else { return }

        self.logger.warning("realtime active/default input changed; restarting capture")
        self.restartCaptureAfterInputChange {
            try self.startCaptureEngine(targetSampleRate: targetSampleRate, onAudio: onAudio)
        }
    }

    private func restartCaptureAfterInputChange(_ restart: () throws -> Void) {
        self.deliveryGate.deactivate()
        self.teardownEngine()
        do {
            try restart()
        } catch {
            self.logger.error(
                "realtime input restart failed: \(error.localizedDescription, privacy: .public)")
            let onFailure = self.onFailure
            self.stop()
            onFailure?(String(
                format: String(localized: "Realtime microphone became unavailable: %@"),
                error.localizedDescription))
        }
    }

    private func teardownEngine() {
        if self.tapInstalled, let inputNode {
            inputNode.removeTap(onBus: 0)
        }
        self.tapInstalled = false
        self.audioEngine?.stop()
        self.audioEngine = nil
        inputNode = nil
        self.activeInputResolution = nil
    }

    #if DEBUG
    func _test_replaceOutputRouteObserver()
        -> (
            callback: @Sendable (MacRealtimeTalkOutputRoute?) -> Void,
            handled: AsyncStream<Void>)
    {
        let handled = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.testOutputRouteCallbackHandled = {
            handled.continuation.yield()
            handled.continuation.finish()
        }
        return (self.replaceOutputRouteObserver(MacRealtimeTalkOutputRouteObserver()), handled.stream)
    }
    #endif
}

struct MacRealtimeTalkOutputRoute: Equatable, Sendable {
    let transportType: UInt32
    let terminalTypes: [UInt32]
    let selectedDataSource: MacRealtimeTalkOutputDataSource
}

enum MacRealtimeTalkOutputDataSource: Equatable, Sendable {
    case unsupported
    case failed
    case selected(kinds: [UInt32])
}

enum MacRealtimeTalkOutputRouteDecisionReason: String, Sendable {
    case routeUnavailable = "route-unavailable"
    case dataSourceReadFailed = "data-source-read-failed"
    case transportNotAllowlisted = "transport-not-allowlisted"
    case outputKindUnavailable = "output-kind-unavailable"
    case outputKindNotHeadphones = "output-kind-not-headphones"
    case isolatedHeadphones = "isolated-headphones"
}

struct MacRealtimeTalkOutputRouteDecision: Equatable, Sendable {
    let suppressesInputDuringOutput: Bool
    let reason: MacRealtimeTalkOutputRouteDecisionReason
    let transportType: UInt32?
    let effectiveKinds: [UInt32]
    let selectedDataSource: MacRealtimeTalkOutputDataSource?

    var redactedDescription: String {
        let transport = self.transportType.map(MacRealtimeTalkFourCC.describe) ?? "unavailable"
        let kinds = MacRealtimeTalkFourCC.describe(self.effectiveKinds)
        let source = switch self.selectedDataSource {
        case .unsupported:
            "unsupported"
        case .failed:
            "failed"
        case let .selected(sourceKinds):
            Self.selectedDataSourceTag(sourceKinds)
        case nil:
            "unavailable"
        }
        return "transport=\(transport) kinds=\(kinds) source=\(source) " +
            "suppression=\(self.suppressesInputDuringOutput) reason=\(self.reason.rawValue)"
    }

    private static func selectedDataSourceTag(_ kinds: [UInt32]) -> String {
        "selected:" + MacRealtimeTalkFourCC.describe(kinds)
    }
}

enum MacRealtimeTalkOutputRoutePolicy {
    static func decision(
        for route: MacRealtimeTalkOutputRoute?) -> MacRealtimeTalkOutputRouteDecision
    {
        guard let route else {
            return MacRealtimeTalkOutputRouteDecision(
                suppressesInputDuringOutput: true,
                reason: .routeUnavailable,
                transportType: nil,
                effectiveKinds: [],
                selectedDataSource: nil)
        }

        if route.selectedDataSource == .failed {
            return self.decision(
                route: route,
                effectiveKinds: [],
                suppressesInput: true,
                reason: .dataSourceReadFailed)
        }

        // The selected source is the active routing fact. Stream terminals are only a
        // fallback for devices that expose no data-source property.
        let effectiveKinds: [UInt32] = switch route.selectedDataSource {
        case .unsupported:
            route.terminalTypes.sorted()
        case let .selected(kinds):
            kinds.sorted()
        case .failed:
            []
        }
        let allowlistedTransports: Set<UInt32> = [
            kAudioDeviceTransportTypeBuiltIn,
            kAudioDeviceTransportTypeUSB,
            kAudioDeviceTransportTypeBluetooth,
            kAudioDeviceTransportTypeBluetoothLE,
        ]
        guard allowlistedTransports.contains(route.transportType) else {
            return self.decision(
                route: route,
                effectiveKinds: effectiveKinds,
                suppressesInput: true,
                reason: .transportNotAllowlisted)
        }

        guard !effectiveKinds.isEmpty else {
            return self.decision(
                route: route,
                effectiveKinds: [],
                suppressesInput: true,
                reason: .outputKindUnavailable)
        }
        guard effectiveKinds.allSatisfy({ $0 == kAudioStreamTerminalTypeHeadphones }) else {
            return self.decision(
                route: route,
                effectiveKinds: effectiveKinds,
                suppressesInput: true,
                reason: .outputKindNotHeadphones)
        }
        return self.decision(
            route: route,
            effectiveKinds: effectiveKinds,
            suppressesInput: false,
            reason: .isolatedHeadphones)
    }

    private static func decision(
        route: MacRealtimeTalkOutputRoute,
        effectiveKinds: [UInt32],
        suppressesInput: Bool,
        reason: MacRealtimeTalkOutputRouteDecisionReason) -> MacRealtimeTalkOutputRouteDecision
    {
        let selectedDataSource = switch route.selectedDataSource {
        case .unsupported:
            MacRealtimeTalkOutputDataSource.unsupported
        case .failed:
            MacRealtimeTalkOutputDataSource.failed
        case let .selected(kinds):
            MacRealtimeTalkOutputDataSource.selected(kinds: kinds.sorted())
        }
        return MacRealtimeTalkOutputRouteDecision(
            suppressesInputDuringOutput: suppressesInput,
            reason: reason,
            transportType: route.transportType,
            effectiveKinds: effectiveKinds,
            selectedDataSource: selectedDataSource)
    }
}

struct MacRealtimeTalkOutputRouteDecisionState {
    private(set) var current: MacRealtimeTalkOutputRouteDecision?

    mutating func update(route: MacRealtimeTalkOutputRoute?) -> MacRealtimeTalkOutputRouteDecision? {
        let next = MacRealtimeTalkOutputRoutePolicy.decision(for: route)
        guard next != self.current else { return nil }
        self.current = next
        return next
    }

    mutating func reset() {
        self.current = nil
    }
}

private enum MacRealtimeTalkFourCC {
    static func describe(_ values: [UInt32]) -> String {
        "[" + values.map(self.describe).joined(separator: ",") + "]"
    }

    static func describe(_ value: UInt32) -> String {
        let bytes = [
            UInt8((value >> 24) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8(value & 0xFF),
        ]
        guard bytes.allSatisfy({ (0x20...0x7E).contains($0) }) else {
            return String(format: "0x%08X", value)
        }
        return "'\(String(bytes: bytes, encoding: .ascii) ?? "????")'"
    }
}

private struct MacRealtimeTalkAudioPropertyObservation {
    let objectID: AudioObjectID
    let address: AudioObjectPropertyAddress
    let listener: AudioObjectPropertyListenerBlock

    init?(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        listener: @escaping AudioObjectPropertyListenerBlock)
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectAddPropertyListenerBlock(
            objectID,
            &address,
            DispatchQueue.main,
            listener) == noErr
        else { return nil }
        self.objectID = objectID
        self.address = address
        self.listener = listener
    }

    func stop() {
        var address = self.address
        _ = AudioObjectRemovePropertyListenerBlock(
            self.objectID,
            &address,
            DispatchQueue.main,
            self.listener)
    }
}

final class MacRealtimeTalkOutputRouteObserver: @unchecked Sendable {
    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime.output-route")
    private var defaultOutputObservation: MacRealtimeTalkAudioPropertyObservation?
    private var dataSourceObservation: MacRealtimeTalkAudioPropertyObservation?
    private var warningReported = false

    func start(onChange: @escaping @Sendable (MacRealtimeTalkOutputRoute?) -> Void) {
        guard self.defaultOutputObservation == nil else { return }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.bindCurrentOutput(onChange: onChange)
        }
        guard let observation = MacRealtimeTalkAudioPropertyObservation(
            objectID: AudioObjectID(kAudioObjectSystemObject),
            selector: kAudioHardwarePropertyDefaultOutputDevice,
            scope: kAudioObjectPropertyScopeGlobal,
            listener: listener)
        else {
            self.reportWarningOnce("default-output-listener-failed")
            onChange(nil)
            return
        }
        self.defaultOutputObservation = observation
        self.bindCurrentOutput(onChange: onChange)
    }

    func stop() {
        self.defaultOutputObservation?.stop()
        self.defaultOutputObservation = nil
        self.dataSourceObservation?.stop()
        self.dataSourceObservation = nil
    }

    private func bindCurrentOutput(
        onChange: @escaping @Sendable (MacRealtimeTalkOutputRoute?) -> Void)
    {
        self.dataSourceObservation?.stop()
        self.dataSourceObservation = nil
        guard let deviceID = Self.defaultOutputDeviceID() else {
            self.reportWarningOnce("default-output-read-failed")
            onChange(nil)
            return
        }
        guard let route = Self.currentRoute(deviceID: deviceID) else {
            self.reportWarningOnce("output-route-read-failed")
            onChange(nil)
            return
        }
        if route.selectedDataSource == .failed {
            self.reportWarningOnce("data-source-read-failed")
        }
        guard Self.hasDataSourceProperty(deviceID: deviceID) else {
            onChange(route)
            return
        }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            guard let refreshedRoute = Self.currentRoute(deviceID: deviceID) else {
                self.reportWarningOnce("output-route-read-failed")
                onChange(nil)
                return
            }
            if refreshedRoute.selectedDataSource == .failed {
                self.reportWarningOnce("data-source-read-failed")
            }
            onChange(refreshedRoute)
        }
        guard let observation = MacRealtimeTalkAudioPropertyObservation(
            objectID: deviceID,
            selector: kAudioDevicePropertyDataSource,
            scope: kAudioDevicePropertyScopeOutput,
            listener: listener)
        else {
            // A supported source can change without the device ID changing. If it cannot
            // be observed, poison the route so the suppression policy remains fail-closed.
            self.reportWarningOnce("data-source-listener-failed")
            onChange(MacRealtimeTalkOutputRoute(
                transportType: route.transportType,
                terminalTypes: route.terminalTypes,
                selectedDataSource: .failed))
            return
        }
        self.dataSourceObservation = observation
        onChange(route)
    }

    private static func currentRoute(deviceID: AudioObjectID) -> MacRealtimeTalkOutputRoute? {
        guard let transportType = uint32Property(
            objectID: deviceID,
            selector: kAudioDevicePropertyTransportType,
            scope: kAudioObjectPropertyScopeGlobal)
        else { return nil }

        let terminalTypes = self.outputTerminalTypes(deviceID: deviceID)
        return MacRealtimeTalkOutputRoute(
            transportType: transportType,
            terminalTypes: terminalTypes,
            selectedDataSource: self.selectedDataSource(deviceID: deviceID))
    }

    private static func defaultOutputDeviceID() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &deviceID)
        return status == noErr && deviceID != 0 ? deviceID : nil
    }

    private static func outputTerminalTypes(deviceID: AudioObjectID) -> [UInt32] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
              size > 0,
              Int(size) % MemoryLayout<AudioStreamID>.size == 0
        else { return [] }

        var streamIDs = [AudioStreamID](
            repeating: 0,
            count: Int(size) / MemoryLayout<AudioStreamID>.size)
        guard AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &size,
            &streamIDs) == noErr
        else { return [] }

        var terminalTypes: [UInt32] = []
        terminalTypes.reserveCapacity(streamIDs.count)
        for streamID in streamIDs {
            guard let terminalType = self.uint32Property(
                objectID: streamID,
                selector: kAudioStreamPropertyTerminalType,
                scope: kAudioObjectPropertyScopeGlobal)
            else { return [] }
            terminalTypes.append(terminalType)
        }
        return terminalTypes
    }

    private static func hasDataSourceProperty(deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDataSource,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        return AudioObjectHasProperty(deviceID, &address)
    }

    private static func selectedDataSource(
        deviceID: AudioObjectID) -> MacRealtimeTalkOutputDataSource
    {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDataSource,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(deviceID, &address) else { return .unsupported }

        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
              size > 0,
              Int(size) % MemoryLayout<UInt32>.size == 0
        else { return .failed }

        var sourceIDs = [UInt32](
            repeating: 0,
            count: Int(size) / MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &size,
            &sourceIDs) == noErr,
            !sourceIDs.isEmpty
        else { return .failed }

        var kinds: [UInt32] = []
        kinds.reserveCapacity(sourceIDs.count)
        for sourceID in sourceIDs {
            guard let kind = self.dataSourceKind(deviceID: deviceID, sourceID: sourceID)
            else { return .failed }
            kinds.append(kind)
        }
        return .selected(kinds: kinds)
    }

    private static func dataSourceKind(
        deviceID: AudioObjectID,
        sourceID: UInt32) -> UInt32?
    {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDataSourceKindForID,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var input = sourceID
        var output: UInt32 = 0
        var status = kAudioHardwareUnspecifiedError
        withUnsafeMutablePointer(to: &input) { inputPointer in
            withUnsafeMutablePointer(to: &output) { outputPointer in
                var translation = AudioValueTranslation(
                    mInputData: UnsafeMutableRawPointer(inputPointer),
                    mInputDataSize: UInt32(MemoryLayout<UInt32>.size),
                    mOutputData: UnsafeMutableRawPointer(outputPointer),
                    mOutputDataSize: UInt32(MemoryLayout<UInt32>.size))
                var size = UInt32(MemoryLayout<AudioValueTranslation>.size)
                status = AudioObjectGetPropertyData(
                    deviceID,
                    &address,
                    0,
                    nil,
                    &size,
                    &translation)
            }
        }
        return status == noErr ? output : nil
    }

    private static func uint32Property(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope) -> UInt32?
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &size,
            &value)
        return status == noErr ? value : nil
    }

    private func reportWarningOnce(_ reason: String) {
        guard !self.warningReported else { return }
        self.warningReported = true
        self.logger.warning(
            "realtime output route observation degraded reason=\(reason, privacy: .public)")
    }
}

enum MacRealtimeTalkAudioCaptureError: LocalizedError {
    case invalidTargetSampleRate
    case inputUnavailable
    case invalidInputFormat

    var errorDescription: String? {
        switch self {
        case .invalidTargetSampleRate: String(localized: "Realtime Talk requested an invalid audio sample rate")
        case .inputUnavailable: String(localized: "Selected input and system default are unavailable")
        case .invalidInputFormat: String(localized: "Selected audio input has no usable Float32 format")
        }
    }
}

enum MacRealtimeTalkAudioFrameEncoder {
    nonisolated static func encode(
        buffer: AVAudioPCMBuffer,
        targetSampleRate: Double,
        timestampMs: Double) -> RealtimeTalkAudioFrame?
    {
        let inputSampleRate = buffer.format.sampleRate
        guard targetSampleRate.isFinite, targetSampleRate > 0
        else { return nil }
        let data = RealtimeTalkPCM16Encoder.encode(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !data.isEmpty else { return nil }
        return RealtimeTalkAudioFrame(
            data: data,
            timestampMs: timestampMs,
            rms: Float(TalkAudioLevel.pcm16RMS(data)))
    }
}

enum MacRealtimeTalkTapHandlerFactory {
    /// AVAudioEngine invokes tap blocks on a realtime audio queue. Build the block from a
    /// nonisolated context so Swift does not inherit MacRealtimeTalkAudioCapture's MainActor
    /// executor and trap when Core Audio calls it off the main thread.
    nonisolated static func make(
        targetSampleRate: Double,
        deliveryGate: TalkGenerationDeliveryGate,
        deliveryToken: UInt64,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) -> AVAudioNodeTapBlock
    {
        { buffer, _ in
            guard deliveryGate.isActive(deliveryToken) else { return }
            let frame = MacRealtimeTalkAudioFrameEncoder.encode(
                buffer: buffer,
                targetSampleRate: targetSampleRate,
                timestampMs: ProcessInfo.processInfo.systemUptime * 1000)
            guard let frame else { return }
            deliveryGate.deliver(ifActive: deliveryToken) {
                onAudio(frame)
            }
        }
    }
}

final class TalkGenerationDeliveryGate: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var active = true

    func activate() -> UInt64 {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.generation &+= 1
        self.active = true
        return self.generation
    }

    func deactivate() {
        self.lock.lock()
        self.generation &+= 1
        self.active = false
        self.lock.unlock()
    }

    func isActive(_ generation: UInt64) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.active && self.generation == generation
    }

    @discardableResult
    func deliver(ifActive generation: UInt64, _ body: () -> Void) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.active, self.generation == generation else { return false }
        body()
        return true
    }
}
