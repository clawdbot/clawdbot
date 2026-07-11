import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct UpdateOrchestrationTests {
    @Test func `Sparkle channels follow the Gateway update channel`() {
        #expect(allowedSparkleChannels(forGatewayUpdateChannel: "beta") == ["beta"])
        #expect(allowedSparkleChannels(forGatewayUpdateChannel: "dev") == ["beta"])
        #expect(allowedSparkleChannels(forGatewayUpdateChannel:
            OpenClawConfigFile.normalizedGatewayUpdateChannel("  BETA \n")) == ["beta"])
        #expect(OpenClawConfigFile.normalizedGatewayUpdateChannel(" \n") == nil)
        #expect(allowedSparkleChannels(forGatewayUpdateChannel: "stable").isEmpty)
        #expect(allowedSparkleChannels(forGatewayUpdateChannel: "extended-stable").isEmpty)
        #expect(allowedSparkleChannels(forGatewayUpdateChannel: "future").isEmpty)
        #expect(allowedSparkleChannels(forGatewayUpdateChannel: nil).isEmpty)
    }

    #if canImport(Sparkle)
    @Test func `Sparkle stays unavailable until launch relocation finishes`() {
        let updater = SparkleUpdaterController(savedAutoUpdate: false)

        #expect(!updater.isAvailable)
        updater.checkForUpdates(nil)
        #expect(!updater.isAvailable)
    }
    #endif

    @Test func `dashboard accepts only start update payloads`() {
        #expect(DashboardWindowController.isStartUpdateRequest(["type": "start-update"]))
        #expect(!DashboardWindowController.isStartUpdateRequest(["type": "update.run"]))
        #expect(!DashboardWindowController.isStartUpdateRequest("start-update"))
    }

    @Test func `dashboard exposes update bridge only for available updater`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let auth = DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        let available = TestUpdater(isAvailable: true)
        let enabled = DashboardWindowController(url: url, auth: auth, updater: available)
        let disabled = DashboardWindowController(
            url: url,
            auth: auth,
            updater: TestUpdater(isAvailable: false))
        let remote = DashboardWindowController(
            url: url,
            auth: auth,
            updater: available,
            updateBridgeEnabled: false)

        #expect(enabled._testUpdateBridgeAvailable)
        #expect(!disabled._testUpdateBridgeAvailable)
        #expect(!remote._testUpdateBridgeAvailable)
        remote.setUpdateBridgeEnabled(true)
        #expect(remote._testUpdateBridgeAvailable)
    }

    @Test func `automatic repair is limited to incompatible managed install`() {
        let managed = CLIInstaller.managedExecutableLocation()
        #expect(CLIInstallPrompter.shouldAutomaticallyRepair(status: .incompatible(
            location: managed,
            found: "2026.7.1",
            required: "2026.7.2"), launchAgentUsesManagedCLI: true, launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(status: .incompatible(
            location: "/opt/homebrew/bin/openclaw",
            found: "2026.7.1",
            required: "2026.7.2"), launchAgentUsesManagedCLI: true, launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(
            status: .missing(location: managed),
            launchAgentUsesManagedCLI: true,
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(
            status: .unusable(location: managed),
            launchAgentUsesManagedCLI: true,
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(
            status: .incompatible(location: managed, found: "2026.7.1", required: "2026.7.2"),
            launchAgentUsesManagedCLI: false,
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(
            status: .incompatible(location: managed, found: "2026.7.1", required: "2026.7.2"),
            launchAgentUsesManagedCLI: true,
            launchAgentWriteDisabled: true))
        // Never silently downgrade a gateway the user moved ahead of the app.
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(status: .incompatible(
            location: managed,
            found: "2026.7.3",
            required: "2026.7.2"), launchAgentUsesManagedCLI: true, launchAgentWriteDisabled: false))
        // Extended-stable pins an older gateway on purpose; keep the prompt.
        #expect(!CLIInstallPrompter.shouldAutomaticallyRepair(
            status: .incompatible(location: managed, found: "2026.7.1", required: "2026.7.2"),
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: "extended-stable",
            launchAgentWriteDisabled: false))
        #expect(CLIInstallPrompter.shouldAutomaticallyRepair(
            status: .incompatible(location: managed, found: "2026.7.1", required: "2026.7.2"),
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: "beta",
            launchAgentWriteDisabled: false))
    }

    @Test func `managed repair only upgrades`() {
        #expect(CLIInstallPrompter.isManagedUpgrade(found: "2026.7.1", required: "2026.7.2"))
        #expect(!CLIInstallPrompter.isManagedUpgrade(found: "2026.7.2", required: "2026.7.1"))
        #expect(!CLIInstallPrompter.isManagedUpgrade(found: "2026.7.2", required: "2026.7.2"))
        // Prerelease of the same triple sorts below its release.
        #expect(CLIInstallPrompter.isManagedUpgrade(found: "2026.7.2-beta.1", required: "2026.7.2"))
        #expect(!CLIInstallPrompter.isManagedUpgrade(found: "2026.7.2", required: "2026.7.2-beta.1"))
        #expect(CLIInstallPrompter.isManagedUpgrade(
            found: "2026.7.2-beta.1",
            required: "2026.7.2-beta.2"))
        #expect(CLIInstallPrompter.isManagedUpgrade(
            found: "2026.7.2-beta.2",
            required: "2026.7.2-beta.10"))
        #expect(!CLIInstallPrompter.isManagedUpgrade(
            found: "2026.7.2-beta.2",
            required: "2026.7.2-beta.1"))
        #expect(!CLIInstallPrompter.isManagedUpgrade(found: "garbage", required: "2026.7.2"))
    }

    @Test func `managed Gateway ownership ignores the generated environment wrapper`() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let wrapper = "\(home)/.openclaw/state/service-env/ai.openclaw.gateway-env-wrapper.sh"
        let environment = "\(home)/.openclaw/state/service-env/ai.openclaw.gateway.env"
        let managedEntry = "\(home)/.openclaw/lib/node_modules/openclaw/dist/index.js"

        #expect(CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: [
            wrapper,
            environment,
            "/usr/local/bin/node",
            managedEntry,
            "gateway",
        ]))
        #expect(!CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: [
            wrapper,
            environment,
            "/usr/local/bin/node",
            "/opt/homebrew/lib/node_modules/openclaw/dist/index.js",
            "gateway",
        ]))
        #expect(!CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: [
            wrapper,
            environment,
            "\(home)/.openclaw/tools/node/bin/node",
            "/opt/homebrew/lib/node_modules/openclaw/dist/index.js",
            "gateway",
        ]))
    }

    @Test func `managed repair gates cover bridge and repair alike`() {
        #expect(CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: nil,
            launchAgentWriteDisabled: false))
        #expect(CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: "beta",
            installPolicy: "exact",
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: false,
            gatewayUpdateChannel: nil,
            installPolicy: nil,
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: "extended-stable",
            installPolicy: nil,
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: nil,
            launchAgentWriteDisabled: true))
        #expect(!CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: "stable",
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: "beta",
            launchAgentWriteDisabled: false))
        #expect(!CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: true,
            gatewayUpdateChannel: nil,
            installPolicy: "dev",
            launchAgentWriteDisabled: false))
    }

    @Test func `pending managed restart marker round trips`() {
        CLIInstallPrompter.clearPendingManagedRestart()
        #expect(!CLIInstallPrompter.hasPendingManagedRestart())
        CLIInstallPrompter.setPendingManagedRestart()
        #expect(CLIInstallPrompter.hasPendingManagedRestart())
        CLIInstallPrompter.clearPendingManagedRestart()
        #expect(!CLIInstallPrompter.hasPendingManagedRestart())
    }

    @Test func `managed Gateway restart requires a new running process`() {
        #expect(CLIInstallPrompter.didManagedGatewayRestart(previousPID: nil, currentPID: 41))
        #expect(CLIInstallPrompter.didManagedGatewayRestart(previousPID: 40, currentPID: 41))
        #expect(!CLIInstallPrompter.didManagedGatewayRestart(previousPID: 41, currentPID: 41))
        #expect(!CLIInstallPrompter.didManagedGatewayRestart(previousPID: 41, currentPID: nil))
    }
}

@MainActor
private final class TestUpdater: UpdaterProviding {
    var automaticallyChecksForUpdates = false
    var automaticallyDownloadsUpdates = false
    let isAvailable: Bool
    let updateStatus = UpdateStatus()

    init(isAvailable: Bool) {
        self.isAvailable = isAvailable
    }

    func checkForUpdates(_: Any?) {}
}
