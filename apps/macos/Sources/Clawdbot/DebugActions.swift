import AppKit
import Foundation
import SwiftUI

enum DebugActions {
    private static let verboseDefaultsKey = "clawdbot.debug.verboseMain"
    private static let sessionMenuLimit = 12
    private static let onboardingSeenKey = "clawdbot.onboardingSeen"

    @MainActor
    static func openAgentEventsWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Agent Events"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AgentEventsWindow())
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor
    static func openLog() {
        let path = self.pinoLogPath()
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            let alert = NSAlert()
            alert.messageText = "Log file not found"
            alert.informativeText = path
            alert.runModal()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @MainActor
    static func openConfigFolder() {
        let url = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdbot", isDirectory: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @MainActor
    static func openSessionStore() {
        if AppStateStore.shared.connectionMode == .remote {
            let alert = NSAlert()
            alert.messageText = "Remote mode"
            alert.informativeText = "Session store lives on the gateway host in remote mode."
            alert.runModal()
            return
        }
        let path = self.resolveSessionStorePath()
        let url = URL(fileURLWithPath: path)
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }

    static func sendTestNotification() async {
        _ = await NotificationManager().send(title: "Clawdbot", body: "Test notification", sound: nil)
    }

    static func sendDebugVoice() async -> Result<String, DebugActionError> {
        let message = """
        This is a debug test from the Mac app. Reply with "Debug test works (and a funny pun)" \
        if you received that.
        """
        let result = await VoiceWakeForwarder.forward(transcript: message)
        switch result {
        case .success:
            return .success("Sent. Await reply.")
        case let .failure(error):
            let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure(.message("Send failed: \(detail)"))
        }
    }

    static func restartGateway() {
        Task { @MainActor in
            switch AppStateStore.shared.connectionMode {
            case .local:
                GatewayProcessManager.shared.stop()
                // Kick the control channel + health check so the UI recovers immediately.
                await GatewayConnection.shared.shutdown()
                try? await Task.sleep(nanoseconds: 300_000_000)
                GatewayProcessManager.shared.setActive(true)
                Task { try? await ControlChannel.shared.configure(mode: .local) }
                Task { await HealthStore.shared.refresh(onDemand: true) }

            case .remote:
                // In remote mode, there is no local gateway to restart. "Restart Gateway" should
                // reset the SSH control tunnel + reconnect so the menu recovers.
                await RemoteTunnelManager.shared.stopAll()
                await GatewayConnection.shared.shutdown()
                do {
                    _ = try await RemoteTunnelManager.shared.ensureControlTunnel()
                    let settings = CommandResolver.connectionSettings()
                    try await ControlChannel.shared.configure(mode: .remote(
                        target: settings.target,
                        identity: settings.identity))
                } catch {
                    // ControlChannel will surface a degraded state; also refresh health to update the menu text.
                    Task { await HealthStore.shared.refresh(onDemand: true) }
                }

            case .unconfigured:
                await GatewayConnection.shared.shutdown()
                await ControlChannel.shared.disconnect()
            }
        }
    }

    static func resetGatewayTunnel() async -> Result<String, DebugActionError> {
        let mode = CommandResolver.connectionSettings().mode
        guard mode == .remote else {
            return .failure(.message("Remote mode is not enabled."))
        }
        await RemoteTunnelManager.shared.stopAll()
        await GatewayConnection.shared.shutdown()
        do {
            _ = try await RemoteTunnelManager.shared.ensureControlTunnel()
            let settings = CommandResolver.connectionSettings()
            try await ControlChannel.shared.configure(mode: .remote(
                target: settings.target,
                identity: settings.identity))
            await HealthStore.shared.refresh(onDemand: true)
            return .success("SSH tunnel reset.")
        } catch {
            Task { await HealthStore.shared.refresh(onDemand: true) }
            return .failure(.message(error.localizedDescription))
        }
    }

    static func pinoLogPath() -> String {
        LogLocator.bestLogFile()?.path ?? LogLocator.launchdLogPath
    }

    @MainActor
    static func runHealthCheckNow() async {
        await HealthStore.shared.refresh(onDemand: true)
    }

    static func sendTestHeartbeat() async -> Result<ControlHeartbeatEvent?, Error> {
        do {
            _ = await GatewayConnection.shared.setHeartbeatsEnabled(true)
            await ControlChannel.shared.configure()
            let data = try await ControlChannel.shared.request(method: "last-heartbeat")
            if let evt = try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data) {
                return .success(evt)
            }
            return .success(nil)
        } catch {
            return .failure(error)
        }
    }

    static var verboseLoggingEnabledMain: Bool {
        UserDefaults.standard.bool(forKey: self.verboseDefaultsKey)
    }

    static func toggleVerboseLoggingMain() async -> Bool {
        let newValue = !self.verboseLoggingEnabledMain
        UserDefaults.standard.set(newValue, forKey: self.verboseDefaultsKey)
        _ = try? await ControlChannel.shared.request(
            method: "system-event",
            params: ["text": AnyHashable("verbose-main:\(newValue ? "on" : "off")")])
        return newValue
    }

    @MainActor
    static func restartApp() {
        let url = Bundle.main.bundleURL
        let task = Process()
        // Relaunch shortly after this instance exits so we get a true restart even in debug.
        task.launchPath = "/bin/sh"
        task.arguments = ["-c", "sleep 0.2; open -n \"$1\"", "_", url.path]
        try? task.run()
        NSApp.terminate(nil)
    }

    @MainActor
    static func restartOnboarding() {
        UserDefaults.standard.set(false, forKey: self.onboardingSeenKey)
        UserDefaults.standard.set(0, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = false
        OnboardingController.shared.restart()
    }

    @MainActor
    private static func resolveSessionStorePath() -> String {
        let defaultPath = SessionLoader.defaultStorePath
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdbot/clawdbot.json")
        guard
            let data = try? Data(contentsOf: configURL),
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let session = parsed["session"] as? [String: Any],
            let path = session["store"] as? String,
            !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return defaultPath
        }
        return path
    }

    // MARK: - Sessions (thinking / verbose)

    static func recentSessions(limit: Int = sessionMenuLimit) async -> [SessionRow] {
        guard let snapshot = try? await SessionLoader.loadSnapshot(limit: limit) else { return [] }
        return Array(snapshot.rows.prefix(limit))
    }

    static func updateSession(
        key: String,
        thinking: String?,
        verbose: String?) async throws
    {
        var params: [String: AnyHashable] = ["key": AnyHashable(key)]
        params["thinkingLevel"] = thinking.map(AnyHashable.init) ?? AnyHashable(NSNull())
        params["verboseLevel"] = verbose.map(AnyHashable.init) ?? AnyHashable(NSNull())
        _ = try await ControlChannel.shared.request(method: "sessions.patch", params: params)
    }

    // MARK: - Port diagnostics

    typealias PortListener = PortGuardian.ReportListener
    typealias PortReport = PortGuardian.PortReport

    static func checkGatewayPorts() async -> [PortReport] {
        let mode = CommandResolver.connectionSettings().mode
        return await PortGuardian.shared.diagnose(mode: mode)
    }

    static func killProcess(_ pid: Int) async -> Result<Void, DebugActionError> {
        let primary = await ShellExecutor.run(command: ["kill", "-TERM", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if primary.ok { return .success(()) }
        let force = await ShellExecutor.run(command: ["kill", "-KILL", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if force.ok { return .success(()) }
        let detail = force.message ?? primary.message ?? "kill failed"
        return .failure(.message(detail))
    }

    @MainActor
    static func openSessionStoreInCode() {
        let path = SessionLoader.defaultStorePath
        let proc = Process()
        proc.launchPath = "/usr/bin/env"
        proc.arguments = ["code", path]
        try? proc.run()
    }
}

enum DebugActionError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case let .message(text):
            text
        }
    }
}
