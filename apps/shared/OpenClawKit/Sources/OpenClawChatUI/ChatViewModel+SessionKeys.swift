import Foundation

extension OpenClawChatViewModel {
    nonisolated static func chatContextUsageFraction(for session: OpenClawChatSessionEntry?) -> Double? {
        guard session?.totalTokensFresh != false,
              let totalTokens = session?.totalTokens,
              totalTokens >= 0,
              let contextTokens = session?.contextTokens,
              contextTokens > 0
        else {
            return nil
        }
        return min(max(Double(totalTokens) / Double(contextTokens), 0), 1)
    }

    func syncContextUsageFraction() {
        let mainSessionKey = self.resolvedMainSessionKey
        let activeSessionKey = self.sessionKey == "main" && mainSessionKey != "main"
            ? mainSessionKey
            : self.sessionKey
        let currentSession = self.sessions.first(where: { $0.key == activeSessionKey }) ??
            self.sessions.first(where: {
                self.matchesCurrentSessionKey(incoming: $0.key, current: self.sessionKey)
            })
        self.contextUsageFraction = Self.chatContextUsageFraction(for: currentSession)
    }

    /// Session lists publish canonical agent keys even when the UI presents `main`.
    /// Keep visible model metadata on the same exact-then-alias read path.
    func currentSessionEntry() -> OpenClawChatSessionEntry? {
        self.sessions.first(where: { $0.key == self.sessionKey }) ??
            self.sessions.first(where: {
                self.matchesCurrentSessionKey(incoming: $0.key, current: self.sessionKey)
            })
    }

    func currentModelPatchTarget() -> ModelPatchTarget {
        let session = self.currentSessionSnapshot()
        return self.modelPatchTarget(
            sessionKey: session.key,
            canonicalSessionKey: self.currentSessionEntry()?.key,
            agentID: session.deliveryAgentID,
            sessionRoutingContract: session.sessionRoutingContract)
    }

    /// Model coordination uses the immutable gateway route, never a presentation alias such as `main`.
    func modelPatchTarget(
        sessionKey: String,
        canonicalSessionKey: String? = nil,
        agentID: String?,
        sessionRoutingContract: String?) -> ModelPatchTarget
    {
        let presentationKey = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let listedKey = canonicalSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = if let listedKey, !listedKey.isEmpty {
            listedKey
        } else {
            presentationKey
        }
        let normalizedAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let routeAgentID = normalizedAgentID?.isEmpty == false ? normalizedAgentID : nil
        let normalizedCandidate = candidate.lowercased()
        let targetKey: String
        let targetAgentID: String?
        if Self.agentID(fromSessionKey: candidate) != nil || normalizedCandidate == "unknown" {
            targetKey = candidate
            targetAgentID = nil
        } else if normalizedCandidate == "global" {
            targetKey = candidate
            targetAgentID = routeAgentID
        } else if let routeAgentID {
            targetKey = "agent:\(routeAgentID):\(candidate)"
            targetAgentID = nil
        } else {
            targetKey = candidate
            targetAgentID = nil
        }
        let normalizedContract = sessionRoutingContract?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let routeContract: String? = if self.usesMutableContractRouting(
            sessionKey: candidate,
            contract: normalizedContract)
        {
            normalizedContract?.isEmpty == false ? normalizedContract : nil
        } else {
            nil
        }
        return ModelPatchTarget(
            canonicalSessionKey: targetKey,
            agentID: targetAgentID,
            sessionRoutingContract: routeContract)
    }

    func sessionEntryForThinking(
        sessionKey: String,
        canonicalSessionKey: String?,
        agentID: String?) -> OpenClawChatSessionEntry?
    {
        if let canonicalSessionKey,
           let exact = self.sessions.first(where: { $0.key == canonicalSessionKey })
        {
            return exact
        }
        if let exact = self.sessions.first(where: { $0.key == sessionKey }) {
            return exact
        }
        return self.sessions.first(where: {
            Self.matchesCurrentSessionKey(
                incoming: $0.key,
                current: sessionKey,
                mainSessionKey: self.resolvedMainSessionKey,
                activeAgentId: agentID)
        })
    }

    func successfulModelPatchResult(
        for target: ModelPatchTarget,
        session: OpenClawChatSessionEntry?) -> OpenClawChatModelPatchResult?
    {
        guard let session,
              let result = self.lastSuccessfulModelPatchResultsByTarget[target]
        else { return nil }
        let sessionModel = Self.normalizedModelIdentityComponent(session.model ?? self.sessionDefaults?.model)
        let sessionProvider = Self.normalizedProvider(session.modelProvider ?? self.sessionDefaults?.modelProvider)
        let resultModel = Self.normalizedModelIdentityComponent(result.model)
        let resultProvider = Self.normalizedProvider(result.modelProvider)
        guard resultModel == nil || resultModel == sessionModel else { return nil }
        guard resultProvider == nil || resultProvider == sessionProvider else { return nil }
        return result
    }

    func sessionIndexForModelState(sessionKey: String) -> Int? {
        if let exact = self.sessions.firstIndex(where: { $0.key == sessionKey }) {
            return exact
        }
        return self.sessions.firstIndex(where: {
            self.matchesCurrentSessionKey(incoming: $0.key, current: sessionKey)
        })
    }

    func updateCurrentSessionModel(
        modelID: String?,
        modelProvider: String?,
        sessionKey: String,
        syncSelection: Bool)
    {
        let existingIndex = self.sessionIndexForModelState(sessionKey: sessionKey)
        var updated = existingIndex.map { self.sessions[$0] } ?? self.placeholderSession(key: sessionKey)
        // Thinking metadata follows model identity; stale options must not survive a model change.
        let preservesThinkingMetadata =
            Self.normalizedModelIdentityComponent(updated.model) ==
            Self.normalizedModelIdentityComponent(modelID) &&
            Self.normalizedModelIdentityComponent(updated.modelProvider) ==
            Self.normalizedModelIdentityComponent(modelProvider)
        updated.modelProvider = modelProvider
        updated.model = modelID
        if !preservesThinkingMetadata {
            updated.contextTokens = nil
            updated.thinkingLevel = nil
            updated.thinkingLevels = nil
            updated.thinkingOptions = nil
            updated.thinkingDefault = nil
        }
        if let index = existingIndex {
            self.sessions[index] = updated
        } else {
            self.sessions.append(updated)
        }
        if syncSelection {
            self.syncSelectedModel()
        }
    }

    static func normalizedProvider(_ provider: String?) -> String? {
        self.normalizedModelIdentityComponent(provider)
    }

    static func normalizedModelIdentityComponent(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    static func providerQualifiedModelSelectionID(modelID: String, provider: String) -> String {
        let providerPrefix = "\(provider)/"
        if modelID.hasPrefix(providerPrefix) {
            return modelID
        }
        return "\(provider)/\(modelID)"
    }

    public var sessionChoices: [OpenClawChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let cutoff = now - (24 * 60 * 60 * 1000)
        let sorted = OpenClawChatSessionListOrganizer.organize(sessions)
        let mainSessionKey = resolvedMainSessionKey

        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        // Always show the resolved main session first, even if it hasn't been updated recently.
        if let main = sorted.first(where: { $0.key == mainSessionKey }) {
            result.append(main)
            included.insert(main.key)
        } else {
            result.append(placeholderSession(key: mainSessionKey))
            included.insert(mainSessionKey)
        }

        for entry in sorted {
            guard !included.contains(entry.key) else { continue }
            guard entry.key == sessionKey || !ChatSessionSidebarModel.isHiddenInternalSession(entry.key)
            else { continue }
            // Pinned sessions stay reachable regardless of recency.
            guard (entry.updatedAt ?? 0) >= cutoff || entry.isPinned else { continue }
            result.append(entry)
            included.insert(entry.key)
        }

        if !included.contains(sessionKey) {
            if let current = sorted.first(where: { $0.key == self.sessionKey }) {
                result.append(current)
            } else {
                result.append(placeholderSession(key: sessionKey))
            }
        }

        return result
    }

    func matchesCurrentSessionKey(incoming: String, current: String) -> Bool {
        Self.matchesCurrentSessionKey(
            incoming: incoming,
            current: current,
            mainSessionKey: resolvedMainSessionKey,
            activeAgentId: activeAgentId)
    }

    func matchesCurrentSessionKey(incoming: String, agentId: String?, current: String) -> Bool {
        Self.matchesCurrentSessionKey(
            incoming: incoming,
            agentId: agentId,
            current: current,
            mainSessionKey: resolvedMainSessionKey,
            activeAgentId: activeAgentId)
    }

    static func matchesCurrentSessionKey(
        incoming: String,
        agentId: String? = nil,
        current: String,
        mainSessionKey: String,
        activeAgentId: String? = nil)
        -> Bool
    {
        let incomingNormalized = incoming.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let currentNormalized = current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if incomingNormalized == currentNormalized {
            if Self.agentIDFromSessionKey(currentNormalized) == nil {
                // `global` is always agent-ambiguous. Ordinary exact keys can
                // arrive before bootstrap publishes the active agent; accept
                // them until there is ownership metadata to compare.
                if currentNormalized != "global",
                   self.normalizedAgentId(activeAgentId) == nil
                {
                    return true
                }
                return Self.matchesAliasAgent(
                    incomingKey: incomingNormalized,
                    agentId: agentId,
                    currentKey: currentNormalized,
                    activeAgentId: activeAgentId)
            }
            return true
        }

        let mainNormalized = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if Self.matchesMainAlias(
            incoming: incomingNormalized,
            current: currentNormalized,
            mainSessionKey: mainNormalized)
        {
            return Self.matchesAliasAgent(
                incomingKey: incomingNormalized,
                agentId: agentId,
                currentKey: currentNormalized,
                activeAgentId: activeAgentId,
                allowIncomingOwnerWhenCurrentUnknown: true)
        }
        if Self.matchesSelectedAgentWrapper(incoming: incomingNormalized, current: currentNormalized) {
            return Self.matchesAliasAgent(
                incomingKey: incomingNormalized,
                agentId: agentId,
                currentKey: currentNormalized,
                activeAgentId: activeAgentId)
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

    private static func normalizedAgentId(_ agentId: String?) -> String? {
        let normalized = agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }

    private static func matchesAliasAgent(
        incomingKey: String,
        agentId: String?,
        currentKey: String,
        activeAgentId: String?,
        allowIncomingOwnerWhenCurrentUnknown: Bool = false) -> Bool
    {
        let currentAgentID = self.agentIDFromSessionKey(currentKey) ?? self.normalizedAgentId(activeAgentId)
        let payloadAgentID = self.normalizedAgentId(agentId)
        let keyAgentID = self.agentIDFromSessionKey(incomingKey)
        if let payloadAgentID, let keyAgentID, payloadAgentID != keyAgentID {
            return false
        }
        let incomingAgentID = payloadAgentID ?? keyAgentID
        guard let currentAgentID else {
            return allowIncomingOwnerWhenCurrentUnknown && incomingAgentID != nil
        }
        guard let incomingAgentID else { return true }
        return incomingAgentID == currentAgentID
    }

    private static func agentIDFromSessionKey(_ sessionKey: String) -> String? {
        let parts = sessionKey.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0] == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    private static func matchesSelectedAgentWrapper(incoming: String, current: String) -> Bool {
        let incomingParts = incoming.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        if incomingParts.count == 3,
           incomingParts[0] == "agent",
           String(incomingParts[2]) == current
        {
            return true
        }
        let currentParts = current.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        return currentParts.count == 3 &&
            currentParts[0] == "agent" &&
            String(currentParts[2]) == incoming
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
