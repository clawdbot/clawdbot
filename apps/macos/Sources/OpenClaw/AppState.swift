import AppKit
import Foundation
import Observation
import OpenClawKit
import ServiceManagement
import SwiftUI

enum ExecApprovalsPolicyLoadState: Equatable {
    case loading
    case available
    case unavailable(String)

    var isAvailable: Bool {
        self == .available
    }

    var errorMessage: String? {
        guard case let .unavailable(message) = self else { return nil }
        return message
    }
}

@MainActor
@Observable
final class AppState {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app-state")
    private static let execApprovalsReadRetryAttempts = 5
    private static let execApprovalsReadUnavailableMessage = "Exec approvals unavailable. Retry to refresh."

    private let isPreview: Bool
    @ObservationIgnored private let execApprovalsDefaultsAsyncResolver:
        @MainActor () async -> Result<ExecApprovalsResolvedDefaults, ExecApprovalsReadError>
    @ObservationIgnored private let execApprovalsReadRetryDelay: Duration
    @ObservationIgnored let bundleLocationAllowsPersistentIntegration: Bool
    @ObservationIgnored private var execApprovalsReadRetryTask: Task<Void, Never>?
    @ObservationIgnored private var execApprovalsReadGeneration = 0
    @ObservationIgnored private var isHydratingLaunchAtLogin = false
    private var isInitializing = true
    private var isApplyingRemoteTokenConfig = false
    private enum GatewayConfigSyncState: Equatable {
        case current
        case pending
        case failed
    }

    @ObservationIgnored private var gatewayConfigSyncState = GatewayConfigSyncState.current
    @ObservationIgnored private var gatewayConfigSyncTask: Task<Void, Never>?
    @ObservationIgnored private(set) var gatewayRoutingGeneration: UInt64 = 0
    #if DEBUG
    @ObservationIgnored private var gatewayConfigSyncEnabledForTesting = false
    #endif
    private var configWatcher: ConfigFileWatcher?
    private var lastConfigFingerprint: Data?
    private var suppressVoiceWakeGlobalSync = false
    private var voiceWakeGlobalSyncTask: Task<Void, Never>?

    private func ifNotPreview(_ action: () -> Void) {
        guard !self.isPreview else { return }
        action()
    }

    var isPaused: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) } }
    }

    var launchAtLogin: Bool {
        didSet {
            guard Self.shouldPersistLaunchAtLoginChange(
                isInitializing: self.isInitializing,
                isHydrating: self.isHydratingLaunchAtLogin,
                isEnabling: self.launchAtLogin,
                bundleLocationAllowsPersistentIntegration: self.bundleLocationAllowsPersistentIntegration)
            else { return }
            self.ifNotPreview { Task { AppStateStore.updateLaunchAtLogin(enabled: self.launchAtLogin) } }
        }
    }

    static func shouldPersistLaunchAtLoginChange(
        isInitializing: Bool,
        isHydrating: Bool,
        isEnabling: Bool,
        bundleLocationAllowsPersistentIntegration: Bool) -> Bool
    {
        !isInitializing && !isHydrating && (!isEnabling || bundleLocationAllowsPersistentIntegration)
    }

    var onboardingSeen: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.onboardingSeen, forKey: onboardingSeenKey) }
        }
    }

    var debugPaneEnabled: Bool {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.debugPaneEnabled, forKey: debugPaneEnabledKey) }
            CanvasManager.shared.refreshDebugStatus()
        }
    }

    var swabbleEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.swabbleEnabled, forKey: swabbleEnabledKey)
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    var swabbleTriggerWords: [String] {
        didSet {
            // Preserve the raw editing state; sanitization happens when we actually use the triggers.
            self.ifNotPreview {
                UserDefaults.standard.set(self.swabbleTriggerWords, forKey: swabbleTriggersKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
                self.scheduleVoiceWakeGlobalSyncIfNeeded()
            }
        }
    }

    var voiceWakeTriggerChime: VoiceWakeChime {
        didSet { self.ifNotPreview { self.storeChime(self.voiceWakeTriggerChime, key: voiceWakeTriggerChimeKey) } }
    }

    var voiceWakeSendChime: VoiceWakeChime {
        didSet { self.ifNotPreview { self.storeChime(self.voiceWakeSendChime, key: voiceWakeSendChimeKey) } }
    }

    var iconAnimationsEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.iconAnimationsEnabled,
            forKey: iconAnimationsEnabledKey) } }
    }

    var showDockIcon: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.showDockIcon, forKey: showDockIconKey)
                AppActivationPolicy.apply(showDockIcon: self.showDockIcon)
            }
        }
    }

    var voiceWakeMicID: String {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.voiceWakeMicID, forKey: voiceWakeMicKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    var voiceWakeMicName: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.voiceWakeMicName, forKey: voiceWakeMicNameKey) } }
    }

    var voiceWakeLocaleID: String {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.voiceWakeLocaleID, forKey: voiceWakeLocaleKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    var voiceWakeAdditionalLocaleIDs: [String] {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.voiceWakeAdditionalLocaleIDs,
            forKey: voiceWakeAdditionalLocalesKey) } }
    }

    var voicePushToTalkEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.voicePushToTalkEnabled,
            forKey: voicePushToTalkEnabledKey) } }
    }

    var voiceWakeTriggersTalkMode: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.voiceWakeTriggersTalkMode, forKey: voiceWakeTriggersTalkModeKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    var voiceWakeMeterActive = false

    var talkEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.talkEnabled, forKey: talkEnabledKey)
                Task { await TalkModeController.shared.setEnabled(self.talkEnabled) }
            }
        }
    }

    var talkPhaseSoundsEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.talkPhaseSoundsEnabled, forKey: talkPhaseSoundsEnabledKey)
            }
        }
    }

    var talkShiftToStopEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.talkShiftToStopEnabled, forKey: talkShiftToStopEnabledKey)
                Task { TalkSpeechInterruptMonitor.shared.setEnabled(self.talkShiftToStopEnabled && self.talkEnabled) }
            }
        }
    }

    /// Gateway-provided UI accent color (hex). Optional; clients provide a default.
    var seamColorHex: String?

    var iconOverride: IconOverrideSelection {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.iconOverride.rawValue, forKey: iconOverrideKey) } }
    }

    var isWorking: Bool = false
    var earBoostActive: Bool = false
    var blinkTick: Int = 0
    var sendCelebrationTick: Int = 0
    var heartbeatsEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.heartbeatsEnabled, forKey: heartbeatsEnabledKey)
                Task { _ = await GatewayConnection.shared.setHeartbeatsEnabled(self.heartbeatsEnabled) }
            }
        }
    }

    var connectionMode: ConnectionMode {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.connectionMode.rawValue, forKey: connectionModeKey) }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteTransport: RemoteTransport {
        didSet { syncGatewayConfigIfNeeded() }
    }

    var canvasEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.canvasEnabled, forKey: canvasEnabledKey) } }
    }

    var execApprovalMode: ExecApprovalQuickMode
    var execApprovalPolicyLoadState: ExecApprovalsPolicyLoadState
    var execApprovalMutationError: String?

    /// Tracks whether the Canvas panel is currently visible (not persisted).
    var canvasPanelVisible: Bool = false

    var peekabooBridgeEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.peekabooBridgeEnabled, forKey: peekabooBridgeEnabledKey)
            }
            self.applyPeekabooBridgeHostState()
        }
    }

    /// PeekabooBridge shares Computer Control's local UI-automation surface, so the host only
    /// runs while Computer Control is enabled. With Computer Control off, users drive Peekaboo
    /// via its own Mac app instead of a second, separately toggled bridge here.
    func applyPeekabooBridgeHostState() {
        self.ifNotPreview {
            let computerControlEnabled = UserDefaults.standard
                .object(forKey: computerControlEnabledKey) as? Bool ?? false
            let shouldRun = self.peekabooBridgeEnabled && computerControlEnabled
            Task { await PeekabooBridgeHostCoordinator.shared.setEnabled(shouldRun) }
        }
    }

    var remoteTarget: String {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.remoteTarget, forKey: remoteTargetKey) }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteUrl: String {
        didSet { syncGatewayConfigIfNeeded() }
    }

    var remoteToken: String {
        didSet {
            guard !self.isApplyingRemoteTokenConfig else { return }
            self.remoteTokenDirty = true
            self.remoteTokenUnsupported = false
            syncGatewayConfigIfNeeded()
        }
    }

    private(set) var remoteTokenDirty = false
    private(set) var remoteTokenUnsupported = false

    var remoteIdentity: String {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.remoteIdentity, forKey: remoteIdentityKey) }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteProjectRoot: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteProjectRoot, forKey: remoteProjectRootKey) } }
    }

    var remoteCliPath: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteCliPath, forKey: remoteCliPathKey) } }
    }

    private var earBoostTask: Task<Void, Never>?

    init(
        preview: Bool = false,
        execApprovalsDefaultsAsyncResolver: @escaping @MainActor () async -> Result<
            ExecApprovalsResolvedDefaults,
            ExecApprovalsReadError,
        > = {
            await ExecApprovalsStore.resolveDefaultsAsyncResult()
        },
        execApprovalsReadRetryDelay: Duration = .milliseconds(250))
    {
        let isPreview = preview || ProcessInfo.processInfo.isRunningTests
        self.isPreview = isPreview
        self.bundleLocationAllowsPersistentIntegration =
            isPreview || ApplicationRelocator.currentBundleAllowsPersistentIntegration()
        self.execApprovalsDefaultsAsyncResolver = execApprovalsDefaultsAsyncResolver
        self.execApprovalsReadRetryDelay = execApprovalsReadRetryDelay
        let onboardingSeen = UserDefaults.standard.bool(forKey: onboardingSeenKey)
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.launchAtLogin = false
        self.onboardingSeen = onboardingSeen
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: debugPaneEnabledKey)
        let savedVoiceWake = UserDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleEnabled = voiceWakeSupported ? savedVoiceWake : false
        self.swabbleTriggerWords = UserDefaults.standard
            .stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
        self.voiceWakeTriggerChime = Self.loadChime(
            key: voiceWakeTriggerChimeKey,
            fallback: .system(name: "Glass"))
        self.voiceWakeSendChime = Self.loadChime(
            key: voiceWakeSendChimeKey,
            fallback: .system(name: "Glass"))
        if let storedIconAnimations = UserDefaults.standard.object(forKey: iconAnimationsEnabledKey) as? Bool {
            self.iconAnimationsEnabled = storedIconAnimations
        } else {
            self.iconAnimationsEnabled = true
            UserDefaults.standard.set(true, forKey: iconAnimationsEnabledKey)
        }
        if let storedShowDockIcon = UserDefaults.standard.object(forKey: showDockIconKey) as? Bool {
            self.showDockIcon = storedShowDockIcon
        } else {
            self.showDockIcon = true
            UserDefaults.standard.set(true, forKey: showDockIconKey)
        }
        self.voiceWakeMicID = UserDefaults.standard.string(forKey: voiceWakeMicKey) ?? ""
        self.voiceWakeMicName = UserDefaults.standard.string(forKey: voiceWakeMicNameKey) ?? ""
        self.voiceWakeLocaleID = UserDefaults.standard.string(forKey: voiceWakeLocaleKey) ?? Locale.current.identifier
        self.voiceWakeAdditionalLocaleIDs = UserDefaults.standard
            .stringArray(forKey: voiceWakeAdditionalLocalesKey) ?? []
        self.voicePushToTalkEnabled = UserDefaults.standard
            .object(forKey: voicePushToTalkEnabledKey) as? Bool ?? false
        self.voiceWakeTriggersTalkMode = UserDefaults.standard
            .object(forKey: voiceWakeTriggersTalkModeKey) as? Bool ?? false
        self.talkEnabled = UserDefaults.standard.bool(forKey: talkEnabledKey)
        if let storedPhaseSounds = UserDefaults.standard.object(forKey: talkPhaseSoundsEnabledKey) as? Bool {
            self.talkPhaseSoundsEnabled = storedPhaseSounds
        } else {
            self.talkPhaseSoundsEnabled = true
            UserDefaults.standard.set(true, forKey: talkPhaseSoundsEnabledKey)
        }
        if let storedShiftToStop = UserDefaults.standard.object(forKey: talkShiftToStopEnabledKey) as? Bool {
            self.talkShiftToStopEnabled = storedShiftToStop
        } else {
            self.talkShiftToStopEnabled = true
            UserDefaults.standard.set(true, forKey: talkShiftToStopEnabledKey)
        }
        self.seamColorHex = nil
        if let storedHeartbeats = UserDefaults.standard.object(forKey: heartbeatsEnabledKey) as? Bool {
            self.heartbeatsEnabled = storedHeartbeats
        } else {
            self.heartbeatsEnabled = true
            UserDefaults.standard.set(true, forKey: heartbeatsEnabledKey)
        }
        if let storedOverride = UserDefaults.standard.string(forKey: iconOverrideKey),
           let selection = IconOverrideSelection(rawValue: storedOverride)
        {
            self.iconOverride = selection
        } else {
            self.iconOverride = .system
            UserDefaults.standard.set(IconOverrideSelection.system.rawValue, forKey: iconOverrideKey)
        }

        let configRoot = OpenClawConfigFile.loadDict()
        self.lastConfigFingerprint = Self.configFingerprint(configRoot)
        let configRemoteToken = GatewayRemoteConfig.resolveTokenValue(root: configRoot)
        let configRemoteResolution = GatewayRemoteConfig.resolveTransportResolution(root: configRoot)
        let configRemoteTransport = configRemoteResolution.transport
        let configRemoteUrl = configRemoteResolution.directURL?.absoluteString
            ?? GatewayRemoteConfig.resolveUrlString(root: configRoot)
        let resolvedConnectionMode = ConnectionModeResolver.resolve(root: configRoot).mode
        self.remoteTransport = configRemoteTransport
        self.connectionMode = resolvedConnectionMode

        let configRemote = (configRoot["gateway"] as? [String: Any])?["remote"] as? [String: Any]
        let hasConfigRemoteTarget = configRemote?.keys.contains("sshTarget") == true
        let configRemoteTarget = (configRemote?["sshTarget"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let storedRemoteTarget = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        if resolvedConnectionMode == .remote,
           hasConfigRemoteTarget
        {
            self.remoteTarget = configRemoteTarget
        } else if resolvedConnectionMode == .remote,
                  configRemoteTransport != .direct,
                  storedRemoteTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let host = AppState.remoteHost(from: configRemoteUrl),
                  !LoopbackHost.isLoopbackHost(host)
        {
            self.remoteTarget = "\(NSUserName())@\(host)"
        } else {
            self.remoteTarget = storedRemoteTarget
        }
        self.remoteUrl = configRemoteUrl ?? ""
        self.remoteToken = configRemoteToken.textFieldValue
        self.remoteTokenDirty = false
        self.remoteTokenUnsupported = configRemoteToken.isUnsupportedNonString
        let hasConfigRemoteIdentity = configRemote?.keys.contains("sshIdentity") == true
        let configRemoteIdentity = (configRemote?["sshIdentity"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.remoteIdentity = hasConfigRemoteIdentity
            ? configRemoteIdentity
            : UserDefaults.standard.string(forKey: remoteIdentityKey)?.nonEmpty ?? ""
        self.remoteProjectRoot = UserDefaults.standard.string(forKey: remoteProjectRootKey)?.nonEmpty ?? ""
        self.remoteCliPath = UserDefaults.standard.string(forKey: remoteCliPathKey)?.nonEmpty ?? ""
        self.canvasEnabled = UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
        self.execApprovalMode = .deny
        self.execApprovalPolicyLoadState = .loading
        self.peekabooBridgeEnabled = UserDefaults.standard
            .object(forKey: peekabooBridgeEnabledKey) as? Bool ?? true
        if !self.isPreview {
            Task.detached(priority: .utility) { [weak self] in
                let current = await LaunchAgentManager.status()
                await MainActor.run { [weak self] in self?.hydrateLaunchAtLogin(current) }
            }
        }

        if self.swabbleEnabled, !PermissionManager.voiceWakePermissionsGranted() {
            self.swabbleEnabled = false
        }
        if self.talkEnabled, !PermissionManager.voiceWakePermissionsGranted() {
            self.talkEnabled = false
        }

        if !self.isPreview {
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            Task { await TalkModeController.shared.setEnabled(self.talkEnabled) }
        }

        if !self.isPreview {
            self.reconcilePreferredGatewayRouteBinding()
        }
        self.isInitializing = false
        if !self.isPreview {
            scheduleExecApprovalModeReadRetry()
        }
        if !self.isPreview {
            self.startConfigWatcher()
        }
    }

    private func hydrateLaunchAtLogin(_ enabled: Bool) {
        // Reading launchd state must not rewrite a valid plist with this process's transient bundle path.
        self.isHydratingLaunchAtLogin = true
        self.launchAtLogin = enabled
        self.isHydratingLaunchAtLogin = false
    }

    @MainActor
    deinit {
        self.execApprovalsReadRetryTask?.cancel()
        self.gatewayConfigSyncTask?.cancel()
        self.configWatcher?.stop()
    }

    private static func remoteHost(from urlString: String?) -> String? {
        guard let raw = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty
        else {
            return nil
        }
        return host
    }

    private static func sanitizeSSHTarget(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("ssh ") {
            return trimmed.replacingOccurrences(of: "ssh ", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    private static func sshTunnelGatewayUrl(existingUrl: String?, expectedRemoteHost: String?) -> String {
        let fallback = "ws://127.0.0.1:18789"
        let trimmed = existingUrl?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty
        else {
            return fallback
        }

        let preservePort: Bool = if LoopbackHost.isLoopbackHost(host) {
            true
        } else if let expectedRemoteHost {
            OpenClawConfigFile.canonicalHostForComparison(host) ==
                OpenClawConfigFile.canonicalHostForComparison(expectedRemoteHost)
        } else {
            false
        }
        guard preservePort else { return fallback }

        return "ws://127.0.0.1:\(url.port ?? 18789)"
    }

    private static func updateGatewayString(
        _ dictionary: inout [String: Any],
        key: String,
        value: String?) -> Bool
    {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            guard dictionary[key] != nil else { return false }
            dictionary.removeValue(forKey: key)
            return true
        }
        if (dictionary[key] as? String) != trimmed {
            dictionary[key] = trimmed
            return true
        }
        return false
    }

    private func applyRemoteTokenState(_ tokenValue: GatewayRemoteConfig.TokenValue) {
        let nextToken = tokenValue.textFieldValue
        let unsupported = tokenValue.isUnsupportedNonString
        guard self.remoteToken != nextToken || self.remoteTokenDirty || self.remoteTokenUnsupported != unsupported
        else {
            return
        }
        self.isApplyingRemoteTokenConfig = true
        self.remoteToken = nextToken
        self.isApplyingRemoteTokenConfig = false
        self.remoteTokenDirty = false
        self.remoteTokenUnsupported = unsupported
    }

    private static func updatedRemoteGatewayConfig(
        current: [String: Any],
        draft: RemoteGatewayConfigDraft) -> (remote: [String: Any], changed: Bool)
    {
        var remote = current
        var changed = false

        switch draft.transport {
        case .direct:
            changed = Self.updateGatewayString(
                &remote,
                key: "transport",
                value: RemoteTransport.direct.rawValue) || changed

            let trimmedUrl = draft.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedUrl.isEmpty {
                changed = Self.updateGatewayString(&remote, key: "url", value: nil) || changed
            } else if let normalizedUrl = GatewayRemoteConfig.normalizeGatewayUrlString(trimmedUrl) {
                changed = Self.updateGatewayString(&remote, key: "url", value: normalizedUrl) || changed
            }

        case .ssh:
            changed = Self.updateGatewayString(
                &remote,
                key: "transport",
                value: RemoteTransport.ssh.rawValue) || changed

            let existingTarget = Self.sanitizeSSHTarget(remote["sshTarget"] as? String ?? "")
            let sanitizedTarget = Self.sanitizeSSHTarget(draft.remoteTarget)
            let expectedRemoteHost = CommandResolver.parseSSHTarget(sanitizedTarget)?.host ?? draft.remoteHost
            let existingUrl = (remote["url"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let desiredUrl = Self.sshTunnelGatewayUrl(
                existingUrl: existingUrl,
                expectedRemoteHost: expectedRemoteHost)
            changed = Self.updateGatewayString(&remote, key: "url", value: desiredUrl) || changed
            changed = Self.updateGatewayString(&remote, key: "sshTarget", value: sanitizedTarget) || changed
            changed = Self.updateGatewayString(&remote, key: "sshIdentity", value: draft.remoteIdentity) || changed
            if existingTarget != sanitizedTarget {
                changed = Self.updateGatewayString(
                    &remote,
                    key: "sshHostKeyPolicy",
                    value: "strict") || changed
            }
        }

        if draft.remoteTokenDirty {
            changed = Self.updateGatewayString(&remote, key: "token", value: draft.remoteToken) || changed
        }

        return (remote, changed)
    }

    private func startConfigWatcher() {
        let configUrl = OpenClawConfigFile.url()
        self.configWatcher = ConfigFileWatcher(url: configUrl) { [weak self] in
            Task { @MainActor in
                self?.applyConfigFromDisk()
            }
        }
        self.configWatcher?.start()
    }

    private func applyConfigFromDisk() {
        let root = OpenClawConfigFile.loadDict()
        let fingerprint = Self.configFingerprint(root)
        guard fingerprint != self.lastConfigFingerprint else { return }
        self.lastConfigFingerprint = fingerprint
        self.applyConfigOverrides(root)
        MacNodeModeCoordinator.shared.refresh()
        NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
    }

    private static func configFingerprint(_ root: [String: Any]) -> Data? {
        var comparableRoot = root
        if var meta = comparableRoot["meta"] as? [String: Any] {
            // Writers refresh these bookkeeping fields without changing runtime configuration.
            // Ignoring them prevents metadata churn from restarting gateway and node routing.
            meta.removeValue(forKey: "lastTouchedAt")
            meta.removeValue(forKey: "lastTouchedVersion")
            if meta.isEmpty {
                comparableRoot.removeValue(forKey: "meta")
            } else {
                comparableRoot["meta"] = meta
            }
        }
        return try? JSONSerialization.data(withJSONObject: comparableRoot, options: [.sortedKeys])
    }

    private func applyConfigOverrides(_ root: [String: Any]) {
        advanceGatewayRoutingGeneration()
        let previousSelection = self.gatewaySelectionSnapshot()
        let gateway = root["gateway"] as? [String: Any]
        let remote = gateway?["remote"] as? [String: Any]
        let modeRaw = (gateway?["mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let remoteUrl = GatewayRemoteConfig.resolveUrlString(root: root)
        let remoteToken = GatewayRemoteConfig.resolveTokenValue(root: root)
        let hasRemoteUrl = !(remoteUrl?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty ?? true)
        let remoteResolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        let remoteTransport = remoteResolution.transport

        let desiredMode: ConnectionMode? = switch modeRaw {
        case "local":
            .local
        case "remote":
            .remote
        case "unconfigured":
            .unconfigured
        default:
            nil
        }

        if let desiredMode {
            if desiredMode != self.connectionMode {
                self.connectionMode = desiredMode
            }
        } else if hasRemoteUrl, self.connectionMode != .remote {
            self.connectionMode = .remote
        }

        if remoteTransport != self.remoteTransport {
            self.remoteTransport = remoteTransport
        }
        let remoteUrlText = remoteResolution.directURL?.absoluteString ?? remoteUrl ?? ""
        if remoteUrlText != self.remoteUrl {
            self.remoteUrl = remoteUrlText
        }
        self.applyRemoteTokenState(remoteToken)

        let targetMode = desiredMode ?? self.connectionMode
        if targetMode == .remote, remoteTransport != .direct {
            let hasConfiguredTarget = remote?.keys.contains("sshTarget") == true
            let configuredTarget = Self.sanitizeSSHTarget(remote?["sshTarget"] as? String ?? "")
            if hasConfiguredTarget, configuredTarget != Self.sanitizeSSHTarget(self.remoteTarget) {
                self.remoteTarget = configuredTarget
            } else if !hasConfiguredTarget,
                      let host = AppState.remoteHost(from: remoteUrl),
                      !LoopbackHost.isLoopbackHost(host)
            {
                self.updateRemoteTarget(host: host)
            }
        }
        if remote?.keys.contains("sshIdentity") == true {
            let configuredIdentity = (remote?["sshIdentity"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if configuredIdentity != self.remoteIdentity {
                self.remoteIdentity = configuredIdentity
            }
        }
        if self.gatewaySelectionSnapshot() != previousSelection {
            // Discovery ids describe one concrete endpoint. An external config
            // edit has no discovery selection event to update that ownership,
            // so retaining the old id would apply its activation lease to the
            // replacement Gateway.
            GatewayDiscoveryPreferences.setPreferredStableID(nil)
        }
    }

    private func gatewaySelectionSnapshot() -> GatewaySelectionSnapshot {
        let remoteUrl = GatewayRemoteConfig.normalizeGatewayUrlString(self.remoteUrl) ??
            self.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        return GatewaySelectionSnapshot(
            connectionMode: self.connectionMode,
            remoteTransport: self.remoteTransport,
            remoteUrl: remoteUrl,
            remoteTarget: Self.sanitizeSSHTarget(self.remoteTarget))
    }

    @discardableResult
    private func reconcilePreferredGatewayRouteBinding() -> Bool {
        let binding = GatewayDiscoveryPreferences.routeBinding(
            connectionMode: self.connectionMode,
            remoteTransport: self.remoteTransport,
            remoteURL: self.remoteUrl,
            remoteTarget: self.remoteTarget)
        return GatewayDiscoveryPreferences.clearPreferredStableIDIfRouteBindingMismatch(binding)
    }

    private func updateRemoteTarget(host: String) {
        let trimmed = self.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = CommandResolver.parseSSHTarget(trimmed) else { return }
        let trimmedUser = parsed.user?.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = (trimmedUser?.isEmpty ?? true) ? nil : trimmedUser
        let port = parsed.port
        let assembled: String = if let user {
            port == 22 ? "\(user)@\(host)" : "\(user)@\(host):\(port)"
        } else {
            port == 22 ? host : "\(host):\(port)"
        }
        if assembled != self.remoteTarget {
            self.remoteTarget = assembled
        }
    }

    private static func syncedGatewayRoot(
        currentRoot: [String: Any],
        draft: GatewayConfigSyncDraft) -> (root: [String: Any], changed: Bool)
    {
        var root = currentRoot
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        var changed = false

        let desiredMode: String? = switch draft.connectionMode {
        case .local:
            "local"
        case .remote:
            "remote"
        case .unconfigured:
            nil
        }

        let currentMode = (gateway["mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let desiredMode {
            if currentMode != desiredMode {
                gateway["mode"] = desiredMode
                changed = true
            }
        } else if currentMode != nil {
            gateway.removeValue(forKey: "mode")
            changed = true
        }

        if draft.connectionMode == .remote {
            let remoteHost = CommandResolver.parseSSHTarget(draft.remoteTarget)?.host
            let currentRemote = gateway["remote"] as? [String: Any] ?? [:]
            let updated = Self.updatedRemoteGatewayConfig(
                current: currentRemote,
                draft: .init(
                    transport: draft.remoteTransport,
                    remoteUrl: draft.remoteUrl,
                    remoteHost: remoteHost,
                    remoteTarget: draft.remoteTarget,
                    remoteIdentity: draft.remoteIdentity,
                    remoteToken: draft.remoteToken,
                    remoteTokenDirty: draft.remoteTokenDirty))
            if updated.changed {
                gateway["remote"] = updated.remote
                changed = true
            }
        }

        guard changed else { return (currentRoot, false) }

        if gateway.isEmpty {
            root.removeValue(forKey: "gateway")
        } else {
            root["gateway"] = gateway
        }
        return (root, true)
    }

    func triggerVoiceEars(ttl: TimeInterval? = 5) {
        self.earBoostTask?.cancel()
        self.earBoostActive = true

        guard let ttl else { return }

        self.earBoostTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ttl * 1_000_000_000))
            await MainActor.run { [weak self] in self?.earBoostActive = false }
        }
    }

    func stopVoiceEars() {
        self.earBoostTask?.cancel()
        self.earBoostTask = nil
        self.earBoostActive = false
    }

    func blinkOnce() {
        self.blinkTick &+= 1
    }

    func celebrateSend() {
        self.sendCelebrationTick &+= 1
    }

    func setVoiceWakeEnabled(_ enabled: Bool) async {
        guard voiceWakeSupported else {
            self.swabbleEnabled = false
            return
        }

        self.swabbleEnabled = enabled
        guard !self.isPreview else { return }

        if !enabled {
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        if PermissionManager.voiceWakePermissionsGranted() {
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        self.swabbleEnabled = granted
        Task { await VoiceWakeRuntime.shared.refresh(state: self) }
    }

    func setTalkEnabled(_ enabled: Bool) async {
        guard voiceWakeSupported else {
            self.talkEnabled = false
            await GatewayConnection.shared.talkMode(enabled: false, phase: "disabled")
            return
        }

        self.talkEnabled = enabled
        guard !self.isPreview else { return }

        if !enabled {
            await GatewayConnection.shared.talkMode(enabled: false, phase: "disabled")
            return
        }

        if PermissionManager.voiceWakePermissionsGranted() {
            await GatewayConnection.shared.talkMode(enabled: true, phase: "enabled")
            return
        }

        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        self.talkEnabled = granted
        await GatewayConnection.shared.talkMode(enabled: granted, phase: granted ? "enabled" : "denied")
    }

    // MARK: - Global wake words sync (Gateway-owned)

    func applyGlobalVoiceWakeTriggers(_ triggers: [String]) {
        self.suppressVoiceWakeGlobalSync = true
        self.swabbleTriggerWords = triggers
        self.suppressVoiceWakeGlobalSync = false
    }

    private func scheduleVoiceWakeGlobalSyncIfNeeded() {
        guard !self.suppressVoiceWakeGlobalSync else { return }
        let sanitized = sanitizeVoiceWakeTriggers(swabbleTriggerWords)
        self.voiceWakeGlobalSyncTask?.cancel()
        self.voiceWakeGlobalSyncTask = Task { [sanitized] in
            try? await Task.sleep(nanoseconds: 650_000_000)
            await GatewayConnection.shared.voiceWakeSetTriggers(sanitized)
        }
    }

    // MARK: - Chime persistence

    private static func loadChime(key: String, fallback: VoiceWakeChime) -> VoiceWakeChime {
        guard let data = UserDefaults.standard.data(forKey: key) else { return fallback }
        if let decoded = try? JSONDecoder().decode(VoiceWakeChime.self, from: data) {
            return decoded
        }
        return fallback
    }

    private func storeChime(_ chime: VoiceWakeChime, key: String) {
        guard let data = try? JSONEncoder().encode(chime) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

// MARK: - Exec approval settings

extension AppState {
    var execApprovalPolicyAvailable: Bool {
        self.execApprovalPolicyLoadState.isAvailable
    }

    var execApprovalLoadError: String? {
        self.execApprovalPolicyLoadState.errorMessage
    }

    func updateExecApprovalMode(_ mode: ExecApprovalQuickMode) {
        guard !self.isPreview else {
            self.syncExecApprovalMode(mode)
            return
        }
        let result = ExecApprovalsStore.updateDefaults { defaults in
            defaults.security = mode.security
            defaults.ask = mode.ask
        }
        self.applyExecApprovalModeMutation(mode, result: result)
    }

    func applyExecApprovalModeMutation(
        _ mode: ExecApprovalQuickMode,
        result: Result<Void, ExecApprovalsMutationError>)
    {
        switch result {
        case .success:
            self.syncExecApprovalMode(mode)
        case let .failure(error):
            self.execApprovalMutationError = error.message
        }
    }

    func syncExecApprovalMode(_ mode: ExecApprovalQuickMode) {
        self.execApprovalsReadGeneration += 1
        self.execApprovalsReadRetryTask?.cancel()
        self.execApprovalsReadRetryTask = nil
        self.execApprovalMode = mode
        self.execApprovalPolicyLoadState = .available
        self.execApprovalMutationError = nil
    }

    func retryExecApprovalModeRead() {
        self.scheduleExecApprovalModeReadRetry()
    }

    func waitForExecApprovalModeRead() async {
        await self.execApprovalsReadRetryTask?.value
    }

    func recoverExecApprovalModeRead(maxAttempts: Int) async {
        self.execApprovalsReadGeneration += 1
        let generation = self.execApprovalsReadGeneration
        self.execApprovalsReadRetryTask?.cancel()
        self.execApprovalsReadRetryTask = nil
        await self.performExecApprovalModeReadAttempts(
            maxAttempts: maxAttempts,
            generation: generation)
    }

    private func performExecApprovalModeReadAttempts(maxAttempts: Int, generation: Int) async {
        guard self.execApprovalsReadGeneration == generation else { return }
        guard maxAttempts > 0 else {
            self.execApprovalPolicyLoadState = .unavailable(Self.execApprovalsReadUnavailableMessage)
            return
        }
        self.execApprovalPolicyLoadState = .loading
        for attempt in 0..<maxAttempts {
            if attempt > 0 {
                do {
                    try await Task.sleep(for: self.execApprovalsReadRetryDelay)
                } catch {
                    return
                }
            }
            guard self.execApprovalsReadGeneration == generation else { return }
            let result = await execApprovalsDefaultsAsyncResolver()
            guard self.execApprovalsReadGeneration == generation else { return }
            switch result {
            case let .success(defaults):
                self.syncExecApprovalMode(
                    ExecApprovalQuickMode.from(security: defaults.security, ask: defaults.ask))
                return
            case .failure:
                continue
            }
        }
        guard self.execApprovalsReadGeneration == generation else { return }
        self.execApprovalPolicyLoadState = .unavailable(Self.execApprovalsReadUnavailableMessage)
    }

    private func scheduleExecApprovalModeReadRetry() {
        self.execApprovalsReadGeneration += 1
        let generation = self.execApprovalsReadGeneration
        self.execApprovalsReadRetryTask?.cancel()
        self.execApprovalPolicyLoadState = .loading
        self.execApprovalsReadRetryTask = Task { [weak self] in
            await self?.performExecApprovalModeReadAttempts(
                maxAttempts: Self.execApprovalsReadRetryAttempts,
                generation: generation)
        }
    }
}

extension AppState {
    private func syncGatewayConfigIfNeeded() {
        self.advanceGatewayRoutingGeneration()
        guard self.gatewayConfigSyncIsEnabled, !self.isInitializing else { return }
        self.setGatewayConfigSyncState(.pending)

        self.gatewayConfigSyncTask?.cancel()
        self.gatewayConfigSyncTask = Task { @MainActor in
            guard !Task.isCancelled else { return }
            self.syncGatewayConfigNow()
        }
    }

    private var gatewayConfigSyncIsEnabled: Bool {
        #if DEBUG
        if self.gatewayConfigSyncEnabledForTesting {
            return true
        }
        #endif
        return !self.isPreview
    }

    var gatewayConfigIsCurrentForRouting: Bool {
        self.gatewayConfigSyncState == .current
    }

    private func setGatewayConfigSyncState(_ state: GatewayConfigSyncState) {
        guard self.gatewayConfigSyncState != state else { return }
        self.gatewayConfigSyncState = state
        self.advanceGatewayRoutingGeneration()
        guard !self.isPreview, state != .pending else { return }
        // Failed persistence must retire the old endpoint; recovery must publish
        // the newly canonical route. Requests also re-check this state directly.
        Task { await GatewayEndpointStore.shared.refresh() }
    }

    private func advanceGatewayRoutingGeneration() {
        self.gatewayRoutingGeneration &+= 1
    }

    private static func gatewayDraftCanPersist(_ draft: GatewayConfigSyncDraft) -> Bool {
        guard draft.connectionMode == .remote else { return true }
        switch draft.remoteTransport {
        case .direct:
            return GatewayRemoteConfig.normalizeGatewayUrl(draft.remoteUrl) != nil
        case .ssh:
            let target = Self.sanitizeSSHTarget(draft.remoteTarget)
            return !target.isEmpty &&
                CommandResolver.sshTargetValidationMessage(target) == nil &&
                CommandResolver.parseSSHTarget(target) != nil
        }
    }

    @discardableResult
    func syncGatewayConfigNow() -> Bool {
        guard self.gatewayConfigSyncIsEnabled, !self.isInitializing else { return true }
        self.setGatewayConfigSyncState(.pending)

        let draft = GatewayConfigSyncDraft(
            connectionMode: connectionMode,
            remoteTransport: remoteTransport,
            remoteTarget: remoteTarget,
            remoteIdentity: remoteIdentity,
            remoteUrl: remoteUrl,
            remoteToken: remoteToken,
            remoteTokenDirty: remoteTokenDirty)
        guard Self.gatewayDraftCanPersist(draft) else {
            self.setGatewayConfigSyncState(.failed)
            return false
        }

        // Keep app-only connection settings local to avoid overwriting remote gateway config.
        let synced = Self.syncedGatewayRoot(
            currentRoot: OpenClawConfigFile.loadDict(),
            draft: draft)
        guard synced.changed else {
            self.setGatewayConfigSyncState(.current)
            return true
        }
        guard OpenClawConfigFile.saveDict(synced.root) else {
            self.setGatewayConfigSyncState(.failed)
            Self.logger.warning("gateway config sync rejected to protect persisted gateway auth/mode")
            return false
        }
        self.lastConfigFingerprint = Self.configFingerprint(synced.root)
        self.setGatewayConfigSyncState(.current)
        NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
        return true
    }
}

extension AppState {
    static var preview: AppState {
        let state = AppState(preview: true)
        state.isPaused = false
        state.launchAtLogin = true
        state.onboardingSeen = true
        state.debugPaneEnabled = true
        state.swabbleEnabled = true
        state.swabbleTriggerWords = ["Claude", "Computer", "Jarvis"]
        state.voiceWakeTriggerChime = .system(name: "Glass")
        state.voiceWakeSendChime = .system(name: "Ping")
        state.iconAnimationsEnabled = true
        state.showDockIcon = true
        state.voiceWakeMicID = "BuiltInMic"
        state.voiceWakeMicName = "Built-in Microphone"
        state.voiceWakeLocaleID = Locale.current.identifier
        state.voiceWakeAdditionalLocaleIDs = ["en-US", "de-DE"]
        state.voicePushToTalkEnabled = false
        state.talkEnabled = false
        state.talkPhaseSoundsEnabled = true
        state.talkShiftToStopEnabled = true
        state.iconOverride = .system
        state.heartbeatsEnabled = true
        state.connectionMode = .local
        state.remoteTransport = .ssh
        state.canvasEnabled = true
        state.remoteTarget = "user@example.com"
        state.remoteUrl = "wss://gateway.example.ts.net"
        state.remoteToken = "example-token"
        state.remoteIdentity = "~/.ssh/id_ed25519"
        state.remoteProjectRoot = "~/Projects/openclaw"
        state.remoteCliPath = ""
        return state
    }
}

extension AppState {
    enum ConnectionMode: String {
        case unconfigured
        case local
        case remote
    }

    enum RemoteTransport: String {
        case ssh
        case direct
    }

    struct RemoteGatewayConfigDraft {
        var transport: RemoteTransport
        var remoteUrl: String
        var remoteHost: String?
        var remoteTarget: String
        var remoteIdentity: String
        var remoteToken: String
        var remoteTokenDirty: Bool
    }

    struct GatewayConfigSyncDraft {
        var connectionMode: ConnectionMode
        var remoteTransport: RemoteTransport
        var remoteTarget: String
        var remoteIdentity: String
        var remoteUrl: String
        var remoteToken: String
        var remoteTokenDirty: Bool
    }

    private struct GatewaySelectionSnapshot: Equatable {
        let connectionMode: ConnectionMode
        let remoteTransport: RemoteTransport
        let remoteUrl: String
        let remoteTarget: String
    }
}

#if DEBUG
@MainActor
extension AppState {
    static func _testConfigFingerprint(_ root: [String: Any]) -> Data? {
        self.configFingerprint(root)
    }

    static func _testUpdatedRemoteGatewayConfig(
        current: [String: Any],
        draft: RemoteGatewayConfigDraft) -> [String: Any]
    {
        self.updatedRemoteGatewayConfig(
            current: current,
            draft: draft).remote
    }

    static func _testSyncedGatewayRoot(
        currentRoot: [String: Any],
        draft: GatewayConfigSyncDraft) -> [String: Any]
    {
        self.syncedGatewayRoot(
            currentRoot: currentRoot,
            draft: draft).root
    }

    static func _testGatewayDraftCanPersist(_ draft: GatewayConfigSyncDraft) -> Bool {
        self.gatewayDraftCanPersist(draft)
    }

    func _testApplyConfigOverrides(_ root: [String: Any]) {
        self.applyConfigOverrides(root)
    }

    func _testEnableGatewayConfigSync() {
        self.gatewayConfigSyncEnabledForTesting = true
    }

    func _testAwaitGatewayConfigSync() async {
        await self.gatewayConfigSyncTask?.value
    }

    var _testGatewayConfigIsCurrentForRouting: Bool {
        self.gatewayConfigIsCurrentForRouting
    }

    @discardableResult
    func _testReconcilePreferredGatewayRouteBinding() -> Bool {
        self.reconcilePreferredGatewayRouteBinding()
    }
}
#endif

@MainActor
enum AppStateStore {
    static let shared = AppState()

    static func updateLaunchAtLogin(enabled: Bool) {
        Task.detached(priority: .utility) {
            await LaunchAgentManager.set(enabled: enabled, bundlePath: Bundle.main.bundlePath)
        }
    }
}

@MainActor
enum AppActivationPolicy {
    static func apply(showDockIcon: Bool) {
        _ = showDockIcon
        DockIconManager.shared.updateDockVisibility()
    }
}
