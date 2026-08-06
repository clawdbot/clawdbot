import Foundation

enum LaunchAgentManager {
    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.mac.plist")
    }

    static func status() async -> Bool {
        guard FileManager().fileExists(atPath: self.plistURL.path) else { return false }
        return await self.isLoaded()
    }

    private static func isLoaded() async -> Bool {
        let result = await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"])
        return result == 0
    }

    @discardableResult
    static func set(
        enabled: Bool,
        bundlePath: String,
        loaded: Bool? = nil,
        writePlist: ((String) -> Void)? = nil) async -> Bool
    {
        if enabled {
            let persist = writePlist ?? { self.writePlist(bundlePath: $0) }
            persist(bundlePath)
            let alreadyLoaded = if let loaded {
                loaded
            } else {
                await self.isLoaded()
            }
            // Startup hydrates the toggle from launchd. Reinstalling the active job here
            // would boot out the app that is still responsible for bootstrapping it again.
            guard !alreadyLoaded else { return false }
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
            _ = await self.runLaunchctl(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            _ = await self.runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"])
        } else {
            // Disable autostart going forward but leave the current app running.
            // bootout would terminate the launchd job immediately (and crash the app if launched via agent).
            try? FileManager().removeItem(at: self.plistURL)
        }
        return true
    }

    private static func writePlist(bundlePath: String) {
        let plist = self.plistContents(bundlePath: bundlePath)
        try? plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
    }

    static func plistContents(
        bundlePath: String,
        preferredPaths: [String] = CommandResolver.preferredPaths()) -> String
    {
        let path = self.escapePlistText(preferredPaths.joined(separator: ":"))
        let profileEnvironment = self.profileEnvironmentPlistEntries()
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>ai.openclaw.mac</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(bundlePath)/Contents/MacOS/OpenClaw</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(FileManager().homeDirectoryForCurrentUser.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>EnvironmentVariables</key>
          <dict>
            <key>PATH</key>
            <string>\(path)</string>\(profileEnvironment)
          </dict>
          <key>StandardOutPath</key>
          <string>\(LogLocator.launchdLogPath)</string>
          <key>StandardErrorPath</key>
          <string>\(LogLocator.launchdLogPath)</string>
        </dict>
        </plist>
        """
    }

    private static func profileEnvironmentPlistEntries() -> String {
        ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"].compactMap { key in
            guard let value = OpenClawEnv.path(key) else { return nil }
            return """

                        <key>\(key)</key>
                        <string>\(self.escapePlistText(value))</string>
            """
        }.joined()
    }

    private static func escapePlistText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    @discardableResult
    private static func runLaunchctl(_ args: [String]) async -> Int32 {
        do {
            return try await BoundedProcess.run(
                path: "/bin/launchctl",
                arguments: args,
                timeout: 5).terminationStatus
        } catch {
            return -1
        }
    }
}
