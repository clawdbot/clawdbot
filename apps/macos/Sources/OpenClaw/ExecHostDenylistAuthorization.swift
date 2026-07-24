import Foundation

struct ExecHostDenylistEntry: Codable, Equatable, Sendable {
    var pattern: String
    var reason: String?

    init(pattern: String, reason: String? = nil) {
        self.pattern = pattern
        self.reason = reason
    }

    init(from decoder: Decoder) throws {
        // TS parity (`normalizeExecDenylist`): malformed entries decode to an
        // empty pattern and are dropped during normalization instead of
        // failing the whole approvals-file read.
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(pattern: "")
            return
        }
        self.init(
            pattern: (try? container.decodeIfPresent(String.self, forKey: .pattern)) ?? "",
            reason: try? container.decodeIfPresent(String.self, forKey: .reason))
    }

    private enum CodingKeys: String, CodingKey {
        case pattern
        case reason
    }
}

enum ExecHostDenylist {
    /// Stable identity key for a denylist entry (pattern + reason). Matches
    /// the TS `buildExecDenylistRuleKey` format so `approvedRuleKeys`
    /// forwarded by the gateway compare correctly against local rules.
    static func ruleKey(_ entry: ExecHostDenylistEntry) -> String {
        "\(entry.pattern)\u{0}\(entry.reason ?? "")"
    }

    /// Normalizes a raw denylist layer: trims patterns/reasons, drops empty
    /// patterns, and de-duplicates by rule key (TS `normalizeExecDenylist`).
    static func normalize(_ entries: [ExecHostDenylistEntry]?) -> [ExecHostDenylistEntry] {
        guard let entries else { return [] }
        var seen = Set<String>()
        var out: [ExecHostDenylistEntry] = []
        for entry in entries {
            let pattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !pattern.isEmpty else { continue }
            let trimmedReason = entry.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
            let reason = (trimmedReason?.isEmpty ?? true) ? nil : trimmedReason
            let normalized = ExecHostDenylistEntry(pattern: pattern, reason: reason)
            guard seen.insert(self.ruleKey(normalized)).inserted else { continue }
            out.append(normalized)
        }
        return out
    }

    /// De-duplicated union across layers: a deny in ANY layer denies
    /// (TS `resolveEffectiveExecDenylist`).
    static func union(_ layers: [[ExecHostDenylistEntry]?]) -> [ExecHostDenylistEntry] {
        self.normalize(layers.compactMap(\.self).flatMap(\.self))
    }
}

struct ExecHostDenylistAuthorizationSnapshot: Codable, Equatable, Sendable {
    var command: String
    var analysisOk: Bool
    var configDenylist: [ExecHostDenylistEntry]
    var approvedRuleKeys: [String]
    var denylisted: Bool?

    /// Deny-over-allow re-screen at final commit. The effective STOP list is
    /// the forwarded config layer; `openclaw.json` is the single persisted
    /// owner for exec STOP rules.
    func requiresFreshApproval(command: [String]) -> Bool {
        let approvedRuleKeys = Set(self.approvedRuleKeys)
        let currentEffective = ExecHostDenylist.union([self.configDenylist])
        let newlyCurrent = currentEffective.filter { entry in
            !approvedRuleKeys.contains(ExecHostDenylist.ruleKey(entry))
        }
        guard !newlyCurrent.isEmpty else { return false }
        if !self.analysisOk {
            return true
        }

        let targets = Self.denylistTargets(command: command, canonicalCommand: self.command)
        return newlyCurrent.contains { entry in
            targets.contains { target in
                ExecHostDenylistMatcher.matches(pattern: entry.pattern, target: target)
            }
        }
    }

    private static func denylistTargets(command: [String], canonicalCommand: String) -> [String] {
        var targets: [String] = []
        var seen = Set<String>()
        func add(_ value: String) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return }
            targets.append(trimmed)
        }

        add(canonicalCommand)
        guard let executable = command.first else { return targets }
        add(command.joined(separator: " "))
        var basenameCommand = command
        basenameCommand[0] = URL(fileURLWithPath: executable).lastPathComponent
        add(basenameCommand.joined(separator: " "))
        return targets
    }
}

private enum ExecHostDenylistMatcher {
    static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return target.range(
            of: Self.regexPattern(for: trimmed),
            options: .regularExpression) != nil
    }

    private static func regexPattern(for glob: String) -> String {
        var regex = "^"
        var index = glob.startIndex
        while index < glob.endIndex {
            let character = glob[index]
            if character == "*" {
                let nextIndex = glob.index(after: index)
                if nextIndex < glob.endIndex, glob[nextIndex] == "*" {
                    regex += ".*"
                    index = glob.index(after: nextIndex)
                    continue
                }
                regex += "[^/]*"
                index = nextIndex
                continue
            }
            if character == "?" {
                regex += "[^/]"
                index = glob.index(after: index)
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(character))
            index = glob.index(after: index)
        }
        regex += "$"
        return regex
    }
}
