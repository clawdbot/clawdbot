import Foundation

enum SessionKey {
    static func normalizeMainKey(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "main" : trimmed
    }

    static func makeAgentSessionKey(agentId: String, baseKey: String) -> String {
        let trimmedAgent = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBase = baseKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedAgent.isEmpty { return trimmedBase.isEmpty ? "main" : trimmedBase }
        let normalizedBase = trimmedBase.isEmpty ? "main" : trimmedBase
        return "agent:\(trimmedAgent):\(normalizedBase)"
    }

    static func agentId(from value: String?) -> String? {
        let parts = (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentId = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentId.isEmpty ? nil : agentId
    }
}
