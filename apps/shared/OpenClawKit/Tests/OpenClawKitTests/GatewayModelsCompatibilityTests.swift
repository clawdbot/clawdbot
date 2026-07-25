import Foundation
import OpenClawProtocol
import Testing

struct GatewayModelsCompatibilityTests {
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
