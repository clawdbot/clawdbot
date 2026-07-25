import Foundation

// Offline transcript cache integration. The cache only pre-paints cold opens
// and covers offline browsing; live gateway responses are always the source
// of truth and replace cached rows wholesale.

extension OpenClawChatViewModel {
    struct SessionSnapshot: Equatable {
        var key: String
        var generation: UInt64
        var agentID: String?
        var deliveryAgentID: String?
        var sessionRoutingContract: String?
    }

    func replaceMessages(_ messages: [OpenClawChatMessage]) {
        guard self.messages != messages else { return }
        self.messages = messages
        self.seedInputHistory(from: messages)
        markTimelineChanged()
    }

    func persistTranscriptToCache(
        session: SessionSnapshot,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>)
    {
        let transcriptCache = self.transcriptCache
        let outbox = self.outbox
        let scope = self.outboxBranchScope(for: session)
        let tip = messages.reversed().compactMap { message -> String? in
            let entryID = message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines)
            return entryID?.isEmpty == false ? entryID : nil
        }.first
        guard transcriptCache != nil || (outbox != nil && scope != nil && tip != nil) else { return }
        let branchStateTask: Task<OpenClawChatOutboxBranchState?, Never>? = if let outbox, let scope {
            Task { await outbox.branchState(for: scope) }
        } else {
            nil
        }
        // Chain writes so an older snapshot can never land after a newer one;
        // detached tasks alone give no ordering guarantee across awaits.
        let previous = pendingCacheWriteTask
        pendingCacheWriteTask = Task.detached {
            await previous?.value
            if let transcriptCache {
                await transcriptCache.storeCanonicalTranscript(
                    sessionKey: session.key,
                    agentID: Self.transcriptCacheAgentID(sessionKey: session.key, agentID: session.agentID),
                    messages: messages,
                    canonicalMessageIdempotencyKeys: canonicalMessageIdempotencyKeys)
            }
            if let outbox,
               let scope,
               let tip,
               let branchStateTask,
               let expectedEpoch = await branchStateTask.value?.epoch
            {
                _ = await outbox.updateLastActiveLeafEntryID(
                    tip,
                    expectedEpoch: expectedEpoch,
                    for: scope)
            }
        }
    }

    func persistSessionsToCache(_ sessions: [OpenClawChatSessionEntry]) {
        guard let transcriptCache else { return }
        let previous = pendingCacheWriteTask
        pendingCacheWriteTask = Task.detached {
            await previous?.value
            await transcriptCache.storeSessions(sessions)
        }
    }

    /// Cache-first cold open: pre-paint the cached transcript/session list
    /// while the live requests are in flight (or failing while offline).
    /// Live history replaces the painted rows wholesale via the normal
    /// applyHistoryPayload reconciliation path.
    func paintFromCacheIfNeeded(session: SessionSnapshot) {
        guard let transcriptCache else { return }
        if sessions.isEmpty, !hasAppliedLiveSessions {
            Task { [weak self] in
                let cached = await transcriptCache.loadSessions()
                guard let self, !cached.isEmpty else { return }
                // A live sessions response (even an empty one) is authoritative;
                // a slow cache read must never repaint over it.
                guard self.sessions.isEmpty, !self.hasAppliedLiveSessions else { return }
                self.sessions = self.applyingLocalUnreadOverrides(
                    to: OpenClawChatSessionListOrganizer.organize(cached))
            }
        }
        guard messages.isEmpty, !hasAppliedLiveHistory else { return }
        Task { [weak self] in
            let cached = await transcriptCache.loadTranscript(
                sessionKey: session.key,
                agentID: Self.transcriptCacheAgentID(sessionKey: session.key, agentID: session.agentID))
            guard let self, !cached.isEmpty else { return }
            guard self.isCurrentSession(session), !self.hasAppliedLiveHistory, self.messages.isEmpty else {
                return
            }
            self.replaceMessages(cached)
            self.isShowingCachedTranscript = true
        }
    }

    static func transcriptCacheAgentID(sessionKey: String, agentID: String?) -> String? {
        guard OpenClawChatSessionKey.agentID(from: sessionKey) == nil else { return nil }
        let normalized = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}
