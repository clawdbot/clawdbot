import Foundation
import Observation
import OpenClawKit

@MainActor
@Observable
final class WatchSpeechPlayback {
    private var speechTask: Task<Void, Never>?
    private(set) var isSpeaking = false
    private(set) var errorText: String?

    func speak(_ text: String) {
        self.stop()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        self.isSpeaking = true
        self.speechTask = Task { @MainActor in
            // A stopped task can still be scheduled, or finish after its replacement.
            // Only the current task may start speech or clear the playback controls.
            guard !Task.isCancelled else { return }
            do {
                try await TalkSystemSpeechSynthesizer.shared.speak(text: text)
            } catch TalkSystemSpeechSynthesizer.SpeakError.canceled {
            } catch {
                guard !Task.isCancelled else { return }
                self.errorText = String(localized: "Couldn't speak the reply. Read it in Chat.")
            }
            guard !Task.isCancelled else { return }
            self.isSpeaking = false
            self.speechTask = nil
        }
    }

    func stop() {
        self.speechTask?.cancel()
        self.speechTask = nil
        self.isSpeaking = false
        self.errorText = nil
    }
}
