import Foundation

enum CommandResolver {
    private static let projectRootDefaultsKey = "clawdbot.gatewayProjectRootPath"
    private static let helperName = "clawdbot"

    static func gatewayEntrypoint(in root: URL) -> String? {
        let distEntry = root.appendingPathComponent("dist/index.js").path
        if FileManager.default.isReadableFile(atPath: distEntry) { return distEntry }
        let binEntry = root.appendingPathComponent("bin/clawdbot.js").path
        if FileManager.default.isReadableFile(atPath: binEntry) { return binEntry }
        return nil
    }

    static func runtimeResolution() -> Result<RuntimeResolution, RuntimeResolutionError> {
        RuntimeLocator.resolve(searchPaths: self.preferredPaths())
    }

    static func runtimeResolution(searchPaths: [String]?) -> Result<RuntimeResolution, RuntimeResolutionError> {
        RuntimeLocator.resolve(searchPaths: searchPaths ?? self.preferredPaths())
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
        cat <<'__CLAWDBOT_ERR__' >&2
        \(message)
        __CLAWDBOT_ERR__
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
            .appendingPathComponent("Projects/clawdbot")
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
        let home = FileManager.default.homeDirectoryForCurrentUser
        let projectRoot = self.projectRoot()
        return self.preferredPaths(home: home, current: current, projectRoot: projectRoot)
    }

    static func preferredPaths(home: URL, current: [String], projectRoot: URL) -> [String] {
        var extras = [
            home.appendingPathComponent("Library/pnpm").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        extras.insert(projectRoot.appendingPathComponent("node_modules/.bin").path, at: 0)
        let clawdbotPaths = self.clawdbotManagedPaths(home: home)
        if !clawdbotPaths.isEmpty {
            extras.insert(contentsOf: clawdbotPaths, at: 1)
        }
        extras.insert(contentsOf: self.nodeManagerBinPaths(home: home), at: 1 + clawdbotPaths.count)
        var seen = Set<String>()
        // Preserve order while stripping duplicates so PATH lookups remain deterministic.
        return (extras + current).filter { seen.insert($0).inserted }
    }

    private static func clawdbotManagedPaths(home: URL) -> [String] {
        let base = home.appendingPathComponent(".clawdbot")
        let bin = base.appendingPathComponent("bin")
        let nodeBin = base.appendingPathComponent("tools/node/bin")
        var paths: [String] = []
        if FileManager.default.fileExists(atPath: bin.path) {
            paths.append(bin.path)
        }
        if FileManager.default.fileExists(atPath: nodeBin.path) {
            paths.append(nodeBin.path)
        }
        return paths
    }

    private static func nodeManagerBinPaths(home: URL) -> [String] {
        var bins: [String] = []

        // Volta
        let volta = home.appendingPathComponent(".volta/bin")
        if FileManager.default.fileExists(atPath: volta.path) {
            bins.append(volta.path)
        }

        // asdf
        let asdf = home.appendingPathComponent(".asdf/shims")
        if FileManager.default.fileExists(atPath: asdf.path) {
            bins.append(asdf.path)
        }

        // fnm
        bins.append(contentsOf: self.versionedNodeBinPaths(
                        base: home.appendingPathComponent(".local/share/fnm/node-versions"),
                        suffix: "installation/bin"))

        // nvm
        bins.append(contentsOf: self.versionedNodeBinPaths(
                        base: home.appendingPathComponent(".nvm/versions/node"),
                        suffix: "bin"))

        return bins
    }

    private static func versionedNodeBinPaths(base: URL, suffix: String) -> [String] {
        guard FileManager.default.fileExists(atPath: base.path) else { return [] }
        let entries: [String]
        do {
            entries = try FileManager.default.contentsOfDirectory(atPath: base.path)
        } catch {
            return []
        }

        func parseVersion(_ name: String) -> [Int] {
            let trimmed = name.hasPrefix("v") ? String(name.dropFirst()) : name
            return trimmed.split(separator: ".").compactMap { Int($0) }
        }

        let sorted = entries.sorted { a, b in
            let va = parseVersion(a)
            let vb = parseVersion(b)
            let maxCount = max(va.count, vb.count)
            for i in 0..<maxCount {
                let ai = i < va.count ? va[i] : 0
                let bi = i < vb.count ? vb[i] : 0
                if ai != bi { return ai > bi }
            }
            // If identical numerically, keep stable ordering.
            return a > b
        }

        var paths: [String] = []
        for entry in sorted {
            let binDir = base.appendingPathComponent(entry).appendingPathComponent(suffix)
            let node = binDir.appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: node.path) {
                paths.append(binDir.path)
            }
        }
        return paths
    }

    static func findExecutable(named name: String, searchPaths: [String]? = nil) -> String? {
        for dir in searchPaths ?? self.preferredPaths() {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func clawdbotExecutable(searchPaths: [String]? = nil) -> String? {
        self.findExecutable(named: self.helperName, searchPaths: searchPaths)
    }

    static func projectClawdbotExecutable(projectRoot: URL? = nil) -> String? {
        let root = projectRoot ?? self.projectRoot()
        let candidate = root.appendingPathComponent("node_modules/.bin").appendingPathComponent(self.helperName).path
        return FileManager.default.isExecutableFile(atPath: candidate) ? candidate : nil
    }

    static func nodeCliPath() -> String? {
        let candidate = self.projectRoot().appendingPathComponent("bin/clawdbot.js").path
        return FileManager.default.isReadableFile(atPath: candidate) ? candidate : nil
    }

    static func hasAnyClawdbotInvoker(searchPaths: [String]? = nil) -> Bool {
        if self.clawdbotExecutable(searchPaths: searchPaths) != nil { return true }
        if self.findExecutable(named: "pnpm", searchPaths: searchPaths) != nil { return true }
        if self.findExecutable(named: "node", searchPaths: searchPaths) != nil,
           self.nodeCliPath() != nil
        {
            return true
        }
        return false
    }

    static func clawdbotNodeCommand(
        subcommand: String,
        extraArgs: [String] = [],
        defaults: UserDefaults = .standard,
        searchPaths: [String]? = nil) -> [String]
    {
        let settings = self.connectionSettings(defaults: defaults)
        if settings.mode == .remote, let ssh = self.sshNodeCommand(
            subcommand: subcommand,
            extraArgs: extraArgs,
            settings: settings)
        {
            return ssh
        }

        let runtimeResult = self.runtimeResolution(searchPaths: searchPaths)

        switch runtimeResult {
        case let .success(runtime):
            let root = self.projectRoot()
            if let clawdbotPath = self.projectClawdbotExecutable(projectRoot: root) {
                return [clawdbotPath, subcommand] + extraArgs
            }

            if let entry = self.gatewayEntrypoint(in: root) {
                return self.makeRuntimeCommand(
                    runtime: runtime,
                    entrypoint: entry,
                    subcommand: subcommand,
                    extraArgs: extraArgs)
            }
            if let pnpm = self.findExecutable(named: "pnpm", searchPaths: searchPaths) {
                // Use --silent to avoid pnpm lifecycle banners that would corrupt JSON outputs.
                return [pnpm, "--silent", "clawdbot", subcommand] + extraArgs
            }
            if let clawdbotPath = self.clawdbotExecutable(searchPaths: searchPaths) {
                return [clawdbotPath, subcommand] + extraArgs
            }

            let missingEntry = """
            clawdbot entrypoint missing (looked for dist/index.js or bin/clawdbot.js); run pnpm build.
            """
            return self.errorCommand(with: missingEntry)

        case let .failure(error):
            return self.runtimeErrorCommand(error)
        }
    }

    // Existing callers still refer to clawdbotCommand; keep it as node alias.
    static func clawdbotCommand(
        subcommand: String,
        extraArgs: [String] = [],
        defaults: UserDefaults = .standard,
        searchPaths: [String]? = nil) -> [String]
    {
        self.clawdbotNodeCommand(
            subcommand: subcommand,
            extraArgs: extraArgs,
            defaults: defaults,
            searchPaths: searchPaths)
    }

    // MARK: - SSH helpers

    private static func sshNodeCommand(subcommand: String, extraArgs: [String], settings: RemoteSettings) -> [String]? {
        guard !settings.target.isEmpty else { return nil }
        guard let parsed = self.parseSSHTarget(settings.target) else { return nil }

        var args: [String] = [
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UpdateHostKeys=yes",
        ]
        if parsed.port > 0 { args.append(contentsOf: ["-p", String(parsed.port)]) }
        if !settings.identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["-i", settings.identity])
        }
        let userHost = parsed.user.map { "\($0)@\(parsed.host)" } ?? parsed.host
        args.append(userHost)

        // Run the real clawdbot CLI on the remote host.
        let exportedPath = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            "$HOME/Library/pnpm",
            "$PATH",
        ].joined(separator: ":")
        let quotedArgs = ([subcommand] + extraArgs).map(self.shellQuote).joined(separator: " ")
        let userPRJ = settings.projectRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        let userCLI = settings.cliPath.trimmingCharacters(in: .whitespacesAndNewlines)

        let projectSection = if userPRJ.isEmpty {
            """
            DEFAULT_PRJ="$HOME/Projects/clawdbot"
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

        let cliSection = if userCLI.isEmpty {
            ""
        } else {
            """
            CLI_HINT=\(self.shellQuote(userCLI))
            if [ -n "$CLI_HINT" ]; then
              if [ -x "$CLI_HINT" ]; then
                CLI="$CLI_HINT"
                "$CLI_HINT" \(quotedArgs);
                exit $?;
              elif [ -f "$CLI_HINT" ]; then
                if command -v node >/dev/null 2>&1; then
                  CLI="node $CLI_HINT"
                  node "$CLI_HINT" \(quotedArgs);
                  exit $?;
                fi
              fi
            fi
            """
        }

        let scriptBody = """
        PATH=\(exportedPath);
        CLI="";
        \(cliSection)
        \(projectSection)
        if command -v clawdbot >/dev/null 2>&1; then
          CLI="$(command -v clawdbot)"
          clawdbot \(quotedArgs);
        elif [ -n "${PRJ:-}" ] && [ -f "$PRJ/dist/index.js" ]; then
          if command -v node >/dev/null 2>&1; then
            CLI="node $PRJ/dist/index.js"
            node "$PRJ/dist/index.js" \(quotedArgs);
          else
            echo "Node >=22 required on remote host"; exit 127;
          fi
        elif [ -n "${PRJ:-}" ] && [ -f "$PRJ/bin/clawdbot.js" ]; then
          if command -v node >/dev/null 2>&1; then
            CLI="node $PRJ/bin/clawdbot.js"
            node "$PRJ/bin/clawdbot.js" \(quotedArgs);
          else
            echo "Node >=22 required on remote host"; exit 127;
          fi
        elif command -v pnpm >/dev/null 2>&1; then
          CLI="pnpm --silent clawdbot"
          pnpm --silent clawdbot \(quotedArgs);
        else
          echo "clawdbot CLI missing on remote host"; exit 127;
        fi
        """
        args.append(contentsOf: ["/bin/sh", "-c", scriptBody])
        return ["/usr/bin/ssh"] + args
    }

    struct RemoteSettings {
        let mode: AppState.ConnectionMode
        let target: String
        let identity: String
        let projectRoot: String
        let cliPath: String
    }

    static func connectionSettings(defaults: UserDefaults = .standard) -> RemoteSettings {
        let modeRaw = defaults.string(forKey: connectionModeKey)
        let mode: AppState.ConnectionMode
        if let modeRaw {
            mode = AppState.ConnectionMode(rawValue: modeRaw) ?? .local
        } else {
            let seen = defaults.bool(forKey: "clawdbot.onboardingSeen")
            mode = seen ? .local : .unconfigured
        }
        let target = defaults.string(forKey: remoteTargetKey) ?? ""
        let identity = defaults.string(forKey: remoteIdentityKey) ?? ""
        let projectRoot = defaults.string(forKey: remoteProjectRootKey) ?? ""
        let cliPath = defaults.string(forKey: remoteCliPathKey) ?? ""
        return RemoteSettings(
            mode: mode,
            target: self.sanitizedTarget(target),
            identity: identity,
            projectRoot: projectRoot,
            cliPath: cliPath)
    }

    static func connectionModeIsRemote(defaults: UserDefaults = .standard) -> Bool {
        self.connectionSettings(defaults: defaults).mode == .remote
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

    #if SWIFT_PACKAGE
    static func _testNodeManagerBinPaths(home: URL) -> [String] {
        self.nodeManagerBinPaths(home: home)
    }
    #endif
}
