import Foundation
import OpenClawProtocol
import Testing

struct GatewayModelsCompatibilityTests {
    @Test
    func `agents workspace encoding remains AnyCodable`() {
        let file = AgentsWorkspaceFile(
            path: "notes.txt",
            name: "notes.txt",
            size: 5,
            updatedatms: 1,
            mimetype: "text/plain",
            encoding: AnyCodable("utf8"),
            content: "hello")

        #expect(file.encoding.value as? String == "utf8")
    }

    private func roundTripGatewayFrame(_ json: String) throws -> GatewayFrame {
        let decoded = try JSONDecoder().decode(GatewayFrame.self, from: Data(json.utf8))
        let encoded = try JSONEncoder().encode(decoded)
        return try JSONDecoder().decode(GatewayFrame.self, from: encoded)
    }

    @Test
    func `optional fields stay additive around required fields`() {
        let params = PluginApprovalRequestParams(
            title: "Install plugin",
            description: "Review requested")

        #expect(params.pluginid == nil)
        #expect(params.approvalreviewerdeviceids == nil)
    }

    @Test
    func `optional fields stay additive before trailing required fields`() {
        let params = MessageActionParams(
            channel: "slack",
            action: "member-info",
            params: [:],
            idempotencykey: "test")

        #expect(params.accountid == nil)
        #expect(params.requesteraccountid == nil)
    }

    @Test
    func `strict literal model optional fields default to nil`() {
        let result = PluginsSessionActionSuccessResult()

        #expect(result.ok)
        #expect(result.result == nil)
    }

    @Test
    func `session group results decode older gateway payloads`() throws {
        let list = try JSONDecoder().decode(
            SessionsGroupsListResult.self,
            from: Data(#"{"groups":[]}"#.utf8))
        let mutation = try JSONDecoder().decode(
            SessionsGroupsMutationResult.self,
            from: Data(#"{"ok":true,"groups":[]}"#.utf8))

        #expect(list.sectionorder == nil)
        #expect(mutation.sectionorder == nil)
    }

    @Test
    func `device pair setup results decode older gateway payloads`() throws {
        let result = try JSONDecoder().decode(
            DevicePairSetupCodeResult.self,
            from: Data(
                #"{"setupCode":"opaque-code","gatewayUrl":"wss://gateway.example","auth":"token","urlSource":"gateway.remote.url"}"#
                    .utf8))

        #expect(result.setupid == nil)
        #expect(result.expiresatms == nil)
        #expect(result.setupcode == "opaque-code")
    }

    @Test
    func `generated models ignore additive gateway fields`() throws {
        let result = try JSONDecoder().decode(
            SessionsGroupsListResult.self,
            from: Data(#"{"groups":[],"futureField":{"ignored":true}}"#.utf8))

        #expect(result.groups.isEmpty)
        #expect(result.sectionorder == nil)
    }

    @Test
    func `session compaction checkpoint preserves canonical token version casing`() throws {
        let checkpoint = SessionCompactionCheckpoint(
            checkpointid: "checkpoint-1",
            sessionkey: "main",
            sessionid: "session-1",
            createdat: 1,
            reason: AnyCodable("manual"),
            tokensVersion: 1,
            precompaction: [:],
            postcompaction: [:])

        #expect(checkpoint.tokensVersion == 1)

        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(checkpoint))
        let encodedJSON = try #require(encoded as? [String: Any])
        #expect(encodedJSON.keys.contains("tokensVersion"))
        #expect(!encodedJSON.keys.contains("tokensversion"))

        let decoded = try JSONDecoder().decode(
            SessionCompactionCheckpoint.self,
            from: Data(
                #"{"checkpointId":"checkpoint-2","sessionKey":"main","sessionId":"session-2","createdAt":2,"reason":"manual","tokensVersion":1,"preCompaction":{},"postCompaction":{}}"#
                    .utf8))

        #expect(decoded.tokensVersion == 1)
    }

    @Test
    func `request frames round trip current payloads`() throws {
        let frame = try self.roundTripGatewayFrame(
            #"{"type":"req","id":"req-1","method":"sessions.list","params":{"limit":20}}"#)

        guard case let .req(request) = frame else {
            Issue.record("Expected a request frame")
            return
        }
        let params = try #require(request.params?.value as? [String: AnyCodable])

        #expect(request.id == "req-1")
        #expect(request.method == "sessions.list")
        #expect(params["limit"] == AnyCodable(20))
    }

    @Test
    func `response frames round trip current payloads`() throws {
        let frame = try self.roundTripGatewayFrame(
            #"{"type":"res","id":"req-1","ok":true,"payload":{"sessions":[]}}"#)

        guard case let .res(response) = frame else {
            Issue.record("Expected a response frame")
            return
        }
        let payload = try #require(response.payload?.value as? [String: AnyCodable])

        #expect(response.id == "req-1")
        #expect(response.ok)
        #expect(payload["sessions"] == AnyCodable([Any]()))
    }

    @Test
    func `event frames round trip current payloads`() throws {
        let frame = try self.roundTripGatewayFrame(
            #"{"type":"event","event":"tick","payload":{"ts":123},"seq":7,"stateVersion":{"presence":2,"health":3}}"#)

        guard case let .event(event) = frame else {
            Issue.record("Expected an event frame")
            return
        }
        let payload = try #require(event.payload?.value as? [String: AnyCodable])

        #expect(event.event == "tick")
        #expect(event.seq == 7)
        #expect(event.stateversion?.presence == 2)
        #expect(event.stateversion?.health == 3)
        #expect(payload["ts"] == AnyCodable(123))
    }

    @Test
    func `chat send canonical initializer stays unambiguous`() {
        let params = ChatSendParams(
            sessionkey: "main",
            message: "hello",
            idempotencykey: "test")
        let legacyParams = ChatSendParams(
            sessionkey: "main",
            message: "hello",
            fastmode: true,
            idempotencykey: "test")

        #expect(params.agentid == nil)
        #expect(params.fastmodevalue == nil)
        #expect(legacyParams.fastmode == true)
    }

    @Test
    func `agent update model keeps legacy source compatibility and nullable wire semantics`() throws {
        let legacyParams = AgentsUpdateParams(agentid: "work", model: "openai/gpt-5.6")
        let omittedParams = AgentsUpdateParams(agentid: "work")
        let clearedParams = AgentsUpdateParams(agentid: "work", modelvalue: AnyCodable(NSNull()))

        #expect(legacyParams.model == "openai/gpt-5.6")
        #expect(omittedParams.modelvalue == nil)

        let legacyJSON = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(legacyParams))
                as? [String: Any])
        let omittedJSON = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(omittedParams))
                as? [String: Any])
        let clearedJSON = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(clearedParams))
                as? [String: Any])

        #expect(legacyJSON["model"] as? String == "openai/gpt-5.6")
        #expect(omittedJSON["model"] == nil)
        #expect(clearedJSON["model"] is NSNull)

        let decodedOmitted = try JSONDecoder().decode(
            AgentsUpdateParams.self,
            from: Data(#"{"agentId":"work"}"#.utf8))
        let decodedCleared = try JSONDecoder().decode(
            AgentsUpdateParams.self,
            from: Data(#"{"agentId":"work","model":null}"#.utf8))
        let reencodedCleared = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(decodedCleared))
                as? [String: Any])

        #expect(decodedOmitted.modelvalue == nil)
        #expect(decodedCleared.modelvalue?.value is NSNull)
        #expect(reencodedCleared["model"] is NSNull)
    }
}
