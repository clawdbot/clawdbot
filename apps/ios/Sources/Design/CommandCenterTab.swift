import OpenClawChatUI
import SwiftUI

struct CommandCenterTab: View {
    fileprivate static let recentSessionsFetchLimit = 200

    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var defaultChatSessionEntry: OpenClawChatSessionEntry?
    @State private var recentChatSessions: [OpenClawChatSessionEntry] = []
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

    var body: some View {
        NavigationStack {
            ZStack {
                CommandControlBackground()
                self.commandAmbientOverlay
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        self.header
                        self.gatewayCard
                        self.defaultChatSessionSection
                        self.recentSessions
                    }
                    .padding(.top, 16)
                    .padding(.bottom, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationBarHidden(true)
        }
        .task(id: self.recentSessionsRefreshID) {
            await self.refreshRecentSessionsIfNeeded()
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

    private var defaultChatSessionSection: some View {
        CommandPanel(padding: 12) {
            VStack(spacing: 10) {
                self.cardHeader(
                    title: "Agent session",
                    value: nil,
                    color: OpenClawBrand.accent)

                Button {
                    self.open(.chat(nil))
                } label: {
                    CommandSessionRow(item: self.defaultChatWorkItem)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var recentSessions: some View {
        CommandPanel(padding: 12) {
            VStack(spacing: 10) {
                self.cardHeader(
                    title: "Recent sessions",
                    value: nil,
                    color: .secondary)

                if self.recentSessionPreviewRows.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.gatewayConnected ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: self.gatewayConnected ? "No recent sessions" : "Gateway offline",
                        detail: self
                            .gatewayConnected ? "Start a chat and it will appear here." : "Connect to the gateway.")
                } else {
                    VStack(spacing: 8) {
                        ForEach(self.recentSessionPreviewRows) { item in
                            Button {
                                self.open(item.route)
                            } label: {
                                CommandSessionRow(item: item)
                            }
                            .buttonStyle(.plain)
                        }

                        if self.hasMoreRecentSessions {
                            NavigationLink {
                                CommandSessionsScreen(openChat: self.openChat)
                            } label: {
                                CommandViewMoreRow()
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
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
            route: .chat(nil))
    }

    private var defaultChatActivityText: String {
        guard let updatedAt = defaultChatSessionEntry?.updatedAt, updatedAt > 0 else {
            return "No recent activity"
        }
        return Self.relativeTimeText(forMilliseconds: updatedAt)
    }

    private var recentSessionRows: [WorkItem] {
        self.sessionItems
    }

    private var recentSessionPreviewRows: [WorkItem] {
        Array(self.recentSessionRows.prefix(3))
    }

    private var hasMoreRecentSessions: Bool {
        self.sessionWorkItems.count > self.recentSessionPreviewRows.count
    }

    private var recentSessionsRefreshID: String {
        [
            self.sessionListMode,
            self.appModel.chatSessionKey,
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private var sessionListAvailable: Bool {
        self.appModel.isAppleReviewDemoModeEnabled || self.appModel.isOperatorGatewayConnected
    }

    private var sessionListMode: String {
        if self.appModel.isAppleReviewDemoModeEnabled { return "demo" }
        return self.appModel.isOperatorGatewayConnected ? "operator" : "offline"
    }

    private var sessionItems: [WorkItem] {
        self.sessionWorkItems
    }

    private var sessionWorkItems: [WorkItem] {
        let currentSessionKey = self.appModel.chatSessionKey
        return self.recentChatSessions
            .filter { Self.isRecentChatSession($0.key, defaultSessionKey: self.appModel.defaultChatSessionKey) }
            .map { session in
                Self.sessionWorkItem(for: session, currentSessionKey: currentSessionKey)
            }
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

    private func refreshRecentSessionsIfNeeded() async {
        guard self.scenePhase == .active else { return }
        guard self.sessionListAvailable else {
            if self.defaultChatSessionEntry != nil {
                self.defaultChatSessionEntry = nil
            }
            if !self.recentChatSessions.isEmpty {
                self.recentChatSessions = []
            }
            return
        }

        do {
            let transport: any OpenClawChatTransport = self.appModel.isAppleReviewDemoModeEnabled
                ? AppleReviewDemoChatTransport()
                : IOSGatewayChatTransport(gateway: self.appModel.operatorSession)
            let response = try await transport.listSessions(limit: Self.recentSessionsFetchLimit)
            self.defaultChatSessionEntry = response.sessions.first {
                $0.key == self.appModel.defaultChatSessionKey
            }
            self.recentChatSessions = Self.sessionChoices(
                response.sessions,
                currentSessionKey: self.appModel.chatSessionKey,
                defaultSessionKey: self.appModel.defaultChatSessionKey)
        } catch {
            self.defaultChatSessionEntry = nil
            self.recentChatSessions = []
        }
    }

    private static func sessionChoices(
        _ sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        defaultSessionKey: String) -> [OpenClawChatSessionEntry]
    {
        let sorted = sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        if Self.isRecentChatSession(currentSessionKey, defaultSessionKey: defaultSessionKey),
           let current = sorted.first(where: { $0.key == currentSessionKey })
        {
            result.append(current)
            included.insert(current.key)
        }

        for session in sorted {
            guard !included.contains(session.key) else { continue }
            guard Self.isRecentChatSession(session.key, defaultSessionKey: defaultSessionKey) else { continue }
            result.append(session)
            included.insert(session.key)
            if result.count >= 4 { break }
        }

        return result
    }

    fileprivate static func sessionWorkItem(
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
            route: .chat(session.key))
    }

    fileprivate static func sessionTitle(_ session: OpenClawChatSessionEntry) -> String {
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

    fileprivate static func sessionDetail(_ session: OpenClawChatSessionEntry) -> String {
        if let updatedAt = session.updatedAt, updatedAt > 0 {
            return self.relativeTimeText(forMilliseconds: updatedAt)
        }
        return session.key
    }

    fileprivate static func relativeTimeText(forMilliseconds milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: .now)
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
            return "\(self.appModel.activeAgentName) on \(server)"
        }
        if let address = normalized(appModel.gatewayRemoteAddress) {
            return "\(self.appModel.activeAgentName) via \(address)"
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

private struct CommandSessionsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var sessions: [OpenClawChatSessionEntry] = []
    @State private var isLoading = false
    @State private var loadErrorText: String?
    let openChat: () -> Void

    var body: some View {
        ZStack {
            CommandControlBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    self.header
                    self.sessionsPanel
                }
                .padding(.top, 16)
                .padding(.bottom, 18)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: self.refreshID) {
            await self.refreshSessions()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Sessions")
                .font(.system(size: 27, weight: .bold, design: .rounded))
            Text(self.headerDetail)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var sessionsPanel: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("Recent sessions")
                        .font(.subheadline.weight(.bold))
                    Spacer(minLength: 8)
                    if self.isLoading {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 3)

                if let loadErrorText {
                    CommandEmptyStateRow(
                        icon: "exclamationmark.triangle.fill",
                        title: "Sessions unavailable",
                        detail: loadErrorText)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                } else if self.sessionRows.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.appModel
                            .isCommandSessionListAvailable ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: self.appModel.isCommandSessionListAvailable ? "No recent sessions" : "Gateway offline",
                        detail: self.appModel
                            .isCommandSessionListAvailable ? "Start a chat and it will appear here." :
                            "Connect to the gateway.")
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                } else {
                    VStack(spacing: 8) {
                        ForEach(self.sessionRows) { item in
                            Button {
                                self.open(item)
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
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var headerDetail: String {
        if self.isLoading, self.sessions.isEmpty { return "Loading recent sessions" }
        let count = self.sessionRows.count
        if count == 0 {
            return self.appModel.isCommandSessionListAvailable ? "No recent sessions" : "Gateway offline"
        }
        return "\(count) \(count == 1 ? "session" : "sessions")"
    }

    private var sessionRows: [CommandCenterTab.WorkItem] {
        self.sessions
            .filter { CommandCenterTab.isRecentChatSession(
                $0.key,
                defaultSessionKey: self.appModel.defaultChatSessionKey) }
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            .map {
                CommandCenterTab.sessionWorkItem(
                    for: $0,
                    currentSessionKey: self.appModel.chatSessionKey)
            }
    }

    private var refreshID: String {
        self.appModel.commandSessionListMode
    }

    private func open(_ item: CommandCenterTab.WorkItem) {
        switch item.route {
        case let .chat(sessionKey):
            self.appModel.openChat(sessionKey: sessionKey)
            self.dismiss()
            self.openChat()
        case .settings:
            break
        }
    }

    private func refreshSessions() async {
        guard self.appModel.isCommandSessionListAvailable else {
            self.sessions = []
            self.loadErrorText = nil
            return
        }

        self.isLoading = true
        self.loadErrorText = nil
        defer { self.isLoading = false }

        do {
            let transport: any OpenClawChatTransport = self.appModel.isAppleReviewDemoModeEnabled
                ? AppleReviewDemoChatTransport()
                : IOSGatewayChatTransport(gateway: self.appModel.operatorSession)
            let response = try await transport.listSessions(limit: CommandCenterTab.recentSessionsFetchLimit)
            self.sessions = response.sessions
        } catch {
            self.sessions = []
            self.loadErrorText = "Try again after the gateway reconnects."
        }
    }
}

extension NodeAppModel {
    fileprivate var isCommandSessionListAvailable: Bool {
        self.isAppleReviewDemoModeEnabled || self.isOperatorGatewayConnected
    }

    fileprivate var commandSessionListMode: String {
        if self.isAppleReviewDemoModeEnabled { return "demo" }
        return self.isOperatorGatewayConnected ? "operator" : "offline"
    }
}
