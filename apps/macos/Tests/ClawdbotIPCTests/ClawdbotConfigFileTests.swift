import Foundation
import Testing
@testable import Moltbot

@Suite(.serialized)
struct MoltbotConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-config-\(UUID().uuidString)")
            .appendingPathComponent("moltbot.json")
            .path

        await TestIsolation.withEnvValues(["CLAWDBOT_CONFIG_PATH": override]) {
            #expect(MoltbotConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-config-\(UUID().uuidString)")
            .appendingPathComponent("moltbot.json")
            .path

        await TestIsolation.withEnvValues(["CLAWDBOT_CONFIG_PATH": override]) {
            MoltbotConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(MoltbotConfigFile.remoteGatewayPort() == 19999)
            #expect(MoltbotConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(MoltbotConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(MoltbotConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-config-\(UUID().uuidString)")
            .appendingPathComponent("moltbot.json")
            .path

        await TestIsolation.withEnvValues(["CLAWDBOT_CONFIG_PATH": override]) {
            MoltbotConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            MoltbotConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = MoltbotConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "CLAWDBOT_CONFIG_PATH": nil,
            "CLAWDBOT_STATE_DIR": dir,
        ]) {
            #expect(MoltbotConfigFile.stateDirURL().path == dir)
            #expect(MoltbotConfigFile.url().path == "\(dir)/moltbot.json")
        }
    }
}
