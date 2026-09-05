package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionAnswers
import ai.openclaw.app.gateway.QuestionGetResult
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionOption
import ai.openclaw.app.gateway.QuestionRecord
import ai.openclaw.app.gateway.QuestionSecretStore
import ai.openclaw.app.ui.chat.questionCountdown
import ai.openclaw.app.ui.chat.terminalQuestionAnswer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatQuestionTest {
  private val json = chatControllerTestJson
  private val ChatController.onlyQuestion: ChatQuestionPrompt
    get() = questions.value.single()

  private val question =
    Question(
      questionId = "meal",
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
  fun secretDraftPreservesBytesWhileNormalAnswersTrim() {
    for (isSecret in listOf(false, true)) {
      val textQuestion = question.copy(options = emptyList(), isSecret = isSecret)
      for (value in listOf(" synthetic-value \t\n", "   ", "")) {
        val normalized = if (isSecret) value else value.trim()
        val expected = if (normalized.isEmpty()) null else mapOf("meal" to listOf(normalized))
        assertEquals(expected, ChatQuestionDraft().setOther(textQuestion, value).answers(listOf(textQuestion)))
      }
    }
  }

  @Test
  fun credentialSubmissionSendsEditedHostsAndRetainsOnlyStoredMarker() =
    runTest {
      val secret = question.copy(options = emptyList(), isSecret = true, secretStore = QuestionSecretStore("TASK_TOKEN", "secret", listOf("api.example.test")))
      val pending = record().copy(questions = listOf(secret))
      for (hosts in listOf(null, "uploads.example.test,\n api.example.test", "")) {
        var request: String? = null
        val controller =
          createScriptedChatController {
            respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
            respond("question.resolve") { params ->
              request = params
              """{"status":"answered","answers":{"answers":{"meal":["stored"]}}}"""
            }
          }
        controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
        runCurrent()
        controller.updateQuestionDraft(controller.onlyQuestion) {
          it.setOther(secret, "  synthetic-value  ").copy(secretStoreAllowedHostsText = hosts)
        }
        controller.resolveQuestion(controller.onlyQuestion, checkNotNull(controller.onlyQuestion.draft.answers(pending.questions)))
        runCurrent()
        val params = json.parseToJsonElement(checkNotNull(request)).jsonObject
        val expectedHosts =
          when (hosts) {
            null -> listOf("api.example.test")
            "" -> emptyList()
            else -> listOf("uploads.example.test", "api.example.test")
          }
        assertEquals(expectedHosts, params.getValue("secretStoreAllowedHosts").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(
          "  synthetic-value  ",
          params
            .getValue("answers")
            .jsonObject
            .getValue("answers")
            .jsonObject
            .getValue("meal")
            .jsonArray
            .single()
            .jsonPrimitive.content,
        )
        assertEquals(QuestionAnswers(mapOf("meal" to listOf("stored"))), controller.onlyQuestion.record.answers)
        assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)
        assertEquals("Answered", terminalQuestionAnswer(controller.onlyQuestion, secret, ChatQuestionStatus.Answered))
      }
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
            answers = QuestionAnswers(mapOf("meal" to listOf("Pizza", "Salad"))),
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
  fun staleQuestionListCannotOverwriteNewerEvent() =
    runTest {
      val listStarted = CompletableDeferred<Unit>()
      val listResponse = CompletableDeferred<String>()
      var listCallCount = 0
      val controller =
        createScriptedChatController {
          respond("question.list") {
            listCallCount += 1
            if (listCallCount == 1) {
              listStarted.complete(Unit)
              listResponse.await()
            } else {
              json.encodeToString(QuestionListResult(listOf(record(id = "ask_new"))))
            }
          }
        }

      controller.handleGatewayEvent("health", null)
      runCurrent()
      listStarted.await()
      controller.handleGatewayEvent("question.requested", json.encodeToString(record(id = "ask_new")))
      listResponse.complete(json.encodeToString(QuestionListResult(listOf(record(id = "ask_old")))))
      advanceUntilIdle()

      assertEquals(listOf("ask_new"), controller.questions.value.map { it.record.id })
    }

  @Test
  fun structuredMissingQuestionScopeClearsStaleCards() =
    runTest {
      val controller =
        createScriptedChatController {
          respond("question.list") {
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
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(record(id = "ask_stale")))
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(controller.questions.value.isEmpty())
    }

  @Test
  fun gatewayWithoutQuestionListClearsStaleCardsWithoutRequestingQuestions() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesMethod = { method -> method != "question.list" }
          respond("question.list") {
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "missing scope: operator.admin",
              ),
            )
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(record(id = "ask_stale")))
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(requests.none { it.first == "question.list" })
      assertTrue(controller.questions.value.isEmpty())
    }

  @Test
  fun pendingRefreshPreservesSubmissionLock() =
    runTest {
      val resolveStarted = CompletableDeferred<Unit>()
      val resolveResponse = CompletableDeferred<String>()
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
          respond("question.resolve") {
            resolveStarted.complete(Unit)
            resolveResponse.await()
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.resolveQuestion(controller.onlyQuestion, mapOf("meal" to listOf("Pizza")))
      runCurrent()
      resolveStarted.await()
      controller.handleGatewayEvent("health", null)
      runCurrent()

      assertEquals(ChatQuestionStatus.Submitting, controller.onlyQuestion.status(nowMs = 3_000))
      assertFalse(controller.onlyQuestion.answeredLocally)
      resolveResponse.complete("""{"status":"answered","answers":{"answers":{"meal":["Pizza"]}}}""")
      advanceUntilIdle()
      assertEquals(ChatQuestionStatus.Answered, controller.onlyQuestion.status())
    }

  @Test
  fun replayedPendingEventCannotReopenResolvedQuestion() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val controller = createChatController()

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent("question.resolved", """{"id":"ask_123","status":"answered"}""")
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))

      assertEquals(ChatQuestionStatus.AnsweredElsewhere, controller.onlyQuestion.status())
    }

  @Test
  fun pendingListRecordCannotReopenResolvedQuestion() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent("question.resolved", """{"id":"ask_123","status":"cancelled"}""")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(ChatQuestionStatus.Cancelled, controller.onlyQuestion.status())
    }

  @Test
  fun resolvedEventReconcilesAfterDiscardingOlderList() =
    runTest {
      val firstListStarted = CompletableDeferred<Unit>()
      val firstListResponse = CompletableDeferred<String>()
      var listCallCount = 0
      val controller =
        createScriptedChatController {
          respond("question.list") {
            listCallCount += 1
            if (listCallCount == 1) {
              firstListStarted.complete(Unit)
              firstListResponse.await()
            } else {
              json.encodeToString(QuestionListResult(listOf(record(id = "ask_other"))))
            }
          }
        }

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
  fun questionListRetainsResolvedSummaryPermanently() =
    runTest {
      val pending = record(id = "ask_done", expiresAtMs = Long.MAX_VALUE)
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(emptyList())))
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent(
        "question.resolved",
        """{"id":"ask_done","status":"answered"}""",
      )
      runCurrent()

      assertEquals(listOf("ask_done"), controller.questions.value.map { it.record.id })
      assertEquals(ChatQuestionStatus.AnsweredElsewhere, controller.onlyQuestion.status())

      advanceTimeBy(60_000)
      runCurrent()

      assertEquals(listOf("ask_done"), controller.questions.value.map { it.record.id })
    }

  @Test
  fun locallyExpiredQuestionRemainsAsSummary() =
    runTest {
      val controller = createChatController()
      val pending = record(expiresAtMs = 1_000)

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      advanceUntilIdle()

      assertEquals(ChatQuestionStatus.Expired, controller.onlyQuestion.status())
    }

  @Test
  fun localExpiryReconcilesMissedRemoteAnswer() =
    runTest {
      val pending = record(expiresAtMs = System.currentTimeMillis() + 1_000)
      val answered = pending.copy(status = "answered")
      var listCalls = 0
      var getCalls = 0
      val controller =
        createScriptedChatController {
          respond("question.list") {
            listCalls += 1
            json.encodeToString(QuestionListResult(if (listCalls == 1) listOf(pending) else emptyList()))
          }
          respond("question.get") {
            getCalls += 1
            json.encodeToString(QuestionGetResult(answered))
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      advanceTimeBy(2_000)
      advanceUntilIdle()

      assertEquals(2, listCalls)
      assertEquals(1, getCalls)
      assertEquals(ChatQuestionStatus.AnsweredElsewhere, controller.onlyQuestion.status())
    }

  @Test
  fun missingPendingQuestionUsesPerIdGetFallback() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val answered =
        pending.copy(
          status = "answered",
          answers = QuestionAnswers(mapOf("meal" to listOf("Tacos"))),
        )
      var getParams: String? = null
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(emptyList())))
          respond("question.get") { params ->
            getParams = params
            json.encodeToString(QuestionGetResult(answered))
          }
        }

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
        controller.onlyQuestion.record.answers
          ?.answers
          ?.get("meal"),
      )
      assertEquals(ChatQuestionStatus.AnsweredElsewhere, controller.onlyQuestion.status())
    }

  @Test
  fun successfulRefreshRecordsApplyWhenAnotherFallbackFails() =
    runTest {
      val listedPending = record(id = "ask_listed")
      val recoveredPending = record(id = "ask_recovered")
      val failingPending = record(id = "ask_failing")
      val newlyMissingPending = record(id = "ask_newly_missing")
      val listedAnswered =
        listedPending.copy(
          status = "answered",
          answers = QuestionAnswers(mapOf("meal" to listOf("Tacos"))),
        )
      val recoveredAnswered = recoveredPending.copy(status = "answered")
      val failingAnswered = failingPending.copy(status = "answered")
      val newlyMissingAnswered = newlyMissingPending.copy(status = "answered")
      val getCalls = mutableMapOf<String, Int>()
      var fallbackFailed = false
      val controller =
        createScriptedChatController {
          respond("question.list") {
            val records =
              if (!fallbackFailed) {
                listOf(listedAnswered, newlyMissingPending)
              } else {
                listOf(listedAnswered)
              }
            json.encodeToString(QuestionListResult(records))
          }
          respond("question.get") { params ->
            val id =
              json
                .parseToJsonElement(checkNotNull(params))
                .jsonObject
                .getValue("id")
                .jsonPrimitive
                .content
            getCalls[id] = getCalls.getOrDefault(id, 0) + 1
            when (id) {
              recoveredPending.id -> {
                json.encodeToString(
                  QuestionGetResult(
                    if (getCalls.getValue(id) == 1) recoveredPending else recoveredAnswered,
                  ),
                )
              }

              newlyMissingPending.id -> {
                json.encodeToString(QuestionGetResult(newlyMissingAnswered))
              }

              failingPending.id -> {
                if (getCalls.getValue(id) == 1) {
                  fallbackFailed = true
                  error("temporary question.get failure")
                }
                json.encodeToString(QuestionGetResult(failingAnswered))
              }

              else -> {
                error("unexpected question id")
              }
            }
          }
        }

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
          ?.get("meal"),
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
  fun questionGetRetryResetsExhaustedBudgetAfterAnotherQuestionChanges() =
    runTest {
      val recovering = record(id = "ask_recovering")
      val unrelated = record(id = "ask_unrelated")
      val recovered = recovering.copy(status = "answered")
      var getCalls = 0
      val finalGetStarted = CompletableDeferred<Unit>()
      val releaseFinalGet = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(unrelated))))
          respond("question.get") {
            getCalls += 1
            if (getCalls < 4) error("temporary question.get failure")
            if (getCalls == 4) {
              finalGetStarted.complete(Unit)
              releaseFinalGet.await()
            }
            json.encodeToString(QuestionGetResult(recovered))
          }
          respond("question.resolve", """{"status":"cancelled"}""")
        }

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

      controller.skipQuestion(controller.questions.value.single { it.record.id == unrelated.id })
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
  fun questionGetRetryResetsBudgetWhenRevisionChangesDuringFinalBackoff() =
    runTest {
      val recovering = record(id = "ask_recovering")
      val unrelated = record(id = "ask_unrelated")
      val recovered = recovering.copy(status = "answered")
      var getCalls = 0
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(unrelated))))
          respond("question.get") {
            getCalls += 1
            if (getCalls < 5) error("temporary question.get failure")
            json.encodeToString(QuestionGetResult(recovered))
          }
          respond("question.resolve", """{"status":"cancelled"}""")
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(recovering))
      controller.handleGatewayEvent("question.requested", json.encodeToString(unrelated))
      runCurrent()
      advanceTimeBy(1_000)
      runCurrent()
      advanceTimeBy(2_000)
      runCurrent()
      assertEquals(3, getCalls)

      controller.skipQuestion(controller.questions.value.single { it.record.id == unrelated.id })
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
  fun locallyExpiredMissingQuestionUsesPerIdGetFallback() =
    runTest {
      val pending = record(expiresAtMs = 0)
      val answered =
        pending.copy(
          status = "answered",
          answers = QuestionAnswers(mapOf("meal" to listOf("Tacos"))),
        )
      var getCalls = 0
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(emptyList())))
          respond("question.get") {
            getCalls += 1
            json.encodeToString(QuestionGetResult(answered))
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()

      assertEquals(1, getCalls)
      assertEquals(
        listOf("Tacos"),
        controller.onlyQuestion.record.answers
          ?.answers
          ?.get("meal"),
      )
      assertEquals(ChatQuestionStatus.AnsweredElsewhere, controller.onlyQuestion.status())
    }

  @Test
  fun missingQuestionGetRetriesAfterOneTwoAndFourSeconds() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      var getCalls = 0
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(emptyList())))
          respond("question.get") {
            getCalls += 1
            if (getCalls < 4) error("temporary question.get failure")
            json.encodeToString(QuestionGetResult(pending))
          }
        }

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
  fun missingQuestionNotFoundHasUnknownTerminalOutcome() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val releaseLookup = CompletableDeferred<Unit>()
      var getCalls = 0
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(emptyList())))
          respond("question.get") {
            getCalls += 1
            releaseLookup.await()
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
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      val rendered = controller.onlyQuestion
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Unsent answer") }
      releaseLookup.complete(Unit)
      advanceUntilIdle()

      assertEquals(ChatQuestionStatus.Unavailable, controller.onlyQuestion.status())
      assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Stale input") }
      assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(1, getCalls)
      assertEquals(ChatQuestionStatus.Unavailable, controller.onlyQuestion.status())
    }

  @Test
  fun skipUsesCancelResolutionAndKeepsSkippedSummary() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      var resolveParams: String? = null
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
          respond("question.resolve") { params ->
            resolveParams = params
            """{"status":"cancelled"}"""
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.skipQuestion(controller.onlyQuestion)
      advanceUntilIdle()

      val params = json.parseToJsonElement(checkNotNull(resolveParams)).jsonObject
      assertEquals("ask_123", params["id"]?.jsonPrimitive?.content)
      assertTrue(params["cancel"]?.jsonPrimitive?.content?.toBoolean() == true)
      assertFalse("answers" in params)
      assertEquals(ChatQuestionStatus.Cancelled, controller.onlyQuestion.status())
    }

  @Test
  fun skipClaimExposesSkippingProgress() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("question.resolve") {
            resolveStarted.complete(Unit)
            releaseResolve.await()
            """{"status":"cancelled"}"""
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      controller.skipQuestion(controller.onlyQuestion)
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
  fun answerClaimBlocksCompetingSkip() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val requestStarted = CompletableDeferred<Unit>()
      val releaseRequest = CompletableDeferred<Unit>()
      val resolveParams = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
          respond("question.resolve") { params ->
            resolveParams.add(checkNotNull(params))
            requestStarted.complete(Unit)
            releaseRequest.await()
            """{"status":"answered","answers":{"answers":{"meal":["Pizza"]}}}"""
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      val rendered = controller.onlyQuestion
      controller.resolveQuestion(rendered, mapOf("meal" to listOf("Pizza")))
      runCurrent()
      requestStarted.await()
      controller.skipQuestion(rendered)
      releaseRequest.complete(Unit)
      advanceUntilIdle()

      assertEquals(1, resolveParams.size)
      assertFalse("cancel" in resolveParams.single())
      assertEquals(ChatQuestionStatus.Answered, controller.onlyQuestion.status())
    }

  @Test
  fun pendingDraftEditsComposeAndSurviveRefreshAndSessionNavigation() =
    runTest {
      val pending = record()
      val listResponse = CompletableDeferred<String>()
      val controller =
        createScriptedChatController {
          respond("question.list") { listResponse.await() }
        }
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      val rendered = controller.onlyQuestion
      controller.updateQuestionDraft(rendered) { it.toggle(question, "Pizza") }
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Salad") }
      controller.switchSession("agent:main:other")
      controller.switchSession("agent:main:main")
      listResponse.complete(json.encodeToString(QuestionListResult(listOf(pending, record(id = "second")))))
      runCurrent()

      val retained = controller.questions.value.single { it.record.id == pending.id }
      assertEquals(mapOf("meal" to listOf("Pizza", "Salad")), retained.draft.answers(pending.questions))
      assertEquals(2, controller.questions.value.size)
    }

  @Test
  fun replacedQuestionRejectsOldDraftEvenWhenOriginalDefinitionReturns() =
    runTest {
      val pending = record()
      val replacements =
        listOf(
          pending.copy(questions = listOf(question.copy(question = "Choose lunch"))),
          pending.copy(agentId = "other"),
          pending.copy(sessionKey = "agent:main:other"),
          pending.copy(runId = "other-run"),
          pending.copy(createdAtMs = 2_000),
          pending.copy(expiresAtMs = Long.MAX_VALUE - 1),
        )
      for (replacement in replacements) {
        var listed = pending
        val controller =
          createScriptedChatController {
            respond("question.list") { json.encodeToString(QuestionListResult(listOf(listed))) }
          }
        controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
        runCurrent()
        val rendered = controller.onlyQuestion
        controller.updateQuestionDraft(rendered) { it.setOther(question, "Original draft") }
        listed = replacement
        controller.handleGatewayEvent("question.requested", json.encodeToString(replacement))
        runCurrent()
        assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)

        listed = pending
        controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
        runCurrent()
        controller.updateQuestionDraft(rendered) { it.setOther(question, "Stale input") }
        assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)
        controller.updateQuestionDraft(controller.onlyQuestion) { it.setOther(question, "Current input") }
        assertEquals(mapOf("meal" to listOf("Current input")), controller.onlyQuestion.draft.answers(pending.questions))
        controller.onGatewayScopeChanging()
      }
    }

  @Test
  fun gatewayRetirementDropsDraftAndRejectsOldInputAfterIdenticalQuestionReload() =
    runTest {
      val pending = record()
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
        }
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      val rendered = controller.onlyQuestion
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Draft on old gateway") }
      controller.onGatewayScopeChanging()
      assertTrue(controller.questions.value.isEmpty())
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Stale input") }
      assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)
    }

  @Test
  fun terminalQuestionClearsSecretDraftAndRejectsRetainedInputCallbacks() =
    runTest {
      val secret = question.copy(options = emptyList(), multiSelect = false, isSecret = true, secretStore = QuestionSecretStore("TASK_TOKEN", "secret"))
      val pending = record().copy(questions = listOf(secret), runId = "task-secret-run")
      for (terminal in listOf("answered", "cancelled", "expired")) {
        var listed = listOf(pending)
        val controller =
          createScriptedChatController {
            respond("question.list") { json.encodeToString(QuestionListResult(listed)) }
          }
        controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
        runCurrent()
        val rendered = controller.onlyQuestion
        controller.updateQuestionDraft(rendered) { it.setOther(secret, "task-only-secret-value") }
        assertTrue(
          controller.onlyQuestion.draft.otherText
            .isNotEmpty(),
        )
        listed = emptyList()
        val outcome = if (terminal == "answered") ",\"answers\":{\"answers\":{\"meal\":[\"stored\"]}}" else ""
        controller.handleGatewayEvent("question.resolved", """{"id":"ask_123","status":"$terminal"$outcome}""")
        runCurrent()
        assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)
        controller.updateQuestionDraft(rendered) { it.setOther(secret, "Stale input") }
        assertEquals(ChatQuestionDraft(), controller.onlyQuestion.draft)
      }
    }

  @Test
  fun failedQuestionSubmissionPreservesDraftAndBlocksEditsDuringSubmission() =
    runTest {
      val pending = record()
      val response = CompletableDeferred<String>()
      val controller =
        createScriptedChatController {
          respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
          respond("question.resolve") { response.await() }
        }
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      val rendered = controller.onlyQuestion
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Try again") }
      controller.resolveQuestion(controller.onlyQuestion, checkNotNull(controller.onlyQuestion.draft.answers(pending.questions)))
      runCurrent()
      controller.updateQuestionDraft(rendered) { it.setOther(question, "Cannot edit while submitting") }
      response.completeExceptionally(IllegalStateException("Gateway unavailable"))
      runCurrent()

      assertEquals(ChatQuestionStatus.Pending, controller.onlyQuestion.status())
      assertEquals("Gateway unavailable", controller.onlyQuestion.errorText)
      assertEquals(mapOf("meal" to listOf("Try again")), controller.onlyQuestion.draft.answers(pending.questions))
    }

  @Test
  fun replacedQuestionDoesNotInheritAnOlderSubmissionClaim() =
    runTest {
      val pending = record()
      val response = CompletableDeferred<String>()
      var listed = pending
      val controller =
        createScriptedChatController {
          respond("question.list") { json.encodeToString(QuestionListResult(listOf(listed))) }
          respond("question.resolve") { response.await() }
        }
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      controller.updateQuestionDraft(controller.onlyQuestion) { it.setOther(question, "Original answer") }
      controller.resolveQuestion(controller.onlyQuestion, mapOf("meal" to listOf("Original answer")))
      runCurrent()
      assertEquals(ChatQuestionStatus.Submitting, controller.onlyQuestion.status())

      listed = pending.copy(questions = listOf(question.copy(question = "Choose lunch")))
      controller.handleGatewayEvent("question.requested", json.encodeToString(listed))
      runCurrent()
      val replacement = controller.onlyQuestion
      response.complete("""{"status":"answered","answers":{"answers":{"meal":["Original answer"]}}}""")
      runCurrent()

      assertEquals(ChatQuestionStatus.Pending, replacement.status())
      assertEquals(ChatQuestionDraft(), replacement.draft)
      assertEquals(replacement, controller.onlyQuestion)
    }

  @Test
  fun retiredQuestionResolutionCannotMutateReloadedQuestionWithSameId() =
    runTest {
      for (fails in listOf(false, true)) {
        val pending = record()
        val response = CompletableDeferred<String>()
        val controller =
          createScriptedChatController {
            respond("question.list", json.encodeToString(QuestionListResult(listOf(pending))))
            respond("question.resolve") { response.await() }
          }
        controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
        runCurrent()
        controller.resolveQuestion(controller.onlyQuestion, mapOf("meal" to listOf("Pizza")))
        runCurrent()
        assertEquals(ChatQuestionStatus.Submitting, controller.onlyQuestion.status())
        controller.onGatewayScopeChanging()
        controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
        runCurrent()
        val replacement = controller.onlyQuestion
        if (fails) {
          response.completeExceptionally(IllegalStateException("Retired request failed"))
        } else {
          response.complete("""{"status":"answered","answers":{"answers":{"meal":["Pizza"]}}}""")
        }
        runCurrent()
        assertEquals(replacement, controller.onlyQuestion)
      }
    }

  @Test
  fun secretResolutionResponsePreservesAuthoritativeAnswerAfterResolvedEvent() =
    runTest {
      val secret = question.copy(options = emptyList(), multiSelect = false, isSecret = true, secretStore = QuestionSecretStore("TASK_TOKEN", "secret"))
      val pending = record().copy(questions = listOf(secret), runId = "task-secret-run")
      val stored = QuestionAnswers(mapOf("meal" to listOf("stored")))
      val resolveStarted = CompletableDeferred<Unit>()
      val resolveResponse = CompletableDeferred<String>()
      var listed = listOf(pending)
      val controller =
        createScriptedChatController {
          respond("question.list") { json.encodeToString(QuestionListResult(listed)) }
          respond("question.resolve") {
            resolveStarted.complete(Unit)
            resolveResponse.await()
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      controller.resolveQuestion(controller.onlyQuestion, mapOf("meal" to listOf("task-only-secret-value")))
      runCurrent()
      resolveStarted.await()
      listed = emptyList()
      controller.handleGatewayEvent(
        "question.resolved",
        """{"id":"ask_123","status":"answered","answers":{"answers":{"meal":["stored"]}}}""",
      )
      runCurrent()
      assertEquals(stored, controller.onlyQuestion.record.answers)

      resolveResponse.complete("""{"status":"answered","answers":{"answers":{"meal":["stored"]}}}""")
      advanceUntilIdle()

      assertEquals(ChatQuestionStatus.Answered, controller.onlyQuestion.status())
      assertEquals(stored, controller.onlyQuestion.record.answers)
    }

  @Test
  fun successfulAnswerOverridesUnavailableRecoveryRace() =
    runTest {
      val pending = record(expiresAtMs = Long.MAX_VALUE)
      val resolveStarted = CompletableDeferred<Unit>()
      val releaseResolve = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("question.list") {
            json.encodeToString(
              QuestionListResult(if (resolveStarted.isCompleted) emptyList() else listOf(pending)),
            )
          }
          respond("question.get") {
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
          respond("question.resolve") {
            resolveStarted.complete(Unit)
            releaseResolve.await()
            """{"status":"answered","answers":{"answers":{"meal":["Pizza"]}}}"""
          }
        }

      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      controller.resolveQuestion(controller.onlyQuestion, mapOf("meal" to listOf("Pizza")))
      runCurrent()
      resolveStarted.await()
      controller.handleGatewayEvent("health", null)
      runCurrent()
      assertEquals(ChatQuestionStatus.Unavailable, controller.onlyQuestion.status())

      releaseResolve.complete(Unit)
      advanceUntilIdle()

      assertEquals(ChatQuestionStatus.Answered, controller.onlyQuestion.status())
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
