import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
private final class PlaybackLoadSequence {
    private var responses: [OpenClawChatLoadedMedia?]
    private(set) var requestCount = 0
    private(set) var preparingCount = 0
    private(set) var sleeps: [Duration] = []

    init(_ responses: [OpenClawChatLoadedMedia?]) {
        self.responses = responses
    }

    func request() -> OpenClawChatLoadedMedia? {
        self.requestCount += 1
        return self.responses.isEmpty ? nil : self.responses.removeFirst()
    }

    func notePreparing() {
        self.preparingCount += 1
    }

    func sleep(_ duration: Duration) {
        self.sleeps.append(duration)
    }
}

@MainActor
@Suite("Chat media playback rendition loading")
struct ChatMediaPlaybackLoaderTests {
    @Test func `retries preparing responses until rendition bytes are ready`() async throws {
        let expected = OpenClawChatMediaData(data: Data([1, 2, 3]), mimeType: "audio/mp4")
        let sequence = PlaybackLoadSequence([.preparing, .preparing, .data(expected)])
        let policy = ChatMediaPlaybackRetryPolicy(delays: [.seconds(1), .seconds(2)])

        let loaded = try await ChatMediaPlaybackLoader.load(
            policy: policy,
            request: { sequence.request() },
            onPreparing: { sequence.notePreparing() },
            sleep: { sequence.sleep($0) })

        guard case let .data(media) = loaded else {
            Issue.record("expected buffered rendition bytes")
            return
        }
        #expect(media.data == expected.data)
        #expect(media.mimeType == expected.mimeType)
        #expect(sequence.requestCount == 3)
        #expect(sequence.preparingCount == 2)
        #expect(sequence.sleeps == [.seconds(1), .seconds(2)])
    }

    @Test func `exhausted preparation retries return unavailable result`() async throws {
        let sequence = PlaybackLoadSequence([.preparing, .preparing, .preparing])
        let policy = ChatMediaPlaybackRetryPolicy(delays: [.seconds(1), .seconds(2)])

        let loaded = try await ChatMediaPlaybackLoader.load(
            policy: policy,
            request: { sequence.request() },
            onPreparing: { sequence.notePreparing() },
            sleep: { sequence.sleep($0) })

        #expect(loaded == nil)
        #expect(sequence.requestCount == 3)
        #expect(sequence.preparingCount == 3)
    }

    @Test func `production retry budget is capped at two minutes`() {
        #expect(ChatMediaPlaybackRetryPolicy.bounded.delays.reduce(.zero, +) == .seconds(120))
    }
}
