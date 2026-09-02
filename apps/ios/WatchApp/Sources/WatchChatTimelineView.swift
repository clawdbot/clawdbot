import Foundation
import SwiftUI
import WatchKit

private struct WatchChatBubble: View {
    let item: WatchChatItem
    var avatarImageSource: String?
    var avatarText: String?

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if !self.isUser {
                WatchClawAvatar(
                    size: 18,
                    imageSource: self.avatarImageSource,
                    text: self.avatarText)
            } else {
                Spacer(minLength: 20)
            }

            VStack(alignment: self.isUser ? .trailing : .leading, spacing: 3) {
                Text(self.roleTitle)
                    .font(WatchClawType.label(size: 9, weight: .bold))
                    .foregroundStyle(self.isUser ? .secondary : WatchClawStyle.accent)
                Text(self.item.text)
                    .font(WatchClawType.body(size: 13))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .frame(maxWidth: 132, alignment: self.isUser ? .trailing : .leading)
            .background {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(self.isUser ? WatchClawStyle.accent.opacity(0.88) : WatchClawStyle.surface)
            }

            if self.isUser {
                WatchMiniUserDot()
            } else {
                Spacer(minLength: 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var isUser: Bool {
        self.item.role.lowercased() == "user"
    }

    private var roleTitle: String {
        switch self.item.role.lowercased() {
        case "user":
            String(localized: "You")
        case "system":
            String(localized: "System")
        default:
            "OpenClaw"
        }
    }
}

struct WatchChatTimelineView: View {
    @Environment(\.scenePhase) private var scenePhase
    var store: WatchInboxStore
    let items: [WatchChatItem]
    let statusText: String
    let sendStatusText: String?
    var avatarImageSource: String?
    var avatarText: String?
    var onRefresh: (() -> Void)?
    var onSendMessage: ((String) -> String?)?
    @State private var speechPlayback = WatchSpeechPlayback()
    @State private var voiceReplyTimeout: Task<Void, Never>?
    @State private var pendingTranscript = WatchPendingTranscript()
    @State private var isVisible = false

    var body: some View {
        VStack(spacing: 7) {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if self.items.isEmpty {
                        WatchChatEmptyState(statusText: self.statusText)
                    } else {
                        ForEach(self.items) { item in
                            WatchChatBubble(
                                item: item,
                                avatarImageSource: self.avatarImageSource,
                                avatarText: self.avatarText)
                        }
                    }

                    if let pendingText = self.pendingTranscript.text {
                        WatchChatBubble(
                            item: WatchChatItem(id: "pending-transcript", role: "user", text: pendingText),
                            avatarImageSource: self.avatarImageSource,
                            avatarText: self.avatarText)
                    }

                    if let sendStatusText, !sendStatusText.isEmpty {
                        WatchTinyStatus(text: sendStatusText)
                    }

                    if let voiceStatusText = self.voiceStatusText {
                        VStack(alignment: .leading, spacing: 3) {
                            // Watch TTS runs through AVSpeechSynthesizer, which has no
                            // metering API, so speaking uses the wave's synthetic pulse.
                            TalkWaveformView(
                                phase: self.speechPlayback.isSpeaking ? .speaking(level: nil) : .thinking)
                                .frame(height: 24)
                                .accessibilityHidden(true)
                            WatchTinyStatus(text: voiceStatusText)
                        }
                    }

                    if let errorText = self.speechPlayback.errorText {
                        WatchTinyStatus(text: errorText)
                    }

                    WatchSecondaryButton(title: "Refresh") {
                        self.onRefresh?()
                    }
                }
                .padding(.horizontal, 8)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .scrollIndicators(.hidden)

            WatchChatComposer(
                onComposeMessage: {
                    self.presentComposer(.typed)
                },
                onStartVoiceTurn: {
                    self.presentComposer(.dictation)
                },
                isAwaitingVoiceReply: self.store.isAwaitingVoiceReply,
                onCancelVoiceTurn: {
                    self.cancelVoiceTurn()
                },
                isSpeaking: self.speechPlayback.isSpeaking,
                onStopSpeaking: {
                    self.speechPlayback.stop()
                })
                .padding(.horizontal, 7)
                .padding(.bottom, 5)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .navigationTitle("Chat")
        .onChange(of: self.store.chatCompletion) { _, _ in
            self.handleCompletedVoiceTurn()
        }
        .onChange(of: self.items) { _, items in
            self.pendingTranscript.resolve(items: items)
        }
        .onChange(of: self.store.appCommandStatus) { _, status in
            // The send status text already explains a failed or blocked send.
            if status?.command == .sendChat, status?.code == .failed || status?.code == .blocked {
                self.pendingTranscript.clear()
            }
        }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.handleCompletedVoiceTurn()
                self.scheduleVoiceReplyTimeout()
            } else if phase == .background {
                self.voiceReplyTimeout?.cancel()
                self.speechPlayback.stop()
            }
        }
        .onAppear {
            self.isVisible = true
            self.pendingTranscript.resolve(items: self.items)
            self.handleCompletedVoiceTurn()
            self.scheduleVoiceReplyTimeout()
        }
        .onDisappear {
            self.isVisible = false
            self.voiceReplyTimeout?.cancel()
            self.speechPlayback.stop()
        }
    }

    private var voiceStatusText: String? {
        if self.speechPlayback.isSpeaking {
            return String(localized: "Speaking reply…")
        }
        if self.store.isAwaitingVoiceReply {
            return String(localized: "Waiting for spoken reply…")
        }
        return nil
    }

    private func presentComposer(_ kind: WatchComposerInputKind) {
        let chatSession = self.store.appSnapshot?.chatSessionIdentity
        self.speechPlayback.stop()
        if kind == .dictation {
            // Haptics must not play while the system sheet captures audio, so the
            // start cue precedes dictation and the outcome cue follows submission.
            WKInterfaceDevice.current().play(.start)
        }
        WatchNativeTextInput.present(kind) { text in
            guard self.store.appSnapshot?.chatSessionIdentity == chatSession else {
                self.store.markAppCommandBlocked(
                    .sendChat,
                    reason: String(localized: "Chat changed on iPhone. Your message was not sent."))
                WKInterfaceDevice.current().play(.failure)
                return
            }
            guard let commandId = self.onSendMessage?(text) else {
                WKInterfaceDevice.current().play(.failure)
                return
            }
            self.pendingTranscript.begin(text)
            WKInterfaceDevice.current().play(.success)
            if kind.speaksReply {
                self.store.beginVoiceTurn(commandId: commandId)
                self.scheduleVoiceReplyTimeout()
            }
        }
    }

    private func handleCompletedVoiceTurn() {
        guard self.isVisible, self.scenePhase == .active,
              let reply = self.store.takeVoiceReply()
        else { return }
        self.voiceReplyTimeout?.cancel()
        self.speechPlayback.speak(reply)
    }

    private func cancelVoiceTurn() {
        self.voiceReplyTimeout?.cancel()
        self.store.cancelVoiceTurn()
    }

    private func scheduleVoiceReplyTimeout() {
        self.voiceReplyTimeout?.cancel()
        guard let delayNanoseconds = self.store.voiceReplyTimeoutNanoseconds() else { return }
        self.voiceReplyTimeout = Task { @MainActor in
            try? await Task.sleep(nanoseconds: delayNanoseconds)
            guard !Task.isCancelled else { return }
            self.store.cancelVoiceTurn()
        }
    }
}

private struct WatchChatEmptyState: View {
    let statusText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No chat synced")
                .font(WatchClawType.title(size: 16))
                .lineLimit(2)
            Text(self.statusText)
                .font(WatchClawType.body(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(3)
            Text("Tap the message pill below to start from your watch.")
                .font(WatchClawType.body(size: 11, weight: .medium))
                .foregroundStyle(WatchClawStyle.accent)
                .lineLimit(2)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .fill(WatchClawStyle.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .strokeBorder(WatchClawStyle.border, lineWidth: 1)
                }
        }
    }
}

private struct WatchMiniUserDot: View {
    var body: some View {
        Text("You")
            .font(WatchClawType.label(size: 8, weight: .bold))
            .foregroundStyle(.white.opacity(0.86))
            .frame(width: 22, height: 18)
            .background {
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.10))
            }
    }
}

private struct WatchChatComposer: View {
    let onComposeMessage: () -> Void
    let onStartVoiceTurn: () -> Void
    let isAwaitingVoiceReply: Bool
    let onCancelVoiceTurn: () -> Void
    let isSpeaking: Bool
    let onStopSpeaking: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button {
                self.onComposeMessage()
            } label: {
                HStack(spacing: 5) {
                    Text("Message OpenClaw")
                        .font(WatchClawType.body(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "keyboard")
                        .font(WatchClawType.symbol(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 10)
                .background {
                    Capsule(style: .continuous)
                        .fill(Color.white.opacity(0.09))
                        .overlay {
                            Capsule(style: .continuous)
                                .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
                        }
                }
            }
            .buttonStyle(.plain)
            .disabled(self.isAwaitingVoiceReply)
            .accessibilityHint(String(localized: "Opens the keyboard or Scribble."))

            Button {
                if self.isSpeaking {
                    self.onStopSpeaking()
                } else if self.isAwaitingVoiceReply {
                    self.onCancelVoiceTurn()
                } else {
                    self.onStartVoiceTurn()
                }
            } label: {
                Image(systemName: self.voiceButtonSymbol)
                    .font(WatchClawType.symbol(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 20, height: 20)
                    .padding(8)
                    .background {
                        Circle()
                            .fill(WatchClawStyle.hotGradient)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(self.voiceButtonAccessibilityLabel)
            .accessibilityHint(self.voiceButtonAccessibilityHint)
        }
    }

    private var voiceButtonSymbol: String {
        if self.isSpeaking {
            return "speaker.slash.fill"
        }
        if self.isAwaitingVoiceReply {
            return "xmark"
        }
        return "mic.fill"
    }

    private var voiceButtonAccessibilityLabel: String {
        if self.isSpeaking {
            return String(localized: "Stop speaking")
        }
        if self.isAwaitingVoiceReply {
            return String(localized: "Cancel spoken reply")
        }
        return String(localized: "Dictate a message")
    }

    private var voiceButtonAccessibilityHint: String {
        if self.isSpeaking || self.isAwaitingVoiceReply {
            return ""
        }
        return String(localized: "Opens dictation. OpenClaw speaks the reply.")
    }
}
