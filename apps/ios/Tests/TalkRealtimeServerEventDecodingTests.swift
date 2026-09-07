import Foundation
import Testing
@testable import OpenClaw

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
}
