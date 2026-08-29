import Foundation
import Testing
@testable import OpenClawKit

struct BridgeInvokeMetadataTests {
    @Test func `outer invoke metadata survives the native bridge`() throws {
        let raw = #"{"id":"invoke","command":"system.worker.start","nodeId":"node","paramsJSON":"{\"sessionKey\":\"untrusted\"}","sessionKey":"agent:main:owner","timeoutMs":42000,"idempotencyKey":"attempt","type":"invoke"}"#
        let request = try JSONDecoder().decode(BridgeInvokeRequest.self, from: Data(raw.utf8))
        let encoded = try JSONEncoder().encode(request)
        let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(actual["sessionKey"] as? String == "agent:main:owner")
        #expect(actual["timeoutMs"] as? Int == 42000)
        #expect(actual["idempotencyKey"] as? String == "attempt")
    }
}
