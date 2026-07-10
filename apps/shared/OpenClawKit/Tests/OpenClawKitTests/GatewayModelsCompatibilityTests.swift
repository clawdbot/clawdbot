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
}
