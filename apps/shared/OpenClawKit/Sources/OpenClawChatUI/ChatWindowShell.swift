#if os(macOS)
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Native macOS chat window: sessions sidebar + transcript detail with the
/// pickers promoted into the unified window toolbar. The compact menu-bar
/// panel keeps using `OpenClawChatView` directly; this shell is the full
/// window experience.
@MainActor
public struct OpenClawChatWindowShell: View {
    @State private var viewModel: OpenClawChatViewModel
    @State private var sessionQuery = ""
    @State private var isConfirmingClearHistory = false
    private let userAccent: Color?

    public init(viewModel: OpenClawChatViewModel, userAccent: Color? = nil) {
        _viewModel = State(initialValue: viewModel)
        self.userAccent = userAccent
    }

    public var body: some View {
        NavigationSplitView {
            ChatSessionSidebar(
                viewModel: self.viewModel,
                query: self.$sessionQuery)
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 340)
        } detail: {
            OpenClawChatView(
                viewModel: self.viewModel,
                drawsBackground: false,
                userAccent: self.userAccent,
                composerChrome: .clean)
                .navigationTitle(self.activeSessionTitle)
                .navigationSubtitle(self.subtitle)
                .toolbar { self.detailToolbar }
                .background(self.keyboardShortcutHandlers)
        }
        .confirmationDialog(
            "Clear this session's history?",
            isPresented: self.$isConfirmingClearHistory)
        {
            Button(role: .destructive) {
                self.viewModel.requestSessionReset()
            } label: {
                Text("Clear History")
                    .font(OpenClawChatTypography.body)
            }
        } message: {
            Text("This resets the conversation for \(self.activeSessionTitle). The session key stays the same.")
                .font(OpenClawChatTypography.body)
        }
        .onChange(of: self.viewModel.pendingRunCount) { previous, current in
                // Run completion changes timestamps/token totals; pull them once
                // per run instead of polling.
                if previous > 0, current == 0 {
                    self.viewModel.refreshSessions(limit: 200)
                }
            }
    }

    /// Key equivalents only fire for installed views; buttons inside a closed
    /// toolbar Menu are not built yet, so the shortcuts live here and the menu
    /// items carry matching labels for discoverability.
    private var keyboardShortcutHandlers: some View {
        Group {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                Text("New Session")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("n", modifiers: [.command])

            Button {
                self.viewModel.refresh()
                self.viewModel.refreshSessions(limit: 200)
            } label: {
                Text("Refresh")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("r", modifiers: [.command])

            Button {
                self.exportTranscript()
            } label: {
                Text("Export Transcript")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .disabled(self.viewModel.messages.isEmpty)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private var activeSessionTitle: String {
        let entry = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        if let entry {
            return ChatSessionSidebarModel.displayName(for: entry)
        }
        return ChatSessionSidebarModel.displayName(forKey: self.viewModel.sessionKey)
    }

    private var subtitle: String {
        let model = self.currentModelLabel
        guard let usage = self.viewModel.contextUsage, let cost = usage.totalCost else {
            return model
        }
        let costLabel = ChatContextUsageFormatter.cost(cost)
        return model.isEmpty ? costLabel : "\(model) · \(costLabel)"
    }

    private var currentModelLabel: String {
        if self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID {
            return self.viewModel.modelSelectionID
        }
        let entry = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        for candidate in [entry?.model, self.viewModel.sessionDefaults?.model] {
            if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
                return trimmed
            }
        }
        return ""
    }

    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if let usage = self.viewModel.contextUsage {
                ChatContextUsageMenu(usage: usage) {
                    self.viewModel.requestSessionCompact()
                }
            }

            if self.viewModel.showsThinkingPicker {
                self.thinkingPicker
            }

            if self.viewModel.showsModelPicker {
                self.modelPicker
            }

            self.sessionActionsMenu
        }
    }

    private var thinkingPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.thinkingLevel },
            set: { self.viewModel.selectThinkingLevel($0) }))
        {
            ForEach(self.viewModel.thinkingLevelOptions) { option in
                Text(option.label)
                    .font(OpenClawChatTypography.body)
                    .tag(option.id)
            }
        } label: {
            Text("Thinking")
                .font(OpenClawChatTypography.body)
        }
        .pickerStyle(.menu)
        .help("Thinking level")
    }

    private var modelPicker: some View {
        let sections = self.viewModel.modelPickerSections
        return Picker(selection: Binding(
            get: { self.viewModel.modelSelectionID },
            set: { self.viewModel.selectModel($0) }))
        {
            Text(self.viewModel.defaultModelLabel)
                .font(OpenClawChatTypography.body)
                .tag(OpenClawChatViewModel.defaultModelSelectionID)
            if sections.pinned.isEmpty, sections.recent.isEmpty {
                self.modelOptions(sections.remaining)
            } else {
                if !sections.pinned.isEmpty {
                    Section("Pinned") { self.modelOptions(sections.pinned) }
                }
                if !sections.recent.isEmpty {
                    Section("Recent") { self.modelOptions(sections.recent) }
                }
                if !sections.remaining.isEmpty {
                    Section("Models") { self.modelOptions(sections.remaining) }
                }
            }
        } label: {
            Text("Model")
                .font(OpenClawChatTypography.body)
        }
        .pickerStyle(.menu)
        .help("Model")
    }

    private func modelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            Text(model.displayLabel)
                .font(OpenClawChatTypography.body)
                .tag(model.selectionID)
        }
    }

    private var sessionActionsMenu: some View {
        Menu {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                chatWindowActionLabel("New Session", systemImage: "square.and.pencil")
            }
            .keyboardShortcut("n", modifiers: [.command])

            Button {
                self.viewModel.refresh()
                self.viewModel.refreshSessions(limit: 200)
            } label: {
                chatWindowActionLabel("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: [.command])

            Divider()

            Button {
                self.copyToPasteboard(self.viewModel.sessionKey)
            } label: {
                chatWindowActionLabel("Copy Session Key", systemImage: "doc.on.doc")
            }

            Button {
                self.exportTranscript()
            } label: {
                chatWindowActionLabel("Export Transcript…", systemImage: "square.and.arrow.up")
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .disabled(self.viewModel.messages.isEmpty)

            Divider()

            Button {
                self.viewModel.requestSessionCompact()
            } label: {
                chatWindowActionLabel("Compact Session", systemImage: "arrow.down.right.and.arrow.up.left")
            }
            .disabled(self.viewModel.hasBlockingRunActivity)

            Button(role: .destructive) {
                self.isConfirmingClearHistory = true
            } label: {
                chatWindowActionLabel("Clear History…", systemImage: "trash")
            }
        } label: {
            chatWindowActionLabel("Session", systemImage: "ellipsis.circle")
        }
        .menuIndicator(.hidden)
        .help("Session actions")
    }

    private func copyToPasteboard(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }

    private func exportTranscript() {
        let markdown = self.viewModel.exportTranscriptMarkdown()
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = ChatTranscriptExporter.filename(
            sessionTitle: self.activeSessionTitle,
            sessionKey: self.viewModel.sessionKey)
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? markdown.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

/// Toolbar gauge + dropdown with token/cost details, mirroring the web UI's
/// context ring.
private struct ChatContextUsageMenu: View {
    let usage: OpenClawChatContextUsage
    let onCompact: () -> Void

    var body: some View {
        Menu {
            Text(self.tokensLine)
                .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            if let cost = self.usage.totalCost {
                Text("Session cost \(ChatContextUsageFormatter.cost(cost))")
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
            Divider()
            Button(action: self.onCompact) {
                Text("Compact Session")
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
        } label: {
            ChatContextUsageIndicator(usage: self.usage)
        }
        .menuIndicator(.hidden)
        .help(self.tokensLine)
    }

    private var tokensLine: String {
        let used = ChatContextUsageFormatter.tokens(self.usage.usedTokens)
        guard let window = self.usage.contextWindowTokens else {
            return "\(used) tokens used"
        }
        return "\(used) of \(ChatContextUsageFormatter.tokens(window)) tokens used"
    }
}

@MainActor
private struct ChatSessionSidebar: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Binding var query: String
    @State private var sessionPendingDeletion: OpenClawChatSessionEntry?

    var body: some View {
        let sections = ChatSessionSidebarModel.sections(
            sessions: self.viewModel.sessions,
            currentSessionKey: self.viewModel.sessionKey,
            mainSessionKey: self.viewModel.resolvedMainSessionKey,
            activeAgentID: self.viewModel.activeAgentId,
            query: self.query)
        List(selection: self.selectionBinding) {
            ForEach(sections) { section in
                if let title = section.title {
                    Section(title) {
                        ForEach(section.sessions) { session in
                            self.row(for: session)
                        }
                    }
                } else {
                    ForEach(section.sessions) { session in
                        self.row(for: session)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: self.$query, placement: .sidebar, prompt: "Search sessions")
        .overlay {
            if sections.isEmpty {
                ContentUnavailableView(
                    self.query.isEmpty ? "No Sessions" : "No Results",
                    systemImage: "bubble.left.and.bubble.right")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            self.connectionFooter
        }
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await self.viewModel.startNewSession() }
                } label: {
                    chatWindowActionLabel("New Session", systemImage: "square.and.pencil")
                }
                .help("New session")
            }
        }
        .task {
            self.viewModel.refreshSessions(limit: 200)
        }
        .onChange(of: self.viewModel.healthOK) { previous, current in
            if !previous, current {
                self.viewModel.refreshSessions(limit: 200)
            }
        }
        .confirmationDialog(
            self.deleteDialogTitle,
            isPresented: self.isPresentingDeleteDialog)
        {
            Button(role: .destructive) {
                if let session = self.sessionPendingDeletion {
                    self.viewModel.deleteSession(session.key)
                }
                self.sessionPendingDeletion = nil
            } label: {
                Text("Delete Session")
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
        } message: {
            Text("The session and its transcript are removed from the gateway.")
                .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
        }
    }

    private var deleteDialogTitle: String {
        let name = self.sessionPendingDeletion.map(ChatSessionSidebarModel.displayName(for:)) ?? ""
        return "Delete “\(name)”?"
    }

    private var isPresentingDeleteDialog: Binding<Bool> {
        Binding(
            get: { self.sessionPendingDeletion != nil },
            set: { if !$0 { self.sessionPendingDeletion = nil } })
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

    private func row(for session: OpenClawChatSessionEntry) -> some View {
        HStack(spacing: 6) {
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

            if session.unread == true, session.key != self.viewModel.sessionKey {
                Circle()
                    .fill(.tint)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel("Unread")
            }
        }
        // The tag type must equal the List selection type (String?) exactly;
        // a plain String tag silently breaks selection highlighting/clicks.
        .tag(Optional(session.key))
        .contextMenu {
            Button {
                self.viewModel.setSessionPinned(session.key, pinned: session.pinned != true)
            } label: {
                Text(session.pinned == true ? "Unpin" : "Pin")
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(session.key, forType: .string)
            } label: {
                Text("Copy Session Key")
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
            if ChatSessionSidebarModel.canDeleteSession(
                key: session.key,
                mainSessionKey: self.viewModel.resolvedMainSessionKey)
            {
                Divider()
                Button(role: .destructive) {
                    self.sessionPendingDeletion = session
                } label: {
                    Text("Delete Session…")
                        .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
                }
            }
        }
    }

    private func rowSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        guard let updatedAt = session.updatedAt ?? session.lastActivityAt, updatedAt > 0 else {
            return nil
        }
        let date = Date(timeIntervalSince1970: updatedAt / 1000)
        return date.formatted(.relative(presentation: .named))
    }

    private var connectionFooter: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.viewModel.healthOK ? "Gateway connected" : "Connecting…")
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

private func chatWindowActionLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
    Label {
        Text(title)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    } icon: {
        Image(systemName: systemImage)
    }
}
#endif
