import AppKit
import Observation
import SwiftUI

struct SettingsRootView: View {
    @Bindable var state: AppState
    private let permissionMonitor = PermissionMonitor.shared
    @State private var monitoringPermissions = false
    @State private var selectedTab: SettingsTab = .general
    @State private var cachedTabs: Set<SettingsTab>
    @State private var inferenceConfiguration: InferenceConfiguration
    @State private var trackedInferenceGatewayID: String?
    @State private var inferenceRefreshTrigger = InferenceRefreshTrigger.invalidate(UUID())
    @State private var crestodianChatIdentity = UUID()
    @State private var deferredTab: SettingsTab?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var snapshotPaths: (configPath: String?, stateDir: String?) = (nil, nil)
    let updater: UpdaterProviding?
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode

    init(
        state: AppState,
        updater: UpdaterProviding?,
        initialTab: SettingsTab? = nil,
        configuredInferenceModel: String? = nil)
    {
        let initial = initialTab ?? .general
        self.state = state
        self.updater = updater
        self._selectedTab = State(initialValue: initial)
        self._cachedTabs = State(initialValue: [initial])
        self._inferenceConfiguration = State(initialValue: configuredInferenceModel.map {
            .loaded($0)
        } ?? .loading)
        self._trackedInferenceGatewayID = State(initialValue: nil)
        self._deferredTab = State(initialValue: nil)
    }

    var body: some View {
        NavigationSplitView(columnVisibility: self.animatedColumnVisibility) {
            List(selection: self.sidebarSelection) {
                ForEach(self.visibleGroups) { group in
                    Section(group.title) {
                        ForEach(group.tabs) { tab in
                            Label(tab.title, systemImage: tab.systemImage)
                                .tag(tab as SettingsTab?)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(SettingsLayout.sidebarWidth)
        } detail: {
            self.detailContainer
        }
        .navigationSplitViewStyle(.balanced)
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: .openclawSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    self.selectRequestedTab(tab)
                }
            }
        }
        .onAppear {
            if let pending = SettingsTabRouter.consumePending() {
                self.selectRequestedTab(pending)
            } else {
                self.selectRequestedTab(self.selectedTab)
            }
            self.cacheSelectedTab()
            self.updatePermissionMonitoring(for: self.selectedTab)
            self.trackedInferenceGatewayID = MacChatTranscriptCache.currentGatewayID()
        }
        .onChange(of: self.state.debugPaneEnabled) { _, enabled in
            if !enabled, self.selectedTab == .debug {
                self.selectedTab = .general
            }
        }
        .onChange(of: self.inferenceConfiguration) { _, configuration in
            if !CrestodianAvailability.shouldShow(configuredModel: configuration.configuredModel),
               self.selectedTab == .crestodian
            {
                self.selectedTab = .general
            }
        }
        .onChange(of: self.selectedTab) { _, newValue in
            self.cachedTabs.insert(newValue)
            self.updatePermissionMonitoring(for: newValue)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if self.selectedTab == .permissions {
                Task { await self.refreshPerms() }
            }
            self.scheduleInferenceRefresh(clearPrevious: false)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openclawConfigDidChange)) { _ in
            let gatewayID = MacChatTranscriptCache.currentGatewayID()
            let plan = Self.configRefreshPlan(
                selectedTab: self.selectedTab,
                previousGatewayID: self.trackedInferenceGatewayID,
                currentGatewayID: gatewayID)
            self.trackedInferenceGatewayID = gatewayID
            self.scheduleInferenceRefresh(
                clearPrevious: plan.clearsPrevious,
                resetCrestodian: plan.resetsCrestodian)
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task {
            guard !self.isPreview else { return }
            await self.refreshPerms()
        }
        .onChange(of: self.state.connectionMode) { _, _ in
            self.trackedInferenceGatewayID = MacChatTranscriptCache.currentGatewayID()
            self.scheduleInferenceRefresh(clearPrevious: true, resetCrestodian: true)
        }
        .task(id: self.inferenceRefreshTrigger) {
            guard !self.isPreview else { return }
            await self.refreshSnapshotPaths()
            await self.refreshInferenceConfiguration(
                clearPrevious: self.inferenceRefreshTrigger.clearsPrevious)
        }
    }

    private var visibleGroups: [SettingsTabGroup] {
        SettingsTabGroup.defaultGroups(
            showDebug: self.state.debugPaneEnabled,
            showCrestodian: CrestodianAvailability.shouldShow(
                configuredModel: self.inferenceConfiguration.configuredModel))
    }

    private var sidebarSelection: Binding<SettingsTab?> {
        Binding(
            get: { self.selectedTab },
            set: { tab in
                guard let tab else { return }
                self.selectRequestedTab(tab)
            })
    }

    private var animatedColumnVisibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { self.columnVisibility },
            set: { visibility in
                withAnimation(.easeInOut(duration: 0.22)) {
                    self.columnVisibility = visibility
                }
            })
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
        case .crestodian:
            AnyView(CrestodianSettings(
                isActive: self.selectedTab == tab,
                onReplyReceived: {
                    self.scheduleInferenceRefresh(clearPrevious: false)
                })
                .id(self.crestodianChatIdentity))
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

    private func selectRequestedTab(_ requested: SettingsTab) {
        let selection = Self.tabSelection(
            requested: requested,
            showDebug: self.state.debugPaneEnabled,
            inferenceConfiguration: self.inferenceConfiguration)
        self.deferredTab = selection.deferred
        self.selectedTab = selection.selected
    }

    struct TabSelection: Equatable {
        let selected: SettingsTab
        let deferred: SettingsTab?
    }

    static func tabSelection(
        requested: SettingsTab,
        showDebug: Bool,
        inferenceConfiguration: InferenceConfiguration) -> TabSelection
    {
        let showCrestodian = CrestodianAvailability.shouldShow(
            configuredModel: inferenceConfiguration.configuredModel)
        let deferred = requested == .crestodian && !showCrestodian && !inferenceConfiguration.isLoaded
            ? requested
            : nil
        return TabSelection(
            selected: Self.normalizedTab(
                requested,
                showDebug: showDebug,
                showCrestodian: showCrestodian),
            deferred: deferred)
    }

    static func normalizedTab(
        _ requested: SettingsTab,
        showDebug: Bool,
        showCrestodian: Bool) -> SettingsTab
    {
        if requested == .debug, !showDebug {
            return .general
        }
        if requested == .crestodian, !showCrestodian {
            return .general
        }
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
    private func refreshInferenceConfiguration(clearPrevious: Bool) async {
        if clearPrevious {
            self.inferenceConfiguration = .loading
        }
        guard let route = await GatewayConnection.shared.captureRoute() else { return }
        do {
            let model = try await GatewayConnection.shared.configuredInferenceModel(
                ifCurrentRoute: route)
            guard !Task.isCancelled else { return }
            self.inferenceConfiguration = Self.configurationAfterInferenceRefresh(
                current: self.inferenceConfiguration,
                result: .confirmed(model))
            if let deferredTab = self.deferredTab {
                self.selectRequestedTab(deferredTab)
            }
        } catch is CancellationError {
            // A route change or task cancellation must not apply stale gateway state.
        } catch {
            guard !Task.isCancelled else { return }
            // Preserve only route-confirmed truth. If this route has never loaded, stay hidden
            // until app activation, config invalidation, or a route change triggers another probe.
            self.inferenceConfiguration = Self.configurationAfterInferenceRefresh(
                current: self.inferenceConfiguration,
                result: .failed)
        }
    }

    enum InferenceConfiguration: Equatable {
        case loading
        case loaded(String?)

        var configuredModel: String? {
            switch self {
            case .loading: nil
            case let .loaded(model): model
            }
        }

        var isLoaded: Bool {
            if case .loaded = self {
                true
            } else {
                false
            }
        }
    }

    enum InferenceRefreshResult {
        case confirmed(String?)
        case failed
    }

    enum InferenceRefreshTrigger: Equatable {
        case invalidate(UUID)
        case verify(UUID)

        var clearsPrevious: Bool {
            switch self {
            case .invalidate: true
            case .verify: false
            }
        }
    }

    struct ConfigRefreshPlan: Equatable {
        let clearsPrevious: Bool
        let resetsCrestodian: Bool
    }

    static func configRefreshPlan(
        selectedTab: SettingsTab,
        previousGatewayID: String?,
        currentGatewayID: String?) -> ConfigRefreshPlan
    {
        let routeChanged = previousGatewayID != currentGatewayID
        return ConfigRefreshPlan(
            clearsPrevious: routeChanged || selectedTab != .crestodian,
            resetsCrestodian: routeChanged)
    }

    static func configurationAfterInferenceRefresh(
        current: InferenceConfiguration,
        result: InferenceRefreshResult) -> InferenceConfiguration
    {
        switch result {
        case let .confirmed(model): .loaded(model)
        case .failed: current
        }
    }

    private func scheduleInferenceRefresh(clearPrevious: Bool, resetCrestodian: Bool = false) {
        if resetCrestodian {
            // Crestodian sessions are gateway-owned. Re-key the cached detail so a route
            // change cannot send old conversation state to a new endpoint.
            self.crestodianChatIdentity = UUID()
        }
        if clearPrevious {
            // Preserve an active or pending Crestodian request while config truth is revalidated.
            // A confirmed model restores it; a confirmed missing model leaves General selected.
            let requestedTab = self.deferredTab ?? self.selectedTab
            self.inferenceConfiguration = .loading
            self.selectRequestedTab(requestedTab)
        }
        self.inferenceRefreshTrigger = clearPrevious ? .invalidate(UUID()) : .verify(UUID())
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

struct SettingsTabGroup: Identifiable {
    let title: String
    let tabs: [SettingsTab]

    var id: String {
        self.title
    }

    static func defaultGroups(showDebug: Bool, showCrestodian: Bool) -> [SettingsTabGroup] {
        let basicTabs: [SettingsTab] = showCrestodian
            ? [.general, .connection, .permissions, .voiceWake, .crestodian]
            : [.general, .connection, .permissions, .voiceWake]
        var groups = [
            SettingsTabGroup(title: "Basics", tabs: basicTabs),
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
    case general, connection, permissions, voiceWake, crestodian, channels, skills, cron
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
        case .crestodian: "Crestodian"
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
        case .crestodian: "lifepreserver"
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
            SettingsRootView(
                state: .preview,
                updater: DisabledUpdaterController(),
                initialTab: tab,
                configuredInferenceModel: tab == .crestodian ? "openai/gpt-5.5" : nil)
                .previewDisplayName(tab.title)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        }
    }
}
#endif
