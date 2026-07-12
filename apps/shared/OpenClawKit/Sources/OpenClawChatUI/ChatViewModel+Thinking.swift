import Foundation

// Thinking-level normalization and option resolution. Session entries,
// session defaults, and free-form user aliases all feed the picker; this
// extension owns collapsing them into the canonical option list.

extension OpenClawChatViewModel {
    func applyAdvertisedThinkingLevel(_ level: String) {
        guard level != self.thinkingLevel else { return }
        self.thinkingLevel = level
        self.updateCurrentSessionThinkingLevel(level, sessionKey: self.sessionKey)
    }

    func performSelectThinkingLevel(_ level: String) async {
        let next = Self.normalizedThinkingLevel(level) ?? "off"
        guard next != self.preferredThinkingLevel else { return }

        let sessionKey = self.sessionKey
        self.prefersExplicitThinkingLevel = true
        self.preferredThinkingLevel = next
        self.thinkingLevel = next
        self.syncThinkingLevelOptions()
        self.updateCurrentSessionThinkingLevel(next, sessionKey: sessionKey)
        self.onThinkingLevelChanged?(next)
        self.nextThinkingSelectionRequestID &+= 1
        let requestID = self.nextThinkingSelectionRequestID
        self.latestThinkingSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestThinkingLevelsBySession[sessionKey] = next

        do {
            try await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: next)
            guard requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey] else {
                let latest = self.latestThinkingLevelsBySession[sessionKey] ?? next
                guard latest != next else { return }
                try? await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: latest)
                return
            }
        } catch {
            guard sessionKey == self.sessionKey,
                  requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey]
            else { return }
            // Best-effort. Persisting the user's local preference matters more than a patch error here.
        }
    }

    func updateCurrentSessionThinkingLevels(
        _ thinkingLevels: [OpenClawChatThinkingLevelOption],
        sessionKey: String)
    {
        guard let index = self.sessionIndexForModelState(sessionKey: sessionKey) else { return }
        self.sessions[index].thinkingLevels = thinkingLevels
        self.sessions[index].thinkingOptions = thinkingLevels.map(\.label)
    }

    func updateCurrentSessionThinkingLevel(_ thinkingLevel: String?, sessionKey: String) {
        guard let index = self.sessionIndexForModelState(sessionKey: sessionKey) else { return }
        self.sessions[index].thinkingLevel = thinkingLevel
    }

    func effectiveThinkingLevelForSend(
        _ storedLevel: String,
        sessionKey: String? = nil,
        canonicalSessionKey: String? = nil,
        agentID: String? = nil,
        sessionRoutingContract: String? = nil) -> String
    {
        let usesCurrentSession = sessionKey == nil ||
            (sessionKey == self.sessionKey && canonicalSessionKey == nil && agentID == nil)
        let session: OpenClawChatSessionEntry?
        let showsPicker: Bool
        let target: ModelPatchTarget
        if !usesCurrentSession, let sessionKey {
            target = self.modelPatchTarget(
                sessionKey: sessionKey,
                canonicalSessionKey: canonicalSessionKey,
                agentID: agentID,
                sessionRoutingContract: sessionRoutingContract)
            // Sessions absent from the loaded list resolve to no metadata and fail
            // open for existing levels. Ultra is new enough that an older or
            // truncated list must use its shipped High meaning until advertised.
            session = self.sessionEntryForThinking(
                sessionKey: sessionKey,
                canonicalSessionKey: canonicalSessionKey,
                agentID: agentID)
            guard session != nil else {
                let fallback = self.thinkingLevelWithoutGatewayMetadata(
                    storedLevel,
                    target: target,
                    session: nil)
                return fallback == "ultra" ? "high" : (fallback ?? storedLevel)
            }
            showsPicker = self.thinkingPickerIsAvailable(
                for: session,
                modelChoice: self.sessionModelChoice(for: session))
        } else {
            session = self.currentSessionEntry()
            showsPicker = self.showsThinkingPicker
            target = self.currentModelPatchTarget()
        }
        guard showsPicker else { return "off" }
        let resolved = self.resolvedThinkingLevelOptions(for: session)
        guard resolved.isGatewayMetadata else {
            return self.thinkingLevelWithoutGatewayMetadata(
                storedLevel,
                target: target,
                session: session) ?? storedLevel
        }
        return Self.normalizedThinkingLevel(
            storedLevel,
            options: resolved.options,
            fallback: session?.thinkingLevel) ?? storedLevel
    }

    func syncThinkingLevelOptions() {
        let currentSession = self.currentSessionEntry()
        self.showsThinkingPicker = self.thinkingPickerIsAvailable(
            for: currentSession,
            modelChoice: self.selectedModelChoice(for: currentSession))

        let resolved = self.resolvedThinkingLevelOptions(for: currentSession)
        var options = resolved.options
        let target = self.currentModelPatchTarget()
        let preferred: String? = if resolved.isGatewayMetadata {
            Self.normalizedThinkingLevel(
                self.preferredThinkingLevel,
                options: options,
                fallback: currentSession?.thinkingLevel)
        } else {
            self.thinkingLevelWithoutGatewayMetadata(
                self.preferredThinkingLevel,
                target: target,
                session: currentSession)
        }
        let current = preferred ?? Self.normalizedThinkingLevel(currentSession?.thinkingLevel)
        if let current {
            self.applyAdvertisedThinkingLevel(current)
            options = Self.withCurrentThinkingOption(options, current: current)
        }
        self.thinkingLevelOptions = options
    }

    private func thinkingLevelWithoutGatewayMetadata(
        _ level: String,
        target: ModelPatchTarget,
        session: OpenClawChatSessionEntry?) -> String?
    {
        let preferred = Self.normalizedThinkingLevel(level)
        guard preferred == "ultra" else { return preferred }
        if let patched = Self.normalizedThinkingLevel(
            self.successfulModelPatchResult(for: target, session: session)?.thinkingLevel)
        {
            return patched
        }
        // Older gateways accept the legacy Ultra spelling as High but do not
        // return capability metadata. Never advertise/send more than they run.
        if self.completedModelPatchTargets.contains(target) {
            return "high"
        }
        return preferred
    }

    private func thinkingPickerIsAvailable(
        for session: OpenClawChatSessionEntry?,
        modelChoice: OpenClawChatModelChoice?) -> Bool
    {
        let resolved = self.resolvedThinkingLevelOptions(for: session)
        let gatewayAllowsOnlyOff = resolved.isGatewayMetadata &&
            resolved.options.allSatisfy { $0.id == "off" }
        return !gatewayAllowsOnlyOff && modelChoice?.reasoning != false
    }

    private struct ThinkingLevelOptionsResolution {
        let options: [OpenClawChatThinkingLevelOption]
        let isGatewayMetadata: Bool
    }

    private func resolvedThinkingLevelOptions(
        for currentSession: OpenClawChatSessionEntry?) -> ThinkingLevelOptionsResolution
    {
        if let levels = Self.normalizedThinkingLevelOptions(currentSession?.thinkingLevels), !levels.isEmpty {
            return ThinkingLevelOptionsResolution(options: levels, isGatewayMetadata: true)
        }

        let defaultsMatch = currentSession.map {
            Self.sessionModelMatchesDefaults($0, defaults: self.sessionDefaults)
        } ?? true

        if defaultsMatch,
           let levels = Self.normalizedThinkingLevelOptions(sessionDefaults?.thinkingLevels),
           !levels.isEmpty
        {
            return ThinkingLevelOptionsResolution(options: levels, isGatewayMetadata: true)
        }

        if let options = Self.thinkingOptions(from: currentSession?.thinkingOptions), !options.isEmpty {
            return ThinkingLevelOptionsResolution(options: options, isGatewayMetadata: true)
        }

        if defaultsMatch,
           let options = Self.thinkingOptions(from: sessionDefaults?.thinkingOptions),
           !options.isEmpty
        {
            return ThinkingLevelOptionsResolution(options: options, isGatewayMetadata: true)
        }

        return ThinkingLevelOptionsResolution(options: Self.baseThinkingLevelOptions, isGatewayMetadata: false)
    }

    private func selectedModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if self.modelSelectionID != Self.defaultModelSelectionID {
            return self.modelChoices.first(where: { $0.selectionID == self.modelSelectionID })
        }

        return self.sessionModelChoice(for: currentSession)
    }

    private func sessionModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if Self.normalizedModelID(currentSession?.model) != nil {
            return self.modelChoice(modelID: currentSession?.model, provider: currentSession?.modelProvider)
        }
        return self.modelChoice(modelID: self.sessionDefaults?.model, provider: self.sessionDefaults?.modelProvider)
    }

    private func modelChoice(modelID: String?, provider: String?) -> OpenClawChatModelChoice? {
        guard let modelID = Self.normalizedModelID(modelID) else { return nil }
        let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let provider, !provider.isEmpty {
            let prefix = "\(provider)/"
            let selectionID = modelID.hasPrefix(prefix) ? modelID : "\(prefix)\(modelID)"
            return self.modelChoices.first(where: {
                $0.selectionID == selectionID ||
                    ($0.modelID == modelID && $0.provider == provider)
            })
        }

        let matches = self.modelChoices.filter { $0.selectionID == modelID || $0.modelID == modelID }
        return matches.count == 1 ? matches[0] : nil
    }

    private static func normalizedModelID(_ modelID: String?) -> String? {
        let trimmed = modelID?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func sessionModelMatchesDefaults(
        _ session: OpenClawChatSessionEntry,
        defaults: OpenClawChatSessionsDefaults?) -> Bool
    {
        let providerMatches = session.modelProvider == nil || session.modelProvider == defaults?.modelProvider
        let modelMatches = session.model == nil || session.model == defaults?.model
        return providerMatches && modelMatches
    }

    private static func normalizedThinkingLevelOptions(
        _ levels: [OpenClawChatThinkingLevelOption]?) -> [OpenClawChatThinkingLevelOption]?
    {
        guard let levels else { return nil }
        return Self.dedupedThinkingOptions(
            levels.compactMap { level in
                guard let id = Self.normalizedThinkingLevel(level.id) else { return nil }
                let label = level.label.trimmingCharacters(in: .whitespacesAndNewlines)
                return OpenClawChatThinkingLevelOption(id: id, label: label.isEmpty ? id : label)
            })
    }

    private static func thinkingOptions(from labels: [String]?) -> [OpenClawChatThinkingLevelOption]? {
        guard let labels else { return nil }
        return Self.dedupedThinkingOptions(
            labels.compactMap { label in
                guard let id = Self.normalizedThinkingLevel(label) else { return nil }
                let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
                return OpenClawChatThinkingLevelOption(id: id, label: trimmed.isEmpty ? id : trimmed)
            })
    }

    static func withCurrentThinkingOption(
        _ options: [OpenClawChatThinkingLevelOption],
        current: String) -> [OpenClawChatThinkingLevelOption]
    {
        guard !options.contains(where: { $0.id == current }) else { return options }
        return options + [OpenClawChatThinkingLevelOption(id: current, label: current)]
    }

    private static func dedupedThinkingOptions(
        _ options: [OpenClawChatThinkingLevelOption]) -> [OpenClawChatThinkingLevelOption]
    {
        var result: [OpenClawChatThinkingLevelOption] = []
        var seen = Set<String>()
        for option in options {
            guard !option.id.isEmpty, !seen.contains(option.id) else { continue }
            seen.insert(option.id)
            result.append(option)
        }
        return result
    }

    static func normalizedThinkingLevel(_ level: String?) -> String? {
        guard let level else { return nil }
        let trimmed = level.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return nil }
        let collapsed = trimmed.replacingOccurrences(
            of: "[\\s_-]+",
            with: "",
            options: .regularExpression)

        switch collapsed {
        case "adaptive", "auto":
            return "adaptive"
        case "max":
            return "max"
        case "ultra":
            return "ultra"
        case "xhigh", "extrahigh":
            return "xhigh"
        case "off", "none":
            return "off"
        case "on", "enable", "enabled":
            return "low"
        case "min", "minimal", "think":
            return "minimal"
        case "low", "thinkhard":
            return "low"
        case "mid", "med", "medium", "thinkharder", "harder":
            return "medium"
        case "high", "ultrathink", "thinkhardest", "highest":
            return "high"
        default:
            return trimmed
        }
    }

    static func normalizedThinkingLevel(
        _ level: String?,
        options: [OpenClawChatThinkingLevelOption],
        fallback: String? = nil) -> String?
    {
        guard let normalized = self.normalizedThinkingLevel(level) else { return nil }
        guard normalized == "ultra" else { return normalized }
        let advertised = options.compactMap { self.normalizedThinkingLevel($0.id) }
        if advertised.contains("ultra") {
            return "ultra"
        }
        if let fallback = self.normalizedThinkingLevel(fallback), advertised.contains(fallback) {
            return fallback
        }
        return advertised
            .filter { $0 != "off" }
            .max { self.thinkingLevelRank($0) < self.thinkingLevelRank($1) }
    }

    private static func thinkingLevelRank(_ level: String) -> Int {
        switch level {
        case "off": 0
        case "minimal": 10
        case "low": 20
        case "medium", "adaptive": 30
        case "high": 40
        case "xhigh": 60
        case "max": 70
        case "ultra": 80
        default: -1
        }
    }
}
