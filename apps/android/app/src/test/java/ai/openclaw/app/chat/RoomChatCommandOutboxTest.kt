package ai.openclaw.app.chat

import androidx.room3.Room
import androidx.room3.executeSQL
import androidx.room3.useWriterConnection
import androidx.room3.withWriteTransaction
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class RoomChatCommandOutboxTest {
  private val database: ClientStateDatabase =
    Room
      .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), ClientStateDatabase::class.java)
      .build()

  private val store = RoomChatCommandOutbox(database = database)

  @After
  fun tearDown() {
    database.close()
  }

  private suspend fun ChatCommandOutbox.enqueueResult(
    text: String,
    nowMs: Long,
    gatewayId: String = "gateway-a",
    sessionKey: String = "main",
    thinkingLevel: String = "off",
    ownerAgentId: String = "main",
    idempotencyKey: String? = null,
    attachments: List<OutboxAttachmentPayload> = emptyList(),
    gatedEpoch: Long? = null,
  ): ChatOutboxEnqueueResult =
    enqueue(
      gatewayId = gatewayId,
      sessionKey = sessionKey,
      text = text,
      thinkingLevel = thinkingLevel,
      nowMs = nowMs,
      ownerAgentId = ownerAgentId,
      idempotencyKey = idempotencyKey,
      attachments = attachments,
      gatedEpoch = gatedEpoch,
    )

  private suspend fun ChatCommandOutbox.enqueueQueued(
    text: String,
    nowMs: Long,
    gatewayId: String = "gateway-a",
    sessionKey: String = "main",
    thinkingLevel: String = "off",
    ownerAgentId: String = "main",
    idempotencyKey: String? = null,
    attachments: List<OutboxAttachmentPayload> = emptyList(),
    gatedEpoch: Long? = null,
  ): ChatOutboxItem =
    (
      enqueueResult(
        text = text,
        nowMs = nowMs,
        gatewayId = gatewayId,
        sessionKey = sessionKey,
        thinkingLevel = thinkingLevel,
        ownerAgentId = ownerAgentId,
        idempotencyKey = idempotencyKey,
        attachments = attachments,
        gatedEpoch = gatedEpoch,
      ) as ChatOutboxEnqueueResult.Queued
    ).item

  private suspend fun ChatCommandOutbox.requeueCurrent(
    item: ChatOutboxItem,
    nowMs: Long,
    replacementId: String,
  ): Int =
    requeueForRetryIfCurrent(
      gatewayId = "gateway-a",
      id = item.id,
      expectedAttemptVersion = item.attemptVersion,
      expectedRetryCount = item.retryCount,
      expectedLastError = item.lastError,
      nowMs = nowMs,
      gatedEpoch = null,
      ownerAgentId = "main",
      replacementId = replacementId,
    )

  private suspend fun ChatCommandOutbox.reconcile(
    scope: ChatOutboxScope,
    previousState: ChatOutboxBranchState,
    activeLeafEntryId: String? = null,
    branchLeafEntryIds: Set<String> = emptySet(),
    activeTranscriptEntryIds: Set<String> = emptySet(),
  ): Boolean =
    reconcileBranchScope(
      gatewayId = "gateway-a",
      scope = scope,
      evidence = ChatOutboxBranchEvidence.BranchListing(previousState, branchLeafEntryIds),
      activeLeafEntryId = activeLeafEntryId,
      activeTranscriptEntryIds = activeTranscriptEntryIds,
      lastError = OUTBOX_BRANCH_CHANGED_ERROR,
    ) != null

  private suspend fun insertLegacyCommand(
    id: String,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
  ) {
    database.outboxDao().insert(
      OutboxCommandEntity(
        id = id,
        gatewayId = "gateway-a",
        sessionKey = "main",
        text = "legacy",
        thinkingLevel = "off",
        createdAtMs = 10,
        status = status.dbValue,
        retryCount = retryCount,
        lastError = lastError,
        gatedEpoch = null,
        ownerAgentId = "main",
      ),
    )
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
  fun callerSuppliedIdempotencyKeyCanReconcileComposerAdmissionAfterRetirement() =
    runTest {
      val result =
        store.enqueueQueued(
          text = "send once",
          nowMs = 10,
          sessionKey = "agent:main:device",
          idempotencyKey = "composer-command-a",
        )

      assertEquals("composer-command-a", result.id)
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
        store.enqueueQueued(
          sessionKey = "agent:main:device-$index",
          text = "message $index",
          nowMs = index.toLong(),
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
      store.enqueueQueued(
        sessionKey = "agent:main:protected",
        text = "still pending",
        nowMs = 0,
        idempotencyKey = protectedId,
      )
      repeat(OUTBOX_ADMISSION_RECEIPTS_PER_ROUTING_OWNER + 2) { index ->
        val id = "retired-command-$index"
        store.enqueueQueued(
          sessionKey = "agent:main:device-$index",
          text = "message $index",
          nowMs = index.toLong() + 1,
          idempotencyKey = id,
        )
        store.delete(id)
      }

      store.delete(protectedId)
      assertTrue(store.wasAdmitted(protectedId))
      val nextId = "next-retired-command"
      store.enqueueQueued(
        sessionKey = "agent:main:next",
        text = "advance the recovery window",
        nowMs = 100,
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

      val refused = store.enqueueResult(text = "overflow", nowMs = 999)

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
  fun restartRecoveryCreatesAmbiguityStateForRowsWithoutDeliveryMetadata() =
    runTest {
      insertLegacyCommand("legacy-sending", ChatOutboxStatus.Sending, retryCount = 0, lastError = null)

      store.failSendingAfterRestart()

      val recovered = store.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertTrue(recovered.hadUnacknowledgedSend)
    }

  @Test
  fun legacyAmbiguousFailureBackfillsFreshRetryIdentityEvidence() =
    runTest {
      insertLegacyCommand(
        "legacy-ambiguous",
        ChatOutboxStatus.Failed,
        retryCount = 1,
        lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
      )
      val legacy = store.load("gateway-a").single()
      assertTrue(legacy.hadUnacknowledgedSend)
      store.confirmBranchChange("gateway-a", ChatOutboxScope("main", "main"), "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR)
      val parked = store.load("gateway-a").single()

      store.requeueCurrent(parked, nowMs = 20, replacementId = "legacy-fresh-id")

      assertEquals("legacy-fresh-id", store.load("gateway-a").single().id)
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
        store.enqueueResult(text = "hi", nowMs = 1, gatewayId = " "),
      )
      assertEquals(emptyList<ChatOutboxItem>(), store.load(" "))

      // Nothing was written under a fallback scope either.
      assertEquals(emptyList<ChatOutboxItem>(), store.load("gateway-a"))
    }

  @Test
  fun branchChangeParksQueuedRowsFromTheSupersededEpoch() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val queued = store.enqueueQueued("old branch", nowMs = 10)

      assertTrue(store.confirmBranchChange("gateway-a", scope, "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR))

      val parked = store.load("gateway-a").single()
      assertEquals(queued.id, parked.id)
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_BRANCH_CHANGED_ERROR, chatOutboxDisplayError(parked.lastError))
      assertEquals(0, parked.branchEpoch)
      assertEquals(1, parked.scopeBranchEpoch)
    }

  @Test
  fun parkedAcceptedRetryMintsFreshIdentityButQueuedRetryKeepsIdentity() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val accepted = store.enqueueQueued("maybe delivered", nowMs = 10)
      store.updateStatusIfAttempt(accepted.id, accepted.attemptVersion, ChatOutboxStatus.Accepted, 0, null)
      store.confirmBranchChange("gateway-a", scope, "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR)
      val parkedAccepted = store.load("gateway-a").single()
      assertTrue(parkedAccepted.parkedWasAccepted)

      assertEquals(
        1,
        store.requeueCurrent(parkedAccepted, nowMs = 20, replacementId = "fresh-client-id"),
      )
      val retriedAccepted = store.load("gateway-a").single()
      assertEquals("fresh-client-id", retriedAccepted.id)
      assertEquals(1, retriedAccepted.attemptVersion)

      store.delete(retriedAccepted.id)
      val queued = store.enqueueQueued("never dispatched", nowMs = 30)
      store.confirmBranchChange("gateway-a", scope, "leaf-newer", OUTBOX_BRANCH_CHANGED_ERROR)
      val parkedQueued = store.load("gateway-a").single()
      store.requeueCurrent(parkedQueued, nowMs = 40, replacementId = "unused-replacement")
      val retriedQueued = store.load("gateway-a").single()
      assertEquals(queued.id, retriedQueued.id)
      assertEquals(2, retriedQueued.attemptVersion)
    }

  @Test
  fun freshRetryIdentityKeepsAttachmentMetadataAndChunksReachable() =
    runTest {
      val bytes = ByteArray(OUTBOX_ATTACHMENT_CHUNK_BYTES + 17) { (it % 251).toByte() }
      val queued =
        store.enqueueQueued(
          text = "attachment retry",
          nowMs = 10,
          attachments = listOf(payload(bytes, fileName = "proof.jpg")),
        )
      store.updateStatusIfAttempt(queued.id, 1, ChatOutboxStatus.Accepted, 0, null)
      store.confirmBranchChange("gateway-a", ChatOutboxScope("main", "main"), "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR)
      val parked = store.load("gateway-a").single()

      assertEquals(
        1,
        store.requeueCurrent(parked, nowMs = 20, replacementId = "fresh-attachment-id"),
      )

      val loaded = store.loadAttachments("fresh-attachment-id").single()
      assertEquals("proof.jpg", loaded.attachment.fileName)
      assertTrue(bytes.contentEquals(loaded.bytes))
    }

  @Test
  fun staleDeliveryCallbackCannotOverwriteANewerAttempt() =
    runTest {
      val queued = store.enqueueQueued("retry safely", nowMs = 10)
      assertEquals(1, store.claimForSendingIfAttempt(queued.id, 1, 0, null))
      assertEquals(
        1,
        store.updateStatusIfAttempt(
          queued.id,
          1,
          ChatOutboxStatus.Queued,
          1,
          "not dispatched",
          expectedStatus = ChatOutboxStatus.Sending,
        ),
      )

      val retried = store.load("gateway-a").single()
      assertEquals(2, retried.attemptVersion)
      assertEquals(
        0,
        store.updateStatusIfAttempt(
          queued.id,
          1,
          ChatOutboxStatus.Accepted,
          0,
          null,
          expectedStatus = ChatOutboxStatus.Sending,
        ),
      )
      assertEquals(ChatOutboxStatus.Queued, store.load("gateway-a").single().status)
    }

  @Test
  fun deliveryCallbackCannotResurrectARowParkedByBranchChange() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val queued = store.enqueueQueued("claimed on old branch", nowMs = 10)
      assertEquals(1, store.claimForSendingIfAttempt(queued.id, queued.attemptVersion, 0, null))
      assertTrue(store.confirmBranchChange("gateway-a", scope, "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR))

      assertEquals(
        0,
        store.updateStatusIfAttempt(
          queued.id,
          queued.attemptVersion,
          ChatOutboxStatus.Accepted,
          0,
          null,
          expectedStatus = ChatOutboxStatus.Sending,
        ),
      )
      assertEquals(ChatOutboxStatus.Failed, store.load("gateway-a").single().status)
    }

  @Test
  fun sessionMutationLeaseParksRowsEnqueuedWhileTheGatewayMutationRuns() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      assertTrue(store.beginSessionMutation("gateway-a", scope, nowMs = 1_000) != null)
      val racing = store.enqueueQueued("racing enqueue", nowMs = 1_001)

      assertTrue(store.confirmBranchChange("gateway-a", scope, "leaf-after-rewind", OUTBOX_BRANCH_CHANGED_ERROR))

      val parked = store.load("gateway-a").single()
      assertEquals(racing.id, parked.id)
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(1, store.branchState("gateway-a", scope)?.epoch)
    }

  @Test
  fun demotedMutationNeedsReconciliationAndCannotClaimQueuedWork() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val lease = requireNotNull(store.beginSessionMutation("gateway-a", scope, nowMs = 1_000))
      assertTrue(store.demoteSessionMutationToReconciliation("gateway-a", scope, lease))
      val queued = store.enqueueQueued("wait for reconcile", nowMs = 1_001)

      assertTrue(store.branchState("gateway-a", scope)?.needsReconciliation == true)
      assertEquals(0, store.claimForSendingIfAttempt(queued.id, queued.attemptVersion, 0, null))
    }

  @Test
  fun staleMutationCancellationCannotClearNewerRemoteReconciliation() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val lease = requireNotNull(store.beginSessionMutation("gateway-a", scope, nowMs = 1_000))
      assertTrue(store.demoteSessionMutationToReconciliation("gateway-a", scope, lease = null))

      assertFalse(store.cancelSessionMutation("gateway-a", scope, lease))
      assertTrue(store.branchState("gateway-a", scope)?.needsReconciliation == true)
    }

  @Test
  fun staleMutationLeaseCannotConfirmOverANewerLease() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val staleLease = requireNotNull(store.beginSessionMutation("gateway-a", scope, nowMs = 1_000))
      assertTrue(store.demoteSessionMutationToReconciliation("gateway-a", scope, lease = null))
      val reconciliationState = requireNotNull(store.branchState("gateway-a", scope))
      assertTrue(store.reconcile(scope, reconciliationState))
      val currentLease = requireNotNull(store.beginSessionMutation("gateway-a", scope, nowMs = 2_000))

      assertFalse(
        store.confirmBranchChange(
          "gateway-a",
          scope,
          "stale-leaf",
          OUTBOX_BRANCH_CHANGED_ERROR,
          staleLease,
        ),
      )
      assertEquals(currentLease.startedAtMs, store.branchState("gateway-a", scope)?.switchPendingSinceMs)
    }

  @Test
  fun historyAdvancePreservesEveryDeliveryStateAndAttachmentIdentity() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val initial = requireNotNull(store.branchState("gateway-a", scope))
      assertTrue(store.recordTranscriptTip("gateway-a", scope, "leaf-a", initial))
      val bytes = byteArrayOf(1, 2, 3, 4)
      for (status in ChatOutboxStatus.entries) {
        val row = store.enqueueQueued(status.name, nowMs = 10, attachments = listOf(payload(bytes)))
        store.updateStatusIfAttempt(row.id, row.attemptVersion, status, 0, if (status == ChatOutboxStatus.Failed) "retained failure" else null)
      }
      val before = store.load("gateway-a")
      val captured = requireNotNull(store.branchState("gateway-a", scope))

      assertNotNull(
        store.reconcileBranchScope(
          "gateway-a",
          scope,
          ChatOutboxBranchEvidence.History(captured),
          "leaf-b",
          setOf("leaf-a", "leaf-b"),
          OUTBOX_BRANCH_CHANGED_ERROR,
        ),
      )

      assertEquals(before, store.load("gateway-a"))
      for (row in before) {
        val attachment = store.loadAttachments(row.id).single()
        assertEquals(row.attachments.single(), attachment.attachment)
        assertTrue(bytes.contentEquals(attachment.bytes))
      }
      assertEquals("leaf-b", store.branchState("gateway-a", scope)?.lastActiveLeafEntryId)
    }

  @Test
  fun staleBranchResponseCannotExpireANewerLeaseAndOverwriteItsBranch() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val initial = requireNotNull(store.branchState("gateway-a", scope))
      assertTrue(store.recordTranscriptTip("gateway-a", scope, "leaf-a", initial))
      val stale = requireNotNull(store.branchState("gateway-a", scope))
      assertTrue(store.confirmBranchChange("gateway-a", scope, "leaf-b", OUTBOX_BRANCH_CHANGED_ERROR))
      assertNotNull(store.beginSessionMutation("gateway-a", scope, nowMs = 1))
      val current = store.branchState("gateway-a", scope)

      assertFalse(
        store.reconcile(
          scope,
          stale,
          activeLeafEntryId = "leaf-a",
          branchLeafEntryIds = setOf("leaf-a"),
          activeTranscriptEntryIds = setOf("leaf-a"),
        ),
      )
      assertEquals(current, store.branchState("gateway-a", scope))
    }

  @Test
  fun ancestryDisambiguatesTranscriptAdvanceFromRemoteBranchChange() =
    runTest {
      val advancingScope = ChatOutboxScope("advance", "main")
      val initialAdvance = requireNotNull(store.branchState("gateway-a", advancingScope))
      assertTrue(store.recordTranscriptTip("gateway-a", advancingScope, "leaf-old", initialAdvance))
      val advanceState = requireNotNull(store.branchState("gateway-a", advancingScope))
      val advancingRow = store.enqueueQueued("stay active", nowMs = 10, sessionKey = "advance")
      assertTrue(
        store.reconcile(
          advancingScope,
          advanceState,
          activeLeafEntryId = "leaf-new",
          branchLeafEntryIds = setOf("leaf-new"),
          activeTranscriptEntryIds = setOf("leaf-old", "leaf-new"),
        ),
      )
      assertEquals(ChatOutboxStatus.Queued, store.load("gateway-a").single { it.id == advancingRow.id }.status)

      val switchedScope = ChatOutboxScope("switched", "main")
      val initialSwitch = requireNotNull(store.branchState("gateway-a", switchedScope))
      assertTrue(store.recordTranscriptTip("gateway-a", switchedScope, "leaf-a", initialSwitch))
      val switchState = requireNotNull(store.branchState("gateway-a", switchedScope))
      val switchedRow = store.enqueueQueued("park me", nowMs = 20, sessionKey = "switched")
      assertTrue(
        store.reconcile(
          switchedScope,
          switchState,
          activeLeafEntryId = "leaf-b",
          branchLeafEntryIds = setOf("leaf-a", "leaf-b"),
          activeTranscriptEntryIds = setOf("leaf-b"),
        ),
      )
      assertEquals(ChatOutboxStatus.Failed, store.load("gateway-a").single { it.id == switchedRow.id }.status)
    }

  @Test
  fun branchOwnershipIsAgentScopedAndEmptyRootReconciles() =
    runTest {
      val mainScope = ChatOutboxScope("shared", "main")
      val opsScope = ChatOutboxScope("shared", "ops")
      val mainState = requireNotNull(store.branchState("gateway-a", mainScope))
      val opsState = requireNotNull(store.branchState("gateway-a", opsScope))

      assertTrue(store.reconcile(mainScope, mainState))
      assertTrue(store.confirmBranchChange("gateway-a", mainScope, "main-leaf", OUTBOX_BRANCH_CHANGED_ERROR))
      assertEquals(1, store.branchState("gateway-a", mainScope)?.epoch)
      assertEquals(0, store.branchState("gateway-a", opsScope)?.epoch)
      assertEquals(opsState, store.branchState("gateway-a", opsScope))
    }

  @Test
  fun commandAdmittedAfterEmptyRootSnapshotBindsToTheListedBranch() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val emptyRoot = requireNotNull(store.branchState("gateway-a", scope))
      val admitted = store.enqueueQueued("after snapshot", nowMs = 10)

      assertTrue(
        store.reconcile(
          scope,
          emptyRoot,
          activeLeafEntryId = "leaf-current",
          branchLeafEntryIds = setOf("leaf-current"),
          activeTranscriptEntryIds = setOf("leaf-current"),
        ),
      )

      val rebound = store.load("gateway-a").single()
      assertEquals(admitted.id, rebound.id)
      assertEquals(ChatOutboxStatus.Queued, rebound.status)
      assertEquals("leaf-current", store.branchState("gateway-a", scope)?.lastActiveLeafEntryId)
    }

  @Test
  fun staleTranscriptTipRevisionCannotOverwriteTheCurrentLeaf() =
    runTest {
      val scope = ChatOutboxScope("main", "main")
      val captured = requireNotNull(store.branchState("gateway-a", scope))

      assertTrue(store.recordTranscriptTip("gateway-a", scope, "leaf-current", captured))
      assertFalse(store.recordTranscriptTip("gateway-a", scope, "leaf-stale", captured))
      assertEquals("leaf-current", store.branchState("gateway-a", scope)?.lastActiveLeafEntryId)
    }

  @Test
  fun pinningMainAliasRebasesDeliveryOntoTheCanonicalBranchEpoch() =
    runTest {
      val canonicalScope = ChatOutboxScope("agent:main:device", "main")
      assertTrue(store.confirmBranchChange("gateway-a", canonicalScope, "leaf-current", OUTBOX_BRANCH_CHANGED_ERROR))
      val queued = store.enqueueQueued("pre-hello", nowMs = 10, sessionKey = "main")

      store.pinSessionKey(queued.id, canonicalScope.sessionKey)

      val pinned = store.load("gateway-a").single()
      assertEquals(canonicalScope.sessionKey, pinned.sessionKey)
      assertEquals(1, pinned.branchEpoch)
      assertEquals(1, pinned.scopeBranchEpoch)
      assertEquals(1, store.claimForSendingIfAttempt(pinned.id, pinned.attemptVersion, 0, null))
    }

  @Test
  fun deleteForSessionRemovesOnlyThatSessionsRows() =
    runTest {
      store.enqueueQueued(
        text = "for main",
        nowMs = 10,
        idempotencyKey = "main-admission",
      )
      store.enqueueQueued("for other", nowMs = 20, sessionKey = "agent:other:main")
      store.enqueueQueued(
        text = "other owner",
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
      val context = RuntimeEnvironment.getApplication()
      val name = "outbox-reopen-${UUID.randomUUID()}.db"
      var persistentDatabase = ClientStateDatabase.open(context, name)
      try {
        val queued =
          RoomChatCommandOutbox(persistentDatabase).enqueueQueued(
            text = "with media",
            nowMs = 10,
            idempotencyKey = "media-admission",
            attachments =
              listOf(
                payload(big, fileName = "big.jpg"),
                payload(small, fileName = "note.m4a", type = "audio", mimeType = "audio/mp4", durationMs = 900L),
              ),
          )
        persistentDatabase.close()
        persistentDatabase = ClientStateDatabase.open(context, name)
        val reopened = RoomChatCommandOutbox(persistentDatabase)

        val loadedItem = reopened.load("gateway-a").single()
        assertEquals(queued, loadedItem)
        assertEquals(listOf("big.jpg", "note.m4a"), loadedItem.attachments.map { it.fileName })
        assertEquals(listOf(big.size.toLong(), small.size.toLong()), loadedItem.attachments.map { it.byteLength })
        assertEquals(900L, loadedItem.attachments[1].durationMs)
        val loaded = reopened.loadAttachments(queued.id)
        assertTrue(big.contentEquals(loaded[0].bytes))
        assertTrue(small.contentEquals(loaded[1].bytes))

        reopened.confirmDelivered(setOf(queued.id))
        persistentDatabase.close()
        persistentDatabase = ClientStateDatabase.open(context, name)
        val retired = RoomChatCommandOutbox(persistentDatabase)
        assertTrue(retired.load("gateway-a").isEmpty())
        assertTrue(retired.loadAttachments(queued.id).isEmpty())
        assertTrue(retired.wasAdmitted(queued.id))
      } finally {
        persistentDatabase.close()
        context.deleteDatabase(name)
      }
    }

  @Test
  fun cancelledAdmissionRollsBackItsReceiptCommandAndAttachmentBytes() =
    runTest {
      val admitted = CompletableDeferred<Unit>()
      val transaction =
        launch {
          database.withWriteTransaction {
            store.enqueueQueued(
              text = "cancelled before commit",
              nowMs = 10,
              idempotencyKey = "cancelled-admission",
              attachments = listOf(payload(byteArrayOf(1, 2, 3))),
            )
            admitted.complete(Unit)
            awaitCancellation()
          }
        }
      admitted.await()
      transaction.cancelAndJoin()

      assertFalse(store.wasAdmitted("cancelled-admission"))
      assertTrue(store.load("gateway-a").isEmpty())
      assertTrue(database.outboxDao().allAttachments().isEmpty())
      assertTrue(database.outboxDao().attachmentChunkPage(null, -1, 1).isEmpty())
      store.enqueueQueued("next admission still works", nowMs = 20)
      assertEquals(listOf("next admission still works"), store.load("gateway-a").map { it.text })
    }

  @Test
  fun perCommandAttachmentByteCapRefusesOversizedSends() =
    runTest {
      val oversized = ByteArray((OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES + 1).toInt())
      val refused =
        store.enqueueResult(
          text = "too big",
          nowMs = 10,
          attachments = listOf(payload(oversized)),
        )
      assertEquals(ChatOutboxEnqueueResult.AttachmentsTooLarge, refused)
      assertTrue(store.load("gateway-a").isEmpty())
    }

  @Test
  fun videoCommandsUseServerAttachmentCapWithoutRaisingOtherMediaCaps() =
    runTest {
      val aboveDefaultCap = ByteArray((OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES + 1L).toInt())
      val video =
        store.enqueueResult(
          text = "video",
          nowMs = 10,
          attachments = listOf(payload(aboveDefaultCap, type = "video", mimeType = "video/mp4")),
        )
      val document =
        store.enqueueResult(
          text = "document",
          nowMs = 11,
          attachments = listOf(payload(aboveDefaultCap, type = "file", mimeType = "application/pdf")),
        )

      assertTrue(video is ChatOutboxEnqueueResult.Queued)
      assertEquals(ChatOutboxEnqueueResult.AttachmentsTooLarge, document)
      assertEquals(20L * 1024L * 1024L, OUTBOX_MAX_VIDEO_COMMAND_ATTACHMENT_BYTES)
    }

  @Test
  fun mixedVideoCommandKeepsNonVideoAggregateCap() =
    runTest {
      val document = ByteArray(5 * 1024 * 1024)
      val refused =
        store.enqueueResult(
          text = "mixed",
          nowMs = 10,
          attachments =
            listOf(
              payload(document, fileName = "one.pdf", type = "file", mimeType = "application/pdf"),
              payload(document, fileName = "two.pdf", type = "file", mimeType = "application/pdf"),
              payload(byteArrayOf(1), fileName = "clip.mp4", type = "video", mimeType = "video/mp4"),
            ),
        )

      assertEquals(ChatOutboxEnqueueResult.AttachmentsTooLarge, refused)
    }

  @Test
  fun gatewayAttachmentByteBudgetRefusesWhenExhaustedAndRecoversAfterDelete() =
    runTest {
      val chunk = ByteArray(OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES.toInt())
      val stored = mutableListOf<String>()
      var index = 0
      while (true) {
        val result =
          store.enqueueResult(
            text = "bulk $index",
            nowMs = index.toLong(),
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
        store.enqueueResult(
          text = "fits again",
          nowMs = 999,
          attachments = listOf(payload(chunk)),
        )
      assertTrue(retried is ChatOutboxEnqueueResult.Queued)
    }

  @Test
  fun conditionalDeleteNeverRemovesAClaimedRow() =
    runTest {
      val first = store.enqueueQueued(text = "delete queued", nowMs = 1, idempotencyKey = "rollback-receipt")
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
        store.enqueueQueued(
          text = "confirmed",
          nowMs = 10,
          attachments = listOf(payload(bytes)),
        )
      store.updateStatus(queued.id, ChatOutboxStatus.Accepted, retryCount = 0, lastError = null)
      val keep = store.enqueueQueued("kept", nowMs = 20)

      database.useWriterConnection {
        it.executeSQL(
          "CREATE TRIGGER fail_command_retirement BEFORE DELETE ON outbox_commands " +
            "BEGIN SELECT RAISE(ABORT, 'retirement failed'); END",
        )
      }
      assertTrue(runCatching { store.confirmDelivered(setOf(queued.id)) }.isFailure)
      assertEquals(ChatOutboxStatus.Accepted, store.load("gateway-a").first().status)
      assertTrue(bytes.contentEquals(store.loadAttachments(queued.id).single().bytes))
      database.useWriterConnection { it.executeSQL("DROP TRIGGER fail_command_retirement") }

      assertEquals(1, store.confirmDelivered(setOf(queued.id, "missing-row")))

      assertEquals(listOf(keep.id), store.load("gateway-a").map { it.id })
      assertTrue(store.loadAttachments(queued.id).isEmpty())
    }

  @Test
  fun clearGatewayAndSessionDeleteAlsoDropAttachmentBytes() =
    runTest {
      val a =
        store.enqueueQueued(
          text = "a",
          nowMs = 10,
          attachments = listOf(payload(byteArrayOf(1))),
        )
      val b =
        store.enqueueQueued(
          sessionKey = "other",
          text = "b",
          nowMs = 20,
          gatewayId = "gateway-b",
          attachments = listOf(payload(byteArrayOf(2))),
        )

      store.deleteForSession("gateway-b", "other", "main")
      store.clearGateway("gateway-a")

      assertTrue(store.load("gateway-a").isEmpty())
      assertTrue(store.load("gateway-b").isEmpty())
      assertTrue(store.loadAttachments(a.id).isEmpty())
      assertTrue(store.loadAttachments(b.id).isEmpty())
    }

  @Test
  fun pinSessionKeyRewritesTheAliasExactlyOnce() =
    runTest {
      val queued = store.enqueueQueued("pinned", nowMs = 10)
      store.pinSessionKey(queued.id, "agent:work:main")
      assertEquals("agent:work:main", store.load("gateway-a").single().sessionKey)
    }

  @Test
  fun retryAndExactSessionDeletionCanonicalizeOwnerAgentIds() =
    runTest {
      val queued =
        store.enqueueQueued(
          text = "mixed owner",
          nowMs = 10,
          ownerAgentId = "Main",
        )
      assertEquals("main", store.load("gateway-a").single().ownerAgentId)
      store.updateStatus(queued.id, ChatOutboxStatus.Failed, retryCount = 1, lastError = "retry")

      assertEquals(
        1,
        store.requeueForRetry(
          gatewayId = "gateway-a",
          id = queued.id,
          nowMs = 20,
          gatedEpoch = null,
          ownerAgentId = "MAIN",
        ),
      )
      assertEquals("main", store.load("gateway-a").single().ownerAgentId)

      store.deleteForSession("gateway-a", "main", "MAIN")
      assertTrue(store.load("gateway-a").isEmpty())
    }

  @Test
  fun gatedEpochSurvivesPersistenceAndRetryRestamping() =
    runTest {
      val queued =
        store.enqueueQueued(
          text = "/clear",
          nowMs = 10,
          gatedEpoch = 7L,
        )
      assertEquals(7L, store.load("gateway-a").single().gatedEpoch)

      store.updateStatus(queued.id, ChatOutboxStatus.Failed, retryCount = 0, lastError = OUTBOX_CONNECTION_CHANGED_ERROR)
      assertEquals(1, store.requeueForRetry(gatewayId = "gateway-a", id = queued.id, nowMs = 20, gatedEpoch = 9L))
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
      val ready = List(2) { CompletableDeferred<Unit>() }
      val start = CompletableDeferred<Unit>()
      val claims =
        ready.map { contender ->
          async(Dispatchers.Default) {
            contender.complete(Unit)
            start.await()
            store.claimForSendingIfAttempt(queued.id, queued.attemptVersion, 0, null)
          }
        }
      ready.forEach { it.await() }
      start.complete(Unit)

      // Only the winning dispatcher may send, even when both observed the same attempt.
      assertEquals(listOf(0, 1), claims.awaitAll().sorted())
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
