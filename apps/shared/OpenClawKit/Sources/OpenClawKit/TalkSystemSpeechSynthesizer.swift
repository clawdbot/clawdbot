import AVFoundation
import Foundation

@MainActor
public final class TalkSystemSpeechSynthesizer: NSObject {
    public enum SpeakError: Error {
        case canceled
    }

    public static let shared = TalkSystemSpeechSynthesizer()

    private let synth = AVSpeechSynthesizer()
    private var speakContinuation: CheckedContinuation<Void, Error>?
    private var currentUtterance: AVSpeechUtterance?
    private var didStartCallback: (() -> Void)?
    private var currentToken = UUID()
    private var watchdog: Task<Void, Never>?

    public var isSpeaking: Bool {
        self.synth.isSpeaking
    }

    override private init() {
        super.init()
        self.synth.delegate = self
    }

    public func stop() {
        self.currentToken = UUID()
        self.watchdog?.cancel()
        self.watchdog = nil
        self.didStartCallback = nil
        self.synth.stopSpeaking(at: .immediate)
        self.finishCurrent(with: SpeakError.canceled)
    }

    public func speak(
        text: String,
        language: String? = nil,
        onStart: (() -> Void)? = nil) async throws
    {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        self.stop()
        let token = UUID()
        self.currentToken = token
        self.didStartCallback = onStart

        let utterance = AVSpeechUtterance(string: trimmed)
        if let language, let voice = AVSpeechSynthesisVoice(language: language) {
            utterance.voice = voice
        }
        self.currentUtterance = utterance

        let watchdogTimeout = Self.watchdogTimeoutSeconds(
            text: trimmed,
            language: language ?? utterance.voice?.language)
        self.watchdog?.cancel()
        self.watchdog = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(watchdogTimeout * 1_000_000_000))
            if Task.isCancelled { return }
            guard self.currentToken == token else { return }
            if self.synth.isSpeaking {
                self.synth.stopSpeaking(at: .immediate)
            }
            self.finishCurrent(
                with: NSError(domain: "TalkSystemSpeechSynthesizer", code: 408, userInfo: [
                    NSLocalizedDescriptionKey: "system TTS timed out after \(watchdogTimeout)s",
                ]))
        }

        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { cont in
                self.speakContinuation = cont
                self.synth.speak(utterance)
            }
        }, onCancel: {
            Task { @MainActor in
                self.stop()
            }
        })

        if self.currentToken != token {
            throw SpeakError.canceled
        }
    }

    static func watchdogTimeoutSeconds(text: String, language: String?) -> Double {
        // Estimate speech duration per language, then apply 3x safety margin.
        // The watchdog is a hang guard — normal completion relies on didFinish.
        //
        // Speech rates based on Pellegrino et al. (2019) syllable-per-second data,
        // adjusted for TTS synthesis (slower than natural speech):
        // https://www.science.org/doi/10.1126/sciadv.aaw2594
        //   Japanese: 7.84 SPS -> ~0.20s/char (mixed kana/kanji avg ~1.5 mora/char)
        //   Korean:   5.96 SPS -> ~0.25s/char (1 char = 1 syllable)
        //   Chinese:  5.18 SPS -> ~0.28s/char (1 char = 1 syllable)
        //   English:  6.19 SPS -> ~0.08s/char (avg ~5 chars/syllable)
        let normalizedLanguage = language?.lowercased() ?? "en"
        let perCharSeconds: Double
        let minSeconds: Double
        if normalizedLanguage.hasPrefix("ko") {
            perCharSeconds = 0.25
            minSeconds = 10.0
        } else if normalizedLanguage.hasPrefix("zh") {
            perCharSeconds = 0.28
            minSeconds = 10.0
        } else if normalizedLanguage.hasPrefix("ja") {
            perCharSeconds = 0.20
            minSeconds = 10.0
        } else {
            perCharSeconds = 0.08
            minSeconds = 3.0
        }
        let estimatedSeconds = max(minSeconds, min(300.0, Double(text.count) * perCharSeconds))
        return estimatedSeconds * 3.0
    }

    private func matchesCurrentUtterance(_ utteranceID: ObjectIdentifier) -> Bool {
        guard let currentUtterance = self.currentUtterance else { return false }
        return ObjectIdentifier(currentUtterance) == utteranceID
    }

    private func handleFinish(utteranceID: ObjectIdentifier, error: Error?) {
        guard self.matchesCurrentUtterance(utteranceID) else { return }
        self.watchdog?.cancel()
        self.watchdog = nil
        self.finishCurrent(with: error)
    }

    private func finishCurrent(with error: Error?) {
        self.currentUtterance = nil
        self.didStartCallback = nil
        let cont = self.speakContinuation
        self.speakContinuation = nil
        if let error {
            cont?.resume(throwing: error)
        } else {
            cont?.resume(returning: ())
        }
    }
}

extension TalkSystemSpeechSynthesizer: AVSpeechSynthesizerDelegate {
    public nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didStart utterance: AVSpeechUtterance)
    {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.matchesCurrentUtterance(utteranceID) else { return }
            let callback = self.didStartCallback
            self.didStartCallback = nil
            callback?()
        }
    }

    public nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance)
    {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor in
            self.handleFinish(utteranceID: utteranceID, error: nil)
        }
    }

    public nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance)
    {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor in
            self.handleFinish(utteranceID: utteranceID, error: SpeakError.canceled)
        }
    }
}
