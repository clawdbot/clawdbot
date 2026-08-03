import Observation
import SwiftUI

@MainActor
public struct ChatSessionsSheet: View {
    private enum SessionScope: String, CaseIterable, Identifiable {
        case active
        case archived

        var id: String {
            self.rawValue
        }

        var title: String {
            switch self {
            case .active: "Active"
            case .archived: "Archived"
            }
        }
    }

    @Bindable var viewModel: OpenClawChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var scope: SessionScope = .active
    @State private var scopedSessions: [OpenClawChatSessionEntry] = []
    @State private var isLoadingScoped = false
    @State private var renameTarget: OpenClawChatSessionEntry?
    @State private var renameText = ""
    @State private var isSelecting = false
    @State private var selectedSessionKeys: Set<String> = []
    @State private var batchErrors: [String: String] = [:]
    @State private var isRunningBatch = false
    @State private var pendingBatchAction: ChatSessionBatchAction?
    @State private var inspectedSession: OpenClawChatSessionEntry?
    @State private var isPresentingGroups = false

    public init(viewModel: OpenClawChatViewModel) {
        self.viewModel = viewModel
    }

    /// Live view-model sessions serve the default active list; search and the
    /// archived scope fetch one-shot lists (server-side search with local
    /// cached fallback inside the view model).
    private var usesScopedFetch: Bool {
        self.scope == .archived || !self.trimmedSearchText.isEmpty
    }

    private var trimmedSearchText: String {
        self.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var displayedSessions: [OpenClawChatSessionEntry] {
        self.usesScopedFetch ? self.scopedSessions : self.viewModel.sessions
    }

    private var displayedSessionKeys: [String] {
        self.displayedSessions.map(\.key)
    }

    private var scopedFetchID: String {
        "\(self.scope.rawValue)|\(self.trimmedSearchText.lowercased())"
    }

    public var body: some View {
        NavigationStack {
            List(selection: self.$selectedSessionKeys) {
                Section {
                    ForEach(self.displayedSessions) { session in
                        self.sessionRow(session)
                    }
                } header: {
                    Picker(selection: self.$scope) {
                        ForEach(SessionScope.allCases) { scope in
                            Text(scope.title)
                                .font(OpenClawChatTypography.caption)
                                .tag(scope)
                        }
                    } label: {
                        Text("Scope")
                            .font(OpenClawChatTypography.caption)
                    }
                    .pickerStyle(.segmented)
                    .textCase(nil)
                }
            }
            .overlay {
                if self.displayedSessions.isEmpty {
                    self.emptyState
                }
            }
            .searchable(text: self.$searchText, prompt: "Search threads")
            .navigationTitle("Threads")
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if self.isSelecting, self.scope == .active {
                    self.batchActionBar
                }
            }
            .toolbar {
                #if os(macOS)
                ToolbarItem(placement: .automatic) {
                    self.refreshButton
                }
                ToolbarItem(placement: .automatic) {
                    self.groupsButton
                }
                ToolbarItem(placement: .automatic) {
                    if self.scope == .active { self.selectButton }
                }
                ToolbarItem(placement: .primaryAction) {
                    self.closeButton
                }
                #else
                ToolbarItem(placement: .topBarLeading) {
                    self.refreshButton
                }
                ToolbarItem(placement: .topBarLeading) {
                    self.groupsButton
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if self.scope == .active { self.selectButton }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    self.closeButton
                }
                #endif
            }
            .task(id: self.scopedFetchID) {
                await self.refreshScopedSessionsIfNeeded(debounce: !self.trimmedSearchText.isEmpty)
            }
            .onAppear {
                self.viewModel.refreshSessions(limit: OpenClawChatViewModel.sessionListFetchLimit)
            }
            .onChange(of: self.scope) {
                self.isSelecting = false
                self.selectedSessionKeys = []
                self.batchErrors = [:]
            }
            .onChange(of: self.scopedFetchID) {
                // A changed query must not retain destructive targets hidden by
                // the new result set.
                self.selectedSessionKeys = []
                self.batchErrors = [:]
            }
            .onChange(of: self.displayedSessionKeys) {
                self.selectedSessionKeys.formIntersection(self.displayedSessionKeys)
                self.batchErrors = self.batchErrors.filter { self.displayedSessionKeys.contains($0.key) }
            }
            .alert(
                "Rename Thread",
                isPresented: Binding(
                    get: { self.renameTarget != nil },
                    set: {
                        if !$0 { self.renameTarget = nil }
                    })) {
                TextField("Thread name", text: self.$renameText)
                    .font(OpenClawChatTypography.body)
                Button {
                    if let target = self.renameTarget {
                        self.viewModel.renameSession(key: target.key, label: self.renameText)
                        self.refreshScopedSessionsSoon()
                    }
                    self.renameTarget = nil
                } label: {
                    Text("Rename")
                        .font(OpenClawChatTypography.body)
                }
                Button(role: .cancel) {
                    self.renameTarget = nil
                } label: {
                    Text("Cancel")
                        .font(OpenClawChatTypography.body)
                }
            }
            .sheet(isPresented: self.$isPresentingGroups) {
                ChatSessionGroupsSheet(viewModel: self.viewModel)
            }
            .sheet(item: self.$inspectedSession) { session in
                ChatSessionInspectorSheet(viewModel: self.viewModel, session: session)
            }
            .confirmationDialog(
                "Delete selected threads?",
                isPresented: Binding(
                    get: { self.pendingBatchAction == .delete },
                    set: { if !$0 { self.pendingBatchAction = nil } }))
            {
                Button("Delete Threads", role: .destructive) {
                    Task { await self.runBatch(.delete) }
                }
            } message: {
                Text("Each selected thread and its transcript will be removed from the gateway.")
                    .font(OpenClawChatTypography.body)
            }
        }
        .modifier(ChatSessionSelectionModeModifier(isSelecting: self.isSelecting && self.scope == .active))
    }

    private var refreshButton: some View {
        Button {
            self.viewModel.refreshSessions(limit: OpenClawChatViewModel.sessionListFetchLimit)
            self.refreshScopedSessionsSoon()
        } label: {
            Image(systemName: "arrow.clockwise")
        }
    }

    private var closeButton: some View {
        Button {
            self.dismiss()
        } label: {
            Image(systemName: "xmark")
        }
    }

    private var groupsButton: some View {
        Button {
            self.isPresentingGroups = true
        } label: {
            Label {
                Text("Groups")
                    .font(OpenClawChatTypography.body)
            } icon: {
                Image(systemName: "folder")
            }
        }
        .help("Manage thread groups")
    }

    private var selectButton: some View {
        Button(self.isSelecting ? "Done" : "Select") {
            self.isSelecting.toggle()
            if !self.isSelecting {
                self.selectedSessionKeys = []
                self.batchErrors = [:]
            }
        }
        .font(OpenClawChatTypography.body)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            if self.isLoadingScoped {
                ProgressView()
            } else {
                Text(self.scope == .archived ? "No archived threads" : "No threads found")
                    .font(OpenClawChatTypography.body)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: OpenClawChatSessionEntry) -> some View {
        if self.isSelecting, self.scope == .active {
            self.sessionRowContent(session)
                .tag(session.key)
        } else {
            self.interactiveSessionRow(session)
        }
    }

    private func interactiveSessionRow(_ session: OpenClawChatSessionEntry) -> some View {
        let archiveActionTitle = LocalizedStringKey(session.isArchived
            ? String(localized: "Restore")
            : String(localized: "Archive"))
        return Button {
            if session.isArchived {
                // Archived sessions reject new sends; opening one restores it
                // first and only switches on success so the composer never
                // points at a still-archived session.
                Task {
                    guard await self.viewModel.restoreSession(key: session.key) else { return }
                    self.viewModel.switchSession(to: session.key)
                    self.dismiss()
                }
            } else {
                self.viewModel.switchSession(to: session.key)
                self.dismiss()
            }
        } label: { self.sessionRowContent(session) }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if !session.isArchived {
                    Button {
                        self.viewModel.setSessionPinned(key: session.key, pinned: !session.isPinned)
                        self.refreshScopedSessionsSoon()
                    } label: {
                        self.actionLabel(
                            session.isPinned ? "Unpin" : "Pin",
                            systemImage: session.isPinned ? "pin.slash" : "pin")
                    }
                    .tint(OpenClawChatTheme.accent)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if session.isArchived || ChatSessionSidebarModel.canArchiveSession(
                    session,
                    mainSessionKey: self.viewModel.resolvedMainSessionKey)
                {
                    Button {
                        self.viewModel.setSessionArchived(key: session.key, archived: !session.isArchived)
                        self.refreshScopedSessionsSoon()
                    } label: {
                        self.actionLabel(
                            archiveActionTitle,
                            systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
                    }
                    .tint(session.isArchived ? OpenClawChatTheme.accent : OpenClawChatTheme.danger)
                }
            }
            .contextMenu {
                Button {
                    self.inspectedSession = session
                } label: {
                    self.actionLabel("Get Info…", systemImage: "info.circle")
                }
                Divider()
                Button {
                    self.renameText = session.displayName ?? ""
                    self.renameTarget = session
                } label: {
                    self.actionLabel("Rename", systemImage: "pencil")
                }
                if !session.isArchived {
                    Button {
                        self.viewModel.setSessionPinned(key: session.key, pinned: !session.isPinned)
                        self.refreshScopedSessionsSoon()
                    } label: {
                        self.actionLabel(
                            session.isPinned ? "Unpin" : "Pin",
                            systemImage: session.isPinned ? "pin.slash" : "pin")
                    }
                }
                if session.isArchived || ChatSessionSidebarModel.canArchiveSession(
                    session,
                    mainSessionKey: self.viewModel.resolvedMainSessionKey)
                {
                    Button {
                        self.viewModel.setSessionArchived(key: session.key, archived: !session.isArchived)
                        self.refreshScopedSessionsSoon()
                    } label: {
                        self.actionLabel(
                            archiveActionTitle,
                            systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
                    }
                }
                Button {
                    Task { await self.viewModel.forkSession(key: session.key) }
                } label: {
                    self.actionLabel(
                        LocalizedStringKey(String(localized: "Fork")),
                        systemImage: "arrow.triangle.branch")
                }
                Button {
                    self.viewModel.setSessionUnread(key: session.key, unread: session.unread != true)
                    self.refreshScopedSessionsSoon()
                } label: {
                    self.actionLabel(
                        LocalizedStringKey(session.unread == true
                            ? String(localized: "Mark Read")
                            : String(localized: "Mark Unread")),
                        systemImage: session.unread == true ? "envelope.open" : "envelope.badge")
                }
            }
    }

    private func sessionRowContent(_ session: OpenClawChatSessionEntry) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.displayName ?? session.key)
                    .font(OpenClawChatTypography.mono(size: 17, relativeTo: .body))
                    .lineLimit(1)
                if let updatedAt = session.updatedAt, updatedAt > 0 {
                    Text(Date(timeIntervalSince1970: updatedAt / 1000).formatted(
                        date: .abbreviated,
                        time: .shortened))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                if let error = self.batchErrors[session.key] {
                    Text(error)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(OpenClawChatTheme.danger)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if session.isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Pinned")
            }
        }
    }

    private var batchActionBar: some View {
        HStack(spacing: 12) {
            Button("Pin") { Task { await self.runBatch(.pin) } }
            Button("Unpin") { Task { await self.runBatch(.unpin) } }
            Button("Archive") { Task { await self.runBatch(.archive) } }
            Spacer()
            Button("Delete", role: .destructive) {
                self.pendingBatchAction = .delete
            }
        }
        .font(OpenClawChatTypography.body)
        .buttonStyle(.borderless)
        .disabled(self.selectedSessionKeys.isEmpty || self.isRunningBatch)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func runBatch(_ action: ChatSessionBatchAction) async {
        self.pendingBatchAction = nil
        guard !self.selectedSessionKeys.isEmpty else { return }
        self.isRunningBatch = true
        defer { self.isRunningBatch = false }
        let selectedSessions = self.displayedSessions.filter { self.selectedSessionKeys.contains($0.key) }
        let result = await self.viewModel.performSessionBatch(
            sessions: selectedSessions,
            action: action)
        self.batchErrors = result.errorsByKey
        self.selectedSessionKeys = Set(result.errorsByKey.keys)
        self.refreshScopedSessionsSoon()
    }

    private func actionLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label {
            Text(title)
                .font(OpenClawChatTypography.body)
        } icon: {
            Image(systemName: systemImage)
        }
    }

    private func refreshScopedSessionsIfNeeded(debounce: Bool) async {
        guard self.usesScopedFetch else {
            self.scopedSessions = []
            return
        }
        if debounce {
            // Debounce keystrokes; .task(id:) cancels superseded fetches.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
        }
        self.isLoadingScoped = true
        defer { self.isLoadingScoped = false }
        let query = self.trimmedSearchText
        let rows = await self.viewModel.fetchSessionList(
            search: query.isEmpty ? nil : query,
            archived: self.scope == .archived)
        // A superseded task must not repaint stale rows over the newer query.
        guard !Task.isCancelled else { return }
        self.scopedSessions = rows
    }

    /// Mutations refresh the scoped list after the optimistic patch settles.
    private func refreshScopedSessionsSoon() {
        guard self.usesScopedFetch else { return }
        Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            await self.refreshScopedSessionsIfNeeded(debounce: false)
        }
    }
}

private struct ChatSessionSelectionModeModifier: ViewModifier {
    let isSelecting: Bool

    func body(content: Content) -> some View {
        #if os(macOS)
        content
        #else
        content.environment(\.editMode, .constant(self.isSelecting ? .active : .inactive))
        #endif
    }
}
