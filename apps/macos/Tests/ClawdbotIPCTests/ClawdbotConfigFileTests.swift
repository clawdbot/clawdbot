import Foundation
import Testing
@testable import Clawdbot

@Suite(.serialized)
struct ClawdbotConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        await TestIsolation.withEnvValues(["CLAWDBOT_CONFIG_PATH": override]) {
            #expect(ClawdbotConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        await TestIsolation.withEnvValues(["CLAWDBOT_CONFIG_PATH": override]) {
            ClawdbotConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://bridge.ts.net:19999",
                    ],
                ],
            ])
            #expect(ClawdbotConfigFile.remoteGatewayPort() == 19999)
            #expect(ClawdbotConfigFile.remoteGatewayPort(matchingHost: "bridge.ts.net") == 19999)
            #expect(ClawdbotConfigFile.remoteGatewayPort(matchingHost: "bridge") == 19999)
            #expect(ClawdbotConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        await TestIsolation.withEnvValues(["CLAWDBOT_CONFIG_PATH": override]) {
            ClawdbotConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            ClawdbotConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = ClawdbotConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "CLAWDBOT_CONFIG_PATH": nil,
            "CLAWDBOT_STATE_DIR": dir,
        ]) {
            #expect(ClawdbotConfigFile.stateDirURL().path == dir)
            #expect(ClawdbotConfigFile.url().path == "\(dir)/clawdbot.json")
        }
    }
}
