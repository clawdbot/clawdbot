import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
private func questionRecord(
    multiSelect: Bool = false,
    isSecret: Bool = false,
    secretStore: QuestionSecretStoreBinding? = nil,
    isOther: Bool = true,
    createdAtMs: Int = 1_000_000,
    expiresAtMs: Int = 4_000_000_000_000,
    status: QuestionStatus = .pending,
    answers: QuestionAnswers? = nil,
    runId: String? = "run-question") -> QuestionRecord
{
    QuestionRecord(
        id: "ask_123",
        questions: [
            Question(
                questionid: "meal",
                header: "Meal",
                question: "Choose dinner",
                options: isSecret ? [] : [
                    QuestionOption(label: "Pizza", description: "Fast"),
                    QuestionOption(label: "Tacos"),
                ],
                multiselect: multiSelect,
                isother: isOther,
                issecret: isSecret,
                secretstore: secretStore),
        ],
        agentid: "main",
        sessionkey: "agent:main:main",
        runid: runId,
        createdatms: createdAtMs,
        expiresatms: expiresAtMs,
        status: status,
        answers: answers)
}

@MainActor
struct ChatQuestionCardTests {
    @Test func `question card single select and other are exclusive`() {
        let model = OpenClawQuestionCardModel(record: questionRecord())
        model.toggleOption(questionID: "meal", label: "Pizza")
        #expect(model.beginSubmission() == ["meal": ["Pizza"]])
        model.failSubmission("retry")

        model.setOtherText(questionID: "meal", value: "  Salad  ")
        #expect(model.selectedOptions["meal"]?.isEmpty == true)
        #expect(model.beginSubmission() == ["meal": ["Salad"]])
    }

    @Test func `question card multi select uses declared option order`() {
        let model = OpenClawQuestionCardModel(record: questionRecord(multiSelect: true))
        model.toggleOption(questionID: "meal", label: "Tacos")
        model.toggleOption(questionID: "meal", label: "Pizza")
        #expect(model.beginSubmission() == ["meal": ["Pizza", "Tacos"]])
    }

    @Test func `question card number selection uses declared option order`() {
        let model = OpenClawQuestionCardModel(record: questionRecord(multiSelect: true))

        #expect(model.toggleOption(questionID: "meal", optionNumber: 2))
        #expect(model.toggleOption(questionID: "meal", optionNumber: 1))
        #expect(!model.toggleOption(questionID: "meal", optionNumber: 4))
        #expect(model.beginSubmission() == ["meal": ["Pizza", "Tacos"]])
    }

    @Test func `question card maps expiry and answer origin`() {
        let now = Date(timeIntervalSince1970: 1500)
        let expired = OpenClawQuestionCardModel(record: questionRecord(expiresAtMs: 1_499_000))
        #expect(expired.status(at: now) == .expired)
        #expect(expired.remainingSeconds(at: now) == 0)

        let remote = OpenClawQuestionCardModel(record: questionRecord())
        remote.apply(resolved: OpenClawQuestionResolvedEvent(id: remote.id, status: .answered))
        #expect(remote.status(at: Date(timeIntervalSince1970: 1500)) == .answeredElsewhere)

        let local = OpenClawQuestionCardModel(record: questionRecord())
        local.markAnsweredLocally(answers: QuestionAnswers(answers: ["meal": AnyCodable(["Pizza"])]))
        local.apply(resolved: OpenClawQuestionResolvedEvent(id: local.id, status: .answered))
        #expect(local.status(at: Date(timeIntervalSince1970: 1500)) == .answered)
    }

    @Test func `question card pending refresh preserves submission`() {
        let model = OpenClawQuestionCardModel(record: questionRecord(expiresAtMs: Int.max))
        model.toggleOption(questionID: "meal", label: "Pizza")
        #expect(model.beginSubmission() != nil)

        #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, expiresAtMs: Int.max)))
        #expect(model.status(at: Date(timeIntervalSince1970: 1500)) == .submitting)

        #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, expiresAtMs: Int.max, status: .answered)))
        #expect(model.status(at: Date(timeIntervalSince1970: 1500)) == .answeredElsewhere)
    }

    @Test func `question card ignores replayed pending record after terminal event`() {
        let model = OpenClawQuestionCardModel(record: questionRecord())
        model.apply(resolved: .init(id: model.id, status: .answered))

        #expect(!model.apply(record: questionRecord(createdAtMs: 2_000_000)))
        #expect(model.status() == .answeredElsewhere)
    }

    @Test func `question card preserves canonical answers across answerless refresh`() throws {
        let model = OpenClawQuestionCardModel(record: questionRecord())
        model.toggleOption(questionID: "meal", label: "Pizza")
        let answers = try #require(model.beginSubmission())
        model.markAnsweredLocally(answers: QuestionAnswers(answers: answers.mapValues(AnyCodable.init)))

        #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, status: .answered)))
        #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
    }

    @Test func `question card preserves canonical answers across answerless resolved event`() throws {
        let model = OpenClawQuestionCardModel(record: questionRecord())
        model.toggleOption(questionID: "meal", label: "Pizza")
        let answers = try #require(model.beginSubmission())
        model.markAnsweredLocally(answers: QuestionAnswers(answers: answers.mapValues(AnyCodable.init)))

        model.apply(resolved: .init(id: model.id, status: .answered))

        #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
    }

    @Test func `question card preserves run identity across local terminal records`() {
        let answered = OpenClawQuestionCardModel(record: questionRecord())
        answered.markAnsweredLocally(answers: QuestionAnswers(answers: ["meal": AnyCodable(["Pizza"])]))
        #expect(answered.record.runid == "run-question")

        let skipped = OpenClawQuestionCardModel(record: questionRecord())
        skipped.markSkippedLocally()
        #expect(skipped.record.runid == "run-question")

        let elsewhere = OpenClawQuestionCardModel(record: questionRecord())
        elsewhere.markAnsweredElsewhere()
        #expect(elsewhere.record.runid == "run-question")

        let resolved = OpenClawQuestionCardModel(record: questionRecord())
        resolved.apply(resolved: .init(id: resolved.id, status: .answered))
        #expect(resolved.record.runid == "run-question")

        let refreshed = OpenClawQuestionCardModel(record: questionRecord(answers: .init(answers: [:])))
        #expect(refreshed.apply(record: questionRecord(status: .answered, runId: "run-refresh")))
        #expect(refreshed.record.runid == "run-refresh")
    }

    @Test func `question card locally expired state remains terminal`() {
        let expiresAt = Date(timeIntervalSince1970: 1500)
        let model = OpenClawQuestionCardModel(record: questionRecord(expiresAtMs: 1_500_000))

        #expect(model.observeLocalExpiry(at: expiresAt))
        #expect(!model.observeLocalExpiry(at: expiresAt.addingTimeInterval(15)))
        #expect(model.status(at: expiresAt.addingTimeInterval(15)) == .expired)
    }

    @Test func `question card stores canonical answers in gateway record shape`() throws {
        let model = OpenClawQuestionCardModel(record: questionRecord())
        model.toggleOption(questionID: "meal", label: "Pizza")
        let answers = try #require(model.beginSubmission())
        model.markAnsweredLocally(answers: QuestionAnswers(answers: answers.mapValues(AnyCodable.init)))

        let data = try JSONEncoder().encode(model.record.answers)
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains("\"meal\":[\"Pizza\"]"))
        #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
    }

    @Test func `question completions override unavailable recovery race`() throws {
        let answered = OpenClawQuestionCardModel(record: questionRecord())
        answered.toggleOption(questionID: "meal", label: "Pizza")
        let answers = try #require(answered.beginSubmission())
        answered.markRecoveryUnavailable()
        answered.markAnsweredLocally(answers: QuestionAnswers(answers: answers.mapValues(AnyCodable.init)))
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

    @Test func `question card skip transitions to persistent skipped summary`() {
        let model = OpenClawQuestionCardModel(record: questionRecord())

        #expect(model.beginSkip())
        #expect(model.isSkipping)
        model.markSkippedLocally()

        #expect(model.status() == .cancelled)
        #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Skipped")
    }

    @Test(arguments: [" synthetic-value \t\n", "   ", ""])
    func `secret draft preserves bytes`(value: String) {
        let model = OpenClawQuestionCardModel(record: questionRecord(isSecret: true))
        model.setOtherText(questionID: "meal", value: value)
        #expect(model.beginSubmission() == (value.isEmpty ? nil : ["meal": [value]]))
    }

    @Test(arguments: ["answered", "cancelled", "expired", "unavailable", "localExpiry", "localSkip", "recovery"])
    func `terminal state discards secret draft`(transition: String) {
        let model = OpenClawQuestionCardModel(record: questionRecord(isSecret: true))
        model.setOtherText(questionID: "meal", value: "synthetic-only-value")
        switch transition {
        case "answered": model.apply(resolved: .init(id: model.id, status: .answered))
        case "cancelled": model.apply(resolved: .init(id: model.id, status: .cancelled))
        case "expired": model.apply(resolved: .init(id: model.id, status: .expired))
        case "unavailable": model.markRecoveryUnavailable()
        case "localExpiry": _ = model.observeLocalExpiry(at: Date(timeIntervalSince1970: 4_000_000_000))
        case "localSkip": model.markSkippedLocally()
        default: _ = model.apply(record: questionRecord(isSecret: true, status: .answered))
        }
        #expect(model.otherText.isEmpty)
        #expect(model.beginSubmission() == nil)
        model.setOtherText(questionID: "meal", value: "stale-callback")
        #expect(model.otherText.isEmpty)
    }

    @Test func `host consent preserves proposal and allows empty override`() {
        let model = OpenClawQuestionCardModel(record: questionRecord(
            isSecret: true,
            secretStore: .init(name: "TASK_TOKEN", kind: AnyCodable("secret"), allowedhosts: ["api.example.test"])))
        #expect(model.secretStoreAllowedHostsText == "api.example.test")
        #expect(model.secretStoreAllowedHosts == ["api.example.test"])
        model.secretStoreAllowedHostsText = " uploads.example.test,\n api.example.test "
        #expect(model.secretStoreAllowedHosts == ["uploads.example.test", "api.example.test"])
        model.secretStoreAllowedHostsText = ""
        model.setOtherText(questionID: "meal", value: "   ")
        #expect(model.secretStoreAllowedHosts == [])
        #expect(model.canSubmit)
        #expect(OpenClawQuestionCardModel(record: questionRecord()).secretStoreAllowedHosts == nil)
    }

    @Test func `only retryable validation preserves secret draft`() {
        let model = OpenClawQuestionCardModel(record: questionRecord(isSecret: true))
        model.setOtherText(questionID: "meal", value: "  synthetic-value  ")
        #expect(model.beginSubmission() != nil)
        model.failSubmission("Invalid hostname", preserveSecretDraft: true)
        #expect(model.otherText["meal"] == "  synthetic-value  ")
        #expect(model.beginSubmission() != nil)
        model.failSubmission("Disconnected")
        #expect(model.otherText.isEmpty)
    }
}
