package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerPermissionSelectionTest {
  private val json = chatControllerTestJson
  private val permissionCapabilities = setOf("session-settings-contract", "session-settings-cas-v1")

  @Test
  fun selectionUsesSessionPatchAndTracksExplicitDefaultEvents() =
    runTest {
      val patches = mutableListOf<String>()
      var sessionRow = """{"key":"main","sessionId":"permission-session","permissionMode":"guarded","permissionModePending":false}"""
      val controller =
        createScriptedChatController {
          gatewayAdvertisesMethod = { it == "sessions.patch" }
          gatewayAdvertisesCapability = permissionCapabilities::contains
          respond("sessions.list") { """{"sessions":[$sessionRow]}""" }
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            sessionRow = """{"key":"main","sessionId":"permission-session","permissionMode":"full","permissionModePending":false}"""
            "{}"
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals(
        ChatPermissionMode.Guarded,
        controller.sessions.value
          .single()
          .permissionMode,
      )

      assertTrue(controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Full))
      assertEquals(
        false,
        controller.sessions.value
          .single()
          .permissionModePending,
      )
      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertEquals("full", (params["permissionMode"] as JsonPrimitive).content)
      assertEquals(JsonPrimitive("permission-session"), params["expectedSessionId"])
      assertEquals(JsonPrimitive("guarded"), params["expectedPermissionMode"])
      assertEquals(
        ChatPermissionMode.Full,
        controller.sessions.value
          .single()
          .permissionMode,
      )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","permissionMode":null}}""",
      )
      advanceUntilIdle()
      assertNull(
        controller.sessions.value
          .single()
          .permissionMode,
      )
      assertTrue(
        controller.sessions.value
          .single()
          .hasPermissionModeMetadata,
      )
    }

  @Test
  fun permissionSelectionRequiresTheSettingsContractWithoutBlockingOlderSettings() =
    runTest {
      for (capabilities in listOf(emptySet(), setOf("session-settings-contract"), setOf("session-settings-cas-v1"))) {
        val (controller, requests) =
          chatControllerTestSetup {
            gatewayAdvertisesMethod = { it == "sessions.patch" }
            gatewayAdvertisesCapability = capabilities::contains
            respond("sessions.list", """{"sessions":[{"key":"main","sessionId":"permission-session","permissionMode":"guarded"}]}""")
          }
        controller.refreshSessions()
        advanceUntilIdle()

        assertFalse(controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace))
        assertFalse(controller.errorText.value.isNullOrBlank())
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
        assertFalse(requests.any { it.first == "sessions.patch" })

        assertTrue(controller.setSessionModelAwait("main", "synthetic/plain"))
        controller.setThinkingLevel("high")
        controller.setSessionFastMode("main", enabled = true)
        advanceUntilIdle()

        val patches =
          requests.filter { it.first == "sessions.patch" }.map {
            json.parseToJsonElement(it.second.orEmpty()) as JsonObject
          }
        assertEquals(listOf("model", "thinkingLevel", "fastMode"), patches.map { (it.keys - setOf("key", "agentId")).single() })
        assertEquals("synthetic/plain", controller.selectedModelRef.value)
        assertEquals("high", controller.thinkingLevel.value)
        assertEquals(
          ChatFastMode.On,
          controller.sessions.value
            .single()
            .fastMode,
        )
      }
    }

  @Test
  fun permissionSelectionRequiresAnAdvertisedPatchMethodAndDurableIdentity() =
    runTest {
      for ((patchAdvertised, sessionId) in listOf(false to "permission-session", null to "permission-session", true to "", true to " ")) {
        val (controller, requests) =
          chatControllerTestSetup {
            gatewayAdvertisesMethod = { if (it == "sessions.patch") patchAdvertised else null }
            gatewayAdvertisesCapability = permissionCapabilities::contains
            respond("sessions.list", """{"sessions":[{"key":"main","sessionId":"$sessionId","permissionMode":"guarded"}]}""")
          }
        controller.refreshSessions()
        advanceUntilIdle()

        assertFalse(controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace))
        assertFalse(controller.errorText.value.isNullOrBlank())
        assertFalse(requests.any { it.first == "sessions.patch" })
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
        assertEquals(
          ChatPermissionMode.Guarded,
          controller.sessions.value
            .single()
            .permissionMode,
        )
      }
    }

  @Test
  fun permissionSelectionSendsAnExplicitNullExpectationForInheritedPermissions() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesMethod = { it == "sessions.patch" }
          gatewayAdvertisesCapability = permissionCapabilities::contains
          respond("sessions.list", """{"sessions":[{"key":"main","sessionId":"permission-session","permissionMode":null}]}""")
        }
      controller.refreshSessions()
      advanceUntilIdle()

      assertTrue(controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace))

      val params = json.parseToJsonElement(requests.single { it.first == "sessions.patch" }.second.orEmpty()) as JsonObject
      assertEquals(JsonPrimitive("permission-session"), params["expectedSessionId"])
      assertEquals(JsonNull, params["expectedPermissionMode"])
      assertEquals(
        ChatPermissionMode.Workspace,
        controller.sessions.value
          .single()
          .permissionMode,
      )
    }

  @Test
  fun queuedPermissionSelectionDoesNotCrossASessionReset() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var sessionId = "permission-session"
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesMethod = { it == "sessions.patch" }
          gatewayAdvertisesCapability = permissionCapabilities::contains
          respond("sessions.list") {
            """{"sessions":[{"key":"main","sessionId":"$sessionId","permissionMode":"guarded"}]}"""
          }
          respond("chat.history") {
            """{"sessionId":"$sessionId","messages":[],"sessionInfo":{"key":"main","sessionId":"$sessionId","permissionMode":"guarded"}}"""
          }
          respond("sessions.patch") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            if ("model" in params) {
              patchStarted.complete(Unit)
              releasePatch.await()
            }
            "{}"
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      val predecessor = async { controller.setSessionModelAwait("main", "synthetic/plain") }
      patchStarted.await()
      val permission = async { controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace) }
      runCurrent()

      try {
        sessionId = "replacement-session"
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"main","agentId":"main","reason":"reset","session":{"key":"main","sessionId":"$sessionId","permissionMode":"guarded"}}""",
        )
        releasePatch.complete(Unit)
        assertTrue(predecessor.await())
        assertFalse(permission.await())
        advanceUntilIdle()

        assertEquals(1, requests.count { it.first == "sessions.patch" })
        assertEquals(
          ChatPermissionMode.Guarded,
          controller.sessions.value
            .single()
            .permissionMode,
        )
        assertEquals(
          sessionId,
          controller.sessions.value
            .single()
            .sessionId,
        )
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      } finally {
        releasePatch.complete(Unit)
        advanceUntilIdle()
      }
    }

  @Test
  fun successfulPermissionResponsePreservesNewerCanonicalModeAndPendingState() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var sessionRow = """{"key":"main","agentId":"main","sessionId":"permission-session","permissionMode":"guarded","permissionModePending":false}"""
      val controller =
        createScriptedChatController {
          gatewayAdvertisesMethod = { it == "sessions.patch" }
          gatewayAdvertisesCapability = permissionCapabilities::contains
          respond("sessions.list") { """{"sessions":[$sessionRow]}""" }
          respond("chat.history") { """{"sessionId":"permission-session","messages":[],"sessionInfo":$sessionRow}""" }
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main","permissionMode":"workspace"},"resolved":{}}"""
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()

      val patch = async { controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace) }
      patchStarted.await()
      for ((mode, pending) in listOf("workspace" to true, "workspace" to false, "read-only" to true)) {
        sessionRow = """{"key":"main","agentId":"main","sessionId":"permission-session","permissionMode":"$mode","permissionModePending":$pending}"""
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"main","agentId":"main","phase":"message","session":$sessionRow}""",
        )
      }
      val newerState =
        controller.sessions.value
          .single()
          .let { it.permissionMode to it.permissionModePending }
      assertEquals(ChatPermissionMode.ReadOnly to true, newerState)

      releasePatch.complete(Unit)
      assertTrue(patch.await())
      advanceUntilIdle()
      assertEquals(
        newerState,
        controller.sessions.value
          .single()
          .let { it.permissionMode to it.permissionModePending },
      )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","permissionMode":"read-only","permissionModePending":false}}""",
      )
      assertEquals(
        ChatPermissionMode.ReadOnly to false,
        controller.sessions.value
          .single()
          .let { it.permissionMode to it.permissionModePending },
      )
    }

  @Test
  fun sessionsRefreshPreservesNewerPermissionSnapshotsEvenWhenTheModeRepeats() =
    runTest {
      for (modeRepeats in listOf(false, true)) {
        val listStarted = CompletableDeferred<Unit>()
        val releaseList = CompletableDeferred<Unit>()
        val olderRow = """{"key":"main","agentId":"main","permissionMode":"workspace","permissionModePending":false}"""
        val newerRow = """{"key":"main","agentId":"main","permissionMode":"read-only","permissionModePending":true}"""
        var sessionRow = if (modeRepeats) newerRow else olderRow
        var listRequests = 0
        val controller =
          createScriptedChatController {
            respond("sessions.list") {
              val response = """{"sessions":[$sessionRow]}"""
              if (++listRequests == 2) {
                listStarted.complete(Unit)
                releaseList.await()
              }
              response
            }
          }
        controller.refreshSessions()
        advanceUntilIdle()
        sessionRow = olderRow
        controller.refreshSessions()
        listStarted.await()

        sessionRow = newerRow
        val event =
          if (modeRepeats) {
            """{"sessionKey":"main","agentId":"main","reason":"patch","permissionMode":"read-only","permissionModePending":true}"""
          } else {
            """{"sessionKey":"main","phase":"message","session":$sessionRow}"""
          }
        controller.handleGatewayEvent("sessions.changed", event)
        releaseList.complete(Unit)
        advanceUntilIdle()

        val session = controller.sessions.value.single()
        assertEquals(ChatPermissionMode.ReadOnly, session.permissionMode)
        assertEquals(true, session.permissionModePending)
        assertEquals(3, listRequests)
      }
    }

  @Test
  fun unchangedMessageSnapshotsDoNotRestartSessionsRefresh() =
    runTest {
      val listStarted = CompletableDeferred<Unit>()
      val releaseList = CompletableDeferred<Unit>()
      var listRequests = 0
      val controller =
        createScriptedChatController {
          respond("sessions.list") {
            if (++listRequests == 2) {
              listStarted.complete(Unit)
              releaseList.await()
            }
            """{"sessions":[{"key":"main","permissionModePending":false,"effectiveFastMode":false,"thinkingLevel":"off","thinkingLevels":[{"id":"off","label":"Off"}],"thinkingDefault":"off"}]}"""
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.refreshSessions()
      listStarted.await()
      controller.handleGatewayEvent(
        "session.message",
        """{"session":{"key":"main","agentId":"main","displayName":"Current conversation"}}""",
      )
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","permissionMode":null,"permissionModePending":false,"effectiveFastMode":false,"thinkingLevel":"off"}}""",
      )
      releaseList.complete(Unit)
      advanceUntilIdle()

      assertNull(
        controller.sessions.value
          .single()
          .permissionMode,
      )
      assertEquals(2, listRequests)
    }

  @Test
  fun exactSettingsReadPreservesNewerSnapshotsWithoutRestartingUnchangedMessages() =
    runTest {
      for (staleRead in listOf(false, true)) {
        val readStarted = CompletableDeferred<Unit>()
        val releaseRead = CompletableDeferred<Unit>()
        val sessionKey = "agent:main:conversation"
        val currentSettings = """"permissionMode":"read-only","permissionModePending":false,"effectiveFastMode":true"""
        var sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id",$currentSettings,"fastMode":true}"""
        var settingsReads = 0
        val controller =
          createScriptedChatController {
            respond("sessions.list") { """{"sessions":[$sessionRow]}""" }
            respond("sessions.patch") {
              val sampledSettings =
                if (staleRead) {
                  """"permissionMode":"workspace","permissionModePending":true,"effectiveFastMode":true"""
                } else {
                  currentSettings
                }
              sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id",$sampledSettings,"status":"completed","outputTokens":5}"""
              """{"entry":{"key":"$sessionKey","sessionId":"conversation-id"},"resolved":{}}"""
            }
            respond("chat.history") {
              val response = """{"sessionKey":"$sessionKey","sessionId":"conversation-id","messages":[],"sessionInfo":$sessionRow}"""
              if (++settingsReads == 1) {
                readStarted.complete(Unit)
                releaseRead.await()
              }
              response
            }
          }
        controller.refreshSessions()
        advanceUntilIdle()
        controller.setSessionFastMode(sessionKey, enabled = false, clearOverride = true)
        readStarted.await()

        sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id",$currentSettings,"status":"running","outputTokens":99}"""
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":$sessionRow}""",
        )
        releaseRead.complete(Unit)
        advanceUntilIdle()

        val session = controller.sessions.value.single()
        assertEquals(ChatPermissionMode.ReadOnly to false, session.permissionMode to session.permissionModePending)
        assertNull(session.fastMode)
        assertEquals(ChatFastMode.On, session.effectiveFastMode)
        assertEquals("running" to 99L, session.status to session.outputTokens)
        assertEquals(if (staleRead) 2 else 1, settingsReads)
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      }
    }

  @Test
  fun sameValueMessageSnapshotKeepsNewerPermissionStateOverAnOlderList() =
    runTest {
      val sessionKey = "agent:main:conversation"
      val listStarted = CompletableDeferred<Unit>()
      val releaseList = CompletableDeferred<Unit>()
      var permissionPending = false
      var listRequests = 0
      val controller =
        createScriptedChatController {
          respond("sessions.list") {
            val response = """{"sessions":[{"key":"$sessionKey","permissionMode":"read-only","permissionModePending":$permissionPending,"effectiveFastMode":false}]}"""
            if (++listRequests == 2) {
              listStarted.complete(Unit)
              releaseList.await()
            }
            response
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      permissionPending = true
      controller.refreshSessions()
      listStarted.await()

      permissionPending = false
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","permissionMode":"read-only","permissionModePending":false,"effectiveFastMode":false}}""",
      )
      releaseList.complete(Unit)
      advanceUntilIdle()

      assertEquals(
        false,
        controller.sessions.value
          .single()
          .permissionModePending,
      )
    }

  @Test
  fun acceptedPermissionResponseDoesNotRefreshAReplacedGatewayOrAgent() =
    runTest {
      for (replaceGateway in listOf(true, false)) {
        val patchStarted = CompletableDeferred<Unit>()
        val releasePatch = CompletableDeferred<Unit>()
        var gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
        var agentId = "main"
        var listRequests = 0
        val controller =
          createChatController(
            cacheScope = { gatewayScope },
            currentDefaultAgentId = { agentId },
            gatewayAdvertisesMethod = { it == "sessions.patch" },
            gatewayAdvertisesCapability = permissionCapabilities::contains,
          ) { method, _ ->
            when (method) {
              "sessions.patch" -> {
                patchStarted.complete(Unit)
                releasePatch.await()
              }

              "sessions.list" -> {
                listRequests += 1
              }
            }
            "{}"
          }
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"main","agentId":"main","session":{"key":"main","sessionId":"permission-session","permissionMode":"guarded"}}""",
        )
        val originalSessions = controller.sessions.value
        val patch = async { controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace) }
        patchStarted.await()
        if (replaceGateway) {
          gatewayScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
          controller.onGatewayScopeChanging()
        } else {
          agentId = "ops"
        }
        releasePatch.complete(Unit)

        assertTrue(patch.await())
        advanceUntilIdle()
        assertEquals(0, listRequests)
        assertEquals(if (replaceGateway) emptyList() else originalSessions, controller.sessions.value)
      }
    }

  @Test
  fun lostPermissionResponseReconcilesWithoutAnEventBeforeSending() =
    runTest {
      verifyUnacknowledgedPermissionWrite(cancelWrite = false)
    }

  @Test
  fun cancelledDispatchedPermissionWriteReconcilesWithoutAnEventBeforeSending() =
    runTest {
      verifyUnacknowledgedPermissionWrite(cancelWrite = true)
    }

  @Test
  fun acceptedPermissionOnRetiredLeaseWaitsForExactSettingsRead() =
    runTest {
      verifyUnacknowledgedPermissionWrite(acceptResponseOnRetiredLease = true)
    }

  @Test
  fun acceptedFastModeDoesNotClearAnEarlierUnknownPermissionWrite() =
    runTest {
      verifyUnacknowledgedPermissionWrite(queueFastMode = true)
    }

  private suspend fun TestScope.verifyUnacknowledgedPermissionWrite(
    cancelWrite: Boolean = false,
    acceptResponseOnRetiredLease: Boolean = false,
    queueFastMode: Boolean = false,
  ) {
    val patchStarted = CompletableDeferred<Unit>()
    val releasePatch = CompletableDeferred<Unit>()
    val releaseHistory = CompletableDeferred<Unit>()
    val gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
    var physicalConnection = 0
    var settingsReadConnection: Int? = null
    var mode = "guarded"
    var fastMode = false

    fun sessionRow() = """{"key":"main","agentId":"main","sessionId":"permission-session","permissionMode":"$mode","fastMode":$fastMode,"effectiveFastMode":$fastMode}"""
    val gateway =
      ScriptedGateway(json).apply {
        respond("sessions.list") { """{"sessions":[${sessionRow()}]}""" }
        respond("sessions.patch") { paramsJson ->
          val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
          if ("fastMode" in params) {
            fastMode = true
            """{"entry":{"key":"main","fastMode":true},"resolved":{}}"""
          } else {
            assertEquals(JsonPrimitive("permission-session"), params["expectedSessionId"])
            assertEquals(JsonPrimitive("guarded"), params["expectedPermissionMode"])
            mode = "workspace"
            patchStarted.complete(Unit)
            releasePatch.await()
            if (!acceptResponseOnRetiredLease) throw GatewayRequestOutcomeUnknown("Patch response lost")
            """{"entry":${sessionRow()},"resolved":{}}"""
          }
        }
        respond("chat.history") {
          releaseHistory.await()
          """{"sessionId":"permission-session","messages":[],"sessionInfo":${sessionRow()}}"""
        }
        respondWith("chat.send", """{"runId":"run-ok","status":"ok"}""")
      }

    fun requestLease(connection: Int) =
      GatewaySession.RequestLease(
        endpointStableId = gatewayScope.gatewayId,
        isCurrentImpl = { physicalConnection == connection },
      ) { method, paramsJson, _, withEnqueue ->
        if (physicalConnection != connection) throw GatewayRequestNotEnqueued("gateway request lease changed")
        withEnqueue {
          if (method == "chat.history") settingsReadConnection = connection
        }
        gateway.request(method, paramsJson)
      }
    val originalLease = requestLease(physicalConnection)
    val controller =
      createChatController(
        cacheScope = { gatewayScope },
        gatewayAdvertisesMethod = { it == "sessions.patch" },
        gatewayAdvertisesCapability = permissionCapabilities::contains,
        captureRequestLease = { capturedScope ->
          assertEquals(gatewayScope, capturedScope)
          if (physicalConnection == 0) originalLease else requestLease(physicalConnection)
        },
        requestGateway = gateway::request,
      )
    controller.handleGatewayEvent("health", null)
    controller.refreshSessions()
    advanceUntilIdle()
    val patch = async { controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Workspace) }
    var send: Deferred<Boolean>? = null

    try {
      runCurrent()
      assertTrue(patchStarted.isCompleted)
      if (queueFastMode) controller.setSessionFastMode("main", enabled = true)
      if (acceptResponseOnRetiredLease) physicalConnection = 1
      if (cancelWrite) {
        patch.cancelAndJoin()
      } else {
        releasePatch.complete(Unit)
        assertEquals(acceptResponseOnRetiredLease, patch.await())
      }
      val pendingSend = async { controller.sendMessageAwaitAcceptance("keep this draft", "off", emptyList()) }
      send = pendingSend
      runCurrent()

      assertFalse("An unconfirmed permission write must not release Send", gateway.calls.any { it.method == "chat.send" })
      assertFalse(pendingSend.isCompleted)
      assertEquals(setOf("main"), controller.pendingSessionSettingsKeys.value)
      assertEquals(
        ChatPermissionMode.Guarded,
        controller.sessions.value
          .single()
          .permissionMode,
      )
      if (acceptResponseOnRetiredLease) assertFalse(originalLease.isCurrent())
      assertEquals(if (acceptResponseOnRetiredLease) 1 else 0, settingsReadConnection)
      val refresh =
        json.parseToJsonElement(
          gateway.calls
            .single { it.method == "chat.history" }
            .paramsJson
            .orEmpty(),
        ) as JsonObject
      assertEquals(JsonPrimitive("main"), refresh["sessionKey"])
      assertEquals(JsonPrimitive("main"), refresh["agentId"])
      assertEquals(JsonPrimitive(1), refresh["limit"])

      releaseHistory.complete(Unit)
      advanceUntilIdle()
      val sendAccepted = acceptResponseOnRetiredLease || queueFastMode
      assertEquals(sendAccepted, pendingSend.await())
      assertEquals(
        ChatPermissionMode.Workspace,
        controller.sessions.value
          .single()
          .permissionMode,
      )
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      if (!sendAccepted) assertTrue(controller.sendMessageAwaitAcceptance("keep this draft", "off", emptyList()))
      assertEquals(1, gateway.callCount("chat.send"))
      assertEquals(
        if (queueFastMode) ChatFastMode.On else ChatFastMode.Off,
        controller.sessions.value
          .single()
          .fastMode,
      )
    } finally {
      releasePatch.complete(Unit)
      releaseHistory.complete(Unit)
      patch.cancelAndJoin()
      send?.cancelAndJoin()
      advanceUntilIdle()
    }
  }

  @Test
  fun fastModeSelectionParsesBooleanSessionAndResolvedState() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","fastMode":false,"effectiveFastMode":false}]}""",
          )
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            """{"entry":{"key":"main","fastMode":true},"resolved":{}}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals(
        ChatFastMode.Off,
        controller.sessions.value
          .single()
          .fastMode,
      )
      assertEquals(
        ChatFastMode.Off,
        controller.sessions.value
          .single()
          .effectiveFastMode,
      )

      controller.setSessionFastMode("main", enabled = true)
      advanceUntilIdle()

      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertEquals("true", (params["fastMode"] as JsonPrimitive).content)
      val session = controller.sessions.value.single()
      assertEquals(ChatFastMode.On, session.fastMode)
      assertEquals(ChatFastMode.On, session.effectiveFastMode)
      assertTrue(session.hasFastModeMetadata)
      assertTrue(session.hasEffectiveFastModeMetadata)
    }

  @Test
  fun fastModeSelectionWaitsForAcceptanceAndPreservesStateAfterRejection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val sessionRow = """{"key":"main","sessionId":"fast-session","fastMode":false,"effectiveFastMode":false}"""
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[$sessionRow]}""")
          respond("chat.history", """{"sessionId":"fast-session","messages":[],"sessionInfo":$sessionRow}""")
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            throw IllegalStateException("rejected")
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()

      controller.setSessionFastMode("main", enabled = true)

      val pending = controller.sessions.value.single()
      assertEquals(ChatFastMode.Off, pending.fastMode)
      assertEquals(ChatFastMode.Off, pending.effectiveFastMode)
      assertEquals(setOf("main"), controller.pendingSessionSettingsKeys.value)

      patchStarted.await()
      releasePatch.complete(Unit)
      advanceUntilIdle()

      val unchanged = controller.sessions.value.single()
      assertEquals(ChatFastMode.Off, unchanged.fastMode)
      assertEquals(ChatFastMode.Off, unchanged.effectiveFastMode)
      assertFalse(controller.pendingSessionSettingsKeys.value.contains("main"))
    }

  @Test
  fun failedFastModeResponseDoesNotOverwriteAnAuthoritativeSessionEvent() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var storedFastMode = false
      val controller =
        createScriptedChatController {
          respond("sessions.list") {
            """{"sessions":[{"key":"main","fastMode":$storedFastMode,"effectiveFastMode":$storedFastMode}]}"""
          }
          respond("chat.history") {
            """{"sessionId":"fast-session","messages":[],"sessionInfo":{"key":"main","sessionId":"fast-session","fastMode":$storedFastMode,"effectiveFastMode":$storedFastMode}}"""
          }
          respond("sessions.patch") {
            storedFastMode = true
            patchStarted.complete(Unit)
            releasePatch.await()
            throw GatewayRequestOutcomeUnknown("Patch response lost")
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.setSessionFastMode("main", enabled = true)
      patchStarted.await()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","permissionMode":null,"permissionModePending":false,"fastMode":$storedFastMode,"effectiveFastMode":$storedFastMode}}""",
      )
      assertEquals(
        ChatFastMode.On,
        controller.sessions.value
          .single()
          .effectiveFastMode,
      )
      releasePatch.complete(Unit)
      advanceUntilIdle()

      val accepted = controller.sessions.value.single()
      assertEquals(ChatFastMode.On, accepted.fastMode)
      assertEquals(ChatFastMode.On, accepted.effectiveFastMode)
      assertFalse(controller.pendingSessionSettingsKeys.value.contains("main"))
    }

  @Test
  fun identityOnlyPatchInvalidationSuppressesAnOlderSettingsResponseUntilRefresh() =
    runTest {
      val sessionKey = "agent:main:conversation"
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val refreshStarted = CompletableDeferred<Unit>()
      val releaseRefresh = CompletableDeferred<Unit>()
      var sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id","permissionMode":"guarded","permissionModePending":false}"""
      var lookupUnavailable = false
      var omitSessionFromList = false
      var settingsReads = 0
      val deletions = mutableListOf<ChatSessionDeletion>()
      val connectionScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val gateway =
        ScriptedGateway(json).apply {
          respond("sessions.list") {
            if (lookupUnavailable || omitSessionFromList) """{"sessions":[]}""" else """{"sessions":[$sessionRow]}"""
          }
          respond("chat.history") { paramsJson ->
            val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
            assertEquals(JsonPrimitive(sessionKey), params["sessionKey"])
            assertEquals(JsonPrimitive("main"), params["agentId"])
            settingsReads += 1
            refreshStarted.complete(Unit)
            releaseRefresh.await()
            if (lookupUnavailable) {
              // The lookup owner also returns this shape when store reads fail.
              """{"sessionKey":"$sessionKey","messages":[],"sessionInfo":{"key":"$sessionKey","agentId":"main","modelProvider":"synthetic","model":"default"}}"""
            } else {
              """{"sessionKey":"$sessionKey","sessionId":"conversation-id","messages":[],"sessionInfo":$sessionRow}"""
            }
          }
          respond("sessions.patch") {
            sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id","permissionMode":"workspace","permissionModePending":false}"""
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"$sessionKey","permissionMode":"workspace"},"resolved":{}}"""
          }
        }
      val controller =
        createChatController(
          cacheScope = { connectionScope },
          gatewayAdvertisesMethod = { it == "sessions.patch" },
          gatewayAdvertisesCapability = permissionCapabilities::contains,
          onSessionDeleted = deletions::add,
          requestGateway = gateway::request,
        )
      controller.refreshSessions()
      advanceUntilIdle()
      val patch = async { controller.setSessionPermissionModeAwait(sessionKey, ChatPermissionMode.Workspace) }
      patchStarted.await()

      // Patch effects and history can lose their row to the lookup owner's empty-on-error
      // projection. Neither missing identity authorizes deleting local state.
      lookupUnavailable = true
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","reason":"patch","ts":1}""",
      )
      releasePatch.complete(Unit)
      assertTrue(patch.await())
      refreshStarted.await()
      try {
        assertEquals(
          ChatPermissionMode.Guarded,
          controller.sessions.value
            .single()
            .permissionMode,
        )
      } finally {
        releaseRefresh.complete(Unit)
        advanceUntilIdle()
      }
      assertEquals(
        ChatPermissionMode.Guarded,
        controller.sessions.value
          .single()
          .permissionMode,
      )
      assertEquals(setOf(sessionKey), controller.pendingSessionSettingsKeys.value)
      assertEquals("Could not refresh session settings. Refresh before sending.", controller.errorText.value)
      assertTrue(deletions.isEmpty())
      assertEquals(1, settingsReads)

      lookupUnavailable = false
      controller.refreshSessions()
      advanceUntilIdle()

      assertEquals(
        ChatPermissionMode.Workspace,
        controller.sessions.value
          .single()
          .permissionMode,
      )
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
      assertNull(controller.errorText.value)
      assertTrue(deletions.isEmpty())
      assertEquals(2, settingsReads)

      sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id","permissionMode":"workspace","permissionModePending":false,"fastMode":true,"effectiveFastMode":true}"""
      controller.load(sessionKey)
      advanceUntilIdle()
      assertEquals(
        ChatFastMode.On,
        controller.sessions.value
          .single()
          .fastMode,
      )
      val previousSettingsReads = settingsReads

      omitSessionFromList = true
      sessionRow = """{"key":"$sessionKey","sessionId":"conversation-id","permissionMode":"workspace","permissionModePending":false,"effectiveFastMode":false}"""
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$sessionKey","agentId":"main","reason":"patch","ts":2}""",
      )
      advanceUntilIdle()

      val inherited = controller.sessions.value.single()
      assertNull(inherited.fastMode)
      assertEquals(ChatFastMode.Off, inherited.effectiveFastMode)
      assertEquals(previousSettingsReads + 1, settingsReads)
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
    }

  @Test
  fun successfulFastModeResponseDoesNotOverwriteANewerSessionSnapshot() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      var sessionRow = """{"key":"main","sessionId":"fast-session","permissionMode":null,"permissionModePending":false,"fastMode":false,"effectiveFastMode":false}"""
      val controller =
        createScriptedChatController {
          respond("sessions.list") { """{"sessions":[$sessionRow]}""" }
          respond("chat.history") { """{"sessionId":"fast-session","messages":[],"sessionInfo":$sessionRow}""" }
          respond("sessions.patch") {
            sessionRow = """{"key":"main","sessionId":"fast-session","permissionMode":null,"permissionModePending":false,"fastMode":true,"effectiveFastMode":true}"""
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main","fastMode":true,"effectiveFastMode":true},"resolved":{}}"""
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.setSessionFastMode("main", enabled = true)
      patchStarted.await()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":$sessionRow}""",
      )

      sessionRow = """{"key":"main","sessionId":"fast-session","permissionMode":null,"permissionModePending":false,"fastMode":false,"effectiveFastMode":false}"""
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":$sessionRow}""",
      )
      assertEquals(
        ChatFastMode.Off,
        controller.sessions.value
          .single()
          .fastMode,
      )

      releasePatch.complete(Unit)
      advanceUntilIdle()

      val session = controller.sessions.value.single()
      assertEquals(ChatFastMode.Off, session.fastMode)
      assertFalse(requireNotNull(session.effectiveFastMode).isEnabled)
      assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())
    }

  @Test
  fun unrelatedSessionSnapshotDoesNotSupersedeAcceptedFastMode() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main","fastMode":false,"effectiveFastMode":false}]}""")
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main","fastMode":true,"effectiveFastMode":true},"resolved":{}}"""
          }
        }
      controller.refreshSessions()
      advanceUntilIdle()
      controller.setSessionFastMode("main", enabled = true)
      patchStarted.await()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"other","agentId":"main","phase":"message","session":{"key":"other","fastMode":false,"effectiveFastMode":false,"permissionMode":null,"permissionModePending":false}}""",
      )
      releasePatch.complete(Unit)
      advanceUntilIdle()

      val session = controller.sessions.value.first { it.key == "main" }
      assertEquals(ChatFastMode.On, session.fastMode)
      assertTrue(requireNotNull(session.effectiveFastMode).isEnabled)
    }

  @Test
  fun clearingFastModeRefreshesInheritedEffectiveStateFromExactSession() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main","fastMode":"on","effectiveFastMode":"on"}]}""")
          respond("chat.history") {
            """{"sessionId":"fast-session","messages":[],"sessionInfo":{"key":"main","sessionId":"fast-session","effectiveFastMode":"on"}}"""
          }
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            """{"entry":{"key":"main"},"resolved":{}}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()

      controller.setSessionFastMode(
        sessionKey = "main",
        enabled = false,
        clearOverride = true,
      )
      advanceUntilIdle()

      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertTrue(params["fastMode"] is JsonNull)
      val session = controller.sessions.value.single()
      assertEquals(null, session.fastMode)
      assertEquals(ChatFastMode.On, session.effectiveFastMode)
      assertFalse(controller.pendingSessionSettingsKeys.value.contains("main"))
    }

  @Test
  fun clearingFastModeDoesNotOverwriteAnInheritedEffectiveEvent() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond("sessions.list", """{"sessions":[{"key":"main","fastMode":"on","effectiveFastMode":"on"}]}""")
          respond("chat.history") {
            """{"sessionId":"fast-session","messages":[],"sessionInfo":{"key":"main","sessionId":"fast-session","effectiveFastMode":"on"}}"""
          }
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            """{"entry":{"key":"main"},"resolved":{}}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      controller.setSessionFastMode(
        sessionKey = "main",
        enabled = false,
        clearOverride = true,
      )
      patchStarted.await()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","session":{"key":"main","fastMode":null,"effectiveFastMode":"on"}}""",
      )
      assertNull(
        controller.sessions.value
          .single()
          .fastMode,
      )
      assertEquals(
        ChatFastMode.On,
        controller.sessions.value
          .single()
          .effectiveFastMode,
      )

      releasePatch.complete(Unit)
      advanceUntilIdle()

      val accepted = controller.sessions.value.single()
      assertNull(accepted.fastMode)
      assertEquals(ChatFastMode.On, accepted.effectiveFastMode)
      assertTrue(accepted.hasEffectiveFastModeMetadata)
      assertFalse(controller.pendingSessionSettingsKeys.value.contains("main"))
    }

  @Test
  fun authoritativeSessionChangeClearsRemovedOverridesButPartialMessagePreservesThem() =
    runTest {
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","agentId":"main","permissionMode":"guarded","permissionModePending":true,"fastMode":"on","effectiveFastMode":"on"}]}""",
          )
        }

      controller.refreshSessions()
      advanceUntilIdle()

      controller.handleGatewayEvent(
        "session.message",
        """{"session":{"key":"main","agentId":"main","displayName":"Renamed"}}""",
      )
      val afterPartial = controller.sessions.value.single()
      assertEquals(ChatPermissionMode.Guarded, afterPartial.permissionMode)
      assertEquals(true, afterPartial.permissionModePending)
      assertEquals(ChatFastMode.On, afterPartial.fastMode)
      assertEquals(ChatFastMode.On, afterPartial.effectiveFastMode)

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","session":{"key":"main","agentId":"main","effectiveFastMode":"on"}}""",
      )
      val afterAuthoritative = controller.sessions.value.single()
      assertNull(afterAuthoritative.permissionMode)
      assertNull(afterAuthoritative.permissionModePending)
      assertNull(afterAuthoritative.fastMode)
      assertEquals(ChatFastMode.On, afterAuthoritative.effectiveFastMode)
      assertFalse(afterAuthoritative.hasPermissionModeMetadata)
      assertFalse(afterAuthoritative.hasFastModeMetadata)
      assertTrue(afterAuthoritative.hasEffectiveFastModeMetadata)
    }

  @Test
  fun defaultSelectionSendsJsonNull() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          gatewayAdvertisesMethod = { it == "sessions.patch" }
          gatewayAdvertisesCapability = permissionCapabilities::contains
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            "{}"
          }
          respond("sessions.list", """{"sessions":[{"key":"main","sessionId":"permission-session","permissionMode":"guarded","permissionModePending":false}]}""")
        }
      controller.refreshSessions()
      advanceUntilIdle()

      assertTrue(controller.setSessionPermissionModeAwait("main", null))

      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertTrue(params["permissionMode"] is JsonNull)
      assertEquals(JsonPrimitive("permission-session"), params["expectedSessionId"])
      assertEquals(JsonPrimitive("guarded"), params["expectedPermissionMode"])
      assertNull(
        controller.sessions.value
          .single()
          .permissionMode,
      )
    }

  @Test
  fun immediateSendWaitsForPendingPermissionSelection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        createChatController(
          gatewayAdvertisesMethod = { it == "sessions.patch" },
          gatewayAdvertisesCapability = permissionCapabilities::contains,
        ) { method, _ ->
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
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","session":{"key":"main","sessionId":"permission-session","permissionMode":"guarded"}}""",
      )

      controller.setSessionPermissionMode("main", ChatPermissionMode.Workspace)
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
}
