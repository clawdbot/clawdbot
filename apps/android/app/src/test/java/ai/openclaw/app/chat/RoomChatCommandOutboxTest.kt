package ai.openclaw.app.chat

import androidx.room.Room
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    ownerAgentId: String = "main",
  ): ChatOutboxItem {
    val result =
      enqueue(
        gatewayId = gatewayId,
        sessionKey = sessionKey,
        text = text,
        thinkingLevel = thinkingLevel,
        nowMs = nowMs,
        ownerAgentId = ownerAgentId,
      )
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
      assertEquals(listOf("main", "main", "main"), loaded.map { it.ownerAgentId })
      // Enqueue-time thinking level survives the round trip.
      assertEquals(listOf("high", "off", "off"), loaded.map { it.thinkingLevel })
      assertEquals(loaded.map { it.createdAtMs }.sorted(), loaded.map { it.createdAtMs })
    }

  @Test
  fun callerSuppliedIdempotencyKeyCanReconcileComposerAdmissionAfterRestart() =
    runTest {
      val result =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "agent:main:device",
          text = "send once",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          idempotencyKey = "composer-command-a",
        ) as ChatOutboxEnqueueResult.Queued

      assertEquals("composer-command-a", result.item.id)
      assertTrue(store.wasAdmitted("composer-command-a"))
      store.delete("composer-command-a")
      assertTrue(store.wasAdmitted("composer-command-a"))
      assertFalse(store.wasAdmitted("never-admitted"))
    }

  @Test
  fun admissionReceiptsStayBoundedAcrossSessionsForOneRoutingOwner() =
    runTest {
      repeat(OUTBOX_ADMISSION_RECEIPTS_PER_ROUTING_OWNER + 2) { index ->
        val id = "composer-command-$index"
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "agent:main:device-$index",
          text = "message $index",
          thinkingLevel = "off",
          nowMs = index.toLong(),
          ownerAgentId = "main",
          idempotencyKey = id,
        )
        store.delete(id)
      }

      assertFalse(store.wasAdmitted("composer-command-0"))
      assertFalse(store.wasAdmitted("composer-command-1"))
      repeat(OUTBOX_ADMISSION_RECEIPTS_PER_ROUTING_OWNER) { offset ->
        assertTrue(store.wasAdmitted("composer-command-${offset + 2}"))
      }
    }

  @Test
  fun activeAdmissionReceiptSurvivesFallbackPruningUntilCommandRetires() =
    runTest {
      val protectedId = "active-checkpoint"
      store.enqueue(
        gatewayId = "gateway-a",
        sessionKey = "agent:main:protected",
        text = "still pending",
        thinkingLevel = "off",
        nowMs = 0,
        ownerAgentId = "main",
        idempotencyKey = protectedId,
      )
      repeat(OUTBOX_ADMISSION_RECEIPTS_PER_ROUTING_OWNER + 2) { index ->
        val id = "retired-command-$index"
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "agent:main:device-$index",
          text = "message $index",
          thinkingLevel = "off",
          nowMs = index.toLong() + 1,
          ownerAgentId = "main",
          idempotencyKey = id,
        )
        store.delete(id)
      }

      store.delete(protectedId)
      assertTrue(store.wasAdmitted(protectedId))
      val nextId = "next-retired-command"
      store.enqueue(
        gatewayId = "gateway-a",
        sessionKey = "agent:main:next",
        text = "advance the recovery window",
        thinkingLevel = "off",
        nowMs = 100,
        ownerAgentId = "main",
        idempotencyKey = nextId,
      )
      store.delete(nextId)
      assertFalse(store.wasAdmitted(protectedId))
    }

  @Test
  fun enqueueRefusesBeyondMaxQueued() =
    runTest {
      repeat(OUTBOX_MAX_QUEUED) { index ->
        store.enqueueQueued("m$index", nowMs = index.toLong())
      }

      val refused =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "overflow",
          thinkingLevel = "off",
          nowMs = 999,
          ownerAgentId = "main",
        )

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

      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = stale.id, nowMs = now, gatedEpoch = null))
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

      val changed = store.requeueForRetry(gatewayId = "gateway-b", id = failed.id, nowMs = 20, gatedEpoch = null)

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
      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = failed.id, nowMs = 20, gatedEpoch = null))
      store.updateStatus(failed.id, ChatOutboxStatus.Sending, retryCount = 0, lastError = null)
      val sendingCreatedAt = store.load("gateway-a").single().createdAtMs

      val changed = store.requeueForRetry(gatewayId = "gateway-a", id = failed.id, nowMs = 30, gatedEpoch = null)

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
        store.enqueue(
          gatewayId = " ",
          sessionKey = "main",
          text = "hi",
          thinkingLevel = "off",
          nowMs = 1,
          ownerAgentId = "main",
        ),
      )
      assertEquals(emptyList<ChatOutboxItem>(), store.load(" "))

      // Nothing was written under a fallback scope either.
      assertEquals(emptyList<ChatOutboxItem>(), store.load("gateway-a"))
    }

  @Test
  fun deleteForSessionRemovesOnlyThatSessionsRows() =
    runTest {
      store.enqueue(
        gatewayId = "gateway-a",
        sessionKey = "main",
        text = "for main",
        thinkingLevel = "off",
        nowMs = 10,
        ownerAgentId = "main",
        idempotencyKey = "main-admission",
      )
      store.enqueueQueued("for other", nowMs = 20, sessionKey = "agent:other:main")
      store.enqueue(
        gatewayId = "gateway-a",
        sessionKey = "main",
        text = "other owner",
        thinkingLevel = "off",
        nowMs = 30,
        ownerAgentId = "other",
        idempotencyKey = "other-owner-admission",
      )

      store.deleteForSession("gateway-a", "main", "main")

      assertEquals(listOf("for other", "other owner"), store.load("gateway-a").map { it.text })
      assertFalse(store.wasAdmitted("main-admission"))
      assertTrue(store.wasAdmitted("other-owner-admission"))
    }

  private fun payload(
    bytes: ByteArray,
    fileName: String = "a.jpg",
    type: String = "image",
    mimeType: String = "image/jpeg",
    durationMs: Long? = null,
  ): OutboxAttachmentPayload = OutboxAttachmentPayload(type = type, mimeType = mimeType, fileName = fileName, durationMs = durationMs, bytes = bytes)

  @Test
  fun attachmentBytesRoundTripExactlyAcrossStoreReopen() =
    runTest {
      // Spans multiple chunks to prove chunked reassembly is byte-exact and ordered.
      val big = ByteArray(OUTBOX_ATTACHMENT_CHUNK_BYTES + 1234) { (it % 251).toByte() }
      val small = byteArrayOf(5, 4, 3)
      val queued =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "with media",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          attachments =
            listOf(
              payload(big, fileName = "big.jpg"),
              payload(small, fileName = "note.m4a", type = "audio", mimeType = "audio/mp4", durationMs = 900L),
            ),
        ) as ChatOutboxEnqueueResult.Queued

      val loadedItem = store.load("gateway-a").single()
      assertEquals(listOf("big.jpg", "note.m4a"), loadedItem.attachments.map { it.fileName })
      assertEquals(listOf(big.size.toLong(), small.size.toLong()), loadedItem.attachments.map { it.byteLength })
      assertEquals(900L, loadedItem.attachments[1].durationMs)

      val loaded = store.loadAttachments(queued.item.id)
      assertTrue(big.contentEquals(loaded[0].bytes))
      assertTrue(small.contentEquals(loaded[1].bytes))
    }

  @Test
  fun perCommandAttachmentByteCapRefusesOversizedSends() =
    runTest {
      val oversized = ByteArray((OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES + 1).toInt())
      val refused =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "too big",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          attachments = listOf(payload(oversized)),
        )
      assertEquals(ChatOutboxEnqueueResult.AttachmentsTooLarge, refused)
      assertTrue(store.load("gateway-a").isEmpty())
    }

  @Test
  fun gatewayAttachmentByteBudgetRefusesWhenExhaustedAndRecoversAfterDelete() =
    runTest {
      val chunk = ByteArray(OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES.toInt())
      val stored = mutableListOf<String>()
      var index = 0
      while (true) {
        val result =
          store.enqueue(
            gatewayId = "gateway-a",
            sessionKey = "main",
            text = "bulk $index",
            thinkingLevel = "off",
            nowMs = index.toLong(),
            ownerAgentId = "main",
            attachments = listOf(payload(chunk)),
          )
        if (result !is ChatOutboxEnqueueResult.Queued) {
          assertEquals(ChatOutboxEnqueueResult.StorageFull, result)
          break
        }
        stored += result.item.id
        index += 1
      }
      assertTrue(stored.isNotEmpty())

      // Deleting a queued row releases its bytes, so admission recovers.
      store.delete(stored.first())
      val retried =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "fits again",
          thinkingLevel = "off",
          nowMs = 999,
          ownerAgentId = "main",
          attachments = listOf(payload(chunk)),
        )
      assertTrue(retried is ChatOutboxEnqueueResult.Queued)
    }

  @Test
  fun conditionalDeleteNeverRemovesAClaimedRow() =
    runTest {
      val first =
        (
          store.enqueue(
            gatewayId = "gateway-a",
            sessionKey = "main",
            text = "delete queued",
            thinkingLevel = "off",
            nowMs = 1,
            ownerAgentId = "main",
            idempotencyKey = "rollback-receipt",
          ) as ChatOutboxEnqueueResult.Queued
        ).item
      assertTrue(store.wasAdmitted("rollback-receipt"))
      assertTrue(store.deleteIfQueued(first.id))
      assertTrue(store.load("gateway-a").isEmpty())
      assertFalse(store.wasAdmitted("rollback-receipt"))

      val claimed = store.enqueueQueued(text = "already claimed", nowMs = 2)
      assertEquals(1, store.claimForSending(claimed.id, retryCount = 0, lastError = null))
      assertFalse(store.deleteIfQueued(claimed.id))
      assertEquals(ChatOutboxStatus.Sending, store.load("gateway-a").single().status)
    }

  @Test
  fun confirmDeliveredRetiresRowsAndTheirAttachmentBytesAtomically() =
    runTest {
      val bytes = byteArrayOf(1, 2, 3)
      val queued =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "confirmed",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          attachments = listOf(payload(bytes)),
        ) as ChatOutboxEnqueueResult.Queued
      store.updateStatus(queued.item.id, ChatOutboxStatus.Accepted, retryCount = 0, lastError = null)
      val keep = store.enqueueQueued("kept", nowMs = 20)

      assertEquals(1, store.confirmDelivered(setOf(queued.item.id, "missing-row")))

      assertEquals(listOf(keep.id), store.load("gateway-a").map { it.id })
      assertTrue(store.loadAttachments(queued.item.id).isEmpty())
    }

  @Test
  fun clearGatewayAndSessionDeleteAlsoDropAttachmentBytes() =
    runTest {
      val a =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "a",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          attachments = listOf(payload(byteArrayOf(1))),
        ) as ChatOutboxEnqueueResult.Queued
      val b =
        store.enqueue(
          gatewayId = "gateway-b",
          sessionKey = "other",
          text = "b",
          thinkingLevel = "off",
          nowMs = 20,
          ownerAgentId = "main",
          attachments = listOf(payload(byteArrayOf(2))),
        ) as ChatOutboxEnqueueResult.Queued

      store.deleteForSession("gateway-b", "other", "main")
      store.clearGateway("gateway-a")

      assertTrue(store.load("gateway-a").isEmpty())
      assertTrue(store.load("gateway-b").isEmpty())
      assertTrue(store.loadAttachments(a.item.id).isEmpty())
      assertTrue(store.loadAttachments(b.item.id).isEmpty())
    }

  @Test
  fun pinSessionKeyRewritesTheAliasExactlyOnce() =
    runTest {
      val queued = store.enqueueQueued("pinned", nowMs = 10)
      store.pinSessionKey(queued.id, "agent:work:main")
      assertEquals("agent:work:main", store.load("gateway-a").single().sessionKey)
    }

  @Test
  fun gatedEpochSurvivesPersistenceAndRetryRestamping() =
    runTest {
      val queued =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "/clear",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          gatedEpoch = 7L,
        ) as ChatOutboxEnqueueResult.Queued
      assertEquals(7L, store.load("gateway-a").single().gatedEpoch)

      store.updateStatus(queued.item.id, ChatOutboxStatus.Failed, retryCount = 0, lastError = OUTBOX_CONNECTION_CHANGED_ERROR)
      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = queued.item.id, nowMs = 20, gatedEpoch = 9L))
      assertEquals(9L, store.load("gateway-a").single().gatedEpoch)
    }

  @Test
  fun staleAcceptedRowsExpireToDeliveryUnconfirmed() =
    runTest {
      val now = 1_000_000_000L
      val accepted = store.enqueueQueued("acked long ago", nowMs = now - OUTBOX_EXPIRY_MS - 1)
      store.updateStatus(accepted.id, ChatOutboxStatus.Accepted, retryCount = 0, lastError = null)

      store.expireStale("gateway-a", nowMs = now)

      val row = store.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Failed, row.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, row.lastError)
    }

  @Test
  fun claimForSendingIsAtomicAcrossCompetingDispatchers() =
    runTest {
      val queued = store.enqueueQueued("claim me", nowMs = 10)

      assertEquals(1, store.claimForSending(queued.id, 0, null))
      // The losing dispatcher gets 0 and must not send; the row is already claimed.
      assertEquals(0, store.claimForSending(queued.id, 0, null))
      assertEquals(ChatOutboxStatus.Sending, store.load("gateway-a").single().status)
    }

  @Test
  fun requeueForRetryKeepsSameSessionQueuedSuccessorsBehindTheRetriedRow() =
    runTest {
      val head = store.enqueueQueued("head", nowMs = 10)
      val tail = store.enqueueQueued("tail", nowMs = 20)
      val other = store.enqueueQueued("other", nowMs = 30, sessionKey = "agent:other:main")
      store.updateStatus(head.id, ChatOutboxStatus.Failed, retryCount = 0, lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR)

      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = head.id, nowMs = 1_000_000_000L, gatedEpoch = null))

      val byId = store.load("gateway-a").associateBy { it.id }
      // The retried head still precedes its session successor; unrelated sessions keep position.
      assertTrue(byId.getValue(head.id).createdAtMs < byId.getValue(tail.id).createdAtMs)
      assertEquals(ChatOutboxStatus.Queued, byId.getValue(tail.id).status)
      assertEquals(30L, byId.getValue(other.id).createdAtMs)
    }
}
