import Testing
@testable import OpenClawChatUI

@MainActor
private final class RecordingMediaPlaybackOwner: ChatMediaPlaybackOwner {
    private(set) var interruptionCount = 0

    func stopForMediaPlaybackInterruption() {
        self.interruptionCount += 1
    }
}

@MainActor
@Suite("Chat media playback coordinator")
struct ChatMediaPlaybackCoordinatorTests {
    @Test func `new playback owner interrupts the previous owner exactly once`() {
        let coordinator = ChatMediaPlaybackCoordinator()
        let first = RecordingMediaPlaybackOwner()
        let second = RecordingMediaPlaybackOwner()

        coordinator.activate(first)
        coordinator.activate(second)
        coordinator.activate(second)

        #expect(first.interruptionCount == 1)
        #expect(second.interruptionCount == 0)
        #expect(coordinator.isActive(second))
    }

    @Test func `stale owner release does not clear its replacement`() {
        let coordinator = ChatMediaPlaybackCoordinator()
        let first = RecordingMediaPlaybackOwner()
        let second = RecordingMediaPlaybackOwner()

        coordinator.activate(first)
        coordinator.activate(second)
        coordinator.release(first)

        #expect(coordinator.isActive(second))
    }
}
