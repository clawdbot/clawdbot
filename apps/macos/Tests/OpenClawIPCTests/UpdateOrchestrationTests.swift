import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct UpdateOrchestrationTests {
    @Test func `Sparkle receipt appears only after the target app launches`() throws {
        let suite = "UpdateOrchestrationTests.post-update.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date(timeIntervalSince1970: 1_720_000_000)

        PostAppUpdateReceiptStore.record(
            fromVersion: "2026.7.3",
            toVersion: "2026.7.4",
            defaults: defaults,
            now: now)

        #expect(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.7.3",
            defaults: defaults) == nil)
        #expect(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.7.4",
            defaults: defaults) == PostAppUpdateReceipt(
            fromVersion: "2026.7.3",
            toVersion: "2026.7.4",
            recordedAt: now))
        let receipt = try #require(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.7.4",
            defaults: defaults))
        let incomplete = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            true,
            receipt: receipt,
            defaults: defaults)
        #expect(incomplete.gatewayUpdateIncomplete)
        #expect(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.7.4",
            defaults: defaults) == incomplete)
        let completed = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            false,
            receipt: incomplete,
            defaults: defaults)
        let inFlight = PostAppUpdateReceiptStore.setNotificationInFlight(
            true,
            receipt: completed,
            defaults: defaults)
        #expect(inFlight.notificationInFlight)
        #expect(!PostUpdateController.isNotificationOnlyRetry(inFlight))
        let readyToRetry = PostAppUpdateReceiptStore.setNotificationInFlight(
            false,
            receipt: inFlight,
            defaults: defaults)
        let firstNotificationFailure = PostAppUpdateReceiptStore.recordNotificationFailure(
            receipt: readyToRetry,
            defaults: defaults)
        #expect(firstNotificationFailure.notificationAttempts == 1)
        #expect(!firstNotificationFailure.gatewayUpdateIncomplete)
        #expect(!firstNotificationFailure.notificationInFlight)
        let finalNotificationFailure = PostAppUpdateReceiptStore.recordNotificationFailure(
            receipt: firstNotificationFailure,
            defaults: defaults)
        #expect(finalNotificationFailure.notificationAttempts == PostAppUpdateReceiptStore.notificationRetryLimit)
        #expect(PostUpdateController.isNotificationOnlyRetry(firstNotificationFailure))
        #expect(!PostUpdateController.isNotificationOnlyRetry(incomplete))
        PostAppUpdateReceiptStore.clear(defaults: defaults)
        #expect(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.7.4",
            defaults: defaults) == nil)
    }

    @Test func `launch transition bootstraps upgrades but not fresh onboarding`() throws {
        let suite = "UpdateOrchestrationTests.launch-transition.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date(timeIntervalSince1970: 1_720_000_000)

        PostAppUpdateReceiptStore.record(
            fromVersion: "2026.7.3",
            toVersion: "2026.7.4",
            defaults: defaults,
            now: now)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.7.4",
            onboardingSeen: false,
            defaults: defaults,
            now: now) == nil)
        #expect(defaults.string(forKey: lastLaunchedAppVersionKey) == "2026.7.4")
        #expect(PostAppUpdateReceiptStore.pending(
            currentVersion: "2026.7.4",
            defaults: defaults) == nil)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.7.4",
            onboardingSeen: true,
            defaults: defaults,
            now: now) == nil)

        defaults.removeObject(forKey: lastLaunchedAppVersionKey)
        #expect(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.7.5-dev",
            onboardingSeen: true,
            allowsUpdateWorkflow: false,
            defaults: defaults,
            now: now) == nil)
        #expect(defaults.string(forKey: lastLaunchedAppVersionKey) == "2026.7.5-dev")

        defaults.removeObject(forKey: lastLaunchedAppVersionKey)
        let bootstrap = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.7.5",
            onboardingSeen: true,
            defaults: defaults,
            now: now))
        #expect(bootstrap == PostAppUpdateReceipt(
            fromVersion: "unknown",
            toVersion: "2026.7.5",
            recordedAt: now))

        PostAppUpdateReceiptStore.clear(defaults: defaults)
        defaults.set("2026.7.5", forKey: lastLaunchedAppVersionKey)
        let transition = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: "2026.7.6",
            onboardingSeen: true,
            defaults: defaults,
            now: now))
        #expect(transition.fromVersion == "2026.7.5")
        #expect(transition.toVersion == "2026.7.6")
    }

    @Test func `post-update notice pages to latest direct top-level interaction`() async throws {
        var requestedOffsets: [Int] = []
        let selected = try #require(try await PostUpdateController.preferredNotificationSession(loadPage: { offset in
            requestedOffsets.append(offset)
            if offset == 0 {
                return PostUpdateSessionsResponse(
                    sessions: [
                        PostUpdateSession(
                            key: "agent:main:group:release",
                            kind: "group",
                            lastChannel: "webchat",
                            lastInteractionAt: 500,
                            spawnedBy: nil,
                            parentSessionKey: nil),
                        PostUpdateSession(
                            key: "agent:main:telegram:direct:other-user",
                            kind: "direct",
                            lastChannel: "telegram",
                            lastInteractionAt: 450,
                            spawnedBy: nil,
                            parentSessionKey: nil),
                        PostUpdateSession(
                            key: "agent:main:subagent:child",
                            kind: "direct",
                            lastChannel: "webchat",
                            lastInteractionAt: 400,
                            spawnedBy: "agent:main:main",
                            parentSessionKey: "agent:main:main"),
                    ],
                    nextOffset: 2)
            }
            return PostUpdateSessionsResponse(
                sessions: [
                    PostUpdateSession(
                        key: "agent:main:main",
                        kind: "direct",
                        lastChannel: "webchat",
                        lastInteractionAt: 300,
                        spawnedBy: nil,
                        parentSessionKey: nil),
                ],
                nextOffset: nil)
        }))

        #expect(selected.key == "agent:main:main")
        #expect(requestedOffsets == [0, 2])
    }

    @Test func `post-update receipt survives transient notification failure`() {
        #expect(PostUpdateNotificationOutcome.delivered.consumesReceipt)
        #expect(PostUpdateNotificationOutcome.noEligibleSession.consumesReceipt)
        #expect(PostUpdateNotificationOutcome.deliveryUnconfirmed.consumesReceipt)
        #expect(PostUpdateNotificationOutcome.skippedUnsupportedGateway.consumesReceipt)
        #expect(PostUpdateNotificationOutcome.skippedWhilePaused.consumesReceipt)
        #expect(!PostUpdateNotificationOutcome.retryLater.consumesReceipt)
    }

    @Test func `post-update notification requires a compatible remote Gateway`() {
        #expect(PostUpdateController.supportsPostUpdateNotification(
            gatewayVersion: "2026.7.4",
            appVersion: "2026.7.4"))
        #expect(PostUpdateController.supportsPostUpdateNotification(
            gatewayVersion: "2026.7.5",
            appVersion: "2026.7.4"))
        #expect(!PostUpdateController.supportsPostUpdateNotification(
            gatewayVersion: "2026.7.3",
            appVersion: "2026.7.4"))
        #expect(!PostUpdateController.supportsPostUpdateNotification(
            gatewayVersion: "2026.7.4-beta.1",
            appVersion: "2026.7.4"))
        #expect(!PostUpdateController.supportsPostUpdateNotification(
            gatewayVersion: nil,
            appVersion: "2026.7.4"))
        #expect(PostUpdateController.remoteNotificationBlocker(
            gatewayVersion: nil,
            appVersion: "2026.7.4") == .retryLater)
        #expect(PostUpdateController.remoteNotificationBlocker(
            gatewayVersion: "2026.7.3",
            appVersion: "2026.7.4") == .skippedUnsupportedGateway)
        #expect(PostUpdateController.remoteNotificationBlocker(
            gatewayVersion: "2026.7.4",
            appVersion: "2026.7.4") == nil)
    }

    @Test func `post-update runtime ownership follows the active service`() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let managedEntry = "\(home)/.openclaw/lib/node_modules/openclaw/dist/index.js"

        #expect(PostUpdateController.ownsManagedRuntime(
            connectionMode: .local,
            programArguments: ["/usr/local/bin/node", managedEntry, "gateway"],
            gatewayUpdateChannel: nil,
            installPolicy: "exact",
            launchAgentWriteDisabled: false))
        #expect(!PostUpdateController.ownsManagedRuntime(
            connectionMode: .local,
            programArguments: ["/usr/local/bin/node", managedEntry, "gateway"],
            gatewayUpdateChannel: nil,
            installPolicy: "exact",
            launchAgentWriteDisabled: true))
        #expect(PostUpdateController.ownsManagedRuntime(
            connectionMode: .remote,
            programArguments: ["/usr/local/bin/node", managedEntry, "node", "run"],
            gatewayUpdateChannel: nil,
            installPolicy: "exact",
            launchAgentWriteDisabled: true))
        #expect(!PostUpdateController.ownsManagedRuntime(
            connectionMode: .remote,
            programArguments: ["/usr/local/bin/node", "/opt/openclaw/dist/index.js", "node", "run"],
            gatewayUpdateChannel: nil,
            installPolicy: "exact",
            launchAgentWriteDisabled: false))
    }

    @Test func `post-update window is reserved for managed Gateway work`() {
        let managed = CLIInstaller.managedExecutableLocation()

        #expect(PostUpdateController.gatewayAction(
            status: .ready(location: managed, version: "2026.7.4"),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: false) == .none)
        #expect(PostUpdateController.gatewayAction(
            status: .ready(location: managed, version: "2026.7.4"),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: true) == .repair)
        #expect(PostUpdateController.gatewayAction(
            status: .incompatible(location: managed, found: "2026.7.3", required: "2026.7.4"),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: false) == .update)
        #expect(PostUpdateController.gatewayAction(
            status: .missing(location: managed),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: false) == .install)
        #expect(PostUpdateController.gatewayAction(
            status: .incompatible(location: managed, found: "2026.7.5", required: "2026.7.4"),
            ownsManagedRuntime: true,
            gatewayUpdateIncomplete: false) == .none)
        #expect(PostUpdateController.gatewayAction(
            status: .incompatible(location: managed, found: "2026.7.3", required: "2026.7.4"),
            ownsManagedRuntime: false,
            gatewayUpdateIncomplete: false) == .none)
        #expect(PostUpdateController.gatewayAction(
            status: .ready(location: managed, version: "2026.7.4"),
            ownsManagedRuntime: false,
            gatewayUpdateIncomplete: true) == .ownershipFailure)
    }

    @Test func `incomplete managed update keeps ownership failures retryable`() {
        #expect(PostUpdateController.shouldPresentOwnershipFailure(
            connectionMode: .local,
            gatewayUpdateIncomplete: true))
        #expect(PostUpdateController.shouldPresentOwnershipFailure(
            connectionMode: .remote,
            gatewayUpdateIncomplete: true))
        #expect(!PostUpdateController.shouldPresentOwnershipFailure(
            connectionMode: .local,
            gatewayUpdateIncomplete: false))
        #expect(!PostUpdateController.shouldPresentOwnershipFailure(
            connectionMode: .remote,
            gatewayUpdateIncomplete: false))
        #expect(!PostUpdateController.shouldPresentOwnershipFailure(
            connectionMode: .unconfigured,
            gatewayUpdateIncomplete: true))
    }

    @Test func `notification retries only definitely uncommitted sends`() {
        #expect(PostUpdateController.notificationSendFailureOutcome(
            OpenClawChatTransportSendError.notDispatched) == .retryLater)
        #expect(PostUpdateController.notificationSendFailureOutcome(
            GatewayResponseError(
                method: "system-event",
                code: "INVALID_REQUEST",
                message: "unsupported",
                details: nil)) == .retryLater)
        #expect(PostUpdateController.notificationSendFailureOutcome(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)) == .deliveryUnconfirmed)
    }

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

    @Test func `CLI management follows configured node modes`() {
        #expect(CLIInstallPrompter.shouldManageCLI(connectionMode: .local))
        #expect(CLIInstallPrompter.shouldManageCLI(connectionMode: .remote))
        #expect(!CLIInstallPrompter.shouldManageCLI(connectionMode: .unconfigured))

        #expect(CLIInstallPrompter.shouldRestartManagedGateway(
            requested: true,
            connectionMode: .local))
        #expect(!CLIInstallPrompter.shouldRestartManagedGateway(
            requested: true,
            connectionMode: .remote))
        #expect(!CLIInstallPrompter.shouldRestartManagedGateway(
            requested: false,
            connectionMode: .local))
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
