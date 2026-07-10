import Foundation
import OSLog

enum NodeServiceManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "node.service")

    static func start() async -> String? {
        let result = await self.runServiceCommandResult(
            ["start"],
            timeout: 20,
            quiet: false)
        if let error = self.errorMessage(from: result, treatNotLoadedAsError: true) {
            self.logger.error("node service start failed: \(error, privacy: .public)")
            return error
        }
        return nil
    }

    static func stop() async -> String? {
        let result = await self.runServiceCommandResult(
            ["stop"],
            timeout: 15,
            quiet: false)
        if let error = self.errorMessage(from: result, treatNotLoadedAsError: false) {
            self.logger.error("node service stop failed: \(error, privacy: .public)")
            return error
        }
        return nil
    }
}

extension NodeServiceManager {
    private static func serviceCommand(_ args: [String]) -> [String] {
        CommandResolver.openclawCommand(
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
        let command = self.serviceCommand(args)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: timeout)
        let parsed = self.parseServiceJson(from: response.stdout) ?? self.parseServiceJson(from: response.stderr)
        let ok = parsed?.ok
        let message = parsed?.error ?? parsed?.message
        let payload = parsed?.text.data(using: .utf8)
            ?? (response.stdout.isEmpty ? response.stderr : response.stdout).data(using: .utf8)
        let success = ok ?? response.success
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

    private static func summarize(_ text: String) -> String? {
        TextSummarySupport.summarizeLastLine(text)
    }
}

#if DEBUG
extension NodeServiceManager {
    static func _testServiceCommand(_ args: [String]) -> [String] {
        self.serviceCommand(args)
    }
}
#endif
