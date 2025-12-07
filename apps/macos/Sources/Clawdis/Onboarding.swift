import AppKit
import ClawdisIPC
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

struct OnboardingView: View {
    @State private var currentPage = 0
    @State private var isRequesting = false
    @State private var installingCLI = false
    @State private var cliStatus: String?
    @State private var copied = false
    @State private var monitoringPermissions = false
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?
    @ObservedObject private var state = AppStateStore.shared
    @ObservedObject private var permissionMonitor = PermissionMonitor.shared

    private let pageWidth: CGFloat = 640
    private let contentHeight: CGFloat = 340
    private let permissionsPageIndex = 2
    private var pageCount: Int { 6 }
    private var buttonTitle: String { self.currentPage == self.pageCount - 1 ? "Finish" : "Next" }
    private let devLinkCommand = "ln -sf $(pwd)/apps/macos/.build/debug/ClawdisCLI /usr/local/bin/clawdis-mac"

    var body: some View {
        VStack(spacing: 0) {
            GlowingClawdisIcon(size: 156)
                .padding(.top, 20)
                .padding(.bottom, 8)
                .frame(height: 200)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    self.welcomePage().frame(width: self.pageWidth)
                    self.connectionPage().frame(width: self.pageWidth)
                    self.permissionsPage().frame(width: self.pageWidth)
                    self.cliPage().frame(width: self.pageWidth)
                    self.whatsappPage().frame(width: self.pageWidth)
                    self.readyPage().frame(width: self.pageWidth)
                }
                .offset(x: CGFloat(-self.currentPage) * self.pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: self.currentPage)
                .frame(height: self.contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: 260)

            self.navigationBar
        }
        .frame(width: self.pageWidth, height: 560)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.currentPage = 0
            self.updatePermissionMonitoring(for: 0)
        }
        .onChange(of: self.currentPage) { _, newValue in
            self.updatePermissionMonitoring(for: newValue)
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task {
            await self.refreshPerms()
            self.refreshCLIStatus()
        }
    }

    private func welcomePage() -> some View {
        self.onboardingPage {
            Text("Welcome to Clawdis")
                .font(.largeTitle.weight(.semibold))
            Text("Your macOS menu bar companion for notifications, screenshots, and privileged agent actions.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)
            Text("Quick steps with live permission checks and the helper CLI so you can finish setup in minutes.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func connectionPage() -> some View {
        self.onboardingPage {
            Text("Where Clawdis runs")
                .font(.largeTitle.weight(.semibold))
            Text("Pick local or remote. Remote uses SSH; we recommend Tailscale for reliable reachability.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard(spacing: 10, padding: 12) {
                Picker("Mode", selection: self.$state.connectionMode) {
                    Text("Local (this Mac)").tag(AppState.ConnectionMode.local)
                    Text("Remote over SSH").tag(AppState.ConnectionMode.remote)
                }
                .pickerStyle(.segmented)
                .frame(width: 320)

                if self.state.connectionMode == .remote {
                    VStack(alignment: .leading, spacing: 8) {
                        LabeledContent("SSH target") {
                            TextField("user@host[:22]", text: self.$state.remoteTarget)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 260)
                        }

                        DisclosureGroup("Advanced") {
                            VStack(alignment: .leading, spacing: 8) {
                                LabeledContent("Identity file") {
                                    TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: 260)
                                }
                                LabeledContent("Project root") {
                                    TextField("/home/you/Projects/clawdis", text: self.$state.remoteProjectRoot)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: 260)
                                }
                            }
                            .padding(.top, 4)
                        }

                        Text("Tip: keep a Tailscale IP here so the agent stays reachable off-LAN.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
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
                    Button("Refresh status") { Task { await self.refreshPerms() } }
                        .controlSize(.small)
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
                        "We install into /usr/local/bin and /opt/homebrew/bin. Rerun anytime if you move the build output.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func whatsappPage() -> some View {
        self.onboardingPage {
            Text("Link WhatsApp")
                .font(.largeTitle.weight(.semibold))
            Text("Run `clawdis login` where the relay runs (local if local mode, remote if remote). Scan the QR to pair your account.")
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
                self.featureRow(
                    title: "Run `clawdis login --verbose`",
                    subtitle: "Scan the QR code with WhatsApp on your phone. We only use your personal session; no cloud relay involved.",
                    systemImage: "qrcode.viewfinder")
                self.featureRow(
                    title: "Re-link after timeouts",
                    subtitle: "If Baileys auth expires, re-run login on that host. Settings → General shows remote/local mode so you know where to run it.",
                    systemImage: "clock.arrow.circlepath")
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
                    subtitle: "Use the CLI helper from your scripts, and reopen onboarding from "
                        + "Settings if you add a new user.",
                    systemImage: "checkmark.seal")
                self.featureRow(
                    title: "Test a notification",
                    subtitle: "Send a quick notify via the menu bar to confirm sounds and permissions.",
                    systemImage: "bell.badge")
                Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                    .onChange(of: self.state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
            }
            Text("Finish to save this version of onboarding. We'll reshow automatically when steps change.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
        }
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
        .padding(.horizontal, 20)
        .frame(height: 60)
    }

    private func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(spacing: 22) {
            content()
            Spacer()
        }
        .frame(width: self.pageWidth, alignment: .top)
    }

    private func onboardingCard(spacing: CGFloat = 12, padding: CGFloat = 16, @ViewBuilder _ content: () -> some View) -> some View {
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

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
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

    private func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
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
