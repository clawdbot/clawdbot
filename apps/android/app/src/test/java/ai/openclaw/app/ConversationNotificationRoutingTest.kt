package ai.openclaw.app

import ai.openclaw.app.chat.ChatComposerOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
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
          isCurrent = { true },
          switchGateway = { gatewayId ->
            events += "gateway:$gatewayId"
            GatewayTargetSelection.Selected { true }
          },
          awaitGatewayReady = { gatewayId ->
            events += "ready:$gatewayId"
            true
          },
          switchSession = { sessionKey, agentId -> events += "session:$sessionKey:$agentId" },
          send = { owner, message, idempotencyKey, _ ->
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
          isCurrent = { true },
          switchGateway = { GatewayTargetSelection.Unavailable },
          awaitGatewayReady = { true },
          switchSession = { _, _ -> sessionSwitched = true },
          send = { _, _, _, _ ->
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
          isCurrent = { true },
          switchGateway = { gatewayId ->
            events += "gateway:$gatewayId"
            GatewayTargetSelection.Selected { true }
          },
          awaitGatewayReady = { gatewayId ->
            events += "ready:$gatewayId"
            false
          },
          switchSession = { _, _ -> sessionSwitched = true },
          send = { _, _, _, _ ->
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

      assertEquals(ConversationNotificationReplyOutcome.Admitted, sent)
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

      assertEquals(ConversationNotificationReplyOutcome.Admitted, sent)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun replyRecoveryFinishesWithoutCancellingReceiptProducer() =
    runTest {
      val receipt = CompletableDeferred<Boolean>()
      var recoveryEntered = false
      val result =
        async {
          sendConversationNotificationReplyWithRecovery(
            timeoutMs = 5_000,
            send = { awaitCancellation() },
            wasAdmitted = {
              recoveryEntered = true
              receipt.await()
            },
          )
        }

      try {
        runCurrent()
        advanceTimeBy(5_000)
        runCurrent()
        assertTrue("Receipt recovery must start after the send timeout", recoveryEntered)

        advanceTimeBy(1_000)
        runCurrent()
        assertTrue("Reply recovery must finish within its own budget", result.isCompleted)
        assertEquals(ConversationNotificationReplyOutcome.Unknown, result.await())
        assertTrue("Timing out the receipt waiter must not cancel its producer", receipt.isActive)
      } finally {
        try {
          result.cancelAndJoin()
        } finally {
          receipt.cancel()
        }
      }
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

      assertEquals(ConversationNotificationReplyOutcome.Admitted, sent)
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

      assertEquals(ConversationNotificationReplyOutcome.NotAdmitted, sent)
    }

  @Test
  fun admissionLookupFailureRemainsUnknown() =
    runTest {
      val sent =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { false },
          wasAdmitted = { error("receipt unavailable") },
        )

      assertEquals(ConversationNotificationReplyOutcome.Unknown, sent)
    }

  @Test
  fun unavailableAdmissionLookupRemainsUnknown() =
    runTest {
      val outcome =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5_000,
          send = { false },
          wasAdmitted = { null },
        )

      assertEquals(ConversationNotificationReplyOutcome.Unknown, outcome)
    }

  @Test
  fun delayedReceiptWithinRecoveryBudgetRemainsAdmitted() =
    runTest {
      val outcome =
        sendConversationNotificationReplyWithRecovery(
          timeoutMs = 5,
          send = { awaitCancellation() },
          wasAdmitted = {
            delay(999)
            true
          },
        )

      assertEquals(ConversationNotificationReplyOutcome.Admitted, outcome)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun callerCancellationDuringEitherReplyStepLeavesIndependentProducerAlive() =
    runTest {
      for (cancelDuringSend in listOf(true, false)) {
        val producer = CompletableDeferred<Boolean>()
        var stepEntered = false
        val result =
          async {
            sendConversationNotificationReplyWithRecovery(
              timeoutMs = 5_000,
              send = {
                if (cancelDuringSend) {
                  stepEntered = true
                  producer.await()
                } else {
                  false
                }
              },
              wasAdmitted = {
                stepEntered = true
                producer.await()
              },
            )
          }

        try {
          runCurrent()
          assertTrue(stepEntered)
          result.cancelAndJoin()
          assertTrue(result.isCancelled)
          assertTrue(producer.isActive)
        } finally {
          try {
            result.cancelAndJoin()
          } finally {
            producer.cancel()
          }
        }
      }
    }

  @Test
  fun nestedTimeoutInEitherReplyStepIsNotAnAdmissionOutcome() =
    runTest {
      for (timeoutDuringSend in listOf(true, false)) {
        var timeoutObserved = false
        try {
          sendConversationNotificationReplyWithRecovery(
            timeoutMs = 5_000,
            send = {
              if (timeoutDuringSend) withTimeout(1) { awaitCancellation() } else false
            },
            wasAdmitted = {
              if (timeoutDuringSend) true else withTimeout(1) { awaitCancellation() }
            },
          )
        } catch (_: TimeoutCancellationException) {
          timeoutObserved = true
        }
        assertTrue(timeoutObserved)
      }
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
