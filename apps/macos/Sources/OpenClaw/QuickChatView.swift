import AppKit
import Observation
import OpenClawChatUI
import SwiftUI

@MainActor
struct QuickChatView: View {
    @Bindable var model: QuickChatModel
    @Bindable var replyBinding: QuickChatReplyBinding
    let onDismiss: () -> Void
    let onSendAccepted: (Bool) -> Void
    let onShowAgentPicker: () -> Void
    let onShowModelMenu: () -> Void
    let onShowRecentSessions: () -> Void
    let onToggleDictation: () -> Void
    let onStopDictation: () -> Void
    let onCaptureTextContext: () -> Void
    let onShowCaptureMenu: () -> Void
    let onGrantPermissions: () -> Void
    let onPasteReply: () -> Void
    let onContentHeightChange: (CGFloat) -> Void
    let onTextViewReady: (NSTextView) -> Void

    @State private var editorHeight: CGFloat = 30
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)

            VStack(spacing: 0) {
                self.inputRow

                if let context = self.model.textContext {
                    self.contextChip(context)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if let status = self.statusLine {
                    HStack {
                        Text(verbatim: status.message)
                            .font(.caption)
                            .foregroundStyle(status.isError ? Color.red : Color.orange)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 9)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if self.model.shouldShowPermissionStrip {
                    self.permissionStrip
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if self.replyBinding.route != nil, let viewModel = self.replyBinding.viewModel {
                    self.replyArea(viewModel: viewModel)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .frame(width: 620)
        .fixedSize(horizontal: false, vertical: true)
        .animation(.spring(duration: 0.25), value: self.model.shouldShowPermissionStrip)
        .animation(.easeOut(duration: 0.14), value: self.model.textContext)
        .animation(.easeOut(duration: 0.14), value: self.statusLine?.message)
        .animation(.spring(duration: 0.28), value: self.replyBinding.route)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            self.onContentHeightChange(height)
        }
    }

    @ViewBuilder private var placeholder: some View {
        if let override = self.model.targetSessionOverride {
            Text("Reply in \(override.displayName)")
        } else {
            Text("Message \(self.model.agentDisplay.name)")
        }
    }

    private var inputRow: some View {
        HStack(spacing: 10) {
            self.agentChip
            self.modelControl

            ZStack(alignment: .leading) {
                if self.model.text.isEmpty {
                    // Interpolated string literals keep the placeholder localizable
                    // (SwiftUI's LocalizedStringKey path). Routing through a computed
                    // String would select the verbatim initializer and drop translation.
                    self.placeholder
                        .font(.system(size: 13.5))
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 2)
                        .allowsHitTesting(false)
                }
                QuickChatTextView(
                    text: self.$model.text,
                    selectionRange: self.model.dictationSelectionRange,
                    onSubmit: self.submit,
                    onEscape: {
                        self.onStopDictation()
                        self.onDismiss()
                    },
                    onUserEdit: {
                        guard self.model.isDictating || self.model.isStartingDictation else { return }
                        self.onStopDictation()
                    },
                    onHeightChange: { self.editorHeight = $0 },
                    onTextViewReady: self.onTextViewReady)
                    .frame(height: self.editorHeight)
            }
            .frame(maxWidth: .infinity)

            if self.model.sendState != .sending {
                Button(action: self.onShowRecentSessions) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 16.5, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .disabled(!self.model.canSelectRecentSession)
                .help("Continue a recent conversation")
                .accessibilityLabel("Continue a recent conversation")

                Button(action: self.onToggleDictation) {
                    Group {
                        if self.model.isStartingDictation {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: self.model.isDictating ? "mic.fill" : "mic")
                                .font(.system(size: 16.5, weight: .medium))
                                .foregroundStyle(self.model.isDictating ? Color.red : Color.secondary)
                                .symbolEffect(
                                    .pulse,
                                    isActive: self.model.isDictating && !self.reduceMotion)
                        }
                    }
                    .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .disabled(!self.model.canToggleDictation)
                .help(self.dictationButtonLabel)
                .accessibilityLabel(Text(verbatim: self.dictationButtonLabel))

                Button(action: self.onCaptureTextContext) {
                    Group {
                        if self.model.isCapturingTextContext {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "doc.text")
                                .font(.system(size: 16.5, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .disabled(!self.model.canCaptureTextContext)
                .help(String(localized: "Attach text from \(self.model.frontmostAppName)"))
                .accessibilityLabel(Text(verbatim: String(
                    localized: "Attach text from \(self.model.frontmostAppName)")))

                Button(action: self.onShowCaptureMenu) {
                    Image(systemName: "camera.viewfinder")
                        .font(.system(size: 16.5, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .disabled(!self.model.canCaptureWindow)
                .help("Capture a screenshot")
                .accessibilityLabel("Capture a screenshot")
            }

            Button {
                self.submit(openChat: false)
            } label: {
                Group {
                    switch self.model.sendState {
                    case .sending:
                        ProgressView()
                            .controlSize(.small)
                    case .sent:
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    case .idle, .failed:
                        Image(systemName: "arrow.up.circle.fill")
                            .foregroundStyle(self.model.canSend ? Color.accentColor : Color.secondary)
                    }
                }
                .font(.system(size: 22))
                .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .disabled(!self.model.canSend)
            .accessibilityLabel("Send message")
        }
        .padding(14)
    }

    @ViewBuilder
    private var agentChip: some View {
        if self.model.agents.count > 1 {
            Button(action: self.onShowAgentPicker) {
                self.agentAvatar
            }
            .buttonStyle(.plain)
            .disabled(self.model.sendState == .sending)
            .help(self.model.agentDisplay.name)
        } else {
            self.agentAvatar
                .help(self.model.agentDisplay.name)
        }
    }

    private var modelControl: some View {
        Button(action: self.onShowModelMenu) {
            HStack(spacing: 4) {
                if self.model.isLoadingModelControls || self.model.isUpdatingModel {
                    ProgressView()
                        .controlSize(.mini)
                }
                Text(verbatim: self.model.modelControlLabel)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(Color.primary.opacity(0.06), in: Capsule())
            .frame(maxWidth: 125)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(!self.model.canUseModelControls)
        .help("Choose model and reasoning")
        .accessibilityLabel("Model and reasoning")
    }

    private var agentAvatar: some View {
        ZStack {
            Circle()
                .fill(self.agentTint.opacity(0.18))
            if case let .image(data) = self.model.agentDisplay.avatar,
               let image = NSImage(data: data)
            {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .clipShape(Circle())
            } else if let emoji = self.model.agentDisplay.emoji {
                Text(emoji)
                    .font(.system(size: 16))
            } else {
                Text(self.model.agentDisplay.monogram)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.agentTint)
            }
        }
        .frame(width: 28, height: 28)
        .accessibilityLabel(self.model.agentDisplay.name)
    }

    private var agentTint: Color {
        Color(
            hue: self.model.agentDisplay.tintHue,
            saturation: 0.62,
            brightness: 0.72)
    }

    private var permissionStrip: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.shield")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Needs additional permissions")
                        .font(.caption.weight(.semibold))
                    Text(verbatim: self.model.missingPermissions.map(\.permissionDisplayName).joined(separator: ", "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Grant") {
                    self.onGrantPermissions()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(self.model.isGrantingPermissions)
                Button("Not now") {
                    self.model.dismissPermissionsForSession()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(12)
        }
    }

    private func contextChip(_ context: QuickChatTextContext) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "doc.text")
                .foregroundStyle(Color.accentColor)
            Text("\(context.appName) — \(context.windowTitle) (\(context.characterCount) chars)")
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
            Button(action: self.model.clearTextContext) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attached text context")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Color.accentColor.opacity(0.1), in: Capsule())
        .padding(.horizontal, 14)
        .padding(.bottom, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func replyArea(viewModel: OpenClawChatViewModel) -> some View {
        VStack(spacing: 0) {
            Divider()
            OpenClawChatView(
                viewModel: viewModel,
                drawsBackground: false,
                showsSessionSwitcher: false,
                displayOptions: [],
                showsAssistantAvatars: false,
                composerChrome: .clean,
                isComposerEnabled: false,
                isAttachmentInputEnabled: false)
                .id(self.replyBinding.route)
                .frame(height: 300)
            if QuickChatPasteLogic.finalAssistantText(
                messages: viewModel.messages,
                afterUserIdempotencyKey: self.model.lastAcceptedIdempotencyKey,
                streamingAssistantText: viewModel.streamingAssistantText,
                pendingRunCount: viewModel.pendingRunCount) != nil
            {
                HStack {
                    Spacer()
                    Button {
                        self.onPasteReply()
                    } label: {
                        if self.replyBinding.isPastingReply {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("Paste to \(self.model.frontmostAppName)", systemImage: "doc.on.clipboard")
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(self.replyBinding.isPastingReply)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 9)
            }
        }
    }

    private var statusLine: (message: String, isError: Bool)? {
        if case let .failed(message) = self.model.sendState {
            return (message, true)
        }
        if let message = self.model.textContextCaptureMessage {
            return (message, false)
        }
        if let message = self.model.dictationStatusMessage {
            return (message, true)
        }
        if let message = self.model.modelControlStatusMessage {
            return (message, true)
        }
        if let message = self.replyBinding.pasteStatusMessage {
            return (message, true)
        }
        if let message = self.model.connectionStatusMessage {
            return (message, false)
        }
        return nil
    }

    private func submit(openChat: Bool) {
        self.onStopDictation()
        guard self.model.canSend, let presentationID = self.model.activePresentationID else { return }
        Task {
            guard await self.model.send() else { return }
            if openChat {
                // The user may have dismissed (or reopened) the bar while the ack was in
                // flight; acting then would close the wrong presentation or steal focus.
                guard self.model.activePresentationID == presentationID else { return }
                self.onSendAccepted(true)
                return
            }
            guard self.model.activePresentationID == presentationID else { return }
            self.onSendAccepted(false)
        }
    }

    private var dictationButtonLabel: String {
        self.model.isDictating || self.model.isStartingDictation
            ? String(localized: "Stop dictation")
            : String(localized: "Start dictation")
    }
}
