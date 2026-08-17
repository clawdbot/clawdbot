import Foundation
import OpenClawProtocol

extension OpenClawChatViewModel {
    func handleProgressCardChanged(_ event: ProgressCardChangedEvent) {
        guard self.matchesCurrentSessionKey(
            incoming: event.sessionkey,
            current: self.sessionKey)
        else { return }

        if event.revision.value is NSNull {
            self.clearProgressCard()
            return
        }
        if event.revision.value as? Int == self.progressCard?.revision {
            return
        }
        self.scheduleProgressCardFetch()
    }

    func scheduleProgressCardFetch(for session: SessionSnapshot? = nil) {
        let session = session ?? self.currentSessionSnapshot()
        guard self.isCurrentSession(session) else { return }
        self.lastIssuedProgressCardRequestID &+= 1
        let requestID = self.lastIssuedProgressCardRequestID
        let generation = self.progressCardGeneration
        Task { [weak self] in
            await self?.fetchProgressCard(
                for: session,
                generation: generation,
                requestID: requestID)
        }
    }

    func clearProgressCard() {
        self.progressCardGeneration &+= 1
        self.applyProgressCard(nil)
    }

    private func fetchProgressCard(
        for session: SessionSnapshot,
        generation: UInt64,
        requestID: UInt64) async
    {
        do {
            let card = try await self.transport.fetchProgressCard(sessionKey: session.key)
            guard self.isCurrentProgressCardRequest(
                session: session,
                generation: generation,
                requestID: requestID)
            else { return }
            self.applyProgressCard(card)
        } catch {
            guard self.isCurrentProgressCardRequest(
                session: session,
                generation: generation,
                requestID: requestID)
            else { return }
            self.applyProgressCard(nil)
            self.logDiagnostic(
                "chat.ui progress card fetch failed sessionKey=\(session.key) "
                    + "error=\(error.localizedDescription)")
        }
    }

    private func isCurrentProgressCardRequest(
        session: SessionSnapshot,
        generation: UInt64,
        requestID: UInt64) -> Bool
    {
        self.progressCardGeneration == generation &&
            self.lastIssuedProgressCardRequestID == requestID &&
            self.isCurrentSession(session)
    }

    private func applyProgressCard(_ card: ProgressCard?) {
        let normalized = Self.normalizedProgressCard(card)
        let previousPresentation = Self.progressCardPresentation(self.progressCard)
        let presentation = Self.progressCardPresentation(normalized)
        let presentationChanged = previousPresentation != presentation
        guard presentationChanged ||
            self.progressCard?.sessionkey != normalized?.sessionkey ||
            self.progressCard?.revision != normalized?.revision
        else { return }
        self.progressCard = normalized
        if presentationChanged {
            self.markTimelineChanged()
        }
    }

    private static func normalizedProgressCard(_ card: ProgressCard?) -> ProgressCard? {
        guard let card else { return nil }
        let markdown = card.markdown?.trimmingCharacters(in: .whitespacesAndNewlines)
        return markdown?.isEmpty == false || card.steps?.isEmpty == false ? card : nil
    }

    private static func progressCardPresentation(_ card: ProgressCard?) -> [String]? {
        guard let card else { return nil }
        return [card.markdown == nil ? "0" : "1", card.markdown ?? ""] +
            (card.steps ?? []).flatMap { [$0.step, $0.status.rawValue] }
    }
}

/// Session-run activity indicator for runs without a chat snapshot.
extension OpenClawChatViewModel {
    func updateActiveSessionRunWithoutChatSnapshot(_ active: Bool) {
        guard self.hasActiveSessionRunWithoutChatSnapshot != active else { return }
        self.hasActiveSessionRunWithoutChatSnapshot = active
        if active {
            self.armActiveSessionRunIndicatorTimeout()
        } else {
            self.activeSessionRunIndicatorTimeoutTask?.cancel()
            self.activeSessionRunIndicatorTimeoutTask = nil
        }
        self.markTimelineChanged()
    }

    private func armActiveSessionRunIndicatorTimeout() {
        self.activeSessionRunIndicatorTimeoutTask?.cancel()
        let timeoutMs = self.pendingRunWaitTimeoutMs
        self.activeSessionRunIndicatorTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            } catch {
                return
            }
            await MainActor.run {
                self?.updateActiveSessionRunWithoutChatSnapshot(false)
            }
        }
    }

    func clearActiveSessionRunIndicatorIfLatestUserAnswered() {
        guard self.hasActiveSessionRunWithoutChatSnapshot,
              !Self.hasUnansweredLatestUser(in: self.messages)
        else { return }
        self.updateActiveSessionRunWithoutChatSnapshot(false)
    }
}
