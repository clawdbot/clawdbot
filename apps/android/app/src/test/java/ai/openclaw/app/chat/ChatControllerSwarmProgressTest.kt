package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
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
  fun swarmChildLifecycleStillUpdatesCanonicalSessionProjection() =
    runTest {
      val child =
        """
        {
          "key":"agent:main:child",
          "parentSessionKey":"main",
          "swarmGroupId":"swarm:main:turn-1",
          "status":"running"
        }
        """.trimIndent()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> """{"commands":[],"models":[],"swarmEnabled":true}"""
              "sessions.list" -> """{"sessions":[$child],"totalCount":1,"hasMore":false}"""
              else -> "{}"
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { "main" },
        )

      controller.refreshSessions()
      controller.refreshCommands()
      advanceUntilIdle()
      assertEquals(
        "running",
        controller.sessions.value
          .single()
          .status,
      )

      controller.handleGatewayEvent(
        "sessions.changed",
        """
        {
          "reason":"run-progress",
          "session":{
            "key":"agent:main:child",
            "parentSessionKey":"main",
            "swarmGroupId":"swarm:main:turn-1",
            "status":"done"
          }
        }
        """.trimIndent(),
      )
      runCurrent()

      assertEquals(
        "done",
        controller.sessions.value
          .single()
          .status,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun delayedSwarmRefreshCannotDispatchOnAReplacementGateway() =
    runTest {
      val listGateways = mutableListOf<String>()
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
                listGateways += gatewayId
                """{"sessions":[],"totalCount":0,"hasMore":false}"""
              }
              else -> "{}"
            }
          },
          cacheScope = { currentScope },
        )

      controller.refreshCommands()
      advanceUntilIdle()
      listGateways.clear()

      controller.handleGatewayEvent(
        "sessions.changed",
        """
        {
          "reason":"create",
          "session":{
            "key":"agent:main:child",
            "parentSessionKey":"main",
            "swarmGroupId":"swarm:main:turn-1",
            "status":"running"
          }
        }
        """.trimIndent(),
      )
      runCurrent()
      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      advanceTimeBy(250)
      runCurrent()

      assertTrue(listGateways.isEmpty())
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
