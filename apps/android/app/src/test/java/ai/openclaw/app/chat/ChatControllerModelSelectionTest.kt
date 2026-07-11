package ai.openclaw.app.chat

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
        "sessions.patch" to "{\"key\":\"main\",\"model\":\"anthropic/claude-opus-4\"}",
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
          requestGateway = { _, _ ->
            """
            {
              "resolved": {
                "modelProvider": "anthropic",
                "model": "claude-sonnet-5",
                "thinkingLevel": "max",
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
      assertEquals("{\"key\":\"main\",\"model\":null}", requests.single())
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
