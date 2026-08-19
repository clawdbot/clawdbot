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
            if let index = self.sessions.firstIndex(where: {
                self.matchesCurrentSessionKey(incoming: $0.key, current: request.session.key)
            }) {
                var updated = self.sessions
                updated[index].hasActiveRun = sessionInfo.hasActiveRun
                updated[index].activeRunIds = sessionInfo.activeRunIds
                self.sessions = updated
            } else {
                self.updateActiveSessionRunIDs(sessionInfo.activeRunIds ?? [])
            }
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
        if !bufferedText.isEmpty {
            self.updateStreamingAssistantText(bufferedText)
        }
        self.logDiagnostic(
            "chat.ui adopted in-flight run sessionKey=\(self.sessionKey) "
                + "runId=\(runId) bufferedTextLen=\(bufferedText.count)")
    }
}
