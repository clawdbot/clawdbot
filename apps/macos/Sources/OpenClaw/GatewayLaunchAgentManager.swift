import Foundation

enum GatewayLaunchAgentManager {
    struct LoadedGatewayState: Equatable, Sendable {
        let runningPID: Int32?
        let reusablePID: Int32?
    }

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

    static func reusableLoadedGatewayPID(port: Int) async -> Int32? {
        await self.loadedGatewayState(port: port).reusablePID
    }

    static func loadedGatewayState(port: Int) async -> LoadedGatewayState {
        guard let service = await self.readDaemonService() else {
            return LoadedGatewayState(runningPID: nil, reusablePID: nil)
        }
        let runningPID = self.runningGatewayPID(from: service)
        let configAudit = service["configAudit"] as? [String: Any]
        let reusablePID: Int32? = if self.configAuditAllowsReuse(configAudit),
                                     self.gatewayPort(from: service) == port
        {
            runningPID
        } else {
            nil
        }
        return LoadedGatewayState(runningPID: runningPID, reusablePID: reusablePID)
    }

    private static func configAuditAllowsReuse(_ audit: [String: Any]?) -> Bool {
        if audit?["ok"] as? Bool == true {
            return true
        }
        guard let issues = audit?["issues"] as? [[String: Any]], !issues.isEmpty else { return false }
        // The installer may require an explicit Node bin directory. Its PATH hygiene advisory
        // must not make a healthy Gateway restart into the same advisory on every app launch.
        return issues.allSatisfy { $0["code"] as? String == "gateway-path-nonminimal" }
    }

    static func runningGatewayPID() async -> Int32? {
        guard let service = await self.readDaemonService() else { return nil }
        return self.runningGatewayPID(from: service)
    }

    static func set(enabled: Bool, bundlePath: String, port: Int) async -> String? {
        _ = bundlePath
        if enabled, CommandResolver.connectionModeIsRemote() {
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
        if self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd restart skipped (disable marker set)")
            return nil
        }
        return await self.runDaemonCommand(["restart"], timeout: 20)
    }

    static func launchdConfigSnapshot() -> LaunchAgentPlistSnapshot? {
        let directory = self.generatedEnvironmentDirectoryURL
        return LaunchAgentPlist.snapshot(
            url: self.plistURL,
            generatedEnvironmentFileURL: directory.appendingPathComponent("\(gatewayLaunchdLabel).env"),
            generatedEnvironmentWrapperURL: directory.appendingPathComponent(
                "\(gatewayLaunchdLabel)-env-wrapper.sh"))
    }

    /// Empty means no Gateway LaunchAgent. Nil preserves an unreadable
    /// ownership record so update callers fail closed instead of consuming it.
    static func launchdProgramArguments() -> [String]? {
        guard FileManager.default.fileExists(atPath: self.plistURL.path) else { return [] }
        return self.launchdConfigSnapshot()?.programArguments
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

    private static func gatewayPort(from service: [String: Any]) -> Int? {
        guard let command = service["command"] as? [String: Any] else { return nil }
        if let arguments = command["programArguments"] as? [String] {
            for (index, argument) in arguments.enumerated() {
                if argument == "--port" {
                    guard arguments.indices.contains(index + 1) else { return nil }
                    return self.validGatewayPort(arguments[index + 1])
                }
                if argument.hasPrefix("--port=") {
                    return self.validGatewayPort(String(argument.dropFirst("--port=".count)))
                }
            }
        }
        let environment = command["environment"] as? [String: Any]
        return self.validGatewayPort(environment?["OPENCLAW_GATEWAY_PORT"] as? String)
    }

    private static func validGatewayPort(_ raw: String?) -> Int? {
        guard let raw,
              let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65535).contains(port)
        else {
            return nil
        }
        return port
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
            if self.testingDaemonCommandDelayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: self.testingDaemonCommandDelayNanoseconds)
            }
            let payload = if args.first == "status" {
                if self.testingDaemonStatusPayloads.isEmpty {
                    self.testingDaemonStatusPayload ?? "{\"ok\":true}"
                } else {
                    self.testingDaemonStatusPayloads.removeFirst()
                }
            } else {
                "{\"ok\":true}"
            }
            return CommandResult(
                success: true,
                payload: Data(payload.utf8),
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
    private nonisolated(unsafe) static var testingDaemonStatusPayload: String?
    private nonisolated(unsafe) static var testingDaemonStatusPayloads: [String] = []
    private nonisolated(unsafe) static var testingDaemonCommandDelayNanoseconds: UInt64 = 0

    static func setTestingDisableLaunchAgentMarkerURL(_ url: URL?) {
        self.testingDisableLaunchAgentMarkerURL = url
    }

    static func setTestingInterceptDaemonCommands(_ intercept: Bool) {
        self.testingInterceptDaemonCommands = intercept
    }

    static func setTestingDaemonStatusPayload(_ payload: String?) {
        self.testingDaemonStatusPayload = payload
        self.testingDaemonStatusPayloads = []
    }

    static func setTestingDaemonStatusPayloads(_ payloads: [String]) {
        self.testingDaemonStatusPayload = nil
        self.testingDaemonStatusPayloads = payloads
    }

    static func setTestingDaemonCommandDelayNanoseconds(_ nanoseconds: UInt64) {
        self.testingDaemonCommandDelayNanoseconds = nanoseconds
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

    static func _testLaunchdProgramArguments(plistURL: URL) -> [String]? {
        guard FileManager.default.fileExists(atPath: plistURL.path) else { return [] }
        return LaunchAgentPlist.snapshot(url: plistURL)?.programArguments
    }
    #endif
}
