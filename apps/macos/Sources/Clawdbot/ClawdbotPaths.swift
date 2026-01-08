import Foundation

enum ClawdbotEnv {
    static func path(_ key: String) -> String? {
        // Normalize env overrides once so UI + file IO stay consistent.
        guard let raw = getenv(key) else { return nil }
        let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty
        else {
            return nil
        }
        return value
    }
}

enum ClawdbotPaths {
    private static let configPathEnv = "CLAWDBOT_CONFIG_PATH"
    private static let stateDirEnv = "CLAWDBOT_STATE_DIR"

    static var stateDirURL: URL {
        if let override = ClawdbotEnv.path(self.stateDirEnv) {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdbot", isDirectory: true)
    }

    static var configURL: URL {
        if let override = ClawdbotEnv.path(self.configPathEnv) {
            return URL(fileURLWithPath: override)
        }
        return self.stateDirURL.appendingPathComponent("clawdbot.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }
}
