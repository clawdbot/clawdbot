import Foundation
import OSLog

enum NodeServiceManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "node.service")
    private static let lifecycleQueue = LifecycleQueue()
    private static var launchdPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(nodeLaunchdLabel).plist")
    }

    static func start(profile: AppProfile = .current) async -> String? {
        await self.lifecycleQueue.run("start", profile: profile)
    }

    static func stop(profile: AppProfile = .current) async -> String? {
        await self.lifecycleQueue.run("stop", profile: profile)
    }

    static func restart(profile: AppProfile = .current) async -> String? {
        await self.lifecycleQueue.run("restart", profile: profile)
    }

    /// Empty means no node LaunchAgent. Nil means the on-disk ownership proof
    /// exists but could not be read, so callers must not treat it as external.
    static func launchdProgramArguments(profile: AppProfile = .current) -> [String]? {
        if self.skipUnderProfile(profile, action: "status") { return [] }
        return self.launchdProgramArguments(
            plistURL: self.launchdPlistURL,
            fileManager: .default)
    }

    static func waitUntilRunning(profile: AppProfile = .current) async -> Bool {
        if self.skipUnderProfile(profile, action: "status poll") { return false }
        var consecutiveRunningChecks = 0
        for attempt in 0..<20 {
            let result = await self.runServiceCommandResult(
                ["status"],
                timeout: 10,
                quiet: true)
            if result.success,
               let object = result.parsed?.object,
               self.runtimeIsRunning(in: object)
            {
                consecutiveRunningChecks += 1
                if consecutiveRunningChecks == 2 { return true }
            } else {
                consecutiveRunningChecks = 0
            }
            if attempt < 19 {
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        return false
    }
}

extension NodeServiceManager {
    private actor LifecycleQueue {
        private var tail: Task<String?, Never>?

        func run(_ action: String, profile: AppProfile) async -> String? {
            if NodeServiceManager.skipUnderProfile(profile, action: action) { return nil }
            let predecessor = self.tail
            let task = Task<String?, Never> {
                _ = await predecessor?.value
                let result = await NodeServiceManager.runServiceCommandResult(
                    [action],
                    timeout: action == "stop" ? 15 : 20,
                    quiet: false)
                guard let error = NodeServiceManager.errorMessage(
                    from: result,
                    treatNotLoadedAsError: action != "stop")
                else { return nil }
                NodeServiceManager.logger.error(
                    "node service \(action, privacy: .public) failed: \(error, privacy: .public)")
                return error
            }
            self.tail = task
            return await task.value
        }
    }

    private static func skipUnderProfile(_ profile: AppProfile, action: String) -> Bool {
        guard profile.isActive else { return false }
        self.logger.info("node service \(action, privacy: .public) skipped (unavailable under app profile)")
        return true
    }

    private static func serviceCommand(_ args: [String]) async -> [String] {
        await CommandResolver.openclawCommand(
            subcommand: "node",
            extraArgs: self.withJsonFlag(args),
            // Service management must always run locally, even if remote mode is configured.
            configRoot: ["gateway": ["mode": "local"]])
    }

    private struct CommandResult {
        let success: Bool
        let payload: Data?
        let message: String?
        let parsed: ParsedServiceJson?
    }

    private struct ParsedServiceJson {
        let text: String
        let object: [String: Any]
        let ok: Bool?
        let result: String?
        let message: String?
        let error: String?
        let hints: [String]
    }

    private static func runServiceCommandResult(
        _ args: [String],
        timeout: Double,
        quiet: Bool) async -> CommandResult
    {
        #if DEBUG
        self.testingServiceCommandCalls.append(args)
        #endif
        let command = await self.serviceCommand(args)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: timeout)
        let parsed = self.parseServiceJson(from: response.stdout) ?? self.parseServiceJson(from: response.stderr)
        let ok = parsed?.ok
        let message = parsed?.error ?? parsed?.message
        let payload = parsed?.text.data(using: .utf8)
            ?? (response.stdout.isEmpty ? response.stderr : response.stdout).data(using: .utf8)
        let success = response.success && (ok ?? true)
        if success {
            return CommandResult(success: true, payload: payload, message: nil, parsed: parsed)
        }

        if quiet {
            return CommandResult(success: false, payload: payload, message: message, parsed: parsed)
        }

        let detail = message ?? self.summarize(response.stderr) ?? self.summarize(response.stdout)
        let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
        let fullMessage = detail.map { "Node service command failed (\(exit)): \($0)" }
            ?? "Node service command failed (\(exit))"
        self.logger.error("\(fullMessage, privacy: .public)")
        return CommandResult(success: false, payload: payload, message: detail, parsed: parsed)
    }

    private static func errorMessage(from result: CommandResult, treatNotLoadedAsError: Bool) -> String? {
        if !result.success {
            return result.message ?? "Node service command failed"
        }
        guard let parsed = result.parsed else { return nil }
        if parsed.ok == false {
            return self.mergeHints(message: parsed.error ?? parsed.message, hints: parsed.hints)
        }
        if treatNotLoadedAsError, parsed.result == "not-loaded" {
            let base = parsed.message ?? "Node service not loaded."
            return self.mergeHints(message: base, hints: parsed.hints)
        }
        return nil
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    private static func parseServiceJson(from raw: String) -> ParsedServiceJson? {
        guard let parsed = JSONObjectExtractionSupport.extract(from: raw) else { return nil }
        let jsonText = parsed.text
        let object = parsed.object
        let ok = object["ok"] as? Bool
        let result = object["result"] as? String
        let message = object["message"] as? String
        let error = object["error"] as? String
        let hints = (object["hints"] as? [String]) ?? []
        return ParsedServiceJson(
            text: jsonText,
            object: object,
            ok: ok,
            result: result,
            message: message,
            error: error,
            hints: hints)
    }

    private static func mergeHints(message: String?, hints: [String]) -> String? {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmpty = trimmed?.isEmpty == false ? trimmed : nil
        guard !hints.isEmpty else { return nonEmpty }
        let hintText = hints.prefix(2).joined(separator: " · ")
        if let nonEmpty {
            return "\(nonEmpty) (\(hintText))"
        }
        return hintText
    }

    private static func launchdProgramArguments(
        plistURL: URL,
        fileManager: FileManager) -> [String]?
    {
        #if DEBUG
        self.testingOwnershipReadCount += 1
        #endif
        guard fileManager.fileExists(atPath: plistURL.path) else { return [] }
        return LaunchAgentPlist.snapshot(url: plistURL)?.programArguments
    }

    private static func runtimeIsRunning(in object: [String: Any]) -> Bool {
        guard let service = object["service"] as? [String: Any],
              service["loaded"] as? Bool == true,
              let runtime = service["runtime"] as? [String: Any]
        else { return false }
        return runtime["status"] as? String == "running"
    }

    private static func summarize(_ text: String) -> String? {
        TextSummarySupport.summarizeLastLine(text)
    }
}

#if DEBUG
extension NodeServiceManager {
    private nonisolated(unsafe) static var testingServiceCommandCalls: [[String]] = []
    private nonisolated(unsafe) static var testingOwnershipReadCount = 0

    static func _testResetPersistentServiceCalls() {
        self.testingServiceCommandCalls = []
        self.testingOwnershipReadCount = 0
    }

    static func _testPersistentServiceCallSnapshot() -> (commands: [[String]], ownershipReads: Int) {
        (self.testingServiceCommandCalls, self.testingOwnershipReadCount)
    }

    static func _testServiceCommand(_ args: [String]) async -> [String] {
        await self.serviceCommand(args)
    }

    static func _testLaunchdProgramArguments(plistURL: URL) -> [String]? {
        self.launchdProgramArguments(plistURL: plistURL, fileManager: .default)
    }

    static func _testRuntimeIsRunning(fromJSON json: String) -> Bool {
        guard let object = JSONObjectExtractionSupport.extract(from: json)?.object else { return false }
        return self.runtimeIsRunning(in: object)
    }
}
#endif
