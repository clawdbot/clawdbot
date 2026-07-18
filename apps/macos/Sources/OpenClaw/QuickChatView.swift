import AppKit
import Observation
import SwiftUI

@MainActor
struct QuickChatView: View {
    @Bindable var model: QuickChatModel
    let onDismiss: () -> Void
    let onSendAccepted: (Bool) -> Void
    let onShowAgentPicker: () -> Void
    let onWindowScreenshot: () -> Void
    let onContentHeightChange: (CGFloat) -> Void
    let onTextViewReady: (NSTextView) -> Void

    @State private var editorHeight: CGFloat = 30

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)

            VStack(spacing: 0) {
                self.inputRow

                if let status = self.statusLine {
                    HStack {
                        Text(status.message)
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
            }
        }
        .frame(width: 620)
        .fixedSize(horizontal: false, vertical: true)
        .animation(.spring(duration: 0.25), value: self.model.shouldShowPermissionStrip)
        .animation(.easeOut(duration: 0.14), value: self.statusLine?.message)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            self.onContentHeightChange(height)
        }
    }

    private var inputRow: some View {
        HStack(spacing: 10) {
            self.agentChip

            ZStack(alignment: .leading) {
                if self.model.text.isEmpty {
                    Text("Message \(self.model.agentDisplay.name)")
                        .font(.system(size: 13.5))
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 2)
                        .allowsHitTesting(false)
                }
                QuickChatTextView(
                    text: self.$model.text,
                    onSubmit: self.submit,
                    onEscape: self.onDismiss,
                    onHeightChange: { self.editorHeight = $0 },
                    onTextViewReady: self.onTextViewReady)
                    .frame(height: self.editorHeight)
            }
            .frame(maxWidth: .infinity)

            if self.model.sendState != .sending {
                Button(action: self.onWindowScreenshot) {
                    Image(systemName: "camera.viewfinder")
                        .font(.system(size: 16.5, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .disabled(!self.model.canCaptureWindow)
                .help("Send a window screenshot")
                .accessibilityLabel("Send a window screenshot")
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
                    Text(self.model.missingPermissions.map(\.permissionDisplayName).joined(separator: ", "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Grant") {
                    self.model.grantMissingPermissions()
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

    private var statusLine: (message: String, isError: Bool)? {
        if case let .failed(message) = self.model.sendState {
            return (message, true)
        }
        if let message = self.model.connectionStatusMessage {
            return (message, false)
        }
        return nil
    }

    private func submit(openChat: Bool) {
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
            // Plain Return lingers briefly on the checkmark before the bar dismisses itself.
            try? await Task.sleep(for: .seconds(0.45))
            guard self.model.activePresentationID == presentationID,
                  self.model.sendState == .sent,
                  self.model.text.isEmpty else { return }
            self.onSendAccepted(false)
        }
    }
}
