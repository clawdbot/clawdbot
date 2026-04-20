import AppKit
import OpenClawChatUI
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
import SwiftUI

extension OnboardingView {
    @ViewBuilder
    func pageView(for pageIndex: Int) -> some View {
        switch pageIndex {
        case 0:
            self.welcomePage()
        case 1:
            self.connectionPage()
        case 3:
            self.wizardPage()
        case 5:
            self.permissionsPage()
        case 6:
            self.cliPage()
        case 8:
            self.onboardingChatPage()
        case 9:
            self.readyPage()
        default:
            EmptyView()
        }
    }

    func welcomePage() -> some View {
        self.onboardingPage {
            VStack(spacing: 22) {
                Text("Welcome to OpenClaw")
                    .font(.largeTitle.weight(.semibold))
                Text("OpenClaw is a powerful personal AI assistant that can connect to WhatsApp or Telegram.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .frame(maxWidth: 560)
                    .fixedSize(horizontal: false, vertical: true)

                self.onboardingCard(spacing: 10, padding: 14) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Color(nsColor: .systemOrange))
                            .frame(width: 22)
                            .padding(.top, 1)

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Security notice")
                                .font(.headline)
                            Text(
                                "The connected AI agent (e.g. Claude) can trigger powerful actions on your Mac, " +
                                    "including running commands, reading/writing files, and capturing screenshots — " +
                                    "depending on the permissions you grant.\n\n" +
                                    "Only enable OpenClaw if you understand the risks and trust the prompts and " +
                                    "integrations you use.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .frame(maxWidth: 520)
            }
            .padding(.top, 16)
        }
    }

    func connectionPage() -> some View {
        self.onboardingPage {
            Text("Choose your Gateway")
                .font(.largeTitle.weight(.semibold))
            Text(
                "OpenClaw uses a single Gateway that stays running. Pick this Mac, " +
                    "connect to a discovered gateway nearby, or configure later.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    self.connectionChoiceButton(
                        title: "This Mac",
                        subtitle: self.localGatewaySubtitle,
                        selected: self.state.connectionMode == .local)
                    {
                        self.selectLocalGateway()
                    }

                    Divider().padding(.vertical, 4)

                    self.gatewayDiscoverySection()

                    if self.shouldShowRemoteConnectionSection {
                        Divider().padding(.vertical, 4)
                        self.remoteConnectionSection()
                    }

                    self.connectionChoiceButton(
                        title: "Configure later",
                        subtitle: "Don’t start the Gateway yet.",
                        selected: self.state.connectionMode == .unconfigured)
                    {
                        self.selectUnconfiguredGateway()
                    }

                    self.advancedConnectionSection()
                }
            }
        }
        .onChange(of: self.state.connectionMode) { _, newValue in
            guard Self.shouldResetRemoteProbeFeedback(
                for: newValue,
                suppressReset: self.suppressRemoteProbeReset)
            else { return }
            self.resetRemoteProbeFeedback()
        }
        .onChange(of: self.state.remoteTransport) { _, _ in
            self.resetRemoteProbeFeedback()
        }
        .onChange(of: self.state.remoteTarget) { _, _ in
            self.resetRemoteProbeFeedback()
        }
        .onChange(of: self.state.remoteUrl) { _, _ in
            self.resetRemoteProbeFeedback()
        }
    }

    private var localGatewaySubtitle: String {
        guard let probe = self.localGatewayProbe else {
            return "Gateway starts automatically on this Mac."
        }
        let base = probe.expected
            ? "Existing gateway detected"
            : "Port \(probe.port) already in use"
        let command = probe.command.isEmpty ? "" : " (\(probe.command) pid \(probe.pid))"
        return "\(base)\(command). Will attach."
    }

    @ViewBuilder
    private func gatewayDiscoverySection() -> some View {
        HStack(spacing: 8) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(self.gatewayDiscovery.statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
            if self.gatewayDiscovery.gateways.isEmpty {
                ProgressView().controlSize(.small)
                Button("Refresh") {
                    self.gatewayDiscovery.refreshRemoteFallbackNow(timeoutSeconds: 5.0)
                }
                .buttonStyle(.link)
                .help("Retry remote discovery (Tailscale DNS-SD + Serve probe).")
            }
            Spacer(minLength: 0)
        }

        if self.gatewayDiscovery.gateways.isEmpty {
            Text("Searching for nearby gateways…")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Nearby gateways")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 4)
                ForEach(self.gatewayDiscovery.gateways.prefix(6)) { gateway in
                    self.connectionChoiceButton(
                        title: gateway.displayName,
                        subtitle: self.gatewaySubtitle(for: gateway),
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
        Button(self.showAdvancedConnection ? "Hide Advanced" : "Advanced…") {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                self.showAdvancedConnection.toggle()
            }
            if self.showAdvancedConnection, self.state.connectionMode != .remote {
                self.state.connectionMode = .remote
            }
        }
        .buttonStyle(.link)

        if self.showAdvancedConnection {
            let labelWidth: CGFloat = 110
            let fieldWidth: CGFloat = 320

            VStack(alignment: .leading, spacing: 10) {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                    GridRow {
                        Text("Transport")
                            .font(.callout.weight(.semibold))
                            .frame(width: labelWidth, alignment: .leading)
                        Picker("Transport", selection: self.$state.remoteTransport) {
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
                            TextField("wss://gateway.example.ts.net", text: self.$state.remoteUrl)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }
                    }
                    if self.state.remoteTransport == .ssh {
                        GridRow {
                            Text("SSH target")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField("user@host[:port]", text: self.$state.remoteTarget)
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

    private var shouldShowRemoteConnectionSection: Bool {
        self.state.connectionMode == .remote ||
            self.showAdvancedConnection ||
            self.remoteProbeState != .idle ||
            self.remoteAuthIssue != nil ||
            Self.shouldShowRemoteTokenField(
                showAdvancedConnection: self.showAdvancedConnection,
                remoteToken: self.state.remoteToken,
                remoteTokenUnsupported: self.state.remoteTokenUnsupported,
                authIssue: self.remoteAuthIssue)
    }

    private var shouldShowRemoteTokenField: Bool {
        guard self.shouldShowRemoteConnectionSection else { return false }
        return Self.shouldShowRemoteTokenField(
            showAdvancedConnection: self.showAdvancedConnection,
            remoteToken: self.state.remoteToken,
            remoteTokenUnsupported: self.state.remoteTokenUnsupported,
            authIssue: self.remoteAuthIssue)
    }

    private var remoteProbePreflightMessage: String? {
        switch self.state.remoteTransport {
        case .direct:
            let trimmedUrl = self.state.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedUrl.isEmpty {
                return "Select a nearby gateway or open Advanced to enter a gateway URL."
            }
            if GatewayRemoteConfig.normalizeGatewayUrl(trimmedUrl) == nil {
                return "Gateway URL must use wss:// for remote hosts (ws:// only for localhost)."
            }
            return nil
        case .ssh:
            let trimmedTarget = self.state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedTarget.isEmpty {
                return "Select a nearby gateway or open Advanced to enter an SSH target."
            }
            return CommandResolver.sshTargetValidationMessage(trimmedTarget)
        }
    }

    private var canProbeRemoteConnection: Bool {
        self.remoteProbePreflightMessage == nil && self.remoteProbeState != .checking
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
        switch self.remoteProbeState {
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
            if self.remoteAuthIssue == nil {
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
        let originalMode = self.state.connectionMode
        let shouldRestoreMode = originalMode != .remote
        if shouldRestoreMode {
            // Reuse the shared remote endpoint stack for probing without committing the user's mode choice.
            self.state.connectionMode = .remote
        }
        self.remoteProbeState = .checking
        self.remoteAuthIssue = nil
        defer {
            if shouldRestoreMode {
                self.suppressRemoteProbeReset = true
                self.state.connectionMode = originalMode
                self.suppressRemoteProbeReset = false
            }
        }

        switch await RemoteGatewayProbe.run() {
        case let .ready(success):
            self.remoteProbeState = .ok(success)
        case let .authIssue(issue):
            self.remoteAuthIssue = issue
            self.remoteProbeState = .failed(issue.statusMessage)
        case let .failed(message):
            self.remoteProbeState = .failed(message)
        }
    }

    private func resetRemoteProbeFeedback() {
        self.remoteProbeState = .idle
        self.remoteAuthIssue = nil
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
        if self.state.remoteTransport == .direct {
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
        guard self.state.connectionMode == .remote else { return false }
        let preferred = self.preferredGatewayID ?? GatewayDiscoveryPreferences.preferredStableID()
        return preferred == gateway.stableID
    }

    func connectionChoiceButton(
        title: String,
        subtitle: String?,
        selected: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                action()
            }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                SelectionStateIndicator(selected: selected)
            }
            .openClawSelectableRowChrome(selected: selected)
        }
        .buttonStyle(.plain)
    }

    func permissionsPage() -> some View {
        self.onboardingPage {
            Text("Grant permissions")
                .font(.largeTitle.weight(.semibold))
            Text("These macOS permissions let OpenClaw automate apps and capture context on this Mac.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 8, padding: 12) {
                ForEach(Capability.allCases, id: \.self) { cap in
                    PermissionRow(
                        capability: cap,
                        status: self.permissionMonitor.status[cap] ?? false,
                        compact: true)
                    {
                        Task { await self.request(cap) }
                    }
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await self.refreshPerms() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Refresh status")
                    if self.isRequesting {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    func cliPage() -> some View {
        self.onboardingPage {
            Text("Install the CLI")
                .font(.largeTitle.weight(.semibold))
            Text("Required for local mode: installs `openclaw` so launchd can run the gateway.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10) {
                HStack(spacing: 12) {
                    Button {
                        Task { await self.installCLI() }
                    } label: {
                        let title = self.cliInstalled ? "Reinstall CLI" : "Install CLI"
                        ZStack {
                            Text(title)
                                .opacity(self.installingCLI ? 0 : 1)
                            if self.installingCLI {
                                ProgressView()
                                    .controlSize(.mini)
                            }
                        }
                        .frame(minWidth: 120)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.installingCLI)

                    Button(self.copied ? "Copied" : "Copy install command") {
                        self.copyToPasteboard(self.devLinkCommand)
                    }
                    .disabled(self.installingCLI)

                    if self.cliInstalled, let loc = self.cliInstallLocation {
                        Label("Installed at \(loc)", systemImage: "checkmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.green)
                    }
                }

                if let cliStatus {
                    Text(cliStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !self.cliInstalled, self.cliInstallLocation == nil {
                    Text(
                        """
                        Installs a user-space Node 22+ runtime and the CLI (no Homebrew).
                        Rerun anytime to reinstall or update.
                        """)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    func workspacePage() -> some View {
        self.onboardingPage {
            Text("Agent workspace")
                .font(.largeTitle.weight(.semibold))
            Text(
                "OpenClaw runs the agent from a dedicated workspace so it can load `AGENTS.md` " +
                    "and write files there without mixing into your other projects.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10) {
                if self.state.connectionMode == .remote {
                    Text("Remote gateway detected")
                        .font(.headline)
                    Text(
                        "Create the workspace on the remote host (SSH in first). " +
                            "The macOS app can’t write files on your gateway over SSH yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button(self.copied ? "Copied" : "Copy setup command") {
                        self.copyToPasteboard(self.workspaceBootstrapCommand)
                    }
                    .buttonStyle(.bordered)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Workspace folder")
                            .font(.headline)
                        TextField(
                            AgentWorkspace.displayPath(for: OpenClawConfigFile.defaultWorkspaceURL()),
                            text: self.$workspacePath)
                            .textFieldStyle(.roundedBorder)

                        HStack(spacing: 12) {
                            Button {
                                Task { await self.applyWorkspace() }
                            } label: {
                                if self.workspaceApplying {
                                    ProgressView()
                                } else {
                                    Text("Create workspace")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(self.workspaceApplying)

                            Button("Open folder") {
                                let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                NSWorkspace.shared.open(url)
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.workspaceApplying)

                            Button("Save in config") {
                                Task {
                                    let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                    let saved = await self.saveAgentWorkspace(AgentWorkspace.displayPath(for: url))
                                    if saved {
                                        self.workspaceStatus =
                                            "Saved to ~/.openclaw/openclaw.json (agents.defaults.workspace)"
                                    }
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.workspaceApplying)
                        }
                    }

                    if let workspaceStatus {
                        Text(workspaceStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else {
                        Text(
                            "Tip: edit AGENTS.md in this folder to shape the assistant’s behavior. " +
                                "For backup, make the workspace a private git repo so your agent’s " +
                                "“memory” is versioned.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    func onboardingChatPage() -> some View {
        VStack(spacing: 16) {
            Text("Meet your agent")
                .font(.largeTitle.weight(.semibold))
            Text(
                "This is a dedicated onboarding chat. Your agent will introduce itself, " +
                    "learn who you are, and help you connect WhatsApp or Telegram if you want.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingGlassCard(padding: 8) {
                OpenClawChatView(viewModel: self.onboardingChatModel, style: .onboarding)
                    .frame(maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, height: self.contentHeight, alignment: .top)
    }

    func readyPage() -> some View {
        self.onboardingPage {
            Text("All set")
                .font(.largeTitle.weight(.semibold))
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
                    title: "Connect WhatsApp or Telegram",
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
                    .onChange(of: self.state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
            }
        }
        .task { await self.maybeLoadOnboardingSkills() }
    }

    private func maybeLoadOnboardingSkills() async {
        guard !self.didLoadOnboardingSkills else { return }
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
