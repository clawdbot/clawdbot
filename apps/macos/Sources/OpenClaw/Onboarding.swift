import AppKit
import CryptoKit
import Observation
import OpenClawDiscovery
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to OpenClaw"
}

enum RemoteOnboardingProbeState: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

enum OnboardingSystemAgentResumeStore {
    struct ActivationOwner: Equatable {
        let id: String
        let routeFingerprint: String
    }

    enum PendingState: Equatable {
        case none
        case activating(deadline: Date)
        case verified(deadline: Date)
        case activationExpired
        case completed
    }

    private enum RecordPhase: String {
        case activating
        case verified
        case completed
    }

    private struct Record {
        let phase: RecordPhase
        let startedAt: Date?
        let deadline: Date?
        let activationOwner: ActivationOwner?
    }

    private static let recordVersion = 4
    /// v2 receipts had no auth binding, so a completed marker could otherwise
    /// attach to replacement credentials on the same endpoint.
    private static let unsafeOwnerlessRecordVersion = 2
    /// v3 persisted a plain SHA-256 credential verifier. Never retain or
    /// migrate it; a fresh activation is safer than carrying sensitive bytes.
    private static let unsafeCredentialFingerprintRecordVersion = 3
    private static let legacyRecordVersion = 1
    private static let activationDeadlineSafetySeconds: TimeInterval = 5
    static let maximumActivationTimeoutMs: Double = 480_000
    /// Legacy string markers do not say whether activation returned. Waiting
    /// one full maximum request window is the only safe migration.
    static let legacyActivationLeaseSeconds: TimeInterval =
        maximumActivationTimeoutMs / 1000 + activationDeadlineSafetySeconds

    @MainActor
    static func selectedRouteIdentity(
        state: AppState = AppStateStore.shared,
        preferredGatewayID: String? = GatewayDiscoveryPreferences.preferredStableID()) -> String?
    {
        let defaultRemotePort = GatewayEnvironment.gatewayPort()
        let sshRemotePort: Int = if state.connectionMode == .remote,
                                    state.remoteTransport == .ssh
        {
            RemotePortTunnel.resolveRemotePortOverride(
                defaultRemotePort: defaultRemotePort,
                for: CommandResolver.parseSSHTarget(state.remoteTarget)?.host ?? "") ?? defaultRemotePort
        } else {
            defaultRemotePort
        }
        return self.routeIdentity(
            connectionMode: state.connectionMode,
            preferredGatewayID: preferredGatewayID,
            remoteTransport: state.remoteTransport,
            remoteURL: state.remoteUrl,
            remoteTarget: state.remoteTarget,
            localStateDir: OpenClawConfigFile.stateDirURL(),
            sshRemotePort: sshRemotePort)
    }

    static func routeIdentity(
        connectionMode: AppState.ConnectionMode,
        preferredGatewayID: String?,
        remoteTransport: AppState.RemoteTransport,
        remoteURL: String,
        remoteTarget: String,
        localStateDir: URL = OpenClawConfigFile.stateDirURL(),
        sshRemotePort: Int = GatewayEnvironment.gatewayPort()) -> String?
    {
        switch connectionMode {
        case .unconfigured:
            return nil
        case .local:
            let stateDir = localStateDir.resolvingSymlinksInPath().standardizedFileURL.path
            let defaultStateDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".openclaw", isDirectory: true)
                .resolvingSymlinksInPath()
                .standardizedFileURL.path
            if stateDir == defaultStateDir {
                return "local"
            }
            return "local:\(self.nonSecretFingerprint(stateDir))"
        case .remote:
            if let gatewayID = normalized(preferredGatewayID) {
                return "remote:id:\(gatewayID)"
            }
            let endpoint = switch remoteTransport {
            case .direct:
                self.nonSecretFingerprint(self.directEndpointIdentity(remoteURL))
            case .ssh:
                self.nonSecretFingerprint("\(remoteTarget):gateway-port:\(sshRemotePort)")
            }
            return "remote:\(remoteTransport.rawValue):\(endpoint)"
        }
    }

    static func isPending(
        for routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> Bool
    {
        self.pendingState(for: routeIdentity, defaults: defaults, now: now) != .none
    }

    @discardableResult
    static func markPending(
        routeIdentity: String?,
        activationOwner: ActivationOwner? = nil,
        activationTimeoutMs: Double = OnboardingSystemAgentResumeStore.maximumActivationTimeoutMs,
        defaults: UserDefaults = .standard,
        now: Date = Date())
        -> Date?
    {
        guard let routeIdentity = normalized(routeIdentity) else { return nil }
        let duration = max(0, activationTimeoutMs / 1000) + self.activationDeadlineSafetySeconds
        let deadline = now.addingTimeInterval(duration)
        var records = self.loadRecords(defaults: defaults, now: now)
        records[routeIdentity] = Record(
            phase: .activating,
            startedAt: now,
            deadline: deadline,
            activationOwner: activationOwner)
        self.writeRecords(records, defaults: defaults)
        return deadline
    }

    static func restorePending(
        routeIdentity: String,
        activationOwner: ActivationOwner? = nil,
        deadline: Date,
        defaults: UserDefaults = .standard,
        now: Date = Date())
    {
        guard let routeIdentity = normalized(routeIdentity) else { return }
        var records = self.loadRecords(defaults: defaults, now: now)
        records[routeIdentity] = Record(
            phase: .activating,
            startedAt: now,
            deadline: deadline,
            activationOwner: activationOwner)
        self.writeRecords(records, defaults: defaults)
    }

    static func markVerified(
        ifOwnedBy routeIdentity: String?,
        activationOwner: ActivationOwner? = nil,
        defaults: UserDefaults = .standard,
        now: Date = Date())
    {
        guard let routeIdentity = normalized(routeIdentity) else { return }
        var records = self.loadRecords(defaults: defaults, now: now)
        guard let record = records[routeIdentity],
              ownerMatches(record, activationOwner: activationOwner)
        else { return }
        records[routeIdentity] = Record(
            phase: .verified,
            startedAt: record.startedAt,
            deadline: record.deadline ?? now.addingTimeInterval(self.legacyActivationLeaseSeconds),
            activationOwner: record.activationOwner)
        self.writeRecords(records, defaults: defaults)
    }

    @discardableResult
    static func markCompleted(
        ifOwnedBy routeIdentity: String?,
        activationOwner: ActivationOwner? = nil,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> Bool
    {
        guard let routeIdentity = normalized(routeIdentity) else { return false }
        var records = self.loadRecords(defaults: defaults, now: now)
        guard let record = records[routeIdentity],
              ownerMatches(record, activationOwner: activationOwner)
        else { return false }
        records[routeIdentity] = Record(
            phase: .completed,
            startedAt: record.startedAt,
            deadline: record.deadline,
            activationOwner: record.activationOwner)
        self.writeRecords(records, defaults: defaults)
        return true
    }

    static func activationOwner(
        for routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> ActivationOwner?
    {
        guard let routeIdentity = normalized(routeIdentity) else { return nil }
        return self.loadRecords(defaults: defaults, now: now)[routeIdentity]?.activationOwner
    }

    static func isOwned(
        by activationOwner: ActivationOwner,
        for routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> Bool
    {
        guard let routeIdentity = normalized(routeIdentity),
              let record = loadRecords(defaults: defaults, now: now)[routeIdentity]
        else { return false }
        return record.activationOwner == activationOwner
    }

    static func pendingState(
        for routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> PendingState
    {
        guard let routeIdentity = normalized(routeIdentity),
              let record = loadRecords(defaults: defaults, now: now)[routeIdentity]
        else { return .none }

        switch record.phase {
        case .completed:
            return .completed
        case .activating, .verified:
            guard let deadline = record.deadline else { return .activationExpired }
            guard now < deadline else { return .activationExpired }
            return record.phase == .activating
                ? .activating(deadline: deadline)
                : .verified(deadline: deadline)
        }
    }

    @discardableResult
    static func clear(
        ifOwnedBy routeIdentity: String,
        activationOwner: ActivationOwner? = nil,
        defaults: UserDefaults = .standard) -> Bool
    {
        guard let routeIdentity = normalized(routeIdentity) else { return false }
        var records = self.loadRecords(defaults: defaults)
        guard let record = records[routeIdentity],
              ownerMatches(record, activationOwner: activationOwner)
        else { return false }
        records.removeValue(forKey: routeIdentity)
        self.writeRecords(records, defaults: defaults)
        return true
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: onboardingSystemAgentPendingKey)
        defaults.removeObject(forKey: onboardingSystemAgentPendingRetiredKey)
    }

    /// Pre-rename releases stored the lease under the Crestodian key; adopt it once
    /// so an app upgrade cannot orphan a live activation record.
    private static func storedPendingPayload(defaults: UserDefaults) -> Any? {
        if let stored = defaults.object(forKey: onboardingSystemAgentPendingKey) { return stored }
        guard let retired = defaults.object(forKey: onboardingSystemAgentPendingRetiredKey) else {
            return nil
        }
        defaults.set(retired, forKey: onboardingSystemAgentPendingKey)
        defaults.removeObject(forKey: onboardingSystemAgentPendingRetiredKey)
        return retired
    }

    private static func loadRecords(
        defaults: UserDefaults,
        now: Date = Date()) -> [String: Record]
    {
        guard let stored = self.storedPendingPayload(defaults: defaults) else { return [:] }
        if let legacyRoute = normalized(stored as? String) {
            let records = [legacyRoute: conservativeLegacyRecord(now: now)]
            self.writeRecords(records, defaults: defaults)
            return records
        }
        guard let container = stored as? [String: Any] else {
            self.clear(defaults: defaults)
            return [:]
        }
        let version = (container["version"] as? NSNumber)?.intValue
        if version == self.legacyRecordVersion,
           let routeIdentity = normalized(container["routeIdentity"] as? String)
        {
            let record = self.decodeLegacyRecord(container, now: now)
            let records = [routeIdentity: record]
            self.writeRecords(records, defaults: defaults)
            return records
        }
        if version == self.unsafeOwnerlessRecordVersion ||
            version == self.unsafeCredentialFingerprintRecordVersion
        {
            guard let storedRecords = container["records"] as? [String: Any] else {
                self.clear(defaults: defaults)
                return [:]
            }
            // Strip the unsafe/absent auth owner immediately, but retain active
            // deadlines so a possibly running activation cannot overlap a new one.
            let records: [String: Record] = storedRecords.reduce(into: [:]) { result, entry in
                guard let routeIdentity = normalized(entry.key),
                      let payload = entry.value as? [String: Any],
                      let record = decodeRecord(payload),
                      record.phase != .completed
                else { return }
                result[routeIdentity] = Record(
                    phase: record.phase,
                    startedAt: record.startedAt,
                    deadline: record.deadline,
                    activationOwner: nil)
            }
            self.writeRecords(records, defaults: defaults)
            return records
        }
        guard version == self.recordVersion,
              let storedRecords = container["records"] as? [String: Any]
        else {
            self.clear(defaults: defaults)
            return [:]
        }
        return storedRecords.reduce(into: [:]) { result, entry in
            guard let routeIdentity = normalized(entry.key),
                  let payload = entry.value as? [String: Any],
                  let record = decodeRecord(payload)
            else { return }
            result[routeIdentity] = record
        }
    }

    private static func decodeLegacyRecord(_ payload: [String: Any], now: Date) -> Record {
        guard let phaseRaw = payload["phase"] as? String,
              let phase = RecordPhase(rawValue: phaseRaw)
        else { return self.conservativeLegacyRecord(now: now) }
        let startedAt = self.date(payload["startedAt"])
        let deadline = self.date(payload["deadlineAt"])
        switch phase {
        case .activating:
            return Record(
                phase: .activating,
                startedAt: startedAt ?? now,
                deadline: deadline ?? now.addingTimeInterval(self.legacyActivationLeaseSeconds),
                activationOwner: nil)
        case .verified, .completed:
            // v1 `verified` could be written by an early read-only probe and
            // carried no deadline, so migration must restore a full lease.
            return Record(
                phase: .verified,
                startedAt: startedAt ?? now,
                deadline: deadline ?? now.addingTimeInterval(self.legacyActivationLeaseSeconds),
                activationOwner: nil)
        }
    }

    private static func conservativeLegacyRecord(now: Date) -> Record {
        Record(
            phase: .activating,
            startedAt: now,
            deadline: now.addingTimeInterval(self.legacyActivationLeaseSeconds),
            activationOwner: nil)
    }

    private static func decodeRecord(_ payload: [String: Any]) -> Record? {
        guard let phaseRaw = payload["phase"] as? String,
              let phase = RecordPhase(rawValue: phaseRaw)
        else { return nil }
        let activationID = self.normalized(payload["activationId"] as? String)
        let routeFingerprint = self.normalized(payload["routeFingerprint"] as? String)
        let activationOwner: ActivationOwner? = if let activationID, let routeFingerprint {
            ActivationOwner(id: activationID, routeFingerprint: routeFingerprint)
        } else {
            nil
        }
        return Record(
            phase: phase,
            startedAt: self.date(payload["startedAt"]),
            deadline: self.date(payload["deadlineAt"]),
            activationOwner: activationOwner)
    }

    private static func writeRecords(_ records: [String: Record], defaults: UserDefaults) {
        guard !records.isEmpty else {
            self.clear(defaults: defaults)
            return
        }
        let payload = records.mapValues { record -> [String: Any] in
            var value: [String: Any] = ["phase": record.phase.rawValue]
            if let startedAt = record.startedAt {
                value["startedAt"] = startedAt.timeIntervalSince1970
            }
            if let deadline = record.deadline {
                value["deadlineAt"] = deadline.timeIntervalSince1970
            }
            if let activationOwner = record.activationOwner {
                value["activationId"] = activationOwner.id
                value["routeFingerprint"] = activationOwner.routeFingerprint
            }
            return value
        }
        defaults.set(
            ["version": self.recordVersion, "records": payload],
            forKey: onboardingSystemAgentPendingKey)
    }

    private static func date(_ value: Any?) -> Date? {
        guard let interval = (value as? NSNumber)?.doubleValue else { return nil }
        return Date(timeIntervalSince1970: interval)
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func ownerMatches(
        _ record: Record,
        activationOwner: ActivationOwner?) -> Bool
    {
        // A missing owner names legacy ownerless records; it is not a wildcard.
        // Otherwise stale UI paths can verify, complete, or clear a newer activation.
        record.activationOwner == activationOwner
    }

    private static func nonSecretFingerprint(_ value: String) -> String {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "" }
        let digest = SHA256.hash(data: Data(raw.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func directEndpointIdentity(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = GatewayRemoteConfig.normalizeGatewayUrlString(trimmed) ?? trimmed
        guard var components = URLComponents(string: normalized) else { return normalized }
        // Auth can rotate while an activation is still committing. The durable
        // lease follows the endpoint, while route-bound RPCs separately guard auth.
        components.user = nil
        components.password = nil
        components.queryItems = components.queryItems?.filter { queryItem in
            !self.isSensitiveQueryItemName(queryItem.name)
        }
        if components.queryItems?.isEmpty == true {
            components.query = nil
        }
        components.fragment = nil
        return components.string ?? normalized
    }

    private static func isSensitiveQueryItemName(_ value: String) -> Bool {
        let normalized = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
        return [
            "access_token",
            "api_key",
            "apikey",
            "app_secret",
            "auth",
            "auth_token",
            "authorization",
            "client_secret",
            "code",
            "credential",
            "hook_token",
            "id_token",
            "jwt",
            "key",
            "pass",
            "passwd",
            "password",
            "private_key",
            "refresh_token",
            "secret",
            "session",
            "signature",
            "token",
            "x_amz_security_token",
            "x_amz_signature",
        ].contains(normalized)
    }
}

@MainActor
final class OnboardingController: NSObject, NSWindowDelegate {
    static let shared = OnboardingController()
    static let windowStyleMask: NSWindow.StyleMask = [.titled, .closable, .resizable, .fullSizeContentView]
    private var window: NSWindow?
    /// Human description of work in flight ("Installing the Gateway…").
    /// While set, closing the window asks for confirmation instead of quitting
    /// setup mid-operation.
    var busyReason: String?

    static func markComplete() {
        UserDefaults.standard.set(true, forKey: onboardingSeenKey)
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true
        DashboardManager.shared.handleOnboardingCompletion()
    }

    func show() {
        if ProcessInfo.processInfo.isNixMode {
            // Nix mode is fully declarative; onboarding would suggest interactive setup that doesn't apply.
            Self.markComplete()
            return
        }
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.styleMask = Self.windowStyleMask
        window.setContentSize(NSSize(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight))
        if let visibleFrame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
            // Constrain the full window frame, not only its content. Otherwise the
            // navigation bar can land below the Dock on shorter displays.
            window.setFrame(Self.initialWindowFrame(visibleFrame: visibleFrame), display: false)
        } else {
            window.center()
        }
        // Keep the focused dialog width while letting taller displays give setup more breathing room.
        window.contentMinSize = NSSize(
            width: OnboardingView.windowWidth,
            height: OnboardingView.minimumWindowHeight)
        window.contentMaxSize = NSSize(width: OnboardingView.windowWidth, height: .greatestFiniteMagnitude)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.delegate = self
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    static func initialWindowFrame(visibleFrame: NSRect) -> NSRect {
        let contentRect = NSRect(
            origin: .zero,
            size: NSSize(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight))
        let preferredFrame = NSWindow.frameRect(forContentRect: contentRect, styleMask: self.windowStyleMask)
        return WindowPlacement.centeredFrame(size: preferredFrame.size, in: visibleFrame)
    }

    func close() {
        self.busyReason = nil
        self.window?.close()
        self.window = nil
    }

    func setWindowCloseEnabled(_ enabled: Bool) {
        self.window?.standardWindowButton(.closeButton)?.isEnabled = enabled
    }

    func restart() {
        self.close()
        self.show()
    }

    func windowShouldClose(_: NSWindow) -> Bool {
        guard let busyReason else { return true }
        let alert = NSAlert()
        alert.messageText = "Setup is still working"
        alert.informativeText =
            "\(busyReason)\n\nYou can keep this window open until it finishes, " +
            "or quit setup and pick it up again later from the menu bar."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Continue Setup")
        alert.addButton(withTitle: "Quit Setup")
        let response = alert.runModal()
        return response == .alertSecondButtonReturn
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        self.busyReason = nil
        self.window = nil
    }
}

struct OnboardingView: View {
    enum CLIInstallPhase {
        case idle
        case installing
        case startingService
    }

    @State var currentPage = 0
    @State var isRequesting = false
    @State var installingCLI = false
    @State var cliInstallPhase: CLIInstallPhase = .idle
    @State var cliStatus: String?
    @State var monitoringPermissions = false
    @State var monitoringDiscovery = false
    @State var cliExecutableReady = false
    @State var cliInstalled = false
    @State var cliStatusKnown = false
    @State var onboardingVisible = false
    @State var cliInstallLocation: String?
    @State var showAdvancedConnection = false
    @State var showRemoteChoices = false
    @State var preferredGatewayID: String?
    @State var remoteProbeState: RemoteOnboardingProbeState = .idle
    @State var remoteAuthIssue: RemoteGatewayAuthIssue?
    @State var suppressRemoteProbeReset = false
    @State var gatewayDiscovery: GatewayDiscoveryModel
    @State var onboardingSkillsModel = SkillsSettingsModel()
    @State var systemAgentState = OnboardingSystemAgentChatState()
    @State var aiSetup = OnboardingAISetupModel()
    @State var configuredGatewayProbe = OnboardingConfiguredGatewayProbe()
    @State var didLoadOnboardingSkills = false
    @State var localGatewayProbe: LocalGatewayProbe?
    @State var defaultsToLocalGateway: Bool
    @Bindable var state: AppState
    var permissionMonitor: PermissionMonitor
    let systemAgentDefaults: UserDefaults
    let aiSetupRouteIdentityProvider: @MainActor () -> String?
    let gatewaySelectionPersister: @MainActor () -> Bool

    static let windowWidth: CGFloat = 630
    static let windowHeight: CGFloat = 752 // ~+10% to fit full onboarding content
    static let minimumWindowHeight: CGFloat = 520

    let pageWidth: CGFloat = Self.windowWidth
    let connectionPageIndex = 1
    let cliPageIndex = 2
    let aiPageIndex = 3
    let onboardingChatPageIndex = 8
    let readyPageIndex = 9

    let permissionsPageIndex = 5

    var heroFrameHeight: CGFloat {
        145
    }

    var heroSize: CGFloat {
        130
    }

    /// The active page is scrollable on short screens. Taller windows donate all
    /// extra room instead of leaving the content pinned to a fixed canvas.
    func contentHeight(for windowHeight: CGFloat) -> CGFloat {
        Self.contentHeight(for: windowHeight, usesCompactHero: self.usesCompactHero)
    }

    static func contentHeight(for windowHeight: CGFloat, usesCompactHero: Bool) -> CGFloat {
        let heroHeight: CGFloat = usesCompactHero ? 78 : 145
        return max(0, windowHeight - heroHeight - 72)
    }

    static func pageOrder(
        for mode: AppState.ConnectionMode,
        requiresCLIInstall: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote mode skips local Gateway/workspace setup, but its Mac node
            // still runs the matching CLI node-host runtime inside the app.
            let setupPages = requiresCLIInstall ? [0, 1, 2, 3, 5] : [0, 1, 3, 5]
            return setupPages + [9]
        case .unconfigured:
            return [0, 1, 9]
        case .local:
            let setupPages = requiresCLIInstall ? [0, 1, 2, 3, 5] : [0, 1, 3, 5]
            return setupPages + [9]
        }
    }

    static func shouldActivateLocalGateway(afterCLIInstallFor mode: AppState.ConnectionMode) -> Bool {
        mode == .local
    }

    var selectedConnectionMode: AppState.ConnectionMode {
        if self.isConnectionSelectionBlocking {
            return .local
        }
        return self.state.connectionMode
    }

    var isConnectionSelectionBlocking: Bool {
        self.defaultsToLocalGateway && self.state.connectionMode == .unconfigured
    }

    var pageOrder: [Int] {
        Self.pageOrder(
            for: self.state.connectionMode,
            requiresCLIInstall: !self.cliInstalled)
    }

    var pageCount: Int {
        self.pageOrder.count
    }

    var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    var buttonTitle: String {
        self.currentPage == self.pageCount - 1 ? "Finish" : "Next"
    }

    var isCLIBlocking: Bool {
        self.activePageIndex == self.cliPageIndex && !self.cliInstalled
    }

    /// Onboarding must not finish without working inference: the AI page
    /// blocks Next until a candidate passed its live test (config is authored
    /// server-side on that success). "Configure later" on the connection page
    /// remains the explicit skip path.
    var isAISetupBlocking: Bool {
        Self.shouldBlockAISetup(
            currentPage: self.currentPage,
            pageOrder: self.pageOrder,
            aiPageIndex: self.aiPageIndex,
            connectionMode: self.state.connectionMode,
            connected: self.aiSetup.connected)
    }

    static func shouldBlockAISetup(
        currentPage: Int,
        pageOrder: [Int],
        aiPageIndex: Int,
        connectionMode: AppState.ConnectionMode,
        connected: Bool) -> Bool
    {
        guard connectionMode != .unconfigured,
              !connected,
              let aiPageCursor = pageOrder.firstIndex(of: aiPageIndex)
        else {
            return false
        }
        return currentPage >= aiPageCursor
    }

    var canAdvance: Bool {
        !self.isCLIBlocking && !self.isAISetupBlocking
    }

    struct LocalGatewayProbe: Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let expected: Bool
    }

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: GatewayDiscoveryModel = GatewayDiscoveryModel(
            localDisplayName: InstanceIdentity.displayName,
            filterLocalGateways: false),
        aiSetupGateway: GatewayConnection = .shared,
        systemAgentDefaults: UserDefaults = .standard,
        aiSetupRouteIdentityProvider: (@MainActor () -> String?)? = nil,
        configuredGatewayProbeTimeoutMs: Double = 15000,
        gatewaySelectionPersister: (@MainActor () -> Bool)? = nil)
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self.systemAgentDefaults = systemAgentDefaults
        let routeIdentityProvider = aiSetupRouteIdentityProvider ?? {
            OnboardingSystemAgentResumeStore.selectedRouteIdentity(state: state)
        }
        self.aiSetupRouteIdentityProvider = routeIdentityProvider
        self.gatewaySelectionPersister = gatewaySelectionPersister ?? {
            state.syncGatewayConfigNow()
        }
        _defaultsToLocalGateway = State(
            initialValue: !state.onboardingSeen && state.connectionMode == .unconfigured)
        _gatewayDiscovery = State(initialValue: discoveryModel)
        _aiSetup = State(initialValue: OnboardingAISetupModel(
            gateway: aiSetupGateway,
            defaults: systemAgentDefaults,
            routeIdentityProvider: routeIdentityProvider))
        _configuredGatewayProbe = State(
            initialValue: OnboardingConfiguredGatewayProbe(
                gateway: aiSetupGateway,
                timeoutMs: configuredGatewayProbeTimeoutMs))
    }
}
