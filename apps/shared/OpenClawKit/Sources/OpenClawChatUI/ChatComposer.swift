import Foundation
import Observation
import SwiftUI
import UniformTypeIdentifiers

#if !os(macOS)
import PhotosUI
#endif

private struct CleanChatComposerSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.composerField))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
        #endif
    }
}

private enum CleanChatComposerMetrics {
    static let controlHeight: CGFloat = 44
}

private struct CompactChatAttachmentLabel: View {
    var body: some View {
        Image(systemName: "paperclip")
            .font(OpenClawChatTypography.display(size: 15, weight: .semibold, relativeTo: .subheadline))
            .foregroundStyle(.secondary)
            .frame(width: CleanChatComposerMetrics.controlHeight, height: CleanChatComposerMetrics.controlHeight)
            .contentShape(Rectangle())
    }
}

private struct SlashPanelHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

@MainActor
struct OpenClawChatComposer: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let style: OpenClawChatView.Style
    let showsSessionSwitcher: Bool
    let userAccent: Color?
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let composerChrome: OpenClawChatView.ComposerChrome
    let isComposerEnabled: Bool
    let isAttachmentInputEnabled: Bool
    let messagePlaceholder: String?
    let talkControl: OpenClawChatTalkControl?
    let voiceNoteControl: OpenClawChatVoiceNoteControl?

    @State private var isSlashPopoverPresented = false
    @State private var suppressNextSlashPopoverUpdate = false
    @State private var slashPanelHeight: CGFloat = 0
    @State private var slashHighlightIndex = 0
    #if !os(macOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var isFocused: Bool
    #else
    @State private var shouldFocusTextView = false
    #endif
    @ScaledMetric(relativeTo: .body) private var scaledBodyLineHeight: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.showsToolbar, self.voiceNoteControl?.recorder.isRecording != true {
                self.composerToolbar
            }

            if self.showsAttachments, !self.viewModel.attachments.isEmpty {
                self.attachmentsStrip
            }

            if let replyTarget = self.viewModel.replyTarget {
                ChatReplyPreview(target: replyTarget) {
                    self.viewModel.clearReplyTarget()
                }
            }

            if let talkControl, talkControl.isEnabled {
                ChatTalkActivityStrip(control: talkControl)
            }

            if let voiceNoteControl, voiceNoteControl.recorder.isRecording {
                OpenClawVoiceNoteRecordingRow(recorder: voiceNoteControl.recorder)
                    .padding(self.editorPadding)
            } else {
                self.editor
            }
        }
        .padding(self.composerPadding)
        .background {
            if self.composerChrome == .full {
                let cornerRadius: CGFloat = 18

                #if os(macOS)
                if self.style == .standard {
                    let shape = UnevenRoundedRectangle(
                        cornerRadii: RectangleCornerRadii(
                            topLeading: 0,
                            bottomLeading: cornerRadius,
                            bottomTrailing: cornerRadius,
                            topTrailing: 0),
                        style: .continuous)
                    shape
                        .fill(OpenClawChatTheme.composerBackground)
                        .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                        .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
                } else {
                    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    shape
                        .fill(OpenClawChatTheme.composerBackground)
                        .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                        .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
                }
                #else
                let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                shape
                    .fill(OpenClawChatTheme.composerBackground)
                    .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
                #endif
            }
        }
        #if os(macOS)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            self.handleDrop(providers)
        }
        .onAppear {
            self.shouldFocusTextView = true
            self.viewModel.loadSlashCommandsIfNeeded()
        }
        #else
        .onChange(of: self.isComposerEnabled) { _, isEnabled in
                if !isEnabled {
                    self.isFocused = false
                    self.setSlashPanelPresented(false)
                }
            }
            .onAppear {
                self.viewModel.loadSlashCommandsIfNeeded()
            }
        #endif
            .onChange(of: self.voiceNoteControl?.recorder.completedRecording) { _, recording in
                    guard recording != nil else { return }
                    self.stageCompletedVoiceNoteIfNeeded()
                }
                .onChange(of: self.voiceNoteControl?.recorder.ownsPendingChatAttachment) { _, _ in
                    self.viewModel.attachmentOwnerActivityChanged()
                }
                .onChange(of: self.voiceNoteControl?.recorder.errorMessage) { _, message in
                    if let message {
                        self.viewModel.errorText = message
                    }
                }
                .onAppear {
                    self.viewModel.attachmentOwnerActivityChanged()
                    self.stageCompletedVoiceNoteIfNeeded()
                }
                .onDisappear {
                    self.cancelActiveVoiceNoteIfNeeded()
                    self.viewModel.attachmentOwnerActivityChanged()
                }
    }

    private var composerToolbar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    if self.showsSessionSwitcher {
                        self.sessionPicker
                        if self.viewModel.showsThinkingPicker {
                            self.thinkingPicker
                        }
                        #if os(macOS)
                        self.verbosityPicker
                        if self.viewModel.selectedModelSupportsFastMode {
                            self.fastModeToggle
                        }
                        #endif
                    }
                    if self.viewModel.showsModelPicker {
                        self.modelPicker
                        if self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID {
                            self.modelPinButton
                        }
                    }
                }
            }

            Spacer(minLength: 4)

            if let fraction = self.viewModel.contextUsageFraction {
                self.contextUsageIndicator(fraction)
            }

            if self.style == .standard {
                self.refreshButton
                self.attachmentPicker
                if let voiceNoteControl, !voiceNoteControl.isTalkActive {
                    OpenClawVoiceNoteButton(
                        control: voiceNoteControl,
                        compact: false,
                        isComposerEnabled: self.isComposerEnabled,
                        isAttachmentInputEnabled: self.isAttachmentInputEnabled)
                }
            }
        }
        .padding(.horizontal, 10)
    }

    private func contextUsageIndicator(_ fraction: Double) -> some View {
        let percentage = Int((fraction * 100).rounded())
        let color = fraction >= 0.8 ? OpenClawChatTheme.warning : OpenClawChatTheme.muted
        return ZStack {
            Circle()
                .stroke(OpenClawChatTheme.muted.opacity(0.2), lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 14, height: 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            String(
                format: String(localized: "Context %@%% used"),
                percentage.formatted()))
    }

    private var thinkingPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.thinkingSelectionID },
            set: { next in self.viewModel.selectThinkingLevel(next) }))
        {
            Text(String(localized: "Default (inherited)"))
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.inheritedThinkingSelectionID)
            ForEach(self.viewModel.thinkingLevelOptions) { option in
                Text(String(
                    format: String(localized: "%@ (override)"),
                    option.label))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .tag(option.id)
            }
        } label: {
            Text("Thinking")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 140, alignment: .leading)
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    #if os(macOS)
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
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
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
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .help(String(localized: "Fast responses"))
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }
    #endif

    private var modelPicker: some View {
        // Sections come from an O(n) recompute over the catalog; bind once per body eval.
        let sections = self.viewModel.modelPickerSections
        return Picker(selection: Binding(
            get: { self.viewModel.modelSelectionID },
            set: { next in self.viewModel.selectModel(next) }))
        {
            Text(self.viewModel.defaultModelLabel)
                .font(OpenClawChatTypography.captionSemiBold)
                .tag(OpenClawChatViewModel.defaultModelSelectionID)
            if !sections.pinned.isEmpty {
                Section {
                    self.modelOptions(sections.pinned)
                } header: {
                    Text("Pinned")
                        .font(OpenClawChatTypography.captionSemiBold)
                }
            }
            if !sections.recent.isEmpty {
                Section {
                    self.modelOptions(sections.recent)
                } header: {
                    Text("Recent")
                        .font(OpenClawChatTypography.captionSemiBold)
                }
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
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 240, alignment: .leading)
        .help("Model")
        .disabled(self.viewModel.isUpdatingSessionSettings)
    }

    private func modelOptions(_ models: [OpenClawChatModelChoice]) -> some View {
        ForEach(models) { model in
            HStack(spacing: 4) {
                Text(model.displayLabel)
                    .font(OpenClawChatTypography.captionSemiBold)
                if self.viewModel.isDefaultModel(model) {
                    Text(String(localized: "Default"))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tag(model.selectionID)
        }
    }

    private var modelPinButton: some View {
        Button {
            self.viewModel.toggleSelectedModelPinned()
        } label: {
            Image(systemName: self.viewModel.isSelectedModelPinned ? "star.fill" : "star")
                .font(.system(size: 12, weight: .semibold))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.viewModel.isSelectedModelPinned ? "Unpin model" : "Pin model")
    }

    private var sessionPicker: some View {
        Picker(selection: Binding(
            get: { self.viewModel.sessionKey },
            set: { next in self.viewModel.switchSession(to: next) }))
        {
            ForEach(self.viewModel.sessionChoices, id: \.key) { session in
                Text(session.displayName ?? session.key)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .caption))
                    .tag(session.key)
            }
        } label: {
            Text("Session")
                .font(OpenClawChatTypography.captionSemiBold)
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 160, alignment: .leading)
        .help("Session")
    }

    @ViewBuilder
    private var attachmentPicker: some View {
        #if os(macOS)
        if self.composerChrome == .clean {
            Button {
                self.pickFilesMac()
            } label: {
                CompactChatAttachmentLabel()
            }
            .help("Add Image")
            .accessibilityLabel("Attachments")
            .accessibilityIdentifier("chat-attachment-picker")
            .buttonStyle(.plain)
            .controlSize(.small)
            .disabled(!self.isAttachmentInputEnabled)
        } else {
            Button {
                self.pickFilesMac()
            } label: {
                Image(systemName: "paperclip")
            }
            .help("Add Image")
            .accessibilityLabel("Attachments")
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(!self.isAttachmentInputEnabled)
        }
        #else
        if self.composerChrome == .clean {
            PhotosPicker(selection: self.$pickerItems, maxSelectionCount: 8, matching: .images) {
                CompactChatAttachmentLabel()
            }
            .help("Add Image")
            .accessibilityLabel("Attachments")
            .accessibilityIdentifier("chat-attachment-picker")
            .buttonStyle(.plain)
            .controlSize(.small)
            .disabled(!self.isAttachmentInputEnabled)
            .onChange(of: self.pickerItems) { _, newItems in
                Task { await self.loadPhotosPickerItems(newItems) }
            }
        } else {
            PhotosPicker(selection: self.$pickerItems, maxSelectionCount: 8, matching: .images) {
                Image(systemName: "paperclip")
            }
            .help("Add Image")
            .accessibilityLabel("Attachments")
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(!self.isAttachmentInputEnabled)
            .onChange(of: self.pickerItems) { _, newItems in
                Task { await self.loadPhotosPickerItems(newItems) }
            }
        }
        #endif
    }

    private var attachmentsStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(
                    self.viewModel.attachments,
                    id: \OpenClawPendingAttachment.id)
                { (att: OpenClawPendingAttachment) in
                    HStack(spacing: 6) {
                        if let img = att.preview {
                            OpenClawPlatformImageFactory.image(img)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else if att.mimeType.hasPrefix("audio/") {
                            Image(systemName: "waveform")
                            Text("Voice note")
                                .font(OpenClawChatTypography.caption)
                            if let durationSeconds = att.durationSeconds {
                                Text(openClawVoiceNoteDurationLabel(durationSeconds))
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Image(systemName: "photo")
                            Text(att.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                        }

                        if att.preview != nil {
                            Text(att.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                        }

                        Button {
                            self.viewModel.removeAttachment(att.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(OpenClawChatTheme.accent.opacity(0.08))
                    .clipShape(Capsule())
                }
            }
        }
    }

    private var editor: some View {
        self.editorContent
            .overlay(alignment: .top) {
                if self.isSlashPopoverPresented {
                    self.slashCommandPanel
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: SlashPanelHeightKey.self,
                                    value: geo.size.height)
                            })
                        .offset(y: -(self.slashPanelHeight + 8))
                        .transition(.opacity)
                }
            }
            .onPreferenceChange(SlashPanelHeightKey.self) { newHeight in
                self.slashPanelHeight = newHeight
            }
    }

    @ViewBuilder
    private var editorContent: some View {
        if self.composerChrome == .clean {
            self.cleanEditor
        } else {
            self.fullEditor
        }
    }

    private var fullEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.editorOverlay

            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(height: 1)
                .padding(.horizontal, 2)

            HStack(alignment: .center, spacing: 8) {
                if let talkControl {
                    self.talkButton(talkControl)
                }
                if self.showsConnectionPill {
                    self.connectionPill
                }
                Spacer(minLength: 0)
                self.sendButton
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawChatTheme.composerField)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder)))
        .padding(self.editorPadding)
    }

    private var cleanEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Bottom-aligned so the paperclip and send/mic stay on the last
            // text line when the field grows to multiple lines, like iMessage.
            HStack(alignment: .bottom, spacing: 8) {
                self.attachmentPicker
                    .frame(width: self.cleanIconControlSize, height: self.cleanEditorMinHeight)

                if let voiceNoteControl, !voiceNoteControl.isTalkActive {
                    OpenClawVoiceNoteButton(
                        control: voiceNoteControl,
                        compact: true,
                        isComposerEnabled: self.isComposerEnabled,
                        isAttachmentInputEnabled: self.isAttachmentInputEnabled)
                        .frame(width: self.cleanIconControlSize, height: self.cleanEditorMinHeight)
                }

                self.editorOverlay
                    .padding(.vertical, self.cleanEditorTextPadding)
                    .padding(.horizontal, 14)
                    .frame(minHeight: self.cleanEditorMinHeight)
                    .modifier(CleanChatComposerSurface(cornerRadius: self.cleanEditorCornerRadius))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chat-composer-surface")

                self.cleanTrailingControl
                    .frame(height: self.cleanEditorMinHeight, alignment: .bottom)
            }

            if self.showsConnectionPill {
                self.connectionPill
                    .padding(.leading, 44)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }

    /// iMessage-style trailing control: the talk (mic) affordance while the
    /// draft is empty, swapping to the send button once the user types.
    @ViewBuilder
    private var cleanTrailingControl: some View {
        if !self.viewModel.hasDraftToSend, !self.viewModel.hasBlockingRunActivity, let talkControl {
            self.compactTalkButton(talkControl)
        } else {
            self.sendButton
                .frame(width: self.cleanControlHeight, height: self.cleanControlHeight)
        }
    }

    private func talkButton(_ talkControl: OpenClawChatTalkControl) -> some View {
        Button {
            talkControl.toggle(self.viewModel.sessionKey)
        } label: {
            HStack(spacing: 6) {
                ChatTalkButtonGlyph(control: talkControl)
                    .font(OpenClawChatTypography.captionSemiBold)
                Text(talkControl.isEnabled ? "Stop" : "Talk")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .lineLimit(1)
            }
            .foregroundStyle(talkControl.isEnabled ? .white : .primary)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background {
                Capsule()
                    .fill(self.talkButtonFill(talkControl))
            }
            .overlay {
                Capsule()
                    .strokeBorder(self.talkButtonStroke(talkControl), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(!talkControl.isGatewayConnected && !talkControl.isEnabled)
        .accessibilityLabel(talkControl.isEnabled ? "Stop realtime chat" : "Start realtime chat")
        .accessibilityValue(self.talkAccessibilityValue(talkControl))
        .accessibilityIdentifier("chat-realtime-control")
        .help(self.talkHelpText(talkControl))
        .chatTalkInputDeviceMenu(talkControl)
    }

    private func compactTalkButton(_ talkControl: OpenClawChatTalkControl) -> some View {
        Button {
            talkControl.toggle(self.viewModel.sessionKey)
        } label: {
            ChatTalkButtonGlyph(control: talkControl)
                .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .subheadline))
                .foregroundStyle(.white)
                .frame(width: self.cleanIconControlSize, height: self.cleanIconControlSize)
                // Prominent filled circle so the mic reads as the primary action,
                // mirroring the send button it swaps with once a draft exists.
                .background {
                    Circle()
                        .fill(talkControl.isEnabled
                            ? self.talkButtonFill(talkControl)
                            : AnyShapeStyle(OpenClawChatTheme.accent))
                        .opacity(talkControl.isGatewayConnected || talkControl.isEnabled ? 1 : 0.4)
                }
                .frame(width: self.cleanControlHeight, height: self.cleanControlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!talkControl.isGatewayConnected && !talkControl.isEnabled)
        .accessibilityLabel(talkControl.isEnabled ? "Stop realtime chat" : "Start realtime chat")
        .accessibilityValue(self.talkAccessibilityValue(talkControl))
        .accessibilityIdentifier("chat-realtime-control")
        .help(self.talkHelpText(talkControl))
        .chatTalkInputDeviceMenu(talkControl)
    }

    private func talkButtonFill(_ talkControl: OpenClawChatTalkControl) -> AnyShapeStyle {
        if talkControl.isEnabled {
            return AnyShapeStyle(OpenClawChatTheme.userBubble)
        }
        if !talkControl.isGatewayConnected {
            return AnyShapeStyle(Color.secondary.opacity(0.12))
        }
        return OpenClawChatTheme.subtleCard
    }

    private func talkButtonStroke(_ talkControl: OpenClawChatTalkControl) -> Color {
        if talkControl.isEnabled {
            return Color.white.opacity(0.18)
        }
        return OpenClawChatTheme.composerBorder
    }

    private func talkAccessibilityValue(_ talkControl: OpenClawChatTalkControl) -> String {
        let status = talkControl.statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = talkControl.providerLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        return [status, provider].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    private func talkHelpText(_ talkControl: OpenClawChatTalkControl) -> String {
        if !talkControl.isGatewayConnected, !talkControl.isEnabled {
            return "Connect the gateway before starting realtime chat"
        }
        let action = talkControl.isEnabled ? "Stop" : "Start"
        return "\(action) realtime chat for \(self.activeSessionLabel)"
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.connectionOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.connectionStatusText)
                .font(OpenClawChatTypography.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, self.composerChrome == .clean ? 0 : 8)
        .padding(.vertical, self.composerChrome == .clean ? 0 : 4)
        .background {
            if self.composerChrome == .full {
                Capsule()
                    .fill(OpenClawChatTheme.subtleCard)
            }
        }
    }

    private var activeSessionLabel: String {
        let match = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let trimmed = match?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.viewModel.sessionKey : trimmed
    }

    private var editorOverlay: some View {
        ZStack(alignment: self.editorOverlayAlignment) {
            if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(self.placeholderText)
                    .font(OpenClawChatTypography.body)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, self.cleanFieldTextInset)
                    .padding(.vertical, self.composerChrome == .clean ? 0 : 4)
            }

            #if os(macOS)
            ChatComposerTextView(
                text: self.$viewModel.input,
                shouldFocus: self.$shouldFocusTextView,
                isEnabled: self.isComposerEnabled,
                onSend: {
                    self.sendDraftIfEnabled()
                },
                onPasteImageAttachment: { data, fileName, mimeType in
                    guard self.isAttachmentInputEnabled else { return }
                    self.viewModel.addImageAttachment(data: data, fileName: fileName, mimeType: mimeType)
                },
                onKeyCommand: { command, context in
                    self.handleComposerKeyCommand(command, context: context)
                })
                .frame(minHeight: self.textMinHeight, idealHeight: self.textMinHeight, maxHeight: self.textMaxHeight)
                .padding(.horizontal, 4)
                .padding(.vertical, 3)
                .onChange(of: self.viewModel.input) { _, _ in
                    self.updateSlashPopoverPresentation()
                }
            #else
            TextField(
                "",
                text: self.$viewModel.input,
                axis: .vertical)
                .font(OpenClawChatTypography.body)
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .fixedSize(horizontal: false, vertical: true)
                // iMessage-style: return inserts a newline; sending is the
                // circle button's job, so keep the standard return key.
                .submitLabel(.return)
                .padding(.horizontal, self.cleanFieldTextInset)
                .padding(.vertical, self.composerChrome == .clean ? 0 : 6)
                .focused(self.$isFocused)
                .disabled(!self.isComposerEnabled)
                .accessibilityIdentifier("chat-message-input")
                .onChange(of: self.viewModel.input) { _, _ in
                    self.updateSlashPopoverPresentation()
                }
                .onChange(of: self.isFocused) { _, focused in
                    if focused {
                        self.updateSlashPopoverPresentation()
                    } else {
                        self.setSlashPanelPresented(false)
                    }
                }
            #endif
        }
    }
}

extension OpenClawChatComposer {
    private var slashQuery: String? {
        let text = self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("/"), !text.hasPrefix("//") else { return nil }
        let body = String(text.dropFirst())
        guard !body.isEmpty else { return "" }
        let lower = body.lowercased()
        if lower == "skill" || lower.hasPrefix("skill ") {
            return body
        }
        if body.contains(where: \.isWhitespace) {
            return nil
        }
        return body
    }

    private var slashCommandPanel: some View {
        let query = self.slashQuery ?? ""
        let matches = self.viewModel.slashCommandMatches(
            query: query,
            filter: .all)
        return VStack(alignment: .leading, spacing: 0) {
            if self.viewModel.isLoadingSlashCommands, self.viewModel.slashCommands.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading commands")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 96)
            } else if let error = self.viewModel.slashCommandsErrorText,
                      self.viewModel.slashCommands.isEmpty
            {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Commands unavailable")
                        .font(OpenClawChatTypography.footnoteSemiBold)
                    Text(error)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Button {
                        self.viewModel.refreshSlashCommands()
                    } label: {
                        Text("Retry")
                            .font(OpenClawChatTypography.captionSemiBold)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if matches.isEmpty {
                Text("No matching commands")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(matches.enumerated()), id: \.element.id) { index, command in
                                Button {
                                    self.selectSlashCommand(command)
                                } label: {
                                    self.slashCommandRow(
                                        command,
                                        isHighlighted: self.usesSlashKeyboardHighlight
                                            && index == self.slashHighlightIndex)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(command.displayInvocation)
                                .id(index)
                                .onHover { hovering in
                                    if hovering {
                                        self.slashHighlightIndex = index
                                    }
                                }
                            }
                        }
                        .padding(8)
                    }
                    .onChange(of: self.slashHighlightIndex) { _, index in
                        proxy.scrollTo(index)
                    }
                }
                .frame(maxHeight: .infinity)
                .overlay(alignment: .bottom) {
                    if matches.count > 4 {
                        self.slashCommandScrollAffordance
                    }
                }
            }
        }
        .frame(height: 340)
        .background(
            .regularMaterial,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.15), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    private func slashCommandRow(
        _ command: OpenClawChatCommandChoice,
        isHighlighted: Bool) -> some View
    {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(command.displayInvocation)
                    .font(OpenClawChatTypography.mono(
                        size: 15,
                        weight: .semibold,
                        relativeTo: .subheadline))
                    .lineLimit(1)
                if !command.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(command.description)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isHighlighted ? AnyShapeStyle(.selection) : AnyShapeStyle(.clear)))
    }

    private var slashCommandScrollAffordance: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(.regularMaterial)
                .mask(
                    LinearGradient(
                        colors: [.clear, .black],
                        startPoint: .top,
                        endPoint: .bottom))
                .frame(height: 34)

            Image(systemName: "chevron.compact.down")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)
                .background(.regularMaterial)
        }
        .allowsHitTesting(false)
    }

    private func selectSlashCommand(_ command: OpenClawChatCommandChoice) {
        self.suppressNextSlashPopoverUpdate = true
        self.viewModel.applySlashCommandSelection(command)
        self.setSlashPanelPresented(false)
        #if os(macOS)
        self.shouldFocusTextView = true
        #else
        self.isFocused = true
        #endif
    }

    private func setSlashPanelPresented(_ presented: Bool) {
        withAnimation(.easeInOut(duration: 0.18)) {
            self.isSlashPopoverPresented = presented
        }
        if presented {
            self.slashHighlightIndex = 0
        }
    }

    private var slashPanelCanPresent: Bool {
        // Transports without a command catalog (e.g. onboarding) get no panel
        // instead of an empty "No matching commands" box.
        guard self.viewModel.transport.supportsSlashCommandCatalog else { return false }
        // macOS input is an NSTextView outside SwiftUI focus tracking; it is
        // the composer's only editable field, so enablement is the gate.
        #if os(macOS)
        return self.isComposerEnabled
        #else
        return self.isComposerEnabled && self.isFocused
        #endif
    }

    /// Keyboard-driven row highlight is macOS-only; on touch platforms a
    /// persistent highlight on row 0 would read as a stray selection.
    private var usesSlashKeyboardHighlight: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }

    private func updateSlashPopoverPresentation() {
        if self.suppressNextSlashPopoverUpdate {
            self.suppressNextSlashPopoverUpdate = false
            return
        }
        let shouldShow = self.slashPanelCanPresent && self.slashQuery != nil
        if shouldShow {
            self.viewModel.loadSlashCommandsIfNeeded()
            self.slashHighlightIndex = 0
        }
        if shouldShow != self.isSlashPopoverPresented {
            self.setSlashPanelPresented(shouldShow)
        }
    }

    #if os(macOS)
    /// Keyboard routing while the slash panel is open: arrows move the
    /// highlight, Tab/Return accept, Escape dismisses. Returning false hands
    /// the key back to the text view (typing, send-on-return).
    private func handleComposerKeyCommand(
        _ command: ChatComposerKeyCommand,
        context: ChatComposerKeyCommandContext) -> Bool
    {
        if self.isSlashPopoverPresented {
            let matches = self.viewModel.slashCommandMatches(query: self.slashQuery ?? "", filter: .all)
            switch command {
            case .escape:
                self.setSlashPanelPresented(false)
                return true
            case .moveUp:
                guard !matches.isEmpty else { return true }
                self.slashHighlightIndex = (self.slashHighlightIndex - 1 + matches.count) % matches.count
                return true
            case .moveDown:
                guard !matches.isEmpty else { return true }
                self.slashHighlightIndex = (self.slashHighlightIndex + 1) % matches.count
                return true
            case .tab, .returnKey:
                guard matches.indices.contains(self.slashHighlightIndex) else {
                    self.setSlashPanelPresented(false)
                    return command == .tab
                }
                self.selectSlashCommand(matches[self.slashHighlightIndex])
                return true
            }
        }

        switch command {
        case .moveUp:
            return self.viewModel.recallPreviousInput(caretOnFirstLine: context.caretOnFirstLine)
        case .moveDown:
            return self.viewModel.recallNextInput()
        case .escape:
            if self.viewModel.cancelInputRecall() { return true }
            guard self.viewModel.replyTarget != nil else { return false }
            self.viewModel.clearReplyTarget()
            return true
        case .tab, .returnKey:
            return false
        }
    }
    #endif
}

extension OpenClawChatComposer {
    @ViewBuilder
    private var sendButton: some View {
        if self.viewModel.pendingRunCount > 0, !self.viewModel.hasDraftToSend {
            Button {
                self.viewModel.abort()
            } label: {
                if self.viewModel.isAborting {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "stop.fill")
                        .font(OpenClawChatTypography.display(size: 13, weight: .semibold, relativeTo: .caption))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .frame(width: self.sendButtonSize, height: self.sendButtonSize)
            .background(
                RoundedRectangle(cornerRadius: self.sendButtonCornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.danger)
                    .frame(width: self.sendButtonVisualSize, height: self.sendButtonVisualSize))
            .contentShape(Rectangle())
            .accessibilityLabel("Stop response")
            .disabled(self.viewModel.isAborting)
        } else {
            Button {
                self.sendDraftIfEnabled()
            } label: {
                if self.viewModel.isSending {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.up")
                        .font(OpenClawChatTypography.display(size: 13, weight: .semibold, relativeTo: .caption))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(self.sendButtonForeground)
            .frame(width: self.sendButtonSize, height: self.sendButtonSize)
            .background(
                RoundedRectangle(cornerRadius: self.sendButtonCornerRadius, style: .continuous)
                    .fill(self.canSendMessage ? self.sendButtonFill : self.disabledSendButtonFill)
                    .frame(width: self.sendButtonVisualSize, height: self.sendButtonVisualSize))
            .overlay(
                RoundedRectangle(cornerRadius: self.sendButtonCornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(self.sendButtonBorderOpacity), lineWidth: 1)
                    .frame(width: self.sendButtonVisualSize, height: self.sendButtonVisualSize))
            .contentShape(Rectangle())
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("chat-send-message")
            .disabled(!self.canSendMessage)
        }
    }

    private var refreshButton: some View {
        Button {
            self.viewModel.refresh()
        } label: {
            Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help("Refresh")
    }

    private var showsToolbar: Bool {
        self.style == .standard && self.composerChrome == .full
    }

    private var showsAttachments: Bool {
        self.style == .standard
    }

    private var showsConnectionPill: Bool {
        self.style == .standard && self.composerChrome == .full
    }

    private var composerPadding: CGFloat {
        self.style == .onboarding ? 5 : (self.composerChrome == .clean ? 4 : 6)
    }

    private var editorPadding: CGFloat {
        self.style == .onboarding ? 5 : (self.composerChrome == .clean ? 4 : 6)
    }

    private var textMinHeight: CGFloat {
        let base: CGFloat = if self.style == .onboarding {
            24
        } else {
            self.composerChrome == .clean ? 24 : 28
        }
        return max(base, self.scaledBodyLineHeight)
    }

    private var textMaxHeight: CGFloat {
        let base: CGFloat = if self.style == .onboarding {
            52
        } else {
            self.composerChrome == .clean ? 48 : 64
        }
        return max(base, self.scaledBodyLineHeight * 4)
    }

    private var cleanEditorMinHeight: CGFloat {
        max(44, self.textMinHeight + self.cleanEditorTextPadding * 2)
    }

    private var cleanEditorCornerRadius: CGFloat {
        self.cleanEditorMinHeight / 2
    }

    private var cleanEditorTextPadding: CGFloat {
        10
    }

    private var sendButtonSize: CGFloat {
        self.composerChrome == .clean ? self.cleanControlHeight : 44
    }

    private var sendButtonVisualSize: CGFloat {
        self.composerChrome == .clean ? self.cleanIconControlSize : self.sendButtonSize
    }

    private var sendButtonCornerRadius: CGFloat {
        self.composerChrome == .clean ? self.cleanIconControlSize / 2 : 12
    }

    private var cleanControlHeight: CGFloat {
        CleanChatComposerMetrics.controlHeight
    }

    private var cleanIconControlSize: CGFloat {
        32
    }

    private var cleanFieldTextInset: CGFloat {
        self.composerChrome == .clean ? 0 : 4
    }

    private var editorOverlayAlignment: Alignment {
        self.composerChrome == .clean ? .leading : .topLeading
    }

    private var sendButtonFill: Color {
        self.userAccent ?? OpenClawChatTheme.userBubble
    }

    private var disabledSendButtonFill: Color {
        self.composerChrome == .clean ? .clear : Color.secondary.opacity(0.32)
    }

    private var sendButtonForeground: Color {
        if self.canSendMessage || self.composerChrome == .full {
            return .white
        }
        return .secondary.opacity(0.55)
    }

    private var sendButtonBorderOpacity: Double {
        if self.composerChrome == .clean, !self.canSendMessage {
            return 0
        }
        return self.canSendMessage ? 0.18 : 0.08
    }

    private var canSendMessage: Bool {
        self.isComposerEnabled
            && self.voiceNoteControl?.recorder.ownsPendingChatAttachment != true
            && self.viewModel.canSend
            && (self.isAttachmentInputEnabled || self.viewModel.attachments.isEmpty)
    }

    private func stageCompletedVoiceNoteIfNeeded() {
        guard let recorder = self.voiceNoteControl?.recorder,
              let recording = recorder.claimCompletedRecording()
        else { return }

        let viewModel = self.viewModel
        Task {
            await viewModel.addVoiceNoteAttachment(
                fileURL: recording.fileURL,
                durationSeconds: recording.durationSeconds)
            recorder.completeStaging(recording)
        }
    }

    private func cancelActiveVoiceNoteIfNeeded() {
        guard let recorder = self.voiceNoteControl?.recorder,
              recorder.isRecording || recorder.isRequestingPermission
        else { return }
        // The app-owned recorder outlives this view. Release the microphone
        // when its only recording UI disappears so capture never runs hidden.
        recorder.cancel()
    }

    private var connectionStatusText: String {
        self.connectionOK ? "Gateway connected" : "Connecting..."
    }

    private var connectionOK: Bool {
        self.viewModel.healthOK || (self.talkControl?.isGatewayConnected ?? false)
    }

    private var placeholderText: String {
        let trimmed = self.messagePlaceholder?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Message…" : trimmed
    }

    #if os(macOS)
    private func pickFilesMac() {
        guard self.isAttachmentInputEnabled else { return }
        let panel = NSOpenPanel()
        panel.title = "Select image attachments"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.begin { resp in
            guard resp == .OK else { return }
            self.viewModel.addAttachments(urls: panel.urls)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        guard self.isAttachmentInputEnabled else { return false }
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        for item in fileProviders {
            item.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil)
                else { return }
                Task { @MainActor in
                    self.viewModel.addAttachments(urls: [url])
                }
            }
        }
        return true
    }
    #else
    private func loadPhotosPickerItems(_ items: [PhotosPickerItem]) async {
        guard self.isAttachmentInputEnabled else {
            self.pickerItems = []
            return
        }
        for item in items {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                let type = item.supportedContentTypes.first ?? .image
                let ext = type.preferredFilenameExtension ?? "jpg"
                let mime = type.preferredMIMEType ?? "image/jpeg"
                let name = "photo-\(UUID().uuidString.prefix(8)).\(ext)"
                self.viewModel.addImageAttachment(data: data, fileName: name, mimeType: mime)
            } catch {
                self.viewModel.errorText = error.localizedDescription
            }
        }
        self.pickerItems = []
    }
    #endif

    private func sendDraftIfEnabled() {
        guard self.canSendMessage else { return }
        self.viewModel.send()
    }
}
