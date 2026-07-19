import Foundation
import Observation
import OpenClawKit
import SwiftUI

enum SystemAgentDraft: String, Decodable {
    case hatch

    var composerValue: String {
        switch self {
        case .hatch: String(localized: "Wake up, my friend!")
        }
    }
}

@MainActor
@Observable
final class OnboardingSystemAgentChatState {
    var chat = SystemAgentOnboardingChatModel()
    var isPresented = false
    @ObservationIgnored private var startTask: Task<Void, Never>?

    @discardableResult
    func presentAndStart() -> Task<Void, Never> {
        self.isPresented = true
        if let startTask {
            return startTask
        }
        let chat = self.chat
        let task = Task { await chat.startIfNeeded() }
        self.startTask = task
        return task
    }

    func waitForStartIfNeeded() async {
        let task = self.startTask
        await task?.value
    }

    func resetForGatewayChange() {
        self.isPresented = false
        self.startTask?.cancel()
        self.startTask = nil
        self.chat.invalidate()
        self.chat = SystemAgentOnboardingChatModel()
    }
}

/// Onboarding talks to OpenClaw over the gateway `openclaw.chat` RPC.
/// The conversation is available after structured setup establishes working
/// inference, so the model-backed helper can answer reliably.
@MainActor
@Observable
final class SystemAgentOnboardingChatModel {
    struct Message: Identifiable, Equatable {
        enum Role {
            case assistant
            case user
        }

        let id = UUID()
        let role: Role
        let text: String
        let question: SystemAgentChatQuestion?

        init(role: Role, text: String, question: SystemAgentChatQuestion? = nil) {
            self.role = role
            self.text = text
            self.question = question
        }
    }

    private(set) var messages: [Message] = []
    private(set) var isSending = false
    private(set) var errorMessage: String?
    private(set) var expectsSensitiveReply = false
    private(set) var dismissedQuestionMessageIDs: Set<UUID> = []
    private(set) var retiredQuestionMessageIDs: Set<UUID> = []
    var input = ""
    /// Set when OpenClaw hands off to the normal agent ("talk to agent").
    var onAgentHandoff: ((SystemAgentDraft?) -> Void)?
    /// Called after every assistant reply (setup may have applied config).
    var onReplyReceived: (() -> Void)?

    private var sessionId: String
    private let sessionPrefix: String
    private let gateway: GatewayConnection
    /// "onboarding" seeds the first-run setup proposal; nil gets the
    /// status/repair greeting (used by Settings → OpenClaw).
    private let welcomeVariant: String?
    private var started = false
    private var requestGeneration: UInt64? = 0
    private var requestTask: Task<Void, Never>?
    private var route: GatewayConnection.Route?

    init(
        welcomeVariant: String? = "onboarding",
        sessionPrefix: String = "mac-onboarding",
        gateway: GatewayConnection = .shared)
    {
        self.welcomeVariant = welcomeVariant
        self.sessionPrefix = sessionPrefix
        self.sessionId = "\(sessionPrefix)-\(UUID().uuidString)"
        self.gateway = gateway
    }

    private struct ChatResult: Decodable {
        let sessionId: String
        let reply: String
        let action: String
        let sensitive: Bool?
        let agentDraft: SystemAgentDraft?
        let question: AnyCodable?
    }

    func startIfNeeded() async {
        guard !self.started,
              self.errorMessage == nil,
              let generation = self.requestGeneration
        else { return }
        self.started = true
        await self.requestReply(message: nil, generation: generation)
        if Task.isCancelled, self.requestGeneration == generation {
            self.started = false
            self.errorMessage = "OpenClaw was interrupted. Restart to try again."
        }
    }

    @discardableResult
    func send() -> Task<Void, Never>? {
        let text = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.send(message: text)
    }

    @discardableResult
    func answerQuestion(messageID: UUID, optionLabel: String) -> Task<Void, Never>? {
        guard let message = self.messages.first(where: { $0.id == messageID }),
              let question = message.question,
              let option = question.options.first(where: { $0.label == optionLabel }),
              self.canAnswerQuestion(message)
        else { return nil }
        // The typed Gateway contract separates the visible label from its canonical reply.
        // Keep the transcript human-readable while returning the machine-facing value.
        return self.send(message: option.reply ?? option.label, displayText: option.label)
    }

    @discardableResult
    func skipQuestion(messageID: UUID) -> Task<Void, Never>? {
        guard let message = self.messages.first(where: { $0.id == messageID }),
              self.canAnswerQuestion(message),
              let task = self.send(message: "Skip for now", displayText: "Skip for now")
        else { return nil }
        self.dismissedQuestionMessageIDs.insert(messageID)
        return task
    }

    func isQuestionVisible(_ message: Message) -> Bool {
        message.question != nil && !self.dismissedQuestionMessageIDs.contains(message.id)
    }

    func canAnswerQuestion(_ message: Message) -> Bool {
        self.isQuestionVisible(message) &&
            !self.retiredQuestionMessageIDs.contains(message.id) &&
            !self.isSending &&
            self.errorMessage == nil
    }

    @discardableResult
    func restartAfterError() -> Task<Void, Never>? {
        guard let previousGeneration = self.requestGeneration else { return nil }
        let generation = previousGeneration &+ 1
        self.requestGeneration = generation
        self.requestTask?.cancel()
        self.sessionId = "\(self.sessionPrefix)-\(UUID().uuidString)"
        self.route = nil
        self.started = true
        self.messages.removeAll()
        self.dismissedQuestionMessageIDs.removeAll()
        self.retiredQuestionMessageIDs.removeAll()
        self.input = ""
        self.expectsSensitiveReply = false
        let task = Task { [weak self] in
            guard let self else { return }
            await self.requestReply(message: nil, generation: generation)
        }
        self.requestTask = task
        return task
    }

    /// Invalidate before replacing the model so queued secret-bearing sends cannot
    /// resume against whichever Gateway route becomes current next.
    func invalidate() {
        self.requestGeneration = nil
        self.requestTask?.cancel()
        self.requestTask = nil
        self.isSending = false
    }

    private func isCurrentRequest(_ generation: UInt64) -> Bool {
        self.requestGeneration == generation && !Task.isCancelled
    }

    private func sessionRoute(for generation: UInt64) async throws -> GatewayConnection.Route {
        if let route = self.route {
            return route
        }
        guard let route = await self.gateway.captureRoute() else {
            guard self.isCurrentRequest(generation) else { throw CancellationError() }
            throw NSError(
                domain: "Gateway",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "gateway not configured"])
        }
        guard self.isCurrentRequest(generation) else { throw CancellationError() }
        self.route = route
        return route
    }

    private func send(message: String, displayText: String? = nil) -> Task<Void, Never>? {
        guard let generation = self.requestGeneration,
              !message.isEmpty,
              !self.isSending,
              self.errorMessage == nil
        else { return nil }
        self.retireQuestions()
        self.input = ""
        self.messages.append(Message(
            role: .user,
            text: displayText ?? (self.expectsSensitiveReply ? "<redacted secret>" : message)))
        let task = Task { [weak self] in
            guard let self else { return }
            await self.requestReply(message: message, generation: generation)
        }
        self.requestTask = task
        return task
    }

    private func retireQuestions() {
        for message in self.messages where message.question != nil {
            self.retiredQuestionMessageIDs.insert(message.id)
        }
    }

    private func requestReply(message: String?, generation: UInt64) async {
        guard self.isCurrentRequest(generation) else { return }
        self.isSending = true
        self.errorMessage = nil
        defer {
            if self.requestGeneration == generation {
                self.isSending = false
            }
        }
        do {
            var params: [String: AnyCodable] = [
                "sessionId": AnyCodable(self.sessionId),
            ]
            if let welcomeVariant = self.welcomeVariant {
                params["welcomeVariant"] = AnyCodable(welcomeVariant)
            }
            if let message {
                params["message"] = AnyCodable(message)
            }
            let route = try await self.sessionRoute(for: generation)
            guard self.isCurrentRequest(generation) else { return }
            let data = try await self.gateway.request(
                method: "openclaw.chat",
                params: params,
                timeoutMs: 190_000,
                ifCurrentRoute: route)
            guard self.isCurrentRequest(generation) else { return }
            guard await self.gateway.isCurrentRoute(route) else { throw CancellationError() }
            let result = try JSONDecoder().decode(ChatResult.self, from: data)
            guard self.isCurrentRequest(generation) else { return }
            self.expectsSensitiveReply = result.sensitive == true
            self.messages.append(Message(
                role: .assistant,
                text: result.reply,
                question: SystemAgentChatQuestion.parse(result.question?.dictionaryValue)))
            self.onReplyReceived?()
            if result.action == "open-agent" {
                self.onAgentHandoff?(result.agentDraft)
            }
        } catch {
            guard self.requestGeneration == generation else { return }
            if error is CancellationError || Task.isCancelled {
                self.started = false
                self.errorMessage = Task.isCancelled
                    ? "OpenClaw was interrupted. Restart to try again."
                    : "The Gateway connection changed. Restart OpenClaw to reconnect."
                return
            }
            self.errorMessage = error.localizedDescription
        }
    }
}

struct SystemAgentOnboardingChatView: View {
    @Bindable var model: SystemAgentOnboardingChatModel

    var body: some View {
        VStack(spacing: 8) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(self.model.messages) { message in
                            VStack(alignment: .leading, spacing: 8) {
                                SystemAgentChatBubble(message: message)
                                if let question = message.question,
                                   self.model.isQuestionVisible(message)
                                {
                                    SystemAgentChatQuestionCard(
                                        question: question,
                                        isEnabled: self.model.canAnswerQuestion(message),
                                        onSelect: { option in
                                            self.model.answerQuestion(
                                                messageID: message.id,
                                                optionLabel: option.label)
                                        },
                                        onSkip: {
                                            self.model.skipQuestion(messageID: message.id)
                                        })
                                        .padding(.trailing, 40)
                                }
                            }
                            .id(message.id)
                        }
                        if self.model.isSending {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .controlSize(.small)
                                Text("OpenClaw is working…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.leading, 4)
                        }
                    }
                    .padding(10)
                }
                .onChange(of: self.model.messages) { _, messages in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            if let error = self.model.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    Button("Restart") {
                        self.model.restartAfterError()
                    }
                    .buttonStyle(.link)
                }
                .padding(.horizontal, 10)
            }

            HStack(spacing: 8) {
                Group {
                    if self.model.expectsSensitiveReply {
                        SecureField("Enter secret…", text: self.$model.input)
                    } else {
                        TextField(
                            "Reply to OpenClaw… (yes sets everything up)",
                            text: self.$model.input)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .onSubmit { self.model.send() }
                .disabled(self.model.errorMessage != nil)
                Button {
                    self.model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(self.model.isSending ||
                    self.model.errorMessage != nil ||
                    self.model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding([.horizontal, .bottom], 10)
        }
    }
}

private struct SystemAgentChatQuestionCard: View {
    let question: SystemAgentChatQuestion
    let isEnabled: Bool
    let onSelect: (SystemAgentChatQuestion.Option) -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(self.question.header.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Text(self.question.question)
                .font(.callout.weight(.semibold))
            ForEach(self.question.options, id: \.label) { option in
                self.optionButton(option)
            }
            Button("Skip for now", action: self.onSkip)
                .buttonStyle(.plain)
                .font(.caption)
                .foregroundStyle(.secondary)
                .disabled(!self.isEnabled)
        }
        .padding(12)
        .frame(maxWidth: 460, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor)))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(.secondary.opacity(0.2)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(self.question.question)
    }

    private func optionButton(_ option: SystemAgentChatQuestion.Option) -> some View {
        Button {
            self.onSelect(option)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                    if let description = option.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if option.recommended {
                    Text("Recommended")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(option.recommended
                        ? Color.accentColor.opacity(0.12)
                        : Color(NSColor.windowBackgroundColor)))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(option.recommended
                        ? Color.accentColor.opacity(0.55)
                        : Color.secondary.opacity(0.16)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.isEnabled)
    }
}

private struct SystemAgentChatBubble: View {
    let message: SystemAgentOnboardingChatModel.Message

    var body: some View {
        HStack {
            if self.message.role == .user {
                Spacer(minLength: 40)
            }
            Text(self.attributedText)
                .font(.callout)
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(self.message.role == .user
                            ? Color.accentColor.opacity(0.22)
                            : Color(NSColor.controlBackgroundColor)))
            if self.message.role == .assistant {
                Spacer(minLength: 40)
            }
        }
    }

    private var attributedText: AttributedString {
        // OpenClaw replies use light markdown (headings, bold, backticks).
        // Parse per line so multi-line replies keep their structure.
        var result = AttributedString()
        let lines = self.message.text.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in lines.enumerated() {
            var text = String(line)
            var isHeading = false
            if text.hasPrefix("## ") {
                text = String(text.dropFirst(3))
                isHeading = true
            }
            var piece = (try? AttributedString(markdown: text)) ?? AttributedString(text)
            if isHeading {
                piece.font = .headline
            }
            result.append(piece)
            if index < lines.count - 1 {
                result.append(AttributedString("\n"))
            }
        }
        return result
    }
}
