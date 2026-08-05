package ai.openclaw.app.chat

import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionRecord

enum class ChatQuestionStatus {
  Pending,
  Submitting,
  Answered,
  AnsweredElsewhere,
  Expired,
  Cancelled,
  Unavailable,
}

data class ChatQuestionPrompt(
  val record: QuestionRecord,
  val submitting: Boolean = false,
  val skipping: Boolean = false,
  val answeredLocally: Boolean = false,
  val errorText: String? = null,
  val terminalObservedAtMs: Long? = null,
  val recoveryUnavailable: Boolean = false,
) {
  fun status(nowMs: Long = System.currentTimeMillis()): ChatQuestionStatus =
    if (recoveryUnavailable) {
      ChatQuestionStatus.Unavailable
    } else {
      when (record.status) {
        "answered" -> if (answeredLocally) ChatQuestionStatus.Answered else ChatQuestionStatus.AnsweredElsewhere
        "cancelled" -> ChatQuestionStatus.Cancelled
        "expired" -> ChatQuestionStatus.Expired
        else ->
          when {
            nowMs >= record.expiresAtMs -> ChatQuestionStatus.Expired
            submitting -> ChatQuestionStatus.Submitting
            else -> ChatQuestionStatus.Pending
          }
      }
    }
}

data class ChatQuestionDraft(
  val selectedOptions: Map<String, Set<String>> = emptyMap(),
  val otherText: Map<String, String> = emptyMap(),
) {
  fun toggle(
    question: Question,
    label: String,
  ): ChatQuestionDraft {
    if (question.options.none { it.label == label }) return this
    val selected = selectedOptions[question.questionId].orEmpty()
    val next =
      if (question.multiSelect == true) {
        if (label in selected) selected - label else selected + label
      } else if (selected == setOf(label)) {
        emptySet()
      } else {
        setOf(label)
      }
    return copy(
      selectedOptions = selectedOptions + (question.questionId to next),
      otherText = if (question.multiSelect != true && next.isNotEmpty()) otherText + (question.questionId to "") else otherText,
    )
  }

  fun setOther(
    question: Question,
    value: String,
  ): ChatQuestionDraft {
    if (question.options.isNotEmpty() && question.isOther != true) return this
    val clearOptions = question.multiSelect != true && value.isNotBlank()
    return copy(
      selectedOptions = if (clearOptions) selectedOptions + (question.questionId to emptySet()) else selectedOptions,
      otherText = otherText + (question.questionId to value),
    )
  }

  fun answers(questions: List<Question>): Map<String, List<String>>? {
    val result = linkedMapOf<String, List<String>>()
    for (question in questions) {
      val selected = selectedOptions[question.questionId].orEmpty()
      val values = question.options.mapNotNull { option -> option.label.takeIf { it in selected } }.toMutableList()
      otherText[question.questionId]?.trim()?.takeIf { it.isNotEmpty() }?.let(values::add)
      if (values.isEmpty()) return null
      result[question.questionId] = values
    }
    return result
  }
}

internal fun questionsForSession(
  prompts: List<ChatQuestionPrompt>,
  sessionKey: String,
  mainSessionKey: String,
  activeAgentId: String,
): List<ChatQuestionPrompt> {
  val main = mainSessionKey.trim().ifEmpty { "main" }
  val current = sessionKey.trim().let { if (it == "main") main else it }
  val activeAgent = activeAgentId.trim().lowercase()
  return prompts.filter { prompt ->
    val key = prompt.record.sessionKey?.trim() ?: return@filter true
    val sessionMatches = key == sessionKey || key == current || (key == "main" && current == main)
    val promptAgent =
      prompt.record.agentId
        ?.trim()
        .orEmpty()
        .lowercase()
    sessionMatches && (promptAgent.isEmpty() || activeAgent.isEmpty() || promptAgent == activeAgent)
  }
}
