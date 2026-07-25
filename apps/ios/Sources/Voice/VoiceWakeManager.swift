import AVFAudio
import Foundation
import Observation
import OpenClawKit
import Speech
import SwabbleKit

private func makeAudioTapEnqueueCallback(queue: AudioBufferQueue) -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
    { buffer, _ in
        // This callback is invoked on a realtime audio thread/queue. Keep it tiny and nonisolated.
        queue.enqueueCopy(of: buffer)
    }
}

private final class AudioBufferQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var buffers: [AVAudioPCMBuffer] = []

    func enqueueCopy(of buffer: AVAudioPCMBuffer) {
        guard let copy = buffer.deepCopy() else { return }
        self.lock.lock()
        self.buffers.append(copy)
        self.lock.unlock()
    }

    func drain() -> [AVAudioPCMBuffer] {
        self.lock.lock()
        let drained = self.buffers
        self.buffers.removeAll(keepingCapacity: true)
        self.lock.unlock()
        return drained
    }

    func clear() {
        self.lock.lock()
        self.buffers.removeAll(keepingCapacity: false)
        self.lock.unlock()
    }
}

private enum VoiceWakeAudioError: LocalizedError {
    case invalidInputFormat

    var errorDescription: String? {
        switch self {
        case .invalidInputFormat:
            String(localized: "Microphone input format unavailable")
        }
    }
}

private enum VoiceWakeSuppressionReason: Hashable {
    case auxiliaryAudio
    case background
    case talk
    case pushToTalk
    case voiceNote
}

extension AVAudioPCMBuffer {
    fileprivate func deepCopy() -> AVAudioPCMBuffer? {
        let format = self.format
        let frameLength = self.frameLength
        guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else {
            return nil
        }
        copy.frameLength = frameLength

        if let src = self.floatChannelData, let dst = copy.floatChannelData {
            let channels = Int(format.channelCount)
            let frames = Int(frameLength)
            for ch in 0..<channels {
                dst[ch].update(from: src[ch], count: frames)
            }
            return copy
        }

        if let src = self.int16ChannelData, let dst = copy.int16ChannelData {
            let channels = Int(format.channelCount)
            let frames = Int(frameLength)
            for ch in 0..<channels {
                dst[ch].update(from: src[ch], count: frames)
            }
            return copy
        }

        if let src = self.int32ChannelData, let dst = copy.int32ChannelData {
            let channels = Int(format.channelCount)
            let frames = Int(frameLength)
            for ch in 0..<channels {
                dst[ch].update(from: src[ch], count: frames)
            }
            return copy
        }

        return nil
    }
}

@MainActor
@Observable
final class VoiceWakeManager: NSObject {
    var isEnabled: Bool = false
    var isListening: Bool = false
    var statusText: String = "Off"
    var triggerWords: [String] = VoiceWakePreferences.loadTriggerWords()
    var lastTriggeredCommand: String?

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionGeneration: UInt64 = 0
    private var tapQueue: AudioBufferQueue?
    private var tapDrainTask: Task<Void, Never>?
    private var scheduledStartTask: Task<Void, Never>?
    private var commandTask: Task<Void, Never>?
    private var commandGeneration: UInt64 = 0
    private var isStarting: Bool = false
    private var audioSessionIsActive = false

    private var lastDispatched: String?
    private var onCommand: (@Sendable (String) async -> Void)?
    private var userDefaultsObserver: NSObjectProtocol?
    private var suppressionReasons: Set<VoiceWakeSuppressionReason> = []

    private let recognitionErrorRestartDelayNs: UInt64
    private let audioSessionDeactivationAction: (@MainActor () throws -> Void)?

    override convenience init() {
        self.init(recognitionErrorRestartDelayNs: 700_000_000, audioSessionDeactivationAction: nil)
    }

    private init(
        recognitionErrorRestartDelayNs: UInt64,
        audioSessionDeactivationAction: (@MainActor () throws -> Void)?)
    {
        self.recognitionErrorRestartDelayNs = recognitionErrorRestartDelayNs
        self.audioSessionDeactivationAction = audioSessionDeactivationAction
        super.init()
        self.triggerWords = VoiceWakePreferences.loadTriggerWords()
        self.userDefaultsObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: UserDefaults.standard,
            queue: .main,
            using: { [weak self] _ in
                Task { @MainActor in
                    self?.handleUserDefaultsDidChange()
                }
            })
    }

    @MainActor deinit {
        if let userDefaultsObserver = self.userDefaultsObserver {
            NotificationCenter.default.removeObserver(userDefaultsObserver)
        }
    }

    var activeTriggerWords: [String] {
        VoiceWakePreferences.sanitizeTriggerWords(self.triggerWords)
    }

    private func handleUserDefaultsDidChange() {
        let updated = VoiceWakePreferences.loadTriggerWords()
        if updated != self.triggerWords {
            self.triggerWords = updated
        }
    }

    func configure(onCommand: @escaping @Sendable (String) async -> Void) {
        self.onCommand = onCommand
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.scheduleStart()
        } else {
            self.stop()
        }
    }

    func setSuppressedByTalk(_ suppressed: Bool) {
        self.setSuppressed(suppressed, reason: .talk)
    }

    func setSuppressedForBackground(_ suppressed: Bool) {
        self.setSuppressed(suppressed, reason: .background)
    }

    func setSuppressedForAuxiliaryAudio(_ suppressed: Bool) {
        self.setSuppressed(suppressed, reason: .auxiliaryAudio)
    }

    func setSuppressedByPushToTalk(_ suppressed: Bool) {
        self.setSuppressed(suppressed, reason: .pushToTalk)
    }

    func setSuppressedByVoiceNote(_ suppressed: Bool) {
        self.setSuppressed(suppressed, reason: .voiceNote)
    }

    func invalidatePendingCommand() {
        self.invalidateCommandTask()
    }

    private func setSuppressed(_ suppressed: Bool, reason: VoiceWakeSuppressionReason) {
        if suppressed {
            self.suppressionReasons.insert(reason)
        } else {
            self.suppressionReasons.remove(reason)
        }

        // Each microphone owner clears only its own reason, so Talk ending
        // cannot restart Voice Wake over an active voice-note recording.
        if !self.suppressionReasons.isEmpty {
            self.cancelScheduledStart()
            let hasRecognitionPipeline = self.isListening ||
                self.recognitionRequest != nil ||
                self.recognitionTask != nil ||
                self.tapDrainTask != nil ||
                self.commandTask != nil ||
                self.audioSessionIsActive ||
                self.audioEngine.isRunning
            if hasRecognitionPipeline {
                self.isListening = false
                self.tearDownRecognitionPipeline()
            }
            if self.isEnabled {
                self.statusText = String(localized: "Paused")
            }
        } else if self.isEnabled {
            self.scheduleStart()
        }
    }

    private func scheduleStart(after delayNs: UInt64 = 0) {
        guard self.isEnabled else { return }

        self.scheduledStartTask?.cancel()
        self.scheduledStartTask = Task { [weak self] in
            if delayNs > 0 {
                try? await Task.sleep(nanoseconds: delayNs)
            }
            guard !Task.isCancelled else { return }
            self?.scheduledStartTask = nil
            await self?.start()
        }
    }

    private func cancelScheduledStart() {
        self.scheduledStartTask?.cancel()
        self.scheduledStartTask = nil
    }

    func start() async {
        guard self.isEnabled else { return }
        if self.isListening { return }
        if self.isStarting { return }

        self.isStarting = true
        defer { self.isStarting = false }

        guard self.suppressionReasons.isEmpty else {
            self.isListening = false
            self.statusText = String(localized: "Paused")
            return
        }

        if ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] != nil ||
            ProcessInfo.processInfo.environment["SIMULATOR_UDID"] != nil
        {
            // The iOS Simulator’s audio stack is unreliable for long-running microphone capture.
            // (We’ve observed CoreAudio deadlocks after TCC permission prompts.)
            self.isListening = false
            self.statusText = String(localized: "Voice Wake isn’t supported on Simulator")
            return
        }

        self.statusText = String(localized: "Requesting permissions…")

        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.statusText = Self.microphonePermissionMessage(
                kind: String(localized: "Microphone"))
            self.isListening = false
            return
        }

        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.statusText = Self.permissionMessage(
                kind: String(localized: "Speech recognition"),
                status: SFSpeechRecognizer.authorizationStatus())
            self.isListening = false
            return
        }

        self.speechRecognizer = SFSpeechRecognizer()
        guard self.speechRecognizer != nil else {
            self.statusText = String(localized: "Speech recognizer unavailable")
            self.isListening = false
            return
        }

        guard self.isEnabled, self.suppressionReasons.isEmpty else {
            self.isListening = false
            self.statusText = self.isEnabled
                ? String(localized: "Paused")
                : String(localized: "Off")
            return
        }

        do {
            try self.configureOwnedAudioSession()
            try self.startRecognition()
            self.isListening = true
            self.statusText = String(localized: "Listening")
        } catch {
            self.isListening = false
            self.tearDownRecognitionPipeline()
            self.statusText = String(
                format: String(localized: "Start failed: %@"),
                error.localizedDescription)
        }
    }

    func stop() {
        self.isEnabled = false
        self.isListening = false
        self.statusText = String(localized: "Off")
        self.cancelScheduledStart()
        self.tearDownRecognitionPipeline()
    }

    private func startRecognition() throws {
        guard self.isEnabled, self.suppressionReasons.isEmpty else { return }

        self.invalidateCommandTask()
        self.recognitionGeneration &+= 1
        let recognitionGeneration = self.recognitionGeneration
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.tapDrainTask?.cancel()
        self.tapDrainTask = nil
        self.tapQueue?.clear()
        self.tapQueue = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.recognitionRequest = request

        let inputNode = self.audioEngine.inputNode
        inputNode.removeTap(onBus: 0)

        let recordingFormat = inputNode.outputFormat(forBus: 0)
        guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
            throw VoiceWakeAudioError.invalidInputFormat
        }

        let queue = AudioBufferQueue()
        self.tapQueue = queue
        let tapBlock: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = makeAudioTapEnqueueCallback(queue: queue)
        inputNode.installTap(
            onBus: 0,
            bufferSize: 1024,
            format: recordingFormat,
            block: tapBlock)

        self.audioEngine.prepare()
        try self.audioEngine.start()

        let handler = self.makeRecognitionResultHandler(recognitionGeneration: recognitionGeneration)
        self.recognitionTask = self.speechRecognizer?.recognitionTask(with: request, resultHandler: handler)

        self.tapDrainTask = Task { [weak self] in
            guard let self, let queue = self.tapQueue else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 40_000_000)
                let drained = queue.drain()
                if drained.isEmpty { continue }
                for buf in drained {
                    request.append(buf)
                }
            }
        }
    }

    private func tearDownRecognitionPipeline() {
        // Speech can deliver buffered results after cancellation. Retire the
        // callback owner before any task or audio teardown begins.
        self.recognitionGeneration &+= 1
        self.invalidateCommandTask()
        let hadRecognitionPipeline = self.recognitionRequest != nil

        self.tapDrainTask?.cancel()
        self.tapDrainTask = nil
        self.tapQueue?.clear()
        self.tapQueue = nil

        self.recognitionTask?.cancel()
        self.recognitionTask = nil

        if self.audioEngine.isRunning {
            self.audioEngine.stop()
        }
        if hadRecognitionPipeline {
            // Accessing inputNode initializes RemoteIO. Only touch it after
            // startRecognition created a request and may have installed a tap.
            self.audioEngine.inputNode.removeTap(onBus: 0)
        }
        self.recognitionRequest = nil

        self.deactivateOwnedAudioSession()
    }

    private nonisolated func makeRecognitionResultHandler(
        recognitionGeneration: UInt64) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void
    {
        { [weak self] result, error in
            let transcript = result?.bestTranscription.formattedString
            let segments = result.flatMap { result in
                transcript.map { WakeWordSpeechSegments.from(transcription: result.bestTranscription, transcript: $0) }
            } ?? []
            let errorText = error?.localizedDescription

            Task { @MainActor in
                self?.handleRecognitionCallback(
                    transcript: transcript,
                    segments: segments,
                    errorText: errorText,
                    recognitionGeneration: recognitionGeneration)
            }
        }
    }

    private func handleRecognitionCallback(
        transcript: String?,
        segments: [WakeWordSegment],
        errorText: String?,
        recognitionGeneration: UInt64)
    {
        guard self.recognitionGeneration == recognitionGeneration else { return }
        if let errorText {
            self.statusText = String(
                format: String(localized: "Recognizer error: %@"),
                errorText)
            self.isListening = false
            self.tearDownRecognitionPipeline()
            self.scheduleStart(after: self.recognitionErrorRestartDelayNs)
            return
        }

        guard let transcript else { return }
        guard let cmd = self.extractCommand(from: transcript, segments: segments) else { return }

        if cmd == self.lastDispatched { return }
        self.lastDispatched = cmd
        self.lastTriggeredCommand = cmd
        self.statusText = String(localized: "Triggered")

        self.commandGeneration &+= 1
        let commandGeneration = self.commandGeneration
        self.commandTask?.cancel()
        self.commandTask = Task { @MainActor [weak self] in
            guard let self,
                  self.isCurrentCommand(
                      recognitionGeneration: recognitionGeneration,
                      commandGeneration: commandGeneration)
            else { return }
            defer {
                if self.commandGeneration == commandGeneration {
                    self.commandTask = nil
                }
            }
            await self.onCommand?(cmd)
            guard self.isCurrentCommand(
                recognitionGeneration: recognitionGeneration,
                commandGeneration: commandGeneration)
            else { return }
            await self.startIfEnabled()
        }
    }

    private func isCurrentCommand(
        recognitionGeneration: UInt64,
        commandGeneration: UInt64) -> Bool
    {
        !Task.isCancelled &&
            self.recognitionGeneration == recognitionGeneration &&
            self.commandGeneration == commandGeneration &&
            self.isEnabled &&
            self.suppressionReasons.isEmpty
    }

    private func invalidateCommandTask() {
        self.commandGeneration &+= 1
        self.commandTask?.cancel()
        self.commandTask = nil
    }

    private func startIfEnabled() async {
        self.scheduleStart()
    }

    private func extractCommand(from transcript: String, segments: [WakeWordSegment]) -> String? {
        Self.extractCommand(from: transcript, segments: segments, triggers: self.activeTriggerWords)
    }

    nonisolated static func extractCommand(
        from transcript: String,
        segments: [WakeWordSegment],
        triggers: [String],
        minPostTriggerGap: TimeInterval = 0.45) -> String?
    {
        let config = WakeWordGateConfig(triggers: triggers, minPostTriggerGap: minPostTriggerGap)
        return WakeWordGate.match(transcript: transcript, segments: segments, config: config)?.command
    }

    private static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [
            .duckOthers,
            .mixWithOthers,
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try session.setActive(true, options: [])
    }

    private func configureOwnedAudioSession() throws {
        try Self.configureAudioSession()
        self.audioSessionIsActive = true
    }

    private func deactivateOwnedAudioSession() {
        guard self.audioSessionIsActive else { return }
        do {
            if let audioSessionDeactivationAction {
                try audioSessionDeactivationAction()
            } else {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
            self.audioSessionIsActive = false
        } catch {
            // Retain ownership so a later teardown retries instead of claiming
            // the shared session was released when AVAudioSession rejected it.
        }
    }

    private nonisolated static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            break
        @unknown default:
            return false
        }

        return await self.requestPermissionWithTimeout { completion in
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        }
    }

    private nonisolated static func microphonePermissionMessage(kind: String) -> String {
        let status = AVAudioApplication.shared.recordPermission
        return self.deniedByDefaultPermissionMessage(
            kind: kind,
            isUndetermined: status == .undetermined)
    }

    private nonisolated static func requestSpeechPermission() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            break
        @unknown default:
            return false
        }

        return await self.requestPermissionWithTimeout { completion in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                completion(authStatus == .authorized)
            }
        }
    }

    private nonisolated static func requestPermissionWithTimeout(
        _ operation: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 8,
                onTimeout: { NSError(domain: "VoiceWake", code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "permission request timed out",
                ]) },
                operation: { await PermissionRequestBridge.awaitRequest(operation) })
        } catch {
            return false
        }
    }

    private static func permissionMessage(
        kind: String,
        status: SFSpeechRecognizerAuthorizationStatus) -> String
    {
        switch status {
        case .denied:
            return String(
                format: String(localized: "%@ permission denied"),
                kind)
        case .restricted:
            return String(
                format: String(localized: "%@ permission restricted"),
                kind)
        case .notDetermined:
            return String(
                format: String(localized: "%@ permission not granted"),
                kind)
        case .authorized:
            return String(
                format: String(localized: "%@ permission denied"),
                kind)
        @unknown default:
            return String(
                format: String(localized: "%@ permission denied"),
                kind)
        }
    }

    private nonisolated static func deniedByDefaultPermissionMessage(kind: String, isUndetermined: Bool) -> String {
        if isUndetermined {
            return String(
                format: String(localized: "%@ permission not granted"),
                kind)
        }
        return String(
            format: String(localized: "%@ permission denied"),
            kind)
    }
}

#if DEBUG
extension VoiceWakeManager {
    static func _test_withoutRestartDelays(
        audioSessionDeactivationAction: (@MainActor () throws -> Void)? = nil) -> VoiceWakeManager
    {
        VoiceWakeManager(
            recognitionErrorRestartDelayNs: 0,
            audioSessionDeactivationAction: audioSessionDeactivationAction)
    }

    func _test_handleRecognitionCallback(
        transcript: String?,
        segments: [WakeWordSegment],
        errorText: String?,
        recognitionGeneration: UInt64? = nil)
    {
        self.handleRecognitionCallback(
            transcript: transcript,
            segments: segments,
            errorText: errorText,
            recognitionGeneration: recognitionGeneration ?? self.recognitionGeneration)
    }

    func _test_recognitionGeneration() -> UInt64 {
        self.recognitionGeneration
    }

    func _test_setAudioSessionIsActive(_ isActive: Bool) {
        self.audioSessionIsActive = isActive
    }

    func _test_isSuppressedByPushToTalk() -> Bool {
        self.suppressionReasons.contains(.pushToTalk)
    }

    func _test_isSuppressedForBackground() -> Bool {
        self.suppressionReasons.contains(.background)
    }

    func _test_isSuppressedForAuxiliaryAudio() -> Bool {
        self.suppressionReasons.contains(.auxiliaryAudio)
    }

    func _test_waitForScheduledStart() async {
        let task = self.scheduledStartTask
        await task?.value
    }
}
#endif
