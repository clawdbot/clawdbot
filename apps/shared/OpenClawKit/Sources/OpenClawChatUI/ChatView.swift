import SwiftUI
#if os(macOS)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

enum ChatReaderUserTransition: Equatable {
    case unchanged
    case added(UUID)
    case removed(latestRemainingID: UUID?)
}

func chatReaderUserTransition(
    previousID: UUID?,
    visibleIDs: [UUID]) -> ChatReaderUserTransition
{
    let latestID = visibleIDs.last
    if let previousID, !visibleIDs.contains(previousID) {
        return .removed(latestRemainingID: latestID)
    }
    if let latestID, latestID != previousID {
        return .added(latestID)
    }
    return .unchanged
}

func chatReaderHasNewerContent(
    after messageID: UUID,
    visibleIDs: [UUID],
    hasTransientContent: Bool) -> Bool
{
    guard let messageIndex = visibleIDs.firstIndex(of: messageID) else { return false }
    return messageIndex < visibleIDs.index(before: visibleIDs.endIndex) || hasTransientContent
}

/// `hasNewerContentBelow` is derived structurally (a later message or streaming text exists),
/// which is true from the first Writing tick of a turn even when the whole transcript is on
/// screen. Gating on the live-edge geometry keeps the jump affordance hidden until content is
/// actually below the viewport; without it the button flashes during every reply (#108693).
func chatReaderShowsJumpToLatest(
    hasNewerContentBelow: Bool,
    isAtLiveEdge: Bool,
    hasVisibleContent: Bool,
    isLoading: Bool) -> Bool
{
    hasNewerContentBelow && !isAtLiveEdge && hasVisibleContent && !isLoading
}

/// The view's own one-shot positioning always runs in a nil-animation transaction, so
/// `.animating` only comes from system scrolls (status-bar scroll-to-top, keyboard
/// avoidance). Not releasing there lets the next timeline tick yank the reader back down.
func chatReaderScrollReleasesFollow(_ phase: ScrollPhase) -> Bool {
    switch phase {
    case .interacting, .animating:
        true
    case .idle, .tracking, .decelerating:
        false
    @unknown default:
        false
    }
}

private enum ScrollFollowTarget: Equatable {
    case latest
    case user(UUID)
}

private struct ChatTurnRecapObservation: Equatable {
    let sessionKey: String
    let indicatorVisible: Bool
    let row: ChatTurnRecapSessionRow?
}

public struct OpenClawChatDisplayOptions: OptionSet, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let reasoning = Self(rawValue: 1 << 0)
    public static let toolActivity = Self(rawValue: 1 << 1)
    public static let assistantTrace: Self = [.reasoning, .toolActivity]

    public static func assistantTrace(_ isVisible: Bool) -> Self {
        isVisible ? .assistantTrace : []
    }
}

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

    public struct StarterPrompt: Hashable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public let prompt: String

        public init(id: String, title: String, prompt: String) {
            self.id = id
            self.title = title
            self.prompt = prompt
        }
    }

    @State private var viewModel: OpenClawChatViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var scrollerBottomID = UUID()
    @State private var scrollPosition: UUID?
    @State private var hasPerformedInitialScroll = false
    @State private var lastUserMessageID: UUID?
    @State private var hasNewerContentBelow = false
    @State private var followTarget: ScrollFollowTarget? = .latest
    @State private var isAtLiveEdge = true
    @State private var isUserScrolling = false
    @State private var isKeyboardVisible = false
    @State private var expandedUserMessageIDs: Set<UUID> = []
    @State private var fullMessageRequest: ChatFullMessageReaderRequest?
    @State private var turnRecapResolver = ChatTurnRecapResolver()
    @State private var turnRecap: ChatTurnRecap?
    @State private var turnRecapSessionKey: String?
    private let showsSessionSwitcher: Bool
    private let drawsBackground: Bool
    private let style: Style
    private let markdownVariant: ChatMarkdownVariant
    private let userAccent: Color?
    private let displayOptions: OpenClawChatDisplayOptions
    private let assistantName: String?
    private let assistantAvatarText: String?
    private let assistantAvatarTint: Color?
    private let showsAssistantAvatars: Bool
    private let composerChrome: ComposerChrome
    private let isComposerEnabled: Bool
    private let isAttachmentInputEnabled: Bool
    private let messagePlaceholder: String?
    private let emptyAssistantIntro: String?
    private let emptyAssistantPrompts: [StarterPrompt]
    private let talkControl: OpenClawChatTalkControl?
    private let dictationControl: OpenClawChatDictationControl?
    private let voiceNoteControl: OpenClawChatVoiceNoteControl?
    private let speech: OpenClawChatSpeechController?

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
        static let newTurnAnchor = UnitPoint(x: 0.5, y: 0.18)
        static let liveEdgeThreshold: CGFloat = 48
        #else
        static let outerPaddingHorizontal: CGFloat = 6
        static let outerPaddingVertical: CGFloat = 6
        static let composerPaddingHorizontal: CGFloat = 6
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 12
        static let messageListPaddingTop: CGFloat = 10
        static let messageListPaddingBottom: CGFloat = 6
        static let messageListPaddingHorizontal: CGFloat = 8
        static let newTurnAnchor = UnitPoint(x: 0.5, y: 0.18)
        static let liveEdgeThreshold: CGFloat = 48
        #endif
    }

    /// `showsAssistantTrace` remains as a source-compatible convenience that sets both display options.
    public init(
        viewModel: OpenClawChatViewModel,
        drawsBackground: Bool = true,
        showsSessionSwitcher: Bool = false,
        style: Style = .standard,
        markdownVariant: ChatMarkdownVariant = .standard,
        userAccent: Color? = nil,
        displayOptions: OpenClawChatDisplayOptions? = nil,
        showsAssistantTrace: Bool = false,
        assistantName: String? = nil,
        assistantAvatarText: String? = nil,
        assistantAvatarTint: Color? = nil,
        showsAssistantAvatars: Bool = true,
        composerChrome: ComposerChrome = .full,
        isComposerEnabled: Bool = true,
        isAttachmentInputEnabled: Bool? = nil,
        messagePlaceholder: String? = nil,
        emptyAssistantIntro: String? = nil,
        emptyAssistantPrompts: [StarterPrompt] = [],
        talkControl: OpenClawChatTalkControl? = nil,
        dictationControl: OpenClawChatDictationControl? = nil,
        voiceNoteControl: OpenClawChatVoiceNoteControl? = nil,
        speech: OpenClawChatSpeechController? = nil)
    {
        _viewModel = State(initialValue: viewModel)
        self.drawsBackground = drawsBackground
        self.showsSessionSwitcher = showsSessionSwitcher
        self.style = style
        self.markdownVariant = markdownVariant
        self.userAccent = userAccent
        self.displayOptions = displayOptions ?? .assistantTrace(showsAssistantTrace)
        self.assistantName = assistantName
        self.assistantAvatarText = assistantAvatarText
        self.assistantAvatarTint = assistantAvatarTint
        self.showsAssistantAvatars = showsAssistantAvatars
        self.composerChrome = composerChrome
        self.isComposerEnabled = isComposerEnabled
        self.isAttachmentInputEnabled = isAttachmentInputEnabled ?? isComposerEnabled
        self.messagePlaceholder = messagePlaceholder
        self.emptyAssistantIntro = emptyAssistantIntro
        self.emptyAssistantPrompts = emptyAssistantPrompts
        self.talkControl = talkControl
        self.dictationControl = dictationControl
        self.voiceNoteControl = voiceNoteControl
        self.speech = speech
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
        .onChange(of: self.turnRecapObservation, initial: true) { _, observation in
            self.updateTurnRecap(observation)
        }
        .sheet(item: self.$fullMessageRequest) { request in
            ChatFullMessageReader(
                request: request,
                markdownVariant: self.markdownVariant,
                load: {
                    try await self.viewModel.transport.requestFullMessage(
                        sessionKey: request.sessionKey,
                        messageID: request.messageID)
                })
        }
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        VStack(spacing: Layout.stackSpacing) {
            self.messageList
                .padding(.horizontal, Layout.outerPaddingHorizontal)
            self.planPill
                .padding(.horizontal, Layout.composerPaddingHorizontal)
            self.turnRecapRow
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
            self.planPill
                .padding(.horizontal, Layout.composerPaddingHorizontal)
                .padding(.top, Layout.stackSpacing)
            self.turnRecapRow
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

    @ViewBuilder
    private var planPill: some View {
        if self.viewModel.hasBlockingRunActivity, !self.viewModel.planSteps.isEmpty {
            ChatPlanPill(
                steps: self.viewModel.planSteps,
                explanation: self.viewModel.planExplanation)
        }
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
            isComposerEnabled: self.isComposerEnabled
                && !self.viewModel.isSendingAttachmentDraft,
            isAttachmentInputEnabled: self.isAttachmentInputEnabled
                && !self.viewModel.isSendingAttachmentDraft,
            messagePlaceholder: self.messagePlaceholder,
            talkControl: self.talkControl,
            dictationControl: self.dictationControl,
            voiceNoteControl: self.voiceNoteControl)
    }

    @ViewBuilder
    private var turnRecapRow: some View {
        if !self.showsWorkingIndicator,
           self.turnRecapSessionKey == self.viewModel.sessionKey,
           let turnRecap
        {
            ChatTurnRecapRow(recap: turnRecap)
                .padding(.horizontal, Layout.outerPaddingHorizontal + Layout.messageListPaddingHorizontal)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
            .scrollPosition(id: self.$scrollPosition, anchor: .bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let distanceFromBottom = geometry.contentSize.height - geometry.visibleRect.maxY
                return distanceFromBottom <= Layout.liveEdgeThreshold
            } action: { _, isAtLiveEdge in
                self.isAtLiveEdge = isAtLiveEdge
                guard self.hasPerformedInitialScroll else { return }
                if isAtLiveEdge, !self.isUserScrolling, !self.isFollowingUserTurn {
                    self.followTarget = .latest
                    self.hasNewerContentBelow = false
                }
            }
            .onScrollPhaseChange { _, phase in
                guard self.hasPerformedInitialScroll else { return }
                if chatReaderScrollReleasesFollow(phase) {
                    self.isUserScrolling = true
                    self.followTarget = nil
                } else if phase == .idle, self.isUserScrolling {
                    self.isUserScrolling = false
                    if self.isAtLiveEdge {
                        self.followTarget = .latest
                        self.hasNewerContentBelow = false
                    } else {
                        self.hasNewerContentBelow = true
                    }
                }
            }

            if self.viewModel.isLoading, self.composerChrome == .full {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            self.messageListOverlay

            if self.showsJumpToLatest {
                self.jumpToLatestButton
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
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
            self.restoreInitialScrollPosition()
            self.hasPerformedInitialScroll = true
            self.lastUserMessageID = self.latestVisibleUserMessageID
        }
        .onChange(of: self.viewModel.sessionKey) { _, _ in
            self.speech?.stop()
            self.hasPerformedInitialScroll = false
            self.followTarget = .latest
            self.isAtLiveEdge = true
            self.isUserScrolling = false
            self.hasNewerContentBelow = false
            self.lastUserMessageID = nil
        }
        .onChange(of: self.scenePhase) { _, newValue in
            if newValue == .background {
                self.speech?.stop()
            }
            guard newValue == .active else { return }
            self.viewModel.resumeFromForeground()
        }
        .onDisappear {
            self.speech?.stop()
        }
        .onChange(of: self.viewModel.timelineRevision) { _, _ in
            self.handleTimelineChange()
        }
        #if canImport(UIKit) && !os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            self.isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            self.isKeyboardVisible = false
        }
        #endif
    }

    @ViewBuilder
    private var messageListRows: some View {
        let contextWindowTokens = self.viewModel.contextUsage?.contextWindowTokens

        if let introText = visibleEmptyAssistantIntro {
            ChatAssistantIntroCard(
                text: introText,
                prompts: self.emptyAssistantPrompts,
                onPrompt: { prompt in
                    self.viewModel.input = prompt.prompt
                    self.viewModel.send()
                })
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if self.showsCleanLoadingPlaceholder {
            ChatLoadingBubble()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        ForEach(self.visibleMessages) { msg in
            self.messageRow(for: msg, contextWindowTokens: contextWindowTokens)
        }

        OpenClawQuestionCards(viewModel: self.viewModel)

        if self.showsWorkingIndicator {
            ChatTypingIndicatorBubble(
                style: self.style,
                assistantName: self.assistantName,
                assistantAvatarText: self.assistantAvatarText,
                assistantAvatarTint: self.assistantAvatarTint,
                showsAssistantAvatar: self.showsAssistantAvatars,
                isClean: self.composerChrome == .clean,
                runIdentity: self.viewModel.workingIndicatorIdentity)
                .equatable()
        }

        if self.displayOptions.contains(.toolActivity), !self.viewModel.pendingToolCalls.isEmpty {
            ChatPendingToolsBubble(toolCalls: self.viewModel.pendingToolCalls)
                .equatable()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if let text = viewModel.streamingAssistantText, self.hasVisibleStreamingAssistantText {
            ChatStreamingAssistantBubble(
                text: text,
                markdownVariant: self.markdownVariant,
                showsReasoning: self.displayOptions.contains(.reasoning),
                assistantName: self.assistantName,
                assistantAvatarText: self.assistantAvatarText,
                assistantAvatarTint: self.assistantAvatarTint,
                showsAssistantAvatar: self.showsAssistantAvatars,
                isClean: self.composerChrome == .clean)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func messageRow(
        for msg: OpenClawChatMessage,
        contextWindowTokens: Int?) -> some View
    {
        let bubble = ChatMessageBubble(
            message: msg,
            style: self.style,
            markdownVariant: self.markdownVariant,
            userAccent: self.userAccent,
            displayOptions: self.displayOptions,
            assistantName: self.assistantName,
            assistantAvatarText: self.assistantAvatarText,
            assistantAvatarTint: self.assistantAvatarTint,
            showsAssistantAvatar: self.showsAssistantAvatars,
            isClean: self.composerChrome == .clean,
            contextWindowTokens: contextWindowTokens,
            userMessageExpanded: self.expandedUserMessageIDs.contains(msg.id),
            onToggleUserMessageExpanded: {
                if self.expandedUserMessageIDs.contains(msg.id) {
                    self.expandedUserMessageIDs.remove(msg.id)
                } else {
                    self.expandedUserMessageIDs.insert(msg.id)
                }
            },
            inlineWidgetResolverReady: self.viewModel.healthOK,
            inlineWidgetResourceResolver: { [weak viewModel] path, failedResource in
                await viewModel?.resolveInlineWidgetResource(path: path, replacing: failedResource)
            })
            .frame(
                maxWidth: .infinity,
                alignment: msg.role.lowercased() == "user" ? .trailing : .leading)
        if let outboxState = self.viewModel.outboxState(for: msg.id) {
            // Offline-queued send: show the durable state under the bubble
            // and offer retry/delete through the row's context menu.
            VStack(alignment: .trailing, spacing: 3) {
                bubble
                ChatOutboxStatusLabel(state: outboxState)
                    .padding(.trailing, 8)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .contextMenu {
                self.copyMessageButton(for: msg)
                self.replyMessageButton(for: msg)
                self.openFullMessageButton(for: msg)
                self.rewindMessageButton(for: msg)
                self.forkMessageButton(for: msg)
                if outboxState.isFailed {
                    Button {
                        self.viewModel.retryOutboxMessage(msg.id)
                    } label: {
                        Label {
                            Text("Retry Send")
                                .font(OpenClawChatTypography.body)
                        } icon: {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                }
                // Sending and acknowledged-but-unconfirmed rows may still
                // reach canonical history, so deletion would hide real work.
                if !outboxState.preventsDeletion {
                    Button(role: .destructive) {
                        self.viewModel.deleteOutboxMessage(msg.id)
                    } label: {
                        Label {
                            Text("Delete")
                                .font(OpenClawChatTypography.body)
                        } icon: {
                            Image(systemName: "trash")
                        }
                    }
                }
            }
        } else if let speech = self.speech, self.isListenable(msg) {
            VStack(alignment: .leading, spacing: 3) {
                bubble
                if let isPreparing = self.speechChipIsPreparing(speech, messageID: msg.id) {
                    ChatSpeechStatusChip(isPreparing: isPreparing) {
                        speech.stop()
                    }
                    .padding(.leading, 8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                self.copyMessageButton(for: msg)
                self.replyMessageButton(for: msg)
                self.openFullMessageButton(for: msg)
                self.rewindMessageButton(for: msg)
                self.forkMessageButton(for: msg)
                Button {
                    if speech.isActive(msg.id) {
                        speech.stop()
                    } else {
                        speech.toggle(
                            messageID: msg.id,
                            text: ChatMessageVisibleText.visibleText(in: msg))
                    }
                } label: {
                    Label {
                        if speech.isActive(msg.id) {
                            Text("Stop Listening")
                                .font(OpenClawChatTypography.body)
                        } else {
                            Text("Listen")
                                .font(OpenClawChatTypography.body)
                        }
                    } icon: {
                        Image(systemName: speech.isActive(msg.id) ? "stop.circle" : "speaker.wave.2")
                    }
                }
            }
        } else {
            bubble
                .contextMenu {
                    self.copyMessageButton(for: msg)
                    self.replyMessageButton(for: msg)
                    self.openFullMessageButton(for: msg)
                    self.rewindMessageButton(for: msg)
                    self.forkMessageButton(for: msg)
                }
        }
    }

    private func isListenable(_ msg: OpenClawChatMessage) -> Bool {
        msg.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant"
            && ChatMessageVisibleText.hasVisibleText(in: msg)
    }

    private func speechChipIsPreparing(
        _ speech: OpenClawChatSpeechController,
        messageID: UUID) -> Bool?
    {
        switch speech.phase {
        case let .preparing(id) where id == messageID:
            true
        case let .speaking(id) where id == messageID:
            false
        default:
            nil
        }
    }

    private var visibleMessages: [OpenClawChatMessage] {
        let base: [OpenClawChatMessage]
        if self.style == .onboarding {
            guard let first = viewModel.messages.first else { return [] }
            base = first.role.lowercased() == "user" ? Array(self.viewModel.messages.dropFirst()) : self.viewModel
                .messages
        } else {
            base = self.viewModel.messages
        }
        return self.mergeToolResults(in: base).filter(self.shouldDisplayMessage(_:))
    }

    private var latestVisibleUserMessageID: UUID? {
        self.visibleUserMessageIDs.last
    }

    private var visibleUserMessageIDs: [UUID] {
        self.visibleMessages.compactMap { message in
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
                ? message.id
                : nil
        }
    }

    private var isFollowingUserTurn: Bool {
        if case .user = self.followTarget {
            return true
        }
        return false
    }

    private var showsJumpToLatest: Bool {
        chatReaderShowsJumpToLatest(
            hasNewerContentBelow: self.hasNewerContentBelow,
            isAtLiveEdge: self.isAtLiveEdge,
            hasVisibleContent: self.hasVisibleMessageListContent,
            isLoading: self.viewModel.isLoading)
    }

    private var jumpToLatestButton: some View {
        Button {
            self.followTarget = .latest
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(OpenClawChatTheme.subtleCard)
                        .shadow(color: .black.opacity(0.16), radius: 8, y: 3))
                // Padding keeps a ~44pt tap target around the compact visual circle.
                .padding(4)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawChatTheme.assistantText)
        .accessibilityLabel("Jump to latest reply")
    }

    @ViewBuilder
    private var messageListOverlay: some View {
        if self.viewModel.isLoading {
            EmptyView()
        } else if self.composerChrome == .clean, self.visibleEmptyAssistantIntro != nil {
            EmptyView()
        } else if self.showsCleanLoadingPlaceholder {
            EmptyView()
        } else if let error = activeErrorText {
            if self.hasVisibleMessageListContent {
                EmptyView()
            } else {
                let presentation = self.errorPresentation(for: error)
                ChatNoticeCard(
                    systemImage: presentation.systemImage,
                    title: presentation.title,
                    message: presentation.message,
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
                actionTitle: nil,
                action: nil)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var activeErrorText: String? {
        guard let text = viewModel.errorText?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty
        else {
            return nil
        }
        return text
    }

    private var hasVisibleMessageListContent: Bool {
        if !self.visibleMessages.isEmpty {
            return true
        }
        return self.hasVisibleTransientContent
    }

    private var hasVisibleStreamingAssistantText: Bool {
        guard let text = self.viewModel.streamingAssistantText else { return false }
        return AssistantTextParser.hasVisibleContent(
            in: text,
            includeThinking: self.displayOptions.contains(.reasoning))
    }

    private var showsWorkingIndicator: Bool {
        self.viewModel.hasBlockingRunActivity && !self.hasVisibleStreamingAssistantText
    }

    private var turnRecapObservation: ChatTurnRecapObservation {
        let row = self.viewModel.currentSessionEntry().map(ChatTurnRecapSessionRow.init)
        return ChatTurnRecapObservation(
            sessionKey: self.viewModel.sessionKey,
            indicatorVisible: self.showsWorkingIndicator,
            row: row)
    }

    private func updateTurnRecap(_ observation: ChatTurnRecapObservation) {
        var resolver = self.turnRecapResolver
        let recap = resolver.resolve(
            sessionKey: observation.sessionKey,
            indicatorVisible: observation.indicatorVisible,
            row: observation.row)
        self.turnRecapResolver = resolver
        self.turnRecap = recap
        self.turnRecapSessionKey = recap == nil ? nil : observation.sessionKey
    }

    private var hasVisibleTransientContent: Bool {
        self.viewModel.hasBlockingRunActivity ||
            (self.displayOptions.contains(.toolActivity) && !self.viewModel.pendingToolCalls.isEmpty) ||
            self.hasVisibleStreamingAssistantText ||
            !self.viewModel.visibleQuestionCards.isEmpty
    }

    @ViewBuilder
    private var messageListNoticeBanner: some View {
        if let error = activeErrorText,
           hasVisibleMessageListContent,
           !self.viewModel.isLoading,
           visibleEmptyAssistantIntro == nil,
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
        guard self.composerChrome == .clean,
              self.showsEmptyState,
              !self.viewModel.isLoading,
              self.activeErrorText == nil,
              self.isComposerEnabled
        else {
            return nil
        }
        guard let text = emptyAssistantIntro?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else {
            return nil
        }
        return text
    }

    private var showsEmptyState: Bool {
        self.viewModel.messages.isEmpty &&
            !self.hasVisibleStreamingAssistantText &&
            !self.viewModel.hasBlockingRunActivity &&
            self.viewModel.pendingToolCalls.isEmpty
    }

    private var emptyStateTitle: String {
        #if os(macOS)
        "Start a Conversation"
        #else
        "Chat"
        #endif
    }

    private var emptyStateMessage: String {
        #if os(macOS)
        "Message your agent to get started.\nReturn sends • Shift-Return adds a line break • / shows commands."
        #else
        "Type a message below to start."
        #endif
    }

    private func errorPresentation(
        for error: String) -> (title: String, message: String, systemImage: String, tint: Color)
    {
        let lower = error.lowercased()
        if lower.contains("not connected") || lower.contains("socket") {
            return ("Disconnected", "Reconnect to your gateway to continue.", "wifi.slash", .orange)
        }
        if lower.contains("timed out") {
            return ("Timed out", "The gateway took too long to respond.", "clock.badge.exclamationmark", .orange)
        }
        // Unknown errors: keep the raw text as the description so it stays actionable.
        return ("Something went wrong", error, "exclamationmark.triangle.fill", .orange)
    }

    private func restoreInitialScrollPosition() {
        if let latestUserMessageID = latestVisibleUserMessageID {
            self.followTarget = nil
            self.hasNewerContentBelow = chatReaderHasNewerContent(
                after: latestUserMessageID,
                visibleIDs: self.visibleMessages.map(\.id),
                hasTransientContent: self.hasVisibleTransientContent)
            self.moveScrollPosition(to: latestUserMessageID, anchor: Layout.newTurnAnchor)
        } else {
            self.followTarget = .latest
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
        }
    }

    private func handleTimelineChange() {
        guard self.hasPerformedInitialScroll else { return }
        if self.viewModel.messages.isEmpty,
           !self.viewModel.hasBlockingRunActivity,
           self.viewModel.pendingToolCalls.isEmpty,
           self.viewModel.streamingAssistantText == nil
        {
            self.lastUserMessageID = nil
            self.followTarget = .latest
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
            return
        }
        let visibleMessages = self.visibleMessages
        let visibleUserMessageIDs = visibleMessages.compactMap { message in
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
                ? message.id
                : nil
        }
        switch chatReaderUserTransition(
            previousID: self.lastUserMessageID,
            visibleIDs: visibleUserMessageIDs)
        {
        case let .removed(latestRemainingID):
            self.lastUserMessageID = latestRemainingID
            if case let .user(messageID) = followTarget,
               !visibleUserMessageIDs.contains(messageID)
            {
                self.followTarget = nil
                self.hasNewerContentBelow = false
            }
            return
        case let .added(latestUserMessageID):
            self.lastUserMessageID = latestUserMessageID
            self.hasNewerContentBelow = false
            // The anchored-question layout assumes a viewport tall enough to read the turn
            // below the anchor. With the keyboard up that space is gone and the reply streams
            // straight past the fold (#108692), so follow the live edge instead.
            if self.isKeyboardVisible {
                self.followTarget = .latest
                self.moveScrollPosition(to: self.scrollerBottomID)
            } else {
                self.followTarget = .user(latestUserMessageID)
                self.moveScrollPosition(to: latestUserMessageID, anchor: Layout.newTurnAnchor)
            }
            return
        case .unchanged:
            break
        }

        switch self.followTarget {
        case .latest:
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
        case let .user(messageID):
            // Reader policy stays on this turn after the one-shot scroll binding is released. Reissuing
            // that target for every streaming delta can loop SwiftUI layout and starve interaction.
            self.hasNewerContentBelow = chatReaderHasNewerContent(
                after: messageID,
                visibleIDs: visibleMessages.map(\.id),
                hasTransientContent: self.hasVisibleTransientContent)
        case nil:
            self.hasNewerContentBelow = true
        }
    }

    private func moveScrollPosition(
        to id: UUID,
        anchor: UnitPoint = .bottom)
    {
        var transaction = Transaction(animation: nil)
        transaction.scrollTargetAnchor = anchor
        withTransaction(transaction) {
            self.scrollPosition = id
        }
        DispatchQueue.main.async {
            guard self.scrollPosition == id else { return }
            // Reader policy lives in followTarget. The binding is only a one-shot positioning request;
            // keeping an overflowing transcript bound to any row can loop SwiftUI scroll layout.
            self.scrollPosition = nil
        }
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

extension OpenClawChatView {
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
                  toolCallIds(in: last).contains(toolCallId)
            else {
                result.append(message)
                continue
            }

            let toolText = self.toolResultText(from: message)
            if toolText.isEmpty {
                continue
            }

            var content = last.content
            // Tool-result diff metadata arrives on the message, but the UI renders the merged block.
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
                    arguments: nil,
                    details: message.details,
                    isError: message.isError))

            let merged = OpenClawChatMessage(
                id: last.id,
                role: last.role,
                content: content,
                timestamp: last.timestamp,
                transcriptMessageID: last.transcriptMessageID,
                isTruncated: last.isTruncated,
                idempotencyKey: last.idempotencyKey,
                toolCallId: last.toolCallId,
                toolName: last.toolName,
                usage: last.usage,
                stopReason: last.stopReason,
                errorMessage: last.errorMessage,
                details: last.details,
                isError: last.isError)
            result[result.count - 1] = merged
        }

        return result
    }

    private func isToolResultMessage(_ message: OpenClawChatMessage) -> Bool {
        let role = message.role.lowercased()
        return role == "toolresult" || role == "tool_result"
    }

    private func shouldDisplayMessage(_ message: OpenClawChatMessage) -> Bool {
        let primaryText = self.primaryText(in: message)
        if self.hasInlineAttachments(in: message) {
            return true
        }

        if self.isToolResultMessage(message) {
            return self.displayOptions.contains(.toolActivity) && !primaryText.isEmpty
        }

        if !primaryText.isEmpty {
            if message.role.lowercased() == "user" {
                return true
            }
            if AssistantTextParser.hasVisibleContent(
                in: primaryText,
                includeThinking: self.displayOptions.contains(.reasoning))
            {
                return true
            }
        }

        return self.displayOptions.contains(.toolActivity) &&
            (!self.toolCalls(in: message).isEmpty || !self.inlineToolResults(in: message).isEmpty)
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

    @ViewBuilder
    private func copyMessageButton(for message: OpenClawChatMessage) -> some View {
        let text = ChatMessageVisibleText.copyText(in: message)
        if !text.isEmpty {
            Button {
                Self.copyToClipboard(text)
            } label: {
                Label {
                    Text("Copy Message")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "doc.on.doc")
                }
            }
        }
    }

    @ViewBuilder
    private func openFullMessageButton(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if role == "assistant",
           message.isTruncated,
           let messageID = message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !messageID.isEmpty
        {
            Button {
                self.fullMessageRequest = ChatFullMessageReaderRequest(
                    sessionKey: self.viewModel.sessionKey,
                    messageID: messageID)
            } label: {
                Label {
                    Text("Open Full Message")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "doc.text.magnifyingglass")
                }
            }
        }
    }

    @ViewBuilder
    private func rewindMessageButton(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if role == "user",
           message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        {
            Button {
                Task { await self.viewModel.rewindToMessage(message) }
            } label: {
                Label {
                    Text("Rewind to Here")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "arrow.uturn.backward")
                }
            }
            .disabled(self.messageSessionActionsDisabled)
        }
    }

    @ViewBuilder
    private func forkMessageButton(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if role == "user",
           message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        {
            Button {
                Task { await self.viewModel.forkAtMessage(message) }
            } label: {
                Label {
                    Text("Fork from Here")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "arrow.triangle.branch")
                }
            }
            .disabled(self.messageSessionActionsDisabled)
        }
    }

    private var messageSessionActionsDisabled: Bool {
        self.viewModel.hasBlockingRunActivity ||
            self.viewModel.isSending ||
            self.viewModel.isAborting
    }

    @ViewBuilder
    private func replyMessageButton(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let text = ChatReplyQuote.targetText(ChatMessageVisibleText.visibleText(in: message))
        if role == "user" || role == "assistant", !text.isEmpty {
            Button {
                self.viewModel.setReplyTarget(
                    messageID: message.id,
                    text: text,
                    senderLabel: self.replySenderLabel(forRole: role))
            } label: {
                Label {
                    Text(String(localized: "Reply"))
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "arrowshape.turn.up.left")
                }
            }
        }
    }

    private func replySenderLabel(forRole role: String) -> String {
        guard role == "assistant" else { return String(localized: "You") }
        let name = self.assistantName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? String(localized: "Assistant") : name
    }

    fileprivate static func copyToClipboard(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

private struct ChatAssistantIntroCard: View {
    let text: String
    let prompts: [OpenClawChatView.StarterPrompt]
    let onPrompt: (OpenClawChatView.StarterPrompt) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Rendered as a grey assistant bubble so the greeting reads like the
            // agent's first message, matching the in-conversation bubble style.
            Text(self.text)
                .font(OpenClawChatTypography.body)
                .foregroundStyle(OpenClawChatTheme.assistantText)
                .multilineTextAlignment(.leading)
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(OpenClawChatTheme.assistantBubble))

            ForEach(self.prompts) { prompt in
                Button {
                    self.onPrompt(prompt)
                } label: {
                    HStack(spacing: 8) {
                        Text(prompt.title)
                            .font(OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .callout))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right")
                            .font(OpenClawChatTypography.captionSemiBold)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(OpenClawChatTheme.subtleCard))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-starter-\(prompt.id)")
            }
        }
        .frame(maxWidth: 340, alignment: .leading)
        .padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatLoadingBubble: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Loading chat")
                .font(OpenClawChatTypography.captionSemiBold)
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
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        // Native empty/error state: SwiftUI's standard ContentUnavailableView, not a custom card.
        ContentUnavailableView {
            Label(self.title, systemImage: self.systemImage)
                .font(OpenClawChatTypography.headline)
        } description: {
            Text(self.message)
                .font(OpenClawChatTypography.body)
        } actions: {
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .subheadline))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
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
                .font(OpenClawChatTypography.display(size: 15, weight: .semibold, relativeTo: .subheadline))
                .foregroundStyle(self.tint)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(OpenClawChatTypography.captionSemiBold)

                Text(self.message)
                    .font(OpenClawChatTypography.caption)
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
