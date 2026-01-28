import Foundation

enum CommandResolver {
    private static let projectRootDefaultsKey = "moltbot.gatewayProjectRootPath"
    private static let helperName = "moltbot"

    static func gatewayEntrypoint(in root: URL) -> String? {
        let distEntry = root.appendingPathComponent("dist/index.js").path
        if FileManager().isReadableFile(atPath: distEntry) { return distEntry }
        let binEntry = root.appendingPathComponent("bin/moltbot.js").path
        if FileManager().isReadableFile(atPath: binEntry) { return binEntry }
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
           FileManager().fileExists(atPath: url.path)
        {
            return url
        }
        let fallback = FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Projects/moltbot")
        if FileManager().fileExists(atPath: fallback.path) {
            return fallback
        }
        return FileManager().homeDirectoryForCurrentUser
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
        let home = FileManager().homeDirectoryForCurrentUser
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
        #if DEBUG
        // Dev-only convenience. Avoid project-local PATH hijacking in release builds.
        extras.insert(projectRoot.appendingPathComponent("node_modules/.bin").path, at: 0)
        #endif
        let moltbotPaths = self.moltbotManagedPaths(home: home)
        if !moltbotPaths.isEmpty {
            extras.insert(contentsOf: moltbotPaths, at: 1)
        }
        extras.insert(contentsOf: self.nodeManagerBinPaths(home: home), at: 1 + moltbotPaths.count)
        var seen = Set<String>()
        // Preserve order while stripping duplicates so PATH lookups remain deterministic.
        return (extras + current).filter { seen.insert($0).inserted }
    }

    private static func moltbotManagedPaths(home: URL) -> [String] {
        let base = home.appendingPathComponent(".clawdbot")
        let bin = base.appendingPathComponent("bin")
        let nodeBin = base.appendingPathComponent("tools/node/bin")
        var paths: [String] = []
        if FileManager().fileExists(atPath: bin.path) {
            paths.append(bin.path)
        }
        if FileManager().fileExists(atPath: nodeBin.path) {
            paths.append(nodeBin.path)
        }
        return paths
    }

    private static func nodeManagerBinPaths(home: URL) -> [String] {
        var bins: [String] = []

        // Volta
        let volta = home.appendingPathComponent(".volta/bin")
        if FileManager().fileExists(atPath: volta.path) {
            bins.append(volta.path)
        }

        // asdf
        let asdf = home.appendingPathComponent(".asdf/shims")
        if FileManager().fileExists(atPath: asdf.path) {
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
        guard FileManager().fileExists(atPath: base.path) else { return [] }
        let entries: [String]
        do {
            entries = try FileManager().contentsOfDirectory(atPath: base.path)
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
            if FileManager().isExecutableFile(atPath: node.path) {
                paths.append(binDir.path)
            }
        }
        return paths
    }

    static func findExecutable(named name: String, searchPaths: [String]? = nil) -> String? {
        for dir in searchPaths ?? self.preferredPaths() {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager().isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func moltbotExecutable(searchPaths: [String]? = nil) -> String? {
        self.findExecutable(named: self.helperName, searchPaths: searchPaths)
    }

    static func projectMoltbotExecutable(projectRoot: URL? = nil) -> String? {
        #if DEBUG
        let root = projectRoot ?? self.projectRoot()
        let candidate = root.appendingPathComponent("node_modules/.bin").appendingPathComponent(self.helperName).path
        return FileManager().isExecutableFile(atPath: candidate) ? candidate : nil
        #else
        return nil
        #endif
    }

    static func nodeCliPath() -> String? {
        let candidate = self.projectRoot().appendingPathComponent("bin/moltbot.js").path
        return FileManager().isReadableFile(atPath: candidate) ? candidate : nil
    }

    static func hasAnyMoltbotInvoker(searchPaths: [String]? = nil) -> Bool {
        if self.moltbotExecutable(searchPaths: searchPaths) != nil { return true }
        if self.findExecutable(named: "pnpm", searchPaths: searchPaths) != nil { return true }
        if self.findExecutable(named: "node", searchPaths: searchPaths) != nil,
           self.nodeCliPath() != nil
        {
            return true
        }
        return false
    }

    static func moltbotNodeCommand(
        subcommand: String,
        extraArgs: [String] = [],
        defaults: UserDefaults = .standard,
        configRoot: [String: Any]? = nil,
        searchPaths: [String]? = nil) -> [String]
    {
        let settings = self.connectionSettings(defaults: defaults, configRoot: configRoot)
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
            if let moltbotPath = self.projectMoltbotExecutable(projectRoot: root) {
                return [moltbotPath, subcommand] + extraArgs
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
                return [pnpm, "--silent", "moltbot", subcommand] + extraArgs
            }
            if let moltbotPath = self.moltbotExecutable(searchPaths: searchPaths) {
                return [moltbotPath, subcommand] + extraArgs
            }

            let missingEntry = """
            moltbot entrypoint missing (looked for dist/index.js or bin/moltbot.js); run pnpm build.
            """
            return self.errorCommand(with: missingEntry)

        case let .failure(error):
            return self.runtimeErrorCommand(error)
        }
    }

    // Existing callers still refer to moltbotCommand; keep it as node alias.
    static func moltbotCommand(
        subcommand: String,
        extraArgs: [String] = [],
        defaults: UserDefaults = .standard,
        configRoot: [String: Any]? = nil,
        searchPaths: [String]? = nil) -> [String]
    {
        self.moltbotNodeCommand(
            subcommand: subcommand,
            extraArgs: extraArgs,
            defaults: defaults,
            configRoot: configRoot,
            searchPaths: searchPaths)
    }

    // MARK: - SSH helpers

    private static func sshNodeCommand(subcommand: String, extraArgs: [String], settings: RemoteSettings) -> [String]? {
        guard !settings.target.isEmpty else { return nil }
        guard let parsed = self.parseSSHTarget(settings.target) else { return nil }

        // Run the real moltbot CLI on the remote host.
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
            DEFAULT_PRJ="$HOME/Projects/moltbot"
            if [ -d "$DEFAULT_PRJ" ]; then
              PRJ="$DEFAULT_PRJ"
              cd "$PRJ" || { echo "Project root not found: $PRJ"; exit 127; }
            fi
            """
        } else {
            """
            PRJ=\(self.shellQuote(userPRJ))
            cd "$PRJ" || { echo "Project root not found: $PRJ"; exit 127; }
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
        if command -v moltbot >/dev/null 2>&1; then
          CLI="$(command -v moltbot)"
          moltbot \(quotedArgs);
        elif [ -n "${PRJ:-}" ] && [ -f "$PRJ/dist/index.js" ]; then
          if command -v node >/dev/null 2>&1; then
            CLI="node $PRJ/dist/index.js"
            node "$PRJ/dist/index.js" \(quotedArgs);
          else
            echo "Node >=22 required on remote host"; exit 127;
          fi
        elif [ -n "${PRJ:-}" ] && [ -f "$PRJ/bin/moltbot.js" ]; then
          if command -v node >/dev/null 2>&1; then
            CLI="node $PRJ/bin/moltbot.js"
            node "$PRJ/bin/moltbot.js" \(quotedArgs);
          else
            echo "Node >=22 required on remote host"; exit 127;
          fi
        elif command -v pnpm >/dev/null 2>&1; then
          CLI="pnpm --silent moltbot"
          pnpm --silent moltbot \(quotedArgs);
        else
          echo "moltbot CLI missing on remote host"; exit 127;
        fi
        """
        let options: [String] = [
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UpdateHostKeys=yes",
        ]
        let args = self.sshArguments(
            target: parsed,
            identity: settings.identity,
            options: options,
            remoteCommand: ["/bin/sh", "-c", scriptBody])
        return ["/usr/bin/ssh"] + args
    }

    struct RemoteSettings {
        let mode: AppState.ConnectionMode
        let target: String
        let identity: String
        let projectRoot: String
        let cliPath: String
    }

    static func connectionSettings(
        defaults: UserDefaults = .standard,
        configRoot: [String: Any]? = nil) -> RemoteSettings
    {
        let root = configRoot ?? MoltbotConfigFile.loadDict()
        let mode = ConnectionModeResolver.resolve(root: root, defaults: defaults).mode
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
        let trimmed = self.normalizeSSHTargetInput(target)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.rangeOfCharacter(from: CharacterSet.whitespacesAndNewlines.union(.controlCharacters)) != nil {
            return nil
        }
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
            guard let parsedPort = Int(portStr), parsedPort > 0, parsedPort <= 65535 else {
                return nil
            }
            port = parsedPort
        } else {
            host = userHostPort
            port = 22
        }

        return self.makeSSHTarget(user: user, host: host, port: port)
    }

    static func sshTargetValidationMessage(_ target: String) -> String? {
        let trimmed = self.normalizeSSHTargetInput(target)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("-") {
            return "SSH target cannot start with '-'"
        }
        if trimmed.rangeOfCharacter(from: CharacterSet.whitespacesAndNewlines.union(.controlCharacters)) != nil {
            return "SSH target cannot contain spaces"
        }
        if self.parseSSHTarget(trimmed) == nil {
            return "SSH target must look like user@host[:port]"
        }
        return nil
    }

    private static func shellQuote(_ text: String) -> String {
        if text.isEmpty { return "''" }
        let escaped = text.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }

    private static func expandPath(_ path: String) -> URL? {
        var expanded = path
        if expanded.hasPrefix("~") {
            let home = FileManager().homeDirectoryForCurrentUser.path
            expanded.replaceSubrange(expanded.startIndex...expanded.startIndex, with: home)
        }
        return URL(fileURLWithPath: expanded)
    }

    private static func normalizeSSHTargetInput(_ target: String) -> String {
        var trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("ssh ") {
            trimmed = trimmed.replacingOccurrences(of: "ssh ", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    private static func isValidSSHComponent(_ value: String, allowLeadingDash: Bool = false) -> Bool {
        if value.isEmpty { return false }
        if !allowLeadingDash, value.hasPrefix("-") { return false }
        let invalid = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        return value.rangeOfCharacter(from: invalid) == nil
    }

    static func makeSSHTarget(user: String?, host: String, port: Int) -> SSHParsedTarget? {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.isValidSSHComponent(trimmedHost) else { return nil }
        let trimmedUser = user?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedUser: String?
        if let trimmedUser {
            guard self.isValidSSHComponent(trimmedUser) else { return nil }
            normalizedUser = trimmedUser.isEmpty ? nil : trimmedUser
        } else {
            normalizedUser = nil
        }
        guard port > 0, port <= 65535 else { return nil }
        return SSHParsedTarget(user: normalizedUser, host: trimmedHost, port: port)
    }

    private static func sshTargetString(_ target: SSHParsedTarget) -> String {
        target.user.map { "\($0)@\(target.host)" } ?? target.host
    }

    static func sshArguments(
        target: SSHParsedTarget,
        identity: String,
        options: [String],
        remoteCommand: [String] = []) -> [String]
    {
        var args = options
        if target.port > 0 {
            args.append(contentsOf: ["-p", String(target.port)])
        }
        let trimmedIdentity = identity.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedIdentity.isEmpty {
            // Only use IdentitiesOnly when an explicit identity file is provided.
            // This allows 1Password SSH agent and other SSH agents to provide keys.
            args.append(contentsOf: ["-o", "IdentitiesOnly=yes"])
            args.append(contentsOf: ["-i", trimmedIdentity])
        }
        args.append("--")
        args.append(self.sshTargetString(target))
        args.append(contentsOf: remoteCommand)
        return args
    }

    #if SWIFT_PACKAGE
    static func _testNodeManagerBinPaths(home: URL) -> [String] {
        self.nodeManagerBinPaths(home: home)
    }
    #endif
}
