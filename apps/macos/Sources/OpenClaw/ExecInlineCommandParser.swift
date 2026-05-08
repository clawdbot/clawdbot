import Foundation

enum ExecInlineCommandParser {
    struct Match {
        let tokenIndex: Int
        let inlineCommand: String?
        let valueTokenOffset: Int

        init(tokenIndex: Int, inlineCommand: String?, valueTokenOffset: Int = 1) {
            self.tokenIndex = tokenIndex
            self.inlineCommand = inlineCommand
            self.valueTokenOffset = valueTokenOffset
        }
    }

    private struct CombinedCommandFlag {
        let attachedCommand: String?
        let separateValueCount: Int
    }

    private static let posixShellOptionsWithSeparateValues = Set([
        "--init-file",
        "--rcfile",
        "-O",
        "-o",
        "+O",
        "+o",
    ])

    static func hasPosixInteractiveStartupBeforeInlineCommand(
        _ argv: [String],
        flags: Set<String>) -> Bool
    {
        var idx = 1
        var sawInteractiveMode = false
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" {
                return false
            }
            if self.isPosixInteractiveModeOption(token) {
                sawInteractiveMode = true
            }
            if flags.contains(token) || self.isCombinedCommandFlag(token) {
                return sawInteractiveMode
            }
            if !token.hasPrefix("-"), !token.hasPrefix("+") {
                return false
            }
            let combinedValueCount = self.combinedSeparateValueOptionCount(token)
            if combinedValueCount > 0 {
                idx += 1 + combinedValueCount
                continue
            }
            if self.consumesSeparateValue(token) {
                idx += 2
                continue
            }
            idx += 1
        }
        return false
    }

    static func hasPosixLoginStartupBeforeInlineCommand(
        _ argv: [String],
        flags: Set<String>) -> Bool
    {
        var idx = 1
        var sawLoginMode = false
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" {
                return false
            }
            if token == "--login" || self.isPosixShortOption(token, containing: "l") {
                sawLoginMode = true
            }
            if flags.contains(token) || self.isCombinedCommandFlag(token) {
                return sawLoginMode
            }
            if !token.hasPrefix("-"), !token.hasPrefix("+") {
                return false
            }
            let combinedValueCount = self.combinedSeparateValueOptionCount(token)
            if combinedValueCount > 0 {
                idx += 1 + combinedValueCount
                continue
            }
            if self.consumesSeparateValue(token) {
                idx += 2
                continue
            }
            idx += 1
        }
        return false
    }

    static func hasFishInitCommandOption(_ argv: [String]) -> Bool {
        var idx = 1
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" {
                return false
            }
            if token == "-C" || token == "--init-command" {
                return true
            }
            if token.hasPrefix("-C"), token != "-C" {
                return true
            }
            if token.hasPrefix("--init-command=") {
                return true
            }
            if !token.hasPrefix("-"), !token.hasPrefix("+") {
                return false
            }
            idx += 1
        }
        return false
    }

    static func hasFishAttachedCommandOption(_ argv: [String]) -> Bool {
        var idx = 1
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" {
                return false
            }
            if token.hasPrefix("-c"), token != "-c" {
                return true
            }
            if !token.hasPrefix("-"), !token.hasPrefix("+") {
                return false
            }
            idx += 1
        }
        return false
    }

    static func findMatch(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool) -> Match?
    {
        var idx = 1
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if token == "--" {
                break
            }
            let comparableToken = allowCombinedC ? token : token.lowercased()
            if flags.contains(comparableToken) {
                return Match(tokenIndex: idx, inlineCommand: nil)
            }
            if allowCombinedC, let combined = self.parseCombinedCommandFlag(token) {
                if let attachedCommand = combined.attachedCommand {
                    return Match(tokenIndex: idx, inlineCommand: attachedCommand, valueTokenOffset: 0)
                }
                return Match(
                    tokenIndex: idx,
                    inlineCommand: nil,
                    valueTokenOffset: 1 + combined.separateValueCount)
            }
            if allowCombinedC, !token.hasPrefix("-"), !token.hasPrefix("+") {
                break
            }
            let combinedValueCount = allowCombinedC ? self.combinedSeparateValueOptionCount(token) : 0
            if combinedValueCount > 0 {
                idx += 1 + combinedValueCount
                continue
            }
            if allowCombinedC, self.consumesSeparateValue(token) {
                idx += 2
                continue
            }
            idx += 1
        }
        return nil
    }

    static func extractInlineCommand(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool) -> String?
    {
        guard let match = self.findMatch(argv, flags: flags, allowCombinedC: allowCombinedC) else {
            return nil
        }
        if let inlineCommand = match.inlineCommand {
            return inlineCommand
        }
        let nextIndex = match.tokenIndex + match.valueTokenOffset
        let payload = nextIndex < argv.count
            ? argv[nextIndex].trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        return payload.isEmpty ? nil : payload
    }

    private static func isCombinedCommandFlag(_ token: String) -> Bool {
        self.parseCombinedCommandFlag(token) != nil
    }

    private static func parseCombinedCommandFlag(_ token: String) -> CombinedCommandFlag? {
        let chars = Array(token)
        guard chars.count >= 2, chars[0] == "-", chars[1] != "-" else {
            return nil
        }
        let optionChars = Array(chars.dropFirst())
        guard let commandFlagIndex = optionChars.firstIndex(of: "c") else {
            return nil
        }
        if optionChars.contains("-") {
            return nil
        }
        let suffix = String(optionChars.dropFirst(commandFlagIndex + 1))
        if !suffix.isEmpty,
           suffix.range(of: #"[^A-Za-z]"#, options: .regularExpression) != nil
        {
            return CombinedCommandFlag(attachedCommand: suffix, separateValueCount: 0)
        }
        let separateValueCount = optionChars.reduce(0) { count, char in
            count + ((char == "o" || char == "O") ? 1 : 0)
        }
        return CombinedCommandFlag(attachedCommand: nil, separateValueCount: separateValueCount)
    }

    private static func combinedSeparateValueOptionCount(_ token: String) -> Int {
        let chars = Array(token)
        guard chars.count >= 2, chars[0] == "-" || chars[0] == "+", chars[1] != "-" else {
            return 0
        }
        if chars.dropFirst().contains("-") {
            return 0
        }
        return chars.dropFirst().reduce(0) { count, char in
            count + ((char == "o" || char == "O") ? 1 : 0)
        }
    }

    private static func consumesSeparateValue(_ token: String) -> Bool {
        self.posixShellOptionsWithSeparateValues.contains(token)
    }

    private static func isPosixInteractiveModeOption(_ token: String) -> Bool {
        token == "--interactive" || self.isPosixShortOption(token, containing: "i")
    }

    private static func isPosixShortOption(_ token: String, containing option: Character) -> Bool {
        let chars = Array(token)
        guard chars.count >= 2, chars[0] == "-", chars[1] != "-" else {
            return false
        }
        if chars.dropFirst().contains("-") {
            return false
        }
        return chars.dropFirst().contains(option)
    }
}
