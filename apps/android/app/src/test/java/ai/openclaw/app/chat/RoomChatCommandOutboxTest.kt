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
  private val database: ClientStateDatabase =
    Room
      .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), ClientStateDatabase::class.java)
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
  fun restartRecoveryCreatesAmbiguityStateForRowsWithoutDeliveryMetadata() =
    runTest {
      database.outboxDao().insert(
        OutboxCommandEntity(
          id = "legacy-sending",
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "legacy",
          thinkingLevel = "off",
          createdAtMs = 10,
          status = ChatOutboxStatus.Sending.dbValue,
          retryCount = 0,
          lastError = null,
          gatedEpoch = null,
          ownerAgentId = "main",
        ),
      )

      store.failSendingAfterRestart()

      val recovered = store.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertTrue(recovered.hadUnacknowledgedSend)
    }

  @Test
  fun legacyAmbiguousFailureBackfillsFreshRetryIdentityEvidence() =
    runTest {
      database.outboxDao().insert(
        OutboxCommandEntity(
          id = "legacy-ambiguous",
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "legacy",
          thinkingLevel = "off",
          createdAtMs = 10,
          status = ChatOutboxStatus.Failed.dbValue,
          retryCount = 1,
          lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
          gatedEpoch = null,
          ownerAgentId = "main",
        ),
      )
      val legacy = store.load("gateway-a").single()
      assertTrue(legacy.hadUnacknowledgedSend)
      store.confirmBranchChange("gateway-a", ChatOutboxScope("main", "main"), "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR)
      val parked = store.load("gateway-a").single()

      store.requeueForRetryIfCurrent(
        gatewayId = "gateway-a",
        id = parked.id,
        expectedAttemptVersion = parked.attemptVersion,
        expectedRetryCount = parked.retryCount,
        expectedLastError = parked.lastError,
        nowMs = 20,
        gatedEpoch = null,
        ownerAgentId = "main",
        replacementId = "legacy-fresh-id",
      )

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
        store.requeueForRetryIfCurrent(
          gatewayId = "gateway-a",
          id = parkedAccepted.id,
          expectedAttemptVersion = parkedAccepted.attemptVersion,
          expectedRetryCount = parkedAccepted.retryCount,
          expectedLastError = parkedAccepted.lastError,
          nowMs = 20,
          gatedEpoch = null,
          ownerAgentId = "main",
          replacementId = "fresh-client-id",
        ),
      )
      val retriedAccepted = store.load("gateway-a").single()
      assertEquals("fresh-client-id", retriedAccepted.id)
      assertEquals(1, retriedAccepted.attemptVersion)

      store.delete(retriedAccepted.id)
      val queued = store.enqueueQueued("never dispatched", nowMs = 30)
      store.confirmBranchChange("gateway-a", scope, "leaf-newer", OUTBOX_BRANCH_CHANGED_ERROR)
      val parkedQueued = store.load("gateway-a").single()
      store.requeueForRetryIfCurrent(
        gatewayId = "gateway-a",
        id = parkedQueued.id,
        expectedAttemptVersion = parkedQueued.attemptVersion,
        expectedRetryCount = parkedQueued.retryCount,
        expectedLastError = parkedQueued.lastError,
        nowMs = 40,
        gatedEpoch = null,
        ownerAgentId = "main",
        replacementId = "unused-replacement",
      )
      val retriedQueued = store.load("gateway-a").single()
      assertEquals(queued.id, retriedQueued.id)
      assertEquals(2, retriedQueued.attemptVersion)
    }

  @Test
  fun freshRetryIdentityKeepsAttachmentMetadataAndChunksReachable() =
    runTest {
      val bytes = ByteArray(OUTBOX_ATTACHMENT_CHUNK_BYTES + 17) { (it % 251).toByte() }
      val queued =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "attachment retry",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "main",
          attachments = listOf(payload(bytes, fileName = "proof.jpg")),
        ) as ChatOutboxEnqueueResult.Queued
      store.updateStatusIfAttempt(queued.item.id, 1, ChatOutboxStatus.Accepted, 0, null)
      store.confirmBranchChange("gateway-a", ChatOutboxScope("main", "main"), "leaf-new", OUTBOX_BRANCH_CHANGED_ERROR)
      val parked = store.load("gateway-a").single()

      assertEquals(
        1,
        store.requeueForRetryIfCurrent(
          gatewayId = "gateway-a",
          id = parked.id,
          expectedAttemptVersion = parked.attemptVersion,
          expectedRetryCount = parked.retryCount,
          expectedLastError = parked.lastError,
          nowMs = 20,
          gatedEpoch = null,
          ownerAgentId = "main",
          replacementId = "fresh-attachment-id",
        ),
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
      assertTrue(
        store.reconcileBranchScope(
          gatewayId = "gateway-a",
          scope = scope,
          previousState = reconciliationState,
          activeLeafEntryId = null,
          branchLeafEntryIds = emptySet(),
          activeTranscriptEntryIds = emptySet(),
          lastError = OUTBOX_BRANCH_CHANGED_ERROR,
        ),
      )
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
  fun ancestryDisambiguatesTranscriptAdvanceFromRemoteBranchChange() =
    runTest {
      val advancingScope = ChatOutboxScope("advance", "main")
      val initialAdvance = requireNotNull(store.branchState("gateway-a", advancingScope))
      assertTrue(store.updateLastActiveLeafEntryId("gateway-a", advancingScope, "leaf-old", initialAdvance.epoch, initialAdvance.revision))
      val advanceState = requireNotNull(store.branchState("gateway-a", advancingScope))
      val advancingRow = store.enqueueQueued("stay active", nowMs = 10, sessionKey = "advance")
      assertTrue(
        store.reconcileBranchScope(
          gatewayId = "gateway-a",
          scope = advancingScope,
          previousState = advanceState,
          activeLeafEntryId = "leaf-new",
          branchLeafEntryIds = setOf("leaf-new"),
          activeTranscriptEntryIds = setOf("leaf-old", "leaf-new"),
          lastError = OUTBOX_BRANCH_CHANGED_ERROR,
        ),
      )
      assertEquals(ChatOutboxStatus.Queued, store.load("gateway-a").single { it.id == advancingRow.id }.status)

      val switchedScope = ChatOutboxScope("switched", "main")
      val initialSwitch = requireNotNull(store.branchState("gateway-a", switchedScope))
      assertTrue(store.updateLastActiveLeafEntryId("gateway-a", switchedScope, "leaf-a", initialSwitch.epoch, initialSwitch.revision))
      val switchState = requireNotNull(store.branchState("gateway-a", switchedScope))
      val switchedRow = store.enqueueQueued("park me", nowMs = 20, sessionKey = "switched")
      assertTrue(
        store.reconcileBranchScope(
          gatewayId = "gateway-a",
          scope = switchedScope,
          previousState = switchState,
          activeLeafEntryId = "leaf-b",
          branchLeafEntryIds = setOf("leaf-a", "leaf-b"),
          activeTranscriptEntryIds = setOf("leaf-b"),
          lastError = OUTBOX_BRANCH_CHANGED_ERROR,
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

      assertTrue(
        store.reconcileBranchScope(
          "gateway-a",
          mainScope,
          mainState,
          activeLeafEntryId = null,
          branchLeafEntryIds = emptySet(),
          activeTranscriptEntryIds = emptySet(),
          lastError = OUTBOX_BRANCH_CHANGED_ERROR,
        ),
      )
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
        store.reconcileBranchScope(
          gatewayId = "gateway-a",
          scope = scope,
          previousState = emptyRoot,
          activeLeafEntryId = "leaf-current",
          branchLeafEntryIds = setOf("leaf-current"),
          activeTranscriptEntryIds = setOf("leaf-current"),
          lastError = OUTBOX_BRANCH_CHANGED_ERROR,
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

      assertTrue(store.updateLastActiveLeafEntryId("gateway-a", scope, "leaf-current", captured.epoch, captured.revision))
      assertFalse(store.updateLastActiveLeafEntryId("gateway-a", scope, "leaf-stale", captured.epoch, captured.revision))
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
  fun retryAndExactSessionDeletionCanonicalizeOwnerAgentIds() =
    runTest {
      val queued =
        store.enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "mixed owner",
          thinkingLevel = "off",
          nowMs = 10,
          ownerAgentId = "Main",
        ) as ChatOutboxEnqueueResult.Queued
      assertEquals("main", store.load("gateway-a").single().ownerAgentId)
      store.updateStatus(queued.item.id, ChatOutboxStatus.Failed, retryCount = 1, lastError = "retry")

      assertEquals(
        1,
        store.requeueForRetry(
          gatewayId = "gateway-a",
          id = queued.item.id,
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
