import Foundation

enum AgentIdentityPresentation {
    nonisolated static func badge(avatarText: String?, displayName: String) -> String {
        self.normalizedBadgeEmoji(avatarText) ?? self.initialsBadge(for: displayName)
    }

    nonisolated static func initialsBadge(for displayName: String) -> String {
        let words = displayName
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "OC" : initials.uppercased()
    }

    nonisolated static func normalizedBadgeEmoji(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty || normalized == "?" ? nil : normalized
    }
}
