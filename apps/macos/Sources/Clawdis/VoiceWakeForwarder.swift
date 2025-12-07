import Foundation
import OSLog

struct VoiceWakeForwardConfig: Sendable {
    let enabled: Bool
    let target: String
    let identityPath: String
    let commandTemplate: String
    let timeout: TimeInterval
}

enum VoiceWakeForwarder {
    private final class CLICache: @unchecked Sendable {
        private var value: (target: String, path: String)?
        private let lock = NSLock()

        func get() -> (target: String, path: String)? {
            self.lock.lock(); defer { self.lock.unlock() }
            return self.value
        }

        func set(_ newValue: (target: String, path: String)?) {
            self.lock.lock(); self.value = newValue; self.lock.unlock()
        }
    }

    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.forward")
    private static let cliSearchCandidates = ["clawdis-mac"] + cliHelperSearchPaths.map { "\($0)/clawdis-mac" }
    private static let cliCache = CLICache()

    static func clearCliCache() {
        self.cliCache.set(nil)
    }

    private static func cliLookupPrefix(target: String, echoPath: Bool) -> String {
        let normalizedTarget = target.trimmingCharacters(in: .whitespacesAndNewlines)
        // Use a clean, deterministic PATH so remote shells with spaces or odd entries don't break.
        let pathPrefix = "PATH=\(cliHelperSearchPaths.joined(separator: ":"))"
        let searchList = self.cliSearchCandidates.joined(separator: " ")

        var steps: [String] = [pathPrefix]

        let cached = self.cliCache.get()

        if let cached, cached.target == normalizedTarget {
            steps.append("CLI=\"\(cached.path)\"")
            steps.append("if [ ! -x \"$CLI\" ]; then CLI=\"\"; fi")
        } else {
            steps.append("CLI=\"\"")
        }

        steps.append("if [ -z \"${CLI:-}\" ]; then CLI=$(command -v clawdis-mac 2>/dev/null || true); fi")
        steps
            .append(
                "if [ -z \"${CLI:-}\" ]; then for c in \(searchList); do [ -x \"$c\" ] && CLI=\"$c\" && break; done; fi")
        steps.append("if [ -z \"${CLI:-}\" ]; then echo 'clawdis-mac missing'; exit 127; fi")

        if echoPath {
            steps.append("echo __CLI:$CLI")
        }

        return steps.joined(separator: "; ")
    }

    static func commandWithCliPath(_ command: String, target: String, echoCliPath: Bool = false) -> String {
        let rewritten: String = if command.contains("clawdis-mac") {
            command.replacingOccurrences(of: "clawdis-mac", with: "\"$CLI\"")
        } else {
            "\"$CLI\" \(command)"
        }

        return "\(self.cliLookupPrefix(target: target, echoPath: echoCliPath)); \(rewritten)"
    }

    #if DEBUG
    // Test-only helpers
    static func _testSetCliCache(target: String, path: String) {
        self.cliCache.set((target: target, path: path))
    }

    static func _testGetCliCache() -> (target: String, path: String)? {
        self.cliCache.get()
    }
    #endif

    enum VoiceWakeForwardError: LocalizedError, Equatable {
        case invalidTarget
        case launchFailed(String)
        case nonZeroExit(Int32, String)
        case cliMissingOrFailed(Int32, String)
        case disabled

        var errorDescription: String? {
            switch self {
            case .invalidTarget: return "Missing or invalid SSH target"
            case let .launchFailed(message): return "ssh failed to start: \(message)"
            case let .nonZeroExit(code, output):
                let clipped = output.prefix(240)
                return clipped.isEmpty
                    ? "ssh exited with code \(code) (verify host, key, and PATH)"
                    : "ssh exited with code \(code): \(clipped)"
            case let .cliMissingOrFailed(code, output):
                let clipped = output.prefix(240)
                return clipped.isEmpty
                    ? "clawdis-mac failed on remote (code \(code))"
                    : "clawdis-mac failed on remote (code \(code)): \(clipped)"
            case .disabled: return "Voice wake forwarding disabled"
            }
        }
    }

    @discardableResult
    static func forward(
        transcript: String,
        config: VoiceWakeForwardConfig) async -> Result<Void, VoiceWakeForwardError>
    {
        guard config.enabled else { return .failure(.disabled) }
        let destination = config.target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = self.parse(target: destination) else {
            self.logger.error("voice wake forward skipped: host missing")
            return .failure(.invalidTarget)
        }

        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host

        var args: [String] = [
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
        ]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        if !config.identityPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let identity = config.identityPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if !FileManager.default.fileExists(atPath: identity) {
                self.logger.error("voice wake forward identity missing: \(identity, privacy: .public)")
                return .failure(.launchFailed("identity not found: \(identity)"))
            }
            args.append(contentsOf: ["-i", identity])
        }
        args.append(userHost)

        let escaped = Self.shellEscape(transcript) // single-quoted literal, safe for sh/zsh
        let templated: String = config.commandTemplate.contains("${text}")
            ? config.commandTemplate.replacingOccurrences(of: "${text}", with: "$CLAW_TEXT")
            : Self.renderedCommand(template: config.commandTemplate, transcript: transcript)
        let script = self.commandWithCliPath("CLAW_TEXT=\(escaped); \(templated)", target: destination)
        args.append(contentsOf: ["/bin/sh", "-c", script])

        let debugCmd = (["/usr/bin/ssh"] + args).joined(separator: " ")
        self.logger.info("voice wake ssh cmd=\(debugCmd, privacy: .public)")

        self.logger.info("voice wake forward starting host=\(userHost, privacy: .public)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = args

        let output = Pipe()
        process.standardOutput = output
        process.standardError = output

        do {
            try process.run()
        } catch {
            self.logger.error("voice wake forward failed to start ssh: \(error.localizedDescription, privacy: .public)")
            return .failure(.launchFailed(error.localizedDescription))
        }

        let out = await self.wait(process, timeout: config.timeout)
        if process.terminationStatus == 0 {
            self.logger.info("voice wake forward ok host=\(userHost, privacy: .public)")
            return .success(())
        }

        // surface the failure instead of being silent
        let clipped = out.isEmpty ? "(no output)" : String(out.prefix(240))
        self.logger.error(
            "voice wake forward failed exit=\(process.terminationStatus) host=\(userHost, privacy: .public) out=\(clipped, privacy: .public) cmd=\(debugCmd, privacy: .public)")
        if process.terminationStatus == 126 || process.terminationStatus == 127 {
            return .failure(.cliMissingOrFailed(process.terminationStatus, out))
        }
        return .failure(.nonZeroExit(process.terminationStatus, out))
    }

    static func checkConnection(config: VoiceWakeForwardConfig) async -> Result<Void, VoiceWakeForwardError> {
        let destination = self.sanitizedTarget(config.target)
        guard let parsed = self.parse(target: destination) else {
            return .failure(.invalidTarget)
        }

        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host

        var baseArgs: [String] = [
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "ConnectTimeout=4",
        ]
        if parsed.port > 0 { baseArgs.append(contentsOf: ["-p", String(parsed.port)]) }
        if !config.identityPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            baseArgs.append(contentsOf: ["-i", config.identityPath])
        }

        // Stage 1: plain SSH connectivity.
        var args = baseArgs
        args.append(contentsOf: [userHost, "true"])

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = args
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe

        do {
            try process.run()
        } catch {
            return .failure(.launchFailed(error.localizedDescription))
        }

        let output = await self.wait(process, timeout: 6, capturing: pipe)
        if process.terminationStatus != 0 {
            return .failure(.nonZeroExit(process.terminationStatus, output))
        }

        // Stage 2: ensure remote clawdis-mac is present and responsive.
        var checkArgs = baseArgs
        let statusCommand = self.commandWithCliPath("clawdis-mac status", target: destination, echoCliPath: true)
        checkArgs.append(contentsOf: [userHost, "/bin/sh", "-c", statusCommand])
        let checkProc = Process()
        checkProc.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        checkProc.arguments = checkArgs
        let checkPipe = Pipe()
        checkProc.standardOutput = checkPipe
        checkProc.standardError = checkPipe
        do {
            try checkProc.run()
        } catch {
            return .failure(.launchFailed(error.localizedDescription))
        }
        let statusOut = await self.wait(checkProc, timeout: 6, capturing: checkPipe)
        if checkProc.terminationStatus == 0 {
            if let cliLine = statusOut
                .split(separator: "\n")
                .last(where: { $0.hasPrefix("__CLI:") })
            {
                let path = String(cliLine.dropFirst("__CLI:".count))
                if !path.isEmpty {
                    self.cliCache.set((target: destination, path: path))
                }
            }
            return .success(())
        }
        return .failure(.cliMissingOrFailed(checkProc.terminationStatus, statusOut))
    }

    static func renderedCommand(template: String, transcript: String) -> String {
        let escaped = Self.shellEscape(transcript)
        if template.contains("${text}") {
            return template.replacingOccurrences(of: "${text}", with: escaped)
        }
        return template
    }

    static func shellEscape(_ text: String) -> String {
        // Single-quote based shell escaping.
        let replaced = text.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(replaced)'"
    }

    private static func wait(_ process: Process, timeout: TimeInterval, capturing pipe: Pipe? = nil) async -> String {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                process.waitUntilExit()
            }
            group.addTask {
                let nanos = UInt64(max(timeout, 0.1) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
                if process.isRunning {
                    process.terminate()
                }
            }
            _ = await group.next()
            group.cancelAll()
        }

        let data = try? pipe?.fileHandleForReading.readToEnd()
        let text = data.flatMap { String(data: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if process.terminationStatus != 0 {
            self.logger.debug("voice wake forward ssh exit=\(process.terminationStatus) out=\(text, privacy: .public)")
        }
        return text
    }

    static func parse(target: String) -> (user: String?, host: String, port: Int)? {
        guard !target.isEmpty else { return nil }
        var remainder = target
        if remainder.hasPrefix("ssh ") {
            remainder = remainder.replacingOccurrences(of: "ssh ", with: "")
        }
        remainder = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        var user: String?
        if let at = remainder.firstIndex(of: "@") {
            user = String(remainder[..<at])
            remainder = String(remainder[remainder.index(after: at)...])
        }

        var host = remainder
        var port = defaultVoiceWakeForwardPort
        if let colon = remainder.lastIndex(of: ":"), colon != remainder.startIndex {
            let p = String(remainder[remainder.index(after: colon)...])
            if let parsedPort = Int(p) {
                port = parsedPort
                host = String(remainder[..<colon])
            }
        }

        host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return nil }
        return (user: user?.trimmingCharacters(in: .whitespacesAndNewlines), host: host, port: port)
    }

    private static func sanitizedTarget(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("ssh ") {
            return trimmed.replacingOccurrences(of: "ssh ", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }
}
