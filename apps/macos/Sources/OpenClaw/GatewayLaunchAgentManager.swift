import Foundation

enum GatewayLaunchAgentManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.launchd")
    private static let disableLaunchAgentMarker = ".openclaw/disable-launchagent"

    private static var disableLaunchAgentMarkerURL: URL {
        #if DEBUG
        if let testingDisableLaunchAgentMarkerURL {
            return testingDisableLaunchAgentMarkerURL
        }
        #endif
        return FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(self.disableLaunchAgentMarker)
    }

    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(gatewayLaunchdLabel).plist")
    }

    private static var generatedEnvironmentDirectoryURL: URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("service-env", isDirectory: true)
    }

    static func isLaunchAgentWriteDisabled() -> Bool {
        if FileManager().fileExists(atPath: self.disableLaunchAgentMarkerURL.path) { return true }
        return false
    }

    static func applyAttachOnlyRuntimeOverride() -> String? {
        self.setLaunchAgentWriteDisabled(true)
    }

    static func setLaunchAgentWriteDisabled(_ disabled: Bool) -> String? {
        let marker = self.disableLaunchAgentMarkerURL
        if disabled {
            do {
                try FileManager().createDirectory(
                    at: marker.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                if !FileManager().fileExists(atPath: marker.path) {
                    FileManager().createFile(atPath: marker.path, contents: nil)
                }
            } catch {
                return error.localizedDescription
            }
            return nil
        }

        if FileManager().fileExists(atPath: marker.path) {
            do {
                try FileManager().removeItem(at: marker)
            } catch {
                return error.localizedDescription
            }
        }
        return nil
    }

    static func isLoaded() async -> Bool {
        guard let loaded = await self.readDaemonLoaded() else { return false }
        return loaded
    }

    static func runningGatewayPID() async -> Int32? {
        guard let service = await self.readDaemonService() else { return nil }
        return self.runningGatewayPID(from: service)
    }

    static func set(enabled: Bool, bundlePath: String, port: Int) async -> String? {
        _ = bundlePath
        guard !CommandResolver.connectionModeIsRemote() else {
            self.logger.info("launchd change skipped (remote mode)")
            return nil
        }
        if enabled, self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd enable skipped (disable marker set)")
            return nil
        }

        if enabled {
            self.logger.info("launchd enable requested via CLI port=\(port)")
            return await self.runDaemonCommand([
                "install",
                "--force",
                "--port",
                "\(port)",
                "--runtime",
                "node",
            ])
        }

        self.logger.info("launchd disable requested via CLI")
        return await self.runDaemonCommand(["uninstall"])
    }

    static func kickstart() async -> String? {
        await self.runDaemonCommand(["restart"], timeout: 20)
    }

    static func launchdConfigSnapshot() -> LaunchAgentPlistSnapshot? {
        let directory = self.generatedEnvironmentDirectoryURL
        return LaunchAgentPlist.snapshot(
            url: self.plistURL,
            generatedEnvironmentFileURL: directory.appendingPathComponent("\(gatewayLaunchdLabel).env"),
            generatedEnvironmentWrapperURL: directory.appendingPathComponent(
                "\(gatewayLaunchdLabel)-env-wrapper.sh"))
    }

    static func launchdGatewayLogPath() -> String {
        let snapshot = self.launchdConfigSnapshot()
        if let stdout = snapshot?.stdoutPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stdout.isEmpty
        {
            return stdout
        }
        if let stderr = snapshot?.stderrPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stderr.isEmpty
        {
            return stderr
        }
        return LogLocator.launchdGatewayLogPath
    }
}

extension GatewayLaunchAgentManager {
    private static func readDaemonLoaded() async -> Bool? {
        await self.readDaemonService()?["loaded"] as? Bool
    }

    private static func readDaemonService() async -> [String: Any]? {
        let result = await self.runDaemonCommandResult(
            ["status", "--json", "--no-probe"],
            timeout: 15,
            quiet: true)
        guard result.success, let payload = result.payload else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
            let service = json["service"] as? [String: Any]
        else {
            return nil
        }
        return service
    }

    private static func runningGatewayPID(from service: [String: Any]) -> Int32? {
        guard service["loaded"] as? Bool == true,
              let runtime = service["runtime"] as? [String: Any],
              runtime["status"] as? String == "running",
              let pid = runtime["pid"] as? Int,
              pid > 0,
              pid <= Int(Int32.max)
        else {
            return nil
        }
        return Int32(pid)
    }

    private struct CommandResult {
        let success: Bool
        let payload: Data?
        let message: String?
    }

    private struct ParsedDaemonJson {
        let text: String
        let object: [String: Any]
    }

    private static func runDaemonCommand(
        _ args: [String],
        timeout: Double = 15,
        quiet: Bool = false) async -> String?
    {
        let result = await self.runDaemonCommandResult(args, timeout: timeout, quiet: quiet)
        if result.success { return nil }
        return result.message ?? "Gateway daemon command failed"
    }

    private static func runDaemonCommandResult(
        _ args: [String],
        timeout: Double,
        quiet: Bool) async -> CommandResult
    {
        #if DEBUG
        if self.testingInterceptDaemonCommands {
            self.testingDaemonCommandCalls.append(args)
            return CommandResult(
                success: true,
                payload: Data("{\"ok\":true}".utf8),
                message: nil)
        }
        #endif
        let command = CommandResolver.openclawCommand(
            subcommand: "gateway",
            extraArgs: self.withJsonFlag(args),
            // Launchd management must always run locally, even if remote mode is configured.
            configRoot: ["gateway": ["mode": "local"]])
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: timeout)
        let parsed = self.parseDaemonJson(from: response.stdout) ?? self.parseDaemonJson(from: response.stderr)
        let ok = parsed?.object["ok"] as? Bool
        let message = (parsed?.object["error"] as? String) ?? (parsed?.object["message"] as? String)
        let payload = parsed?.text.data(using: .utf8)
            ?? (response.stdout.isEmpty ? response.stderr : response.stdout).data(using: .utf8)
        let success = ok ?? response.success
        if success {
            return CommandResult(success: true, payload: payload, message: nil)
        }

        if quiet {
            return CommandResult(success: false, payload: payload, message: message)
        }

        let detail = message ?? self.summarize(response.stderr) ?? self.summarize(response.stdout)
        let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
        let fullMessage = detail.map { "Gateway daemon command failed (\(exit)): \($0)" }
            ?? "Gateway daemon command failed (\(exit))"
        self.logger.error("\(fullMessage, privacy: .public)")
        return CommandResult(success: false, payload: payload, message: detail)
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    private static func parseDaemonJson(from raw: String) -> ParsedDaemonJson? {
        guard let parsed = JSONObjectExtractionSupport.extract(from: raw) else { return nil }
        return ParsedDaemonJson(text: parsed.text, object: parsed.object)
    }

    private static func summarize(_ text: String) -> String? {
        TextSummarySupport.summarizeLastLine(text)
    }

    #if DEBUG
    private nonisolated(unsafe) static var testingDisableLaunchAgentMarkerURL: URL?
    private nonisolated(unsafe) static var testingInterceptDaemonCommands = false
    private nonisolated(unsafe) static var testingDaemonCommandCalls: [[String]] = []

    static func setTestingDisableLaunchAgentMarkerURL(_ url: URL?) {
        self.testingDisableLaunchAgentMarkerURL = url
    }

    static func setTestingInterceptDaemonCommands(_ intercept: Bool) {
        self.testingInterceptDaemonCommands = intercept
    }

    static func clearTestingDaemonCommandCalls() {
        self.testingDaemonCommandCalls.removeAll(keepingCapacity: false)
    }

    static func testingDaemonCommandCallsSnapshot() -> [[String]] {
        self.testingDaemonCommandCalls
    }

    static func _testRunningGatewayPID(from json: String) -> Int32? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let service = object["service"] as? [String: Any]
        else {
            return nil
        }
        return self.runningGatewayPID(from: service)
    }
    #endif
}
