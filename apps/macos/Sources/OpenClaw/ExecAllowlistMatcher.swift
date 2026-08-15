import CryptoKit
import Foundation
import JavaScriptCore

enum ExecAllowlistMatcher {
    private static let hashedArgPatternPrefix = "sha256:argv:"

    static func match(entries: [ExecAllowlistEntry], resolution: ExecCommandResolution?) -> ExecAllowlistEntry? {
        guard let resolution, !entries.isEmpty else { return nil }
        if let wildcard = entries.first(where: {
            $0.pattern.trimmingCharacters(in: .whitespacesAndNewlines) == "*" &&
                ($0.argPattern?.isEmpty ?? true) &&
                $0.source != "allow-always"
        }) {
            return wildcard
        }
        guard resolution.resolvedRealPath?.isEmpty == false || resolution.resolvedPath?.isEmpty == false else {
            return nil
        }

        var pathOnlyMatch: ExecAllowlistEntry?
        for entry in entries {
            let controlPattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            // Shared stores preserve TypeScript's durable-command markers.
            // They are metadata, never basename patterns for native execution.
            if controlPattern.hasPrefix("=command:") || controlPattern.hasPrefix("=node-command:") {
                continue
            }
            switch ExecApprovalHelpers.validateAllowlistPattern(entry.pattern) {
            case let .valid(pattern):
                guard self.matchesExecutable(pattern: pattern, resolution: resolution) else { continue }
                guard let argPattern = entry.argPattern, !argPattern.isEmpty else {
                    // Old generated allow-always entries were path-only and could authorize
                    // changed argv after upgrade. Manual path-only entries have no source.
                    if entry.source == "allow-always" {
                        continue
                    }
                    if pathOnlyMatch == nil {
                        pathOnlyMatch = entry
                    }
                    continue
                }
                if let argv = resolution.argv, matchesArgPattern(argPattern, argv: argv) {
                    return entry
                }
            case .invalid:
                continue
            }
        }
        return pathOnlyMatch
    }

    static func matchAll(
        entries: [ExecAllowlistEntry],
        resolutions: [ExecCommandResolution]) -> [ExecAllowlistEntry]
    {
        guard !entries.isEmpty, !resolutions.isEmpty else { return [] }
        var matches: [ExecAllowlistEntry] = []
        matches.reserveCapacity(resolutions.count)
        for resolution in resolutions {
            guard let match = match(entries: entries, resolution: resolution) else {
                return []
            }
            matches.append(match)
        }
        return matches
    }

    private static func matchesExecutableBasename(
        pattern: String,
        resolution: ExecCommandResolution) -> Bool
    {
        var candidates = Set<String>()
        if !resolution.executableName.isEmpty {
            candidates.insert(resolution.executableName)
        }
        if let resolvedPath = resolution.resolvedPath, !resolvedPath.isEmpty {
            candidates.insert(URL(fileURLWithPath: resolvedPath).lastPathComponent)
        }
        return candidates.contains { self.matches(pattern: pattern, target: $0) }
    }

    private static func matchesExecutable(
        pattern: String,
        resolution: ExecCommandResolution) -> Bool
    {
        if ExecApprovalHelpers.patternHasPathSelector(pattern) {
            guard let trustPath = resolution.resolvedRealPath ?? resolution.resolvedPath else { return false }
            return self.matches(pattern: pattern, target: trustPath)
        }
        return pattern != "*" &&
            !ExecApprovalHelpers.patternHasPathSelector(resolution.rawExecutable) &&
            self.matchesExecutableBasename(pattern: pattern, resolution: resolution)
    }

    /// Mirrors the TypeScript exec-approval argv contract. Generated patterns
    /// use NUL separators plus a trailing sentinel; hand-authored patterns use
    /// one space between parsed arguments. Redirect-shaped tokens stay literal
    /// because resolution does not retain enough shell syntax provenance.
    private static func matchesArgPattern(_ argPattern: String, argv: [String]) -> Bool {
        if argPattern.hasPrefix(self.hashedArgPatternPrefix) {
            return argPattern == self.hashedArgPattern(argv: argv)
        }
        let nul = "\0"
        let arguments = Array(argv.dropFirst())
        let usesNulSeparator = argPattern.contains(nul)
        let joined = if usesNulSeparator {
            arguments.isEmpty ? nul + nul : arguments.joined(separator: nul) + nul
        } else {
            arguments.joined(separator: " ")
        }

        // The shared policy contract is JavaScript RegExp. Foundation uses ICU,
        // whose broader character classes and extra syntax can grant more than
        // the Gateway would, so compile and match with the system JS engine.
        guard let context = JSContext(),
              let constructor = context.objectForKeyedSubscript("RegExp"),
              let regex = constructor.construct(withArguments: [argPattern]),
              context.exception == nil,
              let result = regex.invokeMethod("test", withArguments: [joined]),
              context.exception == nil
        else { return false }
        return result.toBool()
    }

    private static func hashedArgPattern(argv: [String]) -> String {
        let arguments = Array(argv.dropFirst())
        let subject = "\(arguments.count)\0" + arguments
            .map { "\($0.data(using: .utf8)?.count ?? 0)\0\($0)\0" }
            .joined()
        let digest = SHA256.hash(data: Data(subject.utf8))
        return self.hashedArgPatternPrefix + digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = ExecApprovalsStore.expandPath(trimmed)
        let normalizedPattern = self.normalizeMatchTarget(expanded)
        let normalizedTarget = self.normalizeMatchTarget(target)
        guard let regex = regex(for: normalizedPattern) else { return false }
        let range = NSRange(location: 0, length: normalizedTarget.utf16.count)
        return regex.firstMatch(in: normalizedTarget, options: [], range: range) != nil
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        let normalized = value.replacingOccurrences(of: "\\\\", with: "/")
        if normalized == "/private/var" {
            return "/var"
        }
        if normalized.hasPrefix("/private/var/") {
            return String(normalized.dropFirst("/private".count))
        }
        return normalized
    }

    private static func regex(for pattern: String) -> NSRegularExpression? {
        var regex = "^"
        var idx = pattern.startIndex
        while idx < pattern.endIndex {
            let ch = pattern[idx]
            if ch == "*" {
                let next = pattern.index(after: idx)
                if next < pattern.endIndex, pattern[next] == "*" {
                    regex += ".*"
                    idx = pattern.index(after: next)
                } else {
                    regex += "[^/]*"
                    idx = next
                }
                continue
            }
            if ch == "?" {
                regex += "[^/]"
                idx = pattern.index(after: idx)
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(ch))
            idx = pattern.index(after: idx)
        }
        regex += "$"
        return try? NSRegularExpression(pattern: regex)
    }
}
