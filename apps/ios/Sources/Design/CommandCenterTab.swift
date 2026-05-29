import OpenClawChatUI
import SwiftUI

struct CommandCenterTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var activeChatSessions: [OpenClawChatSessionEntry] = []
    var openChat: () -> Void
    var openSettings: () -> Void

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
    }

    struct ApprovalItem: Identifiable {
        let id: String
        let icon: String
        let title: String
        let detail: String
        let priority: String
        let color: Color
    }

    var body: some View {
        NavigationStack {
            ZStack {
                CommandControlBackground()
                self.commandAmbientOverlay
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        self.header
                        self.gatewayCard
                        self.pendingApprovals
                        self.activeTasks
                        self.liveActivity
                        self.startWorkAction
                    }
                    .padding(.top, 16)
                    .padding(.bottom, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationBarHidden(true)
        }
        .task(id: self.activeSessionsRefreshID) {
            await self.refreshActiveSessionsIfNeeded()
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 11) {
            OpenClawProMark(size: 31, shadowRadius: 9)
            Text("OpenClaw")
                .font(.system(size: 27, weight: .bold, design: .rounded))
            Spacer()
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var commandAmbientOverlay: some View {
        Group {
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
    }

    private var gatewayCard: some View {
        CommandPanel(isProminent: true, padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                self.cardHeader(
                    title: "Gateway",
                    value: self.gatewayStateText,
                    color: self.gatewayStatusColor,
                    icon: self.gatewayConnected ? "hourglass" : "wifi.slash")

                HStack(spacing: 0) {
                    self.gatewayFact(
                        icon: "network",
                        title: "Connection",
                        value: self.gatewayConnected ? "Online" : "Offline",
                        color: self.gatewayStatusColor)
                    Divider().frame(height: 38)
                    self.gatewayFact(
                        icon: "server.rack",
                        title: "Address",
                        value: self.gatewayAddressText,
                        color: OpenClawBrand.accent)
                    Divider().frame(height: 38)
                    self.gatewayFact(
                        icon: "person.2.fill",
                        title: "Agents",
                        value: self.gatewayAgentCountText,
                        color: OpenClawBrand.accentHot)
                }
                .padding(.vertical, 9)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(self.colorScheme == .dark ? Color.black.opacity(0.16) : Color.black.opacity(0.026))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(
                                    Color.primary.opacity(self.colorScheme == .dark ? 0.08 : 0.045),
                                    lineWidth: 1)
                        }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func gatewayFact(icon: String, title: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(color)
                Text(title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(title == "Connection" ? color : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
    }

    private var pendingApprovals: some View {
        self.pendingApprovalsContent
            .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var pendingApprovalsContent: some View {
        CommandPanel(
            tint: self.pendingApproval == nil ? nil : OpenClawBrand.warn,
            isProminent: self.pendingApproval != nil,
            padding: self.pendingApproval == nil ? 11 : 13)
        {
            VStack(alignment: .leading, spacing: 10) {
                self.cardHeader(
                    title: "Pending approvals",
                    value: self.pendingApproval == nil ? nil : "Review requests ›",
                    color: OpenClawBrand.accentHot,
                    badgeValue: self.approvalItems.isEmpty ? nil : "\(self.approvalItems.count)")

                if self.approvalItems.isEmpty {
                    CommandEmptyStateRow(
                        icon: "checkmark.shield.fill",
                        title: "No approvals waiting",
                        detail: self
                            .gatewayConnected ? "Gateway requests will appear here." : "Connect to the gateway.")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(self.approvalItems.enumerated()), id: \.element.id) { index, item in
                            CommandApprovalRow(item: item)
                            if index < self.approvalItems.count - 1 {
                                Divider().padding(.leading, 48)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    .background {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(self.approvalRowsFill)
                            .overlay {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(
                                        Color.primary.opacity(self.colorScheme == .dark ? 0.08 : 0.04),
                                        lineWidth: 1)
                            }
                    }
                }

                if let pendingApproval {
                    HStack(spacing: 8) {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Label("Allow", systemImage: "checkmark")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)

                        if pendingApproval.allowsAllowAlways {
                            Button {
                                Task {
                                    await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always")
                                }
                            } label: {
                                Label("Always", systemImage: "checkmark.shield")
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.appModel.pendingExecApprovalPromptResolving)
                        }

                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Label("Deny", systemImage: "xmark")
                        }
                        .buttonStyle(.bordered)
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)

                        Spacer(minLength: 0)
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    private var activeTasks: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                self.cardHeader(
                    title: "Active sessions",
                    value: self.activeSessionsSummaryText,
                    color: .secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 3)

                VStack(spacing: 8) {
                    ForEach(self.visibleActiveSessionRows) { item in
                        Button {
                            self.open(item.route)
                        } label: {
                            CommandSessionRow(item: item)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var liveActivity: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                self.cardHeader(
                    title: "Live activity",
                    value: nil,
                    color: OpenClawBrand.accent)
                    .padding(.horizontal, 12)
                    .padding(.top, 11)
                    .padding(.bottom, 3)

                CommandLiveActivityRow(
                    title: self.liveActivityTitle,
                    value: self.liveActivityValue,
                    color: self.liveActivityColor)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var startWorkAction: some View {
        CommandPanel(tint: OpenClawBrand.accent, isProminent: true, padding: 9) {
            Button(action: self.openChat) {
                Label("Start work", systemImage: "play.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(LinearGradient(
                                colors: [OpenClawBrand.accentHot, OpenClawBrand.accent],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing))
                            .shadow(color: OpenClawBrand.accentHot.opacity(0.34), radius: 18, y: 8)
                    }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func cardHeader(
        title: String,
        value: String?,
        color: Color,
        icon: String? = nil,
        badgeValue: String? = nil,
        action: (() -> Void)? = nil) -> some View
    {
        HStack(spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.bold))
            if let badgeValue {
                Text(badgeValue)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(OpenClawBrand.accentHot, in: Capsule())
            }
            Spacer(minLength: 8)
            if let value {
                if let action {
                    Button(value, action: action)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                } else {
                    HStack(spacing: 4) {
                        if let icon {
                            Image(systemName: icon)
                                .font(.caption2.weight(.bold))
                        }
                        Text(value)
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
                }
            }
        }
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var gatewayStateText: String {
        guard !self.gatewayConnected else { return "Healthy" }
        let status = self.appModel.gatewayDisplayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = status.lowercased()
        if lowercased.contains("approval") { return "Approval" }
        if lowercased.contains("reconnect") { return "Reconnecting" }
        if lowercased.contains("connect") { return "Connecting" }
        if lowercased.contains("idle") { return "Idle" }
        return "Offline"
    }

    private var gatewayStatusColor: Color {
        self.gatewayConnected ? OpenClawBrand.ok : .secondary
    }

    private var gatewayAddressText: String {
        self.normalized(self.appModel.gatewayRemoteAddress)
            ?? self.normalized(self.appModel.gatewayServerName)
            ?? "Unknown"
    }

    private var gatewayAgentCountText: String {
        guard self.gatewayConnected else { return "—" }
        return "\(self.appModel.gatewayAgents.count)"
    }

    private var activeSessionsSummaryText: String {
        let count = self.activeSessionRows.count
        if count == 0 {
            return self.gatewayConnected ? "No sessions" : "Offline"
        }
        if self.sessionWorkItems.isEmpty {
            return self.gatewayConnected ? "\(count) ready" : "Offline"
        }
        return "\(count) \(count == 1 ? "session" : "sessions")"
    }

    private var approvalItems: [ApprovalItem] {
        if let pendingApproval {
            return [
                ApprovalItem(
                    id: "pending-real",
                    icon: "terminal.fill",
                    title: pendingApproval.commandPreview ?? "Review gateway action",
                    detail: "Agent: \(self.appModel.activeAgentName)",
                    priority: self.appModel.pendingExecApprovalPromptResolving ? "Resolving" : "High",
                    color: OpenClawBrand.danger),
                ApprovalItem(
                    id: "pending-context",
                    icon: "doc.text.fill",
                    title: pendingApproval.allowsAllowAlways ? "Permission can be saved" : "One-time approval",
                    detail: "Gateway request",
                    priority: pendingApproval.allowsAllowAlways ? "Medium" : "Review",
                    color: OpenClawBrand.warn),
            ]
        }

        return []
    }

    private var approvalRowsFill: Color {
        self.colorScheme == .dark ? Color.black.opacity(0.12) : Color.black.opacity(0.022)
    }

    private var activeSessionRows: [WorkItem] {
        self.sessionItems
    }

    private var visibleActiveSessionRows: [WorkItem] {
        Array(self.activeSessionRows.prefix(3))
    }

    private var liveActivityTitle: String {
        if let session = self.activeChatSessions.first(where: { !Self.isHiddenInternalSession($0.key) }) {
            return "\(Self.sessionTitle(session)) updated"
        }
        if self.pendingApproval != nil {
            return "Approval waiting"
        }
        return self.gatewayConnected ? "Gateway connected" : self.gatewayStateText
    }

    private var liveActivityValue: String {
        if let session = self.activeChatSessions.first(where: { !Self.isHiddenInternalSession($0.key) }),
           let updatedAt = session.updatedAt,
           updatedAt > 0
        {
            return Self.relativeTimeText(forMilliseconds: updatedAt)
        }
        if self.pendingApproval != nil {
            return "review"
        }
        return self.gatewayConnected ? self.gatewayAddressText : self.gatewayDisplayStatusValue
    }

    private var liveActivityColor: Color {
        if self.pendingApproval != nil { return OpenClawBrand.warn }
        return self.gatewayConnected ? OpenClawBrand.ok : .secondary
    }

    private var gatewayDisplayStatusValue: String {
        let status = self.appModel.gatewayDisplayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        return status.isEmpty ? self.gatewayStateText : status
    }

    private var activeSessionsRefreshID: String {
        [
            self.appModel.isOperatorGatewayConnected ? "connected" : "offline",
            self.appModel.chatSessionKey,
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private var sessionItems: [WorkItem] {
        let liveItems = self.sessionWorkItems
        if !liveItems.isEmpty { return liveItems }
        return self.defaultSessionItems
    }

    private var sessionWorkItems: [WorkItem] {
        let currentSessionKey = self.appModel.chatSessionKey
        return self.activeChatSessions
            .filter { !Self.isHiddenInternalSession($0.key) }
            .prefix(4)
            .map { session in
                let isCurrent = session.key == currentSessionKey
                return WorkItem(
                    id: "chat-session-\(session.key)",
                    icon: isCurrent ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
                    title: Self.sessionTitle(session),
                    detail: Self.sessionDetail(session),
                    state: isCurrent ? "current" : "recent",
                    trailing: "chat",
                    color: isCurrent ? OpenClawBrand.accent : OpenClawBrand.ok,
                    progress: nil,
                    route: .chat(session.key))
            }
    }

    private var defaultSessionItems: [WorkItem] {
        [
            WorkItem(
                id: "main-chat",
                icon: "bubble.left.and.text.bubble.right.fill",
                title: "Main chat",
                detail: self.appModel.activeAgentName,
                state: self.gatewayConnected ? "ready" : "offline",
                trailing: "session",
                color: self.gatewayConnected ? OpenClawBrand.ok : .secondary,
                progress: nil,
                route: .chat(self.appModel.chatSessionKey)),
            WorkItem(
                id: "talk-mode",
                icon: "waveform",
                title: "Talk",
                detail: self.appModel.talkMode.statusText,
                state: self.appModel.talkMode.isEnabled ? "active" : "off",
                trailing: "voice",
                color: self.appModel.talkMode.isEnabled ? OpenClawBrand.ok : .secondary,
                progress: nil,
                route: .settings),
            WorkItem(
                id: "device-capture",
                icon: self.appModel.screenRecordActive ? "record.circle.fill" : "display",
                title: "Device capture",
                detail: self.appModel.screenRecordActive ? "Screen capture is active" : "Screen and device tools",
                state: self.appModel.screenRecordActive ? "running" : "idle",
                trailing: "device",
                color: self.appModel.screenRecordActive ? OpenClawBrand.warn : .secondary,
                progress: nil,
                route: .settings),
            WorkItem(
                id: "agent-roster",
                icon: "person.2.fill",
                title: "Agents",
                detail: self.gatewayConnected ? "\(self.appModel.gatewayAgents.count) available" : "Roster unavailable",
                state: self.gatewayConnected ? "online" : "offline",
                trailing: "gateway",
                color: self.gatewayConnected ? OpenClawBrand.ok : .secondary,
                progress: nil,
                route: .settings),
        ]
    }

    private func open(_ route: WorkRoute) {
        switch route {
        case let .chat(sessionKey):
            self.appModel.openChat(sessionKey: sessionKey)
            self.openChat()
        case .settings:
            self.openSettings()
        }
    }

    private func refreshActiveSessionsIfNeeded() async {
        guard self.scenePhase == .active else { return }
        guard self.appModel.isOperatorGatewayConnected else {
            if !self.activeChatSessions.isEmpty {
                self.activeChatSessions = []
            }
            return
        }

        do {
            let transport = IOSGatewayChatTransport(gateway: appModel.operatorSession)
            let response = try await transport.listSessions(limit: 12)
            self.activeChatSessions = Self.sessionChoices(
                response.sessions,
                currentSessionKey: self.appModel.chatSessionKey)
        } catch {
            self.activeChatSessions = []
        }
    }

    private static func sessionChoices(
        _ sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String) -> [OpenClawChatSessionEntry]
    {
        let sorted = sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        if let current = sorted.first(where: { $0.key == currentSessionKey }) {
            result.append(current)
            included.insert(current.key)
        }

        for session in sorted {
            guard !included.contains(session.key) else { continue }
            guard !Self.isHiddenInternalSession(session.key) else { continue }
            result.append(session)
            included.insert(session.key)
            if result.count >= 4 { break }
        }

        return result
    }

    private static func sessionTitle(_ session: OpenClawChatSessionEntry) -> String {
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

    private static func redactedSessionTitle(for key: String) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()
        guard !trimmed.isEmpty else { return nil }
        if lowercased.contains(":ios-") {
            return "iOS chat"
        }
        if lowercased.hasPrefix("telegram:") {
            return "Telegram chat"
        }
        if lowercased.hasPrefix("user:+") {
            return "Direct chat"
        }
        if lowercased.hasPrefix("cron:") {
            return Self.humanizedSessionKey(String(trimmed.dropFirst("cron:".count)))
        }
        return nil
    }

    private static func humanizedSessionKey(_ key: String) -> String? {
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

    private static func sessionDetail(_ session: OpenClawChatSessionEntry) -> String {
        if let updatedAt = session.updatedAt, updatedAt > 0 {
            return self.relativeTimeText(forMilliseconds: updatedAt)
        }
        return session.key
    }

    private static func relativeTimeText(forMilliseconds milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: .now)
    }

    private static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    private var gatewaySubtitle: String {
        if let server = normalized(appModel.gatewayServerName) {
            return "\(self.appModel.activeAgentName) on \(server)"
        }
        if let address = normalized(appModel.gatewayRemoteAddress) {
            return "\(self.appModel.activeAgentName) via \(address)"
        }
        return self.appModel.gatewayDisplayStatusText
    }

    private var pendingApproval: NodeAppModel.ExecApprovalPrompt? {
        self.appModel.pendingExecApprovalPrompt
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
