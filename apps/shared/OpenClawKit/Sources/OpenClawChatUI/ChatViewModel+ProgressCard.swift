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
            guard let self else { return }
            let storeAvailable = await self.transport.gatewayAdvertisesMethod("progressCard.get")
            self.progressCardStoreAvailable = storeAvailable
            // Gateways without the durable store reject the fetch outright
            // (2026.7.x: "missing scope: operator.admin"); the legacy
            // stream:"plan" fallback owns the card there.
            guard storeAvailable != false else { return }
            await self.fetchProgressCard(
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
            // Keep the last rendered card on transient failure: the durable
            // store clears only via a successful null fetch or a null-revision
            // poke, never via a failed refresh.
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

    func applyProgressCard(_ card: ProgressCard?) {
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

    static func parseLegacyProgressCardSteps(_ value: AnyCodable?) -> [ProgressCardStep] {
        guard let value else { return [] }
        let rawItems: [Any]
        switch value.value {
        case let items as [AnyCodable]:
            rawItems = items.map(\.value)
        case let items as [Any]:
            rawItems = items
        case let items as NSArray:
            rawItems = items.map(\.self)
        default:
            return []
        }
        var hasInProgressStep = false
        return rawItems.compactMap { rawItem in
            guard let step = Self.parseLegacyProgressCardStep(rawItem) else { return nil }
            if case .inProgress = step.status {
                guard !hasInProgressStep else { return nil }
                hasInProgressStep = true
            }
            return step
        }
    }

    private static func parseLegacyProgressCardStep(_ rawValue: Any) -> ProgressCardStep? {
        let value = (rawValue as? AnyCodable)?.value ?? rawValue
        if let legacyStep = value as? String {
            return self.makeLegacyProgressCardStep(text: legacyStep, status: .pending)
        }

        let fields: [String: Any]
        switch value {
        case let dictionary as [String: AnyCodable]:
            fields = dictionary.mapValues(\.value)
        case let dictionary as [String: String]:
            fields = dictionary
        case let dictionary as [String: Any]:
            fields = dictionary
        case let dictionary as NSDictionary:
            fields = dictionary.reduce(into: [:]) { result, entry in
                guard let key = entry.key as? String else { return }
                result[key] = (entry.value as? AnyCodable)?.value ?? entry.value
            }
        default:
            return nil
        }

        guard let text = fields["step"] as? String,
              let rawStatus = fields["status"] as? String,
              let status = ProgressCardStepStatus(rawValue: rawStatus)
        else {
            return nil
        }
        return self.makeLegacyProgressCardStep(text: text, status: status)
    }

    private static func makeLegacyProgressCardStep(
        text: String,
        status: ProgressCardStepStatus) -> ProgressCardStep?
    {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return ProgressCardStep(step: trimmed, status: status)
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
