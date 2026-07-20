import OpenClawChatUI
import SwiftUI

struct CommandCenterTab: View {
    static let recentSessionsFetchLimit = 200

    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var defaultChatSessionEntry: OpenClawChatSessionEntry?
    @State private var recentChatSessions: [OpenClawChatSessionEntry] = []
    var ownsNavigationStack: Bool = true
    var usesNativeNavigationChrome: Bool = false
    var headerTitle: String = "OpenClaw"
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var dashboardModel: RootSidebarModel?
    var showsHeaderMark: Bool = true
    var openChat: () -> Void
    var openSettings: () -> Void
    var openSessions: (() -> Void)?
    var openApprovals: (() -> Void)?
    var openAutomations: (() -> Void)?
    var openUsage: (() -> Void)?

    enum WorkRoute {
        case chat(String?)
        case settings
    }

    struct WorkItem: Identifiable {
        let id: String
        let icon: String
        let title: String
        let detail: String
        let state: String
        let trailing: String
        let color: Color
        let progress: Double?
        let route: WorkRoute
        let isUnread: Bool
        let isPinned: Bool
    }

    var body: some View {
        Group {
            if self.ownsNavigationStack {
                NavigationStack {
                    self.content
                }
            } else {
                self.content
            }
        }
        .task(id: self.recentSessionsRefreshID) {
            guard self.dashboardModel == nil else { return }
            await self.refreshRecentSessionsIfNeeded()
        }
    }

    private var content: some View {
        GeometryReader { geometry in
            ZStack {
                CommandControlBackground()
                self.commandAmbientOverlay
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if !self.usesNativeNavigationChrome {
                            self.header
                        }
                        self.gatewayCard
                        self.threadTiles
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        self.attentionCard
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        self.usageSummaryCard
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        if Self.usesSplitSectionsLayout(
                            horizontalSizeClass: self.horizontalSizeClass,
                            containerWidth: geometry.size.width)
                        {
                            HStack(alignment: .top, spacing: 12) {
                                self.defaultChatSessionSection
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                                self.recentSessions
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                            }
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        } else {
                            self.defaultChatSessionSection
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                            self.recentSessions
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                        }
                    }
                    .padding(.top, 18)
                    .padding(.bottom, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
        }
        .navigationTitle(self.headerTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: self.openSettings) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                    }
                    .accessibilityLabel("Gateway settings")
                }
            }
            if self.usesNativeNavigationChrome, let headerSidebarAction {
                ToolbarItem(placement: .topBarTrailing) {
                    OpenClawSidebarRevealButton(action: headerSidebarAction)
                }
            }
        }
    }

    private var threadTiles: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
            self.threadTile(
                title: String(localized: "Sessions"),
                value: self.overviewSessions.count.formatted())
            self.threadTile(
                title: String(localized: "Live"),
                value: self.overviewLiveCount.formatted())
            self.threadTile(
                title: String(localized: "Unread"),
                value: self.overviewUnreadCount.formatted())
            self.threadTile(
                title: String(localized: "Tokens"),
                value: self.overviewTokenText)
        }
    }

    private func threadTile(title: String, value: String) -> some View {
        Button {
            self.openSessions?()
        } label: {
            ProCard(padding: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: value)
                        .font(OpenClawType.headline)
                        .foregroundStyle(OpenClawBrand.accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(verbatim: title)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint(String(localized: "Opens Sessions"))
    }

    @ViewBuilder
    private var attentionCard: some View {
        let approvalCount = self.appModel.pendingExecApprovalCount
        let cronCount = (self.dashboardModel?.failedCronJobCount ?? 0) +
            (self.dashboardModel?.overdueCronJobCount ?? 0)
        if approvalCount > 0 || cronCount > 0 {
            CommandPanel(tint: OpenClawBrand.warn, padding: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    self.cardHeader(title: String(localized: "Attention"))
                    if approvalCount > 0 {
                        self.dashboardActionRow(
                            title: String(localized: "Pending approvals"),
                            value: approvalCount.formatted(),
                            systemImage: "checkmark.shield",
                            action: self.openApprovals ?? self.openSettings)
                    }
                    if cronCount > 0 {
                        self.dashboardActionRow(
                            title: String(localized: "Automation issues"),
                            value: cronCount.formatted(),
                            systemImage: "clock.badge.exclamationmark",
                            action: self.openAutomations ?? {})
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var usageSummaryCard: some View {
        if let usage = self.dashboardModel?.usage {
            Button(action: self.openUsage ?? {}) {
                CommandPanel(padding: 12) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(localized: "31-day usage"))
                                .font(OpenClawType.subheadSemiBold)
                                .foregroundStyle(.primary)
                            Text(self.usageCostText(usage.totalCost))
                                .font(OpenClawType.title3SemiBold)
                                .foregroundStyle(OpenClawBrand.accent)
                        }
                        Spacer(minLength: 8)
                        self.usageTrend(usage.daily ?? [])
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint(String(localized: "Opens Usage"))
        }
    }

    private func dashboardActionRow(
        title: String,
        value: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawBrand.warn)
                Text(verbatim: title)
                    .font(OpenClawType.subheadSemiBold)
                Spacer(minLength: 8)
                Text(verbatim: value)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawBrand.warn)
                Image(systemName: "chevron.right")
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func usageTrend(_ daily: [CostUsageDailyEntryLite]) -> some View {
        let values = daily.suffix(14).map { max(0, $0.totalCost ?? 0) }
        let maximum = values.max() ?? 0
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Capsule()
                    .fill(OpenClawBrand.accent.opacity(0.75))
                    .frame(width: 3, height: maximum > 0 ? max(3, 28 * value / maximum) : 3)
            }
        }
        .frame(height: 30, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func usageCostText(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.currency(code: "USD"))
    }

    private var overviewSessions: [OpenClawChatSessionEntry] {
        if let dashboardModel {
            return Self.visibleOverviewSessions(dashboardModel.sessions)
        }
        return [self.defaultChatSessionEntry].compactMap(\.self) + self.recentChatSessions
    }

    static func visibleOverviewSessions(
        _ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry]
    {
        sessions.filter {
            $0.archived != true && !ChatSessionSidebarModel.isHiddenInternalSession($0.key)
        }
    }

    private var overviewLiveCount: Int {
        self.overviewSessions.count { session in
            session.hasActiveRun == true || session.hasActiveSubagentRun == true ||
                session.status?.lowercased() == "running"
        }
    }

    private var overviewUnreadCount: Int {
        self.overviewSessions.count { $0.unread == true }
    }

    private var overviewTokenText: String {
        let summary = RootSidebarModel.tokenUsageSummary(for: self.overviewSessions)
        guard let total = summary.total else { return "n/a" }
        return "\(summary.isPartial ? "~" : "")\(total.formatted(.number.notation(.compactName)))"
    }

    static func usesSplitSectionsLayout(
        horizontalSizeClass: UserInterfaceSizeClass?,
        containerWidth: CGFloat) -> Bool
    {
        guard horizontalSizeClass == .regular else { return false }
        return containerWidth >= 1000
    }

    static func shouldShowHeaderMark(
        hasLeadingAction: Bool,
        showsHeaderMark: Bool) -> Bool
    {
        !hasLeadingAction && showsHeaderMark
    }

    private var header: some View {
        OpenClawAdaptiveHeaderRow(
            title: .localized(self.headerTitle),
            subtitle: .localized(self.gatewaySubtitle),
            titleFont: OpenClawType.title3SemiBold,
            subtitleFont: OpenClawType.caption,
            subtitleLineLimit: 1)
        {
            if let headerSidebarAction {
                OpenClawSidebarHeaderLeadingSlot(action: headerSidebarAction)
            } else if Self.shouldShowHeaderMark(
                hasLeadingAction: self.headerSidebarAction != nil,
                showsHeaderMark: self.showsHeaderMark)
            {
                OpenClawProMark(size: 28, shadowRadius: 5)
            }
        } accessory: {
            HStack(spacing: 10) {
                Button(action: self.openSettings) {
                    Image(systemName: "gearshape.fill")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(
                            width: OpenClawProMetric.compactControlSize,
                            height: OpenClawProMetric.compactControlSize)
                }
                .openClawGlassButton()
                .accessibilityLabel("Gateway settings")
                .accessibilityHint("Opens gateway settings")
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var commandAmbientOverlay: some View {
        if self.colorScheme == .light {
            LinearGradient(
                colors: [
                    Color.white.opacity(0.05),
                    Color.clear,
                ],
                startPoint: .top,
                endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
    }

    private var gatewayCard: some View {
        CommandPanel(isProminent: true, padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                self.cardHeader(title: "Gateway")

                HStack(spacing: 0) {
                    self.gatewayFact(
                        icon: "network",
                        title: "Connection",
                        value: self.gatewayConnectionText,
                        color: self.gatewayStatusColor)
                    Divider().frame(height: 38)
                    self.gatewayFact(
                        icon: "server.rack",
                        title: "Address",
                        value: self.gatewayAddressText,
                        color: OpenClawBrand.accentForeground)
                    Divider().frame(height: 38)
                    self.gatewayFact(
                        icon: "person.2.fill",
                        title: "Agents",
                        value: self.gatewayAgentCountText,
                        color: OpenClawBrand.accentHotForeground)
                }
                .padding(.vertical, 7)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func gatewayFact(icon: String, title: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(OpenClawType.caption2Bold)
                    .foregroundStyle(color)
                Text(title)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(title == "Connection" ? color : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
    }

    private var defaultChatSessionSection: some View {
        CommandPanel(padding: 12) {
            VStack(spacing: 10) {
                self.cardHeader(title: "Agent session")

                Button {
                    self.openDefaultChatSession()
                } label: {
                    CommandSessionRow(item: self.defaultChatWorkItem)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var recentSessions: some View {
        CommandPanel(padding: 12) {
            VStack(spacing: 10) {
                self.cardHeader(title: "Recent sessions")

                if self.recentSessionPreviewSessions.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.gatewayConnected ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: self.gatewayConnected ? "No recent sessions" : "Gateway offline",
                        detail: self
                            .gatewayConnected ? "Start a chat and it will appear here." : "Connect to the gateway.")
                } else {
                    VStack(spacing: 8) {
                        ForEach(self.recentSessionPreviewSessions) { session in
                            let item = Self.sessionWorkItem(
                                for: session,
                                currentSessionKey: self.appModel.chatSessionKey)
                            Button {
                                self.open(session)
                            } label: {
                                CommandSessionRow(item: item)
                            }
                            .buttonStyle(.plain)
                            .commandSessionActions(
                                session: session,
                                categories: self.sessionCategories,
                                isEnabled: self.sessionControlsAvailable,
                                actions: CommandSessionActions(
                                    rename: { self.patchSession(session, label: .some($0)) },
                                    moveToGroup: { self.patchSession(session, category: .some($0)) },
                                    togglePinned: { self.patchSession(session, pinned: session.pinned != true) },
                                    toggleUnread: { self.patchSession(session, unread: session.unread != true) },
                                    fork: { self.forkSession(session) },
                                    toggleArchived: { self.archiveSession(session) },
                                    delete: { self.deleteSession(session) }))
                        }

                        if self.hasMoreRecentSessions {
                            if let openSessions {
                                Button(action: openSessions) {
                                    CommandViewMoreRow()
                                }
                                .buttonStyle(.plain)
                            } else {
                                NavigationLink {
                                    CommandSessionsScreen(
                                        usesNativeNavigationChrome: self.usesNativeNavigationChrome,
                                        openChat: self.openChat)
                                } label: {
                                    CommandViewMoreRow()
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
    }

    private func cardHeader(title: String) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
        }
    }

    private var gatewayConnected: Bool {
        self.gatewayDisplayState == .connected
    }

    private var gatewayDisplayState: GatewayDisplayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private var gatewayConnectionText: String {
        switch self.gatewayDisplayState {
        case .connected:
            String(localized: "Online")
        case .connecting:
            String(localized: "Connecting")
        case .error:
            String(localized: "Attention")
        case .disconnected:
            String(localized: "Offline")
        }
    }

    private var gatewayStatusColor: Color {
        switch self.gatewayDisplayState {
        case .connected:
            OpenClawBrand.ok
        case .connecting:
            OpenClawBrand.accent
        case .error:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    private var gatewayAddressText: String {
        self.normalized(self.appModel.gatewayRemoteAddress)
            ?? self.normalized(self.appModel.gatewayServerName)
            ?? String(localized: "Unknown")
    }

    private var gatewayAgentCountText: String {
        guard self.gatewayConnected else { return "—" }
        return self.appModel.gatewayAgents.count.formatted()
    }

    private var defaultChatWorkItem: WorkItem {
        let isOpen = self.appModel.chatSessionKey == self.appModel.defaultChatSessionKey
        return WorkItem(
            id: "default-chat",
            icon: isOpen ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
            title: self.appModel.activeAgentName,
            detail: self.defaultChatActivityText,
            state: isOpen ? "open" : "default",
            trailing: "chat",
            color: isOpen ? OpenClawBrand.accent : OpenClawBrand.ok,
            progress: nil,
            route: .chat(nil),
            isUnread: self.effectiveDefaultChatSessionEntry?.unread == true,
            isPinned: self.effectiveDefaultChatSessionEntry?.pinned == true)
    }

    private var defaultChatActivityText: String {
        let activityAt = self.effectiveDefaultChatSessionEntry?.lastActivityAt ??
            self.effectiveDefaultChatSessionEntry?.updatedAt
        guard let activityAt, activityAt > 0 else {
            return String(localized: "No recent activity")
        }
        return Self.relativeTimeText(forMilliseconds: activityAt)
    }

    private var recentSessionPreviewSessions: [OpenClawChatSessionEntry] {
        CommandSessionGrouping.previewSelection(
            self.effectiveRecentChatSessions,
            currentKey: self.appModel.chatSessionKey)
    }

    private var hasMoreRecentSessions: Bool {
        self.effectiveRecentChatSessions.count > self.recentSessionPreviewSessions.count
    }

    private var sessionCategories: [String] {
        CommandSessionGrouping.categories(
            from: self.effectiveRecentChatSessions,
            knownGroups: SessionGroupStore.load())
    }

    private var effectiveDefaultChatSessionEntry: OpenClawChatSessionEntry? {
        guard let sessions = self.dashboardModel?.sessions else { return self.defaultChatSessionEntry }
        let mainKey = ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: self.appModel.defaultChatSessionKey,
            activeAgentID: self.appModel.chatAgentId)
        return sessions.first { $0.key == mainKey } ?? self.defaultChatSessionEntry
    }

    private var effectiveRecentChatSessions: [OpenClawChatSessionEntry] {
        guard let dashboardModel else { return self.recentChatSessions }
        return Self.sessionChoices(
            dashboardModel.sessions,
            defaultSessionKey: self.appModel.defaultChatSessionKey)
    }

    private var sessionControlsAvailable: Bool {
        !self.appModel.isLocalChatFixtureEnabled && self.appModel.isOperatorGatewayConnected
    }

    private var recentSessionsRefreshID: String {
        [
            self.sessionListMode,
            self.appModel.chatSessionKey,
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private var sessionListMode: String {
        self.appModel.chatViewModelIdentityID
    }

    private func open(_ route: WorkRoute, unread: Bool = false) {
        switch route {
        case let .chat(sessionKey):
            self.appModel.openChat(sessionKey: sessionKey, unread: unread)
            self.openChat()
        case .settings:
            self.openSettings()
        }
    }

    private func open(_ session: OpenClawChatSessionEntry) {
        self.open(.chat(session.key), unread: session.unread == true)
    }

    private func openDefaultChatSession() {
        self.open(.chat(nil), unread: self.effectiveDefaultChatSessionEntry?.unread == true)
    }

    private func patchSession(
        _ session: OpenClawChatSessionEntry,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        self.performSessionMutation { transport in
            try await transport.patchSession(
                key: session.key,
                label: label,
                category: category,
                pinned: pinned,
                archived: archived,
                unread: unread)
        }
    }

    private func deleteSession(_ session: OpenClawChatSessionEntry) {
        self.performSessionMutation(resetActiveSessionKey: session.key) { transport in
            try await transport.deleteSession(key: session.key)
        }
    }

    private func archiveSession(_ session: OpenClawChatSessionEntry) {
        self.performSessionMutation(resetActiveSessionKey: session.key) { transport in
            try await transport.patchSession(
                key: session.key,
                label: nil,
                category: nil,
                pinned: nil,
                archived: true,
                unread: nil)
        }
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(parentKey: session.key)
                if let dashboardModel {
                    await dashboardModel.refreshSessions(appModel: self.appModel)
                } else {
                    await self.refreshRecentSessionsIfNeeded()
                }
                self.open(.chat(key))
            } catch {}
        }
    }

    private func performSessionMutation(
        resetActiveSessionKey: String? = nil,
        _ operation: @escaping (any OpenClawChatTransport) async throws -> Void)
    {
        Task {
            do {
                try await operation(self.appModel.makeChatTransport())
                if resetActiveSessionKey == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                if let dashboardModel {
                    await dashboardModel.refreshSessions(appModel: self.appModel)
                } else {
                    await self.refreshRecentSessionsIfNeeded()
                }
            } catch {}
        }
    }

    private func refreshRecentSessionsIfNeeded() async {
        guard self.scenePhase == .active else { return }
        do {
            let roster = try await self.appModel.loadChatSessionRoster(limit: Self.recentSessionsFetchLimit)
            self.applySessions(roster.sessions)
        } catch {
            await self.applyCachedSessions()
        }
    }

    private func applyCachedSessions() async {
        let sessions = await self.appModel.loadCachedChatSessions()
        self.applySessions(sessions)
    }

    private func applySessions(_ sessions: [OpenClawChatSessionEntry]) {
        self.defaultChatSessionEntry = sessions.first {
            $0.key == self.appModel.defaultChatSessionKey
        }
        self.recentChatSessions = Self.sessionChoices(
            sessions,
            defaultSessionKey: self.appModel.defaultChatSessionKey)
    }

    private static func sessionChoices(
        _ sessions: [OpenClawChatSessionEntry],
        defaultSessionKey: String) -> [OpenClawChatSessionEntry]
    {
        sessions.filter {
            self.isRecentChatSession($0.key, defaultSessionKey: defaultSessionKey)
        }
    }

    static func sessionWorkItem(
        for session: OpenClawChatSessionEntry,
        currentSessionKey: String) -> WorkItem
    {
        let isCurrent = session.key == currentSessionKey
        return WorkItem(
            id: "chat-session-\(session.key)",
            icon: isCurrent ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
            title: Self.sessionTitle(session),
            detail: Self.sessionDetail(session),
            state: isCurrent ? "open" : "recent",
            trailing: "chat",
            color: isCurrent ? OpenClawBrand.accent : OpenClawBrand.ok,
            progress: nil,
            route: .chat(session.key),
            isUnread: session.unread == true,
            isPinned: session.pinned == true)
    }

    static func sessionTitle(_ session: OpenClawChatSessionEntry) -> String {
        let label = session.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty {
            return label
        }
        if let title = redactedSessionTitle(for: session.key) {
            return title
        }

        let displayName = session.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let displayName, !displayName.isEmpty {
            return Self.redactedSessionTitle(for: displayName) ?? displayName
        }
        let subject = session.subject?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let subject, !subject.isEmpty {
            return Self.redactedSessionTitle(for: subject) ?? subject
        }
        return session.key
    }

    fileprivate static func redactedSessionTitle(for key: String) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()
        guard !trimmed.isEmpty else { return nil }
        if lowercased.contains(":ios-") {
            return String(localized: "iOS chat")
        }
        if lowercased.hasPrefix("telegram:") {
            return String(localized: "Telegram chat")
        }
        if lowercased.hasPrefix("user:+") {
            return String(localized: "Direct chat")
        }
        if lowercased.hasPrefix("cron:") {
            return Self.humanizedSessionKey(String(trimmed.dropFirst("cron:".count)))
        }
        return nil
    }

    fileprivate static func humanizedSessionKey(_ key: String) -> String? {
        let words = key
            .replacingOccurrences(of: "_", with: "-")
            .split(separator: "-")
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !words.isEmpty else { return nil }

        return words
            .map { word in
                switch word.lowercased() {
                case "ai", "api", "ios", "qmd", "url":
                    word.uppercased()
                default:
                    word.prefix(1).uppercased() + String(word.dropFirst())
                }
            }
            .joined(separator: " ")
    }

    static func sessionDetail(_ session: OpenClawChatSessionEntry) -> String {
        let activityAt = session.lastActivityAt ?? session.updatedAt
        if let activityAt, activityAt > 0 {
            return self.relativeTimeText(forMilliseconds: activityAt)
        }
        return session.key
    }

    static func relativeTimeText(
        forMilliseconds milliseconds: Double,
        relativeTo now: Date = .now) -> String
    {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard now.timeIntervalSince(date) >= 60 else {
            return String(localized: "just now")
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    fileprivate nonisolated static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    nonisolated static func isRecentChatSession(_ key: String, defaultSessionKey: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed == defaultSessionKey { return false }
        let normalized = trimmed.lowercased()
        let defaultBase = self.sessionBaseKey(defaultSessionKey)
        if !normalized.contains(":"),
           self.isDirectSessionBase(normalized, defaultBase: defaultBase)
        {
            return false
        }
        if self.isHiddenInternalSession(trimmed) { return false }
        return !self.isAgentDeviceSession(trimmed, defaultSessionKey: defaultSessionKey)
    }

    private nonisolated static func isAgentDeviceSession(_ key: String, defaultSessionKey: String) -> Bool {
        let parts = key
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return false }
        guard parts.count == 3 || parts[3].lowercased() == "thread" else { return false }

        let base = String(parts[2]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let defaultKey = self.sessionBaseKey(defaultSessionKey)
        return self.isDirectSessionBase(base, defaultBase: defaultKey)
    }

    private nonisolated static func isDirectSessionBase(_ base: String, defaultBase: String) -> Bool {
        base == defaultBase || base == "main" || base == "global" || base.hasPrefix("node-")
    }

    private nonisolated static func sessionBaseKey(_ key: String) -> String {
        let parts = key
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else {
            return key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        return String(parts[2]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var gatewaySubtitle: String {
        if let server = normalized(appModel.gatewayServerName) {
            return String(
                format: String(localized: "%@ on %@"),
                self.appModel.activeAgentName,
                server)
        }
        if let address = normalized(appModel.gatewayRemoteAddress) {
            return String(
                format: String(localized: "%@ via %@"),
                self.appModel.activeAgentName,
                address)
        }
        return self.appModel.gatewayDisplayStatusText
    }

    private func normalized(_ value: String?) -> String? {
        Self.normalized(value)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct CommandSessionsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    private enum GroupEditor: Equatable {
        case rename(String)
        case create
    }

    /// Group mutations need the full session store, not a recency window.
    private static let groupMemberFetchLimit = 10000

    @State private var sessions: [OpenClawChatSessionEntry] = []
    @State private var isLoading = false
    @State private var loadErrorText: String?
    @State private var showArchived = false
    @State private var knownGroups = SessionGroupStore.load()
    @State private var groupEditor: GroupEditor?
    @State private var groupDraftText = ""
    @State private var groupPendingDelete: String?
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let openChat: () -> Void

    init(
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        openChat: @escaping () -> Void)
    {
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.openChat = openChat
    }

    var body: some View {
        ZStack {
            CommandControlBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !self.usesNativeNavigationChrome {
                        self.header
                    }
                    self.sessionsPanel
                }
                .padding(.top, 16)
                .padding(.bottom, 18)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .task(id: self.refreshID) {
            await self.refreshSessions()
        }
        .alert(self.groupEditorTitle, isPresented: self.groupEditorBinding) {
            TextField("Group name", text: self.$groupDraftText)
                .font(OpenClawType.body)
            Button {
                self.commitGroupEditor()
            } label: {
                Text(self.groupEditor == .create
                    ? LocalizedStringKey("Create")
                    : LocalizedStringKey("Save"))
                    .font(OpenClawType.subheadSemiBold)
            }
            Button(role: .cancel) {
                self.groupEditor = nil
            } label: {
                Text("Cancel")
                    .font(OpenClawType.subheadSemiBold)
            }
        }
        .alert(
            "Delete Group?",
            isPresented: self.groupDeleteBinding,
            presenting: self.groupPendingDelete)
        { group in
            Button(role: .destructive) {
                self.deleteGroup(group)
            } label: {
                Text("Delete Group")
                    .font(OpenClawType.subheadSemiBold)
            }
            Button(role: .cancel) {} label: {
                Text("Cancel")
                    .font(OpenClawType.subheadSemiBold)
            }
        } message: { group in
            Text(verbatim: String(
                format: String(
                    localized: "Sessions in \u{201C}%@\u{201D} move back to Ungrouped."),
                group))
                .font(OpenClawType.caption)
        }
    }

    private var header: some View {
        OpenClawAdaptiveHeaderRow(
            title: "Sessions",
            subtitle: .verbatim(self.headerDetail),
            titleFont: OpenClawType.title2,
            subtitleFont: OpenClawType.captionMedium)
        {
            if let headerSidebarAction {
                OpenClawSidebarHeaderLeadingSlot(action: headerSidebarAction)
            }
        } accessory: {
            EmptyView()
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var sessionsPanel: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(self.showArchived
                        ? LocalizedStringKey("Archived sessions")
                        : LocalizedStringKey("Recent sessions"))
                        .font(OpenClawType.subheadBold)
                    Spacer(minLength: 8)
                    if self.isLoading {
                        ProgressView()
                            .controlSize(.small)
                    }
                    if self.sessionControlsAvailable {
                        Toggle(isOn: self.$showArchived) {
                            Text("Show Archived")
                                .font(OpenClawType.captionMedium)
                        }
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 3)

                if let loadErrorText {
                    CommandEmptyStateRow(
                        icon: "exclamationmark.triangle.fill",
                        title: "Sessions unavailable",
                        detail: .verbatim(loadErrorText))
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                } else if self.visibleSessions.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.appModel
                            .isCommandSessionListAvailable ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: .verbatim(self.emptyTitle),
                        detail: .verbatim(self.appModel
                            .isCommandSessionListAvailable
                            ? self.emptyDetail
                            : String(localized: "Connect to the gateway.")))
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(self.sessionSections) { section in
                            VStack(alignment: .leading, spacing: 6) {
                                if section.showsHeader {
                                    self.sectionHeader(section)
                                }
                                ForEach(section.entries) { session in
                                    self.sessionRow(session)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var headerDetail: String {
        if self.isLoading, self.sessions.isEmpty {
            return self.showArchived
                ? String(localized: "Loading archived sessions")
                : String(localized: "Loading recent sessions")
        }
        let count = self.visibleSessions.count
        if count == 0 {
            return self.emptyTitle
        }
        return String(
            AttributedString(localized: "^[\(count) session](inflect: true)").characters)
    }

    private var visibleSessions: [OpenClawChatSessionEntry] {
        self.sessions
            .filter { CommandCenterTab.isRecentChatSession(
                $0.key,
                defaultSessionKey: self.appModel.defaultChatSessionKey) }
            // Gate on the entry's own archived flag so a stale pre-toggle list can
            // never render active sessions with archived-only actions mid-refresh.
            .filter { self.showArchived ? $0.archived == true : $0.archived != true }
    }

    private var sessionSections: [CommandSessionSection] {
        CommandSessionGrouping.sections(from: self.visibleSessions, knownGroups: self.knownGroups)
    }

    private var sessionCategories: [String] {
        CommandSessionGrouping.categories(from: self.sessions, knownGroups: self.knownGroups)
    }

    private var sessionControlsAvailable: Bool {
        !self.appModel.isLocalChatFixtureEnabled && self.appModel.isOperatorGatewayConnected
    }

    private var emptyTitle: String {
        guard self.appModel.isCommandSessionListAvailable else {
            return String(localized: "Gateway offline")
        }
        return self.showArchived
            ? String(localized: "No archived sessions")
            : String(localized: "No recent sessions")
    }

    private var emptyDetail: String {
        self.showArchived
            ? String(localized: "Archived sessions will appear here.")
            : String(localized: "Start a chat and it will appear here.")
    }

    private var refreshID: String {
        "\(self.appModel.commandSessionListMode):\(self.showArchived)"
    }

    @ViewBuilder
    private func sectionHeader(_ section: CommandSessionSection) -> some View {
        let title = Text(section.title)
            .font(OpenClawType.captionSemiBold)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
        // Group management only applies to custom categories, never the
        // Pinned/Ungrouped built-ins.
        if case let .category(group) = section.id, self.sessionControlsAvailable {
            title.contextMenu {
                self.groupMenu(for: group)
            }
        } else {
            title
        }
    }

    @ViewBuilder
    private func groupMenu(for group: String) -> some View {
        Button {
            self.groupDraftText = group
            self.groupEditor = .rename(group)
        } label: {
            Label("Rename Group…", systemImage: "pencil")
                .font(OpenClawType.subhead)
        }
        Button {
            self.groupDraftText = ""
            self.groupEditor = .create
        } label: {
            Label("New Group…", systemImage: "folder.badge.plus")
                .font(OpenClawType.subhead)
        }
        Button(role: .destructive) {
            self.groupPendingDelete = group
        } label: {
            Label("Delete Group…", systemImage: "trash")
                .font(OpenClawType.subhead)
        }
    }

    private var groupEditorTitle: String {
        self.groupEditor == .create
            ? String(localized: "New Group")
            : String(localized: "Rename Group")
    }

    private var groupEditorBinding: Binding<Bool> {
        Binding(
            get: { self.groupEditor != nil },
            set: { if !$0 { self.groupEditor = nil } })
    }

    private var groupDeleteBinding: Binding<Bool> {
        Binding(
            get: { self.groupPendingDelete != nil },
            set: { if !$0 { self.groupPendingDelete = nil } })
    }

    private func commitGroupEditor() {
        let editor = self.groupEditor
        self.groupEditor = nil
        let name = self.groupDraftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        switch editor {
        case let .rename(group):
            guard name != group else { return }
            self.updateStoredGroups { SessionGroupStore.renaming($0, from: group, to: name) }
            self.patchGroupMembers(group, category: name)
        case .create:
            // Header-created groups start empty: stored-list only, no patches.
            self.updateStoredGroups { SessionGroupStore.adding($0, name) }
        case nil:
            break
        }
    }

    private func deleteGroup(_ group: String) {
        self.groupPendingDelete = nil
        self.updateStoredGroups { SessionGroupStore.removing($0, group) }
        self.patchGroupMembers(group, category: nil)
    }

    private func updateStoredGroups(_ transform: ([String]) -> [String]) {
        let updated = transform(SessionGroupStore.load())
        SessionGroupStore.save(updated)
        self.knownGroups = updated
    }

    /// Reassigns (or clears, when `category` is nil) every member of `group`.
    private func patchGroupMembers(_ group: String, category: String?) {
        self.performMutation { transport in
            // Enumerate every member, not the windowed visible list: archived
            // members must follow a rename so restores land in the new group.
            // The gateway defaults an absent `limit` to 100 rows, so ask for
            // an explicitly high limit to cover the whole store.
            let active = try await transport.listSessions(
                limit: Self.groupMemberFetchLimit,
                archived: false)
            let archived = try await transport.listSessions(
                limit: Self.groupMemberFetchLimit,
                archived: true)
            let members = CommandSessionGrouping.members(
                of: group,
                in: [active.sessions, archived.sessions])
            // Best effort: one failed patch must not abandon the rest of the
            // group; the first error still surfaces via performMutation.
            var firstError: (any Error)?
            for member in members {
                do {
                    try await transport.patchSession(
                        key: member.key,
                        label: nil,
                        category: .some(category),
                        pinned: nil,
                        archived: nil,
                        unread: nil)
                } catch {
                    firstError = firstError ?? error
                }
            }
            if let firstError {
                throw firstError
            }
        }
    }

    private func sessionRow(_ session: OpenClawChatSessionEntry) -> some View {
        let item = CommandCenterTab.sessionWorkItem(
            for: session,
            currentSessionKey: self.appModel.chatSessionKey)
        return Button {
            self.open(session)
        } label: {
            CommandSessionRow(item: item)
        }
        .buttonStyle(.plain)
        .commandSessionActions(
            session: session,
            categories: self.sessionCategories,
            isArchived: session.archived == true,
            isEnabled: self.sessionControlsAvailable,
            actions: CommandSessionActions(
                rename: { self.patchSession(session, label: .some($0)) },
                moveToGroup: { self.patchSession(session, category: .some($0)) },
                togglePinned: { self.patchSession(session, pinned: session.pinned != true) },
                toggleUnread: { self.patchSession(session, unread: session.unread != true) },
                fork: { self.forkSession(session) },
                toggleArchived: { self.toggleArchived(session) },
                delete: { self.deleteSession(session) }))
    }

    private func open(_ session: OpenClawChatSessionEntry) {
        self.openSessionKey(session.key, unread: session.unread == true)
    }

    private func openSessionKey(_ key: String, unread: Bool = false) {
        self.appModel.openChat(sessionKey: key, unread: unread)
        self.dismiss()
        self.openChat()
    }

    private func patchSession(
        _ session: OpenClawChatSessionEntry,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        self.performMutation { transport in
            try await transport.patchSession(
                key: session.key,
                label: label,
                category: category,
                pinned: pinned,
                archived: archived,
                unread: unread)
        }
    }

    private func deleteSession(_ session: OpenClawChatSessionEntry) {
        self.performMutation(resetActiveSessionKey: session.key) { transport in
            try await transport.deleteSession(key: session.key)
        }
    }

    private func toggleArchived(_ session: OpenClawChatSessionEntry) {
        let archivesSession = !self.showArchived && session.archived != true
        self.performMutation(resetActiveSessionKey: archivesSession ? session.key : nil) { transport in
            try await transport.patchSession(
                key: session.key,
                label: nil,
                category: nil,
                pinned: nil,
                archived: archivesSession,
                unread: nil)
        }
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(parentKey: session.key)
                await self.refreshSessions()
                self.openSessionKey(key)
            } catch {
                self.loadErrorText = error.localizedDescription
            }
        }
    }

    private func performMutation(
        resetActiveSessionKey: String? = nil,
        _ operation: @escaping (any OpenClawChatTransport) async throws -> Void)
    {
        Task {
            do {
                try await operation(self.appModel.makeChatTransport())
                if resetActiveSessionKey == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.refreshSessions()
            } catch {
                self.loadErrorText = error.localizedDescription
            }
        }
    }

    private func refreshSessions() async {
        // Pick up groups stored by other surfaces (for example the per-session
        // New Group editor) alongside the fresh session list.
        self.knownGroups = SessionGroupStore.load()
        let requestsArchived = self.showArchived
        self.isLoading = true
        self.loadErrorText = nil
        defer { self.isLoading = false }

        do {
            let roster = try await self.appModel.loadChatSessionRoster(
                limit: CommandCenterTab.recentSessionsFetchLimit,
                archived: requestsArchived)
            guard requestsArchived == self.showArchived else { return }
            self.sessions = roster.sessions
        } catch {
            guard requestsArchived == self.showArchived else { return }
            self.sessions = requestsArchived ? [] : await self.appModel.loadCachedChatSessions()
            self.loadErrorText = self.sessions.isEmpty ? "Try again after the gateway reconnects." : nil
        }
    }
}

extension NodeAppModel {
    fileprivate var isCommandSessionListAvailable: Bool {
        self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected
    }

    fileprivate var commandSessionListMode: String {
        self.chatViewModelIdentityID
    }
}
