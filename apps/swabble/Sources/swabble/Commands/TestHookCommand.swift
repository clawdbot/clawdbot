import Commander
import Foundation
import Swabble

@MainActor
struct TestHookCommand: ParsableCommand {
    @Argument(help: "Text to send to hook") var text: String
    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?

    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "test-hook", abstract: "Invoke the configured hook with text")
    }

    init() {}

    init(parsed: ParsedValues) {
        self.init()
        if let positional = parsed.positional.first { text = positional }
        if let cfg = parsed.options["config"]?.last { configPath = cfg }
    }

    mutating func run() async throws {
        let cfg = try ConfigLoader.load(at: configURL)
        let executor = HookExecutor(config: cfg)
        try await executor.run(job: HookJob(text: text, timestamp: Date()))
        print("hook invoked")
    }

    private var configURL: URL? { configPath.map { URL(fileURLWithPath: $0) } }
}
