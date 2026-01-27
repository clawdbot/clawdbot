import Foundation
import Testing
@testable import MoltbotKit
import MoltbotProtocol

struct GatewayNodeSessionTests {
    @Test
    func invokeWithTimeoutReturnsUnderlyingResponseBeforeTimeout() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 50,
            onInvoke: { req in
                #expect(req.id == "1")
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}", error: nil)
            }
        )

        #expect(response.ok == true)
        #expect(response.error == nil)
        #expect(response.payloadJSON == "{}")
    }

    @Test
    func invokeWithTimeoutReturnsTimeoutError() async {
        let request = BridgeInvokeRequest(id: "abc", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 10,
            onInvoke: { _ in
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                return BridgeInvokeResponse(id: "abc", ok: true, payloadJSON: "{}", error: nil)
            }
        )

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message.contains("timed out") == true)
    }

    @Test
    func invokeWithTimeoutZeroDisablesTimeout() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 0,
            onInvoke: { req in
                try? await Task.sleep(nanoseconds: 5_000_000)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            }
        )

        #expect(response.ok == true)
        #expect(response.error == nil)
    }
}
