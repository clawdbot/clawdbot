import Commander
import Foundation
import Swabble

@MainActor
struct StatusCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "status", abstract: "Show daemon state")
    }

    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?

    init() {}
    init(parsed: ParsedValues) {
        self.init()
        if let cfg = parsed.options["config"]?.last { configPath = cfg }
    }

    mutating func run() async throws {
        let cfg = try? ConfigLoader.load(at: configURL)
        let wake = cfg?.wake.word ?? "clawd"
        let wakeEnabled = cfg?.wake.enabled ?? false
        let latest = await TranscriptsStore.shared.latest().suffix(3)
        print("wake: \(wakeEnabled ? wake : "disabled")")
        if latest.isEmpty {
            print("transcripts: (none yet)")
        } else {
            print("last transcripts:")
            latest.forEach { print("- \($0)") }
        }
    }

    private var configURL: URL? { configPath.map { URL(fileURLWithPath: $0) } }
}
