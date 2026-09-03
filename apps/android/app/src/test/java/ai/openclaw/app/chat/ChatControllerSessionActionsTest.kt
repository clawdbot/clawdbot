package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerSessionActionsTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun controller(
    scope: kotlinx.coroutines.CoroutineScope,
    gateway: ScriptedGateway,
  ): ChatController =
    ChatController(
      scope = scope,
      json = json,
      requestGateway = gateway::request,
    )

  private fun ScriptedGateway.respondWithBranchHistory() {
    respondWith(
      "chat.history",
      historyResponse(
        sessionId = "session-main",
        messages = listOf(ReplayHistoryMessage("user", "hello", 1, entryId = "entry-user")),
      ),
    )
    respondWith(
      "sessions.branches.list",
      """{"branches":[{"leafEntryId":"entry-user","headline":"Current work","messageCount":1,"updatedAt":"2026-07-20T12:00:00Z","active":true}]}""",
    )
  }

  private inner class ArchiveFixture(
    private val scope: TestScope,
  ) {
    val gateway = ScriptedGateway(json)
    var gatewayScope = ChatCacheScope("gateway-a", 1)
    var defaultAgentId = "owner-a"
    var defaultAgentRevision = 0L
    var canonicalSessionId = "session-a"
    val routedRequests = mutableListOf<Pair<String, ScriptedGateway.Call>>()
    val controller =
      ChatController(
        scope = scope,
        json = json,
        requestGateway = gateway::request,
        requestGatewayForGateway = { gatewayId, method, params ->
          routedRequests += gatewayId to ScriptedGateway.Call(method, params)
          gateway.request(method, params)
        },
        cacheScope = { gatewayScope },
        currentDefaultAgentId = { defaultAgentId },
        currentDefaultAgentRevision = { defaultAgentRevision },
      )
    private val archiveResponse = CompletableDeferred<String>()

    init {
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      gateway.respond("chat.history") { params ->
        val request = json.parseToJsonElement(params!!).jsonObject
        val key = request.getValue("sessionKey").jsonPrimitive.content
        val owner = request.getValue("agentId").jsonPrimitive.content
        historyResponse(
          sessionId = if (key == "custom") canonicalSessionId else "session-$key",
          messages = listOf(ReplayHistoryMessage("user", "${gatewayScope.gatewayId}/$owner/$key/$canonicalSessionId", 1)),
        )
      }
      gateway.respond("sessions.patch") { archiveResponse.await() }
    }

    suspend fun completeArchive(
      expectedSessionId: String = "session-a",
      ownerAgentId: String = "owner-a",
      fallsBack: Boolean = false,
      whilePending: suspend () -> Unit = {},
    ) {
      val archive =
        scope.async {
          controller.patchSession(
            key = "custom",
            ownerAgentId = ownerAgentId,
            expectedSessionId = expectedSessionId,
            archived = true,
          )
        }
      try {
        scope.runCurrent()
        assertFalse(archive.isCompleted)
        val request = json.parseToJsonElement(gateway.calls.single { it.method == "sessions.patch" }.paramsJson!!).jsonObject
        assertEquals("custom", request.getValue("key").jsonPrimitive.content)
        assertEquals(ownerAgentId, request.getValue("agentId").jsonPrimitive.content)
        assertEquals(expectedSessionId, request.getValue("expectedSessionId").jsonPrimitive.content)
        assertEquals("true", request.getValue("archived").jsonPrimitive.content)
        whilePending()
        scope.runCurrent()
        val selectedKey = controller.sessionKey.value
        val selectedOwner = controller.sessionOwnerAgentId.value
        val selectedId = controller.sessionId.value
        val selectedMessages = controller.messages.value
        assertTrue(selectedMessages.isNotEmpty())
        archiveResponse.complete("{}")
        assertTrue(archive.await())
        scope.runCurrent()
        assertNull(controller.errorText.value)
        if (fallsBack) {
          assertEquals("main", controller.sessionKey.value)
          assertEquals("session-main", controller.sessionId.value)
        } else {
          assertEquals(selectedKey, controller.sessionKey.value)
          assertEquals(selectedOwner, controller.sessionOwnerAgentId.value)
          assertEquals(selectedId, controller.sessionId.value)
          assertEquals(selectedMessages, controller.messages.value)
        }
        assertEquals("gateway-a", routedRequests.single { it.second.method == "sessions.patch" }.first)
      } finally {
        archiveResponse.complete("{}")
      }
    }
  }

  private fun TestScope.loadedArchiveFixture(ownerAgentId: String? = "owner-a"): ArchiveFixture =
    ArchiveFixture(this).also {
      it.controller.load("custom", ownerAgentId)
      runCurrent()
      assertEquals("session-a", it.controller.sessionId.value)
    }

  @Test
  fun archiveCompletionFallsBackForTheMatchingActiveOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(fallsBack = true) { fixture.controller.refresh() }
    }

  @Test
  fun archiveCompletionPreservesSameKeyCanonicalSuccessorWithoutNewSelection() =
    runTest {
      val fixture = loadedArchiveFixture()
      val selection = fixture.controller.selectionGeneration.value
      fixture.completeArchive {
        fixture.canonicalSessionId = "session-b"
        fixture.controller.refresh()
        runCurrent()
        assertEquals("session-b", fixture.controller.sessionId.value)
        assertEquals(selection, fixture.controller.selectionGeneration.value)
      }
    }

  @Test
  fun archiveCompletionPreservesSameKeyAndIdOnAnotherGateway() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive {
        fixture.gatewayScope = ChatCacheScope("gateway-b", 2)
        fixture.controller.onGatewayScopeChanging()
        fixture.controller.load("custom", "owner-a")
      }
    }

  @Test
  fun archiveCompletionPreservesSameKeyAndIdAfterReconnect() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive {
        fixture.controller.onDisconnected("reconnecting")
        fixture.gatewayScope = ChatCacheScope("gateway-a", 2)
        fixture.controller.onGatewayConnected()
      }
    }

  @Test
  fun archiveCompletionPreservesSameKeyAndIdForAnotherOwner() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive { fixture.controller.switchSession("custom", "owner-b") }
    }

  @Test
  fun archiveCompletionPreservesChangedDefaultOwnerWithoutNewSelection() =
    runTest {
      val fixture = loadedArchiveFixture(ownerAgentId = null)
      val selection = fixture.controller.selectionGeneration.value
      fixture.completeArchive {
        fixture.defaultAgentRevision += 1
        fixture.defaultAgentId = "owner-b"
        fixture.controller.onDefaultAgentChanged("owner-b")
        runCurrent()
        assertEquals(selection, fixture.controller.selectionGeneration.value)
      }
    }

  @Test
  fun archiveCompletionPreservesDefaultOwnerAwayAndBackToTheSameOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture(ownerAgentId = null)
      val selection = fixture.controller.selectionGeneration.value
      fixture.completeArchive {
        for (owner in listOf("owner-b", "owner-a")) {
          fixture.defaultAgentRevision += 1
          fixture.defaultAgentId = owner
          fixture.controller.onDefaultAgentChanged(owner)
          runCurrent()
        }
        assertEquals(selection, fixture.controller.selectionGeneration.value)
      }
    }

  @Test
  fun archiveCompletionStillFallsBackAfterUnrelatedDefaultOwnerChange() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(fallsBack = true) {
        fixture.defaultAgentRevision += 1
        fixture.defaultAgentId = "owner-b"
        fixture.controller.onDefaultAgentChanged("owner-b")
      }
    }

  @Test
  fun archiveCompletionPreservesDifferentNewerNavigation() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive { fixture.controller.switchSession("other", "owner-a") }
    }

  @Test
  fun archiveCompletionPreservesNavigationAwayAndBackToTheSameOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive {
        fixture.controller.switchSession("other", "owner-a")
        runCurrent()
        fixture.controller.switchSession("custom", "owner-a")
      }
    }

  @Test
  fun archiveOfInactiveRowStillSucceedsWhenTheRowIsSelectedWhilePending() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.controller.switchSession("other", "owner-a")
      runCurrent()
      fixture.completeArchive { fixture.controller.switchSession("custom", "owner-a") }
    }

  @Test
  fun archiveOfAnotherOccurrenceCannotAcquireNavigationOwnershipOnCompletion() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(expectedSessionId = "session-b") {
        fixture.canonicalSessionId = "session-b"
        fixture.controller.refresh()
      }
    }

  @Test
  fun archiveOfAnotherOwnerPreservesTheActiveSameKeyOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(ownerAgentId = "owner-b")
    }

  @Test
  fun rewindReturnsEditorTextAndValidAttachmentsAndIssuesAgentScopedParams() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.rewind",
        """{"editorText":"restore me","editorAttachments":[{"mimeType":"image/png","data":"aW1hZ2U="},{"mimeType":"image/jpeg","data":"%%%"}]}""",
      )
      gateway.respondWithBranchHistory()
      val controller = controller(this, gateway)

      assertEquals(
        SessionRewindResult(
          editorText = "restore me",
          editorAttachments = listOf(SessionEditorAttachment(mimeType = "image/png", data = "aW1hZ2U=")),
        ),
        controller.rewindSessionAtEntryResult("main", "entry-user"),
      )

      val params = json.parseToJsonElement(gateway.calls.first { it.method == "sessions.rewind" }.paramsJson!!).jsonObject
      assertEquals("main", params.getValue("sessionKey").jsonPrimitive.content)
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
      assertEquals("entry-user", params.getValue("entryId").jsonPrimitive.content)
    }

  @Test
  fun forkReturnsCreatedKeyEditorTextAndAttachmentsForLockedNativeSession() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.fork",
        """{"sessionKey":"agent:main:forked","editorText":"continue here","editorAttachments":[{"mimeType":"image/webp","data":"Zm9yaw=="}]}""",
      )
      val controller = controller(this, gateway)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"}}}""",
      )

      assertEquals(
        SessionForkResult(
          sessionKey = "agent:main:forked",
          editorText = "continue here",
          editorAttachments = listOf(SessionEditorAttachment(mimeType = "image/webp", data = "Zm9yaw==")),
        ),
        controller.forkSessionAtEntry("main", "entry-user"),
      )

      val params = json.parseToJsonElement(gateway.calls.single { it.method == "sessions.fork" }.paramsJson!!).jsonObject
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
      assertEquals("entry-user", params.getValue("entryId").jsonPrimitive.content)
    }

  @Test
  fun branchesListParsesAllFields() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-a","headline":"Earlier idea","messageCount":4,"updatedAt":"2026-07-20T12:00:00Z","active":false}]}""",
      )
      val controller = controller(this, gateway)

      assertEquals(
        listOf(SessionBranch("leaf-a", "Earlier idea", 4, "2026-07-20T12:00:00Z", active = false)),
        controller.listSessionBranches("main"),
      )
      val params = json.parseToJsonElement(gateway.calls.single().paramsJson!!).jsonObject
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
    }

  @Test
  fun switchReturnsTrueAndRefreshesHistoryAndBranches() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.branches.switch", "{}")
      gateway.respondWithBranchHistory()
      val controller = controller(this, gateway)

      assertTrue(controller.switchSessionBranch("main", "leaf-other"))
      assertEquals(1, gateway.callCount("sessions.branches.switch"))
      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(1, gateway.callCount("sessions.branches.list"))
    }

  @Test
  fun switchFailureReturnsFalseAndSurfacesError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.branches.switch") { throw IllegalStateException("run active") }
      val controller = controller(this, gateway)

      assertFalse(controller.switchSessionBranch("main", "leaf-other"))
      assertEquals("run active", controller.errorText.value)
    }

  @Test
  fun listFailureReturnsNullAndSurfacesError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.branches.list") { throw IllegalStateException("offline") }
      val controller = controller(this, gateway)

      assertNull(controller.listSessionBranches("main"))
      assertEquals("offline", controller.errorText.value)
    }

  @Test
  fun malformedBranchesResponseRetainsTheLastKnownBranchState() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-a","headline":"Known","messageCount":1,"active":true}]}""",
      )
      val controller = controller(this, gateway)

      assertTrue(controller.refreshSessionBranches())
      val known = controller.sessionBranches.value
      gateway.respondWith("sessions.branches.list", """{"branches":{}}""")

      assertFalse(controller.refreshSessionBranches())
      assertEquals(known, controller.sessionBranches.value)
    }

  @Test
  fun nullBranchTimestampRemainsAValidOptionalField() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-a","headline":"Known","messageCount":1,"updatedAt":null,"active":true}]}""",
      )
      val controller = controller(this, gateway)

      assertEquals(
        listOf(SessionBranch("leaf-a", "Known", 1, updatedAt = null, active = true)),
        controller.listSessionBranches("main"),
      )
    }

  @Test
  fun definitiveRewindFailureReloadsTheCurrentTranscript() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.rewind") { throw GatewayRequestNotEnqueued("rejected") }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "authoritative", 1, entryId = "entry-current")),
        ),
      )
      val controller = controller(this, gateway)

      assertNull(controller.rewindSessionAtEntryResult("main", "entry-old"))
      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(
        "authoritative",
        controller.messages.value
          .single()
          .content
          .single()
          .text,
      )
    }
}
