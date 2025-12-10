import AppKit
import Foundation

extension ProcessInfo {
    var isPreview: Bool {
        self.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
    }
}

enum LaunchdManager {
    private static func runLaunchctl(_ args: [String]) {
        let process = Process()
        process.launchPath = "/bin/launchctl"
        process.arguments = args
        try? process.run()
    }

    static func startClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        self.runLaunchctl(["kickstart", "-k", userTarget])
    }

    static func stopClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        self.runLaunchctl(["stop", userTarget])
    }
}

enum LaunchAgentManager {
    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.steipete.clawdis.plist")
    }

    static func status() async -> Bool {
        guard FileManager.default.fileExists(atPath: self.plistURL.path) else { return false }
        let result = await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"])
        return result == 0
    }

    static func set(enabled: Bool, bundlePath: String) async {
        if enabled {
            self.writePlist(bundlePath: bundlePath)
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
            _ = await self.runLaunchctl(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            _ = await self.runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"])
        } else {
            // Disable autostart going forward but leave the current app running.
            // bootout would terminate the launchd job immediately (and crash the app if launched via agent).
            try? FileManager.default.removeItem(at: self.plistURL)
        }
    }

    private static func writePlist(bundlePath: String) {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.steipete.clawdis</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(bundlePath)/Contents/MacOS/Clawdis</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(FileManager.default.homeDirectoryForCurrentUser.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
            <key>PATH</key>
            <string>\(CommandResolver.preferredPaths().joined(separator: ":"))</string>
          </dict>
          <key>MachServices</key>
          <dict>
            <key>com.steipete.clawdis.xpc</key>
            <true/>
          </dict>
          <key>StandardOutPath</key>
          <string>\(LogLocator.launchdLogPath)</string>
          <key>StandardErrorPath</key>
          <string>\(LogLocator.launchdLogPath)</string>
        </dict>
        </plist>
        """
        try? plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
    }

    @discardableResult
    private static func runLaunchctl(_ args: [String]) async -> Int32 {
        await Task.detached(priority: .utility) { () -> Int32 in
            let process = Process()
            process.launchPath = "/bin/launchctl"
            process.arguments = args
            process.standardOutput = Pipe()
            process.standardError = Pipe()
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus
            } catch {
                return -1
            }
        }.value
    }
}

// Human-friendly age string (e.g., "2m ago").
func age(from date: Date, now: Date = .init()) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    let minutes = seconds / 60
    let hours = minutes / 60
    let days = hours / 24

    if seconds < 60 { return "just now" }
    if minutes == 1 { return "1 minute ago" }
    if minutes < 60 { return "\(minutes)m ago" }
    if hours == 1 { return "1 hour ago" }
    if hours < 24 { return "\(hours)h ago" }
    if days == 1 { return "yesterday" }
    return "\(days)d ago"
}

@MainActor
enum CLIInstaller {
    static func installedLocation() -> String? {
        let fm = FileManager.default

        for basePath in cliHelperSearchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("clawdis-mac").path
            var isDirectory: ObjCBool = false

            guard fm.fileExists(atPath: candidate, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }

            if fm.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        return nil
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func install(statusHandler: @escaping @Sendable (String) async -> Void) async {
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ClawdisCLI")
        guard FileManager.default.isExecutableFile(atPath: helper.path) else {
            await statusHandler("Helper missing in bundle; rebuild via scripts/package-mac-app.sh")
            return
        }

        let targets = cliHelperSearchPaths.map { "\($0)/clawdis-mac" }
        let result = await self.privilegedSymlink(source: helper.path, targets: targets)
        await statusHandler(result)
    }

    private static func privilegedSymlink(source: String, targets: [String]) async -> String {
        let escapedSource = self.shellEscape(source)
        let targetList = targets.map(self.shellEscape).joined(separator: " ")
        let cmds = [
            "mkdir -p /usr/local/bin /opt/homebrew/bin",
            targets.map { "ln -sf \(escapedSource) \($0)" }.joined(separator: "; "),
        ].joined(separator: "; ")

        let script = """
        do shell script "\(cmds)" with administrator privileges
        """

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if proc.terminationStatus == 0 {
                return output.isEmpty ? "CLI helper linked into \(targetList)" : output
            }
            if output.lowercased().contains("user canceled") {
                return "Install canceled"
            }
            return "Failed to install CLI helper: \(output)"
        } catch {
            return "Failed to run installer: \(error.localizedDescription)"
        }
    }

    private static func shellEscape(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}

enum CommandResolver {
    private static let projectRootDefaultsKey = "clawdis.gatewayProjectRootPath"
    private static let helperName = "clawdis"

    static func gatewayEntrypoint(in root: URL) -> String? {
        let distEntry = root.appendingPathComponent("dist/index.js").path
        if FileManager.default.isReadableFile(atPath: distEntry) { return distEntry }
        let binEntry = root.appendingPathComponent("bin/clawdis.js").path
        if FileManager.default.isReadableFile(atPath: binEntry) { return binEntry }
        return nil
    }

    static func runtimeResolution() -> Result<RuntimeResolution, RuntimeResolutionError> {
        RuntimeLocator.resolve(searchPaths: self.preferredPaths())
    }

    static func makeRuntimeCommand(
        runtime: RuntimeResolution,
        entrypoint: String,
        subcommand: String,
        extraArgs: [String]) -> [String]
    {
        [runtime.path, entrypoint, subcommand] + extraArgs
    }

    static func runtimeErrorCommand(_ error: RuntimeResolutionError) -> [String] {
        let message = RuntimeLocator.describeFailure(error)
        return self.errorCommand(with: message)
    }

    static func errorCommand(with message: String) -> [String] {
        let script = """
        cat <<'__CLAWDIS_ERR__' >&2
        \(message)
        __CLAWDIS_ERR__
        exit 1
        """
        return ["/bin/sh", "-c", script]
    }

    static func projectRoot() -> URL {
        if let stored = UserDefaults.standard.string(forKey: self.projectRootDefaultsKey),
           let url = self.expandPath(stored),
           FileManager.default.fileExists(atPath: url.path)
        {
            return url
        }
        let fallback = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Projects/clawdis")
        if FileManager.default.fileExists(atPath: fallback.path) {
            return fallback
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static func setProjectRoot(_ path: String) {
        UserDefaults.standard.set(path, forKey: self.projectRootDefaultsKey)
    }

    static func projectRootPath() -> String {
        self.projectRoot().path
    }

    static func preferredPaths() -> [String] {
        let current = ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":").map(String.init) ?? []
        var extras = [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/pnpm").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        extras.insert(self.projectRoot().appendingPathComponent("node_modules/.bin").path, at: 0)
        var seen = Set<String>()
        // Preserve order while stripping duplicates so PATH lookups remain deterministic.
        return (extras + current).filter { seen.insert($0).inserted }
    }

    static func findExecutable(named name: String) -> String? {
        for dir in self.preferredPaths() {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func clawdisExecutable() -> String? {
        self.findExecutable(named: self.helperName)
    }

    static func nodeCliPath() -> String? {
        let candidate = self.projectRoot().appendingPathComponent("bin/clawdis.js").path
        return FileManager.default.isReadableFile(atPath: candidate) ? candidate : nil
    }

    static func hasAnyClawdisInvoker() -> Bool {
        if self.clawdisExecutable() != nil { return true }
        if self.findExecutable(named: "pnpm") != nil { return true }
        if self.findExecutable(named: "node") != nil, self.nodeCliPath() != nil { return true }
        return false
    }

    static func clawdisNodeCommand(subcommand: String, extraArgs: [String] = []) -> [String] {
        let settings = self.connectionSettings()
        if settings.mode == .remote, let ssh = self.sshNodeCommand(
            subcommand: subcommand,
            extraArgs: extraArgs,
            settings: settings)
        {
            return ssh
        }

        let runtimeResult = self.runtimeResolution()

        switch runtimeResult {
        case let .success(runtime):
            if let clawdisPath = self.clawdisExecutable() {
                return [clawdisPath, subcommand] + extraArgs
            }

            if let entry = self.gatewayEntrypoint(in: self.projectRoot()) {
                return self.makeRuntimeCommand(
                    runtime: runtime,
                    entrypoint: entry,
                    subcommand: subcommand,
                    extraArgs: extraArgs)
            }
            if let pnpm = self.findExecutable(named: "pnpm") {
                // Use --silent to avoid pnpm lifecycle banners that would corrupt JSON outputs.
                return [pnpm, "--silent", "clawdis", subcommand] + extraArgs
            }

            let missingEntry = """
            clawdis entrypoint missing (looked for dist/index.js or bin/clawdis.js); run pnpm build.
            """
            return self.errorCommand(with: missingEntry)

        case let .failure(error):
            return self.runtimeErrorCommand(error)
        }
    }

    static func clawdisMacCommand(subcommand: String, extraArgs: [String] = []) -> [String] {
        let settings = self.connectionSettings()
        if settings.mode == .remote, let ssh = self.sshMacHelperCommand(
            subcommand: subcommand,
            extraArgs: extraArgs,
            settings: settings)
        {
            return ssh
        }
        if let helper = self.findExecutable(named: "clawdis-mac") {
            return [helper, subcommand] + extraArgs
        }
        return ["/usr/local/bin/clawdis-mac", subcommand] + extraArgs
    }

    // Existing callers still refer to clawdisCommand; keep it as node alias.
    static func clawdisCommand(subcommand: String, extraArgs: [String] = []) -> [String] {
        self.clawdisNodeCommand(subcommand: subcommand, extraArgs: extraArgs)
    }

    // MARK: - SSH helpers

    private static func sshNodeCommand(subcommand: String, extraArgs: [String], settings: RemoteSettings) -> [String]? {
        guard !settings.target.isEmpty else { return nil }
        guard let parsed = self.parseSSHTarget(settings.target) else { return nil }

        var args: [String] = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        if !settings.identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["-i", settings.identity])
        }
        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host
        args.append(userHost)

        // Run the real clawdis CLI on the remote host; do not fall back to clawdis-mac.
        let exportedPath = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            "/Users/steipete/Library/pnpm",
            "$PATH",
        ].joined(separator: ":")
        let quotedArgs = ([subcommand] + extraArgs).map(self.shellQuote).joined(separator: " ")
        let userPRJ = settings.projectRoot.trimmingCharacters(in: .whitespacesAndNewlines)

        let projectSection = if userPRJ.isEmpty {
            """
            DEFAULT_PRJ="$HOME/Projects/clawdis"
            if [ -d "$DEFAULT_PRJ" ]; then
              PRJ="$DEFAULT_PRJ"
              cd "$PRJ" || { echo "Project root not found: $PRJ"; exit 127; }
            fi
            """
        } else {
            """
            PRJ=\(self.shellQuote(userPRJ))
            cd \(self.shellQuote(userPRJ)) || { echo "Project root not found: \(userPRJ)"; exit 127; }
            """
        }

        let scriptBody = """
        PATH=\(exportedPath);
        CLI="";
        \(projectSection)
        if command -v clawdis >/dev/null 2>&1; then
          CLI="$(command -v clawdis)"
          clawdis \(quotedArgs);
        elif [ -n "${PRJ:-}" ] && [ -f "$PRJ/dist/index.js" ]; then
          if command -v node >/dev/null 2>&1; then
            CLI="node $PRJ/dist/index.js"
            node "$PRJ/dist/index.js" \(quotedArgs);
          else
            echo "Node >=22 required on remote host"; exit 127;
          fi
        elif [ -n "${PRJ:-}" ] && [ -f "$PRJ/bin/clawdis.js" ]; then
          if command -v node >/dev/null 2>&1; then
            CLI="node $PRJ/bin/clawdis.js"
            node "$PRJ/bin/clawdis.js" \(quotedArgs);
          else
            echo "Node >=22 required on remote host"; exit 127;
          fi
        elif command -v pnpm >/dev/null 2>&1; then
          CLI="pnpm --silent clawdis"
          pnpm --silent clawdis \(quotedArgs);
        else
          echo "clawdis CLI missing on remote host"; exit 127;
        fi
        """
        args.append(contentsOf: ["/bin/sh", "-c", scriptBody])
        return ["/usr/bin/ssh"] + args
    }

    private static func sshMacHelperCommand(
        subcommand: String,
        extraArgs: [String],
        settings: RemoteSettings) -> [String]?
    {
        guard !settings.target.isEmpty else { return nil }
        guard let parsed = self.parseSSHTarget(settings.target) else { return nil }

        var args: [String] = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        if !settings.identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["-i", settings.identity])
        }
        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host
        args.append(userHost)

        let exportedPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
        let userPRJ = settings.projectRoot
        let quotedArgs = ([subcommand] + extraArgs).map(self.shellQuote).joined(separator: " ")
        let scriptBody = """
        PATH=\(exportedPath);
        PRJ=\(userPRJ.isEmpty ? "" : self.shellQuote(userPRJ))
        DEFAULT_PRJ="$HOME/Projects/clawdis"
        if [ -z "${PRJ:-}" ] && [ -d "$DEFAULT_PRJ" ]; then PRJ="$DEFAULT_PRJ"; fi
        if [ -n "${PRJ:-}" ]; then cd "$PRJ" || { echo "Project root not found: $PRJ"; exit 127; }; fi
        if ! command -v clawdis-mac >/dev/null 2>&1; then echo "clawdis-mac missing on remote host"; exit 127; fi;
        clawdis-mac \(quotedArgs)
        """
        args.append(contentsOf: ["/bin/sh", "-c", scriptBody])
        return ["/usr/bin/ssh"] + args
    }

    struct RemoteSettings {
        let mode: AppState.ConnectionMode
        let target: String
        let identity: String
        let projectRoot: String
    }

    static func connectionSettings() -> RemoteSettings {
        let modeRaw = UserDefaults.standard.string(forKey: connectionModeKey) ?? "local"
        let mode = AppState.ConnectionMode(rawValue: modeRaw) ?? .local
        let target = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        let identity = UserDefaults.standard.string(forKey: remoteIdentityKey) ?? ""
        let projectRoot = UserDefaults.standard.string(forKey: remoteProjectRootKey) ?? ""
        return RemoteSettings(
            mode: mode,
            target: self.sanitizedTarget(target),
            identity: identity,
            projectRoot: projectRoot)
    }

    static func connectionModeIsRemote() -> Bool {
        self.connectionSettings().mode == .remote
    }

    private static func sanitizedTarget(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("ssh ") {
            return trimmed.replacingOccurrences(of: "ssh ", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    struct SSHParsedTarget {
        let user: String?
        let host: String
        let port: Int
    }

    static func parseSSHTarget(_ target: String) -> SSHParsedTarget? {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let userHostPort: String
        let user: String?
        if let atRange = trimmed.range(of: "@") {
            user = String(trimmed[..<atRange.lowerBound])
            userHostPort = String(trimmed[atRange.upperBound...])
        } else {
            user = nil
            userHostPort = trimmed
        }

        let host: String
        let port: Int
        if let colon = userHostPort.lastIndex(of: ":"), colon != userHostPort.startIndex {
            host = String(userHostPort[..<colon])
            let portStr = String(userHostPort[userHostPort.index(after: colon)...])
            port = Int(portStr) ?? 22
        } else {
            host = userHostPort
            port = 22
        }

        return SSHParsedTarget(user: user, host: host, port: port)
    }

    private static func shellQuote(_ text: String) -> String {
        if text.isEmpty { return "''" }
        let escaped = text.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }

    private static func expandPath(_ path: String) -> URL? {
        var expanded = path
        if expanded.hasPrefix("~") {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            expanded.replaceSubrange(expanded.startIndex...expanded.startIndex, with: home)
        }
        return URL(fileURLWithPath: expanded)
    }
}
