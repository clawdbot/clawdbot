import Foundation

extension OpenClawChatViewModel {
    func matchesCurrentSessionKey(incoming: String, current: String) -> Bool {
        Self.matchesCurrentSessionKey(
            incoming: incoming,
            current: current,
            mainSessionKey: self.resolvedMainSessionKey)
    }

    func matchesCurrentSessionKey(incoming: String, agentId: String?, current: String) -> Bool {
        Self.matchesCurrentSessionKey(
            incoming: incoming,
            agentId: agentId,
            current: current,
            mainSessionKey: self.resolvedMainSessionKey)
    }

    static func matchesCurrentSessionKey(
        incoming: String,
        agentId: String? = nil,
        current: String,
        mainSessionKey: String)
        -> Bool
    {
        let incomingNormalized = incoming.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let currentNormalized = current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if incomingNormalized == currentNormalized {
            return true
        }

        let mainNormalized = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if Self.matchesMainAlias(
            incoming: incomingNormalized,
            current: currentNormalized,
            mainSessionKey: mainNormalized)
        {
            return true
        }
        if Self.matchesSelectedAgentGlobal(
            incoming: incomingNormalized,
            agentId: agentId,
            current: currentNormalized)
        {
            return true
        }
        return false
    }

    private static func matchesMainAlias(incoming: String, current: String, mainSessionKey: String) -> Bool {
        if current == "main", incoming == mainSessionKey, mainSessionKey != "main" {
            return true
        }
        if incoming == "main", current == mainSessionKey, mainSessionKey != "main" {
            return true
        }
        return (current == "main" && incoming == "agent:main:main") ||
            (incoming == "main" && current == "agent:main:main")
    }

    private static func matchesSelectedAgentGlobal(incoming: String, agentId: String?, current: String) -> Bool {
        guard incoming == "global",
              let selectedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !selectedAgentId.isEmpty
        else {
            return false
        }
        return current == "agent:\(selectedAgentId):global"
    }
}
