import Foundation
import OSLog

/// Lightweight SemVer helper (major.minor.patch only) for gateway compatibility checks.
struct Semver: Comparable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int

    var description: String {
        "\(self.major).\(self.minor).\(self.patch)"
    }

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
        // Strip prerelease suffix (e.g., "11-4" → "11", "5-beta.1" → "5")
        let patchRaw = String(parts[2])
        guard let patchToken = patchRaw.split(whereSeparator: { $0 == "-" || $0 == "+" }).first,
              let patchNumeric = Int(patchToken)
        else {
            return nil
        }
        return Semver(major: major, minor: minor, patch: patchNumeric)
    }

    func compatible(with required: Semver) -> Bool {
        // Same major and not older than required.
        self.major == required.major && self >= required
    }

    static func satisfiesExpectedGatewayVersion(installed: String, expected: String?) -> Bool {
        let installed = installed.trimmingCharacters(in: .whitespacesAndNewlines)
        let expected = expected?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let installedVersion = Self.parse(installed) else { return false }
        guard let expectedVersion = Self.parse(expected) else { return true }
        if Self.isPrerelease(installed) || Self.isPrerelease(expected) {
            return installed == expected
        }
        return installedVersion.compatible(with: expectedVersion)
    }

    static func isPrerelease(_ version: String?) -> Bool {
        guard let version = version?.lowercased() else { return false }
        let versionCore = version.split(
            separator: "+",
            maxSplits: 1,
            omittingEmptySubsequences: false)[0]
        if ["alpha", "beta"].contains(where: { lane in
            versionCore.contains("-\(lane).") || versionCore.contains(".\(lane).")
        }) {
            return true
        }
        guard let separator = versionCore.firstIndex(of: "-") else { return false }
        let suffix = versionCore[versionCore.index(after: separator)...]
        return !suffix.split(separator: ".").allSatisfy { Int($0) != nil }
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
    private enum CommandSource {
        case executable(String)
        case project(runtime: RuntimeResolution, entrypoint: String)
    }

    private struct EnvironmentResolution {
        let status: GatewayEnvironmentStatus
        let commandSource: CommandSource?
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.env")
    private static let supportedBindModes: Set<String> = ["loopback", "tailnet", "lan", "auto"]

    static func gatewayPort() -> Int {
        if let raw = ProcessInfo.processInfo.environment["OPENCLAW_GATEWAY_PORT"] {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if let parsed = Int(trimmed), parsed > 0 { return parsed }
        }
        if let configPort = OpenClawConfigFile.gatewayPort(), configPort > 0 {
            return configPort
        }
        let stored = UserDefaults.standard.integer(forKey: "gatewayPort")
        return stored > 0 ? stored : 18789
    }

    static func expectedGatewayVersion() -> Semver? {
        Semver.parse(self.expectedGatewayVersionString())
    }

    static func appVersionString() -> String? {
        let bundleVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let trimmed = bundleVersion?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed : nil
    }

    static func expectedGatewayVersionString() -> String? {
        CLIInstallPolicy.requiredGatewayVersionString(
            appVersion: self.appVersionString(),
            isDebug: CLIInstallBuild.isDebug)
    }

    /// Exposed for tests so we can inject fake version checks without rewriting bundle metadata.
    static func expectedGatewayVersion(from versionString: String?) -> Semver? {
        Semver.parse(versionString)
    }

    static func check() async -> GatewayEnvironmentStatus {
        let searchPaths = await CommandResolver.preferredPathsAsync()
        return await self.resolveEnvironment(searchPaths: searchPaths).status
    }

    private static func resolveEnvironment(searchPaths: [String]) async -> EnvironmentResolution {
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
        let expectedString = self.expectedGatewayVersionString()

        let projectRoot = CommandResolver.projectRoot()
        let projectEntrypoint = CommandResolver.gatewayEntrypoint(in: projectRoot)

        switch await RuntimeLocator.resolve(searchPaths: searchPaths) {
        case let .failure(err):
            return EnvironmentResolution(
                status: GatewayEnvironmentStatus(
                    kind: .missingNode,
                    nodeVersion: nil,
                    gatewayVersion: nil,
                    requiredGateway: expectedString,
                    message: RuntimeLocator.describeFailure(err)),
                commandSource: nil)
        case let .success(runtime):
            let gatewayBin = CommandResolver.openclawExecutable(searchPaths: searchPaths)

            if gatewayBin == nil, projectEntrypoint == nil {
                return EnvironmentResolution(
                    status: GatewayEnvironmentStatus(
                        kind: .missingGateway,
                        nodeVersion: runtime.version.description,
                        gatewayVersion: nil,
                        requiredGateway: expectedString,
                        message: "openclaw CLI not found in PATH; install the CLI."),
                    commandSource: nil)
            }

            let installedRaw = await self.installedGatewayVersion(
                gatewayBin: gatewayBin,
                projectRoot: projectRoot,
                searchPaths: searchPaths)
            let installed = Semver.parse(installedRaw)

            if let expected, let installedRaw, installed != nil,
               !Semver.satisfiesExpectedGatewayVersion(installed: installedRaw, expected: expectedString)
            {
                let expectedText = expectedString ?? expected.description
                return EnvironmentResolution(
                    status: GatewayEnvironmentStatus(
                        kind: .incompatible(found: installedRaw, required: expectedText),
                        nodeVersion: runtime.version.description,
                        gatewayVersion: installedRaw,
                        requiredGateway: expectedText,
                        message: """
                        Gateway version \(installedRaw) is incompatible with app \(expectedText);
                        install or update the global package.
                        """),
                    commandSource: nil)
            }

            let gatewayLabel = gatewayBin != nil ? "global" : "local"
            let gatewayVersionText = installedRaw ?? "unknown"
            // Avoid repeating "(local)" twice; if using the local entrypoint, show the path once.
            let localPathHint = gatewayBin == nil && projectEntrypoint != nil
                ? " (local: \(projectEntrypoint ?? "unknown"))"
                : ""
            let gatewayLabelText = gatewayBin != nil
                ? "(\(gatewayLabel))"
                : localPathHint.isEmpty ? "(\(gatewayLabel))" : localPathHint
            let commandSource: CommandSource? = if let gatewayBin {
                CommandSource.executable(gatewayBin)
            } else if let projectEntrypoint {
                CommandSource.project(runtime: runtime, entrypoint: projectEntrypoint)
            } else {
                nil
            }
            return EnvironmentResolution(
                status: GatewayEnvironmentStatus(
                    kind: .ok,
                    nodeVersion: runtime.version.description,
                    gatewayVersion: gatewayVersionText,
                    requiredGateway: expectedString,
                    message: "Node \(runtime.version.description); gateway \(gatewayVersionText) \(gatewayLabelText)"),
                commandSource: commandSource)
        }
    }

    static func resolveGatewayCommand(
        searchPathsProvider: @Sendable () async -> [String] = CommandResolver.preferredPathsAsync) async
        -> GatewayCommandResolution
    {
        let start = Date()
        defer {
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            if elapsedMs > 500 {
                self.logger.warning("gateway command resolve slow (\(elapsedMs, privacy: .public)ms)")
            } else {
                self.logger.debug("gateway command resolve ok (\(elapsedMs, privacy: .public)ms)")
            }
        }
        let searchPaths = await searchPathsProvider()
        let environment = await self.resolveEnvironment(searchPaths: searchPaths)

        guard case .ok = environment.status.kind else {
            return GatewayCommandResolution(status: environment.status, command: nil)
        }

        let port = self.gatewayPort()
        let bind = self.preferredGatewayBind() ?? "loopback"
        switch environment.commandSource {
        case let .executable(gatewayBin):
            let cmd = [gatewayBin, "gateway", "--port", "\(port)", "--bind", bind]
            return GatewayCommandResolution(status: environment.status, command: cmd)
        case let .project(runtime, entrypoint):
            let cmd = [runtime.path, entrypoint, "gateway", "--port", "\(port)", "--bind", bind]
            return GatewayCommandResolution(status: environment.status, command: cmd)
        case nil:
            return GatewayCommandResolution(status: environment.status, command: nil)
        }
    }

    private static func preferredGatewayBind() -> String? {
        if CommandResolver.connectionModeIsRemote() {
            return nil
        }
        if let env = ProcessInfo.processInfo.environment["OPENCLAW_GATEWAY_BIND"] {
            let trimmed = env.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if self.supportedBindModes.contains(trimmed) {
                return trimmed
            }
        }

        let root = OpenClawConfigFile.loadDict()
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

    // MARK: - Internals

    /// Exposed for tests so CLI version output normalization stays local to gateway checks.
    static func normalizeGatewayVersionOutput(_ raw: String?) -> String? {
        guard var normalized = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !normalized.isEmpty else {
            return nil
        }
        if normalized.lowercased().hasPrefix("openclaw ") {
            normalized = String(normalized.dropFirst("openclaw ".count))
        }
        // Strip trailing commit metadata, e.g. "2026.4.2 (d74a122)" → "2026.4.2"
        if let parenRange = normalized.range(of: #"\s*\([0-9a-fA-F]+\)\s*$"#, options: .regularExpression) {
            normalized = String(normalized[normalized.startIndex..<parenRange.lowerBound])
        }
        return normalized
    }

    static func installedGatewayVersion(
        gatewayBin: String?,
        projectRoot: URL,
        searchPaths: [String]) async -> String?
    {
        if let gatewayBin,
           let version = await self.readGatewayVersion(binary: gatewayBin, searchPaths: searchPaths)
        {
            return version
        }
        return self.readLocalGatewayVersion(projectRoot: projectRoot)
    }

    private static func readGatewayVersion(binary: String, searchPaths: [String]) async -> String? {
        let start = Date()
        do {
            let result = try await BoundedProcess.run(
                path: binary,
                arguments: ["--version"],
                environment: ["PATH": searchPaths.joined(separator: ":")],
                timeout: 2)
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
            let raw = String(data: result.output, encoding: .utf8)
            guard let normalized = self.normalizeGatewayVersionOutput(raw),
                  Semver.parse(normalized) != nil
            else { return nil }
            return normalized
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

    private static func readLocalGatewayVersion(projectRoot: URL) -> String? {
        let pkg = projectRoot.appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: pkg) else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = json["version"] as? String
        else { return nil }
        guard Semver.parse(version) != nil else { return nil }
        return version.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
