import AppKit
import Observation
import SwiftUI

struct SettingsRootView: View {
    @Bindable var state: AppState
    private let permissionMonitor = PermissionMonitor.shared
    @State private var monitoringPermissions = false
    @State private var selectedTab: SettingsTab = .general
    @State private var cachedTabs: Set<SettingsTab>
    @State private var snapshotPaths: (configPath: String?, stateDir: String?) = (nil, nil)
    let updater: UpdaterProviding?
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode

    init(state: AppState, updater: UpdaterProviding?, initialTab: SettingsTab? = nil) {
        let initial = initialTab ?? .general
        self.state = state
        self.updater = updater
        self._selectedTab = State(initialValue: initial)
        self._cachedTabs = State(initialValue: [initial])
    }

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebar(
                groups: self.visibleGroups,
                selectedTab: self.$selectedTab)
                .frame(width: SettingsLayout.sidebarWidth)

            self.detailContainer
        }
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(SettingsWindowChromeConfigurator())
        .onReceive(NotificationCenter.default.publisher(for: .openclawSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    self.selectedTab = self.validTab(for: tab)
                }
            }
        }
        .onAppear {
            if let pending = SettingsTabRouter.consumePending() {
                self.selectedTab = self.validTab(for: pending)
            }
            self.cacheSelectedTab()
            self.updatePermissionMonitoring(for: self.selectedTab)
        }
        .onChange(of: self.state.debugPaneEnabled) { _, enabled in
            if !enabled, self.selectedTab == .debug {
                self.selectedTab = .general
            }
        }
        .onChange(of: self.selectedTab) { _, newValue in
            self.cachedTabs.insert(newValue)
            self.updatePermissionMonitoring(for: newValue)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            guard self.selectedTab == .permissions else { return }
            Task { await self.refreshPerms() }
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task {
            guard !self.isPreview else { return }
            await self.refreshPerms()
        }
        .task(id: self.state.connectionMode) {
            guard !self.isPreview else { return }
            await self.refreshSnapshotPaths()
        }
    }

    private var visibleGroups: [SettingsTabGroup] {
        SettingsTabGroup.defaultGroups(showDebug: self.state.debugPaneEnabled)
    }

    private var detailContainer: some View {
        VStack(alignment: .leading, spacing: 14) {
            if self.isNixMode {
                self.nixManagedBanner
            }
            self.cachedDetailViews
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, SettingsLayout.detailHorizontalPadding)
        .padding(.vertical, SettingsLayout.detailVerticalPadding)
    }

    private var cachedDetailTabs: [SettingsTab] {
        let cached = self.cachedTabs.union([self.selectedTab])
        return self.visibleGroups.flatMap(\.tabs).filter { cached.contains($0) }
    }

    private var nixManagedBanner: some View {
        // Prefer gateway-resolved paths; fall back to local env defaults if disconnected.
        let configPath = self.snapshotPaths.configPath ?? OpenClawPaths.configURL.path
        let stateDir = self.snapshotPaths.stateDir ?? OpenClawPaths.stateDirURL.path

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "gearshape.2.fill")
                    .foregroundStyle(.secondary)
                Text("Managed by Nix")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Config: \(configPath)")
                Text("State:  \(stateDir)")
            }
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(Color.gray.opacity(0.12))
        .cornerRadius(10)
    }

    private var cachedDetailViews: some View {
        ZStack(alignment: .topLeading) {
            ForEach(self.cachedDetailTabs) { tab in
                self.detailView(for: tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .opacity(tab == self.selectedTab ? 1 : 0)
                    .allowsHitTesting(tab == self.selectedTab)
                    .disabled(tab != self.selectedTab)
                    .accessibilityHidden(tab != self.selectedTab)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func detailView(for tab: SettingsTab) -> AnyView {
        switch tab {
        case .general:
            AnyView(GeneralSettings(state: self.state, page: .general, isActive: self.selectedTab == tab))
        case .connection:
            AnyView(GeneralSettings(state: self.state, page: .connection, isActive: self.selectedTab == tab))
        case .permissions:
            AnyView(PermissionsSettings(
                status: self.permissionMonitor.status,
                refresh: self.refreshPerms,
                showOnboarding: { DebugActions.restartOnboarding() }))
        case .voiceWake:
            AnyView(VoiceWakeSettings(state: self.state, isActive: self.selectedTab == .voiceWake))
        case .channels:
            AnyView(ChannelsSettings(isActive: self.selectedTab == tab))
        case .skills:
            AnyView(SkillsSettings(state: self.state))
        case .cron:
            AnyView(CronSettings(isActive: self.selectedTab == tab))
        case .execApprovals:
            AnyView(ExecApprovalsSettings())
        case .sessions:
            AnyView(SessionsSettings())
        case .instances:
            AnyView(InstancesSettings(isActive: self.selectedTab == tab))
        case .config:
            AnyView(ConfigSettings())
        case .debug:
            AnyView(DebugSettings(state: self.state))
        case .about:
            AnyView(AboutSettings(updater: self.updater))
        }
    }

    private func validTab(for requested: SettingsTab) -> SettingsTab {
        if requested == .debug, !self.state.debugPaneEnabled { return .general }
        return requested
    }

    private func cacheSelectedTab() {
        self.cachedTabs.insert(self.selectedTab)
    }

    @MainActor
    private func refreshSnapshotPaths() async {
        let paths = await GatewayConnection.shared.snapshotPaths()
        self.snapshotPaths = paths
    }

    @MainActor
    private func refreshPerms() async {
        guard !self.isPreview else { return }
        await self.permissionMonitor.refreshNow()
    }

    private func updatePermissionMonitoring(for tab: SettingsTab) {
        guard !self.isPreview else { return }
        PermissionMonitoringSupport.setMonitoring(tab == .permissions, monitoring: &self.monitoringPermissions)
    }

    private func stopPermissionMonitoring() {
        PermissionMonitoringSupport.stopMonitoring(&self.monitoringPermissions)
    }
}

private struct SettingsSidebar: View {
    let groups: [SettingsTabGroup]
    @Binding var selectedTab: SettingsTab

    var body: some View {
        ZStack(alignment: .topLeading) {
            VisualEffectView(material: .sidebar)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(.white.opacity(0.09), lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.16), radius: 18, x: 0, y: 12)

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(self.groups) { group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(group.title)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)

                            ForEach(group.tabs) { tab in
                                SettingsSidebarRow(
                                    tab: tab,
                                    selected: self.selectedTab == tab)
                                {
                                    self.selectedTab = tab
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
            }
        }
        .padding(.leading, 12)
        .padding(.vertical, 10)
    }
}

private struct SettingsSidebarRow: View {
    let tab: SettingsTab
    let selected: Bool
    let select: () -> Void

    var body: some View {
        Label(self.tab.title, systemImage: self.tab.systemImage)
            .font(.body.weight(.medium))
            .labelStyle(.titleAndIcon)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(self.selected ? Color.white.opacity(0.13) : Color.clear)
            }
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onTapGesture(perform: self.select)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(self.tab.title)
            .accessibilityAddTraits(self.selected ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { self.select() }
    }
}

private struct SettingsTabGroup: Identifiable {
    let title: String
    let tabs: [SettingsTab]

    var id: String {
        self.title
    }

    static func defaultGroups(showDebug: Bool) -> [SettingsTabGroup] {
        var groups = [
            SettingsTabGroup(title: "Basics", tabs: [.general, .connection, .permissions, .voiceWake]),
            SettingsTabGroup(title: "Automation", tabs: [.channels, .skills, .cron, .execApprovals]),
            SettingsTabGroup(title: "Data", tabs: [.sessions, .instances]),
            SettingsTabGroup(title: "Advanced", tabs: [.config]),
            SettingsTabGroup(title: "OpenClaw", tabs: [.about]),
        ]

        if showDebug {
            groups.insert(SettingsTabGroup(title: "Developer", tabs: [.debug]), at: groups.count - 1)
        }

        return groups
    }
}

enum SettingsTab: CaseIterable, Identifiable, Hashable {
    case general, connection, permissions, voiceWake, channels, skills, cron
    case execApprovals, sessions, instances, config, debug, about
    static let windowWidth: CGFloat = 1120
    static let windowHeight: CGFloat = 790

    var id: Self {
        self
    }

    var title: String {
        switch self {
        case .general: "General"
        case .connection: "Connection"
        case .permissions: "Permissions"
        case .voiceWake: "Voice & Talk"
        case .channels: "Channels"
        case .skills: "Skills"
        case .cron: "Cron Jobs"
        case .execApprovals: "Exec Approvals"
        case .sessions: "Sessions"
        case .instances: "Instances"
        case .config: "Config"
        case .debug: "Debug"
        case .about: "About"
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .connection: "point.3.connected.trianglepath.dotted"
        case .permissions: "lock.shield"
        case .voiceWake: "waveform.circle"
        case .channels: "link"
        case .skills: "sparkles"
        case .cron: "calendar.badge.clock"
        case .execApprovals: "terminal"
        case .sessions: "clock.arrow.circlepath"
        case .instances: "network"
        case .config: "slider.horizontal.3"
        case .debug: "ant"
        case .about: "info.circle"
        }
    }
}

private struct SettingsWindowChromeConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        self.configureWindow(for: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        self.configureWindow(for: nsView)
    }

    private func configureWindow(for view: NSView) {
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.styleMask.remove(.fullSizeContentView)
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = true
            window.toolbarStyle = .unifiedCompact
        }
    }
}

@MainActor
enum SettingsTabRouter {
    private static var pending: SettingsTab?

    static func request(_ tab: SettingsTab) {
        self.pending = tab
    }

    static func consumePending() -> SettingsTab? {
        defer { self.pending = nil }
        return self.pending
    }
}

extension Notification.Name {
    static let openclawSelectSettingsTab = Notification.Name("openclawSelectSettingsTab")
}

#if DEBUG
struct SettingsRootView_Previews: PreviewProvider {
    static var previews: some View {
        ForEach(SettingsTab.allCases, id: \.self) { tab in
            SettingsRootView(state: .preview, updater: DisabledUpdaterController(), initialTab: tab)
                .previewDisplayName(tab.title)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        }
    }
}
#endif
