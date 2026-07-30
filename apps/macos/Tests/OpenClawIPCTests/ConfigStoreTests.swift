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
        let notificationCenter = NotificationCenter()
        let changeCount = NotificationCount()
        let observer = notificationCenter.addObserver(
            forName: .openclawConfigDidChange,
            object: nil,
            queue: nil)
        { note in changeCount.record(note) }
        defer { notificationCenter.removeObserver(observer) }

        try await self.withOverrides(.init(
            isRemoteMode: { true },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in
                remoteHit = true
                // Reproduce a concurrent AppState-style publisher overlapping this save.
                await Task.detached {
                    NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
                }.value
            },
            notificationCenter: notificationCenter))
        {
            try await ConfigStore.save(["remote": true])
        }

        #expect(remoteHit)
        #expect(!localHit)
        #expect(changeCount.value == 1)
        #expect(changeCount.allSendersWereNil)
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

    @Test func `failed save does not announce config change`() async {
        let notificationCenter = NotificationCenter()
        let changeCount = NotificationCount()
        let observer = notificationCenter.addObserver(
            forName: .openclawConfigDidChange,
            object: nil,
            queue: nil)
        { note in changeCount.record(note) }
        defer { notificationCenter.removeObserver(observer) }

        await self.withOverrides(.init(
            isRemoteMode: { true },
            saveRemote: { _ in
                // Concurrent same-name traffic must not look like a ConfigStore announcement.
                await Task.detached {
                    NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
                }.value
                throw NSError(domain: "ConfigStoreTests", code: 1)
            },
            notificationCenter: notificationCenter))
        {
            do {
                try await ConfigStore.save(["remote": true])
                Issue.record("Expected save to fail")
            } catch {}
        }

        #expect(changeCount.value == 0)
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

    private func withOverrides<T>(
        _ overrides: ConfigStore.Overrides,
        _ body: () async throws -> T) async rethrows -> T
    {
        await ConfigStore._testSetOverrides(overrides)
        do {
            let result = try await body()
            await ConfigStore._testClearOverrides()
            return result
        } catch {
            await ConfigStore._testClearOverrides()
            throw error
        }
    }
}

private final class NotificationCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var sawNonNilSender = false

    var value: Int {
        self.lock.withLock { self.count }
    }

    var allSendersWereNil: Bool {
        self.lock.withLock { !self.sawNonNilSender }
    }

    func record(_ notification: Notification) {
        self.lock.withLock {
            self.count += 1
            self.sawNonNilSender = self.sawNonNilSender || notification.object != nil
        }
    }
}
