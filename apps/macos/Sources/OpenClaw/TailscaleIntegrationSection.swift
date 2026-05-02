import SwiftUI

private enum GatewayTailscaleMode: String, CaseIterable, Identifiable {
    case off
    case serve
    case funnel

    var id: String {
        self.rawValue
    }

    var label: String {
        switch self {
        case .off: "Off"
        case .serve: "Tailnet (Serve)"
        case .funnel: "Public (Funnel)"
        }
    }

    var description: String {
        switch self {
        case .off:
            "No automatic Tailscale configuration."
        case .serve:
            "Tailnet-only HTTPS via Tailscale Serve."
        case .funnel:
            "Public HTTPS via Tailscale Funnel (requires auth)."
        }
    }
}

private struct GatewayTailscaleSettingsSnapshot: Equatable {
    var mode: GatewayTailscaleMode
    var requireCredentialsForServe: Bool
    var password: String

    init(mode: GatewayTailscaleMode, requireCredentialsForServe: Bool, password: String) {
        self.mode = mode
        self.requireCredentialsForServe = requireCredentialsForServe
        self.password = password.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private struct GatewayTailscaleLoadedSettings {
    var snapshot: GatewayTailscaleSettingsSnapshot
    var displayPassword: String
}

private struct GatewayTailscaleApplyResult {
    var didApply: Bool
    var success: Bool
    var errorMessage: String?
    var validationMessage: String?
}

private struct GatewayTailscaleApplyMessages {
    var statusMessage: String?
    var validationMessage: String?
    var shouldRecordSuccess: Bool
    var shouldRestartGateway: Bool
}

private typealias GatewayTailscaleSettingsSaver = @MainActor @Sendable (
    GatewayTailscaleSettingsSnapshot,
    AppState.ConnectionMode,
    Bool) async -> (Bool, String?)

struct TailscaleIntegrationSection: View {
    let connectionMode: AppState.ConnectionMode
    let isPaused: Bool

    @Environment(TailscaleService.self) private var tailscaleService
    #if DEBUG
    private var testingService: TailscaleService?
    #endif

    @State private var hasLoaded = false
    @State private var tailscaleMode: GatewayTailscaleMode = .serve
    @State private var requireCredentialsForServe = false
    @State private var password: String = ""
    @State private var statusMessage: String?
    @State private var validationMessage: String?
    @State private var statusTimer: Timer?
    @State private var lastAppliedSettings: GatewayTailscaleSettingsSnapshot?

    init(connectionMode: AppState.ConnectionMode, isPaused: Bool) {
        self.connectionMode = connectionMode
        self.isPaused = isPaused
        #if DEBUG
        self.testingService = nil
        #endif
    }

    private var effectiveService: TailscaleService {
        #if DEBUG
        return self.testingService ?? self.tailscaleService
        #else
        return self.tailscaleService
        #endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tailscale (dashboard access)")
                .font(.callout.weight(.semibold))

            self.statusRow

            if !self.effectiveService.isInstalled {
                self.installButtons
            } else {
                self.modePicker
                if self.tailscaleMode != .off {
                    self.accessURLRow
                }
                if self.tailscaleMode == .serve {
                    self.serveAuthSection
                }
                if self.tailscaleMode == .funnel {
                    self.funnelAuthSection
                }
            }

            if self.connectionMode != .local {
                Text("Local mode required. Update settings on the gateway host.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let validationMessage {
                Text(validationMessage)
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
        .disabled(self.connectionMode != .local)
        .task {
            guard !self.hasLoaded else { return }
            await self.loadConfig()
            self.hasLoaded = true
            await self.effectiveService.checkTailscaleStatus()
            self.startStatusTimer()
        }
        .onDisappear {
            self.stopStatusTimer()
        }
        .onChange(of: self.tailscaleMode) { _, _ in
            Task { await self.applySettings() }
        }
        .onChange(of: self.requireCredentialsForServe) { _, _ in
            Task { await self.applySettings() }
        }
    }

    private var statusRow: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(self.statusColor)
                .frame(width: 10, height: 10)
            Text(self.statusText)
                .font(.callout)
            Spacer()
            Button("Refresh") {
                Task { await self.effectiveService.checkTailscaleStatus() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private var statusColor: Color {
        if !self.effectiveService.isInstalled { return .yellow }
        if self.effectiveService.isRunning { return .green }
        return .orange
    }

    private var statusText: String {
        if !self.effectiveService.isInstalled { return "Tailscale is not installed" }
        if self.effectiveService.isRunning { return "Tailscale is installed and running" }
        return "Tailscale is installed but not running"
    }

    private var installButtons: some View {
        HStack(spacing: 12) {
            Button("App Store") { self.effectiveService.openAppStore() }
                .buttonStyle(.link)
            Button("Direct Download") { self.effectiveService.openDownloadPage() }
                .buttonStyle(.link)
            Button("Setup Guide") { self.effectiveService.openSetupGuide() }
                .buttonStyle(.link)
        }
        .controlSize(.small)
    }

    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Exposure mode")
                .font(.callout.weight(.semibold))
            Picker("Exposure", selection: self.$tailscaleMode) {
                ForEach(GatewayTailscaleMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            Text(self.tailscaleMode.description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var accessURLRow: some View {
        if let host = self.effectiveService.tailscaleHostname {
            let url = "https://\(host)/ui/"
            HStack(spacing: 8) {
                Text("Dashboard URL:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let link = URL(string: url) {
                    Link(url, destination: link)
                        .font(.system(.caption, design: .monospaced))
                } else {
                    Text(url)
                        .font(.system(.caption, design: .monospaced))
                }
            }
        } else if !self.effectiveService.isRunning {
            Text("Start Tailscale to get your tailnet hostname.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if self.effectiveService.isInstalled, !self.effectiveService.isRunning {
            Button("Start Tailscale") { self.effectiveService.openTailscaleApp() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
    }

    private var serveAuthSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Require credentials", isOn: self.$requireCredentialsForServe)
                .toggleStyle(.checkbox)
            if self.requireCredentialsForServe {
                self.authFields
            } else {
                Text("Serve uses Tailscale identity headers; no password required.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var funnelAuthSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Funnel requires authentication.")
                .font(.caption)
                .foregroundStyle(.secondary)
            self.authFields
        }
    }

    @ViewBuilder
    private var authFields: some View {
        SecureField("Password", text: self.$password)
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 240)
            .onSubmit { Task { await self.applySettings() } }
        Text("Stored in ~/.openclaw/openclaw.json. Prefer OPENCLAW_GATEWAY_PASSWORD for production.")
            .font(.caption)
            .foregroundStyle(.secondary)
        Button("Update password") { Task { await self.applySettings() } }
            .buttonStyle(.bordered)
            .controlSize(.small)
    }

    private func loadConfig() async {
        let root = await ConfigStore.load()
        let loaded = TailscaleIntegrationSection.loadedSettings(from: root)
        self.tailscaleMode = loaded.snapshot.mode
        self.requireCredentialsForServe = loaded.snapshot.requireCredentialsForServe
        self.password = loaded.displayPassword
        self.lastAppliedSettings = loaded.snapshot
    }

    private func applySettings() async {
        guard self.hasLoaded else { return }
        let currentSettings = self.currentSettingsSnapshot()
        let result = await TailscaleIntegrationSection.applySettingsIfChanged(
            currentSettings: currentSettings,
            lastAppliedSettings: self.lastAppliedSettings,
            connectionMode: self.connectionMode,
            isPaused: self.isPaused,
            saveSettings: TailscaleIntegrationSection.saveTailscaleSettings)
        let messages = TailscaleIntegrationSection.messages(
            for: result,
            connectionMode: self.connectionMode,
            isPaused: self.isPaused)
        self.validationMessage = messages.validationMessage
        self.statusMessage = messages.statusMessage
        guard messages.shouldRecordSuccess else { return }

        self.lastAppliedSettings = currentSettings
        if messages.shouldRestartGateway {
            self.restartGatewayIfNeeded()
        }
    }

    @MainActor
    private static func buildAndSaveTailscaleConfig(
        tailscaleMode: GatewayTailscaleMode,
        requireCredentialsForServe: Bool,
        password: String,
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool) async -> (Bool, String?)
    {
        let settings = GatewayTailscaleSettingsSnapshot(
            mode: tailscaleMode,
            requireCredentialsForServe: requireCredentialsForServe,
            password: password)
        let root = await self.buildTailscaleConfigRoot(root: ConfigStore.load(), settings: settings)

        do {
            try await ConfigStore.save(root, allowGatewayAuthMutation: true)
            return (true, nil)
        } catch {
            return (false, error.localizedDescription)
        }
    }

    private static func buildTailscaleConfigRoot(
        root originalRoot: [String: Any],
        settings: GatewayTailscaleSettingsSnapshot) -> [String: Any]
    {
        var root = originalRoot
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        var tailscale = gateway["tailscale"] as? [String: Any] ?? [:]
        tailscale["mode"] = settings.mode.rawValue
        gateway["tailscale"] = tailscale

        if settings.mode != .off {
            gateway["bind"] = "loopback"
        }

        if settings.mode == .off {
            gateway.removeValue(forKey: "auth")
        } else {
            var auth = gateway["auth"] as? [String: Any] ?? [:]
            if settings.mode == .serve, !settings.requireCredentialsForServe {
                auth["allowTailscale"] = true
                auth.removeValue(forKey: "mode")
                auth.removeValue(forKey: "password")
            } else {
                auth["allowTailscale"] = false
                auth["mode"] = "password"
                auth["password"] = settings.password
            }

            if auth.isEmpty {
                gateway.removeValue(forKey: "auth")
            } else {
                gateway["auth"] = auth
            }
        }

        if gateway.isEmpty {
            root.removeValue(forKey: "gateway")
        } else {
            root["gateway"] = gateway
        }

        return root
    }

    private func restartGatewayIfNeeded() {
        guard self.connectionMode == .local, !self.isPaused else { return }
        Task { await GatewayLaunchAgentManager.kickstart() }
    }

    private func currentSettingsSnapshot() -> GatewayTailscaleSettingsSnapshot {
        GatewayTailscaleSettingsSnapshot(
            mode: self.tailscaleMode,
            requireCredentialsForServe: self.requireCredentialsForServe,
            password: self.password.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func loadedSettings(from root: [String: Any]) -> GatewayTailscaleLoadedSettings {
        let gateway = root["gateway"] as? [String: Any] ?? [:]
        let tailscale = gateway["tailscale"] as? [String: Any] ?? [:]
        let modeRaw = (tailscale["mode"] as? String) ?? "serve"
        let mode = GatewayTailscaleMode(rawValue: modeRaw) ?? .off

        let auth = gateway["auth"] as? [String: Any] ?? [:]
        let authModeRaw = auth["mode"] as? String
        let allowTailscale = auth["allowTailscale"] as? Bool
        let password = auth["password"] as? String ?? ""
        let requireCredentialsForServe: Bool

        if mode == .serve {
            let usesExplicitAuth = authModeRaw == "password"
            if let allowTailscale, allowTailscale == false {
                requireCredentialsForServe = true
            } else {
                requireCredentialsForServe = usesExplicitAuth
            }
        } else {
            requireCredentialsForServe = false
        }

        return GatewayTailscaleLoadedSettings(
            snapshot: GatewayTailscaleSettingsSnapshot(
                mode: mode,
                requireCredentialsForServe: requireCredentialsForServe,
                password: password),
            displayPassword: password)
    }

    private static func applySettingsIfChanged(
        currentSettings: GatewayTailscaleSettingsSnapshot,
        lastAppliedSettings: GatewayTailscaleSettingsSnapshot?,
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool,
        saveSettings: GatewayTailscaleSettingsSaver) async -> GatewayTailscaleApplyResult
    {
        guard currentSettings != lastAppliedSettings else {
            return GatewayTailscaleApplyResult(
                didApply: false,
                success: true,
                errorMessage: nil,
                validationMessage: nil)
        }

        let requiresPassword = currentSettings.mode == .funnel
            || (currentSettings.mode == .serve && currentSettings.requireCredentialsForServe)
        if requiresPassword, currentSettings.password.isEmpty {
            return GatewayTailscaleApplyResult(
                didApply: true,
                success: false,
                errorMessage: nil,
                validationMessage: "Password required for this mode.")
        }

        let (success, errorMessage) = await saveSettings(currentSettings, connectionMode, isPaused)
        return GatewayTailscaleApplyResult(
            didApply: true,
            success: success,
            errorMessage: errorMessage,
            validationMessage: nil)
    }

    private static func messages(
        for result: GatewayTailscaleApplyResult,
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool) -> GatewayTailscaleApplyMessages
    {
        guard result.didApply else {
            return GatewayTailscaleApplyMessages(
                statusMessage: nil,
                validationMessage: nil,
                shouldRecordSuccess: false,
                shouldRestartGateway: false)
        }

        if let validationMessage = result.validationMessage {
            return GatewayTailscaleApplyMessages(
                statusMessage: nil,
                validationMessage: validationMessage,
                shouldRecordSuccess: false,
                shouldRestartGateway: false)
        }

        if !result.success, let errorMessage = result.errorMessage {
            return GatewayTailscaleApplyMessages(
                statusMessage: errorMessage,
                validationMessage: nil,
                shouldRecordSuccess: false,
                shouldRestartGateway: false)
        }

        let statusMessage = if connectionMode == .local, !isPaused {
            "Saved to ~/.openclaw/openclaw.json. Restarting gateway…"
        } else {
            "Saved to ~/.openclaw/openclaw.json. Restart the gateway to apply."
        }
        return GatewayTailscaleApplyMessages(
            statusMessage: statusMessage,
            validationMessage: nil,
            shouldRecordSuccess: true,
            shouldRestartGateway: true)
    }

    @MainActor
    private static func saveTailscaleSettings(
        settings: GatewayTailscaleSettingsSnapshot,
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool) async -> (Bool, String?)
    {
        await self.buildAndSaveTailscaleConfig(
            tailscaleMode: settings.mode,
            requireCredentialsForServe: settings.requireCredentialsForServe,
            password: settings.password,
            connectionMode: connectionMode,
            isPaused: isPaused)
    }

    private func startStatusTimer() {
        self.stopStatusTimer()
        if ProcessInfo.processInfo.isRunningTests {
            return
        }
        self.statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { await self.effectiveService.checkTailscaleStatus() }
        }
    }

    private func stopStatusTimer() {
        self.statusTimer?.invalidate()
        self.statusTimer = nil
    }
}

#if DEBUG
extension TailscaleIntegrationSection {
    mutating func setTestingState(
        mode: String,
        requireCredentials: Bool,
        password: String = "secret",
        statusMessage: String? = nil,
        validationMessage: String? = nil)
    {
        if let mode = GatewayTailscaleMode(rawValue: mode) {
            self.tailscaleMode = mode
        }
        self.requireCredentialsForServe = requireCredentials
        self.password = password
        self.statusMessage = statusMessage
        self.validationMessage = validationMessage
    }

    mutating func setTestingService(_ service: TailscaleService?) {
        self.testingService = service
    }

    static func simulateHydrationApplyForTesting(
        root: [String: Any],
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool,
        saveRoot: @MainActor @Sendable @escaping ([String: Any]) -> Void) async
    {
        let loaded = self.loadedSettings(from: root)
        _ = await self.applySettingsIfChanged(
            currentSettings: loaded.snapshot,
            lastAppliedSettings: loaded.snapshot,
            connectionMode: connectionMode,
            isPaused: isPaused,
            saveSettings: { settings, _, _ in
                let nextRoot = self.buildTailscaleConfigRoot(root: root, settings: settings)
                saveRoot(nextRoot)
                return (true, nil)
            })
    }

    static func messagesForTesting(
        didApply: Bool,
        success: Bool,
        errorMessage: String? = nil,
        validationMessage: String? = nil,
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool) -> (
        statusMessage: String?,
        validationMessage: String?,
        shouldRecordSuccess: Bool,
        shouldRestartGateway: Bool)
    {
        let messages = self.messages(
            for: GatewayTailscaleApplyResult(
                didApply: didApply,
                success: success,
                errorMessage: errorMessage,
                validationMessage: validationMessage),
            connectionMode: connectionMode,
            isPaused: isPaused)
        return (
            statusMessage: messages.statusMessage,
            validationMessage: messages.validationMessage,
            shouldRecordSuccess: messages.shouldRecordSuccess,
            shouldRestartGateway: messages.shouldRestartGateway)
    }
}
#endif
