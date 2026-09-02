package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelUnavailableReason
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.chat.ChatComposerTextDraftStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerModelSelectionTest {
  private val json = chatControllerTestJson

  @Test
  fun nativeModelLockSurvivesHistoryAndPartialSettingsWithoutLockingThinking() =
    runTest {
      val sessionKey = "agent:main:native"
      val thinking = thinkingFields("off", "off", "high")
      val (controller, requests) =
        chatControllerTestSetup {
          respond(
            "chat.history",
            """{"sessionId":"native-model-session","messages":[],"sessionInfo":{"key":"$sessionKey","agentId":"main","sessionId":"native-model-session","modelProvider":"synthetic","model":"outer-default","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"},$thinking}}""",
          )
          respond("sessions.list", """{"sessions":[]}""")
          respond("sessions.patch", """{"resolved":{"thinkingLevel":"high"}}""")
        }
      controller.load(sessionKey)
      advanceUntilIdle()

      assertFalse(controller.setSessionModelAwait(sessionKey, "openai/gpt-5.6-sol"))
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","thinkingLevel":"off","contextTokens":200000}}""",
      )
      controller.setThinkingLevel("high")
      advanceUntilIdle()

      assertEquals("high", controller.thinkingLevel.value)
      assertFalse(controller.setSessionModelAwait(sessionKey, null))
      val patch = json.parseToJsonElement(requests.single { it.first == "sessions.patch" }.second.orEmpty()) as JsonObject
      assertEquals(JsonPrimitive("high"), patch["thinkingLevel"])
      assertFalse("model" in patch)

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","modelSelectionLocked":false}}""",
      )
      assertTrue(controller.setSessionModelAwait(sessionKey, "openai/gpt-5.6-sol"))
    }

  @Test
  fun queuedModelSelectionRechecksNativeLockAtTransportEnqueue() =
    runTest {
      for (lockFromResponse in listOf(true, false)) {
        val thinkingStarted = CompletableDeferred<Unit>()
        val releaseThinking = CompletableDeferred<Unit>()
        val modelTransportStarted = CompletableDeferred<Unit>()
        val releaseModelTransport = CompletableDeferred<Unit>()
        val patches = mutableListOf<JsonObject>()
        val controller =
          createChatController(
            captureRequestLease = {
              GatewaySession.RequestLease(endpointStableId = "") { _, paramsJson, _, withEnqueue ->
                val patch = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                if ("model" in patch && !lockFromResponse) {
                  modelTransportStarted.complete(Unit)
                  releaseModelTransport.await()
                }
                withEnqueue { patches += patch }
                if ("thinkingLevel" in patch) {
                  thinkingStarted.complete(Unit)
                  releaseThinking.await()
                  if (lockFromResponse) {
                    """{"key":"main","entry":{"sessionId":"native-model-session","agentHarnessId":"codex","modelSelectionLocked":true},"resolved":{"thinkingLevel":"high","agentRuntime":{"id":"codex","source":"session"}}}"""
                  } else {
                    "{}"
                  }
                } else {
                  "{}"
                }
              }
            },
          ) { method, _ ->
            if (method == "sessions.list") {
              """{"sessions":[{"key":"main","agentId":"main","thinkingLevel":"off","modelSelectionLocked":false}]}"""
            } else {
              "{}"
            }
          }
        controller.refreshSessions()
        advanceUntilIdle()
        controller.setThinkingLevel("high")
        thinkingStarted.await()
        val queued = async { controller.setSessionModelAwait("main", "openai/gpt-5.6-sol") }
        runCurrent()
        assertEquals(1, patches.size)

        try {
          releaseThinking.complete(Unit)
          if (!lockFromResponse) {
            modelTransportStarted.await()
            controller.handleGatewayEvent(
              "sessions.changed",
              """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"}}}""",
            )
          }
        } finally {
          releaseThinking.complete(Unit)
          releaseModelTransport.complete(Unit)
        }

        assertFalse("A newer native lock must retire the queued model choice", queued.await())
        advanceUntilIdle()
        assertEquals(listOf(JsonPrimitive("high")), patches.map { it["thinkingLevel"] })
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      }
    }

  @Test
  fun successfulSelectionRecordsRecentAndUpdatesSelectedModel() =
    runTest {
      val recents = mutableListOf<String>()
      val (controller, requests) =
        chatControllerTestSetup {
          recordModelRecent = recents::add
        }

      assertTrue(controller.setSessionModelAwait("main", " anthropic/claude-opus-4 "))

      assertEquals(listOf("anthropic/claude-opus-4"), recents)
      assertEquals("anthropic/claude-opus-4", controller.selectedModelRef.value)
      assertEquals(
        "sessions.patch" to "{\"key\":\"main\",\"agentId\":\"main\",\"model\":\"anthropic/claude-opus-4\"}",
        requests.single(),
      )
    }

  @Test
  fun successfulSelectionAppliesGatewayThinkingLevelsAndEffectiveLevel() =
    runTest {
      val controller =
        createChatController { _, paramsJson ->
          val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
          val acceptedThinking = (params["thinkingLevel"] as? JsonPrimitive)?.content ?: "max"
          """{"resolved":{"modelProvider":"anthropic","model":"claude-sonnet-5",${thinkingFields(acceptedThinking, "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max")}}}"""
        }

      assertTrue(controller.setSessionModelAwait("main", "anthropic/claude-sonnet-5"))

      assertTrue(controller.thinkingLevelSelection.value.isGatewayProvided)
      assertEquals(
        listOf("off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
      assertEquals("max", controller.thinkingLevel.value)

      controller.setThinkingLevel("ultra")
      assertEquals("max", controller.thinkingLevel.value)
      controller.setThinkingLevel("adaptive")
      assertEquals("adaptive", controller.thinkingLevel.value)
    }

  @Test
  fun successfulModelResponseDoesNotOverwriteANewerSessionSnapshot() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var modelProvider = "openai"
      var model = "gpt-5"
      val controller =
        createScriptedChatController {
          respond("chat.history") {
            """{"sessionId":"model-session","messages":[],"sessionInfo":{"key":"main","sessionId":"model-session","modelProvider":"$modelProvider","model":"$model"}}"""
          }
          respond("sessions.list") {
            """{"sessions":[{"key":"main","modelProvider":"$modelProvider","model":"$model"}]}"""
          }
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main"},"resolved":{"modelProvider":"openai","model":"gpt-5-mini"}}"""
          }
        }
      controller.load("main")
      advanceUntilIdle()
      assertEquals("openai/gpt-5", controller.selectedModelRef.value)

      val patch = async { controller.setSessionModelAwait("main", "openai/gpt-5-mini") }
      patchStarted.await()
      modelProvider = "anthropic"
      model = "claude-opus-4"
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelProvider":"$modelProvider","model":"$model","permissionMode":null,"permissionModePending":false}}""",
      )
      assertEquals(
        model,
        controller.sessions.value
          .single()
          .model,
      )

      releasePatch.complete(Unit)
      assertTrue(patch.await())
      advanceUntilIdle()

      val session = controller.sessions.value.single()
      assertEquals("$modelProvider/$model", "${session.modelProvider}/${session.model}")
      assertEquals("$modelProvider/$model", controller.selectedModelRef.value)
    }

  @Test
  fun cancelledQueuedModelSelectionDoesNotRetireItsRunningPredecessor() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list", """{"sessions":[{"key":"main","modelProvider":"openai","model":"gpt-5"}]}""")
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main"},"resolved":{"modelProvider":"openai","model":"gpt-5-mini"}}"""
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      val predecessor = async { controller.setSessionModelAwait("main", "openai/gpt-5-mini") }
      patchStarted.await()
      val successor = async { controller.setSessionModelAwait("main", "anthropic/claude-opus-4") }
      runCurrent()
      successor.cancelAndJoin()
      val pendingAfterCancellation = controller.pendingSessionSettingsKeys.value

      releasePatch.complete(Unit)
      assertTrue(predecessor.await())
      advanceUntilIdle()

      assertEquals("openai/gpt-5-mini", controller.selectedModelRef.value)
      assertEquals(
        "gpt-5-mini",
        controller.sessions.value
          .single()
          .model,
      )
      assertEquals(setOf("main"), pendingAfterCancellation)
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      assertEquals(1, requests.count { it.first == "sessions.patch" })
    }

  @Test
  fun cancelledQueuedModelSelectionDoesNotLetLaterSelectionsOvertakeItsPredecessor() =
    runTest {
      for (enqueueBeforeCancellation in listOf(true, false)) {
        val predecessorStarted = CompletableDeferred<Unit>()
        val releasePredecessor = CompletableDeferred<Unit>()
        val successorStarted = CompletableDeferred<Unit>()
        val releaseSuccessor = CompletableDeferred<Unit>()
        val models = mutableListOf<String>()
        val controller =
          createScriptedChatController {
            respond("sessions.patch") { paramsJson ->
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              val modelRef = (params["model"] as JsonPrimitive).content
              models += modelRef
              if (modelRef == "openai/gpt-5-mini") {
                predecessorStarted.complete(Unit)
                releasePredecessor.await()
              } else {
                successorStarted.complete(Unit)
                releaseSuccessor.await()
              }
              "{}"
            }
          }
        val predecessor = async { controller.setSessionModelAwait("main", "openai/gpt-5-mini") }
        predecessorStarted.await()
        val cancelled = async { controller.setSessionModelAwait("main", "anthropic/claude-opus-4") }
        runCurrent()
        if (!enqueueBeforeCancellation) cancelled.cancelAndJoin()
        val successor = async { controller.setSessionModelAwait("main", "openai/gpt-5.6-luna") }
        runCurrent()
        if (enqueueBeforeCancellation) cancelled.cancelAndJoin()
        runCurrent()

        try {
          assertEquals(listOf("openai/gpt-5-mini"), models)
          releasePredecessor.complete(Unit)
          assertTrue(predecessor.await())
          successorStarted.await()
          assertEquals("openai/gpt-5-mini", controller.selectedModelRef.value)
        } finally {
          releasePredecessor.complete(Unit)
          releaseSuccessor.complete(Unit)
          advanceUntilIdle()
        }
        assertTrue(successor.await())
        assertEquals(listOf("openai/gpt-5-mini", "openai/gpt-5.6-luna"), models)
        assertEquals("openai/gpt-5.6-luna", controller.selectedModelRef.value)
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      }
    }

  @Test
  fun successfulThinkingResponseDoesNotOverwriteANewerSessionSnapshot() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var thinkingLevel = "off"
      val controller =
        createScriptedChatController {
          respond("chat.history") {
            """{"sessionId":"thinking-session","messages":[],"sessionInfo":{"key":"main","sessionId":"thinking-session",${thinkingFields(thinkingLevel, "off", "high", "max")}}}"""
          }
          respond("sessions.list") {
            """{"sessions":[{"key":"main",${thinkingFields(thinkingLevel, "off", "high", "max")}}]}"""
          }
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main","thinkingLevel":"high"},"resolved":{${thinkingFields("high", "off", "high", "max")}}}"""
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.setThinkingLevel("high")
      patchStarted.await()

      thinkingLevel = "max"
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","thinkingLevel":"max","permissionMode":null,"permissionModePending":false}}""",
      )
      assertEquals("max", controller.thinkingLevel.value)

      releasePatch.complete(Unit)
      advanceUntilIdle()

      assertEquals(
        "max",
        controller.sessions.value
          .single()
          .thinkingLevel,
      )
      assertEquals("max", controller.thinkingLevel.value)
    }

  @Test
  fun failedThinkingResponseDoesNotRollBackANewerSessionSnapshot() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var thinkingLevel = "off"
      val controller =
        createScriptedChatController {
          respond("chat.history") {
            """{"sessionId":"thinking-session","messages":[],"sessionInfo":{"key":"main","sessionId":"thinking-session",${thinkingFields(thinkingLevel, "off", "high", "max")}}}"""
          }
          respond("sessions.list") {
            """{"sessions":[{"key":"main",${thinkingFields(thinkingLevel, "off", "high", "max")}}]}"""
          }
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            error("Rejected response")
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.setThinkingLevel("high")
      patchStarted.await()
      thinkingLevel = "max"
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","thinkingLevel":"max","permissionMode":null,"permissionModePending":false}}""",
      )
      assertEquals("max", controller.thinkingLevel.value)

      releasePatch.complete(Unit)
      advanceUntilIdle()

      assertEquals(
        "max",
        controller.sessions.value
          .single()
          .thinkingLevel,
      )
      assertEquals("max", controller.thinkingLevel.value)
      assertEquals("Rejected response", controller.errorText.value)
    }

  @Test
  fun thinkingResponseUsesTheObservationAtActualTransportEnqueue() =
    runTest {
      val transportStarted = CompletableDeferred<Unit>()
      val releaseTransport = CompletableDeferred<Unit>()
      val requestStarted = CompletableDeferred<Unit>()
      val releaseResponse = CompletableDeferred<Unit>()
      var listRequests = 0
      val controller =
        createChatController(
          captureRequestLease = {
            GatewaySession.RequestLease(endpointStableId = "") { _, _, _, withEnqueue ->
              transportStarted.complete(Unit)
              releaseTransport.await()
              withEnqueue { requestStarted.complete(Unit) }
              releaseResponse.await()
              """{"resolved":{${thinkingFields("high", "off", "high")}}}"""
            }
          },
        ) { method, _ ->
          if (method == "sessions.list" && ++listRequests == 1) {
            """{"sessions":[{"key":"main",${thinkingFields("off", "off", "high", "max")}}]}"""
          } else {
            error("List unavailable")
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.setThinkingLevel("high")
      transportStarted.await()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","thinkingLevel":"max","permissionMode":null,"permissionModePending":false}}""",
      )
      assertEquals(
        "max",
        controller.sessions.value
          .single()
          .thinkingLevel,
      )

      releaseTransport.complete(Unit)
      requestStarted.await()
      releaseResponse.complete(Unit)
      advanceUntilIdle()

      assertEquals(
        "high",
        controller.sessions.value
          .single()
          .thinkingLevel,
      )
      assertEquals("high", controller.thinkingLevel.value)
      assertEquals(
        listOf("off", "high"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
    }

  @Test
  fun existingSessionPreservesEffectiveLevelOmittedFromAdvertisedOptions() =
    runTest {
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","modelProvider":"openai","model":"gpt-5.6-luna",${thinkingFields("ultra", "off", "high", "xhigh", "max")}}]}""",
          )
          respond("chat.send") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
            """{"runId":"run-ok","status":"ok"}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()

      assertEquals(
        listOf("off", "high", "xhigh", "max"),
        controller
          .thinkingLevelSelection
          .value
          .options
          .map { it.id },
      )
      assertEquals("ultra", controller.thinkingLevel.value)
      controller.handleGatewayEvent("health", null)
      assertTrue(
        controller.sendMessageAwaitAcceptance(
          message = "preserve effective reasoning",
          thinkingLevel = controller.thinkingLevel.value,
          attachments = emptyList(),
        ),
      )
      assertEquals(listOf("ultra"), sentThinkingLevels)
    }

  @Test
  fun failedSelectionDoesNotRecordRecentOrUpdateSelectedModel() =
    runTest {
      val recents = mutableListOf<String>()
      val controller =
        createChatController(
          recordModelRecent = recents::add,
        ) { _, _ -> error("patch failed") }

      assertFalse(controller.setSessionModelAwait("main", "openai/gpt-5"))

      assertEquals(emptyList<String>(), recents)
      assertNull(controller.selectedModelRef.value)
      assertEquals("patch failed", controller.errorText.value)
    }

  @Test
  fun successfulDefaultSelectionDoesNotRecordRecent() =
    runTest {
      val requests = mutableListOf<String?>()
      val recents = mutableListOf<String>()
      val controller =
        createChatController(
          recordModelRecent = recents::add,
        ) { _, paramsJson ->
          requests += paramsJson
          "{}"
        }

      assertTrue(controller.setSessionModelAwait("main", null))

      assertEquals(emptyList<String>(), recents)
      assertEquals("{\"key\":\"main\",\"agentId\":\"main\",\"model\":null}", requests.single())
    }

  @Test
  fun immediateSendWaitsForPendingModelSelection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        createChatController { method, _ ->
          requests += method
          when (method) {
            "sessions.patch" -> {
              patchStarted.complete(Unit)
              releasePatch.await()
              "{}"
            }

            "chat.send" -> {
              """{"runId":"run-ok","status":"ok"}"""
            }

            else -> {
              "{}"
            }
          }
        }
      controller.handleGatewayEvent("health", null)

      controller.setSessionModel("main", "openai/gpt-5")
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = "off",
            attachments = emptyList(),
          )
        }
      yield()

      assertEquals(listOf("sessions.patch"), requests.filter { it == "sessions.patch" || it == "chat.send" })

      releasePatch.complete(Unit)
      assertTrue(send.await())
      assertEquals(
        listOf("sessions.patch", "chat.send"),
        requests.filter { it == "sessions.patch" || it == "chat.send" },
      )
    }

  @Test
  fun immediateSendWaitsForModelCapabilitiesAfterANewerMessageSnapshot() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val refreshStarted = CompletableDeferred<Unit>()
      val releaseRefresh = CompletableDeferred<Unit>()
      val successorStarted = CompletableDeferred<Unit>()
      val releaseSuccessor = CompletableDeferred<Unit>()
      var sessionRow =
        """{"key":"main","sessionId":"model-session","modelProvider":"synthetic","model":"reasoning",${thinkingFields("high", "off", "high")},"permissionMode":null,"permissionModePending":false}"""
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata") {
            """
            {"commands":[],"models":[
              {"id":"reasoning","provider":"synthetic","available":true,"input":["text"],"reasoning":true},
              {"id":"plain","provider":"synthetic","available":true,"input":["text"],"reasoning":false},
              {"id":"plain-next","provider":"synthetic","available":true,"input":["text"],"reasoning":false}
            ]}
            """.trimIndent()
          }
          respond("sessions.list") {
            """{"sessions":[$sessionRow]}"""
          }
          respond("chat.history") { paramsJson ->
            val response = """{"sessionId":"model-session","messages":[],"sessionInfo":$sessionRow}"""
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if (params["limit"] == JsonPrimitive(1)) {
              refreshStarted.complete(Unit)
              releaseRefresh.await()
            }
            response
          }
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val model = (params["model"] as JsonPrimitive).content.removePrefix("synthetic/")
            sessionRow =
              """{"key":"main","sessionId":"model-session","modelProvider":"synthetic","model":"$model",${thinkingFields("off", "off")},"permissionMode":null,"permissionModePending":false}"""
            if (model == "plain") {
              patchStarted.complete(Unit)
              releasePatch.await()
            } else {
              successorStarted.complete(Unit)
              releaseSuccessor.await()
            }
            """{"entry":$sessionRow,"resolved":{"modelProvider":"synthetic","model":"$model",${thinkingFields("off", "off")}}}"""
          }
          respond("chat.send", """{"runId":"run-ok","status":"ok"}""")
        }
      controller.handleGatewayEvent("health", null)
      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals("high", controller.thinkingLevel.value)

      val patch = async { controller.setSessionModelAwait("main", "synthetic/plain") }
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "use the selected model",
            thinkingLevel = controller.thinkingLevel.value,
            attachments = emptyList(),
          )
        }
      runCurrent()

      // Message snapshots omit catalog-backed picker options; the exact read must
      // reconcile them when a newer event prevents applying the rich patch ACK.
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelProvider":"synthetic","model":"plain","thinkingLevel":"off","permissionMode":null,"permissionModePending":false}}""",
      )
      releasePatch.complete(Unit)
      try {
        refreshStarted.await()
        runCurrent()
        assertFalse(requests.any { it.first == "chat.send" })
        controller.setSessionModel("main", "synthetic/plain-next")
        runCurrent()
        assertEquals(1, requests.count { it.first == "sessions.patch" })
        releaseRefresh.complete(Unit)
        successorStarted.await()
        runCurrent()
        assertFalse(requests.any { it.first == "chat.send" })
      } finally {
        releaseRefresh.complete(Unit)
        releaseSuccessor.complete(Unit)
      }

      assertTrue(patch.await())
      assertTrue(send.await())
      val sentParams =
        json.parseToJsonElement(
          requests
            .single { it.first == "chat.send" }
            .second
            .orEmpty(),
        ) as JsonObject
      assertEquals("off", (sentParams["thinking"] as JsonPrimitive).content)
      assertEquals("synthetic/plain-next", controller.selectedModelRef.value)
      assertEquals(
        listOf("off"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
      val historyLimits =
        requests
          .filter { it.first == "chat.history" }
          .map { (json.parseToJsonElement(it.second.orEmpty()) as JsonObject)["limit"] }
      assertEquals(listOf(JsonPrimitive(1), null), historyLimits)
    }

  @Test
  fun modelReconciliationReadsExactSessionWhenItFallsOutsideVisibleWindow() =
    runTest {
      val sessionKey = "agent:main:conversation"
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var patched = false
      var sessionRow =
        """{"key":"$sessionKey","agentId":"main","sessionId":"conversation-id","updatedAt":1,"modelProvider":"synthetic","model":"reasoning",${thinkingFields("high", "off", "high")}}"""
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history") {
            """{"sessionKey":"$sessionKey","sessionId":"conversation-id","messages":[],"sessionInfo":$sessionRow}"""
          }
          respond("sessions.list") {
            if (patched) {
              // The current window has one row; a newer conversation displaces this one.
              """{"sessions":[{"key":"agent:main:newer","sessionId":"newer-id","updatedAt":3}],"totalCount":2,"hasMore":true}"""
            } else {
              """{"sessions":[$sessionRow]}"""
            }
          }
          respond("sessions.patch") {
            patched = true
            sessionRow =
              """{"key":"$sessionKey","agentId":"main","sessionId":"conversation-id","updatedAt":2,"modelProvider":"synthetic","model":"plain",${thinkingFields("off", "off")}}"""
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":$sessionRow,"resolved":{"modelProvider":"synthetic","model":"plain",${thinkingFields("off", "off")}}}"""
          }
          respond("chat.send", """{"runId":"run-ok","status":"ok"}""")
        }
      controller.load(sessionKey)
      advanceUntilIdle()
      assertEquals("high", controller.thinkingLevel.value)

      val patch = async { controller.setSessionModelAwait(sessionKey, "synthetic/plain") }
      patchStarted.await()
      val send = async { controller.sendMessageAwaitAcceptance("keep this draft", "high", emptyList()) }
      runCurrent()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","sessionId":"conversation-id","modelProvider":"synthetic","model":"plain","thinkingLevel":"off","permissionMode":null,"permissionModePending":false}}""",
      )
      releasePatch.complete(Unit)

      assertTrue(patch.await())
      assertTrue(send.await())
      val sentParams = json.parseToJsonElement(requests.single { it.first == "chat.send" }.second.orEmpty()) as JsonObject
      assertEquals("off", (sentParams["thinking"] as JsonPrimitive).content)
      assertEquals("synthetic/plain", controller.selectedModelRef.value)
      assertEquals(
        listOf("off"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      assertNull(controller.errorText.value)
    }

  @Test
  fun idleSessionSettingsInvalidationWaitsForExactHistoryOutsideVisibleWindow() =
    runTest {
      val sessionKey = "agent:ops:conversation"
      val readStarted = CompletableDeferred<JsonObject>()
      val releaseRead = CompletableDeferred<Unit>()
      val nextReadStarted = CompletableDeferred<JsonObject>()
      val releaseNextRead = CompletableDeferred<Unit>()
      var changed = false
      var sessionRow =
        """{"key":"$sessionKey","agentId":"ops","sessionId":"conversation-id","updatedAt":1,"modelProvider":"synthetic","model":"reasoning",${thinkingFields("high", "off", "high")}}"""
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = { it == "session-scoped-chat-metadata" }
          respond(
            "chat.metadata",
            """{"commands":[],"models":[{"id":"reasoning","provider":"synthetic","available":true,"input":["text"],"reasoning":true},{"id":"plain","provider":"synthetic","available":true,"input":["text"],"reasoning":false}]}""",
          )
          respond("sessions.list") {
            if (changed) {
              // A newer conversation displaced the selected row from the one-row drawer window.
              """{"sessions":[{"key":"agent:ops:newer","sessionId":"newer-id","updatedAt":3}],"totalCount":2,"hasMore":true}"""
            } else {
              """{"sessions":[$sessionRow]}"""
            }
          }
          respond("chat.history") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val response = """{"sessionId":"conversation-id","messages":[],"sessionInfo":$sessionRow}"""
            if (params["limit"] == JsonPrimitive(1)) {
              val firstRead = !readStarted.isCompleted
              (if (firstRead) readStarted else nextReadStarted).complete(params)
              (if (firstRead) releaseRead else releaseNextRead).await()
            }
            response
          }
          respond("chat.send", """{"runId":"run-ok","status":"ok"}""")
        }
      controller.load(sessionKey)
      advanceUntilIdle()
      assertEquals("synthetic/reasoning", controller.selectedModelRef.value)
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())

      changed = true
      sessionRow =
        """{"key":"$sessionKey","agentId":"ops","sessionId":"conversation-id","updatedAt":2,"modelProvider":"synthetic","model":"plain",${thinkingFields("off", "off")}}"""
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"ops","reason":"command-metadata","ts":2}""",
      )
      val send = async { controller.sendMessageAwaitAcceptance("use the refreshed model", "high", emptyList()) }
      try {
        runCurrent()
        assertEquals("Idle invalidation must block Send until the exact settings read returns", 0, requests.count { it.first == "chat.send" })
        assertFalse(send.isCompleted)
        assertTrue("The invalidation must start an exact settings read without a local write", readStarted.isCompleted)
        val read = readStarted.await()
        assertEquals(JsonPrimitive(sessionKey), read["sessionKey"])
        assertEquals(JsonPrimitive("ops"), read["agentId"])
        assertEquals(JsonPrimitive(1), read["limit"])
        assertEquals(setOf(sessionKey), controller.pendingSessionSettingsKeys.value)

        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"$sessionKey","agentId":"ops","reason":"command-metadata","ts":3}""",
        )
        releaseRead.complete(Unit)
        runCurrent()
        assertFalse("A newer invalidation must fence the first exact response", requests.any { it.first == "chat.send" })
        assertFalse(send.isCompleted)
        assertTrue("The newer invalidation must receive its own exact read", nextReadStarted.isCompleted)
        assertEquals(read, nextReadStarted.await())
      } finally {
        releaseRead.complete(Unit)
        releaseNextRead.complete(Unit)
      }

      assertTrue(send.await())
      assertEquals("synthetic/plain", controller.selectedModelRef.value)
      assertEquals(
        listOf("off"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
      val sentParams = json.parseToJsonElement(requests.single { it.first == "chat.send" }.second.orEmpty()) as JsonObject
      assertEquals(JsonPrimitive(sessionKey), sentParams["sessionKey"])
      assertEquals(JsonPrimitive("off"), sentParams["thinking"])
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      assertFalse(requests.any { it.first == "sessions.patch" })
    }

  @Test
  fun deletionRetiresActiveAndQueuedModelSelectionsBeforeTheirAcknowledgements() =
    runTest {
      for (sessionKey in listOf("agent:main:conversation", "global")) {
        val patchStarted = CompletableDeferred<Unit>()
        val releasePatch = CompletableDeferred<Unit>()
        var deleted = false
        val (controller, requests) =
          chatControllerTestSetup {
            cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) }
            respond("sessions.list") {
              if (deleted) {
                """{"sessions":[]}"""
              } else {
                """{"sessions":[{"key":"$sessionKey","sessionId":"conversation-id","modelProvider":"synthetic","model":"original"}]}"""
              }
            }
            respond("sessions.patch") { paramsJson ->
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              val model = (params["model"] as JsonPrimitive).content.removePrefix("synthetic/")
              if (model == "first") {
                patchStarted.complete(Unit)
                releasePatch.await()
              }
              """{"entry":{"key":"$sessionKey","sessionId":"conversation-id"},"resolved":{"modelProvider":"synthetic","model":"$model"}}"""
            }
          }
        controller.load(sessionKey, ownerAgentId = "main")
        advanceUntilIdle()
        val first = async { controller.setSessionModelAwait(sessionKey, "synthetic/first") }
        patchStarted.await()
        val queued = async { controller.setSessionModelAwait(sessionKey, "synthetic/queued") }
        runCurrent()

        // The patch committed before deletion, but its response is still in flight.
        deleted = true
        try {
          if (sessionKey == "global") {
            controller.handleGatewayEvent(
              "sessions.changed",
              """{"sessionKey":"$sessionKey","reason":"delete","ts":3}""",
            )
            runCurrent()
            assertTrue(controller.sessions.value.any { it.key == sessionKey })
            assertEquals(setOf(sessionKey), controller.pendingSessionSettingsKeys.value)
          }
          controller.handleGatewayEvent(
            "sessions.changed",
            """{"sessionKey":"$sessionKey","sessionId":"conversation-id","agentId":"main","reason":"delete","ts":3}""",
          )
          runCurrent()
          assertFalse(controller.sessions.value.any { it.key == sessionKey })
          assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
          assertEquals("main", controller.sessionKey.value)
        } finally {
          releasePatch.complete(Unit)
        }
        assertTrue(first.await())
        runCurrent()

        assertFalse(controller.sessions.value.any { it.key == sessionKey })
        assertFalse(queued.await())
        assertEquals(1, requests.count { it.first == "sessions.patch" })
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      }
    }

  @Test
  fun failedModelReconciliationPreservesWriteAcceptanceAndBlocksSendUntilRefresh() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var failRefresh = false
      var sessionRow =
        """{"key":"main","sessionId":"model-session","modelProvider":"synthetic","model":"reasoning",${thinkingFields("high", "off", "high")}}"""
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list") {
            """{"sessions":[$sessionRow]}"""
          }
          respond("chat.history") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if (params["limit"] == JsonPrimitive(1) && failRefresh) error("history offline")
            """{"sessionId":"model-session","messages":[],"sessionInfo":$sessionRow}"""
          }
          respond("sessions.patch") {
            sessionRow = """{"key":"main","sessionId":"model-session","modelProvider":"synthetic","model":"plain",${thinkingFields("off", "off")}}"""
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":$sessionRow,"resolved":{"modelProvider":"synthetic","model":"plain",${thinkingFields("off", "off")}}}"""
          }
          respond("chat.send", """{"runId":"run-ok","status":"ok"}""")
        }
      controller.handleGatewayEvent("health", null)
      controller.refreshSessions()
      advanceUntilIdle()

      val patch = async { controller.setSessionModelAwait("main", "synthetic/plain") }
      patchStarted.await()
      val send = async { controller.sendMessageAwaitAcceptance("keep this draft", "high", emptyList()) }
      runCurrent()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelProvider":"synthetic","model":"plain","thinkingLevel":"off","permissionMode":null,"permissionModePending":false}}""",
      )
      failRefresh = true
      releasePatch.complete(Unit)

      assertTrue(patch.await())
      assertFalse(send.await())
      assertEquals("Could not refresh session settings. Refresh before sending.", controller.errorText.value)
      assertFalse(controller.sendMessageAwaitAcceptance("keep this draft", "high", emptyList()))
      assertFalse(requests.any { it.first == "chat.send" })

      failRefresh = false
      controller.refreshSessions()
      advanceUntilIdle()

      assertNull(controller.errorText.value)
      assertTrue(controller.sendMessageAwaitAcceptance("keep this draft", "high", emptyList()))
      val sentParams = json.parseToJsonElement(requests.single { it.first == "chat.send" }.second.orEmpty()) as JsonObject
      assertEquals("off", (sentParams["thinking"] as JsonPrimitive).content)
      val historyLimits =
        requests
          .filter { it.first == "chat.history" }
          .map { (json.parseToJsonElement(it.second.orEmpty()) as JsonObject)["limit"] }
      assertEquals(listOf(JsonPrimitive(1), JsonPrimitive(1), null), historyLimits)
    }

  @Test
  fun thinkingPatchAndSendFollowPendingModelOnSharedSettingsLane() =
    runTest {
      val modelPatchStarted = CompletableDeferred<Unit>()
      val releaseModelPatch = CompletableDeferred<Unit>()
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              modelPatchStarted.complete(Unit)
              releaseModelPatch.await()
              """{"resolved":{"thinkingLevel":"high","thinkingLevels":[{"id":"off","label":"off"},{"id":"high","label":"high"},{"id":"ultra","label":"ultra"}]}}"""
            } else {
              """{"resolved":{"thinkingLevel":"ultra"}}"""
            }
          }
          respond("chat.send", """{"runId":"run-ok","status":"ok"}""")
        }
      controller.handleGatewayEvent("health", null)

      controller.setSessionModel("main", "openai/gpt-5.6-sol")
      modelPatchStarted.await()
      controller.setThinkingLevel("ultra")
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = controller.thinkingLevel.value,
            attachments = emptyList(),
          )
        }
      yield()

      assertEquals(
        listOf("sessions.patch"),
        requests.map { it.first }.filter { it == "sessions.patch" || it == "chat.send" },
      )
      releaseModelPatch.complete(Unit)
      assertTrue(send.await())
      assertEquals("ultra", controller.thinkingLevel.value)
      assertEquals(
        listOf("sessions.patch", "sessions.patch", "chat.send"),
        requests.map { it.first }.filter { it == "sessions.patch" || it == "chat.send" },
      )
      val thinkingPatch = requests.first { (method, params) -> method == "sessions.patch" && "thinkingLevel" in params.orEmpty() }
      assertEquals(
        "ultra",
        ((json.parseToJsonElement(thinkingPatch.second.orEmpty()) as JsonObject)["thinkingLevel"] as JsonPrimitive)
          .content,
      )
    }

  @Test
  fun failedThinkingPatchRollsBackToModelAcceptedLevelWithoutSessionRow() =
    runTest {
      val modelPatchStarted = CompletableDeferred<Unit>()
      val releaseModelPatch = CompletableDeferred<Unit>()
      val acceptedThinking = thinkingFields("high", "off", "high", "ultra")
      val controller =
        createScriptedChatController {
          respond("chat.history", """{"sessionId":"thinking-session","messages":[],"sessionInfo":{"key":"main","sessionId":"thinking-session",$acceptedThinking}}""")
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              modelPatchStarted.complete(Unit)
              releaseModelPatch.await()
              """{"resolved":{$acceptedThinking}}"""
            } else {
              error("thinking rejected")
            }
          }
        }

      controller.setSessionModel("main", "openai/gpt-5.6-sol")
      modelPatchStarted.await()
      controller.setThinkingLevel("ultra")
      releaseModelPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals("high", controller.thinkingLevel.value)
      assertEquals("thinking rejected", controller.errorText.value)
    }

  @Test
  fun thinkingRollbackStateIsScopedToGatewayConnection() =
    runTest {
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        createChatController(
          cacheScope = { gatewayScope },
        ) { method, _ ->
          when {
            method == "sessions.list" -> {
              """{"sessions":[{"key":"main","thinkingLevel":"off"}]}"""
            }

            method == "chat.history" -> {
              """{"sessionId":"${gatewayScope.gatewayId}-session","messages":[],"sessionInfo":{"key":"main","thinkingLevel":"off"}}"""
            }

            method == "sessions.patch" && gatewayScope.gatewayId == "gateway-a" -> {
              """{"resolved":{"thinkingLevel":"medium"}}"""
            }

            method == "sessions.patch" -> {
              error("thinking rejected")
            }

            else -> {
              "{}"
            }
          }
        }

      controller.setThinkingLevel("medium")
      advanceUntilIdle()
      assertEquals("medium", controller.thinkingLevel.value)

      gatewayScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals("off", controller.thinkingLevel.value)

      controller.setThinkingLevel("high")
      advanceUntilIdle()

      assertEquals("off", controller.thinkingLevel.value)
      assertEquals("thinking rejected", controller.errorText.value)
    }

  @Test
  fun settingsPatchUsesCapturedGatewayConnectionScope() =
    runTest {
      val capturedScopes = mutableListOf<ChatCacheScope>()
      val gatewayScope = ChatCacheScope(gatewayId = " gateway-a ", connectionGeneration = 7)
      val normalizedScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 7)
      val controller =
        createChatController(
          cacheScope = { gatewayScope },
          captureRequestLease = { scope ->
            scope ?: error("missing scope")
            GatewaySession.RequestLease(scope.gatewayId) { _, _, _, withEnqueue ->
              withEnqueue {}
              capturedScopes += scope
              "{}"
            }
          },
        ) { _, _ -> error("unscoped request") }

      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-sol"))

      assertEquals(listOf(normalizedScope), capturedScopes)
    }

  @Test
  fun staleGatewayThinkingFailureDoesNotReplaceCurrentError() =
    runTest {
      val oldPatchStarted = CompletableDeferred<Unit>()
      val releaseOldPatch = CompletableDeferred<Unit>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        createScriptedChatController {
          cacheScope = { gatewayScope }
          respond("chat.history", """{"sessionId":"current-session","messages":[],"sessionInfo":{"key":"main","thinkingLevel":"off"}}""")
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val level = (params["thinkingLevel"] as? JsonPrimitive)?.content
            if (level == "medium") {
              oldPatchStarted.complete(Unit)
              releaseOldPatch.await()
              error("old gateway failure")
            }
            error("current gateway failure")
          }
        }

      controller.setThinkingLevel("medium")
      oldPatchStarted.await()

      gatewayScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.setThinkingLevel("high")
      assertEquals("current gateway failure", controller.errorText.value)

      releaseOldPatch.complete(Unit)
      advanceUntilIdle()
      assertEquals("current gateway failure", controller.errorText.value)
    }

  @Test
  fun staleGatewayModelFailureDoesNotReplaceCurrentError() =
    runTest {
      val oldPatchStarted = CompletableDeferred<Unit>()
      val releaseOldPatch = CompletableDeferred<Unit>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        createScriptedChatController {
          cacheScope = { gatewayScope }
          respond("chat.history", """{"sessionId":"current-session","messages":[],"sessionInfo":{"key":"main","thinkingLevel":"off"}}""")
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              oldPatchStarted.complete(Unit)
              releaseOldPatch.await()
              error("old gateway failure")
            }
            error("current gateway failure")
          }
        }

      controller.setSessionModel("main", "openai/gpt-old")
      oldPatchStarted.await()

      gatewayScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.setThinkingLevel("high")
      assertEquals("current gateway failure", controller.errorText.value)

      releaseOldPatch.complete(Unit)
      advanceUntilIdle()
      assertEquals("current gateway failure", controller.errorText.value)
    }

  @Test
  fun queuedMutationDoesNotCrossGatewayConnection() =
    runTest {
      val oldModelPatchStarted = CompletableDeferred<Unit>()
      val releaseOldModelPatch = CompletableDeferred<Unit>()
      val patchedThinkingLevels = mutableListOf<String>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        createScriptedChatController {
          cacheScope = { gatewayScope }
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              oldModelPatchStarted.complete(Unit)
              releaseOldModelPatch.await()
              "{}"
            } else {
              val level = (params["thinkingLevel"] as JsonPrimitive).content
              patchedThinkingLevels += level
              """{"resolved":{"thinkingLevel":"$level"}}"""
            }
          }
        }

      controller.setSessionModel("main", "openai/gpt-old")
      oldModelPatchStarted.await()
      controller.setThinkingLevel("high")

      gatewayScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.setThinkingLevel("max")
      assertEquals(listOf("max"), patchedThinkingLevels)

      releaseOldModelPatch.complete(Unit)
      advanceUntilIdle()
      assertEquals(listOf("max"), patchedThinkingLevels)
      assertEquals("max", controller.thinkingLevel.value)
    }

  @Test
  fun failedThinkingPatchUsesRefreshedAuthoritativeLevel() =
    runTest {
      var sessionLevel = "off"
      val controller =
        createScriptedChatController {
          respond("sessions.list") {
            """{"sessions":[{"key":"main","thinkingLevel":"$sessionLevel"}]}"""
          }
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val level = (params["thinkingLevel"] as JsonPrimitive).content
            if (level == "max") error("rejected")
            """{"resolved":{"thinkingLevel":"$level"}}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      controller.setThinkingLevel("medium")
      advanceUntilIdle()

      sessionLevel = "high"
      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals("high", controller.thinkingLevel.value)

      controller.setThinkingLevel("max")
      advanceUntilIdle()
      assertEquals("high", controller.thinkingLevel.value)
    }

  @Test
  fun sessionsRefreshRetriesWhenThinkingPatchOverlapsResponse() =
    runTest {
      val firstListStarted = CompletableDeferred<Unit>()
      val releaseFirstList = CompletableDeferred<Unit>()
      val thinkingPatchStarted = CompletableDeferred<Unit>()
      val releaseThinkingPatch = CompletableDeferred<Unit>()
      var listRequests = 0
      val controller =
        createScriptedChatController {
          respond("chat.history", """{"sessionId":"thinking-session","messages":[],"sessionInfo":{"key":"main","thinkingLevel":"high"}}""")
          respond("sessions.list") { _ ->
            listRequests += 1
            if (listRequests == 1) {
              firstListStarted.complete(Unit)
              releaseFirstList.await()
            }
            """{"sessions":[{"key":"main","thinkingLevel":"high"}]}"""
          }
          respond("sessions.patch") { _ ->
            thinkingPatchStarted.complete(Unit)
            releaseThinkingPatch.await()
            error("rejected")
          }
        }

      controller.refreshSessions()
      firstListStarted.await()
      controller.setThinkingLevel("max")
      thinkingPatchStarted.await()

      releaseFirstList.complete(Unit)
      yield()
      assertEquals("max", controller.thinkingLevel.value)
      assertEquals(1, listRequests)

      releaseThinkingPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals(2, listRequests)
      assertEquals("high", controller.thinkingLevel.value)
    }

  @Test
  fun sessionsRefreshDoesNotWaitForSettingsOnPreviousGateway() =
    runTest {
      val oldPatchStarted = CompletableDeferred<Unit>()
      val releaseOldPatch = CompletableDeferred<Unit>()
      val newListFinished = CompletableDeferred<Unit>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        createChatController(
          cacheScope = { gatewayScope },
          requestGatewayForGateway = { gatewayId, method, _ ->
            if (gatewayId == "gateway-a" && method == "sessions.patch") {
              oldPatchStarted.complete(Unit)
              releaseOldPatch.await()
            }
            "{}"
          },
        ) { method, _ ->
          when (method) {
            "sessions.list" -> {
              newListFinished.complete(Unit)
              """{"sessions":[{"key":"main","thinkingLevel":"high"}]}"""
            }

            else -> {
              "{}"
            }
          }
        }

      controller.setThinkingLevel("max")
      oldPatchStarted.await()

      gatewayScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.refreshSessions()
      yield()

      assertTrue(newListFinished.isCompleted)
      assertEquals("high", controller.thinkingLevel.value)

      releaseOldPatch.complete(Unit)
      advanceUntilIdle()
    }

  @Test
  fun twoFailedQueuedThinkingPatchesWithoutSessionRowRestoreConfirmedLevel() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val level = (params["thinkingLevel"] as JsonPrimitive).content
            if (level == "medium") {
              firstPatchStarted.complete(Unit)
              releaseFirstPatch.await()
            }
            error("rejected")
          }
        }

      controller.setThinkingLevel("medium")
      firstPatchStarted.await()
      controller.setThinkingLevel("high")
      releaseFirstPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals("off", controller.thinkingLevel.value)
    }

  @Test
  fun failedLatestThinkingPatchRestoresOlderAcceptedOptionsWithoutSessionRow() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val level = (params["thinkingLevel"] as JsonPrimitive).content
            if (level == "medium") {
              firstPatchStarted.complete(Unit)
              releaseFirstPatch.await()
              """{"resolved":{${thinkingFields("medium", "off", "medium")}}}"""
            } else {
              error("rejected")
            }
          }
        }

      controller.setThinkingLevel("medium")
      firstPatchStarted.await()
      controller.setThinkingLevel("high")
      releaseFirstPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals("medium", controller.thinkingLevel.value)
      assertTrue(controller.thinkingLevelSelection.value.isGatewayProvided)
      assertEquals(
        listOf("off", "medium"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
    }

  @Test
  fun failedThinkingPatchPreservesGatewayOptionsWithoutSessionRow() =
    runTest {
      val controller =
        createScriptedChatController {
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              """{"resolved":{${thinkingFields("off", "off", "high")}}}"""
            } else {
              error("rejected")
            }
          }
        }

      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-sol"))
      controller.setThinkingLevel("high")
      advanceUntilIdle()

      assertEquals("off", controller.thinkingLevel.value)
      assertTrue(controller.thinkingLevelSelection.value.isGatewayProvided)
      assertEquals(
        listOf("off", "high"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
    }

  @Test
  fun modelPatchPreservesAcceptedOptionsWhenResolutionOmitsThem() =
    runTest {
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main",${thinkingFields("off", "off", "ultra")}}]}""")
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              """{"resolved":{"modelProvider":"openai","model":"gpt-5.6-sol","thinkingLevel":"off"}}"""
            } else {
              error("rejected")
            }
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-sol"))
      controller.setThinkingLevel("ultra")
      advanceUntilIdle()

      assertEquals("off", controller.thinkingLevel.value)
      assertTrue(controller.thinkingLevelSelection.value.isGatewayProvided)
      assertEquals(
        listOf("off", "ultra"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
    }

  @Test
  fun modelPatchUpdatesAcceptedOptionsWhenResolutionOmitsLevel() =
    runTest {
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main",${thinkingFields("off", "off", "high")}}]}""")
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              """{"resolved":{"modelProvider":"openai","model":"gpt-5.6-sol",${thinkingFields(null, "off", "max")}}}"""
            } else {
              error("rejected")
            }
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-sol"))
      controller.setThinkingLevel("max")
      advanceUntilIdle()

      assertEquals("off", controller.thinkingLevel.value)
      assertTrue(controller.thinkingLevelSelection.value.isGatewayProvided)
      assertEquals(
        listOf("off", "max"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
    }

  @Test
  fun modelPatchPreservesAcceptedThinkingWhenResolutionOmitsThinkingMetadata() =
    runTest {
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main",${thinkingFields("off", "off", "ultra")}}]}""")
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              """{"resolved":{"modelProvider":"openai","model":"gpt-5.6-sol"}}"""
            } else {
              """{"resolved":{${thinkingFields("ultra", "off", "ultra")}}}"""
            }
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      controller.setThinkingLevel("ultra")
      advanceUntilIdle()
      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-sol"))

      assertEquals("ultra", controller.thinkingLevel.value)
      assertTrue(controller.thinkingLevelSelection.value.isGatewayProvided)
      assertEquals(
        listOf("off", "ultra"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
    }

  @Test
  fun olderThinkingCompletionDoesNotReplaceNewerQueuedIntent() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      val secondPatchStarted = CompletableDeferred<Unit>()
      val releaseSecondPatch = CompletableDeferred<Unit>()
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            when ((params["thinkingLevel"] as? JsonPrimitive)?.content) {
              "high" -> {
                firstPatchStarted.complete(Unit)
                releaseFirstPatch.await()
              }

              "ultra" -> {
                secondPatchStarted.complete(Unit)
                releaseSecondPatch.await()
              }
            }
            "{}"
          }
          respond("chat.send", """{"runId":"run-ok","status":"ok"}""")
        }
      controller.handleGatewayEvent("health", null)

      controller.setThinkingLevel("high")
      firstPatchStarted.await()
      controller.setThinkingLevel("ultra")
      releaseFirstPatch.complete(Unit)
      secondPatchStarted.await()

      assertEquals("ultra", controller.thinkingLevel.value)
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = controller.thinkingLevel.value,
            attachments = emptyList(),
          )
        }
      releaseSecondPatch.complete(Unit)
      assertTrue(send.await())
      val sendParams = requests.first { it.first == "chat.send" }.second.orEmpty()
      assertEquals(
        "ultra",
        ((json.parseToJsonElement(sendParams) as JsonObject)["thinking"] as JsonPrimitive).content,
      )
    }

  @Test
  fun repeatedThinkingValueStillUsesLatestRequestIdentity() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      var patchIndex = 0
      val controller =
        createScriptedChatController {
          respond("sessions.patch") {
            patchIndex += 1
            when (patchIndex) {
              1 -> {
                firstPatchStarted.complete(Unit)
                releaseFirstPatch.await()
                """{"resolved":{"thinkingLevel":"medium"}}"""
              }

              2 -> {
                """{"resolved":{"thinkingLevel":"ultra"}}"""
              }

              else -> {
                """{"resolved":{"thinkingLevel":"max"}}"""
              }
            }
          }
        }

      controller.setThinkingLevel("high")
      firstPatchStarted.await()
      controller.setThinkingLevel("ultra")
      controller.setThinkingLevel("high")
      releaseFirstPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals(3, patchIndex)
      assertEquals("max", controller.thinkingLevel.value)
    }

  @Test
  fun immediateSendStopsWhenPendingModelSelectionFails() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        createChatController { method, _ ->
          requests += method
          when (method) {
            "chat.history" -> {
              """{"sessionId":"model-session","messages":[],"sessionInfo":{"key":"main","thinkingLevel":"off"}}"""
            }

            "sessions.patch" -> {
              patchStarted.complete(Unit)
              releasePatch.await()
              error("patch failed")
            }

            "chat.send" -> {
              """{"runId":"run-unexpected","status":"ok"}"""
            }

            else -> {
              "{}"
            }
          }
        }
      controller.handleGatewayEvent("health", null)

      controller.setSessionModel("main", "openai/gpt-5")
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = "off",
            attachments = emptyList(),
          )
        }
      yield()

      releasePatch.complete(Unit)
      assertFalse(send.await())
      assertEquals("patch failed", controller.errorText.value)
      assertFalse("chat.send" in requests)
    }

  @Test
  fun staleHistoryDoesNotOverwriteAcceptedModelSelection() =
    runTest {
      val historyStarted = CompletableDeferred<Unit>()
      val releaseHistory = CompletableDeferred<Unit>()
      val listStarted = CompletableDeferred<Unit>()
      val releaseList = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("chat.history") { _ ->
            historyStarted.complete(Unit)
            releaseHistory.await()
            """{"messages":[{"role":"assistant","content":"Recovered transcript"}],"sessionInfo":{"key":"main","modelProvider":"anthropic","model":"claude-opus-4",${thinkingFields("low", "off", "low", "high")}}}"""
          }
          respond("sessions.patch", """{"resolved":{"modelProvider":"openai","model":"gpt-5",${thinkingFields("high", "off", "high")}}}""")
          respond("sessions.list") {
            listStarted.complete(Unit)
            releaseList.await()
            """{"sessions":[{"key":"main","modelProvider":"openai","model":"gpt-5",${thinkingFields("high", "off", "high")}}]}"""
          }
          respond("chat.metadata", """{"commands":[],"models":[]}""")
        }

      controller.load("main")
      historyStarted.await()
      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5"))

      releaseHistory.complete(Unit)
      listStarted.await()

      try {
        assertEquals(
          "Recovered transcript",
          controller.messages.value
            .single()
            .content
            .single()
            .text,
        )
        assertEquals("openai/gpt-5", controller.selectedModelRef.value)
        val session = controller.sessions.value.single()
        assertEquals("openai/gpt-5", "${session.modelProvider}/${session.model}")
        assertEquals("high", session.thinkingLevel)
        assertEquals("high", controller.thinkingLevel.value)
      } finally {
        releaseList.complete(Unit)
      }
      advanceUntilIdle()
    }

  @Test
  fun historyHydratesSelectedModelAndAgentScopedCatalog() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history") { paramsJson ->
            """
            {
              "sessionId": "session-ops",
              "messages": [],
              "sessionInfo": {
                "key": "agent:ops:main",
                "sessionId": "session-ops",
                "modelProvider": "anthropic",
                "model": "claude-opus-4"
              }
            }
            """.trimIndent()
          }
          respond("chat.metadata") { paramsJson ->
            """
            {
              "commands": [],
              "models": [
                {
                  "id": "claude-opus-4",
                  "name": "Claude Opus 4",
                  "provider": "anthropic",
                  "available": true,
                  "input": ["text"]
                }
              ]
            }
            """.trimIndent()
          }
          respond("sessions.list", """{"sessions":[]}""")
        }

      controller.load("agent:ops:main")
      advanceUntilIdle()

      assertEquals("anthropic/claude-opus-4", controller.selectedModelRef.value)
      assertEquals(
        "claude-opus-4",
        controller.modelCatalog.value
          .single()
          .id,
      )
      val metadataRequest = requests.single { it.first == "chat.metadata" }
      assertTrue(metadataRequest.second.orEmpty().contains("\"agentId\":\"ops\""))

      val selectedBeforeEvent = controller.sessions.value.singleOrNull { it.key == "agent:ops:main" }
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"agent:ops:main","agentId":"ops","phase":"start","runId":"ops-run","session":{"key":"agent:ops:main","thinkingLevel":"high","totalTokens":24000,"totalTokensFresh":true,"contextTokens":200000}}""",
      )

      assertEquals("anthropic/claude-opus-4", controller.selectedModelRef.value)
      assertEquals("session-ops", selectedBeforeEvent?.sessionId)
      val selectedAfterEvent = controller.sessions.value.single { it.key == "agent:ops:main" }
      assertEquals("session-ops", selectedAfterEvent.sessionId)
      assertEquals("ops", selectedAfterEvent.ownerAgentId)
      assertEquals("anthropic", selectedAfterEvent.modelProvider)
      assertEquals("claude-opus-4", selectedAfterEvent.model)
      assertEquals("high", controller.thinkingLevel.value)
      assertEquals(24_000L, selectedAfterEvent.totalTokens)
    }

  @Test
  fun metadataScopeFollowsNegotiatedGatewayContract() =
    runTest {
      for (advertised in listOf(null, false, true)) {
        val (controller, requests) =
          chatControllerTestSetup {
            gatewayAdvertisesCapability = { if (it == "session-scoped-chat-metadata") advertised else false }
            respond("chat.history", historyResponse("session-ops", emptyList()))
            respond("chat.metadata") { paramsJson ->
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              // Stable v2026.7.1-2 rejects any additional property before computing metadata.
              require(params.keys == if (advertised == true) setOf("agentId", "sessionKey") else setOf("agentId"))
              """{"swarmEnabled":false,"commands":[{"name":"new","textAliases":["/new"]}],"models":[{"id":"gpt-5.6-luna","provider":"openai","available":true,"input":["text"]}]}"""
            }
          }
        controller.load("agent:ops:first")
        advanceUntilIdle()
        assertEquals("legacy and current peers both load commands", listOf("new"), controller.commands.value.map { it.name })
        assertEquals(
          "gpt-5.6-luna",
          controller.modelCatalog.value
            .single()
            .id,
        )
        controller.switchSession("agent:ops:second")
        advanceUntilIdle()
        val metadata = requests.filter { it.first == "chat.metadata" }.map { json.parseToJsonElement(it.second.orEmpty()) as JsonObject }
        assertEquals(if (advertised == true) 2 else 1, metadata.size)
        assertEquals("ops", (metadata.last()["agentId"] as JsonPrimitive).content)
        assertEquals(if (advertised == true) JsonPrimitive("agent:ops:second") else null, metadata.last()["sessionKey"])
      }
    }

  @Test
  fun sessionMetadataMutationsRevalidateWithoutResettingChat() =
    runTest {
      for (reason in listOf("patch", "command-metadata", "reset")) verifyMetadataPublication(reason)
    }

  @Test
  fun sequenceGapRevalidatesLoadedMetadataWithoutResettingChat() =
    runTest {
      verifyMetadataPublication("seqGap")
    }

  private suspend fun TestScope.verifyMetadataPublication(reason: String) {
    var available = false
    val (controller, requests) =
      chatControllerTestSetup {
        gatewayAdvertisesCapability = { it == "session-scoped-chat-metadata" }
        respond("chat.history", historyResponse("session-current", listOf(ReplayHistoryMessage("assistant", "Earlier reply", 1))))
        respond("chat.metadata") { availabilityMetadata(available) }
      }
    controller.load("global", ownerAgentId = "main")
    advanceUntilIdle()
    val messages = controller.messages.value

    fun owner() = resolveChatComposerOwner(null, controller.sessionOwnerAgentId.value, sessionKey = controller.sessionKey.value, mainSessionKey = "main")
    val drafts = ChatComposerTextDraftStore()
    drafts[owner()] = "Unsent draft"
    val historyRequests = requests.count { it.first == "chat.history" }
    val metadataRequests = requests.count { it.first == "chat.metadata" }
    for (unrelated in listOf(
      """{"sessionKey":"other","agentId":"main","reason":"patch"}""",
      """{"sessionKey":"global","agentId":"ops","reason":"patch"}""",
      """{"sessionKey":"global","agentId":"main","phase":"message"}""",
    )) {
      controller.handleGatewayEvent("sessions.changed", unrelated)
    }
    advanceUntilIdle()
    assertEquals(metadataRequests, requests.count { it.first == "chat.metadata" })
    for (next in listOf(true, false)) {
      available = next
      if (reason == "seqGap") {
        controller.handleGatewayEvent("seqGap", null)
      } else {
        controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"global","agentId":"main","reason":"$reason"}""")
      }
      advanceUntilIdle()
      assertEquals(
        "$reason must revalidate accepted availability",
        next,
        controller.modelCatalog.value
          .single()
          .available,
      )
      assertEquals(messages, controller.messages.value)
      assertEquals("Unsent draft", drafts[owner()])
    }
    assertEquals(metadataRequests + 2, requests.count { it.first == "chat.metadata" })
    if (reason != "seqGap") assertEquals(historyRequests, requests.count { it.first == "chat.history" })
  }

  @Test
  fun metadataChangeRetainsSessionProfileAvailabilityUntilAcceptedRefreshWithoutReloadingChat() =
    runTest {
      val pendingRefresh = CompletableDeferred<String>()
      val sessionKey = "agent:main:profile-locked"
      var metadataRequests = 0
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history", historyResponse("session-main", listOf(ReplayHistoryMessage("assistant", "Earlier reply", 1))))
          gatewayAdvertisesCapability = { it == "session-scoped-chat-metadata" }
          respond("chat.metadata") { paramsJson ->
            metadataRequests += 1
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            // Neutral agent credentials work; this session's selected profile starts unavailable.
            when {
              (params["sessionKey"] as? JsonPrimitive)?.content != sessionKey -> availabilityMetadata(true)
              metadataRequests == 2 -> pendingRefresh.await()
              metadataRequests == 4 -> availabilityMetadata(true)
              else -> availabilityMetadata(false)
            }
          }
        }
      controller.load(sessionKey)
      advanceUntilIdle()
      assertTrue(controller.setSessionModelAwait(sessionKey, "openai/gpt-5.6-luna"))
      val messages = controller.messages.value
      val historyRequests = requests.count { it.first == "chat.history" }
      val sessionRequests = requests.count { it.first == "sessions.list" }
      assertEquals(
        false,
        controller.modelCatalog.value
          .single()
          .available,
      )

      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      runCurrent()
      assertEquals(2, metadataRequests)
      assertEquals(
        false,
        controller.modelCatalog.value
          .single()
          .available,
      )

      pendingRefresh.completeExceptionally(IllegalStateException("transport failed"))
      advanceUntilIdle()
      assertEquals(
        false,
        controller.modelCatalog.value
          .single()
          .available,
      )

      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()
      assertEquals(
        false,
        controller.modelCatalog.value
          .single()
          .available,
      )

      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()
      assertEquals(
        true,
        controller.modelCatalog.value
          .single()
          .available,
      )
      assertEquals("openai/gpt-5.6-luna", controller.selectedModelRef.value)
      assertEquals(messages, controller.messages.value)
      assertEquals(historyRequests, requests.count { it.first == "chat.history" })
      assertEquals(sessionRequests, requests.count { it.first == "sessions.list" })
    }

  @Test
  fun acceptedMetadataRecoveryUnblocksPermanentAuthSendGate() =
    runTest {
      var available = false
      var unavailableReason: String? = "missing-auth"
      var sends = 0
      val controller =
        createScriptedChatController {
          respond("chat.metadata") { availabilityMetadata(available, unavailableReason) }
          respond("sessions.patch", "{}")
          respond("chat.send") {
            sends += 1
            """{"runId":"recovered-send","status":"ok"}"""
          }
        }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-luna"))
      assertEquals(
        GatewayModelUnavailableReason.MissingAuth,
        controller.modelCatalog.value
          .single()
          .unavailableReason,
      )

      assertFalse(controller.sendMessageAwaitAcceptance("blocked", "off", emptyList()))
      assertEquals(0, sends)

      available = true
      unavailableReason = null
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()

      assertTrue(controller.sendMessageAwaitAcceptance("allowed", "off", emptyList()))
      assertEquals(1, sends)
    }

  @Test
  fun newerMetadataPublicationFencesOlderResponseAndFailure() =
    runTest {
      for (event in listOf("chat.metadata.changed", "patch", "command-metadata", "reset", "seqGap")) {
        for (oldRequestFails in listOf(false, true)) {
          val oldRefresh = CompletableDeferred<String>()
          val newRefresh = CompletableDeferred<String>()
          var metadataRequests = 0
          val controller =
            createScriptedChatController {
              gatewayAdvertisesCapability = { it == "session-scoped-chat-metadata" }
              respond("chat.metadata") {
                metadataRequests += 1
                when (metadataRequests) {
                  2 -> oldRefresh.await()
                  3 -> newRefresh.await()
                  else -> availabilityMetadata(false)
                }
              }
            }
          controller.handleGatewayEvent("health", null)
          advanceUntilIdle()
          controller.handleGatewayEvent("chat.metadata.changed", "{}")
          runCurrent()
          // Queue the old completion before delivering the invalidation. It must be
          // retired synchronously, before the new refresh coroutine gets to run.
          if (oldRequestFails) {
            oldRefresh.completeExceptionally(IllegalStateException("stale transport failure"))
          } else {
            oldRefresh.complete(availabilityMetadata(true))
          }
          if (event == "chat.metadata.changed" || event == "seqGap") {
            controller.handleGatewayEvent(event, null)
          } else {
            controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"main","agentId":"main","reason":"$event"}""")
          }
          runCurrent()
          assertEquals("$event refreshes at the event boundary", 3, metadataRequests)
          assertEquals(
            "$event fences a queued stale completion",
            false,
            controller.modelCatalog.value
              .single()
              .available,
          )
          newRefresh.complete(availabilityMetadata(true))
          advanceUntilIdle()
          assertEquals(
            true,
            controller.modelCatalog.value
              .single()
              .available,
          )
        }
      }
    }

  @Test
  fun metadataPublicationCannotCrossDisconnectOrSessionRoundTrip() =
    runTest {
      for (transition in listOf("disconnect", "agent", "session")) {
        val oldRefresh = CompletableDeferred<String>()
        var metadataRequests = 0
        val controller =
          createScriptedChatController {
            gatewayAdvertisesCapability = { it == "session-scoped-chat-metadata" }
            respond("chat.metadata") {
              metadataRequests += 1
              if (metadataRequests == 2) oldRefresh.await() else availabilityMetadata(false)
            }
            respond("chat.history", historyResponse("session-current", emptyList()))
          }
        controller.handleGatewayEvent("health", null)
        advanceUntilIdle()
        controller.handleGatewayEvent("chat.metadata.changed", "{}")
        runCurrent()
        assertEquals(2, metadataRequests)

        if (transition == "disconnect") {
          controller.onDisconnected("Offline")
          assertTrue(controller.modelCatalog.value.isEmpty())
          controller.handleGatewayEvent("health", null)
          runCurrent()
        } else {
          controller.switchSession(if (transition == "agent") "agent:ops:main" else "agent:main:other")
          runCurrent()
          controller.switchSession("main")
          runCurrent()
        }
        assertEquals(
          false,
          controller.modelCatalog.value
            .single()
            .available,
        )

        oldRefresh.complete(availabilityMetadata(true))
        advanceUntilIdle()
        assertEquals(
          false,
          controller.modelCatalog.value
            .single()
            .available,
        )
      }
    }

  @Test
  fun emptyModelCatalogIsRetriedOnNextHealthEvent() =
    runTest {
      var metadataRequests = 0
      val controller =
        createScriptedChatController {
          respond("chat.metadata") { _ ->
            metadataRequests += 1
            if (metadataRequests == 1) {
              """{"commands":[{"name":"new","textAliases":["/new"]}],"models":[]}"""
            } else {
              """{"commands":[{"name":"new","textAliases":["/new"]}],"models":[{"id":"gpt-5","provider":"openai","input":["text"]}]}"""
            }
          }
        }

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertTrue(controller.modelCatalog.value.isEmpty())

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(2, metadataRequests)
      assertEquals(
        "gpt-5",
        controller.modelCatalog.value
          .single()
          .id,
      )
    }

  @Test
  fun validEmptyModelCatalogStopsAfterOneRetry() =
    runTest {
      var metadataRequests = 0
      val controller =
        createScriptedChatController {
          respond("chat.metadata") {
            metadataRequests += 1
            """{"commands":[],"models":[]}"""
          }
        }

      repeat(3) {
        controller.handleGatewayEvent("health", null)
        advanceUntilIdle()
      }

      assertEquals(2, metadataRequests)
      assertTrue(controller.modelCatalog.value.isEmpty())
    }

  @Test
  fun unsupportedReasoningSendsOffWithoutChangingStoredLevelAndRestoresAfterFlip() =
    runTest {
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond("chat.send") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
            """{"runId":"run-${sentThinkingLevels.size}","status":"ok"}"""
          }
          respond("chat.history", """{"messages":[],"sessionInfo":{"key":"main"}}""")
          // Gating reads the controller-owned agent-scoped catalog hydrated from chat.metadata.
          respond("sessions.list", """{"sessions":[]}""")
          respond("chat.metadata") { paramsJson ->
            """
            {
              "commands": [],
              "models": [
                {"id": "plain", "name": "plain", "provider": "openai", "available": true, "input": ["text"], "reasoning": false},
                {"id": "reasoning", "name": "reasoning", "provider": "openai", "available": true, "input": ["text"], "reasoning": true}
              ]
            }
            """.trimIndent()
          }
        }
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()
      controller.setThinkingLevel("high")
      assertTrue(controller.setSessionModelAwait("main", "openai/plain"))

      assertTrue(
        controller.sendMessageAwaitAcceptance(
          message = "plain model",
          thinkingLevel = controller.thinkingLevel.value,
          attachments = emptyList(),
        ),
      )
      assertEquals(listOf("off"), sentThinkingLevels)
      assertEquals("high", controller.thinkingLevel.value)

      assertTrue(controller.setSessionModelAwait("main", "openai/reasoning"))
      assertTrue(
        controller.sendMessageAwaitAcceptance(
          message = "reasoning restored",
          thinkingLevel = controller.thinkingLevel.value,
          attachments = emptyList(),
        ),
      )
      assertEquals(listOf("off", "high"), sentThinkingLevels)
      assertEquals("high", controller.thinkingLevel.value)
    }

  @Test
  fun advertisedThinkingLevelsOverrideCatalogReasoningFlagForSend() =
    runTest {
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond("chat.metadata") { paramsJson ->
            """
            {
              "commands": [],
              "models": [
                {
                  "id": "reasoner",
                  "name": "Reasoner",
                  "provider": "synthetic",
                  "available": true,
                  "input": ["text"],
                  "reasoning": false
                }
              ]
            }
            """.trimIndent()
          }
          respond("chat.history", """{"messages":[],"sessionInfo":{"key":"main"}}""")
          respond("sessions.list", """{"sessions":[]}""")
          respond("sessions.patch") { paramsJson ->
            """{"resolved":{"modelProvider":"synthetic","model":"reasoner",${thinkingFields("max", "off", "max")}}}"""
          }
          respond("chat.send") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
            """{"runId":"run-ok","status":"ok"}"""
          }
        }
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.setSessionModelAwait("main", "synthetic/reasoner"))
      assertTrue(
        controller.sendMessageAwaitAcceptance(
          message = "use the advertised level",
          thinkingLevel = controller.thinkingLevel.value,
          attachments = emptyList(),
        ),
      )

      assertEquals(listOf("max"), sentThinkingLevels)
    }

  private fun availabilityMetadata(
    available: Boolean,
    unavailableReason: String? = null,
  ): String {
    val reasonField = unavailableReason?.let { ",\"unavailableReason\":\"$it\"" }.orEmpty()
    return """{"swarmEnabled":false,"commands":[],"models":[{"id":"gpt-5.6-luna","provider":"openai","available":$available$reasonField,"input":["text"]}]}"""
  }

  private fun thinkingFields(
    level: String?,
    vararg options: String,
  ): String =
    listOfNotNull(
      level?.let { """"thinkingLevel":"$it"""" },
      options.takeIf { it.isNotEmpty() }?.joinToString(",", "\"thinkingLevels\":[", "]") {
        """{"id":"$it","label":"$it"}"""
      },
    ).joinToString(",")
}
