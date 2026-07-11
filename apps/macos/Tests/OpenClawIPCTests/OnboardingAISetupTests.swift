import Foundation
@testable import OpenClaw
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing

@Suite(.serialized)
@MainActor
struct OnboardingAISetupTests {
    @Test func `candidate failure keeps friendly summary and exact detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "auth",
            error: "Codex login expired (request 42)"
        )

        #expect(failure.summary == "Codex CLI is installed, but the login didn’t work. Sign in again, then retry.")
        #expect(failure.detail == "Codex login expired (request 42)")
        #expect(failure.copyText == "Codex login expired (request 42)")
    }

    @Test func `candidate failure omits empty detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "timeout",
            error: "  "
        )

        #expect(failure.summary == "Codex CLI didn’t answer in time.")
        #expect(failure.detail == nil)
        #expect(failure.copyText == failure.summary)
    }

    @Test func `transport failure preserves original detail`() {
        let failure = OnboardingAISetupModel.transportFailure(
            "Gateway request failed: connection reset"
        )

        #expect(failure.summary == "The Gateway setup request failed. Show details to inspect or copy the error.")
        #expect(failure.detail == "Gateway request failed: connection reset")
    }

    @Test func `unavailable failure keeps long detail out of the visible summary`() {
        let rawDetail = String(repeating: "installer output ", count: 200)
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "unavailable",
            error: rawDetail
        )

        #expect(failure.summary == "Codex CLI couldn’t complete the test. Show details to inspect or copy the error.")
        #expect(failure.detail == rawDetail.trimmingCharacters(in: .whitespacesAndNewlines))
        #expect(failure.copyText == failure.detail)
    }

    @Test func `Claude Code and Codex use bundled vector artwork`() {
        for kind in ["claude-cli", "codex-cli"] {
            let url = OnboardingProviderIcon.resourceURL(for: kind)
            #expect(url?.pathExtension == "svg")
            #expect(OnboardingProviderIcon.image(for: kind)?.isTemplate == true)
        }
        #expect(OnboardingProviderIcon.resourceURL(for: "gemini-cli") == nil)
    }

    @Test func `codex activation covers install probe and finalization`() {
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") == 480_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "claude-cli") == 150_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(
            for: "api-key",
            provisionsCodexSupervision: true) == 480_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") >= (305 + 90) * 1000)
        #expect(OnboardingAISetupModel.activationOutcomeDeadlineMs(for: "codex-cli") == 510_000)
    }

    @Test func `activation sends exact model only to capable gateways`() {
        let legacy = OnboardingAISetupModel.activationParams(
            kind: "codex-cli",
            modelRef: "openai/gpt-5.5",
            supportsExactModel: false
        )
        let capable = OnboardingAISetupModel.activationParams(
            kind: "codex-cli",
            modelRef: "openai/gpt-5.5",
            supportsExactModel: true
        )

        #expect(legacy["kind"]?.value as? String == "codex-cli")
        #expect(legacy["modelRef"] == nil)
        #expect(capable["kind"]?.value as? String == "codex-cli")
        #expect(capable["modelRef"]?.value as? String == "openai/gpt-5.5")
    }

    @Test func `activation decodes and retains copyable setup lines`() throws {
        let data = Data(
            #"""
            {"ok":true,"modelRef":"openai/gpt-5.5","lines":[
              "Model: openai/gpt-5.5","  Plugin registry refresh failed: offline  ",""
            ]}
            """#
            .utf8
        )
        let result = try JSONDecoder().decode(OnboardingAISetupModel.ActivateResult.self, from: data)
        let model = OnboardingAISetupModel()

        model._test_setConnectedSetupLines(result.lines)

        #expect(model.connectedSetupLines == [
            "Model: openai/gpt-5.5",
            "Plugin registry refresh failed: offline",
        ])
        #expect(model.connectedSetupCopyText ==
            "Model: openai/gpt-5.5\nPlugin registry refresh failed: offline")

        model.resetForGatewayChange()
        #expect(model.connectedSetupLines.isEmpty)
        #expect(model.connectedSetupCopyText.isEmpty)
    }

    @Test func `gateway hello maps exact-model setup capability`() throws {
        let data = Data(
            #"""
            {"type":"hello-ok","protocol":4,
             "server":{"version":"test","connId":"test"},
             "features":{"methods":[],"events":[],"capabilities":["crestodian-setup-model-ref"]},
             "snapshot":{"presence":[],"health":{},
                         "stateVersion":{"presence":0,"health":0},"uptimeMs":0},
             "auth":{},"policy":{}}
            """#
            .utf8
        )
        let hello = try JSONDecoder().decode(HelloOk.self, from: data)

        #expect(hello.supportsServerCapability(.crestodianSetupModelRef))
    }

    @Test func `reconciliation requires setup state to transition after activation`() {
        let missing = OnboardingAISetupModel.PersistedActivationState(
            setupComplete: false,
            configuredModel: nil
        )
        let persisted = OnboardingAISetupModel.PersistedActivationState(
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"
        )

        #expect(OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: "openai/gpt-5.5",
            before: missing,
            after: persisted
        ))
        #expect(!OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: "openai/gpt-5.5",
            before: persisted,
            after: persisted
        ))
        #expect(!OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: "openai/gpt-5.5",
            before: nil,
            after: persisted
        ))
    }

    @Test func `definitive gateway response does not enter reconciliation`() {
        let responseError = GatewayResponseError(
            method: "crestodian.setup.activate",
            code: "UNKNOWN_METHOD",
            message: "unknown method",
            details: nil
        )
        let timeout = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out"]
        )
        let decodeError = DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "invalid activation response"
        ))

        #expect(OnboardingAISetupModel.activationReconciliationMode(after: responseError) == .none)
        #expect(OnboardingAISetupModel.activationReconciliationMode(
            after: OpenClawChatTransportSendError.notDispatched
        ) == .none)
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

    @Test func `retired setup socket requires a fresh detection lease`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true
        let failure = OnboardingAISetupModel.transportFailure("connection dropped")

        model.requireFreshDetection(after: failure)

        #expect(model.phase == .ready)
        #expect(model.detectError == failure)
        #expect(model.candidates.isEmpty)
        #expect(model.manualProviders.isEmpty)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
    }
}
