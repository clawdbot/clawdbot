import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
private func questionRecord(
    multiSelect: Bool = false,
    isOther: Bool = true,
    createdAtMs: Int = 1_000_000,
    expiresAtMs: Int = 4_000_000_000_000,
    status: QuestionStatus = .pending,
    answers: QuestionAnswers? = nil) -> QuestionRecord
{
    QuestionRecord(
        id: "ask_123",
        questions: [
            Question(
                questionid: "meal",
                header: "Meal",
                question: "Choose dinner",
                options: [
                    QuestionOption(label: "Pizza", description: "Fast"),
                    QuestionOption(label: "Tacos"),
                ],
                multiselect: multiSelect,
                isother: isOther),
        ],
        agentid: "main",
        sessionkey: "agent:main:main",
        createdatms: createdAtMs,
        expiresatms: expiresAtMs,
        status: status,
        answers: answers)
}

@MainActor
@Test func `question card single select and other are exclusive`() {
    let model = OpenClawQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    #expect(model.beginSubmission() == ["meal": ["Pizza"]])
    model.failSubmission("retry")

    model.setOtherText(questionID: "meal", value: "  Salad  ")
    #expect(model.selectedOptions["meal"]?.isEmpty == true)
    #expect(model.beginSubmission() == ["meal": ["Salad"]])
}

@MainActor
@Test func `question card multi select uses declared option order`() {
    let model = OpenClawQuestionCardModel(record: questionRecord(multiSelect: true))
    model.toggleOption(questionID: "meal", label: "Tacos")
    model.toggleOption(questionID: "meal", label: "Pizza")
    #expect(model.beginSubmission() == ["meal": ["Pizza", "Tacos"]])
}

@MainActor
@Test func `question card number selection uses declared option order`() {
    let model = OpenClawQuestionCardModel(record: questionRecord(multiSelect: true))

    #expect(model.toggleOption(questionID: "meal", optionNumber: 2))
    #expect(model.toggleOption(questionID: "meal", optionNumber: 1))
    #expect(!model.toggleOption(questionID: "meal", optionNumber: 4))
    #expect(model.beginSubmission() == ["meal": ["Pizza", "Tacos"]])
}

@MainActor
@Test func `question card maps expiry and answer origin`() {
    let now = Date(timeIntervalSince1970: 1500)
    let expired = OpenClawQuestionCardModel(record: questionRecord(expiresAtMs: 1_499_000))
    #expect(expired.status(at: now) == .expired)
    #expect(expired.remainingSeconds(at: now) == 0)

    let remote = OpenClawQuestionCardModel(record: questionRecord())
    remote.apply(resolved: OpenClawQuestionResolvedEvent(id: remote.id, status: .answered))
    #expect(remote.status(at: Date(timeIntervalSince1970: 1500)) == .answeredElsewhere)

    let local = OpenClawQuestionCardModel(record: questionRecord())
    local.markAnsweredLocally(answers: ["meal": ["Pizza"]])
    local.apply(resolved: OpenClawQuestionResolvedEvent(id: local.id, status: .answered))
    #expect(local.status(at: Date(timeIntervalSince1970: 1500)) == .answered)
}

@MainActor
@Test func `question card pending refresh preserves submission`() {
    let model = OpenClawQuestionCardModel(record: questionRecord(expiresAtMs: Int.max))
    model.toggleOption(questionID: "meal", label: "Pizza")
    #expect(model.beginSubmission() != nil)

    #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, expiresAtMs: Int.max)))
    #expect(model.status(at: Date(timeIntervalSince1970: 1500)) == .submitting)

    #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, expiresAtMs: Int.max, status: .answered)))
    #expect(model.status(at: Date(timeIntervalSince1970: 1500)) == .answeredElsewhere)
}

@MainActor
@Test func `question card ignores replayed pending record after terminal event`() {
    let model = OpenClawQuestionCardModel(record: questionRecord())
    model.apply(resolved: .init(id: model.id, status: .answered))

    #expect(!model.apply(record: questionRecord(createdAtMs: 2_000_000)))
    #expect(model.status() == .answeredElsewhere)
}

@MainActor
@Test func `question card preserves submitted answers across answerless refresh`() throws {
    let model = OpenClawQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(model.beginSubmission())
    model.markAnsweredLocally(answers: answers)

    #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, status: .answered)))
    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
}

@MainActor
@Test func `question card preserves submitted answers across answerless resolved event`() throws {
    let model = OpenClawQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(model.beginSubmission())
    model.markAnsweredLocally(answers: answers)

    model.apply(resolved: .init(id: model.id, status: .answered))

    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
}

@MainActor
@Test func `question card locally expired state remains terminal`() {
    let expiresAt = Date(timeIntervalSince1970: 1500)
    let model = OpenClawQuestionCardModel(record: questionRecord(expiresAtMs: 1_500_000))

    #expect(model.observeLocalExpiry(at: expiresAt))
    #expect(!model.observeLocalExpiry(at: expiresAt.addingTimeInterval(15)))
    #expect(model.status(at: expiresAt.addingTimeInterval(15)) == .expired)
}

@MainActor
@Test func `question card stores local answers in gateway record shape`() throws {
    let model = OpenClawQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(model.beginSubmission())
    model.markAnsweredLocally(answers: answers)

    let data = try JSONEncoder().encode(model.record.answers)
    let json = try #require(String(data: data, encoding: .utf8))
    #expect(json.contains("\"meal\":[\"Pizza\"]"))
    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
}

@MainActor
@Test func `question completions override unavailable recovery race`() throws {
    let answered = OpenClawQuestionCardModel(record: questionRecord())
    answered.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(answered.beginSubmission())
    answered.markRecoveryUnavailable()
    answered.markAnsweredLocally(answers: answers)
    #expect(answered.status() == .answered)

    let skipped = OpenClawQuestionCardModel(record: questionRecord())
    #expect(skipped.beginSkip())
    skipped.markRecoveryUnavailable()
    skipped.markSkippedLocally()
    #expect(skipped.status() == .cancelled)

    let answeredElsewhere = OpenClawQuestionCardModel(record: questionRecord())
    answeredElsewhere.markRecoveryUnavailable()
    answeredElsewhere.markAnsweredElsewhere()
    #expect(answeredElsewhere.status() == .answeredElsewhere)
}

@MainActor
@Test func `question card terminal summaries prefer resolved answers`() {
    let answers = QuestionAnswers(answers: [
        "meal": AnyCodable(["Pizza", "extra hot"]),
    ])
    let answered = OpenClawQuestionCardModel(record: questionRecord(status: .answered, answers: answers))
    let question = answered.record.questions[0]
    #expect(answered.terminalSummaryText(for: question) == "Pizza, extra hot")

    let elsewhere = OpenClawQuestionCardModel(record: questionRecord(status: .answered))
    #expect(elsewhere.terminalSummaryText(for: question) == "Answered elsewhere")

    let skipped = OpenClawQuestionCardModel(record: questionRecord(status: .cancelled))
    #expect(skipped.terminalSummaryText(for: question) == "Skipped")

    let expired = OpenClawQuestionCardModel(record: questionRecord(status: .expired))
    #expect(expired.terminalSummaryText(for: question) == "Expired")

    let unavailable = OpenClawQuestionCardModel(record: questionRecord())
    unavailable.markRecoveryUnavailable()
    #expect(unavailable.status() == .unavailable)
    #expect(unavailable.terminalSummaryText(for: question) == "Unavailable")
    #expect(!unavailable.apply(record: questionRecord()))
    #expect(unavailable.status() == .unavailable)
}

@MainActor
@Test func `question card skip transitions to persistent skipped summary`() {
    let model = OpenClawQuestionCardModel(record: questionRecord())

    #expect(model.beginSkip())
    #expect(model.isSkipping)
    model.markSkippedLocally()

    #expect(model.status() == .cancelled)
    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Skipped")
}
