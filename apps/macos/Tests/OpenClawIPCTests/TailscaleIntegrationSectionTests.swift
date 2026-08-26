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

    @Test func `concurrent status checks share one request`() async {
        let loader = TailscaleStatusLoader()
        let completion = TailscaleStatusCompletion()
        let joinBarrier = TailscaleStatusJoinBarrier()
        let service = TailscaleService(
            isInstalled: true,
            isRunning: true,
            tailscaleHostname: "april.tail7a0b9.ts.net",
            tailscaleIP: "100.66.5.88",
            appInstallationProbe: { true },
            cliInstallationProbe: { false },
            statusDataLoader: loader.load,
            statusCheckJoinHandler: { await joinBarrier.signal() })

        let first = Task { await service.checkTailscaleStatus() }
        await loader.waitForRequestStart()
        let second = Task {
            await service.checkTailscaleStatus()
            await completion.markFinished()
        }
        await joinBarrier.wait()

        #expect(await loader.requestCount == 1)
        #expect(await completion.finishedCount == 0)

        await loader.releaseRequest()
        await first.value
        await second.value

        #expect(await completion.finishedCount == 1)
        #expect(service.tailscaleIP == "100.66.5.88")

        await service.checkTailscaleStatus()
        #expect(await loader.requestCount == 2)
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

private actor TailscaleStatusLoader {
    private(set) var requestCount = 0
    private var requestStartedContinuations: [CheckedContinuation<Void, Never>] = []
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var shouldSuspendRequest = true

    func load(url: URL) async throws -> (Data, URLResponse) {
        self.requestCount += 1
        for continuation in self.requestStartedContinuations {
            continuation.resume()
        }
        self.requestStartedContinuations.removeAll()
        if self.shouldSuspendRequest {
            self.shouldSuspendRequest = false
            await withCheckedContinuation { continuation in
                self.requestContinuation = continuation
            }
        }
        let data = try JSONEncoder().encode(
            TailscaleService.TailscaleAPIResponse(
                status: "Running",
                deviceName: "april",
                tailnetName: "tail7a0b9.ts.net",
                iPv4: "100.66.5.88"))
        let response = try #require(
            HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil))
        return (data, response)
    }

    func waitForRequestStart() async {
        guard self.requestCount == 0 else { return }
        await withCheckedContinuation { continuation in
            self.requestStartedContinuations.append(continuation)
        }
    }

    func releaseRequest() {
        self.requestContinuation?.resume()
        self.requestContinuation = nil
    }
}

private actor TailscaleStatusCompletion {
    private(set) var finishedCount = 0

    func markFinished() {
        self.finishedCount += 1
    }
}

private actor TailscaleStatusJoinBarrier {
    private var joined = false
    private var continuation: CheckedContinuation<Void, Never>?

    func signal() {
        self.joined = true
        self.continuation?.resume()
        self.continuation = nil
    }

    func wait() async {
        guard !self.joined else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }
}
