import Foundation
import SwiftUI

struct ChatTalkTranscriptStripModel: Equatable {
    let recentTranscript: [String]
    let partialTranscript: String

    init(recentTranscript: [String], partialTranscript: String, limit: Int = 20) {
        let finals = recentTranscript
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        self.recentTranscript = Array(finals.suffix(max(0, limit)))
        self.partialTranscript = partialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var hasTranscript: Bool {
        !self.recentTranscript.isEmpty || !self.partialTranscript.isEmpty
    }

    var collapsedText: String? {
        if !self.partialTranscript.isEmpty { return self.partialTranscript }
        return self.recentTranscript.last
    }
}

@MainActor
struct ChatTalkActivityStrip: View {
    let control: OpenClawChatTalkControl

    @State private var isExpanded = false

    var body: some View {
        let model = ChatTalkTranscriptStripModel(
            recentTranscript: self.control.recentTranscript,
            partialTranscript: self.control.partialTranscript)

        if self.control.isEnabled {
            VStack(alignment: .leading, spacing: 6) {
                if model.hasTranscript {
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            self.isExpanded.toggle()
                        }
                    } label: {
                        self.header(model: model, showsDisclosure: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(self.isExpanded
                        ? String(localized: "Hide talk transcript")
                        : String(localized: "Show talk transcript"))
                } else {
                    self.header(model: model, showsDisclosure: false)
                }

                if self.isExpanded, model.hasTranscript {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(model.recentTranscript.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if !model.partialTranscript.isEmpty {
                                Text(model.partialTranscript)
                                    .font(OpenClawChatTypography.caption.italic())
                                    .foregroundStyle(OpenClawChatTheme.accent)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .frame(maxHeight: 104)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(OpenClawChatTheme.subtleCard))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
            .padding(.horizontal, 14)
            .accessibilityIdentifier("chat-talk-activity")
        }
    }

    private func header(model: ChatTalkTranscriptStripModel, showsDisclosure: Bool) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(OpenClawChatTheme.accent)
                .frame(width: 7, height: 7)
            Text(self.control.statusText)
                .font(OpenClawChatTypography.captionSemiBold)
                .lineLimit(1)
            if let collapsedText = model.collapsedText, !self.isExpanded {
                Text(collapsedText)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(model.partialTranscript.isEmpty ? .secondary : OpenClawChatTheme.accent)
                    .italic(!model.partialTranscript.isEmpty)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if showsDisclosure {
                Image(systemName: self.isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

struct ChatTalkButtonGlyph: View {
    let control: OpenClawChatTalkControl

    private static let activePalette = TalkWaveformPalette(
        active: [.white, .white.opacity(0.78), .white.opacity(0.55)],
        inactive: [.white.opacity(0.65)])

    var body: some View {
        if self.control.isEnabled {
            TalkWaveformView(phase: self.waveformPhase, palette: Self.activePalette)
                .frame(width: 23, height: 16)
                .allowsHitTesting(false)
        } else {
            Image(systemName: "waveform")
        }
    }

    private var waveformPhase: TalkWaveformPhase {
        if self.control.isListening {
            return .listening(
                level: self.control.level,
                speechActive: !self.control.partialTranscript.isEmpty)
        }
        if self.control.isSpeaking {
            return .speaking(level: self.control.level)
        }
        return .thinking
    }
}

private struct ChatTalkInputDeviceMenuModifier: ViewModifier {
    let control: OpenClawChatTalkControl

    func body(content: Content) -> some View {
        if self.control.selectInputDevice != nil {
            content.contextMenu {
                Button {
                    self.control.selectInputDevice?(nil)
                } label: {
                    self.menuLabel(
                        String(localized: "System Default"),
                        selected: self.control.selectedInputDeviceID == nil)
                }
                if !self.control.inputDevices.isEmpty {
                    Divider()
                    ForEach(self.control.inputDevices) { device in
                        Button {
                            self.control.selectInputDevice?(device.id)
                        } label: {
                            self.menuLabel(
                                device.name,
                                selected: self.control.selectedInputDeviceID == device.id)
                        }
                    }
                }
            }
        } else {
            content
        }
    }

    @ViewBuilder
    private func menuLabel(_ text: String, selected: Bool) -> some View {
        if selected {
            Label(text, systemImage: "checkmark")
                .font(OpenClawChatTypography.body)
        } else {
            Text(text)
                .font(OpenClawChatTypography.body)
        }
    }
}

extension View {
    func chatTalkInputDeviceMenu(_ control: OpenClawChatTalkControl) -> some View {
        self.modifier(ChatTalkInputDeviceMenuModifier(control: control))
    }
}
