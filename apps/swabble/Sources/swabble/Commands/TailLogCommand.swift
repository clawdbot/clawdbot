import Commander
import Foundation
import Swabble

@MainActor
struct TailLogCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "tail-log", abstract: "Tail recent transcripts")
    }

    init() {}
    init(parsed: ParsedValues) {}

    mutating func run() async throws {
        let latest = await TranscriptsStore.shared.latest()
        for line in latest.suffix(10) {
            print(line)
        }
    }
}
