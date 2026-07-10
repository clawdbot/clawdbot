import AppKit
import Foundation
import Observation
import OpenClawIPC
import OpenClawKit
import SwiftUI

/// Structured "Connect your AI" onboarding step.
///
/// Drives the gateway's `crestodian.setup.detect` / `crestodian.setup.activate`
/// RPCs: detect reusable AI access (Claude Code, Codex, Gemini logins, API
/// keys), live-test the best candidate, and automatically fall through to the
/// next one when a test fails. Config is only written server-side after a
/// candidate actually answered, so this page can never strand the user with a
/// broken model.
@MainActor
@Observable
final class OnboardingAISetupModel {
    struct Candidate: Identifiable, Equatable {
        let kind: String
        let label: String
        let detail: String
        let modelRef: String
        let recommended: Bool
        let credentials: Bool?

        var id: String {
            self.kind
        }
    }

    enum CandidateStatus: Equatable {
        case untried
        case testing
        case failed(Failure)
        case connected
    }

    struct Failure: Equatable {
        let summary: String
        let detail: String?

        var copyText: String {
            self.detail ?? self.summary
        }
    }

    enum Phase: Equatable {
        case idle
        case detecting
        case ready
        case testing
        case connected
    }

    struct ManualProvider: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String?
    }

    private(set) var phase: Phase = .idle {
        didSet {
            // Close-guard: quitting mid-test is confirmable, not silent.
            OnboardingController.shared.busyReason = self.phase == .testing
                ? "OpenClaw is testing your AI connection."
                : nil
        }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var connectedModelRef: String?
    private(set) var connectedLatencyMs: Int?
    private(set) var detectError: Failure?
    /// Set once every detected candidate failed; opens the manual key form.
    private(set) var exhaustedAutoCandidates = false

    var manualProviderID = ""
    var manualKey: String = ""
    private(set) var manualTesting = false
    private(set) var manualError: Failure?
    var showManualEntry = false

    var selectedManualProvider: ManualProvider? {
        self.manualProviders.first { $0.id == self.manualProviderID }
    }

    var connected: Bool {
        self.phase == .connected
    }

    var isBusy: Bool {
        self.phase == .detecting || self.phase == .testing || self.manualTesting
    }

    /// Called when a candidate connects so the page can advance.
    var onConnected: (() -> Void)?

    private var started = false
    private var attemptToken = UUID()

    private struct DetectResult: Decodable {
        struct DetectedCandidate: Decodable {
            let kind: String
            let label: String
            let detail: String
            let modelRef: String
            let recommended: Bool
            let credentials: Bool?
        }

        let candidates: [DetectedCandidate]
        let manualProviders: [ManualProvider]?
        let workspace: String
        let configuredModel: String?
        let setupComplete: Bool
    }

    private struct ActivateResult: Decodable {
        let ok: Bool
        let modelRef: String?
        let latencyMs: Double?
        let status: String?
        let error: String?
    }

    func startIfNeeded() {
        guard !self.started else { return }
        self.started = true
        Task { await self.detectAndAutoConnect() }
    }

    func retryFromScratch() {
        self.resetForGatewayChange()
        self.started = true
        Task { await self.detectAndAutoConnect() }
    }

    /// Cancel route-bound work and discard results that belong to the previous Gateway.
    func resetForGatewayChange() {
        self.attemptToken = UUID()
        self.started = false
        self.phase = .idle
        self.candidates = []
        self.manualProviders = []
        self.providerCatalogLoaded = false
        self.providerCatalogError = nil
        self.statuses = [:]
        self.selectedKind = nil
        self.connectedModelRef = nil
        self.connectedLatencyMs = nil
        self.detectError = nil
        self.exhaustedAutoCandidates = false
        self.manualProviderID = ""
        self.manualKey = ""
        self.manualError = nil
        self.manualTesting = false
        self.showManualEntry = false
    }

    func detectAndAutoConnect() async {
        let token = self.attemptToken
        self.phase = .detecting
        self.detectError = nil
        self.providerCatalogError = nil
        do {
            let data = try await GatewayConnection.shared.request(
                method: "crestodian.setup.detect",
                params: [:],
                timeoutMs: 20000,
                retryTransportFailures: true)
            guard token == self.attemptToken else { return }
            let result = try JSONDecoder().decode(DetectResult.self, from: data)
            let manualProviders = result.manualProviders ?? []
            self.candidates = result.candidates.map { detected in
                Candidate(
                    kind: detected.kind,
                    label: detected.label,
                    detail: detected.detail,
                    modelRef: detected.modelRef,
                    recommended: detected.recommended,
                    credentials: detected.credentials)
            }
            self.manualProviders = manualProviders
            self.providerCatalogLoaded = result.manualProviders != nil
            if result.manualProviders == nil {
                self.providerCatalogError = OnboardingAISetupError.providerCatalogUnavailable.localizedDescription
            }
            if !manualProviders.contains(where: { $0.id == self.manualProviderID }) {
                self.manualProviderID = manualProviders.first?.id ?? ""
            }
            for candidate in self.candidates {
                self.statuses[candidate.kind] = .untried
            }
            self.phase = .ready
            if let first = self.autoCandidateAfter(kind: nil) {
                // Best candidate found: connect without asking. Switching later
                // stays one click away while the test runs server-side.
                await self.activate(kind: first.kind)
            } else {
                self.showManualEntry = !self.manualProviders.isEmpty
            }
        } catch {
            guard token == self.attemptToken else { return }
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            self.showManualEntry = self.candidates.isEmpty
        }
    }

    /// Transport/protocol failures deserve plain language, not RPC codes.
    static func friendlyTransportError(_ raw: String) -> String {
        if raw.localizedCaseInsensitiveContains("unknown method") {
            return "The Gateway is running an older OpenClaw version that doesn’t support " +
                "app-guided setup. Update OpenClaw on the gateway, then try again."
        }
        return raw
    }

    static func activationRequestTimeoutMs(for kind: String) -> Double {
        // Codex can spend 305s installing its runtime plugin before the 90s live probe.
        // Keep a bounded client deadline with room for registry refresh and finalization.
        kind == "codex-cli" ? 480_000 : 150_000
    }

    static func activationOutcomeDeadlineMs(for kind: String) -> Double {
        // A request timeout removes only the client waiter. Keep a short final window
        // to observe config that the still-running Gateway operation just persisted.
        self.activationRequestTimeoutMs(for: kind) + 30000
    }

    static func activationIsPersisted(
        expectedModel: String,
        setupComplete: Bool,
        configuredModel: String?) -> Bool
    {
        setupComplete && configuredModel == expectedModel
    }

    enum ActivationReconciliationMode: Equatable {
        case none
        case immediate
        case polling
    }

    static func activationReconciliationMode(after error: Error) -> ActivationReconciliationMode {
        // Decode failures happen after the side-effectful RPC returned bytes, so check persisted
        // state once. Only transport-unknown outcomes need the bounded polling window.
        if error is DecodingError {
            return .immediate
        }
        if error is GatewayResponseError ||
            error is GatewayConnectAuthError ||
            error is GatewayTLSValidationError
        {
            return .none
        }
        return .polling
    }

    /// Candidates the automatic ladder may try: skip definitively logged-out
    /// installs and anything already attempted.
    private func autoCandidateAfter(kind: String?) -> Candidate? {
        let startIndex: Int = if let kind, let index = self.candidates.firstIndex(where: { $0.kind == kind }) {
            index + 1
        } else {
            0
        }
        guard startIndex <= self.candidates.count else { return nil }
        return self.candidates[startIndex...].first { candidate in
            candidate.credentials != false && self.statuses[candidate.kind] == .untried
        }
    }

    func userSelect(kind: String) {
        guard !self.isBusy else { return }
        guard self.statuses[kind] != .connected else { return }
        Task { await self.activate(kind: kind) }
    }

    func activate(kind: String) async {
        let token = self.attemptToken
        let clock = ContinuousClock()
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: kind)
        let outcomeDeadlineMs = Self.activationOutcomeDeadlineMs(for: kind)
        let reconciliationDeadline = clock.now.advanced(by: .milliseconds(Int64(outcomeDeadlineMs)))
        self.selectedKind = kind
        self.phase = .testing
        self.statuses[kind] = .testing
        do {
            let data = try await GatewayConnection.shared.request(
                method: "crestodian.setup.activate",
                params: ["kind": AnyCodable(kind)],
                timeoutMs: requestTimeoutMs,
                retryTransportFailures: false)
            guard token == self.attemptToken else { return }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok {
                self.finishConnected(kind: kind, result: result)
            } else {
                self.statuses[kind] = .failed(Self.failure(
                    label: self.candidates.first { $0.kind == kind }?.label ?? kind,
                    status: result.status,
                    error: result.error))
                await self.tryNextAfterFailure(of: kind)
            }
        } catch {
            guard token == self.attemptToken else { return }
            // Activation can persist config before a response is decoded, and Codex plugin
            // setup can outlive a dropped socket. Re-read state with an error-specific budget.
            switch Self.activationReconciliationMode(after: error) {
            case .none:
                break
            case .immediate:
                if await self.reconcilePersistedActivation(kind: kind, token: token) {
                    return
                }
            case .polling:
                if await self.reconcileActivationAfterTransportDrop(
                    kind: kind,
                    token: token,
                    deadline: reconciliationDeadline)
                {
                    return
                }
            }
            guard token == self.attemptToken else { return }
            self.statuses[kind] = .failed(Self.transportFailure(error.localizedDescription))
            // Do not start another provider after an RPC or protocol failure: setup may
            // already have applied, or a late Codex completion could race the next attempt.
            self.phase = .ready
        }
    }

    /// After a transport drop during activate, poll `crestodian.setup.detect`
    /// (the gateway restart takes a few seconds) and count the attempt as
    /// connected only when the server persisted exactly the model this
    /// candidate would have written. Returns true when reconciled.
    private func reconcileActivationAfterTransportDrop(
        kind: String,
        token: UUID,
        deadline: ContinuousClock.Instant) async -> Bool
    {
        let clock = ContinuousClock()
        var delayMs: UInt64 = 2000
        while clock.now < deadline {
            do {
                try await Task.sleep(nanoseconds: delayMs * 1_000_000)
            } catch {
                return false
            }
            guard token == self.attemptToken else { return false }
            delayMs = min(delayMs * 2, 15000)
            if await self.reconcilePersistedActivation(kind: kind, token: token) {
                return true
            }
            // A healthy detect can race the still-running activation whose socket dropped;
            // keep polling instead of falling through to another provider.
        }
        return false
    }

    private func reconcilePersistedActivation(kind: String, token: UUID) async -> Bool {
        guard let expected = self.candidates.first(where: { $0.kind == kind })?.modelRef,
              let data = try? await GatewayConnection.shared.request(
                  method: "crestodian.setup.detect",
                  params: [:],
                  timeoutMs: 10000,
                  retryTransportFailures: true),
              token == self.attemptToken,
              let result = try? JSONDecoder().decode(DetectResult.self, from: data),
              Self.activationIsPersisted(
                  expectedModel: expected,
                  setupComplete: result.setupComplete,
                  configuredModel: result.configuredModel)
        else {
            return false
        }
        self.finishConnected(
            kind: kind,
            result: ActivateResult(ok: true, modelRef: expected, latencyMs: nil, status: nil, error: nil))
        return true
    }

    func submitManualKey() {
        let key = self.manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = self.selectedManualProvider, !key.isEmpty, !self.manualTesting else { return }
        self.manualError = nil
        self.manualTesting = true
        let token = self.attemptToken
        Task {
            defer {
                if token == self.attemptToken {
                    self.manualTesting = false
                }
            }
            do {
                let data = try await GatewayConnection.shared.request(
                    method: "crestodian.setup.activate",
                    params: [
                        "kind": AnyCodable("api-key"),
                        "authChoice": AnyCodable(provider.id),
                        "apiKey": AnyCodable(key),
                    ],
                    timeoutMs: 150_000,
                    retryTransportFailures: false)
                guard token == self.attemptToken else { return }
                let result = try JSONDecoder().decode(ActivateResult.self, from: data)
                if result.ok {
                    self.manualKey = ""
                    self.finishConnected(kind: "api-key", result: result)
                } else {
                    self.manualError = Self.failure(
                        label: provider.label,
                        status: result.status,
                        error: result.error)
                }
            } catch {
                guard token == self.attemptToken else { return }
                self.manualError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    private func finishConnected(kind: String, result: ActivateResult) {
        self.statuses[kind] = .connected
        self.selectedKind = kind
        self.connectedModelRef = result.modelRef
        self.connectedLatencyMs = result.latencyMs.map { Int($0.rounded()) }
        self.phase = .connected
        self.onConnected?()
    }

    private func tryNextAfterFailure(of kind: String) async {
        if let next = self.autoCandidateAfter(kind: kind) {
            await self.activate(kind: next.kind)
            return
        }
        self.phase = .ready
        self.exhaustedAutoCandidates = true
        self.showManualEntry = true
    }

    /// Keep the exact Gateway-sanitized error available behind the friendly
    /// summary so users can copy it into support or diagnostics.
    static func failure(label: String, status: String?, error: String?) -> Failure {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: self.friendlyFailure(label: label, status: status, error: detail),
            detail: detail?.isEmpty == false ? detail : nil)
    }

    static func transportFailure(_ raw: String) -> Failure {
        let detail = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: self.friendlyTransportError(detail),
            detail: detail.isEmpty ? nil : detail)
    }

    /// One friendly sentence per failure bucket.
    static func friendlyFailure(label: String, status: String?, error: String?) -> String {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch status {
        case "auth":
            return "\(label) is installed, but the login didn’t work. Sign in again, then retry."
        case "billing":
            return "\(label) responded, but the account has a billing problem."
        case "rate_limit":
            return "\(label) is temporarily rate-limited. Try again in a moment."
        case "timeout":
            return "\(label) didn’t answer in time."
        case "format", "unavailable":
            return detail.isEmpty ? "\(label) couldn’t complete the test." : detail
        default:
            return detail.isEmpty ? "\(label) couldn’t complete the test." : detail
        }
    }

    var connectedSummary: String {
        guard let modelRef = self.connectedModelRef else { return "Your AI is connected." }
        let label = self.candidates.first { $0.kind == self.selectedKind }?.label ??
            (self.selectedKind == "api-key" ? self.selectedManualProvider?.label : nil)
        let via = label.map { " via \($0)" } ?? ""
        if let latency = self.connectedLatencyMs {
            let seconds = Double(latency) / 1000
            return "\(modelRef)\(via) — replied in \(String(format: "%.1f", seconds))s"
        }
        return "\(modelRef)\(via)"
    }
}

private enum OnboardingAISetupError: LocalizedError {
    case providerCatalogUnavailable

    var errorDescription: String? {
        switch self {
        case .providerCatalogUnavailable:
            "The Gateway is running an older OpenClaw version that doesn’t provide the " +
                "supported provider list. Update OpenClaw on the gateway, then try again."
        }
    }
}

struct OnboardingAISetupView: View {
    @Bindable var model: OnboardingAISetupModel
    var crestodianChat: CrestodianOnboardingChatModel
    @Binding var showCrestodianChat: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch self.model.phase {
            case .idle, .detecting:
                self.detectingView
            default:
                self.resultsView
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: self.$showCrestodianChat) {
            self.crestodianSheet
        }
    }

    private var detectingView: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text("Looking for AI you already use…")
                    .font(.callout.weight(.semibold))
                Text("Checking for Claude Code, Codex, Gemini, and saved API keys.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var resultsView: some View {
        if self.model.connected {
            self.connectedBanner
        }

        if !self.model.candidates.isEmpty {
            VStack(spacing: 8) {
                ForEach(self.model.candidates) { candidate in
                    self.candidateRow(candidate)
                }
            }
        } else if self.model.phase != .connected, self.model.detectError == nil {
            // A failed detect must not claim "nothing found" — the error card
            // below owns that state and the claim would be unproven.
            self.noCandidatesIntro
        }

        if let detectError = self.model.detectError {
            OnboardingErrorCard(
                title: "Couldn’t check this Mac for AI accounts",
                message: detectError.summary,
                details: detectError.detail,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                self.model.retryFromScratch()
            }
        }

        if let providerCatalogError = self.model.providerCatalogError {
            OnboardingErrorCard(
                title: "Couldn’t load the full provider list",
                message: providerCatalogError,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                self.model.retryFromScratch()
            }
        }

        if self.model.exhaustedAutoCandidates, !self.model.connected {
            OnboardingErrorCard(
                title: "None of the found options worked",
                message: """
                The details are listed on each option above. \
                You can fix the login and retry, or connect with an API key or token below.
                """,
                docsSlug: "concepts/model-providers",
                retryTitle: "Check again")
            {
                self.model.retryFromScratch()
            }
        }

        if !self.model.connected, self.model.providerCatalogLoaded {
            self.manualSection
        }

        if CrestodianAvailability.shouldShow(configuredModel: self.model.connectedModelRef) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    self.showCrestodianChat = true
                } label: {
                    Label("Need help? Chat with Crestodian", systemImage: "questionmark.bubble")
                        .font(.caption)
                }
                .buttonStyle(.link)
            }
        }
    }

    private var connectedBanner: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("Your AI is ready")
                    .font(.headline)
                Text(self.model.connectedSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.green.opacity(0.12)))
    }

    private var noCandidatesIntro: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No AI accounts found on this Mac")
                .font(.headline)
            Text(
                "That’s fine — you can connect one with an API key or token. " +
                    "If you use Claude Code, Codex, or the Gemini CLI on this Mac, " +
                    "sign in there first and hit “Check again”.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Check again") {
                self.model.retryFromScratch()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private func candidateRow(_ candidate: OnboardingAISetupModel.Candidate) -> some View {
        let status = self.model.statuses[candidate.kind] ?? .untried
        let selected = self.model.selectedKind == candidate.kind
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                self.model.userSelect(kind: candidate.kind)
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: Self.symbol(for: candidate.kind))
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(candidate.label)
                                .font(.callout.weight(.semibold))
                            if candidate.recommended, status != .connected {
                                Text("Recommended")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.accentColor.opacity(0.16)))
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        Text(self.subtitle(for: candidate, status: status))
                            .font(.caption)
                            .foregroundStyle(self.subtitleStyle(for: status))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    self.trailingIndicator(status: status, selected: selected)
                }
            }
            .buttonStyle(.plain)
            .disabled(self.model.isBusy || self.model.connected)

            if case let .failed(failure) = status {
                OnboardingErrorDetails(text: failure.copyText)
                    .padding(.leading, 38)
                    .padding(.top, 6)
            }
        }
        .openClawSelectableRowChrome(selected: selected && !Self.isFailed(status))
    }

    private func subtitle(
        for candidate: OnboardingAISetupModel.Candidate,
        status: OnboardingAISetupModel.CandidateStatus) -> String
    {
        switch status {
        case .testing:
            "Testing — asking \(candidate.modelRef) for a quick reply…"
        case let .failed(failure):
            failure.summary
        case .connected:
            self.model.connectedSummary
        case .untried:
            "\(candidate.modelRef) · \(candidate.detail)"
        }
    }

    private func subtitleStyle(
        for status: OnboardingAISetupModel.CandidateStatus) -> Color
    {
        if case .failed = status {
            return .orange
        }
        return .secondary
    }

    @ViewBuilder
    private func trailingIndicator(
        status: OnboardingAISetupModel.CandidateStatus,
        selected: Bool) -> some View
    {
        switch status {
        case .testing:
            ProgressView()
                .controlSize(.small)
        case .connected:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        case .untried:
            SelectionStateIndicator(selected: selected)
        }
    }

    private static func symbol(for kind: String) -> String {
        switch kind {
        case "claude-cli": "sparkle"
        case "codex-cli": "chevron.left.forwardslash.chevron.right"
        case "gemini-cli": "diamond"
        case "existing-model": "checkmark.seal"
        default: "key.fill"
        }
    }

    private static func isFailed(_ status: OnboardingAISetupModel.CandidateStatus) -> Bool {
        if case .failed = status {
            return true
        }
        return false
    }

    private var manualSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.model.manualProviders.isEmpty {
                OnboardingErrorCard(
                    title: "No key-based providers are available",
                    message: "Enable or install a text-inference provider plugin on this Gateway, then check again.",
                    docsSlug: "concepts/model-providers",
                    retryTitle: "Check again")
                {
                    self.model.retryFromScratch()
                }
            } else if self.model.candidates.isEmpty || self.model.showManualEntry {
                self.manualForm
            } else {
                Button {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                        self.model.showManualEntry = true
                    }
                } label: {
                    Label("Connect with an API key or token instead…", systemImage: "key")
                        .font(.callout)
                }
                .buttonStyle(.link)
                .disabled(self.model.isBusy)
            }
        }
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect with an API key or token")
                .font(.headline)
            HStack(spacing: 8) {
                Picker("Provider", selection: self.$model.manualProviderID) {
                    ForEach(self.model.manualProviders) { provider in
                        Text(provider.label).tag(provider.id)
                    }
                }
                .labelsHidden()
                .frame(width: 230)

                SecureField("API key or token", text: self.$model.manualKey)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { self.model.submitManualKey() }

                Button {
                    self.model.submitManualKey()
                } label: {
                    if self.model.manualTesting {
                        ProgressView()
                            .controlSize(.small)
                            .frame(minWidth: 74)
                    } else {
                        Text("Connect")
                            .frame(minWidth: 74)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.model.manualTesting ||
                    self.model.manualKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Text(self.manualProviderHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let manualError = self.model.manualError {
                OnboardingErrorCard(
                    title: "That key didn’t work",
                    message: manualError.summary,
                    details: manualError.detail,
                    docsSlug: "concepts/model-providers",
                    retryTitle: nil,
                    retry: nil)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor)))
    }

    private var manualProviderHelp: String {
        let hint = self.model.selectedManualProvider?.hint?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hint, !hint.isEmpty else {
            return "Paste the key or token here, and OpenClaw checks it with a real test question."
        }
        return "\(hint). Paste it here, and OpenClaw checks it with a real test question."
    }

    private var crestodianSheet: some View {
        VStack(spacing: 8) {
            HStack {
                Label("Crestodian — setup helper", systemImage: "lifepreserver")
                    .font(.headline)
                Spacer(minLength: 0)
                Button("Done") {
                    self.showCrestodianChat = false
                }
            }
            .padding([.top, .horizontal], 14)
            CrestodianOnboardingChatView(model: self.crestodianChat)
                .task { await self.crestodianChat.startIfNeeded() }
        }
        .frame(width: 520, height: 480)
    }
}

/// Friendly error presentation with a consistent docs escape hatch.
/// Every onboarding failure points at a docs.openclaw.ai page so people are
/// never stuck staring at a raw error string.
struct OnboardingErrorCard: View {
    let title: String
    let message: String
    var details: String?
    let docsSlug: String
    var retryTitle: String?
    var retry: (() -> Void)?

    init(
        title: String,
        message: String,
        details: String? = nil,
        docsSlug: String,
        retryTitle: String? = nil,
        retry: (() -> Void)? = nil)
    {
        self.title = title
        self.message = message
        self.details = details
        self.docsSlug = docsSlug
        self.retryTitle = retryTitle
        self.retry = retry
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.callout.weight(.semibold))
                Text(self.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let details = self.details {
                    OnboardingErrorDetails(text: details)
                }
                HStack(spacing: 14) {
                    if let retryTitle = self.retryTitle, let retry = self.retry {
                        Button(retryTitle, action: retry)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    Button("Open help…") {
                        if let url = URL(string: "https://docs.openclaw.ai/\(self.docsSlug)") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    if self.details == nil {
                        Button("Copy error") {
                            OnboardingErrorDetails.copy(self.message)
                        }
                        .buttonStyle(.link)
                        .font(.caption)
                    }
                }
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.orange.opacity(0.10)))
    }
}

private struct OnboardingErrorDetails: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    self.expanded.toggle()
                }
            } label: {
                Label(
                    self.expanded ? "Hide details" : "Show details",
                    systemImage: self.expanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.link)
            .font(.caption)

            if self.expanded {
                Text(self.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.primary.opacity(0.05)))
                Button {
                    Self.copy(self.text)
                } label: {
                    Label("Copy error", systemImage: "doc.on.doc")
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
