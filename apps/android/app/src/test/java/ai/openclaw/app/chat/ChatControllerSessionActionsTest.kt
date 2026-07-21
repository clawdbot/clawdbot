package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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

  @Test
  fun rewindReturnsEditorTextAndIssuesAgentScopedParams() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.rewind", """{"editorText":"restore me"}""")
      gateway.respondWithBranchHistory()
      val controller = controller(this, gateway)

      assertEquals("restore me", controller.rewindSessionAtEntry("main", "entry-user"))

      val params = json.parseToJsonElement(gateway.calls.first { it.method == "sessions.rewind" }.paramsJson!!).jsonObject
      assertEquals("main", params.getValue("sessionKey").jsonPrimitive.content)
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
      assertEquals("entry-user", params.getValue("entryId").jsonPrimitive.content)
    }

  @Test
  fun forkReturnsCreatedKeyAndEditorText() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.fork", """{"sessionKey":"agent:main:forked","editorText":"continue here"}""")
      val controller = controller(this, gateway)

      assertEquals("agent:main:forked" to "continue here", controller.forkSessionAtEntry("main", "entry-user"))

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
