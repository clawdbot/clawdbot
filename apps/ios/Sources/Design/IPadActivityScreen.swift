import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct IPadActivityScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var sessions: [OpenClawChatSessionEntry] = []
    @State private var isLoading = false
    @State private var loadErrorText: String?
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let openChat: () -> Void
    let openSettings: () -> Void

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        openChat: @escaping () -> Void,
        openSettings: @escaping () -> Void)
    {
        self.headerLeadingAction = headerLeadingAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.openChat = openChat
        self.openSettings = openSettings
    }

    var body: some View {
        IPadSidebarScreenChrome(
            title: "Activity",
            subtitle: "Live device and gateway activity.",
            headerLeadingAction: self.headerLeadingAction,
            usesNativeNavigationChrome: self.usesNativeNavigationChrome,
            gatewayAction: self.openSettings)
        {
            ProMetricGrid(metrics: self.metrics)
            self.activityFeed
        }
        .task(id: self.refreshID) {
            await self.refreshSessions()
        }
        .refreshable {
            await self.refreshSessions()
        }
    }

    private var metrics: [ProMetric] {
        [
            ProMetric(
                icon: self.gatewayConnected ? "checkmark.circle.fill" : "wifi.slash",
                title: "Gateway",
                value: self.gatewayStateText,
                color: self.gatewayConnected ? OpenClawBrand.ok : .secondary),
            ProMetric(
                icon: "person.2.fill",
                title: "Agents",
                value: self.gatewayConnected ? "\(self.appModel.gatewayAgents.count)" : "offline",
                color: OpenClawBrand.accentForeground),
            ProMetric(
                icon: "bubble.left.and.text.bubble.right",
                title: "Threads",
                value: self.isLoading ? "..." : "\(self.sessionRows.count)",
                color: OpenClawBrand.accentHotForeground),
        ]
    }

    private var activityFeed: some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: "Recent activity",
                    value: self.isLoading ? "Loading" : nil,
                    actionTitle: "Refresh",
                    action: {
                        Task { await self.refreshSessions() }
                    })

                if let pendingExecApprovalPrompt = self.appModel.pendingExecApprovalPrompt {
                    ProStatusRow(
                        icon: "hand.raised.fill",
                        title: "Approval needed",
                        detail: .verbatim(
                            pendingExecApprovalPrompt.commandPreview ?? pendingExecApprovalPrompt.commandText),
                        value: "pending",
                        color: OpenClawBrand.warn,
                        actionTitle: nil,
                        action: nil)
                    Divider().padding(.leading, 58)
                }

                ProStatusRow(
                    icon: self.gatewayConnected ? "network" : "wifi.slash",
                    title: "Gateway",
                    detail: .verbatim(self.gatewayDetailText),
                    value: self.gatewayStateText.lowercased(),
                    color: self.gatewayConnected ? OpenClawBrand.ok : .secondary,
                    actionTitle: self.gatewayConnected ? nil : "Settings",
                    action: self.gatewayConnected ? nil : self.openSettings)

                Divider().padding(.leading, 58)

                ProStatusRow(
                    icon: "square.and.arrow.down",
                    title: "Share intake",
                    detail: .verbatim(self.appModel.lastShareEventText),
                    value: "iPad",
                    color: OpenClawBrand.accentForeground,
                    actionTitle: nil,
                    action: nil)

                if self.isLoading, self.sessions.isEmpty {
                    Divider().padding(.leading, 58)
                    ProStatusRow(
                        icon: "hourglass",
                        title: "Loading threads",
                        detail: "Fetching recent activity from the gateway.",
                        value: "loading",
                        color: OpenClawBrand.accentForeground,
                        actionTitle: nil,
                        action: nil)
                } else if let loadErrorText {
                    Divider().padding(.leading, 58)
                    ProStatusRow(
                        icon: "exclamationmark.triangle.fill",
                        title: "Threads unavailable",
                        detail: .verbatim(loadErrorText),
                        value: "error",
                        color: OpenClawBrand.warn,
                        actionTitle: nil,
                        action: nil)
                } else if self.sessionRows.isEmpty {
                    Divider().padding(.leading, 58)
                    ProStatusRow(
                        icon: "bubble.left.and.text.bubble.right",
                        title: self.sessionsAvailable ? "No recent threads" : "Thread activity offline",
                        detail: self.sessionsAvailable
                            ? "Start a chat and it will appear here."
                            : "Connect to the gateway to load recent chat activity.",
                        value: self.sessionsAvailable ? "empty" : "offline",
                        color: .secondary,
                        actionTitle: self.sessionsAvailable ? "Chat" : nil,
                        action: self.sessionsAvailable ? self.openChat : nil)
                } else {
                    ForEach(self.sessionRows) { row in
                        Divider().padding(.leading, 58)
                        ProStatusRow(
                            icon: row.icon,
                            title: .localized(row.title),
                            detail: .localized(row.detail),
                            value: row.state,
                            color: row.color,
                            actionTitle: "Open",
                            action: {
                                self.open(row)
                            })
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var refreshID: String {
        [
            self.sessionsMode,
            self.appModel.chatSessionKey,
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var gatewayStateText: String {
        guard !self.gatewayConnected else { return "Online" }
        let status = self.appModel.gatewayDisplayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        return status.isEmpty ? "Offline" : status
    }

    private var gatewayDetailText: String {
        self.normalized(self.appModel.gatewayRemoteAddress)
            ?? self.normalized(self.appModel.gatewayServerName)
            ?? "No gateway connection"
    }

    private var sessionsAvailable: Bool {
        self.appModel.isLocalChatFixtureEnabled || self.appModel.isOperatorGatewayConnected
    }

    private var sessionsMode: String {
        self.appModel.chatViewModelIdentityID
    }

    private var sessionRows: [CommandCenterTab.WorkItem] {
        self.sessions
            .filter { CommandCenterTab.isRecentChatSession(
                $0.key,
                defaultSessionKey: self.appModel.defaultChatSessionKey) }
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            .prefix(8)
            .map {
                CommandCenterTab.sessionWorkItem(
                    for: $0,
                    currentSessionKey: self.appModel.chatSessionKey)
            }
    }

    private func refreshSessions() async {
        guard self.scenePhase == .active else { return }
        guard self.sessionsAvailable else {
            self.sessions = await self.appModel.loadCachedChatSessions()
            self.loadErrorText = nil
            return
        }

        self.isLoading = true
        self.loadErrorText = nil
        defer { self.isLoading = false }

        do {
            let transport = self.appModel.makeChatTransport()
            let response = try await transport.listSessions(limit: CommandCenterTab.recentSessionsFetchLimit)
            self.sessions = response.sessions
            await self.appModel.storeCachedChatSessions(response.sessions)
        } catch {
            self.sessions = await self.appModel.loadCachedChatSessions()
            self.loadErrorText = self.sessions.isEmpty ? "Try again after the gateway reconnects." : nil
        }
    }

    private func open(_ item: CommandCenterTab.WorkItem) {
        switch item.route {
        case let .chat(sessionKey):
            self.appModel.openChat(sessionKey: sessionKey, unread: item.isUnread)
            self.openChat()
        case .settings:
            self.openSettings()
        }
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
