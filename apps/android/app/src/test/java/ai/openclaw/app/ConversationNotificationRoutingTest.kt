package ai.openclaw.app

import ai.openclaw.app.chat.ChatComposerOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationNotificationRoutingTest {
  private val target =
    ConversationNotificationTarget(
      gatewayStableId = "gateway-a",
      agentId = "main",
      sessionKey = "agent:main:main",
      runId = "run-42",
    )

  @Test
  fun preTiramisuSkipsRuntimePermissionCheck() {
    var permissionChecked = false

    val allowed =
      canPostConversationNotifications(sdkInt = 31) {
        permissionChecked = true
        false
      }

    assertTrue(allowed)
    assertFalse(permissionChecked)
    assertFalse(canPostConversationNotifications(sdkInt = 33) { false })
    assertTrue(canPostConversationNotifications(sdkInt = 33) { true })
  }

  @Test
  fun unverifiedOrIncompleteOwnerCannotBecomeNotificationTarget() {
    assertEquals(
      null,
      ConversationNotificationTarget.from(
        ChatComposerOwner(
          gatewayStableId = "gateway-a",
          agentId = "main",
          sessionKey = "main",
          routingVerified = false,
        ),
        "run-42",
      ),
    )
    assertEquals(
      null,
      ConversationNotificationTarget.from(
        ChatComposerOwner(gatewayStableId = null, agentId = "main", sessionKey = "agent:main:main"),
        "run-42",
      ),
    )
  }

  @Test
  fun replyIdempotencyIsStablePerTerminalRun() {
    val first = conversationNotificationReplyIdempotencyKey(target)

    assertEquals(first, conversationNotificationReplyIdempotencyKey(target))
    assertNotEquals(first, conversationNotificationReplyIdempotencyKey(target.copy(runId = "run-43")))
  }

  @Test
  fun replyRoutesGatewayThenSessionThenExistingOwnerSend() =
    runTest {
      val events = mutableListOf<String>()
      var sentOwner: ChatComposerOwner? = null

      val sent =
        routeConversationNotificationReply(
          target = target,
          reply = "Continue",
          idempotencyKey = "idempotency-key",
          activeGatewayStableId = { "gateway-b" },
          switchGateway = { gatewayId ->
            events += "gateway:$gatewayId"
            true
          },
          awaitGatewayReady = { gatewayId ->
            events += "ready:$gatewayId"
            true
          },
          switchSession = { sessionKey, agentId -> events += "session:$sessionKey:$agentId" },
          send = { owner, message, idempotencyKey ->
            sentOwner = owner
            events += "send:$message:$idempotencyKey"
            true
          },
        )

      assertTrue(sent)
      assertEquals(
        listOf(
          "gateway:gateway-a",
          "ready:gateway-a",
          "session:agent:main:main:main",
          "send:Continue:idempotency-key",
        ),
        events,
      )
      assertEquals(target.toComposerOwner(), sentOwner)
    }

  @Test
  fun failedGatewaySwitchCannotCrossIntoSessionOrOutbox() =
    runTest {
      var sessionSwitched = false
      var sendCalled = false

      val sent =
        routeConversationNotificationReply(
          target = target,
          reply = "Continue",
          idempotencyKey = "idempotency-key",
          activeGatewayStableId = { "gateway-b" },
          switchGateway = { false },
          awaitGatewayReady = { true },
          switchSession = { _, _ -> sessionSwitched = true },
          send = { _, _, _ ->
            sendCalled = true
            true
          },
        )

      assertFalse(sent)
      assertFalse(sessionSwitched)
      assertFalse(sendCalled)
    }

  @Test
  fun unreadyGatewayCannotCrossIntoSessionOrOutbox() =
    runTest {
      val events = mutableListOf<String>()
      var sessionSwitched = false
      var sendCalled = false

      val sent =
        routeConversationNotificationReply(
          target = target,
          reply = "Continue",
          idempotencyKey = "idempotency-key",
          activeGatewayStableId = { "gateway-b" },
          switchGateway = { gatewayId ->
            events += "gateway:$gatewayId"
            true
          },
          awaitGatewayReady = { gatewayId ->
            events += "ready:$gatewayId"
            false
          },
          switchSession = { _, _ -> sessionSwitched = true },
          send = { _, _, _ ->
            sendCalled = true
            true
          },
        )

      assertFalse(sent)
      assertEquals(listOf("gateway:gateway-a", "ready:gateway-a"), events)
      assertFalse(sessionSwitched)
      assertFalse(sendCalled)
    }

  @Test
  fun successfulReplySkipsAdmissionLookup() =
    runTest {
      var admissionChecked = false

      val sent =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { true },
          wasAdmitted = {
            admissionChecked = true
            false
          },
        )

      assertTrue(sent)
      assertFalse(admissionChecked)
    }

  @Test
  fun timedOutReplyUsesDurableAdmissionReceipt() =
    runTest {
      val sent =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5,
          send = {
            delay(10)
            false
          },
          wasAdmitted = { true },
        )

      assertTrue(sent)
    }

  @Test
  fun failedReplyUsesDurableAdmissionReceipt() =
    runTest {
      val sent =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { error("transport failed after admission") },
          wasAdmitted = { true },
        )

      assertTrue(sent)
    }

  @Test
  fun unadmittedReplyRemainsFailed() =
    runTest {
      val sent =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { false },
          wasAdmitted = { false },
        )

      assertFalse(sent)
    }

  @Test
  fun admissionLookupFailureRemainsFailed() =
    runTest {
      val sent =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { false },
          wasAdmitted = { error("receipt unavailable") },
        )

      assertFalse(sent)
    }

  @Test
  fun externalCancellationIsNotConvertedIntoRetryFailure() =
    runTest {
      var cancellationObserved = false

      try {
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { throw CancellationException("cancelled") },
          wasAdmitted = { true },
        )
      } catch (_: CancellationException) {
        cancellationObserved = true
      }

      assertTrue(cancellationObserved)
    }
}
