import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI

public enum OpenClawQuestionCardStatus: Sendable, Equatable {
    case pending
    case submitting
    case answered
    case answeredElsewhere
    case expired
    case cancelled
}

@MainActor
@Observable
public final class OpenClawQuestionCardModel: Identifiable {
    private static let terminalRetentionSeconds: TimeInterval = 15

    public let id: String
    public private(set) var record: QuestionRecord
    public private(set) var isSubmitting = false
    public private(set) var wasAnsweredLocally = false
    public private(set) var errorText: String?
    public private(set) var selectedOptions: [String: Set<String>] = [:]
    public private(set) var otherText: [String: String] = [:]
    private var terminalObservedAt: Date?

    public init(record: QuestionRecord) {
        self.id = record.id
        self.record = record
        self.terminalObservedAt = record.status == .pending ? nil : Date()
    }

    @discardableResult
    public func apply(record: QuestionRecord, at date: Date = Date()) -> Bool {
        guard record.id == self.id, !Self.recordsMatch(self.record, record) else { return false }
        self.record = record
        self.isSubmitting = self.isSubmitting && record.status == .pending
        self.terminalObservedAt = record.status == .pending ? nil : (self.terminalObservedAt ?? date)
        return true
    }

    public func status(at date: Date = Date()) -> OpenClawQuestionCardStatus {
        switch self.record.status {
        case .answered:
            return self.wasAnsweredLocally ? .answered : .answeredElsewhere
        case .cancelled:
            return .cancelled
        case .expired:
            return .expired
        case .pending:
            if date.timeIntervalSince1970 * 1000 >= Double(self.record.expiresatms) {
                return .expired
            }
            return self.isSubmitting ? .submitting : .pending
        }
    }

    public func remainingSeconds(at date: Date = Date()) -> Int {
        max(0, Int(ceil(Double(self.record.expiresatms) / 1000 - date.timeIntervalSince1970)))
    }

    public func toggleOption(questionID: String, label: String) {
        guard let question = self.record.questions.first(where: { $0.id == questionID }),
              question.options.contains(where: { $0.label == label }),
              self.status() == .pending
        else { return }
        var selected = self.selectedOptions[questionID] ?? []
        if question.multiselect == true {
            if selected.contains(label) {
                selected.remove(label)
            } else {
                selected.insert(label)
            }
        } else {
            selected = selected == [label] ? [] : [label]
            if !selected.isEmpty {
                self.otherText[questionID] = ""
            }
        }
        self.selectedOptions[questionID] = selected
        self.errorText = nil
    }

    public func setOtherText(questionID: String, value: String) {
        guard let question = self.record.questions.first(where: { $0.id == questionID }),
              question.options.isEmpty || question.isother == true,
              self.status() == .pending
        else { return }
        self.otherText[questionID] = value
        if question.multiselect != true, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.selectedOptions[questionID] = []
        }
        self.errorText = nil
    }

    public var canSubmit: Bool {
        self.status() == .pending && self.answers() != nil
    }

    public func beginSubmission() -> [String: [String]]? {
        guard let answers = self.answers(), self.status() == .pending else { return nil }
        self.isSubmitting = true
        self.errorText = nil
        return answers
    }

    public func markAnsweredLocally(at date: Date = Date()) {
        self.wasAnsweredLocally = true
        self.isSubmitting = false
        self.terminalObservedAt = self.terminalObservedAt ?? date
        self.record = QuestionRecord(
            id: self.record.id,
            questions: self.record.questions,
            agentid: self.record.agentid,
            sessionkey: self.record.sessionkey,
            createdatms: self.record.createdatms,
            expiresatms: self.record.expiresatms,
            status: .answered,
            answers: self.answers().map { answers in
                QuestionAnswers(answers: answers.mapValues { values in
                    AnyCodable(["answers": values])
                })
            },
            resolvedby: self.record.resolvedby)
    }

    public func apply(resolved: OpenClawQuestionResolvedEvent, at date: Date = Date()) {
        guard resolved.id == self.id else { return }
        self.isSubmitting = false
        self.terminalObservedAt = self.terminalObservedAt ?? date
        self.record = QuestionRecord(
            id: self.record.id,
            questions: self.record.questions,
            agentid: self.record.agentid,
            sessionkey: self.record.sessionkey,
            createdatms: self.record.createdatms,
            expiresatms: self.record.expiresatms,
            status: resolved.status,
            answers: resolved.answers,
            resolvedby: self.record.resolvedby)
    }

    public func failSubmission(_ message: String) {
        self.isSubmitting = false
        self.errorText = message
    }

    func shouldRetainAfterList(at date: Date) -> Bool {
        guard let terminalObservedAt else { return false }
        return date.timeIntervalSince(terminalObservedAt) < Self.terminalRetentionSeconds
    }

    func terminalRetentionDelay(at date: Date) -> TimeInterval? {
        guard let terminalObservedAt else { return nil }
        return max(0, Self.terminalRetentionSeconds - date.timeIntervalSince(terminalObservedAt))
    }

    func observeLocalExpiry(at date: Date) -> Bool {
        guard self.record.status == .pending, self.terminalObservedAt == nil,
              date.timeIntervalSince1970 * 1000 >= Double(self.record.expiresatms)
        else { return false }
        self.terminalObservedAt = date
        return true
    }

    func localExpiryDelay(at date: Date) -> TimeInterval? {
        guard self.record.status == .pending, self.terminalObservedAt == nil else { return nil }
        return max(0, Double(self.record.expiresatms) / 1000 - date.timeIntervalSince1970)
    }

    private func answers() -> [String: [String]]? {
        var result: [String: [String]] = [:]
        for question in self.record.questions {
            let selected = self.selectedOptions[question.id] ?? []
            var values = question.options.compactMap { selected.contains($0.label) ? $0.label : nil }
            if let other = self.otherText[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines),
               !other.isEmpty
            {
                values.append(other)
            }
            guard !values.isEmpty else { return nil }
            result[question.id] = values
        }
        return result
    }

    private static func recordsMatch(_ lhs: QuestionRecord, _ rhs: QuestionRecord) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(lhs)) == (try? encoder.encode(rhs))
    }
}

// periphery:ignore - Public SwiftUI component for package consumers; native apps embed it through the shared list.
public struct OpenClawQuestionCard: View {
    @Bindable private var model: OpenClawQuestionCardModel
    private let onSubmit: @MainActor @Sendable (OpenClawQuestionCardModel) async -> Void

    // periphery:ignore - Public construction is part of the exported SwiftUI component API.
    public init(
        model: OpenClawQuestionCardModel,
        onSubmit: @escaping @MainActor @Sendable (OpenClawQuestionCardModel) async -> Void)
    {
        self.model = model
        self.onSubmit = onSubmit
    }

    // periphery:ignore - SwiftUI View witness must stay public for the exported component.
    public var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: 14) {
                ForEach(self.model.record.questions, id: \.id) { question in
                    self.questionSection(question, now: context.date)
                }
                self.footer(now: context.date)
            }
            .padding(16)
            .background(OpenClawChatTheme.subtleCard, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(.secondary.opacity(0.2)))
        }
    }

    private func questionSection(_ question: Question, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question.header.uppercased())
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(OpenClawChatTheme.accent)
            Text(question.question)
                .font(OpenClawChatTypography.body)
            ForEach(question.options, id: \.label) { option in
                self.optionRow(question: question, option: option, now: now)
            }
            if question.options.isEmpty || question.isother == true {
                TextField(
                    "Other answer",
                    text: Binding(
                        get: { self.model.otherText[question.id] ?? "" },
                        set: { self.model.setOtherText(questionID: question.id, value: $0) }),
                    axis: .vertical)
                    .font(OpenClawChatTypography.body)
                    .textFieldStyle(.roundedBorder)
                    .disabled(self.model.status(at: now) != .pending)
                    .accessibilityLabel("Other answer")
            }
        }
    }

    private func optionRow(question: Question, option: QuestionOption, now: Date) -> some View {
        let selected = self.model.selectedOptions[question.id]?.contains(option.label) == true
        return Button {
            self.model.toggleOption(questionID: question.id, label: option.label)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected
                    ? (question.multiselect == true ? "checkmark.square.fill" : "largecircle.fill.circle")
                    : (question.multiselect == true ? "square" : "circle"))
                    .foregroundStyle(selected ? OpenClawChatTheme.accent : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(OpenClawChatTypography.body)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(self.model.status(at: now) != .pending)
        .accessibilityLabel(option.label)
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }

    @ViewBuilder
    private func footer(now: Date) -> some View {
        let status = self.model.status(at: now)
        if status == .pending || status == .submitting {
            HStack {
                Text(self.countdownText(now: now))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(status == .submitting ? "Submitting…" : "Submit") {
                    Task { await self.onSubmit(self.model) }
                }
                .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .callout))
                .buttonStyle(.borderedProminent)
                .disabled(!self.model.canSubmit || status == .submitting)
            }
            if let errorText = self.model.errorText {
                Text(errorText)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.danger)
            }
        } else {
            Label(self.terminalText(status), systemImage: self.terminalIcon(status))
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(.secondary)
        }
    }

    private func countdownText(now: Date) -> String {
        let seconds = self.model.remainingSeconds(at: now)
        return seconds >= 60 ? "Expires in \(seconds / 60)m \(seconds % 60)s" : "Expires in \(seconds)s"
    }

    private func terminalText(_ status: OpenClawQuestionCardStatus) -> String {
        switch status {
        case .answered: "Answered"
        case .answeredElsewhere: "Answered elsewhere"
        case .expired: "Expired"
        case .cancelled: "Cancelled"
        case .pending, .submitting: "Pending"
        }
    }

    private func terminalIcon(_ status: OpenClawQuestionCardStatus) -> String {
        switch status {
        case .answered, .answeredElsewhere: "checkmark.circle.fill"
        case .expired: "clock.badge.xmark"
        case .cancelled: "xmark.circle"
        case .pending, .submitting: "clock"
        }
    }
}

@MainActor
struct OpenClawQuestionCards: View {
    let viewModel: OpenClawChatViewModel

    var body: some View {
        ForEach(self.viewModel.visibleQuestionCards) { card in
            OpenClawQuestionCard(model: card) { [weak viewModel = self.viewModel] model in
                await viewModel?.submitQuestion(model)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension OpenClawChatViewModel {
    public var visibleQuestionCards: [OpenClawQuestionCardModel] {
        self.questionCards.filter { card in
            guard let key = card.record.sessionkey else { return true }
            return self.matchesCurrentSessionKey(
                incoming: key,
                agentId: card.record.agentid,
                current: self.sessionKey)
        }
    }

    func refreshQuestions() async {
        self.questionRefreshGeneration &+= 1
        let refreshGeneration = self.questionRefreshGeneration
        let stateRevision = self.questionStateRevision
        do {
            let records = try await self.transport.listQuestions()
            guard refreshGeneration == self.questionRefreshGeneration,
                  stateRevision == self.questionStateRevision
            else { return }
            let existing = Dictionary(uniqueKeysWithValues: self.questionCards.map { ($0.id, $0) })
            let listedIDs = Set(records.map(\.id))
            let now = Date()
            let retainedTerminal = self.questionCards.filter { model in
                !listedIDs.contains(model.id) && model.shouldRetainAfterList(at: now)
            }
            var changed = records.count + retainedTerminal.count != self.questionCards.count
            self.questionCards = records.map { record in
                if let model = existing[record.id] {
                    changed = model.apply(record: record) || changed
                    return model
                }
                changed = true
                return OpenClawQuestionCardModel(record: record)
            } + retainedTerminal
            self.syncQuestionEvictions()
            if changed {
                self.questionStateRevision &+= 1
                self.markTimelineChanged()
            }
        } catch let error as GatewayResponseError where Self.questionListIsUnavailable(error) {
            guard refreshGeneration == self.questionRefreshGeneration,
                  stateRevision == self.questionStateRevision,
                  !self.questionCards.isEmpty
            else { return }
            self.questionCards = []
            self.syncQuestionEvictions()
            self.questionStateRevision &+= 1
            self.markTimelineChanged()
        } catch {
            // Question recovery is best-effort; chat bootstrap remains usable without this scope.
        }
    }

    private nonisolated static func questionListIsUnavailable(_ error: GatewayResponseError) -> Bool {
        guard error.code == "INVALID_REQUEST" else { return false }
        return error.message == "unknown method: question.list" ||
            error.message == "missing scope: operator.questions"
    }

    func upsertQuestion(_ record: QuestionRecord) {
        if let model = self.questionCards.first(where: { $0.id == record.id }) {
            guard model.apply(record: record) else { return }
        } else {
            self.questionCards.append(OpenClawQuestionCardModel(record: record))
        }
        self.questionStateRevision &+= 1
        self.syncQuestionEvictions()
        self.markTimelineChanged()
    }

    func resolveQuestionEvent(_ event: OpenClawQuestionResolvedEvent) {
        self.questionCards.first(where: { $0.id == event.id })?.apply(resolved: event)
        self.questionStateRevision &+= 1
        self.syncQuestionEvictions()
        self.markTimelineChanged()
    }

    func reconcileQuestionsAfterEvent() {
        // Invalidate a list snapshot captured before this event, then fetch the
        // authoritative set so other pending cards from that snapshot are not lost.
        self.questionRefreshGeneration &+= 1
        Task { [weak self] in await self?.refreshQuestions() }
    }

    func submitQuestion(_ model: OpenClawQuestionCardModel) async {
        guard let answers = model.beginSubmission() else { return }
        self.questionStateRevision &+= 1
        do {
            try await self.transport.resolveQuestion(id: model.id, answers: answers)
            model.markAnsweredLocally()
            self.questionStateRevision &+= 1
            self.syncQuestionEvictions()
            self.markTimelineChanged()
        } catch {
            model.failSubmission(error.localizedDescription)
            self.questionStateRevision &+= 1
        }
    }

    func evictQuestionIfTerminalGraceElapsed(
        _ model: OpenClawQuestionCardModel,
        at date: Date = Date())
    {
        guard self.questionCards.first(where: { $0.id == model.id }) === model else { return }
        if model.observeLocalExpiry(at: date) {
            self.questionStateRevision &+= 1
            self.markTimelineChanged()
        }
        guard
            !model.shouldRetainAfterList(at: date),
            model.status(at: date) == .expired || model.record.status != .pending
        else {
            self.syncQuestionEvictions(at: date)
            return
        }
        self.questionCards.removeAll { $0 === model }
        self.questionEvictionTasks.removeValue(forKey: model.id)?.cancel()
        self.questionEvictionDeadlines.removeValue(forKey: model.id)
        self.questionStateRevision &+= 1
        self.markTimelineChanged()
    }

    private func syncQuestionEvictions(at date: Date = Date()) {
        let modelsByID = Dictionary(uniqueKeysWithValues: self.questionCards.map { ($0.id, $0) })
        let cancelledIDs = self.questionEvictionTasks.keys.filter { modelsByID[$0] == nil }
        for id in cancelledIDs {
            self.questionEvictionTasks.removeValue(forKey: id)?.cancel()
            self.questionEvictionDeadlines.removeValue(forKey: id)
        }
        for model in self.questionCards {
            guard let delay = model.terminalRetentionDelay(at: date) ?? model.localExpiryDelay(at: date)
            else { continue }
            let deadline = date.addingTimeInterval(delay)
            if let scheduled = self.questionEvictionDeadlines[model.id],
               abs(scheduled.timeIntervalSince(deadline)) < 0.01
            {
                continue
            }
            self.questionEvictionTasks.removeValue(forKey: model.id)?.cancel()
            self.questionEvictionDeadlines[model.id] = deadline
            self.questionEvictionTasks[model.id] = Task { [weak self, weak model] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self, let model else { return }
                self.questionEvictionTasks.removeValue(forKey: model.id)
                self.questionEvictionDeadlines.removeValue(forKey: model.id)
                self.evictQuestionIfTerminalGraceElapsed(model)
            }
        }
    }
}
