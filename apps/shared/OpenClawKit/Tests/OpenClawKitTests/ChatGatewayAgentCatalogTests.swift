import Foundation
import OpenClawChatUI
import Testing

struct ChatGatewayAgentCatalogTests {
    @Test(arguments: ["[]", #"[{"id":"system","kind":"system"}]"#])
    func `empty selectable rosters preserve the server default`(agents: String) throws {
        let data = Data("""
        {"defaultId":"system","mainKey":"main","scope":"per-agent","agents":\(agents)}
        """.utf8)

        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data) ==
            OpenClawChatAgentsListResponse(defaultId: "system", agents: []))
    }

    @Test(arguments: [
        #"{"defaultId":"main","scope":"per-agent","agents":[]}"#,
        #"{"defaultId":"main","mainKey":"main","agents":[]}"#,
        #"{"defaultId":"main","mainKey":"main","scope":"per-agent","agents":[{"id":"main","kind":"unknown"}]}"#,
    ])
    func `malformed gateway rosters retain protocol decoding failures`(payload: String) {
        #expect(throws: DecodingError.self) {
            try OpenClawChatGatewayPayloadCodec.decodeAgentsList(Data(payload.utf8))
        }
    }
}
