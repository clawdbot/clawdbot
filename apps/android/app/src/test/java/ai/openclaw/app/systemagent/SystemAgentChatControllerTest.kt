package ai.openclaw.app.systemagent

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SystemAgentChatControllerTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun chatIsGatedAndGreetingUsesOnlySettingsSessionParams() =
    runTest {
      val harness = Harness(this)
      harness.responses += reply("Ready")

      harness.controller.refresh()
      harness.access = harness.access.copy(connected = true, gatewayId = "gateway-a")
      harness.controller.refresh()
      harness.access = harness.access.copy(hasAdminScope = true)
      harness.controller.refresh()
      assertTrue(harness.requests.isEmpty())

      harness.access = harness.access.copy(supportsMethod = true)
      harness.controller.refresh()
      advanceUntilIdle()

      val request = harness.requests.single()
      assertEquals("openclaw.chat", request.method)
      assertEquals(190_000, request.timeoutMs)
      val params = json.parseToJsonElement(request.paramsJson).jsonObject
      assertTrue(
        params
          .getValue("sessionId")
          .jsonPrimitive.content
          .startsWith("android-settings-openclaw-"),
      )
      assertFalse("message" in params)
      assertFalse("welcomeVariant" in params)
      assertFalse("delegation" in params)
    }

  @Test
  fun gatewayAccessRefreshDoesNotStartConversationUntilScreenRequestsIt() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += reply("Ready")

      harness.controller.refresh(startIfNeeded = false)
      advanceUntilIdle()
      assertEquals(SystemAgentChatAccess.Ready, harness.controller.state.value.access)
      assertTrue(harness.requests.isEmpty())

      harness.controller.refresh()
      advanceUntilIdle()
      assertEquals(1, harness.requests.size)
    }

  @Test
  fun sensitiveReplyIsSentVerbatimAndRedactedLocally() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += reply("Enter the token", sensitive = true)
      harness.responses += reply("Saved")

      harness.controller.refresh()
      advanceUntilIdle()
      assertTrue(harness.controller.state.value.expectsSensitiveReply)

      harness.controller.setInput(" nonpublic test text ")
      harness.controller.sendInput()
      advanceUntilIdle()

      val params = json.parseToJsonElement(harness.requests[1].paramsJson).jsonObject
      assertEquals(" nonpublic test text ", params.getValue("message").jsonPrimitive.content)
      assertTrue(
        harness.controller.state.value.messages.any {
          it.role == SystemAgentChatMessage.Role.User && it.text == "<redacted secret>"
        },
      )
      assertFalse(
        harness.controller.state.value.messages
          .any { "nonpublic test text" in it.text },
      )
    }

  @Test
  fun typedOptionSendsCanonicalReplyAndRetiresQuestion() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += questionReply()
      harness.responses += reply("Applied")

      harness.controller.refresh()
      advanceUntilIdle()
      val questionMessage =
        harness.controller.state.value.messages
          .single()

      harness.controller.answerQuestion(questionMessage.id, "Use Tailscale")
      advanceUntilIdle()

      val params = json.parseToJsonElement(harness.requests[1].paramsJson).jsonObject
      assertEquals("tailscale", params.getValue("message").jsonPrimitive.content)
      assertTrue(
        harness.controller.state.value.messages
          .any { it.text == "Use Tailscale" },
      )
      assertTrue(questionMessage.id in harness.controller.state.value.retiredQuestionIds)
    }

  @Test
  fun skipSendsExplicitReplyAndDismissesQuestion() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += questionReply()
      harness.responses += reply("Skipped")

      harness.controller.refresh()
      advanceUntilIdle()
      val questionMessage =
        harness.controller.state.value.messages
          .single()

      harness.controller.skipQuestion(questionMessage.id)
      advanceUntilIdle()

      val params = json.parseToJsonElement(harness.requests[1].paramsJson).jsonObject
      assertEquals("Skip for now", params.getValue("message").jsonPrimitive.content)
      assertTrue(questionMessage.id in harness.controller.state.value.dismissedQuestionIds)
    }

  @Test
  fun staleRouteReplyIsRejectedAndRequiresRestart() =
    runTest {
      val requestStarted = CompletableDeferred<Unit>()
      val response = CompletableDeferred<String>()
      val harness = readyHarness(this)
      harness.handler = {
        requestStarted.complete(Unit)
        response.await()
      }

      harness.controller.refresh()
      runCurrent()
      requestStarted.await()
      harness.routeCurrent = false
      response.complete(reply("stale reply"))
      advanceUntilIdle()

      assertTrue(
        harness.controller.state.value.messages
          .isEmpty(),
      )
      assertEquals(
        "The Gateway connection changed. Restart OpenClaw to reconnect.",
        harness.controller.state.value.errorText,
      )
    }

  @Test
  fun gatewaySwitchDuringAdmissionCannotPolluteReplacementConversation() =
    runTest {
      var access =
        SystemAgentGatewayAccess(
          connected = true,
          hasAdminScope = true,
          supportsMethod = true,
          gatewayId = "gateway-a",
        )
      var currentRoute = "gateway-a"
      var switchDuringCapture = false
      var requestCount = 0
      lateinit var controller: SystemAgentChatController
      controller =
        SystemAgentChatController(
          scope = this,
          access = { access },
          captureLease = { gatewayId ->
            val capturedRoute = gatewayId.orEmpty()
            val lease =
              GatewaySession.RequestLease(capturedRoute, { currentRoute == capturedRoute }, null) { _, _, _ ->
                requestCount += 1
                reply("Welcome")
              }
            if (switchDuringCapture) {
              currentRoute = "gateway-b"
              access = access.copy(gatewayId = currentRoute)
              controller.refresh(startIfNeeded = false)
            }
            lease
          },
          json = json,
        )

      controller.refresh()
      advanceUntilIdle()
      assertEquals(
        listOf("Welcome"),
        controller.state.value.messages
          .map { it.text },
      )

      switchDuringCapture = true
      controller.setInput("stale message")
      controller.sendInput()
      advanceUntilIdle()

      assertEquals(SystemAgentChatAccess.Ready, controller.state.value.access)
      assertTrue(
        controller.state.value.messages
          .isEmpty(),
      )
      assertFalse(controller.state.value.sending)
      assertNull(controller.state.value.errorText)
      assertEquals(1, requestCount)
    }

  @Test
  fun staleFailureCannotCommitOutsideCapturedRoute() =
    runTest {
      val harness = readyHarness(this)
      var commitCount = 0
      harness.commitIfCurrent = { block ->
        commitCount += 1
        if (commitCount == 1) {
          block()
          true
        } else {
          false
        }
      }
      harness.handler = {
        throw GatewayRequestRejected(GatewaySession.ErrorShape("FAILED", "old route failure"))
      }

      harness.controller.refresh()
      advanceUntilIdle()

      assertEquals(
        "The Gateway connection changed. Restart OpenClaw to reconnect.",
        harness.controller.state.value.errorText,
      )
      assertFalse(
        harness.controller.state.value.errorText
          ?.contains("old route failure") == true,
      )
    }

  @Test
  fun gatewayIdentityChangeRotatesConversationAndSession() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += questionReply()
      harness.responses += reply("New gateway")

      harness.controller.refresh()
      advanceUntilIdle()
      val originalSessionId = harness.controller.state.value.sessionId
      harness.controller.setInput("discard-me")

      harness.access = harness.access.copy(gatewayId = "gateway-b")
      harness.controller.refresh(startIfNeeded = false)
      assertNotEquals(originalSessionId, harness.controller.state.value.sessionId)
      assertTrue(
        harness.controller.state.value.messages
          .isEmpty(),
      )
      assertEquals("", harness.controller.state.value.input)
      assertEquals(1, harness.requests.size)
      harness.controller.refresh()
      advanceUntilIdle()
      assertEquals(
        listOf("New gateway"),
        harness.controller.state.value.messages
          .map { it.text },
      )
    }

  @Test
  fun reconnectOnSameGatewayRetainsTranscriptButRequiresFreshSession() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += reply("Welcome")
      harness.responses += reply("Recovered")

      harness.controller.refresh()
      advanceUntilIdle()
      val originalSessionId = harness.controller.state.value.sessionId

      harness.access = harness.access.copy(connected = false, supportsMethod = false)
      harness.controller.refresh()
      assertEquals(SystemAgentChatAccess.Disconnected, harness.controller.state.value.access)
      assertEquals(
        listOf("Welcome"),
        harness.controller.state.value.messages
          .map { it.text },
      )

      harness.access = harness.access.copy(connected = true, supportsMethod = true)
      harness.controller.refresh()
      assertEquals(SystemAgentChatAccess.Ready, harness.controller.state.value.access)
      assertTrue(harness.controller.state.value.errorText != null)
      assertEquals(1, harness.requests.size)

      harness.controller.restart()
      advanceUntilIdle()
      assertNotEquals(originalSessionId, harness.controller.state.value.sessionId)
      assertEquals(
        listOf("Recovered"),
        harness.controller.state.value.messages
          .map { it.text },
      )
    }

  @Test
  fun pendingSupportCheckClearsDraftButKeepsSecureConversationState() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += reply("Enter a secret", sensitive = true)

      harness.controller.refresh()
      advanceUntilIdle()
      harness.controller.setInput("discard-me")
      harness.access = harness.access.copy(supportsMethod = null)
      harness.controller.refresh()

      assertEquals(SystemAgentChatAccess.CheckingGateway, harness.controller.state.value.access)
      assertEquals("", harness.controller.state.value.input)
      assertTrue(harness.controller.state.value.expectsSensitiveReply)
      assertNull(harness.controller.state.value.errorText)

      harness.access = harness.access.copy(supportsMethod = true)
      harness.controller.refresh()
      assertEquals(1, harness.requests.size)
      assertEquals(
        listOf("Enter a secret"),
        harness.controller.state.value.messages
          .map { it.text },
      )
    }

  @Test
  fun backgroundCleanupClearsDraftWithoutCancelingInFlightGreeting() =
    runTest {
      val requestStarted = CompletableDeferred<Unit>()
      val response = CompletableDeferred<String>()
      val harness = readyHarness(this)
      harness.handler = {
        requestStarted.complete(Unit)
        response.await()
      }

      harness.controller.refresh()
      runCurrent()
      requestStarted.await()
      harness.controller.setInput("discard-me")
      harness.controller.clearInputForBackground()
      response.complete(reply("Welcome"))
      advanceUntilIdle()

      assertEquals("", harness.controller.state.value.input)
      assertEquals(
        listOf("Welcome"),
        harness.controller.state.value.messages
          .map { it.text },
      )
      assertNull(harness.controller.state.value.errorText)
    }

  @Test
  fun handoffWaitsForExplicitActionAndBlocksFurtherMessages() =
    runTest {
      val harness = readyHarness(this)
      harness.responses += reply("Continue in chat", action = "open-agent", agentId = " reviewer ")

      harness.controller.refresh()
      advanceUntilIdle()
      harness.controller.setInput("must-not-send")
      harness.controller.sendInput()
      advanceUntilIdle()

      assertEquals(1, harness.requests.size)
      assertEquals(
        " reviewer ",
        harness.controller.state.value.handoff
          ?.agentId,
      )
      assertEquals(" reviewer ", harness.controller.openHandoff()?.agentId)
      assertNull(harness.controller.state.value.handoff)
    }

  private fun readyHarness(scope: CoroutineScope): Harness =
    Harness(scope).also {
      it.access =
        SystemAgentGatewayAccess(
          connected = true,
          hasAdminScope = true,
          supportsMethod = true,
          gatewayId = "gateway-a",
        )
    }

  private fun reply(
    text: String,
    action: String = "none",
    sensitive: Boolean? = null,
    agentId: String? = null,
  ): String =
    buildJsonObject {
      put("sessionId", JsonPrimitive("system-session"))
      put("reply", JsonPrimitive(text))
      put("action", JsonPrimitive(action))
      sensitive?.let { put("sensitive", JsonPrimitive(it)) }
      agentId?.let { put("agentId", JsonPrimitive(it)) }
    }.toString()

  private fun questionReply(): String =
    """
    {
      "sessionId": "system-session",
      "reply": "Choose a connection",
      "action": "none",
      "question": {
        "id": "connection",
        "header": "Connection",
        "question": "How should OpenClaw connect?",
        "options": [
          {
            "label": "Use Tailscale",
            "description": "Private network",
            "recommended": true,
            "reply": "tailscale"
          },
          {
            "label": "Use LAN",
            "description": "Local network",
            "reply": "lan"
          }
        ]
      }
    }
    """.trimIndent()

  private data class RecordedRequest(
    val method: String,
    val paramsJson: String,
    val timeoutMs: Long,
  )

  private class Harness(
    scope: CoroutineScope,
  ) {
    var access =
      SystemAgentGatewayAccess(
        connected = false,
        hasAdminScope = false,
        supportsMethod = null,
        gatewayId = null,
      )
    var routeCurrent = true
    var commitIfCurrent: ((block: () -> Unit) -> Boolean)? = null
    val requests = mutableListOf<RecordedRequest>()
    val responses = ArrayDeque<String>()
    var handler: suspend (RecordedRequest) -> String = { responses.removeFirst() }
    val controller =
      SystemAgentChatController(
        scope = scope,
        access = { access },
        captureLease = { gatewayId ->
          if (!access.connected) {
            null
          } else {
            GatewaySession.RequestLease(gatewayId.orEmpty(), { routeCurrent }, commitIfCurrent) { method, paramsJson, timeoutMs ->
              val request = RecordedRequest(method, paramsJson.orEmpty(), timeoutMs)
              requests += request
              handler(request)
            }
          }
        },
        json = Json { ignoreUnknownKeys = true },
      )
  }
}
