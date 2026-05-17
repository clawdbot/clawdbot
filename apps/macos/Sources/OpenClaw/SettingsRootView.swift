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
        NavigationSplitView {
            List(selection: self.$selectedTab) {
                ForEach(self.visibleGroups) { group in
                    Section(group.title) {
                        ForEach(group.tabs) { tab in
                            NavigationLink(value: tab) {
                                Label(tab.title, systemImage: tab.systemImage)
                            }
                        }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 240)
        } detail: {
            VStack(alignment: .leading, spacing: 14) {
                if self.isNixMode {
                    self.nixManagedBanner
                }
                self.cachedDetailViews
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, 22)
            .padding(.vertical, 18)
        }
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(SettingsWindowChromeConfigurator())
        .toolbar(removing: .sidebarToggle)
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

    @ViewBuilder
    private func detailView(for tab: SettingsTab) -> some View {
        switch tab {
        case .general:
            GeneralSettings(state: self.state, page: .general, isActive: self.selectedTab == tab)
        case .connection:
            GeneralSettings(state: self.state, page: .connection, isActive: self.selectedTab == tab)
        case .permissions:
            PermissionsSettings(
                status: self.permissionMonitor.status,
                refresh: self.refreshPerms,
                showOnboarding: { DebugActions.restartOnboarding() })
        case .voiceWake:
            VoiceWakeSettings(state: self.state, isActive: self.selectedTab == .voiceWake)
        case .channels:
            ChannelsSettings(isActive: self.selectedTab == tab)
        case .skills:
            SkillsSettings(state: self.state)
        case .cron:
            CronSettings(isActive: self.selectedTab == tab)
        case .execApprovals:
            ExecApprovalsSettings()
        case .sessions:
            SessionsSettings()
        case .instances:
            InstancesSettings(isActive: self.selectedTab == tab)
        case .config:
            ConfigSettings()
        case .debug:
            DebugSettings(state: self.state)
        case .about:
            AboutSettings(updater: self.updater)
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
    static let windowWidth: CGFloat = 960
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
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        self.configureWindow(for: view, coordinator: context.coordinator)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        self.configureWindow(for: nsView, coordinator: context.coordinator)
    }

    private func configureWindow(for view: NSView, coordinator: Coordinator) {
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.styleMask.remove(.fullSizeContentView)
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = true
            window.toolbarStyle = .unifiedCompact
            coordinator.installToolbar(on: window)
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSToolbarDelegate {
        private static let toolbarIdentifier = NSToolbar.Identifier("OpenClawSettingsToolbar")
        private let items: [NSToolbarItem.Identifier] = [
            .toggleSidebar,
            .flexibleSpace,
        ]

        func installToolbar(on window: NSWindow) {
            if window.toolbar?.identifier == Self.toolbarIdentifier {
                return
            }

            let toolbar = NSToolbar(identifier: Self.toolbarIdentifier)
            toolbar.delegate = self
            toolbar.displayMode = .iconOnly
            window.toolbar = toolbar
        }

        func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
            self.items
        }

        func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
            self.items
        }

        func toolbar(
            _ toolbar: NSToolbar,
            itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
            willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem?
        {
            guard itemIdentifier == .toggleSidebar else { return nil }
            let item = NSToolbarItem(itemIdentifier: .toggleSidebar)
            item.label = "Toggle Sidebar"
            item.paletteLabel = "Toggle Sidebar"
            item.toolTip = "Toggle Sidebar"
            item.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Toggle Sidebar")
            item.action = #selector(NSSplitViewController.toggleSidebar(_:))
            item.target = nil
            return item
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
