import Commander
import Foundation

@MainActor
struct ServiceRootCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(
            commandName: "service",
            abstract: "Manage launchd agent",
            subcommands: [ServiceInstall.self, ServiceUninstall.self, ServiceStatus.self])
    }
}

private enum LaunchdHelper {
    static let label = "com.swabble.agent"

    static var plistURL: URL {
        FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static func writePlist(executable: String) throws {
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [executable, "serve"],
            "RunAtLoad": true,
            "KeepAlive": true
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL)
    }

    static func removePlist() throws {
        try? FileManager.default.removeItem(at: plistURL)
    }
}

@MainActor
struct ServiceInstall: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "install", abstract: "Install user launch agent")
    }

    mutating func run() async throws {
        let exe = CommandLine.arguments.first ?? "/usr/local/bin/swabble"
        try LaunchdHelper.writePlist(executable: exe)
        print("launchctl load -w \(LaunchdHelper.plistURL.path)")
    }
}

@MainActor
struct ServiceUninstall: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "uninstall", abstract: "Remove launch agent")
    }

    mutating func run() async throws {
        try LaunchdHelper.removePlist()
        print("launchctl bootout gui/$(id -u)/\(LaunchdHelper.label)")
    }
}

@MainActor
struct ServiceStatus: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "status", abstract: "Show launch agent status")
    }

    mutating func run() async throws {
        if FileManager.default.fileExists(atPath: LaunchdHelper.plistURL.path) {
            print("plist present at \(LaunchdHelper.plistURL.path)")
        } else {
            print("launchd plist not installed")
        }
    }
}
