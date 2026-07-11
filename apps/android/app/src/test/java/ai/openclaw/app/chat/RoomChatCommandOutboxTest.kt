package ai.openclaw.app.chat

import androidx.room.Room
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class RoomChatCommandOutboxTest {
  private val database: ChatCacheDatabase =
    Room
      .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), ChatCacheDatabase::class.java)
      .build()

  private val store = RoomChatCommandOutbox(database = database)

  @After
  fun tearDown() {
    database.close()
  }

  private suspend fun ChatCommandOutbox.enqueueQueued(
    text: String,
    nowMs: Long,
    gatewayId: String = "gateway-a",
    sessionKey: String = "main",
    thinkingLevel: String = "off",
  ): ChatOutboxItem {
    val result =
      enqueue(gatewayId = gatewayId, sessionKey = sessionKey, text = text, thinkingLevel = thinkingLevel, nowMs = nowMs)
    return (result as ChatOutboxEnqueueResult.Queued).item
  }

  @Test
  fun enqueuePersistsAndLoadsInEnqueueOrderEvenForCollidingClocks() =
    runTest {
      store.enqueueQueued("first", nowMs = 20, thinkingLevel = "high")
      // Same millisecond and a backwards clock must not scramble FIFO flush order.
      store.enqueueQueued("second", nowMs = 20)
      store.enqueueQueued("third", nowMs = 10)

      val loaded = store.load("gateway-a")

      assertEquals(listOf("first", "second", "third"), loaded.map { it.text })
      assertTrue(loaded.all { it.status == ChatOutboxStatus.Queued && it.retryCount == 0 && it.lastError == null })
      assertEquals(listOf("main", "main", "main"), loaded.map { it.sessionKey })
      // Enqueue-time thinking level survives the round trip.
      assertEquals(listOf("high", "off", "off"), loaded.map { it.thinkingLevel })
      assertEquals(loaded.map { it.createdAtMs }.sorted(), loaded.map { it.createdAtMs })
    }

  @Test
  fun enqueueRefusesBeyondMaxQueued() =
    runTest {
      repeat(OUTBOX_MAX_QUEUED) { index ->
        store.enqueueQueued("m$index", nowMs = index.toLong())
      }

      val refused =
        store.enqueue(gatewayId = "gateway-a", sessionKey = "main", text = "overflow", thinkingLevel = "off", nowMs = 999)

      assertEquals(ChatOutboxEnqueueResult.QueueFull, refused)
      assertEquals(OUTBOX_MAX_QUEUED, store.load("gateway-a").size)
    }

  @Test
  fun expireStaleFailsRowsAtOrPastTheBoundaryOnly() =
    runTest {
      val now = 1_000_000_000L
      val atBoundary = store.enqueueQueued("stale", nowMs = now - OUTBOX_EXPIRY_MS)
      val justInside = store.enqueueQueued("fresh", nowMs = now - OUTBOX_EXPIRY_MS + 1)

      store.expireStale("gateway-a", nowMs = now)

      val byId = store.load("gateway-a").associateBy { it.id }
      assertEquals(ChatOutboxStatus.Failed, byId.getValue(atBoundary.id).status)
      assertEquals(OUTBOX_EXPIRED_ERROR, byId.getValue(atBoundary.id).lastError)
      assertEquals(ChatOutboxStatus.Queued, byId.getValue(justInside.id).status)
      assertNull(byId.getValue(justInside.id).lastError)
    }

  @Test
  fun expireStaleLeavesFailedAndSendingRowsUntouched() =
    runTest {
      val now = 1_000_000_000L
      val failed = store.enqueueQueued("already failed", nowMs = now - OUTBOX_EXPIRY_MS - 5)
      store.updateStatus(failed.id, ChatOutboxStatus.Failed, retryCount = 3, lastError = "boom")
      val sending = store.enqueueQueued("in flight", nowMs = now - OUTBOX_EXPIRY_MS - 5)
      store.updateStatus(sending.id, ChatOutboxStatus.Sending, retryCount = 0, lastError = null)

      store.expireStale("gateway-a", nowMs = now)

      val byId = store.load("gateway-a").associateBy { it.id }
      assertEquals("boom", byId.getValue(failed.id).lastError)
      assertEquals(ChatOutboxStatus.Sending, byId.getValue(sending.id).status)
    }

  @Test
  fun failSendingAfterRestartKeepsInterruptedRowsVisibleForExplicitRetry() =
    runTest {
      val interrupted = store.enqueueQueued("interrupted", nowMs = 10)
      store.updateStatus(interrupted.id, ChatOutboxStatus.Sending, retryCount = 1, lastError = "socket closed")
      val failed = store.enqueueQueued("dead", nowMs = 20)
      store.updateStatus(failed.id, ChatOutboxStatus.Failed, retryCount = 3, lastError = "boom")

      store.failSendingAfterRestart()

      val byId = store.load("gateway-a").associateBy { it.id }
      assertEquals(ChatOutboxStatus.Failed, byId.getValue(interrupted.id).status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, byId.getValue(interrupted.id).lastError)
      // Retry bookkeeping survives the restart so an explicit retry retains the original context.
      assertEquals(1, byId.getValue(interrupted.id).retryCount)
      assertEquals(ChatOutboxStatus.Failed, byId.getValue(failed.id).status)
    }

  @Test
  fun requeueForRetryRefreshesCreatedAtSoExpirySweepCannotRefailIt() =
    runTest {
      val now = 1_000_000_000L
      val stale = store.enqueueQueued("expired once", nowMs = now - OUTBOX_EXPIRY_MS - 10)
      store.expireStale("gateway-a", nowMs = now)
      assertEquals(ChatOutboxStatus.Failed, store.load("gateway-a").single().status)

      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = stale.id, nowMs = now))
      store.expireStale("gateway-a", nowMs = now)

      val retried = store.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Queued, retried.status)
      assertEquals(0, retried.retryCount)
      assertNull(retried.lastError)
      assertTrue(retried.createdAtMs >= now)
    }

  @Test
  fun requeueForRetryCannotCrossGatewayOwnership() =
    runTest {
      val failed = store.enqueueQueued("gateway a failed", nowMs = 10, gatewayId = "gateway-a")
      store.updateStatus(failed.id, ChatOutboxStatus.Failed, retryCount = 1, lastError = "boom")

      val changed = store.requeueForRetry(gatewayId = "gateway-b", id = failed.id, nowMs = 20)

      assertEquals(0, changed)
      val untouched = store.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Failed, untouched.status)
      assertEquals(10L, untouched.createdAtMs)
      assertEquals("boom", untouched.lastError)
    }

  @Test
  fun secondRetryCannotRequeueARowAlreadySending() =
    runTest {
      val failed = store.enqueueQueued("retry once", nowMs = 10)
      store.updateStatus(failed.id, ChatOutboxStatus.Failed, retryCount = 1, lastError = "boom")
      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = failed.id, nowMs = 20))
      store.updateStatus(failed.id, ChatOutboxStatus.Sending, retryCount = 0, lastError = null)
      val sendingCreatedAt = store.load("gateway-a").single().createdAtMs

      val changed = store.requeueForRetry(gatewayId = "gateway-a", id = failed.id, nowMs = 30)

      assertEquals(0, changed)
      val untouched = store.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Sending, untouched.status)
      assertEquals(sendingCreatedAt, untouched.createdAtMs)
    }

  @Test
  fun rowsAreScopedToGatewayIdentity() =
    runTest {
      store.enqueueQueued("gateway a command", nowMs = 10, gatewayId = "gateway-a")

      assertEquals(emptyList<ChatOutboxItem>(), store.load("gateway-b"))
      store.enqueueQueued("gateway b command", nowMs = 20, gatewayId = "gateway-b")

      assertEquals(listOf("gateway a command"), store.load("gateway-a").map { it.text })
      assertEquals(listOf("gateway b command"), store.load("gateway-b").map { it.text })
    }

  @Test
  fun blankGatewayIdentityDisablesReadsAndWrites() =
    runTest {
      assertEquals(
        ChatOutboxEnqueueResult.Unavailable,
        store.enqueue(gatewayId = " ", sessionKey = "main", text = "hi", thinkingLevel = "off", nowMs = 1),
      )
      assertEquals(emptyList<ChatOutboxItem>(), store.load(" "))

      // Nothing was written under a fallback scope either.
      assertEquals(emptyList<ChatOutboxItem>(), store.load("gateway-a"))
    }

  @Test
  fun deleteForSessionRemovesOnlyThatSessionsRows() =
    runTest {
      store.enqueueQueued("for main", nowMs = 10)
      store.enqueueQueued("for other", nowMs = 20, sessionKey = "agent:other:main")

      store.deleteForSession("gateway-a", "main")

      assertEquals(listOf("for other"), store.load("gateway-a").map { it.text })
    }
}
