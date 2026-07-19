#if os(macOS)
import AppKit
import SwiftUI

@MainActor
struct ChatSessionSidebar: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Binding var query: String
    @State private var sessionPendingDeletion: OpenClawChatSessionEntry?
    @State private var sessionPendingRename: OpenClawChatSessionEntry?
    @State private var renameText = ""
    @State private var groups: [OpenClawChatSessionGroup] = []
    @State private var groupRefreshNonce = 0
    @State private var groupLoadFailed = false
    @State private var inspectedSession: OpenClawChatSessionEntry?
    @State private var isPresentingNewSessionOptions = false
    @AppStorage("openclaw.chat.collapsedSessionGroups") private var collapsedSessionGroups = ""

    var body: some View {
        let sections = ChatSessionSidebarModel.sections(
            sessions: self.viewModel.sessions,
            currentSessionKey: self.viewModel.sessionKey,
            mainSessionKey: self.viewModel.resolvedMainSessionKey,
            activeAgentID: self.viewModel.activeAgentId,
            groups: self.groups,
            query: self.query)
        List(selection: self.selectionBinding) {
            ForEach(sections) { section in
                if section.id.hasPrefix("group:"), let title = section.title {
                    Section {
                        if !self.isGroupCollapsed(title) || !self.query
                            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        {
                            self.rows(section.nodes)
                        }
                    } header: {
                        Button {
                            self.toggleGroupCollapsed(title)
                        } label: {
                            HStack {
                                Image(systemName: self.isGroupCollapsed(title) ? "chevron.right" : "chevron.down")
                                Text(verbatim: title)
                                    .font(OpenClawChatTypography.caption)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } else if let title = section.title {
                    Section {
                        self.rows(section.nodes)
                    } header: {
                        Text(LocalizedStringKey(title))
                            .font(OpenClawChatTypography.caption)
                    }
                } else {
                    self.rows(section.nodes)
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(
            text: self.$query,
            placement: .sidebar,
            prompt: String(localized: "Search sessions"))
        .overlay {
            if sections.isEmpty {
                ContentUnavailableView(
                    self.query.isEmpty
                        ? String(localized: "No Sessions")
                        : String(localized: "No Results"),
                    systemImage: "bubble.left.and.bubble.right")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { self.connectionFooter }
        .toolbar {
            ToolbarItem {
                HStack(spacing: 2) {
                    Button {
                        Task { await self.viewModel.startNewSession() }
                    } label: {
                        chatWindowActionLabel("New Session", systemImage: "square.and.pencil")
                    }
                    .help(String(localized: "New session"))
                    Button {
                        self.isPresentingNewSessionOptions = true
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                    .help(String(localized: "New session options"))
                    .popover(isPresented: self.$isPresentingNewSessionOptions) {
                        ChatNewSessionOptionsPopover(viewModel: self.viewModel) {
                            self.isPresentingNewSessionOptions = false
                        }
                    }
                }
            }
        }
        .task(id: self.groupRefreshID) {
            self.viewModel.refreshSessions(limit: 200)
            do {
                let groups = try await self.viewModel.fetchSessionGroups()
                self.groups = groups
                self.groupLoadFailed = false
            } catch {
                self.groupLoadFailed = true
            }
        }
        .onChange(of: self.viewModel.healthOK) { previous, current in
            if !previous, current {
                self.viewModel.refreshSessions(limit: 200)
            }
        }
        .sheet(item: self.$inspectedSession) { session in
            ChatSessionInspectorSheet(viewModel: self.viewModel, session: session)
        }
        .alert(
            String(localized: "Rename Session"),
            isPresented: self.isPresentingRenameAlert)
        {
            TextField(String(localized: "Session name"), text: self.$renameText)
            Button(String(localized: "Rename")) {
                if let session = self.sessionPendingRename {
                    self.viewModel.renameSession(key: session.key, label: self.renameText)
                }
                self.sessionPendingRename = nil
            }
            Button(String(localized: "Cancel"), role: .cancel) {
                self.sessionPendingRename = nil
            }
        }
        .confirmationDialog(self.deleteDialogTitle, isPresented: self.isPresentingDeleteDialog) {
                Button(String(localized: "Delete Session"), role: .destructive) {
                    if let session = self.sessionPendingDeletion {
                        self.viewModel.deleteSession(session.key)
                    }
                    self.sessionPendingDeletion = nil
                }
            } message: {
                Text(String(localized: "The session and its transcript are removed from the gateway."))
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
    }

    private var selectionBinding: Binding<String?> {
        Binding(
            get: {
                ChatSessionSidebarModel.selectedSessionKey(
                    sessions: self.viewModel.sessions,
                    currentSessionKey: self.viewModel.sessionKey,
                    mainSessionKey: self.viewModel.resolvedMainSessionKey,
                    activeAgentID: self.viewModel.activeAgentId)
            },
            set: { next in
                guard let next, next != self.viewModel.sessionKey else { return }
                self.viewModel.switchSession(to: next)
            })
    }

    private var groupRefreshID: String {
        let categories = self.viewModel.sessions.compactMap(\.category).sorted().joined(separator: "|")
        let revision = self.viewModel.sessionGroupsRevision
        return "\(self.viewModel.healthOK)|\(categories)|\(revision)|\(self.groupRefreshNonce)"
    }

    private var deleteDialogTitle: String {
        let name = self.sessionPendingDeletion.map(ChatSessionSidebarModel.displayName(for:)) ?? ""
        return String(format: String(localized: "Delete “%@”?"), name)
    }

    private var isPresentingDeleteDialog: Binding<Bool> {
        Binding(
            get: { self.sessionPendingDeletion != nil },
            set: { if !$0 { self.sessionPendingDeletion = nil } })
    }

    private var isPresentingRenameAlert: Binding<Bool> {
        Binding(
            get: { self.sessionPendingRename != nil },
            set: { if !$0 { self.sessionPendingRename = nil } })
    }

    private func rows(_ nodes: [ChatSessionSidebarModel.Node]) -> some View {
        OutlineGroup(nodes, children: \.outlineChildren) { node in
            self.row(for: node)
        }
    }

    private func row(for node: ChatSessionSidebarModel.Node) -> some View {
        let session = node.session
        return HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ChatSessionSidebarModel.displayName(for: session))
                    .font(OpenClawChatTypography.body(size: 13, weight: .medium, relativeTo: .body))
                    .lineLimit(1)
                if let subtitle = self.rowSubtitle(for: session) {
                    Text(subtitle)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            self.badges(for: node)
        }
        // The tag type must equal the List selection type (String?) exactly.
        .tag(Optional(session.key))
        .contextMenu { self.contextMenu(for: session) }
    }

    @ViewBuilder
    private func badges(for node: ChatSessionSidebarModel.Node) -> some View {
        if node.badges.runningCount > 0 {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel(String(localized: "Session running"))
        }
        if node.badges.failedCount > 0 {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Session failed"))
        }
        let isCurrentSession = self.viewModel.matchesCurrentSessionKey(
            incoming: node.session.key,
            current: self.viewModel.sessionKey)
        if node.hasUnreadDescendant || (node.session.unread == true && !isCurrentSession) {
            Circle()
                .fill(.tint)
                .frame(width: 7, height: 7)
                .accessibilityLabel(String(localized: "Unread"))
        }
    }

    @ViewBuilder
    private func contextMenu(for session: OpenClawChatSessionEntry) -> some View {
        Button {
            self.inspectedSession = session
        } label: {
            self.actionLabel(String(localized: "Get Info…"), systemImage: "info.circle")
        }
        Divider()
        Button {
            self.renameText = session.label ?? session.displayName ?? ""
            self.sessionPendingRename = session
        } label: {
            self.actionLabel(String(localized: "Rename…"), systemImage: "pencil")
        }
        Button {
            self.viewModel.setSessionPinned(key: session.key, pinned: session.pinned != true)
        } label: {
            self.actionLabel(
                session.pinned == true ? String(localized: "Unpin") : String(localized: "Pin"),
                systemImage: session.pinned == true ? "pin.slash" : "pin")
        }
        Button {
            Task { await self.viewModel.forkSession(key: session.key) }
        } label: {
            self.actionLabel(String(localized: "Fork"), systemImage: "arrow.triangle.branch")
        }
        Button {
            self.viewModel.setSessionUnread(key: session.key, unread: session.unread != true)
        } label: {
            self.actionLabel(
                session.unread == true ? String(localized: "Mark Read") : String(localized: "Mark Unread"),
                systemImage: session.unread == true ? "envelope.open" : "envelope.badge")
        }
        if session.isArchived || ChatSessionSidebarModel.canArchiveSession(
            session,
            mainSessionKey: self.viewModel.resolvedMainSessionKey)
        {
            Button {
                self.viewModel.setSessionArchived(key: session.key, archived: !session.isArchived)
            } label: {
                self.actionLabel(
                    session.isArchived ? String(localized: "Restore") : String(localized: "Archive"),
                    systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
        }
        Divider()
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(session.key, forType: .string)
        } label: {
            self.actionLabel(String(localized: "Copy Session Key"), systemImage: "doc.on.doc")
        }
        if ChatSessionSidebarModel.canDeleteSession(
            key: session.key,
            mainSessionKey: self.viewModel.resolvedMainSessionKey)
        {
            Button(role: .destructive) {
                self.sessionPendingDeletion = session
            } label: {
                self.actionLabel(String(localized: "Delete Session…"), systemImage: "trash")
            }
        }
    }

    private func isGroupCollapsed(_ name: String) -> Bool {
        Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init)).contains(name)
    }

    private func toggleGroupCollapsed(_ name: String) {
        var names = Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init))
        if !names.insert(name).inserted {
            names.remove(name)
        }
        self.collapsedSessionGroups = names.sorted().joined(separator: "\u{1F}")
    }

    private func actionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    }

    private func rowSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        var parts: [String] = []
        if let branch = session.worktree?.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty
        {
            parts.append(branch)
        }
        if let updatedAt = session.updatedAt ?? session.lastActivityAt, updatedAt > 0 {
            let date = Date(timeIntervalSince1970: updatedAt / 1000)
            parts.append(date.formatted(.relative(presentation: .named)))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var connectionFooter: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.viewModel.healthOK
                ? String(localized: "Gateway connected")
                : String(localized: "Connecting…"))
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if self.groupLoadFailed {
                Button {
                    self.groupRefreshNonce += 1
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help(String(localized: "Retry session groups"))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}
#endif
