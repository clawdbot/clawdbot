import AVFAudio
import Observation

@MainActor
@Observable
final class WatchSpeechPlayback: NSObject {
    private let synthesizer = AVSpeechSynthesizer()
    private(set) var isSpeaking = false

    override init() {
        super.init()
        self.synthesizer.delegate = self
    }

    func speak(_ text: String) {
        self.stop()
        self.isSpeaking = true
        self.synthesizer.speak(AVSpeechUtterance(string: text))
    }

    func stop() {
        guard self.isSpeaking || self.synthesizer.isSpeaking else { return }
        self.synthesizer.stopSpeaking(at: .immediate)
        self.isSpeaking = false
    }
}

extension WatchSpeechPlayback: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _: AVSpeechSynthesizer,
        didFinish _: AVSpeechUtterance)
    {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }

    nonisolated func speechSynthesizer(
        _: AVSpeechSynthesizer,
        didCancel _: AVSpeechUtterance)
    {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }
}
