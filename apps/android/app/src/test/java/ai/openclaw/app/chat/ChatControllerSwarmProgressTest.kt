package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerSwarmProgressTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disabledSwarmDoesNotFetchChildSessions() =
    runTest {
      val methods = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            methods += method
            when (method) {
              "chat.metadata" -> """{"commands":[],"models":[],"swarmEnabled":false}"""
              else -> "{}"
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      controller.refreshCommands()
      advanceUntilIdle()

      assertTrue("sessions.list" !in methods)
      assertTrue(controller.swarmGroups.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun oldGatewaySwarmResponseCannotPopulateTheNewGateway() =
    runTest {
      val listStarted = CompletableDeferred<Unit>()
      val listGate = CompletableDeferred<Unit>()
      var currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> "{}" },
          requestGatewayForGateway = { gatewayId, method, _ ->
            when (method) {
              "chat.metadata" -> """{"commands":[],"models":[],"swarmEnabled":true}"""
              "sessions.list" -> {
                check(gatewayId == "gateway-a")
                listStarted.complete(Unit)
                listGate.await()
                """
                {
                  "sessions":[{
                    "key":"agent:main:child",
                    "parentSessionKey":"main",
                    "swarmGroupId":"swarm:main:turn-1",
                    "status":"running"
                  }],
                  "totalCount":1,
                  "hasMore":false
                }
                """.trimIndent()
              }
              else -> "{}"
            }
          },
          cacheScope = { currentScope },
        )

      controller.refreshCommands()
      runCurrent()
      listStarted.await()

      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      assertTrue(controller.swarmGroups.value.isEmpty())

      listGate.complete(Unit)
      advanceUntilIdle()

      assertTrue(controller.swarmGroups.value.isEmpty())
    }
}
