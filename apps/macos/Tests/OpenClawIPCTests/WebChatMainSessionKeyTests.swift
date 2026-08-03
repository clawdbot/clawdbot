import Foundation
import Testing
@testable import OpenClaw

struct WebChatMainSessionKeyTests {
    @Test func `config get snapshot main key falls back to main when missing`() throws {
        let json = """
        {
          "path": "/Users/pete/.openclaw/openclaw.json",
          "exists": true,
          "raw": null,
          "parsed": {},
          "valid": true,
          "config": {},
          "issues": []
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot main key trims and uses value`() throws {
        let json = """
        {
          "path": "/Users/pete/.openclaw/openclaw.json",
          "exists": true,
          "raw": null,
          "parsed": {},
          "valid": true,
          "config": { "session": { "mainKey": "  primary  " } },
          "issues": []
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot main key falls back when empty or whitespace`() throws {
        let json = """
        {
          "config": { "session": { "mainKey": "   " } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot main key falls back when config null`() throws {
        let json = """
        {
          "config": null
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot uses global scope`() throws {
        let json = """
        {
          "config": { "session": { "scope": "global" } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "global")
    }
}
