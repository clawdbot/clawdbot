import Foundation

extension OpenClawChatViewModel {
    func fetchModels(sessionSnapshot: SessionSnapshot? = nil) async {
        self.nextModelCatalogRequestID &+= 1
        let requestID = self.nextModelCatalogRequestID
        let session = sessionSnapshot ?? self.currentSessionSnapshot()
        let target = self.currentModelPatchTarget()
        let settingsRevision = self.settingsPatchRevisionsByTarget[target, default: 0]
        do {
            let catalog = try await transport.loadModelCatalog(
                sessionKey: session.key,
                agentID: session.deliveryAgentID)
            guard self.isCurrentSession(session), requestID == self.nextModelCatalogRequestID else {
                return
            }
            self.modelChoices = catalog.choices
            self.modelAvailabilityIsSessionScoped = catalog.availabilityIsSessionScoped
            if target == self.currentModelPatchTarget(),
               settingsRevision == self.settingsPatchRevisionsByTarget[target, default: 0],
               self.inFlightSettingsPatchCountsByTarget[target] == nil
            {
                self.syncSelectedModel()
            }
            syncThinkingLevelOptions()
        } catch {
            // Best-effort.
        }
    }

    public static let verboseLevelOptions = ["off", "on", "full"]

    public var modelPickerSections: ChatModelPickerSections {
        let defaultProvider = ChatModelPickerStore.resolvedDefaultProvider(
            provider: self.sessionDefaults?.modelProvider,
            model: self.sessionDefaults?.model)
        return ChatModelPickerStore.sections(
            choices: self.modelChoices,
            favorites: self.modelPickerFavorites,
            recents: self.modelPickerRecents,
            defaultProvider: defaultProvider)
    }

    public var modelSelectionTargetDescription: String? {
        switch self.sessionDefaults?.modelSelectionTarget {
        case "session": String(localized: "Changes this session only")
        case "agent": String(localized: "Changes this agent's default")
        case "global": String(localized: "Changes the global default")
        default: nil
        }
    }

    public func isModelUnavailable(_ model: OpenClawChatModelChoice) -> Bool {
        self.modelAvailabilityIsSessionScoped && model.available == false
    }

    public func canSelectModel(_ selectionID: String) -> Bool {
        guard selectionID != Self.defaultModelSelectionID,
              let model = self.modelChoices.first(where: { $0.selectionID == selectionID })
        else { return true }
        return !self.isModelUnavailable(model)
    }

    public func modelUnavailableDescription(_ model: OpenClawChatModelChoice) -> String? {
        guard self.isModelUnavailable(model) else { return nil }
        return model.availabilityReason?.pickerDescription ?? String(localized: "Unavailable")
    }

    public var selectedModelUnavailableReason: OpenClawChatModelUnavailableReason? {
        guard self.modelAvailabilityIsSessionScoped,
              let selectedKey = self.selectedModelAvailabilityKey()
        else { return nil }
        let matches = self.modelChoices.filter {
            Self.modelAvailabilityKey(modelID: $0.modelID, provider: $0.provider) == selectedKey
        }
        guard !matches.isEmpty,
              matches.allSatisfy({ $0.available == false && $0.availabilityReason != nil })
        else { return nil }
        let reasons = matches.compactMap(\.availabilityReason)
        if reasons.contains(.cooldown) {
            return .cooldown
        }
        if let unknown = reasons.first(where: {
            if case .unknown = $0 { return true }
            return false
        }) {
            return unknown
        }
        return reasons.contains(.authFailed) ? .authFailed : .missingAuth
    }

    public var composerModelAvailabilityMessage: String? {
        guard self.healthOK,
              !self.currentDraftUsesDurableQueue,
              let reason = self.selectedModelUnavailableReason,
              reason.blocksSend
        else { return nil }
        switch reason {
        case .missingAuth:
            return String(localized: "No provider credential is configured for this model. Set it up in Model Setup.")
        case .authFailed:
            return String(localized: "Authentication failed. Review the provider credential or sign-in, then retry.")
        case .cooldown, .unknown:
            return nil
        }
    }

    private var currentDraftUsesDurableQueue: Bool {
        self.outbox != nil && (!self.attachments.isEmpty || self.hasPendingOutboxCommandsForCurrentSession)
    }

    private func selectedModelAvailabilityKey() -> String? {
        if self.modelSelectionID != Self.defaultModelSelectionID {
            return Self.modelAvailabilityKey(modelID: self.canonicalModelSelectionID, provider: nil)
        }
        let session = self.currentSessionEntry()
        if let model = session?.model {
            return self.resolvedModelAvailabilityKey(modelID: model, provider: session?.modelProvider)
        }
        return self.resolvedModelAvailabilityKey(
            modelID: self.sessionDefaults?.model,
            provider: self.sessionDefaults?.modelProvider)
    }

    private func resolvedModelAvailabilityKey(modelID: String?, provider: String?) -> String? {
        guard let direct = Self.modelAvailabilityKey(modelID: modelID, provider: provider) else { return nil }
        if direct.contains("/") {
            return direct
        }
        let matches = Set(self.modelChoices.compactMap { choice -> String? in
            guard choice.modelID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == direct else {
                return nil
            }
            return Self.modelAvailabilityKey(modelID: choice.modelID, provider: choice.provider)
        })
        return matches.count == 1 ? matches.first : direct
    }

    private static func modelAvailabilityKey(modelID: String?, provider: String?) -> String? {
        guard let modelID = modelID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !modelID.isEmpty
        else { return nil }
        if let separator = modelID.firstIndex(of: "/"), separator != modelID.startIndex {
            let embeddedProvider = String(modelID[..<separator])
            let model = String(modelID[modelID.index(after: separator)...])
            return "\(self.modelAvailabilityProvider(embeddedProvider))/\(model)"
        }
        guard let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines),
              !provider.isEmpty
        else { return modelID }
        return "\(self.modelAvailabilityProvider(provider))/\(modelID)"
    }

    private static func modelAvailabilityProvider(_ provider: String) -> String {
        let normalized = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "codex" || normalized == "openai-codex" ? "openai" : normalized
    }

    public func isDefaultModel(_ model: OpenClawChatModelChoice) -> Bool {
        ChatModelPickerStore.isDefaultModel(
            model,
            defaultProvider: self.sessionDefaults?.modelProvider,
            defaultModel: self.sessionDefaults?.model)
    }

    public var isSelectedModelPinned: Bool {
        self.modelSelectionID != Self.defaultModelSelectionID &&
            self.modelPickerFavorites.contains(self.modelSelectionID)
    }

    public func toggleSelectedModelPinned() {
        guard self.modelSelectionID != Self.defaultModelSelectionID else { return }
        self.modelPickerStore.toggleFavorite(self.modelSelectionID)
        self.modelPickerFavorites = self.modelPickerStore.favorites
    }

    public var thinkingSelectionID: String {
        self.thinkingOverrideIsInherited ? Self.inheritedThinkingSelectionID : self.thinkingLevel
    }

    public var thinkingOverrideIsInherited: Bool {
        if self.hasAppliedLiveSessions {
            return self.currentSessionEntry()?.thinkingLevel == nil
        }
        return !self.prefersExplicitThinkingLevel
    }

    public var verboseLevel: String {
        if self.hasAppliedLiveSessions {
            return Self.normalizedVerboseLevel(self.currentSessionEntry()?.verboseLevel)
                ?? Self.inheritedThinkingSelectionID
        }
        return self.prefersExplicitVerboseLevel
            ? self.preferredVerboseLevel
            : Self.inheritedThinkingSelectionID
    }

    public var fastModeSelectionID: String {
        guard let session = self.currentSessionEntry(), session.fastMode != nil else {
            return Self.inheritedThinkingSelectionID
        }
        return (session.effectiveFastMode ?? session.fastMode)?.isEnabled == true ? "on" : "off"
    }

    public var fastModeIsEnabled: Bool {
        guard let session = self.currentSessionEntry() else { return false }
        return (session.effectiveFastMode ?? session.fastMode)?.isEnabled == true
    }

    public var composerInlineModelLabel: String {
        let label = if self.modelSelectionID == Self.defaultModelSelectionID {
            self.defaultModelLabel.replacingOccurrences(of: "Default: ", with: "")
        } else {
            self.modelChoices.first { self.isSelectedModel($0.selectionID) }?.displayLabel ??
                self.modelSelectionID
        }
        return label.split(separator: "/").last.map(String.init) ?? label
    }

    public var canonicalModelSelectionID: String {
        if self.modelSelectionID == Self.defaultModelSelectionID {
            return Self.defaultModelSelectionID
        }
        return self.modelChoices.first { self.isSelectedModel($0.selectionID) }?.selectionID ??
            self.modelSelectionID
    }

    public func isSelectedModel(_ selectionID: String) -> Bool {
        Self.modelSelectionMatches(
            selectionID: selectionID,
            currentSelectionID: self.modelSelectionID,
            choices: self.modelChoices)
    }

    static func modelSelectionMatches(
        selectionID: String,
        currentSelectionID: String,
        choices: [OpenClawChatModelChoice]) -> Bool
    {
        if selectionID == defaultModelSelectionID {
            return currentSelectionID == defaultModelSelectionID
        }
        guard let choice = choices.first(where: { $0.selectionID == selectionID }) else {
            return currentSelectionID == selectionID
        }
        return currentSelectionID == choice.selectionID || currentSelectionID == choice.modelID
    }

    public var composerInlineEffortLabel: String {
        let effort = self.thinkingOverrideIsInherited
            ? String(
                format: String(localized: "Inherited %@"),
                self.thinkingLevel)
            : self.thinkingLevel
        return self.fastModeSelectionID == "on"
            ? String(
                format: String(localized: "%@, Fast"),
                effort)
            : effort
    }

    public var composerInlineEffortAngle: Double {
        guard self.thinkingLevel != "off",
              let index = self.thinkingLevelOptions.firstIndex(where: { $0.id == self.thinkingLevel })
        else { return -120 }
        guard self.thinkingLevelOptions.count > 1 else { return 120 }
        let fraction = Double(index) / Double(self.thinkingLevelOptions.count - 1)
        return -120 + fraction * 240
    }

    /// `models.list` currently has no fast-support capability field. Keep the
    /// control available and let the gateway validate the session patch.
    public var selectedModelSupportsFastMode: Bool {
        true
    }

    public var isUpdatingSessionSettings: Bool {
        self.inFlightSettingsPatchCountsByTarget[self.currentModelPatchTarget()] != nil
    }

    static func normalizedVerboseLevel(_ level: String?) -> String? {
        let normalized = level?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return Self.verboseLevelOptions.contains(normalized ?? "") ? normalized : nil
    }

    func performSelectVerboseLevel(_ level: String) {
        let clearsOverride = level == Self.inheritedThinkingSelectionID
        let next = clearsOverride ? nil : Self.normalizedVerboseLevel(level)
        guard clearsOverride || next != nil else { return }
        let target = self.currentModelPatchTarget()
        let sessionKey = self.sessionKey
        let baselineSessionLevel = self.currentSessionEntry()?.verboseLevel
        guard clearsOverride ? baselineSessionLevel != nil : Self.normalizedVerboseLevel(baselineSessionLevel) != next
        else { return }

        self.errorText = nil
        if self.acceptedVerboseLevelsByTarget[target] == nil {
            self.acceptedVerboseLevelsByTarget[target] = baselineSessionLevel.map(VerboseLevelState.value)
                ?? VerboseLevelState.none
        }

        self.updateCurrentSessionVerboseLevel(next, sessionKey: sessionKey)
        self.nextVerboseSelectionRequestID &+= 1
        let verboseRequestID = self.nextVerboseSelectionRequestID
        let requestedPreference = VerbosePreferenceState(
            level: next ?? self.preferredVerboseLevel,
            isExplicit: !clearsOverride)
        self.verbosePreferenceRequests[verboseRequestID] = .pending(requestedPreference)
        self.reconcileVerbosePreferenceRequests()
        let requestID = self.reserveSessionSettingsRequest(for: target)
        self.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            do {
                guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
                let result = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: OpenClawChatSessionSettingsPatch(verboseLevel: .some(next)))
                let accepted = clearsOverride ? nil : (Self.normalizedVerboseLevel(result?.verboseLevel) ?? next)
                self.acceptedVerboseLevelsByTarget[target] = accepted.map(VerboseLevelState.value)
                    ?? VerboseLevelState.none
                self.recordModelControlPatchSuccess(
                    result: result,
                    requestID: requestID,
                    target: target,
                    verboseLevelOverride: .some(accepted))
                self.verbosePreferenceRequests[verboseRequestID] = .succeeded(VerbosePreferenceState(
                    level: accepted ?? requestedPreference.level,
                    isExplicit: !clearsOverride))
                self.reconcileVerbosePreferenceRequests()
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionVerboseLevel(
                        accepted,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                }
            } catch {
                self.verbosePreferenceRequests[verboseRequestID] = .failed
                self.reconcileVerbosePreferenceRequests()
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionVerboseLevel(
                        self.acceptedVerboseLevelsByTarget[target]?.level,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                    if !state.exactMatchOnly { self.errorText = error.localizedDescription }
                }
            }
        }
    }

    private func reconcileVerbosePreferenceRequests() {
        let resolved = self.verbosePreferenceRequests.keys.sorted(by: >).compactMap { requestID
            -> VerbosePreferenceState? in
            switch self.verbosePreferenceRequests[requestID] {
            case let .pending(state), let .succeeded(state): state
            case .failed, .none: nil
            }
        }.first ?? self.confirmedVerbosePreference
        if resolved.level != self.preferredVerboseLevel {
            self.preferredVerboseLevel = resolved.level
            self.onVerboseLevelChanged?(resolved.level)
        }
        self.prefersExplicitVerboseLevel = resolved.isExplicit
        if resolved != self.emittedVerbosePreference {
            self.emittedVerbosePreference = resolved
            self.onVerbosePreferenceChanged?(resolved.isExplicit ? resolved.level : nil)
        }
        guard !self.verbosePreferenceRequests.values.contains(where: {
            if case .pending = $0 { return true }
            return false
        }) else { return }
        self.confirmedVerbosePreference = resolved
        self.verbosePreferenceRequests.removeAll()
    }

    func performSelectFastMode(_ selectionID: String) {
        let next: OpenClawChatFastMode?
        switch selectionID {
        case Self.inheritedThinkingSelectionID: next = nil
        case "on": next = .on
        case "off": next = .off
        default: return
        }
        let target = self.currentModelPatchTarget()
        let sessionKey = self.sessionKey
        let baselineFastMode = self.currentSessionEntry()?.fastMode
        let baselineEffectiveFastMode = self.currentSessionEntry()?.effectiveFastMode
        guard baselineFastMode != next else { return }

        self.errorText = nil
        if self.acceptedFastModesByTarget[target] == nil {
            self.acceptedFastModesByTarget[target] = FastModeState(
                override: baselineFastMode,
                effective: baselineEffectiveFastMode)
        }

        self.updateCurrentSessionFastMode(
            next,
            effective: next ?? baselineEffectiveFastMode,
            sessionKey: sessionKey)
        let requestID = self.reserveSessionSettingsRequest(for: target)
        self.enqueueSessionSettingsPatch(requestID: requestID, target: target) { [weak self] routeLease in
            guard let self else { return }
            do {
                guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
                let result = try await routeLease.patchSessionSettings(
                    sessionKey: target.canonicalSessionKey,
                    agentID: target.agentID,
                    patch: OpenClawChatSessionSettingsPatch(fastMode: .some(next)))
                let acceptedOverride = next == nil ? nil : (result?.fastMode ?? next)
                let acceptedEffective = result?.effectiveFastMode
                    ?? result?.fastMode
                    ?? acceptedOverride
                    ?? baselineEffectiveFastMode
                self.acceptedFastModesByTarget[target] = FastModeState(
                    override: acceptedOverride,
                    effective: acceptedEffective)
                self.recordModelControlPatchSuccess(
                    result: result,
                    requestID: requestID,
                    target: target,
                    fastModeOverride: .some(acceptedOverride),
                    effectiveFastMode: acceptedEffective)
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    self.updateCurrentSessionFastMode(
                        acceptedOverride,
                        effective: acceptedEffective,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                }
            } catch {
                if let state = self.modelControlState(for: target, originalSessionKey: sessionKey) {
                    let accepted = self.acceptedFastModesByTarget[target]
                    self.updateCurrentSessionFastMode(
                        accepted?.override,
                        effective: accepted?.effective,
                        sessionKey: state.key,
                        exactMatchOnly: state.exactMatchOnly)
                    if !state.exactMatchOnly { self.errorText = error.localizedDescription }
                }
            }
        }
    }

    func applyModelControlPatchResult(
        _ result: OpenClawChatModelPatchResult,
        sessionKey: String,
        fastOverrideCleared: Bool = false,
        verboseOverrideCleared: Bool = false)
    {
        let session = self.currentSessionEntry()
        if fastOverrideCleared {
            self.updateCurrentSessionFastMode(
                nil,
                effective: result.effectiveFastMode ?? result.fastMode ?? session?.effectiveFastMode,
                sessionKey: sessionKey)
        } else if let fastMode = result.fastMode {
            self.updateCurrentSessionFastMode(
                fastMode,
                effective: result.effectiveFastMode ?? fastMode,
                sessionKey: sessionKey)
        } else if let effectiveFastMode = result.effectiveFastMode {
            self.updateCurrentSessionFastMode(
                session?.fastMode,
                effective: effectiveFastMode,
                sessionKey: sessionKey)
        }
        if verboseOverrideCleared {
            self.updateCurrentSessionVerboseLevel(nil, sessionKey: sessionKey)
        } else if let verboseLevel = Self.normalizedVerboseLevel(result.verboseLevel) {
            self.updateCurrentSessionVerboseLevel(verboseLevel, sessionKey: sessionKey)
        }
    }

    private func recordModelControlPatchSuccess(
        result: OpenClawChatModelPatchResult?,
        requestID: UInt64,
        target: ModelPatchTarget,
        fastModeOverride: OpenClawChatFastMode?? = nil,
        effectiveFastMode: OpenClawChatFastMode? = nil,
        verboseLevelOverride: String?? = nil)
    {
        let previous = self.lastSuccessfulSettingsPatchResultsByTarget[target]
        let recordedFastMode: OpenClawChatFastMode? = if let fastModeOverride {
            fastModeOverride
        } else {
            result?.fastMode ?? previous?.fastMode
        }
        let recordedVerboseLevel: String? = if let verboseLevelOverride {
            verboseLevelOverride
        } else {
            result?.verboseLevel ?? previous?.verboseLevel
        }
        if let fastModeOverride {
            self.lastSuccessfulFastOverrideClearedByTarget[target] = fastModeOverride == nil
        }
        if let verboseLevelOverride {
            self.lastSuccessfulVerboseOverrideClearedByTarget[target] = verboseLevelOverride == nil
        }
        self.lastSuccessfulSettingsPatchRequestIDsByTarget[target] = requestID
        self.lastSuccessfulSettingsPatchResultsByTarget[target] = OpenClawChatModelPatchResult(
            key: result?.key ?? previous?.key ?? target.canonicalSessionKey,
            modelProvider: result?.modelProvider ?? previous?.modelProvider,
            model: result?.model ?? previous?.model,
            thinkingLevel: result?.thinkingLevel ?? previous?.thinkingLevel,
            thinkingLevels: result?.thinkingLevels ?? previous?.thinkingLevels,
            fastMode: recordedFastMode,
            effectiveFastMode: result?.effectiveFastMode ?? effectiveFastMode ?? previous?.effectiveFastMode,
            verboseLevel: recordedVerboseLevel)
    }

    private func modelControlState(for target: ModelPatchTarget, originalSessionKey: String)
        -> (key: String, exactMatchOnly: Bool)?
    {
        if target == self.currentModelPatchTarget() {
            return (originalSessionKey, false)
        }
        guard let key = self.inactiveSettingsStateKey(for: target) else { return nil }
        return (key, true)
    }

    private func updateCurrentSessionVerboseLevel(
        _ level: String?,
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? self.sessions.firstIndex(where: { $0.key == sessionKey })
            : self.sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        self.sessions[index].verboseLevel = level
    }

    private func updateCurrentSessionFastMode(
        _ mode: OpenClawChatFastMode?,
        effective: OpenClawChatFastMode?,
        sessionKey: String,
        exactMatchOnly: Bool = false)
    {
        let index = exactMatchOnly
            ? self.sessions.firstIndex(where: { $0.key == sessionKey })
            : self.sessionIndexForModelState(sessionKey: sessionKey)
        guard let index else { return }
        self.sessions[index].fastMode = mode
        self.sessions[index].effectiveFastMode = effective
    }
}
