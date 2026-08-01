import Commander
import Foundation

@MainActor
struct HealthCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "health", abstract: "Health probe")
    }

    mutating func run() async throws {
        print("ok")
    }
}
