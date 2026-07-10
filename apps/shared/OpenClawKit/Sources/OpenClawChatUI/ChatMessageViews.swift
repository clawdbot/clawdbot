import Foundation
import OpenClawKit
import SwiftUI

private enum ChatUIConstants {
    static let bubbleMaxWidth: CGFloat = 560
    static let bubbleCorner: CGFloat = 18
}

struct ChatAgentAvatar: View {
    let text: String?
    let name: String?
    let tint: Color?
    var size: CGFloat = 30

    var body: some View {
        Text(self.displayText)
            .font(OpenClawChatTypography.avatar(size: self.fontSize))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .frame(width: self.size, height: self.size)
            .background(
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                (self.tint ?? OpenClawChatTheme.accent).opacity(0.95),
                                Color(red: 38 / 255.0, green: 40 / 255.0, blue: 43 / 255.0),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing)))
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
            .shadow(color: (self.tint ?? OpenClawChatTheme.accent).opacity(0.18), radius: 8, y: 4)
            .accessibilityLabel(self.name.map { "\($0) avatar" } ?? "Agent avatar")
    }

    private var displayText: String {
        if let text = self.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return String(text.prefix(3))
        }
        if let name = self.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let words = name.split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" }).prefix(2)
            let initials = words.compactMap(\.first).map(String.init).joined()
            if !initials.isEmpty {
                return initials.uppercased()
            }
        }
        return "OC"
    }

    private var fontSize: CGFloat {
        self.displayText.count > 2 ? self.size * 0.34 : self.size * 0.42
    }
}

private struct ChatBubbleShape: InsettableShape {
    enum Tail {
        case left
        case right
        case none
    }

    let cornerRadius: CGFloat
    let tail: Tail
    var insetAmount: CGFloat = 0

    private let tailWidth: CGFloat = 7
    private let tailBaseHeight: CGFloat = 9

    func inset(by amount: CGFloat) -> ChatBubbleShape {
        var copy = self
        copy.insetAmount += amount
        return copy
    }

    func path(in rect: CGRect) -> Path {
        let rect = rect.insetBy(dx: self.insetAmount, dy: self.insetAmount)
        switch self.tail {
        case .left:
            return self.leftTailPath(in: rect, radius: self.cornerRadius)
        case .right:
            return self.rightTailPath(in: rect, radius: self.cornerRadius)
        case .none:
            return Path(roundedRect: rect, cornerRadius: self.cornerRadius)
        }
    }

    private func rightTailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        var path = Path()
        let bubbleMinX = rect.minX
        let bubbleMaxX = rect.maxX - self.tailWidth
        let bubbleMinY = rect.minY
        let bubbleMaxY = rect.maxY

        let available = max(4, bubbleMaxY - bubbleMinY - 2 * r)
        let baseH = min(tailBaseHeight, available)
        let baseBottomY = bubbleMaxY - max(r * 0.45, 6)
        let baseTopY = baseBottomY - baseH
        let midY = (baseTopY + baseBottomY) / 2

        let baseTop = CGPoint(x: bubbleMaxX, y: baseTopY)
        let baseBottom = CGPoint(x: bubbleMaxX, y: baseBottomY)
        let tip = CGPoint(x: bubbleMaxX + self.tailWidth, y: midY)

        path.move(to: CGPoint(x: bubbleMinX + r, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX - r, y: bubbleMinY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX, y: bubbleMinY + r),
            control: CGPoint(x: bubbleMaxX, y: bubbleMinY))
        path.addLine(to: baseTop)
        path.addCurve(
            to: tip,
            control1: CGPoint(x: bubbleMaxX + self.tailWidth * 0.2, y: baseTopY + baseH * 0.05),
            control2: CGPoint(x: bubbleMaxX + self.tailWidth * 0.95, y: midY - baseH * 0.15))
        path.addCurve(
            to: baseBottom,
            control1: CGPoint(x: bubbleMaxX + self.tailWidth * 0.95, y: midY + baseH * 0.15),
            control2: CGPoint(x: bubbleMaxX + self.tailWidth * 0.2, y: baseBottomY - baseH * 0.05))
        self.addBottomEdge(
            path: &path,
            bubbleMinX: bubbleMinX,
            bubbleMaxX: bubbleMaxX,
            bubbleMaxY: bubbleMaxY,
            radius: r)
        path.addLine(to: CGPoint(x: bubbleMinX, y: bubbleMinY + r))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX + r, y: bubbleMinY),
            control: CGPoint(x: bubbleMinX, y: bubbleMinY))

        return path
    }

    private func leftTailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        var path = Path()
        let bubbleMinX = rect.minX + self.tailWidth
        let bubbleMaxX = rect.maxX
        let bubbleMinY = rect.minY
        let bubbleMaxY = rect.maxY

        let available = max(4, bubbleMaxY - bubbleMinY - 2 * r)
        let baseH = min(tailBaseHeight, available)
        let baseBottomY = bubbleMaxY - max(r * 0.45, 6)
        let baseTopY = baseBottomY - baseH
        let midY = (baseTopY + baseBottomY) / 2

        let baseTop = CGPoint(x: bubbleMinX, y: baseTopY)
        let baseBottom = CGPoint(x: bubbleMinX, y: baseBottomY)
        let tip = CGPoint(x: bubbleMinX - self.tailWidth, y: midY)

        path.move(to: CGPoint(x: bubbleMinX + r, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX - r, y: bubbleMinY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX, y: bubbleMinY + r),
            control: CGPoint(x: bubbleMaxX, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX, y: bubbleMaxY - r))
        self.addBottomEdge(
            path: &path,
            bubbleMinX: bubbleMinX,
            bubbleMaxX: bubbleMaxX,
            bubbleMaxY: bubbleMaxY,
            radius: r)
        path.addLine(to: baseBottom)
        path.addCurve(
            to: tip,
            control1: CGPoint(x: bubbleMinX - self.tailWidth * 0.2, y: baseBottomY - baseH * 0.05),
            control2: CGPoint(x: bubbleMinX - self.tailWidth * 0.95, y: midY + baseH * 0.15))
        path.addCurve(
            to: baseTop,
            control1: CGPoint(x: bubbleMinX - self.tailWidth * 0.95, y: midY - baseH * 0.15),
            control2: CGPoint(x: bubbleMinX - self.tailWidth * 0.2, y: baseTopY + baseH * 0.05))
        path.addLine(to: CGPoint(x: bubbleMinX, y: bubbleMinY + r))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX + r, y: bubbleMinY),
            control: CGPoint(x: bubbleMinX, y: bubbleMinY))

        return path
    }

    private func addBottomEdge(
        path: inout Path,
        bubbleMinX: CGFloat,
        bubbleMaxX: CGFloat,
        bubbleMaxY: CGFloat,
        radius: CGFloat)
    {
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX - radius, y: bubbleMaxY),
            control: CGPoint(x: bubbleMaxX, y: bubbleMaxY))
        path.addLine(to: CGPoint(x: bubbleMinX + radius, y: bubbleMaxY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX, y: bubbleMaxY - radius),
            control: CGPoint(x: bubbleMinX, y: bubbleMaxY))
    }
}

@MainActor
struct ChatMessageBubble: View {
    let message: OpenClawChatMessage
    let style: OpenClawChatView.Style
    let markdownVariant: ChatMarkdownVariant
    let userAccent: Color?
    let showsAssistantTrace: Bool
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let showsAssistantAvatar: Bool
    let isClean: Bool
    let contextWindowTokens: Int?

    var body: some View {
        if self.isUser {
            self.messageBody
                .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, 2)
        } else {
            HStack(alignment: .top, spacing: 8) {
                if self.showsAssistantAvatar {
                    ChatAgentAvatar(
                        text: self.assistantAvatarText,
                        name: self.assistantName,
                        tint: self.assistantAvatarTint)
                        .padding(.top, 1)
                }

                self.messageBody
                    .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
        }
    }

    private var isUser: Bool {
        self.message.role.lowercased() == "user"
    }

    private var messageBody: some View {
        ChatMessageBody(
            message: self.message,
            isUser: self.isUser,
            style: self.style,
            markdownVariant: self.markdownVariant,
            userAccent: self.userAccent,
            showsAssistantTrace: self.showsAssistantTrace,
            isClean: self.isClean,
            contextWindowTokens: self.contextWindowTokens)
    }
}

@MainActor
private struct ChatMessageBody: View {
    @Environment(\.openClawAssistantBubblesInCleanChrome) private var assistantBubblesInClean
    let message: OpenClawChatMessage
    let isUser: Bool
    let style: OpenClawChatView.Style
    let markdownVariant: ChatMarkdownVariant
    let userAccent: Color?
    let showsAssistantTrace: Bool
    let isClean: Bool
    let contextWindowTokens: Int?

    var body: some View {
        let text = self.primaryText
        let textColor = self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText

        if self.usesBubble {
            self.messageContent(text: text, textColor: textColor)
                .padding(.vertical, 10)
                .padding(.horizontal, 12)
                .background(self.bubbleBackground)
                .clipShape(self.bubbleShape)
                .overlay(self.bubbleBorder)
                .shadow(
                    color: self.bubbleShadowColor,
                    radius: self.bubbleShadowRadius,
                    y: self.bubbleShadowYOffset)
                .padding(.leading, self.tailPaddingLeading)
                .padding(.trailing, self.tailPaddingTrailing)
        } else {
            self.messageContent(text: text, textColor: textColor)
                .padding(.vertical, 5)
                .padding(.horizontal, 4)
        }
    }

    private func messageContent(text: String, textColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.isToolResultMessage, self.showsAssistantTrace {
                if !text.isEmpty {
                    ToolResultCard(
                        title: self.toolResultTitle,
                        text: text,
                        isUser: self.isUser,
                        toolName: self.message.toolName)
                }
            } else if self.isUser {
                ChatMarkdownRenderer(
                    text: text,
                    context: .user,
                    variant: self.markdownVariant,
                    font: OpenClawChatTypography.body,
                    textColor: textColor)
            } else {
                ChatAssistantTextBody(
                    text: text,
                    markdownVariant: self.markdownVariant,
                    includesThinking: self.showsAssistantTrace)
            }

            if self.showsLinkPreview, let previewURL = chatFirstPreviewURL(in: text) {
                ChatLinkPreview(url: previewURL)
            }

            if !self.inlineAttachments.isEmpty {
                ForEach(self.inlineAttachments.indices, id: \.self) { idx in
                    AttachmentRow(att: self.inlineAttachments[idx], isUser: self.isUser)
                }
            }

            if self.showsAssistantTrace, !self.toolCalls.isEmpty {
                ForEach(self.toolCalls.indices, id: \.self) { idx in
                    ToolCallCard(
                        content: self.toolCalls[idx],
                        isUser: self.isUser)
                }
            }

            if self.showsAssistantTrace, !self.inlineToolResults.isEmpty {
                ForEach(self.inlineToolResults.indices, id: \.self) { idx in
                    let toolResult = self.inlineToolResults[idx]
                    let display = ToolDisplayRegistry.resolve(name: toolResult.name ?? "tool", args: nil)
                    ToolResultCard(
                        title: "\(display.emoji) \(display.title)",
                        text: toolResult.text ?? "",
                        isUser: self.isUser,
                        toolName: toolResult.name)
                }
            }

            if let usagePresentation = self.usagePresentation {
                Text(usagePresentation.text)
                    .font(OpenClawChatTypography.caption2)
                    .monospacedDigit()
                    .foregroundStyle(self.usageTint(usagePresentation.pressure))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(String(localized: "Message usage"))
                    .accessibilityValue(usagePresentation.accessibilityValue)
            }
        }
        .textSelection(.enabled)
        .foregroundStyle(textColor)
    }

    private var usesBubble: Bool {
        // Keep the guarded base condition; iOS additionally opts assistant
        // messages into bubbles via the clean-chrome environment flag.
        self.isUser || self.style == .onboarding || !self.isClean || self.assistantBubblesInClean
    }

    private var showsLinkPreview: Bool {
        let role = self.message.role.lowercased()
        return role == "user" || role == "assistant"
    }

    private var primaryText: String {
        let parts = self.message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty else { return nil }
            return content.text
        }
        return OpenClawChatMessage.displayText(
            contentText: parts.joined(separator: "\n"),
            role: self.message.role,
            stopReason: self.message.stopReason,
            errorMessage: self.message.errorMessage)
    }

    private var inlineAttachments: [OpenClawChatMessageContent] {
        self.message.content.filter { content in
            switch content.type ?? "text" {
            case "file", "attachment":
                true
            default:
                false
            }
        }
    }

    private var toolCalls: [OpenClawChatMessageContent] {
        self.message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            if ["toolcall", "tool_call", "tooluse", "tool_use"].contains(kind) {
                return true
            }
            return content.name != nil && content.arguments != nil
        }
    }

    private var inlineToolResults: [OpenClawChatMessageContent] {
        self.message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            return kind == "toolresult" || kind == "tool_result"
        }
    }

    private var isToolResultMessage: Bool {
        let role = self.message.role.lowercased()
        return role == "toolresult" || role == "tool_result"
    }

    private var usagePresentation: ChatMessageUsagePresentation? {
        ChatMessageUsagePresentation.make(
            message: self.message,
            contextWindowTokens: self.contextWindowTokens)
    }

    private func usageTint(_ pressure: ChatMessageUsagePresentation.Pressure) -> Color {
        switch pressure {
        case .normal:
            OpenClawChatTheme.muted
        case .warning:
            OpenClawChatTheme.warning
        case .danger:
            OpenClawChatTheme.danger
        }
    }

    private var toolResultTitle: String {
        if let name = self.message.toolName, !name.isEmpty {
            let display = ToolDisplayRegistry.resolve(name: name, args: nil)
            return "\(display.emoji) \(display.title)"
        }
        let display = ToolDisplayRegistry.resolve(name: "tool", args: nil)
        return "\(display.emoji) \(display.title)"
    }

    private var bubbleFillColor: Color {
        if self.isUser {
            return self.userAccent ?? OpenClawChatTheme.userBubble
        }
        if self.style == .onboarding {
            return OpenClawChatTheme.onboardingAssistantBubble
        }
        return OpenClawChatTheme.assistantBubble
    }

    private var bubbleBackground: AnyShapeStyle {
        AnyShapeStyle(self.bubbleFillColor)
    }

    private var bubbleBorderColor: Color {
        if self.isUser {
            return Color.white.opacity(0.12)
        }
        if self.style == .onboarding {
            return OpenClawChatTheme.onboardingAssistantBorder
        }
        return Color.white.opacity(0.08)
    }

    private var bubbleBorderWidth: CGFloat {
        if self.isUser { return 0.5 }
        if self.style == .onboarding { return 0.8 }
        return 1
    }

    private var bubbleBorder: some View {
        self.bubbleShape.strokeBorder(self.bubbleBorderColor, lineWidth: self.bubbleBorderWidth)
    }

    private var bubbleShape: ChatBubbleShape {
        ChatBubbleShape(cornerRadius: ChatUIConstants.bubbleCorner, tail: self.bubbleTail)
    }

    private var bubbleTail: ChatBubbleShape.Tail {
        guard self.style == .onboarding else { return .none }
        return self.isUser ? .right : .left
    }

    private var tailPaddingLeading: CGFloat {
        self.style == .onboarding && !self.isUser ? 8 : 0
    }

    private var tailPaddingTrailing: CGFloat {
        self.style == .onboarding && self.isUser ? 8 : 0
    }

    private var bubbleShadowColor: Color {
        self.style == .onboarding && !self.isUser ? Color.black.opacity(0.28) : .clear
    }

    private var bubbleShadowRadius: CGFloat {
        self.style == .onboarding && !self.isUser ? 6 : 0
    }

    private var bubbleShadowYOffset: CGFloat {
        self.style == .onboarding && !self.isUser ? 2 : 0
    }
}

private struct AttachmentRow: View {
    let att: OpenClawChatMessageContent
    let isUser: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: self.isAudio ? "waveform" : "paperclip")
            Text(self.isAudio ? "Voice note" : (self.att.fileName ?? "Attachment"))
                .font(OpenClawChatTypography.footnote)
                .lineLimit(1)
                .foregroundStyle(self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText)
            if self.isAudio, let durationSeconds = self.att.durationSeconds {
                Text(openClawVoiceNoteDurationLabel(durationSeconds))
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(
                        self.isUser
                            ? OpenClawChatTheme.userText.opacity(0.72)
                            : OpenClawChatTheme.assistantText.opacity(0.72))
            }
            Spacer()
        }
        .padding(10)
        .background(self.isUser ? Color.white.opacity(0.2) : Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var isAudio: Bool {
        self.att.mimeType?.hasPrefix("audio/") == true
    }
}

private struct ToolCallCard: View {
    let content: OpenClawChatMessageContent
    let isUser: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(self.toolName)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                Spacer(minLength: 0)
            }

            if let summary = self.summary, !summary.isEmpty {
                Text(summary)
                    .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var toolName: String {
        "\(self.display.emoji) \(self.display.title)"
    }

    private var summary: String? {
        self.display.detailLine
    }

    private var display: ToolDisplaySummary {
        ToolDisplayRegistry.resolve(name: self.content.name ?? "tool", args: self.content.arguments)
    }
}

private struct ToolResultCard: View {
    let title: String
    let text: String
    let isUser: Bool
    let toolName: String?
    @State private var expanded = false

    var body: some View {
        if !self.displayContent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(self.title)
                        .font(OpenClawChatTypography.footnoteSemiBold)
                    Spacer(minLength: 0)
                }

                Text(self.displayText)
                    .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                    .foregroundStyle(self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText)
                    .lineLimit(self.expanded ? nil : Self.previewLineLimit)

                if self.shouldShowToggle {
                    Button(self.expanded ? "Show less" : "Show full output") {
                        self.expanded.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(OpenClawChatTheme.subtleCard)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
        }
    }

    private static let previewLineLimit = 8

    private var displayContent: String {
        ToolResultTextFormatter.format(text: self.text, toolName: self.toolName)
    }

    private var lines: [Substring] {
        self.displayContent.components(separatedBy: .newlines).map { Substring($0) }
    }

    private var displayText: String {
        guard !self.expanded, self.lines.count > Self.previewLineLimit else { return self.displayContent }
        return self.lines.prefix(Self.previewLineLimit).joined(separator: "\n") + "\n…"
    }

    private var shouldShowToggle: Bool {
        self.lines.count > Self.previewLineLimit
    }
}

@MainActor
struct ChatTypingIndicatorBubble: View {
    let style: OpenClawChatView.Style
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let showsAssistantAvatar: Bool
    let isClean: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if self.showsAssistantAvatar {
                ChatAgentAvatar(
                    text: self.assistantAvatarText,
                    name: self.assistantName,
                    tint: self.assistantAvatarTint,
                    size: 28)
            }

            HStack(spacing: 9) {
                TypingDots()
                Text("Writing")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, self.isClean ? 5 : (self.style == .standard ? 10 : 9))
            .padding(.horizontal, self.isClean ? 4 : (self.style == .standard ? 12 : 14))
            .assistantBubbleContainerStyle(isClean: self.isClean, cornerRadius: 15)
            .fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .focusable(false)
    }
}

/// Inline playback state under an assistant bubble while Listen is active;
/// tapping it stops speech.
struct ChatSpeechStatusChip: View {
    let isPreparing: Bool
    let onStop: () -> Void

    var body: some View {
        Button(action: self.onStop) {
            HStack(spacing: 4) {
                Image(systemName: self.isPreparing ? "hourglass" : "speaker.wave.2.fill")
                    .font(.system(size: 10, weight: .semibold))
                if self.isPreparing {
                    Text("Preparing audio…")
                        .font(OpenClawChatTypography.caption)
                } else {
                    Text("Speaking…")
                        .font(OpenClawChatTypography.caption)
                }
            }
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.isPreparing
            ? "Preparing audio, tap to cancel"
            : "Speaking, tap to stop")
    }
}

/// Status footer for a user bubble backed by the durable offline outbox.
@MainActor
struct ChatOutboxStatusLabel: View {
    let state: OpenClawChatOutboxMessageState

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: self.iconName)
                .font(.system(size: 10, weight: .semibold))
            Text(self.title)
                .font(OpenClawChatTypography.caption)
        }
        .foregroundStyle(self.state.isFailed ? AnyShapeStyle(OpenClawChatTheme.danger) : AnyShapeStyle(.secondary))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(self.accessibilityText)
    }

    private var title: String {
        switch self.state {
        case .queued:
            "Queued"
        case .sending:
            "Sending…"
        case .confirming:
            "Confirming…"
        case let .failed(reason) where reason == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError:
            "Delivery unknown"
        case .failed:
            "Not sent"
        }
    }

    private var iconName: String {
        switch self.state {
        case .queued:
            "clock"
        case .sending:
            "arrow.up.circle"
        case .confirming:
            "checkmark.circle"
        case let .failed(reason) where reason == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError:
            "questionmark.circle"
        case .failed:
            "exclamationmark.circle"
        }
    }

    private var accessibilityText: String {
        switch self.state {
        case .queued:
            "Queued, sends when reconnected"
        case .sending:
            "Sending"
        case .confirming:
            "Sent, waiting for chat history confirmation"
        case let .failed(reason) where reason == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError:
            "Delivery unconfirmed, touch and hold to retry or delete"
        case .failed:
            "Not sent, touch and hold to retry or delete"
        }
    }
}

extension ChatTypingIndicatorBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.style == rhs.style &&
            lhs.assistantName == rhs.assistantName &&
            lhs.assistantAvatarText == rhs.assistantAvatarText &&
            lhs.showsAssistantAvatar == rhs.showsAssistantAvatar &&
            lhs.isClean == rhs.isClean
    }
}

extension EnvironmentValues {
    /// Clients that want iMessage-style assistant bubbles in the clean chrome
    /// (the iOS app) opt in; the default keeps the plain clean look elsewhere.
    @Entry public var openClawAssistantBubblesInCleanChrome: Bool = false
}

private struct AssistantBubbleContainerStyle: ViewModifier {
    let isClean: Bool
    let cornerRadius: CGFloat

    @Environment(\.openClawAssistantBubblesInCleanChrome) private var bubblesInClean

    func body(content: Content) -> some View {
        if self.isClean, !self.bubblesInClean {
            content
        } else {
            content
                // Clean call sites pre-pad only ~4pt; bubbles need room to breathe.
                    .padding(self.isClean ? 8 : 0)
                    .background(
                        RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                            .fill(OpenClawChatTheme.assistantBubble))
                    .overlay(
                        RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
        }
    }
}

extension View {
    fileprivate func assistantBubbleContainerStyle(isClean: Bool, cornerRadius: CGFloat = 16) -> some View {
        self.modifier(AssistantBubbleContainerStyle(isClean: isClean, cornerRadius: cornerRadius))
            .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
            .focusable(false)
    }
}

@MainActor
struct ChatStreamingAssistantBubble: View {
    let text: String
    let markdownVariant: ChatMarkdownVariant
    let showsAssistantTrace: Bool
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let showsAssistantAvatar: Bool
    let isClean: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if self.showsAssistantAvatar {
                ChatAgentAvatar(
                    text: self.assistantAvatarText,
                    name: self.assistantName,
                    tint: self.assistantAvatarTint)
                    .padding(.top, 1)
            }

            VStack(alignment: .leading, spacing: 10) {
                ChatAssistantTextBody(
                    text: self.text,
                    markdownVariant: self.markdownVariant,
                    includesThinking: self.showsAssistantTrace,
                    isComplete: false)
            }
            .padding(self.isClean ? 4 : 12)
            .assistantBubbleContainerStyle(isClean: self.isClean)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@MainActor
struct ChatPendingToolsBubble: View {
    let toolCalls: [OpenClawChatPendingToolCall]
    let isClean: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Running tools…", systemImage: "hammer")
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)

            ForEach(self.toolCalls) { call in
                let display = ToolDisplayRegistry.resolve(name: call.name, args: call.args)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(display.emoji) \(display.label)")
                            .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        ProgressView().controlSize(.mini)
                    }
                    if let detail = display.detailLine, !detail.isEmpty {
                        Text(detail)
                            .font(OpenClawChatTypography.mono(size: 12, relativeTo: .caption))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(10)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(self.isClean ? 4 : 12)
        .assistantBubbleContainerStyle(isClean: self.isClean)
    }
}

extension ChatPendingToolsBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.toolCalls == rhs.toolCalls && lhs.isClean == rhs.isClean
    }
}

@MainActor
private struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var animate = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { idx in
                Circle()
                    .fill(Color.secondary.opacity(0.55))
                    .frame(width: 7, height: 7)
                    .scaleEffect(self.reduceMotion ? 0.85 : (self.animate ? 1.05 : 0.70))
                    .opacity(self.reduceMotion ? 0.55 : (self.animate ? 0.95 : 0.30))
                    .animation(
                        self.reduceMotion ? nil : .easeInOut(duration: 0.55)
                            .repeatForever(autoreverses: true)
                            .delay(Double(idx) * 0.16),
                        value: self.animate)
            }
        }
        .onAppear { self.updateAnimationState() }
        .onDisappear { self.animate = false }
        .onChange(of: self.scenePhase) { _, _ in
            self.updateAnimationState()
        }
        .onChange(of: self.reduceMotion) { _, _ in
            self.updateAnimationState()
        }
    }

    private func updateAnimationState() {
        guard !self.reduceMotion, self.scenePhase == .active else {
            self.animate = false
            return
        }
        self.animate = true
    }
}

private struct ChatAssistantTextBody: View {
    let text: String
    let markdownVariant: ChatMarkdownVariant
    let includesThinking: Bool
    var isComplete: Bool = true

    var body: some View {
        if self.isComplete {
            self.completeBody
        } else {
            ChatStreamingAssistantTextBody(
                text: self.text,
                markdownVariant: self.markdownVariant,
                includesThinking: self.includesThinking)
        }
    }

    private var completeBody: some View {
        let segments = AssistantTextParser.segments(from: self.text, includeThinking: self.includesThinking)
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                let font = segment.kind == .thinking
                    ? OpenClawChatTypography.callout.italic()
                    : OpenClawChatTypography.body
                let inlineMathTypography: ChatMarkdownRenderer.InlineMathTypography = segment.kind == .thinking
                    ? .callout
                    : .body
                ChatMarkdownRenderer(
                    text: segment.text,
                    context: .assistant,
                    variant: self.markdownVariant,
                    font: font,
                    textColor: OpenClawChatTheme.assistantText,
                    inlineMathTypography: inlineMathTypography,
                    isComplete: self.isComplete)
            }
        }
    }
}

@MainActor
private struct ChatStreamingAssistantTextBody: View {
    let text: String
    let markdownVariant: ChatMarkdownVariant
    let includesThinking: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var snapshot: Snapshot
    @State private var revealState: ChatStreamingRevealState
    @State private var revealLocation: Snapshot.ProseLocation?
    @State private var pendingUntil: TimeInterval?

    init(text: String, markdownVariant: ChatMarkdownVariant, includesThinking: Bool) {
        self.text = text
        self.markdownVariant = markdownVariant
        self.includesThinking = includesThinking

        let now = Date.timeIntervalSinceReferenceDate
        let snapshot = Snapshot(text: text, includesThinking: includesThinking)
        let location = snapshot.lastProseLocation
        let revealState = location.map {
            step(state: ChatStreamingRevealState(), newText: snapshot.prose(at: $0).plainText, now: now)
        } ?? ChatStreamingRevealState()
        self._snapshot = State(initialValue: snapshot)
        self._revealState = State(initialValue: revealState)
        self._revealLocation = State(initialValue: location)
        self._pendingUntil = State(initialValue: revealState.latestDeadline)
    }

    var body: some View {
        Group {
            if self.reduceMotion || self.pendingUntil == nil {
                self.render(now: nil)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
                    self.render(now: timeline.date.timeIntervalSinceReferenceDate)
                }
            }
        }
        .onChange(of: self.text) { _, _ in
            self.updateSnapshot()
        }
        .onChange(of: self.includesThinking) { _, _ in
            self.updateSnapshot()
        }
        .onChange(of: self.reduceMotion) { _, reduceMotion in
            self.pendingUntil = reduceMotion ? nil : self.futureDeadline()
        }
        .onAppear {
            if self.snapshot.sourceText != self.text || self.snapshot.includesThinking != self.includesThinking {
                self.updateSnapshot()
            }
        }
        .task(id: self.pendingUntil) {
            guard let pendingUntil = self.pendingUntil else { return }
            let delay = max(0, pendingUntil - Date.timeIntervalSinceReferenceDate)
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            guard !Task.isCancelled, self.pendingUntil == pendingUntil else { return }
            self.pendingUntil = nil
        }
    }

    private func render(now: TimeInterval?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(self.snapshot.segments.enumerated()), id: \.offset) { entry in
                let segment = entry.element
                let font = segment.kind == .thinking
                    ? OpenClawChatTypography.callout.italic()
                    : OpenClawChatTypography.body
                let inlineMathTypography: ChatMarkdownRenderer.InlineMathTypography = segment.kind == .thinking
                    ? .callout
                    : .body
                let reveal = self.reveal(
                    segmentIndex: entry.offset,
                    now: now)
                ChatMarkdownRenderer(
                    snapshot: segment.markdown,
                    context: .assistant,
                    variant: self.markdownVariant,
                    font: font,
                    textColor: OpenClawChatTheme.assistantText,
                    inlineMathTypography: inlineMathTypography,
                    reveal: reveal)
            }
        }
    }

    private func reveal(segmentIndex: Int, now: TimeInterval?) -> ChatMarkdownProseReveal? {
        guard let now,
              let location = self.revealLocation,
              location.segmentIndex == segmentIndex
        else { return nil }
        return ChatMarkdownProseReveal(
            blockIndex: location.blockIndex,
            state: self.revealState,
            now: now)
    }

    private func updateSnapshot() {
        let now = Date.timeIntervalSinceReferenceDate
        let nextSnapshot = Snapshot(text: self.text, includesThinking: self.includesThinking)
        let nextLocation = nextSnapshot.lastProseLocation
        let nextRevealState: ChatStreamingRevealState
        if let nextLocation {
            let nextText = nextSnapshot.prose(at: nextLocation).plainText
            if nextLocation == self.revealLocation {
                nextRevealState = step(state: self.revealState, newText: nextText, now: now)
            } else {
                nextRevealState = step(state: ChatStreamingRevealState(), newText: nextText, now: now)
            }
        } else {
            nextRevealState = ChatStreamingRevealState()
        }

        self.snapshot = nextSnapshot
        self.revealLocation = nextLocation
        self.revealState = nextRevealState
        self.pendingUntil = self.reduceMotion ? nil : self.futureDeadline(now: now, state: nextRevealState)
    }

    private func futureDeadline(
        now: TimeInterval = Date.timeIntervalSinceReferenceDate,
        state: ChatStreamingRevealState? = nil) -> TimeInterval?
    {
        guard let deadline = (state ?? self.revealState).latestDeadline, deadline > now else {
            return nil
        }
        return deadline
    }

    @MainActor
    private struct Snapshot {
        struct Segment {
            let kind: AssistantTextSegment.Kind
            let markdown: ChatMarkdownRenderSnapshot
        }

        struct ProseLocation: Equatable {
            let segmentIndex: Int
            let blockIndex: Int
        }

        let segments: [Segment]
        let lastProseLocation: ProseLocation?
        let sourceText: String
        let includesThinking: Bool

        init(text: String, includesThinking: Bool) {
            let segments = AssistantTextParser.segments(
                from: text,
                includeThinking: includesThinking).map {
                Segment(
                    kind: $0.kind,
                    markdown: ChatMarkdownRenderSnapshot(
                        text: $0.text,
                        isComplete: false,
                        preparesReveal: true))
            }
            self.segments = segments
            self.sourceText = text
            self.includesThinking = includesThinking
            self.lastProseLocation = segments.indices.reversed().compactMap { segmentIndex in
                segments[segmentIndex].markdown.lastProseIndex.map {
                    ProseLocation(segmentIndex: segmentIndex, blockIndex: $0)
                }
            }.first
        }

        func prose(at location: ProseLocation) -> ChatMarkdownProse {
            guard case let .prose(prose) = self.segments[location.segmentIndex]
                .markdown.blocks[location.blockIndex]
            else {
                preconditionFailure("Streaming reveal location must identify prose")
            }
            return prose
        }
    }
}
