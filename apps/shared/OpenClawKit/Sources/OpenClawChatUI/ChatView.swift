import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@MainActor
public struct OpenClawChatView: View {
    public enum Style {
        case standard
        case onboarding
    }

    public enum ComposerChrome {
        case full
        case clean
    }

    @State private var viewModel: OpenClawChatViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var scrollerBottomID = UUID()
    @State private var scrollPosition: UUID?
    @State private var showSessions = false
    @State private var hasPerformedInitialScroll = false
    @State private var isPinnedToBottom = true
    @State private var lastUserMessageID: UUID?
    private let showsSessionSwitcher: Bool
    private let drawsBackground: Bool
    private let style: Style
    private let markdownVariant: ChatMarkdownVariant
    private let userAccent: Color?
    private let showsAssistantTrace: Bool
    private let assistantName: String?
    private let assistantAvatarText: String?
    private let assistantAvatarTint: Color?
    private let showsAssistantAvatars: Bool
    private let composerChrome: ComposerChrome
    private let isComposerEnabled: Bool
    private let messagePlaceholder: String?
    private let emptyAssistantIntro: String?
    private let talkControl: OpenClawChatTalkControl?

    private enum Layout {
        #if os(macOS)
        static let outerPaddingHorizontal: CGFloat = 6
        static let outerPaddingVertical: CGFloat = 0
        static let composerPaddingHorizontal: CGFloat = 0
        static let stackSpacing: CGFloat = 0
        static let messageSpacing: CGFloat = 6
        static let messageListPaddingTop: CGFloat = 12
        static let messageListPaddingBottom: CGFloat = 16
        static let messageListPaddingHorizontal: CGFloat = 6
        #else
        static let outerPaddingHorizontal: CGFloat = 6
        static let outerPaddingVertical: CGFloat = 6
        static let composerPaddingHorizontal: CGFloat = 6
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 12
        static let messageListPaddingTop: CGFloat = 10
        static let messageListPaddingBottom: CGFloat = 6
        static let messageListPaddingHorizontal: CGFloat = 8
        #endif
    }

    public init(
        viewModel: OpenClawChatViewModel,
        drawsBackground: Bool = true,
        showsSessionSwitcher: Bool = false,
        style: Style = .standard,
        markdownVariant: ChatMarkdownVariant = .standard,
        userAccent: Color? = nil,
        showsAssistantTrace: Bool = false,
        assistantName: String? = nil,
        assistantAvatarText: String? = nil,
        assistantAvatarTint: Color? = nil,
        showsAssistantAvatars: Bool = true,
        composerChrome: ComposerChrome = .full,
        isComposerEnabled: Bool = true,
        messagePlaceholder: String? = nil,
        emptyAssistantIntro: String? = nil,
        talkControl: OpenClawChatTalkControl? = nil)
    {
        self._viewModel = State(initialValue: viewModel)
        self.drawsBackground = drawsBackground
        self.showsSessionSwitcher = showsSessionSwitcher
        self.style = style
        self.markdownVariant = markdownVariant
        self.userAccent = userAccent
        self.showsAssistantTrace = showsAssistantTrace
        self.assistantName = assistantName
        self.assistantAvatarText = assistantAvatarText
        self.assistantAvatarTint = assistantAvatarTint
        self.showsAssistantAvatars = showsAssistantAvatars
        self.composerChrome = composerChrome
        self.isComposerEnabled = isComposerEnabled
        self.messagePlaceholder = messagePlaceholder
        self.emptyAssistantIntro = emptyAssistantIntro
        self.talkControl = talkControl
    }

    public var body: some View {
        ZStack {
            if self.drawsBackground, self.style == .standard {
                OpenClawChatTheme.background
                    .ignoresSafeArea()
            }

            self.content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { self.viewModel.load() }
        .sheet(isPresented: self.$showSessions) {
            if self.showsSessionSwitcher {
                ChatSessionsSheet(viewModel: self.viewModel)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        VStack(spacing: Layout.stackSpacing) {
            self.messageList
                .padding(.horizontal, Layout.outerPaddingHorizontal)
            self.composer
                .padding(.horizontal, Layout.composerPaddingHorizontal)
        }
        .padding(.vertical, Layout.outerPaddingVertical)
        .frame(maxWidth: .infinity)
        .frame(maxHeight: .infinity, alignment: .top)
        #else
        VStack(spacing: 0) {
            self.messageList
                .padding(.horizontal, Layout.outerPaddingHorizontal)
            self.composer
                .padding(.horizontal, Layout.composerPaddingHorizontal)
                .padding(.top, Layout.stackSpacing)
                .padding(.bottom, Layout.outerPaddingVertical)
        }
        .padding(.top, Layout.outerPaddingVertical)
        .frame(maxWidth: .infinity)
        .frame(maxHeight: .infinity, alignment: .top)
        #endif
    }

    private var composer: some View {
        OpenClawChatComposer(
            viewModel: self.viewModel,
            style: self.style,
            showsSessionSwitcher: self.showsSessionSwitcher,
            userAccent: self.userAccent,
            assistantName: self.assistantName,
            assistantAvatarText: self.assistantAvatarText,
            assistantAvatarTint: self.assistantAvatarTint,
            composerChrome: self.composerChrome,
            isComposerEnabled: self.isComposerEnabled,
            messagePlaceholder: self.messagePlaceholder,
            talkControl: self.talkControl)
    }

    private var messageList: some View {
        ZStack {
            ScrollView {
                LazyVStack(spacing: Layout.messageSpacing) {
                    self.messageListRows

                    Color.clear
                    #if os(macOS)
                        .frame(height: Layout.messageListPaddingBottom)
                    #else
                        .frame(height: Layout.messageListPaddingBottom + 1)
                    #endif
                        .id(self.scrollerBottomID)
                }
                // Use scroll targets for stable auto-scroll without ScrollViewReader relayout glitches.
                .scrollTargetLayout()
                .padding(.top, Layout.messageListPaddingTop)
                .padding(.horizontal, Layout.messageListPaddingHorizontal)
            }
            #if !os(macOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .safeAreaInset(edge: .top, spacing: 0) {
                self.messageListNoticeBanner
            }
            // Keep the scroll pinned to the bottom for new messages.
            .scrollPosition(id: self.$scrollPosition, anchor: .bottom)
            .onChange(of: self.scrollPosition) { _, position in
                guard let position else { return }
                self.isPinnedToBottom = position == self.scrollerBottomID
            }

            if self.viewModel.isLoading, self.composerChrome == .full {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            self.messageListOverlay
        }
        // Ensure the message list claims vertical space on the first layout pass.
        .frame(maxHeight: .infinity, alignment: .top)
        .layoutPriority(1)
        .simultaneousGesture(
            TapGesture().onEnded {
                self.dismissKeyboardIfNeeded()
            })
        .onChange(of: self.viewModel.isLoading) { _, isLoading in
            guard !isLoading, !self.hasPerformedInitialScroll else { return }
            self.scrollPosition = self.scrollerBottomID
            self.hasPerformedInitialScroll = true
            self.isPinnedToBottom = true
        }
        .onChange(of: self.viewModel.sessionKey) { _, _ in
            self.hasPerformedInitialScroll = false
            self.isPinnedToBottom = true
        }
        .onChange(of: self.scenePhase) { _, newValue in
            guard newValue == .active else { return }
            self.viewModel.resumeFromForeground()
        }
        .onChange(of: self.viewModel.isSending) { _, isSending in
            // Scroll to bottom when user sends a message, even if scrolled up.
            guard isSending, self.hasPerformedInitialScroll else { return }
            self.isPinnedToBottom = true
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
        .onChange(of: self.viewModel.messages.count) { _, _ in
            guard self.hasPerformedInitialScroll else { return }
            if let lastMessage = self.viewModel.messages.last,
               lastMessage.role.lowercased() == "user",
               lastMessage.id != self.lastUserMessageID
            {
                self.lastUserMessageID = lastMessage.id
                self.isPinnedToBottom = true
                withAnimation(.snappy(duration: 0.22)) {
                    self.scrollPosition = self.scrollerBottomID
                }
                return
            }

            guard self.isPinnedToBottom else { return }
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
        .onChange(of: self.viewModel.pendingRunCount) { _, _ in
            guard self.hasPerformedInitialScroll, self.isPinnedToBottom else { return }
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
        .onChange(of: self.viewModel.streamingAssistantText) { _, _ in
            guard self.hasPerformedInitialScroll, self.isPinnedToBottom else { return }
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
    }

    @ViewBuilder
    private var messageListRows: some View {
        if let introText = self.visibleEmptyAssistantIntro {
            ChatAssistantIntroCard(text: introText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if self.showsCleanLoadingPlaceholder {
            ChatLoadingBubble()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if let error = self.inlineCleanErrorText {
            let presentation = self.errorPresentation(for: error)
            ChatNoticeCard(
                systemImage: presentation.systemImage,
                title: presentation.title,
                message: error,
                tint: presentation.tint,
                actionTitle: "Refresh",
                action: { self.viewModel.refresh() })
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        ForEach(self.visibleMessages) { msg in
            ChatMessageBubble(
                message: msg,
                style: self.style,
                markdownVariant: self.markdownVariant,
                userAccent: self.userAccent,
                showsAssistantTrace: self.showsAssistantTrace,
                assistantName: self.assistantName,
                assistantAvatarText: self.assistantAvatarText,
                assistantAvatarTint: self.assistantAvatarTint,
                showsAssistantAvatar: self.showsAssistantAvatars)
                .frame(
                    maxWidth: .infinity,
                    alignment: msg.role.lowercased() == "user" ? .trailing : .leading)
        }

        if self.viewModel.pendingRunCount > 0 {
            ChatTypingIndicatorBubble(
                style: self.style,
                assistantName: self.assistantName,
                assistantAvatarText: self.assistantAvatarText,
                assistantAvatarTint: self.assistantAvatarTint,
                showsAssistantAvatar: self.showsAssistantAvatars)
                .equatable()
        }

        if !self.viewModel.pendingToolCalls.isEmpty {
            ChatPendingToolsBubble(toolCalls: self.viewModel.pendingToolCalls)
                .equatable()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if let text = self.viewModel.streamingAssistantText,
           AssistantTextParser.hasVisibleContent(in: text, includeThinking: self.showsAssistantTrace)
        {
            ChatStreamingAssistantBubble(
                text: text,
                markdownVariant: self.markdownVariant,
                showsAssistantTrace: self.showsAssistantTrace,
                assistantName: self.assistantName,
                assistantAvatarText: self.assistantAvatarText,
                assistantAvatarTint: self.assistantAvatarTint,
                showsAssistantAvatar: self.showsAssistantAvatars)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var visibleMessages: [OpenClawChatMessage] {
        let base: [OpenClawChatMessage]
        if self.style == .onboarding {
            guard let first = self.viewModel.messages.first else { return [] }
            base = first.role.lowercased() == "user" ? Array(self.viewModel.messages.dropFirst()) : self.viewModel
                .messages
        } else {
            base = self.viewModel.messages
        }
        return self.mergeToolResults(in: base).filter(self.shouldDisplayMessage(_:))
    }

    @ViewBuilder
    private var messageListOverlay: some View {
        if self.viewModel.isLoading {
            EmptyView()
        } else if self.composerChrome == .clean, self.visibleEmptyAssistantIntro != nil {
            EmptyView()
        } else if self.showsCleanLoadingPlaceholder {
            EmptyView()
        } else if self.inlineCleanErrorText != nil {
            EmptyView()
        } else if let error = self.activeErrorText {
            if self.hasVisibleMessageListContent {
                EmptyView()
            } else {
                let presentation = self.errorPresentation(for: error)
                ChatNoticeCard(
                    systemImage: presentation.systemImage,
                    title: presentation.title,
                    message: error,
                    tint: presentation.tint,
                    actionTitle: "Refresh",
                    action: { self.viewModel.refresh() })
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if self.showsEmptyState {
            ChatNoticeCard(
                systemImage: "bubble.left.and.bubble.right.fill",
                title: self.emptyStateTitle,
                message: self.emptyStateMessage,
                tint: .accentColor,
                actionTitle: nil,
                action: nil)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var activeErrorText: String? {
        guard let text = self.viewModel.errorText?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty
        else {
            return nil
        }
        return text
    }

    private var inlineCleanErrorText: String? {
        guard self.composerChrome == .clean, !self.hasVisibleMessageListContent else {
            return nil
        }
        return self.activeErrorText
    }

    private var hasVisibleMessageListContent: Bool {
        if !self.visibleMessages.isEmpty {
            return true
        }
        if let text = self.viewModel.streamingAssistantText,
           AssistantTextParser.hasVisibleContent(in: text, includeThinking: self.showsAssistantTrace)
        {
            return true
        }
        if self.viewModel.pendingRunCount > 0 {
            return true
        }
        if !self.viewModel.pendingToolCalls.isEmpty {
            return true
        }
        return false
    }

    @ViewBuilder
    private var messageListNoticeBanner: some View {
        if let error = self.activeErrorText,
           self.hasVisibleMessageListContent,
           !self.viewModel.isLoading,
           self.visibleEmptyAssistantIntro == nil,
           !self.showsCleanLoadingPlaceholder
        {
            let presentation = self.errorPresentation(for: error)
            ChatNoticeBanner(
                systemImage: presentation.systemImage,
                title: presentation.title,
                message: error,
                tint: presentation.tint,
                dismiss: { self.viewModel.errorText = nil },
                refresh: { self.viewModel.refresh() })
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 8)
        }
    }

    private var showsCleanLoadingPlaceholder: Bool {
        self.composerChrome == .clean &&
            self.viewModel.isLoading &&
            self.visibleEmptyAssistantIntro == nil &&
            self.activeErrorText == nil &&
            !self.hasVisibleMessageListContent
    }

    private var visibleEmptyAssistantIntro: String? {
        guard self.composerChrome == .clean, self.showsEmptyState else { return nil }
        guard let text = self.emptyAssistantIntro?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else {
            return nil
        }
        return text
    }

    private var showsEmptyState: Bool {
        self.viewModel.messages.isEmpty &&
            !(self.viewModel.streamingAssistantText.map {
                AssistantTextParser.hasVisibleContent(in: $0, includeThinking: self.showsAssistantTrace)
            } ?? false) &&
            self.viewModel.pendingRunCount == 0 &&
            self.viewModel.pendingToolCalls.isEmpty
    }

    private var emptyStateTitle: String {
        #if os(macOS)
        "Web Chat"
        #else
        "Chat"
        #endif
    }

    private var emptyStateMessage: String {
        #if os(macOS)
        "Type a message below to start.\nReturn sends • Shift-Return adds a line break."
        #else
        "Type a message below to start."
        #endif
    }

    private func errorPresentation(for error: String) -> (title: String, systemImage: String, tint: Color) {
        let lower = error.lowercased()
        if lower.contains("not connected") || lower.contains("socket") {
            return ("Disconnected", "wifi.slash", .orange)
        }
        if lower.contains("timed out") {
            return ("Timed out", "clock.badge.exclamationmark", .orange)
        }
        return ("Error", "exclamationmark.triangle.fill", .orange)
    }

    private func mergeToolResults(in messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        var result: [OpenClawChatMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard self.isToolResultMessage(message) else {
                result.append(message)
                continue
            }

            guard let toolCallId = message.toolCallId,
                  let last = result.last,
                  self.toolCallIds(in: last).contains(toolCallId)
            else {
                result.append(message)
                continue
            }

            let toolText = self.toolResultText(from: message)
            if toolText.isEmpty {
                continue
            }

            var content = last.content
            content.append(
                OpenClawChatMessageContent(
                    type: "tool_result",
                    text: toolText,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    id: toolCallId,
                    name: message.toolName,
                    arguments: nil))

            let merged = OpenClawChatMessage(
                id: last.id,
                role: last.role,
                content: content,
                timestamp: last.timestamp,
                toolCallId: last.toolCallId,
                toolName: last.toolName,
                usage: last.usage,
                stopReason: last.stopReason,
                errorMessage: last.errorMessage)
            result[result.count - 1] = merged
        }

        return result
    }

    private func isToolResultMessage(_ message: OpenClawChatMessage) -> Bool {
        let role = message.role.lowercased()
        return role == "toolresult" || role == "tool_result"
    }

    private func shouldDisplayMessage(_ message: OpenClawChatMessage) -> Bool {
        if self.hasInlineAttachments(in: message) {
            return true
        }

        let primaryText = self.primaryText(in: message)
        if !primaryText.isEmpty {
            if message.role.lowercased() == "user" {
                return true
            }
            if AssistantTextParser.hasVisibleContent(in: primaryText, includeThinking: self.showsAssistantTrace) {
                return true
            }
        }

        guard self.showsAssistantTrace else {
            return false
        }

        if self.isToolResultMessage(message) {
            return !primaryText.isEmpty
        }

        return !self.toolCalls(in: message).isEmpty || !self.inlineToolResults(in: message).isEmpty
    }

    private func primaryText(in message: OpenClawChatMessage) -> String {
        let parts = message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty else { return nil }
            return content.text
        }
        return OpenClawChatMessage.displayText(
            contentText: parts.joined(separator: "\n"),
            role: message.role,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage)
    }

    private func hasInlineAttachments(in message: OpenClawChatMessage) -> Bool {
        message.content.contains { content in
            switch content.type ?? "text" {
            case "file", "attachment":
                true
            default:
                false
            }
        }
    }

    private func toolCalls(in message: OpenClawChatMessage) -> [OpenClawChatMessageContent] {
        message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            if ["toolcall", "tool_call", "tooluse", "tool_use"].contains(kind) {
                return true
            }
            return content.name != nil && content.arguments != nil
        }
    }

    private func inlineToolResults(in message: OpenClawChatMessage) -> [OpenClawChatMessageContent] {
        message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            return kind == "toolresult" || kind == "tool_result"
        }
    }

    private func toolCallIds(in message: OpenClawChatMessage) -> Set<String> {
        var ids = Set<String>()
        for content in self.toolCalls(in: message) {
            if let id = content.id {
                ids.insert(id)
            }
        }
        if let toolCallId = message.toolCallId {
            ids.insert(toolCallId)
        }
        return ids
    }

    private func toolResultText(from message: OpenClawChatMessage) -> String {
        self.primaryText(in: message)
    }

    private func dismissKeyboardIfNeeded() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil)
        #endif
    }
}

private struct ChatAssistantIntroCard: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(.system(size: 15))
            .lineSpacing(4)
            .foregroundStyle(OpenClawChatTheme.assistantText)
            .multilineTextAlignment(.leading)
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(OpenClawChatTheme.assistantBubble)
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
            .frame(maxWidth: 280, alignment: .leading)
            .padding(.top, 4)
            .padding(.leading, 10)
    }
}

private struct ChatLoadingBubble: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Loading chat")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 12)
        .background(
            Capsule()
                .fill(OpenClawChatTheme.subtleCard))
        .padding(.leading, 10)
    }
}

private struct ChatNoticeCard: View {
    let systemImage: String
    let title: String
    let message: String
    let tint: Color
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: self.systemImage)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(self.tint)
                .frame(width: 42, height: 42)
                .background(self.tint.opacity(0.14), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.headline)

                Text(self.message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(3)
            }

            Spacer(minLength: 8)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 7)
    }
}

private struct ChatNoticeBanner: View {
    let systemImage: String
    let title: String
    let message: String
    let tint: Color
    let dismiss: () -> Void
    let refresh: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: self.systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(self.tint)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(.caption.weight(.semibold))

                Text(self.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            Button(action: self.refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Refresh")

            Button(action: self.dismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Dismiss")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)))
    }
}
