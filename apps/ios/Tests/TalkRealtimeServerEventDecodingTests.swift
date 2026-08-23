import Foundation
import Testing
@testable import OpenClaw

private actor TalkRealtimeAcknowledgementBarrier {
    private var entered = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var responseWaiter: CheckedContinuation<Data, Never>?

    func response() async -> Data {
        self.entered = true
        let enteredWaiters = self.enteredWaiters
        self.enteredWaiters.removeAll()
        for waiter in enteredWaiters {
            waiter.resume()
        }
        return await withCheckedContinuation { continuation in
            self.responseWaiter = continuation
        }
    }

    func waitUntilEntered() async {
        if self.entered { return }
        await withCheckedContinuation { continuation in
            self.enteredWaiters.append(continuation)
        }
    }

    func release(_ data: Data) {
        self.responseWaiter?.resume(returning: data)
        self.responseWaiter = nil
    }
}

struct TalkRealtimeServerEventDecodingTests {
    @Test func `decodes frameless realtime transcript and turn events`() throws {
        let userDelta = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(#"{"type":"input_transcript.added","item":{"id":"user-1","text":"Hello"}}"#.utf8))
        #expect(userDelta.item?.id == "user-1")
        #expect(userDelta.item?.text == "Hello")

        let assistantDelta = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(#"{"type":"output_transcript.added","item":{"id":"assistant-1","text":"Hi"}}"#.utf8))
        #expect(assistantDelta.item?.id == "assistant-1")
        #expect(assistantDelta.item?.text == "Hi")

        let turnDone = try JSONDecoder().decode(
            TalkRealtimeServerEvent.self,
            from: Data(
                #"{"type":"turn.done","turn":{"id":"turn-1","role":"assistant","transcript":"Hi there"}}"#.utf8))
        #expect(turnDone.turn?.id == "turn-1")
        #expect(turnDone.turn?.role == "assistant")
        #expect(turnDone.turn?.transcript == "Hi there")
    }

    @Test func `tool call response resolves canonical agent run identity`() throws {
        let response = try JSONDecoder().decode(
            TalkRealtimeToolCallResponse.self,
            from: Data(
                #"{"runId":"run-1","idempotencyKey":"talk-1","agentId":"device","agentSessionKey":"agent:device:main"}"#.utf8))
        let identity = try #require(response.resolvedRunIdentity(fallbackSessionKey: "main"))

        #expect(identity.runId == "run-1")
        #expect(identity.agentId == "device")
        #expect(identity.agentSessionKey == "agent:device:main")
        #expect(identity.matches(sessionKey: "agent:device:main"))
        #expect(!identity.matches(sessionKey: "main"))
    }

    @Test func `tool call response accepts legacy Gateway identity omission`() throws {
        let response = try JSONDecoder().decode(
            TalkRealtimeToolCallResponse.self,
            from: Data(#"{"idempotencyKey":"talk-legacy"}"#.utf8))
        let identity = try #require(response.resolvedRunIdentity(fallbackSessionKey: "main"))

        #expect(identity.runId == "talk-legacy")
        #expect(identity.agentId == nil)
        #expect(identity.agentSessionKey == "main")
        #expect(identity.matches(sessionKey: "agent:main:main"))
    }

    @Test func `tool call response rejects a partial agent identity`() throws {
        let payloads = [
            #"{"runId":"run-agent-only","agentId":"device"}"#,
            #"{"runId":"run-session-only","agentSessionKey":"agent:device:main"}"#,
        ]

        for payload in payloads {
            let response = try JSONDecoder().decode(
                TalkRealtimeToolCallResponse.self,
                from: Data(payload.utf8))
            #expect(response.resolvedRunIdentity(fallbackSessionKey: "main") == nil)
        }
    }

    @Test func `cancelled caller still receives its tool call acknowledgement`() async throws {
        let barrier = TalkRealtimeAcknowledgementBarrier()
        let caller = Task {
            let response = try await TalkRealtimeToolCallAcknowledgement.waitForResponse {
                await barrier.response()
            }
            return (response, Task.isCancelled)
        }
        await barrier.waitUntilEntered()

        caller.cancel()
        let expected = Data(#"{"runId":"run-after-cancel"}"#.utf8)
        await barrier.release(expected)
        let (response, remainedCancelled) = try await caller.value

        #expect(response == expected)
        #expect(remainedCancelled)
    }

    @Test func `agent wait uses authoritative final without transcript idempotency correlation`() throws {
        let response = try JSONDecoder().decode(
            TalkRealtimeAgentWaitResponse.self,
            from: Data(
                #"{"runId":"run-1","status":"ok","terminalReply":{"disposition":"visible","text":"Runtime-owned final"}}"#.utf8))

        #expect(response.authoritativeResultText == "Runtime-owned final")
    }

    @Test func `agent wait preserves authoritative no-text outcomes`() throws {
        for disposition in ["silent", "empty"] {
            let response = try JSONDecoder().decode(
                TalkRealtimeAgentWaitResponse.self,
                from: Data(
                    #"{"runId":"run-1","status":"ok","terminalReply":{"disposition":"\#(disposition)"}}"#.utf8))

            #expect(response.authoritativeResultText == "OpenClaw finished with no text.")
        }
    }

    @Test func `legacy agent wait completion exposes missing authoritative final`() throws {
        let response = try JSONDecoder().decode(
            TalkRealtimeAgentWaitResponse.self,
            from: Data(#"{"runId":"run-legacy","status":"ok"}"#.utf8))

        #expect(response.authoritativeResultText == nil)
        #expect(TalkRealtimeAgentWaitResultError.finalReplyUnavailable.localizedDescription.contains("Update OpenClaw"))
    }
}
