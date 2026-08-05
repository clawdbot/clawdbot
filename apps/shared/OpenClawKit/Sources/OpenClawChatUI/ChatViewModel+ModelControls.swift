import Foundation

extension OpenClawChatViewModel {
    public static let verboseLevelOptions = ["off", "on", "full"]

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
