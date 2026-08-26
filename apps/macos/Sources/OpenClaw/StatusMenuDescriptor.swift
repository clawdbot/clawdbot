import Foundation

@MainActor
struct StatusMenuDescriptor {
    struct Snapshot {
        var isPaused: Bool
        var connection: Connection
        var quickChatEnabled: Bool
        var canvasEnabled: Bool
        var voiceWakeSupported: Bool
        var debugEnabled: Bool
        var updateReady: Bool
        var hasUsage: Bool
        var isUsageStalled: Bool
        var sessions: [SessionRow]
        var sessionError: String?
        var mainSessionKey: String
        var approvals: [ExecApprovalQueueItem]
        var gateways: [DashboardGatewayMenuItem]
        var now: Date

        init(
            isPaused: Bool = false,
            connection: Connection = .connected,
            quickChatEnabled: Bool = false,
            canvasEnabled: Bool = false,
            voiceWakeSupported: Bool = true,
            debugEnabled: Bool = false,
            updateReady: Bool = false,
            hasUsage: Bool = false,
            isUsageStalled: Bool = false,
            sessions: [SessionRow] = [],
            sessionError: String? = nil,
            mainSessionKey: String = "main",
            approvals: [ExecApprovalQueueItem] = [],
            gateways: [DashboardGatewayMenuItem] = [],
            now: Date = Date())
        {
            self.isPaused = isPaused
            self.connection = connection
            self.quickChatEnabled = quickChatEnabled
            self.canvasEnabled = canvasEnabled
            self.voiceWakeSupported = voiceWakeSupported
            self.debugEnabled = debugEnabled
            self.updateReady = updateReady
            self.hasUsage = hasUsage
            self.isUsageStalled = isUsageStalled
            self.sessions = sessions
            self.sessionError = sessionError
            self.mainSessionKey = mainSessionKey
            self.approvals = approvals
            self.gateways = gateways
            self.now = now
        }
    }

    enum Connection {
        case unconfigured
        case disconnected
        case connecting
        case connected
        case degraded
    }

    struct Section {
        let id: String
        var entries: [Entry]
    }

    struct Entry {
        let kind: Kind

        init(_ kind: Kind) {
            self.kind = kind
        }

        var id: String {
            switch self.kind {
            case .header:
                "header"
            case .gatewayHeader:
                "gateway.header"
            case let .session(session):
                "session.\(session.key)"
            case let .approval(approval):
                "approval.\(approval.id)"
            case .placeholder:
                "placeholder"
            case let .action(action):
                "action.\(action.rawValue)"
            case let .summary(summary):
                "summary.\(summary.rawValue)"
            case let .gateway(gateway, isAlternate):
                "gateway.\(gateway.id)\(isAlternate ? ".alternate" : "")"
            case .updateReady:
                "update.ready"
            }
        }
    }

    enum Kind {
        case header
        case gatewayHeader
        case session(SessionRow)
        case approval(ExecApprovalQueueItem)
        case placeholder(String)
        case action(Action)
        case summary(Summary)
        case gateway(DashboardGatewayMenuItem, isAlternate: Bool)
        case updateReady
    }

    enum Action: String {
        case dashboard
        case quickChat
        case talkMode
        case canvas
        case allSessions
        case settings
        case debug
        case about
        case quit
    }

    enum Summary: String {
        case automations
        case usage
        case devices
    }

    static let maximumSessionCount = 6
    private static let activeWindowSeconds: TimeInterval = 24 * 60 * 60

    var sections: [Section]

    static func build(from snapshot: Snapshot) -> StatusMenuDescriptor {
        var sections = [Section(id: "header", entries: [Entry(.header)])]
        sections.append(self.sessionSection(from: snapshot))
        sections.append(self.actionSection(from: snapshot))
        sections.append(self.summarySection(from: snapshot))

        if snapshot.gateways.count >= 2 {
            let entries = [Entry(.gatewayHeader)] + snapshot.gateways.flatMap { gateway in
                var entries = [Entry(.gateway(gateway, isAlternate: false))]
                if gateway.canPromote {
                    entries.append(Entry(.gateway(gateway, isAlternate: true)))
                }
                return entries
            }
            sections.append(Section(id: "gateways", entries: entries))
        }

        sections.append(self.footerSection(from: snapshot))
        return StatusMenuDescriptor(sections: sections)
    }

    static func activeRows(
        from rows: [SessionRow],
        mainSessionKey: String = "main",
        now: Date = Date()) -> [SessionRow]
    {
        rows.filter { row in
            if row.key == "main", mainSessionKey != "main" { return false }
            if row.key == mainSessionKey { return true }
            guard let updatedAt = row.updatedAt else { return false }
            return now.timeIntervalSince(updatedAt) <= self.activeWindowSeconds
        }.sorted { lhs, rhs in
            if lhs.key == mainSessionKey { return true }
            if rhs.key == mainSessionKey { return false }
            return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
        }
    }

    private static func sessionSection(from snapshot: Snapshot) -> Section {
        guard snapshot.connection == .connected else {
            let approvals = snapshot.approvals.map { Entry(.approval($0)) }
            return Section(id: "sessions", entries: approvals + [Entry(.placeholder(
                self.connectionMessage(snapshot.connection)))])
        }

        let activeRows = self.activeRows(
            from: snapshot.sessions,
            mainSessionKey: snapshot.mainSessionKey,
            now: snapshot.now)
        let visibleRows = Array(activeRows.prefix(self.maximumSessionCount))
        let visibleKeys = Set(visibleRows.map(\.key))
        var entries = snapshot.approvals
            .filter { approval in
                guard let sessionKey = approval.request.sessionKey else { return true }
                return !visibleKeys.contains(sessionKey)
            }
            .map { Entry(.approval($0)) }

        for row in visibleRows {
            entries.append(contentsOf: snapshot.approvals
                .filter { $0.request.sessionKey == row.key }
                .map { Entry(.approval($0)) })
            entries.append(Entry(.session(row)))
        }

        if visibleRows.isEmpty {
            let message = snapshot.sessionError ?? String(localized: "No recent sessions")
            entries.append(Entry(.placeholder(message)))
        } else if activeRows.count > self.maximumSessionCount {
            entries.append(Entry(.action(.allSessions)))
        }

        return Section(id: "sessions", entries: entries)
    }

    private static func actionSection(from snapshot: Snapshot) -> Section {
        var entries = [Entry(.action(.dashboard))]
        if snapshot.quickChatEnabled {
            entries.append(Entry(.action(.quickChat)))
        }
        entries.append(Entry(.action(.talkMode)))
        if snapshot.canvasEnabled {
            entries.append(Entry(.action(.canvas)))
        }
        return Section(id: "actions", entries: entries)
    }

    private static func summarySection(from snapshot: Snapshot) -> Section {
        var entries = [Entry(.summary(.automations))]
        if snapshot.hasUsage || snapshot.isUsageStalled {
            entries.append(Entry(.summary(.usage)))
        }
        entries.append(Entry(.summary(.devices)))
        return Section(id: "summaries", entries: entries)
    }

    private static func footerSection(from snapshot: Snapshot) -> Section {
        var entries = [Entry(.action(.settings))]
        if snapshot.debugEnabled {
            entries.append(Entry(.action(.debug)))
        }
        entries.append(Entry(.action(.about)))
        if snapshot.updateReady {
            entries.append(Entry(.updateReady))
        }
        entries.append(Entry(.action(.quit)))
        return Section(id: "footer", entries: entries)
    }

    private static func connectionMessage(_ connection: Connection) -> String {
        switch connection {
        case .unconfigured:
            String(localized: "Gateway not configured")
        case .disconnected:
            String(localized: "Gateway disconnected")
        case .connecting:
            String(localized: "Connecting…")
        case .connected:
            String(localized: "No recent sessions")
        case .degraded:
            String(localized: "Gateway needs attention")
        }
    }
}
