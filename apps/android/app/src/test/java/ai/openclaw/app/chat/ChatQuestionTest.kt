package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionAnswers
import ai.openclaw.app.gateway.QuestionAnswersAnswersValue
import ai.openclaw.app.gateway.QuestionGetResult
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionOption
import ai.openclaw.app.gateway.QuestionRecord
import ai.openclaw.app.ui.chat.questionCountdown
import ai.openclaw.app.ui.chat.terminalQuestionAnswer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
  fun terminalPromptsRemainInTheTimeline() {
    val prompt =
      ChatQuestionPrompt(
        record = record(status = "answered"),
        terminalObservedAtMs = 1_000,
      )

    assertEquals(ChatQuestionStatus.AnsweredElsewhere, prompt.status(nowMs = Long.MAX_VALUE))
  }

  @Test
  fun countdownMatchesWebMinuteSecondFormat() {
    assertEquals("1:05", questionCountdown(expiresAtMs = 65_000, nowMs = 0))
    assertEquals("0:05", questionCountdown(expiresAtMs = 4_001, nowMs = 0))
    assertEquals("0:00", questionCountdown(expiresAtMs = 1_000, nowMs = 2_000))
  }

  @Test
  fun terminalSummaryUsesAnswersAndStatusLabels() {
    val answered =
      ChatQuestionPrompt(
        record =
          record(status = "answered").copy(
            answers = QuestionAnswers(mapOf("meal" to QuestionAnswersAnswersValue(listOf("Pizza", "Salad")))),
          ),
        answeredLocally = true,
      )

    assertEquals("Pizza, Salad", terminalQuestionAnswer(answered, question, ChatQuestionStatus.Answered))
    assertEquals("Skipped", terminalQuestionAnswer(answered, question, ChatQuestionStatus.Cancelled))
    assertEquals("Expired", terminalQuestionAnswer(answered, question, ChatQuestionStatus.Expired))
    assertEquals("Unavailable", terminalQuestionAnswer(answered, question, ChatQuestionStatus.Unavailable))
    assertEquals(
      "Answered elsewhere",
      terminalQuestionAnswer(answered.copy(record = answered.record.copy(answers = null)), question, ChatQuestionStatus.AnsweredElsewhere),
    )
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
  fun structuredMissingQuestionScopeClearsStaleCards() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "question.list") {
              throw GatewayRequestRejected(
                GatewaySession.ErrorShape(
                  code = "FORBIDDEN",
                  message = "permission denied",
                  details =
                    GatewayErrorDetails(
                      code = "MISSING_SCOPE",
                      missingScope = "operator.questions",
                      requiredScopes = listOf("operator.questions"),
                      canRetryWithDeviceToken = false,
                      recommendedNextStep = null,
                    ),
                ),
              )
            }
            "{}"
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(record(id = "ask_stale")))
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(controller.questions.value.isEmpty())
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
  fun replayedPendingEventCannotReopenResolvedQuestion() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val controller = ChatController(scope = this, json = json, requestGateway = { _, _ -> "{}" })

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent("question.resolved", """{"id":"ask_123","status":"answered"}""")
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))

      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun pendingListRecordCannotReopenResolvedQuestion() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "question.list") json.encodeToString(QuestionListResult(listOf(pending))) else "{}"
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent("question.resolved", """{"id":"ask_123","status":"cancelled"}""")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(
        ChatQuestionStatus.Cancelled,
        controller.questions.value
          .single()
          .status(),
      )
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
  fun questionListRetainsResolvedSummaryPermanently() =
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

      advanceTimeBy(60_000)
      runCurrent()

      assertEquals(listOf("ask_done"), controller.questions.value.map { it.record.id })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun locallyExpiredQuestionRemainsAsSummary() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val controller = ChatController(scope = this, json = json, requestGateway = { _, _ -> "{}" })
      val pending = record(expiresAtMs = 1_000)

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      advanceUntilIdle()

      assertEquals(
        ChatQuestionStatus.Expired,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun localExpiryReconcilesMissedRemoteAnswer() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = System.currentTimeMillis() + 1_000)
      val answered = pending.copy(status = "answered")
      var listCalls = 0
      var getCalls = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> {
                listCalls += 1
                json.encodeToString(QuestionListResult(if (listCalls == 1) listOf(pending) else emptyList()))
              }
              "question.get" -> {
                getCalls += 1
                json.encodeToString(QuestionGetResult(answered))
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      advanceTimeBy(2_000)
      advanceUntilIdle()

      assertEquals(2, listCalls)
      assertEquals(1, getCalls)
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun missingPendingQuestionUsesPerIdGetFallback() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val answered =
        pending.copy(
          status = "answered",
          answers = QuestionAnswers(mapOf("meal" to QuestionAnswersAnswersValue(listOf("Tacos")))),
        )
      var getParams: String? = null
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(emptyList()))
              "question.get" -> {
                getParams = params
                json.encodeToString(QuestionGetResult(answered))
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      advanceUntilIdle()

      assertEquals(
        "ask_123",
        json
          .parseToJsonElement(checkNotNull(getParams))
          .jsonObject["id"]
          ?.jsonPrimitive
          ?.content,
      )
      assertEquals(
        listOf("Tacos"),
        controller.questions.value
          .single()
          .record.answers
          ?.answers
          ?.get("meal")
          ?.answers,
      )
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun successfulRefreshRecordsApplyWhenAnotherFallbackFails() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val listedPending = record(id = "ask_listed")
      val recoveredPending = record(id = "ask_recovered")
      val failingPending = record(id = "ask_failing")
      val newlyMissingPending = record(id = "ask_newly_missing")
      val listedAnswered =
        listedPending.copy(
          status = "answered",
          answers = QuestionAnswers(mapOf("meal" to QuestionAnswersAnswersValue(listOf("Tacos")))),
        )
      val recoveredAnswered = recoveredPending.copy(status = "answered")
      val failingAnswered = failingPending.copy(status = "answered")
      val newlyMissingAnswered = newlyMissingPending.copy(status = "answered")
      val getCalls = mutableMapOf<String, Int>()
      var fallbackFailed = false
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "question.list" -> {
                val records =
                  if (!fallbackFailed) {
                    listOf(listedAnswered, newlyMissingPending)
                  } else {
                    listOf(listedAnswered)
                  }
                json.encodeToString(QuestionListResult(records))
              }
              "question.get" -> {
                val id =
                  json
                    .parseToJsonElement(checkNotNull(params))
                    .jsonObject
                    .getValue("id")
                    .jsonPrimitive
                    .content
                getCalls[id] = getCalls.getOrDefault(id, 0) + 1
                when (id) {
                  recoveredPending.id ->
                    json.encodeToString(
                      QuestionGetResult(
                        if (getCalls.getValue(id) == 1) recoveredPending else recoveredAnswered,
                      ),
                    )
                  newlyMissingPending.id -> json.encodeToString(QuestionGetResult(newlyMissingAnswered))
                  failingPending.id -> {
                    if (getCalls.getValue(id) == 1) {
                      fallbackFailed = true
                      error("temporary question.get failure")
                    }
                    json.encodeToString(QuestionGetResult(failingAnswered))
                  }
                  else -> error("unexpected question id")
                }
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(listedPending))
      controller.handleGatewayEvent("question.requested", json.encodeToString(recoveredPending))
      controller.handleGatewayEvent("question.requested", json.encodeToString(failingPending))
      controller.handleGatewayEvent("question.requested", json.encodeToString(newlyMissingPending))
      runCurrent()

      val prompts = controller.questions.value.associateBy { it.record.id }
      assertEquals(ChatQuestionStatus.AnsweredElsewhere, prompts.getValue("ask_listed").status())
      assertEquals(
        listOf("Tacos"),
        prompts
          .getValue("ask_listed")
          .record
          .answers
          ?.answers
          ?.get("meal")
          ?.answers,
      )
      assertEquals(ChatQuestionStatus.Pending, prompts.getValue("ask_recovered").status())
      assertEquals(ChatQuestionStatus.Pending, prompts.getValue("ask_failing").status())
      assertEquals(ChatQuestionStatus.Pending, prompts.getValue("ask_newly_missing").status())

      advanceTimeBy(1_000)
      runCurrent()
      assertEquals(2, getCalls["ask_recovered"])
      assertEquals(2, getCalls["ask_failing"])
      assertEquals(1, getCalls["ask_newly_missing"])
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single { it.record.id == "ask_newly_missing" }
          .status(),
      )
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single { it.record.id == "ask_recovered" }
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun questionGetRetryResetsExhaustedBudgetAfterAnotherQuestionChanges() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val recovering = record(id = "ask_recovering")
      val unrelated = record(id = "ask_unrelated")
      val recovered = recovering.copy(status = "answered")
      var getCalls = 0
      val finalGetStarted = CompletableDeferred<Unit>()
      val releaseFinalGet = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(listOf(unrelated)))
              "question.get" -> {
                getCalls += 1
                if (getCalls < 4) error("temporary question.get failure")
                if (getCalls == 4) {
                  finalGetStarted.complete(Unit)
                  releaseFinalGet.await()
                }
                json.encodeToString(QuestionGetResult(recovered))
              }
              "question.resolve" -> "{}"
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(recovering))
      controller.handleGatewayEvent("question.requested", json.encodeToString(unrelated))
      runCurrent()
      assertEquals(1, getCalls)

      advanceTimeBy(1_000)
      runCurrent()
      advanceTimeBy(2_000)
      runCurrent()
      advanceTimeBy(4_000)
      runCurrent()
      finalGetStarted.await()
      assertEquals(4, getCalls)

      controller.skipQuestion(unrelated.id)
      runCurrent()
      releaseFinalGet.complete(Unit)
      runCurrent()
      advanceTimeBy(1_000)
      runCurrent()

      assertEquals(5, getCalls)
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single { it.record.id == recovering.id }
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun questionGetRetryResetsBudgetWhenRevisionChangesDuringFinalBackoff() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val recovering = record(id = "ask_recovering")
      val unrelated = record(id = "ask_unrelated")
      val recovered = recovering.copy(status = "answered")
      var getCalls = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(listOf(unrelated)))
              "question.get" -> {
                getCalls += 1
                if (getCalls < 5) error("temporary question.get failure")
                json.encodeToString(QuestionGetResult(recovered))
              }
              "question.resolve" -> "{}"
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(recovering))
      controller.handleGatewayEvent("question.requested", json.encodeToString(unrelated))
      runCurrent()
      advanceTimeBy(1_000)
      runCurrent()
      advanceTimeBy(2_000)
      runCurrent()
      assertEquals(3, getCalls)

      controller.skipQuestion(unrelated.id)
      runCurrent()
      advanceTimeBy(4_000)
      runCurrent()
      assertEquals(4, getCalls)
      advanceTimeBy(1_000)
      runCurrent()

      assertEquals(5, getCalls)
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single { it.record.id == recovering.id }
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun locallyExpiredMissingQuestionUsesPerIdGetFallback() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = 0)
      val answered =
        pending.copy(
          status = "answered",
          answers = QuestionAnswers(mapOf("meal" to QuestionAnswersAnswersValue(listOf("Tacos")))),
        )
      var getCalls = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(emptyList()))
              "question.get" -> {
                getCalls += 1
                json.encodeToString(QuestionGetResult(answered))
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()

      assertEquals(1, getCalls)
      assertEquals(
        listOf("Tacos"),
        controller.questions.value
          .single()
          .record.answers
          ?.answers
          ?.get("meal")
          ?.answers,
      )
      assertEquals(
        ChatQuestionStatus.AnsweredElsewhere,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun missingQuestionGetRetriesAfterOneTwoAndFourSeconds() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      var getCalls = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(emptyList()))
              "question.get" -> {
                getCalls += 1
                if (getCalls < 4) error("temporary question.get failure")
                json.encodeToString(QuestionGetResult(pending))
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      assertEquals(1, getCalls)
      advanceTimeBy(999)
      runCurrent()
      assertEquals(1, getCalls)
      advanceTimeBy(1)
      runCurrent()
      assertEquals(2, getCalls)
      advanceTimeBy(2_000)
      runCurrent()
      assertEquals(3, getCalls)
      advanceTimeBy(4_000)
      runCurrent()
      assertEquals(4, getCalls)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun missingQuestionNotFoundHasUnknownTerminalOutcome() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      var getCalls = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(emptyList()))
              "question.get" ->
                run {
                  getCalls += 1
                  throw GatewayRequestRejected(
                    GatewaySession.ErrorShape(
                      code = "INVALID_REQUEST",
                      message = "question not found",
                      details =
                        GatewayErrorDetails(
                          code = null,
                          reason = "QUESTION_NOT_FOUND",
                          canRetryWithDeviceToken = false,
                          recommendedNextStep = null,
                        ),
                    ),
                  )
                }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      advanceUntilIdle()

      assertEquals(
        ChatQuestionStatus.Unavailable,
        controller.questions.value
          .single()
          .status(),
      )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(1, getCalls)
      assertEquals(
        ChatQuestionStatus.Unavailable,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun skipUsesCancelResolutionAndKeepsSkippedSummary() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      var resolveParams: String? = null
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(listOf(pending)))
              "question.resolve" -> {
                resolveParams = params
                "{}"
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.skipQuestion(pending.id)
      advanceUntilIdle()

      val params = json.parseToJsonElement(checkNotNull(resolveParams)).jsonObject
      assertEquals("ask_123", params["id"]?.jsonPrimitive?.content)
      assertTrue(params["cancel"]?.jsonPrimitive?.content?.toBoolean() == true)
      assertFalse("answers" in params)
      assertEquals(
        ChatQuestionStatus.Cancelled,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun skipClaimExposesSkippingProgress() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.resolve" -> {
                resolveStarted.complete(Unit)
                releaseResolve.await()
                "{}"
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.skipQuestion(pending.id)
      runCurrent()
      resolveStarted.await()

      val submitting = controller.questions.value.single()
      assertEquals(ChatQuestionStatus.Submitting, submitting.status())
      assertTrue(submitting.submitting)
      assertTrue(submitting.skipping)

      releaseResolve.complete(Unit)
      advanceUntilIdle()

      val completed = controller.questions.value.single()
      assertEquals(ChatQuestionStatus.Cancelled, completed.status())
      assertFalse(completed.submitting)
      assertFalse(completed.skipping)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun answerClaimBlocksCompetingSkip() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val requestStarted = CompletableDeferred<Unit>()
      val releaseRequest = CompletableDeferred<Unit>()
      val resolveParams = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "question.list" -> json.encodeToString(QuestionListResult(listOf(pending)))
              "question.resolve" -> {
                resolveParams.add(checkNotNull(params))
                requestStarted.complete(Unit)
                releaseRequest.await()
                "{}"
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.resolveQuestion(pending.id, mapOf("meal" to listOf("Pizza")))
      runCurrent()
      requestStarted.await()
      controller.skipQuestion(pending.id)
      releaseRequest.complete(Unit)
      advanceUntilIdle()

      assertEquals(1, resolveParams.size)
      assertFalse("cancel" in resolveParams.single())
      assertEquals(
        ChatQuestionStatus.Answered,
        controller.questions.value
          .single()
          .status(),
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun successfulAnswerOverridesUnavailableRecoveryRace() =
    runTest {
      val json = Json { ignoreUnknownKeys = true }
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "question.list" ->
                json.encodeToString(
                  QuestionListResult(if (resolveStarted.isCompleted) emptyList() else listOf(pending)),
                )
              "question.get" ->
                throw GatewayRequestRejected(
                  GatewaySession.ErrorShape(
                    code = "INVALID_REQUEST",
                    message = "question not found",
                    details =
                      GatewayErrorDetails(
                        code = null,
                        reason = "QUESTION_NOT_FOUND",
                        canRetryWithDeviceToken = false,
                        recommendedNextStep = null,
                      ),
                  ),
                )
              "question.resolve" -> {
                resolveStarted.complete(Unit)
                releaseResolve.await()
                "{}"
              }
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      controller.resolveQuestion(pending.id, mapOf("meal" to listOf("Pizza")))
      runCurrent()
      resolveStarted.await()
      controller.handleGatewayEvent("health", null)
      runCurrent()
      assertEquals(
        ChatQuestionStatus.Unavailable,
        controller.questions.value
          .single()
          .status(),
      )

      releaseResolve.complete(Unit)
      advanceUntilIdle()

      assertEquals(
        ChatQuestionStatus.Answered,
        controller.questions.value
          .single()
          .status(),
      )
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
