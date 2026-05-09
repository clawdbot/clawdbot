import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConfigStoreTests {
    @Test func `load uses remote in remote mode`() async {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))

        let result = await ConfigStore.load()

        await ConfigStore._testClearOverrides()
        #expect(remoteHit)
        #expect(!localHit)
        #expect(result["remote"] as? Bool == true)
    }

    @Test func `load uses local in local mode`() async {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))

        let result = await ConfigStore.load()

        await ConfigStore._testClearOverrides()
        #expect(localHit)
        #expect(!remoteHit)
        #expect(result["local"] as? Bool == true)
    }

    @Test func `save routes to remote in remote mode`() async throws {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))

        try await ConfigStore.save(["remote": true])

        await ConfigStore._testClearOverrides()
        #expect(remoteHit)
        #expect(!localHit)
    }

    @Test func `save routes to local in local mode`() async throws {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { false },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))

        try await ConfigStore.save(["local": true])

        await ConfigStore._testClearOverrides()
        #expect(localHit)
        #expect(!remoteHit)
    }

    @Test func `local save does not fall back to direct write after stale gateway rejection`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                    "auth": [
                        "mode": "token",
                        "token": "test-token", // pragma: allowlist secret
                    ],
                ],
            ])
            let before = try String(contentsOf: configPath, encoding: .utf8)
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { false },
                saveGateway: { _ in
                    throw NSError(domain: "Gateway", code: 0, userInfo: [
                        NSLocalizedDescriptionKey: "config changed since last load; re-run config.get and retry",
                    ])
                }))

            var didThrow = false
            do {
                try await ConfigStore.save(["browser": ["enabled": false]])
            } catch {
                didThrow = true
            }
            await ConfigStore._testClearOverrides()

            #expect(didThrow)
            let after = try String(contentsOf: configPath, encoding: .utf8)
            #expect(after == before)
        }
    }

    @Test func `local save can fall back to protected direct write when gateway is unavailable`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { false },
                saveGateway: { _ in
                    throw NSError(domain: "Gateway", code: 0, userInfo: [
                        NSLocalizedDescriptionKey: "gateway not configured",
                    ])
                }))
            try await ConfigStore.save([
                "gateway": ["mode": "local"],
                "browser": ["enabled": false],
            ])
            await ConfigStore._testClearOverrides()

            let data = try Data(contentsOf: configPath)
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            #expect(((root?["browser"] as? [String: Any])?["enabled"] as? Bool) == false)
            #expect((root?["meta"] as? [String: Any]) != nil)
        }
    }
}
