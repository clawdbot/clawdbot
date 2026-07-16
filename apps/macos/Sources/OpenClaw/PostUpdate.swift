import AppKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct PostAppUpdateReceipt: Codable, Equatable {
    private enum CodingKeys: String, CodingKey {
        case fromVersion
        case toVersion
        case recordedAt
        case gatewayUpdateIncomplete
        case notificationAttempts
        case notificationInFlight
    }

    let fromVersion: String
    let toVersion: String
    let recordedAt: Date
    let gatewayUpdateIncomplete: Bool
    let notificationAttempts: Int
    let notificationInFlight: Bool

    init(
        fromVersion: String,
        toVersion: String,
        recordedAt: Date,
        gatewayUpdateIncomplete: Bool = false,
        notificationAttempts: Int = 0,
        notificationInFlight: Bool = false)
    {
        self.fromVersion = fromVersion
        self.toVersion = toVersion
        self.recordedAt = recordedAt
        self.gatewayUpdateIncomplete = gatewayUpdateIncomplete
        self.notificationAttempts = notificationAttempts
        self.notificationInFlight = notificationInFlight
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.fromVersion = try container.decode(String.self, forKey: .fromVersion)
        self.toVersion = try container.decode(String.self, forKey: .toVersion)
        self.recordedAt = try container.decode(Date.self, forKey: .recordedAt)
        self.gatewayUpdateIncomplete = try container.decodeIfPresent(
            Bool.self,
            forKey: .gatewayUpdateIncomplete) ?? false
        self.notificationAttempts = try container.decodeIfPresent(
            Int.self,
            forKey: .notificationAttempts) ?? 0
        self.notificationInFlight = try container.decodeIfPresent(
            Bool.self,
            forKey: .notificationInFlight) ?? false
    }
}

enum PostAppUpdateReceiptStore {
    static let notificationRetryLimit = 2

    static func record(
        fromVersion: String,
        toVersion: String,
        defaults: UserDefaults = .standard,
        now: Date = Date())
    {
        let from = fromVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        let to = toVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !from.isEmpty, !to.isEmpty, from != to else { return }
        let receipt = PostAppUpdateReceipt(fromVersion: from, toVersion: to, recordedAt: now)
        self.persist(receipt, defaults: defaults)
    }

    static func pending(
        currentVersion: String?,
        defaults: UserDefaults = .standard) -> PostAppUpdateReceipt?
    {
        guard let currentVersion = normalized(currentVersion),
              let data = defaults.data(forKey: postAppUpdateReceiptKey),
              let receipt = try? JSONDecoder().decode(PostAppUpdateReceipt.self, from: data),
              normalized(receipt.toVersion) == currentVersion
        else { return nil }
        return receipt
    }

    static func pendingForLaunch(
        currentVersion: String?,
        onboardingSeen: Bool,
        allowsUpdateWorkflow: Bool = true,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> PostAppUpdateReceipt?
    {
        guard let currentVersion = normalized(currentVersion) else { return nil }
        let previousVersion = self.normalized(defaults.string(forKey: lastLaunchedAppVersionKey))
        let receipt: PostAppUpdateReceipt?
        if !onboardingSeen || !allowsUpdateWorkflow {
            // A receipt can arrive before first-run onboarding. Consume it here so
            // completing onboarding cannot replay old post-update work later.
            self.clear(defaults: defaults)
            receipt = nil
        } else if let pending = self.pending(currentVersion: currentVersion, defaults: defaults) {
            receipt = pending
        } else if previousVersion != currentVersion {
            // The first recorder-capable build has no prior launch marker. An
            // onboarded install is therefore an upgrade; fresh installs were gated above.
            let bootstrap = PostAppUpdateReceipt(
                fromVersion: previousVersion ?? "unknown",
                toVersion: currentVersion,
                recordedAt: now)
            self.persist(bootstrap, defaults: defaults)
            receipt = bootstrap
        } else {
            receipt = nil
        }
        defaults.set(currentVersion, forKey: lastLaunchedAppVersionKey)
        return receipt
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: postAppUpdateReceiptKey)
    }

    @discardableResult
    static func setGatewayUpdateIncomplete(
        _ incomplete: Bool,
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = .standard) -> PostAppUpdateReceipt
    {
        let updated = PostAppUpdateReceipt(
            fromVersion: receipt.fromVersion,
            toVersion: receipt.toVersion,
            recordedAt: receipt.recordedAt,
            gatewayUpdateIncomplete: incomplete,
            notificationAttempts: receipt.notificationAttempts,
            notificationInFlight: receipt.notificationInFlight)
        self.persist(updated, defaults: defaults)
        return updated
    }

    @discardableResult
    static func recordNotificationFailure(
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = .standard) -> PostAppUpdateReceipt
    {
        // One later-launch retry handles restart races. The bound prevents
        // permanent auth/schema errors from reopening this window forever.
        let updated = PostAppUpdateReceipt(
            fromVersion: receipt.fromVersion,
            toVersion: receipt.toVersion,
            recordedAt: receipt.recordedAt,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete,
            notificationAttempts: min(receipt.notificationAttempts + 1, self.notificationRetryLimit),
            notificationInFlight: receipt.notificationInFlight)
        self.persist(updated, defaults: defaults)
        return updated
    }

    @discardableResult
    static func setNotificationInFlight(
        _ inFlight: Bool,
        receipt: PostAppUpdateReceipt,
        defaults: UserDefaults = .standard) -> PostAppUpdateReceipt
    {
        let updated = PostAppUpdateReceipt(
            fromVersion: receipt.fromVersion,
            toVersion: receipt.toVersion,
            recordedAt: receipt.recordedAt,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete,
            notificationAttempts: receipt.notificationAttempts,
            notificationInFlight: inFlight)
        self.persist(updated, defaults: defaults)
        // Cross the persistence boundary before the Gateway request. A crash
        // after enqueue must not replay this one-time welcome on next launch.
        defaults.synchronize()
        return updated
    }

    private static func persist(_ receipt: PostAppUpdateReceipt, defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(receipt) else { return }
        defaults.set(data, forKey: postAppUpdateReceiptKey)
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

@MainActor
@Observable
final class PostUpdateModel {
    enum Phase: Equatable {
        case checking
        case updating
        case verifying
        case notifying
        case complete
        case failed
    }

    var phase: Phase = .checking
    var title = String(localized: "Finishing your OpenClaw update")
    var message = String(localized: "Checking the Mac app and Gateway…")
    var details: String?

    var isWorking: Bool {
        switch self.phase {
        case .checking, .updating, .verifying, .notifying: true
        case .complete, .failed: false
        }
    }

    var mood: OpenClawMascotMood {
        switch self.phase {
        case .checking, .updating, .verifying, .notifying: .thinking
        case .complete: .celebrating
        case .failed: .sad
        }
    }
}

enum PostUpdateGatewayAction: Equatable {
    case none
    case ownershipFailure
    case repair
    case update
    case install
}

struct PostUpdateSessionsResponse: Decodable {
    let sessions: [PostUpdateSession]
    let nextOffset: Int?
}

struct PostUpdateSession: Decodable {
    let key: String
    let kind: String
    let lastChannel: String?
    let lastInteractionAt: Double?
    let spawnedBy: String?
    let parentSessionKey: String?
}

enum PostUpdateNotificationOutcome: Equatable {
    case delivered
    case noEligibleSession
    case deliveryUnconfirmed
    case skippedUnsupportedGateway
    case skippedWhilePaused
    case retryLater

    var consumesReceipt: Bool {
        self != .retryLater
    }
}

@MainActor
final class PostUpdateController: NSObject, NSWindowDelegate {
    static let shared = PostUpdateController()
    static let updateGuideURL = URL(string: "https://docs.openclaw.ai/install/updating")!
    static let discordURL = URL(string: "https://discord.gg/clawd")!

    private let model = PostUpdateModel()
    private var receipt: PostAppUpdateReceipt?
    private var window: NSWindow?
    private var task: Task<Void, Never>?

    @discardableResult
    func startIfNeeded() -> Bool {
        guard let receipt = PostAppUpdateReceiptStore.pendingForLaunch(
            currentVersion: GatewayEnvironment.appVersionString(),
            onboardingSeen: AppStateStore.shared.onboardingSeen,
            allowsUpdateWorkflow: !CLIInstallBuild.isDebug)
        else { return false }
        self.receipt = receipt
        self.run()
        return true
    }

    func retry() {
        guard self.receipt != nil, !self.model.isWorking else { return }
        self.run()
    }

    func close() {
        self.window?.close()
    }

    func openUpdateGuide() {
        NSWorkspace.shared.open(Self.updateGuideURL)
    }

    func openDiscord() {
        NSWorkspace.shared.open(Self.discordURL)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        self.window = nil
    }

    private func show() {
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: PostUpdateView(model: model))
        let window = NSWindow(contentViewController: hosting)
        window.title = String(localized: "OpenClaw updated")
        window.setContentSize(NSSize(width: 560, height: 600))
        window.styleMask = OnboardingController.windowStyleMask
        window.contentMinSize = NSSize(width: 560, height: 600)
        window.contentMaxSize = NSSize(width: 560, height: 760)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.delegate = self
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    private func run() {
        guard let receipt, task == nil else { return }
        self.model.phase = .checking
        self.model.title = String(localized: "Finishing your OpenClaw update")
        self.model.message = String(localized: "Checking the Mac app and Gateway…")
        self.model.details = nil
        self.window?.standardWindowButton(.closeButton)?.isEnabled = false
        self.task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.finishUpdate(receipt: receipt)
            self.window?.standardWindowButton(.closeButton)?.isEnabled = true
            self.task = nil
        }
    }

    private func finishUpdate(receipt: PostAppUpdateReceipt) async {
        let connectionMode = AppStateStore.shared.connectionMode
        guard CLIInstallPrompter.shouldManageCLI(connectionMode: connectionMode) else {
            self.finishSilently()
            return
        }

        // Resume a definitely uncommitted notification before the Gateway action
        // gate; a ready runtime must not discard it as an app-only receipt.
        if Self.isNotificationOnlyRetry(receipt) {
            await self.finishNotification(receipt: receipt, connectionMode: connectionMode)
            return
        }
        if receipt.notificationInFlight && !receipt.gatewayUpdateIncomplete {
            self.finishNotification(
                outcome: .deliveryUnconfirmed,
                receipt: receipt,
                connectionMode: connectionMode)
            return
        }

        let managedStatus = await CLIInstaller.managedStatus()
        let runtimeProgramArguments: [String]
        switch connectionMode {
        case .local:
            guard let programArguments = GatewayLaunchAgentManager.launchdProgramArguments() else {
                self.finishAfterOwnershipCheckFailure(
                    connectionMode: connectionMode,
                    receipt: receipt)
                return
            }
            runtimeProgramArguments = programArguments
        case .remote:
            guard let programArguments = NodeServiceManager.launchdProgramArguments() else {
                self.finishAfterOwnershipCheckFailure(
                    connectionMode: connectionMode,
                    receipt: receipt)
                return
            }
            runtimeProgramArguments = programArguments
        case .unconfigured:
            runtimeProgramArguments = []
        }
        let ownsManagedRuntime = Self.ownsManagedRuntime(
            connectionMode: connectionMode,
            programArguments: runtimeProgramArguments,
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
            installPolicy: CLIInstallPolicy.storedPolicy(),
            launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled())
        let restartGateway = connectionMode == .local && !AppStateStore.shared.isPaused

        // App-only relaunches stay invisible. The window belongs only to
        // confirmed managed Gateway work and its recovery path.
        switch Self.gatewayAction(
            status: managedStatus,
            ownsManagedRuntime: ownsManagedRuntime,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete)
        {
        case .none:
            self.finishSilently()
            return
        case .ownershipFailure:
            self.finishAfterOwnershipCheckFailure(
                connectionMode: connectionMode,
                receipt: receipt)
            return
        case .repair:
            self.model.phase = .updating
            self.show()
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: receipt.toVersion,
                restartGateway: restartGateway,
                repair: true)
            { [weak self] message in
                self?.model.message = message
            }
            guard self.consume(outcome) else { return }
        case .update:
            self.setGatewayUpdateIncomplete(true, receipt: receipt)
            self.model.phase = .updating
            self.show()
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: receipt.toVersion,
                restartGateway: restartGateway)
            { [weak self] message in
                self?.model.message = message
            }
            guard self.consume(outcome) else { return }
        case .install:
            self.setGatewayUpdateIncomplete(true, receipt: receipt)
            self.model.phase = .updating
            self.show()
            let installed = await CLIInstaller.install(target: .exact(receipt.toVersion)) { [weak self] message in
                self?.model.message = message
            }
            guard installed else {
                self.fail(
                    message: String(localized: "Gateway recovery failed."),
                    details: String(localized: "The managed OpenClaw runtime could not be reinstalled."))
                return
            }
        }

        self.model.phase = .verifying
        self.model.message = connectionMode == .local
            ? String(localized: "Restarting and verifying the Gateway…")
            : String(localized: "Verifying the Mac node runtime…")
        guard await self.verifyRuntime(connectionMode: connectionMode) else { return }
        // Verification owns the persistence boundary: clearing earlier would
        // turn a failed health check into a silent app-only completion on retry.
        self.setGatewayUpdateIncomplete(false, receipt: receipt)

        await self.finishNotification(receipt: receipt, connectionMode: connectionMode)
    }

    private func finishNotification(
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode) async
    {
        self.model.phase = .notifying
        self.model.message = String(localized: "Letting your agent know you’re back…")
        let notification = connectionMode == .local && AppStateStore.shared.isPaused
            ? PostUpdateNotificationOutcome.skippedWhilePaused
            : await self.notifyMostRecentSession(
                version: receipt.toVersion,
                connectionMode: connectionMode,
                receipt: receipt)

        self.finishNotification(
            outcome: notification,
            receipt: receipt,
            connectionMode: connectionMode)
    }

    private func finishNotification(
        outcome notification: PostUpdateNotificationOutcome,
        receipt: PostAppUpdateReceipt,
        connectionMode: AppState.ConnectionMode)
    {
        let notificationRetryScheduled: Bool
        if notification == .retryLater {
            let updated = PostAppUpdateReceiptStore.recordNotificationFailure(
                receipt: self.receipt ?? receipt)
            self.receipt = updated
            notificationRetryScheduled = updated.notificationAttempts < PostAppUpdateReceiptStore.notificationRetryLimit
        } else {
            notificationRetryScheduled = false
        }
        if notification.consumesReceipt || !notificationRetryScheduled {
            PostAppUpdateReceiptStore.clear()
        }
        self.model.phase = .complete
        self.model.title = String(localized: "Welcome back")
        self.model.message = connectionMode == .local
            ? String(localized: "OpenClaw \(receipt.toVersion) and its Gateway are ready.")
            : String(localized: "OpenClaw \(receipt.toVersion) and its Mac node runtime are ready.")
        self.model.details = switch (notification, notificationRetryScheduled) {
        case (.retryLater, true):
            String(localized: "Your agent could not be notified yet. OpenClaw will retry after the next app launch.")
        case (.retryLater, false):
            if connectionMode == .local {
                String(
                    localized: """
                    OpenClaw could not notify your agent automatically. \
                    The app and Gateway update are complete.
                    """)
            } else {
                String(
                    localized: """
                    OpenClaw could not notify your agent automatically. \
                    The app and Mac node update are complete.
                    """)
            }
        case (.deliveryUnconfirmed, _):
            String(
                localized: """
                OpenClaw could not confirm the agent notification. \
                It will not retry, to avoid a duplicate welcome.
                """)
        case (.skippedUnsupportedGateway, _):
            String(
                localized: "The remote Gateway is older than this Mac app, so OpenClaw skipped the agent notification.")
        case (.skippedWhilePaused, _):
            String(localized: "The Gateway remains paused, so OpenClaw did not wake your agent.")
        default:
            nil
        }
    }

    private func consume(_ outcome: ManagedCLIUpdateOutcome) -> Bool {
        switch outcome {
        case .success:
            return true
        case let .failure(message, details):
            self.fail(message: message, details: details)
            return false
        }
    }

    private func setGatewayUpdateIncomplete(
        _ incomplete: Bool,
        receipt: PostAppUpdateReceipt)
    {
        self.receipt = PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
            incomplete,
            receipt: receipt)
    }

    private func verifyRuntime(connectionMode: AppState.ConnectionMode) async -> Bool {
        guard case .ready = await CLIInstaller.managedStatus() else {
            self.fail(
                message: String(localized: "Gateway verification failed."),
                details: String(localized: "The managed runtime does not match the updated Mac app."))
            return false
        }
        if connectionMode == .remote {
            if let error = await NodeServiceManager.restart() {
                self.fail(
                    message: String(localized: "The Mac node did not restart."),
                    details: error)
                return false
            }
            guard await NodeServiceManager.waitUntilRunning() else {
                self.fail(
                    message: String(localized: "The Mac node did not become ready."),
                    details: String(localized: "The node service restarted but did not remain running."))
                return false
            }
            return true
        }

        await GatewayConnection.shared.shutdown()
        let activation = await CLIInstaller.activateLocalGateway()
        switch activation {
        case .failed:
            self.fail(
                message: String(localized: "The Gateway did not start."),
                details: String(localized: "The update is installed, but Gateway health did not become ready."))
            return false
        case .deferred:
            // A paused Gateway stays paused. On-disk version verification above
            // is sufficient; reconnecting would violate the user's pause state.
            return true
        case .ready:
            break
        }
        await ControlChannel.shared.refreshEndpoint(reason: "post-app-update")
        guard ControlChannel.shared.state == .connected else {
            self.fail(
                message: String(localized: "The Gateway could not reconnect."),
                details: String(
                    localized: "OpenClaw installed the update but could not verify the Gateway connection."))
            return false
        }
        return true
    }

    private func notifyMostRecentSession(
        version: String,
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt) async -> PostUpdateNotificationOutcome
    {
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else {
            return .retryLater
        }
        if connectionMode == .remote {
            let gatewayVersion = await GatewayConnection.shared.cachedGatewayVersion(
                ifCurrentServerLease: serverLease)
            if let blocked = Self.remoteNotificationBlocker(
                gatewayVersion: gatewayVersion,
                appVersion: version)
            {
                return blocked
            }
        }

        let session: PostUpdateSession
        do {
            guard let selected = try await Self.preferredNotificationSession(loadPage: { offset in
                var params: [String: OpenClawKit.AnyCodable] = [
                    "limit": OpenClawKit.AnyCodable(100),
                    "includeGlobal": OpenClawKit.AnyCodable(false),
                    "includeUnknown": OpenClawKit.AnyCodable(false),
                    "configuredAgentsOnly": OpenClawKit.AnyCodable(true),
                    "requireLastInteraction": OpenClawKit.AnyCodable(true),
                    "sortBy": OpenClawKit.AnyCodable("lastInteractionAt"),
                ]
                if offset > 0 {
                    params["offset"] = OpenClawKit.AnyCodable(offset)
                }
                let data = try await GatewayConnection.shared.request(
                    method: "sessions.list",
                    params: params,
                    ifCurrentServerLease: serverLease)
                return try JSONDecoder().decode(PostUpdateSessionsResponse.self, from: data)
            }) else { return .noEligibleSession }
            session = selected
        } catch {
            // Read-only discovery is safe to retry after the next app launch.
            return .retryLater
        }

        let text =
            "OpenClaw updated to \(version). Briefly welcome the user back and say you are updated, " +
            "then continue normally."
        self.receipt = PostAppUpdateReceiptStore.setNotificationInFlight(
            true,
            receipt: self.receipt ?? receipt)
        do {
            _ = try await GatewayConnection.shared.request(
                method: "system-event",
                params: [
                    "text": OpenClawKit.AnyCodable(text),
                    "sessionKey": OpenClawKit.AnyCodable(session.key),
                    "wake": OpenClawKit.AnyCodable(true),
                ],
                ifCurrentServerLease: serverLease)
            return .delivered
        } catch {
            let outcome = Self.notificationSendFailureOutcome(error)
            if outcome == .retryLater {
                self.receipt = PostAppUpdateReceiptStore.setNotificationInFlight(
                    false,
                    receipt: self.receipt ?? receipt)
            }
            return outcome
        }
    }

    static func supportsPostUpdateNotification(
        gatewayVersion: String?,
        appVersion: String) -> Bool
    {
        guard Semver.parse(gatewayVersion) != nil,
              Semver.parse(appVersion) != nil,
              let gatewayVersion
        else { return false }
        return !CLIInstallPrompter.isManagedUpgrade(
            found: gatewayVersion,
            required: appVersion)
    }

    static func isNotificationOnlyRetry(_ receipt: PostAppUpdateReceipt) -> Bool {
        receipt.notificationAttempts > 0 &&
            !receipt.notificationInFlight &&
            !receipt.gatewayUpdateIncomplete
    }

    static func gatewayAction(
        status: CLIInstaller.Status,
        ownsManagedRuntime: Bool,
        gatewayUpdateIncomplete: Bool) -> PostUpdateGatewayAction
    {
        if gatewayUpdateIncomplete, !ownsManagedRuntime {
            return .ownershipFailure
        }
        guard ownsManagedRuntime else { return .none }
        return switch status {
        case .ready:
            gatewayUpdateIncomplete ? .repair : .none
        case let .incompatible(_, found, required):
            CLIInstallPrompter.isManagedUpgrade(found: found, required: required) ? .update : .none
        case .missing, .unusable:
            .install
        }
    }

    static func shouldPresentOwnershipFailure(
        connectionMode: AppState.ConnectionMode,
        gatewayUpdateIncomplete: Bool) -> Bool
    {
        gatewayUpdateIncomplete && connectionMode != .unconfigured
    }

    static func remoteNotificationBlocker(
        gatewayVersion: String?,
        appVersion: String) -> PostUpdateNotificationOutcome?
    {
        guard let gatewayVersion else { return .retryLater }
        return Self.supportsPostUpdateNotification(
            gatewayVersion: gatewayVersion,
            appVersion: appVersion) ? nil : .skippedUnsupportedGateway
    }

    static func ownsManagedRuntime(
        connectionMode: AppState.ConnectionMode,
        programArguments: [String],
        gatewayUpdateChannel: String?,
        installPolicy: String?,
        launchAgentWriteDisabled: Bool) -> Bool
    {
        CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: CLIInstallPrompter.launchAgentUsesManagedCLI(
                programArguments: programArguments),
            gatewayUpdateChannel: gatewayUpdateChannel,
            installPolicy: installPolicy,
            // This debug gate owns only the local Gateway LaunchAgent. Remote
            // mode proves ownership from the node service command instead.
            launchAgentWriteDisabled: connectionMode == .local && launchAgentWriteDisabled)
    }

    static func notificationSendFailureOutcome(_ error: Error) -> PostUpdateNotificationOutcome {
        if error is OpenClawChatTransportSendError || error is GatewayResponseError {
            return .retryLater
        }
        // The request may have committed before another transport failure was
        // observed. Consuming the attempt avoids a duplicate welcome.
        return .deliveryUnconfirmed
    }

    static func preferredNotificationSession(
        loadPage: (Int) async throws -> PostUpdateSessionsResponse) async throws -> PostUpdateSession?
    {
        var offset = 0
        while true {
            let page = try await loadPage(offset)
            if let session = page.sessions.first(where: { session in
                // External direct sessions may belong to other people. Only
                // wake the internal operator surface after an app update.
                session.kind == "direct" &&
                    session.lastChannel?.lowercased() == "webchat" &&
                    session.lastInteractionAt != nil &&
                    session.spawnedBy == nil &&
                    session.parentSessionKey == nil
            }) {
                return session
            }
            guard let nextOffset = page.nextOffset, nextOffset > offset else { return nil }
            offset = nextOffset
        }
    }

    private func finishSilently() {
        PostAppUpdateReceiptStore.clear()
        self.receipt = nil
        self.close()
    }

    private func finishAfterOwnershipCheckFailure(
        connectionMode: AppState.ConnectionMode,
        receipt: PostAppUpdateReceipt)
    {
        guard Self.shouldPresentOwnershipFailure(
            connectionMode: connectionMode,
            gatewayUpdateIncomplete: receipt.gatewayUpdateIncomplete)
        else {
            self.finishSilently()
            return
        }

        // An incomplete receipt proves app-owned Gateway work already began.
        // Keep it retryable when the service record is temporarily unreadable.
        self.show()
        switch connectionMode {
        case .local:
            self.fail(
                message: String(localized: "The Gateway could not be checked."),
                details: String(
                    localized: """
                    OpenClaw could not read the Gateway service ownership record. \
                    Retry after checking the Gateway LaunchAgent.
                    """))
        case .remote:
            self.fail(
                message: String(localized: "The Mac node could not be checked."),
                details: String(
                    localized: """
                    OpenClaw could not read the node service ownership record. \
                    Retry after checking the node LaunchAgent.
                    """))
        case .unconfigured:
            self.finishSilently()
        }
    }

    private func fail(message: String, details: String?) {
        self.model.phase = .failed
        self.model.title = String(localized: "Gateway update needs help")
        self.model.message = message
        self.model.details = details
    }
}

private struct PostUpdateView: View {
    @Bindable var model: PostUpdateModel

    var body: some View {
        VStack(spacing: 0) {
            GlowingOpenClawIcon(size: 150, mood: self.model.mood)
                .frame(height: 205)

            VStack(spacing: 18) {
                Text(self.model.title)
                    .font(.system(size: 25, weight: .semibold))
                    .multilineTextAlignment(.center)
                Text(self.model.message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 430)

                if self.model.isWorking {
                    ProgressView()
                        .controlSize(.large)
                        .padding(.top, 6)
                }

                if let details = self.model.details {
                    ScrollView {
                        Text(details)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 120)
                    .padding(12)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                }

                Spacer(minLength: 0)
                self.actions
            }
            .padding(.horizontal, 42)
            .padding(.bottom, 34)
        }
        .frame(minWidth: 560, minHeight: 600)
        .background(Color(NSColor.windowBackgroundColor))
    }

    @ViewBuilder
    private var actions: some View {
        switch self.model.phase {
        case .failed:
            HStack {
                Button("Update guide") { PostUpdateController.shared.openUpdateGuide() }
                Button("Ask Discord") { PostUpdateController.shared.openDiscord() }
                Spacer()
                Button("Retry") { PostUpdateController.shared.retry() }
                    .buttonStyle(.borderedProminent)
            }
        case .complete:
            HStack {
                Spacer()
                Button("Continue") { PostUpdateController.shared.close() }
                    .buttonStyle(.borderedProminent)
            }
        case .checking, .updating, .verifying, .notifying:
            EmptyView()
        }
    }
}
