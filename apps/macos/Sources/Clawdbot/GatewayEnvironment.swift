import ClawdbotIPC
import Foundation
import OSLog

// Lightweight SemVer helper (major.minor.patch only) for gateway compatibility checks.
struct Semver: Comparable, CustomStringConvertible, Sendable {
    let major: Int
    let minor: Int
    let patch: Int

    var description: String { "\(self.major).\(self.minor).\(self.patch)" }

    static func < (lhs: Semver, rhs: Semver) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        return lhs.patch < rhs.patch
    }

    static func parse(_ raw: String?) -> Semver? {
        guard let raw, !raw.isEmpty else { return nil }
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^v", with: "", options: .regularExpression)
        let parts = cleaned.split(separator: ".")
        guard parts.count >= 3,
              let major = Int(parts[0]),
              let minor = Int(parts[1])
        else { return nil }
        let patch = Int(parts[2]) ?? 0
        return Semver(major: major, minor: minor, patch: patch)
    }

    func compatible(with required: Semver) -> Bool {
        // Same major and not older than required.
        self.major == required.major && self >= required
    }
}

enum GatewayEnvironmentKind: Equatable {
    case checking
    case ok
    case missingNode
    case missingGateway
    case incompatible(found: String, required: String)
    case error(String)
}

struct GatewayEnvironmentStatus: Equatable {
    let kind: GatewayEnvironmentKind
    let nodeVersion: String?
    let gatewayVersion: String?
    let requiredGateway: String?
    let message: String

    static var checking: Self {
        .init(kind: .checking, nodeVersion: nil, gatewayVersion: nil, requiredGateway: nil, message: "Checking…")
    }
}

struct GatewayCommandResolution {
    let status: GatewayEnvironmentStatus
    let command: [String]?
}

enum GatewayEnvironment {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "gateway.env")
    private static let supportedBindModes: Set<String> = ["loopback", "tailnet", "lan", "auto"]
    private static let bundledGatewayLabel = "Bundled gateway"

    static func bundledGatewayExecutable() -> String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let path = res.appendingPathComponent("Relay/clawdbot").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    static func bundledNodeExecutable() -> String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let path = res.appendingPathComponent("Relay/node").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    static func gatewayPort() -> Int {
        if let raw = ProcessInfo.processInfo.environment["CLAWDBOT_GATEWAY_PORT"] {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if let parsed = Int(trimmed), parsed > 0 { return parsed }
        }
        if let configPort = ClawdbotConfigFile.gatewayPort(), configPort > 0 {
            return configPort
        }
        let stored = UserDefaults.standard.integer(forKey: "gatewayPort")
        return stored > 0 ? stored : 18789
    }

    static func expectedGatewayVersion() -> Semver? {
        let bundleVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return Semver.parse(bundleVersion)
    }

    // Exposed for tests so we can inject fake version checks without rewriting bundle metadata.
    static func expectedGatewayVersion(from versionString: String?) -> Semver? {
        Semver.parse(versionString)
    }

    static func check() -> GatewayEnvironmentStatus {
        let start = Date()
        defer {
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            if elapsedMs > 500 {
                self.logger.warning("gateway env check slow (\(elapsedMs, privacy: .public)ms)")
            } else {
                self.logger.debug("gateway env check ok (\(elapsedMs, privacy: .public)ms)")
            }
        }
        let expected = self.expectedGatewayVersion()

        if let bundled = self.bundledGatewayExecutable() {
            let installed = self.readGatewayVersion(binary: bundled)
            let bundledNode = self.bundledNodeExecutable()
            let bundledNodeVersion = bundledNode.flatMap { self.readNodeVersion(binary: $0) }
            if let expected, let installed, !installed.compatible(with: expected) {
                let message = self.bundledGatewayIncompatibleMessage(
                    installed: installed,
                    expected: expected)
                return GatewayEnvironmentStatus(
                    kind: .incompatible(found: installed.description, required: expected.description),
                    nodeVersion: bundledNodeVersion,
                    gatewayVersion: installed.description,
                    requiredGateway: expected.description,
                    message: message)
            }
            let gatewayVersionText = installed?.description ?? "unknown"
            return GatewayEnvironmentStatus(
                kind: .ok,
                nodeVersion: bundledNodeVersion,
                gatewayVersion: gatewayVersionText,
                requiredGateway: expected?.description,
                message: self.bundledGatewayStatusMessage(
                    gatewayVersion: gatewayVersionText,
                    nodeVersion: bundledNodeVersion))
        }

        let projectRoot = CommandResolver.projectRoot()
        let projectEntrypoint = CommandResolver.gatewayEntrypoint(in: projectRoot)

        switch RuntimeLocator.resolve(searchPaths: CommandResolver.preferredPaths()) {
        case let .failure(err):
            return GatewayEnvironmentStatus(
                kind: .missingNode,
                nodeVersion: nil,
                gatewayVersion: nil,
                requiredGateway: expected?.description,
                message: RuntimeLocator.describeFailure(err))
        case let .success(runtime):
            let gatewayBin = CommandResolver.clawdbotExecutable()

            if gatewayBin == nil, projectEntrypoint == nil {
                return GatewayEnvironmentStatus(
                    kind: .missingGateway,
                    nodeVersion: runtime.version.description,
                    gatewayVersion: nil,
                    requiredGateway: expected?.description,
                    message: "clawdbot CLI not found in PATH; install the global package.")
            }

            let installed = gatewayBin.flatMap { self.readGatewayVersion(binary: $0) }
                ?? self.readLocalGatewayVersion(projectRoot: projectRoot)

            if let expected, let installed, !installed.compatible(with: expected) {
                return GatewayEnvironmentStatus(
                    kind: .incompatible(found: installed.description, required: expected.description),
                    nodeVersion: runtime.version.description,
                    gatewayVersion: installed.description,
                    requiredGateway: expected.description,
                    message: """
                    Gateway version \(installed.description) is incompatible with app \(expected.description);
                    install or update the global package.
                    """)
            }

            let gatewayLabel = gatewayBin != nil ? "global" : "local"
            let gatewayVersionText = installed?.description ?? "unknown"
            // Avoid repeating "(local)" twice; if using the local entrypoint, show the path once.
            let localPathHint = gatewayBin == nil && projectEntrypoint != nil
                ? " (local: \(projectEntrypoint ?? "unknown"))"
                : ""
            let gatewayLabelText = gatewayBin != nil
                ? "(\(gatewayLabel))"
                : localPathHint.isEmpty ? "(\(gatewayLabel))" : localPathHint
            return GatewayEnvironmentStatus(
                kind: .ok,
                nodeVersion: runtime.version.description,
                gatewayVersion: gatewayVersionText,
                requiredGateway: expected?.description,
                message: "Node \(runtime.version.description); gateway \(gatewayVersionText) \(gatewayLabelText)")
        }
    }

    static func resolveGatewayCommand() -> GatewayCommandResolution {
        let start = Date()
        defer {
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            if elapsedMs > 500 {
                self.logger.warning("gateway command resolve slow (\(elapsedMs, privacy: .public)ms)")
            } else {
                self.logger.debug("gateway command resolve ok (\(elapsedMs, privacy: .public)ms)")
            }
        }
        let projectRoot = CommandResolver.projectRoot()
        let projectEntrypoint = CommandResolver.gatewayEntrypoint(in: projectRoot)
        let status = self.check()
        let gatewayBin = CommandResolver.clawdbotExecutable()
        let bundled = self.bundledGatewayExecutable()
        let runtime = RuntimeLocator.resolve(searchPaths: CommandResolver.preferredPaths())

        guard case .ok = status.kind else {
            return GatewayCommandResolution(status: status, command: nil)
        }

        let port = self.gatewayPort()
        if let bundled {
            let bind = self.preferredGatewayBind() ?? "loopback"
            let cmd = [bundled, "gateway-daemon", "--port", "\(port)", "--bind", bind]
            return GatewayCommandResolution(status: status, command: cmd)
        }
        if let gatewayBin {
            let cmd = [gatewayBin, "gateway", "--port", "\(port)"]
            return GatewayCommandResolution(status: status, command: cmd)
        }

        if let entry = projectEntrypoint,
           case let .success(resolvedRuntime) = runtime
        {
            let cmd = [resolvedRuntime.path, entry, "gateway", "--port", "\(port)"]
            return GatewayCommandResolution(status: status, command: cmd)
        }

        return GatewayCommandResolution(status: status, command: nil)
    }

    private static func preferredGatewayBind() -> String? {
        if CommandResolver.connectionModeIsRemote() {
            return nil
        }
        if let env = ProcessInfo.processInfo.environment["CLAWDBOT_GATEWAY_BIND"] {
            let trimmed = env.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }

        let root = ClawdbotConfigFile.loadDict()
        if let gateway = root["gateway"] as? [String: Any],
           let bind = gateway["bind"] as? String
        {
            let trimmed = bind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }

        return nil
    }

    static func installGlobal(version: Semver?, statusHandler: @escaping @Sendable (String) -> Void) async {
        let preferred = CommandResolver.preferredPaths().joined(separator: ":")
        let target = version?.description ?? "latest"
        let npm = CommandResolver.findExecutable(named: "npm")
        let pnpm = CommandResolver.findExecutable(named: "pnpm")
        let bun = CommandResolver.findExecutable(named: "bun")
        let (label, cmd): (String, [String]) =
            if let npm {
                ("npm", [npm, "install", "-g", "clawdbot@\(target)"])
            } else if let pnpm {
                ("pnpm", [pnpm, "add", "-g", "clawdbot@\(target)"])
            } else if let bun {
                ("bun", [bun, "add", "-g", "clawdbot@\(target)"])
            } else {
                ("npm", ["npm", "install", "-g", "clawdbot@\(target)"])
            }

        statusHandler("Installing clawdbot@\(target) via \(label)…")

        func summarize(_ text: String) -> String? {
            let lines = text
                .split(whereSeparator: \.isNewline)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            guard let last = lines.last else { return nil }
            let normalized = last.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            return normalized.count > 200 ? String(normalized.prefix(199)) + "…" : normalized
        }

        let response = await ShellExecutor.runDetailed(command: cmd, cwd: nil, env: ["PATH": preferred], timeout: 300)
        if response.success {
            statusHandler("Installed clawdbot@\(target)")
        } else {
            if response.timedOut {
                statusHandler("Install failed: timed out. Check your internet connection and try again.")
                return
            }

            let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
            let detail = summarize(response.stderr) ?? summarize(response.stdout)
            if let detail {
                statusHandler("Install failed (\(exit)): \(detail)")
            } else {
                statusHandler("Install failed (\(exit))")
            }
        }
    }

    // MARK: - Internals

    private static func readGatewayVersion(binary: String) -> Semver? {
        let start = Date()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["--version"]
        process.environment = ["PATH": CommandResolver.preferredPaths().joined(separator: ":")]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            if elapsedMs > 500 {
                self.logger.warning(
                    """
                    gateway --version slow (\(elapsedMs, privacy: .public)ms) \
                    bin=\(binary, privacy: .public)
                    """)
            } else {
                self.logger.debug(
                    """
                    gateway --version ok (\(elapsedMs, privacy: .public)ms) \
                    bin=\(binary, privacy: .public)
                    """)
            }
            let data = pipe.fileHandleForReading.readToEndSafely()
            let raw = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Semver.parse(raw)
        } catch {
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            self.logger.error(
                """
                gateway --version failed (\(elapsedMs, privacy: .public)ms) \
                bin=\(binary, privacy: .public) \
                err=\(error.localizedDescription, privacy: .public)
                """)
            return nil
        }
    }

    private static func readLocalGatewayVersion(projectRoot: URL) -> Semver? {
        let pkg = projectRoot.appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: pkg) else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = json["version"] as? String
        else { return nil }
        return Semver.parse(version)
    }

    private static func readNodeVersion(binary: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["--version"]
        process.environment = ["PATH": CommandResolver.preferredPaths().joined(separator: ":")]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readToEndSafely()
            let raw = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "^v", with: "", options: .regularExpression)
            return raw?.isEmpty == false ? raw : nil
        } catch {
            return nil
        }
    }

    private static func bundledGatewayStatusMessage(
        gatewayVersion: String,
        nodeVersion: String?) -> String
    {
        "\(self.bundledGatewayLabel) \(gatewayVersion) (node \(nodeVersion ?? "unknown"))"
    }

    private static func bundledGatewayIncompatibleMessage(
        installed: Semver,
        expected: Semver) -> String
    {
        "\(self.bundledGatewayLabel) \(installed.description) is incompatible with app " +
            "\(expected.description); rebuild the app bundle."
    }
}
