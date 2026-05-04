import Commander
import Foundation
import Swabble

@MainActor
struct SetupCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "setup", abstract: "Write default config")
    }

    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?

    init() {}
    init(parsed: ParsedValues) {
        self.init()
        if let cfg = parsed.options["config"]?.last { configPath = cfg }
    }

    mutating func run() async throws {
        let cfg = SwabbleConfig()
        try ConfigLoader.save(cfg, at: configURL)
        print("wrote config to \(configURL?.path ?? SwabbleConfig.defaultPath.path)")
    }

    private var configURL: URL? { configPath.map { URL(fileURLWithPath: $0) } }
}
