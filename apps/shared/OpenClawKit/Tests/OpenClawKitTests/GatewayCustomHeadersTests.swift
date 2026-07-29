import Foundation
import Testing
@testable import OpenClawKit

struct GatewayCustomHeadersTests {
    @Test func `sanitized keeps operator proxy credential headers`() {
        let headers = GatewayCustomHeaders.sanitized([
            "CF-Access-Client-Id": "client-id",
            "CF-Access-Client-Secret": "client-secret",
            "Authorization": "Basic dXNlcjpwYXNz",
        ])
        #expect(headers == [
            "CF-Access-Client-Id": "client-id",
            "CF-Access-Client-Secret": "client-secret",
            "Authorization": "Basic dXNlcjpwYXNz",
        ])
    }

    @Test func `sanitized drops reserved handshake header names`() {
        let headers = GatewayCustomHeaders.sanitized([
            "Host": "evil.example",
            "connection": "close",
            "Upgrade": "h2c",
            "Sec-WebSocket-Protocol": "override",
            "sec-websocket-key": "override",
            "Content-Length": "0",
            "Proxy-Connection": "keep-alive",
            "X-Allowed": "yes",
        ])
        #expect(headers == ["X-Allowed": "yes"])
    }

    @Test func `sanitized drops invalid names and control characters`() {
        let headers = GatewayCustomHeaders.sanitized([
            "": "value",
            "   ": "value",
            "X Bad": "value",
            "X:Bad": "value",
            "X-Bad-é": "value",
            "X-Split\r\nEvil": "value",
            "X-Value-Split": "a\r\nEvil: b",
            "X-Tab-Value": "a\tb",
            "X-Fine": "value",
        ])
        #expect(headers == ["X-Fine": "value"])
    }

    @Test func `reserved name check is case and whitespace insensitive`() {
        #expect(GatewayCustomHeaders.isReservedName(" HOST "))
        #expect(GatewayCustomHeaders.isReservedName("Sec-WebSocket-Extensions"))
        #expect(!GatewayCustomHeaders.isReservedName("CF-Access-Client-Id"))
    }
}
