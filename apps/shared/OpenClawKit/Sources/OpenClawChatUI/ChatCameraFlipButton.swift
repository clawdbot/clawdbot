import Foundation
import SwiftUI

@MainActor
struct ChatCameraFlipButton: View {
    let control: OpenClawChatTalkControl
    let size: CGFloat

    static func isAvailable(for control: OpenClawChatTalkControl) -> Bool {
        control.isEnabled && control.cameraFacing != nil && control.flipCamera != nil
    }

    var body: some View {
        Button {
            self.control.flipCamera?()
        } label: {
            Image(systemName: "arrow.triangle.2.circlepath.camera")
                .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .subheadline))
                .foregroundStyle(.primary)
                .frame(width: self.size, height: self.size)
                .background {
                    Circle()
                        .fill(OpenClawChatTheme.accent.opacity(0.12))
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.accessibilityLabel)
        .accessibilityIdentifier("chat-camera-flip")
        .help(self.accessibilityLabel)
    }

    private var accessibilityLabel: String {
        switch self.control.cameraFacing {
        case .front:
            String(localized: "Switch to back camera")
        case .back:
            String(localized: "Switch to front camera")
        case nil:
            String(localized: "Flip camera")
        }
    }
}

@MainActor
struct ChatTalkButton: View {
    enum Style {
        case full
        case compact(controlHeight: CGFloat, iconControlSize: CGFloat)
    }

    let control: OpenClawChatTalkControl
    let sessionKey: String
    let helpText: String
    let style: Style

    var body: some View {
        switch self.style {
        case .full:
            self.fullButton
        case let .compact(controlHeight, iconControlSize):
            self.compactButton(controlHeight: controlHeight, iconControlSize: iconControlSize)
        }
    }

    private var fullButton: some View {
        Button {
            self.control.toggle(self.sessionKey)
        } label: {
            HStack(spacing: 6) {
                ChatTalkButtonGlyph(control: self.control)
                    .font(OpenClawChatTypography.captionSemiBold)
                Text(self.control.isEnabled ? "Stop" : "Talk")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .lineLimit(1)
            }
            .foregroundStyle(self.control.isEnabled ? .white : .primary)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background {
                Capsule()
                    .fill(self.fill)
            }
            .overlay {
                Capsule()
                    .strokeBorder(self.stroke, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(!self.control.isGatewayConnected && !self.control.isEnabled)
        .accessibilityLabel(self.control.isEnabled ? "Stop realtime chat" : "Start realtime chat")
        .accessibilityValue(self.accessibilityValue)
        .accessibilityIdentifier("chat-realtime-control")
        .help(self.helpText)
        .chatTalkInputDeviceMenu(self.control)
    }

    private func compactButton(controlHeight: CGFloat, iconControlSize: CGFloat) -> some View {
        Button {
            self.control.toggle(self.sessionKey)
        } label: {
            ChatTalkButtonGlyph(control: self.control)
                .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .subheadline))
                .foregroundStyle(.white)
                .frame(width: iconControlSize, height: iconControlSize)
                // Prominent filled circle so the mic reads as the primary action,
                // mirroring the send button it swaps with once a draft exists.
                .background {
                    Circle()
                        .fill(self.control.isEnabled ? self.fill : AnyShapeStyle(OpenClawChatTheme.accent))
                        .opacity(self.control.isGatewayConnected || self.control.isEnabled ? 1 : 0.4)
                }
                .frame(width: controlHeight, height: controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.control.isGatewayConnected && !self.control.isEnabled)
        .accessibilityLabel(self.control.isEnabled ? "Stop realtime chat" : "Start realtime chat")
        .accessibilityValue(self.accessibilityValue)
        .accessibilityIdentifier("chat-realtime-control")
        .help(self.helpText)
        .chatTalkInputDeviceMenu(self.control)
    }

    private var fill: AnyShapeStyle {
        if self.control.isEnabled {
            return AnyShapeStyle(OpenClawChatTheme.userBubble)
        }
        if !self.control.isGatewayConnected {
            return AnyShapeStyle(Color.secondary.opacity(0.12))
        }
        return OpenClawChatTheme.subtleCard
    }

    private var stroke: Color {
        if self.control.isEnabled {
            return Color.white.opacity(0.18)
        }
        return OpenClawChatTheme.composerBorder
    }

    private var accessibilityValue: String {
        let status = self.control.statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = self.control.providerLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        return [status, provider].filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

extension OpenClawChatComposer {
    /// Local capture and realtime Talk share one microphone, so the Talk affordance
    /// must yield until dictation or voice-note capture releases audio ownership.
    nonisolated static func showsCompactTalkControl(
        hasDraftToSend: Bool,
        hasBlockingRunActivity: Bool,
        isLocalVoiceCaptureActive: Bool) -> Bool
    {
        !hasDraftToSend && !hasBlockingRunActivity && !isLocalVoiceCaptureActive
    }
}

@MainActor
enum ChatDictationActions {
    static func start(
        _ control: OpenClawChatDictationControl,
        task: Binding<Task<Void, Never>?>,
        viewModel: OpenClawChatViewModel)
    {
        guard task.wrappedValue == nil else { return }
        let session = viewModel.currentSessionSnapshot()
        task.wrappedValue = Task { @MainActor in
            defer { task.wrappedValue = nil }
            do {
                guard let transcript = try await control.start(), !transcript.isEmpty else { return }
                try Task.checkCancellation()
                viewModel.appendDictationTranscript(transcript, for: session)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                viewModel.setDictationError(error, for: session)
            }
        }
    }

    static func cancel(
        task: Binding<Task<Void, Never>?>,
        control: OpenClawChatDictationControl?)
    {
        guard task.wrappedValue != nil else { return }
        task.wrappedValue?.cancel()
        control?.cancel()
    }
}

struct ChatConnectionPill: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.isConnected ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.isConnected ? "Gateway connected" : "Connecting...")
                .font(OpenClawChatTypography.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background {
            Capsule()
                .fill(OpenClawChatTheme.subtleCard)
        }
    }
}
