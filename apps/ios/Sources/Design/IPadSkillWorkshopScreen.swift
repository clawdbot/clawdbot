import OpenClawKit
import SwiftUI

struct IPadSkillWorkshopScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var proposals: [IPadSkillProposal] = []
    @State private var selectedProposalID: String?
    @State private var selectedAgentScopeID = ""
    @State private var statusFilter = "pending"
    @State private var query = ""
    @State private var isLoading = false
    @State private var inspectingProposalID: String?
    @State private var busyAction: IPadSkillProposalAction?
    @State private var errorText: String?
    @State private var noticeText: String?
    @State private var presentedProposalRoute: IPadSkillProposalSheetRoute?
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let openSettings: () -> Void

    init(
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        openSettings: @escaping () -> Void = {})
    {
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.openSettings = openSettings
    }

    var body: some View {
        IPadSidebarScreenChrome(
            title: "Skill Workshop",
            subtitle: "Review and apply proposed skills.",
            headerSidebarAction: self.headerSidebarAction,
            usesNativeNavigationChrome: self.usesNativeNavigationChrome,
            gatewayAction: self.openSettings)
        {
            if self.isCompactWidth {
                self.compactFiltersCard
            } else {
                ProMetricGrid(metrics: self.metrics)
                self.filtersCard
            }
            self.proposalContent
        }
        .task(id: self.refreshID) {
            await self.loadProposals(force: false)
        }
        .refreshable {
            await self.loadProposals(force: true)
        }
        .onChange(of: self.statusFilter) { _, _ in
            self.syncSelectedProposalIDForVisibleProposals()
        }
        .onChange(of: self.query) { _, _ in
            self.syncSelectedProposalIDForVisibleProposals()
        }
        .sheet(item: self.$presentedProposalRoute) { route in
            NavigationStack {
                ScrollView {
                    self.presentedProposalDetail(proposalID: route.proposalID)
                        .padding(.horizontal, OpenClawProMetric.pagePadding)
                        .padding(.vertical, OpenClawSpacing.space4)
                }
                .background(OpenClawProBackground())
                .navigationTitle("Proposal")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            self.presentedProposalRoute = nil
                        } label: {
                            Text("Done")
                                .font(OpenClawType.subheadSemiBold)
                        }
                    }
                }
            }
        }
    }

    private var metrics: [ProMetric] {
        [
            ProMetric(
                icon: "clock",
                title: "Pending",
                value: "\(self.count("pending"))",
                color: OpenClawBrand.warn),
            ProMetric(
                icon: "checkmark.circle",
                title: "Applied",
                value: "\(self.count("applied"))",
                color: OpenClawBrand.ok),
            ProMetric(
                icon: "shield",
                title: "Held",
                value: "\(self.count("quarantined") + self.count("stale"))",
                color: .secondary),
        ]
    }

    private var filtersCard: some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.agentScopeMenu
                self.proposalSearchField
                Picker(selection: self.$statusFilter) {
                    ForEach(Self.proposalStatusFilters, id: \.self) { filter in
                        Text(Self.proposalStatusFilterLabel(filter))
                            .font(OpenClawType.captionSemiBold)
                            .tag(filter)
                    }
                } label: {
                    Text("Status")
                        .font(OpenClawType.captionSemiBold)
                }
                .pickerStyle(.segmented)
                .controlSize(.small)
                .tint(OpenClawBrand.accent)
                HStack(spacing: 8) {
                    Button {
                        Task { await self.loadProposals(force: true) }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(self.neutralControlTint)
                    .disabled(self.isLoading)

                    if self.isLoading {
                        ProgressView().controlSize(.small)
                    }
                }
                if let noticeText {
                    Text(noticeText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.accent)
                }
                if let errorText {
                    Text(errorText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var compactFiltersCard: some View {
        let count = self.filteredProposals.count
        let countText = String(
            AttributedString(localized: "^[\(count) proposal](inflect: true)").characters)
        return ProCard(radius: OpenClawProMetric.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: countText)
                            .font(OpenClawType.headline)
                        Text(self.statusFilterLabel)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    if self.isLoading {
                        ProgressView().controlSize(.small)
                    }
                }

                self.agentScopeMenu
                Picker(selection: self.$statusFilter) {
                    ForEach(Self.proposalStatusFilters, id: \.self) { filter in
                        Text(Self.proposalStatusFilterLabel(filter))
                            .font(OpenClawType.captionSemiBold)
                            .tag(filter)
                    }
                } label: {
                    Text("Status")
                        .font(OpenClawType.captionSemiBold)
                }
                .pickerStyle(.segmented)
                .controlSize(.small)
                .tint(OpenClawBrand.accent)

                self.proposalSearchField

                HStack(spacing: 8) {
                    Button {
                        Task { await self.loadProposals(force: true) }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(OpenClawType.captionSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(self.neutralControlTint)
                    .disabled(self.isLoading)
                }
                if let noticeText {
                    Text(noticeText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.accent)
                }
                if let errorText {
                    Text(errorText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var proposalSearchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            TextField("Search proposals", text: self.$query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(OpenClawType.subhead)
            if !self.query.isEmpty {
                Button {
                    self.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var agentScopeMenu: some View {
        HStack(spacing: 8) {
            Text("Agent")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            Menu {
                Button {
                    self.selectedAgentScopeID = ""
                } label: {
                    Text("Default agent")
                        .font(OpenClawType.subhead)
                }
                ForEach(self.agentScopeOptions, id: \.id) { option in
                    Button {
                        self.selectedAgentScopeID = option.id
                    } label: {
                        Text(option.title)
                            .font(OpenClawType.subhead)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(self.agentScopeLabel)
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(OpenClawType.caption2Bold)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(self.neutralControlTint)
            .disabled(self.agentScopeOptions.isEmpty)
            .accessibilityLabel("Skill Workshop agent scope")
        }
    }

    private var neutralControlTint: Color {
        Color.primary.opacity(0.55)
    }

    private var proposalContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if self.filteredProposals.isEmpty {
                ProCard(radius: OpenClawProMetric.cardRadius) {
                    ProStatusRow(
                        icon: self.canRead ? "hammer" : "wifi.slash",
                        title: self.canRead ? "No proposals" : "No proposals loaded",
                        detail: self.canRead
                            ? "New proposals will appear here when agents draft skills."
                            : "Connect from Settings to load Skill Workshop proposals.",
                        value: self.canRead ? "empty" : nil,
                        color: .secondary,
                        actionTitle: nil,
                        action: nil)
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
            } else {
                if self.isCompactWidth {
                    VStack(alignment: .leading, spacing: 12) {
                        self.proposalList
                    }
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
                } else {
                    self.proposalBoard
                }
            }
        }
    }

    private var proposalBoard: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(self.visibleProposalLaneStatuses, id: \.self) { status in
                    IPadSkillProposalKanbanColumn(
                        status: status,
                        proposals: self.proposals(forLaneStatus: status),
                        selectedProposalID: self.selectedProposalID,
                        inspectingProposalID: self.inspectingProposalID,
                        canApplyProposalMutations: self.canApplyProposalMutations,
                        busyAction: self.busyAction,
                        select: { proposal in
                            self.selectProposal(
                                proposal,
                                opensSheet: true,
                                forceInspect: false)
                        },
                        inspect: { proposal in
                            self.selectProposal(
                                proposal,
                                opensSheet: true,
                                forceInspect: true)
                        },
                        apply: { proposal in
                            Task { await self.run(.apply, proposal: proposal) }
                        },
                        reject: { proposal in
                            Task { await self.run(.reject, proposal: proposal) }
                        })
                        .frame(width: 282)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
        .scrollIndicators(.visible)
    }

    private var proposalList: some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: "Queue",
                    value: "\(self.filteredProposals.count)",
                    actionTitle: nil,
                    action: nil)
                ForEach(Array(self.filteredProposals.enumerated()), id: \.element.id) { index, proposal in
                    if index > 0 {
                        Divider().padding(.leading, 58)
                    }
                    Button {
                        self.selectProposal(
                            proposal,
                            opensSheet: self.isCompactWidth,
                            forceInspect: false)
                    } label: {
                        IPadSkillProposalRow(
                            proposal: proposal,
                            isSelected: proposal.id == self.selectedProposalID,
                            isBusy: self.inspectingProposalID == proposal.id)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button {
                            self.selectProposal(
                                proposal,
                                opensSheet: true,
                                forceInspect: true)
                        } label: {
                            Text("Inspect")
                                .font(OpenClawType.subhead)
                        }
                        if proposal.status == "pending" {
                            Button {
                                Task { await self.run(.apply, proposal: proposal) }
                            } label: {
                                Text("Apply")
                                    .font(OpenClawType.subhead)
                            }
                            .disabled(!self.canApplyProposalMutations || self.busyAction != nil)
                            Button(role: .destructive) {
                                Task { await self.run(.reject, proposal: proposal) }
                            } label: {
                                Text("Reject")
                                    .font(OpenClawType.subhead)
                            }
                            .disabled(!self.canApplyProposalMutations || self.busyAction != nil)
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if proposal.status == "pending" {
                            Button {
                                Task { await self.run(.apply, proposal: proposal) }
                            } label: {
                                Text("Apply")
                                    .font(OpenClawType.subhead)
                            }
                            .tint(OpenClawBrand.ok)
                            .disabled(!self.canApplyProposalMutations || self.busyAction != nil)
                            Button(role: .destructive) {
                                Task { await self.run(.reject, proposal: proposal) }
                            } label: {
                                Text("Reject")
                                    .font(OpenClawType.subhead)
                            }
                            .disabled(!self.canApplyProposalMutations || self.busyAction != nil)
                        }
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button {
                            self.selectProposal(
                                proposal,
                                opensSheet: true,
                                forceInspect: true)
                        } label: {
                            Text("Inspect")
                                .font(OpenClawType.subhead)
                        }
                        .tint(OpenClawBrand.accent)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func presentedProposalDetail(proposalID: String) -> some View {
        if let proposal = proposal(withID: proposalID) {
            self.proposalDetailCard(proposal)
        } else {
            ProCard(radius: OpenClawProMetric.cardRadius) {
                ProStatusRow(
                    icon: "hammer",
                    title: "Proposal unavailable",
                    detail: "Return to the queue and choose another proposal.",
                    value: "missing",
                    color: .secondary,
                    actionTitle: nil,
                    action: nil)
            }
        }
    }

    private func proposalDetailCard(_ proposal: IPadSkillProposal) -> some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: "hammer", color: proposal.statusColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(proposal.title)
                            .font(OpenClawType.headline)
                        Text(proposal.description)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    ProValuePill(value: proposal.status, color: proposal.statusColor)
                }

                if self.inspectingProposalID == proposal.id {
                    ProgressView().controlSize(.small)
                }

                if let content = proposal.content, !content.isEmpty {
                    Text(content)
                        .font(OpenClawType.monoSmall)
                        .foregroundStyle(.secondary)
                        .lineLimit(16)
                        .textSelection(.enabled)
                } else {
                    Text("Select refresh to load the proposal body.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }

                if !proposal.supportFiles.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Support files")
                            .font(OpenClawType.subheadSemiBold)
                        ForEach(proposal.supportFiles, id: \.path) { file in
                            Text(file.path)
                                .font(OpenClawType.monoCaption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }

                if proposal.status == "pending" {
                    if self.isCompactWidth {
                        VStack(spacing: 8) {
                            self.proposalApplyButton(proposal)
                            self.proposalRejectButton(proposal)
                            self.proposalInspectButton(proposal)
                        }
                    } else {
                        HStack(spacing: 8) {
                            self.proposalApplyButton(proposal)
                            self.proposalRejectButton(proposal)
                            self.proposalInspectButton(proposal)
                        }
                    }
                    if !self.canApplyProposalMutations {
                        self.adminScopeNotice
                    }
                }
            }
        }
    }

    private func proposalApplyButton(_ proposal: IPadSkillProposal) -> some View {
        Button {
            Task { await self.run(.apply, proposal: proposal) }
        } label: {
            Label("Apply", systemImage: "checkmark.circle")
                .font(OpenClawType.captionSemiBold)
                .frame(maxWidth: self.isCompactWidth ? .infinity : nil)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(!self.canApplyProposalMutations || self.busyAction != nil)
    }

    private func proposalRejectButton(_ proposal: IPadSkillProposal) -> some View {
        Button(role: .destructive) {
            Task { await self.run(.reject, proposal: proposal) }
        } label: {
            Label("Reject", systemImage: "xmark.circle")
                .font(OpenClawType.captionSemiBold)
                .frame(maxWidth: self.isCompactWidth ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!self.canApplyProposalMutations || self.busyAction != nil)
    }

    private func proposalInspectButton(_ proposal: IPadSkillProposal) -> some View {
        Button {
            Task { await self.inspect(proposalID: proposal.id, force: true) }
        } label: {
            Label("Inspect", systemImage: "doc.text.magnifyingglass")
                .font(OpenClawType.captionSemiBold)
                .frame(maxWidth: self.isCompactWidth ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(self.inspectingProposalID != nil)
    }

    private var refreshID: String {
        [
            self.canRead ? "connected" : "offline",
            self.scenePhase == .active ? "active" : "inactive",
            self.selectedAgentScopeID.isEmpty ? "default" : self.selectedAgentScopeID,
        ].joined(separator: ":")
    }

    private var canRead: Bool {
        self.appModel.isOperatorGatewayConnected
    }

    private var canWrite: Bool {
        self.appModel.isOperatorGatewayConnected && !self.appModel.isAppleReviewDemoModeEnabled
    }

    private var canApplyProposalMutations: Bool {
        Self.shouldEnableProposalMutation(
            canWrite: self.canWrite,
            hasOperatorAdminScope: self.appModel.hasOperatorAdminScope)
    }

    private var agentScopeOptions: [IPadSkillWorkshopAgentScope] {
        let defaultID = Self.normalizedScopeID(self.appModel.gatewayDefaultAgentId)
        return self.appModel.gatewayAgents
            .filter(\.isSelectableAgent)
            .filter { Self.normalizedScopeID($0.id) != defaultID }
            .map { agent in
                let name = Self.normalizedScopeID(agent.name)
                return IPadSkillWorkshopAgentScope(
                    id: Self.normalizedScopeID(agent.id),
                    title: name.isEmpty ? agent.id : name)
            }
            .filter { !$0.id.isEmpty }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    private var agentScopeLabel: String {
        let selected = Self.normalizedScopeID(self.selectedAgentScopeID)
        guard !selected.isEmpty else { return self.defaultAgentScopeLabel }
        return self.agentScopeOptions.first(where: { $0.id == selected })?.title ?? selected
    }

    private var defaultAgentScopeLabel: String {
        let defaultID = Self.normalizedScopeID(self.appModel.gatewayDefaultAgentId)
        if let match = appModel.gatewayAgents.first(where: { Self.normalizedScopeID($0.id) == defaultID }) {
            let name = Self.normalizedScopeID(match.name)
            return name.isEmpty ? String(localized: "Default agent") : name
        }
        let activeName = Self.normalizedScopeID(self.appModel.activeAgentName)
        return activeName.isEmpty ? String(localized: "Default agent") : activeName
    }

    private var selectedAgentParam: String? {
        let selected = Self.normalizedScopeID(self.selectedAgentScopeID)
        return selected.isEmpty ? nil : selected
    }

    static func shouldEnableProposalMutation(canWrite: Bool, hasOperatorAdminScope: Bool) -> Bool {
        canWrite && hasOperatorAdminScope
    }

    private var adminScopeNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.shield")
                .foregroundStyle(OpenClawBrand.warn)
            Text("Admin scope required.")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
        }
        .padding(.top, 2)
    }

    private var isCompactWidth: Bool {
        Self.usesCompactTaskFlow(
            horizontalSizeClass: self.horizontalSizeClass,
            verticalSizeClass: self.verticalSizeClass)
    }

    static func usesCompactTaskFlow(
        horizontalSizeClass: UserInterfaceSizeClass?,
        verticalSizeClass: UserInterfaceSizeClass?) -> Bool
    {
        horizontalSizeClass == .compact || verticalSizeClass == .compact
    }

    static let proposalStatusFilters = ["pending", "held", "applied", "rejected", "all"]

    static let defaultProposalStatusBoardLanes = ["pending", "quarantined", "stale", "applied", "rejected"]

    static func proposalStatusFilterLabel(_ filter: String) -> String {
        switch filter {
        case "pending": String(localized: "Pending")
        case "held": String(localized: "Held")
        case "applied": String(localized: "Applied")
        case "rejected": String(localized: "Rejected")
        default: String(localized: "All")
        }
    }

    static func proposalLaneLabel(_ status: String) -> String {
        switch status {
        case "quarantined": String(localized: "Quarantined")
        case "stale": String(localized: "Stale")
        case "pending", "applied", "rejected":
            self.proposalStatusFilterLabel(status)
        default:
            self.titleCasedProposalStatus(status)
        }
    }

    static func titleCasedProposalStatus(_ status: String) -> String {
        status
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { word in
                let text = String(word)
                if text == text.uppercased() {
                    return text
                }
                return text.prefix(1).uppercased() + text.dropFirst().lowercased()
            }
            .joined(separator: " ")
    }

    static func proposalStatusBoardLanes(filter: String, proposalStatuses: [String]) -> [String] {
        let customStatuses = proposalStatuses
            .filter { !self.defaultProposalStatusBoardLanes.contains($0) }
            .sorted()
        switch filter {
        case "all":
            return self.defaultProposalStatusBoardLanes + customStatuses
        case "held":
            return ["quarantined", "stale"]
        case "pending", "applied", "rejected":
            return [filter]
        default:
            return [filter]
        }
    }

    static func proposalStatusMatchesFilter(status: String, filter: String) -> Bool {
        switch filter {
        case "all":
            true
        case "held":
            status == "quarantined" || status == "stale"
        default:
            status == filter
        }
    }

    static func nextSelectedProposalID(
        current: String?,
        proposals: [(id: String, status: String)],
        filter: String) -> String?
    {
        let filtered = proposals.filter { Self.proposalStatusMatchesFilter(status: $0.status, filter: filter) }
        return Self.nextSelectedProposalID(current: current, visibleProposalIDs: filtered.map(\.id))
    }

    static func nextSelectedProposalID(current: String?, visibleProposalIDs: [String]) -> String? {
        guard !visibleProposalIDs.isEmpty else { return nil }
        if let current, visibleProposalIDs.contains(current) {
            return current
        }
        return visibleProposalIDs.first
    }

    static func normalizedScopeID(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var statusFilterLabel: String {
        Self.proposalStatusFilterLabel(self.statusFilter)
    }

    private var filteredProposals: [IPadSkillProposal] {
        let trimmedQuery = self.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.proposals
            .filter { proposal in
                Self.proposalStatusMatchesFilter(status: proposal.status, filter: self.statusFilter)
            }
            .filter { proposal in
                guard !trimmedQuery.isEmpty else { return true }
                return [
                    proposal.title,
                    proposal.description,
                    proposal.skillName,
                    proposal.skillKey,
                ]
                    .joined(separator: " ")
                    .lowercased()
                    .contains(trimmedQuery)
            }
    }

    private var visibleProposalLaneStatuses: [String] {
        Self.proposalStatusBoardLanes(
            filter: self.statusFilter,
            proposalStatuses: self.proposals.map(\.status))
    }

    private func proposals(forLaneStatus status: String) -> [IPadSkillProposal] {
        let trimmedQuery = self.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.proposals
            .filter { $0.status == status }
            .filter { proposal in
                guard !trimmedQuery.isEmpty else { return true }
                return [
                    proposal.title,
                    proposal.description,
                    proposal.skillName,
                    proposal.skillKey,
                ]
                    .joined(separator: " ")
                    .lowercased()
                    .contains(trimmedQuery)
            }
            .sorted { $0.updatedAtMs > $1.updatedAtMs }
    }

    private func syncSelectedProposalIDForVisibleProposals() {
        let nextID = Self.nextSelectedProposalID(
            current: self.selectedProposalID,
            visibleProposalIDs: self.filteredProposals.map(\.id))
        guard self.selectedProposalID != nextID else { return }
        self.selectedProposalID = nextID
    }

    private func count(_ status: String) -> Int {
        self.proposals.count(where: { $0.status == status })
    }

    private func proposal(withID id: String) -> IPadSkillProposal? {
        self.proposals.first { $0.id == id }
    }

    private func selectProposal(
        _ proposal: IPadSkillProposal,
        opensSheet: Bool,
        forceInspect: Bool)
    {
        self.selectedProposalID = proposal.id
        if opensSheet {
            self.presentedProposalRoute = IPadSkillProposalSheetRoute(proposalID: proposal.id)
        }
        Task { await self.inspect(proposalID: proposal.id, force: forceInspect) }
    }

    private func loadProposals(force: Bool) async {
        guard self.scenePhase == .active else { return }
        guard self.canRead else {
            self.proposals = []
            self.errorText = nil
            return
        }
        guard !self.isLoading else { return }

        self.isLoading = true
        self.errorText = nil
        defer { self.isLoading = false }

        do {
            let data = try await request(
                method: "skills.proposals.list",
                params: IPadSkillProposalListParams(agentId: selectedAgentParam),
                timeoutSeconds: 20)
            let response = try JSONDecoder().decode(IPadSkillProposalManifest.self, from: data)
            let previousByID = Dictionary(uniqueKeysWithValues: proposals.map { ($0.id, $0) })
            let next = response.proposals
                .map { IPadSkillProposal(entry: $0, previous: previousByID[$0.id]) }
                .sorted { $0.updatedAtMs > $1.updatedAtMs }
            self.proposals = next
            self.syncSelectedProposalIDForVisibleProposals()
            if let selectedProposalID {
                await self.inspect(proposalID: selectedProposalID, force: force)
            }
        } catch {
            if force || self.proposals.isEmpty {
                self.errorText = Self.message(for: error)
            }
        }
    }

    private func inspect(proposalID: String, force: Bool) async {
        guard self.canRead else { return }
        guard force || self.proposals.first(where: { $0.id == proposalID })?.content == nil else { return }
        guard self.inspectingProposalID == nil else { return }

        self.inspectingProposalID = proposalID
        self.errorText = nil
        defer { self.inspectingProposalID = nil }

        do {
            let data = try await request(
                method: "skills.proposals.inspect",
                params: IPadSkillProposalInspectParams(
                    agentId: selectedAgentParam,
                    proposalId: proposalID),
                timeoutSeconds: 20)
            let response = try JSONDecoder().decode(IPadSkillProposalInspectResponse.self, from: data)
            self.merge(IPadSkillProposal(inspect: response, previous: self.proposals.first { $0.id == proposalID }))
        } catch {
            self.errorText = Self.message(for: error)
        }
    }

    private func run(_ action: IPadSkillProposalAction.Kind, proposal: IPadSkillProposal) async {
        guard self.canApplyProposalMutations, self.busyAction == nil else { return }
        self.busyAction = IPadSkillProposalAction(kind: action, proposalID: proposal.id)
        self.errorText = nil
        self.noticeText = nil
        defer { self.busyAction = nil }

        do {
            let method = action == .apply ? "skills.proposals.apply" : "skills.proposals.reject"
            _ = try await self.request(
                method: method,
                params: IPadSkillProposalInspectParams(
                    agentId: self.selectedAgentParam,
                    proposalId: proposal.id),
                timeoutSeconds: 30)
            self.noticeText = action == .apply
                ? String(localized: "Proposal applied.")
                : String(localized: "Proposal rejected.")
            await self.loadProposals(force: true)
        } catch {
            self.errorText = Self.message(for: error)
        }
    }

    private func merge(_ proposal: IPadSkillProposal) {
        self.proposals.removeAll { $0.id == proposal.id }
        self.proposals.append(proposal)
        self.proposals.sort { $0.updatedAtMs > $1.updatedAtMs }
    }

    private func request(method: String, params: some Encodable, timeoutSeconds: Int) async throws -> Data {
        guard self.canRead else { throw IPadSidebarGatewayError.offline }
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw IPadSidebarGatewayError.invalidPayload
        }
        return try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds)
    }

    private static func message(for error: Error) -> String {
        if let gatewayError = error as? IPadSidebarGatewayError {
            return gatewayError.message
        }
        return error.localizedDescription
    }
}

struct IPadSkillProposalKanbanColumn: View {
    let status: String
    let proposals: [IPadSkillProposal]
    let selectedProposalID: String?
    let inspectingProposalID: String?
    let canApplyProposalMutations: Bool
    let busyAction: IPadSkillProposalAction?
    let select: (IPadSkillProposal) -> Void
    let inspect: (IPadSkillProposal) -> Void
    let apply: (IPadSkillProposal) -> Void
    let reject: (IPadSkillProposal) -> Void

    var body: some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: .localized(IPadSkillWorkshopScreen.proposalLaneLabel(self.status)),
                    value: "\(self.proposals.count)",
                    actionTitle: nil,
                    action: nil)

                if self.proposals.isEmpty {
                    let lane = IPadSkillWorkshopScreen.proposalLaneLabel(self.status)
                    ProStatusRow(
                        icon: "hammer",
                        title: .verbatim(
                            String(
                                format: String(localized: "No proposals in %@"),
                                lane)),
                        detail: "Matching proposals appear here after gateway refresh.",
                        value: "empty",
                        color: .secondary,
                        actionTitle: nil,
                        action: nil)
                } else {
                    ForEach(Array(self.proposals.enumerated()), id: \.element.id) { index, proposal in
                        if index > 0 {
                            Divider().padding(.leading, 12)
                        }
                        IPadSkillProposalKanbanCard(
                            proposal: proposal,
                            isSelected: proposal.id == self.selectedProposalID,
                            isInspecting: proposal.id == self.inspectingProposalID,
                            canApplyProposalMutations: self.canApplyProposalMutations,
                            isBusy: self.busyAction != nil,
                            select: {
                                self.select(proposal)
                            },
                            inspect: {
                                self.inspect(proposal)
                            },
                            apply: {
                                self.apply(proposal)
                            },
                            reject: {
                                self.reject(proposal)
                            })
                    }
                }
            }
        }
    }
}

private struct IPadSkillProposalKanbanCard: View {
    let proposal: IPadSkillProposal
    let isSelected: Bool
    let isInspecting: Bool
    let canApplyProposalMutations: Bool
    let isBusy: Bool
    let select: () -> Void
    let inspect: () -> Void
    let apply: () -> Void
    let reject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: self.select) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 10) {
                        ProIconBadge(
                            systemName: self.isInspecting ? "hourglass" : "hammer",
                            color: self.proposal.statusColor)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(self.proposal.title)
                                .font(OpenClawType.subheadSemiBold)
                                .foregroundStyle(self.isSelected ? OpenClawBrand.accent : .primary)
                                .lineLimit(2)
                            Text(self.proposal.description)
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                    HStack(spacing: 8) {
                        ProValuePill(value: self.proposal.status, color: self.proposal.statusColor)
                        Spacer(minLength: 4)
                        Text(self.proposal.ageLabel)
                            .font(OpenClawType.caption2SemiBold)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                if self.proposal.status == "pending" {
                    Button(action: self.apply) {
                        Image(systemName: "checkmark.circle")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .accessibilityLabel("Apply Proposal")
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .disabled(!self.canApplyProposalMutations || self.isBusy)

                    Button(role: .destructive, action: self.reject) {
                        Image(systemName: "xmark.circle")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .accessibilityLabel("Reject Proposal")
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .disabled(!self.canApplyProposalMutations || self.isBusy)
                }

                Button(action: self.inspect) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(OpenClawType.captionSemiBold)
                }
                .accessibilityLabel("Inspect Proposal")
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(self.isInspecting)
            }
        }
        .padding(OpenClawSpacing.space3)
        .background(
            self.isSelected ? OpenClawBrand.accent.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous))
        .contentShape(Rectangle())
        .contextMenu {
            Button(action: self.inspect) {
                Text("Inspect")
                    .font(OpenClawType.subhead)
            }
            if self.proposal.status == "pending" {
                Button(action: self.apply) {
                    Text("Apply")
                        .font(OpenClawType.subhead)
                }
                .disabled(!self.canApplyProposalMutations || self.isBusy)
                Button(role: .destructive, action: self.reject) {
                    Text("Reject")
                        .font(OpenClawType.subhead)
                }
                .disabled(!self.canApplyProposalMutations || self.isBusy)
            }
        }
    }
}

struct IPadSkillProposalRow: View {
    let proposal: IPadSkillProposal
    let isSelected: Bool
    let isBusy: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.isBusy ? "hourglass" : "hammer", color: self.proposal.statusColor)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.proposal.title)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(self.isSelected ? OpenClawBrand.accent : .primary)
                    .lineLimit(1)
                Text(self.proposal.description)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Text(self.proposal.ageLabel)
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            self.isSelected ? OpenClawBrand.danger.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous))
    }
}

private struct IPadSkillProposalSheetRoute: Identifiable {
    let proposalID: String

    var id: String {
        self.proposalID
    }
}

struct IPadSkillProposalAction: Equatable {
    enum Kind {
        case apply
        case reject
    }

    let kind: Kind
    let proposalID: String
}

private struct IPadSkillProposalManifest: Decodable {
    let proposals: [IPadSkillProposalManifestEntry]
}

struct IPadSkillProposalManifestEntry: Decodable {
    let id: String
    let status: String
    let title: String
    let description: String
    let skillName: String
    let skillKey: String
    let updatedAt: String
    let scanState: String
}

private struct IPadSkillWorkshopAgentScope: Identifiable {
    let id: String
    let title: String
}

private struct IPadSkillProposalListParams: Encodable {
    let agentId: String?
}

private struct IPadSkillProposalInspectParams: Encodable {
    let agentId: String?
    let proposalId: String
}

struct IPadSkillProposalInspectResponse: Decodable {
    let record: IPadSkillProposalRecord
    let content: String
    let supportFiles: [IPadSkillProposalSupportFile]?
}

struct IPadSkillProposalRecord: Decodable {
    let id: String
    let status: String
    let title: String
    let description: String
    let updatedAt: String
    let target: IPadSkillProposalTarget
}

struct IPadSkillProposalTarget: Decodable {
    let skillName: String
    let skillKey: String
}

struct IPadSkillProposalSupportFile: Decodable {
    let path: String
    let content: String?
}

struct IPadSkillProposal: Identifiable {
    let id: String
    let status: String
    let title: String
    let description: String
    let skillName: String
    let skillKey: String
    let updatedAtMs: Double
    var content: String?
    var supportFiles: [IPadSkillProposalSupportFile]

    init(entry: IPadSkillProposalManifestEntry, previous: IPadSkillProposal?) {
        self.id = entry.id
        self.status = entry.status
        self.title = entry.title.isEmpty ? entry.skillName : entry.title
        self.description = entry.description
        self.skillName = entry.skillName
        self.skillKey = entry.skillKey
        self.updatedAtMs = Self.parseDate(entry.updatedAt)
        self.content = previous?.updatedAtMs == self.updatedAtMs ? previous?.content : nil
        self.supportFiles = previous?.updatedAtMs == self.updatedAtMs ? previous?.supportFiles ?? [] : []
    }

    init(inspect: IPadSkillProposalInspectResponse, previous: IPadSkillProposal?) {
        let record = inspect.record
        self.id = record.id
        self.status = record.status
        self.title = record.title.isEmpty ? record.target.skillName : record.title
        self.description = record.description
        self.skillName = record.target.skillName
        self.skillKey = record.target.skillKey
        self.updatedAtMs = Self.parseDate(record.updatedAt)
        self.content = Self.stripFrontmatter(inspect.content)
        self.supportFiles = inspect.supportFiles ?? previous?.supportFiles ?? []
    }

    var ageLabel: String {
        let diff = max(0, Date().timeIntervalSince1970 * 1000 - self.updatedAtMs)
        let minutes = Int(diff / 60000)
        if minutes < 1 { return String(localized: "now") }
        if minutes < 60 {
            return String(format: String(localized: "%@m"), minutes.formatted())
        }
        let hours = minutes / 60
        if hours < 24 {
            return String(format: String(localized: "%@h"), hours.formatted())
        }
        return String(format: String(localized: "%@d"), (hours / 24).formatted())
    }

    var statusColor: Color {
        switch self.status {
        case "pending": OpenClawBrand.warn
        case "applied": OpenClawBrand.ok
        case "rejected": .secondary
        case "quarantined", "stale": OpenClawBrand.warn
        default: OpenClawBrand.accent
        }
    }

    private static func parseDate(_ value: String) -> Double {
        (ISO8601DateFormatter().date(from: value)?.timeIntervalSince1970 ?? Date().timeIntervalSince1970) * 1000
    }

    private static func stripFrontmatter(_ value: String) -> String {
        let pattern = #"(?s)^---\r?\n.*?\r?\n---\r?\n?"#
        return value.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
