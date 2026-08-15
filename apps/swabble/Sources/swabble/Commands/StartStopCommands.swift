import Commander
import Foundation

@MainActor
struct StartCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "start", abstract: "Start swabble (foreground placeholder)")
    }

    mutating func run() async throws {
        print("start: launchd helper not implemented; run 'swabble serve' instead")
    }
}

@MainActor
struct StopCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "stop", abstract: "Stop swabble (placeholder)")
    }

    mutating func run() async throws {
        print("stop: launchd helper not implemented yet")
    }
}

@MainActor
struct RestartCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "restart", abstract: "Restart swabble (placeholder)")
    }

    mutating func run() async throws {
        print("restart: launchd helper not implemented yet")
    }
}
