import Foundation

enum ExecShellWrapperParser {
    struct ParsedShellWrapper {
        let isWrapper: Bool
        let command: String?

        static let notWrapper = ParsedShellWrapper(isWrapper: false, command: nil)
        static let blockedWrapper = ParsedShellWrapper(isWrapper: true, command: nil)
    }

    private enum Kind: Equatable {
        case posix
        case cmd
        case powershell
    }

    private struct WrapperSpec {
        let kind: Kind
        let names: Set<String>
    }

    private static let posixInlineFlags = Set(["-lc", "-c", "--command"])
    private static let powershellInlineFlags = Set(["-c", "-command", "--command"])

    private static let wrapperSpecs: [WrapperSpec] = [
        WrapperSpec(kind: .posix, names: ["ash", "sh", "bash", "zsh", "dash", "ksh", "fish"]),
        WrapperSpec(kind: .cmd, names: ["cmd.exe", "cmd"]),
        WrapperSpec(kind: .powershell, names: ["powershell", "powershell.exe", "pwsh", "pwsh.exe"]),
    ]
    private static let loginStartupShellNames = Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"])

    static func extract(command: [String], rawCommand: String?) -> ParsedShellWrapper {
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preferredRaw = trimmedRaw.isEmpty ? nil : trimmedRaw
        return self.extract(
            command: command,
            preferredRaw: preferredRaw,
            failClosedOnStartupWrappers: false,
            depth: 0)
    }

    static func extractForAllowlist(command: [String], rawCommand: String?) -> ParsedShellWrapper {
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preferredRaw = trimmedRaw.isEmpty ? nil : trimmedRaw
        return self.extract(
            command: command,
            preferredRaw: preferredRaw,
            failClosedOnStartupWrappers: true,
            depth: 0)
    }

    private static func extract(
        command: [String],
        preferredRaw: String?,
        failClosedOnStartupWrappers: Bool,
        depth: Int) -> ParsedShellWrapper
    {
        guard depth < ExecEnvInvocationUnwrapper.maxWrapperDepth else {
            return .notWrapper
        }
        guard let token0 = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return .notWrapper
        }

        let base0 = ExecCommandToken.basenameLower(token0)
        if base0 == "env" {
            guard let unwrapped = ExecEnvInvocationUnwrapper.unwrap(command) else {
                return .notWrapper
            }
            return self.extract(
                command: unwrapped,
                preferredRaw: preferredRaw,
                failClosedOnStartupWrappers: failClosedOnStartupWrappers,
                depth: depth + 1)
        }

        guard let spec = self.wrapperSpecs.first(where: { $0.names.contains(base0) }) else {
            return .notWrapper
        }
        if spec.kind == .posix,
           base0 == "fish",
           ExecInlineCommandParser.hasFishAttachedCommandOption(command)
        {
            return .blockedWrapper
        }
        let includeLegacyLoginInlineForm = failClosedOnStartupWrappers &&
            !self.legacyLoginInlinePayloadMatchesRaw(
                command: command,
                spec: spec,
                base0: base0,
                preferredRaw: preferredRaw)
        if self.startupWrapperRequiresFullArgv(
            command: command,
            spec: spec,
            base0: base0,
            includeLegacyLoginInlineForm: includeLegacyLoginInlineForm)
        {
            return .blockedWrapper
        }
        guard let payload = self.extractPayload(command: command, spec: spec) else {
            return .notWrapper
        }
        let normalized = failClosedOnStartupWrappers ? payload : preferredRaw ?? payload
        return ParsedShellWrapper(isWrapper: true, command: normalized)
    }

    private static func startupWrapperRequiresFullArgv(
        command: [String],
        spec: WrapperSpec,
        base0: String,
        includeLegacyLoginInlineForm: Bool) -> Bool
    {
        guard spec.kind == .posix else {
            return false
        }
        if base0 == "fish",
           ExecInlineCommandParser.hasFishInitCommandOption(command)
        {
            return true
        }
        if self.loginStartupShellNames.contains(base0),
           ExecInlineCommandParser.hasPosixLoginStartupBeforeInlineCommand(
               command,
               flags: self.posixInlineFlags)
        {
            return includeLegacyLoginInlineForm || !self.isLegacyShLoginInlineForm(command, base0: base0)
        }
        return ExecInlineCommandParser.hasPosixInteractiveStartupBeforeInlineCommand(
            command,
            flags: self.posixInlineFlags)
    }

    private static func isLegacyLoginInlineForm(_ command: [String]) -> Bool {
        guard command.count > 1 else {
            return false
        }
        return command[1].trimmingCharacters(in: .whitespacesAndNewlines) == "-lc"
    }

    private static func isLegacyShLoginInlineForm(_ command: [String], base0: String) -> Bool {
        base0 == "sh" && self.isLegacyLoginInlineForm(command)
    }

    private static func legacyLoginInlinePayloadMatchesRaw(
        command: [String],
        spec: WrapperSpec,
        base0: String,
        preferredRaw: String?) -> Bool
    {
        guard let preferredRaw,
              base0 == "sh",
              self.isLegacyLoginInlineForm(command),
              let payload = self.extractPayload(command: command, spec: spec)
        else {
            return false
        }
        return payload == preferredRaw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractPayload(command: [String], spec: WrapperSpec) -> String? {
        switch spec.kind {
        case .posix:
            self.extractPosixInlineCommand(command)
        case .cmd:
            self.extractCmdInlineCommand(command)
        case .powershell:
            self.extractPowerShellInlineCommand(command)
        }
    }

    private static func extractPosixInlineCommand(_ command: [String]) -> String? {
        ExecInlineCommandParser.extractInlineCommand(
            command,
            flags: self.posixInlineFlags,
            allowCombinedC: true)
    }

    private static func extractCmdInlineCommand(_ command: [String]) -> String? {
        guard let idx = command
            .firstIndex(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/c" })
        else {
            return nil
        }
        let tail = command.suffix(from: command.index(after: idx)).joined(separator: " ")
        let payload = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        return payload.isEmpty ? nil : payload
    }

    private static func extractPowerShellInlineCommand(_ command: [String]) -> String? {
        for idx in 1..<command.count {
            let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if token.isEmpty { continue }
            if token == "--" { break }
            if self.powershellInlineFlags.contains(token) {
                return ExecInlineCommandParser.extractInlineCommand(
                    command,
                    flags: self.powershellInlineFlags,
                    allowCombinedC: false)
            }
        }
        return nil
    }
}
