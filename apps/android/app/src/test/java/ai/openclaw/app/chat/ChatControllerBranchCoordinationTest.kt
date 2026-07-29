package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import androidx.room.Room
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
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
  ): ChatController {
    val controllerScope = CoroutineScope(SupervisorJob() + dispatcher)
    controllerScopes += controllerScope
    return ChatController(
      scope = controllerScope,
      json = json,
      requestGateway = gateway::request,
      cacheScope = { ChatCacheScope("gateway-a", 1) },
      commandOutbox = outbox,
    )
  }

  private suspend fun enqueue(text: String = "queued"): ChatOutboxItem =
    (
      outbox.enqueue(
        gatewayId = "gateway-a",
        sessionKey = "main",
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
          1, 2 -> throw IllegalStateException("history temporarily unavailable")
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
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (gateway.callCount("chat.send") == 0) {
            runCurrent()
            kotlinx.coroutines.delay(10)
          }
        }
      }

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
      val firstListFailure = CompletableDeferred<Unit>()
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
          firstListFailure.complete(Unit)
          throw IllegalStateException("branches temporarily unavailable")
        }
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
      firstListFailure.await()
      assertEquals(0, gateway.callCount("chat.send"))

      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (gateway.callCount("chat.send") == 0) kotlinx.coroutines.delay(10)
        }
      }

      assertTrue(listCalls.get() >= 2)
      assertFalse(outbox.branchState("gateway-a", ChatOutboxScope("main", "main"))?.needsReconciliation == true)
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
      assertTrue(outbox.updateLastActiveLeafEntryId("gateway-a", branchScope, "leaf-old", initial.epoch, initial.revision))
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
          else ->
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("user", "winner", 2, entryId = "leaf-winner")),
            )
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
      assertTrue(outbox.updateLastActiveLeafEntryId("gateway-a", branchScope, "leaf-current", initial.epoch, initial.revision))
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
      assertTrue(outbox.updateLastActiveLeafEntryId("gateway-a", backgroundScope, "leaf-old", initial.epoch, initial.revision))
      outbox.enqueue(
        gatewayId = "gateway-a",
        sessionKey = backgroundKey,
        text = "background message",
        thinkingLevel = "off",
        nowMs = System.currentTimeMillis(),
        ownerAgentId = "main",
      )
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "background",
          messages = listOf(ReplayHistoryMessage("user", "old", 1, entryId = "leaf-old")),
        ),
      )
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-old","headline":"Old","messageCount":1,"active":true}]}""",
      )
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.load(backgroundKey)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.sessionBranches.first { it.isNotEmpty() } }
      }
      controller.switchSession("main")
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "background",
          messages = listOf(ReplayHistoryMessage("user", "new", 2, entryId = "leaf-new")),
        ),
      )
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[
          {"leafEntryId":"leaf-old","headline":"Old","messageCount":1,"active":false},
          {"leafEntryId":"leaf-new","headline":"New","messageCount":1,"active":true}
        ]}""",
      )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"branch-switch","sessionKey":"$backgroundKey","agentId":"main"}""",
      )
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (outbox.load("gateway-a").single().status != ChatOutboxStatus.Failed) {
            kotlinx.coroutines.delay(10)
          }
        }
      }

      assertEquals(ChatOutboxStatus.Failed, outbox.load("gateway-a").single().status)
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
      val branchScope = ChatOutboxScope("main", "main")
      val initial = requireNotNull(outbox.branchState("gateway-a", branchScope))
      assertTrue(outbox.updateLastActiveLeafEntryId("gateway-a", branchScope, "leaf-current", initial.epoch, initial.revision))
      enqueue("first queued")
      assertTrue(outbox.demoteSessionMutationToReconciliation("gateway-a", branchScope, lease = null))

      val gateway = ScriptedGateway(json)
      val branchesEntered = CompletableDeferred<Unit>()
      val releaseBranches = CompletableDeferred<Unit>()
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "main",
          messages = listOf(ReplayHistoryMessage("user", "current", 1, entryId = "leaf-current")),
        ),
      )
      gateway.respond("sessions.branches.list") {
        branchesEntered.complete(Unit)
        releaseBranches.await()
        """{"branches":[{"leafEntryId":"leaf-current","headline":"Current","messageCount":1,"active":true}]}"""
      }
      gateway.respondChatSend("started")
      gateway.respond("chat.history") {
        val idempotencyKey = gateway.lastRunId?.let { "$it:user" }
        historyResponse(
          sessionId = "main",
          messages =
            listOf(
              ReplayHistoryMessage(
                "user",
                "current",
                1,
                idempotencyKey = idempotencyKey,
                entryId = "leaf-current",
              ),
            ),
        )
      }
      val controller = controller(gateway)
      controller.awaitOutboxRestore()
      controller.handleGatewayEvent("health", null)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) { controller.healthOk.first { it } }
      }
      branchesEntered.await()

      assertTrue(controller.sendMessageAwaitAcceptance("second queued", "off", emptyList()))
      releaseBranches.complete(Unit)
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        withTimeout(5_000) {
          while (outbox.branchState("gateway-a", branchScope)?.needsReconciliation != false) {
            kotlinx.coroutines.delay(10)
          }
        }
      }

      assertEquals(2, outbox.load("gateway-a").size)
      assertTrue(outbox.load("gateway-a").none { it.status == ChatOutboxStatus.Failed })
    }
}
