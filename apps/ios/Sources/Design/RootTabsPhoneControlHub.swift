import OpenClawProtocol
import SwiftUI

struct RootTabsPhoneControlHub: View {
    @Environment(NodeAppModel.self) private var appModel

    let groups: [RootTabs.SidebarGroup]
    let initialDestination: RootTabs.SidebarDestination?
    let navigationRequest: RootTabs.PhoneControlNavigationRequest?
    let openRootDestination: (RootTabs.SidebarDestination) -> Void
    let openChatFromControlDetail: (RootTabs.SidebarDestination) -> Void

    @State private var navigationPath: [RootTabs.SidebarDestination] = []
    @State private var didApplyInitialDestination = false
    @State private var handledNavigationRequestID = 0

    var body: some View {
        NavigationStack(path: self.$navigationPath) {
            List {
                Section {
                    self.gatewayHeader
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section {
                    self.chatTalkRow
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section {
                    ForEach(self.phoneDestinations) { destination in
                        self.destinationRow(destination)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Control")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: RootTabs.SidebarDestination.self) { destination in
                self.detail(for: destination)
            }
            .onAppear {
                self.applyInitialDestinationIfNeeded()
                self.applyNavigationRequestIfNeeded()
            }
            .onChange(of: self.navigationRequest) { _, _ in
                self.applyNavigationRequestIfNeeded()
            }
        }
    }

    private var gatewayHeader: some View {
        Button {
            self.openGatewayDetail()
        } label: {
            HStack(spacing: 12) {
                OpenClawProMark(size: 44, shadowRadius: 5)
                VStack(alignment: .leading, spacing: 3) {
                    self.gatewayIdentityTitle
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HStack(spacing: 4) {
                        Text(self.sidebarActiveAgentTitle)
                        Text("•")
                            .accessibilityHidden(true)
                        Text(self.gatewayStateText)
                            .foregroundStyle(self.gatewayStateColor)
                    }
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .background(Color.primary.opacity(0.06), in: Circle())
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(self.gatewayAccessibilityLabel)
        .accessibilityHint("Opens Settings / Gateway")
    }

    private var chatTalkRow: some View {
        // Chat and Talk intentionally stay as Control shortcuts even though they own root tabs.
        // These are the hub's primary actions; the remaining destination list filters root tabs.
        HStack(alignment: .top, spacing: 12) {
            self.prominentDestinationCard(
                .chat,
                subtitle: "Agent chat and recent work.")
            self.prominentDestinationCard(
                .talk,
                subtitle: "Realtime voice and controls.")
        }
    }

    private func prominentDestinationCard(
        _ destination: RootTabs.SidebarDestination,
        subtitle: LocalizedStringKey) -> some View
    {
        Button {
            self.openPhoneRootDestination(destination)
        } label: {
            ProCard(padding: 16, radius: OpenClawProMetric.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    ControlCircleIcon(
                        systemName: destination.systemImage,
                        color: self.color(for: destination),
                        size: 46)
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(destination.title)
                                .font(OpenClawType.headline)
                                .foregroundStyle(.primary)
                            Text(subtitle)
                                .font(OpenClawType.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(OpenClawType.caption2Bold)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 128, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func destinationRow(_ destination: RootTabs.SidebarDestination) -> some View {
        NavigationLink(value: destination) {
            self.rowLabel(destination)
        }
    }

    private func rowLabel(_ destination: RootTabs.SidebarDestination) -> some View {
        Label {
            Text(destination.title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.primary)
        } icon: {
            ControlCircleIcon(
                systemName: destination.systemImage,
                color: self.color(for: destination),
                size: 34)
        }
    }

    @ViewBuilder
    private func detail(for destination: RootTabs.SidebarDestination) -> some View {
        switch destination {
        case .chat, .talk, .agents:
            EmptyView()
        case .gateway:
            SettingsProTab(directRoute: .gateway)
        case .overview:
            CommandCenterTab(
                ownsNavigationStack: false,
                usesNativeNavigationChrome: true,
                headerTitle: "Overview",
                showsHeaderMark: false,
                openChat: { self.openChatFromControlDetail(.overview) },
                openSettings: { self.openGatewayDetail() },
                openSessions: { self.navigationPath.append(.sessions) })
        case .activity:
            IPadActivityScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openChatFromControlDetail(.activity) },
                openSettings: { self.openGatewayDetail() })
        case .workboard:
            IPadWorkboardScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openChatFromControlDetail(.workboard) },
                openSettings: { self.openGatewayDetail() })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                usesNativeNavigationChrome: true,
                openSettings: { self.openGatewayDetail() })
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerTitle: "Instances",
                openSettings: { self.openGatewayDetail() })
        case .sessions:
            CommandSessionsScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openChatFromControlDetail(.sessions) })
        case .files:
            AgentProTab(
                directRoute: .files,
                headerTitle: "Files",
                openSettings: { self.openGatewayDetail() })
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerTitle: "Dreaming",
                openSettings: { self.openGatewayDetail() })
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerTitle: "Usage",
                openSettings: { self.openGatewayDetail() })
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerTitle: "Automations",
                openSettings: { self.openGatewayDetail() })
        case .terminal:
            TerminalHubScreen(
                usesNativeNavigationChrome: true,
                gatewayAction: { self.openGatewayDetail() })
        case .docs:
            OpenClawDocsScreen(
                usesNativeNavigationChrome: true,
                gatewayAction: { self.openGatewayDetail() })
        case .settings:
            EmptyView()
        }
    }

    /// Gateway settings open as a pushed detail on this stack so Back returns
    /// to the hub screen the user came from, not the canonical Settings tab.
    private func openGatewayDetail() {
        self.navigationPath.append(.gateway)
    }

    private func openPhoneRootDestination(_ destination: RootTabs.SidebarDestination) {
        self.navigationPath.removeAll()
        self.openRootDestination(destination)
    }

    private func opensRootTab(_ destination: RootTabs.SidebarDestination) -> Bool {
        RootTabs.shouldOpenRootTabFromPhoneHub(destination)
    }

    private var phoneDestinations: [RootTabs.SidebarDestination] {
        self.groups.flatMap(\.destinations).filter { !self.opensRootTab($0) }
    }

    private func applyInitialDestinationIfNeeded() {
        guard !self.didApplyInitialDestination else { return }
        self.didApplyInitialDestination = true
        guard let initialDestination, initialDestination != .overview else { return }
        self.applyDestination(initialDestination)
    }

    private func applyNavigationRequestIfNeeded() {
        guard let navigationRequest, navigationRequest.id != self.handledNavigationRequestID else { return }
        self.handledNavigationRequestID = navigationRequest.id
        switch navigationRequest.target {
        case .root:
            self.navigationPath.removeAll()
        case let .detail(destination):
            self.applyDestination(destination)
        }
    }

    private func applyDestination(_ destination: RootTabs.SidebarDestination) {
        if self.opensRootTab(destination) {
            self.openPhoneRootDestination(destination)
        } else {
            self.navigationPath = [destination]
        }
    }

    private var sidebarActiveAgentTitle: String {
        let selectedID = self.normalized(self.appModel.selectedAgentId) ?? self.resolveDefaultAgentID()
        if let agent = self.appModel.gatewayAgents.first(where: { $0.id == selectedID }) {
            return self.agentTitle(for: agent)
        }
        return self.normalized(self.appModel.activeAgentName) ?? String(localized: "Default Agent")
    }

    private var gatewayDisplayLabel: String? {
        self.normalized(self.appModel.gatewayServerName)
            ?? self.normalized(self.appModel.gatewayRemoteAddress)
    }

    @ViewBuilder
    private var gatewayIdentityTitle: some View {
        // Gateway names are server data; only the product fallback is localizable.
        if let gatewayDisplayLabel {
            Text(verbatim: gatewayDisplayLabel)
                .font(OpenClawType.headlineBold)
        } else {
            Text("Gateway")
                .font(OpenClawType.headlineBold)
        }
    }

    private var gatewayAccessibilityLabel: Text {
        if let gatewayDisplayLabel {
            Text(verbatim: String(
                format: String(localized: "Gateway %1$@, %2$@, %3$@"),
                self.gatewayStateText,
                gatewayDisplayLabel,
                self.sidebarActiveAgentTitle))
                .font(OpenClawType.captionMedium)
        } else {
            Text(verbatim: String(
                format: String(localized: "Gateway %1$@, %2$@"),
                self.gatewayStateText,
                self.sidebarActiveAgentTitle))
                .font(OpenClawType.captionMedium)
        }
    }

    private var gatewayStateText: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .error: String(localized: "Attention")
        case .disconnected: String(localized: "Offline")
        }
    }

    private var gatewayStateColor: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
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

    private func color(for destination: RootTabs.SidebarDestination) -> Color {
        switch destination {
        case .chat:
            OpenClawBrand.ok
        case .talk, .skillWorkshop, .files:
            OpenClawBrand.info
        case .overview:
            OpenClawBrand.warn
        case .activity:
            OpenClawBrand.accent
        case .workboard:
            .purple
        case .instances, .sessions, .dreaming, .terminal:
            .secondary
        case .usage, .docs:
            OpenClawBrand.accentHot
        case .agents, .cron, .settings, .gateway:
            OpenClawBrand.ok
        }
    }

    private func resolveDefaultAgentID() -> String {
        self.normalized(self.appModel.gatewayDefaultAgentId) ?? ""
    }

    private func agentTitle(for agent: AgentSummary) -> String {
        let name = self.normalized(agent.name) ?? agent.id
        return name == agent.id ? name : "\(name) (\(agent.id))"
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct ControlCircleIcon: View {
    @Environment(\.colorScheme) private var colorScheme

    let systemName: String
    let color: Color
    let size: CGFloat

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: self.size * 0.42, weight: .semibold))
            .foregroundStyle(self.iconForegroundStyle)
            .frame(width: self.size, height: self.size)
            .background(
                LinearGradient(
                    colors: [self.color.opacity(0.72), self.color],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing),
                in: Circle())
    }

    private var iconForegroundStyle: Color {
        self.colorScheme == .dark ? .black.opacity(0.82) : .white
    }
}

#if DEBUG
#Preview("Phone control hub offline") {
    RootTabsPhoneControlHub.preview(appModel: NodeAppModel())
}

#Preview("Phone control hub connected") {
    let appModel = NodeAppModel()
    appModel.enterAppleReviewDemoMode()
    return RootTabsPhoneControlHub.preview(appModel: appModel)
}

#Preview("Phone control hub connecting") {
    let appModel = NodeAppModel()
    appModel.gatewayStatusText = "Connecting..."
    return RootTabsPhoneControlHub.preview(appModel: appModel)
}

#Preview("Phone control hub gateway error") {
    let appModel = NodeAppModel()
    appModel.gatewayStatusText = "Gateway error: connection refused"
    return RootTabsPhoneControlHub.preview(appModel: appModel)
}

#Preview(
    "Phone control hub landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    RootTabsPhoneControlHub.preview(appModel: NodeAppModel())
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
}

extension RootTabsPhoneControlHub {
    fileprivate static func preview(appModel: NodeAppModel) -> some View {
        RootTabsPhoneControlHub(
            groups: RootTabs.phoneControlGroups,
            initialDestination: nil,
            navigationRequest: nil,
            openRootDestination: { _ in },
            openChatFromControlDetail: { _ in })
            .environment(appModel)
    }
}
#endif
