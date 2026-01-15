import AppKit
import AVFoundation
import Foundation
import Observation
import SwiftUI

/// Menu contents for the Clawdbot menu bar extra.
struct MenuContent: View {
    @Bindable var state: AppState
    let updater: UpdaterProviding?
    @Bindable private var updateStatus: UpdateStatus
    private let gatewayManager = GatewayProcessManager.shared
    private let healthStore = HealthStore.shared
    private let heartbeatStore = HeartbeatStore.shared
    private let controlChannel = ControlChannel.shared
    private let activityStore = WorkActivityStore.shared
    @Bindable private var pairingPrompter = NodePairingApprovalPrompter.shared
    @Environment(\.openSettings) private var openSettings
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false
    @State private var micObserver = AudioInputDeviceObserver()
    @State private var micRefreshTask: Task<Void, Never>?
    @State private var browserControlEnabled = true
    @AppStorage(cameraEnabledKey) private var cameraEnabled: Bool = false
    @AppStorage(appLogLevelKey) private var appLogLevelRaw: String = AppLogLevel.default.rawValue
    @AppStorage(debugFileLogEnabledKey) private var appFileLoggingEnabled: Bool = false

    init(state: AppState, updater: UpdaterProviding?) {
        self._state = Bindable(wrappedValue: state)
        self.updater = updater
        self._updateStatus = Bindable(wrappedValue: updater?.updateStatus ?? UpdateStatus.disabled)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.activeBinding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.connectionLabel)
                    self.statusLine(label: self.healthStatus.label, color: self.healthStatus.color)
                    if self.pairingPrompter.pendingCount > 0 {
                        let repairCount = self.pairingPrompter.pendingRepairCount
                        let repairSuffix = repairCount > 0 ? " · \(repairCount) repair" : ""
                        self.statusLine(
                            label: "Pairing approval pending (\(self.pairingPrompter.pendingCount))\(repairSuffix)",
                            color: .orange)
                    }
                }
            }
            .disabled(self.state.connectionMode == .unconfigured)

            Divider()
            Toggle(isOn: self.heartbeatsBinding) {
                HStack(spacing: 8) {
                    Label("Send Heartbeats", systemImage: "waveform.path.ecg")
                    Spacer(minLength: 0)
                    self.statusLine(label: self.heartbeatStatus.label, color: self.heartbeatStatus.color)
                }
            }
            Toggle(
                isOn: Binding(
                    get: { self.browserControlEnabled },
                    set: { enabled in
                        self.browserControlEnabled = enabled
                        Task { await self.saveBrowserControlEnabled(enabled) }
                    })) {
                Label("Browser Control", systemImage: "globe")
            }
            Toggle(isOn: self.$cameraEnabled) {
                Label("Allow Camera", systemImage: "camera")
            }
            Toggle(isOn: Binding(get: { self.state.canvasEnabled }, set: { self.state.canvasEnabled = $0 })) {
                Label("Allow Canvas", systemImage: "rectangle.and.pencil.and.ellipsis")
            }
            .onChange(of: self.state.canvasEnabled) { _, enabled in
                if !enabled {
                    CanvasManager.shared.hideAll()
                }
            }
            Toggle(isOn: self.voiceWakeBinding) {
                Label("Voice Wake", systemImage: "mic.fill")
            }
            .disabled(!voiceWakeSupported)
            .opacity(voiceWakeSupported ? 1 : 0.5)
            if self.showVoiceWakeMicPicker {
                self.voiceWakeMicMenu
            }
            Divider()
            Button {
                Task { @MainActor in
                    await self.openDashboard()
                }
            } label: {
                Label("Open Dashboard", systemImage: "gauge")
            }
            Button {
                Task { @MainActor in
                    let sessionKey = await WebChatManager.shared.preferredSessionKey()
                    WebChatManager.shared.show(sessionKey: sessionKey)
                }
            } label: {
                Label("Open Chat", systemImage: "bubble.left.and.bubble.right")
            }
            if self.state.canvasEnabled {
                Button {
                    Task { @MainActor in
                        if self.state.canvasPanelVisible {
                            CanvasManager.shared.hideAll()
                        } else {
                            let sessionKey = await GatewayConnection.shared.mainSessionKey()
                            // Don't force a navigation on re-open: preserve the current web view state.
                            _ = try? CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
                        }
                    }
                } label: {
                    Label(
                        self.state.canvasPanelVisible ? "Close Canvas" : "Open Canvas",
                        systemImage: "rectangle.inset.filled.on.rectangle")
                }
            }
            Button {
                Task { await self.state.setTalkEnabled(!self.state.talkEnabled) }
            } label: {
                Label(self.state.talkEnabled ? "Stop Talk Mode" : "Talk Mode", systemImage: "waveform.circle.fill")
            }
            .disabled(!voiceWakeSupported)
            .opacity(voiceWakeSupported ? 1 : 0.5)
            Divider()
            Button("Settings…") { self.open(tab: .general) }
                .keyboardShortcut(",", modifiers: [.command])
            self.debugMenu
            Button("About Clawdbot") { self.open(tab: .about) }
            if let updater, updater.isAvailable, self.updateStatus.isUpdateReady {
                Button("Update ready, restart now?") { updater.checkForUpdates(nil) }
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .task(id: self.state.swabbleEnabled) {
            if self.state.swabbleEnabled {
                await self.loadMicrophones(force: true)
            }
        }
        .task {
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && self.state.voicePushToTalkEnabled)
        }
        .onChange(of: self.state.voicePushToTalkEnabled) { _, enabled in
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && enabled)
        }
        .task(id: self.state.connectionMode) {
            await self.loadBrowserControlEnabled()
        }
        .onAppear {
            self.startMicObserver()
        }
        .onDisappear {
            self.micRefreshTask?.cancel()
            self.micRefreshTask = nil
            self.micObserver.stop()
        }
        .task { @MainActor in
            SettingsWindowOpener.shared.register(openSettings: self.openSettings)
        }
    }

    private var connectionLabel: String {
        switch self.state.connectionMode {
        case .unconfigured:
            "Clawdbot Not Configured"
        case .remote:
            "Remote Clawdbot Active"
        case .local:
            "Clawdbot Active"
        }
    }

    private func loadBrowserControlEnabled() async {
        let root = await ConfigStore.load()
        let browser = root["browser"] as? [String: Any]
        let enabled = browser?["enabled"] as? Bool ?? true
        await MainActor.run { self.browserControlEnabled = enabled }
    }

    private func saveBrowserControlEnabled(_ enabled: Bool) async {
        let (success, _) = await MenuContent.buildAndSaveBrowserEnabled(enabled)

        if !success {
            await self.loadBrowserControlEnabled()
        }
    }

    @MainActor
    private static func buildAndSaveBrowserEnabled(_ enabled: Bool) async -> (Bool, ()) {
        var root = await ConfigStore.load()
        var browser = root["browser"] as? [String: Any] ?? [:]
        browser["enabled"] = enabled
        root["browser"] = browser
        do {
            try await ConfigStore.save(root)
            return (true, ())
        } catch {
            return (false, ())
        }
    }

    @ViewBuilder
    private var debugMenu: some View {
        if self.state.debugPaneEnabled {
            Menu("Debug") {
                Button {
                    DebugActions.openConfigFolder()
                } label: {
                    Label("Open Config Folder", systemImage: "folder")
                }
                Button {
                    Task { await DebugActions.runHealthCheckNow() }
                } label: {
                    Label("Run Health Check Now", systemImage: "stethoscope")
                }
                Button {
                    Task { _ = await DebugActions.sendTestHeartbeat() }
                } label: {
                    Label("Send Test Heartbeat", systemImage: "waveform.path.ecg")
                }
                if self.state.connectionMode == .remote {
                    Button {
                        Task { @MainActor in
                            let result = await DebugActions.resetGatewayTunnel()
                            self.presentDebugResult(result, title: "Remote Tunnel")
                        }
                    } label: {
                        Label("Reset Remote Tunnel", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                Button {
                    Task { _ = await DebugActions.toggleVerboseLoggingMain() }
                } label: {
                    Label(
                        DebugActions.verboseLoggingEnabledMain
                            ? "Verbose Logging (Main): On"
                            : "Verbose Logging (Main): Off",
                        systemImage: "text.alignleft")
                }
                Menu {
                    Picker("Verbosity", selection: self.$appLogLevelRaw) {
                        ForEach(AppLogLevel.allCases) { level in
                            Text(level.title).tag(level.rawValue)
                        }
                    }
                    Toggle(isOn: self.$appFileLoggingEnabled) {
                        Label(
                            self.appFileLoggingEnabled
                                ? "File Logging: On"
                                : "File Logging: Off",
                            systemImage: "doc.text.magnifyingglass")
                    }
                } label: {
                    Label("App Logging", systemImage: "doc.text")
                }
                Button {
                    DebugActions.openSessionStore()
                } label: {
                    Label("Open Session Store", systemImage: "externaldrive")
                }
                Divider()
                Button {
                    DebugActions.openAgentEventsWindow()
                } label: {
                    Label("Open Agent Events…", systemImage: "bolt.horizontal.circle")
                }
                Button {
                    DebugActions.openLog()
                } label: {
                    Label("Open Log", systemImage: "doc.text.magnifyingglass")
                }
                Button {
                    Task { _ = await DebugActions.sendDebugVoice() }
                } label: {
                    Label("Send Debug Voice Text", systemImage: "waveform.circle")
                }
                Button {
                    Task { await DebugActions.sendTestNotification() }
                } label: {
                    Label("Send Test Notification", systemImage: "bell")
                }
                Divider()
                if self.state.connectionMode == .local {
                    Button {
                        DebugActions.restartGateway()
                    } label: {
                        Label("Restart Gateway", systemImage: "arrow.clockwise")
                    }
                }
                Button {
                    DebugActions.restartOnboarding()
                } label: {
                    Label("Restart Onboarding", systemImage: "arrow.counterclockwise")
                }
                Button {
                    DebugActions.restartApp()
                } label: {
                    Label("Restart App", systemImage: "arrow.triangle.2.circlepath")
                }
            }
        }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .clawdbotSelectSettingsTab, object: tab)
        }
    }

    @MainActor
    private func openDashboard() async {
        do {
            let config = try await GatewayEndpointStore.shared.requireConfig()
            let url = try GatewayEndpointStore.dashboardURL(for: config)
            NSWorkspace.shared.open(url)
        } catch {
            let alert = NSAlert()
            alert.messageText = "Dashboard unavailable"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    private var healthStatus: (label: String, color: Color) {
        if let activity = self.activityStore.current {
            let color: Color = activity.role == .main ? .accentColor : .gray
            let roleLabel = activity.role == .main ? "Main" : "Other"
            let text = "\(roleLabel) · \(activity.label)"
            return (text, color)
        }

        let health = self.healthStore.state
        let isRefreshing = self.healthStore.isRefreshing
        let lastAge = self.healthStore.lastSuccess.map { age(from: $0) }

        if isRefreshing {
            return ("Health check running…", health.tint)
        }

        switch health {
        case .ok:
            let ageText = lastAge.map { " · checked \($0)" } ?? ""
            return ("Health ok\(ageText)", .green)
        case .linkingNeeded:
            return ("Health: login required", .red)
        case let .degraded(reason):
            let detail = HealthStore.shared.degradedSummary ?? reason
            let ageText = lastAge.map { " · checked \($0)" } ?? ""
            return ("\(detail)\(ageText)", .orange)
        case .unknown:
            return ("Health pending", .secondary)
        }
    }

    private var heartbeatStatus: (label: String, color: Color) {
        if case .degraded = self.controlChannel.state {
            return ("Control channel disconnected", .red)
        } else if let evt = self.heartbeatStore.lastEvent {
            let ageText = age(from: Date(timeIntervalSince1970: evt.ts / 1000))
            switch evt.status {
            case "sent":
                return ("Last heartbeat sent · \(ageText)", .blue)
            case "ok-empty", "ok-token":
                return ("Heartbeat ok · \(ageText)", .green)
            case "skipped":
                return ("Heartbeat skipped · \(ageText)", .secondary)
            case "failed":
                return ("Heartbeat failed · \(ageText)", .red)
            default:
                return ("Heartbeat · \(ageText)", .secondary)
            }
        } else {
            return ("No heartbeat yet", .secondary)
        }
    }

    @ViewBuilder
    private func statusLine(label: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
        }
        .padding(.top, 2)
    }

    private var activeBinding: Binding<Bool> {
        Binding(get: { !self.state.isPaused }, set: { self.state.isPaused = !$0 })
    }

    private var heartbeatsBinding: Binding<Bool> {
        Binding(get: { self.state.heartbeatsEnabled }, set: { self.state.heartbeatsEnabled = $0 })
    }

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
    }

    private var showVoiceWakeMicPicker: Bool {
        voiceWakeSupported && self.state.swabbleEnabled
    }

    private var voiceWakeMicMenu: some View {
        Menu {
            self.microphoneMenuItems

            if self.loadingMics {
                Divider()
                Label("Refreshing microphones…", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.titleOnly)
                    .foregroundStyle(.secondary)
                    .disabled(true)
            }
        } label: {
            HStack {
                Text("Microphone")
                Spacer()
                Text(self.selectedMicLabel)
                    .foregroundStyle(.secondary)
            }
        }
        .task { await self.loadMicrophones() }
    }

    private var selectedMicLabel: String {
        if self.state.voiceWakeMicID.isEmpty { return self.defaultMicLabel }
        if let match = self.availableMics.first(where: { $0.uid == self.state.voiceWakeMicID }) {
            return match.name
        }
        if !self.state.voiceWakeMicName.isEmpty { return self.state.voiceWakeMicName }
        return "Unavailable"
    }

    private var microphoneMenuItems: some View {
        Group {
            if self.isSelectedMicUnavailable {
                Label("Disconnected (using System default)", systemImage: "exclamationmark.triangle")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.secondary)
                    .disabled(true)
                Divider()
            }
            Button {
                self.state.voiceWakeMicID = ""
                self.state.voiceWakeMicName = ""
            } label: {
                Label(self.defaultMicLabel, systemImage: self.state.voiceWakeMicID.isEmpty ? "checkmark" : "")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)

            ForEach(self.availableMics) { mic in
                Button {
                    self.state.voiceWakeMicID = mic.uid
                    self.state.voiceWakeMicName = mic.name
                } label: {
                    Label(mic.name, systemImage: self.state.voiceWakeMicID == mic.uid ? "checkmark" : "")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var isSelectedMicUnavailable: Bool {
        let selected = self.state.voiceWakeMicID
        guard !selected.isEmpty else { return false }
        return !self.availableMics.contains(where: { $0.uid == selected })
    }

    private var defaultMicLabel: String {
        if let host = Host.current().localizedName, !host.isEmpty {
            return "Auto-detect (\(host))"
        }
        return "System default"
    }

    @MainActor
    private func presentDebugResult(_ result: Result<String, DebugActionError>, title: String) {
        let alert = NSAlert()
        alert.messageText = title
        switch result {
        case let .success(message):
            alert.informativeText = message
            alert.alertStyle = .informational
        case let .failure(error):
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
        }
        alert.runModal()
    }

    @MainActor
    private func loadMicrophones(force: Bool = false) async {
        guard self.showVoiceWakeMicPicker else {
            self.availableMics = []
            self.loadingMics = false
            return
        }
        if !force, !self.availableMics.isEmpty { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        let connectedDevices = discovery.devices.filter(\.isConnected)
        self.availableMics = connectedDevices
            .sorted { lhs, rhs in
                lhs.localizedName.localizedCaseInsensitiveCompare(rhs.localizedName) == .orderedAscending
            }
            .map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.availableMics = self.filterAliveInputs(self.availableMics)
        self.updateSelectedMicName()
        self.loadingMics = false
    }

    private func startMicObserver() {
        self.micObserver.start {
            Task { @MainActor in
                self.scheduleMicRefresh()
            }
        }
    }

    @MainActor
    private func scheduleMicRefresh() {
        self.micRefreshTask?.cancel()
        self.micRefreshTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await self.loadMicrophones(force: true)
        }
    }

    private func filterAliveInputs(_ inputs: [AudioInputDevice]) -> [AudioInputDevice] {
        let aliveUIDs = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        guard !aliveUIDs.isEmpty else { return inputs }
        return inputs.filter { aliveUIDs.contains($0.uid) }
    }

    @MainActor
    private func updateSelectedMicName() {
        let selected = self.state.voiceWakeMicID
        if selected.isEmpty {
            self.state.voiceWakeMicName = ""
            return
        }
        if let match = self.availableMics.first(where: { $0.uid == selected }) {
            self.state.voiceWakeMicName = match.name
        }
    }

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String { self.uid }
    }
}
