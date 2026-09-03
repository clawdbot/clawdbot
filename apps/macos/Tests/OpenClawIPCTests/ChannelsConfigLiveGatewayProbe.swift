import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

/// Races a save against a live Gateway with no fetch override, so the snapshot that lands is
/// one the Gateway really produced.
///
/// Set OPENCLAW_PROOF_GATEWAY=1 with OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN.
///
/// This writes config, so per AGENTS.md it runs only against a session-owned dev Gateway:
/// loopback, an isolated OPENCLAW_STATE_DIR, and never the operator's default port 18789.
/// It also puts the original config back before asserting, so a failing run restores too.
@Suite(.serialized)
@MainActor
struct ChannelsConfigLiveGatewayProbe {
    @Test func `an edit during a real gateway save survives the reload`() async {
        guard ProcessInfo.processInfo.environment["OPENCLAW_PROOF_GATEWAY"] == "1" else { return }
        if let refusal = Self.refusalReason() {
            Issue.record("probe writes config, so it refuses this Gateway: \(refusal)")
            return
        }
        guard let original = await Self.fetch() else {
            Issue.record("could not read the Gateway config to restore afterwards")
            return
        }
        // The environment only says what this process asked for. GatewayEndpointStore
        // resolves the real target from config, defaults and stored routes, so the connection
        // can land somewhere the checks above never saw. config.get reports the file the
        // Gateway is actually serving, which is the one thing that proves who is on the other
        // end. Nothing is written until this passes.
        if let refusal = Self.ownershipRefusal(original) {
            Issue.record("probe writes config, so it refuses this Gateway: \(refusal)")
            return
        }

        let store = ChannelsStore(isPreview: true)
        store.configSourceKey = nil
        await store.loadConfig()
        print("PROOF load status=\(store.configStatus ?? "nil") loaded=\(store.configLoaded)")

        // A is what the save submits. B is typed while that write is in flight.
        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: true)
        print("PROOF A submitted dirty=\(store.configDirty) value=\(Self.discordEnabled(store) as Any)")

        let gate = SaveGate()
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveRemote: { root in
                // A real write to the real Gateway, then hold so an edit can land behind it.
                try await Self.write(root)
                await gate.wait()
            }))

        let saving = Task { await store.saveConfigDraft() }
        let reachedWrite = await gate.waitUntilEntered()
        print("PROOF save reached the gateway write: \(reachedWrite)")

        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: false)
        print("PROOF B typed mid-flight value=\(Self.discordEnabled(store) as Any)")

        await gate.release()
        await saving.value
        await ConfigStore._testClearOverrides()

        print("PROOF after status=\(store.configStatus ?? "nil")")
        print("PROOF after value=\(Self.discordEnabled(store) as Any) dirty=\(store.configDirty)")

        let status = store.configStatus
        let value = Self.discordEnabled(store)
        let dirty = store.configDirty

        // Put the Gateway back the way it was before asserting, so a failure still restores.
        let restored = await Self.restore(original)
        print("PROOF restored original config: \(restored)")

        #expect(reachedWrite)
        #expect(status == nil)
        #expect(value == false)
        #expect(dirty == true)
        #expect(restored)
    }

    /// AGENTS.md: live gateway tests use a session owned dev gateway only, isolated
    /// OPENCLAW_STATE_DIR and a free port, never the operator's gateway port while it runs.
    ///
    /// This checks the values that actually route the connection. `GatewayEndpointStore`
    /// resolves the port from OPENCLAW_GATEWAY_PORT and the loaded config, not from a URL,
    /// so checking a URL here would pass while the app connected somewhere else entirely.
    static func refusalReason() -> String? {
        let env = ProcessInfo.processInfo.environment
        guard let rawPort = env["OPENCLAW_GATEWAY_PORT"], let port = Int(rawPort) else {
            return "OPENCLAW_GATEWAY_PORT is not set, so the port is whatever the operator uses"
        }
        if port == Self.operatorDefaultPort {
            return "port \(port) is the operator default"
        }
        guard let stateDir = env["OPENCLAW_STATE_DIR"], !stateDir.isEmpty else {
            return "OPENCLAW_STATE_DIR is not set, so the state is not isolated"
        }
        guard let configPath = env["OPENCLAW_CONFIG_PATH"], !configPath.isEmpty else {
            return "OPENCLAW_CONFIG_PATH is not set, so this would read the operator's config"
        }
        return nil
    }

    static let operatorDefaultPort = 18789

    /// Confirms the Gateway on the other end serves the isolated config this run set up,
    /// rather than trusting that the environment routed us where we asked.
    static func ownershipRefusal(_ snapshot: ConfigSnapshot) -> String? {
        guard let expected = ProcessInfo.processInfo.environment["OPENCLAW_CONFIG_PATH"],
              !expected.isEmpty
        else {
            return "OPENCLAW_CONFIG_PATH is not set, so the served config cannot be checked"
        }
        guard let served = snapshot.path, !served.isEmpty else {
            return "the Gateway did not report which config file it serves"
        }
        guard Self.samePath(served, expected) else {
            return "the Gateway serves \(served), not the isolated config at \(expected)"
        }
        return nil
    }

    static func samePath(_ left: String, _ right: String) -> Bool {
        let resolve = { (path: String) -> String in
            URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        }
        return resolve(left) == resolve(right)
    }

    static func fetch() async -> ConfigSnapshot? {
        try? await GatewayConnection.shared.requestDecoded(
            method: .configGet,
            params: nil,
            timeoutMs: 10000)
    }

    static func write(_ root: [String: Any]) async throws {
        let data = try JSONSerialization.data(
            withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else { return }
        try await self.writeRaw(raw)
    }

    static func writeRaw(_ raw: String) async throws {
        // The Gateway refuses a write without the hash it last handed out.
        let current: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
            method: .configGet,
            params: nil,
            timeoutMs: 10000)
        var params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
        if let baseHash = current.hash {
            params["baseHash"] = AnyCodable(baseHash)
        }
        let _: ProbeWriteAck = try await GatewayConnection.shared.requestDecoded(
            method: .configSet,
            params: params,
            timeoutMs: 10000)
    }

    static func restore(_ original: ConfigSnapshot) async -> Bool {
        guard let raw = original.raw else { return false }
        do {
            try await self.writeRaw(raw)
            return true
        } catch {
            return false
        }
    }

    static func discordEnabled(_ store: ChannelsStore) -> Bool? {
        let channels = store.configDraft["channels"] as? [String: Any]
        let discord = channels?["discord"] as? [String: Any]
        return discord?["enabled"] as? Bool
    }
}

private struct ProbeWriteAck: Decodable {
    let hash: String?
}

private actor SaveGate {
    private var entered = false
    private var released = false

    func wait() async {
        self.entered = true
        var spins = 0
        while !self.released, spins < 1500 {
            try? await Task.sleep(nanoseconds: 10_000_000)
            spins += 1
        }
    }

    func waitUntilEntered() async -> Bool {
        var spins = 0
        while !self.entered, spins < 1500 {
            try? await Task.sleep(nanoseconds: 10_000_000)
            spins += 1
        }
        return self.entered
    }

    func release() {
        self.released = true
    }
}
