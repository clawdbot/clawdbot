import AppKit
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
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
        case 5:
            self.permissionsPage(contentHeight: contentHeight)
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
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                            self.showRemoteChoices.toggle()
                        }
                    }

                    if self.showRemoteChoices || self.selectedConnectionMode == .remote {
                        self.gatewayDiscoverySection()

                        if self.shouldShowRemoteConnectionSection {
                            Divider().padding(.vertical, 4)
                            self.remoteConnectionSection()
                        }

                        self.advancedConnectionSection()
                    }
                }
            }

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
            // retires route-owned AI/Crestodian state. This nested observer owns probe copy only.
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
        let base = probe.expected
            ? "Existing gateway detected"
            : "Port \(probe.port) already in use"
        let command = probe.command.isEmpty ? "" : " (\(probe.command) pid \(probe.pid))"
        return "\(base)\(command). Will attach."
    }

    private var remoteChoiceSubtitle: String {
        let count = gatewayDiscovery.gateways.count
        if count > 0 {
            return count == 1
                ? "1 gateway found on your network — click to choose it."
                : "\(count) gateways found on your network — click to choose one."
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

    @ViewBuilder
    private func advancedConnectionSection() -> some View {
        Button(showAdvancedConnection ? "Hide Advanced" : "Advanced…") {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                self.showAdvancedConnection.toggle()
            }
            if self.showAdvancedConnection, self.state.connectionMode != .remote {
                self.state.connectionMode = .remote
            }
        }
        .buttonStyle(.link)

        if showAdvancedConnection {
            let labelWidth: CGFloat = 110
            let fieldWidth: CGFloat = 320

            VStack(alignment: .leading, spacing: 10) {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                    GridRow {
                        Text("Transport")
                            .font(.callout.weight(.semibold))
                            .frame(width: labelWidth, alignment: .leading)
                        Picker("Transport", selection: self.manualRemoteTransportBinding) {
                            Text("SSH tunnel").tag(AppState.RemoteTransport.ssh)
                            Text("Direct (ws/wss)").tag(AppState.RemoteTransport.direct)
                        }
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
                }

                Text(self.state.remoteTransport == .direct
                    ? "Tip: use Tailscale Serve so the gateway has a valid HTTPS cert."
                    : "Tip: keep Tailscale enabled so your gateway stays reachable.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
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
                return """
                Gateway URL must use wss:// for public hosts; ws:// is allowed for localhost, LAN, or Tailnet hosts.
                """
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
        self.remoteProbePreflightMessage == nil && remoteProbeState != .checking
    }

    private func remoteConnectionSection() -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Remote connection")
                        .font(.callout.weight(.semibold))
                    Text("Checks the real remote websocket and auth handshake.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    Task { await self.probeRemoteConnection() }
                } label: {
                    if self.remoteProbeState == .checking {
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

            if self.shouldShowRemoteTokenField {
                self.remoteTokenField()
            }

            if let message = self.remoteProbePreflightMessage, self.remoteProbeState != .checking {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            self.remoteProbeStatusView()

            if let issue = self.remoteAuthIssue {
                self.remoteAuthPromptView(issue: issue)
            }
        }
    }

    private func remoteTokenField() -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 12) {
                Text("Gateway token")
                    .font(.callout.weight(.semibold))
                    .frame(width: 110, alignment: .leading)
                SecureField("remote gateway auth token (gateway.remote.token)", text: self.$state.remoteToken)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 320)
            }
            Text("Used when the remote gateway requires token auth.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if self.state.remoteTokenUnsupported {
                Text(
                    "The current gateway.remote.token value is not plain text. "
                        + "OpenClaw for macOS cannot use it directly; "
                        + "enter a plaintext token here to replace it.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
        case let .ok(success):
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
        case let .failed(message):
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
    private func probeRemoteConnection() async {
        let originalMode = state.connectionMode
        let shouldRestoreMode = originalMode != .remote
        if shouldRestoreMode {
            // Reuse the shared remote endpoint stack for probing without committing the user's mode choice.
            configuredGatewayProbe.beginTemporaryConnectionCheck()
            state.connectionMode = .remote
        }
        remoteProbeState = .checking
        remoteAuthIssue = nil
        defer {
            if shouldRestoreMode {
                self.suppressRemoteProbeReset = true
                self.state.connectionMode = originalMode
                self.suppressRemoteProbeReset = false
                self.configuredGatewayProbe.endTemporaryConnectionCheck()
            }
        }

        switch await RemoteGatewayProbe.run() {
        case let .ready(success):
            remoteProbeState = .ok(success)
        case let .authIssue(issue):
            remoteAuthIssue = issue
            remoteProbeState = .failed(issue.statusMessage)
        case let .failed(message):
            remoteProbeState = .failed(message)
        }
    }

    func resetRemoteProbeFeedback() {
        remoteProbeState = .idle
        remoteAuthIssue = nil
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

    func permissionsPage(contentHeight: CGFloat) -> some View {
        // Fixed layout (no ScrollView): sorted by importance and sized so all
        // permissions stay visible at once — no scrollbars during onboarding.
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Text("Grant permissions")
                    .font(.largeTitle.weight(.semibold))
                if self.isRequesting {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            Text(
                "These macOS permissions let OpenClaw automate apps and capture context on this Mac. " +
                    "Status updates automatically.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 4, padding: 12) {
                ForEach(Capability.importanceOrdered, id: \.self) { cap in
                    PermissionRow(
                        capability: cap,
                        status: self.permissionMonitor.status[cap] ?? false,
                        compact: true)
                    {
                        Task { await self.request(cap) }
                    }
                }
            }
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, height: contentHeight, alignment: .top)
    }

    func cliPage() -> some View {
        onboardingPage {
            Text("Getting things ready")
                .font(.largeTitle.weight(.semibold))
            Text(
                "OpenClaw is setting up its background service on this Mac. " +
                    "This usually takes under a minute — no Terminal, no administrator password.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 14, padding: 16) {
                self.installStepRow(
                    title: "Install OpenClaw",
                    detail: self.cliInstalled
                        ? (self.cliInstallLocation ?? "Installed")
                        : "A private copy inside your user folder.",
                    state: self.installStepStateForInstall,
                    monospacedDetail: self.cliInstalled && self.cliInstallLocation != nil)
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
                        title: "The Gateway didn’t start",
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
        if self.cliInstalled { return .done }
        if self.installingCLI {
            return self.cliInstallPhase == .startingService ? .done : .running
        }
        if self.installFailed { return .failed }
        return .running // status probe still deciding
    }

    private var installStepStateForService: InstallStepState {
        if self.cliInstalled { return .done }
        if self.installingCLI {
            return self.cliInstallPhase == .startingService ? .running : .pending
        }
        if self.installFailed { return .failed }
        return .pending
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
            if self.state.connectionMode != .unconfigured {
                Text("Finish opens the chat — say hi to your new agent.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            self.onboardingCard {
                if self.state.connectionMode == .unconfigured {
                    self.featureRow(
                        title: "Configure later",
                        subtitle: "Pick Local or Remote in Settings → General whenever you’re ready.",
                        systemImage: "gearshape")
                    Divider()
                        .padding(.vertical, 6)
                }
                if self.state.connectionMode == .remote {
                    self.featureRow(
                        title: "Remote gateway checklist",
                        subtitle: """
                        On your gateway host: install/update the `openclaw` package and make sure credentials exist
                        (typically `~/.openclaw/credentials/oauth.json`). Then connect again if needed.
                        """,
                        systemImage: "network")
                    Divider()
                        .padding(.vertical, 6)
                }
                self.featureRow(
                    title: "Open the menu bar panel",
                    subtitle: "Click the OpenClaw menu bar icon for quick chat and status.",
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
                    subtitle: "Open the menu bar panel for quick chat; the agent can show previews " +
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
                self.skillsOverview
                Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                    .disabled(!self.state.bundleLocationAllowsPersistentIntegration && !self.state.launchAtLogin)
            }
        }
        .task { await self.maybeLoadOnboardingSkills() }
        .onChange(of: currentPage) { _, newValue in
            // The pager builds every page up front, so the initial load above
            // can run before the local gateway is configured and fail. Retry
            // when the user actually lands here instead of latching the error.
            guard self.activePageIndex(for: newValue) == self.pageOrder.last else { return }
            Task { await self.maybeLoadOnboardingSkills() }
        }
    }

    private func maybeLoadOnboardingSkills() async {
        if self.onboardingSkillsModel.isLoading { return }
        if self.didLoadOnboardingSkills, self.onboardingSkillsModel.error == nil { return }
        self.didLoadOnboardingSkills = true
        await self.onboardingSkillsModel.refresh()
    }

    private var skillsOverview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
                .padding(.vertical, 6)

            HStack(spacing: 10) {
                Text("Skills included")
                    .font(.headline)
                Spacer(minLength: 0)
                if self.onboardingSkillsModel.isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button("Refresh") {
                        Task { await self.onboardingSkillsModel.refresh() }
                    }
                    .buttonStyle(.link)
                }
            }

            if let error = self.onboardingSkillsModel.error {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Couldn’t load skills from the Gateway.")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(
                        "Make sure the Gateway is running and connected, " +
                            "then hit Refresh (or open Settings → Skills).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Details: \(error)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if self.onboardingSkillsModel.skills.isEmpty {
                Text("No skills reported yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(self.onboardingSkillsModel.skills) { skill in
                            HStack(alignment: .top, spacing: 10) {
                                Text(skill.emoji ?? "✨")
                                    .font(.callout)
                                    .frame(width: 22, alignment: .leading)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(skill.name)
                                        .font(.callout.weight(.semibold))
                                    Text(skill.description)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color(NSColor.windowBackgroundColor)))
                }
                .frame(maxHeight: 160)
            }
        }
    }
}
