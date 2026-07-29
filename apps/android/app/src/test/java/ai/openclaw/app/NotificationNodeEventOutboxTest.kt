package ai.openclaw.app

import ai.openclaw.app.gateway.NodeEventSendOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationNodeEventOutboxTest {
  @Test
  fun deliverRetainsAcceptedEventsAcrossReconnectAndPreservesOrder() =
    runBlocking {
      val attempted = mutableListOf<String>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      val firstBlockedAttempt = CompletableDeferred<Unit>()
      var connected = false
      val outbox =
        NotificationNodeEventOutbox(capacity = 2) { pending ->
          attempted += pending.payloadJson.orEmpty()
          if (!connected) {
            firstBlockedAttempt.complete(Unit)
            NodeEventSendOutcome.DISCONNECTED
          } else {
            delivered.send(pending.payloadJson.orEmpty())
            NodeEventSendOutcome.COMPLETED
          }
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("first"))
        withTimeout(1_000) { firstBlockedAttempt.await() }
        outbox.enqueue(notificationEvent("second"))

        connected = true
        outbox.onConnected()

        val received =
          listOf(
            withTimeout(1_000) { delivered.receive() },
            withTimeout(1_000) { delivered.receive() },
          )
        assertEquals(listOf("first", "second"), received)
        assertEquals(listOf("first", "first", "second"), attempted)
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun enqueueDropsOldestBufferedEventAtCapacity() =
    runBlocking {
      val delivered = Channel<String>(Channel.UNLIMITED)
      var connected = false
      val outbox =
        NotificationNodeEventOutbox(
          capacity = 2,
          isConnected = { connected },
        ) { pending ->
          delivered.send(pending.payloadJson.orEmpty())
          NodeEventSendOutcome.COMPLETED
        }
      val deliveryJob = launch { outbox.deliver() }

      outbox.enqueue(notificationEvent("first"))
      outbox.enqueue(notificationEvent("second"))
      outbox.enqueue(notificationEvent("third"))
      connected = true
      outbox.onConnected()

      try {
        assertEquals("second", withTimeout(1_000) { delivered.receive() })
        assertEquals("third", withTimeout(1_000) { delivered.receive() })
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun clearDropsCurrentAndBufferedEvents() =
    runBlocking {
      val firstAttempt = CompletableDeferred<Unit>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      var connected = false
      val outbox =
        NotificationNodeEventOutbox { pending ->
          if (!connected) {
            firstAttempt.complete(Unit)
            NodeEventSendOutcome.DISCONNECTED
          } else {
            delivered.send(pending.payloadJson.orEmpty())
            NodeEventSendOutcome.COMPLETED
          }
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("first"))
        withTimeout(1_000) { firstAttempt.await() }
        outbox.enqueue(notificationEvent("second"))
        outbox.clear()
        connected = true
        outbox.onConnected()

        assertEquals(null, withTimeoutOrNull(100) { delivered.receive() })
        outbox.enqueue(notificationEvent("third"))
        assertEquals("third", withTimeout(1_000) { delivered.receive() })
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun ambiguousSendFailureIsNotRetried() =
    runBlocking {
      val failedAttempt = CompletableDeferred<Unit>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      val attempted = mutableListOf<String>()
      val outbox =
        NotificationNodeEventOutbox { pending ->
          val payload = pending.payloadJson.orEmpty()
          attempted += payload
          if (payload == "failed") {
            failedAttempt.complete(Unit)
            NodeEventSendOutcome.FAILED
          } else {
            delivered.send(payload)
            NodeEventSendOutcome.COMPLETED
          }
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("failed"))
        withTimeout(1_000) { failedAttempt.await() }
        outbox.enqueue(notificationEvent("next"))
        assertEquals("next", withTimeout(1_000) { delivered.receive() })
        assertEquals(listOf("failed", "next"), attempted)
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun ambiguousSendFailureConsumesDeliverySlot() =
    runBlocking {
      val sleepStarted = CompletableDeferred<Long>()
      val releaseSleep = CompletableDeferred<Unit>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      var nowEpochMs = 1_000L
      val outbox =
        NotificationNodeEventOutbox(
          deliveryIntervalMs = { 100L },
          nowEpochMs = { nowEpochMs },
          sleep = { delayMs ->
            sleepStarted.complete(delayMs)
            releaseSleep.await()
            nowEpochMs += delayMs
          },
        ) { pending ->
          if (pending.payloadJson == "failed") {
            NodeEventSendOutcome.FAILED
          } else {
            delivered.send(pending.payloadJson.orEmpty())
            NodeEventSendOutcome.COMPLETED
          }
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("failed"))
        outbox.enqueue(notificationEvent("next"))
        assertEquals(100L, withTimeout(1_000) { sleepStarted.await() })
        assertEquals(null, withTimeoutOrNull(100) { delivered.receive() })
        releaseSleep.complete(Unit)
        assertEquals("next", withTimeout(1_000) { delivered.receive() })
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun deliveryPacesQueuedEvents() =
    runBlocking {
      val sleepStarted = CompletableDeferred<Long>()
      val releaseSleep = CompletableDeferred<Unit>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      var nowEpochMs = 1_000L
      val outbox =
        NotificationNodeEventOutbox(
          deliveryIntervalMs = { 100L },
          nowEpochMs = { nowEpochMs },
          sleep = { delayMs ->
            sleepStarted.complete(delayMs)
            releaseSleep.await()
            nowEpochMs += delayMs
          },
        ) { pending ->
          delivered.send(pending.payloadJson.orEmpty())
          NodeEventSendOutcome.COMPLETED
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("first"))
        outbox.enqueue(notificationEvent("second"))
        assertEquals("first", withTimeout(1_000) { delivered.receive() })
        assertEquals(100L, withTimeout(1_000) { sleepStarted.await() })
        assertEquals(null, withTimeoutOrNull(100) { delivered.receive() })
        releaseSleep.complete(Unit)
        assertEquals("second", withTimeout(1_000) { delivered.receive() })
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun clearInvalidatesRateWaitWithoutDelayingReplacement() =
    runBlocking {
      val sleepStarted = CompletableDeferred<Unit>()
      val releaseSleep = CompletableDeferred<Unit>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      var nowEpochMs = 1_000L
      val outbox =
        NotificationNodeEventOutbox(
          deliveryIntervalMs = { 100L },
          nowEpochMs = { nowEpochMs },
          sleep = { delayMs ->
            sleepStarted.complete(Unit)
            releaseSleep.await()
            nowEpochMs += delayMs
          },
        ) { pending ->
          delivered.send(pending.payloadJson.orEmpty())
          NodeEventSendOutcome.COMPLETED
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("first"))
        assertEquals("first", withTimeout(1_000) { delivered.receive() })
        outbox.enqueue(notificationEvent("stale"))
        withTimeout(1_000) { sleepStarted.await() }
        outbox.clear()
        outbox.enqueue(notificationEvent("replacement"))
        releaseSleep.complete(Unit)

        assertEquals("replacement", withTimeout(1_000) { delivered.receive() })
        assertEquals(null, withTimeoutOrNull(100) { delivered.receive() })
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun clearInvalidatesOnlyAnInFlightSend() =
    runBlocking {
      val firstSendStarted = CompletableDeferred<Unit>()
      val finishFirstSend = CompletableDeferred<Unit>()
      val delivered = Channel<String>(Channel.UNLIMITED)
      var invalidationCount = 0
      var firstSend = true
      val outbox =
        NotificationNodeEventOutbox(
          invalidateConnection = { invalidationCount += 1 },
        ) { pending ->
          if (firstSend) {
            firstSend = false
            firstSendStarted.complete(Unit)
            finishFirstSend.await()
            NodeEventSendOutcome.FAILED
          } else {
            delivered.send(pending.payloadJson.orEmpty())
            NodeEventSendOutcome.COMPLETED
          }
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("stale"))
        withTimeout(1_000) { firstSendStarted.await() }
        outbox.clear()
        outbox.enqueue(notificationEvent("replacement"))
        finishFirstSend.complete(Unit)

        assertEquals("replacement", withTimeout(1_000) { delivered.receive() })
        assertEquals(1, invalidationCount)
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun clearWithOnlyQueuedEventsDoesNotInvalidateConnection() =
    runBlocking {
      var invalidationCount = 0
      val outbox =
        NotificationNodeEventOutbox(
          isConnected = { false },
          invalidateConnection = { invalidationCount += 1 },
        ) { NodeEventSendOutcome.COMPLETED }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.enqueue(notificationEvent("queued"))
        outbox.clear()
        assertEquals(0, invalidationCount)
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  @Test
  fun policyUpdateIsVisibleBeforeNewGenerationCanSend() =
    runBlocking {
      var authorized = true
      val delivered = Channel<String>(Channel.UNLIMITED)
      val outbox =
        NotificationNodeEventOutbox(
          isAuthorized = { authorized },
        ) { pending ->
          delivered.send(pending.payloadJson.orEmpty())
          NodeEventSendOutcome.COMPLETED
        }
      val deliveryJob = launch { outbox.deliver() }

      try {
        outbox.updatePolicy { authorized = false }
        outbox.enqueue(notificationEvent("blocked"))
        assertEquals(null, withTimeoutOrNull(100) { delivered.receive() })
      } finally {
        deliveryJob.cancelAndJoin()
      }
    }

  private fun notificationEvent(payload: String) =
    PendingNotificationNodeEvent(
      event = "notifications.changed",
      payloadJson = payload,
    )
}
