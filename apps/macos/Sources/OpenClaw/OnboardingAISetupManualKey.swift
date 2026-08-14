import Foundation

extension OnboardingAISetupModel {
    func submitManualKey() {
        let key = self.manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = selectedManualProvider, !key.isEmpty, !self.isBusy else { return }
        guard let context = beginAttemptContext() else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return
        }
        self.manualError = nil
        self.manualTesting = true
        Task { await self.submitManualKey(key: key, provider: provider, context: context) }
    }

    private func submitManualKey(
        key: String,
        provider: ManualProvider,
        context: AttemptContext) async
    {
        defer {
            if self.isCurrentAttempt(context) {
                self.manualTesting = false
            }
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let lease = serverLease,
              await gateway.isCurrentServerLease(lease)
        else {
            let failure = Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again.")
            self.manualError = failure
            self.requireFreshDetection(after: failure)
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let routeFingerprint = await gateway.activationOwnershipFingerprint(
            ifCurrentServerLease: lease)
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: "api-key")
        // Same keychain-unavailable degradation as detected candidates: an
        // unbound lease keeps the ambiguity window without a resume receipt.
        let activationOwner = routeFingerprint.map { fingerprint in
            OnboardingSystemAgentResumeStore.ActivationOwner(
                id: UUID().uuidString,
                routeFingerprint: fingerprint)
        } ?? .unbound()
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = true
        // Manual activation has the same persist-before-response ambiguity as
        // detected candidates, so relaunch must inspect exact Gateway truth.
        guard let activationDeadline = OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs,
            defaults: defaults)
        else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return
        }
        guard !Task.isCancelled else {
            self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            return
        }
        do {
            let data = try await gateway.request(
                method: "openclaw.setup.activate",
                params: [
                    "kind": AnyCodable("api-key"),
                    "authChoice": AnyCodable(provider.id),
                    "apiKey": AnyCodable(key),
                ],
                timeoutMs: requestTimeoutMs,
                ifCurrentServerLease: lease)
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            guard await self.gateway.isCurrentServerLease(lease) else {
                if result.ok,
                   OnboardingSystemAgentResumeStore.markCompleted(
                       ifOwnedBy: context.routeIdentity,
                       activationOwner: activationOwner,
                       defaults: self.defaults)
                {
                    self.pendingActivationVerification = true
                    self.phase = .detecting
                    _ = await self.verifyPendingConfiguredInference()
                } else {
                    self.pendingActivationVerification = false
                    self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                    self.requireFreshDetection(after: Self.transportFailure(
                        "The Gateway connection changed while AI setup was finishing. Check again."))
                }
                return
            }
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                self.manualKey = ""
                self.finishConnected(
                    kind: "api-key",
                    activationOwner: activationOwner)
            } else {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.manualError = Self.failure(
                    label: provider.label,
                    status: result.status,
                    error: result.error)
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // A cancellation after request dispatch is ambiguous; keep the
            // pending marker so relaunch reconciles against this exact route.
            let failure = Self.transportFailure(error.localizedDescription)
            self.manualError = failure
            if Self.activationFailureIsDefinitive(error) {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                if await !(self.gateway.isCurrentServerLease(lease)) {
                    self.requireFreshDetection(after: failure)
                }
            } else {
                self.retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline)
            }
        }
    }
}

