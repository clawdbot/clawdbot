import AppKit
import ClawdisIPC
import Observation
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to Clawdis"
}

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    func show() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.setContentSize(NSSize(width: 680, height: 840))
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.window?.close()
        self.window = nil
    }
}

// swiftlint:disable:next type_body_length
struct OnboardingView: View {
    @Environment(\.openSettings) private var openSettings
    @State private var currentPage = 0
    @State private var isRequesting = false
    @State private var installingCLI = false
    @State private var cliStatus: String?
    @State private var copied = false
    @State private var monitoringPermissions = false
    @State private var monitoringDiscovery = false
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?
    @State private var workspacePath: String = ""
    @State private var workspaceStatus: String?
    @State private var workspaceApplying = false
    @State private var anthropicAuthPKCE: AnthropicOAuth.PKCE?
    @State private var anthropicAuthCode: String = ""
    @State private var anthropicAuthStatus: String?
    @State private var anthropicAuthBusy = false
    @State private var anthropicAuthConnected = false
    @State private var monitoringAuth = false
    @State private var authMonitorTask: Task<Void, Never>?
    @State private var identityName: String = ""
    @State private var identityTheme: String = ""
    @State private var identityEmoji: String = ""
    @State private var identityStatus: String?
    @State private var identityApplying = false
    @State private var gatewayStatus: GatewayEnvironmentStatus = .checking
    @State private var gatewayInstalling = false
    @State private var gatewayInstallMessage: String?
    // swiftlint:disable:next inclusive_language
    @State private var masterDiscovery: MasterDiscoveryModel
    @Bindable private var state: AppState
    private var permissionMonitor: PermissionMonitor

    private let pageWidth: CGFloat = 680
    private let contentHeight: CGFloat = 520
    private let connectionPageIndex = 1
    private let anthropicAuthPageIndex = 2
    private let permissionsPageIndex = 5
    private var pageOrder: [Int] {
        if self.state.connectionMode == .remote {
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // and WhatsApp/Telegram setup is optional.
            return [0, 1, 5, 9]
        }
        return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    }

    private var pageCount: Int { self.pageOrder.count }
    private var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    private var buttonTitle: String { self.currentPage == self.pageCount - 1 ? "Finish" : "Next" }
    private let devLinkCommand = "ln -sf $(pwd)/apps/macos/.build/debug/ClawdisCLI /usr/local/bin/clawdis-mac"

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: MasterDiscoveryModel = MasterDiscoveryModel())
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self._masterDiscovery = State(initialValue: discoveryModel)
    }

    var body: some View {
        VStack(spacing: 0) {
            GlowingClawdisIcon(size: 156)
                .padding(.top, 10)
                .padding(.bottom, 2)
                .frame(height: 176)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    self.welcomePage().frame(width: self.pageWidth)
                    self.connectionPage().frame(width: self.pageWidth)
                    self.anthropicAuthPage().frame(width: self.pageWidth)
                    self.identityPage().frame(width: self.pageWidth)
                    self.gatewayPage().frame(width: self.pageWidth)
                    self.permissionsPage().frame(width: self.pageWidth)
                    self.cliPage().frame(width: self.pageWidth)
                    self.workspacePage().frame(width: self.pageWidth)
                    self.whatsappPage().frame(width: self.pageWidth)
                    self.readyPage().frame(width: self.pageWidth)
                }
                .offset(x: CGFloat(-self.activePageIndex) * self.pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: self.currentPage)
                .frame(height: self.contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: self.contentHeight)

            self.navigationBar
        }
        .frame(width: self.pageWidth, height: 720)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.currentPage = 0
            self.updateMonitoring(for: 0)
        }
        .onChange(of: self.currentPage) { _, newValue in
            self.updateMonitoring(for: self.activePageIndex(for: newValue))
        }
        .onChange(of: self.state.connectionMode) { _, _ in
            let oldActive = self.activePageIndex
            self.reconcilePageForModeChange(previousActivePageIndex: oldActive)
            self.updateDiscoveryMonitoring(for: self.activePageIndex)
        }
        .onDisappear {
            self.stopPermissionMonitoring()
            self.stopDiscovery()
            self.stopAuthMonitoring()
        }
        .task {
            await self.refreshPerms()
            self.refreshCLIStatus()
            self.refreshGatewayStatus()
            self.loadWorkspaceDefaults()
            self.refreshAnthropicOAuthStatus()
            self.loadIdentityDefaults()
        }
    }

    private func activePageIndex(for pageCursor: Int) -> Int {
        guard !self.pageOrder.isEmpty else { return 0 }
        let clamped = min(max(0, pageCursor), self.pageOrder.count - 1)
        return self.pageOrder[clamped]
    }

    private func reconcilePageForModeChange(previousActivePageIndex: Int) {
        if let exact = self.pageOrder.firstIndex(of: previousActivePageIndex) {
            withAnimation { self.currentPage = exact }
            return
        }
        if let next = self.pageOrder.firstIndex(where: { $0 > previousActivePageIndex }) {
            withAnimation { self.currentPage = next }
            return
        }
        withAnimation { self.currentPage = max(0, self.pageOrder.count - 1) }
    }

    private func welcomePage() -> some View {
        self.onboardingPage {
            VStack(spacing: 22) {
                Text("Welcome to Clawdis")
                    .font(.largeTitle.weight(.semibold))
                Text(
                    "Your macOS menu bar companion for notifications, screenshots, and agent automation — " +
                        "setup takes just a few minutes.")
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
                                    "Only enable Clawdis if you understand the risks and trust the prompts and " +
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

    private func connectionPage() -> some View {
        self.onboardingPage {
            Text("Where Clawdis runs")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Clawdis has one primary Gateway (“master”) that runs continuously. " +
                    "Connect locally or over SSH/Tailscale so the agent can work on any Mac.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 14) {
                Picker("Clawdis runs", selection: self.$state.connectionMode) {
                    Text("Local (this Mac)").tag(AppState.ConnectionMode.local)
                    Text("Remote over SSH").tag(AppState.ConnectionMode.remote)
                }
                .pickerStyle(.segmented)
                .frame(width: 360)

                if self.state.connectionMode == .remote {
                    let labelWidth: CGFloat = 90
                    let fieldWidth: CGFloat = 300
                    let contentLeading: CGFloat = labelWidth + 12

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .center, spacing: 12) {
                            Text("SSH target")
                                .font(.callout.weight(.semibold))
                                .frame(width: labelWidth, alignment: .leading)
                            TextField("user@host[:22]", text: self.$state.remoteTarget)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: fieldWidth)
                        }

                        MasterDiscoveryInlineList(
                            discovery: self.masterDiscovery,
                            currentTarget: self.state.remoteTarget)
                        { master in
                            self.applyDiscoveredMaster(master)
                        }
                        .frame(width: fieldWidth, alignment: .leading)
                        .padding(.leading, contentLeading)

                        DisclosureGroup("Advanced") {
                            VStack(alignment: .leading, spacing: 8) {
                                LabeledContent("Identity file") {
                                    TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: fieldWidth)
                                }
                                LabeledContent("Project root") {
                                    TextField("/home/you/Projects/clawdis", text: self.$state.remoteProjectRoot)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: fieldWidth)
                                }
                            }
                            .padding(.top, 4)
                        }

                        Text("Tip: enable Tailscale so your remote Clawdis stays reachable.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private func anthropicAuthPage() -> some View {
        self.onboardingPage {
            Text("Connect Claude")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Optional, but recommended: authenticate via Claude (Anthropic) so Pi can answer immediately. " +
                    "Clawdis will always pass --provider/--model when invoking Pi.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 16) {
                HStack(alignment: .center, spacing: 10) {
                    Circle()
                        .fill(self.anthropicAuthConnected ? Color.green : Color.orange)
                        .frame(width: 10, height: 10)
                    Text(self.anthropicAuthConnected ? "Anthropic OAuth connected" : "Not connected yet")
                        .font(.headline)
                    Spacer()
                }

                Text(
                    "This writes Pi-compatible credentials to `~/.pi/agent/oauth.json` (owner-only). " +
                        "You can redo this anytime.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 12) {
                    Text(PiOAuthStore.oauthURL().path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer()

                    Button("Reveal") {
                        NSWorkspace.shared.activateFileViewerSelecting([PiOAuthStore.oauthURL()])
                    }
                    .buttonStyle(.bordered)

                    Button("Refresh") {
                        self.refreshAnthropicOAuthStatus()
                    }
                    .buttonStyle(.bordered)
                }

                Divider().padding(.vertical, 2)

                HStack(spacing: 12) {
                    Button {
                        self.startAnthropicOAuth()
                    } label: {
                        if self.anthropicAuthBusy {
                            ProgressView()
                        } else {
                            Text("Open Claude login (OAuth)")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.anthropicAuthBusy)

                    Button("Skip for now") {
                        self.anthropicAuthStatus = "Skipped. The agent may not respond until you authenticate."
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.anthropicAuthBusy)
                }

                if self.anthropicAuthPKCE != nil {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Paste `code#state`")
                            .font(.headline)
                        TextField("code#state", text: self.$anthropicAuthCode)
                            .textFieldStyle(.roundedBorder)

                        Button("Finish connection") {
                            Task { await self.finishAnthropicOAuth() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(
                            self.anthropicAuthBusy ||
                                self.anthropicAuthCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

                self.onboardingCard(spacing: 8, padding: 12) {
                    Text("API key (advanced)")
                        .font(.headline)
                    Text(
                        "You can also use an Anthropic API key, but this is instructions-only for now " +
                            "(GUI-launched processes don’t automatically inherit your shell env vars).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .shadow(color: .clear, radius: 0)
                .background(Color.clear)

                if let status = self.anthropicAuthStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func startAnthropicOAuth() {
        guard !self.anthropicAuthBusy else { return }
        self.anthropicAuthBusy = true
        defer { self.anthropicAuthBusy = false }

        do {
            let pkce = try AnthropicOAuth.generatePKCE()
            self.anthropicAuthPKCE = pkce
            let url = AnthropicOAuth.buildAuthorizeURL(pkce: pkce)
            NSWorkspace.shared.open(url)
            self.anthropicAuthStatus = "Opened browser. After approving, paste the `code#state` here."
        } catch {
            self.anthropicAuthStatus = "Failed to start OAuth: \(error.localizedDescription)"
        }
    }

    @MainActor
    private func finishAnthropicOAuth() async {
        guard !self.anthropicAuthBusy else { return }
        guard let pkce = self.anthropicAuthPKCE else { return }
        self.anthropicAuthBusy = true
        defer { self.anthropicAuthBusy = false }

        let trimmed = self.anthropicAuthCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let splits = trimmed.split(separator: "#", maxSplits: 1).map(String.init)
        let code = splits.first ?? ""
        let state = splits.count > 1 ? splits[1] : ""

        do {
            let creds = try await AnthropicOAuth.exchangeCode(code: code, state: state, verifier: pkce.verifier)
            try PiOAuthStore.saveAnthropicOAuth(creds)
            self.refreshAnthropicOAuthStatus()
            self.anthropicAuthStatus = "Connected. Pi can now use Claude via Anthropic OAuth."
        } catch {
            self.anthropicAuthStatus = "OAuth failed: \(error.localizedDescription)"
        }
    }

    private func refreshAnthropicOAuthStatus() {
        self.anthropicAuthConnected = PiOAuthStore.hasAnthropicOAuth()
    }

    private func identityPage() -> some View {
        self.onboardingPage {
            Text("Identity")
                .font(.largeTitle.weight(.semibold))
            Text("Name your agent, pick a theme, and we’ll suggest an emoji.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 12, padding: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Agent name")
                        .font(.headline)
                    TextField("Samantha", text: self.$identityName)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Theme")
                        .font(.headline)
                    TextField("space lobster", text: self.$identityTheme)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Emoji")
                        .font(.headline)
                    HStack(spacing: 12) {
                        TextField("🦞", text: self.$identityEmoji)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)

                        Button("Suggest") {
                            let suggested = AgentIdentityEmoji.suggest(theme: self.identityTheme)
                            self.identityEmoji = suggested
                        }
                        .buttonStyle(.bordered)
                    }
                }

                Divider().padding(.vertical, 2)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Workspace")
                        .font(.headline)
                    Text(self.workspacePath.isEmpty ? AgentWorkspace
                        .displayPath(for: ClawdisConfigFile.defaultWorkspaceURL()) : self.workspacePath)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await self.applyIdentity() }
                    } label: {
                        if self.identityApplying {
                            ProgressView()
                        } else {
                            Text("Save identity")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.identityApplying || self.identityName.trimmingCharacters(in: .whitespacesAndNewlines)
                        .isEmpty)

                    Button("Open workspace") {
                        let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                        NSWorkspace.shared.open(url)
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.identityApplying)
                }

                Text(
                    "This writes your identity to `~/.clawdis/clawdis.json` and into `AGENTS.md` " +
                        "inside the workspace. " +
                        "Treat that workspace as the agent’s “memory” and consider making it a (private) git " +
                        "repo.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let status = self.identityStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func gatewayPage() -> some View {
        self.onboardingPage {
            Text("Install the gateway")
                .font(.largeTitle.weight(.semibold))
            Text(
                """
                Clawdis now runs the WebSocket gateway from the global "clawdis" package.
                Install/update it here and we’ll check Node for you.
                """)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10, padding: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(self.gatewayStatusColor)
                            .frame(width: 10, height: 10)
                        Text(self.gatewayStatus.message)
                            .font(.callout.weight(.semibold))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if let gatewayVersion = self.gatewayStatus.gatewayVersion,
                       let required = self.gatewayStatus.requiredGateway,
                       gatewayVersion != required
                    {
                        Text("Installed: \(gatewayVersion) · Required: \(required)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let gatewayVersion = self.gatewayStatus.gatewayVersion {
                        Text("Gateway \(gatewayVersion) detected")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if let node = self.gatewayStatus.nodeVersion {
                        Text("Node \(node)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 12) {
                        Button {
                            Task { await self.installGateway() }
                        } label: {
                            if self.gatewayInstalling {
                                ProgressView()
                            } else {
                                Text("Install / Update gateway")
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.gatewayInstalling)

                        Button("Recheck") { self.refreshGatewayStatus() }
                            .buttonStyle(.bordered)
                            .disabled(self.gatewayInstalling)
                    }

                    if let gatewayInstallMessage {
                        Text(gatewayInstallMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else {
                        Text(
                            "Uses \"npm install -g clawdis@<version>\" on your PATH. " +
                                "We keep the gateway on port 18789.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    // swiftlint:disable:next inclusive_language
    private func applyDiscoveredMaster(_ master: MasterDiscoveryModel.DiscoveredMaster) {
        let host = master.tailnetDns ?? master.lanHost
        guard let host else { return }
        let user = NSUserName()
        var target = "\(user)@\(host)"
        if master.sshPort != 22 {
            target += ":\(master.sshPort)"
        }
        self.state.remoteTarget = target
    }

    private func permissionsPage() -> some View {
        self.onboardingPage {
            Text("Grant permissions")
                .font(.largeTitle.weight(.semibold))
            Text("Approve these once and the helper CLI reuses the same grants.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard {
                ForEach(Capability.allCases, id: \.self) { cap in
                    PermissionRow(capability: cap, status: self.permissionMonitor.status[cap] ?? false) {
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

    private func cliPage() -> some View {
        self.onboardingPage {
            Text("Install the helper CLI")
                .font(.largeTitle.weight(.semibold))
            Text("Link `clawdis-mac` so scripts and the agent can talk to this app.")
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
                        if self.installingCLI {
                            ProgressView()
                        } else {
                            Text(self.cliInstalled ? "Reinstall helper" : "Install helper")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.installingCLI)

                    Button(self.copied ? "Copied" : "Copy dev link") {
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
                        We install into /usr/local/bin and /opt/homebrew/bin.
                        Rerun anytime if you move the build output.
                        """)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func workspacePage() -> some View {
        self.onboardingPage {
            Text("Agent workspace")
                .font(.largeTitle.weight(.semibold))
            Text(
                """
                Clawdis runs the agent from a dedicated workspace so it can load AGENTS.md
                and write files without touching your other folders.
                """)
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
                            AgentWorkspace.displayPath(for: ClawdisConfigFile.defaultWorkspaceURL()),
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
                                let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
                                ClawdisConfigFile.setInboundWorkspace(AgentWorkspace.displayPath(for: url))
                                self.workspaceStatus = "Saved to ~/.clawdis/clawdis.json (inbound.workspace)"
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
                                "For backup, make the workspace a (private) git repo so Clawd’s “memory” is versioned.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    private func whatsappPage() -> some View {
        self.onboardingPage {
            Text("Link WhatsApp or Telegram")
                .font(.largeTitle.weight(.semibold))
            Text(
                """
                WhatsApp uses a QR login for your personal account. Telegram uses a bot token.
                Either (or both) is fine; configure them where the gateway runs.
                """)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard {
                self.featureRow(
                    title: "Open a terminal",
                    subtitle: "Use the same host selected above. If remote, SSH in first.",
                    systemImage: "terminal")

                Text("WhatsApp")
                    .font(.headline)
                self.featureRow(
                    title: "Run `clawdis login --verbose`",
                    subtitle: """
                    Scan the QR code with WhatsApp on your phone.
                    We only use your personal session; no cloud gateway involved.
                    """,
                    systemImage: "qrcode.viewfinder")
                self.featureRow(
                    title: "Re-link after timeouts",
                    subtitle: """
                    If Baileys auth expires, re-run login on that host.
                    Settings → General shows remote/local mode so you know where to run it.
                    """,
                    systemImage: "clock.arrow.circlepath")

                Divider()
                    .padding(.vertical, 6)

                Text("Telegram")
                    .font(.headline)
                self.featureRow(
                    title: "Set `TELEGRAM_BOT_TOKEN`",
                    subtitle: """
                    Create a bot with @BotFather and set the token as an env var
                    (or `telegram.botToken` in `~/.clawdis/clawdis.json`).
                    """,
                    systemImage: "key")
                self.featureRow(
                    title: "Verify with `clawdis status --deep`",
                    subtitle: "This probes both WhatsApp and the Telegram API and prints what’s configured.",
                    systemImage: "checkmark.shield")
            }
        }
    }

    private func readyPage() -> some View {
        self.onboardingPage {
            Text("All set")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                self.featureRow(
                    title: "Run the dashboard",
                    subtitle: """
                    Use the CLI helper from your scripts, and reopen onboarding from Settings
                    if you add a new user.
                    """,
                    systemImage: "checkmark.seal")
                self.featureRow(
                    title: "Try Voice Wake",
                    subtitle: "Enable Voice Wake in Settings for hands-free commands with a live transcript overlay.",
                    systemImage: "waveform.circle")
                self.featureRow(
                    title: "Use the panel + Canvas",
                    subtitle: "Open the menu bar panel for quick chat; the agent can show previews " +
                        "and richer visuals in Canvas.",
                    systemImage: "rectangle.inset.filled.and.person.filled")
                self.featureRow(
                    title: "Test a notification",
                    subtitle: "Send a quick notify via the menu bar to confirm sounds and permissions.",
                    systemImage: "bell.badge")
                self.featureActionRow(
                    title: "Give your agent more powers",
                    subtitle: "Install optional tools (Peekaboo, oracle, camsnap, …) from Settings → Tools.",
                    systemImage: "wrench.and.screwdriver")
                {
                    self.openSettings(tab: .tools)
                }
                Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                    .onChange(of: self.state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
            }
        }
    }

    private func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var navigationBar: some View {
        HStack(spacing: 20) {
            ZStack(alignment: .leading) {
                Button(action: {}, label: {
                    Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
                })
                .buttonStyle(.plain)
                .opacity(0)
                .disabled(true)

                if self.currentPage > 0 {
                    Button(action: self.handleBack, label: {
                        Label("Back", systemImage: "chevron.left")
                            .labelStyle(.iconOnly)
                    })
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
                    .opacity(0.8)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .frame(minWidth: 80, alignment: .leading)

            Spacer()

            HStack(spacing: 8) {
                ForEach(0..<self.pageCount, id: \.self) { index in
                    Button {
                        withAnimation { self.currentPage = index }
                    } label: {
                        Circle()
                            .fill(index == self.currentPage ? Color.accentColor : Color.gray.opacity(0.3))
                            .frame(width: 8, height: 8)
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()

            Button(action: self.handleNext) {
                Text(self.buttonTitle)
                    .frame(minWidth: 88)
            }
            .keyboardShortcut(.return)
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 24)
        .frame(height: 60)
    }

    private func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(spacing: 22) {
            content()
            Spacer()
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, alignment: .top)
    }

    private func onboardingCard(
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3))
    }

    private func featureRow(title: String, subtitle: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func featureActionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Open Settings → Tools", action: action)
                    .buttonStyle(.link)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
    }

    private func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    private func handleNext() {
        if self.currentPage < self.pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "clawdis.onboardingSeen")
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        OnboardingController.shared.close()
    }

    @MainActor
    private func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    @MainActor
    private func request(_ cap: Capability) async {
        guard !self.isRequesting else { return }
        self.isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshPerms()
    }

    private func updatePermissionMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.permissionsPageIndex
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    private func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == self.connectionPageIndex
        let shouldMonitor = isConnectionPage && self.state.connectionMode == .remote
        if shouldMonitor, !self.monitoringDiscovery {
            self.monitoringDiscovery = true
            self.masterDiscovery.start()
        } else if !shouldMonitor, self.monitoringDiscovery {
            self.monitoringDiscovery = false
            self.masterDiscovery.stop()
        }
    }

    private func updateMonitoring(for pageIndex: Int) {
        self.updatePermissionMonitoring(for: pageIndex)
        self.updateDiscoveryMonitoring(for: pageIndex)
        self.updateAuthMonitoring(for: pageIndex)
    }

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }

    private func stopDiscovery() {
        guard self.monitoringDiscovery else { return }
        self.monitoringDiscovery = false
        self.masterDiscovery.stop()
    }

    private func updateAuthMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.anthropicAuthPageIndex && self.state.connectionMode == .local
        if shouldMonitor, !self.monitoringAuth {
            self.monitoringAuth = true
            self.startAuthMonitoring()
        } else if !shouldMonitor, self.monitoringAuth {
            self.stopAuthMonitoring()
        }
    }

    private func startAuthMonitoring() {
        self.refreshAnthropicOAuthStatus()
        self.authMonitorTask?.cancel()
        self.authMonitorTask = Task {
            while !Task.isCancelled {
                await MainActor.run { self.refreshAnthropicOAuthStatus() }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func stopAuthMonitoring() {
        self.monitoringAuth = false
        self.authMonitorTask?.cancel()
        self.authMonitorTask = nil
    }

    private func installCLI() async {
        guard !self.installingCLI else { return }
        self.installingCLI = true
        defer { installingCLI = false }
        await CLIInstaller.install { message in
            await MainActor.run { self.cliStatus = message }
        }
        self.refreshCLIStatus()
    }

    private func refreshCLIStatus() {
        let installLocation = CLIInstaller.installedLocation()
        self.cliInstallLocation = installLocation
        self.cliInstalled = installLocation != nil
    }

    private func refreshGatewayStatus() {
        self.gatewayStatus = GatewayEnvironment.check()
    }

    private func installGateway() async {
        guard !self.gatewayInstalling else { return }
        self.gatewayInstalling = true
        defer { self.gatewayInstalling = false }
        self.gatewayInstallMessage = nil
        let expected = GatewayEnvironment.expectedGatewayVersion()
        await GatewayEnvironment.installGlobal(version: expected) { message in
            Task { @MainActor in self.gatewayInstallMessage = message }
        }
        self.refreshGatewayStatus()
    }

    private var gatewayStatusColor: Color {
        switch self.gatewayStatus.kind {
        case .ok: .green
        case .checking: .secondary
        case .missingNode, .missingGateway, .incompatible, .error: .orange
        }
    }

    private func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }

    private func loadWorkspaceDefaults() {
        guard self.workspacePath.isEmpty else { return }
        let configured = ClawdisConfigFile.inboundWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        self.workspacePath = AgentWorkspace.displayPath(for: url)
    }

    private func loadIdentityDefaults() {
        guard self.identityName.isEmpty, self.identityTheme.isEmpty, self.identityEmoji.isEmpty else { return }
        if let identity = ClawdisConfigFile.loadIdentity() {
            self.identityName = identity.name
            self.identityTheme = identity.theme
            self.identityEmoji = identity.emoji
            return
        }
        self.identityEmoji = AgentIdentityEmoji.suggest(theme: "")
    }

    private var workspaceBootstrapCommand: String {
        let template = AgentWorkspace.defaultTemplate().trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        mkdir -p ~/.clawdis/workspace
        cat > ~/.clawdis/workspace/AGENTS.md <<'EOF'
        \(template)
        EOF
        """
    }

    private func applyWorkspace() async {
        guard !self.workspaceApplying else { return }
        self.workspaceApplying = true
        defer { self.workspaceApplying = false }

        do {
            let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
            _ = try AgentWorkspace.bootstrap(workspaceURL: url)
            self.workspacePath = AgentWorkspace.displayPath(for: url)
            self.workspaceStatus = "Workspace ready at \(self.workspacePath)"
        } catch {
            self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
        }
    }

    private func applyIdentity() async {
        guard !self.identityApplying else { return }
        self.identityApplying = true
        defer { self.identityApplying = false }

        if self.identityName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.identityStatus = "Please enter a name first."
            return
        }

        var identity = AgentIdentity(
            name: self.identityName,
            theme: self.identityTheme,
            emoji: self.identityEmoji)

        if identity.emoji.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            identity.emoji = AgentIdentityEmoji.suggest(theme: identity.theme)
            self.identityEmoji = identity.emoji
        }

        do {
            let workspaceURL = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
            try AgentWorkspace.upsertIdentity(workspaceURL: workspaceURL, identity: identity)
            ClawdisConfigFile.setInboundWorkspace(AgentWorkspace.displayPath(for: workspaceURL))
            ClawdisConfigFile.setIdentity(identity)
            self.identityStatus = "Saved identity to AGENTS.md and ~/.clawdis/clawdis.json"
        } catch {
            self.identityStatus = "Failed to save identity: \(error.localizedDescription)"
        }
    }
}

private struct GlowingClawdisIcon: View {
    let size: CGFloat
    let glowIntensity: Double
    let enableFloating: Bool

    @State private var breathe = false

    init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
        self.size = size
        self.glowIntensity = glowIntensity
        self.enableFloating = enableFloating
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(self.glowIntensity),
                            Color.blue.opacity(self.glowIntensity * 0.6),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .blur(radius: 22)
                .scaleEffect(self.breathe ? 1.12 : 0.95)
                .opacity(0.9)

            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: self.size, height: self.size)
                .clipShape(RoundedRectangle(cornerRadius: self.size * 0.22, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                .scaleEffect(self.breathe ? 1.02 : 1.0)
        }
        .frame(width: self.size + 60, height: self.size + 60)
        .onAppear {
            guard self.enableFloating else { return }
            withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
                self.breathe.toggle()
            }
        }
    }
}
