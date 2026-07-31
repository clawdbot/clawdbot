package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerModelSelectionTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun successfulSelectionRecordsRecentAndUpdatesSelectedModel() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            "{}"
          },
          recordModelRecent = recents::add,
        )

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
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            val acceptedThinking = (params["thinkingLevel"] as? JsonPrimitive)?.content ?: "max"
            """
            {
              "resolved": {
                "modelProvider": "anthropic",
                "model": "claude-sonnet-5",
                "thinkingLevel": "$acceptedThinking",
                "thinkingLevels": [
                  {"id": "off", "label": "off"},
                  {"id": "minimal", "label": "minimal"},
                  {"id": "low", "label": "low"},
                  {"id": "medium", "label": "medium"},
                  {"id": "high", "label": "high"},
                  {"id": "xhigh", "label": "xhigh"},
                  {"id": "adaptive", "label": "adaptive"},
                  {"id": "max", "label": "max"}
                ]
              }
            }
            """.trimIndent()
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun existingSessionPreservesEffectiveLevelOmittedFromAdvertisedOptions() =
    runTest {
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "sessions.list" ->
                """
                {
                  "sessions": [
                    {
                      "key": "main",
                      "modelProvider": "openai",
                      "model": "gpt-5.6-luna",
                      "thinkingLevel": "ultra",
                      "thinkingLevels": [
                        {"id": "off", "label": "off"},
                        {"id": "high", "label": "high"},
                        {"id": "xhigh", "label": "xhigh"},
                        {"id": "max", "label": "max"}
                      ]
                    }
                  ]
                }
                """.trimIndent()
              "chat.send" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
                """{"runId":"run-ok","status":"ok"}"""
              }
              else -> "{}"
            }
          },
        )

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
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> error("patch failed") },
          recordModelRecent = recents::add,
        )

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
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, paramsJson ->
            requests += paramsJson
            "{}"
          },
          recordModelRecent = recents::add,
        )

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
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requests += method
            when (method) {
              "sessions.patch" -> {
                patchStarted.complete(Unit)
                releasePatch.await()
                "{}"
              }
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              else -> "{}"
            }
          },
        )
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
  fun thinkingPatchAndSendFollowPendingModelOnSharedSettingsLane() =
    runTest {
      val modelPatchStarted = CompletableDeferred<Unit>()
      val releaseModelPatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.patch" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                if ("model" in params) {
                  modelPatchStarted.complete(Unit)
                  releaseModelPatch.await()
                  """{"resolved":{"thinkingLevel":"high","thinkingLevels":[{"id":"off","label":"off"},{"id":"high","label":"high"},{"id":"ultra","label":"ultra"}]}}"""
                } else {
                  """{"resolved":{"thinkingLevel":"ultra"}}"""
                }
              }
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              else -> "{}"
            }
          },
        )
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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun failedThinkingPatchRollsBackToModelAcceptedLevelWithoutSessionRow() =
    runTest {
      val modelPatchStarted = CompletableDeferred<Unit>()
      val releaseModelPatch = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            if (method != "sessions.patch") {
              "{}"
            } else {
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              if ("model" in params) {
                modelPatchStarted.complete(Unit)
                releaseModelPatch.await()
                """{"resolved":{"thinkingLevel":"high","thinkingLevels":[{"id":"off","label":"off"},{"id":"high","label":"high"},{"id":"ultra","label":"ultra"}]}}"""
              } else {
                error("thinking rejected")
              }
            }
          },
        )

      controller.setSessionModel("main", "openai/gpt-5.6-sol")
      modelPatchStarted.await()
      controller.setThinkingLevel("ultra")
      releaseModelPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals("high", controller.thinkingLevel.value)
      assertEquals("thinking rejected", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun thinkingRollbackStateIsScopedToGatewayConnection() =
    runTest {
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          cacheScope = { gatewayScope },
          requestGateway = { method, _ ->
            when {
              method == "sessions.list" ->
                """{"sessions":[{"key":"main","thinkingLevel":"off"}]}"""
              method == "sessions.patch" && gatewayScope.gatewayId == "gateway-a" ->
                """{"resolved":{"thinkingLevel":"medium"}}"""
              method == "sessions.patch" -> error("thinking rejected")
              else -> "{}"
            }
          },
        )

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
        ChatController(
          scope = this,
          json = json,
          cacheScope = { gatewayScope },
          requestGateway = { _, _ -> error("unscoped request") },
          captureSettingsRequestLease = { scope ->
            scope ?: error("missing scope")
            GatewaySession.RequestLease(scope.gatewayId) { _, _, _ ->
              capturedScopes += scope
              "{}"
            }
          },
        )

      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5.6-sol"))

      assertEquals(listOf(normalizedScope), capturedScopes)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleGatewayThinkingFailureDoesNotReplaceCurrentError() =
    runTest {
      val oldPatchStarted = CompletableDeferred<Unit>()
      val releaseOldPatch = CompletableDeferred<Unit>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          cacheScope = { gatewayScope },
          requestGateway = { method, paramsJson ->
            if (method != "sessions.patch") {
              "{}"
            } else {
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              val level = (params["thinkingLevel"] as? JsonPrimitive)?.content
              if (level == "medium") {
                oldPatchStarted.complete(Unit)
                releaseOldPatch.await()
                error("old gateway failure")
              }
              error("current gateway failure")
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleGatewayModelFailureDoesNotReplaceCurrentError() =
    runTest {
      val oldPatchStarted = CompletableDeferred<Unit>()
      val releaseOldPatch = CompletableDeferred<Unit>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          cacheScope = { gatewayScope },
          requestGateway = { method, paramsJson ->
            if (method != "sessions.patch") {
              "{}"
            } else {
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              if ("model" in params) {
                oldPatchStarted.complete(Unit)
                releaseOldPatch.await()
                error("old gateway failure")
              }
              error("current gateway failure")
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun queuedMutationDoesNotCrossGatewayConnection() =
    runTest {
      val oldModelPatchStarted = CompletableDeferred<Unit>()
      val releaseOldModelPatch = CompletableDeferred<Unit>()
      val patchedThinkingLevels = mutableListOf<String>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          cacheScope = { gatewayScope },
          requestGateway = { method, paramsJson ->
            if (method != "sessions.patch") {
              "{}"
            } else {
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
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun failedThinkingPatchUsesRefreshedAuthoritativeLevel() =
    runTest {
      var sessionLevel = "off"
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"main","thinkingLevel":"$sessionLevel"}]}"""
              "sessions.patch" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                val level = (params["thinkingLevel"] as JsonPrimitive).content
                if (level == "max") error("rejected")
                """{"resolved":{"thinkingLevel":"$level"}}"""
              }
              else -> "{}"
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionsRefreshRetriesWhenThinkingPatchOverlapsResponse() =
    runTest {
      val firstListStarted = CompletableDeferred<Unit>()
      val releaseFirstList = CompletableDeferred<Unit>()
      val thinkingPatchStarted = CompletableDeferred<Unit>()
      val releaseThinkingPatch = CompletableDeferred<Unit>()
      var listRequests = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" -> {
                listRequests += 1
                if (listRequests == 1) {
                  firstListStarted.complete(Unit)
                  releaseFirstList.await()
                }
                """{"sessions":[{"key":"main","thinkingLevel":"high"}]}"""
              }
              "sessions.patch" -> {
                thinkingPatchStarted.complete(Unit)
                releaseThinkingPatch.await()
                error("rejected")
              }
              else -> "{}"
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionsRefreshDoesNotWaitForSettingsOnPreviousGateway() =
    runTest {
      val oldPatchStarted = CompletableDeferred<Unit>()
      val releaseOldPatch = CompletableDeferred<Unit>()
      val newListFinished = CompletableDeferred<Unit>()
      var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          cacheScope = { gatewayScope },
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" -> {
                newListFinished.complete(Unit)
                """{"sessions":[{"key":"main","thinkingLevel":"high"}]}"""
              }
              else -> "{}"
            }
          },
          requestGatewayForGateway = { gatewayId, method, _ ->
            if (gatewayId == "gateway-a" && method == "sessions.patch") {
              oldPatchStarted.complete(Unit)
              releaseOldPatch.await()
            }
            "{}"
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun twoFailedQueuedThinkingPatchesWithoutSessionRowRestoreConfirmedLevel() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            if (method != "sessions.patch") {
              "{}"
            } else {
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              val level = (params["thinkingLevel"] as JsonPrimitive).content
              if (level == "medium") {
                firstPatchStarted.complete(Unit)
                releaseFirstPatch.await()
              }
              error("rejected")
            }
          },
        )

      controller.setThinkingLevel("medium")
      firstPatchStarted.await()
      controller.setThinkingLevel("high")
      releaseFirstPatch.complete(Unit)
      advanceUntilIdle()

      assertEquals("off", controller.thinkingLevel.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun failedLatestThinkingPatchRestoresOlderAcceptedOptionsWithoutSessionRow() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            if (method != "sessions.patch") {
              "{}"
            } else {
              val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
              val level = (params["thinkingLevel"] as JsonPrimitive).content
              if (level == "medium") {
                firstPatchStarted.complete(Unit)
                releaseFirstPatch.await()
                """
                {"resolved":{"thinkingLevel":"medium","thinkingLevels":[
                  {"id":"off","label":"off"},{"id":"medium","label":"medium"}
                ]}}
                """.trimIndent()
              } else {
                error("rejected")
              }
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun failedThinkingPatchPreservesGatewayOptionsWithoutSessionRow() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "sessions.patch" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                if ("model" in params) {
                  """
                  {"resolved":{"thinkingLevel":"off","thinkingLevels":[
                    {"id":"off","label":"off"},{"id":"high","label":"high"}
                  ]}}
                  """.trimIndent()
                } else {
                  error("rejected")
                }
              }
              else -> "{}"
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun modelPatchPreservesAcceptedOptionsWhenResolutionOmitsThem() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "sessions.list" ->
                """
                {"sessions":[{"key":"main","thinkingLevel":"off","thinkingLevels":[
                  {"id":"off","label":"off"},{"id":"ultra","label":"ultra"}
                ]}]}
                """.trimIndent()
              "sessions.patch" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                if ("model" in params) {
                  """{"resolved":{"modelProvider":"openai","model":"gpt-5.6-sol","thinkingLevel":"off"}}"""
                } else {
                  error("rejected")
                }
              }
              else -> "{}"
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun modelPatchUpdatesAcceptedOptionsWhenResolutionOmitsLevel() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "sessions.list" ->
                """
                {"sessions":[{"key":"main","thinkingLevel":"off","thinkingLevels":[
                  {"id":"off","label":"off"},{"id":"high","label":"high"}
                ]}]}
                """.trimIndent()
              "sessions.patch" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                if ("model" in params) {
                  """
                  {"resolved":{"modelProvider":"openai","model":"gpt-5.6-sol","thinkingLevels":[
                    {"id":"off","label":"off"},{"id":"max","label":"max"}
                  ]}}
                  """.trimIndent()
                } else {
                  error("rejected")
                }
              }
              else -> "{}"
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun modelPatchPreservesAcceptedThinkingWhenResolutionOmitsThinkingMetadata() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "sessions.list" ->
                """
                {"sessions":[{"key":"main","thinkingLevel":"off","thinkingLevels":[
                  {"id":"off","label":"off"},{"id":"ultra","label":"ultra"}
                ]}]}
                """.trimIndent()
              "sessions.patch" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                if ("model" in params) {
                  """{"resolved":{"modelProvider":"openai","model":"gpt-5.6-sol"}}"""
                } else {
                  """
                  {"resolved":{"thinkingLevel":"ultra","thinkingLevels":[
                    {"id":"off","label":"off"},{"id":"ultra","label":"ultra"}
                  ]}}
                  """.trimIndent()
                }
              }
              else -> "{}"
            }
          },
        )

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
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.patch" -> {
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
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              else -> "{}"
            }
          },
        )
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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun repeatedThinkingValueStillUsesLatestRequestIdentity() =
    runTest {
      val firstPatchStarted = CompletableDeferred<Unit>()
      val releaseFirstPatch = CompletableDeferred<Unit>()
      var patchIndex = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method != "sessions.patch") {
              "{}"
            } else {
              patchIndex += 1
              when (patchIndex) {
                1 -> {
                  firstPatchStarted.complete(Unit)
                  releaseFirstPatch.await()
                  """{"resolved":{"thinkingLevel":"medium"}}"""
                }
                2 -> """{"resolved":{"thinkingLevel":"ultra"}}"""
                else -> """{"resolved":{"thinkingLevel":"max"}}"""
              }
            }
          },
        )

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
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requests += method
            when (method) {
              "sessions.patch" -> {
                patchStarted.complete(Unit)
                releasePatch.await()
                error("patch failed")
              }
              "chat.send" -> """{"runId":"run-unexpected","status":"ok"}"""
              else -> "{}"
            }
          },
        )
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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleHistoryDoesNotOverwriteAcceptedModelSelection() =
    runTest {
      val historyStarted = CompletableDeferred<Unit>()
      val releaseHistory = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.history" -> {
                historyStarted.complete(Unit)
                releaseHistory.await()
                """{"messages":[],"sessionInfo":{"key":"main","modelProvider":"anthropic","model":"claude-opus-4"}}"""
              }
              "sessions.list" -> """{"sessions":[]}"""
              "chat.metadata" -> """{"commands":[],"models":[]}"""
              else -> "{}"
            }
          },
        )

      controller.load("main")
      historyStarted.await()
      assertTrue(controller.setSessionModelAwait("main", "openai/gpt-5"))

      releaseHistory.complete(Unit)
      advanceUntilIdle()

      assertEquals("openai/gpt-5", controller.selectedModelRef.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun historyHydratesSelectedModelAndAgentScopedCatalog() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.history" ->
                """
                {
                  "sessionId": "session-ops",
                  "messages": [],
                  "sessionInfo": {
                    "key": "agent:ops:main",
                    "modelProvider": "anthropic",
                    "model": "claude-opus-4"
                  }
                }
                """.trimIndent()
              "chat.metadata" ->
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
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )

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
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun emptyModelCatalogIsRetriedOnNextHealthEvent() =
    runTest {
      var metadataRequests = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> {
                metadataRequests += 1
                if (metadataRequests == 1) {
                  """{"commands":[{"name":"new","textAliases":["/new"]}],"models":[]}"""
                } else {
                  """{"commands":[{"name":"new","textAliases":["/new"]}],"models":[{"id":"gpt-5","provider":"openai","input":["text"]}]}"""
                }
              }
              else -> "{}"
            }
          },
        )

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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun validEmptyModelCatalogStopsAfterOneRetry() =
    runTest {
      var metadataRequests = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "chat.metadata") {
              metadataRequests += 1
              """{"commands":[],"models":[]}"""
            } else {
              "{}"
            }
          },
        )

      repeat(3) {
        controller.handleGatewayEvent("health", null)
        advanceUntilIdle()
      }

      assertEquals(2, metadataRequests)
      assertTrue(controller.modelCatalog.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unsupportedReasoningSendsOffWithoutChangingStoredLevelAndRestoresAfterFlip() =
    runTest {
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "chat.send" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
                """{"runId":"run-${sentThinkingLevels.size}","status":"ok"}"""
              }
              "chat.history" -> """{"messages":[],"sessionInfo":{"key":"main"}}"""
              "sessions.list" -> """{"sessions":[]}"""
              // Gating reads the controller-owned agent-scoped catalog hydrated from chat.metadata.
              "chat.metadata" ->
                """
                {
                  "commands": [],
                  "models": [
                    {"id": "plain", "name": "plain", "provider": "openai", "available": true, "input": ["text"], "reasoning": false},
                    {"id": "reasoning", "name": "reasoning", "provider": "openai", "available": true, "input": ["text"], "reasoning": true}
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )
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
  @OptIn(ExperimentalCoroutinesApi::class)
  fun advertisedThinkingLevelsOverrideCatalogReasoningFlagForSend() =
    runTest {
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "chat.metadata" ->
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
              "chat.history" -> """{"messages":[],"sessionInfo":{"key":"main"}}"""
              "sessions.list" -> """{"sessions":[]}"""
              "sessions.patch" ->
                """
                {
                  "resolved": {
                    "modelProvider": "synthetic",
                    "model": "reasoner",
                    "thinkingLevel": "max",
                    "thinkingLevels": [
                      {"id": "off", "label": "off"},
                      {"id": "max", "label": "max"}
                    ]
                  }
                }
                """.trimIndent()
              "chat.send" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
                """{"runId":"run-ok","status":"ok"}"""
              }
              else -> "{}"
            }
          },
        )
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
}
