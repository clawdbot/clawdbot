package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerCommandControlsTest {
  private val json = chatControllerTestJson

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

  @Test
  fun healthEventRefreshesCommandsAfterReconnect() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata", commandResponse("model", "Switch models", acceptsArgs = true))
        }

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

  @Test
  fun commandListScopesToActiveAgentAndRefreshesAfterAgentSwitch() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata") { paramsJson ->
            if (paramsJson.orEmpty().contains("\"agentId\":\"ops\"")) {
              commandResponse("ops", "Ops command")
            } else {
              commandResponse("main", "Main command")
            }
          }
          respond("chat.history", """{"sessionId":"loaded-session","messages":[]}""")
          respond("health", "{}")
        }

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

  @Test
  fun delayedCommandListFromPreviousGatewayCannotReplaceCurrentCommands() =
    runTest {
      var cacheScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val gatewayAResponse = CompletableDeferred<String>()
      val controller =
        createChatController(
          requestGatewayForGateway = { gatewayId, method, _ ->
            require(method == "chat.metadata")
            if (gatewayId == "gateway-a") {
              gatewayAResponse.await()
            } else {
              commandResponse("gateway-b")
            }
          },
          cacheScope = { cacheScope },
        ) { _, _ -> error("gateway-bound request expected") }

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

  @Test
  fun startNewChatCreatesUnnamedWriteScopedSessionAndReloadsHistory() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create", """{"ok":true,"key":"agent:main:dashboard:fresh"}""")
          respond("chat.history", """{"sessionId":"fresh-session","messages":[]}""")
          respond("health", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"main\""))
      assertTrue(create.second.orEmpty().contains("\"parentSessionKey\":\"main\""))
      assertTrue(create.second.orEmpty().contains("\"emitCommandHooks\":true"))
      assertTrue(create.second.orEmpty().contains("\"succeedsParent\":false"))
      assertFalse(create.second.orEmpty().contains("\"label\""))
      assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
      assertEquals("fresh-session", controller.sessionId.value)
      assertTrue(requests.any { it.first == "chat.history" })
      assertTrue(requests.any { it.first == "sessions.list" })
    }

  @Test
  fun lockedParentRejectsGenericForkAndWorktreeChats() =
    runTest {
      for (action in listOf("fork", "worktree")) {
        val (controller, requests) =
          chatControllerTestSetup {
            respond("sessions.create", """{"key":"agent:main:dashboard:child"}""")
            respond(
              "chat.history",
              """{"sessionId":"locked-parent","messages":[],"sessionInfo":{"key":"main","agentId":"main","sessionId":"locked-parent","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"}}}""",
            )
            respond("sessions.list", """{"sessions":[]}""")
          }
        controller.load("main")
        runCurrent()

        val accepted =
          if (action == "fork") {
            controller.forkSession("main", ownerAgentId = "main") != null
          } else {
            controller.startNewChatAwait(worktree = action == "worktree")
          }

        assertFalse("$action must not create a child of a locked parent", accepted)
        assertTrue(requests.none { it.first == "sessions.create" })
        assertTrue("The rejected action needs a visible explanation", !controller.errorText.value.isNullOrBlank())
        assertEquals("main", controller.sessionKey.value)
      }
    }

  @Test
  fun parentActionsRecheckLockBeforeTransportEnqueue() =
    runTest {
      for (fork in listOf(false, true)) {
        val transportStarted = CompletableDeferred<Unit>()
        val releaseTransport = CompletableDeferred<Unit>()
        val creates = mutableListOf<String?>()

        suspend fun request(
          method: String,
          paramsJson: String?,
          withEnqueue: (() -> Unit) -> Unit = { it() },
        ): String {
          if (method == "sessions.create") {
            transportStarted.complete(Unit)
            releaseTransport.await()
          }
          withEnqueue { if (method == "sessions.create") creates += paramsJson }
          return when (method) {
            "sessions.create" -> {
              """{"key":"agent:main:dashboard:child"}"""
            }

            "chat.history" -> {
              """{"sessionId":"lineage-parent","messages":[],"sessionInfo":{"key":"main","agentId":"main","sessionId":"lineage-parent","modelSelectionLocked":false}}"""
            }

            "sessions.list" -> {
              """{"sessions":[]}"""
            }

            else -> {
              "{}"
            }
          }
        }

        val controller =
          createChatController(
            captureRequestLease = {
              GatewaySession.RequestLease(endpointStableId = "") { method, paramsJson, _, withEnqueue ->
                request(method, paramsJson, withEnqueue)
              }
            },
          ) { method, paramsJson -> request(method, paramsJson) }
        controller.load("main")
        runCurrent()
        val pending =
          async {
            if (fork) {
              controller.forkSession("main", ownerAgentId = "main") != null
            } else {
              controller.startNewChatAwait(worktree = true)
            }
          }

        try {
          transportStarted.await()
          controller.handleGatewayEvent(
            "sessions.changed",
            """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"}}}""",
          )
        } finally {
          releaseTransport.complete(Unit)
        }

        assertFalse("A newly locked parent must reject fork=$fork before enqueue", pending.await())
        assertTrue("No child-create request may reach the transport", creates.isEmpty())
        assertEquals("main", controller.sessionKey.value)
      }
    }

  @Test
  fun startNewChatRetriesWithoutParentLifecycleAgainstOlderGateway() =
    runTest {
      var createCalls = 0
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create") { paramsJson ->
            createCalls += 1
            if (createCalls == 1) {
              throw GatewayRequestRejected(
                GatewaySession.ErrorShape(
                  code = "INVALID_REQUEST",
                  message =
                    "invalid sessions.create params: at root: unexpected property 'succeedsParent'",
                ),
              )
            }
            """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
          }
          respond("chat.history", """{"sessionId":"fresh-session","messages":[]}""")
          respond("health", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val creates = requests.filter { it.first == "sessions.create" }
      assertEquals(2, creates.size)
      assertTrue(creates[0].second.orEmpty().contains("\"succeedsParent\":false"))
      assertEquals(false, creates[1].second.orEmpty().contains("\"succeedsParent\""))
      assertEquals(false, creates[1].second.orEmpty().contains("\"parentSessionKey\""))
      assertEquals(false, creates[1].second.orEmpty().contains("\"emitCommandHooks\""))
      assertTrue(creates[1].second.orEmpty().contains("\"agentId\":\"main\""))
      assertFalse(creates.any { it.second.orEmpty().contains("\"label\"") })
      assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
    }

  @Test
  fun newSessionCreatesRootSessionFromLockedParentForSelectedAgent() =
    runTest {
      for (catalogId in listOf(null, "codex")) {
        val (controller, requests) =
          chatControllerTestSetup {
            respond("sessions.create", """{"ok":true,"key":"agent:main:dashboard:fresh"}""")
            respond(
              "chat.history",
              """{"sessionId":"locked-session","messages":[],"sessionInfo":{"key":"main","agentId":"main","sessionId":"locked-session","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"}}}""",
            )
            respond("health", "{}")
            respond("sessions.list", """{"sessions":[]}""")
          }
        controller.handleGatewayEvent("health", null)
        controller.load("main")
        advanceUntilIdle()

        assertTrue("New session must work with catalog=$catalogId", controller.startNewChatAwait(catalogId = catalogId))

        val create = json.parseToJsonElement(requests.single { it.first == "sessions.create" }.second.orEmpty()).jsonObject
        assertEquals(setOfNotNull("agentId", catalogId?.let { "catalogId" }), create.keys)
        assertEquals(JsonPrimitive("main"), create["agentId"])
        assertEquals(catalogId?.let(::JsonPrimitive), create["catalogId"])
        assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
        assertEquals(null, controller.errorText.value)
      }
    }

  @Test
  fun startNewChatInWorktreeIncludesWorktreeFlag() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create", """{"ok":true,"key":"agent:main:dashboard:worktree"}""")
          respond("chat.history", """{"sessionId":"worktree-session","messages":[]}""")
          respond("health", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }
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
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list", """{"sessions":[]}""")
          respond("sessions.delete", """{"deleted":true}""")
        }

      controller.patchSession(
        key = "main",
        ownerAgentId = "owner-a",
        expectedSessionId = "session-main",
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
      assertTrue(patch.contains("\"expectedSessionId\":\"session-main\""))
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
  fun sessionColorCanBeSetAndClearedWithoutOtherChanges() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list", """{"sessions":[]}""")
        }

      assertTrue(controller.patchSession(key = "main", ownerAgentId = "owner-a", color = "purple"))
      assertTrue(controller.patchSession(key = "main", ownerAgentId = "owner-a", clearColor = true))

      val patches = requests.filter { it.first == "sessions.patch" }.map { json.parseToJsonElement(it.second!!).jsonObject }
      assertEquals(listOf(JsonPrimitive("purple"), JsonNull), patches.map { it["color"] })
      assertTrue(patches.all { it["agentId"] == JsonPrimitive("owner-a") })
      assertEquals(2, requests.count { it.first == "sessions.list" })
    }

  @Test
  fun manualSessionRenamePersistsExplicitLabel() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.patch", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }

      assertTrue(controller.patchSession(key = "main", ownerAgentId = "owner-a", label = "Renamed chat"))

      val patch = requests.single { it.first == "sessions.patch" }.second.orEmpty()
      assertTrue(patch.contains("\"key\":\"main\""))
      assertTrue(patch.contains("\"agentId\":\"owner-a\""))
      assertTrue(patch.contains("\"label\":\"Renamed chat\""))
    }

  @Test
  fun archiveUsesObservedIdentityAndArchiveDeadline() =
    runTest {
      var archiveParams: String? = null
      var archiveTimeoutMs: Long? = null
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            check(method != "sessions.patch") { "archive must use its captured request lease" }
            if (method == "sessions.list") """{"sessions":[]}""" else "{}"
          },
          cacheScope = { ChatCacheScope("gateway-a", 1) },
          captureRequestLease = { capturedScope ->
            assertEquals(ChatCacheScope("gateway-a", 1), capturedScope)
            GatewaySession.RequestLease(endpointStableId = "gateway-a") { method, paramsJson, timeoutMs, withEnqueue ->
              withEnqueue {}
              assertEquals("sessions.patch", method)
              archiveParams = paramsJson
              archiveTimeoutMs = timeoutMs
              "{}"
            }
          },
        )

      assertTrue(
        controller.patchSession(
          key = "agent:main:side",
          expectedSessionId = "session-side",
          archived = true,
        ),
      )

      assertTrue(archiveParams.orEmpty().contains("\"expectedSessionId\":\"session-side\""))
      assertEquals(10 * 60_000L, archiveTimeoutMs)
    }

  @Test
  fun archiveWithoutObservedIdentityDoesNotDispatch() =
    runTest {
      val requests = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requests += method
            "{}"
          },
        )

      assertFalse(controller.patchSession(key = "agent:main:cached", archived = true))
      assertFalse(requests.contains("sessions.patch"))
    }

  @Test
  fun renameSessionGroupPatchesEveryMemberIncludingArchivedOnlyOnes() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list") { paramsJson ->
            if (paramsJson.orEmpty().contains("\"archived\":true")) {
              """{"sessions":[{"key":"agent:main:active","category":"Work"},{"key":"agent:main:archived","category":" Work "}]}"""
            } else {
              """{"sessions":[{"key":"agent:main:active","category":"Work"},{"key":"agent:main:other","category":"Play"}]}"""
            }
          }
        }

      controller.refreshSessions(limit = 100)
      advanceUntilIdle()
      requests.clear()

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
      // Group enumeration must not replace the requested display window.
      assertEquals(JsonPrimitive(100), json.parseToJsonElement(lists.last()).jsonObject["limit"])
    }

  @Test
  fun dissolveSessionGroupClearsCategoriesBestEffort() =
    runTest {
      var patchCount = 0
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list") { paramsJson ->
            if (paramsJson.orEmpty().contains("\"archived\":true")) {
              """{"sessions":[{"key":"agent:main:archived","category":"Work"}]}"""
            } else {
              """{"sessions":[{"key":"agent:main:a","category":"Work"},{"key":"agent:main:b","category":"Work"}]}"""
            }
          }
          respond("sessions.patch") { paramsJson ->
            patchCount += 1
            if (patchCount == 1) throw RuntimeException("offline") else "{}"
          }
        }

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
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create", """{"session":{"key":"agent:main:forked"}}""")
          respond("sessions.list", """{"sessions":[]}""")
        }

      val key = controller.forkSession("main")

      assertEquals("agent:main:forked", key)
      val create = requests.first { it.first == "sessions.create" }.second.orEmpty()
      assertTrue(create.contains("\"parentSessionKey\":\"main\""))
      assertTrue(create.contains("\"fork\":true"))
      assertFalse(create.contains("\"forkFrom\""))
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

      controller.forkSession("main", fromLastCompleted = true)
      val activeCreate = requests.last { it.first == "sessions.create" }.second.orEmpty()
      assertTrue(activeCreate.contains("\"forkFrom\":\"last-completed\""))
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

  @Test
  fun archivedSessionListAndOpenUnreadSessionUsePatchContracts() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","sessionId":"session-main","unread":true}]}""",
          )
        }

      controller.refreshSessions(archived = true)
      advanceUntilIdle()
      assertTrue(
        requests
          .first { it.first == "sessions.list" }
          .second
          .orEmpty()
          .contains("\"archived\":true"),
      )
      assertEquals(
        "session-main",
        controller.sessions.value
          .single()
          .sessionId,
      )

      controller.switchSession("main")
      advanceUntilIdle()
      controller.switchSession("main")
      advanceUntilIdle()

      val patch = requests.single { it.first == "sessions.patch" }.second.orEmpty()
      assertTrue(patch.contains("\"key\":\"main\""))
      assertTrue(patch.contains("\"unread\":false"))
    }

  @Test
  fun sessionEventsApplyExplicitMetadataClears() =
    runTest {
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main","label":"Named","category":"Work","color":" BLUE "}]}""")
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals(
        "Work",
        controller.sessions.value
          .single()
          .category,
      )

      assertEquals(
        "blue",
        controller.sessions.value
          .single()
          .color,
      )

      // Another client cleared the metadata; the gateway sends explicit nulls.
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","label":null,"category":null,"color":null}}""",
      )
      advanceUntilIdle()
      val merged = controller.sessions.value.single()
      assertEquals(null, merged.label)
      assertEquals(null, merged.category)
      assertEquals(null, merged.color)
    }

  @Test
  fun failedReadAcknowledgementUnlatchesForRetry() =
    runTest {
      var failPatches = true
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.patch") { paramsJson ->
            if (failPatches) throw RuntimeException("offline") else "{}"
          }
          respond("sessions.list", """{"sessions":[{"key":"main","unread":true}]}""")
        }

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

  @Test
  fun explicitMarkReadUsesLegacyCompatiblePayloadOnCurrentGateway() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = { it == SESSION_UNREAD_ACK_CAPABILITY }
        }

      assertTrue(controller.patchSession(key = "main", unread = false))
      advanceUntilIdle()

      val patch = requests.single { it.first == "sessions.patch" }.second.orEmpty()
      assertTrue(patch.contains("\"unread\":false"))
      assertFalse(patch.contains("readIntent"))
      assertFalse(patch.contains("expectedMarkedUnreadAt"))
    }

  @Test
  fun archivingOrDeletingTheOpenSessionFallsBackToMain() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history", """{"sessionId":"session-side","messages":[]}""")
          respond("sessions.list", """{"sessions":[{"key":"agent:main:side","sessionId":"session-side"}]}""")
          respond("sessions.delete", """{"deleted":true}""")
        }

      controller.switchSession("agent:main:side")
      advanceUntilIdle()
      assertEquals("agent:main:side", controller.sessionKey.value)

      controller.patchSession(
        key = "agent:main:side",
        expectedSessionId = "session-side",
        archived = true,
      )
      advanceUntilIdle()
      assertEquals("main", controller.sessionKey.value)

      controller.switchSession("agent:main:side")
      advanceUntilIdle()
      controller.deleteSession("agent:main:side")
      advanceUntilIdle()
      assertEquals("main", controller.sessionKey.value)
    }

  @Test
  fun openSessionReacknowledgesUnreadOncePerEpisode() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list", """{"sessions":[{"key":"main","unread":false}]}""")
        }

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
      assertFalse(
        requests
          .single { it.first == "sessions.patch" }
          .second
          .orEmpty()
          .contains("expectedMarkedUnreadAt"),
      )

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
  fun manualUnreadOnOpenSessionSurvivesRunUpdatesUntilReactivation() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = { it == SESSION_UNREAD_ACK_CAPABILITY }
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","unread":false},{"key":"other","unread":false}]}""",
          )
        }

      controller.refreshSessions()
      advanceUntilIdle()
      controller.switchSession("main")
      advanceUntilIdle()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":true,"markedUnreadAt":100}}""",
      )
      advanceUntilIdle()
      assertEquals(0, requests.count { it.first == "sessions.patch" })
      val retained = controller.sessions.value.first { it.key == "main" }
      assertEquals(true, retained.unread)
      assertEquals(100L, retained.markedUnreadAt)

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":true,"markedUnreadAt":100,"hasActiveRun":true,"status":"running"}}""",
      )
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","unread":true,"markedUnreadAt":100,"hasActiveRun":false,"status":"done"}}""",
      )
      advanceUntilIdle()
      assertEquals(0, requests.count { it.first == "sessions.patch" })

      controller.switchSession("other")
      advanceUntilIdle()
      controller.switchSession("main")
      advanceUntilIdle()

      val patch = requests.single { it.first == "sessions.patch" }.second.orEmpty()
      assertTrue(patch.contains("\"unread\":false"))
      assertTrue(patch.contains("\"expectedMarkedUnreadAt\":100"))
      assertFalse(patch.contains("readIntent"))
    }

  @Test
  fun startNewChatWithoutLoadedParentCreatesFirstSession() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create", """{"ok":true,"key":"agent:main:dashboard:first"}""")
          respond("chat.history", """{"sessionId":"first-session","messages":[]}""")
          respond("health", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"main\""))
      assertEquals(false, create.second.orEmpty().contains("\"parentSessionKey\""))
      assertEquals(false, create.second.orEmpty().contains("\"emitCommandHooks\""))
      assertEquals("agent:main:dashboard:first", controller.sessionKey.value)
    }

  @Test
  fun startNewChatScopesCreateToActiveAgentSession() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create", """{"ok":true,"key":"agent:ops:dashboard:fresh"}""")
          respond("chat.history", """{"sessionId":"ops-session","messages":[]}""")
          respond("health", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }

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
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.send", """{"runId":"run-new"}""")
          respond("health", "{}")
        }
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("/new", "off", emptyList()))

      val send = requests.single { it.first == "chat.send" }
      assertTrue(send.second.orEmpty().contains("\"message\":\"/new\""))
      assertTrue(requests.none { it.first == "sessions.create" })
    }

  @Test
  fun startNewChatRejectsWhileRunPending() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.send", """{"runId":"run-1"}""")
          respond("health", "{}")
        }
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("hello", "off", emptyList()))
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals(false, controller.startNewChatAwait())
      assertTrue(requests.none { it.first == "sessions.create" })
    }

  @Test
  fun startNewChatRejectsDuplicateCreateWhileFirstRequestIsPending() =
    runTest {
      val createEntered = CompletableDeferred<Unit>()
      val releaseCreate = CompletableDeferred<Unit>()
      var createCount = 0
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.create") { paramsJson ->
            createCount += 1
            createEntered.complete(Unit)
            releaseCreate.await()
            """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
          }
          respond("chat.history", """{"sessionId":"fresh-session","messages":[]}""")
          respond("health", "{}")
          respond("sessions.list", """{"sessions":[]}""")
        }
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

  @Test
  fun startNewChatSelectsCreatedSessionAfterConcurrentSameSessionHistoryLoad() =
    runTest {
      for (refreshLoadedParent in listOf(false, true)) {
        val createEntered = CompletableDeferred<Unit>()
        val releaseCreate = CompletableDeferred<Unit>()
        val (controller, requests) =
          chatControllerTestSetup {
            respond("sessions.create") {
              createEntered.complete(Unit)
              releaseCreate.await()
              """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
            }
            respond("chat.history") { paramsJson ->
              val sessionId =
                if (paramsJson.orEmpty().contains("agent:main:dashboard:fresh")) "fresh-session" else "parent-session"
              historyResponse(sessionId, emptyList())
            }
            respond("health", "{}")
            respond("sessions.list", """{"sessions":[]}""")
          }
        controller.handleGatewayEvent("health", null)
        if (refreshLoadedParent) {
          controller.load("main")
          advanceUntilIdle()
          assertEquals("parent-session", controller.sessionId.value)
        }

        val historyRequests = requests.count { it.first == "chat.history" }
        val create = async { controller.startNewChatAwait() }
        createEntered.await()
        try {
          if (refreshLoadedParent) controller.refresh() else controller.load("main")
          advanceUntilIdle()
          assertEquals(historyRequests + 1, requests.count { it.first == "chat.history" })
          assertEquals("main", controller.sessionKey.value)
          assertEquals("parent-session", controller.sessionId.value)
          assertFalse(controller.historyLoading.value)
        } finally {
          releaseCreate.complete(Unit)
        }

        assertTrue("New must survive same-session history; refreshLoadedParent=$refreshLoadedParent", create.await())
        assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
        assertEquals("fresh-session", controller.sessionId.value)
        assertEquals(1, requests.count { it.first == "sessions.create" })
      }
    }

  @Test
  fun startNewChatIgnoresStaleCreateResponseAfterOwnershipChanges() =
    runTest {
      for (change in listOf("navigation", "navigation-away-back", "canonical-parent", "default-owner-away-back", "gateway", "connection")) {
        val createEntered = CompletableDeferred<Unit>()
        val createResponse = CompletableDeferred<String>()
        val gateway = ScriptedGateway(json)
        var gatewayScope = ChatCacheScope("gateway-a", 1)
        var defaultAgentId = "main"
        var defaultAgentRevision = 0L
        var parentSessionId = "session-a"
        var leaseCurrent = true
        gateway.respond("sessions.create") {
          createEntered.complete(Unit)
          createResponse.await()
        }
        gateway.respond("chat.history") { paramsJson ->
          val params = json.parseToJsonElement(paramsJson!!).jsonObject
          val key = params.getValue("sessionKey").jsonPrimitive.content
          val owner = params.getValue("agentId").jsonPrimitive.content
          historyResponse(if (key == "main") "$owner-$parentSessionId" else "$key-session", emptyList())
        }
        gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
        val controller =
          createChatController(
            cacheScope = { gatewayScope },
            currentDefaultAgentId = { defaultAgentId },
            currentDefaultAgentRevision = { defaultAgentRevision },
            captureRequestLease = { capturedScope ->
              GatewaySession.RequestLease(
                endpointStableId = capturedScope?.gatewayId.orEmpty(),
                isCurrentImpl = { leaseCurrent },
              ) { method, paramsJson, _, withEnqueue ->
                withEnqueue {}
                gateway.request(method, paramsJson)
              }
            },
            requestGateway = gateway::request,
          )
        controller.load("main")
        runCurrent()
        assertEquals("main-session-a", controller.sessionId.value)

        val create = async { controller.startNewChatAwait() }
        try {
          createEntered.await()
          when (change) {
            "navigation" -> {
              controller.switchSession("other")
            }

            "navigation-away-back" -> {
              controller.switchSession("other")
              runCurrent()
              controller.switchSession("main")
            }

            "canonical-parent" -> {
              parentSessionId = "session-b"
              controller.refresh()
            }

            "default-owner-away-back" -> {
              for (owner in listOf("ops", "main")) {
                defaultAgentId = owner
                defaultAgentRevision += 1
                controller.onDefaultAgentChanged(owner)
                runCurrent()
              }
            }

            "gateway" -> {
              gatewayScope = ChatCacheScope("gateway-b", 2)
              controller.onGatewayScopeChanging()
              controller.load("main")
            }

            "connection" -> {
              // Socket retirement precedes delivery of the controller's disconnect callback.
              leaseCurrent = false
            }
          }
          runCurrent()
          val selectedKey = controller.sessionKey.value
          val selectedOwner = controller.sessionOwnerAgentId.value
          val selectedSessionId = controller.sessionId.value
          val historyRequests = gateway.callCount("chat.history")
          createResponse.complete("""{"ok":true,"key":"agent:main:dashboard:fresh"}""")

          assertFalse("A stale create must not select its result after $change", create.await())
          runCurrent()
          assertEquals(selectedKey, controller.sessionKey.value)
          assertEquals(selectedOwner, controller.sessionOwnerAgentId.value)
          assertEquals(selectedSessionId, controller.sessionId.value)
          assertNull(controller.errorText.value)
          assertEquals(historyRequests, gateway.callCount("chat.history"))
          assertEquals(1, gateway.callCount("sessions.create"))
        } finally {
          createResponse.complete("""{"ok":true,"key":"agent:main:dashboard:fresh"}""")
        }
      }
    }

  @Test
  fun startNewChatLateFailurePreservesNewerSessionHistoryLoad() =
    runTest {
      val createEntered = CompletableDeferred<Unit>()
      val createResponse = CompletableDeferred<String>()
      val historyEntered = CompletableDeferred<Unit>()
      val historyResponse = CompletableDeferred<String>()
      val controller =
        createScriptedChatController {
          respond("sessions.create") {
            createEntered.complete(Unit)
            createResponse.await()
          }
          respond("chat.history") {
            historyEntered.complete(Unit)
            historyResponse.await()
          }
        }
      val create = async { controller.startNewChatAwait() }
      try {
        createEntered.await()
        controller.switchSession("other")
        historyEntered.await()
        assertTrue(controller.historyLoading.value)

        createResponse.completeExceptionally(IllegalStateException("old create failed"))
        assertFalse(create.await())
        assertEquals("other", controller.sessionKey.value)
        assertTrue(controller.historyLoading.value)
        assertNull(controller.errorText.value)

        historyResponse.complete("""{"sessionId":"other-session","messages":[]}""")
      } finally {
        createResponse.complete("{}")
        historyResponse.complete("""{"sessionId":"other-session","messages":[]}""")
      }
      advanceUntilIdle()
      assertEquals("other-session", controller.sessionId.value)
      assertFalse(controller.historyLoading.value)
      assertNull(controller.errorText.value)
    }

  @Test
  fun startNewChatPropagatesCancellationAndAllowsAnotherCreate() =
    runTest {
      val cancellation = CancellationException("create cancelled")
      var cancelCreate = true
      val controller =
        createScriptedChatController {
          respond("sessions.create") {
            if (cancelCreate) throw cancellation
            """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
          }
          respond("chat.history", """{"sessionId":"fresh-session","messages":[]}""")
        }

      assertSame(cancellation, runCatching { controller.startNewChatAwait() }.exceptionOrNull())
      assertNull(controller.errorText.value)
      cancelCreate = false

      assertTrue(controller.startNewChatAwait())
      assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
    }

  @Test
  fun startNewChatCancellationClearsSpinnerWhenRefreshFinishesBeforeAdmission() =
    runTest {
      val gatewayScope = ChatCacheScope("gateway-a", 1)
      val gateway = ScriptedGateway(json)
      val cancellation = CancellationException("create cancelled")
      var refreshBeforeAdmission = false
      lateinit var controller: ChatController
      gateway.respondWith("chat.history", historyResponse("parent-session", emptyList()))
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      gateway.respond("sessions.create") { throw cancellation }
      controller =
        createChatController(
          cacheScope = { gatewayScope },
          captureRequestLease = {
            GatewaySession.RequestLease(
              endpointStableId = gatewayScope.gatewayId,
              commitIfCurrentImpl = { block ->
                if (refreshBeforeAdmission) {
                  refreshBeforeAdmission = false
                  controller.refresh()
                  runCurrent()
                  assertEquals("parent-session", controller.sessionId.value)
                  assertFalse(controller.historyLoading.value)
                }
                block()
                true
              },
            ) { method, paramsJson, _, withEnqueue ->
              withEnqueue {}
              gateway.request(method, paramsJson)
            }
          },
          requestGateway = gateway::request,
        )
      controller.load("main")
      runCurrent()
      assertEquals("parent-session", controller.sessionId.value)
      refreshBeforeAdmission = true

      assertSame(cancellation, runCatching { controller.startNewChatAwait() }.exceptionOrNull())

      assertEquals("main", controller.sessionKey.value)
      assertEquals(2, gateway.callCount("chat.history"))
      assertEquals(1, gateway.callCount("sessions.create"))
      assertNull(controller.errorText.value)
      assertFalse(controller.historyLoading.value)
    }

  @Test
  fun startNewChatCancellationClearsOnlyItsOwnFreshHistoryLoad() =
    runTest {
      for (refreshBeforeCancellation in listOf(false, true)) {
        val firstHistoryEntered = CompletableDeferred<Unit>()
        val refreshedHistoryEntered = CompletableDeferred<Unit>()
        val releaseHistory = CompletableDeferred<Unit>()
        var historyRequests = 0
        val controller =
          createScriptedChatController {
            respond("sessions.create", """{"ok":true,"key":"agent:main:dashboard:fresh"}""")
            respond("chat.history") {
              historyRequests += 1
              if (historyRequests == 1) firstHistoryEntered.complete(Unit) else refreshedHistoryEntered.complete(Unit)
              releaseHistory.await()
              """{"sessionId":"fresh-session","messages":[]}"""
            }
          }
        val create = async { controller.startNewChatAwait() }
        try {
          firstHistoryEntered.await()
          assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
          assertTrue(controller.historyLoading.value)
          if (refreshBeforeCancellation) {
            controller.refresh()
            refreshedHistoryEntered.await()
          }

          create.cancelAndJoin()

          assertTrue(create.isCancelled)
          assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
          assertEquals("Only a newer history request may retain loading", refreshBeforeCancellation, controller.historyLoading.value)
          assertNull(controller.errorText.value)

          releaseHistory.complete(Unit)
          if (!refreshBeforeCancellation) controller.refresh()
          advanceUntilIdle()
          assertEquals("fresh-session", controller.sessionId.value)
          assertFalse(controller.historyLoading.value)
        } finally {
          releaseHistory.complete(Unit)
          create.cancelAndJoin()
        }
      }
    }

  private fun commandResponse(
    name: String,
    description: String? = null,
    acceptsArgs: Boolean = false,
  ): String {
    val descriptionJson = description?.let { ""","description":"$it"""" }.orEmpty()
    return """{"commands":[{"name":"$name"$descriptionJson,"textAliases":["/$name"],"acceptsArgs":$acceptsArgs}]}"""
  }
}
