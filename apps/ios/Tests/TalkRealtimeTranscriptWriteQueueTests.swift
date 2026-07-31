import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct TalkRealtimeTranscriptWriteQueueTests {
    private struct PersistError: Error {}

    @Test func `retries writes in order and continues after final failure`() async {
        var attempts: [String] = []
        let store = TalkRealtimeTranscriptStore(retryDelaysNanoseconds: [0, 0, 0, 0])
        let delegate = RecordingTranscriptFailureDelegate()
        let session = TalkRealtimeWebRTCSession(
            gateway: GatewayNodeSession(),
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-1",
            transcriptStore: store,
            delegate: delegate)

        for _ in 1...3 {
            store.enqueue(
                sessionKey: "agent:main:main",
                voiceSessionId: "voice-1",
                role: .user,
                text: "hello",
                timestamp: 1234,
                persist: { params in
                    attempts.append(params.entryId)
                    if params.entryId == "1", attempts.filter({ $0 == "1" }).count < 3 {
                        throw PersistError()
                    }
                    if params.entryId == "2" {
                        throw PersistError()
                    }
                },
                failureLog: { entryId, error in
                    session._test_reportTranscriptPersistenceFailure(entryId: entryId, error: error)
                })
        }
        await store.flush(voiceSessionId: "voice-1")

        #expect(attempts == ["1", "1", "1", "2", "2", "2", "3"])
        #expect(delegate.failedEntryIds == ["2"])
    }

    @Test func `shares ordering across transport replacements`() async {
        var persisted: [String] = []
        let store = TalkRealtimeTranscriptStore(retryDelaysNanoseconds: [])
        let persist: TalkRealtimeTranscriptWriteQueue.Persist = { params in
            persisted.append("\(params.voiceSessionId):\(params.entryId)")
        }
        let failureLog: TalkRealtimeTranscriptWriteQueue.FailureLog = { _, _ in }

        let firstTransportEntry = store.enqueue(
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-a",
            role: .user,
            text: "one",
            timestamp: 1,
            persist: persist,
            failureLog: failureLog)
        let replacementTransportEntry = store.enqueue(
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-a",
            role: .assistant,
            text: "two",
            timestamp: 2,
            persist: persist,
            failureLog: failureLog)
        let otherVoiceSessionEntry = store.enqueue(
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-b",
            role: .user,
            text: "other",
            timestamp: 3,
            persist: persist,
            failureLog: failureLog)
        await store.flush(voiceSessionId: "voice-a")
        await store.flush(voiceSessionId: "voice-b")

        #expect(firstTransportEntry == "1")
        #expect(replacementTransportEntry == "2")
        #expect(otherVoiceSessionEntry == "1")
        #expect(persisted.filter { $0.hasPrefix("voice-a:") } == ["voice-a:1", "voice-a:2"])
        #expect(persisted.filter { $0.hasPrefix("voice-b:") } == ["voice-b:1"])
    }
}

@MainActor
private final class RecordingTranscriptFailureDelegate: TalkRealtimeWebRTCSessionDelegate {
    var failedEntryIds: [String] = []

    func realtimeSession(_: TalkRealtimeWebRTCSession, didChangeStatus _: String) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didDetectInputSpeech _: Bool) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didUpdateAudioLevels _: Double?, output _: Double?) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveUserTranscript _: String) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript _: String) {}

    func realtimeSession(
        _: TalkRealtimeWebRTCSession,
        didFailTranscriptPersistenceForEntry entryId: String,
        error _: Error)
    {
        self.failedEntryIds.append(entryId)
    }

    func realtimeSessionDidFinish(_: TalkRealtimeWebRTCSession) {}
}
