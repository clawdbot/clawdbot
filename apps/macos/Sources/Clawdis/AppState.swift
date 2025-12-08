import AppKit
import Foundation
import ServiceManagement
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    enum ConnectionMode: String {
        case local
        case remote
    }

    @Published var isPaused: Bool {
        didSet { UserDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) }
    }

    @Published var launchAtLogin: Bool {
        didSet { Task { AppStateStore.updateLaunchAtLogin(enabled: self.launchAtLogin) } }
    }

    @Published var onboardingSeen: Bool {
        didSet { UserDefaults.standard.set(self.onboardingSeen, forKey: "clawdis.onboardingSeen") }
    }

    @Published var debugPaneEnabled: Bool {
        didSet { UserDefaults.standard.set(self.debugPaneEnabled, forKey: "clawdis.debugPaneEnabled") }
    }

    @Published var swabbleEnabled: Bool {
        didSet {
            UserDefaults.standard.set(self.swabbleEnabled, forKey: swabbleEnabledKey)
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
        }
    }

    @Published var swabbleTriggerWords: [String] {
        didSet {
            // Trim user input but keep empty placeholders so the UI can show newly added rows.
            let cleaned = self.swabbleTriggerWords.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            UserDefaults.standard.set(cleaned, forKey: swabbleTriggersKey)
            if cleaned != self.swabbleTriggerWords {
                self.swabbleTriggerWords = cleaned
                return
            }
            if self.swabbleEnabled {
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var iconAnimationsEnabled: Bool {
        didSet { UserDefaults.standard.set(self.iconAnimationsEnabled, forKey: iconAnimationsEnabledKey) }
    }

    @Published var showDockIcon: Bool {
        didSet {
            UserDefaults.standard.set(self.showDockIcon, forKey: showDockIconKey)
            AppActivationPolicy.apply(showDockIcon: self.showDockIcon)
        }
    }

    @Published var voiceWakeMicID: String {
        didSet {
            UserDefaults.standard.set(self.voiceWakeMicID, forKey: voiceWakeMicKey)
            if self.swabbleEnabled {
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var voiceWakeLocaleID: String {
        didSet {
            UserDefaults.standard.set(self.voiceWakeLocaleID, forKey: voiceWakeLocaleKey)
            if self.swabbleEnabled {
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var voiceWakeAdditionalLocaleIDs: [String] {
        didSet { UserDefaults.standard.set(self.voiceWakeAdditionalLocaleIDs, forKey: voiceWakeAdditionalLocalesKey) }
    }

    @Published var voiceWakeForwardEnabled: Bool {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardEnabled, forKey: voiceWakeForwardEnabledKey) }
    }

    @Published var voiceWakeForwardTarget: String {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardTarget, forKey: voiceWakeForwardTargetKey) }
    }

    @Published var voiceWakeForwardIdentity: String {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardIdentity, forKey: voiceWakeForwardIdentityKey) }
    }

    @Published var voiceWakeForwardCommand: String {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardCommand, forKey: voiceWakeForwardCommandKey) }
    }

    @Published var voicePushToTalkEnabled: Bool {
        didSet { UserDefaults.standard.set(self.voicePushToTalkEnabled, forKey: voicePushToTalkEnabledKey) }
    }

    @Published var isWorking: Bool = false
    @Published var earBoostActive: Bool = false
    @Published var heartbeatsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(self.heartbeatsEnabled, forKey: heartbeatsEnabledKey)
            Task { _ = await AgentRPC.shared.setHeartbeatsEnabled(self.heartbeatsEnabled) }
        }
    }

    @Published var connectionMode: ConnectionMode {
        didSet { UserDefaults.standard.set(self.connectionMode.rawValue, forKey: connectionModeKey) }
    }

    @Published var webChatEnabled: Bool {
        didSet { UserDefaults.standard.set(self.webChatEnabled, forKey: webChatEnabledKey) }
    }

    @Published var webChatPort: Int {
        didSet { UserDefaults.standard.set(self.webChatPort, forKey: webChatPortKey) }
    }

    @Published var remoteTarget: String {
        didSet { UserDefaults.standard.set(self.remoteTarget, forKey: remoteTargetKey) }
    }

    @Published var remoteIdentity: String {
        didSet { UserDefaults.standard.set(self.remoteIdentity, forKey: remoteIdentityKey) }
    }

    @Published var remoteProjectRoot: String {
        didSet { UserDefaults.standard.set(self.remoteProjectRoot, forKey: remoteProjectRootKey) }
    }

    private var earBoostTask: Task<Void, Never>?

    init() {
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.launchAtLogin = false
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdis.debugPaneEnabled")
        let savedVoiceWake = UserDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleEnabled = voiceWakeSupported ? savedVoiceWake : false
        self.swabbleTriggerWords = UserDefaults.standard
            .stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
        if let storedIconAnimations = UserDefaults.standard.object(forKey: iconAnimationsEnabledKey) as? Bool {
            self.iconAnimationsEnabled = storedIconAnimations
        } else {
            self.iconAnimationsEnabled = true
            UserDefaults.standard.set(true, forKey: iconAnimationsEnabledKey)
        }
        self.showDockIcon = UserDefaults.standard.bool(forKey: showDockIconKey)
        self.voiceWakeMicID = UserDefaults.standard.string(forKey: voiceWakeMicKey) ?? ""
        self.voiceWakeLocaleID = UserDefaults.standard.string(forKey: voiceWakeLocaleKey) ?? Locale.current.identifier
        self.voiceWakeAdditionalLocaleIDs = UserDefaults.standard
            .stringArray(forKey: voiceWakeAdditionalLocalesKey) ?? []
        self.voiceWakeForwardEnabled = UserDefaults.standard.bool(forKey: voiceWakeForwardEnabledKey)
        let legacyTarget = Self.legacyTargetString()
        self.voiceWakeForwardTarget = UserDefaults.standard
            .string(forKey: voiceWakeForwardTargetKey) ?? legacyTarget
        self.voiceWakeForwardIdentity = UserDefaults.standard.string(forKey: voiceWakeForwardIdentityKey) ?? ""

        self.voicePushToTalkEnabled = UserDefaults.standard
            .object(forKey: voicePushToTalkEnabledKey) as? Bool ?? false

        var storedForwardCommand = UserDefaults.standard
            .string(forKey: voiceWakeForwardCommandKey) ?? defaultVoiceWakeForwardCommand
        // Guard against older prefs missing flags; the forwarder depends on these for replies.
        if !storedForwardCommand.contains("--deliver") || !storedForwardCommand.contains("--session") {
            storedForwardCommand = defaultVoiceWakeForwardCommand
            UserDefaults.standard.set(storedForwardCommand, forKey: voiceWakeForwardCommandKey)
        }
        self.voiceWakeForwardCommand = storedForwardCommand
        if let storedHeartbeats = UserDefaults.standard.object(forKey: heartbeatsEnabledKey) as? Bool {
            self.heartbeatsEnabled = storedHeartbeats
        } else {
            self.heartbeatsEnabled = true
            UserDefaults.standard.set(true, forKey: heartbeatsEnabledKey)
        }

        let storedMode = UserDefaults.standard.string(forKey: connectionModeKey)
        self.connectionMode = ConnectionMode(rawValue: storedMode ?? "local") ?? .local
        self.remoteTarget = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        self.remoteIdentity = UserDefaults.standard.string(forKey: remoteIdentityKey) ?? ""
        self.remoteProjectRoot = UserDefaults.standard.string(forKey: remoteProjectRootKey) ?? ""
        self.webChatEnabled = UserDefaults.standard.object(forKey: webChatEnabledKey) as? Bool ?? true
        let storedPort = UserDefaults.standard.integer(forKey: webChatPortKey)
        self.webChatPort = storedPort > 0 ? storedPort : 18788

        Task.detached(priority: .utility) { [weak self] in
            let current = await LaunchAgentManager.status()
            await MainActor.run { [weak self] in self?.launchAtLogin = current }
        }

        if self.swabbleEnabled, !PermissionManager.voiceWakePermissionsGranted() {
            self.swabbleEnabled = false
        }

        Task { await VoiceWakeRuntime.shared.refresh(state: self) }
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

    func setVoiceWakeEnabled(_ enabled: Bool) async {
        guard voiceWakeSupported else {
            self.swabbleEnabled = false
            return
        }

        if !enabled {
            self.swabbleEnabled = false
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        if PermissionManager.voiceWakePermissionsGranted() {
            self.swabbleEnabled = true
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        self.swabbleEnabled = granted
        Task { await VoiceWakeRuntime.shared.refresh(state: self) }
    }

    func setWorking(_ working: Bool) {
        self.isWorking = working
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

    static var webChatEnabled: Bool {
        UserDefaults.standard.object(forKey: webChatEnabledKey) as? Bool ?? true
    }

    static var webChatPort: Int {
        let stored = UserDefaults.standard.integer(forKey: webChatPortKey)
        return stored > 0 ? stored : 18788
    }
}

extension AppState {
    var voiceWakeForwardConfig: VoiceWakeForwardConfig {
        VoiceWakeForwardConfig(
            enabled: self.voiceWakeForwardEnabled,
            target: self.voiceWakeForwardTarget,
            identityPath: self.voiceWakeForwardIdentity,
            commandTemplate: self.voiceWakeForwardCommand,
            timeout: defaultVoiceWakeForwardTimeout)
    }

    private static func legacyTargetString() -> String {
        let host = UserDefaults.standard.string(forKey: voiceWakeForwardHostKey) ?? ""
        let user = UserDefaults.standard.string(forKey: voiceWakeForwardUserKey) ?? ""
        let savedPort = UserDefaults.standard.integer(forKey: voiceWakeForwardPortKey)
        let port = savedPort == 0 ? defaultVoiceWakeForwardPort : savedPort
        let userPrefix = user.isEmpty ? "" : "\(user)@"
        let portSuffix = host.isEmpty ? "" : ":\(port)"
        return "\(userPrefix)\(host)\(portSuffix)"
    }
}

@MainActor
enum AppActivationPolicy {
    static func apply(showDockIcon: Bool) {
        NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
    }
}
