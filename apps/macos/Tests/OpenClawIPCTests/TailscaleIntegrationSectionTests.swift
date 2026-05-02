import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TailscaleIntegrationSectionTests {
    @Test func `tailscale section builds body when not installed`() {
        let service = TailscaleService(isInstalled: false, isRunning: false, statusError: "not installed")
        var view = TailscaleIntegrationSection(connectionMode: .local, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(mode: "off", requireCredentials: false, statusMessage: "Idle")
        _ = view.body
    }

    @Test func `tailscale section builds body for serve mode`() {
        let service = TailscaleService(
            isInstalled: true,
            isRunning: true,
            tailscaleHostname: "openclaw.tailnet.ts.net",
            tailscaleIP: "100.64.0.1")
        var view = TailscaleIntegrationSection(connectionMode: .local, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(
            mode: "serve",
            requireCredentials: true,
            password: "secret",
            statusMessage: "Running")
        _ = view.body
    }

    @Test func `tailscale section builds body for funnel mode`() {
        let service = TailscaleService(
            isInstalled: true,
            isRunning: false,
            tailscaleHostname: nil,
            tailscaleIP: nil,
            statusError: "not running")
        var view = TailscaleIntegrationSection(connectionMode: .remote, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(
            mode: "funnel",
            requireCredentials: false,
            statusMessage: "Needs start",
            validationMessage: "Invalid token")
        _ = view.body
    }

    @Test func `general tailscale hydration does not rewrite existing config`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager().removeItem(at: stateDir) }

        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        let initialConfig = """
        {
          "meta": {
            "lastTouchedVersion": "2026.3.28",
            "lastTouchedAt": "2026-03-31T13:15:24.532Z"
          },
          "wizard": {
            "lastRunAt": "2026-03-30T14:24:54.570Z",
            "lastRunVersion": "2026.3.24"
          },
          "gateway": {
            "mode": "local",
            "port": 18789,
            "bind": "auto",
            "tailscale": {
              "mode": "serve"
            },
            "auth": {
              "mode": "token",
              "token": "existing-token"
            }
          }
        }
        """

        try initialConfig.write(to: configPath, atomically: true, encoding: .utf8)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            let before = try Data(contentsOf: configPath)
            let root = try #require(
                JSONSerialization.jsonObject(with: before) as? [String: Any])

            await TailscaleIntegrationSection.simulateHydrationApplyForTesting(
                root: root,
                connectionMode: .local,
                isPaused: true,
                saveRoot: { root in
                    OpenClawConfigFile.saveDict(root, allowGatewayAuthMutation: true)
                })

            let after = try Data(contentsOf: configPath)
            #expect(after == before)

            let afterRoot = try #require(
                JSONSerialization.jsonObject(with: after) as? [String: Any])
            let gateway = try #require(afterRoot["gateway"] as? [String: Any])
            let auth = try #require(gateway["auth"] as? [String: Any])
            let meta = try #require(afterRoot["meta"] as? [String: Any])
            let wizard = try #require(afterRoot["wizard"] as? [String: Any])

            #expect(gateway["bind"] as? String == "auto")
            #expect(auth["mode"] as? String == "token")
            #expect(auth["token"] as? String == "existing-token") // pragma: allowlist secret
            #expect(meta["lastTouchedAt"] as? String == "2026-03-31T13:15:24.532Z")
            #expect(wizard["lastRunAt"] as? String == "2026-03-30T14:24:54.570Z")
            #expect(wizard["lastRunVersion"] as? String == "2026.3.24")
        }
    }

    @Test func `unchanged tailscale apply clears stale messages`() {
        let messages = TailscaleIntegrationSection.messagesForTesting(
            didApply: false,
            success: true,
            connectionMode: .local,
            isPaused: false)

        #expect(messages.statusMessage == nil)
        #expect(messages.validationMessage == nil)
        #expect(messages.shouldRecordSuccess == false)
        #expect(messages.shouldRestartGateway == false)
    }
}
