import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TailscaleIntegrationSectionTests {
    @Test func `cli installation requires an executable candidate`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let executable = tempDir.appendingPathComponent("tailscale")
        let nonExecutable = tempDir.appendingPathComponent("tailscaled")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try Data().write(to: executable)
        try Data().write(to: nonExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        #expect(TailscaleService.hasExecutableCLI(at: [executable.path]))
        #expect(!TailscaleService.hasExecutableCLI(at: [nonExecutable.path]))
    }

    @Test func `cli-only tailscale status is detected as installed and running`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: true,
            apiResponse: TailscaleService.TailscaleAPIResponse(
                status: "Running",
                deviceName: "april",
                tailnetName: "tail7a0b9.ts.net",
                iPv4: "100.66.5.88"),
            fallbackIP: "100.66.5.88")

        #expect(service.isInstalled)
        #expect(service.isRunning)
        #expect(service.tailscaleHostname == "april.tail7a0b9.ts.net")
        #expect(service.tailscaleIP == "100.66.5.88")
        #expect(service.statusError == nil)
    }

    @Test func `installed cli-only tailscale without a running daemon is detected`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: true,
            apiResponse: nil,
            fallbackIP: nil)

        #expect(service.isInstalled)
        #expect(!service.isAppInstalled)
        #expect(!service.isRunning)
        #expect(service.tailscaleHostname == nil)
        #expect(service.tailscaleIP == nil)
        #expect(service.statusError == "Please start the Tailscale daemon")
    }

    @Test func `shared cgnat address alone is not treated as a tailscale installation`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: false,
            apiResponse: nil,
            fallbackIP: "100.66.5.88")

        #expect(!service.isInstalled)
        #expect(!service.isAppInstalled)
        #expect(!service.isRunning)
        #expect(service.tailscaleHostname == nil)
        #expect(service.tailscaleIP == nil)
        #expect(service.statusError == "Tailscale is not installed")
    }

    @Test func `known cli installation can use interface fallback`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: true,
            apiResponse: nil,
            fallbackIP: "100.66.5.88")

        #expect(service.isInstalled)
        #expect(!service.isAppInstalled)
        #expect(service.isRunning)
        #expect(service.tailscaleHostname == nil)
        #expect(service.tailscaleIP == "100.66.5.88")
        #expect(service.statusError == nil)
    }

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
            isAppInstalled: true,
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
