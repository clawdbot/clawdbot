import Foundation
import Testing
@testable import Moltbot

@Suite struct WebChatMainSessionKeyTests {
    @Test func configGetSnapshotMainKeyFallsBackToMainWhenMissing() throws {
        let json = """
        {
          "path": "/Users/pete/.clawdbot/moltbot.json",
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

    @Test func configGetSnapshotMainKeyTrimsAndUsesValue() throws {
        let json = """
        {
          "path": "/Users/pete/.clawdbot/moltbot.json",
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

    @Test func configGetSnapshotMainKeyFallsBackWhenEmptyOrWhitespace() throws {
        let json = """
        {
          "config": { "session": { "mainKey": "   " } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func configGetSnapshotMainKeyFallsBackWhenConfigNull() throws {
        let json = """
        {
          "config": null
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func configGetSnapshotUsesGlobalScope() throws {
        let json = """
        {
          "config": { "session": { "scope": "global" } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "global")
    }
}
