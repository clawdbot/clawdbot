import Foundation

@MainActor
protocol ChatMediaPlaybackOwner: AnyObject {
    func stopForMediaPlaybackInterruption()
}

/// AVAudioSession and audible chat media are process-wide resources. Keeping the
/// active owner here prevents Listen, audio attachments, and videos from talking
/// over one another across separate chat views.
@MainActor
final class ChatMediaPlaybackCoordinator {
    static let shared = ChatMediaPlaybackCoordinator()

    private weak var activeOwner: (any ChatMediaPlaybackOwner)?

    func activate(_ owner: any ChatMediaPlaybackOwner) {
        guard self.activeOwner !== owner else { return }
        let previous = self.activeOwner
        // Install the new owner before stopping the old one: its release callback
        // must not clear the replacement that already owns playback.
        self.activeOwner = owner
        previous?.stopForMediaPlaybackInterruption()
    }

    func release(_ owner: any ChatMediaPlaybackOwner) {
        guard self.activeOwner === owner else { return }
        self.activeOwner = nil
    }

    func isActive(_ owner: any ChatMediaPlaybackOwner) -> Bool {
        self.activeOwner === owner
    }
}
