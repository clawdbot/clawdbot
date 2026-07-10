import Observation
import SwiftUI

@MainActor
struct ChatSessionsSheet: View {
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

    private var scopedFetchID: String {
        "\(self.scope.rawValue)|\(self.trimmedSearchText.lowercased())"
    }

    var body: some View {
        NavigationStack {
            List {
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
            .searchable(text: self.$searchText, prompt: "Search sessions")
            .navigationTitle("Sessions")
            .toolbar {
                #if os(macOS)
                ToolbarItem(placement: .automatic) {
                    self.refreshButton
                }
                ToolbarItem(placement: .primaryAction) {
                    self.closeButton
                }
                #else
                ToolbarItem(placement: .topBarLeading) {
                    self.refreshButton
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
            .alert(
                "Rename Session",
                isPresented: Binding(
                    get: { self.renameTarget != nil },
                    set: {
                        if !$0 { self.renameTarget = nil }
                    })) {
                TextField("Session name", text: self.$renameText)
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
        }
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

    private var emptyState: some View {
        VStack(spacing: 6) {
            if self.isLoadingScoped {
                ProgressView()
            } else {
                Text(self.scope == .archived ? "No archived sessions" : "No sessions found")
                    .font(OpenClawChatTypography.body)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func sessionRow(_ session: OpenClawChatSessionEntry) -> some View {
        Button {
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
        } label: {
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
            Button {
                self.viewModel.setSessionArchived(key: session.key, archived: !session.isArchived)
                self.refreshScopedSessionsSoon()
            } label: {
                self.actionLabel(
                    session.isArchived ? "Unarchive" : "Archive",
                    systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
            .tint(session.isArchived ? OpenClawChatTheme.accent : OpenClawChatTheme.danger)
        }
        .contextMenu {
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
            Button {
                self.viewModel.setSessionArchived(key: session.key, archived: !session.isArchived)
                self.refreshScopedSessionsSoon()
            } label: {
                self.actionLabel(
                    session.isArchived ? "Unarchive" : "Archive",
                    systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
        }
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
