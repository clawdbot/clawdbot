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
        if let activeRunIDs = payload.sessionInfo?.activeRunIds {
            self.updateActiveSessionRunIDs(activeRunIDs)
        } else if payload.sessionInfo?.hasActiveRun == false {
            self.updateActiveSessionRunIDs([])
        }
        // Plan reconciliation shares run adoption: rejected history cannot clobber newer live state.
        // A missing plan is version-skew unknown; replacement or explicit terminal evidence clears it.
        guard let snapshot = payload.inFlightRun,
              let runId = Self.normalizedRunID(snapshot.runId),
              self.liveRunStateByRunID[runId]?.terminal != true
        else {
            guard let retainedRunId = self.planRunId else { return }
            let activeRunIds = payload.sessionInfo?.activeRunIds
            let confirmsAnotherRun = activeRunIds.map { !$0.contains(retainedRunId) } == true
            if payload.sessionInfo?.hasActiveRun == false || confirmsAnotherRun {
                self.clearPlan(for: retainedRunId)
            }
            return
        }

        self.isApplyingRunSnapshot = true
        defer { self.isApplyingRunSnapshot = false }
        self.updateActiveSessionRunWithoutChatSnapshot(false)
        self.adoptRunState(runId: runId, bufferedText: snapshot.text, preservePlan: true)
        if self.planRunId != nil, self.planRunId != runId {
            self.clearPlan()
        }
        if let planSnapshot = snapshot.plan {
            self.applyPlanSnapshot(
                runId: runId,
                steps: planSnapshot.steps,
                explanation: planSnapshot.explanation)
        }
    }

    func adoptRun(runId: String, bufferedText: String) {
        self.adoptRunState(runId: runId, bufferedText: bufferedText, preservePlan: false)
    }

    private func adoptRunState(runId: String, bufferedText: String, preservePlan: Bool) {
        // A terminal ID stays retired until an authoritative session snapshot
        // explicitly removes it; late deltas/history cannot resurrect the run.
        guard self.liveRunStateByRunID[runId]?.terminal != true else { return }
        let replacedRun = self.pendingRuns.count != 1 || !self.pendingRuns.contains(runId)
        if replacedRun {
            // Gateway snapshots and live deltas are canonical for this session.
            // Replace stale local ownership so only that run consumes later events.
            clearPendingRuns(reason: nil, preservePlan: preservePlan)
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
        if !bufferedText.isEmpty {
            self.updateStreamingAssistantText(bufferedText)
        }
        self.logDiagnostic(
            "chat.ui adopted in-flight run sessionKey=\(self.sessionKey) "
                + "runId=\(runId) bufferedTextLen=\(bufferedText.count)")
    }
}
