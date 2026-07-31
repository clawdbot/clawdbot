import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

struct RootSidebar: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @Bindable var model: RootSidebarModel
    @State private var searchText = ""
    @State private var isSearchActive = false
    @State private var showsPagesEditor = false
    @FocusState private var isSearchFocused: Bool
    @AppStorage("sidebar.pinnedPages") private var pinnedPagesStorage: String = ""
    @AppStorage(RootSidebar.visibleAgentCountKey) private var visibleAgentCount: Int = 1

    let selectedDestination: RootTabs.SidebarDestination
    let isDrawerLayout: Bool
    let isDismissButtonEnabled: Bool
    let selectDestination: (RootTabs.SidebarDestination) -> Void
    let hideSidebar: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            self.brandHeader
            if self.isSearchActive {
                self.searchField
            }
            ScrollView {
                // One 10pt unit everywhere: side insets, section gaps, and
                // the picker card's clearance all match.
                LazyVStack(alignment: .leading, spacing: 10) {
                    self.agentsSection
                    self.pagesSection
                    self.sessionsSection
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
            }
            self.footer
        }
        .foregroundStyle(OpenClawSidebarPalette.text)
        .background(OpenClawSidebarPalette.background)
        .sheet(isPresented: self.$showsPagesEditor) {
            RootSidebarPagesEditor(
                pinnedPages: self.pinnedPages,
                onSelect: { destination in
                    self.showsPagesEditor = false
                    self.selectSidebarDestination(destination)
                },
                onTogglePin: self.togglePinnedPage)
        }
    }

    private var pinnedPages: [RootTabs.SidebarDestination] {
        RootTabs.pinnedSidebarPages(from: self.pinnedPagesStorage)
    }

    private func togglePinnedPage(_ destination: RootTabs.SidebarDestination) {
        var pages = self.pinnedPages
        if let index = pages.firstIndex(of: destination) {
            pages.remove(at: index)
        } else {
            pages.append(destination)
        }
        self.pinnedPagesStorage = RootTabs.pinnedSidebarPagesStorage(pages)
    }

    /// Brand header with compact actions; the gear owns Settings entry
    /// (prototype parity) so the footer stays connection-only.
    private var brandHeader: some View {
        HStack(spacing: 4) {
            HStack(spacing: 8) {
                OpenClawProMark(size: 26, shadowRadius: 2)
                    .accessibilityHidden(true)
                Text(String(localized: "OpenClaw"))
                    .font(OpenClawType.headline)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .lineLimit(1)
            }
            .padding(.leading, 6)

            Spacer(minLength: 4)

            self.headerIconButton(
                systemName: "magnifyingglass",
                label: String(localized: "Search sessions"))
            {
                withAnimation(.easeInOut(duration: 0.15)) {
                    self.isSearchActive.toggle()
                }
                if self.isSearchActive {
                    self.isSearchFocused = true
                } else {
                    self.searchText = ""
                }
            }

            self.headerIconButton(
                systemName: "gearshape",
                label: String(localized: "Settings"))
            {
                self.selectSidebarDestination(.settings)
            }
            .accessibilityIdentifier("RootTabs.Sidebar.Destination.settings")

            if self.isDrawerLayout {
                OpenClawSidebarControlButton(action: self.dismissAction)
                    .allowsHitTesting(self.isDismissButtonEnabled)
                    .accessibilityHidden(!self.isDismissButtonEnabled)
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(OpenClawSidebarPalette.background)
        .overlay(alignment: .bottom) { self.separator }
    }

    private var dismissAction: OpenClawSidebarHeaderAction {
        OpenClawSidebarHeaderAction(
            systemName: "xmark",
            accessibilityLabel: .localized("Hide Sidebar"),
            accessibilityIdentifier: self.isDismissButtonEnabled
                ? RootTabs.sidebarHideButtonAccessibilityIdentifier
                : nil,
            action: self.dismissSidebar)
    }

    /// Prototype-style agent roster: up to `visibleAgentCount` rows inline
    /// (owner setting, default 1) and a switcher menu for the rest.
    @ViewBuilder
    private var agentsSection: some View {
        let agents = self.orderedAgents
        let shownCount = Self.shownAgentCount(configured: self.visibleAgentCount, total: agents.count)
        if !agents.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(agents.prefix(shownCount), id: \.id) { agent in
                    self.agentRow(agent)
                }
                if agents.count > shownCount {
                    self.moreAgentsRow(Array(agents.dropFirst(shownCount)))
                }
            }
            .padding(4)
            .background(.ultraThinMaterial, in: RoundedRectangle(
                cornerRadius: OpenClawProMetric.cardRadius,
                style: .continuous))
        }
    }

    static let visibleAgentCountKey = "sidebar.visibleAgentCount"

    static func shownAgentCount(configured: Int, total: Int) -> Int {
        min(max(configured, 1), max(total, 1))
    }

    /// Selected agent leads; the rest keep the gateway roster order.
    private var orderedAgents: [AgentSummary] {
        let agents = self.appModel.gatewayAgents.filter(\.isSelectableAgent)
        guard let index = agents.firstIndex(where: { $0.id == self.currentAgentID }), index != 0 else {
            return agents
        }
        var ordered = agents
        let selected = ordered.remove(at: index)
        ordered.insert(selected, at: 0)
        return ordered
    }

    private func agentRow(_ agent: AgentSummary) -> some View {
        let isSelected = agent.id == self.currentAgentID
        return Button {
            self.appModel.setSelectedAgentId(agent.id)
        } label: {
            HStack(spacing: 9) {
                ZStack(alignment: .bottomTrailing) {
                    self.agentAvatarBadge(agent, size: 28)
                    if isSelected {
                        Circle()
                            .fill(OpenClawBrand.ok)
                            .frame(width: 8, height: 8)
                            .overlay(Circle().stroke(OpenClawSidebarPalette.background, lineWidth: 1.5))
                    }
                }
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: Self.agentDisplayName(agent))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                    if let model = Self.agentModelLabel(agent) {
                        Text(verbatim: model)
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 4)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .accessibilityValue(isSelected ? String(localized: "Selected") : "")
    }

    private func moreAgentsRow(_ agents: [AgentSummary]) -> some View {
        Menu {
            ForEach(agents, id: \.id) { agent in
                Button {
                    self.appModel.setSelectedAgentId(agent.id)
                } label: {
                    Label {
                        Text(verbatim: Self.agentDisplayName(agent))
                            .font(OpenClawType.subheadSemiBold)
                    } icon: {
                        self.agentMenuAvatarImage(agent)
                            .renderingMode(.original)
                    }
                }
                .accessibilityLabel(Self.agentDisplayName(agent))
            }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "chevron.up.chevron.down")
                    .font(OpenClawType.captionSemiBold)
                    .frame(width: 28)
                Text(String(localized: "More Agents"))
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Spacer(minLength: 4)
            }
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.muted)
    }

    /// Same key order the Agents roster uses for its model subtitles.
    static func agentModelLabel(_ agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["primary", "name", "id", "model"] {
            if let value = (model[key]?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty
            {
                return value
            }
        }
        return nil
    }

    private func headerIconButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: systemName)
                .font(OpenClawType.subheadSemiBold)
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
        .accessibilityLabel(label)
    }

    private var currentAgentID: String {
        let selected = self.appModel.selectedAgentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !selected.isEmpty { return selected }
        return self.appModel.gatewayDefaultAgentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static func agentDisplayName(_ agent: AgentSummary) -> String {
        let name = agent.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? agent.id : name
    }

    static func agentBadge(name: String, identity: [String: AnyCodable]?) -> String {
        AgentIdentityPresentation.badge(
            avatarText: identity?["emoji"]?.value as? String,
            displayName: name)
    }

    private func agentAvatarBadge(_ agent: AgentSummary, size: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(OpenClawSidebarPalette.elevated)
            Text(verbatim: Self.agentBadge(name: Self.agentDisplayName(agent), identity: agent.identity))
                .font(OpenClawType.caption2Bold)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .minimumScaleFactor(0.65)
                .lineLimit(1)
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(OpenClawSidebarPalette.hairline, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private func agentMenuAvatarImage(_ agent: AgentSummary) -> Image {
        let renderer = ImageRenderer(content: self.agentAvatarBadge(agent, size: 24)
            .environment(\.colorScheme, self.colorScheme))
        renderer.scale = self.displayScale
        guard let image = renderer.uiImage else {
            return Image(systemName: "person.crop.circle")
        }
        return Image(uiImage: image)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .accessibilityHidden(true)
            ZStack(alignment: .leading) {
                if self.searchText.isEmpty {
                    Text(String(localized: "Search sessions"))
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .accessibilityHidden(true)
                }
                TextField("", text: self.$searchText)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused(self.$isSearchFocused)
                    .accessibilityLabel(String(localized: "Search sessions"))
            }
            if !self.searchText.isEmpty {
                Button {
                    self.searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Clear session search"))
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 12)
        .background(OpenClawSidebarPalette.elevated, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private var sessionsSection: some View {
        let sections = self.visibleSessionSections
        let selectedSessionKey = self.resolvedSelectedSessionKey
        VStack(alignment: .leading, spacing: 6) {
            if let sessionErrorText = self.model.sessionErrorText {
                Text(verbatim: sessionErrorText)
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawBrand.warn)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
            }
            if self.model.isRefreshing, self.model.sessions.isEmpty {
                self.sessionsHeader(String(localized: "Recent"))
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text(String(localized: "Loading sessions"))
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
                .frame(minHeight: 44)
                .padding(.horizontal, 10)
            } else if sections.isEmpty {
                self.sessionsHeader(String(localized: "Recent"))
                Text(String(localized: "No recent sessions"))
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 10)
            } else {
                ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                    // Sole ungrouped section carries no model title; the web
                    // and apps agree on calling it Recent. New Chat rides the
                    // first header so it lives where sessions live.
                    let title = section.title ?? String(localized: "Recent")
                    if index == 0 {
                        self.sessionsHeader(title)
                    } else {
                        self.sectionTitle(title)
                    }
                    ForEach(self.sessionNodes(for: section)) { node in
                        self.sessionButton(node, selectedSessionKey: selectedSessionKey)
                    }
                }
            }

            Button {
                self.selectSidebarDestination(.sessions)
            } label: {
                Label {
                    Text(String(localized: "All Sessions…"))
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: "rectangle.stack")
                        .font(OpenClawType.subheadSemiBold)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawSidebarPalette.accent)
        }
    }

    private var pagesSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                self.sectionTitle(String(localized: "Pages"))
                Spacer(minLength: 4)
                Button {
                    self.showsPagesEditor = true
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(OpenClawType.captionSemiBold)
                        .frame(width: 40, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .accessibilityLabel(String(localized: "Edit Pages"))
            }
            self.homeRow
            ForEach(self.pinnedPages) { destination in
                self.destinationButton(destination)
            }
        }
    }

    /// Fixed first Pages row like the web "Home": opens the agent's chat and
    /// carries the main session's run/unread state.
    private var homeRow: some View {
        let mainKey = self.resolvedMainSessionKey
        let isSelected = self.selectedDestination == .chat &&
            self.resolvedSelectedSessionKey.caseInsensitiveCompare(mainKey) == .orderedSame
        let mainSession = self.mainSessionEntry
        return Button {
            self.appModel.openChat(sessionKey: mainKey, unread: mainSession?.unread == true)
            self.selectSidebarDestination(.chat)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "house")
                    .font(OpenClawType.subheadSemiBold)
                    .frame(width: 18)
                Text(String(localized: "Home"))
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if mainSession?.hasActiveRun == true {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(OpenClawSidebarPalette.accent)
                } else if mainSession?.unread == true {
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? OpenClawSidebarPalette.accent : OpenClawSidebarPalette.text)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .accessibilityIdentifier("RootTabs.Sidebar.Destination.chat")
        .accessibilityValue(mainSession?.unread == true ? String(localized: "Unread") : "")
    }

    /// Web-parity compact footer: connection state left, Settings gear right.
    private var footer: some View {
        VStack(spacing: 0) {
            self.separator
            HStack(spacing: 4) {
                Button {
                    self.selectSidebarDestination(.gateway)
                } label: {
                    HStack(spacing: 9) {
                        // The agent card owns the healthy status; like the web
                        // footer, a dot appears here only when degraded.
                        if !self.isGatewayConnected {
                            Circle()
                                .fill(self.gatewayStatusColor)
                                .frame(width: 8, height: 8)
                                .accessibilityHidden(true)
                        }
                        Text(verbatim: self.gatewayName)
                            .font(OpenClawType.subheadSemiBold)
                            .lineLimit(1)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.text)
                .accessibilityValue(self.gatewayStatusTitle)

                Spacer(minLength: 4)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .fixedSize(horizontal: false, vertical: true)
        .background(OpenClawSidebarPalette.background)
    }

    /// Alias-aware main lookup: rosters may return namespaced keys
    /// ("agent:<id>:main"), so raw comparison would drop Home's badges.
    private var mainSessionEntry: OpenClawChatSessionEntry? {
        self.model.sessions.first { $0.key == self.resolvedMainSessionKey }
    }

    private var resolvedMainSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.model.sessions,
            currentSessionKey: "main",
            mainSessionKey: self.appModel.defaultChatSessionKey,
            activeAgentID: self.appModel.chatAgentId)
    }

    private var resolvedSelectedSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.model.sessions,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.defaultChatSessionKey,
            activeAgentID: self.appModel.chatAgentId)
    }

    private var visibleSessionSections: [ChatSessionSidebarModel.Section] {
        self.model.sections(
            query: self.searchText,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.defaultChatSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            groups: self.sessionGroups)
    }

    private var sessionCategories: [String] {
        CommandSessionGrouping.categories(from: self.model.sessions, knownGroups: SessionGroupStore.load())
    }

    private var sessionGroups: [OpenClawChatSessionGroup] {
        self.sessionCategories.enumerated().map { offset, name in
            OpenClawChatSessionGroup(name: name, position: offset)
        }
    }

    private func flattened(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Node] {
        nodes.flatMap { [$0] + self.flattened($0.children) }
    }

    private func sessionNodes(for section: ChatSessionSidebarModel.Section) -> [ChatSessionSidebarModel.Node] {
        let nodes = self.flattened(section.nodes)
        guard section.id == "recent", let limit = Self.recentSessionCap(searchText: self.searchText) else {
            return nodes
        }
        return Array(nodes.prefix(limit))
    }

    static func recentSessionCap(searchText: String) -> Int? {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 20 : nil
    }

    private func sessionButton(
        _ node: ChatSessionSidebarModel.Node,
        selectedSessionKey: String) -> some View
    {
        let session = node.session
        let isSelected = session.key == selectedSessionKey
        return Button {
            self.appModel.openChat(sessionKey: session.key, unread: session.unread == true)
            self.selectSidebarDestination(.chat)
        } label: {
            HStack(spacing: 9) {
                ZStack {
                    if node.badges.runningCount > 0 {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(OpenClawSidebarPalette.accent)
                    } else {
                        Image(systemName: "bubble.left")
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(isSelected
                                ? OpenClawSidebarPalette.accent
                                : OpenClawSidebarPalette.muted)
                    }
                }
                .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: CommandCenterTab.sessionTitle(session))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(isSelected
                            ? OpenClawSidebarPalette.accent
                            : OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                    // Web-parity subtitle: the work line (repo/branch) names the
                    // session; recency moves to the trailing metadata slot.
                    if let subtitle = ChatSessionSidebarModel.subtitle(
                        for: session,
                        workSubtitle: ChatSessionSidebarModel.workSubtitle(for: session))
                    {
                        Text(verbatim: subtitle)
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 4)
                Text(verbatim: CommandCenterTab.sessionDetail(session))
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .lineLimit(1)
                if session.unread == true {
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                if session.pinned == true {
                    Image(systemName: "pin.fill")
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.accent)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .commandSessionActions(
            session: session,
            categories: self.sessionCategories,
            isEnabled: self.appModel.isOperatorGatewayConnected,
            canArchive: ChatSessionSidebarModel.canArchiveSession(
                session,
                mainSessionKey: self.resolvedMainSessionKey),
            canDelete: ChatSessionSidebarModel.canDeleteSession(
                key: session.key,
                mainSessionKey: self.resolvedMainSessionKey),
            actions: CommandSessionActions(
                rename: { self.patchSession(session, label: .some($0)) },
                moveToGroup: { self.patchSession(session, category: .some($0)) },
                togglePinned: { self.patchSession(session, pinned: session.pinned != true) },
                toggleUnread: { self.patchSession(session, unread: session.unread != true) },
                fork: { self.forkSession(session) },
                toggleArchived: { self.patchSession(session, archived: true) },
                delete: { self.deleteSession(session) }))
        .accessibilityValue(session.unread == true ? String(localized: "Unread") : "")
    }

    private func destinationButton(_ destination: RootTabs.SidebarDestination) -> some View {
        let isSelected = destination == self.selectedDestination
        let badgeCount = self.badgeCount(for: destination)
        return Button {
            self.selectSidebarDestination(destination)
        } label: {
            HStack(spacing: 0) {
                Label {
                    Text(destination.sidebarTitle)
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                } icon: {
                    Image(systemName: destination.systemImage)
                        .font(OpenClawType.subheadSemiBold)
                }
                Spacer(minLength: 6)
                if badgeCount > 0 {
                    Text(verbatim: badgeCount.formatted())
                        .font(OpenClawType.caption2Bold)
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(OpenClawSidebarPalette.accent, in: Capsule())
                        .accessibilityLabel(String(localized: "Attention"))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? OpenClawSidebarPalette.accent : OpenClawSidebarPalette.text)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .accessibilityIdentifier("RootTabs.Sidebar.Destination.\(destination.rawValue)")
    }

    /// Attention lives on the rows that act on it (prototype parity): pending
    /// approvals surface on Overview, cron issues on Automations.
    private func badgeCount(for destination: RootTabs.SidebarDestination) -> Int {
        switch destination {
        case .overview: self.appModel.pendingExecApprovalCount
        case .cron: self.model.failedCronJobCount + self.model.overdueCronJobCount
        default: 0
        }
    }

    private func sessionsHeader(_ title: String) -> some View {
        HStack(spacing: 4) {
            self.sectionTitle(title)
            Spacer(minLength: 4)
            Button {
                self.appModel.requestNewChat()
                self.selectSidebarDestination(.chat)
            } label: {
                Image(systemName: "plus.bubble")
                    .font(OpenClawType.captionSemiBold)
                    .frame(width: 40, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .disabled(!self.appModel.isOperatorGatewayConnected)
            .accessibilityLabel(String(localized: "New Chat"))
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(verbatim: title.uppercased())
            .font(OpenClawType.caption2Bold)
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .tracking(0.5)
            .padding(.horizontal, 10)
    }

    private var separator: some View {
        Rectangle()
            .fill(OpenClawSidebarPalette.hairline)
            .frame(height: 1 / self.displayScale)
    }

    private var gatewayName: String {
        Self.gatewayName(
            serverName: self.appModel.gatewayServerName,
            remoteAddress: self.appModel.gatewayRemoteAddress)
    }

    static func gatewayName(serverName: String?, remoteAddress: String?) -> String {
        for candidate in [serverName, remoteAddress] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty { return trimmed }
        }
        return String(localized: "Connection")
    }

    private var gatewayStatusTitle: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .error: String(localized: "Needs attention")
        case .disconnected: String(localized: "Offline")
        }
    }

    private var isGatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var gatewayStatusColor: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: OpenClawBrand.ok
        case .connecting: OpenClawBrand.accent
        case .error: OpenClawBrand.warn
        case .disconnected: OpenClawSidebarPalette.muted
        }
    }

    private func patchSession(
        _ session: OpenClawChatSessionEntry,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        Task {
            do {
                try await self.appModel.makeChatTransport().patchSession(
                    key: session.key,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
                if archived == true, session.key == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func deleteSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                try await self.appModel.makeChatTransport().deleteSession(key: session.key)
                if session.key == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(parentKey: session.key)
                self.appModel.openChat(sessionKey: key)
                self.selectSidebarDestination(.chat)
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func selectSidebarDestination(_ destination: RootTabs.SidebarDestination) {
        self.isSearchFocused = false
        self.selectDestination(destination)
    }

    private func dismissSidebar() {
        self.isSearchFocused = false
        self.hideSidebar()
    }
}

/// Web-parity Pages editor (the pen menu): navigate to any page, pin/unpin
/// which ones stay in the sidebar. Home is fixed and not listed.
struct RootSidebarPagesEditor: View {
    let pinnedPages: [RootTabs.SidebarDestination]
    let onSelect: (RootTabs.SidebarDestination) -> Void
    let onTogglePin: (RootTabs.SidebarDestination) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(RootTabs.pinnableSidebarPages) { destination in
                        self.pageRow(destination)
                    }
                } footer: {
                    Text("Pinned pages stay in the sidebar. Home is always shown.")
                        .font(OpenClawType.caption)
                }
            }
            .navigationTitle(String(localized: "Pages"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text(String(localized: "Done"))
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
            }
        }
        .openClawSheetChrome()
    }

    private func pageRow(_ destination: RootTabs.SidebarDestination) -> some View {
        let isPinned = self.pinnedPages.contains(destination)
        return HStack(spacing: 10) {
            Button {
                self.onSelect(destination)
            } label: {
                Label {
                    Text(destination.sidebarTitle)
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: destination.systemImage)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                self.onTogglePin(destination)
            } label: {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(isPinned ? OpenClawBrand.accent : Color.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(destination.sidebarTitle)
            .accessibilityValue(
                isPinned
                    ? String(localized: "Pinned")
                    : String(localized: "Not pinned"))
        }
    }
}
