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
    public nonisolated static let assistantTraceDefaultsKey = "openclaw.webchat.showAssistantTrace"
    public nonisolated static let assistantReasoningDefaultsKey = "openclaw.webchat.showAssistantReasoning"
    public nonisolated static let assistantToolActivityDefaultsKey = "openclaw.webchat.showAssistantToolActivity"

    @State private var viewModel: OpenClawChatViewModel
    @State private var sessionQuery = ""
    @State private var isConfirmingClearHistory = false
    @State private var isPresentingSessions = false
    @State private var isRenamingSession = false
    @State private var isPresentingNewSessionOptions = false
    @State private var renameSessionKey: String?
    @State private var renameText = ""
    private let userAccent: Color?
    private let displayOptions: OpenClawChatDisplayOptions
    private let emptyAssistantIntro: String?
    private let emptyAssistantPrompts: [OpenClawChatView.StarterPrompt]
    private let talkControl: OpenClawChatTalkControl?
    private let voiceNoteControl: OpenClawChatVoiceNoteControl?
    private let speech: OpenClawChatSpeechController?

    /// `showsAssistantTrace` remains as a source-compatible convenience that sets both display options.
    public init(
        viewModel: OpenClawChatViewModel,
        userAccent: Color? = nil,
        displayOptions: OpenClawChatDisplayOptions? = nil,
        showsAssistantTrace: Bool = false,
        emptyAssistantIntro: String? = nil,
        emptyAssistantPrompts: [OpenClawChatView.StarterPrompt] = [],
        talkControl: OpenClawChatTalkControl? = nil,
        voiceNoteControl: OpenClawChatVoiceNoteControl? = nil,
        speech: OpenClawChatSpeechController? = nil)
    {
        _viewModel = State(initialValue: viewModel)
        self.userAccent = userAccent
        self.displayOptions = displayOptions ?? .assistantTrace(showsAssistantTrace)
        self.emptyAssistantIntro = emptyAssistantIntro
        self.emptyAssistantPrompts = emptyAssistantPrompts
        self.talkControl = talkControl
        self.voiceNoteControl = voiceNoteControl
        self.speech = speech
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
                displayOptions: self.displayOptions,
                composerChrome: .clean,
                emptyAssistantIntro: self.emptyAssistantIntro,
                emptyAssistantPrompts: self.emptyAssistantPrompts,
                talkControl: self.talkControl,
                voiceNoteControl: self.voiceNoteControl,
                speech: self.speech)
                .navigationTitle(self.activeSessionTitle)
                .navigationSubtitle(self.subtitle)
                .toolbar { self.detailToolbar }
                .background(self.keyboardShortcutHandlers)
        }
        .confirmationDialog(
            "Clear this thread's history?",
            isPresented: self.$isConfirmingClearHistory)
        {
            Button(role: .destructive) {
                self.viewModel.requestSessionReset()
            } label: {
                Text("Clear History")
                    .font(OpenClawChatTypography.body)
            }
        } message: {
            Text(verbatim: String(
                format: String(localized: """
                This resets the conversation for %@. The session key stays the same.
                """),
                self.activeSessionTitle))
                .font(OpenClawChatTypography.body)
        }
        .alert(String(localized: "Rename Thread"), isPresented: self.$isRenamingSession) {
                TextField(String(localized: "Thread name"), text: self.$renameText)
                Button(String(localized: "Rename")) {
                    guard let renameSessionKey else { return }
                    self.viewModel.renameSession(key: renameSessionKey, label: self.renameText)
                    self.renameSessionKey = nil
                }
                Button(String(localized: "Cancel"), role: .cancel) {
                    self.renameSessionKey = nil
                }
            }
            .sheet(isPresented: self.$isPresentingSessions) {
                ChatSessionsSheet(viewModel: self.viewModel)
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
                Text("New Thread")
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

            Button {
                self.isPresentingSessions = true
            } label: {
                Text("Threads")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("s", modifiers: [.command, .shift])
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private var activeSessionTitle: String {
        if let entry = self.activeSessionEntry {
            return ChatSessionSidebarModel.displayName(for: entry)
        }
        return ChatSessionSidebarModel.displayName(forKey: self.viewModel.sessionKey)
    }

    private var activeSessionEntry: OpenClawChatSessionEntry? {
        self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey } ??
            self.viewModel.sessions.first {
                self.viewModel.matchesCurrentSessionKey(
                    incoming: $0.key,
                    current: self.viewModel.sessionKey)
            }
    }

    private var activeSessionKey: String {
        self.activeSessionEntry?.key ?? self.viewModel.sessionKey
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

            self.verbosityPicker
            if self.viewModel.selectedModelSupportsFastMode {
                self.fastModeToggle
            }

            if self.viewModel.showsModelPicker {
                self.modelPicker
            }

            self.sessionActionsMenu
        }
    }

    private var thinkingPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.thinkingSelectionID },
            set: { self.viewModel.selectThinkingLevel($0) }))
        {
            Text(String(localized: "Default (inherited)"))
                .font(OpenClawChatTypography.body)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            ForEach(self.viewModel.thinkingLevelOptions) { option in
                Text(String(
                    format: String(localized: "%@ (override)"),
                    option.label))
                    .font(OpenClawChatTypography.body)
                    .tag(option.id)
            }
        } label: {
            Text("Thinking")
                .font(OpenClawChatTypography.body)
        }
        .pickerStyle(.menu)
        .help(String(localized: "Thinking level"))
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private var verbosityPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.verboseLevel },
            set: { self.viewModel.selectVerboseLevel($0) }))
        {
            Text(String(localized: "Default (inherited)"))
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            Text(String(localized: "Off")).tag("off")
            Text(String(localized: "On")).tag("on")
            Text(String(localized: "Full")).tag("full")
        } label: {
            Text(String(localized: "Verbosity"))
                .font(OpenClawChatTypography.body)
        }
        .pickerStyle(.menu)
        .help(String(localized: "Verbosity"))
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private var fastModeToggle: some View {
        Picker(selection: Binding(
            get: { self.viewModel.fastModeSelectionID },
            set: { self.viewModel.selectFastMode($0) }))
        {
            Text(String(localized: "Default (inherited)"))
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            Text(String(localized: "On")).tag("on")
            Text(String(localized: "Off")).tag("off")
        } label: {
            Label(String(localized: "Fast"), systemImage: "bolt.fill")
        }
        .pickerStyle(.menu)
        .help(String(localized: "Fast responses"))
        .disabled(self.viewModel.isUpdatingSessionSettings)
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
            if !sections.pinned.isEmpty {
                Section("Pinned") { self.modelOptions(sections.pinned) }
            }
            if !sections.recent.isEmpty {
                Section("Recent") { self.modelOptions(sections.recent) }
            }
            ForEach(sections.providers) { provider in
                Section {
                    self.modelOptions(provider.models)
                } header: {
                    HStack(spacing: 4) {
                        Text(provider.displayName)
                        if provider.isDefaultProvider {
                            Text(String(localized: "Default"))
                                .font(OpenClawChatTypography.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } label: {
            Text("Model")
                .font(OpenClawChatTypography.body)
        }
        .pickerStyle(.menu)
        .help("Model")
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private func modelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            HStack(spacing: 4) {
                Text(model.displayLabel)
                    .font(OpenClawChatTypography.body)
                if self.viewModel.isDefaultModel(model) {
                    Text(String(localized: "Default"))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tag(model.selectionID)
        }
    }

    private var sessionActionsMenu: some View {
        Menu {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                chatWindowActionLabel("New Thread", systemImage: "square.and.pencil")
            }
            .keyboardShortcut("n", modifiers: [.command])

            Button {
                self.isPresentingNewSessionOptions = true
            } label: {
                chatWindowActionLabel("New Thread Options…", systemImage: "slider.horizontal.3")
            }

            Button {
                self.viewModel.refresh()
                self.viewModel.refreshSessions(limit: 200)
            } label: {
                chatWindowActionLabel("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: [.command])

            Button {
                self.isPresentingSessions = true
            } label: {
                chatWindowActionLabel("Threads…", systemImage: "rectangle.stack")
            }
            .keyboardShortcut("s", modifiers: [.command, .shift])

            Divider()

            Button {
                self.renameSessionKey = self.activeSessionKey
                self.renameText = self.activeSessionEntry?.label ?? self.activeSessionTitle
                self.isRenamingSession = true
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(String(localized: "Rename Thread…")),
                    systemImage: "pencil")
            }

            Button {
                Task { await self.viewModel.forkSession(key: self.activeSessionKey) }
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(String(localized: "Fork")),
                    systemImage: "arrow.triangle.branch")
            }

            Button {
                self.viewModel.setSessionPinned(
                    key: self.activeSessionKey,
                    pinned: self.activeSessionEntry?.pinned != true)
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(self.activeSessionEntry?.pinned == true
                        ? String(localized: "Unpin")
                        : String(localized: "Pin")),
                    systemImage: self.activeSessionEntry?.pinned == true ? "pin.slash" : "pin")
            }

            Button {
                self.viewModel.setSessionUnread(
                    key: self.activeSessionKey,
                    unread: self.activeSessionEntry?.unread != true)
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(self.activeSessionEntry?.unread == true
                        ? String(localized: "Mark Read")
                        : String(localized: "Mark Unread")),
                    systemImage: self.activeSessionEntry?.unread == true ? "envelope.open" : "envelope.badge")
            }

            if self.activeSessionEntry?.isArchived == true || self.activeSessionEntry.map({
                ChatSessionSidebarModel.canArchiveSession(
                    $0,
                    mainSessionKey: self.viewModel.resolvedMainSessionKey)
            }) == true {
                Button {
                    self.viewModel.setSessionArchived(
                        key: self.activeSessionKey,
                        archived: self.activeSessionEntry?.isArchived != true)
                } label: {
                    chatWindowActionLabel(
                        LocalizedStringKey(self.activeSessionEntry?.isArchived == true
                            ? String(localized: "Restore")
                            : String(localized: "Archive")),
                        systemImage: self.activeSessionEntry?.isArchived == true
                            ? "tray.and.arrow.up"
                            : "archivebox")
                }
            }

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

            Toggle(isOn: Binding(
                get: { self.displayOptions.contains(.reasoning) },
                set: {
                    UserDefaults.standard.set(
                        $0,
                        forKey: Self.assistantReasoningDefaultsKey)
                })) {
                    chatWindowActionLabel(
                        "Show Reasoning",
                        systemImage: "brain.head.profile")
                }

            Toggle(isOn: Binding(
                get: { self.displayOptions.contains(.toolActivity) },
                set: {
                    UserDefaults.standard.set(
                        $0,
                        forKey: Self.assistantToolActivityDefaultsKey)
                })) {
                    chatWindowActionLabel(
                        "Show Tool Activity",
                        systemImage: "hammer")
                }

            Divider()

            Button {
                self.viewModel.requestSessionCompact()
            } label: {
                chatWindowActionLabel("Compact Thread", systemImage: "arrow.down.right.and.arrow.up.left")
            }
            .disabled(self.viewModel.hasBlockingRunActivity)

            Button(role: .destructive) {
                self.isConfirmingClearHistory = true
            } label: {
                chatWindowActionLabel("Clear History…", systemImage: "trash")
            }
        } label: {
            chatWindowActionLabel("Thread", systemImage: "ellipsis.circle")
        }
        .popover(isPresented: self.$isPresentingNewSessionOptions) {
            ChatNewSessionOptionsPopover(viewModel: self.viewModel) {
                self.isPresentingNewSessionOptions = false
            }
        }
        .menuIndicator(.hidden)
        .help("Thread actions")
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
                Text(verbatim: String(
                    format: String(localized: "Thread cost %@"),
                    ChatContextUsageFormatter.cost(cost)))
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
            Divider()
            Button(action: self.onCompact) {
                Text("Compact Thread")
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

func chatWindowActionLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
    Label {
        Text(title)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    } icon: {
        Image(systemName: systemImage)
    }
}
#endif
