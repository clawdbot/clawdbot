package ai.openclaw.app.chat

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayHelloSummary
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.testDeviceIdentityStore
import ai.openclaw.app.ui.chat.FULL_MESSAGE_FIRST_CHAT
import ai.openclaw.app.ui.chat.FULL_MESSAGE_READY_TIMEOUT_MS
import ai.openclaw.app.ui.chat.FULL_MESSAGE_SECOND_CHAT
import ai.openclaw.app.ui.chat.FullMessageGateway
import ai.openclaw.app.ui.chat.FullMessageRead
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
class ChatFullMessageCancellationTest {
  @Test
  fun cancellationDuringOwnerValidationEnqueuesNoFullMessageRequest() =
    runBlocking {
      withReader { fixture ->
        val canceledRead = fixture.prepare()
        val caller = async(start = CoroutineStart.LAZY) { canceledRead.execute() }
        fixture.cancelDuringValidation.set(caller)
        caller.start()
        try {
          val cancellation = runCatching { withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { caller.await() } }.exceptionOrNull()
          assertTrue(cancellation is CancellationException && cancellation !is TimeoutCancellationException)
          assertEquals(ChatFullMessageState.Loading, canceledRead.state.value)

          val current = fixture.prepare()
          current.execute()
          assertTrue(current.state.value is ChatFullMessageState.Loaded)
          assertEquals(
            "Cancellation during owner validation must enqueue zero old reads; only the fresh same-socket read is allowed",
            1,
            fixture.gateway.fullReads.size,
          )
          assertEquals(
            fixture.gateway.operatorConnection.get(),
            fixture.gateway.fullReads
              .single()
              .connection,
          )
        } finally {
          caller.cancelAndJoin()
        }
      }
    }

  @Test
  fun aConnectionReplacedAfterLogicalValidationReceivesNoRetiredRequest() =
    runBlocking {
      withReader { fixture ->
        val old = fixture.prepare()
        val oldConnection = fixture.gateway.operatorConnection.get()
        val gate = RequestGate()
        fixture.dispatchGate.set(gate)
        val pending = async(Dispatchers.IO) { old.execute() }
        try {
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gate.entered.await() }
          fixture.session.reconnect()
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
            fixture.hello.first { it?.serverName == "full-message-${fixture.gateway.operatorConnection.get()}" && fixture.gateway.operatorConnection.get() > oldConnection }
          }
          gate.release.complete(Unit)
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { pending.await() }
          fixture.awaitReady()
          val current = fixture.prepare()
          current.execute()
          assertTrue(current.state.value is ChatFullMessageState.Loaded)
          assertEquals(ChatFullMessageState.Loading, old.state.value)
          assertEquals("Only the fresh lease may reach the replacement connection", 1, fixture.gateway.fullReads.size)
          assertEquals(
            fixture.gateway.operatorConnection.get(),
            fixture.gateway.fullReads
              .single()
              .connection,
          )
        } finally {
          gate.release.complete(Unit)
          pending.cancelAndJoin()
        }
      }
    }

  @Test
  fun aSelectionReplacedAfterLogicalValidationEnqueuesNoRetiredRequest() =
    runBlocking {
      withReader { fixture ->
        val old = fixture.prepare()
        val connection = fixture.gateway.operatorConnection.get()
        val gate = RequestGate()
        fixture.dispatchGate.set(gate)
        val pending = async(Dispatchers.IO) { old.execute() }
        try {
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gate.entered.await() }
          fixture.controller.switchSession(FULL_MESSAGE_SECOND_CHAT, ownerAgentId = "main")
          fixture.awaitReady(FULL_MESSAGE_SECOND_CHAT)
          gate.release.complete(Unit)
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { pending.await() }
          fixture.assertOnlyCurrentRead(connection)
          assertEquals(ChatFullMessageState.Loading, old.state.value)
        } finally {
          gate.release.complete(Unit)
          pending.cancelAndJoin()
        }
      }
    }

  @Test
  fun aSelectionReplacedWhileWaitingForTransportWriteEnqueuesNoRetiredRequest() =
    runBlocking {
      withReader { fixture ->
        val old = fixture.prepare()
        val connection = fixture.gateway.operatorConnection.get()
        val generation = fixture.controller.selectionGeneration.value
        val writeLock =
          GatewaySession::class.java
            .getDeclaredField("writeLock")
            .apply { isAccessible = true }
            .get(fixture.session) as Mutex
        val lockOwner = Any()
        writeLock.lock(lockOwner)
        // No fixture gate: execute runs through the real lease and pending registration,
        // then suspends at the held transport mutex before OkHttp can enqueue the frame.
        val pending = async(start = CoroutineStart.UNDISPATCHED) { old.execute() }
        try {
          assertTrue("The admitted read must be waiting for the transport write", pending.isActive)
          fixture.controller.switchSession(FULL_MESSAGE_SECOND_CHAT, ownerAgentId = "main")
          assertEquals(FULL_MESSAGE_SECOND_CHAT, fixture.controller.sessionKey.value)
          assertTrue(fixture.controller.selectionGeneration.value > generation)
          writeLock.unlock(lockOwner)
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { pending.await() }
          fixture.awaitReady(FULL_MESSAGE_SECOND_CHAT)
          fixture.assertOnlyCurrentRead(connection)
          assertEquals(ChatFullMessageState.Loading, old.state.value)
        } finally {
          if (writeLock.holdsLock(lockOwner)) writeLock.unlock(lockOwner)
          pending.cancelAndJoin()
        }
      }
    }

  @Test
  fun anOlderSelectionCannotOverwriteReadinessFromANewerRefresh() =
    runBlocking {
      withReader { fixture ->
        val connection = fixture.gateway.operatorConnection.get()
        val gate = SelectionSetupGate()
        val selection =
          async(Dispatchers.IO) {
            gate.ownerThread.set(Thread.currentThread())
            fixture.selectionSetupGate.set(gate)
            // Hydration shares the reset without holding the explicit-choice monitor.
            fixture.controller.load(FULL_MESSAGE_SECOND_CHAT, ownerAgentId = "main")
          }
        try {
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gate.entered.await() }
          assertEquals(FULL_MESSAGE_SECOND_CHAT, fixture.controller.sessionKey.value)
          val beforeHistory = fixture.gateway.historyReads.value.size
          fixture.controller.refresh()
          fixture.awaitReady(FULL_MESSAGE_SECOND_CHAT)
          assertTrue(
            "The newer refresh must complete a real history read on the same socket",
            fixture.gateway.historyReads.value
              .drop(beforeHistory)
              .contains(connection to FULL_MESSAGE_SECOND_CHAT),
          )
          assertEquals(connection, fixture.gateway.operatorConnection.get())

          gate.release.countDown()
          withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { selection.await() }
          assertFalse(
            "Older selection setup must not restore loading after a newer refresh completed",
            fixture.controller.historyLoading.value,
          )
          assertTrue(
            "Older selection setup must not clear health after a newer refresh completed",
            fixture.controller.healthOk.value,
          )
          assertEquals(FULL_MESSAGE_SECOND_CHAT, fixture.controller.sessionKey.value)
          assertEquals(
            fixture.gateway.preview(FULL_MESSAGE_SECOND_CHAT),
            fixture.controller.messages.value
              .single()
              .content
              .single()
              .text,
          )
          assertEquals(connection, fixture.gateway.operatorConnection.get())
        } finally {
          fixture.selectionSetupGate.compareAndSet(gate, null)
          gate.release.countDown()
          selection.cancelAndJoin()
        }
      }
    }

  private suspend fun withReader(block: suspend CoroutineScope.(ReaderFixture) -> Unit) =
    coroutineScope {
      val app = RuntimeEnvironment.getApplication()
      val gateway = FullMessageGateway()
      val ownerJob = SupervisorJob()
      val scope = CoroutineScope(ownerJob + Dispatchers.IO)
      val hello = MutableStateFlow<GatewayHelloSummary?>(null)
      val catalogRevision = AtomicLong()
      val cancelDuringValidation = AtomicReference<Job?>()
      val dispatchGate = AtomicReference<RequestGate?>()
      val selectionSetupGate = AtomicReference<SelectionSetupGate?>()
      val controllerRef = AtomicReference<ChatController?>()
      var session: GatewaySession? = null
      try {
        val prefs = SecurePrefs(app, app.getSharedPreferences("full-message-cancel-${UUID.randomUUID()}", Context.MODE_PRIVATE))
        val liveSession =
          GatewaySession(
            scope = scope,
            identityStore = testDeviceIdentityStore(app),
            deviceAuthStore = DeviceAuthStore(prefs),
            onConnected = { summary ->
              catalogRevision.incrementAndGet()
              hello.value = summary
              controllerRef.get()?.onGatewayConnected()
            },
            onDisconnected = { message ->
              catalogRevision.incrementAndGet()
              hello.value = null
              controllerRef.get()?.onDisconnected(message)
            },
            onEvent = { _, _ -> },
          )
        session = liveSession
        liveSession.connect(
          endpoint = gateway.endpoint,
          token = "synthetic-full-message-proof",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "operator",
              scopes = listOf("operator.read", "operator.write"),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client = GatewayClientInfo(id = "openclaw-android", displayName = "Full message test", version = "test", platform = "android", mode = "ui", instanceId = "full-message-test", deviceFamily = null, modelIdentifier = null),
            ),
        )
        withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { hello.first { it != null } }
        val controller =
          ChatController(
            scope = scope,
            json = Json { ignoreUnknownKeys = true },
            requestGateway = { method, params -> liveSession.request(method, params) },
            requestGatewayForGateway = { gatewayId, method, params -> liveSession.requestForEndpoint(gatewayId, method, params) },
            captureRequestLease = { gatewayScope ->
              liveSession.captureRequestLease(gatewayScope?.gatewayId)?.let { actualLease ->
                GatewaySession.RequestLease(
                  endpointStableId = actualLease.endpointStableId,
                  isCurrentImpl = actualLease::isCurrent,
                  commitIfCurrentImpl = actualLease::commitIfCurrent,
                ) { method, params, timeout, withEnqueue ->
                  // The request boundary is outside the controller's logical monitor. A real
                  // replacement hello can complete here; all lease authority stays delegated.
                  dispatchGate.getAndSet(null)?.let { gate ->
                    gate.entered.complete(Unit)
                    withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) { gate.release.await() }
                  }
                  actualLease.request(method, params, timeout, withEnqueue)
                }
              }
            },
            cacheScope = { ChatCacheScope(gateway.endpoint.stableId, catalogRevision.get()) },
            gatewayAdvertisesMethod = { method ->
              val gate = selectionSetupGate.get()
              if (
                method == "progressCard.get" &&
                gate != null &&
                gate.ownerThread.get() === Thread.currentThread() &&
                selectionSetupGate.compareAndSet(gate, null)
              ) {
                // Pause only this selection's synchronous catalog read, outside owner locks;
                // a newer refresh must remain free to complete through the real socket.
                gate.entered.complete(Unit)
                check(gate.release.await(FULL_MESSAGE_READY_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                  "Selection setup gate was not released"
                }
              }
              hello.value?.methods?.contains(method)
            },
            currentGatewayCatalogRevision = {
              // Model cancellation while the owner check holds its monitor, after execute's
              // initial cancellation check. The catalog value itself remains the real hello fact.
              cancelDuringValidation.getAndSet(null)?.cancel()
              catalogRevision.get()
            },
          )
        controllerRef.set(controller)
        controller.switchSession(FULL_MESSAGE_FIRST_CHAT, ownerAgentId = "main")
        val fixture = ReaderFixture(gateway, liveSession, controller, hello, catalogRevision, cancelDuringValidation, dispatchGate, selectionSetupGate)
        fixture.awaitReady()
        block(fixture)
      } finally {
        try {
          session?.disconnectAndJoin()
        } finally {
          try {
            ownerJob.cancelAndJoin()
          } finally {
            gateway.close()
          }
        }
      }
    }

  private class RequestGate {
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
  }

  private class SelectionSetupGate {
    val ownerThread = AtomicReference<Thread?>()
    val entered = CompletableDeferred<Unit>()
    val release = CountDownLatch(1)
  }

  private data class ReaderFixture(
    val gateway: FullMessageGateway,
    val session: GatewaySession,
    val controller: ChatController,
    val hello: MutableStateFlow<GatewayHelloSummary?>,
    val catalogRevision: AtomicLong,
    val cancelDuringValidation: AtomicReference<Job?>,
    val dispatchGate: AtomicReference<RequestGate?>,
    val selectionSetupGate: AtomicReference<SelectionSetupGate?>,
  ) {
    fun prepare(sessionKey: String = FULL_MESSAGE_FIRST_CHAT) =
      checkNotNull(
        controller.prepareFullMessageRead(
          ChatComposerOwner(gateway.endpoint.stableId, "main", sessionKey),
          controller.selectionGeneration.value,
          catalogRevision.get(),
          controller.messages.value.single(),
        ),
      )

    suspend fun assertOnlyCurrentRead(connection: Int) {
      val currentMessage = controller.messages.value.single()
      val current = prepare(FULL_MESSAGE_SECOND_CHAT)
      current.execute()
      assertTrue(current.state.value is ChatFullMessageState.Loaded)
      assertEquals("Selection retirement must not replace the physical connection", connection, gateway.operatorConnection.get())
      assertEquals(
        "Only the fresh current-selection read may reach the same socket; dropping an old result is insufficient",
        listOf(FullMessageRead(connection, FULL_MESSAGE_SECOND_CHAT, "main", checkNotNull(currentMessage.entryId))),
        gateway.fullReads.toList(),
      )
    }

    suspend fun awaitReady(sessionKey: String = FULL_MESSAGE_FIRST_CHAT) {
      withTimeout(FULL_MESSAGE_READY_TIMEOUT_MS) {
        combine(controller.messages, controller.historyLoading, controller.healthOk) { messages, loading, healthy ->
          !loading &&
            healthy &&
            messages
              .singleOrNull()
              ?.content
              ?.singleOrNull()
              ?.text == gateway.preview(sessionKey)
        }.first { it }
      }
    }
  }
}
