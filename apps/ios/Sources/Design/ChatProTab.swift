import AVFAudio
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

private struct ChatScrollEdgeTreatment: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            // The shared canvas supplies color for the native blur. Automatic
            // edge effects harden to black when the host inserts an opaque fill.
            content.scrollEdgeEffectStyle(.soft, for: .vertical)
        } else {
            content
        }
    }
}

struct ChatProTab: View {
    enum GatewayStatusTone: Equatable {
        case success
        case warning
        case error
    }

    private struct TranscriptShareItem: Identifiable {
        let id = UUID()
        let fileURL: URL
    }

    @Environment(NodeAppModel.self) private var appModel
    @AppStorage("openclaw.webchat.showAssistantTrace")
    private var showsAssistantTrace = true
    @State private var viewModel: OpenClawChatViewModel?
    @State private var viewModelOwnerID = ""
    @State private var transcriptShareItem: TranscriptShareItem?
    @State private var showsTranscriptExportError = false
    @State private var showsBackgroundTasks = false
    @State private var showsSessions = false
    @State private var showsNewSessionOptions = false
    // Transport can start unscoped while the UI uses its "main" fallback.
    // Track the real agent so gateway metadata replaces the captured transport.
    @State private var viewModelTransportAgentID = ""
    @State private var viewModelRoutingContract = ""
    @State private var viewModelPresentationAgentID = "main"
    @State private var viewModelPresentationAgentName = "Main"
    @State private var viewModelPresentationAgentBadge = "M"
    @State private var viewModelHasVerifiedOfflineRoutingIdentity = false
    @State private var speech: OpenClawChatSpeechController?
    @State private var isGatewayStatusManuallyExpanded = false
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let headerTitle: String?
    let showsAgentBadge: Bool
    let ownsNavigationStack: Bool
    let openSettings: (() -> Void)?

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        headerTitle: String? = nil,
        showsAgentBadge: Bool = true,
        ownsNavigationStack: Bool = true,
        openSettings: (() -> Void)? = nil)
    {
        self.headerLeadingAction = headerLeadingAction
        self.headerTitle = headerTitle
        self.showsAgentBadge = showsAgentBadge
        self.ownsNavigationStack = ownsNavigationStack
        self.openSettings = openSettings
    }

    var body: some View {
        Group {
            if self.ownsNavigationStack {
                NavigationStack {
                    self.content
                }
            } else {
                // Phone and iPad hosts already provide a NavigationStack. Keep
                // one native bar so embedded Chat never grows duplicate chrome.
                self.content
            }
        }
        .task {
            await self.appModel.restoreChatSessionRoutingIdentityIfNeeded()
            self.syncChatViewModel()
            if self.speech == nil {
                let gateway = self.appModel.operatorSession
                self.speech = OpenClawChatSpeechController { text in
                    try await ChatMessageSpeechClient.synthesize(text: text, gateway: gateway)
                }
            }
        }
        .onChange(of: self.appModel.chatSessionKey) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatViewModelOwnerID) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatAgentId) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.gatewayDefaultAgentId) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatSessionRoutingContract) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.voiceNoteRecorder.ownsPendingChatAttachment) { _, _ in
            self.viewModel?.attachmentOwnerActivityChanged()
            self.syncChatViewModel()
        }
        .onChange(of: self.viewModel?.isAttachmentOwnerPinned) { _, pinned in
            guard pinned == false else { return }
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.isAppleReviewDemoModeEnabled) { _, _ in
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
        .onChange(of: self.appModel.isScreenshotFixtureModeEnabled) { _, _ in
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
        .onChange(of: self.appModel.isOperatorGatewayConnected) { _, connected in
            guard connected else { return }
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
    }

    private var content: some View {
        self.chatSurface
            .modifier(ChatScrollEdgeTreatment())
            .navigationTitle(self.showsAgentBadge ? "" : self.headerDisplayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let headerLeadingAction {
                    ToolbarItem(placement: .topBarLeading) {
                        OpenClawSidebarRevealButton(action: headerLeadingAction)
                    }
                }
                if self.showsAgentBadge {
                    if #available(iOS 26.0, *) {
                        ToolbarItem(placement: .topBarLeading) {
                            self.headerAgentIdentity
                        }
                        .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .topBarLeading) {
                            self.headerAgentIdentity
                        }
                    }
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        self.headerGatewayStatus
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    self.chatActionsMenu
                }
            }
            .sheet(item: self.$transcriptShareItem) { item in
                ChatTranscriptShareSheet(fileURL: item.fileURL)
            }
            .sheet(isPresented: self.$showsBackgroundTasks) {
                BackgroundTasksScreen(agentID: self.currentAgentID)
            }
            .sheet(isPresented: self.$showsSessions) {
                if let viewModel {
                    ChatSessionsSheet(viewModel: viewModel)
                }
            }
            .sheet(isPresented: self.$showsNewSessionOptions) {
                if let viewModel {
                    ChatNewSessionOptionsPopover(viewModel: viewModel) {
                        self.showsNewSessionOptions = false
                    }
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
                }
            }
            .alert(
                String(localized: "Unable to Export Transcript"),
                isPresented: self.$showsTranscriptExportError)
            {
                Button(role: .cancel) {} label: {
                    Text("OK")
                        .font(OpenClawType.body)
                }
            } message: {
                Text("OpenClaw could not prepare the Markdown file.")
                    .font(OpenClawType.body)
            }
    }

    @ViewBuilder
    private var chatSurface: some View {
        if let viewModel {
            OpenClawChatView(
                viewModel: viewModel,
                drawsBackground: true,
                showsSessionSwitcher: false,
                userAccent: self.chatUserAccent,
                showsAssistantTrace: self.showsAssistantTrace,
                assistantName: self.agentDisplayName,
                assistantAvatarText: self.agentBadge,
                assistantAvatarTint: OpenClawBrand.accent,
                showsAssistantAvatars: false,
                composerChrome: .clean,
                isComposerEnabled: self.gatewayConnected || self.canQueueOffline,
                isAttachmentInputEnabled: self.gatewayConnected || self.canQueueOffline,
                messagePlaceholder: self.messagePlaceholder,
                emptyAssistantIntro: String(localized: "What would you like to work on?"),
                emptyAssistantPrompts: Self.emptyAssistantPrompts,
                talkControl: Self.shouldExposeCaptureControl(
                    isAttachmentOwnerPinned: viewModel.isAttachmentOwnerPinned,
                    isCaptureInFlight: self.appModel.talkMode.isEnabled) ? self.talkControl : nil,
                dictationControl: Self.shouldExposeCaptureControl(
                    isAttachmentOwnerPinned: viewModel.isAttachmentOwnerPinned,
                    isCaptureInFlight: self.appModel.isChatDictationPending || self.appModel.isChatDictationActive)
                    ? self.dictationControl
                    : nil,
                voiceNoteControl: self.voiceNoteControl,
                speech: self.speech)
                // iMessage-style grey bubbles for agent replies in the clean chrome.
                    .environment(\.openClawAssistantBubblesInCleanChrome, true)
                    .id(ObjectIdentifier(viewModel))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            ContentUnavailableView(
                "Preparing Chat",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("The thread attaches once the gateway is ready.")
                    .font(OpenClawType.body))
        }
    }

    /// Voice activity owns the contour while gateway state stays a compact,
    /// stable dot on the avatar instead of competing with it in the toolbar.
    private var headerIdentityBadge: some View {
        TalkAvatarWaveformView(
            phase: self.voiceAvatarPhase,
            palette: .openClawBrand,
            diameter: 38,
            avatarDiameter: 28)
        {
            Text(self.agentBadge)
                .font(OpenClawType.avatar(size: self.agentBadge.count > 2 ? 12 : 16))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .frame(width: 28, height: 28)
                .background(Circle().fill(OpenClawBrand.carapaceElevated))
        }
        .overlay(alignment: .topTrailing) {
            self.gatewayAvatarStatusDot
        }
        .accessibilityElement(children: .ignore)
    }

    private var gatewayAvatarStatusDot: some View {
        ZStack {
            Circle()
                .fill(Color(uiColor: .systemBackground))
            Circle()
                .fill(self.gatewayStatusColor)
                .padding(2)
        }
        .frame(width: 13, height: 13)
        .accessibilityHidden(true)
    }

    private var headerAgentIdentity: some View {
        HStack {
            self.headerAgentIdentityControl
        }
        .frame(minHeight: 44)
        .accessibilityIdentifier("chat-agent-identity")
        .animation(.snappy(duration: 0.24), value: self.showsExpandedGatewayStatus)
    }

    @ViewBuilder
    private var headerGatewayStatus: some View {
        if self.gatewayStatusIsHealthy || self.openSettings != nil {
            Button(action: self.handleHeaderAgentIdentityTap) {
                self.headerGatewayStatusLabel
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: self.gatewayAccessibilityLabel))
            .accessibilityHint(self.gatewayStatusAccessibilityHint)
            .accessibilityIdentifier("chat-gateway-status")
        } else {
            self.headerGatewayStatusLabel
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: self.gatewayAccessibilityLabel))
                .accessibilityIdentifier("chat-gateway-status")
        }
    }

    private var headerGatewayStatusLabel: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.gatewayStatusColor)
                .frame(width: 10, height: 10)
            if self.showsExpandedGatewayStatus {
                self.expandedGatewayStatusLabel
            }
        }
        .frame(minHeight: 44)
        .animation(.snappy(duration: 0.24), value: self.showsExpandedGatewayStatus)
    }

    @ViewBuilder
    private var headerAgentIdentityControl: some View {
        if self.gatewayStatusIsHealthy || self.openSettings != nil {
            Button(action: self.handleHeaderAgentIdentityTap) {
                self.headerAgentIdentityLabel
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: self.headerAgentAccessibilityLabel))
            .accessibilityValue(self.showsExpandedGatewayStatus ? "Expanded" : "Collapsed")
            .accessibilityHint(self.gatewayStatusAccessibilityHint)
            .accessibilityIdentifier("chat-gateway-status")
        } else {
            self.headerAgentIdentityLabel
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: self.headerAgentAccessibilityLabel))
                .accessibilityIdentifier("chat-gateway-status")
        }
    }

    private var headerAgentIdentityLabel: some View {
        HStack(spacing: 7) {
            self.headerIdentityBadge
            if self.showsExpandedGatewayStatus {
                self.expandedGatewayStatusLabel
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            } else {
                Text(self.agentDisplayName)
                    .font(OpenClawType.headline)
                    .lineLimit(1)
                    .transition(.opacity)
            }
        }
    }

    private var gatewayStatusIsHealthy: Bool {
        Self.gatewayStatusTone(
            state: self.gatewayDisplayState,
            isGatewayUsable: self.gatewayConnected) == .success
    }

    private var headerAgentAccessibilityLabel: String {
        "\(self.voiceAvatarAccessibilityLabel). \(self.gatewayAccessibilityLabel)"
    }

    private func handleHeaderAgentIdentityTap() {
        if self.gatewayStatusIsHealthy {
            withAnimation(.snappy(duration: 0.24)) {
                self.isGatewayStatusManuallyExpanded.toggle()
            }
        } else {
            self.openSettings?()
        }
    }

    private var expandedGatewayStatusLabel: some View {
        Text(Self.gatewayStatusTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))
            .font(OpenClawType.subheadMedium)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(self.gatewayStatusColor.opacity(0.12), in: Capsule())
            .overlay {
                Capsule()
                    .stroke(self.gatewayStatusColor.opacity(0.28), lineWidth: 1)
            }
    }

    private var showsExpandedGatewayStatus: Bool {
        Self.gatewayStatusShouldExpand(
            state: self.gatewayDisplayState,
            isGatewayUsable: self.gatewayConnected,
            isManuallyExpanded: self.isGatewayStatusManuallyExpanded)
    }

    private var gatewayStatusAccessibilityHint: String {
        if !self.gatewayStatusIsHealthy {
            return String(localized: "Opens Settings / Gateway")
        }
        return self.isGatewayStatusManuallyExpanded
            ? String(localized: "Hides the gateway status label")
            : String(localized: "Shows the full gateway status label")
    }

    private var voiceAvatarPhase: TalkWaveformPhase {
        guard self.appModel.talkMode.isEnabled else { return .idle }
        if self.appModel.talkMode.isSpeaking {
            return .speaking(level: self.appModel.talkMode.playbackLevel)
        }
        if self.appModel.talkMode.isListening {
            return .listening(
                level: self.appModel.talkMode.micLevel,
                speechActive: self.appModel.talkMode.isUserSpeechDetected)
        }
        return .idle
    }

    private var voiceAvatarAccessibilityLabel: String {
        let state = self.appModel.talkMode.isEnabled
            ? self.appModel.talkMode.statusText
            : String(localized: "Voice off")
        return "\(self.agentDisplayName), \(state)"
    }

    private func syncChatViewModel() {
        let sessionKey = self.appModel.chatSessionKey
        // Includes the cache gateway identity so switching paired gateways
        // rebuilds the view model even while the transport mode stays the same.
        let ownerID = self.appModel.chatViewModelOwnerID
        let deliveryAgentID = self.appModel.chatDeliveryAgentId
        let transportAgentID = Self.transportAgentID(deliveryAgentID)
        let routingContract = self.appModel.chatSessionRoutingContract ?? ""
        guard let viewModel else {
            self.viewModelOwnerID = ownerID
            self.viewModelTransportAgentID = transportAgentID
            self.viewModelRoutingContract = routingContract
            self.captureCurrentPresentationIdentity()
            self.viewModel = self.makeChatViewModel(sessionKey: sessionKey)
            return
        }
        if Self.requiresViewModelRebuild(
            currentOwnerID: self.viewModelOwnerID,
            nextOwnerID: ownerID,
            currentTransportAgentID: self.viewModelTransportAgentID,
            nextTransportAgentID: transportAgentID)
        {
            // Keep recording, staging, and delivery on their captured route.
            // The pin-change observer replays this rebuild with latest state.
            guard !viewModel.isAttachmentOwnerPinned else { return }
            viewModel.endPendingToolActivities()
            self.viewModelOwnerID = ownerID
            self.viewModelTransportAgentID = transportAgentID
            self.viewModelRoutingContract = routingContract
            self.captureCurrentPresentationIdentity()
            self.viewModel = self.makeChatViewModel(sessionKey: sessionKey)
            return
        }
        if self.viewModelRoutingContract != routingContract {
            self.viewModelRoutingContract = routingContract
            viewModel.syncSessionRoutingContract(self.appModel.chatSessionRoutingContract)
        }
        viewModel.syncSession(to: sessionKey)
        if !viewModel.isAttachmentOwnerPinned {
            self.captureCurrentPresentationIdentity()
        }
    }

    private func captureCurrentPresentationIdentity() {
        self.viewModelPresentationAgentID = self.currentAgentID
        self.viewModelPresentationAgentName = self.currentAgentDisplayName
        self.viewModelPresentationAgentBadge = self.currentAgentBadge
        self.viewModelHasVerifiedOfflineRoutingIdentity = self.appModel.hasVerifiedChatOfflineRoutingIdentity
    }

    private func makeChatViewModel(sessionKey: String) -> OpenClawChatViewModel {
        // One store instance backs both seams so the transcript cache and the
        // offline outbox share a single SQLite connection.
        let offlineStore = self.appModel.makeChatOfflineStore()
        let voiceNoteRecorder = self.appModel.voiceNoteRecorder
        return OpenClawChatViewModel(
            sessionKey: sessionKey,
            // Bind durable rows and their transport lease to the exact same
            // gateway owner even if app state switches between these calls.
            transport: self.appModel.makeChatTransport(outboxGatewayID: offlineStore?.gatewayID),
            activeAgentId: self.appModel.chatDeliveryAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract,
            attachmentOwnerIsActive: { voiceNoteRecorder.ownsPendingChatAttachment },
            transcriptCache: offlineStore,
            outbox: offlineStore,
            onSessionChanged: { sessionKey in
                self.appModel.focusChatSession(sessionKey)
            },
            onToolActivity: { id, name, isActive, toolSessionKey in
                if isActive {
                    LiveActivityManager.shared.showTool(
                        id: id,
                        name: name,
                        agentName: self.agentDisplayName,
                        agentBadge: self.agentBadge,
                        sessionKey: toolSessionKey)
                } else {
                    LiveActivityManager.shared.endTool(id: id, sessionKey: toolSessionKey)
                }
            },
            diagnosticsLog: { message in
                GatewayDiagnostics.log(message)
            })
    }

    private var talkControl: OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: self.appModel.talkMode.isEnabled,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isGatewayConnected: self.appModel.talkMode.isGatewayConnected,
            statusText: self.appModel.talkMode.statusText,
            providerLabel: self.appModel.talkMode.gatewayTalkProviderLabel,
            level: self.talkLevel,
            inputDevices: self.talkInputDevices,
            selectedInputDeviceID: self.selectedTalkInputDeviceID,
            selectInputDevice: { deviceID in
                self.appModel.talkMode.selectInputDevice(deviceID)
            },
            cameraFacing: self.appModel.preferredCameraFacing == .front ? .front : .back,
            flipCamera: {
                self.appModel.flipPreferredCameraFacing()
            },
            toggle: { sessionKey in
                self.appModel.focusChatSession(sessionKey)
                self.appModel.setTalkEnabled(!self.appModel.talkMode.isEnabled)
            })
    }

    private var talkInputDevices: [OpenClawChatAudioInputDevice] {
        (AVAudioSession.sharedInstance().availableInputs ?? []).map { input in
            OpenClawChatAudioInputDevice(id: input.uid, name: input.portName)
        }
    }

    private var selectedTalkInputDeviceID: String? {
        guard let preferredID = self.appModel.talkMode.preferredInputDeviceID,
              self.talkInputDevices.contains(where: { $0.id == preferredID })
        else { return nil }
        return preferredID
    }

    private var dictationControl: OpenClawChatDictationControl {
        OpenClawChatDictationControl(
            isActive: self.appModel.isChatDictationActive,
            isAvailable: !self.appModel.isTalkCaptureActive || self.appModel.isChatDictationActive,
            start: {
                try await self.appModel.transcribeChatDraft()
            },
            finish: {
                self.appModel.finishChatDictation()
            },
            cancel: {
                self.appModel.cancelChatDictation()
            })
    }

    private var talkLevel: Double {
        if self.appModel.talkMode.isSpeaking {
            return self.appModel.talkMode.playbackLevel ?? 0
        }
        if self.appModel.talkMode.isListening {
            return self.appModel.talkMode.micLevel
        }
        return 0
    }

    private var voiceNoteControl: OpenClawChatVoiceNoteControl {
        OpenClawChatVoiceNoteControl(
            recorder: self.appModel.voiceNoteRecorder,
            isTalkActive: self.appModel.isTalkCaptureActive)
    }

    private var chatActionsMenu: some View {
        Menu {
            Button {
                Task { await self.viewModel?.startNewSession() }
            } label: {
                Label {
                    Text("New Chat")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "plus.bubble")
                }
            }
            .disabled(self.viewModel == nil || !self.gatewayConnected || self.isAttachmentOwnerPinned)

            if self.activeAgent?.workspacegit == true {
                Button {
                    Task { await self.viewModel?.startNewSession(worktree: true) }
                } label: {
                    Label {
                        Text("New Chat in Worktree")
                            .font(OpenClawType.body)
                    } icon: {
                        Image(systemName: "arrow.triangle.branch")
                    }
                }
                .disabled(self.viewModel == nil || !self.gatewayConnected || self.isAttachmentOwnerPinned)
            }

            Button {
                self.showsNewSessionOptions = true
            } label: {
                Label {
                    Text("New Session Options…")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "slider.horizontal.3")
                }
            }
            .disabled(self.viewModel == nil || !self.gatewayConnected || self.isAttachmentOwnerPinned)

            Button {
                self.showsSessions = true
            } label: {
                Label {
                    Text(String(localized: "Threads…"))
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "rectangle.stack")
                }
            }

            Divider()

            if let viewModel {
                ChatModelControlsMenuItems(viewModel: viewModel)
                Divider()
            }

            Button {
                self.showsBackgroundTasks = true
            } label: {
                Label {
                    Text("Background Tasks")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "clock.arrow.circlepath")
                }
            }
            .disabled(!self.appModel.isOperatorGatewayConnected)

            Button {
                self.exportTranscript()
            } label: {
                Label {
                    Text("Export Transcript")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "square.and.arrow.up")
                }
            }
            .disabled(self.viewModel == nil)

            if let openSettings {
                Divider()

                Button(action: openSettings) {
                    Label {
                        Text("Gateway Settings")
                            .font(OpenClawType.body)
                    } icon: {
                        Image(systemName: "network")
                    }
                }
                .accessibilityIdentifier("chat-gateway-settings")
            }

            Toggle(isOn: self.$showsAssistantTrace) {
                Label {
                    Text(String(localized: "Show reasoning & tool activity"))
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "brain.head.profile")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Chat actions")
    }

    private func exportTranscript() {
        guard let viewModel else { return }
        let title = viewModel.sessions.first { $0.key == viewModel.sessionKey }?.displayName
        let filename = ChatTranscriptExporter.filename(
            sessionTitle: title,
            sessionKey: viewModel.sessionKey)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenClawTranscripts", isDirectory: true)
        let fileURL = directory.appendingPathComponent(filename, isDirectory: false)

        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try viewModel.exportTranscriptMarkdown().write(to: fileURL, atomically: true, encoding: .utf8)
            self.transcriptShareItem = TranscriptShareItem(fileURL: fileURL)
        } catch {
            self.showsTranscriptExportError = true
        }
    }

    private var gatewayConnected: Bool {
        guard self.gatewayDisplayState == .connected else {
            return false
        }
        return self.appModel.isLocalChatFixtureEnabled || self.appModel.isOperatorGatewayConnected
    }

    private var gatewayDisplayState: GatewayDisplayState {
        Self.presentationGatewayState(
            current: GatewayStatusBuilder.build(appModel: self.appModel),
            isAttachmentOwnerPinned: self.isAttachmentOwnerPinned,
            capturedOwnerID: self.viewModelOwnerID,
            currentOwnerID: self.appModel.chatViewModelOwnerID)
    }

    nonisolated static func presentationGatewayState(
        current: GatewayDisplayState,
        isAttachmentOwnerPinned: Bool,
        capturedOwnerID: String,
        currentOwnerID: String) -> GatewayDisplayState
    {
        if isAttachmentOwnerPinned, capturedOwnerID != currentOwnerID {
            return .disconnected
        }
        return current
    }

    /// Attachment pinning blocks new capture, but starting or active capture must keep its stop control.
    nonisolated static func shouldExposeCaptureControl(
        isAttachmentOwnerPinned: Bool,
        isCaptureInFlight: Bool) -> Bool
    {
        !isAttachmentOwnerPinned || isCaptureInFlight
    }

    private var gatewayAccessibilityLabel: String {
        "Gateway: \(Self.gatewayStatusTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))"
    }

    private var gatewayStatusColor: Color {
        switch Self.gatewayStatusTone(
            state: self.gatewayDisplayState,
            isGatewayUsable: self.gatewayConnected)
        {
        case .success:
            OpenClawBrand.statusSuccess
        case .warning:
            OpenClawBrand.statusWarning
        case .error:
            OpenClawBrand.statusError
        }
    }

    nonisolated static func gatewayStatusTone(
        state: GatewayDisplayState,
        isGatewayUsable: Bool) -> GatewayStatusTone
    {
        switch state {
        case .connected:
            isGatewayUsable ? .success : .warning
        case .connecting, .error:
            .warning
        case .disconnected:
            .error
        }
    }

    nonisolated static func gatewayStatusShouldExpand(
        state: GatewayDisplayState,
        isGatewayUsable: Bool,
        isManuallyExpanded: Bool) -> Bool
    {
        isManuallyExpanded || self.gatewayStatusTone(
            state: state,
            isGatewayUsable: isGatewayUsable) != .success
    }

    nonisolated static func gatewayStatusTitle(state: GatewayDisplayState, isGatewayUsable: Bool) -> String {
        switch state {
        case .connected:
            isGatewayUsable ? "Connected" : "Unavailable"
        case .connecting:
            "Connecting"
        case .error:
            "Attention"
        case .disconnected:
            "Offline"
        }
    }

    private var messagePlaceholder: String {
        if self.gatewayConnected {
            return String(
                format: String(localized: "Message %@..."),
                self.agentDisplayName)
        }
        if self.canQueueOffline {
            return String(
                format: String(localized: "Message %@; sends when connected"),
                self.agentDisplayName)
        }
        return String(localized: "Connect to a gateway")
    }

    private var canQueueOffline: Bool {
        self.viewModel?.supportsOfflineTextOutbox == true &&
            (self.isAttachmentOwnerPinned
                ? self.viewModelHasVerifiedOfflineRoutingIdentity
                : self.appModel.hasVerifiedChatOfflineRoutingIdentity)
    }

    private var headerDisplayTitle: String {
        self.normalized(self.headerTitle)
            ?? Self.defaultHeaderTitle(showsAgentBadge: self.showsAgentBadge, agentDisplayName: self.agentDisplayName)
    }

    nonisolated static func defaultHeaderTitle(showsAgentBadge: Bool, agentDisplayName: String) -> String {
        showsAgentBadge ? agentDisplayName : "Chat"
    }

    private var chatUserAccent: Color {
        OpenClawBrand.accent
    }

    private var isAttachmentOwnerPinned: Bool {
        self.viewModel?.isAttachmentOwnerPinned == true
    }

    private var currentAgentID: String {
        self.normalized(self.appModel.chatAgentId) ?? "main"
    }

    private var currentActiveAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.currentAgentID }
    }

    private var activeAgentID: String {
        self.isAttachmentOwnerPinned ? self.viewModelPresentationAgentID : self.currentAgentID
    }

    private var activeAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.activeAgentID }
    }

    private var currentAgentDisplayName: String {
        self.normalized(self.currentActiveAgent?.name) ?? self.appModel.chatAgentName
    }

    private var agentDisplayName: String {
        self.isAttachmentOwnerPinned ? self.viewModelPresentationAgentName : self.currentAgentDisplayName
    }

    private var currentAgentBadge: String {
        if let identity = currentActiveAgent?.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = Self.normalizedBadgeEmoji(emoji)
        {
            return normalizedEmoji
        }
        return Self.initialsBadge(for: self.currentAgentDisplayName)
    }

    private var agentBadge: String {
        self.isAttachmentOwnerPinned ? self.viewModelPresentationAgentBadge : self.currentAgentBadge
    }

    nonisolated static func initialsBadge(for displayName: String) -> String {
        AgentIdentityPresentation.initialsBadge(for: displayName)
    }

    nonisolated static func normalizedBadgeEmoji(_ value: String?) -> String? {
        AgentIdentityPresentation.normalizedBadgeEmoji(value)
    }

    nonisolated static func transportAgentID(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    nonisolated static func requiresViewModelRebuild(
        currentOwnerID: String,
        nextOwnerID: String,
        currentTransportAgentID: String,
        nextTransportAgentID: String) -> Bool
    {
        currentOwnerID != nextOwnerID || currentTransportAgentID != nextTransportAgentID
    }

    nonisolated static let emptyAssistantPrompts: [OpenClawChatView.StarterPrompt] = [
        OpenClawChatView.StarterPrompt(
            id: "summarize-status",
            title: String(localized: "Check OpenClaw status"),
            prompt: String(localized: "Summarize the current OpenClaw status and tell me what needs attention.")),
        OpenClawChatView.StarterPrompt(
            id: "show-controls",
            title: String(localized: "What can I control here?"),
            prompt: String(localized: "Show me which phone controls and device capabilities are available right now.")),
        OpenClawChatView.StarterPrompt(
            id: "start-voice",
            title: String(localized: "Help me start voice chat"),
            prompt: String(localized: "Help me start a realtime voice session from this phone.")),
    ]

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
