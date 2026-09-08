import AppKit
import CoreLocation
import Foundation
import Observation
import OpenClawKit
import ServiceManagement
import SwiftUI

@MainActor
final class VoiceWakeGlobalSyncScheduler {
    private let delay: @Sendable () async throws -> Void
    private let deliver: @Sendable ([String]) async -> Void
    private var debounceTask: Task<Void, Never>?
    private var deliveryTail: Task<Void, Never>?
    private var generation: UInt64 = 0

    init(
        delay: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .milliseconds(650))
        },
        deliver: @escaping @Sendable ([String]) async -> Void = { triggers in
            await GatewayConnection.shared.voiceWakeSetTriggers(triggers)
        })
    {
        self.delay = delay
        self.deliver = deliver
    }

    @discardableResult
    func schedule(_ triggers: [String]) -> Task<Void, Never> {
        self.generation &+= 1
        let generation = self.generation
        self.debounceTask?.cancel()
        let delay = self.delay
        let task = Task { [weak self] in
            do {
                try await delay()
            } catch {
                return
            }
            guard !Task.isCancelled, let self, self.generation == generation else { return }
            self.enqueueDelivery(triggers, generation: generation)
        }
        self.debounceTask = task
        return task
    }

    private func enqueueDelivery(_ triggers: [String], generation: UInt64) {
        let previousDelivery = self.deliveryTail
        let deliver = self.deliver
        self.deliveryTail = Task { [weak self, previousDelivery] in
            await previousDelivery?.value
            guard let self, self.generation == generation else { return }
            await deliver(triggers)
        }
    }
}

@MainActor
@Observable
final class AppState {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app-state")

    let isPreview: Bool
    @ObservationIgnored private let gatewayConfigSaver: ([String: Any]) -> Bool
    @ObservationIgnored let bundleLocationAllowsPersistentIntegration: Bool
    @ObservationIgnored private var isHydratingLaunchAtLogin = false
    private var isInitializing = true
    private var isApplyingGatewayConfig = false
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
    private var lastObservedGatewayConfig: GatewayConfigSnapshot = .empty
    private var dirtyGatewayConfigFields: Set<GatewayConfigField> = []
    private var conflictedGatewayConfigFields: Set<GatewayConfigField> = []
    private var suppressVoiceWakeGlobalSync = false
    @ObservationIgnored private var voiceWakeEnableGeneration: UInt64 = 0
    @ObservationIgnored private var locationModeGeneration: UInt64 = 0
    @ObservationIgnored private let voiceWakeGlobalSyncScheduler = VoiceWakeGlobalSyncScheduler()
    @ObservationIgnored private var activeComputerPresenceTask: Task<Void, Never>?
    @ObservationIgnored private var activeComputerPresenceUpdateGeneration: UInt64 = 0
    @ObservationIgnored private var computerControlHostReconciliationTask: Task<Void, Never>?
    @ObservationIgnored private var computerControlHostGeneration: UInt64 = 0

    var isPaused: Bool {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) } }
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

    var onboardingSeen: Bool {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.onboardingSeen, forKey: onboardingSeenKey) }
        }
    }

    var debugPaneEnabled: Bool {
        didSet {
            self.ifNotPreview { AppDefaults.standard.set(self.debugPaneEnabled, forKey: debugPaneEnabledKey) }
            CanvasManager.shared.refreshDebugStatus()
        }
    }

    var swabbleEnabled: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.swabbleEnabled, forKey: swabbleEnabledKey)
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    var swabbleTriggerWords: [String] {
        didSet {
            // Preserve the raw editing state; sanitization happens when we actually use the triggers.
            self.ifNotPreview {
                AppDefaults.standard.set(self.swabbleTriggerWords, forKey: swabbleTriggersKey)
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
        didSet { self.ifNotPreview { AppDefaults.standard.set(
            self.iconAnimationsEnabled,
            forKey: iconAnimationsEnabledKey) } }
    }

    var showDockIcon: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.showDockIcon, forKey: showDockIconKey)
                AppActivationPolicy.apply(showDockIcon: self.showDockIcon)
            }
        }
    }

    var voiceWakeMicID: String {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.voiceWakeMicID, forKey: voiceWakeMicKey)
                if self.swabbleEnabled, !self.talkEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
                if self.talkEnabled {
                    Task { await TalkModeRuntime.shared.inputDeviceSelectionDidChange() }
                }
            }
        }
    }

    var voiceWakeMicName: String {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.voiceWakeMicName, forKey: voiceWakeMicNameKey) } }
    }

    var voiceWakeLocaleID: String {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.voiceWakeLocaleID, forKey: voiceWakeLocaleKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    var voiceWakeAdditionalLocaleIDs: [String] {
        didSet { self.ifNotPreview { AppDefaults.standard.set(
            self.voiceWakeAdditionalLocaleIDs,
            forKey: voiceWakeAdditionalLocalesKey) } }
    }

    var voicePushToTalkEnabled: Bool {
        didSet { self.ifNotPreview { AppDefaults.standard.set(
            self.voicePushToTalkEnabled,
            forKey: voicePushToTalkEnabledKey) } }
    }

    var voiceWakeTriggersTalkMode: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.voiceWakeTriggersTalkMode, forKey: voiceWakeTriggersTalkModeKey)
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
                AppDefaults.standard.set(self.talkEnabled, forKey: talkEnabledKey)
                Task { await TalkModeController.shared.setEnabled(self.talkEnabled) }
            }
        }
    }

    var talkRealtimeRelayEnabled = isTalkRealtimeRelayEnabled() {
        didSet { self.persistTalkRealtimeRelayPreference(previousValue: oldValue) }
    }

    var talkPhaseSoundsEnabled: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.talkPhaseSoundsEnabled, forKey: talkPhaseSoundsEnabledKey)
            }
        }
    }

    var talkShiftToStopEnabled: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.talkShiftToStopEnabled, forKey: talkShiftToStopEnabledKey)
                Task { TalkSpeechInterruptMonitor.shared.setEnabled(self.talkShiftToStopEnabled && self.talkEnabled) }
            }
        }
    }

    /// Gateway-provided UI accent color (hex). Optional; clients provide a default.
    var seamColorHex: String?

    /// Caller's per-profile accent (users.prefs.get). Kept separate from
    /// seamColorHex so Gateway config refreshes cannot clobber it.
    var profileAccentHex: String?

    /// Accent the UI renders: the profile accent wins over the gateway seam color.
    var effectiveAccentHex: String? {
        self.profileAccentHex ?? self.seamColorHex
    }

    var iconOverride: IconOverrideSelection {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.iconOverride.rawValue, forKey: iconOverrideKey) } }
    }

    var isWorking: Bool = false
    var earBoostActive: Bool = false
    var blinkTick: Int = 0
    var sendCelebrationTick: Int = 0
    var heartbeatsEnabled: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.heartbeatsEnabled, forKey: heartbeatsEnabledKey)
                Task { _ = await GatewayConnection.shared.setHeartbeatsEnabled(self.heartbeatsEnabled) }
            }
        }
    }

    var connectionMode: ConnectionMode {
        didSet {
            self.ifNotPreview { AppDefaults.standard.set(self.connectionMode.rawValue, forKey: connectionModeKey) }
            if oldValue != self.connectionMode {
                self.markGatewayConfigDirty([.mode])
            }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteTransport: RemoteTransport {
        didSet {
            if oldValue != self.remoteTransport {
                let fields: Set<GatewayConfigField> = switch self.remoteTransport {
                case .direct:
                    [.remoteTransport, .remoteUrl]
                case .ssh:
                    [.remoteTransport, .remoteUrl, .remoteTarget, .remoteIdentity, .remoteHostKeyPolicy]
                }
                self.markGatewayConfigDirty(fields)
            }
            syncGatewayConfigIfNeeded()
        }
    }

    var canvasEnabled: Bool {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.canvasEnabled, forKey: canvasEnabledKey) } }
    }

    var quickChatEnabled: Bool {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.quickChatEnabled, forKey: quickChatEnabledKey) } }
    }

    var cookieSyncEnabled: Bool {
        didSet {
            self.ifNotPreview { AppDefaults.standard.set(self.cookieSyncEnabled, forKey: cookieSyncEnabledKey) }
        }
    }

    var cookieSyncIntoProfile: String {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.cookieSyncIntoProfile, forKey: cookieSyncIntoProfileKey)
            }
        }
    }

    var cookieSyncDomains: [String] {
        didSet {
            self.ifNotPreview { AppDefaults.standard.set(self.cookieSyncDomains, forKey: cookieSyncDomainsKey) }
        }
    }

    var activeComputerPresenceEnabled: Bool {
        didSet { self.scheduleActiveComputerPresenceUpdate() }
    }

    /// Tracks whether the Canvas panel is currently visible (not persisted).
    var canvasPanelVisible: Bool = false

    var peekabooBridgeEnabled: Bool {
        didSet {
            self.ifNotPreview {
                AppDefaults.standard.set(self.peekabooBridgeEnabled, forKey: peekabooBridgeEnabledKey)
            }
            self.applyComputerControlHostState()
        }
    }

    /// The selected provider owns the complete Computer Control execution surface.
    /// Keep the unselected host stopped so one node execution never mixes backends.
    func applyComputerControlHostState() {
        self.ifNotPreview {
            let computerControlEnabled = isComputerControlEnabled()
            let provider = ComputerControlProvider.current()
            let launchPlan = AppLaunchRuntimePlan.current
            let peekabooBridgeEnabled = self.peekabooBridgeEnabled
            self.computerControlHostGeneration &+= 1
            let generation = self.computerControlHostGeneration
            let predecessor = self.computerControlHostReconciliationTask
            let task = Task { @MainActor [weak self] in
                await predecessor?.value
                guard let self, generation == self.computerControlHostGeneration else { return }
                switch provider {
                case .cua where computerControlEnabled:
                    await PeekabooBridgeHostCoordinator.shared.setEnabled(false)
                    guard generation == self.computerControlHostGeneration else { return }
                    await CuaDriverHostCoordinator.shared.setEnabled(true)
                case .peekaboo:
                    if launchPlan.allowsCuaComputerControl {
                        await CuaDriverHostCoordinator.shared.setEnabled(false)
                    }
                    guard generation == self.computerControlHostGeneration else { return }
                    await PeekabooBridgeHostCoordinator.shared.setEnabled(
                        peekabooBridgeEnabled && computerControlEnabled)
                case .cua:
                    await CuaDriverHostCoordinator.shared.setEnabled(false)
                    guard generation == self.computerControlHostGeneration else { return }
                    await PeekabooBridgeHostCoordinator.shared.setEnabled(false)
                }
            }
            self.computerControlHostReconciliationTask = task
        }
    }

    var remoteTarget: String {
        didSet {
            self.ifNotPreview { AppDefaults.standard.set(self.remoteTarget, forKey: remoteTargetKey) }
            if oldValue != self.remoteTarget {
                self.markGatewayConfigDirty([.remoteTarget, .remoteUrl, .remoteHostKeyPolicy])
            }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteUrl: String {
        didSet {
            if oldValue != self.remoteUrl {
                self.markGatewayConfigDirty([.remoteUrl])
            }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteToken: String {
        didSet {
            guard oldValue != self.remoteToken else { return }
            self.markGatewayConfigDirty([.remoteToken])
            self.remoteTokenUnsupported = false
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteTokenDirty: Bool {
        self.dirtyGatewayConfigFields.contains(.remoteToken)
    }

    var gatewayConfigConflict: GatewayConfigConflict? {
        let fields = GatewayConfigField.allCases.filter(self.conflictedGatewayConfigFields.contains)
        guard !fields.isEmpty else { return nil }
        let fieldNames = fields.map(\.displayName)
        let fieldList = ListFormatter.localizedString(byJoining: fieldNames)
        let message = String(format: String(localized: """
        These settings changed outside the app while you were editing: %@. \
        Choose which version to keep.
        """), fieldList)
        return GatewayConfigConflict(
            fields: fields,
            fieldNames: fieldNames,
            message: message)
    }

    private(set) var remoteTokenUnsupported = false

    var remoteIdentity: String {
        didSet {
            self.ifNotPreview { AppDefaults.standard.set(self.remoteIdentity, forKey: remoteIdentityKey) }
            if oldValue != self.remoteIdentity {
                self.markGatewayConfigDirty([.remoteIdentity])
            }
            syncGatewayConfigIfNeeded()
        }
    }

    var remoteProjectRoot: String {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.remoteProjectRoot, forKey: remoteProjectRootKey) } }
    }

    var remoteCliPath: String {
        didSet { self.ifNotPreview { AppDefaults.standard.set(self.remoteCliPath, forKey: remoteCliPathKey) } }
    }

    init(
        preview: Bool = false,
        gatewayConfigSaver: @escaping ([String: Any]) -> Bool = { OpenClawConfigFile.saveDict($0) })
    {
        let isPreview = preview || ProcessInfo.processInfo.isRunningTests
        self.isPreview = isPreview
        self.bundleLocationAllowsPersistentIntegration =
            !AppProfile.current.isActive &&
            (isPreview || ApplicationRelocator.currentBundleAllowsPersistentIntegration())
        self.gatewayConfigSaver = gatewayConfigSaver
        let onboardingSeen = AppDefaults.standard.bool(forKey: onboardingSeenKey)
        self.isPaused = AppLaunchRuntimePlan.current.resolvePaused(AppDefaults.standard.bool(forKey: pauseDefaultsKey))
        self.launchAtLogin = false
        self.onboardingSeen = onboardingSeen
        self.debugPaneEnabled = AppDefaults.standard.bool(forKey: debugPaneEnabledKey)
        let savedVoiceWake = AppDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleEnabled = voiceWakeSupported ? savedVoiceWake : false
        self.swabbleTriggerWords = AppDefaults.standard
            .stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
        self.voiceWakeTriggerChime = Self.loadChime(
            key: voiceWakeTriggerChimeKey,
            fallback: .system(name: "Glass"))
        self.voiceWakeSendChime = Self.loadChime(
            key: voiceWakeSendChimeKey,
            fallback: .system(name: "Glass"))
        if let storedIconAnimations = AppDefaults.standard.object(forKey: iconAnimationsEnabledKey) as? Bool {
            self.iconAnimationsEnabled = storedIconAnimations
        } else {
            self.iconAnimationsEnabled = true
            AppDefaults.standard.set(true, forKey: iconAnimationsEnabledKey)
        }
        if let storedShowDockIcon = AppDefaults.standard.object(forKey: showDockIconKey) as? Bool {
            self.showDockIcon = storedShowDockIcon
        } else {
            self.showDockIcon = true
            AppDefaults.standard.set(true, forKey: showDockIconKey)
        }
        self.voiceWakeMicID = AppDefaults.standard.string(forKey: voiceWakeMicKey) ?? ""
        self.voiceWakeMicName = AppDefaults.standard.string(forKey: voiceWakeMicNameKey) ?? ""
        self.voiceWakeLocaleID = AppDefaults.standard.string(forKey: voiceWakeLocaleKey) ?? Locale.current.identifier
        self.voiceWakeAdditionalLocaleIDs = AppDefaults.standard
            .stringArray(forKey: voiceWakeAdditionalLocalesKey) ?? []
        self.voicePushToTalkEnabled = AppDefaults.standard
            .object(forKey: voicePushToTalkEnabledKey) as? Bool ?? false
        self.voiceWakeTriggersTalkMode = AppDefaults.standard
            .object(forKey: voiceWakeTriggersTalkModeKey) as? Bool ?? false
        self.talkEnabled = AppDefaults.standard.bool(forKey: talkEnabledKey)
        if let storedPhaseSounds = AppDefaults.standard.object(forKey: talkPhaseSoundsEnabledKey) as? Bool {
            self.talkPhaseSoundsEnabled = storedPhaseSounds
        } else {
            self.talkPhaseSoundsEnabled = true
            AppDefaults.standard.set(true, forKey: talkPhaseSoundsEnabledKey)
        }
        if let storedShiftToStop = AppDefaults.standard.object(forKey: talkShiftToStopEnabledKey) as? Bool {
            self.talkShiftToStopEnabled = storedShiftToStop
        } else {
            self.talkShiftToStopEnabled = true
            AppDefaults.standard.set(true, forKey: talkShiftToStopEnabledKey)
        }
        self.seamColorHex = nil
        self.profileAccentHex = nil
        if let storedHeartbeats = AppDefaults.standard.object(forKey: heartbeatsEnabledKey) as? Bool {
            self.heartbeatsEnabled = storedHeartbeats
        } else {
            self.heartbeatsEnabled = true
            AppDefaults.standard.set(true, forKey: heartbeatsEnabledKey)
        }
        if let storedOverride = AppDefaults.standard.string(forKey: iconOverrideKey),
           let selection = IconOverrideSelection(rawValue: storedOverride)
        {
            self.iconOverride = selection
        } else {
            self.iconOverride = .system
            AppDefaults.standard.set(IconOverrideSelection.system.rawValue, forKey: iconOverrideKey)
        }

        let configRoot = OpenClawConfigFile.loadDict()
        self.lastConfigFingerprint = Self.configFingerprint(configRoot)
        self.lastObservedGatewayConfig = Self.gatewayConfigSnapshot(configRoot)
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
        let storedRemoteTarget = AppDefaults.standard.string(forKey: remoteTargetKey) ?? ""
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
        self.remoteTokenUnsupported = configRemoteToken.isUnsupportedNonString
        let hasConfigRemoteIdentity = configRemote?.keys.contains("sshIdentity") == true
        let configRemoteIdentity = (configRemote?["sshIdentity"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.remoteIdentity = hasConfigRemoteIdentity
            ? configRemoteIdentity
            : AppDefaults.standard.string(forKey: remoteIdentityKey)?.nonEmpty ?? ""
        self.remoteProjectRoot = AppDefaults.standard.string(forKey: remoteProjectRootKey)?.nonEmpty ?? ""
        self.remoteCliPath = AppDefaults.standard.string(forKey: remoteCliPathKey)?.nonEmpty ?? ""
        self.canvasEnabled = AppDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
        self.quickChatEnabled = AppDefaults.standard.object(forKey: quickChatEnabledKey) as? Bool ?? true
        (self.cookieSyncEnabled, self.cookieSyncIntoProfile, self.cookieSyncDomains) = Self.loadCookieSyncDefaults()
        self.activeComputerPresenceEnabled = Self.resolveActiveComputerPresenceEnabled()
        self.peekabooBridgeEnabled = AppLaunchRuntimePlan.current.resolvePeekabooBridgeEnabled(
            AppDefaults.standard.object(forKey: peekabooBridgeEnabledKey) as? Bool ?? true)
        if !self.isPreview, !AppProfile.current.isActive {
            Task.detached(priority: .utility) { [weak self] in
                let current = await LaunchAgentManager.status()
                await MainActor.run { [weak self] in self?.hydrateLaunchAtLogin(current) }
            }
        } else if !self.isPreview, AppProfile.current.isActive {
            Self.logger.info("login-agent status skipped (unavailable under app profile)")
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
}

extension AppState {
    private func markGatewayConfigDirty(_ fields: Set<GatewayConfigField>) {
        guard !self.isInitializing, !self.isApplyingGatewayConfig else { return }
        self.dirtyGatewayConfigFields.formUnion(fields)
    }

    private func applyRemoteTokenState(_ tokenValue: GatewayRemoteConfig.TokenValue) {
        let nextToken = tokenValue.textFieldValue
        let unsupported = tokenValue.isUnsupportedNonString
        if self.remoteToken != nextToken {
            self.remoteToken = nextToken
        }
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
            if draft.dirtyFields.contains(.remoteTransport) {
                changed = Self.updateGatewayString(
                    &remote,
                    key: "transport",
                    value: RemoteTransport.direct.rawValue) || changed
            }

            if draft.dirtyFields.contains(.remoteUrl) {
                // Reconciliation needs the incomplete draft too, or it mistakes the
                // unchanged disk URL for a saved edit. gatewayDraftCanPersist gates writes.
                let url = GatewayRemoteConfig.normalizeGatewayUrlString(draft.remoteUrl) ?? draft.remoteUrl
                changed = Self.updateGatewayString(&remote, key: "url", value: url) || changed
            }

        case .ssh:
            if draft.dirtyFields.contains(.remoteTransport) {
                changed = Self.updateGatewayString(
                    &remote,
                    key: "transport",
                    value: RemoteTransport.ssh.rawValue) || changed
            }

            let existingTarget = Self.sanitizeSSHTarget(remote["sshTarget"] as? String ?? "")
            let sanitizedTarget = Self.sanitizeSSHTarget(draft.remoteTarget)
            let expectedRemoteHost = CommandResolver.parseSSHTarget(sanitizedTarget)?.host ?? draft.remoteHost
            if draft.dirtyFields.contains(.remoteUrl) {
                let existingUrl = (remote["url"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let desiredUrl = Self.sshTunnelGatewayUrl(
                    existingUrl: existingUrl,
                    expectedRemoteHost: expectedRemoteHost)
                changed = Self.updateGatewayString(&remote, key: "url", value: desiredUrl) || changed
            }
            if draft.dirtyFields.contains(.remoteTarget) {
                changed = Self.updateGatewayString(&remote, key: "sshTarget", value: sanitizedTarget) || changed
            }
            if draft.dirtyFields.contains(.remoteIdentity) {
                changed = Self.updateGatewayString(
                    &remote,
                    key: "sshIdentity",
                    value: draft.remoteIdentity) || changed
            }
            if draft.dirtyFields.contains(.remoteHostKeyPolicy), existingTarget != sanitizedTarget {
                changed = Self.updateGatewayString(
                    &remote,
                    key: "sshHostKeyPolicy",
                    value: "strict") || changed
            }
        }

        if draft.dirtyFields.contains(.remoteToken) {
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

    private static func gatewayConfigSnapshot(_ root: [String: Any]) -> GatewayConfigSnapshot {
        let gateway = root["gateway"] as? [String: Any]
        let remote = gateway?["remote"] as? [String: Any]
        var values: [GatewayConfigField: GatewayConfigValue] = [:]
        for field in GatewayConfigField.allCases {
            let value = if let remoteKey = field.remoteKey {
                remote?[remoteKey]
            } else {
                gateway?["mode"]
            }
            guard let value else {
                values[field] = .missing
                continue
            }
            let data = try? JSONSerialization.data(
                withJSONObject: ["value": value],
                options: [.sortedKeys])
            values[field] = data.map(GatewayConfigValue.json) ?? .missing
        }
        return GatewayConfigSnapshot(values: values)
    }

    private func gatewayConfigDraft() -> GatewayConfigSyncDraft {
        GatewayConfigSyncDraft(
            connectionMode: self.connectionMode,
            remoteTransport: self.remoteTransport,
            remoteTarget: self.remoteTarget,
            remoteIdentity: self.remoteIdentity,
            remoteUrl: self.remoteUrl,
            remoteToken: self.remoteToken,
            dirtyFields: self.dirtyGatewayConfigFields)
    }

    private static func gatewayConfigFieldsPersisted(by draft: GatewayConfigSyncDraft) -> Set<GatewayConfigField> {
        var fields = draft.dirtyFields.intersection([.mode, .remoteTransport, .remoteUrl, .remoteToken])
        if draft.remoteTransport == .ssh {
            fields.formUnion(draft.dirtyFields.intersection([
                .remoteTarget,
                .remoteIdentity,
                .remoteHostKeyPolicy,
            ]))
        }
        return fields
    }

    private func reconcileGatewayConfigOwnership(_ root: [String: Any]) -> Set<GatewayConfigField> {
        let diskSnapshot = Self.gatewayConfigSnapshot(root)
        let desiredRoot = Self.syncedGatewayRoot(
            currentRoot: root,
            draft: self.gatewayConfigDraft()).root
        let desiredSnapshot = Self.gatewayConfigSnapshot(desiredRoot)
        let priorConflicts = self.conflictedGatewayConfigFields

        // Dirty fields retain the user's pending UI value. A disk value that moved
        // from the last observed baseline is a conflict, never write authorization.
        let persistedFields = Self.gatewayConfigFieldsPersisted(by: self.gatewayConfigDraft())
        var externallyPersistedFields: Set<GatewayConfigField> = []
        for field in persistedFields {
            if diskSnapshot[field] == desiredSnapshot[field] {
                externallyPersistedFields.insert(field)
            } else if diskSnapshot[field] != self.lastObservedGatewayConfig[field] {
                self.conflictedGatewayConfigFields.insert(field)
            }
        }
        self.dirtyGatewayConfigFields.subtract(externallyPersistedFields)
        self.conflictedGatewayConfigFields.subtract(externallyPersistedFields)
        self.conflictedGatewayConfigFields.formIntersection(self.dirtyGatewayConfigFields)
        self.lastObservedGatewayConfig = diskSnapshot
        return priorConflicts
    }

    private func applyGatewayConfigView(
        _ root: [String: Any],
        forcing forcedFields: Set<GatewayConfigField> = [])
    {
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

        self.isApplyingGatewayConfig = true
        self.applyGatewayConfigMode(
            desiredMode,
            hasRemoteUrl: hasRemoteUrl,
            forcing: forcedFields.contains(.mode))

        let shouldApplyTransport = forcedFields.contains(.remoteTransport) ||
            !self.dirtyGatewayConfigFields.contains(.remoteTransport)
        if shouldApplyTransport, remoteTransport != self.remoteTransport {
            self.remoteTransport = remoteTransport
        }
        if forcedFields.contains(.remoteUrl) || !self.dirtyGatewayConfigFields.contains(.remoteUrl) {
            let remoteUrlText = remoteResolution.directURL?.absoluteString ?? remoteUrl ?? ""
            if remoteUrlText != self.remoteUrl {
                self.remoteUrl = remoteUrlText
            }
        }
        if forcedFields.contains(.remoteToken) || !self.dirtyGatewayConfigFields.contains(.remoteToken) {
            self.applyRemoteTokenState(remoteToken)
        }

        let targetMode = desiredMode ?? self.connectionMode
        if forcedFields.contains(.remoteTarget) {
            let configuredTarget = Self.sanitizeSSHTarget(remote?["sshTarget"] as? String ?? "")
            if configuredTarget != Self.sanitizeSSHTarget(self.remoteTarget) {
                self.remoteTarget = configuredTarget
            }
        } else if !self.dirtyGatewayConfigFields.contains(.remoteTarget),
                  targetMode == .remote,
                  remoteTransport != .direct
        {
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
        if forcedFields.contains(.remoteIdentity) {
            let configuredIdentity = (remote?["sshIdentity"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if configuredIdentity != self.remoteIdentity {
                self.remoteIdentity = configuredIdentity
            }
        } else if !self.dirtyGatewayConfigFields.contains(.remoteIdentity),
                  remote?.keys.contains("sshIdentity") == true
        {
            let configuredIdentity = (remote?["sshIdentity"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if configuredIdentity != self.remoteIdentity {
                self.remoteIdentity = configuredIdentity
            }
        }
        self.isApplyingGatewayConfig = false
    }

    private func applyGatewayConfigMode(
        _ desiredMode: ConnectionMode?,
        hasRemoteUrl: Bool,
        forcing: Bool)
    {
        guard forcing || !self.dirtyGatewayConfigFields.contains(.mode) else { return }
        let nextMode = desiredMode ?? (hasRemoteUrl ? .remote : forcing ? .unconfigured : nil)
        if let nextMode, nextMode != self.connectionMode {
            self.connectionMode = nextMode
        }
    }

    private func applyConfigOverrides(_ root: [String: Any]) {
        advanceGatewayRoutingGeneration()
        let previousSelection = self.gatewaySelectionSnapshot()
        let priorConflicts = self.reconcileGatewayConfigOwnership(root)
        self.applyGatewayConfigView(root)

        if self.gatewaySelectionSnapshot() != previousSelection {
            // Discovery ids describe one concrete endpoint. An external config
            // edit has no discovery selection event to update that ownership,
            // so retaining the old id would apply its activation lease to the
            // replacement Gateway.
            GatewayDiscoveryPreferences.setPreferredStableID(nil)
        }

        let newConflicts = self.conflictedGatewayConfigFields.subtracting(priorConflicts)
        if !newConflicts.isEmpty {
            let names = self.conflictedGatewayConfigFields.map(\.rawValue).sorted().joined(separator: ", ")
            Self.logger.warning("gateway config sync conflict fields=\(names)")
        }
        if !self.conflictedGatewayConfigFields.isEmpty {
            self.setGatewayConfigSyncState(.failed)
        } else if !priorConflicts.isEmpty, self.dirtyGatewayConfigFields.isEmpty {
            self.setGatewayConfigSyncState(.current)
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

    func startVoiceEars() {
        self.earBoostActive = true
    }

    func stopVoiceEars() {
        self.earBoostActive = false
    }

    func blinkOnce() {
        self.blinkTick &+= 1
    }

    func celebrateSend() {
        self.sendCelebrationTick &+= 1
    }

    func setVoiceWakeEnabled(_ enabled: Bool, requestIsCurrent: @MainActor () -> Bool = { true }) async {
        guard !Task.isCancelled, requestIsCurrent() else { return }
        self.voiceWakeEnableGeneration &+= 1
        let generation = self.voiceWakeEnableGeneration
        var authorized = enabled && voiceWakeSupported && SpeechRecognitionRequestPolicy.supportsPassiveVoiceWake(
            localeID: self.voiceWakeLocaleID)
        if authorized, !self.isPreview, !PermissionManager.voiceWakePermissionsGranted() {
            authorized = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        }
        // OS authorization outlives task cancellation. Only the current intent and
        // requesting document may commit; didSet owns persistence and runtime refresh.
        guard !Task.isCancelled, generation == self.voiceWakeEnableGeneration, requestIsCurrent() else { return }
        self.swabbleEnabled = authorized
    }

    func setLocationMode(_ mode: OpenClawLocationMode, requestIsCurrent: @MainActor () -> Bool) async {
        guard !self.isPreview, !Task.isCancelled, requestIsCurrent() else { return }
        self.locationModeGeneration &+= 1
        let generation = self.locationModeGeneration
        if mode != .off {
            guard CLLocationManager.locationServicesEnabled() else {
                SystemSettingsURLSupport.openPrivacySettings(for: .location)
                return
            }
            let requireAlways = mode == .always
            let status = await LocationPermissionRequester.shared.request(always: requireAlways)
            guard PermissionManager.isLocationAuthorized(status: status, requireAlways: requireAlways) else { return }
        }
        // All Dashboard windows share location intent; a newer Off must invalidate
        // an older authorization even while its requesting document remains open.
        guard !Task.isCancelled, generation == self.locationModeGeneration, requestIsCurrent() else { return }
        AppDefaults.standard.set(mode.rawValue, forKey: locationModeKey)
    }

    func setTalkEnabled(_ enabled: Bool) async {
        self.talkEnabled = enabled && voiceWakeSupported
        guard !self.isPreview else { return }

        if !self.talkEnabled {
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
        self.voiceWakeGlobalSyncScheduler.schedule(sanitized)
    }

    // MARK: - Chime persistence

    private static func loadChime(key: String, fallback: VoiceWakeChime) -> VoiceWakeChime {
        guard let data = AppDefaults.standard.data(forKey: key) else { return fallback }
        if let decoded = try? JSONDecoder().decode(VoiceWakeChime.self, from: data) {
            return decoded
        }
        return fallback
    }

    private func storeChime(_ chime: VoiceWakeChime, key: String) {
        guard let data = try? JSONEncoder().encode(chime) else { return }
        AppDefaults.standard.set(data, forKey: key)
    }
}

// MARK: - App state helpers

extension AppState {
    private func ifNotPreview(_ action: () -> Void) {
        guard !self.isPreview else { return }
        action()
    }

    static func shouldPersistLaunchAtLoginChange(
        isInitializing: Bool,
        isHydrating: Bool,
        isEnabling: Bool,
        bundleLocationAllowsPersistentIntegration: Bool) -> Bool
    {
        !isInitializing && !isHydrating && (!isEnabling || bundleLocationAllowsPersistentIntegration)
    }
}

extension AppState {
    struct PrimaryGatewayConfiguration: Equatable, Sendable {
        let url: URL
        let token: String?
        let tlsFingerprint: String?
    }

    private static func syncedGatewayRoot(
        currentRoot: [String: Any],
        draft: GatewayConfigSyncDraft,
        primaryGateway: PrimaryGatewayConfiguration? = nil)
        -> (root: [String: Any], changed: Bool)
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

        if draft.dirtyFields.contains(.mode) {
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
        }

        var remote = gateway["remote"] as? [String: Any] ?? [:]
        var remoteChanged = false
        if draft.dirtyFields.contains(where: { $0.remoteKey != nil }) {
            let remoteHost = CommandResolver.parseSSHTarget(draft.remoteTarget)?.host
            let updated = Self.updatedRemoteGatewayConfig(
                current: remote,
                draft: .init(
                    transport: draft.remoteTransport,
                    remoteUrl: draft.remoteUrl,
                    remoteHost: remoteHost,
                    remoteTarget: draft.remoteTarget,
                    remoteIdentity: draft.remoteIdentity,
                    remoteToken: draft.remoteToken,
                    dirtyFields: draft.dirtyFields))
            remote = updated.remote
            remoteChanged = updated.changed
        }
        if let primaryGateway {
            // An explicit Gateway replacement owns the complete auth bundle;
            // an old password must never reach the new Gateway's native dashboard.
            remoteChanged = Self.updateGatewayString(&remote, key: "password", value: nil) || remoteChanged
            remoteChanged = Self.updateGatewayString(
                &remote,
                key: "tlsFingerprint",
                value: primaryGateway.tlsFingerprint) || remoteChanged
        }
        if remoteChanged {
            if remote.isEmpty {
                gateway.removeValue(forKey: "remote")
            } else {
                gateway["remote"] = remote
            }
            changed = true
        }

        guard changed else { return (currentRoot, false) }

        if gateway.isEmpty {
            root.removeValue(forKey: "gateway")
        } else {
            root["gateway"] = gateway
        }
        return (root, true)
    }

    private func syncGatewayConfigIfNeeded() {
        guard !self.isApplyingGatewayConfig else { return }
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
        let ownsRemoteRoute = draft.dirtyFields.contains(.remoteTransport) ||
            draft.dirtyFields.contains(.remoteUrl) ||
            draft.dirtyFields.contains(.remoteTarget)
        guard draft.connectionMode == .remote || ownsRemoteRoute else { return true }
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
        self.syncGatewayConfigNow(primaryGateway: nil)
    }

    @discardableResult
    func replacePrimaryGateway(_ configuration: PrimaryGatewayConfiguration) -> Bool {
        self.syncGatewayConfigNow(primaryGateway: configuration)
    }

    private func syncGatewayConfigNow(primaryGateway: PrimaryGatewayConfiguration?) -> Bool {
        guard self.gatewayConfigSyncIsEnabled, !self.isInitializing else { return true }
        let previousSyncState = self.gatewayConfigSyncState
        self.setGatewayConfigSyncState(.pending)

        let currentRoot = OpenClawConfigFile.loadDict()
        self.applyConfigOverrides(currentRoot)
        guard self.conflictedGatewayConfigFields.isEmpty else { return false }

        var draft = self.gatewayConfigDraft()
        if let primaryGateway {
            draft.connectionMode = .remote
            draft.remoteTransport = .direct
            draft.remoteUrl = primaryGateway.url.absoluteString
            draft.remoteToken = primaryGateway.token ?? ""
            draft.dirtyFields.formUnion([.mode, .remoteTransport, .remoteUrl, .remoteToken])
        }
        guard Self.gatewayDraftCanPersist(draft) else {
            self.setGatewayConfigSyncState(primaryGateway == nil ? .failed : previousSyncState)
            return false
        }

        // Keep app-only connection settings local to avoid overwriting remote gateway config.
        let synced = Self.syncedGatewayRoot(
            currentRoot: currentRoot,
            draft: draft,
            primaryGateway: primaryGateway)
        guard !synced.changed || self.gatewayConfigSaver(synced.root) else {
            self.setGatewayConfigSyncState(primaryGateway == nil ? .failed : previousSyncState)
            Self.logger.warning("gateway config sync rejected to protect persisted gateway auth/mode")
            return false
        }
        self.acknowledgeGatewayConfigPersistence(draft, root: synced.root)
        if primaryGateway != nil {
            // Publish the selection only after its endpoint and credentials commit.
            if synced.changed, !self.isPreview {
                WebChatManager.shared.resetPrimaryConnections()
            }
            self.applyGatewayConfigView(synced.root, forcing: Self.gatewayConfigFieldsPersisted(by: draft))
        }
        self.lastConfigFingerprint = Self.configFingerprint(synced.root)
        self.setGatewayConfigSyncState(.current)
        if synced.changed {
            NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
        }
        return true
    }

    private func acknowledgeGatewayConfigPersistence(
        _ draft: GatewayConfigSyncDraft,
        root: [String: Any])
    {
        let persistedFields = Self.gatewayConfigFieldsPersisted(by: draft)
        self.dirtyGatewayConfigFields.subtract(persistedFields)
        self.conflictedGatewayConfigFields.subtract(persistedFields)
        self.lastObservedGatewayConfig = Self.gatewayConfigSnapshot(root)
    }

    @discardableResult
    func useFileGatewayConfigConflict() -> Bool {
        let fields = self.conflictedGatewayConfigFields
        guard !fields.isEmpty else { return true }

        let priorDraft = self.gatewayConfigDraft()
        let priorRemoteTokenUnsupported = self.remoteTokenUnsupported
        let root = OpenClawConfigFile.loadDict()
        self.dirtyGatewayConfigFields.subtract(fields)
        self.conflictedGatewayConfigFields.subtract(fields)
        self.applyGatewayConfigView(root, forcing: fields)

        guard self.syncGatewayConfigNow() else {
            self.restoreGatewayConfigDraft(priorDraft, fields: fields)
            self.remoteTokenUnsupported = priorRemoteTokenUnsupported
            self.dirtyGatewayConfigFields.formUnion(fields)
            self.conflictedGatewayConfigFields.formUnion(fields)
            self.setGatewayConfigSyncState(.failed)
            return false
        }
        return true
    }

    @discardableResult
    func keepGatewayConfigEdits() -> Bool {
        let fields = self.conflictedGatewayConfigFields
        guard !fields.isEmpty else { return true }

        self.conflictedGatewayConfigFields.subtract(fields)
        self.dirtyGatewayConfigFields.formUnion(fields)
        guard self.syncGatewayConfigNow(),
              self.dirtyGatewayConfigFields.isDisjoint(with: fields)
        else {
            self.conflictedGatewayConfigFields.formUnion(fields)
            self.setGatewayConfigSyncState(.failed)
            return false
        }
        return true
    }

    private func restoreGatewayConfigDraft(
        _ draft: GatewayConfigSyncDraft,
        fields: Set<GatewayConfigField>)
    {
        self.isApplyingGatewayConfig = true
        if fields.contains(.mode) {
            self.connectionMode = draft.connectionMode
        }
        if fields.contains(.remoteTransport) {
            self.remoteTransport = draft.remoteTransport
        }
        if fields.contains(.remoteUrl) {
            self.remoteUrl = draft.remoteUrl
        }
        if fields.contains(.remoteTarget) {
            self.remoteTarget = draft.remoteTarget
        }
        if fields.contains(.remoteIdentity) {
            self.remoteIdentity = draft.remoteIdentity
        }
        if fields.contains(.remoteToken) {
            self.remoteToken = draft.remoteToken
        }
        self.isApplyingGatewayConfig = false
    }
}

extension AppState {
    private static func loadCookieSyncDefaults() -> (Bool, String, [String]) {
        let defaults = AppDefaults.standard
        return (
            defaults.object(forKey: cookieSyncEnabledKey) as? Bool ?? false,
            defaults.string(forKey: cookieSyncIntoProfileKey) ?? "imported",
            defaults.stringArray(forKey: cookieSyncDomainsKey) ?? [])
    }

    static func resolveActiveComputerPresenceEnabled(defaults: UserDefaults = AppDefaults.standard) -> Bool {
        defaults.bool(forKey: activeComputerPresenceEnabledKey)
    }

    static func activeComputerPresenceUpdateIsCurrent(
        capturedGeneration: UInt64,
        currentGeneration: UInt64,
        capturedEnabled: Bool,
        currentEnabled: Bool,
        isCancelled: Bool) -> Bool
    {
        !isCancelled &&
            capturedGeneration == currentGeneration &&
            capturedEnabled == currentEnabled
    }

    private func scheduleActiveComputerPresenceUpdate() {
        self.ifNotPreview {
            let enabled = self.activeComputerPresenceEnabled
            AppDefaults.standard.set(enabled, forKey: activeComputerPresenceEnabledKey)
            PresenceReporter.shared.sendImmediate(reason: "activity-sharing-changed")
            self.activeComputerPresenceUpdateGeneration &+= 1
            let generation = self.activeComputerPresenceUpdateGeneration
            self.activeComputerPresenceTask?.cancel()
            // Apply the newest privacy choice immediately. An older network-bound
            // enable may resume later, but the reporter's generation guard contains it.
            self.activeComputerPresenceTask = Task { @MainActor [weak self] in
                guard let self,
                      Self.activeComputerPresenceUpdateIsCurrent(
                          capturedGeneration: generation,
                          currentGeneration: self.activeComputerPresenceUpdateGeneration,
                          capturedEnabled: enabled,
                          currentEnabled: self.activeComputerPresenceEnabled,
                          isCancelled: Task.isCancelled)
                else { return }
                await MacNodeModeCoordinator.shared.setPresenceActivityReportingEnabled(enabled)
            }
        }
    }

    enum ConnectionMode: String {
        case unconfigured
        case local
        case remote
    }

    enum RemoteTransport: String {
        case ssh
        case direct
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

    func _testApplyConfigFromDisk() {
        self.applyConfigFromDisk()
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

    var _testDirtyGatewayConfigFields: [String] {
        self.dirtyGatewayConfigFields.map(\.rawValue).sorted()
    }

    var _testConflictedGatewayConfigFields: [String] {
        self.conflictedGatewayConfigFields.map(\.rawValue).sorted()
    }

    @discardableResult
    func _testReconcilePreferredGatewayRouteBinding() -> Bool {
        self.reconcilePreferredGatewayRouteBinding()
    }
}
#endif

@MainActor
enum AppStateStore {
    static let shared = AppState(preview: ProcessInfo.processInfo.isPreview)

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
