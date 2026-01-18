import AppKit
import Foundation
import Observation
import ServiceManagement
import SwiftUI

@MainActor
@Observable
final class AppState {
    private let isPreview: Bool
    private var isInitializing = true
    private var configWatcher: ConfigFileWatcher?
    private var suppressVoiceWakeGlobalSync = false
    private var voiceWakeGlobalSyncTask: Task<Void, Never>?

    private func ifNotPreview(_ action: () -> Void) {
        guard !self.isPreview else { return }
        action()
    }

    enum ConnectionMode: String {
        case unconfigured
        case local
        case remote
    }

    var isPaused: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) } }
    }

    var launchAtLogin: Bool {
        didSet {
            guard !self.isInitializing else { return }
            self.ifNotPreview { Task { AppStateStore.updateLaunchAtLogin(enabled: self.launchAtLogin) } }
        }
    }

    var onboardingSeen: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.onboardingSeen, forKey: "clawdbot.onboardingSeen") }
        }
    }

    var debugPaneEnabled: Bool {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.debugPaneEnabled, forKey: "clawdbot.debugPaneEnabled") }
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

    var talkEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.talkEnabled, forKey: talkEnabledKey)
                Task { await TalkModeController.shared.setEnabled(self.talkEnabled) }
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
            self.syncGatewayConfigIfNeeded()
        }
    }

    var canvasEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.canvasEnabled, forKey: canvasEnabledKey) } }
    }

    var execApprovalMode: ExecApprovalQuickMode {
        didSet {
            self.ifNotPreview {
                ExecApprovalsStore.updateDefaults { defaults in
                    defaults.security = self.execApprovalMode.security
                    defaults.ask = self.execApprovalMode.ask
                }
            }
        }
    }

    /// Tracks whether the Canvas panel is currently visible (not persisted).
    var canvasPanelVisible: Bool = false

    var peekabooBridgeEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.peekabooBridgeEnabled, forKey: peekabooBridgeEnabledKey)
                Task { await PeekabooBridgeHostCoordinator.shared.setEnabled(self.peekabooBridgeEnabled) }
            }
        }
    }

    var remoteTarget: String {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.remoteTarget, forKey: remoteTargetKey) }
            self.syncGatewayConfigIfNeeded()
        }
    }

    var remoteIdentity: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteIdentity, forKey: remoteIdentityKey) } }
    }

    var remoteProjectRoot: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteProjectRoot, forKey: remoteProjectRootKey) } }
    }

    var remoteCliPath: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteCliPath, forKey: remoteCliPathKey) } }
    }

    private var earBoostTask: Task<Void, Never>?

    init(preview: Bool = false) {
        self.isPreview = preview || ProcessInfo.processInfo.isRunningTests
        let onboardingSeen = UserDefaults.standard.bool(forKey: "clawdbot.onboardingSeen")
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.launchAtLogin = false
        self.onboardingSeen = onboardingSeen
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdbot.debugPaneEnabled")
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
        self.showDockIcon = UserDefaults.standard.bool(forKey: showDockIconKey)
        self.voiceWakeMicID = UserDefaults.standard.string(forKey: voiceWakeMicKey) ?? ""
        self.voiceWakeMicName = UserDefaults.standard.string(forKey: voiceWakeMicNameKey) ?? ""
        self.voiceWakeLocaleID = UserDefaults.standard.string(forKey: voiceWakeLocaleKey) ?? Locale.current.identifier
        self.voiceWakeAdditionalLocaleIDs = UserDefaults.standard
            .stringArray(forKey: voiceWakeAdditionalLocalesKey) ?? []
        self.voicePushToTalkEnabled = UserDefaults.standard
            .object(forKey: voicePushToTalkEnabledKey) as? Bool ?? false
        self.talkEnabled = UserDefaults.standard.bool(forKey: talkEnabledKey)
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

        let configRoot = ClawdbotConfigFile.loadDict()
        let configGateway = configRoot["gateway"] as? [String: Any]
        let configRemoteUrl = (configGateway?["remote"] as? [String: Any])?["url"] as? String
        let resolvedConnectionMode = ConnectionModeResolver.resolve(root: configRoot).mode
        self.connectionMode = resolvedConnectionMode

        let storedRemoteTarget = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        if resolvedConnectionMode == .remote,
           storedRemoteTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let host = AppState.remoteHost(from: configRemoteUrl)
        {
            self.remoteTarget = "\(NSUserName())@\(host)"
        } else {
            self.remoteTarget = storedRemoteTarget
        }
        self.remoteIdentity = UserDefaults.standard.string(forKey: remoteIdentityKey) ?? ""
        self.remoteProjectRoot = UserDefaults.standard.string(forKey: remoteProjectRootKey) ?? ""
        self.remoteCliPath = UserDefaults.standard.string(forKey: remoteCliPathKey) ?? ""
        self.canvasEnabled = UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
        let execDefaults = ExecApprovalsStore.resolveDefaults()
        self.execApprovalMode = ExecApprovalQuickMode.from(security: execDefaults.security, ask: execDefaults.ask)
        self.peekabooBridgeEnabled = UserDefaults.standard
            .object(forKey: peekabooBridgeEnabledKey) as? Bool ?? true
        if !self.isPreview {
            Task.detached(priority: .utility) { [weak self] in
                let current = await LaunchAgentManager.status()
                await MainActor.run { [weak self] in self?.launchAtLogin = current }
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

        self.isInitializing = false
        if !self.isPreview {
            self.startConfigWatcher()
        }
    }

    @MainActor
    deinit {
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

    private func startConfigWatcher() {
        let configUrl = ClawdbotConfigFile.url()
        self.configWatcher = ConfigFileWatcher(url: configUrl) { [weak self] in
            Task { @MainActor in
                self?.applyConfigFromDisk()
            }
        }
        self.configWatcher?.start()
    }

    private func applyConfigFromDisk() {
        let root = ClawdbotConfigFile.loadDict()
        self.applyConfigOverrides(root)
    }

    private func applyConfigOverrides(_ root: [String: Any]) {
        let gateway = root["gateway"] as? [String: Any]
        let modeRaw = (gateway?["mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let remoteUrl = (gateway?["remote"] as? [String: Any])?["url"] as? String
        let hasRemoteUrl = !(remoteUrl?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty ?? true)

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

        let targetMode = desiredMode ?? self.connectionMode
        if targetMode == .remote,
           let host = AppState.remoteHost(from: remoteUrl)
        {
            self.updateRemoteTarget(host: host)
        }
    }

    private func updateRemoteTarget(host: String) {
        let parsed = CommandResolver.parseSSHTarget(self.remoteTarget)
        let user = parsed?.user ?? NSUserName()
        let port = parsed?.port ?? 22
        let assembled = port == 22 ? "\(user)@\(host)" : "\(user)@\(host):\(port)"
        if assembled != self.remoteTarget {
            self.remoteTarget = assembled
        }
    }

    private func syncGatewayConfigIfNeeded() {
        guard !self.isPreview, !self.isInitializing else { return }

        let connectionMode = self.connectionMode
        let remoteTarget = self.remoteTarget
        let remoteIdentity = self.remoteIdentity
        let desiredMode: String? = switch connectionMode {
        case .local:
            "local"
        case .remote:
            "remote"
        case .unconfigured:
            nil
        }
        let remoteHost = connectionMode == .remote
            ? CommandResolver.parseSSHTarget(remoteTarget)?.host
            : nil

        Task { @MainActor in
            // Keep app-only connection settings local to avoid overwriting remote gateway config.
            var root = ClawdbotConfigFile.loadDict()
            var gateway = root["gateway"] as? [String: Any] ?? [:]
            var changed = false

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

            if connectionMode == .remote {
                var remote = gateway["remote"] as? [String: Any] ?? [:]
                var remoteChanged = false

                if let host = remoteHost {
                    let existingUrl = (remote["url"] as? String)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let parsedExisting = existingUrl.isEmpty ? nil : URL(string: existingUrl)
                    let scheme = parsedExisting?.scheme?.isEmpty == false ? parsedExisting?.scheme : "ws"
                    let port = parsedExisting?.port ?? 18789
                    let desiredUrl = "\(scheme ?? "ws")://\(host):\(port)"
                    if existingUrl != desiredUrl {
                        remote["url"] = desiredUrl
                        remoteChanged = true
                    }
                }

                let sanitizedTarget = Self.sanitizeSSHTarget(remoteTarget)
                if !sanitizedTarget.isEmpty {
                    if (remote["sshTarget"] as? String) != sanitizedTarget {
                        remote["sshTarget"] = sanitizedTarget
                        remoteChanged = true
                    }
                } else if remote["sshTarget"] != nil {
                    remote.removeValue(forKey: "sshTarget")
                    remoteChanged = true
                }

                let trimmedIdentity = remoteIdentity.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedIdentity.isEmpty {
                    if (remote["sshIdentity"] as? String) != trimmedIdentity {
                        remote["sshIdentity"] = trimmedIdentity
                        remoteChanged = true
                    }
                } else if remote["sshIdentity"] != nil {
                    remote.removeValue(forKey: "sshIdentity")
                    remoteChanged = true
                }

                if remoteChanged {
                    gateway["remote"] = remote
                    changed = true
                }
            }

            guard changed else { return }
            if gateway.isEmpty {
                root.removeValue(forKey: "gateway")
            } else {
                root["gateway"] = gateway
            }
            ClawdbotConfigFile.saveDict(root)
        }
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
        let sanitized = sanitizeVoiceWakeTriggers(self.swabbleTriggerWords)
        self.voiceWakeGlobalSyncTask?.cancel()
        self.voiceWakeGlobalSyncTask = Task { [sanitized] in
            try? await Task.sleep(nanoseconds: 650_000_000)
            await GatewayConnection.shared.voiceWakeSetTriggers(sanitized)
        }
    }

    func setWorking(_ working: Bool) {
        self.isWorking = working
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
        state.iconOverride = .system
        state.heartbeatsEnabled = true
        state.connectionMode = .local
        state.canvasEnabled = true
        state.remoteTarget = "user@example.com"
        state.remoteIdentity = "~/.ssh/id_ed25519"
        state.remoteProjectRoot = "~/Projects/clawdbot"
        state.remoteCliPath = ""
        return state
    }
}

@MainActor
enum AppStateStore {
    static let shared = AppState()
    static var isPausedFlag: Bool { UserDefaults.standard.bool(forKey: pauseDefaultsKey) }

    static func updateLaunchAtLogin(enabled: Bool) {
        Task.detached(priority: .utility) {
            await LaunchAgentManager.set(enabled: enabled, bundlePath: Bundle.main.bundlePath)
        }
    }

    static var canvasEnabled: Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }
}

@MainActor
enum AppActivationPolicy {
    static func apply(showDockIcon: Bool) {
        _ = showDockIcon
        DockIconManager.shared.updateDockVisibility()
    }
}
