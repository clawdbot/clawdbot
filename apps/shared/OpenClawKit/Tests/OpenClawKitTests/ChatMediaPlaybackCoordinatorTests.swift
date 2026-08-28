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
private final class RecordingNowPlayingCenter: ChatMediaNowPlayingPublishing {
    private(set) var published: [ChatMediaNowPlayingMetadata] = []
    private(set) var clearCount = 0
    private var handler: (@MainActor @Sendable (ChatMediaRemoteCommand) -> Void)?

    func publish(_ metadata: ChatMediaNowPlayingMetadata) {
        self.published.append(metadata)
    }

    func setRemoteCommandHandler(
        _ handler: (@MainActor @Sendable (ChatMediaRemoteCommand) -> Void)?)
    {
        self.handler = handler
    }

    func clear() {
        self.handler = nil
        self.clearCount += 1
    }

    func send(_ command: ChatMediaRemoteCommand) {
        self.handler?(command)
    }
}

@MainActor
private final class RecordingNowPlayingOwner: ChatMediaNowPlayingOwner {
    var nowPlayingMetadata = ChatMediaNowPlayingMetadata(
        title: "clip.mov",
        duration: 42,
        elapsed: 3,
        playbackRate: 1)
    var onCommand: (@MainActor (ChatMediaRemoteCommand) -> Void)?
    private(set) var commands: [ChatMediaRemoteCommand] = []

    func stopForMediaPlaybackInterruption() {}

    func handleRemoteCommand(_ command: ChatMediaRemoteCommand) {
        self.commands.append(command)
        self.nowPlayingMetadata = ChatMediaNowPlayingMetadata(
            title: "clip.mov",
            duration: 42,
            elapsed: 4,
            playbackRate: command == .pause ? 0 : 1)
        self.onCommand?(command)
    }
}

@MainActor
@Suite("Chat media playback coordinator")
struct ChatMediaPlaybackCoordinatorTests {
    @Test func `new playback owner interrupts the previous owner exactly once`() {
        let coordinator = ChatMediaPlaybackCoordinator(nowPlayingCenter: RecordingNowPlayingCenter())
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
        let coordinator = ChatMediaPlaybackCoordinator(nowPlayingCenter: RecordingNowPlayingCenter())
        let first = RecordingMediaPlaybackOwner()
        let second = RecordingMediaPlaybackOwner()

        coordinator.activate(first)
        coordinator.activate(second)
        coordinator.release(first)

        #expect(coordinator.isActive(second))
    }

    @Test func `inline owner publishes updates and handles remote commands until release`() {
        let center = RecordingNowPlayingCenter()
        let coordinator = ChatMediaPlaybackCoordinator(nowPlayingCenter: center)
        let owner = RecordingNowPlayingOwner()

        coordinator.activate(owner)
        owner.nowPlayingMetadata = ChatMediaNowPlayingMetadata(
            title: "clip.mov",
            duration: 42,
            elapsed: 3.5,
            playbackRate: 1)
        coordinator.updateNowPlaying(owner)
        center.send(.pause)

        #expect(center.published.first?.title == "clip.mov")
        #expect(center.published.contains { $0.elapsed == 3.5 })
        #expect(owner.commands == [.pause])
        #expect(center.published.last?.playbackRate == 0)

        coordinator.release(owner)
        #expect(center.clearCount == 1)
    }

    @Test func `speech-style owners clear attachment Now Playing metadata`() {
        let center = RecordingNowPlayingCenter()
        let coordinator = ChatMediaPlaybackCoordinator(nowPlayingCenter: center)
        let inline = RecordingNowPlayingOwner()
        let speech = RecordingMediaPlaybackOwner()

        coordinator.activate(inline)
        coordinator.activate(speech)

        #expect(center.published.count == 1)
        #expect(center.clearCount == 1)
    }

    @Test(arguments: [false, true])
    func `remote commands never republish a released or replaced owner`(replaceOwner: Bool) {
        let center = RecordingNowPlayingCenter()
        let coordinator = ChatMediaPlaybackCoordinator(nowPlayingCenter: center)
        let owner = RecordingNowPlayingOwner()
        let replacement = RecordingNowPlayingOwner()
        replacement.nowPlayingMetadata = ChatMediaNowPlayingMetadata(
            title: "next.mov",
            duration: 12,
            elapsed: 0,
            playbackRate: 1)
        owner.onCommand = { [weak owner] _ in
            guard let owner else { return }
            if replaceOwner {
                coordinator.activate(replacement)
            } else {
                coordinator.release(owner)
            }
        }

        coordinator.activate(owner)
        center.send(.play)

        #expect(center.published.count == (replaceOwner ? 2 : 1))
        #expect(center.published.last?.title == (replaceOwner ? "next.mov" : "clip.mov"))
        #expect(center.clearCount == (replaceOwner ? 0 : 1))
    }
}
