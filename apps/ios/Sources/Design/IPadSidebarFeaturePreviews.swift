import SwiftUI

#if DEBUG
#Preview("Activity states") {
    IPadActivityStatesPreview()
}

#Preview("Workboard states") {
    IPadWorkboardStatesPreview()
}

#Preview("Skill Workshop states") {
    IPadSkillWorkshopStatesPreview()
}

#Preview(
    "Skill Workshop iPad kanban lanes",
    traits: .fixedLayout(width: 1180, height: 820))
{
    IPadSkillWorkshopKanbanPreview()
}

#Preview("Workboard phone queue rows") {
    IPadWorkboardCompactRowsPreview()
}

#Preview("Skill Workshop phone queue rows") {
    IPadSkillWorkshopCompactRowsPreview()
}

#Preview(
    "Workboard phone landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    IPadSidebarTaskScreenPreviewHost {
        IPadWorkboardScreen(openChat: {}, openSettings: {})
    }
}

#Preview(
    "Skill Workshop phone landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    IPadSidebarTaskScreenPreviewHost {
        IPadSkillWorkshopScreen(openSettings: {})
    }
}

private struct IPadWorkboardCompactRowsPreview: View {
    private let statuses = ["todo", "ready", "running", "review", "blocked", "done"]
    private let cards = IPadWorkboardPreviewFixtures.cards

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    self.previewHeader
                    ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                        VStack(spacing: 0) {
                            ProPanelHeader(
                                title: "Queue",
                                value: "\(self.cards.count)",
                                actionTitle: nil,
                                action: nil)
                            ForEach(Array(self.cards.enumerated()), id: \.element.id) { index, card in
                                if index > 0 {
                                    Divider().padding(.leading, 58)
                                }
                                IPadWorkboardQueueRow(
                                    card: card,
                                    statuses: self.statuses,
                                    isBusy: card.id == "preview-running",
                                    inspect: {},
                                    openSession: {},
                                    move: { _ in },
                                    archive: {})
                            }
                        }
                    }

                    ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                        ProStatusRow(
                            icon: "tray",
                            title: "No cards",
                            detail: "Create a card or change the filter.",
                            value: "empty",
                            color: .secondary,
                            actionTitle: nil,
                            action: nil)
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
        .environment(\.horizontalSizeClass, .compact)
        .environment(\.verticalSizeClass, .regular)
    }

    private var previewHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Phone queue")
                .font(OpenClawType.headline)
            Text("Tap for detail, swipe or long-press for card actions.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct IPadSkillWorkshopCompactRowsPreview: View {
    private let proposals = IPadSkillWorkshopPreviewFixtures.proposals

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    self.previewHeader
                    ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                        VStack(spacing: 0) {
                            ProPanelHeader(
                                title: "Queue",
                                value: "\(self.proposals.count)",
                                actionTitle: nil,
                                action: nil)
                            ForEach(Array(self.proposals.enumerated()), id: \.element.id) { index, proposal in
                                if index > 0 {
                                    Divider().padding(.leading, 58)
                                }
                                IPadSkillProposalRow(
                                    proposal: proposal,
                                    isSelected: proposal.id == "preview-pending",
                                    isBusy: proposal.id == "preview-held")
                            }
                        }
                    }

                    ProCard(radius: OpenClawProMetric.cardRadius) {
                        ProStatusRow(
                            icon: "hammer",
                            title: "No proposals",
                            detail: "New proposals will appear here when agents draft skills.",
                            value: "empty",
                            color: .secondary,
                            actionTitle: nil,
                            action: nil)
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
        .environment(\.horizontalSizeClass, .compact)
        .environment(\.verticalSizeClass, .regular)
    }

    private var previewHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Phone proposals")
                .font(OpenClawType.headline)
            Text("Tap for detail, swipe or long-press for proposal actions.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct IPadSidebarTaskScreenPreviewHost<Content: View>: View {
    @State private var appModel = NodeAppModel()
    @ViewBuilder var content: Content

    var body: some View {
        NavigationStack {
            self.content
        }
        .environment(self.appModel)
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
    }
}

private struct IPadActivityStatesPreview: View {
    private let connectedSessions = [
        CommandCenterTab.WorkItem(
            id: "preview-main",
            icon: "bubble.left.and.text.bubble.right",
            title: "Main",
            detail: "Updated just now",
            state: "active",
            trailing: "open",
            color: OpenClawBrand.ok,
            progress: nil,
            route: .chat("main"),
            isUnread: false,
            isPinned: false),
        CommandCenterTab.WorkItem(
            id: "preview-ipad-audit",
            icon: "bubble.left.and.text.bubble.right",
            title: "iPad audit",
            detail: "Updated 8m ago",
            state: "recent",
            trailing: "open",
            color: OpenClawBrand.accent,
            progress: nil,
            route: .chat("ipad-audit"),
            isUnread: true,
            isPinned: true),
    ]

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    self.previewHeader("Connected")
                    self.activityCard(
                        gatewayTitle: "Gateway",
                        gatewayDetail: "tailscale.local:18789",
                        gatewayValue: "online",
                        gatewayColor: OpenClawBrand.ok,
                        sessionRows: self.connectedSessions,
                        tailRows: [])

                    self.previewHeader("Loading")
                    self.activityCard(
                        gatewayTitle: "Gateway",
                        gatewayDetail: "Fetching recent activity from the gateway.",
                        gatewayValue: "online",
                        gatewayColor: OpenClawBrand.ok,
                        sessionRows: [],
                        tailRows: [
                            ActivityPreviewRow(
                                icon: "hourglass",
                                title: "Loading sessions",
                                detail: "Fetching recent activity from the gateway.",
                                value: "loading",
                                color: OpenClawBrand.accent),
                        ])

                    self.previewHeader("Empty")
                    self.activityCard(
                        gatewayTitle: "Gateway",
                        gatewayDetail: "tailscale.local:18789",
                        gatewayValue: "online",
                        gatewayColor: OpenClawBrand.ok,
                        sessionRows: [],
                        tailRows: [
                            ActivityPreviewRow(
                                icon: "bubble.left.and.text.bubble.right",
                                title: "No recent sessions",
                                detail: "Start a chat and it will appear here.",
                                value: "empty",
                                color: .secondary),
                        ])

                    self.previewHeader("Error")
                    self.activityCard(
                        gatewayTitle: "Gateway",
                        gatewayDetail: "No gateway connection",
                        gatewayValue: "offline",
                        gatewayColor: .secondary,
                        sessionRows: [],
                        tailRows: [
                            ActivityPreviewRow(
                                icon: "exclamationmark.triangle.fill",
                                title: "Sessions unavailable",
                                detail: "Try again after the gateway reconnects.",
                                value: "error",
                                color: OpenClawBrand.warn),
                        ])
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
    }

    private func previewHeader(_ title: String) -> some View {
        Text(title)
            .font(OpenClawType.captionSemiBold)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }

    private func activityCard(
        gatewayTitle: String,
        gatewayDetail: String,
        gatewayValue: String,
        gatewayColor: Color,
        sessionRows: [CommandCenterTab.WorkItem],
        tailRows: [ActivityPreviewRow]) -> some View
    {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: "Recent activity",
                    value: nil,
                    actionTitle: "Refresh",
                    action: {})
                ProStatusRow(
                    icon: gatewayValue == "online" ? "network" : "wifi.slash",
                    title: .localized(gatewayTitle),
                    detail: .localized(gatewayDetail),
                    value: gatewayValue,
                    color: gatewayColor,
                    actionTitle: gatewayValue == "online" ? nil : "Settings",
                    action: {})
                Divider().padding(.leading, 58)
                ProStatusRow(
                    icon: "square.and.arrow.down",
                    title: "Share intake",
                    detail: "No share events yet.",
                    value: "iPad",
                    color: OpenClawBrand.accent,
                    actionTitle: nil,
                    action: nil)
                ForEach(sessionRows) { row in
                    Divider().padding(.leading, 58)
                    ProStatusRow(
                        icon: row.icon,
                        title: .localized(row.title),
                        detail: .localized(row.detail),
                        value: row.state,
                        color: row.color,
                        actionTitle: "Open",
                        action: {})
                }
                ForEach(tailRows) { row in
                    Divider().padding(.leading, 58)
                    ProStatusRow(
                        icon: row.icon,
                        title: .localized(row.title),
                        detail: .localized(row.detail),
                        value: row.value,
                        color: row.color,
                        actionTitle: nil,
                        action: nil)
                }
            }
        }
    }

    private struct ActivityPreviewRow: Identifiable {
        let id = UUID()
        let icon: String
        let title: String
        let detail: String
        let value: String
        let color: Color
    }
}

private struct IPadWorkboardStatesPreview: View {
    private let statuses = ["todo", "running", "review"]
    private let connectedCards = IPadWorkboardPreviewFixtures.cards
    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    self.previewHeader("Connected")
                    self.connectedBoard

                    self.previewHeader("Empty")
                    IPadWorkboardKanbanColumn(
                        status: "todo",
                        cards: [],
                        statuses: self.statuses,
                        busyCardID: nil,
                        openSession: { _ in },
                        inspect: { _ in },
                        move: { _, _ in },
                        archive: { _ in })
                        .frame(maxWidth: 320)

                    self.previewHeader("Loading")
                    ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                        ProStatusRow(
                            icon: "arrow.clockwise",
                            title: "Loading cards",
                            detail: "Refreshing the workboard from the gateway.",
                            value: "loading",
                            color: OpenClawBrand.accent,
                            actionTitle: nil,
                            action: nil)
                    }

                    self.previewHeader("Error")
                    ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                        ProStatusRow(
                            icon: "exclamationmark.triangle",
                            title: "Cards unavailable",
                            detail: "Check the gateway connection, then refresh.",
                            value: "error",
                            color: OpenClawBrand.warn,
                            actionTitle: "Retry",
                            action: {})
                    }
                }
                .padding(18)
            }
        }
    }

    private var connectedBoard: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(self.statuses, id: \.self) { status in
                    IPadWorkboardKanbanColumn(
                        status: status,
                        cards: self.connectedCards.filter { $0.status == status },
                        statuses: self.statuses,
                        busyCardID: nil,
                        openSession: { _ in },
                        inspect: { _ in },
                        move: { _, _ in },
                        archive: { _ in })
                        .frame(width: 282)
                }
            }
        }
    }

    private func previewHeader(_ title: String) -> some View {
        Text(title)
            .font(OpenClawType.captionSemiBold)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }
}

private enum IPadWorkboardPreviewFixtures {
    static let cards = [
        IPadWorkboardCard(
            id: "preview-todo",
            title: "Prep iPad sidebar audit",
            notes: "Confirm portrait drawer behavior before device install.",
            status: "todo",
            priority: "normal",
            labels: ["iPad", "UI"],
            agentId: "main",
            sessionKey: nil,
            position: 0,
            updatedAt: nil,
            metadata: nil),
        IPadWorkboardCard(
            id: "preview-running",
            title: "Verify phone workboard queue",
            notes: "Single-list compact flow with detail sheet actions.",
            status: "running",
            priority: "high",
            labels: ["phone"],
            agentId: "main",
            sessionKey: "session-preview",
            position: 1,
            updatedAt: nil,
            metadata: nil),
        IPadWorkboardCard(
            id: "preview-review",
            title: "Review adaptive shell",
            notes: "Make sure shared destinations stay device-specific.",
            status: "review",
            priority: "normal",
            labels: ["shell"],
            agentId: "main",
            sessionKey: nil,
            position: 2,
            updatedAt: nil,
            metadata: nil),
    ]
}

private struct IPadSkillWorkshopStatesPreview: View {
    private let proposals = IPadSkillWorkshopPreviewFixtures.proposals

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    self.previewHeader("Connected")
                    self.queueCard(self.proposals, selectedID: "preview-pending", busyID: nil)

                    self.previewHeader("Loading")
                    self.queueCard(self.proposals, selectedID: "preview-pending", busyID: "preview-pending")

                    self.previewHeader("Empty")
                    ProCard(radius: OpenClawProMetric.cardRadius) {
                        ProStatusRow(
                            icon: "hammer",
                            title: "No proposals",
                            detail: "New proposals will appear here when agents draft skills.",
                            value: "empty",
                            color: .secondary,
                            actionTitle: nil,
                            action: nil)
                    }

                    self.previewHeader("Offline / Error")
                    ProCard(radius: OpenClawProMetric.cardRadius) {
                        ProStatusRow(
                            icon: "wifi.slash",
                            title: "Workshop offline",
                            detail: "Connect to the gateway to load Skill Workshop proposals.",
                            value: "offline",
                            color: .secondary,
                            actionTitle: nil,
                            action: nil)
                        Divider().padding(.leading, 58)
                        ProStatusRow(
                            icon: "exclamationmark.triangle",
                            title: "Proposal unavailable",
                            detail: "Try again after the gateway reconnects.",
                            value: "error",
                            color: OpenClawBrand.warn,
                            actionTitle: nil,
                            action: nil)
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
    }

    private func previewHeader(_ title: String) -> some View {
        Text(title)
            .font(OpenClawType.subheadSemiBold)
            .foregroundStyle(.secondary)
    }

    private func queueCard(
        _ proposals: [IPadSkillProposal],
        selectedID: String?,
        busyID: String?) -> some View
    {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: "Queue",
                    value: "\(proposals.count)",
                    actionTitle: nil,
                    action: nil)
                ForEach(Array(proposals.enumerated()), id: \.element.id) { index, proposal in
                    if index > 0 {
                        Divider().padding(.leading, 58)
                    }
                    IPadSkillProposalRow(
                        proposal: proposal,
                        isSelected: proposal.id == selectedID,
                        isBusy: proposal.id == busyID)
                }
            }
        }
    }
}

private struct IPadSkillWorkshopKanbanPreview: View {
    private let lanes = IPadSkillWorkshopPreviewFixtures.kanbanStatuses
    private let proposals = IPadSkillWorkshopPreviewFixtures.proposals

    var body: some View {
        ZStack {
            OpenClawProBackground()
            VStack(alignment: .leading, spacing: 18) {
                self.previewHeader
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(self.lanes, id: \.self) { status in
                            IPadSkillProposalKanbanColumn(
                                status: status,
                                proposals: self.proposals.filter { $0.status == status },
                                selectedProposalID: "preview-pending",
                                inspectingProposalID: "preview-needs-review",
                                canApplyProposalMutations: true,
                                busyAction: nil,
                                select: { _ in },
                                inspect: { _ in },
                                apply: { _ in },
                                reject: { _ in })
                                .frame(width: 282)
                        }
                    }
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
                }
            }
            .padding(.vertical, 22)
        }
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .regular)
    }

    private var previewHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("iPad kanban")
                .font(OpenClawType.headline)
            Text("Wide layout with populated, empty, held, and custom proposal lanes.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }
}

private enum IPadSkillWorkshopPreviewFixtures {
    static let kanbanStatuses = [
        "pending",
        "quarantined",
        "stale",
        "applied",
        "rejected",
        "needs-review",
        "manual_QA",
    ]

    static let proposals = [
        Self.proposal(
            id: "preview-pending",
            status: "pending",
            title: "Add Tailscale gateway helper",
            description: "Drafts a helper skill for checking local Tailscale reachability before pairing.",
            minutesAgo: 9),
        Self.proposal(
            id: "preview-applied",
            status: "applied",
            title: "Summarize channel health",
            description: "Adds a lightweight status summary for channel clients and recent routing failures.",
            minutesAgo: 47),
        Self.proposal(
            id: "preview-held",
            status: "quarantined",
            title: "Desktop automation bridge",
            description: "Held for review because it requests broader file access than mobile should expose.",
            minutesAgo: 128),
        Self.proposal(
            id: "preview-needs-review",
            status: "needs-review",
            title: "Review pairing diagnostics",
            description: "Adds a diagnostic checklist before trusting a new gateway certificate.",
            minutesAgo: 32),
        Self.proposal(
            id: "preview-manual-qa",
            status: "manual_QA",
            title: "Manual QA runbook",
            description: "Generates a device checklist for iPhone portrait and iPad split layouts.",
            minutesAgo: 15),
    ]

    private static func proposal(
        id: String,
        status: String,
        title: String,
        description: String,
        minutesAgo: Int) -> IPadSkillProposal
    {
        let updatedAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(-minutesAgo * 60)))
        return IPadSkillProposal(
            entry: IPadSkillProposalManifestEntry(
                id: id,
                status: status,
                title: title,
                description: description,
                skillName: title,
                skillKey: id,
                updatedAt: updatedAt,
                scanState: "complete"),
            previous: nil)
    }
}
#endif
