import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct MacGatewayChatTransportMappingTests {
    private actor ProgressRequestRecorder {
        var params: [Data] = []

        func append(_ data: Data) {
            self.params.append(data)
        }

        func snapshot() -> [Data] {
            self.params
        }
    }

    @Test(arguments: [false, true, nil] as [Bool?])
    func `progress requests negotiate owner scope on the connected server`(supportsOwner: Bool?) async throws {
        let recorder = ProgressRequestRecorder()
        let socketSession = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                var payload = "{}"
                if frame["method"] as? String == "progressCard.get" {
                    let params = try #require(frame["params"] as? [String: Any])
                    try await recorder.append(JSONSerialization.data(withJSONObject: params))
                    // A released server's closed schema rejects the extra owner field.
                    #expect(supportsOwner == true || params["agentId"] == nil)
                    let owner = params["agentId"] as? String ??
                        OpenClawChatSessionKey.agentID(from: params["sessionKey"] as? String) ?? "main"
                    payload = #"{"card":{"sessionKey":"agent:\#(owner):global","revision":1,"updatedAt":10,"markdown":"\#(owner)","steps":[]}}"#
                }
                socket
                    .emitReceiveSuccess(.data(Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                            .utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let hello = GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: ["progressCard.get"],
                    capabilities: supportsOwner == true ? ["progress-card-agent-scope-v1"] : [])
                guard supportsOwner == nil else { return .data(hello) }
                var frame = try #require(JSONSerialization.jsonObject(with: hello) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var features = try #require(payload["features"] as? [String: Any])
                features.removeValue(forKey: "capabilities")
                payload["features"] = features
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: socketSession))
        do {
            _ = try await gateway.request(method: "health", params: nil)
            let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "main")
            let ordinary = try await transport.fetchProgressCard(
                sessionKey: "agent:research:global",
                agentID: "research")
            #expect(ordinary?.markdown == "research")
            if supportsOwner == true {
                let global = try await transport.fetchProgressCard(sessionKey: "global", agentID: "research")
                #expect(global?.markdown == "research")
            } else {
                do {
                    _ = try await transport.fetchProgressCard(sessionKey: "global", agentID: "research")
                    Issue.record("Unadvertised owner-scoped progress must not dispatch")
                } catch let error as NSError {
                    #expect(error.localizedDescription == OpenClawChatTransportUpgradeMessage.progressCardAgentScope)
                }
            }
            let params = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: String])
            }
            #expect(params == (supportsOwner == true ? [
                ["sessionKey": "agent:research:global"],
                ["sessionKey": "global", "agentId": "research"],
            ] : [["sessionKey": "agent:research:global"]]))
            await gateway.shutdown()
        } catch {
            await gateway.shutdown()
            throw error
        }
    }

    @Test func `mac chat advertises typed agent rosters and inline widgets`() {
        #expect(GatewayConnection.operatorClientCaps == [
            OpenClawGatewayClientCapability.agentKind,
            OpenClawGatewayClientCapability.inlineWidgets,
            OpenClawGatewayClientCapability.usageRefreshing,
        ])
    }

    @Test func `bare global session target carries normalized selected agent`() {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: "  Agent-A  ")

        #expect(transport.sessionTarget(for: " GLOBAL ") == .init(
            sessionKey: "GLOBAL",
            agentID: "agent-a"))
        #expect(transport.sessionTarget(for: "agent:agent-a:main") == .init(
            sessionKey: "agent:agent-a:main",
            agentID: nil))
        #expect(transport.sessionTarget(for: "main") == .init(
            sessionKey: "main",
            agentID: nil))

        let snapshotObserverTransport = transport
        snapshotObserverTransport.updateDefaultGlobalAgentID("Agent-B")
        #expect(transport.sessionTarget(for: "global") == .init(
            sessionKey: "global",
            agentID: "agent-b"))
    }

    @Test func `bare global session target tolerates missing selected agent`() {
        let transport = MacGatewayChatTransport()

        #expect(transport.sessionTarget(for: "global") == .init(
            sessionKey: "global",
            agentID: nil))
    }

    @Test func `session list request follows the current routing agent`() {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: "  Agent-A  ")

        let first = transport.sessionsListRequest(limit: 50, search: nil, archived: false)
        #expect(first.params["agentId"]?.value as? String == "agent-a")

        transport.updateDefaultGlobalAgentID("Agent-B")
        let second = transport.sessionsListRequest(limit: nil, search: "recent", archived: true)
        #expect(second.params["agentId"]?.value as? String == "agent-b")

        let unowned = MacGatewayChatTransport()
            .sessionsListRequest(limit: nil, search: nil, archived: false)
        #expect(unowned.params["agentId"] == nil)
    }

    @Test func `fixed connection does not inherit app wide cache routing`() async throws {
        let url = try #require(URL(string: "wss://fixed.example"))
        let connection = GatewayConnection(configProvider: {
            (url: url, token: nil, password: nil)
        })
        let transport = MacGatewayChatTransport(
            connection: connection,
            outboxGatewayID: "manual-fixed")

        #expect(await transport.currentOutboxGatewayMatchesConnection())
        await connection.shutdown()
    }

    @Test func `session settings request preserves verbosity patch`() {
        let request = MacGatewayChatTransport.sessionSettingsRequest(
            sessionKey: "global",
            agentID: "reviewer",
            patch: OpenClawChatSessionSettingsPatch(
                model: .some("openai/gpt-5.6-sol"),
                thinkingLevel: .some(nil),
                fastMode: .some(.on),
                verboseLevel: .some("full")))

        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["model"]?.value as? String == "openai/gpt-5.6-sol")
        #expect(request.params["thinkingLevel"]?.value is NSNull)
        #expect(request.params["fastMode"]?.value as? Bool == true)
        #expect(request.params["verboseLevel"]?.value as? String == "full")
    }

    @Test func `full message request uses generated gateway field names`() throws {
        let request = try MacGatewayChatTransport.fullMessageRequest(
            sessionKey: "global",
            agentID: "reviewer",
            messageID: "msg-42")

        #expect(request.method == "chat.message.get")
        #expect(request.params["sessionKey"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["messageId"]?.value as? String == "msg-42")
        #expect(request.params["maxChars"]?.value as? Int == 500_000)
    }

    @Test func `message rewind and fork requests map session targets`() {
        let rewind = MacGatewayChatTransport.rewindSessionRequest(
            sessionKey: "global",
            agentID: "reviewer",
            entryId: "msg-42")
        let fork = MacGatewayChatTransport.forkSessionAtMessageRequest(
            sessionKey: "agent:reviewer:main",
            agentID: nil,
            entryId: "msg-43")

        #expect(rewind.method == "sessions.rewind")
        #expect(rewind.params["sessionKey"]?.value as? String == "global")
        #expect(rewind.params["agentId"]?.value as? String == "reviewer")
        #expect(rewind.params["entryId"]?.value as? String == "msg-42")
        #expect(fork.method == "sessions.fork")
        #expect(fork.params["sessionKey"]?.value as? String == "agent:reviewer:main")
        #expect(fork.params["agentId"] == nil)
        #expect(fork.params["entryId"]?.value as? String == "msg-43")
    }

    @Test func `legacy trace preference migrates to independent defaults once`() throws {
        let suiteName = "MacGatewayChatTransportMappingTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: OpenClawChatWindowShell.assistantTraceDefaultsKey)

        #expect(WebChatTracePreferences.displayOptions(defaults: defaults).isEmpty)
        #expect(defaults.object(forKey: OpenClawChatWindowShell.assistantReasoningDefaultsKey) as? Bool == false)
        #expect(defaults.object(forKey: OpenClawChatWindowShell.assistantToolActivityDefaultsKey) as? Bool == false)

        defaults.set(true, forKey: OpenClawChatWindowShell.assistantReasoningDefaultsKey)
        #expect(WebChatTracePreferences.displayOptions(defaults: defaults) == [.reasoning])
    }

    @Test func `snapshot maps to health`() {
        let snapshot = Snapshot(
            presence: [],
            health: ["ok": OpenClawProtocol.AnyCodable(false)],
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
            controluitabs: nil,
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
            if case .tick = mapped {
                return true
            }
            return false
        }())
    }

    @Test func `sessions changed event maps to authoritative refresh signal`() {
        let payload = OpenClawProtocol.AnyCodable([
            "sessionKey": OpenClawProtocol.AnyCodable("agent:main:main"),
            "agentId": OpenClawProtocol.AnyCodable("main"),
            "reason": OpenClawProtocol.AnyCodable("command-metadata"),
        ])
        let frame = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: payload,
            seq: 1,
            stateversion: nil)

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        guard case let .sessionsChanged(change) = mapped else {
            Issue.record("expected .sessionsChanged, got \(String(describing: mapped))")
            return
        }
        #expect(change == .init(
            sessionKey: "agent:main:main",
            agentId: "main",
            reason: "command-metadata"))
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
            if case .seqGap = mapped {
                return true
            }
            return false
        }())
    }
}
