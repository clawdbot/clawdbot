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
    case unavailable
}

@MainActor
@Observable
public final class OpenClawQuestionCardModel: Identifiable {
    public let id: String
    public private(set) var record: QuestionRecord
    public private(set) var isSubmitting = false
    public private(set) var isSkipping = false
    public private(set) var wasAnsweredLocally = false
    public private(set) var errorText: String?
    public private(set) var selectedOptions: [String: Set<String>] = [:]
    public private(set) var otherText: [String: String] = [:]
    public private(set) var isLocallyExpired = false
    public private(set) var isRecoveryUnavailable = false

    public init(record: QuestionRecord) {
        self.id = record.id
        self.record = record
    }

    @discardableResult
    public func apply(record: QuestionRecord) -> Bool {
        let nextRecord = self.preservingKnownAnswers(in: record)
        guard record.id == self.id,
              !((self.record.status != .pending || self.isRecoveryUnavailable) && record.status == .pending),
              !Self.recordsMatch(self.record, nextRecord)
        else { return false }
        self.record = nextRecord
        self.isSubmitting = self.isSubmitting && nextRecord.status == .pending
        self.isSkipping = self.isSkipping && nextRecord.status == .pending
        self.isLocallyExpired = false
        self.isRecoveryUnavailable = false
        return true
    }

    private func preservingKnownAnswers(in record: QuestionRecord) -> QuestionRecord {
        guard record.status == .answered, record.answers == nil, let answers = self.record.answers else {
            return record
        }
        return QuestionRecord(
            id: record.id,
            questions: record.questions,
            agentid: record.agentid,
            sessionkey: record.sessionkey,
            createdatms: record.createdatms,
            expiresatms: record.expiresatms,
            status: record.status,
            answers: answers,
            resolvedby: record.resolvedby)
    }

    public func status(at date: Date = Date()) -> OpenClawQuestionCardStatus {
        if self.isRecoveryUnavailable { return .unavailable }
        switch self.record.status {
        case .answered:
            return self.wasAnsweredLocally ? .answered : .answeredElsewhere
        case .cancelled:
            return .cancelled
        case .expired:
            return .expired
        case .pending:
            if self.isLocallyExpired || date.timeIntervalSince1970 * 1000 >= Double(self.record.expiresatms) {
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

    @discardableResult
    public func toggleOption(questionID: String, optionNumber: Int) -> Bool {
        guard let question = self.record.questions.first(where: { $0.id == questionID }),
              self.status() == .pending,
              (1...4).contains(optionNumber),
              question.options.indices.contains(optionNumber - 1)
        else { return false }
        self.toggleOption(questionID: questionID, label: question.options[optionNumber - 1].label)
        return true
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
        self.isSkipping = false
        self.errorText = nil
        return answers
    }

    public func beginSkip() -> Bool {
        guard self.status() == .pending else { return false }
        self.isSubmitting = true
        self.isSkipping = true
        self.errorText = nil
        return true
    }

    public func markAnsweredLocally(answers: [String: [String]]) {
        self.wasAnsweredLocally = true
        self.isSubmitting = false
        self.isSkipping = false
        self.isLocallyExpired = false
        self.isRecoveryUnavailable = false
        self.record = QuestionRecord(
            id: self.record.id,
            questions: self.record.questions,
            agentid: self.record.agentid,
            sessionkey: self.record.sessionkey,
            createdatms: self.record.createdatms,
            expiresatms: self.record.expiresatms,
            status: .answered,
            answers: QuestionAnswers(answers: answers.mapValues { values in
                AnyCodable(["answers": values])
            }),
            resolvedby: self.record.resolvedby)
    }

    public func markSkippedLocally() {
        self.isSubmitting = false
        self.isSkipping = false
        self.isLocallyExpired = false
        self.isRecoveryUnavailable = false
        self.record = QuestionRecord(
            id: self.record.id,
            questions: self.record.questions,
            agentid: self.record.agentid,
            sessionkey: self.record.sessionkey,
            createdatms: self.record.createdatms,
            expiresatms: self.record.expiresatms,
            status: .cancelled,
            resolvedby: self.record.resolvedby)
    }

    // periphery:ignore - Public completion API for package consumers reconciling external answers.
    public func markAnsweredElsewhere() {
        self.isSubmitting = false
        self.isSkipping = false
        self.isLocallyExpired = false
        self.isRecoveryUnavailable = false
        self.record = QuestionRecord(
            id: self.record.id,
            questions: self.record.questions,
            agentid: self.record.agentid,
            sessionkey: self.record.sessionkey,
            createdatms: self.record.createdatms,
            expiresatms: self.record.expiresatms,
            status: .answered,
            resolvedby: self.record.resolvedby)
    }

    @discardableResult
    public func markRecoveryUnavailable() -> Bool {
        guard !self.isRecoveryUnavailable else { return false }
        self.isSubmitting = false
        self.isSkipping = false
        self.isLocallyExpired = false
        self.isRecoveryUnavailable = true
        return true
    }

    public func apply(resolved: OpenClawQuestionResolvedEvent) {
        guard resolved.id == self.id else { return }
        self.isSubmitting = false
        self.isSkipping = false
        self.isLocallyExpired = false
        self.isRecoveryUnavailable = false
        self.record = QuestionRecord(
            id: self.record.id,
            questions: self.record.questions,
            agentid: self.record.agentid,
            sessionkey: self.record.sessionkey,
            createdatms: self.record.createdatms,
            expiresatms: self.record.expiresatms,
            status: resolved.status,
            answers: resolved.answers ?? self.record.answers,
            resolvedby: self.record.resolvedby)
    }

    public func failSubmission(_ message: String) {
        self.isSubmitting = false
        self.isSkipping = false
        self.errorText = message
    }

    func observeLocalExpiry(at date: Date) -> Bool {
        guard self.record.status == .pending, !self.isLocallyExpired,
              date.timeIntervalSince1970 * 1000 >= Double(self.record.expiresatms)
        else { return false }
        self.isLocallyExpired = true
        self.isSubmitting = false
        self.isSkipping = false
        return true
    }

    func localExpiryDelay(at date: Date) -> TimeInterval? {
        guard self.record.status == .pending, !self.isLocallyExpired else { return nil }
        return max(0, Double(self.record.expiresatms) / 1000 - date.timeIntervalSince1970)
    }

    public func terminalSummaryText(for question: Question) -> String {
        switch self.status() {
        case .answered:
            self.answerValues(questionID: question.id)?.joined(separator: ", ") ?? String(localized: "Answered")
        case .answeredElsewhere:
            self.answerValues(questionID: question.id)?.joined(separator: ", ")
                ?? String(localized: "Answered elsewhere")
        case .cancelled:
            String(localized: "Skipped")
        case .expired:
            String(localized: "Expired")
        case .unavailable:
            String(localized: "Unavailable")
        case .pending, .submitting:
            String(localized: "Pending")
        }
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

    private func answerValues(questionID: String) -> [String]? {
        guard let answer = self.record.answers?.answers[questionID],
              let data = try? JSONEncoder().encode(answer),
              let decoded = try? JSONDecoder().decode(ResolvedAnswer.self, from: data),
              !decoded.answers.isEmpty
        else { return nil }
        return decoded.answers
    }

    private struct ResolvedAnswer: Codable {
        let answers: [String]
    }

    private static func recordsMatch(_ lhs: QuestionRecord, _ rhs: QuestionRecord) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(lhs)) == (try? encoder.encode(rhs))
    }
}

struct OpenClawQuestionCard: View {
    @Bindable private var model: OpenClawQuestionCardModel
    private let onSubmit: @MainActor @Sendable (OpenClawQuestionCardModel) async -> Void
    private let onSkip: (@MainActor @Sendable (OpenClawQuestionCardModel) async -> Void)?
    #if os(macOS)
    @FocusState private var focusedQuestionID: String?
    #endif

    init(
        model: OpenClawQuestionCardModel,
        onSubmit: @escaping @MainActor @Sendable (OpenClawQuestionCardModel) async -> Void,
        onSkip: @escaping @MainActor @Sendable (OpenClawQuestionCardModel) async -> Void)
    {
        self.model = model
        self.onSubmit = onSubmit
        self.onSkip = onSkip
    }

    var body: some View {
        let status = self.model.status()
        if status == .pending || status == .submitting {
            self.pendingCard
        } else {
            self.terminalSummary
        }
    }

    private var pendingCard: some View {
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

    private var terminalSummary: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(self.model.record.questions, id: \.id) { question in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(verbatim: "\(question.header):")
                        .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .callout))
                    Text(self.model.terminalSummaryText(for: question))
                        .font(OpenClawChatTypography.body(size: 14, weight: .regular, relativeTo: .callout))
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(OpenClawChatTheme.subtleCard, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Question summary")
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
        #if os(macOS)
        .focusable()
        .focused(self.$focusedQuestionID, equals: question.id)
        .onKeyPress(characters: .decimalDigits) { keyPress in
            guard self.focusedQuestionID == question.id else { return .ignored }
            return self.handleNumberKey(keyPress, question: question, now: now)
        }
        .onKeyPress(.return) {
            guard self.focusedQuestionID == question.id,
                  self.model.status(at: now) == .pending,
                  self.model.canSubmit
            else { return .ignored }
            Task { await self.onSubmit(self.model) }
            return .handled
        }
        #endif
    }

    private func optionRow(question: Question, option: QuestionOption, now: Date) -> some View {
        let selected = self.model.selectedOptions[question.id]?.contains(option.label) == true
        return Button {
            #if os(macOS)
            self.focusedQuestionID = question.id
            #endif
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
                if let onSkip = self.onSkip {
                    Button {
                        Task { await onSkip(self.model) }
                    } label: {
                        if self.model.isSkipping {
                            Text("Skipping…")
                                .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .callout))
                        } else {
                            Text("Skip")
                                .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .callout))
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(status == .submitting)
                }
                Button {
                    Task { await self.onSubmit(self.model) }
                } label: {
                    if status == .submitting, !self.model.isSkipping {
                        Text("Submitting…")
                            .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .callout))
                    } else {
                        Text("Submit")
                            .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .callout))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!self.model.canSubmit || status == .submitting)
            }
            if let errorText = self.model.errorText {
                Text(errorText)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.danger)
            }
        }
    }

    private func countdownText(now: Date) -> String {
        let seconds = self.model.remainingSeconds(at: now)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    #if os(macOS)
    private func handleNumberKey(
        _ keyPress: KeyPress,
        question: Question,
        now: Date) -> KeyPress.Result
    {
        guard self.model.status(at: now) == .pending,
              let digit = keyPress.characters.first?.wholeNumberValue,
              self.model.toggleOption(questionID: question.id, optionNumber: digit)
        else { return .ignored }
        return .handled
    }
    #endif
}

@MainActor
struct OpenClawQuestionCards: View {
    let viewModel: OpenClawChatViewModel

    var body: some View {
        ForEach(self.viewModel.visibleQuestionCards) { card in
            OpenClawQuestionCard(model: card) { [weak viewModel = self.viewModel] model in
                await viewModel?.submitQuestion(model)
            } onSkip: { [weak viewModel = self.viewModel] model in
                await viewModel?.skipQuestion(model)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private enum QuestionLookupResult {
    case record(QuestionRecord)
    case notFound
    case failed
}

private struct QuestionRefreshApplyResult {
    let complete: Bool
    let changed: Bool
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
        self.questionRefreshRetryTask?.cancel()
        self.questionRefreshRetryTask = nil
        await self.refreshQuestions(generation: refreshGeneration, retryIndex: 0)
    }

    private func refreshQuestions(generation refreshGeneration: UInt64, retryIndex: Int) async {
        guard refreshGeneration == self.questionRefreshGeneration else { return }
        let stateRevision = self.questionStateRevision
        do {
            let records = try await self.transport.listQuestions()
            guard self.questionRefreshSnapshotIsCurrent(
                generation: refreshGeneration,
                stateRevision: stateRevision)
            else { return }
            let listedIDs = Set(records.map(\.id))
            let missingPending = self.questionCards.filter { model in
                model.record.status == .pending &&
                    !model.isRecoveryUnavailable &&
                    !listedIDs.contains(model.id)
            }
            let lookups = await self.fetchMissingQuestionLookups(missingPending)
            guard self.questionRefreshSnapshotIsCurrent(
                generation: refreshGeneration,
                stateRevision: stateRevision)
            else { return }
            let result = self.applyQuestionRefresh(records: records, lookups: lookups)
            if result.complete {
                self.questionRefreshRetryTask = nil
            } else {
                self.scheduleQuestionRefreshRetry(
                    generation: refreshGeneration,
                    retryIndex: result.changed ? 0 : retryIndex)
            }
        } catch let error as GatewayResponseError where Self.questionListIsUnavailable(error) {
            guard self.questionRefreshSnapshotIsCurrent(
                generation: refreshGeneration,
                stateRevision: stateRevision)
            else { return }
            self.clearPendingQuestionsForUnavailableList()
        } catch {
            guard self.questionRefreshSnapshotIsCurrent(
                generation: refreshGeneration,
                stateRevision: stateRevision)
            else { return }
            self.scheduleQuestionRefreshRetry(
                generation: refreshGeneration,
                retryIndex: retryIndex)
        }
    }

    private func fetchMissingQuestionLookups(
        _ models: [OpenClawQuestionCardModel]) async
        -> [(OpenClawQuestionCardModel, QuestionLookupResult)]
    {
        // The gateway enumerates pending questions only; terminal records remain addressable
        // briefly by known ID. Cards observed by this view model persist without timed eviction,
        // but session transcripts do not contain enough question data to recreate them on launch.
        var lookups: [(OpenClawQuestionCardModel, QuestionLookupResult)] = []
        for model in models {
            do {
                let record = try await self.transport.getQuestion(id: model.id)
                lookups.append((model, .record(record)))
            } catch let error as GatewayResponseError where Self.questionIsNotFound(error) {
                lookups.append((model, .notFound))
            } catch {
                lookups.append((model, .failed))
            }
        }
        return lookups
    }

    private func applyQuestionRefresh(
        records: [QuestionRecord],
        lookups: [(OpenClawQuestionCardModel, QuestionLookupResult)]) -> QuestionRefreshApplyResult
    {
        var changed = false
        for record in records {
            if let model = self.questionCards.first(where: { $0.id == record.id }) {
                changed = model.apply(record: record) || changed
            } else {
                self.questionCards.append(OpenClawQuestionCardModel(record: record))
                changed = true
            }
        }
        var complete = true
        for (model, result) in lookups {
            guard self.questionCards.contains(where: { $0 === model }) else { continue }
            switch result {
            case let .record(record):
                changed = model.apply(record: record) || changed
            case .notFound:
                // The terminal tombstone has aged out, so the question is no longer actionable,
                // but its answered/cancelled/expired outcome cannot be reconstructed.
                changed = model.markRecoveryUnavailable() || changed
            case .failed:
                complete = false
            }
        }
        self.syncQuestionExpirations()
        if changed {
            self.questionStateRevision &+= 1
            self.markTimelineChanged()
        }
        return QuestionRefreshApplyResult(complete: complete, changed: changed)
    }

    private func clearPendingQuestionsForUnavailableList() {
        let previousCount = self.questionCards.count
        self.questionCards.removeAll {
            let status = $0.status()
            return status == .pending || status == .submitting
        }
        self.syncQuestionExpirations()
        if self.questionCards.count != previousCount {
            self.questionStateRevision &+= 1
            self.markTimelineChanged()
        }
    }

    private func questionRefreshSnapshotIsCurrent(generation: UInt64, stateRevision: UInt64) -> Bool {
        guard generation == self.questionRefreshGeneration else { return false }
        guard stateRevision == self.questionStateRevision else {
            self.restartQuestionRefreshAfterStateChange(generation: generation)
            return false
        }
        return true
    }

    private nonisolated static func questionListIsUnavailable(_ error: GatewayResponseError) -> Bool {
        if error.missingScope == "operator.questions" { return true }
        return error.code == "INVALID_REQUEST" && error.message == "unknown method: question.list"
    }

    private nonisolated static func questionIsNotFound(_ error: GatewayResponseError) -> Bool {
        error.detailsReason == "QUESTION_NOT_FOUND"
    }

    private func restartQuestionRefreshAfterStateChange(generation: UInt64) {
        // Local question mutations invalidate the whole lookup snapshot, not one transport attempt.
        // Restart the bounded budget so a late mutation cannot consume the last reconciliation slot.
        self.scheduleQuestionRefreshRetry(generation: generation, retryIndex: 0)
    }

    private func scheduleQuestionRefreshRetry(generation: UInt64, retryIndex: Int) {
        guard generation == self.questionRefreshGeneration else { return }
        guard self.questionRefreshRetryDelaysMs.indices.contains(retryIndex) else {
            self.questionRefreshRetryTask = nil
            return
        }
        let delayMs = self.questionRefreshRetryDelaysMs[retryIndex]
        let stateRevision = self.questionStateRevision
        self.questionRefreshRetryTask?.cancel()
        self.questionRefreshRetryTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delayMs))
            guard !Task.isCancelled, let self,
                  generation == self.questionRefreshGeneration
            else { return }
            // A mutation during backoff invalidates the reconciliation attempt, not the retry budget.
            let nextRetryIndex = stateRevision == self.questionStateRevision ? retryIndex + 1 : 0
            await self.refreshQuestions(generation: generation, retryIndex: nextRetryIndex)
        }
    }

    func upsertQuestion(_ record: QuestionRecord) {
        if let model = self.questionCards.first(where: { $0.id == record.id }) {
            guard model.apply(record: record) else { return }
        } else {
            self.questionCards.append(OpenClawQuestionCardModel(record: record))
        }
        self.questionStateRevision &+= 1
        self.syncQuestionExpirations()
        self.markTimelineChanged()
    }

    func resolveQuestionEvent(_ event: OpenClawQuestionResolvedEvent) {
        self.questionCards.first(where: { $0.id == event.id })?.apply(resolved: event)
        self.questionStateRevision &+= 1
        self.syncQuestionExpirations()
        self.markTimelineChanged()
    }

    func reconcileQuestionsAfterEvent() {
        // Invalidate a list snapshot captured before this event, then fetch the
        // authoritative set so other pending cards from that snapshot are not lost.
        self.questionRefreshGeneration &+= 1
        self.questionRefreshRetryTask?.cancel()
        self.questionRefreshRetryTask = nil
        Task { [weak self] in await self?.refreshQuestions() }
    }

    func submitQuestion(_ model: OpenClawQuestionCardModel) async {
        guard let answers = model.beginSubmission() else { return }
        self.questionStateRevision &+= 1
        do {
            try await self.transport.resolveQuestion(id: model.id, answers: answers)
            model.markAnsweredLocally(answers: answers)
            self.questionStateRevision &+= 1
            self.syncQuestionExpirations()
            self.markTimelineChanged()
        } catch {
            model.failSubmission(error.localizedDescription)
            self.questionStateRevision &+= 1
        }
    }

    func skipQuestion(_ model: OpenClawQuestionCardModel) async {
        guard model.beginSkip() else { return }
        self.questionStateRevision &+= 1
        do {
            try await self.transport.cancelQuestion(id: model.id)
            model.markSkippedLocally()
            self.questionStateRevision &+= 1
            self.syncQuestionExpirations()
            self.markTimelineChanged()
        } catch {
            model.failSubmission(error.localizedDescription)
            self.questionStateRevision &+= 1
        }
    }

    func expireQuestionIfNeeded(
        _ model: OpenClawQuestionCardModel,
        at date: Date = Date())
    {
        guard self.questionCards.first(where: { $0.id == model.id }) === model else { return }
        if model.observeLocalExpiry(at: date) {
            self.questionStateRevision &+= 1
            self.syncQuestionExpirations(at: date)
            self.markTimelineChanged()
            Task { [weak self] in await self?.refreshQuestions() }
        } else {
            self.syncQuestionExpirations(at: date)
        }
    }

    private func syncQuestionExpirations(at date: Date = Date()) {
        let modelsByID = Dictionary(uniqueKeysWithValues: self.questionCards.map { ($0.id, $0) })
        let cancelledIDs = self.questionExpiryTasks.keys.filter { modelsByID[$0] == nil }
        for id in cancelledIDs {
            self.questionExpiryTasks.removeValue(forKey: id)?.cancel()
            self.questionExpiryDeadlines.removeValue(forKey: id)
        }
        for model in self.questionCards {
            guard let delay = model.localExpiryDelay(at: date) else {
                self.questionExpiryTasks.removeValue(forKey: model.id)?.cancel()
                self.questionExpiryDeadlines.removeValue(forKey: model.id)
                continue
            }
            let deadline = date.addingTimeInterval(delay)
            if let scheduled = self.questionExpiryDeadlines[model.id],
               abs(scheduled.timeIntervalSince(deadline)) < 0.01
            {
                continue
            }
            self.questionExpiryTasks.removeValue(forKey: model.id)?.cancel()
            self.questionExpiryDeadlines[model.id] = deadline
            self.questionExpiryTasks[model.id] = Task { [weak self, weak model] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self, let model else { return }
                self.questionExpiryTasks.removeValue(forKey: model.id)
                self.questionExpiryDeadlines.removeValue(forKey: model.id)
                self.expireQuestionIfNeeded(model)
            }
        }
    }
}
