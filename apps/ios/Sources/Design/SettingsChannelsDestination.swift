import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct SettingsChannelsDestination: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    let showsSummaryCard: Bool
    @State private var snapshot: ChannelsStatusResult?
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var busyOperation: SettingsChannelOperation?

    init(showsSummaryCard: Bool = true) {
        self.showsSummaryCard = showsSummaryCard
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if self.showsSummaryCard {
                self.summaryCard
            }
            self.channelsCard
        }
        .font(OpenClawType.body)
        .task(id: self.refreshID) {
            await self.loadChannels(force: false)
        }
        .refreshable {
            await self.loadChannels(force: true)
        }
    }

    private var summaryCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: "point.3.connected.trianglepath.dotted", color: self.summaryColor)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Channels / Integrations")
                        .font(OpenClawType.headline)
                    Text(self.summaryDetail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                ProValuePill(value: self.summaryValue, color: self.summaryColor)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var channelsCard: some View {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: "Message Routing",
                    value: self.headerValue,
                    actionIcon: self.isLoading ? "hourglass" : "arrow.clockwise",
                    actionAccessibilityLabel: "Refresh Channels",
                    isActionDisabled: self.isLoading,
                    action: {
                        Task { await self.loadChannels(force: true) }
                    })

                if let errorText {
                    ProStatusRow(
                        icon: "exclamationmark.triangle",
                        title: "Channel status unavailable",
                        detail: errorText,
                        value: "error",
                        color: OpenClawBrand.warn)
                } else if !self.canRead {
                    ProStatusRow(
                        icon: "wifi.slash",
                        title: "Gateway offline",
                        detail: "Connect to the gateway to load installed channels, accounts, and routing status.",
                        value: "offline",
                        color: .secondary)
                } else if self.isLoading, self.snapshot == nil {
                    ProStatusRow(
                        icon: "hourglass",
                        title: "Loading channels",
                        detail: "Fetching installed channels, accounts, and routing status from the gateway.",
                        value: "loading",
                        color: OpenClawBrand.accent)
                } else if self.channelEntries.isEmpty {
                    ProStatusRow(
                        icon: "tray",
                        title: "No channel plugins reported",
                        detail: "Install or enable channel plugins on the gateway, then refresh.",
                        value: "empty",
                        color: .secondary)
                } else {
                    ForEach(Array(self.channelEntries.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 {
                            Divider().padding(.leading, 58)
                        }
                        SettingsChannelRow(
                            entry: entry,
                            canAdmin: self.canAdmin,
                            busyOperation: self.busyOperation,
                            start: { accountID in
                                Task { await self.run(.start, channelID: entry.id, accountID: accountID) }
                            },
                            stop: { accountID in
                                Task { await self.run(.stop, channelID: entry.id, accountID: accountID) }
                            },
                            logout: { accountID in
                                Task { await self.run(.logout, channelID: entry.id, accountID: accountID) }
                            })
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var refreshID: String {
        [
            self.canRead ? "connected" : "offline",
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private var canRead: Bool {
        self.appModel.isOperatorGatewayConnected
    }

    private var canAdmin: Bool {
        self.appModel.hasOperatorAdminScope
    }

    static func shouldEnableChannelOperation(canRead: Bool, hasOperatorAdminScope: Bool) -> Bool {
        canRead && hasOperatorAdminScope
    }

    private var headerValue: String? {
        if self.isLoading { return "Loading" }
        guard self.canRead else { return "Offline" }
        return "\(self.channelEntries.count)"
    }

    private var summaryDetail: String {
        guard self.canRead else {
            return "Connect to load channel integrations."
        }
        if let errorText {
            return errorText
        }
        return "Installed channel clients, account state, and message-routing readiness."
    }

    private var summaryValue: String {
        guard self.canRead else { return "offline" }
        if self.isLoading { return "loading" }
        if self.errorText != nil { return "error" }
        let configured = self.channelEntries.count(where: { $0.configured })
        return "\(configured)/\(self.channelEntries.count)"
    }

    private var summaryColor: Color {
        guard self.canRead else { return .secondary }
        if self.errorText != nil { return OpenClawBrand.warn }
        return self.channelEntries.contains(where: { $0.running || $0.connected }) ? OpenClawBrand.ok : OpenClawBrand
            .accent
    }

    private var channelEntries: [SettingsChannelEntry] {
        guard let snapshot else { return [] }
        let ids = snapshot.channelorder.isEmpty ? Array(snapshot.channels.keys).sorted() : snapshot.channelorder
        return ids.map { self.entry(channelID: $0, snapshot: snapshot) }
    }

    private func entry(channelID: String, snapshot: ChannelsStatusResult) -> SettingsChannelEntry {
        let summary = snapshot.channels[channelID]?.dictionaryValue ?? [:]
        let accounts = self.accounts(channelID: channelID, snapshot: snapshot)
        let configured = accounts.contains(where: \.configured) || summary["configured"]?.boolValue == true
        let running = accounts.contains(where: \.running)
        let connected = accounts.contains(where: \.connected)
        let linked = accounts.contains(where: \.linked)
        let label = snapshot.channellabels[channelID]?.stringValue ?? Self.fallbackLabel(channelID)
        let detail = snapshot.channeldetaillabels?[channelID]?.stringValue ?? Self.fallbackDetail(channelID)
        let systemImage = snapshot.channelsystemimages?[channelID]?.stringValue ?? Self.fallbackSystemImage(channelID)
        let lastActivity = accounts.compactMap(\.lastActivityMs).max()
        let lastError = accounts.compactMap(\.lastError).first ?? summary["lastError"]?.stringValue
        return SettingsChannelEntry(
            id: channelID,
            label: label,
            detail: detail,
            systemImage: systemImage,
            configured: configured,
            running: running,
            connected: connected,
            linked: linked,
            lastActivityText: lastActivity.map(Self.relativeTime),
            lastError: lastError,
            unavailableReason: configured ? nil : "Configure this channel on the gateway.",
            accounts: accounts)
    }

    private func accounts(channelID: String, snapshot: ChannelsStatusResult) -> [SettingsChannelAccount] {
        let rawAccounts = snapshot.channelaccounts[channelID]?.arrayValue ?? []
        return rawAccounts.compactMap { raw in
            guard let dict = raw.dictionaryValue else { return nil }
            let accountID = dict["accountId"]?.stringValue ?? "default"
            let name = dict["name"]?.stringValue
            let lastActivity = [
                dict["lastInboundAt"]?.intValue,
                dict["lastOutboundAt"]?.intValue,
                dict["lastTransportActivityAt"]?.intValue,
            ]
                .compactMap(\.self)
                .max()
            return SettingsChannelAccount(
                id: accountID,
                name: name,
                configured: dict["configured"]?.boolValue == true,
                enabled: dict["enabled"]?.boolValue != false,
                running: dict["running"]?.boolValue == true,
                connected: dict["connected"]?.boolValue == true,
                linked: dict["linked"]?.boolValue == true,
                healthState: dict["healthState"]?.stringValue,
                lastError: dict["lastError"]?.stringValue,
                lastActivityMs: lastActivity)
        }
    }

    private func loadChannels(force: Bool) async {
        guard self.scenePhase == .active else { return }
        guard self.canRead else {
            self.snapshot = nil
            self.errorText = nil
            return
        }
        if self.isLoading { return }

        self.isLoading = true
        self.errorText = nil
        defer { self.isLoading = false }

        do {
            let params = ChannelsStatusParams(probe: false, timeoutms: 10000, channel: nil)
            let data = try await self.request(method: "channels.status", params: params, timeoutSeconds: 12)
            self.snapshot = try JSONDecoder().decode(ChannelsStatusResult.self, from: data)
        } catch {
            if force || self.snapshot == nil {
                self.errorText = Self.message(for: error)
            }
        }
    }

    private func run(_ kind: SettingsChannelOperation.Kind, channelID: String, accountID: String?) async {
        guard Self.shouldEnableChannelOperation(canRead: self.canRead, hasOperatorAdminScope: self.canAdmin),
              self.busyOperation == nil
        else {
            return
        }
        self.busyOperation = SettingsChannelOperation(kind: kind, channelID: channelID, accountID: accountID)
        self.errorText = nil
        defer { self.busyOperation = nil }

        do {
            switch kind {
            case .start:
                let params = ChannelsStartParams(channel: channelID, accountid: accountID)
                _ = try await self.request(method: "channels.start", params: params, timeoutSeconds: 20)
            case .stop:
                let params = ChannelsStopParams(channel: channelID, accountid: accountID)
                _ = try await self.request(method: "channels.stop", params: params, timeoutSeconds: 20)
            case .logout:
                let params = ChannelsLogoutParams(channel: channelID, accountid: accountID)
                _ = try await self.request(method: "channels.logout", params: params, timeoutSeconds: 20)
            }
            await self.loadChannels(force: true)
        } catch {
            self.errorText = Self.message(for: error)
        }
    }

    private func request(method: String, params: some Encodable, timeoutSeconds: Int) async throws -> Data {
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw SettingsChannelError.invalidPayload
        }
        return try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds)
    }

    static func fallbackLabel(_ id: String) -> String {
        if let metadata = self.fallbackMetadata[id.lowercased()] {
            return metadata.label
        }
        return id.replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    static func fallbackDetail(_ id: String) -> String {
        self.fallbackMetadata[id.lowercased()]?.detail ?? "Channel integration"
    }

    static func fallbackSystemImage(_ id: String) -> String {
        self.fallbackMetadata[id.lowercased()]?.systemImage ?? "bubble.left.and.text.bubble.right"
    }

    private static let fallbackMetadata: [String: SettingsChannelFallbackMetadata] = [
        "clickclack": SettingsChannelFallbackMetadata(
            label: "ClickClack",
            detail: "Self-hosted chat bot routing.",
            systemImage: "bubble.left.and.bubble.right"),
    ]

    private static func relativeTime(_ milliseconds: Int) -> String {
        let age = max(0, Int(Date().timeIntervalSince1970 * 1000) - milliseconds)
        let minutes = age / 60000
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    private static func message(for error: Error) -> String {
        if let channelError = error as? SettingsChannelError {
            return channelError.message
        }
        return error.localizedDescription
    }
}

private struct SettingsChannelRow: View {
    let entry: SettingsChannelEntry
    let canAdmin: Bool
    let busyOperation: SettingsChannelOperation?
    let start: (String?) -> Void
    let stop: (String?) -> Void
    let logout: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                ProIconBadge(systemName: self.entry.systemImage, color: self.entry.color)
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.entry.label)
                        .font(OpenClawType.subheadSemiBold)
                    Text(self.entry.detailText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let lastError = self.entry.lastError {
                        Text(lastError)
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawBrand.warn)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                ProValuePill(value: self.entry.statusValue, color: self.entry.color)
            }

            if !self.entry.accounts.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(self.entry.accounts.enumerated()), id: \.element.id) { index, account in
                        if index > 0 {
                            Divider().padding(.leading, 38)
                        }
                        self.accountRow(account)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func accountRow(_ account: SettingsChannelAccount) -> some View {
        HStack(spacing: 10) {
            Image(systemName: account.running || account.connected ? "checkmark.circle.fill" : "circle")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(account.color)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.displayName)
                    .font(OpenClawType.captionSemiBold)
                Text(account.detailText)
                    .font(OpenClawType.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Menu {
                if account.running {
                    Button {
                        self.stop(account.id)
                    } label: {
                        Text("Stop")
                            .font(OpenClawType.subhead)
                    }
                } else {
                    Button {
                        self.start(account.id)
                    } label: {
                        Text("Start")
                            .font(OpenClawType.subhead)
                    }
                    .disabled(!account.configured || !account.enabled)
                }
                if account.linked {
                    Button(role: .destructive) {
                        self.logout(account.id)
                    } label: {
                        Text("Logout")
                            .font(OpenClawType.subhead)
                    }
                }
            } label: {
                Image(systemName: self.actionMenuIcon(account))
                    .font(OpenClawType.captionSemiBold)
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
            .disabled(!self.canAdmin || self.isBusy(account))
        }
        .padding(.vertical, 8)
    }

    private func actionMenuIcon(_ account: SettingsChannelAccount) -> String {
        if self.isBusy(account) {
            return "hourglass"
        }
        if !self.canAdmin {
            return "lock.shield"
        }
        return "ellipsis.circle"
    }

    private func isBusy(_ account: SettingsChannelAccount) -> Bool {
        self.busyOperation?.channelID == self.entry.id && self.busyOperation?.accountID == account.id
    }
}

private struct SettingsChannelEntry: Identifiable {
    let id: String
    let label: String
    let detail: String
    let systemImage: String
    let configured: Bool
    let running: Bool
    let connected: Bool
    let linked: Bool
    let lastActivityText: String?
    let lastError: String?
    let unavailableReason: String?
    let accounts: [SettingsChannelAccount]

    var color: Color {
        if self.connected || self.running { return OpenClawBrand.ok }
        if self.lastError != nil { return OpenClawBrand.warn }
        return self.configured ? OpenClawBrand.accent : .secondary
    }

    var statusValue: String {
        if self.connected { return "connected" }
        if self.running { return "running" }
        if self.linked { return "linked" }
        if self.configured { return "configured" }
        return "not set"
    }

    var detailText: String {
        if let lastActivityText {
            return "\(self.detail) • active \(lastActivityText)"
        }
        if let unavailableReason {
            return unavailableReason
        }
        return self.detail
    }
}

private struct SettingsChannelFallbackMetadata {
    let label: String
    let detail: String
    let systemImage: String
}

private struct SettingsChannelAccount: Identifiable {
    let id: String
    let name: String?
    let configured: Bool
    let enabled: Bool
    let running: Bool
    let connected: Bool
    let linked: Bool
    let healthState: String?
    let lastError: String?
    let lastActivityMs: Int?

    var displayName: String {
        let trimmedName = self.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmedName.isEmpty ? self.id : "\(trimmedName) (\(self.id))"
    }

    var detailText: String {
        let state = if self.connected {
            "connected"
        } else if self.running {
            "running"
        } else if self.linked {
            "linked"
        } else if self.configured {
            "configured"
        } else {
            "not configured"
        }
        let enabledText = self.enabled ? "enabled" : "disabled"
        if let healthState, !healthState.isEmpty {
            return "\(state), \(enabledText), \(healthState)"
        }
        if let lastError, !lastError.isEmpty {
            return "\(state), \(enabledText), error"
        }
        return "\(state), \(enabledText)"
    }

    var color: Color {
        if self.connected || self.running { return OpenClawBrand.ok }
        if self.lastError != nil { return OpenClawBrand.warn }
        return self.configured ? OpenClawBrand.accent : .secondary
    }
}

private struct SettingsChannelOperation: Equatable {
    enum Kind {
        case start
        case stop
        case logout
    }

    let kind: Kind
    let channelID: String
    let accountID: String?
}

private enum SettingsChannelError: Error {
    case invalidPayload

    var message: String {
        switch self {
        case .invalidPayload:
            "Could not encode channel request."
        }
    }
}

#if DEBUG
#Preview("Channels states") {
    SettingsChannelsStatesPreview()
}

private struct SettingsChannelsStatesPreview: View {
    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.stateSection("Connected") {
                        SettingsChannelRow(
                            entry: Self.telegramEntry,
                            canAdmin: true,
                            busyOperation: nil,
                            start: { _ in },
                            stop: { _ in },
                            logout: { _ in })
                    }

                    self.stateSection("Loading") {
                        ProPanelHeader(
                            title: "Message Routing",
                            value: "Loading",
                            actionIcon: "hourglass",
                            actionAccessibilityLabel: "Refresh Channels",
                            isActionDisabled: true,
                            action: {})
                        ProStatusRow(
                            icon: "hourglass",
                            title: "Loading channel status",
                            detail: "Checking installed channel clients and account state.",
                            value: "loading",
                            color: OpenClawBrand.accent)
                    }

                    self.stateSection("Empty") {
                        ProPanelHeader(
                            title: "Message Routing",
                            value: "0",
                            actionIcon: "arrow.clockwise",
                            actionAccessibilityLabel: "Refresh Channels",
                            action: {})
                        ProStatusRow(
                            icon: "tray",
                            title: "No channel plugins reported",
                            detail: "Install or enable channel plugins on the gateway, then refresh.",
                            value: "empty",
                            color: .secondary)
                    }

                    self.stateSection("Error") {
                        ProStatusRow(
                            icon: "exclamationmark.triangle",
                            title: "Channel status unavailable",
                            detail: "Gateway returned an unexpected channel status response.",
                            value: "error",
                            color: OpenClawBrand.warn)
                    }

                    self.stateSection("Offline") {
                        ProStatusRow(
                            icon: "wifi.slash",
                            title: "Gateway offline",
                            detail: "Connect to the gateway to load installed channels, accounts, and routing status.",
                            value: "offline",
                            color: .secondary)
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
    }

    private func stateSection(
        _ title: String,
        @ViewBuilder content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.secondary)
            ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
                VStack(spacing: 0) {
                    content()
                }
            }
        }
    }

    private static let telegramEntry = SettingsChannelEntry(
        id: "telegram",
        label: "Telegram",
        detail: "Message routing client",
        systemImage: "paperplane",
        configured: true,
        running: true,
        connected: true,
        linked: true,
        lastActivityText: "4m ago",
        lastError: nil,
        unavailableReason: nil,
        accounts: [
            SettingsChannelAccount(
                id: "main",
                name: "OpenClaw Ops",
                configured: true,
                enabled: true,
                running: true,
                connected: true,
                linked: true,
                healthState: "healthy",
                lastError: nil,
                lastActivityMs: nil),
        ])
}
#endif
