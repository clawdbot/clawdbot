import AppKit
import Foundation
import SwiftUI

enum OnboardingProviderIcon {
    private static let resourceBundle: Bundle? = locateResourceBundle()

    static func resourceURL(for kind: String) -> URL? {
        guard let name = resourceName(for: kind) else { return nil }
        return self.resourceBundle?.url(
            forResource: name,
            withExtension: "svg",
            subdirectory: "ProviderIcons")
    }

    static func image(for kind: String) -> NSImage? {
        guard let url = resourceURL(for: kind), let image = NSImage(contentsOf: url) else {
            return nil
        }
        image.isTemplate = true
        return image
    }

    private static func resourceName(for kind: String) -> String? {
        switch kind {
        case "claude-cli": "ProviderIcon-claude"
        case "codex-cli": "ProviderIcon-codex"
        default: nil
        }
    }

    private static func locateResourceBundle() -> Bundle? {
        if self.bundleContainsProviderIcons(Bundle.main) {
            return Bundle.main
        }
        // Packaged apps copy these vectors into Bundle.main. SwiftPM's generated
        // Bundle.module accessor can fatalError when that sidecar is absent, so
        // consult it only for development/test executables, never an .app.
        if Bundle.main.bundleURL.pathExtension != "app",
           self.bundleContainsProviderIcons(Bundle.module)
        {
            return Bundle.module
        }
        return nil
    }

    private static func bundleContainsProviderIcons(_ bundle: Bundle) -> Bool {
        bundle.url(
            forResource: "ProviderIcon-claude",
            withExtension: "svg",
            subdirectory: "ProviderIcons") != nil
    }
}

struct OnboardingAISetupView: View {
    @Bindable var model: OnboardingAISetupModel
    var crestodianChat: CrestodianOnboardingChatModel
    @Binding var showCrestodianChat: Bool
    var retryConfiguredGatewayProbe: () -> Void

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
                Text(self.model.waitingForPendingActivationDeadline
                    ? "Waiting for the previous AI test to finish…"
                    : "Looking for AI you already use…")
                    .font(.callout.weight(.semibold))
                Text(self.model.waitingForPendingActivationDeadline
                    ? "OpenClaw will check again before changing any inference settings."
                    : "Checking for Claude Code, Codex, Gemini, and saved API keys.")
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

        if let detectError = model.detectError {
            OnboardingErrorCard(
                title: self.model.configuredGatewayProbeUnavailable
                    ? "Couldn’t check this Gateway for AI accounts"
                    : "Couldn’t check this Mac for AI accounts",
                message: detectError.summary,
                details: detectError.detail,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                if self.model.configuredGatewayProbeUnavailable {
                    self.retryConfiguredGatewayProbe()
                } else {
                    self.model.retryFromScratch()
                }
            }
        }

        if let providerCatalogError = model.providerCatalogError {
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
        VStack(alignment: .leading, spacing: 10) {
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

            if !self.model.connectedSetupLines.isEmpty {
                Divider()
                Text("Setup details")
                    .font(.caption.weight(.semibold))
                ScrollView(.vertical) {
                    Text(self.model.connectedSetupCopyText)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 150)
                Button {
                    OnboardingErrorDetails.copy(self.model.connectedSetupCopyText)
                } label: {
                    Label("Copy setup details", systemImage: "doc.on.doc")
                }
                .buttonStyle(.link)
                .font(.caption)
            }
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
                    self.providerIcon(for: candidate.kind)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.label)
                            .font(.callout.weight(.semibold))
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

    @ViewBuilder
    private func providerIcon(for kind: String) -> some View {
        if let image = OnboardingProviderIcon.image(for: kind) {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 21, height: 21)
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
        } else {
            Image(systemName: Self.symbol(for: kind))
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
        }
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
                .disabled(self.model.isBusy ||
                    self.model.manualKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Text(self.manualProviderHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let manualError = model.manualError {
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
                if let details {
                    OnboardingErrorDetails(text: details)
                }
                HStack(spacing: 14) {
                    if let retryTitle, let retry {
                        Button(retryTitle, action: retry)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    Button("Open help…") {
                        if let url = URL(string: "https://docs.openclaw.ai/\(docsSlug)") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    if details == nil {
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
                ScrollView(.vertical) {
                    Text(self.text)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
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
