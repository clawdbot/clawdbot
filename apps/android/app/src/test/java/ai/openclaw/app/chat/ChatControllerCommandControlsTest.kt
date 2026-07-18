package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerCommandControlsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parseChatCommandsKeepsTextAliasesAndArgumentFlag() {
    val commands =
      parseChatCommands(
        json,
        """
        {
          "commands": [
            {
              "name": "new",
              "description": "Start a fresh chat",
              "category": "session",
              "textAliases": ["/new", "/reset"],
              "acceptsArgs": false
            },
            {
              "name": "/model",
              "description": "Switch models",
              "category": "options",
              "textAliases": ["model", "/model"],
              "acceptsArgs": true
            }
          ]
        }
        """.trimIndent(),
      )

    assertEquals(2, commands.size)
    assertEquals("new", commands[0].name)
    assertEquals(listOf("/new", "/reset"), commands[0].textAliases)
    assertEquals(false, commands[0].acceptsArgs)
    assertEquals("model", commands[1].name)
    assertEquals(listOf("/model"), commands[1].textAliases)
    assertEquals(true, commands[1].acceptsArgs)
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun healthEventRefreshesCommandsAfterReconnect() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.metadata" ->
                """
                {
                  "commands": [
                    {
                      "name": "model",
                      "description": "Switch models",
                      "textAliases": ["/model"],
                      "acceptsArgs": true
                    }
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(
        listOf("/model"),
        controller.commands.value
          .single()
          .textAliases,
      )

      controller.onDisconnected("gateway closed")
      assertEquals(emptyList<ChatCommandEntry>(), controller.commands.value)

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(
        listOf("/model"),
        controller.commands.value
          .single()
          .textAliases,
      )
      assertEquals(2, requests.count { it.first == "chat.metadata" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun commandListScopesToActiveAgentAndRefreshesAfterAgentSwitch() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.metadata" ->
                if (paramsJson.orEmpty().contains("\"agentId\":\"ops\"")) {
                  """
                  {
                    "commands": [
                      {
                        "name": "ops",
                        "description": "Ops command",
                        "textAliases": ["/ops"],
                        "acceptsArgs": false
                      }
                    ]
                  }
                  """.trimIndent()
                } else {
                  """
                  {
                    "commands": [
                      {
                        "name": "main",
                        "description": "Main command",
                        "textAliases": ["/main"],
                        "acceptsArgs": false
                      }
                    ]
                  }
                  """.trimIndent()
                }
              "chat.history" -> """{"sessionId":"loaded-session","messages":[]}"""
              "health" -> "{}"
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(
        listOf("/main"),
        controller.commands.value
          .single()
          .textAliases,
      )

      controller.switchSession("agent:ops:dashboard:parent")
      advanceUntilIdle()
      assertEquals(
        listOf("/ops"),
        controller.commands.value
          .single()
          .textAliases,
      )

      val commandRequests = requests.filter { it.first == "chat.metadata" }
      assertTrue(commandRequests.any { it.second.orEmpty().contains("\"agentId\":\"main\"") })
      assertTrue(commandRequests.any { it.second.orEmpty().contains("\"agentId\":\"ops\"") })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun delayedCommandListFromPreviousGatewayCannotReplaceCurrentCommands() =
    runTest {
      var cacheScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val gatewayAResponse = CompletableDeferred<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> error("gateway-bound request expected") },
          requestGatewayForGateway = { gatewayId, method, _ ->
            require(method == "chat.metadata")
            if (gatewayId == "gateway-a") {
              gatewayAResponse.await()
            } else {
              commandResponse("gateway-b")
            }
          },
          cacheScope = { cacheScope },
        )

      controller.refreshCommands()
      runCurrent()
      cacheScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.refreshCommands()
      runCurrent()
      assertEquals(
        "gateway-b",
        controller.commands.value
          .single()
          .name,
      )

      gatewayAResponse.complete(commandResponse("gateway-a"))
      advanceUntilIdle()

      assertEquals(
        "gateway-b",
        controller.commands.value
          .single()
          .name,
      )
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatCreatesWriteScopedSessionAndReloadsHistory() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
              "chat.history" -> """{"sessionId":"fresh-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"main\""))
      assertTrue(create.second.orEmpty().contains("\"parentSessionKey\":\"main\""))
      assertTrue(create.second.orEmpty().contains("\"emitCommandHooks\":true"))
      assertTrue(create.second.orEmpty().contains("\"label\":\"New chat\""))
      assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
      assertEquals("fresh-session", controller.sessionId.value)
      assertTrue(requests.any { it.first == "chat.history" })
      assertTrue(requests.any { it.first == "sessions.list" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatInWorktreeIncludesWorktreeFlag() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:worktree"}"""
              "chat.history" -> """{"sessionId":"worktree-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait(worktree = true))

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"worktree\":true"))
    }

  @Test
  fun sessionMutationsSendGatewayContractsAndRefresh() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.list" -> """{"sessions":[]}"""
              "sessions.delete" -> """{"deleted":true}"""
              else -> "{}"
            }
          },
        )

      controller.patchSession(
        key = "main",
        ownerAgentId = "owner-a",
        clearLabel = true,
        clearCategory = true,
        pinned = true,
        archived = false,
        unread = true,
      )
      controller.deleteSession("main", ownerAgentId = "main")

      val patch = requests.first { it.first == "sessions.patch" }.second.orEmpty()
      assertTrue(patch.contains("\"key\":\"main\""))
      assertTrue(patch.contains("\"agentId\":\"owner-a\""))
      assertTrue(patch.contains("\"label\":null"))
      assertTrue(patch.contains("\"category\":null"))
      assertTrue(patch.contains("\"pinned\":true"))
      assertTrue(patch.contains("\"archived\":false"))
      assertTrue(patch.contains("\"unread\":true"))

      val delete = requests.first { it.first == "sessions.delete" }.second.orEmpty()
      assertTrue(delete.contains("\"key\":\"main\""))
      assertTrue(delete.contains("\"deleteTranscript\":true"))
      assertEquals(2, requests.count { it.first == "sessions.list" })
    }

  @Test
  fun renameSessionGroupPatchesEveryMemberIncludingArchivedOnlyOnes() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.list" ->
                if (paramsJson.orEmpty().contains("\"archived\":true")) {
                  """{"sessions":[{"key":"agent:main:active","category":"Work"},{"key":"agent:main:archived","category":" Work "}]}"""
                } else {
                  """{"sessions":[{"key":"agent:main:active","category":"Work"},{"key":"agent:main:other","category":"Play"}]}"""
                }
              else -> "{}"
            }
          },
        )

      controller.renameSessionGroup(from = "Work", to = "Focus")

      // Membership enumeration sends the explicit high bound (absent limit is
      // capped at 100 rows server-side) across active + archived rows.
      val lists = requests.filter { it.first == "sessions.list" }.map { it.second.orEmpty() }
      assertEquals(2, lists.count { it.contains("\"limit\":10000") })
      assertEquals(1, lists.count { it.contains("\"archived\":true") })

      val patches = requests.filter { it.first == "sessions.patch" }.map { it.second.orEmpty() }
      assertEquals(2, patches.size)
      assertTrue(patches.any { it.contains("\"key\":\"agent:main:active\"") && it.contains("\"category\":\"Focus\"") })
      assertTrue(patches.any { it.contains("\"key\":\"agent:main:archived\"") && it.contains("\"category\":\"Focus\"") })
      // The session list refreshes (windowed) after the fan-out.
      assertTrue(lists.last().contains("\"limit\""))
    }

  @Test
  fun dissolveSessionGroupClearsCategoriesBestEffort() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      var patchCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.list" ->
                if (paramsJson.orEmpty().contains("\"archived\":true")) {
                  """{"sessions":[{"key":"agent:main:archived","category":"Work"}]}"""
                } else {
                  """{"sessions":[{"key":"agent:main:a","category":"Work"},{"key":"agent:main:b","category":"Work"}]}"""
                }
              "sessions.patch" -> {
                patchCount += 1
                if (patchCount == 1) throw RuntimeException("offline") else "{}"
              }
              else -> "{}"
            }
          },
        )

      controller.dissolveSessionGroup("Work")

      // One failed member patch must not abandon the remaining members.
      val patches = requests.filter { it.first == "sessions.patch" }.map { it.second.orEmpty() }
      assertEquals(3, patches.size)
      assertTrue(patches.all { it.contains("\"category\":null") })
      assertEquals("offline", controller.errorText.value)
    }

  @Test
  fun forkSessionReturnsCreatedKeyAndRefreshesActiveSessions() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"session":{"key":"agent:main:forked"}}"""
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )

      val key = controller.forkSession("main")

      assertEquals("agent:main:forked", key)
      val create = requests.first { it.first == "sessions.create" }.second.orEmpty()
      assertTrue(create.contains("\"parentSessionKey\":\"main\""))
      assertTrue(create.contains("\"fork\":true"))
      // The active unqualified parent keeps the captured default-agent owner.
      assertTrue(create.contains("\"agentId\":\"main\""))

      // Agent-qualified parents keep the fork under the parent's agent.
      controller.forkSession("agent:ops:dashboard:abc")
      val scopedCreate = requests.last { it.first == "sessions.create" }.second.orEmpty()
      assertTrue(scopedCreate.contains("\"parentSessionKey\":\"agent:ops:dashboard:abc\""))
      assertTrue(scopedCreate.contains("\"agentId\":\"ops\""))

      // Unqualified list rows carry their captured owner through a later default-agent change.
      controller.forkSession("custom", ownerAgentId = "owner-a")
      val capturedOwnerCreate = requests.last { it.first == "sessions.create" }.second.orEmpty()
      assertTrue(capturedOwnerCreate.contains("\"parentSessionKey\":\"custom\""))
      assertTrue(capturedOwnerCreate.contains("\"agentId\":\"owner-a\""))
      assertTrue(requests.any { it.first == "sessions.list" })
      assertEquals(
        false,
        requests
          .last { it.first == "sessions.list" }
          .second
          .orEmpty()
          .contains("\"archived\""),
      )
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun archivedSessionListAndOpenUnreadSessionUsePatchContracts() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"main","unread":true}]}"""
              else -> "{}"
            }
          },
        )

      controller.refreshSessions(archived = true)
      advanceUntilIdle()
      assertTrue(
        requests
          .first { it.first == "sessions.list" }
          .second
          .orEmpty()
          .contains("\"archived\":true"),
      )

      controller.switchSession("main")
      advanceUntilIdle()
      controller.switchSession("main")
      advanceUntilIdle()

      val patch = requests.single { it.first == "sessions.patch" }.second.orEmpty()
      assertTrue(patch.contains("\"key\":\"main\""))
      assertTrue(patch.contains("\"unread\":false"))
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun sessionEventsApplyExplicitLabelAndCategoryClears() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"main","label":"Named","category":"Work"}]}"""
              else -> "{}"
            }
          },
        )

      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals(
        "Work",
        controller.sessions.value
          .single()
          .category,
      )

      // Another client cleared the group and name; the gateway sends explicit nulls.
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","label":null,"category":null}}""",
      )
      advanceUntilIdle()
      val merged = controller.sessions.value.single()
      assertEquals(null, merged.label)
      assertEquals(null, merged.category)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun failedReadAcknowledgementUnlatchesForRetry() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      var failPatches = true
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.patch" -> if (failPatches) throw RuntimeException("offline") else "{}"
              "sessions.list" -> """{"sessions":[{"key":"main","unread":true}]}"""
              else -> "{}"
            }
          },
        )

      controller.refreshSessions()
      advanceUntilIdle()
      controller.switchSession("main")
      advanceUntilIdle()
      assertEquals(1, requests.count { it.first == "sessions.patch" })

      // The failed acknowledgement unlatched; the next unread snapshot retries.
      failPatches = false
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":true}}""",
      )
      advanceUntilIdle()
      assertEquals(2, requests.count { it.first == "sessions.patch" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun archivingOrDeletingTheOpenSessionFallsBackToMain() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"agent:main:side"}]}"""
              "sessions.delete" -> """{"deleted":true}"""
              else -> "{}"
            }
          },
        )

      controller.switchSession("agent:main:side")
      advanceUntilIdle()
      assertEquals("agent:main:side", controller.sessionKey.value)

      controller.patchSession(key = "agent:main:side", archived = true)
      advanceUntilIdle()
      assertEquals("main", controller.sessionKey.value)

      controller.switchSession("agent:main:side")
      advanceUntilIdle()
      controller.deleteSession("agent:main:side")
      advanceUntilIdle()
      assertEquals("main", controller.sessionKey.value)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun openSessionReacknowledgesUnreadOncePerEpisode() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"main","unread":false}]}"""
              else -> "{}"
            }
          },
        )

      controller.refreshSessions()
      advanceUntilIdle()
      controller.switchSession("main")
      advanceUntilIdle()
      assertEquals(0, requests.count { it.first == "sessions.patch" })

      // A run completes while the session stays open: the gateway flags it unread again.
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":true}}""",
      )
      advanceUntilIdle()
      assertEquals(1, requests.count { it.first == "sessions.patch" })

      // Server-confirmed read resets the episode; a stale duplicate must not re-patch.
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":false}}""",
      )
      advanceUntilIdle()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":true}}""",
      )
      advanceUntilIdle()
      assertEquals(2, requests.count { it.first == "sessions.patch" })
    }

  @Test
  fun startNewChatWithoutLoadedParentCreatesFirstSession() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:first"}"""
              "chat.history" -> """{"sessionId":"first-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"main\""))
      assertEquals(false, create.second.orEmpty().contains("\"parentSessionKey\""))
      assertEquals(false, create.second.orEmpty().contains("\"emitCommandHooks\""))
      assertEquals("agent:main:dashboard:first", controller.sessionKey.value)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatUsesNextAvailableNewChatLabel() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:fresh-3"}"""
              "chat.history" -> """{"sessionId":"fresh-session-3","messages":[]}"""
              "health" -> "{}"
              "sessions.list" ->
                """
                {
                  "sessions": [
                    {"key":"agent:main:dashboard:fresh","displayName":"New chat"},
                    {"key":"agent:main:dashboard:fresh-2","displayName":"New chat 2"}
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)
      controller.refreshSessions()
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"label\":\"New chat 3\""))
      assertEquals("agent:main:dashboard:fresh-3", controller.sessionKey.value)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatScopesCreateToActiveAgentSession() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:ops:dashboard:fresh"}"""
              "chat.history" -> """{"sessionId":"ops-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )

      controller.switchSession("agent:ops:dashboard:parent")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"ops\""))
      assertTrue(create.second.orEmpty().contains("\"parentSessionKey\":\"agent:ops:dashboard:parent\""))
      assertEquals("agent:ops:dashboard:fresh", controller.sessionKey.value)
    }

  @Test
  fun bareNewSlashCommandUsesGatewayChatCommandPath() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.send" -> """{"runId":"run-new"}"""
              "health" -> "{}"
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("/new", "off", emptyList()))

      val send = requests.single { it.first == "chat.send" }
      assertTrue(send.second.orEmpty().contains("\"message\":\"/new\""))
      assertTrue(requests.none { it.first == "sessions.create" })
    }

  @Test
  fun startNewChatRejectsWhileRunPending() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.send" -> """{"runId":"run-1"}"""
              "health" -> "{}"
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("hello", "off", emptyList()))
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals(false, controller.startNewChatAwait())
      assertTrue(requests.none { it.first == "sessions.create" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatRejectsDuplicateCreateWhileFirstRequestIsPending() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val createEntered = CompletableDeferred<Unit>()
      val releaseCreate = CompletableDeferred<Unit>()
      var createCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> {
                createCount += 1
                createEntered.complete(Unit)
                releaseCreate.await()
                """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
              }
              "chat.history" -> """{"sessionId":"fresh-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      val first = async { controller.startNewChatAwait() }
      createEntered.await()

      val second = async { controller.startNewChatAwait() }
      advanceUntilIdle()
      releaseCreate.complete(Unit)

      assertTrue(first.await())
      assertEquals(false, second.await())
      assertEquals(1, createCount)
      assertEquals(1, requests.count { it.first == "sessions.create" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatIgnoresStaleCreateResponseAfterSessionSwitch() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      lateinit var controller: ChatController
      controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> {
                controller.switchSession("agent:main:dashboard:other")
                """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
              }
              "chat.history" -> """{"sessionId":"other-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertEquals(false, controller.startNewChatAwait())
      advanceUntilIdle()
      assertEquals("agent:main:dashboard:other", controller.sessionKey.value)
      assertEquals("other-session", controller.sessionId.value)
      assertTrue(requests.any { it.first == "sessions.create" })
    }

  private fun commandResponse(name: String): String = """{"commands":[{"name":"$name","textAliases":["/$name"],"acceptsArgs":false}]}"""
}
