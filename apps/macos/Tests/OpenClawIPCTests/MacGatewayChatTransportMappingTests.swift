import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct MacGatewayChatTransportMappingTests {
    @Test func `snapshot maps to health`() {
        let snapshot = Snapshot(
            presence: [],
            health: OpenClawProtocol.AnyCodable(["ok": OpenClawProtocol.AnyCodable(false)]),
            stateversion: StateVersion(presence: 1, health: 1),
            uptimems: 123,
            configpath: nil,
            statedir: nil,
            sessiondefaults: nil,
            authmode: nil,
            updateavailable: nil)

        let hello = HelloOk(
            type: "hello",
            _protocol: 2,
            server: [:],
            features: [:],
            snapshot: snapshot,
            pluginsurfaceurls: nil,
            auth: [:],
            policy: [:])

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.snapshot(hello))
        switch mapped {
        case let .health(ok):
            #expect(ok == false)
        default:
            Issue.record("expected .health from snapshot, got \(String(describing: mapped))")
        }
    }

    @Test func `health event maps to health`() {
        let frame = EventFrame(
            type: "event",
            event: "health",
            payload: OpenClawProtocol.AnyCodable(["ok": OpenClawProtocol.AnyCodable(true)]),
            seq: 1,
            stateversion: nil)

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        switch mapped {
        case let .health(ok):
            #expect(ok == true)
        default:
            Issue.record("expected .health from health event, got \(String(describing: mapped))")
        }
    }

    @Test func `tick event maps to tick`() {
        let frame = EventFrame(type: "event", event: "tick", payload: nil, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        #expect({
            if case .tick = mapped { return true }
            return false
        }())
    }

    @Test func `chat event maps to chat`() {
        let payload = OpenClawProtocol.AnyCodable([
            "runId": OpenClawProtocol.AnyCodable("run-1"),
            "sessionKey": OpenClawProtocol.AnyCodable("main"),
            "state": OpenClawProtocol.AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func `session message event maps to session message`() {
        let payload = OpenClawProtocol.AnyCodable([
            "sessionKey": OpenClawProtocol.AnyCodable("agent:main:main"),
            "messageId": OpenClawProtocol.AnyCodable("msg-1"),
            "messageSeq": OpenClawProtocol.AnyCodable(7),
            "message": OpenClawProtocol.AnyCodable([
                "role": OpenClawProtocol.AnyCodable("user"),
                "content": OpenClawProtocol.AnyCodable([
                    OpenClawProtocol.AnyCodable([
                        "type": OpenClawProtocol.AnyCodable("text"),
                        "text": OpenClawProtocol.AnyCodable("spoken transcript"),
                    ]),
                ]),
                "timestamp": OpenClawProtocol.AnyCodable(1234.5),
            ]),
        ])
        let frame = EventFrame(type: "event", event: "session.message", payload: payload, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))

        switch mapped {
        case let .sessionMessage(message):
            #expect(message.sessionKey == "agent:main:main")
            #expect(message.messageId == "msg-1")
            #expect(message.messageSeq == 7)
            #expect(message.message?.role == "user")
            #expect(message.message?.content.first?.text == "spoken transcript")
        default:
            Issue.record("expected .sessionMessage from session.message event, got \(String(describing: mapped))")
        }
    }

    @Test func `unknown event maps to nil`() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: OpenClawProtocol.AnyCodable(["a": OpenClawProtocol.AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        #expect(mapped == nil)
    }

    @Test func `seq gap maps to seq gap`() {
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.seqGap(expected: 1, received: 9))
        #expect({
            if case .seqGap = mapped { return true }
            return false
        }())
    }
}
