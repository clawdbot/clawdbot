import AppKit
import Foundation
import OpenClawChatUI
import OpenClawProtocol
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

enum OnboardingProviderAuthLink {
    static func safeURL(_ rawValue: String?) -> URL? {
        guard let rawValue,
              let url = URL(string: rawValue),
              url.scheme?.lowercased() == "https",
              url.host() != nil,
              url.user() == nil,
              url.password() == nil
        else { return nil }
        return url
    }
}

private struct OnboardingProviderArtwork: View {
    let icon: String?
    let fallbackKind: String
    let fallbackSymbol: String

    var body: some View {
        Group {
            if let url = OnboardingProviderAuthLink.safeURL(self.icon) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFit()
                    default:
                        self.fallback
                    }
                }
            } else {
                self.fallback
            }
        }
        .frame(width: 24, height: 24)
    }

    @ViewBuilder
    private var fallback: some View {
        if let image = OnboardingProviderIcon.image(for: self.fallbackKind) {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(Color.accentColor)
        } else {
            Image(systemName: self.fallbackSymbol)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
        }
    }
}

private struct OnboardingRecommendedInstallCard: View {
    let install: OnboardingAISetupModel.RecommendedInstall

    var body: some View {
        if let website = OnboardingProviderAuthLink.safeURL(self.install.website) {
            Link(destination: website) { self.content }
                .buttonStyle(.plain)
        } else {
            self.content
        }
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 10) {
            OnboardingProviderArtwork(
                icon: self.install.icon,
                fallbackKind: self.install.id == "claude-code" ? "claude-cli" : self.install.id,
                fallbackSymbol: "arrow.down.circle")
            VStack(alignment: .leading, spacing: 2) {
                Text(self.install.label)
                    .font(.callout.weight(.semibold))
                Text(self.install.hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(self.install.website)
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right.square")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor)))
    }
}

struct OnboardingAISetupView: View {
    @Bindable var model: OnboardingAISetupModel
    var systemAgentChat: SystemAgentOnboardingChatModel
    @Binding var showSystemAgentChat: Bool
    var retryConfiguredGatewayProbe: () -> Void
    @State private var openedProviderAuthURL: URL?

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
        .sheet(isPresented: self.$showSystemAgentChat) {
            self.systemAgentSheet
        }
        .sheet(isPresented: Binding(
            get: { self.model.activeAuthOption != nil },
            set: {
                if !$0 {
                    self.model.cancelProviderAuth()
                }
            })) {
                self.providerAuthSheet
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
                    : "Checking CLI logins, saved API keys, and local model servers on the Gateway.")
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

        if !self.model.unavailableCandidates.isEmpty {
            self.unavailableCandidatesSection
        }

        if let detectError = model.detectError {
            OnboardingErrorCard(
                title: self.model.configuredGatewayProbeUnavailable
                    ? "Couldn’t check this Gateway for AI accounts"
                    : "Couldn’t check this Gateway for AI access",
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
            self.providerAuthSection
            self.manualSection
        }

        if SystemAgentAvailability.shouldShow(configuredModel: self.model.connectedModelRef) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    self.showSystemAgentChat = true
                } label: {
                    Label("Need help? Chat with OpenClaw", systemImage: "questionmark.bubble")
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
        VStack(alignment: .leading, spacing: 8) {
            Text("No usable AI access found on this Gateway")
                .font(.headline)
            Text(self.model.recommendedInstalls.isEmpty
                ? "Connect a provider below with an API key or token, then check again."
                : "Install one of these tools, then check again. You can also connect a provider below.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !self.model.recommendedInstalls.isEmpty {
                Text("Recommended installs")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 220), spacing: 8)],
                    spacing: 8)
                {
                    ForEach(self.model.recommendedInstalls) { install in
                        OnboardingRecommendedInstallCard(install: install)
                    }
                }
            }
            Button("Check again") {
                self.model.retryFromScratch()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private var unavailableCandidatesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Detected, but not auto-tested")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(self.model.unavailableCandidates) { candidate in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(candidate.label) — \(candidate.detail)")
                            .font(.caption.weight(.semibold))
                        Text(candidate.reason)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func candidateRow(_ candidate: OnboardingAISetupModel.Candidate) -> some View {
        let status = self.model.statuses[candidate.kind] ?? .untried
        let selected = self.model.selectedKind == candidate.kind
        let presentation = self.model.candidatePresentation[candidate.kind]
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                self.model.userSelect(kind: candidate.kind)
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    OnboardingProviderArtwork(
                        icon: presentation?.icon,
                        fallbackKind: candidate.kind,
                        fallbackSymbol: Self.symbol(for: candidate.kind))
                        .frame(width: 26)
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

    @ViewBuilder
    private var manualSection: some View {
        if self.model.manualProviders.isEmpty {
            if self.model.authOptions.isEmpty {
                OnboardingErrorCard(
                    title: "No key-based providers are available",
                    message: "Enable or install a text-inference provider plugin on this Gateway, then check again.",
                    docsSlug: "concepts/model-providers",
                    retryTitle: "Check again")
                {
                    self.model.retryFromScratch()
                }
            }
        } else if self.model.candidates.isEmpty || self.model.showManualEntry {
            self.manualForm
        }
    }

    @ViewBuilder
    private var providerAuthSection: some View {
        if !self.model.authOptions.isEmpty || !self.model.manualProviders.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Sign in with a provider")
                    .font(.headline)
                Text(
                    "Use an existing subscription or provider account. " +
                        "OpenClaw opens the provider’s own sign-in flow, then verifies it with a real reply.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                let featured = self.model.authOptions.filter(\.featured)
                let more = self.model.authOptions.filter { !$0.featured }
                ForEach(featured) { option in
                    self.providerAuthRow(option)
                }
                if !self.model.manualProviders.isEmpty {
                    self.apiKeysRow
                }
                if !more.isEmpty {
                    DisclosureGroup("More sign-in options") {
                        VStack(spacing: 8) {
                            ForEach(more) { option in
                                self.providerAuthRow(option)
                            }
                        }
                        .padding(.top, 6)
                    }
                    .font(.callout)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(NSColor.controlBackgroundColor)))
        }
    }

    private var apiKeysRow: some View {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                self.model.showManualEntry = true
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "key.fill")
                    .font(.title3)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text("API Keys")
                        .font(.callout.weight(.semibold))
                    Text("Connect with an API key or token")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Text("Connect")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .buttonStyle(.plain)
        .disabled(self.model.isBusy)
        .openClawSelectableRowChrome(selected: self.model.showManualEntry)
    }

    private func providerAuthRow(_ option: OnboardingAISetupModel.AuthOption) -> some View {
        Button {
            self.openedProviderAuthURL = nil
            self.model.startProviderAuth(option)
        } label: {
            HStack(spacing: 10) {
                OnboardingProviderArtwork(
                    icon: option.icon,
                    fallbackKind: option.id,
                    fallbackSymbol: option.kind == "device-code"
                        ? "link.badge.plus"
                        : "person.crop.circle.badge.checkmark")
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.callout.weight(.semibold))
                    if let hint = option.hint, !hint.isEmpty {
                        Text(hint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                Text(option.kind == "device-code" ? "Pair" : "Sign in")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .buttonStyle(.plain)
        .disabled(self.model.isBusy)
        .openClawSelectableRowChrome(selected: false)
    }

    private var providerAuthSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.model.activeAuthOption?.label ?? "Provider sign-in")
                        .font(.title3.weight(.semibold))
                    Text("Credentials stay on this Gateway and are saved only after the live test succeeds.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

            if let step = self.model.authStep {
                let deviceCode = parseWizardDeviceCode(step.devicecode)
                if deviceCode == nil,
                   let title = step.title,
                   !title.isEmpty,
                   title != self.model.activeAuthOption?.label
                {
                    Text(title).font(.headline)
                }
                if let deviceCode {
                    self.deviceCodeStep(deviceCode)
                } else if let message = step.message, !message.isEmpty {
                    ScrollView {
                        Text(message)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 190)
                }
                if deviceCode == nil,
                   let url = OnboardingProviderAuthLink.safeURL(step.externalurl)
                {
                    Link("Open sign-in page…", destination: url)
                        .font(.caption.weight(.semibold))
                }
                self.authStepInput(step)
            } else if self.model.authBusy {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Starting secure sign-in…")
                }
            }

            if let error = self.model.authError {
                OnboardingErrorCard(
                    title: "Sign-in didn’t complete",
                    message: error.summary,
                    details: error.detail,
                    docsSlug: "concepts/model-providers",
                    retryTitle: nil,
                    retry: nil)
            }

            Spacer(minLength: 0)
            HStack {
                Button("Cancel") { self.model.cancelProviderAuth() }
                Spacer(minLength: 0)
                if self.model.authStep != nil {
                    Button(self.authContinueTitle) { self.model.continueProviderAuth() }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.model.authBusy)
                }
            }
        }
        .padding(22)
        .frame(width: 560)
        .frame(minHeight: 330)
        .onAppear {
            self.openProviderAuthURLIfNeeded(self.model.authStep?.externalurl)
        }
        .onChange(of: self.model.authStep?.externalurl) { _, rawURL in
            self.openProviderAuthURLIfNeeded(rawURL)
        }
    }

    private func deviceCodeStep(_ deviceCode: WizardDeviceCodePresentation) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Finish in your browser")
                    .font(.headline)
                Text(deviceCode.message ?? "Enter this one-time code on the provider's sign-in page.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Text(deviceCode.code)
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(deviceCode.code, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(NSColor.controlBackgroundColor)))

            HStack(spacing: 12) {
                if let minutes = deviceCode.expiresInMinutes {
                    Label("Expires in \(minutes) minutes", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let url = OnboardingProviderAuthLink.safeURL(self.model.authStep?.externalurl) {
                    Link(destination: url) {
                        Label("Open sign-in page", systemImage: "arrow.up.right.square")
                    }
                    .font(.caption.weight(.semibold))
                }
            }
        }
    }

    private func openProviderAuthURLIfNeeded(_ rawURL: String?) {
        guard let url = OnboardingProviderAuthLink.safeURL(rawURL),
              url != openedProviderAuthURL
        else { return }
        self.openedProviderAuthURL = url
        NSWorkspace.shared.open(url)
    }

    @ViewBuilder
    private func authStepInput(_ step: WizardStep) -> some View {
        switch wizardStepType(step) {
        case "text":
            if step.sensitive == true {
                SecureField(step.placeholder ?? "Value", text: self.$model.authText)
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField(step.placeholder ?? "Value", text: self.$model.authText)
                    .textFieldStyle(.roundedBorder)
            }
        case "select":
            Picker("Option", selection: self.$model.authSelection) {
                ForEach(Array(self.model.authWizardOptions.enumerated()), id: \.offset) { index, option in
                    Text(option.label).tag(index)
                }
            }
        case "confirm":
            Toggle("Confirm", isOn: self.$model.authConfirmation)
        default:
            EmptyView()
        }
    }

    private var authContinueTitle: String {
        guard let step = model.authStep else { return "Continue" }
        if parseWizardDeviceCode(step.devicecode) != nil {
            return String(localized: "I've signed in")
        }
        return wizardStepType(step) == "note" ? "Continue" : "Submit"
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect with an API key or token")
                .font(.headline)
            HStack(spacing: 8) {
                if let provider = self.model.selectedManualProvider {
                    OnboardingProviderArtwork(
                        icon: provider.icon,
                        fallbackKind: provider.id,
                        fallbackSymbol: "key.fill")
                }
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

    private var systemAgentSheet: some View {
        VStack(spacing: 8) {
            HStack {
                Label("OpenClaw — setup helper", systemImage: "lifepreserver")
                    .font(.headline)
                Spacer(minLength: 0)
                Button("Done") {
                    self.showSystemAgentChat = false
                }
            }
            .padding([.top, .horizontal], 14)
            SystemAgentOnboardingChatView(model: self.systemAgentChat)
                .task { await self.systemAgentChat.startIfNeeded() }
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
