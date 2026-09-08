import Foundation
import OpenClawKit
import OpenClawProtocol

extension OpenClawChatViewModel {
    func handleProgressCardChanged(_ event: ProgressCardChangedEvent) {
        let session = self.currentSessionSnapshot()
        let target = self.progressCardTarget(for: session)
        let canonical = target?.sessionKey ?? session.key
        guard Self.matchesCurrentSessionKey(
            incoming: event.sessionkey,
            current: canonical,
            mainSessionKey: self.resolvedMainSessionKey,
            activeAgentId: target?.agentID ?? session.deliveryAgentID)
        else { return }

        // Global and ordinary rows can share a wire key. Events invalidate; only the
        // captured target's get response may publish or clear its durable card.
        self.scheduleProgressCardFetch(for: session)
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
            guard self.isCurrentProgressCardRequest(
                session: session,
                generation: generation,
                requestID: requestID)
            else { return }
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

    func refreshProgressCard(from info: OpenClawChatSessionInfo?, for request: HistoryRequest) {
        // History may finish on an old physical route. Its canonical target is
        // reusable only within the session and progress generation that admitted it.
        guard request.progressCardGeneration == self.progressCardGeneration,
              self.isCurrentSession(request.session)
        else { return }
        self.preparedProgressCardTarget = nil
        if let key = info?.key,
           let owner = info?.agentId ?? OpenClawChatSessionKey.agentID(from: key),
           request.session.deliveryAgentID == nil || request.session.deliveryAgentID == owner,
           key == "global" || OpenClawChatSessionKey.agentID(from: key) == owner
        {
            self.preparedProgressCardTarget = (
                request.session,
                request.progressCardGeneration,
                OpenClawChatSessionTarget(sessionKey: key, agentID: owner))
        }
        self.scheduleProgressCardFetch(for: request.session)
    }

    func invalidateProgressCardTarget() {
        self.progressCardGeneration &+= 1
        self.preparedProgressCardTarget = nil
    }

    func clearProgressCard() {
        self.invalidateProgressCardTarget()
        self.applyProgressCard(nil)
    }

    private func progressCardTarget(for session: SessionSnapshot) -> OpenClawChatSessionTarget? {
        if let prepared = self.preparedProgressCardTarget,
           prepared.generation == self.progressCardGeneration,
           self.isCurrentSession(prepared.session)
        {
            return prepared.target
        }
        // A literal global key and selected owner are already canonical;
        // aliases wait for admitted history instead of guessing a main key.
        guard session.key == "global", let owner = session.deliveryAgentID else { return nil }
        return OpenClawChatSessionTarget(sessionKey: "global", agentID: owner)
    }

    private func fetchProgressCard(
        for session: SessionSnapshot,
        generation: UInt64,
        requestID: UInt64) async
    {
        guard let target = self.progressCardTarget(for: session), let owner = target.agentID else {
            self.logDiagnostic("chat.ui progress card waits for canonical history identity")
            return
        }
        let expectedKey = target.sessionKey == "global" ? "agent:\(owner):global" : target.sessionKey
        do {
            let card = try await self.transport.fetchProgressCard(
                sessionKey: target.sessionKey,
                agentID: owner)
            guard self.isCurrentProgressCardRequest(
                session: session,
                generation: generation,
                requestID: requestID)
            else { return }
            if let card, card.sessionkey != expectedKey {
                self.logDiagnostic("chat.ui progress card response rejected: session identity changed")
                return
            }
            self.applyProgressCard(card)
            if self.errorText == OpenClawChatTransportUpgradeMessage.progressCardAgentScope {
                self.errorText = nil
            }
        } catch {
            guard self.isCurrentProgressCardRequest(
                session: session,
                generation: generation,
                requestID: requestID)
            else { return }
            if let response = error as? GatewayResponseError,
               response.details["code"]?.stringValue == "SESSION_PARTICIPATION_REQUIRED"
            {
                self.applyProgressCard(nil)
            }
            if error is OpenClawChatProgressCardError, self.errorText == nil {
                self.errorText = error.localizedDescription
            }
            // Unsupported or transient refresh failures retain the last durable card.
            // Explicit denial removes its content while preserving the canonical retry target.
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
