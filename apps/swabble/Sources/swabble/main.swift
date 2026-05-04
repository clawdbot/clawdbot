import Commander
import Foundation

@available(macOS 26.0, *)
@MainActor
private func runCLI() async -> Int32 {
    do {
        let descriptors = CLIRegistry.descriptors
        let program = Program(descriptors: descriptors)
        let invocation = try program.resolve(argv: CommandLine.arguments)
        try await dispatch(invocation: invocation)
        return 0
    } catch {
        fputs("error: \(error)\n", stderr)
        return 1
    }
}

@available(macOS 26.0, *)
@MainActor
private func dispatch(invocation: CommandInvocation) async throws {
    let parsed = invocation.parsedValues
    let path = invocation.path
    guard let first = path.first else { throw CommanderProgramError.missingCommand }

    switch first {
    case "swabble":
        try await dispatchSwabble(parsed: parsed, path: path)
    default:
        throw CommanderProgramError.unknownCommand(first)
    }
}

@available(macOS 26.0, *)
@MainActor
private func dispatchSwabble(parsed: ParsedValues, path: [String]) async throws {
    let sub = try subcommand(path, index: 1, command: "swabble")
    switch sub {
    case "mic":
        try await dispatchMic(parsed: parsed, path: path)
    case "service":
        try await dispatchService(path: path)
    default:
        let handlers = swabbleHandlers(parsed: parsed)
        guard let handler = handlers[sub] else {
            throw CommanderProgramError.unknownSubcommand(command: "swabble", name: sub)
        }
        try await handler()
    }
}

@available(macOS 26.0, *)
@MainActor
private func swabbleHandlers(parsed: ParsedValues) -> [String: () async throws -> Void] {
    [
        "serve": {
            var cmd = ServeCommand(parsed: parsed)
            try await cmd.run()
        },
        "transcribe": {
            var cmd = TranscribeCommand(parsed: parsed)
            try await cmd.run()
        },
        "test-hook": {
            var cmd = TestHookCommand(parsed: parsed)
            try await cmd.run()
        },
        "doctor": {
            var cmd = DoctorCommand(parsed: parsed)
            try await cmd.run()
        },
        "setup": {
            var cmd = SetupCommand(parsed: parsed)
            try await cmd.run()
        },
        "health": {
            var cmd = HealthCommand(parsed: parsed)
            try await cmd.run()
        },
        "tail-log": {
            var cmd = TailLogCommand(parsed: parsed)
            try await cmd.run()
        },
        "start": {
            var cmd = StartCommand()
            try await cmd.run()
        },
        "stop": {
            var cmd = StopCommand()
            try await cmd.run()
        },
        "restart": {
            var cmd = RestartCommand()
            try await cmd.run()
        },
        "status": {
            var cmd = StatusCommand()
            try await cmd.run()
        }
    ]
}

@available(macOS 26.0, *)
@MainActor
private func dispatchMic(parsed: ParsedValues, path: [String]) async throws {
    let micSub = try subcommand(path, index: 2, command: "mic")
    switch micSub {
    case "list":
        var cmd = MicList(parsed: parsed)
        try await cmd.run()
    case "set":
        var cmd = MicSet(parsed: parsed)
        try await cmd.run()
    default:
        throw CommanderProgramError.unknownSubcommand(command: "mic", name: micSub)
    }
}

@available(macOS 26.0, *)
@MainActor
private func dispatchService(path: [String]) async throws {
    let svcSub = try subcommand(path, index: 2, command: "service")
    switch svcSub {
    case "install":
        var cmd = ServiceInstall()
        try await cmd.run()
    case "uninstall":
        var cmd = ServiceUninstall()
        try await cmd.run()
    case "status":
        var cmd = ServiceStatus()
        try await cmd.run()
    default:
        throw CommanderProgramError.unknownSubcommand(command: "service", name: svcSub)
    }
}

private func subcommand(_ path: [String], index: Int, command: String) throws -> String {
    guard path.count > index else {
        throw CommanderProgramError.missingSubcommand(command: command)
    }
    return path[index]
}

if #available(macOS 26.0, *) {
    let exitCode = await runCLI()
    exit(exitCode)
} else {
    fputs("error: swabble requires macOS 26 or newer\n", stderr)
    exit(1)
}
