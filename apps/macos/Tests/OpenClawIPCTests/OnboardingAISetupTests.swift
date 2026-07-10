import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingAISetupTests {
    @Test func `candidate failure keeps friendly summary and exact detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "auth",
            error: "Codex login expired (request 42)")

        #expect(failure.summary == "Codex CLI is installed, but the login didn’t work. Sign in again, then retry.")
        #expect(failure.detail == "Codex login expired (request 42)")
        #expect(failure.copyText == "Codex login expired (request 42)")
    }

    @Test func `candidate failure omits empty detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "timeout",
            error: "  ")

        #expect(failure.summary == "Codex CLI didn’t answer in time.")
        #expect(failure.detail == nil)
        #expect(failure.copyText == failure.summary)
    }

    @Test func `transport failure preserves original detail`() {
        let failure = OnboardingAISetupModel.transportFailure(
            "Gateway request failed: connection reset")

        #expect(failure.summary == "Gateway request failed: connection reset")
        #expect(failure.detail == "Gateway request failed: connection reset")
    }

    @Test func `codex activation covers install probe and finalization`() {
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") == 480_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "claude-cli") == 150_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") >= (305 + 90) * 1000)
        #expect(OnboardingAISetupModel.activationOutcomeDeadlineMs(for: "codex-cli") == 510_000)
    }

    @Test func `incomplete detection is not a reconciled activation`() {
        #expect(!OnboardingAISetupModel.activationIsPersisted(
            expectedModel: "openai/gpt-5.5",
            setupComplete: false,
            configuredModel: nil))
        #expect(OnboardingAISetupModel.activationIsPersisted(
            expectedModel: "openai/gpt-5.5",
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"))
    }

    @Test func `definitive gateway response does not enter reconciliation`() {
        let responseError = GatewayResponseError(
            method: "crestodian.setup.activate",
            code: "UNKNOWN_METHOD",
            message: "unknown method",
            details: nil)
        let timeout = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out"])
        let decodeError = DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "invalid activation response"))

        #expect(OnboardingAISetupModel.activationReconciliationMode(after: responseError) == .none)
        #expect(OnboardingAISetupModel.activationReconciliationMode(after: decodeError) == .immediate)
        #expect(OnboardingAISetupModel.activationReconciliationMode(after: timeout) == .polling)
    }

    @Test func `gateway change clears route-bound setup state`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true

        model.resetForGatewayChange()

        #expect(model.phase == .idle)
        #expect(model.connectedModelRef == nil)
        #expect(model.connectedLatencyMs == nil)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
    }
}
