package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.chat.outboxItemsForSession
import androidx.room3.Room
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerBranchCoordinationTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val database =
    Room
      .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), ClientStateDatabase::class.java)
      .build()
  private val outbox = RoomChatCommandOutbox(database)
  private val controllerScopes = mutableListOf<CoroutineScope>()

  @After
  fun tearDown() {
    controllerScopes.forEach { it.cancel() }
    database.close()
  }

  private fun controller(
    gateway: ScriptedGateway,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    gatewayAdvertisesMethod: (method: String) -> Boolean? = { null },
    commandOutbox: ChatCommandOutbox = outbox,
  ): ChatController {
    val controllerScope = CoroutineScope(SupervisorJob() + dispatcher)
    controllerScopes += controllerScope
    return ChatController(
      scope = controllerScope,
      json = json,
      requestGateway = gateway::request,
      cacheScope = { ChatCacheScope("gateway-a", 1) },
      gatewayAdvertisesMethod = gatewayAdvertisesMethod,
      commandOutbox = commandOutbox,
    )
  }

  private suspend fun enqueue(
    text: String = "queued",
    sessionKey: String = "main",
  ): ChatOutboxItem =
    (
      outbox.enqueue(
        gatewayId = "gateway-a",
        sessionKey = sessionKey,
        text = text,
        thinkingLevel = "off",
        nowMs = System.currentTimeMillis(),
        ownerAgentId = "main",
      ) as ChatOutboxEnqueueResult.Queued
    ).item

  private suspend fun ChatController.awaitOutboxRestore() {
    withContext(Dispatchers.Default.limitedParallelism(1)) {
      withTimeout(5_000) { outboxPresentationRestored.first { it } }
    }
  }

  @Test
  fun unconfirmedOutboxBlocksRewindForkAndBranchSwitch() =
    runTest {
      enqueue()
      assertNull(
        outbox.beginSessionMutation(
          "gateway-a",
          ChatOutboxScope("main", "main"),
          nowMs = 100,
        ),
      )
      val gateway = ScriptedGateway(json)
      val controller = controller(gateway)
      runCurrent()
      controller.awaitOutboxRestore()

      assertNull(controller.rewindSessionAtEntryResult("main", "entry-a"))
      assertNull(controller.forkSessionAtEntry("main", "entry-a"))
      assertFalse(controller.switchSessionBranch("main", "leaf-b"))
      assertTrue(
        gateway.calls.toString(),
        gateway.calls.none { it.method in setOf("sessions.rewind", "sessions.fork", "sessions.branches.switch") },
      )
    }

  @Test
  fun rewindParksAnEnqueueThatRacesInsideTheMutationLease() =
    runTest {
      val gateway = ScriptedGateway(json)
      val rewindStarted = CompletableDeferred<Unit>()
      val releaseRewind = CompletableDeferred<Unit>()
      gateway.respond("sessions.rewind") {
        rewindStarted.complete(Unit)
        releaseRewind.await()
        """{"editorText":"restored"}"""
      }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "before", 1, entryId = "leaf-after")),
        ),
      )
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-after","headline":"After rewind","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      runCurrent()
      controller.awaitOutboxRestore()

      val rewind = async { controller.rewindSessionAtEntryResult("main", "entry-a") }
      rewindStarted.await()
      val racing = enqueue("racing")
      val leasedState = requireNotNull(outbox.branchState("gateway-a", ChatOutboxScope("main", "main")))
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", "external-during-rewind", seq = 1))
      awaitBranchProgress { controller.sessionId.value == "session-main" }
      assertEquals(leasedState, outbox.branchState("gateway-a", ChatOutboxScope("main", "main")))
      assertEquals(racing.id, outbox.load("gateway-a").single().id)
      assertEquals(ChatOutboxStatus.Queued, outbox.load("gateway-a").single().status)
      assertEquals(0, gateway.callCount("chat.send"))
      releaseRewind.complete(Unit)

      val result = rewind.await()
      assertNotNull(result)
      assertEquals("restored", result?.editorText)
      val parked = outbox.load("gateway-a").single()
      assertEquals(racing.id, parked.id)
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(1, outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.epoch)
    }

  @Test
  fun ambiguousRewindBlocksDeliveryUntilAuthoritativeHistoryReconcilesTheBranch() =
    runTest {
      val gateway = ScriptedGateway(json)
      val historyCalls = AtomicInteger()
      val retryHistoryStarted = CompletableDeferred<Unit>()
      val releaseRetryHistory = CompletableDeferred<Unit>()
      gateway.respond("sessions.rewind") { throw GatewayRequestOutcomeUnknown("response lost") }
      gateway.respond("chat.history") {
        when (historyCalls.incrementAndGet()) {
          1, 2 -> {
            throw IllegalStateException("history temporarily unavailable")
          }

          else -> {
            retryHistoryStarted.complete(Unit)
            releaseRetryHistory.await()
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("user", "authoritative rewind", 2, entryId = "leaf-rewound")),
            )
          }
        }
      }
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-rewound","headline":"Rewound","messageCount":1,"active":true}]}""",
      )
      gateway.respondChatSend("started")
      val controller = controller(gateway, StandardTestDispatcher(testScheduler))
      runCurrent()
      controller.awaitOutboxRestore()
      controller.handleGatewayEvent("health", null)
      runCurrent()
      assertTrue(controller.healthOk.value)

      assertNull(controller.rewindSessionAtEntryResult("main", "entry-a"))
      advanceUntilIdle()
      retryHistoryStarted.await()
      assertTrue(controller.sendMessageAwaitAcceptance("queued after rewind", "off", emptyList()))

      val state = outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))
      assertTrue(state?.needsReconciliation == true)
      assertNull(state?.switchPendingSinceMs)
      assertEquals(0, gateway.callCount("chat.send"))
      assertTrue(controller.messages.value.isEmpty())

      releaseRetryHistory.complete(Unit)
      awaitBranchProgress { gateway.callCount("chat.send") > 0 }

      assertFalse(outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation == true)
      assertEquals(1, gateway.callCount("chat.send"))
      assertEquals(
        "authoritative rewind",
        controller.messages.value
          .first()
          .content
          .single()
          .text,
      )
    }

  @Test
  fun transientBranchListFailureRetriesReconciliationAndDeliversQueuedInput() =
    runTest {
      val gateway = ScriptedGateway(json)
      val listCalls = AtomicInteger()
      val retryListStarted = CompletableDeferred<Unit>()
      val releaseRetryList = CompletableDeferred<Unit>()
      gateway.respond("sessions.rewind") { throw GatewayRequestOutcomeUnknown("response lost") }
      gateway.respond("chat.history") {
        if (gateway.callCount("chat.history") == 1) throw IllegalStateException("history temporarily unavailable")
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "authoritative rewind", 2, entryId = "leaf-rewound")),
        )
      }
      gateway.respond("sessions.branches.list") {
        if (listCalls.incrementAndGet() == 1) {
          throw IllegalStateException("branches temporarily unavailable")
        }
        retryListStarted.complete(Unit)
        releaseRetryList.await()
        """{"branches":[{"leafEntryId":"leaf-rewound","headline":"Rewound","messageCount":1,"active":true}]}"""
      }
      gateway.respondChatSend("started")
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.handleGatewayEvent("health", null)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.healthOk.first { it } }
      }

      assertNull(controller.rewindSessionAtEntryResult("main", "entry-a"))
      assertTrue(controller.sendMessageAwaitAcceptance("queued after rewind", "off", emptyList()))
      // A past failure cannot fence dispatch; keep its successful retry pending while checking.
      retryListStarted.await()
      assertEquals(0, gateway.callCount("chat.send"))
      releaseRetryList.complete(Unit)

      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (gateway.callCount("chat.send") == 0) kotlinx.coroutines.delay(10)
        }
      }

      assertTrue(listCalls.get() >= 2)
      assertFalse(outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation == true)
    }

  @Test
  fun inactiveOrphanHistoryRecordsEmptyRootBeforeRetiringItsHead() =
    runTest {
      val key = "agent:main:orphan"
      val otherKey = "agent:main:other"
      val branchScope = ChatOutboxScope(key, "main")
      val gateway = ScriptedGateway(json)
      val healthy = AtomicBoolean(true)
      val runningHead = AtomicReference<ChatOutboxItem?>(null)
      val completedHead = AtomicReference<ChatOutboxItem?>(null)
      val retirementEntered = CompletableDeferred<ChatOutboxBranchState?>()
      val releaseRetirement = CompletableDeferred<Unit>()
      val observedOutbox =
        object : ChatCommandOutbox by outbox {
          override suspend fun confirmDeliveredAttempts(ids: Map<String, Int>): Int {
            if (completedHead.get()?.id in ids) {
              retirementEntered.complete(outbox.branchState("gateway-a", branchScope))
              releaseRetirement.await()
            }
            return outbox.confirmDeliveredAttempts(ids)
          }
        }
      gateway.respond("health") {
        check(healthy.get()) { "health unavailable; transport remains connected" }
        "{}"
      }
      gateway.respond("chat.history") { paramsJson ->
        val sessionKey = requireNotNull(gateway.sessionKeyOf(paramsJson))
        val head = completedHead.get()?.takeIf { sessionKey == key }
        historyResponse(
          sessionId = sessionKey,
          messages =
            if (head == null) {
              emptyList()
            } else {
              listOf(
                ReplayHistoryMessage("user", head.text, 1, idempotencyKey = "${head.id}:user", entryId = "entry-input"),
                ReplayHistoryMessage("assistant", "completed", 2, entryId = "entry-reply"),
              )
            },
          inFlightRun = runningHead.get()?.takeIf { sessionKey == key && head == null }?.let { it.id to it.text },
        )
      }
      gateway.respond("sessions.branches.list") { paramsJson ->
        if (gateway.sessionKeyOf(paramsJson) == key && completedHead.get() != null) {
          """{"branches":[{"leafEntryId":"entry-reply","headline":"Current","messageCount":2,"active":true}]}"""
        } else {
          """{"branches":[]}"""
        }
      }
      gateway.respondChatSend("started")
      val controller = controller(gateway, commandOutbox = observedOutbox)
      runCurrent()
      controller.awaitOutboxRestore()
      controller.load(key)
      awaitBranchProgress { controller.healthOk.value && !controller.historyLoading.value && !controller.sessionBranchesLoading.value }
      assertNull(outbox.branchState("gateway-a", branchScope)?.lastActiveLeafEntryId)
      assertTrue(controller.sendMessageAwaitAcceptance("submitted head", "off", emptyList()))
      val head = outbox.load("gateway-a").single()
      runningHead.set(head)
      // Admission can return while the flush lane is still persisting its ACK.
      awaitBranchProgress { outbox.load("gateway-a").single().status == ChatOutboxStatus.Accepted }

      // Keep the target's reconciled scope while moving its live run offscreen.
      healthy.set(false)
      controller.switchSession(otherKey)
      awaitBranchProgress { !controller.healthOk.value && !controller.historyLoading.value && !controller.sessionBranchesLoading.value }
      val successor = enqueue("queued successor", sessionKey = key)
      assertEquals(ChatOutboxStatus.Accepted, outbox.load("gateway-a").single { it.id == head.id }.status)
      completedHead.set(head)
      controller.handleGatewayEvent("chat", chatTerminalPayload(key, head.id, seq = 1, assistantText = "completed"))
      healthy.set(true)
      controller.handleGatewayEvent("health", null)
      awaitBranchProgress { retirementEntered.isCompleted }

      try {
        assertEquals("Orphan history must record continuity before retiring its proving row", "entry-reply", retirementEntered.await()?.lastActiveLeafEntryId)
        val rows = outbox.load("gateway-a")
        assertEquals(ChatOutboxStatus.Accepted, rows.single { it.id == head.id }.status)
        assertEquals(ChatOutboxStatus.Queued, rows.single { it.id == successor.id }.status)
        assertEquals(1, gateway.callCount("chat.send"))
      } finally {
        releaseRetirement.complete(Unit)
      }

      awaitBranchProgress {
        outbox.load("gateway-a").singleOrNull()?.let { it.id == successor.id && it.status == ChatOutboxStatus.Accepted } == true
      }
      val sentIds =
        gateway.calls.filter { it.method == "chat.send" }.map {
          json
            .parseToJsonElement(requireNotNull(it.paramsJson))
            .jsonObject
            .getValue("idempotencyKey")
            .jsonPrimitive.content
        }
      assertEquals(listOf(head.id, successor.id), sentIds)
      assertEquals(otherKey, controller.sessionKey.value)
    }

  @Test
  fun gatewayWithoutBranchListingDispatchesQueuedInputWithoutRequestingBranches() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse(sessionId = "main", messages = emptyList()))
      gateway.respond("sessions.branches.list") {
        throw GatewayRequestRejected(
          GatewaySession.ErrorShape(
            code = "INVALID_REQUEST",
            message = "missing scope: operator.admin",
          ),
        )
      }
      gateway.respondChatSend("started")
      val controller =
        controller(
          gateway,
          StandardTestDispatcher(testScheduler),
          gatewayAdvertisesMethod = { method -> method != "sessions.branches.list" },
        )
      runCurrent()
      controller.awaitOutboxRestore()
      controller.handleGatewayEvent("health", null)
      runCurrent()
      assertTrue(controller.healthOk.value)

      assertTrue(controller.sendMessageAwaitAcceptance("dispatch without branches", "off", emptyList()))
      awaitBranchProgress {
        gateway.callCount("chat.send") > 0 || gateway.callCount("sessions.branches.list") > 0
      }

      assertEquals(0, gateway.callCount("sessions.branches.list"))
      assertEquals(1, gateway.callCount("chat.send"))
      assertFalse(outbox.load("gateway-a").single().status == ChatOutboxStatus.Queued)
    }

  @Test
  fun expiredMutationLeaseReconcilesBeforeStartingTheNextAction() =
    runTest {
      assertNotNull(outbox.beginSessionMutation("gateway-a", ChatOutboxScope("main", "main"), nowMs = 1))
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.rewind", """{"editorText":"recovered"}""")
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "current", 1, entryId = "leaf-current")),
        ),
      )
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-current","headline":"Current","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      controller.awaitOutboxRestore()

      val result = controller.rewindSessionAtEntryResult("main", "entry-a")

      assertEquals("recovered", result?.editorText)
      assertTrue(gateway.callCount("sessions.branches.list") >= 2)
      assertFalse(outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation == true)
    }

  @Test
  fun rewindCanFinalizeAnEmptyTranscriptRoot() =
    runTest {
      val branchScope = ChatOutboxScope("main", "main")
      val initial = requireNotNull(outbox.branchState("gateway-a", branchScope))
      assertTrue(outbox.recordTranscriptTip("gateway-a", branchScope, "leaf-old", initial))
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.rewind", """{"editorText":null}""")
      gateway.respondWith("chat.history", historyResponse(sessionId = "session-main", messages = emptyList()))
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      val controller = controller(gateway)
      controller.awaitOutboxRestore()

      assertNotNull(controller.rewindSessionAtEntryResult("main", "leaf-old"))

      val finalized = outbox.branchState("gateway-a", branchScope)
      assertEquals(1, finalized?.epoch)
      assertNull(finalized?.lastActiveLeafEntryId)
      assertFalse(finalized?.needsReconciliation == true)
    }

  @Test
  fun cancellingRewindDoesNotStrandTheDurableMutationLease() =
    runTest {
      val gateway = ScriptedGateway(json)
      val rewindStarted = CompletableDeferred<Unit>()
      gateway.respond("sessions.rewind") {
        rewindStarted.complete(Unit)
        CompletableDeferred<Unit>().await()
        "{}"
      }
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      val rewind = async { controller.rewindSessionAtEntryResult("main", "entry-a") }
      rewindStarted.await()

      rewind.cancel()
      rewind.join()
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation != true) {
            kotlinx.coroutines.delay(10)
          }
        }
      }

      val state = outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))
      assertTrue(state?.needsReconciliation == true)
      assertNull(state?.switchPendingSinceMs)
    }

  @Test
  fun rewindInvalidatesAHistoryResponseStartedBeforeTheMutation() =
    runTest {
      val gateway = ScriptedGateway(json)
      val historyCalls = AtomicInteger()
      val oldHistoryStarted = CompletableDeferred<Unit>()
      val releaseOldHistory = CompletableDeferred<Unit>()
      gateway.respond("chat.history") {
        if (historyCalls.incrementAndGet() == 1) {
          oldHistoryStarted.complete(Unit)
          releaseOldHistory.await()
          historyResponse(
            sessionId = "session-main",
            messages = listOf(ReplayHistoryMessage("user", "stale", 1, entryId = "leaf-stale")),
          )
        } else {
          historyResponse(
            sessionId = "session-main",
            messages = listOf(ReplayHistoryMessage("user", "rewound", 2, entryId = "leaf-new")),
          )
        }
      }
      gateway.respondWith("sessions.rewind", """{"editorText":"rewound draft"}""")
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-new","headline":"Rewound","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.load("main")
      oldHistoryStarted.await()

      val rewind = controller.rewindSessionAtEntryResult("main", "entry-a")
      assertNotNull(rewind)
      releaseOldHistory.complete(Unit)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          controller.messages.first { messages ->
            messages
              .singleOrNull()
              ?.content
              ?.singleOrNull()
              ?.text == "rewound"
          }
        }
      }

      assertEquals(
        "rewound",
        controller.messages.value
          .single()
          .content
          .single()
          .text,
      )
    }

  @Test
  fun branchRefreshPreservesTheLastGoodListOnFailure() =
    runTest {
      val gateway = ScriptedGateway(json)
      var fail = false
      gateway.respond("sessions.branches.list") {
        if (fail) throw IllegalStateException("offline")
        """{"branches":[
          {"leafEntryId":"leaf-a","headline":"Current","messageCount":2,"active":true},
          {"leafEntryId":"leaf-b","headline":"Earlier","messageCount":1,"active":false}
        ]}"""
      }
      val controller = controller(gateway)
      runCurrent()
      controller.awaitOutboxRestore()

      assertTrue(controller.refreshSessionBranches())
      val cached = controller.sessionBranches.value
      fail = true
      assertFalse(controller.refreshSessionBranches())
      assertEquals(cached, controller.sessionBranches.value)
    }

  @Test
  fun bootstrapReconcilesTheCapturedBranchStateBeforeAdvancingTheTip() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "hello", 1, entryId = "leaf-live")),
        ),
      )
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-live","headline":"Current","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      controller.awaitOutboxRestore()

      controller.load("main")
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.sessionBranches.first { it.isNotEmpty() } }
      }

      val state = outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))
      assertEquals("leaf-live", state?.lastActiveLeafEntryId)
      assertFalse(state?.needsReconciliation == true)
    }

  @Test
  fun inputAdmittedAfterExternalFinalHistorySendsOnceOnReconnect() = runTest { verifyInputAcrossHistoryReplacement(bootstrap = false, admitBeforeReplacement = false) }

  @Test
  fun dispatchGateWaitsForRefreshBranchEvidence() = runTest { verifyDeferredBranchDispatch(DispatchGateLane.Refresh) }

  @Test
  fun dispatchGateWaitsForRemoteBranchEvidence() = runTest { verifyDeferredBranchDispatch(DispatchGateLane.RemoteEvent) }

  @Test
  fun dispatchGateWaitsForReconnectBranchEvidence() = runTest { verifyDeferredBranchDispatch(DispatchGateLane.Reconnect) }

  @Test
  fun dispatchGateVisibleBacklogAppliesPostHistoryBranchEvidence() = runTest { verifyDeferredBranchDispatch(DispatchGateLane.VisibleBacklog) }

  @Test
  fun dispatchGateBackgroundBacklogAppliesPostHistoryBranchEvidence() = runTest { verifyDeferredBranchDispatch(DispatchGateLane.BackgroundBacklog) }

  @Test
  fun dispatchGateSamePathAdvanceSendsOnce() = runTest { verifyDeferredBranchDispatch(DispatchGateLane.VisibleBacklog, branchSwitch = false) }

  private enum class DispatchGateLane { Refresh, RemoteEvent, Reconnect, VisibleBacklog, BackgroundBacklog }

  private suspend fun TestScope.verifyDeferredBranchDispatch(
    lane: DispatchGateLane,
    branchSwitch: Boolean = true,
  ) {
    val key = if (lane == DispatchGateLane.BackgroundBacklog) "agent:main:background" else "main"
    val branchScope = ChatOutboxScope(key, "main")
    val gateway = ScriptedGateway(json)
    val releaseBranches = CompletableDeferred<Unit>()
    val heldListings = mutableSetOf<Job>()
    var holdBranches = false
    var activeLeaf = "A"
    gateway.respond("health") { error("health unavailable") }
    gateway.respond("chat.history") {
      val entries =
        when {
          activeLeaf == "B" -> listOf("B")
          holdBranches && !branchSwitch -> listOf("A", "A2")
          else -> listOf("A")
        }
      historyResponse("same-session", entries.map { ReplayHistoryMessage("assistant", it, 1, entryId = it) })
    }
    gateway.respond("sessions.branches.list") {
      if (holdBranches) {
        heldListings += requireNotNull(currentCoroutineContext()[Job])
        releaseBranches.await()
      }
      val inactive = if (activeLeaf == "B") """{"leafEntryId":"A","headline":"Earlier","messageCount":1,"active":false},""" else ""
      """{"branches":[$inactive{"leafEntryId":"$activeLeaf","headline":"Current","messageCount":1,"active":true}]}"""
    }
    gateway.respondChatSend("started")
    var controller = controller(gateway, StandardTestDispatcher(testScheduler))
    runCurrent()
    controller.awaitOutboxRestore()
    controller.load(key)
    awaitBranchProgress { !controller.historyLoading.value && controller.sessionBranches.value.isNotEmpty() }
    assertFalse(controller.healthOk.value)
    assertTrue(controller.sendMessageAwaitAcceptance("input for A", "off", listOf(OutgoingAttachment("image", "image/png", "proof.png", "AQIDBA=="))))
    val admitted = outbox.load("gateway-a").single()
    assertEquals(ChatOutboxStatus.Queued, admitted.status)
    assertEquals("A", outbox.branchState("gateway-a", branchScope)?.lastActiveLeafEntryId)

    if (lane == DispatchGateLane.VisibleBacklog || lane == DispatchGateLane.BackgroundBacklog) {
      controllerScopes.last().cancel()
      controller = controller(gateway, StandardTestDispatcher(testScheduler))
      runCurrent()
      controller.awaitOutboxRestore()
    }
    val ownerJob = requireNotNull(controllerScopes.last().coroutineContext[Job])
    holdBranches = true
    when (lane) {
      DispatchGateLane.Refresh -> {
        controller.refresh()
      }

      DispatchGateLane.RemoteEvent -> {
        controller.handleGatewayEvent("sessions.changed", """{"reason":"branch-switch","sessionKey":"$key","agentId":"main"}""")
      }

      DispatchGateLane.Reconnect -> {
        controller.onDisconnected("Reconnecting")
        controller.onGatewayConnected()
      }

      else -> {
        controller.handleGatewayEvent("health", null)
      }
    }
    awaitBranchProgress { heldListings.isNotEmpty() }
    // The gateway changes branches after the history snapshot, without a mutation event.
    activeLeaf = if (branchSwitch) "B" else "A2"
    controller.handleGatewayEvent("health", null)
    awaitBranchProgress {
      gateway.callCount("chat.send") > 0 || ownerJob.children.all { it in heldListings }
    }
    assertEquals("No dispatch before the held authoritative branch listing returns", 0, gateway.callCount("chat.send"))
    val held = outbox.load("gateway-a").single()
    assertEquals(admitted.id, held.id)
    assertEquals(admitted.attemptVersion, held.attemptVersion)
    assertTrue(held.status == ChatOutboxStatus.Queued || held.status == ChatOutboxStatus.Failed)
    releaseBranches.complete(Unit)
    awaitBranchProgress {
      gateway.callCount("chat.send") > 0 || ownerJob.children.none()
    }
    if (branchSwitch) {
      assertEquals("A input must never dispatch on the newly listed B branch", 0, gateway.callCount("chat.send"))
      val retained = outbox.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Failed, retained.status)
      assertEquals(admitted.id, retained.id)
      assertEquals(admitted.text, retained.text)
      assertEquals(admitted.branchEpoch, retained.branchEpoch)
      assertEquals(admitted.attemptVersion, retained.attemptVersion)
      assertEquals(admitted.attachments, retained.attachments)
      assertEquals(OUTBOX_BRANCH_CHANGED_ERROR, chatOutboxDisplayError(retained.lastError))
      assertTrue(byteArrayOf(1, 2, 3, 4).contentEquals(outbox.loadAttachments(retained.id).single().bytes))
      assertEquals("B", outbox.branchState("gateway-a", branchScope)?.lastActiveLeafEntryId)
    } else {
      assertEquals(1, gateway.callCount("chat.send"))
      assertEquals(admitted.id, gateway.lastRunId)
      assertEquals("A2", outbox.branchState("gateway-a", branchScope)?.lastActiveLeafEntryId)
    }
  }

  @Test
  fun orderedOverlappingHistoryPublishesNewestContinuation() = runTest { verifyOverlappingHistory(olderFirst = true, branchSwitch = false) }

  @Test
  fun orderedOverlappingHistoryPublishesNewestBranch() = runTest { verifyOverlappingHistory(olderFirst = true, branchSwitch = true) }

  @Test
  fun lateOlderHistoryCannotReplaceNewestContinuation() = runTest { verifyOverlappingHistory(olderFirst = false, branchSwitch = false) }

  @Test
  fun lateOlderHistoryCannotReplaceNewestBranch() = runTest { verifyOverlappingHistory(olderFirst = false, branchSwitch = true) }

  @Test
  fun independentBranchListingFencesOverlappingHistory() = runTest { verifyOverlappingHistory(olderFirst = true, branchSwitch = false, independentListing = true) }

  private suspend fun TestScope.verifyOverlappingHistory(
    olderFirst: Boolean,
    branchSwitch: Boolean,
    independentListing: Boolean = false,
  ) {
    val key = "agent:main:overlap"
    val branchScope = ChatOutboxScope(key, "main")
    val gateway = ScriptedGateway(json)
    val entered = List(3) { CompletableDeferred<Unit>() }
    val release = List(3) { CompletableDeferred<Unit>() }
    val requests = AtomicInteger()
    gateway.respond("health") { throw IllegalStateException("health unavailable") }
    gateway.respondWith("sessions.branches.list", """{"branches":[{"leafEntryId":"A1","headline":"Current","messageCount":1,"active":true}]}""")
    gateway.respond("chat.history") {
      val index = requests.getAndIncrement()
      check(index < 3) { "Unexpected history retry" }
      if (index > 0) {
        entered[index].complete(Unit)
        release[index].await()
      }
      val entries = if (index == 2 && branchSwitch) listOf("B") else (1..index + 1).map { "A$it" }
      historyResponse(
        sessionId = if (index == 2 && branchSwitch) "session-B" else "session-A",
        messages = entries.mapIndexed { i, entry -> ReplayHistoryMessage("assistant", entry, i.toLong(), entryId = entry) },
      )
    }
    val controller = controller(gateway, StandardTestDispatcher(testScheduler))
    runCurrent()
    controller.awaitOutboxRestore()
    controller.load(key)
    awaitBranchProgress { !controller.historyLoading.value && !controller.sessionBranchesLoading.value && controller.sessionBranches.value.isNotEmpty() }
    val initial = requireNotNull(outbox.branchState("gateway-a", branchScope))
    val ownerJob = requireNotNull(controllerScopes.last().coroutineContext[Job])

    fun requestHistory(runId: String): List<Job> {
      val before = ownerJob.children.toSet()
      controller.handleGatewayEvent("chat", chatTerminalPayload(key, runId, seq = 1))
      return ownerJob.children
        .filterNot { it in before }
        .toList()
        .also { assertTrue(it.isNotEmpty()) }
    }
    val older = requestHistory("external-older")
    awaitBranchProgress { entered[1].isCompleted }
    val newer = requestHistory("external-newer")
    awaitBranchProgress { entered[2].isCompleted }
    assertEquals(initial, outbox.branchState("gateway-a", branchScope))

    release[if (olderFirst) 1 else 2].complete(Unit)
    awaitBranchProgress { (if (olderFirst) older else newer).all { it.isCompleted } }
    assertEquals(
      if (olderFirst) {
        "A2"
      } else if (branchSwitch) {
        "B"
      } else {
        "A3"
      },
      controller.messages.value
        .last()
        .entryId,
    )
    assertTrue(controller.sendMessageAwaitAcceptance("between responses", "off", emptyList()))
    val admitted = outbox.load("gateway-a").single()
    if (independentListing) {
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[
          {"leafEntryId":"A2","headline":"Earlier","messageCount":2,"active":false},
          {"leafEntryId":"listed-B","headline":"Current","messageCount":1,"active":true}
        ]}""",
      )
      assertTrue(controller.refreshSessionBranches())
    }
    val beforeLastResponse = requireNotNull(outbox.branchState("gateway-a", branchScope))

    release[if (olderFirst) 2 else 1].complete(Unit)
    awaitBranchProgress { (older + newer).all { it.isCompleted } }
    val expectedEntries =
      if (independentListing) {
        listOf("A1", "A2")
      } else if (branchSwitch) {
        listOf("B")
      } else {
        listOf("A1", "A2", "A3")
      }
    assertEquals("Newest authoritative history must render without a follow-up refresh", expectedEntries, controller.messages.value.map { it.entryId })
    assertEquals(if (branchSwitch) "session-B" else "session-A", controller.sessionId.value)
    val finalState = requireNotNull(outbox.branchState("gateway-a", branchScope))
    assertEquals(if (independentListing) "listed-B" else expectedEntries.last(), finalState.lastActiveLeafEntryId)
    assertFalse(finalState.needsReconciliation)
    if (!olderFirst || independentListing) assertEquals(beforeLastResponse, finalState)
    val retained = outbox.load("gateway-a").single()
    assertEquals(admitted.id, retained.id)
    assertEquals(admitted.branchEpoch, retained.branchEpoch)
    assertEquals(admitted.attemptVersion, retained.attemptVersion)
    assertEquals(if (independentListing || (olderFirst && branchSwitch)) ChatOutboxStatus.Failed else ChatOutboxStatus.Queued, retained.status)
    assertEquals(3, gateway.callCount("chat.history"))
    assertEquals(0, gateway.callCount("chat.send"))
  }

  @Test
  fun inputAdmittedAfterBootstrapHistorySendsOnceOnReconnect() = runTest { verifyInputAcrossHistoryReplacement(bootstrap = true, admitBeforeReplacement = false) }

  @Test
  fun inputAdmittedBeforeExternalFinalHistorySurvivesForExplicitRetry() = runTest { verifyInputAcrossHistoryReplacement(bootstrap = false, admitBeforeReplacement = true) }

  @Test
  fun inputAdmittedWhileReplacementHistoryWaitsSurvivesForExplicitRetry() = runTest { verifyInputAcrossHistoryReplacement(gate = ReplacementGate.History) }

  @Test
  fun inputAdmittedWhileRemoteBranchHistoryWaitsSurvivesForExplicitRetry() = runTest { verifyInputAcrossHistoryReplacement(gate = ReplacementGate.History, remoteMutation = true) }

  @Test
  fun blankHistoryEntryIdDoesNotStrandBootstrap() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("main", listOf(ReplayHistoryMessage("assistant", "History", 1, entryId = " \t"))),
      )
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      val controller = controller(gateway, StandardTestDispatcher(testScheduler))
      val ownerJob = requireNotNull(controllerScopes.last().coroutineContext[Job])
      runCurrent()
      controller.awaitOutboxRestore()
      controller.load("main")
      awaitBranchProgress { ownerJob.children.none() }

      assertTrue(controller.healthOk.value)
      assertFalse(controller.historyLoading.value)
      assertNull(
        controller.messages.value
          .single()
          .entryId,
      )
      assertEquals(1, gateway.callCount("chat.history"))
    }

  @Test
  fun reconnectCompletesWhenEarlierBranchListingFencesHistory() =
    runTest {
      val key = "agent:main:branch-proof"
      val gateway = ScriptedGateway(json)
      val transcript = AtomicReference(listOf("A"))
      val holdBranches = AtomicBoolean(false)
      val holdReconnectHistory = AtomicBoolean(false)
      val branchesEntered = CompletableDeferred<Job>()
      val releaseBranches = CompletableDeferred<Unit>()
      val reconnectHistoryEntered = CompletableDeferred<Job>()
      val releaseReconnectHistory = CompletableDeferred<Unit>()
      gateway.respond("chat.history") {
        val entries = transcript.get()
        val response =
          historyResponse(
            sessionId = "session-${entries.first()}",
            messages =
              entries.mapIndexed { index, entry ->
                ReplayHistoryMessage("assistant", "history $entry", index.toLong() + 1, entryId = "entry-$entry")
              },
          )
        if (holdReconnectHistory.compareAndSet(true, false)) {
          reconnectHistoryEntered.complete(requireNotNull(currentCoroutineContext()[Job]))
          releaseReconnectHistory.await()
        }
        response
      }
      gateway.respond("sessions.branches.list") {
        val entries = transcript.get()
        val response = """{"branches":[{"leafEntryId":"entry-${entries.last()}","headline":"Current","messageCount":${entries.size},"active":true}]}"""
        if (holdBranches.compareAndSet(true, false)) {
          branchesEntered.complete(requireNotNull(currentCoroutineContext()[Job]))
          releaseBranches.await()
        }
        response
      }
      val controller = controller(gateway, StandardTestDispatcher(testScheduler))
      val ownerJob = requireNotNull(controllerScopes.last().coroutineContext[Job])
      runCurrent()
      controller.awaitOutboxRestore()
      controller.load(key)
      awaitBranchProgress { controller.healthOk.value && !controller.historyLoading.value && ownerJob.children.none() }
      assertEquals("session-A", controller.sessionId.value)

      transcript.set(listOf("B"))
      holdBranches.set(true)
      controller.handleGatewayEvent("sessions.changed", """{"reason":"branch-switch","sessionKey":"$key","agentId":"main"}""")
      awaitBranchProgress { branchesEntered.isCompleted }
      val branchesJob = branchesEntered.await()
      assertEquals("session-B", controller.sessionId.value)

      holdReconnectHistory.set(true)
      controller.onDisconnected("Reconnecting")
      controller.onGatewayConnected()
      awaitBranchProgress { reconnectHistoryEntered.isCompleted }
      val reconnectHistoryJob = reconnectHistoryEntered.await()
      assertFalse(controller.healthOk.value)
      assertTrue(controller.historyLoading.value)

      // The listing settles after reconnect captured its branch evidence, before history returns.
      releaseBranches.complete(Unit)
      awaitBranchProgress { branchesJob.isCompleted }
      // The held response stays at B; recovery must read again to observe this continuation.
      transcript.set(listOf("B", "B2"))
      releaseReconnectHistory.complete(Unit)
      awaitBranchProgress { reconnectHistoryJob.isCompleted && ownerJob.children.none() }

      assertEquals(
        "Branch listing completed=${branchesJob.isCompleted}; reconnect completed=${reconnectHistoryJob.isCompleted}; " +
          "remaining controller jobs=${ownerJob.children.count()}",
        Triple(true, false, "session-B"),
        Triple(controller.healthOk.value, controller.historyLoading.value, controller.sessionId.value),
      )
      assertEquals(listOf("history B", "history B2"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  fun inputAdmittedAfterHistoryWhileBranchesWaitSendsOnceOnReconnect() = runTest { verifyInputAcrossHistoryReplacement(bootstrap = true, gate = ReplacementGate.Branches) }

  @Test
  fun staleBranchResponseCannotDemoteNewerHistoryEvidence() = runTest { verifyInputAcrossHistoryReplacement(gate = ReplacementGate.StaleBranches) }

  @Test
  fun oldHistoryPostPublicationHealthWaitCannotDemoteNewerEvidence() = runTest { verifyInputAcrossHistoryReplacement(gate = ReplacementGate.ReconnectHealth) }

  @Test
  fun inputAdmittedAfterEmptyCanonicalHistorySendsOnceOnReconnect() = runTest { verifyInputAcrossHistoryReplacement(emptyReplacement = true) }

  private enum class ReplacementGate { None, History, Branches, StaleBranches, ReconnectHealth }

  private suspend fun awaitBranchProgress(condition: suspend () -> Boolean) {
    // runTest drives the scheduler; pumping it here would run controller callbacks concurrently.
    withContext(Dispatchers.Default.limitedParallelism(1)) {
      withTimeout(5_000) {
        while (true) {
          if (condition()) return@withTimeout
          kotlinx.coroutines.delay(10)
        }
      }
    }
  }

  private suspend fun TestScope.verifyInputAcrossHistoryReplacement(
    bootstrap: Boolean = false,
    admitBeforeReplacement: Boolean = false,
    gate: ReplacementGate = ReplacementGate.None,
    emptyReplacement: Boolean = false,
    remoteMutation: Boolean = false,
  ) {
    val key = "agent:main:branch-proof"
    val branchScope = ChatOutboxScope(key, "main")
    val gateway = ScriptedGateway(json)
    val replacement = AtomicBoolean(false)
    val healthy = AtomicBoolean(true)
    val sent = AtomicReference<JsonObject?>(null)
    val gateArmed = AtomicBoolean(false)
    val gateEntered = CompletableDeferred<Unit>()
    val releaseGate = CompletableDeferred<Unit>()

    suspend fun waitAtGate(expected: ReplacementGate) {
      if (gate == expected && gateArmed.compareAndSet(true, false)) {
        gateEntered.complete(Unit)
        releaseGate.await()
      }
    }
    gateway.respond("health") {
      waitAtGate(ReplacementGate.ReconnectHealth)
      check(healthy.get()) { "health unavailable; chat transport remains connected" }
      "{}"
    }
    gateway.respond("chat.history") {
      val generation = if (replacement.get()) "B" else "A"
      val delivered = sent.get()
      val messages = mutableListOf<ReplayHistoryMessage>()
      if (!emptyReplacement || !replacement.get()) {
        messages += ReplayHistoryMessage("assistant", "history $generation", 1, entryId = "entry-$generation")
      }
      if (delivered != null) {
        val id = delivered.getValue("idempotencyKey").jsonPrimitive.content
        messages += ReplayHistoryMessage("user", "retained input", 2, idempotencyKey = "$id:user", entryId = "entry-input")
        messages += ReplayHistoryMessage("assistant", "delivered", 3, entryId = "entry-reply")
      }
      val response = historyResponse(sessionId = "session-$generation", messages = messages)
      waitAtGate(ReplacementGate.History)
      response
    }
    gateway.respond("sessions.branches.list") {
      val leaf =
        if (sent.get() != null) {
          "entry-reply"
        } else if (replacement.get()) {
          "entry-B"
        } else {
          "entry-A"
        }
      val response =
        if (emptyReplacement && replacement.get() && sent.get() == null) {
          """{"branches":[]}"""
        } else {
          """{"branches":[{"leafEntryId":"$leaf","headline":"Current","messageCount":1,"active":true}]}"""
        }
      waitAtGate(ReplacementGate.StaleBranches)
      waitAtGate(ReplacementGate.Branches)
      response
    }
    gateway.respond("chat.send") { paramsJson ->
      val params = json.parseToJsonElement(requireNotNull(paramsJson)).jsonObject
      sent.set(params)
      val id = params.getValue("idempotencyKey").jsonPrimitive.content
      """{"runId":"$id","status":"started"}"""
    }
    val controller = controller(gateway, StandardTestDispatcher(testScheduler))
    runCurrent()
    controller.awaitOutboxRestore()
    controller.load(key)
    awaitBranchProgress {
      controller.healthOk.value &&
        controller.sessionBranches.value
          .singleOrNull()
          ?.leafEntryId == "entry-A"
    }
    assertEquals("entry-A", outbox.branchState("gateway-a", branchScope)?.lastActiveLeafEntryId)
    assertTrue(outbox.load("gateway-a").isEmpty())

    // Fail only health; history and branch RPCs still work on the same transport.
    healthy.set(false)
    controller.refresh()
    awaitBranchProgress { !controller.healthOk.value && !controller.historyLoading.value }
    assertEquals("session-A", controller.sessionId.value)
    assertFalse(outbox.branchState("gateway-a", branchScope)?.needsReconciliation == true)
    val attachment = OutgoingAttachment("image", "image/png", "proof.png", "AQIDBA==")

    suspend fun admit(): ChatOutboxItem {
      assertTrue(controller.sendMessageAwaitAcceptance("retained input", "off", listOf(attachment)))
      // Admission owns durability; a newer refresh may still own the visible snapshot.
      val admitted = outbox.load("gateway-a").single()
      awaitBranchProgress { controller.outboxItems.value.any { it.id == admitted.id } }
      return controller.outboxItems.value.single().also {
        assertEquals(ChatOutboxStatus.Queued, it.status)
        assertEquals("retained input", it.text)
        assertEquals("proof.png", it.attachments.single().fileName)
      }
    }
    var before = if (admitBeforeReplacement) admit() else null
    val staleBranches =
      if (gate == ReplacementGate.StaleBranches) {
        gateArmed.set(true)
        async { controller.refreshSessionBranches() }.also { awaitBranchProgress { gateEntered.isCompleted } }
      } else {
        null
      }
    if (gate == ReplacementGate.ReconnectHealth) {
      gateArmed.set(true)
      controller.onDisconnected("Reconnecting A")
      controller.onGatewayConnected()
      awaitBranchProgress { gateEntered.isCompleted }
      assertEquals("session-A", controller.sessionId.value)
    }
    replacement.set(true)
    if (gate == ReplacementGate.History || gate == ReplacementGate.Branches) gateArmed.set(true)
    if (bootstrap) {
      controller.refresh()
      awaitBranchProgress {
        if (gate == ReplacementGate.Branches) {
          controller.sessionId.value == "session-B" && gateEntered.isCompleted
        } else {
          controller.sessionBranches.value
            .singleOrNull()
            ?.leafEntryId == "entry-B" &&
            !controller.sessionBranchesLoading.value
        }
      }
    } else {
      if (remoteMutation) {
        controller.handleGatewayEvent("sessions.changed", """{"reason":"branch-switch","sessionKey":"$key","agentId":"main"}""")
      } else {
        controller.handleGatewayEvent("chat", chatTerminalPayload(key, "external-B", seq = 1, assistantText = "history B"))
      }
      if (gate == ReplacementGate.History) {
        awaitBranchProgress { gateEntered.isCompleted }
        assertEquals("session-A", controller.sessionId.value)
        before = admit()
        releaseGate.complete(Unit)
      }
      awaitBranchProgress { controller.sessionId.value == "session-B" }
    }
    assertEquals("session-B", controller.sessionId.value)
    val replacementText = if (emptyReplacement) emptyList() else listOf("history B")
    assertEquals(replacementText, controller.messages.value.map { it.content.single().text })
    assertFalse(controller.healthOk.value)
    val admitted = before ?: admit()
    val publishedState = requireNotNull(outbox.branchState("gateway-a", branchScope))
    if (before == null) {
      assertEquals(if (emptyReplacement) null else "entry-B", publishedState.lastActiveLeafEntryId)
      assertFalse(publishedState.needsReconciliation)
    }
    val sessionListsBeforeRelease = gateway.callCount("sessions.list")
    releaseGate.complete(Unit)
    staleBranches?.await()
    if (gate == ReplacementGate.Branches || gate == ReplacementGate.ReconnectHealth) {
      // Bootstrap lists sessions only after history's post-publication work has completed.
      awaitBranchProgress { gateway.callCount("sessions.list") > sessionListsBeforeRelease }
    }
    runCurrent()
    if (gate == ReplacementGate.StaleBranches || gate == ReplacementGate.ReconnectHealth) {
      assertEquals(publishedState, outbox.branchState("gateway-a", branchScope))
    }
    assertTrue(byteArrayOf(1, 2, 3, 4).contentEquals(outbox.loadAttachments(admitted.id).single().bytes))
    assertEquals(0, gateway.callCount("chat.send"))

    controller.onDisconnected("Reconnecting")
    healthy.set(true)
    controller.onGatewayConnected()
    // Matching history can retire a hidden intermediate row; wait for visible failure or completed retirement.
    awaitBranchProgress {
      val published = controller.outboxItems.value
      val visible =
        outboxItemsForSession(
          items = published,
          sessionKey = key,
          mainSessionKey = "main",
          ownerAgentId = branchScope.ownerAgentId,
          messages = controller.messages.value,
        )
      controller.healthOk.value &&
        !controller.historyLoading.value &&
        (
          (published.isEmpty() && outbox.load("gateway-a").isEmpty()) ||
            visible.singleOrNull()?.status == ChatOutboxStatus.Failed
        )
    }
    val retained = controller.outboxItems.value.singleOrNull()
    assertEquals("session-B", controller.sessionId.value)
    if (before != null) {
      assertEquals(0, gateway.callCount("chat.send"))
      assertEquals(admitted.id, retained?.id)
      assertEquals("retained input", retained?.text)
      assertEquals(admitted.attemptVersion, retained?.attemptVersion)
      assertEquals(admitted.branchEpoch, retained?.branchEpoch)
      assertEquals(admitted.attachments, retained?.attachments)
      assertEquals(OUTBOX_BRANCH_CHANGED_ERROR, chatOutboxDisplayError(retained?.lastError))
      assertEquals(replacementText, controller.messages.value.map { it.content.single().text })
      assertTrue(byteArrayOf(1, 2, 3, 4).contentEquals(outbox.loadAttachments(admitted.id).single().bytes))
      controller.retryOutboxCommand(admitted.id)
      awaitBranchProgress { controller.outboxItems.value.isEmpty() }
    } else {
      // B was authoritative before admission: reconnecting to B must not blame A's obsolete leaf.
      assertFalse("Input admitted after B was displayed must not be branch-failed: $retained", retained?.status == ChatOutboxStatus.Failed)
    }
    assertEquals("Exactly one dispatch of the admitted input", 1, gateway.callCount("chat.send"))
    val params = requireNotNull(sent.get())
    assertEquals(admitted.id, params.getValue("idempotencyKey").jsonPrimitive.content)
    assertEquals(key, params.getValue("sessionKey").jsonPrimitive.content)
    assertEquals("retained input", params.getValue("message").jsonPrimitive.content)
    val dispatchedAttachment =
      params
        .getValue("attachments")
        .jsonArray
        .single()
        .jsonObject
    assertEquals(attachment.fileName, dispatchedAttachment.getValue("fileName").jsonPrimitive.content)
    assertEquals(attachment.base64, dispatchedAttachment.getValue("content").jsonPrimitive.content)
    awaitBranchProgress {
      controller.messages.value
        .lastOrNull()
        ?.content
        ?.singleOrNull()
        ?.text == "delivered"
    }
    assertEquals(replacementText + listOf("retained input", "delivered"), controller.messages.value.map { it.content.single().text })
    assertTrue(controller.outboxItems.value.isEmpty())
    controller.onDisconnected("Reconnecting again")
    controller.onGatewayConnected()
    awaitBranchProgress { controller.healthOk.value && !controller.historyLoading.value && !controller.sessionBranchesLoading.value }
    assertEquals("A second reconnect must not redispatch the confirmed input", 1, gateway.callCount("chat.send"))
  }

  @Test
  fun reconnectAckPublishesAcceptedUntilHistoryConfirmsDelivery() =
    runTest {
      val key = "agent:main:ack-proof"
      val gateway = ScriptedGateway(json)
      val initialLoadFinished = CompletableDeferred<Unit>()
      val sendId = AtomicReference<String?>(null)
      val confirmationRequested = CompletableDeferred<Unit>()
      val releaseConfirmation = CompletableDeferred<Unit>()
      gateway.respond("sessions.list") {
        initialLoadFinished.complete(Unit)
        """{"sessions":[]}"""
      }
      gateway.respond("chat.history") {
        val id = sendId.get()
        if (id != null) {
          confirmationRequested.complete(Unit)
          releaseConfirmation.await()
        }
        historyResponse(
          sessionId = "ack-proof",
          messages =
            listOf(ReplayHistoryMessage("assistant", "before", 1, entryId = "entry-before")) +
              if (id == null) {
                emptyList()
              } else {
                listOf(ReplayHistoryMessage("user", "queued", 2, idempotencyKey = "$id:user", entryId = "entry-input"))
              },
        )
      }
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"entry-before","headline":"Current","messageCount":1,"active":true}]}""",
      )
      gateway.respond("chat.send") { paramsJson ->
        val id =
          json
            .parseToJsonElement(requireNotNull(paramsJson))
            .jsonObject
            .getValue("idempotencyKey")
            .jsonPrimitive
            .content
        sendId.set(id)
        """{"runId":"$id","status":"started"}"""
      }
      val controller = controller(gateway, StandardTestDispatcher(testScheduler))
      controller.awaitOutboxRestore()
      controller.load(key)
      initialLoadFinished.await()
      controller.onDisconnected("Queue offline")
      assertTrue(controller.sendMessageAwaitAcceptance("queued", "off", emptyList()))
      val admitted = outbox.load("gateway-a").single()
      assertEquals(ChatOutboxStatus.Queued, admitted.status)
      controller.onGatewayConnected()
      try {
        confirmationRequested.await()
        val acknowledged = outbox.load("gateway-a").single()
        assertEquals(admitted.id, acknowledged.id)
        assertEquals(admitted.attemptVersion, acknowledged.attemptVersion)
        assertEquals(ChatOutboxStatus.Accepted, acknowledged.status)
        assertEquals(1, gateway.callCount("chat.send"))
      } finally {
        releaseConfirmation.complete(Unit)
      }
      awaitBranchProgress { outbox.load("gateway-a").isEmpty() }
    }

  @Test
  fun staleBranchSwitchCompletionCannotOverrideNewerNavigation() =
    runTest {
      val gateway = ScriptedGateway(json)
      val switchStarted = CompletableDeferred<Unit>()
      val releaseSwitch = CompletableDeferred<Unit>()
      gateway.respond("sessions.branches.switch") {
        switchStarted.complete(Unit)
        releaseSwitch.await()
        "{}"
      }
      gateway.respondWith("chat.history", historyResponse("other", emptyList()))
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      val controller = controller(gateway)
      runCurrent()
      controller.awaitOutboxRestore()

      val switching = async { controller.switchSessionBranch("main", "leaf-b") }
      switchStarted.await()
      controller.switchSession("agent:main:other")
      releaseSwitch.complete(Unit)

      assertFalse(switching.await())
      assertEquals("agent:main:other", controller.sessionKey.value)
      assertFalse(controller.sessionBranchSwitching.value)
    }

  @Test
  fun secondBranchSwitchDoesNotInvalidateTheActiveSwitch() =
    runTest {
      val gateway = ScriptedGateway(json)
      val firstStarted = CompletableDeferred<Unit>()
      val releaseFirst = CompletableDeferred<Unit>()
      gateway.respond("sessions.branches.switch") {
        firstStarted.complete(Unit)
        releaseFirst.await()
        "{}"
      }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "branch", 1, entryId = "leaf-b")),
        ),
      )
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-b","headline":"Selected","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      controller.awaitOutboxRestore()

      val first = async { controller.switchSessionBranch("main", "leaf-b") }
      firstStarted.await()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
      )
      assertFalse(controller.switchSessionBranch("main", "leaf-c"))
      releaseFirst.complete(Unit)

      assertTrue(first.await())
      assertFalse(controller.sessionBranchSwitching.value)
      assertEquals(1, gateway.callCount("sessions.branches.switch"))
    }

  @Test
  fun localBranchEventAfterConfirmationDoesNotInvalidateTheActionRefresh() =
    runTest {
      val gateway = ScriptedGateway(json)
      val historyStarted = CompletableDeferred<Unit>()
      val releaseHistory = CompletableDeferred<Unit>()
      gateway.respondWith("sessions.branches.switch", "{}")
      gateway.respond("chat.history") {
        historyStarted.complete(Unit)
        releaseHistory.await()
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "selected", 1, entryId = "leaf-b")),
        )
      }
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-b","headline":"Selected","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      controller.awaitOutboxRestore()

      val switching = async { controller.switchSessionBranch("main", "leaf-b") }
      historyStarted.await()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
      )
      releaseHistory.complete(Unit)

      assertTrue(switching.await())
      assertFalse(controller.sessionBranchSwitching.value)
    }

  @Test
  fun matchingSecondClientBranchMutationDuringOurLeaseReconcilesToItsWinningLeaf() =
    runTest {
      val gateway = ScriptedGateway(json)
      val localHistoryStarted = CompletableDeferred<Unit>()
      val releaseLocalHistory = CompletableDeferred<Unit>()
      var historyRequests = 0
      var branchRequests = 0
      gateway.respondWith("sessions.branches.switch", "{}")
      gateway.respond("chat.history") {
        when (++historyRequests) {
          1 -> {
            localHistoryStarted.complete(Unit)
            releaseLocalHistory.await()
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("user", "local", 1, entryId = "leaf-local")),
            )
          }

          else -> {
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("user", "winner", 2, entryId = "leaf-winner")),
            )
          }
        }
      }
      gateway.respond("sessions.branches.list") {
        val leaf = if (++branchRequests == 1) "leaf-local" else "leaf-winner"
        """{"branches":[{"leafEntryId":"$leaf","headline":"Current","messageCount":1,"active":true}]}"""
      }
      val controller = controller(gateway)
      controller.awaitOutboxRestore()

      val switching = async { controller.switchSessionBranch("main", "leaf-local") }
      localHistoryStarted.await()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
      )
      releaseLocalHistory.complete(Unit)

      assertTrue(switching.await())
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.lastActiveLeafEntryId != "leaf-winner") {
            kotlinx.coroutines.delay(10)
          }
        }
      }
      assertFalse(outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation == true)
      assertTrue(gateway.callCount("chat.history") >= 2)
    }

  @Test
  fun remoteBranchEventIsNotDiscardedWhileForkUsesAnEntryGate() =
    runTest {
      val gateway = ScriptedGateway(json)
      val forkStarted = CompletableDeferred<Unit>()
      val releaseFork = CompletableDeferred<Unit>()
      gateway.respond("sessions.fork") {
        forkStarted.complete(Unit)
        releaseFork.await()
        """{"sessionKey":"agent:main:forked"}"""
      }
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      val fork = async { controller.forkSessionAtEntry("main", "entry-a") }
      forkStarted.await()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
      )
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation != true) {
            kotlinx.coroutines.delay(10)
          }
        }
      }
      releaseFork.complete(Unit)

      assertNotNull(fork.await())
      assertTrue(outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation == true)
    }

  @Test
  fun failedEventHistoryRefreshStillSchedulesReconciliationAndDelivery() =
    runTest {
      val branchScope = ChatOutboxScope("main", "main")
      val initial = requireNotNull(outbox.branchState("gateway-a", branchScope))
      assertTrue(outbox.recordTranscriptTip("gateway-a", branchScope, "leaf-current", initial))
      val gateway = ScriptedGateway(json)
      var historyRequests = 0
      val branchesEntered = CompletableDeferred<Unit>()
      val releaseBranches = CompletableDeferred<Unit>()
      gateway.respond("chat.history") {
        if (++historyRequests == 1) throw IllegalStateException("history temporarily unavailable")
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "current", 1, entryId = "leaf-current")),
        )
      }
      gateway.respond("sessions.branches.list") {
        branchesEntered.complete(Unit)
        releaseBranches.await()
        """{"branches":[{"leafEntryId":"leaf-current","headline":"Current","messageCount":1,"active":true}]}"""
      }
      gateway.respondChatSend("started")
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.handleGatewayEvent("health", null)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.healthOk.first { it } }
      }
      enqueue("deliver after recovery")

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
      )
      branchesEntered.await()
      releaseBranches.complete(Unit)

      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (gateway.callCount("chat.send") == 0) {
            kotlinx.coroutines.delay(10)
          }
        }
      }
      assertFalse(outbox.branchState("gateway-a", branchScope)?.needsReconciliation == true)
    }

  @Test
  fun backgroundMutationRefreshesTheSessionDrawerBeforeBranchHandlingReturns() =
    runTest {
      val gateway = ScriptedGateway(json)
      val changed = AtomicBoolean(false)
      gateway.respond("sessions.list") {
        val label = if (changed.get()) "After rewind" else "Before rewind"
        """{"sessions":[{"key":"agent:main:background","label":"$label"}]}"""
      }
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.refreshSessions()
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          controller.sessions.first { sessions -> sessions.singleOrNull()?.label == "Before rewind" }
        }
      }

      changed.set(true)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"rewind","sessionKey":"agent:main:background","agentId":"main"}""",
      )

      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          controller.sessions.first { sessions -> sessions.singleOrNull()?.label == "After rewind" }
        }
      }
    }

  @Test
  fun remoteBackgroundBranchChangeDemotesThatSessionsDurableScope() =
    runTest {
      val backgroundKey = "agent:main:background"
      val backgroundScope = ChatOutboxScope(backgroundKey, "main")
      val initial = requireNotNull(outbox.branchState("gateway-a", backgroundScope))
      assertTrue(outbox.recordTranscriptTip("gateway-a", backgroundScope, "leaf-old", initial))
      outbox.enqueue(
        gatewayId = "gateway-a",
        sessionKey = backgroundKey,
        text = "background message",
        thinkingLevel = "off",
        nowMs = System.currentTimeMillis(),
        ownerAgentId = "main",
      )
      val gateway = ScriptedGateway(json)
      val controller = controller(gateway, StandardTestDispatcher(testScheduler))
      runCurrent()
      controller.awaitOutboxRestore()

      val ownerJob = requireNotNull(controllerScopes.last().coroutineContext[Job])
      val previousJobs = ownerJob.children.toSet()
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"$backgroundKey","agentId":"main"}""",
      )
      // Completing this event's work, not draining the test dispatcher, joins Room's IO.
      val eventJobs = ownerJob.children.filterNot { it in previousJobs }.toList()
      eventJobs.forEach { it.join() }
      assertTrue(outbox.branchState("gateway-a", backgroundScope)?.needsReconciliation == true)
    }

  @Test
  fun directSendQueuesWithoutDispatchWhileRemoteBranchReconciliationIsPending() =
    runTest {
      val gateway = ScriptedGateway(json)
      val remoteChange = AtomicBoolean(false)
      val releaseBranches = CompletableDeferred<Unit>()
      gateway.respond("chat.history") {
        historyResponse(
          sessionId = "main",
          messages =
            listOf(
              ReplayHistoryMessage(
                "user",
                if (remoteChange.get()) "new" else "old",
                1,
                entryId = if (remoteChange.get()) "leaf-new" else "leaf-old",
              ),
            ),
        )
      }
      gateway.respond("sessions.branches.list") {
        if (remoteChange.get()) releaseBranches.await()
        val leaf = if (remoteChange.get()) "leaf-new" else "leaf-old"
        """{"branches":[{"leafEntryId":"$leaf","headline":"Current","messageCount":1,"active":true}]}"""
      }
      gateway.respondChatSend("started")
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.load("main")
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.sessionBranches.first { it.isNotEmpty() } }
      }
      controller.handleGatewayEvent("health", null)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.healthOk.first { it } }
      }

      remoteChange.set(true)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
      )
      assertTrue(controller.sendMessageAwaitAcceptance("queued during reconcile", "off", emptyList()))

      assertEquals(0, gateway.callCount("chat.send"))
      releaseBranches.complete(Unit)
    }

  @Test
  fun reconcileOwnerDrainsRequestsQueuedDuringAnActivePass() =
    runTest {
      val backgroundScope = ChatOutboxScope("background", "main")
      val backgroundState = requireNotNull(outbox.branchState("gateway-a", backgroundScope))
      assertTrue(
        outbox.recordTranscriptTip(
          "gateway-a",
          backgroundScope,
          "leaf-current",
          backgroundState,
        ),
      )
      val visibleScope = ChatOutboxScope("main", "main")
      val visibleState = requireNotNull(outbox.branchState("gateway-a", visibleScope))
      assertTrue(
        outbox.recordTranscriptTip(
          "gateway-a",
          visibleScope,
          "leaf-current",
          visibleState,
        ),
      )
      enqueue("first queued", sessionKey = "background")
      assertNotNull(outbox.demoteSessionMutationToReconciliationState("gateway-a", backgroundScope, lease = null))

      val gateway = ScriptedGateway(json)
      val branchesEntered = CompletableDeferred<Unit>()
      val releaseBranches = CompletableDeferred<Unit>()
      val requestsDrained = CompletableDeferred<Unit>()
      val sendCalls = AtomicInteger()
      gateway.respond("chat.history") { paramsJson ->
        historyResponse(
          sessionId = gateway.sessionKeyOf(paramsJson) ?: "main",
          messages = listOf(ReplayHistoryMessage("user", "current", 1, entryId = "leaf-current")),
        )
      }
      gateway.respond("sessions.branches.list") {
        if (!branchesEntered.isCompleted) {
          branchesEntered.complete(Unit)
          releaseBranches.await()
        }
        """{"branches":[{"leafEntryId":"leaf-current","headline":"Current","messageCount":1,"active":true}]}"""
      }
      gateway.respond("chat.send") { paramsJson ->
        val runId =
          requireNotNull(paramsJson)
            .let(json::parseToJsonElement)
            .jsonObject
            .getValue("idempotencyKey")
            .jsonPrimitive
            .content
        if (sendCalls.incrementAndGet() == 2) requestsDrained.complete(Unit)
        """{"runId":"$runId","status":"started"}"""
      }
      val controller = controller(gateway, StandardTestDispatcher(testScheduler))
      runCurrent()
      controller.awaitOutboxRestore()
      controller.handleGatewayEvent("health", null)
      runCurrent()
      assertTrue(controller.healthOk.value)
      branchesEntered.await()

      assertTrue(controller.sendMessageAwaitAcceptance("second queued", "off", emptyList()))
      assertEquals(2, outbox.load("gateway-a").size)
      releaseBranches.complete(Unit)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { requestsDrained.await() }
      }

      assertEquals(2, gateway.callCount("chat.send"))
    }
}
