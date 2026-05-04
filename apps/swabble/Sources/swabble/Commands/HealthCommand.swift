import Commander
import Foundation

@MainActor
struct HealthCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "health", abstract: "Health probe")
    }

    init() {}
    init(parsed: ParsedValues) {}

    mutating func run() async throws {
        print("ok")
    }
}
