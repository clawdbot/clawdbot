import Foundation

enum ExecCommandToken {
    static func basenameLower(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let normalized = trimmed.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map { String($0).lowercased() } ?? normalized.lowercased()
    }
}

enum ExecEnvInvocationUnwrapper {
    static let maxWrapperDepth = 4

    struct UnwrapResult {
        let command: [String]
        let usesModifiers: Bool
    }

    private static func isEnvAssignment(_ token: String) -> Bool {
        let pattern = #"^[A-Za-z_][A-Za-z0-9_]*=.*"#
        return token.range(of: pattern, options: .regularExpression) != nil
    }

    static func unwrap(_ command: [String]) -> [String]? {
        self.unwrapWithMetadata(command)?.command
    }

    static func unwrapWithMetadata(_ command: [String]) -> UnwrapResult? {
        var idx = 1
        var expectsOptionValue = false
        var usesModifiers = false
        while idx < command.count {
            let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                return nil
            }
            if expectsOptionValue {
                expectsOptionValue = false
                usesModifiers = true
                idx += 1
                continue
            }
            if token == "--" {
                idx += 1
                break
            }
            if token == "-" {
                usesModifiers = true
                idx += 1
                break
            }
            if self.isEnvAssignment(token) {
                usesModifiers = true
                idx += 1
                continue
            }
            if token.hasPrefix("-"), token != "-" {
                let lower = token.lowercased()
                let flag = lower.split(separator: "=", maxSplits: 1).first.map(String.init) ?? lower
                if ExecEnvOptions.flagOnly.contains(flag) {
                    usesModifiers = true
                    idx += 1
                    continue
                }
                if ExecEnvOptions.withValue.contains(flag) {
                    usesModifiers = true
                    if !lower.contains("=") {
                        expectsOptionValue = true
                    }
                    idx += 1
                    continue
                }
                if lower.hasPrefix("-u") ||
                    lower.hasPrefix("-c") ||
                    lower.hasPrefix("-s") ||
                    lower.hasPrefix("--unset=") ||
                    lower.hasPrefix("--chdir=") ||
                    lower.hasPrefix("--split-string=") ||
                    lower.hasPrefix("--default-signal=") ||
                    lower.hasPrefix("--ignore-signal=") ||
                    lower.hasPrefix("--block-signal=")
                {
                    usesModifiers = true
                    idx += 1
                    continue
                }
                return nil
            }
            break
        }
        guard !expectsOptionValue,
              idx < command.count,
              !command[idx].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return UnwrapResult(command: Array(command[idx...]), usesModifiers: usesModifiers)
    }

    static func unwrapDispatchWrappersForResolution(_ command: [String]) -> [String] {
        var current = command
        var depth = 0
        while depth < self.maxWrapperDepth {
            guard let token = current.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
                break
            }
            guard ExecCommandToken.basenameLower(token) == "env" else {
                break
            }
            guard let unwrapped = unwrapWithMetadata(current), !unwrapped.command.isEmpty else {
                break
            }
            if unwrapped.usesModifiers {
                break
            }
            current = unwrapped.command
            depth += 1
        }
        return current
    }

    private static func unwrapTransparentEnvInvocation(_ command: [String]) -> [String]? {
        var idx = 1
        while idx < command.count {
            let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                return nil
            }
            if token == "--" {
                idx += 1
                break
            }
            if token == "-" {
                return nil
            }
            if self.isEnvAssignment(token) {
                return nil
            }
            if token.hasPrefix("-"), token != "-" {
                return nil
            }
            break
        }
        guard idx < command.count,
              !command[idx].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return Array(command[idx...])
    }

    static func unwrapTransparentDispatchWrappersForResolution(_ command: [String]) -> [String] {
        var current = command
        var depth = 0
        while depth < self.maxWrapperDepth {
            guard let token = current.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
                break
            }
            guard ExecCommandToken.basenameLower(token) == "env" else {
                break
            }
            guard let unwrapped = unwrapTransparentEnvInvocation(current), !unwrapped.isEmpty else {
                break
            }
            current = unwrapped
            depth += 1
        }
        return current
    }
}
