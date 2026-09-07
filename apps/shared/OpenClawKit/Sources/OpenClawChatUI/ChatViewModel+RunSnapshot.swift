import OpenClawKit

/// In-flight run adoption shared by history replay and live transport events.
extension OpenClawChatViewModel {
    func applyInFlightRunSnapshot(
        _ payload: OpenClawChatHistoryPayload,
        for request: HistoryRequest)
    {
        guard request.runOwnershipGeneration == self.runOwnershipGeneration,
              request.id >= self.latestAppliedRunSnapshotRequestID
        else {
            return
        }
        self.latestAppliedRunSnapshotRequestID = request.id
        if let sessionInfo = payload.sessionInfo {
            let listedIndex = self.sessions.firstIndex(where: {
                self.matchesCurrentSessionKey(incoming: $0.key, current: request.session.key)
            })
            if let index = listedIndex {
                var updated = self.sessions
                updated[index].hasActiveRun = sessionInfo.hasActiveRun
                updated[index].activeRunIds = sessionInfo.activeRunIds
                self.sessions = updated
            } else {
                self.updateActiveSessionRunIDs(sessionInfo.activeRunIds ?? [])
            }
            // The history response is authoritative for the session it was
            // requested for, whether or not that session currently has a row.
            // A bounded or failed refresh can drop the row while a rejection is
            // still latched; reconciling only inside the row branch would strand
            // that latch and leave the picker disabled against idle evidence.
            // The snapshot remains authoritative for this session only.
            self.reconcileGatewayConfirmedActiveRuns(observing: [
                GatewaySessionLivenessObservation(
                    identity: self.gatewayRunLivenessIdentity(
                        forSessionKey: request.session.key,
                        agentID: request.session.deliveryAgentID ?? request.session.agentID,
                        listedKey: listedIndex.map { self.sessions[$0].key }),
                    hasActiveRun: sessionInfo.hasActiveRun),
            ])
        }
        guard let snapshot = payload.inFlightRun,
              let runId = Self.normalizedRunID(snapshot.runId),
              self.liveRunStateByRunID[runId]?.terminal != true
        else {
            return
        }

        self.isApplyingRunSnapshot = true
        defer { self.isApplyingRunSnapshot = false }
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        self.adoptRunState(runId: runId, bufferedText: snapshot.text)
    }

    func adoptRun(runId: String, bufferedText: String) {
        self.adoptRunState(runId: runId, bufferedText: bufferedText)
    }

    private func adoptRunState(runId: String, bufferedText: String) {
        // A terminal ID stays retired until an authoritative session snapshot
        // explicitly removes it; late deltas/history cannot resurrect the run.
        guard self.liveRunStateByRunID[runId]?.terminal != true else { return }
        let replacedRun = self.pendingRuns.count != 1 || !self.pendingRuns.contains(runId)
        if replacedRun {
            // Gateway snapshots and live deltas are canonical for this session.
            // Replace stale local ownership so only that run consumes later events.
            clearPendingRuns(reason: nil)
            self.pendingRuns.insert(runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
        }
        if self.runMessageScopesByRunID[runId] == nil {
            self.runMessageScopesByRunID[runId] = currentRunMessageScope()
        }
        if self.pendingRunOwnerArmIDs[runId] == nil {
            armPendingRunOwner(runId: runId)
        }
        // Chat snapshots concatenate model turns; agent text owns the current item once observed.
        if self.liveRunStateByRunID[runId]?.hasAgentAssistantText != true, !bufferedText.isEmpty {
            self.updateStreamingAssistantText(bufferedText)
        }
        self.logDiagnostic(
            "chat.ui adopted in-flight run sessionKey=\(self.sessionKey) "
                + "runId=\(runId) bufferedTextLen=\(bufferedText.count)")
    }
}
