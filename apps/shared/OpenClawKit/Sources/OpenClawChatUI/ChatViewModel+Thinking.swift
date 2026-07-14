import Foundation

// Thinking-level normalization and option resolution. Session entries,
// session defaults, and free-form user aliases all feed the picker; this
// extension owns collapsing them into the canonical option list.

extension OpenClawChatViewModel {
    func applyAdvertisedThinkingLevel(_ level: String) {
        guard level != thinkingLevel else { return }
        thinkingLevel = level
        self.updateCurrentSessionThinkingLevel(level, sessionKey: sessionKey)
    }

    func performSelectThinkingLevel(_ level: String) {
        let next = Self.normalizedThinkingLevel(level) ?? "off"
        guard next != preferredThinkingLevel else { return }

        let sessionKey = self.sessionKey
        let acceptedBaseline = Self.normalizedThinkingLevel(currentSessionEntry()?.thinkingLevel)
            ?? Self.normalizedThinkingLevel(thinkingLevel)
            ?? "off"
        let target = currentModelPatchTarget()
        if acceptedThinkingLevelsByTarget[target] == nil {
            // Preserve the gateway-confirmed value across the whole queued lane.
            // Later optimistic selections must not become rollback truth.
            acceptedThinkingLevelsByTarget[target] = acceptedBaseline
            acceptedPreferredThinkingLevelsByTarget[target] = preferredThinkingLevel
            let session = currentSessionEntry()
            acceptedSettingsPatchResultsByTarget[target] = OpenClawChatModelPatchResult(
                key: session?.key ?? target.canonicalSessionKey,
                modelProvider: session?.modelProvider,
                model: session?.model,
                thinkingLevel: acceptedBaseline,
                thinkingLevels: session?.thinkingLevels)
        }
        if acceptedExplicitThinkingPreferencesByTarget[target] == nil {
            acceptedExplicitThinkingPreferencesByTarget[target] = prefersExplicitThinkingLevel
        }
        prefersExplicitThinkingLevel = true
        preferredThinkingLevel = next
        thinkingLevel = next
        self.syncThinkingLevelOptions()
        self.updateCurrentSessionThinkingLevel(next, sessionKey: sessionKey)
        let settingsRequestID = reserveSessionSettingsRequest(for: target)
        onThinkingLevelChanged?(next)
        nextThinkingSelectionRequestID &+= 1
        let requestID = nextThinkingSelectionRequestID
        latestThinkingSelectionRequestIDsByTarget[target] = requestID
        enqueueSessionSettingsPatch(requestID: settingsRequestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            do {
                guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
                let patchResult = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(next)))
                let previousResult = self.acceptedSettingsPatchResultsByTarget[target]
                let acceptedLevel = Self.normalizedThinkingLevel(patchResult?.thinkingLevel) ?? next
                let acceptedResult = OpenClawChatModelPatchResult(
                    key: patchResult?.key ?? previousResult?.key ?? target.canonicalSessionKey,
                    modelProvider: patchResult?.modelProvider ?? previousResult?.modelProvider,
                    model: patchResult?.model ?? previousResult?.model,
                    thinkingLevel: acceptedLevel,
                    thinkingLevels: patchResult?.thinkingLevels ?? previousResult?.thinkingLevels)
                // Older queued successes remain rollback truth, but never replace
                // a newer optimistic selection in the session row or picker.
                self.lastSuccessfulSettingsPatchResultsByTarget[target] = acceptedResult
                self.acceptedSettingsPatchResultsByTarget[target] = acceptedResult
                self.acceptedThinkingLevelsByTarget[target] = acceptedLevel
                self.acceptedPreferredThinkingLevelsByTarget[target] = acceptedLevel
                self.acceptedExplicitThinkingPreferencesByTarget[target] = true
                self.lastSuccessfulSettingsPatchRequestIDsByTarget[target] = settingsRequestID
                guard requestID == self.latestThinkingSelectionRequestIDsByTarget[target] else { return }
                let targetIsCurrent = target == self.currentModelPatchTarget()
                let stateKey: String
                let exactMatchOnly: Bool
                if targetIsCurrent {
                    stateKey = sessionKey
                    exactMatchOnly = false
                } else {
                    guard let inactiveStateKey = self.inactiveSettingsStateKey(for: target) else { return }
                    stateKey = inactiveStateKey
                    exactMatchOnly = true
                }
                self.updateCurrentSessionThinkingLevel(
                    acceptedLevel,
                    sessionKey: stateKey,
                    exactMatchOnly: exactMatchOnly)
                if let thinkingLevels = acceptedResult.thinkingLevels {
                    self.updateCurrentSessionThinkingLevels(
                        thinkingLevels,
                        sessionKey: stateKey,
                        exactMatchOnly: exactMatchOnly)
                }
                guard targetIsCurrent else { return }
                if acceptedLevel != next {
                    self.onThinkingLevelChanged?(acceptedLevel)
                }
                self.preferredThinkingLevel = acceptedLevel
                self.thinkingLevel = acceptedLevel
                self.syncThinkingLevelOptions()
            } catch {
                guard requestID == self.latestThinkingSelectionRequestIDsByTarget[target] else { return }
                let targetIsCurrent = target == self.currentModelPatchTarget()
                let stateKey: String
                let exactMatchOnly: Bool
                if targetIsCurrent {
                    stateKey = sessionKey
                    exactMatchOnly = false
                } else {
                    guard let inactiveStateKey = self.inactiveSettingsStateKey(for: target) else { return }
                    stateKey = inactiveStateKey
                    exactMatchOnly = true
                }
                let rollbackResult = self.acceptedSettingsPatchResultsByTarget[target]
                let rollbackLevel = self.acceptedThinkingLevelsByTarget[target]
                    ?? Self.normalizedThinkingLevel(rollbackResult?.thinkingLevel)
                    ?? acceptedBaseline
                let rollbackPreferredLevel = self.acceptedPreferredThinkingLevelsByTarget[target]
                    ?? rollbackLevel
                self.updateCurrentSessionThinkingLevel(
                    rollbackLevel,
                    sessionKey: stateKey,
                    exactMatchOnly: exactMatchOnly)
                if let thinkingLevels = rollbackResult?.thinkingLevels {
                    self.updateCurrentSessionThinkingLevels(
                        thinkingLevels,
                        sessionKey: stateKey,
                        exactMatchOnly: exactMatchOnly)
                }
                guard targetIsCurrent else { return }
                self.prefersExplicitThinkingLevel = self.acceptedExplicitThinkingPreferencesByTarget[target] ?? false
                self.preferredThinkingLevel = rollbackPreferredLevel
                self.thinkingLevel = rollbackLevel
                self.syncThinkingLevelOptions()
                // Option resolution may project the preferred value when it is
                // supported. A rejection must still leave the applied state at
                // the gateway-confirmed rollback value.
                self.thinkingLevel = rollbackLevel
                self.updateCurrentSessionThinkingLevel(rollbackLevel, sessionKey: sessionKey)
                self.onThinkingLevelChanged?(rollbackPreferredLevel)
            }
        }
    }

    func updateCurrentSessionThinkingLevels(
        _ thinkingLevels: [OpenClawChatThinkingLevelOption],
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? sessions.firstIndex(where: { $0.key == sessionKey })
            : sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        sessions[index].thinkingLevels = thinkingLevels
        sessions[index].thinkingOptions = thinkingLevels.map(\.label)
    }

    /// Agent-qualified keys keep an immutable owner even when their main-session
    /// contract changes. Bare aliases cannot safely identify an inactive row.
    private func inactiveSettingsStateKey(for target: ModelPatchTarget) -> String? {
        if target.agentID != nil || target.sessionRoutingContract != nil {
            guard OpenClawChatSessionKey.agentID(from: target.canonicalSessionKey) != nil else { return nil }
        }
        return target.canonicalSessionKey
    }

    func updateCurrentSessionThinkingLevel(
        _ thinkingLevel: String?,
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? sessions.firstIndex(where: { $0.key == sessionKey })
            : sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        sessions[index].thinkingLevel = thinkingLevel
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
            target = modelPatchTarget(
                sessionKey: sessionKey,
                canonicalSessionKey: canonicalSessionKey,
                agentID: agentID,
                sessionRoutingContract: sessionRoutingContract)
            // Sessions absent from the loaded list resolve to no metadata and fail
            // open for existing levels. Ultra is new enough that an older or
            // truncated list must use its shipped High meaning until advertised.
            session = sessionEntryForThinking(
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
            session = currentSessionEntry()
            showsPicker = showsThinkingPicker
            target = currentModelPatchTarget()
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
        let currentSession = currentSessionEntry()
        showsThinkingPicker = self.thinkingPickerIsAvailable(
            for: currentSession,
            modelChoice: self.selectedModelChoice(for: currentSession))

        let resolved = self.resolvedThinkingLevelOptions(for: currentSession)
        var options = resolved.options
        let target = currentModelPatchTarget()
        let preferredLevel = self.prefersExplicitThinkingLevel
            ? self.preferredThinkingLevel
            : Self.normalizedThinkingLevel(currentSession?.thinkingLevel) ?? self.preferredThinkingLevel
        let preferred: String? = if resolved.isGatewayMetadata {
            Self.normalizedThinkingLevel(
                preferredLevel,
                options: options,
                fallback: currentSession?.thinkingLevel)
        } else {
            self.thinkingLevelWithoutGatewayMetadata(
                preferredLevel,
                target: target,
                session: currentSession)
        }
        let current = preferred ?? Self.normalizedThinkingLevel(currentSession?.thinkingLevel)
        if let current {
            self.applyAdvertisedThinkingLevel(current)
            options = Self.withCurrentThinkingOption(options, current: current)
        }
        thinkingLevelOptions = options
    }

    private func thinkingLevelWithoutGatewayMetadata(
        _ level: String,
        target: ModelPatchTarget,
        session: OpenClawChatSessionEntry?) -> String?
    {
        let preferred = Self.normalizedThinkingLevel(level)
        guard preferred == "ultra" else { return preferred }
        if let patched = Self.normalizedThinkingLevel(
            successfulModelPatchResult(for: target, session: session)?.thinkingLevel)
        {
            return patched
        }
        // Older gateways accept the legacy Ultra spelling as High but do not
        // return capability metadata. Never advertise/send more than they run.
        if completedModelPatchTargets.contains(target) {
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
        if modelSelectionID != Self.defaultModelSelectionID {
            return modelChoices.first(where: { $0.selectionID == self.modelSelectionID })
        }

        return self.sessionModelChoice(for: currentSession)
    }

    private func sessionModelChoice(
        for currentSession: OpenClawChatSessionEntry?) -> OpenClawChatModelChoice?
    {
        if Self.normalizedModelID(currentSession?.model) != nil {
            return self.modelChoice(modelID: currentSession?.model, provider: currentSession?.modelProvider)
        }
        return self.modelChoice(modelID: sessionDefaults?.model, provider: sessionDefaults?.modelProvider)
    }

    private func modelChoice(modelID: String?, provider: String?) -> OpenClawChatModelChoice? {
        guard let modelID = Self.normalizedModelID(modelID) else { return nil }
        let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let provider, !provider.isEmpty {
            let prefix = "\(provider)/"
            let selectionID = modelID.hasPrefix(prefix) ? modelID : "\(prefix)\(modelID)"
            return modelChoices.first(where: {
                $0.selectionID == selectionID ||
                    ($0.modelID == modelID && $0.provider == provider)
            })
        }

        let matches = modelChoices.filter { $0.selectionID == modelID || $0.modelID == modelID }
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
        guard let normalized = normalizedThinkingLevel(level) else { return nil }
        guard normalized == "ultra" else { return normalized }
        let advertised = options.compactMap { self.normalizedThinkingLevel($0.id) }
        if advertised.contains("ultra") {
            return "ultra"
        }
        if let fallback = normalizedThinkingLevel(fallback), advertised.contains(fallback) {
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
