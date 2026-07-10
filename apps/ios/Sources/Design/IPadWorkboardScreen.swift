import OpenClawKit
import SwiftUI

struct IPadWorkboardScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var cards: [IPadWorkboardCard] = []
    @State private var statuses: [String] = IPadWorkboardDefaults.statuses
    @State private var selectedStatus = "active"
    @State private var selectedBoardID = ""
    @State private var knownBoardIDs: [String] = []
    @State private var query = ""
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var draftTitle = ""
    @State private var draftNotes = ""
    @State private var isCreatingCard = false
    @State private var busyCardID: String?
    @State private var dispatchSummaryText: String?
    @State private var presentedSheet: IPadWorkboardSheet?
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let openChat: () -> Void
    let openSettings: () -> Void

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        openChat: @escaping () -> Void,
        openSettings: @escaping () -> Void = {})
    {
        self.headerLeadingAction = headerLeadingAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.openChat = openChat
        self.openSettings = openSettings
    }

    var body: some View {
        IPadSidebarScreenChrome(
            title: "Workboard",
            subtitle: self.currentWorkboardSubtitle,
            headerLeadingAction: self.headerLeadingAction,
            usesNativeNavigationChrome: self.usesNativeNavigationChrome,
            gatewayAction: self.openSettings)
        {
            if self.isCompactWidth {
                self.compactQueueControls
                self.compactCardsPanel
            } else {
                ProMetricGrid(metrics: self.metrics)
                self.controlsCard
                self.kanbanBoard
            }
        }
        .task(id: self.refreshID) {
            await self.loadCards(force: false)
        }
        .refreshable {
            await self.loadCards(force: true)
        }
        .sheet(item: self.$presentedSheet) { sheet in
            switch sheet {
            case .create:
                NavigationStack {
                    self.createCardSheet
                }
            case let .card(card):
                IPadWorkboardCardDetailSheet(
                    card: card,
                    statuses: self.statuses,
                    isBusy: self.busyCardID == card.id,
                    canWrite: self.canWrite,
                    openSession: { self.open(card) },
                    move: { status in Task { await self.move(card, to: status) } },
                    archive: { Task { await self.archive(card) } })
            }
        }
    }

    private var metrics: [ProMetric] {
        [
            ProMetric(
                icon: "tray.full",
                title: "Cards",
                value: "\(self.cards.count)",
                color: OpenClawBrand.accent),
            ProMetric(
                icon: "figure.run",
                title: "Running",
                value: "\(self.cards.count(where: { $0.status == "running" }))",
                color: OpenClawBrand.ok),
            ProMetric(
                icon: "exclamationmark.triangle",
                title: "Blocked",
                value: "\(self.cards.count(where: { $0.status == "blocked" }))",
                color: OpenClawBrand.warn),
        ]
    }

    private var controlsCard: some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.boardScopeMenu
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(.secondary)
                    TextField("Search cards", text: self.$query)
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
                if self.isCompactWidth {
                    self.statusMenu
                } else {
                    Picker(selection: self.$selectedStatus) {
                        Text("Active")
                            .font(OpenClawType.captionSemiBold)
                            .tag("active")
                        ForEach(self.statuses, id: \.self) { status in
                            Text(IPadWorkboardDefaults.label(for: status))
                                .font(OpenClawType.captionSemiBold)
                                .tag(status)
                        }
                    } label: {
                        Text("Scope")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .pickerStyle(.segmented)
                    .controlSize(.small)
                    .tint(OpenClawBrand.accent)
                }

                HStack(spacing: 8) {
                    self.newCardButton(expands: false)

                    Button {
                        Task { await self.dispatchCards() }
                    } label: {
                        Label("Dispatch", systemImage: "bolt.fill")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(!self.canWrite || self.isLoading)

                    Button {
                        Task { await self.loadCards(force: true) }
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

                if let dispatchSummaryText {
                    Text(dispatchSummaryText)
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

    private var compactQueueControls: some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(self.filteredCards.count) cards")
                        .font(OpenClawType.headline)
                    Spacer(minLength: 8)
                    self.compactRefreshButton
                }

                self.compactBoardScopeMenu
                self.compactStatusPicker

                if self.canWrite {
                    HStack(spacing: 8) {
                        self.newCardButton(expands: true)

                        Button {
                            Task { await self.dispatchCards() }
                        } label: {
                            Label("Dispatch", systemImage: "bolt.fill")
                                .font(OpenClawType.captionSemiBold)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(self.isLoading)
                    }
                } else {
                    Text(Self.compactWriteUnavailableMessage(canRead: self.canRead))
                        .font(OpenClawType.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                if let dispatchSummaryText {
                    Text(dispatchSummaryText)
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

    private var compactRefreshButton: some View {
        Button {
            Task { await self.loadCards(force: true) }
        } label: {
            Image(systemName: "arrow.clockwise")
                .font(OpenClawType.captionSemiBold)
                .frame(width: 32, height: 32)
        }
        .buttonStyle(.plain)
        .foregroundStyle(self.neutralControlTint)
        .accessibilityLabel("Refresh workboard")
        .disabled(self.isLoading)
    }

    private func newCardButton(expands: Bool) -> some View {
        Button {
            self.beginCreateCard()
        } label: {
            Label("New Card", systemImage: "plus")
                .font(OpenClawType.captionSemiBold)
                .frame(maxWidth: expands ? .infinity : nil)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(self.isCreatingCard)
        .accessibilityHint("Opens card title and notes entry")
    }

    private var compactBoardScopeMenu: some View {
        Menu {
            Button {
                self.selectedBoardID = ""
            } label: {
                Text("All boards")
                    .font(OpenClawType.subhead)
            }
            ForEach(self.boardScopeOptions, id: \.self) { boardID in
                Button {
                    self.selectedBoardID = boardID
                } label: {
                    Text(Self.boardScopeLabel(for: boardID))
                        .font(OpenClawType.subhead)
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.stack")
                    .font(OpenClawType.captionSemiBold)
                Text(self.boardScopeLabel)
                    .font(OpenClawType.captionSemiBold)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(OpenClawType.caption2Bold)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(
                Color.primary.opacity(0.06),
                in: RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityLabel("Workboard board scope")
    }

    private var compactStatusPicker: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                self.compactStatusChip("active")
                ForEach(self.compactStatuses, id: \.self) { status in
                    self.compactStatusChip(status)
                }
            }
            .padding(.vertical, 1)
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .trailing) {
            LinearGradient(
                colors: [.clear, Color(uiColor: .secondarySystemGroupedBackground)],
                startPoint: .leading,
                endPoint: .trailing)
                .frame(width: 24)
                .allowsHitTesting(false)
        }
    }

    private func compactStatusChip(_ status: String) -> some View {
        Button {
            self.selectedStatus = status
        } label: {
            Text(IPadWorkboardDefaults.label(for: status))
                .font(OpenClawType.caption2SemiBold)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(
                    self.selectedStatus == status
                        ? OpenClawBrand.accent.opacity(0.12)
                        : Color.primary.opacity(0.06),
                    in: Capsule())
                .overlay {
                    Capsule()
                        .strokeBorder(
                            self.selectedStatus == status
                                ? OpenClawBrand.accent.opacity(0.42)
                                : Color.primary.opacity(0.08),
                            lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .foregroundStyle(self.selectedStatus == status ? OpenClawBrand.accent : .primary)
        .accessibilityLabel("Show \(IPadWorkboardDefaults.label(for: status)) cards")
    }

    private var boardScopeMenu: some View {
        HStack(spacing: 8) {
            Text("Board")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            Menu {
                Button {
                    self.selectedBoardID = ""
                } label: {
                    Text("All boards")
                        .font(OpenClawType.subhead)
                }
                ForEach(self.boardScopeOptions, id: \.self) { boardID in
                    Button {
                        self.selectedBoardID = boardID
                    } label: {
                        Text(Self.boardScopeLabel(for: boardID))
                            .font(OpenClawType.subhead)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(self.boardScopeLabel)
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
            .accessibilityLabel("Workboard board scope")
        }
    }

    private var statusMenu: some View {
        HStack(spacing: 8) {
            Text("Status")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            Menu {
                Button {
                    self.selectedStatus = "active"
                } label: {
                    Text("Active")
                        .font(OpenClawType.subhead)
                }
                ForEach(self.statuses, id: \.self) { status in
                    Button {
                        self.selectedStatus = status
                    } label: {
                        Text(IPadWorkboardDefaults.label(for: status))
                            .font(OpenClawType.subhead)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(IPadWorkboardDefaults.label(for: self.selectedStatus))
                        .font(OpenClawType.subheadSemiBold)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(OpenClawType.caption2Bold)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(self.neutralControlTint)
        }
    }

    private var neutralControlTint: Color {
        Color.primary.opacity(0.55)
    }

    private var kanbanBoard: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(self.visibleKanbanStatuses, id: \.self) { status in
                    IPadWorkboardKanbanColumn(
                        status: status,
                        cards: self.cards(forKanbanStatus: status),
                        statuses: self.statuses,
                        busyCardID: self.busyCardID,
                        openSession: { card in
                            self.open(card)
                        },
                        inspect: { card in
                            self.presentedSheet = .card(card)
                        },
                        move: { card, status in
                            Task { await self.move(card, to: status) }
                        },
                        archive: { card in
                            Task { await self.archive(card) }
                        })
                        .frame(width: 282)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.visible)
    }

    private var compactCardsPanel: some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: "Queue",
                    value: "\(self.filteredCards.count)",
                    actionTitle: nil,
                    action: nil)
                if self.filteredCards.isEmpty {
                    ProStatusRow(
                        icon: self.canRead ? "tray" : "wifi.slash",
                        title: self.canRead ? "No cards" : "No cards loaded",
                        detail: self.canRead
                            ? "Create a card or change the filter."
                            : "Connect from Settings to load workboard cards.",
                        value: self.canRead ? "empty" : nil,
                        color: .secondary,
                        actionTitle: nil,
                        action: nil)
                } else {
                    ForEach(Array(self.filteredCards.enumerated()), id: \.element.id) { index, card in
                        if index > 0 {
                            Divider().padding(.leading, 58)
                        }
                        IPadWorkboardQueueRow(
                            card: card,
                            statuses: self.statuses,
                            isBusy: self.busyCardID == card.id,
                            inspect: {
                                self.presentedSheet = .card(card)
                            },
                            openSession: {
                                self.open(card)
                            },
                            move: { status in
                                Task { await self.move(card, to: status) }
                            },
                            archive: {
                                Task { await self.archive(card) }
                            })
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var createCardSheet: some View {
        Form {
            Section {
                TextField("Title", text: self.$draftTitle)
                    .textInputAutocapitalization(.sentences)
                    .font(OpenClawType.subhead)
                    .submitLabel(.next)
                TextField("Notes", text: self.$draftNotes, axis: .vertical)
                    .lineLimit(3...6)
                    .textInputAutocapitalization(.sentences)
                    .font(OpenClawType.subhead)
            } header: {
                Text("Card")
                    .font(OpenClawType.captionSemiBold)
            }
            if let errorText {
                Section {
                    Text(errorText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .navigationTitle("New Card")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    self.presentedSheet = nil
                } label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task {
                        if await self.createCard() {
                            self.presentedSheet = nil
                        }
                    }
                } label: {
                    Text(self.isCreatingCard ? "Creating..." : "Create")
                        .font(OpenClawType.subheadSemiBold)
                }
                .disabled(self.isCreatingCard)
                .accessibilityHint(self.createUnavailableMessage ?? "Creates a workboard card")
            }
        }
    }

    private var refreshID: String {
        [
            self.canRead ? "connected" : "offline",
            self.scenePhase == .active ? "active" : "inactive",
            self.selectedBoardID.isEmpty ? "all" : self.selectedBoardID,
        ].joined(separator: ":")
    }

    private var canRead: Bool {
        self.appModel.isOperatorGatewayConnected
    }

    private var canWrite: Bool {
        self.appModel.isOperatorGatewayConnected && !self.appModel
            .isAppleReviewDemoModeEnabled
    }

    private var currentWorkboardSubtitle: String {
        Self.workboardSubtitle(
            boardScopeLabel: self.boardScopeLabel,
            selectedStatus: self.selectedStatus)
    }

    private var boardScopeOptions: [String] {
        Self.boardScopeOptions(
            knownBoardIDs: self.knownBoardIDs,
            cardBoardIDs: self.cards.map { self.boardID(for: $0) })
    }

    private var boardScopeLabel: String {
        self.selectedBoardID.isEmpty ? "All boards" : Self.boardScopeLabel(for: self.selectedBoardID)
    }

    private var selectedBoardParam: String? {
        Self.normalizedScopeID(self.selectedBoardID).isEmpty ? nil : Self.normalizedScopeID(self.selectedBoardID)
    }

    private var trimmedDraftTitle: String {
        self.draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var createUnavailableMessage: String? {
        if self.isCreatingCard {
            return "Card creation is already in progress."
        }
        if !self.canWrite {
            return Self.compactWriteUnavailableMessage(canRead: self.canRead)
        }
        if self.trimmedDraftTitle.isEmpty {
            return "Enter a title to create a card."
        }
        return nil
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

    static func workboardSubtitle(boardScopeLabel: String, selectedStatus: String) -> String {
        "\(boardScopeLabel) / \(IPadWorkboardDefaults.label(for: selectedStatus))"
    }

    static func compactWriteUnavailableMessage(canRead: Bool) -> String {
        canRead ? "Read-only gateway." : "Connect from Settings to create, move, and dispatch cards."
    }

    static func boardScopeOptions(knownBoardIDs: [String], cardBoardIDs: [String]) -> [String] {
        Array(Set((knownBoardIDs + cardBoardIDs).map { self.normalizedScopeID($0) }.filter { !$0.isEmpty }))
            .sorted()
    }

    private var visibleKanbanStatuses: [String] {
        if self.selectedStatus == "active" {
            return self.statuses.filter { $0 != "done" }
        }
        if self.statuses.contains(self.selectedStatus) {
            return [self.selectedStatus]
        }
        return self.statuses
    }

    private var compactStatuses: [String] {
        let preferred = ["todo", "ready", "running", "review", "blocked", "scheduled", "done"]
        let known = preferred.filter { self.statuses.contains($0) }
        let custom = self.statuses.filter { !preferred.contains($0) }
        return known + custom
    }

    private func cards(forKanbanStatus status: String) -> [IPadWorkboardCard] {
        self.cards
            .filter { card in
                card.status == status && (self.selectedStatus != "active" || card.metadata?.archivedAt == nil)
            }
            .filter { self.matchesQuery($0) }
            .sorted { $0.position < $1.position }
    }

    private var filteredCards: [IPadWorkboardCard] {
        self.cards
            .filter { card in
                if self.selectedStatus == "active" {
                    return card.metadata?.archivedAt == nil && card.status != "done"
                }
                return card.status == self.selectedStatus
            }
            .filter { self.matchesQuery($0) }
            .sorted { left, right in
                if left.status != right.status {
                    return IPadWorkboardDefaults.rank(left.status) < IPadWorkboardDefaults.rank(right.status)
                }
                return left.position < right.position
            }
    }

    private func matchesQuery(_ card: IPadWorkboardCard) -> Bool {
        let trimmedQuery = self.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmedQuery.isEmpty else { return true }
        return [
            card.title,
            card.notes,
            card.agentId,
            card.sessionKey,
            card.labels.joined(separator: " "),
        ]
            .compactMap(\.self)
            .joined(separator: " ")
            .lowercased()
            .contains(trimmedQuery)
    }

    private func loadCards(force: Bool) async {
        guard self.scenePhase == .active else { return }
        guard self.canRead else {
            self.cards = []
            self.errorText = nil
            return
        }
        if self.isLoading {
            return
        }

        self.isLoading = true
        self.errorText = nil
        defer { self.isLoading = false }

        if !self.statuses.contains(self.selectedStatus), self.selectedStatus != "active" {
            self.selectedStatus = "active"
        }

        do {
            try await self.applyCardsResponse(self.fetchCards())
            await self.loadBoardScopes(force: force)
        } catch {
            if force || self.cards.isEmpty {
                self.errorText = Self.message(for: error)
            }
        }
    }

    private func beginCreateCard() {
        self.draftTitle = ""
        self.draftNotes = ""
        self.errorText = nil
        self.presentedSheet = .create
    }

    private func createCard() async -> Bool {
        if let createUnavailableMessage {
            self.errorText = createUnavailableMessage
            return false
        }

        self.isCreatingCard = true
        self.errorText = nil
        defer { self.isCreatingCard = false }

        do {
            let status = self.statuses.contains(self.selectedStatus) ? self.selectedStatus : "todo"
            let data = try await request(
                method: "workboard.cards.create",
                params: IPadWorkboardCreateParams(
                    title: trimmedDraftTitle,
                    notes: draftNotes.trimmingCharacters(in: .whitespacesAndNewlines),
                    status: status,
                    priority: "normal",
                    labels: [],
                    agentId: "",
                    sessionKey: nil,
                    position: self.nextPosition(for: status),
                    boardId: self.selectedBoardParam),
                timeoutSeconds: 20)
            try self.replace(Self.decodeCardResponse(data))
            self.draftTitle = ""
            self.draftNotes = ""
            return true
        } catch {
            self.errorText = Self.message(for: error)
            return false
        }
    }

    private func move(_ card: IPadWorkboardCard, to status: String) async {
        guard self.canWrite, self.busyCardID == nil else { return }
        self.busyCardID = card.id
        self.errorText = nil
        defer { self.busyCardID = nil }

        do {
            let data = try await request(
                method: "workboard.cards.move",
                params: IPadWorkboardMoveParams(
                    id: card.id,
                    status: status,
                    position: self.nextPosition(for: status, excluding: card.id)),
                timeoutSeconds: 20)
            try self.replace(Self.decodeCardResponse(data))
        } catch {
            self.errorText = Self.message(for: error)
        }
    }

    private func archive(_ card: IPadWorkboardCard) async {
        guard self.canWrite, self.busyCardID == nil else { return }
        self.busyCardID = card.id
        self.errorText = nil
        defer { self.busyCardID = nil }

        do {
            let data = try await request(
                method: "workboard.cards.archive",
                params: IPadWorkboardArchiveParams(
                    id: card.id,
                    archived: card.metadata?.archivedAt == nil),
                timeoutSeconds: 20)
            try self.replace(Self.decodeCardResponse(data))
        } catch {
            self.errorText = Self.message(for: error)
        }
    }

    private func dispatchCards() async {
        guard self.canWrite, !self.isLoading else { return }
        self.isLoading = true
        self.errorText = nil
        self.dispatchSummaryText = nil
        defer { self.isLoading = false }

        do {
            let data = try await request(
                method: "workboard.cards.dispatch",
                params: IPadWorkboardListParams(boardId: selectedBoardParam),
                timeoutSeconds: 45)
            self.dispatchSummaryText = try JSONDecoder()
                .decode(IPadWorkboardDispatchSummary.self, from: data)
                .summaryText
            try await self.applyCardsResponse(self.fetchCards())
        } catch {
            self.errorText = Self.message(for: error)
        }
    }

    private func open(_ card: IPadWorkboardCard) {
        guard let sessionKey = normalized(card.sessionKey) else { return }
        // Card details are a sheet. Dismiss it before changing tabs or the requested
        // Chat session and contextual return action remain obscured by the old card.
        self.presentedSheet = nil
        self.appModel.openChat(sessionKey: sessionKey)
        self.openChat()
    }

    private func replace(_ card: IPadWorkboardCard) {
        self.cards.removeAll { $0.id == card.id }
        self.cards.append(card)
        self.cards.sort { $0.position < $1.position }
    }

    private func fetchCards() async throws -> IPadWorkboardCardsResponse {
        let data = try await request(
            method: "workboard.cards.list",
            params: IPadWorkboardListParams(boardId: selectedBoardParam),
            timeoutSeconds: 20)
        return try JSONDecoder().decode(IPadWorkboardCardsResponse.self, from: data)
    }

    private func applyCardsResponse(_ response: IPadWorkboardCardsResponse) {
        self.cards = response.cards.sorted { $0.position < $1.position }
        self.statuses = self.normalizedStatuses(response.statuses)
        self.rememberBoardIDs(from: response.cards)
    }

    private func loadBoardScopes(force: Bool) async {
        do {
            let data = try await request(
                method: "workboard.boards.list",
                params: EmptyParams(),
                timeoutSeconds: 20)
            let response = try JSONDecoder().decode(IPadWorkboardBoardsResponse.self, from: data)
            self.rememberBoardIDs(from: response.boards)
        } catch {
            if force, self.knownBoardIDs.isEmpty {
                self.errorText = Self.message(for: error)
            }
        }
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

    private func normalizedStatuses(_ statuses: [String]?) -> [String] {
        let normalized = (statuses ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return normalized.isEmpty ? IPadWorkboardDefaults.statuses : normalized
    }

    private func nextPosition(for status: String, excluding cardID: String? = nil) -> Double {
        let maxPosition = self.cards
            .filter { $0.status == status && $0.id != cardID }
            .map(\.position)
            .max() ?? 0
        return maxPosition + 1000
    }

    private static func decodeCardResponse(_ data: Data) throws -> IPadWorkboardCard {
        try JSONDecoder().decode(IPadWorkboardCardResponse.self, from: data).card
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func boardID(for card: IPadWorkboardCard) -> String {
        Self.normalizedScopeID(card.metadata?.automation?.boardId).isEmpty
            ? "default"
            : Self.normalizedScopeID(card.metadata?.automation?.boardId)
    }

    private func rememberBoardIDs(from cards: [IPadWorkboardCard]) {
        let discovered = cards.map { self.boardID(for: $0) }
        self.knownBoardIDs = Array(Set(self.knownBoardIDs + discovered)).sorted()
    }

    private func rememberBoardIDs(from boards: [IPadWorkboardBoardSummary]) {
        let discovered = boards.map(\.id)
        self.knownBoardIDs = Self.boardScopeOptions(
            knownBoardIDs: self.knownBoardIDs,
            cardBoardIDs: discovered)
    }

    static func normalizedScopeID(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func boardScopeLabel(for boardID: String) -> String {
        let normalized = self.normalizedScopeID(boardID)
        return normalized.isEmpty ? "All boards" : normalized
    }

    private static func message(for error: Error) -> String {
        if let gatewayError = error as? IPadSidebarGatewayError {
            return gatewayError.message
        }
        return error.localizedDescription
    }
}

struct IPadWorkboardKanbanColumn: View {
    let status: String
    let cards: [IPadWorkboardCard]
    let statuses: [String]
    let busyCardID: String?
    let openSession: (IPadWorkboardCard) -> Void
    let inspect: (IPadWorkboardCard) -> Void
    let move: (IPadWorkboardCard, String) -> Void
    let archive: (IPadWorkboardCard) -> Void

    var body: some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ProPanelHeader(
                    title: IPadWorkboardDefaults.label(for: self.status),
                    value: "\(self.cards.count)",
                    actionTitle: nil,
                    action: nil)

                if self.cards.isEmpty {
                    ProStatusRow(
                        icon: "tray",
                        title: "No \(IPadWorkboardDefaults.label(for: self.status).lowercased()) cards",
                        detail: "Cards moved into this lane appear here.",
                        value: "empty",
                        color: .secondary,
                        actionTitle: nil,
                        action: nil)
                } else {
                    ForEach(Array(self.cards.enumerated()), id: \.element.id) { index, card in
                        if index > 0 {
                            Divider().padding(.leading, 12)
                        }
                        IPadWorkboardKanbanCard(
                            card: card,
                            statuses: self.statuses,
                            isBusy: self.busyCardID == card.id,
                            openSession: {
                                self.openSession(card)
                            },
                            inspect: {
                                self.inspect(card)
                            },
                            move: { status in
                                self.move(card, status)
                            },
                            archive: {
                                self.archive(card)
                            })
                    }
                }
            }
        }
    }
}

private struct IPadWorkboardKanbanCard: View {
    let card: IPadWorkboardCard
    let statuses: [String]
    let isBusy: Bool
    let openSession: () -> Void
    let inspect: () -> Void
    let move: (String) -> Void
    let archive: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: self.inspect) {
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .top, spacing: 10) {
                        ProIconBadge(systemName: self.icon, color: self.color)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(self.card.title)
                                .font(OpenClawType.subheadSemiBold)
                                .lineLimit(2)
                            Text(self.detail)
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }

                    if !self.card.labels.isEmpty {
                        Text(self.card.labels.prefix(3).joined(separator: ", "))
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                if self.card.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                    Button(action: self.openSession) {
                        Image(systemName: "bubble.left.and.text.bubble.right")
                    }
                    .accessibilityLabel("Open Session")
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }

                Menu {
                    ForEach(self.statuses, id: \.self) { status in
                        Button {
                            self.move(status)
                        } label: {
                            Text("Move to \(IPadWorkboardDefaults.label(for: status))")
                                .font(OpenClawType.subheadSemiBold)
                        }
                    }
                    Button(action: self.archive) {
                        Text(self.card.metadata?.archivedAt == nil ? "Archive" : "Unarchive")
                            .font(OpenClawType.subheadSemiBold)
                    }
                } label: {
                    Image(systemName: self.isBusy ? "hourglass" : "ellipsis")
                        .frame(width: 22, height: 22)
                }
                .accessibilityLabel("Card Actions")
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(self.isBusy)

                Spacer(minLength: 4)
                ProValuePill(value: IPadWorkboardDefaults.label(for: self.card.status), color: self.color)
            }
        }
        .padding(OpenClawSpacing.space3)
        .contentShape(Rectangle())
    }

    private var icon: String {
        switch self.card.status {
        case "running": "figure.run"
        case "review": "checklist"
        case "blocked": "exclamationmark.triangle"
        case "done": "checkmark.circle"
        default: "tray"
        }
    }

    private var color: Color {
        switch self.card.status {
        case "running": OpenClawBrand.ok
        case "review": OpenClawBrand.accentForeground
        case "blocked": OpenClawBrand.warn
        case "done": .secondary
        default: OpenClawBrand.accentHotForeground
        }
    }

    private var detail: String {
        if let notes = card.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
            return notes
        }
        if let sessionKey = card.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines), !sessionKey.isEmpty {
            return sessionKey
        }
        return self.card.agentId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? self.card.agentId ?? "Default agent"
            : "Default agent"
    }
}

struct IPadWorkboardQueueRow: View {
    let card: IPadWorkboardCard
    let statuses: [String]
    let isBusy: Bool
    let inspect: () -> Void
    let openSession: () -> Void
    let move: (String) -> Void
    let archive: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: self.inspect) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: self.icon, color: self.color)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(self.card.title)
                            .font(OpenClawType.subheadSemiBold)
                            .lineLimit(2)
                        Text(self.detail)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    ProValuePill(value: IPadWorkboardDefaults.label(for: self.card.status), color: self.color)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Menu {
                self.actionMenuItems
            } label: {
                Image(systemName: self.isBusy ? "hourglass" : "ellipsis.circle")
                    .font(.system(size: 19, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawBrand.accent)
            .disabled(self.isBusy)
            .accessibilityLabel("Card Actions")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contextMenu {
            self.actionMenuItems
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button(action: self.inspect) {
                Text("Inspect")
                    .font(OpenClawType.subheadSemiBold)
            }
            .tint(OpenClawBrand.accent)
            if self.card.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                Button(action: self.openSession) {
                    Text("Open")
                        .font(OpenClawType.subheadSemiBold)
                }
                .tint(OpenClawBrand.ok)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let nextStatus {
                Button {
                    self.move(nextStatus)
                } label: {
                    Text(IPadWorkboardDefaults.label(for: nextStatus))
                        .font(OpenClawType.subheadSemiBold)
                }
                .tint(OpenClawBrand.accentHot)
            }
            Button(action: self.archive) {
                Text(self.card.metadata?.archivedAt == nil ? "Archive" : "Unarchive")
                    .font(OpenClawType.subheadSemiBold)
            }
            .tint(.secondary)
        }
    }

    @ViewBuilder
    private var actionMenuItems: some View {
        if self.card.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            Button(action: self.openSession) {
                Text("Open Session")
                    .font(OpenClawType.subheadSemiBold)
            }
        }
        Button(action: self.inspect) {
            Text("Inspect")
                .font(OpenClawType.subheadSemiBold)
        }
        ForEach(self.statuses, id: \.self) { status in
            Button {
                self.move(status)
            } label: {
                Text("Move to \(IPadWorkboardDefaults.label(for: status))")
                    .font(OpenClawType.subheadSemiBold)
            }
        }
        Button(action: self.archive) {
            Text(self.card.metadata?.archivedAt == nil ? "Archive" : "Unarchive")
                .font(OpenClawType.subheadSemiBold)
        }
    }

    private var nextStatus: String? {
        guard let currentIndex = statuses.firstIndex(of: card.status) else {
            return self.statuses.first
        }
        let nextIndex = self.statuses.index(after: currentIndex)
        guard self.statuses.indices.contains(nextIndex) else { return nil }
        return self.statuses[nextIndex]
    }

    private var icon: String {
        switch self.card.status {
        case "running": "figure.run"
        case "review": "checklist"
        case "blocked": "exclamationmark.triangle"
        case "done": "checkmark.circle"
        default: "tray"
        }
    }

    private var color: Color {
        switch self.card.status {
        case "running": OpenClawBrand.ok
        case "review": OpenClawBrand.accentForeground
        case "blocked": OpenClawBrand.warn
        case "done": .secondary
        default: OpenClawBrand.accentHotForeground
        }
    }

    private var detail: String {
        if let notes = card.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
            return notes
        }
        if let sessionKey = card.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines), !sessionKey.isEmpty {
            return sessionKey
        }
        return self.card.agentId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? self.card.agentId ?? "Default agent"
            : "Default agent"
    }
}

private struct IPadWorkboardCardDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let card: IPadWorkboardCard
    let statuses: [String]
    let isBusy: Bool
    let canWrite: Bool
    let openSession: () -> Void
    let move: (String) -> Void
    let archive: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    self.detailRow("Title", value: self.card.title)
                    self.detailRow("Status", value: IPadWorkboardDefaults.label(for: self.card.status))
                    if let notes = self.card.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
                        Text(notes)
                            .font(OpenClawType.subhead)
                    }
                } header: {
                    Text("Card")
                        .font(OpenClawType.captionSemiBold)
                }

                Section {
                    if self.card.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                        Button {
                            self.openSession()
                        } label: {
                            Text("Open Session")
                                .font(OpenClawType.subheadSemiBold)
                        }
                    }
                    Menu {
                        ForEach(self.statuses, id: \.self) { status in
                            Button {
                                self.move(status)
                            } label: {
                                Text(IPadWorkboardDefaults.label(for: status))
                                    .font(OpenClawType.subhead)
                            }
                        }
                    } label: {
                        Text("Move")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .disabled(!self.canWrite || self.isBusy)
                    Button {
                        self.archive()
                    } label: {
                        Text(self.card.metadata?.archivedAt == nil ? "Archive" : "Unarchive")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .disabled(!self.canWrite || self.isBusy)
                } header: {
                    Text("Actions")
                        .font(OpenClawType.captionSemiBold)
                }
            }
            .navigationTitle("Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Done")
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
            }
        }
    }

    private func detailRow(_ title: String, value: String) -> some View {
        LabeledContent {
            Text(value)
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
        } label: {
            Text(title)
                .font(OpenClawType.subheadSemiBold)
        }
    }
}

private enum IPadWorkboardSheet: Identifiable {
    case create
    case card(IPadWorkboardCard)

    var id: String {
        switch self {
        case .create:
            "create"
        case let .card(card):
            "card-\(card.id)"
        }
    }
}

private enum IPadWorkboardDefaults {
    static let statuses = ["todo", "scheduled", "ready", "running", "review", "blocked", "done"]

    static func label(for status: String) -> String {
        status
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    static func rank(_ status: String) -> Int {
        self.statuses.firstIndex(of: status) ?? Int.max
    }
}

private struct IPadWorkboardCardsResponse: Decodable {
    let cards: [IPadWorkboardCard]
    let statuses: [String]?
}

private struct IPadWorkboardCardResponse: Decodable {
    let card: IPadWorkboardCard
}

private struct IPadWorkboardBoardsResponse: Decodable {
    let boards: [IPadWorkboardBoardSummary]
}

private struct IPadWorkboardBoardSummary: Decodable {
    let id: String
}

struct IPadWorkboardCard: Decodable, Identifiable {
    let id: String
    let title: String
    let notes: String?
    let status: String
    let priority: String?
    let labels: [String]
    let agentId: String?
    let sessionKey: String?
    let position: Double
    let updatedAt: Double?
    let metadata: IPadWorkboardMetadata?
}

struct IPadWorkboardMetadata: Decodable {
    let archivedAt: Double?
    let automation: IPadWorkboardAutomationMetadata?
}

struct IPadWorkboardAutomationMetadata: Decodable {
    let boardId: String?
}

private struct IPadWorkboardListParams: Encodable {
    let boardId: String?
}

private struct IPadWorkboardCreateParams: Encodable {
    let title: String
    let notes: String
    let status: String
    let priority: String
    let labels: [String]
    let agentId: String
    let sessionKey: String?
    let position: Double
    let boardId: String?
}

private struct IPadWorkboardMoveParams: Encodable {
    let id: String
    let status: String
    let position: Double
}

private struct IPadWorkboardArchiveParams: Encodable {
    let id: String
    let archived: Bool
}

struct IPadWorkboardDispatchSummary: Decodable {
    private let startedCount: Int
    private let startFailureCount: Int
    private let promotedCount: Int
    private let blockedCount: Int
    private let reclaimedCount: Int
    private let orchestratedCount: Int
    private let dispatchCount: Int

    private enum CodingKeys: String, CodingKey {
        case started
        case startFailures
        case promoted
        case blocked
        case reclaimed
        case orchestrated
        case count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.startedCount = Self.arrayCount(container, .started)
        self.startFailureCount = Self.arrayCount(container, .startFailures)
        self.promotedCount = Self.arrayCount(container, .promoted)
        self.blockedCount = Self.arrayCount(container, .blocked)
        self.reclaimedCount = Self.arrayCount(container, .reclaimed)
        self.orchestratedCount = Self.arrayCount(container, .orchestrated)
        self.dispatchCount = (try? container.decode(Int.self, forKey: .count)) ?? 0
    }

    var summaryText: String {
        let total = max(
            dispatchCount,
            startedCount + self.promotedCount + self.reclaimedCount + self.orchestratedCount +
                self.blockedCount + self.startFailureCount)
        if total == 0, self.startFailureCount == 0, self.blockedCount == 0 {
            return "No cards dispatched."
        }
        let outcomes = [
            Self.outcomeText(self.startedCount, "started"),
            Self.outcomeText(self.promotedCount, "promoted"),
            Self.outcomeText(self.reclaimedCount, "reclaimed"),
            Self.outcomeText(self.orchestratedCount, "orchestrated"),
            Self.outcomeText(self.blockedCount, "blocked"),
            Self.outcomeText(self.startFailureCount, "failed"),
        ].compactMap(\.self)
        guard !outcomes.isEmpty else {
            return "\(total) dispatched."
        }
        return "\(total) dispatched: \(outcomes.joined(separator: ", "))."
    }

    private static func arrayCount(
        _ container: KeyedDecodingContainer<CodingKeys>,
        _ key: CodingKeys) -> Int
    {
        (try? container.decode([IPadWorkboardDispatchEntry].self, forKey: key).count) ?? 0
    }

    private static func outcomeText(_ count: Int, _ label: String) -> String? {
        guard count > 0 else { return nil }
        return "\(count) \(label)"
    }
}

private struct IPadWorkboardDispatchEntry: Decodable {}
