import AppKit
import OpenClawDiscovery
import SwiftUI

extension OnboardingView {
    @ViewBuilder
    func pageView(for pageIndex: Int, contentHeight: CGFloat) -> some View {
        switch pageIndex {
        case 0:
            self.welcomePage()
        case 1:
            self.connectionPage()
        case 2:
            self.cliPage()
        case 3:
            self.aiSetupPage(contentHeight: contentHeight)
        case 9:
            self.readyPage()
        default:
            EmptyView()
        }
    }

    func welcomePage() -> some View {
        onboardingPage {
            VStack(spacing: 18) {
                VStack(spacing: 8) {
                    Text("Welcome to OpenClaw")
                        .font(.largeTitle.weight(.semibold))
                    Text("Your personal AI assistant, living on your own Mac.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                Text(
                    "It answers questions, works with your files and apps, and can chat with you " +
                        "on WhatsApp or Telegram. Setup takes about two minutes.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)
                    .fixedSize(horizontal: false, vertical: true)

                self.onboardingCard(spacing: 14, padding: 16) {
                    self.featureRow(
                        title: "Ask, create, and automate",
                        subtitle: "Give your assistant tasks and let it help across your Mac.",
                        systemImage: "sparkles")
                    self.featureRow(
                        title: "Chat wherever you like",
                        subtitle: "This app, WhatsApp, Telegram, Discord, Slack — your choice.",
                        systemImage: "bubble.left.and.bubble.right.fill")
                    self.featureRow(
                        title: "Stay in control",
                        subtitle: "Everything runs where you decide, with permissions you grant.",
                        systemImage: "hand.raised.fill")
                }
                .frame(maxWidth: 520)

                Label {
                    Text(
                        "OpenClaw can take actions using the permissions and services you enable. " +
                            "Review prompts and only connect tools you trust.")
                } icon: {
                    Image(systemName: "info.circle")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 500, alignment: .leading)
            }
            .padding(.top, 8)
        }
    }

    func connectionPage() -> some View {
        onboardingPage {
            Text("Where should your assistant live?")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Most people pick this Mac — OpenClaw installs everything and keeps it " +
                    "running in the background. You can change this anytime in Settings.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    self.connectionChoiceButton(
                        title: "On this Mac",
                        badge: "Recommended",
                        subtitle: self.localGatewaySubtitle,
                        systemImage: "laptopcomputer",
                        selected: self.selectedConnectionMode == .local)
                    {
                        self.selectLocalGateway()
                    }

                    self.connectionChoiceButton(
                        title: "On another computer",
                        badge: nil,
                        subtitle: self.remoteChoiceSubtitle,
                        systemImage: "network",
                        selected: self.selectedConnectionMode == .remote)
                    {
                        self.handleRemoteSelection()
                    }

                    if self.showRemoteChoices || self.selectedConnectionMode == .remote {
                        self.gatewayDiscoverySection()

                        if self.shouldShowRemoteConnectionSection {
                            self.remoteConnectionSection()
                        } else {
                            self.advancedConnectionSection()
                        }
                    }
                }
            }

            GatewayConfigConflictRecoveryView(state: self.state)

            HStack {
                Spacer(minLength: 0)
                Button("Set up later") {
                    self.selectUnconfiguredGateway()
                }
                .buttonStyle(.link)
                .font(.callout)
                .foregroundStyle(self.selectedConnectionMode == .unconfigured ? Color.accentColor : .secondary)
                .help("Skip Gateway setup for now; pick Local or Remote later in Settings → General.")
                Spacer(minLength: 0)
            }
            if self.selectedConnectionMode == .unconfigured {
                Text("OK — OpenClaw won’t start anything yet. Pick Local or Remote later in Settings → General.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .disabled(self.installingCLI)
        .onChange(of: self.state.connectionMode) { _, newValue in
            // The root view's mode observer calls handleConnectionModeChange(), which
            // retires route-owned AI/OpenClaw state. This nested observer owns probe copy only.
            guard Self.shouldResetRemoteProbeFeedback(
                for: newValue,
                suppressReset: self.suppressRemoteProbeReset)
            else { return }
            self.resetRemoteProbeFeedback()
        }
        .onChange(of: state.remoteTransport) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteTarget) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteUrl) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteToken) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
        .onChange(of: state.remoteIdentity) { _, _ in
            self.retireGatewayStateForRemoteEndpointEdit()
        }
    }

    private var localGatewaySubtitle: String {
        guard let probe = localGatewayProbe else {
            return "Private to this computer. Installs and starts automatically."
        }
        return probe.subtitle
    }

    private var remoteChoiceSubtitle: String {
        Self.remoteChoiceSubtitle(discoveredGatewayCount: gatewayDiscovery.gateways.count)
    }

    static func remoteChoiceSubtitle(discoveredGatewayCount count: Int) -> String {
        if count > 0 {
            return count == 1
                ? String(localized: "1 gateway found on your network — click to choose it.")
                : String(
                    format: String(localized: "%lld gateways found on your network — click to choose one."),
                    count)
        }
        return "For advanced setups — use a gateway that runs elsewhere."
    }

    @ViewBuilder
    private func gatewayDiscoverySection() -> some View {
        // Quiet by design: discovery runs in the background and must not make
        // the page read as "loading" — no spinner, just a status line.
        if gatewayDiscovery.gateways.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Text("No gateways found on your network yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Look again") {
                    self.gatewayDiscovery.refreshRemoteFallbackNow(timeoutSeconds: 5.0)
                }
                .buttonStyle(.link)
                .font(.caption)
                .help("Retry discovery (Bonjour + Tailscale DNS-SD).")
                Spacer(minLength: 0)
            }
            .padding(.leading, 4)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(self.gatewayDiscovery.gateways.prefix(6)) { gateway in
                    self.connectionChoiceButton(
                        title: gateway.displayName,
                        badge: nil,
                        subtitle: self.gatewaySubtitle(for: gateway),
                        systemImage: "desktopcomputer",
                        monospacedSubtitle: true,
                        selected: self.isSelectedGateway(gateway))
                    {
                        self.selectRemoteGateway(gateway)
                    }
                }
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(NSColor.controlBackgroundColor)))
        }
    }

    private func advancedConnectionSection() -> some View {
        // Open-only: this button renders only while the remote panel (and its
        // Hide toggle) is absent, so it never needs to collapse anything.
        Button("Advanced…") {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                self.showAdvancedConnection = true
            }
            if self.state.connectionMode != .remote {
                self.state.connectionMode = .remote
            }
        }
        .buttonStyle(.link)
    }

    private var manualRemoteTransportBinding: Binding<AppState.RemoteTransport> {
        Binding(
            get: { self.state.remoteTransport },
            set: { self.updateManualRemoteTransport($0) })
    }

    private var manualRemoteURLBinding: Binding<String> {
        Binding(
            get: { self.state.remoteUrl },
            set: { self.updateManualRemoteURL($0) })
    }

    private var manualRemoteTargetBinding: Binding<String> {
        Binding(
            get: { self.state.remoteTarget },
            set: { self.updateManualRemoteTarget($0) })
    }

    func updateManualRemoteTransport(_ value: AppState.RemoteTransport) {
        guard value != state.remoteTransport else { return }
        self.retireGatewayStateForRemoteEndpointEdit()
        self.clearPreferredGatewayForManualEndpointEdit()
        state.remoteTransport = value
    }

    func updateManualRemoteURL(_ value: String) {
        guard value != state.remoteUrl else { return }
        self.retireGatewayStateForRemoteEndpointEdit()
        self.clearPreferredGatewayForManualEndpointEdit()
        state.remoteUrl = value
    }

    func updateManualRemoteTarget(_ value: String) {
        guard value != state.remoteTarget else { return }
        self.retireGatewayStateForRemoteEndpointEdit()
        self.clearPreferredGatewayForManualEndpointEdit()
        state.remoteTarget = value
    }

    func retireGatewayStateForRemoteEndpointEdit() {
        self.resetRemoteProbeFeedback()
        // Editing only retires work owned by the old route. The durable lease
        // survives, and Check connection / the AI page probes the finished value.
        resetGatewayBoundAIState()
    }

    private func clearPreferredGatewayForManualEndpointEdit() {
        let preferred = preferredGatewayID ?? GatewayDiscoveryPreferences.preferredStableID()
        guard preferred != nil else { return }
        preferredGatewayID = nil
        // The coordinator clears the persisted discovery preference and revokes
        // any suspended attempt before this manual endpoint can become active.
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(nil, state: state)
    }

    private var shouldShowRemoteConnectionSection: Bool {
        state.connectionMode == .remote ||
            showAdvancedConnection ||
            remoteProbeState != .idle ||
            remoteAuthIssue != nil ||
            Self.shouldShowRemoteTokenField(
                showAdvancedConnection: showAdvancedConnection,
                remoteToken: state.remoteToken,
                remoteTokenUnsupported: state.remoteTokenUnsupported,
                authIssue: remoteAuthIssue)
    }

    private var shouldShowRemoteTokenField: Bool {
        guard self.shouldShowRemoteConnectionSection else { return false }
        return Self.shouldShowRemoteTokenField(
            showAdvancedConnection: showAdvancedConnection,
            remoteToken: state.remoteToken,
            remoteTokenUnsupported: state.remoteTokenUnsupported,
            authIssue: remoteAuthIssue)
    }

    private var remoteProbePreflightMessage: String? {
        switch state.remoteTransport {
        case .direct:
            let trimmedUrl = state.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedUrl.isEmpty {
                return "Select a nearby gateway or open Advanced to enter a gateway URL."
            }
            if GatewayRemoteConfig.normalizeGatewayUrl(trimmedUrl) == nil {
                return GatewayRemoteConfig.directGatewayUrlValidationMessage
            }
            return nil
        case .ssh:
            let trimmedTarget = state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedTarget.isEmpty {
                return "Select a nearby gateway or open Advanced to enter an SSH target."
            }
            return CommandResolver.sshTargetValidationMessage(trimmedTarget)
        }
    }

    private var canProbeRemoteConnection: Bool {
        self.remoteProbePreflightMessage == nil && !self.remoteProbeState.isChecking
    }

    private func remoteConnectionSection() -> some View {
        let labelWidth: CGFloat = 110
        let fieldWidth: CGFloat = 320

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Remote connection")
                        .font(.callout.weight(.semibold))
                    Text("Verify OpenClaw can reach this gateway.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    Task { await self.probeRemoteConnection(advanceOnSuccess: false) }
                } label: {
                    if self.remoteProbeState.isChecking {
                        ProgressView()
                            .controlSize(.small)
                            .frame(minWidth: 120)
                    } else {
                        Text("Check connection")
                            .frame(minWidth: 120)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!self.canProbeRemoteConnection)
            }

            // Probe feedback sits with the Check connection button it explains,
            // above the form rows, so grid growth never pushes it out of view.
            if let message = self.remoteProbePreflightMessage, !self.remoteProbeState.isChecking {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            self.remoteProbeStatusView()

            if let issue = self.remoteAuthIssue {
                self.remoteAuthPromptView(issue: issue)
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                if self.shouldShowRemoteTokenField {
                    self.remoteTokenField(labelWidth: labelWidth, fieldWidth: fieldWidth)
                }
                if self.showAdvancedConnection {
                    self.advancedConnectionFields(labelWidth: labelWidth, fieldWidth: fieldWidth)
                }
            }

            Button {
                withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                    self.showAdvancedConnection.toggle()
                }
                if self.showAdvancedConnection, self.state.connectionMode != .remote {
                    self.state.connectionMode = .remote
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: self.showAdvancedConnection ? "chevron.up" : "chevron.down")
                    Text(self.showAdvancedConnection ? "Hide advanced options" : "Advanced options")
                }
            }
            .buttonStyle(.link)
        }
        .padding(12)
        .background(
            // controlBackgroundColor matches the card fill, so the hairline
            // stroke is what makes this read as a contained panel.
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color(NSColor.separatorColor))))
    }

    @ViewBuilder
    private func remoteTokenField(labelWidth: CGFloat, fieldWidth: CGFloat) -> some View {
        GridRow {
            Text("Gateway token")
                .font(.callout.weight(.semibold))
                .frame(width: labelWidth, alignment: .leading)
            SecureField("Paste the token from your gateway", text: self.$state.remoteToken)
                .textFieldStyle(.roundedBorder)
                .frame(width: fieldWidth)
        }
        GridRow {
            Text("")
                .frame(width: labelWidth, alignment: .leading)
            Text("Only needed when the gateway requires token auth.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: fieldWidth, alignment: .leading)
        }
        if self.state.remoteTokenUnsupported {
            GridRow {
                Text("")
                    .frame(width: labelWidth, alignment: .leading)
                Text(
                    "The current gateway.remote.token value is not plain text. "
                        + "OpenClaw for macOS cannot use it directly; "
                        + "enter a plaintext token here to replace it.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: fieldWidth, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func advancedConnectionFields(labelWidth: CGFloat, fieldWidth: CGFloat) -> some View {
        GridRow {
            Text("Transport")
                .font(.callout.weight(.semibold))
                .frame(width: labelWidth, alignment: .leading)
            Picker("Transport", selection: self.manualRemoteTransportBinding) {
                Text("SSH tunnel").tag(AppState.RemoteTransport.ssh)
                Text("Direct (ws/wss)").tag(AppState.RemoteTransport.direct)
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: fieldWidth)
        }
        if self.state.remoteTransport == .direct {
            GridRow {
                Text("Gateway URL")
                    .font(.callout.weight(.semibold))
                    .frame(width: labelWidth, alignment: .leading)
                TextField("wss://gateway.example.ts.net", text: self.manualRemoteURLBinding)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: fieldWidth)
            }
        }
        if self.state.remoteTransport == .ssh {
            GridRow {
                Text("SSH target")
                    .font(.callout.weight(.semibold))
                    .frame(width: labelWidth, alignment: .leading)
                TextField("user@host[:port]", text: self.manualRemoteTargetBinding)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: fieldWidth)
            }
            if let message = CommandResolver
                .sshTargetValidationMessage(self.state.remoteTarget)
            {
                GridRow {
                    Text("")
                        .frame(width: labelWidth, alignment: .leading)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(width: fieldWidth, alignment: .leading)
                }
            }
            GridRow {
                Text("Identity file")
                    .font(.callout.weight(.semibold))
                    .frame(width: labelWidth, alignment: .leading)
                TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: fieldWidth)
            }
            GridRow {
                Text("Project root")
                    .font(.callout.weight(.semibold))
                    .frame(width: labelWidth, alignment: .leading)
                TextField("/home/you/Projects/openclaw", text: self.$state.remoteProjectRoot)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: fieldWidth)
            }
            GridRow {
                Text("CLI path")
                    .font(.callout.weight(.semibold))
                    .frame(width: labelWidth, alignment: .leading)
                TextField(
                    "/Applications/OpenClaw.app/.../openclaw",
                    text: self.$state.remoteCliPath)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: fieldWidth)
            }
        }
        GridRow {
            Text("")
                .frame(width: labelWidth, alignment: .leading)
            Text(self.state.remoteTransport == .direct
                ? "Tip: use Tailscale Serve so the gateway has a valid HTTPS cert."
                : "Tip: keep Tailscale enabled so your gateway stays reachable.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: fieldWidth, alignment: .leading)
        }
    }

    @ViewBuilder
    private func remoteProbeStatusView() -> some View {
        switch remoteProbeState {
        case .idle:
            EmptyView()
        case .checking:
            Text("Checking remote gateway…")
                .font(.caption)
                .foregroundStyle(.secondary)
        case let .ok(_, success):
            VStack(alignment: .leading, spacing: 2) {
                Label(success.title, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
                if let detail = success.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case let .failed(_, message):
            if remoteAuthIssue == nil {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func remoteAuthPromptView(issue: RemoteGatewayAuthIssue) -> some View {
        let promptStyle = Self.remoteAuthPromptStyle(for: issue)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: promptStyle.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(promptStyle.tint)
                .frame(width: 16, alignment: .center)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(issue.title)
                    .font(.caption.weight(.semibold))
                Text(.init(issue.body))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let footnote = issue.footnote {
                    Text(.init(footnote))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @MainActor
    var remoteGatewayProbeInput: RemoteGatewayProbeInput {
        RemoteGatewayProbeInput(
            transport: state.remoteTransport,
            target: state.remoteTransport == .direct ? state.remoteUrl : state.remoteTarget,
            token: state.remoteToken)
    }

    func probeRemoteConnection(advanceOnSuccess: Bool) async {
        let input = self.remoteGatewayProbeInput
        let attemptID = UUID()
        self.remoteProbeAttemptID = attemptID
        let originalMode = state.connectionMode
        if originalMode != .remote {
            // Reuse the shared remote endpoint stack for probing without committing the user's mode choice.
            if self.remoteProbeTemporaryRestoreMode == nil {
                self.remoteProbeTemporaryRestoreMode = originalMode
                configuredGatewayProbe.beginTemporaryConnectionCheck()
            }
            state.connectionMode = .remote
        }
        remoteProbeState = .checking(input)
        remoteAuthIssue = nil
        defer {
            if Self.ownsRemoteGatewayProbeAttempt(
                attemptID: attemptID,
                currentAttemptID: self.remoteProbeAttemptID)
            {
                self.remoteProbeAttemptID = nil
                self.finishTemporaryRemoteProbeIfNeeded()
            }
        }
        let result = await RemoteGatewayProbe.run()
        guard Self.shouldAcceptRemoteGatewayProbeResult(
            attemptID: attemptID,
            currentAttemptID: self.remoteProbeAttemptID,
            probeState: self.remoteProbeState,
            expectedInput: input,
            currentInput: self.remoteGatewayProbeInput)
        else {
            return
        }
        switch result {
        case let .ready(success):
            remoteProbeState = .ok(input, success)
            if advanceOnSuccess,
               state.connectionMode == .remote,
               activePageIndex == connectionPageIndex
            {
                self.handleNext()
            }
        case let .authIssue(issue):
            remoteAuthIssue = issue
            remoteProbeState = .failed(input, issue.statusMessage)
        case let .failed(message):
            remoteProbeState = .failed(input, message)
        }
    }

    func resetRemoteProbeFeedback() {
        remoteProbeAttemptID = nil
        self.finishTemporaryRemoteProbeIfNeeded()
        remoteProbeState = .idle
        remoteAuthIssue = nil
    }

    private func finishTemporaryRemoteProbeIfNeeded() {
        guard let restoreMode = self.remoteProbeTemporaryRestoreMode else { return }
        self.remoteProbeTemporaryRestoreMode = nil
        self.suppressRemoteProbeReset = true
        self.state.connectionMode = restoreMode
        self.suppressRemoteProbeReset = false
        self.configuredGatewayProbe.endTemporaryConnectionCheck()
    }

    static func ownsRemoteGatewayProbeAttempt(
        attemptID: UUID,
        currentAttemptID: UUID?) -> Bool
    {
        currentAttemptID == attemptID
    }

    static func shouldAcceptRemoteGatewayProbeResult(
        attemptID: UUID,
        currentAttemptID: UUID?,
        probeState: RemoteOnboardingProbeState,
        expectedInput: RemoteGatewayProbeInput,
        currentInput: RemoteGatewayProbeInput) -> Bool
    {
        self.ownsRemoteGatewayProbeAttempt(attemptID: attemptID, currentAttemptID: currentAttemptID) &&
            probeState == .checking(expectedInput) &&
            currentInput == expectedInput
    }

    static func remoteAuthPromptStyle(
        for issue: RemoteGatewayAuthIssue)
        -> (systemImage: String, tint: Color)
    {
        switch issue {
        case .tokenRequired:
            ("key.fill", .orange)
        case .tokenMismatch:
            ("exclamationmark.triangle.fill", .orange)
        case .gatewayTokenNotConfigured:
            ("wrench.and.screwdriver.fill", .orange)
        case .setupCodeExpired:
            ("qrcode.viewfinder", .orange)
        case .passwordRequired:
            ("lock.slash.fill", .orange)
        case .pairingRequired:
            ("link.badge.plus", .orange)
        }
    }

    static func shouldShowRemoteTokenField(
        showAdvancedConnection: Bool,
        remoteToken: String,
        remoteTokenUnsupported: Bool,
        authIssue: RemoteGatewayAuthIssue?) -> Bool
    {
        showAdvancedConnection ||
            remoteTokenUnsupported ||
            !remoteToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            authIssue?.showsTokenField == true
    }

    static func shouldResetRemoteProbeFeedback(
        for connectionMode: AppState.ConnectionMode,
        suppressReset: Bool) -> Bool
    {
        !suppressReset && connectionMode != .remote
    }

    func gatewaySubtitle(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        if state.remoteTransport == .direct {
            return GatewayDiscoveryHelpers.directUrl(for: gateway) ?? "Gateway pairing only"
        }
        if let target = GatewayDiscoveryHelpers.sshTarget(for: gateway),
           let parsed = CommandResolver.parseSSHTarget(target)
        {
            let portSuffix = parsed.port != 22 ? " · ssh \(parsed.port)" : ""
            return "\(parsed.host)\(portSuffix)"
        }
        return "Gateway pairing only"
    }

    func isSelectedGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool {
        guard state.connectionMode == .remote else { return false }
        return effectivePreferredGatewayID == gateway.stableID
    }

    func connectionChoiceButton(
        title: String,
        badge: String? = nil,
        subtitle: String?,
        systemImage: String? = nil,
        monospacedSubtitle: Bool = false,
        selected: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                action()
            }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                        .frame(width: 26)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.callout.weight(.semibold))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if let badge {
                            Text(badge)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Color.accentColor.opacity(0.16)))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    if let subtitle {
                        Text(subtitle)
                            .font(monospacedSubtitle ? .caption.monospaced() : .caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                SelectionStateIndicator(selected: selected)
            }
            .openClawSelectableRowChrome(selected: selected)
        }
        .buttonStyle(.plain)
    }

    func cliPage() -> some View {
        let detail = "OpenClaw is setting up its Gateway background service on this Mac. " +
            "Published Stable and Beta installs are usually quick. " +
            "Dev (Git main) downloads and builds OpenClaw from source, so allow several minutes " +
            "and several gigabytes of free space. No administrator password is required."
        return onboardingPage {
            Text("Getting things ready")
                .font(.largeTitle.weight(.semibold))
            Text(detail)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 14, padding: 16) {
                self.installStepRow(
                    title: "Install OpenClaw",
                    detail: self.cliExecutableReady
                        ? (self.cliInstallLocation ?? "Installed")
                        : "A private copy inside your user folder.",
                    state: self.installStepStateForInstall,
                    monospacedDetail: self.cliExecutableReady && self.cliInstallLocation != nil)
                self.installStepRow(
                    title: "Start the background service",
                    detail: "Runs quietly and starts again after a restart.",
                    state: self.installStepStateForService)
                self.installStepRow(
                    title: "Ready for the next step",
                    detail: "Once the service answers, you’ll connect your AI.",
                    state: self.cliInstalled ? .done : .pending)

                if self.installFailed {
                    OnboardingErrorCard(
                        title: self.cliExecutableReady
                            ? "The Gateway didn’t start"
                            : "OpenClaw installation failed",
                        message: self.cliStatus ?? "The installer did not finish.",
                        docsSlug: "platforms/mac/bundled-gateway",
                        retryTitle: "Try again")
                    {
                        if self.cliExecutableReady {
                            self.startExistingCLIActivationIfNeeded()
                        } else {
                            self.startCLIInstall()
                        }
                    }
                } else if let cliStatus, !self.cliInstalled {
                    Text(cliStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var installFailed: Bool {
        cliStatusKnown && !installingCLI && !cliInstalled
    }

    /// Exactly one spinner at a time: the install row finishes before the
    /// service row starts, mirroring the actual runCLIInstall phases.
    private var installStepStateForInstall: InstallStepState {
        Self.cliInstallStepStates(
            executableReady: self.cliExecutableReady,
            gatewayReady: self.cliInstalled,
            statusKnown: self.cliStatusKnown,
            installing: self.installingCLI,
            phase: self.cliInstallPhase).install
    }

    private var installStepStateForService: InstallStepState {
        Self.cliInstallStepStates(
            executableReady: self.cliExecutableReady,
            gatewayReady: self.cliInstalled,
            statusKnown: self.cliStatusKnown,
            installing: self.installingCLI,
            phase: self.cliInstallPhase).service
    }

    static func cliInstallStepStates(
        executableReady: Bool,
        gatewayReady: Bool,
        statusKnown: Bool,
        installing: Bool,
        phase: CLIInstallPhase) -> (install: InstallStepState, service: InstallStepState)
    {
        let install: InstallStepState = if executableReady || gatewayReady {
            .done
        } else if installing {
            if phase == .choosingTarget {
                .pending
            } else if phase == .startingService {
                .done
            } else {
                .running
            }
        } else if statusKnown {
            .failed
        } else {
            .running
        }

        let service: InstallStepState = if gatewayReady {
            .done
        } else if installing {
            phase == .startingService ? .running : .pending
        } else if statusKnown, executableReady {
            .failed
        } else {
            .pending
        }

        return (install, service)
    }

    enum InstallStepState {
        case pending
        case running
        case done
        case failed
    }

    private func installStepRow(
        title: String,
        detail: String,
        state: InstallStepState,
        monospacedDetail: Bool = false) -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            Group {
                switch state {
                case .pending:
                    Image(systemName: "circle.dotted")
                        .foregroundStyle(.tertiary)
                case .running:
                    ProgressView()
                        .controlSize(.small)
                case .done:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .failed:
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                }
            }
            .font(.title3)
            .frame(width: 26, height: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(state == .pending ? Color.secondary : Color.primary)
                Text(detail)
                    .font(monospacedDetail ? .caption.monospaced() : .caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    func readyPage() -> some View {
        onboardingPage {
            Text("You’re all set!")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                self.featureRow(
                    title: "Configure later",
                    subtitle: "Pick Local or Remote in Settings → General whenever you’re ready.",
                    systemImage: "gearshape")
                Divider()
                    .padding(.vertical, 6)
                self.featureRow(
                    title: "Open the menu bar panel",
                    subtitle: "Click the OpenClaw menu bar icon for the compact chat panel and status.",
                    systemImage: "bubble.left.and.bubble.right")
                self.featureActionRow(
                    title: "Connect Discord, Slack, Telegram, WhatsApp, …",
                    subtitle: "Open Settings → Channels to link channels and monitor status.",
                    systemImage: "link",
                    buttonTitle: "Open Settings → Channels")
                {
                    self.openSettings(tab: .channels)
                }
                self.featureRow(
                    title: "Try Voice Wake",
                    subtitle: "Enable Voice Wake in Settings for hands-free commands with a live transcript overlay.",
                    systemImage: "waveform.circle")
                self.featureRow(
                    title: "Use the panel + Canvas",
                    subtitle: "Open the compact chat panel; the agent can show previews " +
                        "and richer visuals in Canvas.",
                    systemImage: "rectangle.inset.filled.and.person.filled")
                self.featureActionRow(
                    title: "Give your agent more powers",
                    subtitle: "Enable optional skills (Peekaboo, oracle, camsnap, …) from Settings → Skills.",
                    systemImage: "sparkles",
                    buttonTitle: "Open Settings → Skills")
                {
                    self.openSettings(tab: .skills)
                }
                if AppProfile.current.isActive {
                    LabeledContent("Launch at login", value: "Unavailable under profile")
                } else {
                    Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                        .disabled(!self.state.bundleLocationAllowsPersistentIntegration && !self.state.launchAtLogin)
                }
            }
        }
    }
}

extension RemoteOnboardingProbeState {
    var isChecking: Bool {
        if case .checking = self { return true }
        return false
    }
}
