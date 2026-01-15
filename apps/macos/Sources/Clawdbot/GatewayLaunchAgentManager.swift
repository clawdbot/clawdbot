import Foundation

enum GatewayLaunchAgentManager {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "gateway.launchd")
    private static let supportedBindModes: Set<String> = ["loopback", "tailnet", "lan", "auto"]
    private static let legacyGatewayLaunchdLabel = "com.steipete.clawdbot.gateway"
    private static let disableLaunchAgentMarker = ".clawdbot/disable-launchagent"

    private enum GatewayProgramArgumentsError: LocalizedError {
        case message(String)

        var errorDescription: String? {
            switch self {
            case let .message(message):
                message
            }
        }
    }

    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(gatewayLaunchdLabel).plist")
    }

    private static var legacyPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(legacyGatewayLaunchdLabel).plist")
    }

    private static func gatewayProgramArguments(
        port: Int,
        bind: String) -> Result<[String], GatewayProgramArgumentsError>
    {
        let projectRoot = CommandResolver.projectRoot()
        #if DEBUG
        if let localBin = CommandResolver.projectClawdbotExecutable(projectRoot: projectRoot) {
            return .success([localBin, "gateway-daemon", "--port", "\(port)", "--bind", bind])
        }
        if let entry = CommandResolver.gatewayEntrypoint(in: projectRoot) {
            switch CommandResolver.runtimeResolution() {
            case let .success(runtime):
                let cmd = CommandResolver.makeRuntimeCommand(
                    runtime: runtime,
                    entrypoint: entry,
                    subcommand: "gateway-daemon",
                    extraArgs: ["--port", "\(port)", "--bind", bind])
                return .success(cmd)
            case .failure:
                break
            }
        }
        #endif
        let searchPaths = CommandResolver.preferredPaths()
        if let gatewayBin = CommandResolver.clawdbotExecutable(searchPaths: searchPaths) {
            return .success([gatewayBin, "gateway-daemon", "--port", "\(port)", "--bind", bind])
        }

        if let entry = CommandResolver.gatewayEntrypoint(in: projectRoot),
           case let .success(runtime) = CommandResolver.runtimeResolution(searchPaths: searchPaths)
        {
            let cmd = CommandResolver.makeRuntimeCommand(
                runtime: runtime,
                entrypoint: entry,
                subcommand: "gateway-daemon",
                extraArgs: ["--port", "\(port)", "--bind", bind])
            return .success(cmd)
        }

        return .failure(.message("clawdbot CLI not found in PATH; install the CLI."))
    }

    static func isLoaded() async -> Bool {
        guard FileManager.default.fileExists(atPath: self.plistURL.path) else { return false }
        let result = await Launchctl.run(["print", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
        return result.status == 0
    }

    static func set(enabled: Bool, bundlePath: String, port: Int) async -> String? {
        _ = bundlePath
        if enabled, self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd enable skipped (disable marker set)")
            return nil
        }
        if enabled {
            _ = await Launchctl.run(["bootout", "gui/\(getuid())/\(self.legacyGatewayLaunchdLabel)"])
            try? FileManager.default.removeItem(at: self.legacyPlistURL)

            let desiredBind = self.preferredGatewayBind() ?? "loopback"
            let desiredToken = self.preferredGatewayToken()
            let desiredPassword = self.preferredGatewayPassword()
            let desiredConfig = DesiredConfig(
                port: port,
                bind: desiredBind,
                token: desiredToken,
                password: desiredPassword)
            let programArgumentsResult = self.gatewayProgramArguments(port: port, bind: desiredBind)
            guard case let .success(programArguments) = programArgumentsResult else {
                if case let .failure(error) = programArgumentsResult {
                    let message = error.localizedDescription
                    self.logger.error("launchd enable failed: \(message)")
                    return message
                }
                return "Failed to resolve gateway command."
            }

            // If launchd already loaded the job (common on login), avoid `bootout` unless we must
            // change the config. `bootout` can kill a just-started gateway and cause attach loops.
            let loaded = await self.isLoaded()
            if loaded {
                if let existing = self.readPlistConfig(), existing.matches(desiredConfig) {
                    self.logger.info("launchd job already loaded with desired config; skipping bootout")
                    await self.ensureEnabled()
                    _ = await Launchctl.run(["kickstart", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
                    return nil
                }
            }

            self.logger.info("launchd enable requested port=\(port) bind=\(desiredBind)")
            self.writePlist(programArguments: programArguments)

            await self.ensureEnabled()
            if loaded {
                _ = await Launchctl.run(["bootout", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
            }
            let bootstrap = await Launchctl.run(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            if bootstrap.status != 0 {
                let msg = bootstrap.output.trimmingCharacters(in: .whitespacesAndNewlines)
                self.logger.error("launchd bootstrap failed: \(msg)")
                return bootstrap.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Failed to bootstrap gateway launchd job"
                    : bootstrap.output.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            await self.ensureEnabled()
            return nil
        }

        self.logger.info("launchd disable requested")
        _ = await Launchctl.run(["bootout", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
        await self.ensureDisabled()
        try? FileManager.default.removeItem(at: self.plistURL)
        return nil
    }

    static func kickstart() async {
        _ = await Launchctl.run(["kickstart", "-k", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
    }

    private static func writePlist(programArguments: [String]) {
        let preferredPath = CommandResolver.preferredPaths().joined(separator: ":")
        let token = self.preferredGatewayToken()
        let password = self.preferredGatewayPassword()
        var envEntries = """
            <key>PATH</key>
            <string>\(preferredPath)</string>
        """
        if let token {
            let escapedToken = self.escapePlistValue(token)
            envEntries += """
                <key>CLAWDBOT_GATEWAY_TOKEN</key>
                <string>\(escapedToken)</string>
            """
        }
        if let password {
            let escapedPassword = self.escapePlistValue(password)
            envEntries += """
                <key>CLAWDBOT_GATEWAY_PASSWORD</key>
                <string>\(escapedPassword)</string>
            """
        }
        let argsXml = programArguments
            .map { "<string>\(self.escapePlistValue($0))</string>" }
            .joined(separator: "\n            ")
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(gatewayLaunchdLabel)</string>
          <key>ProgramArguments</key>
          <array>
            \(argsXml)
          </array>
          <key>WorkingDirectory</key>
          <string>\(FileManager.default.homeDirectoryForCurrentUser.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
        \(envEntries)
          </dict>
          <key>StandardOutPath</key>
          <string>\(LogLocator.launchdGatewayLogPath)</string>
          <key>StandardErrorPath</key>
          <string>\(LogLocator.launchdGatewayLogPath)</string>
        </dict>
        </plist>
        """
        do {
            try plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
        } catch {
            self.logger.error("launchd plist write failed: \(error.localizedDescription)")
        }
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

    private static func preferredGatewayToken() -> String? {
        let raw = ProcessInfo.processInfo.environment["CLAWDBOT_GATEWAY_TOKEN"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
        }
        let root = ClawdbotConfigFile.loadDict()
        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let token = auth["token"] as? String
        {
            let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private static func preferredGatewayPassword() -> String? {
        // First check environment variable
        let raw = ProcessInfo.processInfo.environment["CLAWDBOT_GATEWAY_PASSWORD"] ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
        }
        // Then check config file (gateway.auth.password)
        let root = ClawdbotConfigFile.loadDict()
        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           let password = auth["password"] as? String
        {
            return password.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private static func escapePlistValue(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    private struct DesiredConfig: Equatable {
        let port: Int
        let bind: String
        let token: String?
        let password: String?
    }

    private struct InstalledConfig: Equatable {
        let port: Int?
        let bind: String?
        let token: String?
        let password: String?

        func matches(_ desired: DesiredConfig) -> Bool {
            guard self.port == desired.port else { return false }
            guard (self.bind ?? "loopback") == desired.bind else { return false }
            guard self.token == desired.token else { return false }
            guard self.password == desired.password else { return false }
            return true
        }
    }

    private static func readPlistConfig() -> InstalledConfig? {
        guard let snapshot = LaunchAgentPlist.snapshot(url: self.plistURL) else { return nil }
        return InstalledConfig(
            port: snapshot.port,
            bind: snapshot.bind,
            token: snapshot.token,
            password: snapshot.password)
    }

    static func launchdConfigSnapshot() -> LaunchAgentPlistSnapshot? {
        LaunchAgentPlist.snapshot(url: self.plistURL)
    }

    private static func ensureEnabled() async {
        let result = await Launchctl.run(["enable", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
        guard result.status != 0 else { return }
        let msg = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        if msg.isEmpty {
            self.logger.warning("launchd enable failed")
        } else {
            self.logger.warning("launchd enable failed: \(msg)")
        }
    }

    private static func ensureDisabled() async {
        let result = await Launchctl.run(["disable", "gui/\(getuid())/\(gatewayLaunchdLabel)"])
        guard result.status != 0 else { return }
        let msg = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        if msg.isEmpty {
            self.logger.warning("launchd disable failed")
        } else {
            self.logger.warning("launchd disable failed: \(msg)")
        }
    }
}

extension GatewayLaunchAgentManager {
    private static func isLaunchAgentWriteDisabled() -> Bool {
        let marker = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(self.disableLaunchAgentMarker)
        return FileManager.default.fileExists(atPath: marker.path)
    }
}

#if DEBUG
extension GatewayLaunchAgentManager {
    static func _testPreferredGatewayBind() -> String? {
        self.preferredGatewayBind()
    }

    static func _testPreferredGatewayToken() -> String? {
        self.preferredGatewayToken()
    }

    static func _testEscapePlistValue(_ raw: String) -> String {
        self.escapePlistValue(raw)
    }
}
#endif
