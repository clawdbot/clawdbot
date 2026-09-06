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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
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
          commandOutbox = this.createChatCommandOutbox(),
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
  fun readsCrossAgentDirectChildrenForWearWithoutMutatingPhoneSwarmState() =
    runTest {
      val target = "agent:main:wear-b"
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, params ->
            requests += method to params
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                """
                {"sessions":[
                  {
                    "key":"agent:codex:subagent:gateway-watch",
                    "parentSessionKey":"$target",
                    "spawnedBy":"$target",
                    "status":"running",
                    "subagentRunState":"active",
                    "hasActiveSubagentRun":true
                  },
                  {
                    "key":"agent:clock:subagent:clock-watch",
                    "parentSessionKey":"$target",
                    "spawnedBy":"$target",
                    "status":"running",
                    "subagentRunState":"active",
                    "hasActiveSubagentRun":true
                  },
                  {
                    "key":"agent:load:subagent:load-watch",
                    "parentSessionKey":"$target",
                    "spawnedBy":"$target",
                    "status":"running",
                    "subagentRunState":"active",
                    "hasActiveSubagentRun":true
                  }
                ],
                  "totalCount":3,
                  "hasMore":false
                }
                """.trimIndent()
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )
      val phoneSessionBefore = controller.sessionKey.value
      val phoneSwarmBefore = controller.currentSwarmSnapshot()

      val snapshot = controller.readSwarmSnapshotFor(target, "main")

      assertTrue(snapshot?.isAvailableFor(target) == true)
      assertEquals(3, snapshot?.groups?.single()?.running)
      assertTrue(
        requests.any { (method, params) ->
          method == "chat.metadata" && params.orEmpty().contains("\"agentId\":\"main\"")
        },
      )
      assertTrue(
        requests.any { (method, params) ->
          method == "sessions.list" &&
            params.orEmpty().contains("\"spawnedBy\":\"$target\"") &&
            !params.orEmpty().contains("\"agentId\"")
        },
      )
      assertEquals(phoneSessionBefore, controller.sessionKey.value)
      assertEquals(phoneSwarmBefore, controller.currentSwarmSnapshot())
    }

  @Test
  fun keepsCollectGroupsSeparateFromDirectWearChildren() =
    runTest {
      val target = "agent:main:wear-b"
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                """
                {"sessions":[
                  {
                    "key":"agent:writer:subagent:collect",
                    "spawnedBy":"$target",
                    "swarmGroupId":"swarm:$target:turn-1",
                    "status":"running"
                  },
                  {
                    "key":"agent:clock:subagent:direct",
                    "spawnedBy":"$target",
                    "status":"running",
                    "subagentRunState":"active"
                  }
                ],"totalCount":2,"hasMore":false}
                """.trimIndent()
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      val snapshot = controller.readSwarmSnapshotFor(target, "main")

      assertEquals(2, snapshot?.groups?.size)
      assertEquals(2, snapshot?.groups?.sumOf { it.running })
    }

  @Test
  fun acceptsGatewayFilteredWearRowsWhenNavigationParentOwnsTheChild() =
    runTest {
      val target = "agent:main:wear-b"
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                """
                {"sessions":[{
                  "key":"agent:codex:subagent:foreign",
                  "spawnedBy":"agent:main:other",
                  "parentSessionKey":"$target",
                  "swarmGroupId":"swarm:$target:turn-1",
                  "status":"running"
                }],"totalCount":1,"hasMore":false}
                """.trimIndent()
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      val snapshot = controller.readSwarmSnapshotFor(target, "main")

      assertTrue(snapshot?.isAvailableFor(target) == true)
      assertEquals(1, snapshot?.groups?.single()?.running)
    }

  @Test
  fun ignoresUngroupedRowsWithoutSubagentProvenance() =
    runTest {
      val target = "agent:main:wear-b"
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                """
                {"sessions":[{
                  "key":"agent:main:ordinary-session",
                  "spawnedBy":"$target",
                  "status":"running"
                }],"totalCount":1,"hasMore":false}
                """.trimIndent()
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      val snapshot = controller.readSwarmSnapshotFor(target, "main")

      assertTrue(snapshot?.isAvailableFor(target) == true)
      assertTrue(snapshot?.groups?.isEmpty() == true)
    }

  @Test
  fun readsEmptyWearSelectedSessionAsAvailableIdleWithoutMutatingPhoneState() =
    runTest {
      val target = "main"
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                assertTrue(params.orEmpty().contains("\"agentId\":\"main\""))
                assertTrue(params.orEmpty().contains("\"spawnedBy\":\"$target\""))
                """{"sessions":[],"totalCount":0,"hasMore":false}"""
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )
      val phoneSessionBefore = controller.sessionKey.value
      val phoneSwarmBefore = controller.currentSwarmSnapshot()

      val snapshot = controller.readSwarmSnapshotFor(target, "main")

      assertTrue(snapshot?.isAvailableFor(target) == true)
      assertTrue(snapshot?.groups?.isEmpty() == true)
      assertEquals(phoneSessionBefore, controller.sessionKey.value)
      assertEquals(phoneSwarmBefore, controller.currentSwarmSnapshot())
    }

  @Test
  fun rejectsForeignAgentWearSessionBeforeAnyGatewayRead() =
    runTest {
      val methods = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ ->
            methods += method
            error("foreign session must fail before Gateway read")
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      val snapshot = controller.readSwarmSnapshotFor("agent:other:foreign", "main")

      assertEquals(null, snapshot)
      assertTrue(methods.isEmpty())
    }

  @Test
  fun rejectsTruncatedWearSessionSwarmInsteadOfPublishingPartialCounts() =
    runTest {
      val target = "agent:main:wear-large"
      var sessionsListCalls = 0
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, params ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                sessionsListCalls += 1
                assertTrue(params.orEmpty().contains("\"limit\":1001"))
                assertTrue(params.orEmpty().contains("\"offset\":0"))
                """
                {
                  "sessions":[],
                  "totalCount":1001,
                  "hasMore":true,
                  "nextOffset":1001
                }
                """.trimIndent()
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      val snapshot = controller.readSwarmSnapshotFor(target, "main")

      assertEquals(null, snapshot)
      assertEquals(1, sessionsListCalls)
    }

  @Test
  fun disabledWearSessionSwarmStaysUnavailableWithoutListingChildren() =
    runTest {
      var sessionsListCalls = 0
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":false}"""
              }

              "sessions.list" -> {
                sessionsListCalls += 1
                error("disabled Swarm must not list children")
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      val snapshot = controller.readSwarmSnapshotFor("agent:main:wear-b", "main")

      assertEquals(false, snapshot?.enabled)
      assertEquals(0, sessionsListCalls)
    }

  @Test
  fun discardsWearSessionSwarmWhenGatewayScopeChangesDuringRead() =
    runTest {
      var currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                currentScope = currentScope.copy(connectionGeneration = 2)
                """{"sessions":[],"totalCount":0,"hasMore":false}"""
              }

              else -> {
                error("unexpected method $method")
              }
            }
          },
          cacheScope = { currentScope },
        )
      val phoneSessionBefore = controller.sessionKey.value
      val phoneSwarmBefore = controller.currentSwarmSnapshot()

      val snapshot = controller.readSwarmSnapshotFor("agent:main:wear-b", "main")

      assertEquals(null, snapshot)
      assertEquals(phoneSessionBefore, controller.sessionKey.value)
      assertEquals(phoneSwarmBefore, controller.currentSwarmSnapshot())
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
          commandOutbox = this.createChatCommandOutbox(),
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
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ -> emptyChatGatewayResponse(method) },
          requestGatewayForGateway = { gatewayId, method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

              "sessions.list" -> {
                listGateways += gatewayId
                """{"sessions":[],"totalCount":0,"hasMore":false}"""
              }

              else -> {
                emptyChatGatewayResponse(method)
              }
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
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = { method, _ -> emptyChatGatewayResponse(method) },
          requestGatewayForGateway = { gatewayId, method, _ ->
            when (method) {
              "chat.metadata" -> {
                """{"commands":[],"models":[],"swarmEnabled":true}"""
              }

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

              else -> {
                emptyChatGatewayResponse(method)
              }
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
