package ai.openclaw.app.chat

import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionOption
import ai.openclaw.app.gateway.QuestionRecord
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatQuestionTest {
  private val question =
    Question(
      id = "meal",
      header = "Meal",
      question = "Choose dinner",
      options = listOf(QuestionOption("Pizza"), QuestionOption("Tacos")),
      multiSelect = true,
      isOther = true,
    )

  @Test
  fun multiSelectAnswersFollowDeclaredOrderAndIncludeOther() {
    val draft =
      ChatQuestionDraft()
        .toggle(question, "Tacos")
        .toggle(question, "Pizza")
        .setOther(question, " Salad ")

    assertEquals(mapOf("meal" to listOf("Pizza", "Tacos", "Salad")), draft.answers(listOf(question)))
  }

  @Test
  fun statusDistinguishesLocalRemoteAndExpiry() {
    val record = record(status = "pending", expiresAtMs = 2_000)
    assertEquals(ChatQuestionStatus.Expired, ChatQuestionPrompt(record).status(nowMs = 2_000))
    assertEquals(
      ChatQuestionStatus.AnsweredElsewhere,
      ChatQuestionPrompt(record.copy(status = "answered")).status(nowMs = 1_000),
    )
    assertEquals(
      ChatQuestionStatus.Answered,
      ChatQuestionPrompt(record.copy(status = "answered"), answeredLocally = true).status(nowMs = 1_000),
    )
  }

  @Test
  fun terminalPromptRetentionMatchesGatewayGrace() {
    val prompt =
      ChatQuestionPrompt(
        record = record(status = "answered"),
        terminalObservedAtMs = 1_000,
      )

    assertTrue(prompt.shouldRetainAfterList(15_999))
    assertFalse(prompt.shouldRetainAfterList(16_000))
  }

  @Test
  fun sessionFilterKeepsGlobalAndCurrentPrompts() {
    val prompts =
      listOf(
        ChatQuestionPrompt(record(sessionKey = null)),
        ChatQuestionPrompt(record(id = "current", sessionKey = "agent:main:main")),
        ChatQuestionPrompt(record(id = "other", sessionKey = "agent:main:other")),
        ChatQuestionPrompt(record(id = "foreign-main", sessionKey = "main", agentId = "other")),
      )
    val visible = questionsForSession(prompts, "main", "agent:main:main", "main")
    assertEquals(listOf("ask_123", "current"), visible.map { it.record.id })
    assertTrue(visible.all { it.status(1_000) == ChatQuestionStatus.Pending })
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleQuestionListCannotOverwriteNewerEvent() =
    runTest {
      val listStarted = CompletableDeferred<Unit>()
      val listResponse = CompletableDeferred<String>()
      val json = Json { ignoreUnknownKeys = true }
      var listCallCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "question.list") {
              listCallCount += 1
              if (listCallCount == 1) {
                listStarted.complete(Unit)
                listResponse.await()
              } else {
                json.encodeToString(QuestionListResult(listOf(record(id = "ask_new"))))
              }
            } else {
              "{}"
            }
          },
        )

      controller.handleGatewayEvent("health", null)
      runCurrent()
      listStarted.await()
      controller.handleGatewayEvent("question.requested", json.encodeToString(record(id = "ask_new")))
      listResponse.complete(json.encodeToString(QuestionListResult(listOf(record(id = "ask_old")))))
      advanceUntilIdle()

      assertEquals(listOf("ask_new"), controller.questions.value.map { it.record.id })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun pendingRefreshPreservesSubmissionLock() =
    runTest {
      val resolveStarted = CompletableDeferred<Unit>()
      val resolveResponse = CompletableDeferred<String>()
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(listOf(pending.copy(createdAtMs = 2_000))))
              "question.resolve" -> {
                resolveStarted.complete(Unit)
                resolveResponse.await()
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.resolveQuestion(pending.id, mapOf("meal" to listOf("Pizza")))
      runCurrent()
      resolveStarted.await()
      controller.handleGatewayEvent("health", null)
      runCurrent()

      assertEquals(
        ChatQuestionStatus.Submitting,
        controller.questions.value
          .single()
          .status(nowMs = 3_000),
      )
      assertFalse(
        controller.questions.value
          .single()
          .answeredLocally,
      )
      resolveResponse.complete("{}")
      advanceUntilIdle()
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun resolvedEventReconcilesAfterDiscardingOlderList() =
    runTest {
      val firstListStarted = CompletableDeferred<Unit>()
      val firstListResponse = CompletableDeferred<String>()
      val json = Json { ignoreUnknownKeys = true }
      var listCallCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method != "question.list") {
              "{}"
            } else {
              listCallCount += 1
              if (listCallCount == 1) {
                firstListStarted.complete(Unit)
                firstListResponse.await()
              } else {
                json.encodeToString(QuestionListResult(listOf(record(id = "ask_other"))))
              }
            }
          },
        )

      controller.handleGatewayEvent("health", null)
      runCurrent()
      firstListStarted.await()
      controller.handleGatewayEvent(
        "question.resolved",
        """{"id":"ask_done","status":"answered"}""",
      )
      runCurrent()
      firstListResponse.complete(json.encodeToString(QuestionListResult(listOf(record(id = "ask_done")))))
      advanceUntilIdle()

      assertEquals(listOf("ask_other"), controller.questions.value.map { it.record.id })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun questionListRetainsRecentlyResolvedCard() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(id = "ask_done", expiresAtMs = Long.MAX_VALUE)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> json.encodeToString(QuestionListResult(emptyList())) },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent(
        "question.resolved",
        """{"id":"ask_done","status":"answered"}""",
      )
      runCurrent()

      assertEquals(listOf("ask_done"), controller.questions.value.map { it.record.id })
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single()
          .status(),
      )

      advanceTimeBy(QUESTION_TERMINAL_RETENTION_MS)
      runCurrent()

      assertTrue(controller.questions.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun locallyExpiredQuestionIsEvictedAfterTerminalGrace() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val controller = ChatController(scope = this, json = json, requestGateway = { _, _ -> "{}" })
      val pending = record(expiresAtMs = 1_000)

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      advanceTimeBy(QUESTION_TERMINAL_RETENTION_MS + 1_001)
      runCurrent()

      assertTrue(controller.questions.value.isEmpty())
    }

  private fun record(
    id: String = "ask_123",
    status: String = "pending",
    expiresAtMs: Long = Long.MAX_VALUE,
    sessionKey: String? = "agent:main:main",
    agentId: String? = "main",
  ) = QuestionRecord(
    id = id,
    questions = listOf(question),
    agentId = agentId,
    sessionKey = sessionKey,
    createdAtMs = 1_000,
    expiresAtMs = expiresAtMs,
    status = status,
  )
}
