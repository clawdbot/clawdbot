import Commander
import Foundation

@available(macOS 26.0, *)
@MainActor
enum CLIRegistry {
    static var descriptors: [CommandDescriptor] {
        let serveDesc = descriptor(for: ServeCommand.self)
        let transcribeDesc = descriptor(for: TranscribeCommand.self)
        let testHookDesc = descriptor(for: TestHookCommand.self)
        let micList = descriptor(for: MicList.self)
        let micSet = descriptor(for: MicSet.self)
        let micRoot = CommandDescriptor(
            name: "mic",
            abstract: "Microphone management",
            discussion: nil,
            signature: CommandSignature(),
            subcommands: [micList, micSet])
        let serviceRoot = CommandDescriptor(
            name: "service",
            abstract: "launchd helper",
            discussion: nil,
            signature: CommandSignature(),
            subcommands: [
                descriptor(for: ServiceInstall.self),
                descriptor(for: ServiceUninstall.self),
                descriptor(for: ServiceStatus.self)
            ])
        let doctorDesc = descriptor(for: DoctorCommand.self)
        let setupDesc = descriptor(for: SetupCommand.self)
        let healthDesc = descriptor(for: HealthCommand.self)
        let tailLogDesc = descriptor(for: TailLogCommand.self)
        let startDesc = descriptor(for: StartCommand.self)
        let stopDesc = descriptor(for: StopCommand.self)
        let restartDesc = descriptor(for: RestartCommand.self)
        let statusDesc = descriptor(for: StatusCommand.self)

        let rootSignature = CommandSignature().withStandardRuntimeFlags()
        let root = CommandDescriptor(
            name: "swabble",
            abstract: "Speech hook daemon",
            discussion: "Local wake-word → SpeechTranscriber → hook",
            signature: rootSignature,
            subcommands: [
                serveDesc,
                transcribeDesc,
                testHookDesc,
                micRoot,
                serviceRoot,
                doctorDesc,
                setupDesc,
                healthDesc,
                tailLogDesc,
                startDesc,
                stopDesc,
                restartDesc,
                statusDesc
            ])
        return [root]
    }

    private static func descriptor(for type: any ParsableCommand.Type) -> CommandDescriptor {
        let sig = CommandSignature.describe(type.init()).withStandardRuntimeFlags()
        return CommandDescriptor(
            name: type.commandDescription.commandName ?? "",
            abstract: type.commandDescription.abstract,
            discussion: type.commandDescription.discussion,
            signature: sig,
            subcommands: [])
    }
}
