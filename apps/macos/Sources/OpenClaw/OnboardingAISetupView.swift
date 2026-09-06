import AppKit
import Foundation
import SwiftUI

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

    static func displayHost(_ rawValue: String?) -> String? {
        guard let host = safeURL(rawValue)?.host()?.lowercased() else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

private struct OnboardingRecommendedInstallCard: View {
    let install: OnboardingAISetupModel.RecommendedInstall
    @State private var hovered = false

    var body: some View {
        Group {
            if let website = OnboardingProviderAuthLink.safeURL(self.install.website) {
                Link(destination: website) { self.content }
                    .buttonStyle(.plain)
            } else {
                self.content
            }
        }
        .onHover { self.hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: self.hovered)
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 10) {
            OnboardingProviderArtwork(
                icon: self.install.icon,
                brandCandidates: [self.install.brandId, self.install.id],
                fallbackSymbol: "arrow.down.circle")
            VStack(alignment: .leading, spacing: 2) {
                Text(self.install.label)
                    .font(.callout.weight(.semibold))
                Text(self.install.hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let host = OnboardingProviderAuthLink.displayHost(self.install.website) {
                    Text(host)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(self.hovered ? 0.085 : 0.05)))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
    }
}

struct OnboardingSurface: View {
    let cornerRadius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
            .fill(Color.primary.opacity(0.045))
            .overlay {
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            }
    }
}

struct GatewayAuthCard: Equatable {
    let title: String
    let message: String
    let primaryTitle: String
    let secondaryTitle: String
}

struct OnboardingAISetupView: View {
    @Bindable var model: OnboardingAISetupModel
    var returnToGatewayAuthentication: () -> Void
    var retryConfiguredGatewayProbe: (OnboardingAISetupModel.SetupIntent) -> Void
    @State private var manualEntryRequest = 0

    static func gatewayAuthCard(for issue: RemoteGatewayAuthIssue) -> GatewayAuthCard {
        GatewayAuthCard(
            title: "Gateway authentication required",
            message: issue.statusMessage,
            primaryTitle: "Back to Gateway",
            secondaryTitle: "Try again")
    }

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                self.content
                    .padding(.vertical, 4)
                    .padding(.trailing, 12)
            }
            .scrollIndicators(.automatic)
            .onChange(of: self.manualEntryRequest) {
                withAnimation { scroll.scrollTo("manual-entry", anchor: .top) }
            }
            .onChange(of: self.model.manualError) { _, error in
                if error != nil {
                    withAnimation { scroll.scrollTo("manual-entry", anchor: .bottom) }
                }
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch self.model.phase {
            case .idle, .detecting:
                self.detectingView
            case .ready, .testing:
                self.resultsView
            case .connected:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: Binding(
            get: { self.model.activeAuthOption != nil },
            set: {
                if !$0 {
                    self.model.cancelProviderAuth()
                }
            })) {
                OnboardingAISetupSheet(model: self.model)
        }
    }

    private var detectingView: some View {
        VStack(alignment: .leading, spacing: 12) {
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

            if self.model.waitingForPendingActivationDeadline {
                if let failure = self.model.detectError {
                    OnboardingErrorCard(
                        title: "AI setup needs verification",
                        message: failure.summary,
                        details: failure.detail,
                        docsSlug: "start/onboarding",
                        retryTitle: "Check again",
                        retry: { self.retryConfiguredGatewayProbe(.inspectOnly) })
                } else {
                    Button("Check again") { self.retryConfiguredGatewayProbe(.inspectOnly) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder
    private var resultsView: some View {
        if !self.model.candidates.isEmpty {
            VStack(spacing: 8) {
                ForEach(self.model.candidates) { candidate in
                    self.candidateRow(candidate)
                }
            }
        } else if self.model.detectError == nil,
                  self.model.configuredGatewayAuthIssue == nil
        {
            // A failed detect must not claim "nothing found" — the error card
            // below owns that state and the claim would be unproven.
            self.noCandidatesIntro
        }

        if !self.model.unavailableCandidates.isEmpty {
            self.unavailableCandidatesSection
        }

        if let authIssue = model.configuredGatewayAuthIssue {
            let card = Self.gatewayAuthCard(for: authIssue)
            OnboardingErrorCard(
                title: card.title,
                message: card.message,
                docsSlug: "start/onboarding",
                retryTitle: card.primaryTitle,
                secondaryTitle: card.secondaryTitle,
                secondary: { self.retryConfiguredGatewayProbe(.startSetup) },
                retry: self.returnToGatewayAuthentication)
        } else if let detectError = model.detectError {
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
                    self.retryConfiguredGatewayProbe(.startSetup)
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

        if self.model.providerCatalogLoaded {
            self.providerPrepareSection
            self.providerAuthSection
            self.manualSection
        }
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
                    columns: [GridItem(.adaptive(minimum: 230), spacing: 10)],
                    spacing: 10)
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
                        Text(verbatim: "\(candidate.label) — \(candidate.detail)")
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
                        brandCandidates: [presentation?.brandId, candidate.kind],
                        fallbackSymbol: Self.symbol(for: candidate.kind))
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
                // Plain buttons hit-test only opaque label pixels; without this the
                // row's blank stretch (between texts, over the Spacer) ignores clicks
                // and a mid-testing candidate pick silently does nothing.
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!self.model.canSelectCandidate(kind: candidate.kind))

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
    private var providerPrepareSection: some View {
        if !self.model.prepareOptions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Set up a local model")
                    .font(.headline)
                Text("Connect a local model service, or prepare a model on this Gateway.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(self.model.prepareOptions) { option in
                    Button {
                        self.model.startProviderPrepare(option)
                    } label: {
                        HStack(spacing: 10) {
                            OnboardingProviderArtwork(
                                icon: option.icon,
                                brandCandidates: [option.brandId, option.id],
                                fallbackSymbol: "arrow.down.circle")
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
                            Text(option.actionLabel ?? String(localized: "Connect / Set up"))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                        .openClawSelectableRowChrome(selected: false)
                    }
                    .buttonStyle(.plain)
                    .disabled(self.model.isBusy)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(OnboardingSurface(cornerRadius: 12))
        }
    }

    @ViewBuilder
    private var providerAuthSection: some View {
        if !self.model.authOptions.isEmpty || !self.model.manualProviders.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if self.model.nativeSessionCatalogPreferenceRequired,
                   !self.model.nativeSessionCatalogs.isEmpty
                {
                    Toggle(isOn: self.$model.nativeSessionCatalogsEnabled) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Show existing native conversations")
                                .font(.callout.weight(.semibold))
                            Text(String(
                                format: String(localized: """
                                Include existing %@ conversations in the sidebar. \
                                This discovers them in place; it does not copy transcripts.
                                """),
                                self.model.nativeSessionCatalogSummary))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.checkbox)
                    .padding(.bottom, 6)
                }
                Text("Connect an AI provider")
                    .font(.headline)
                // Localization: the sign-in/API-key flow belongs to the selected provider, not OpenClaw.
                Text(
                    "Choose any supported provider. OpenClaw asks before installing a provider plugin, " +
                        "then continues into its own sign-in or API-key flow and verifies a real reply.")
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
            .background(OnboardingSurface(cornerRadius: 12))
        }
    }

    private var apiKeysRow: some View {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                self.model.showManualEntry = true
                // The form can already exist below the viewport; every tap must reveal it.
                self.manualEntryRequest += 1
            }
        } label: {
            HStack(spacing: 10) {
                OnboardingProviderArtwork(
                    icon: nil,
                    brandCandidates: [],
                    fallbackSymbol: "key.fill")
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
            .openClawSelectableRowChrome(selected: self.model.showManualEntry)
        }
        .buttonStyle(.plain)
        .disabled(self.model.isBusy)
    }

    private func providerAuthRow(_ option: OnboardingAISetupModel.AuthOption) -> some View {
        let fallbackSymbol = switch option.kind {
        case "device-code": "link.badge.plus"
        case "install": "puzzlepiece.extension"
        case "custom": "point.3.connected.trianglepath.dotted"
        default: "person.crop.circle.badge.checkmark"
        }
        let actionLabel: LocalizedStringKey = switch option.kind {
        case "device-code": "Pair"
        case "install": "Set up…"
        case "custom": "Configure…"
        default: "Sign in"
        }
        return Button {
            self.model.startProviderAuth(option)
        } label: {
            HStack(spacing: 10) {
                OnboardingProviderArtwork(
                    icon: option.icon,
                    brandCandidates: [option.brandId, option.id],
                    fallbackSymbol: fallbackSymbol)
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
                Text(actionLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
            .openClawSelectableRowChrome(selected: false)
        }
        .buttonStyle(.plain)
        .disabled(self.model.isBusy)
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect with an API key or token")
                .font(.headline)
            HStack(spacing: 8) {
                if let provider = self.model.selectedManualProvider {
                    OnboardingProviderArtwork(
                        icon: provider.icon,
                        brandCandidates: [provider.brandId, provider.id],
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
                // isBusy, not just manualTesting: submitManualKey drops the tap
                // while another test runs, so an enabled button would be a
                // silent no-op.
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
        .background(OnboardingSurface(cornerRadius: 12))
        .id("manual-entry")
    }

    private var manualProviderHelp: String {
        let hint = self.model.selectedManualProvider?.hint?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hint, !hint.isEmpty else {
            return "Paste the key or token here, and OpenClaw checks it with a real test question."
        }
        return "\(hint). Paste it here, and OpenClaw checks it with a real test question."
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
    var secondaryTitle: String?
    var secondary: (() -> Void)?

    /// Keep retry required so Swift binds a lone trailing closure to the primary
    /// action instead of the defaulted secondary action.
    init(
        title: String,
        message: String,
        details: String? = nil,
        docsSlug: String,
        retryTitle: String? = nil,
        secondaryTitle: String? = nil,
        secondary: (() -> Void)? = nil,
        retry: (() -> Void)?)
    {
        self.title = title
        self.message = message
        self.details = details
        self.docsSlug = docsSlug
        self.retryTitle = retryTitle
        self.retry = retry
        self.secondaryTitle = secondaryTitle
        self.secondary = secondary
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
                    if let secondaryTitle, let secondary {
                        Button(secondaryTitle, action: secondary)
                            .buttonStyle(.bordered)
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
