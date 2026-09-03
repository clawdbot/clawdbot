package ai.openclaw.app

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.ui.GatewayConnectConfig
import ai.openclaw.app.ui.GatewayConnectPlan
import ai.openclaw.app.ui.GatewaySavedAuthAction
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowApplication
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.Continuation
import kotlin.coroutines.CoroutineContext

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeForegroundServiceTest {
  @After
  fun resetNodeServiceStartSuppression() {
    NodeForegroundService.resume(RuntimeEnvironment.getApplication(), startNow = false)
  }

  @Test
  fun stableNotificationStateReemitsWhenLocaleChanges() =
    runBlocking {
      val localeChanges = MutableStateFlow(0L)
      val firstEmission = CompletableDeferred<Unit>()
      val emissions = mutableListOf<LocaleAwareNotificationState<String>>()
      val collection =
        launch(start = CoroutineStart.UNDISPATCHED) {
          refreshNotificationOnLocaleChanges(
            states = flowOf("stable"),
            localeChanges = localeChanges,
          ).take(2)
            .collect { update ->
              emissions += update
              if (emissions.size == 1) firstEmission.complete(Unit)
            }
        }

      firstEmission.await()
      localeChanges.value = 1L
      collection.join()

      assertEquals(
        listOf(
          LocaleAwareNotificationState(state = "stable", localeRevision = 0L),
          LocaleAwareNotificationState(state = "stable", localeRevision = 1L),
        ),
        emissions,
      )
    }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun coldStickyStartRestoresSavedGatewayWithoutForegroundCapabilities() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val gateway = lifetimeGateway(hello = ::bootstrapHello)
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    app.prefs.setManualTls(false)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    app.prefs.gatewayRegistry.setActive(endpoint.stableId)
    app.prefs.saveGatewayCredentials(endpoint.stableId, null, "synthetic-bootstrap-token", null)

    try {
      assertNull(app.peekRuntime())
      assertEquals(Service.START_STICKY, controller.get().onStartCommand(null, 0, 1))
      drainWithMainLooper {
        withTimeout(10_000) {
          while (app.peekRuntime() == null) yield()
          requireNotNull(app.peekRuntime()).gatewayConnectionDisplay.first { it.isConnected && requireNotNull(app.peekRuntime()).nodeConnected.value }
        }
      }
      assertFalse(requireNotNull(app.peekRuntime()).isForeground.value)
    } finally {
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stopDuringRuntimeConstructionRetiresBackgroundStartup() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val fixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val gate = RuntimeReturnGate()
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val gateway = lifetimeGateway()
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    app.prefs.setManualTls(false)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    app.prefs.gatewayRegistry.setActive(endpoint.stableId)
    app.prefs.saveGatewayCredentials(endpoint.stableId, "synthetic-lifetime-token", null, null)
    fixture.prefsReadGate = gate

    try {
      assertEquals(Service.START_STICKY, controller.get().onStartCommand(null, 0, 1))
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      assertTrue("Service did not enter runtime construction", gate.entered.await(10, TimeUnit.SECONDS))
      NodeForegroundService.stop(app)
      controller.destroy()
      gate.release.countDown()
      drainWithMainLooper {
        withTimeout(10_000) {
          ReflectionHelpers
            .getField<CoroutineScope>(controller.get(), "scope")
            .coroutineContext.job
            .join()
        }
      }

      val runtime = requireNotNull(app.peekRuntime())
      assertFalse(runtime.nodeConnected.value)
      assertFalse(runtime.isForeground.value)
      assertEquals("Offline", runtime.gatewayConnectionDisplay.value.statusText)
      while (gateway.takeRequest(0, TimeUnit.MILLISECONDS) != null) {
        // Construction may have started a socket before Stop retired it.
      }
      runtime.setForeground(true)
      assertNull("Foreground re-entry must not reconnect a stopped runtime", gateway.takeRequest(10, TimeUnit.SECONDS))
    } finally {
      gate.release.countDown()
      fixture.prefsReadGate = null
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  fun coldStopDoesNotCreateRuntime() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    assertNull(app.peekRuntime())
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()

    try {
      val result =
        controller
          .get()
          .onStartCommand(
            Intent(app, NodeForegroundService::class.java)
              .setAction("ai.openclaw.app.action.STOP"),
            0,
            1,
          )

      assertEquals(Service.START_NOT_STICKY, result)
      assertNull(app.peekRuntime())

      val secondResult = controller.get().onStartCommand(Intent(app, NodeForegroundService::class.java), 0, 2)
      assertEquals(Service.START_NOT_STICKY, secondResult)
      assertEquals(2, Shadows.shadowOf(controller.get()).stopSelfResultId)
      assertNull(app.peekRuntime())
    } finally {
      closeNodeServiceTestFixture(controller, app)
    }
  }

  @Test
  fun explicitResumeAfterStopRestoresStickyServiceOwnership() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()

    try {
      val stopped =
        controller
          .get()
          .onStartCommand(
            Intent(app, NodeForegroundService::class.java)
              .setAction("ai.openclaw.app.action.STOP"),
            0,
            1,
          )
      NodeForegroundService.resume(app, startNow = true)
      val resumed = controller.get().onStartCommand(Shadows.shadowOf(app).nextStartedService, 0, 2)

      assertEquals(Service.START_NOT_STICKY, stopped)
      assertEquals(Service.START_STICKY, resumed)
    } finally {
      closeNodeServiceTestFixture(controller, app)
    }
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun cancelledServiceStartupDoesNotDisconnectRuntimeAdoptedByActivity() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val mainDispatcher = HeldMainDispatch()
    val gateway = lifetimeGateway()
    Dispatchers.setMain(mainDispatcher)

    try {
      assertEquals(Service.START_STICKY, controller.get().onStartCommand(null, 0, 1))
      val activation = mainDispatcher.awaitHeldDispatch()
      val startup = requireNotNull(activation.context.job.parent)

      NodeForegroundService.resume(app, startNow = false)
      assertSame(runtime, app.ensureRuntime())
      runtime.setForeground(true)
      runtime.connect(
        GatewayEndpoint.manual("127.0.0.1", gateway.port),
        NodeRuntime.GatewayConnectAuth(token = "synthetic-lifetime-token", bootstrapToken = null, password = null),
      )
      drainWithMainLooper { withTimeout(10_000) { runtime.nodeConnected.first { it } } }

      controller.destroy()
      mainDispatcher.release(activation)
      drainWithMainLooper { withTimeout(10_000) { startup.join() } }

      assertTrue("The Activity's adopted connection must outlive the old service observer", runtime.nodeConnected.value)
    } finally {
      mainDispatcher.releaseRemaining()
      Dispatchers.resetMain()
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun immediateStopThenResumeDoesNotDisconnectNewConnection() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val appShadow = Shadows.shadowOf(app)
    val gateway = lifetimeGateway()

    try {
      NodeForegroundService.stop(app)
      NodeForegroundService.resume(app, startNow = true)
      val pendingStarts = generateSequence { appShadow.nextStartedService }.toList()
      runtime.connect(
        GatewayEndpoint.manual("127.0.0.1", gateway.port),
        NodeRuntime.GatewayConnectAuth(token = "synthetic-lifetime-token", bootstrapToken = null, password = null),
      )
      drainWithMainLooper { withTimeout(10_000) { runtime.nodeConnected.first { it } } }

      val processOwner = ReflectionHelpers.getField<CoroutineScope>(app, "runtimeScope").coroutineContext.job
      val existingTasks = processOwner.children.toSet()
      pendingStarts.forEachIndexed { index, intent -> controller.get().onStartCommand(intent, 0, index + 1) }
      val stopTasks = processOwner.children.filterNot(existingTasks::contains).toList()
      drainWithMainLooper {
        // Join the process-owned stop work, as fixture teardown does; the assertion
        // below reads only the public connection state after those callbacks finish.
        withTimeout(10_000) {
          stopTasks.joinAll()
        }
      }

      assertTrue("A queued old Stop must not retire the newer Resume connection", runtime.nodeConnected.value)
    } finally {
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stopRetiresQueuedActivityConnect() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Connect)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stopRetiresQueuedActivityRefresh() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Refresh)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stopRetiresQueuedSavedGatewayConnection() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Save)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stopRetiresQueuedConversationNotification() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Notification)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stopRetiresQueuedForgetGateway() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Forget)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, ConnectAdmissionShadow::class])
  fun stopRetiresConnectAfterViewModelAdmissionCheck() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Connect, gateAtConnectEntry = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, ConnectAdmissionShadow::class])
  fun anotherActivityResumeDoesNotReviveStoppedConnect() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Connect, gateAtConnectEntry = true, resumeFromAnotherActivity = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun onboardingCompletionPreservesNodeCapabilityRefresh() = assertEstablishedConnectionSurvives(EstablishedConnectionAction.Onboarding)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun sameGatewayNotificationPreservesNodeCapabilityRefresh() = assertEstablishedConnectionSurvives(EstablishedConnectionAction.Notification)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun forgettingInactiveGatewayPreservesNodeCapabilityRefresh() = assertEstablishedConnectionSurvives(EstablishedConnectionAction.Forget)

  private enum class EstablishedConnectionAction { Onboarding, Notification, Forget }

  private fun assertEstablishedConnectionSurvives(action: EstablishedConnectionAction) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    app.prefs.setOnboardingCompleted(false)
    app.prefs.setCameraEnabled(true)
    val runtime = app.ensureBackgroundRuntime()
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("established", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val connections = LinkedBlockingQueue<String>()
    val gateway =
      lifetimeGateway { role ->
        connections.add(role)
        bootstrapHello(role)
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    val inactiveGateway = lifetimeGateway()
    val inactiveEndpoint = GatewayEndpoint.manual("127.0.0.1", inactiveGateway.port)

    try {
      viewModel.connect(endpoint, null, "synthetic-bootstrap-token", null)
      drainWithMainLooper {
        withTimeout(10_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value } }
      }
      connections.clear()
      when (action) {
        EstablishedConnectionAction.Onboarding -> {
          viewModel.setOnboardingCompleted(true)
        }

        EstablishedConnectionAction.Notification -> {
          viewModel.openConversationNotification(ConversationNotificationTarget(endpoint.stableId, "main", "agent:main:notification-proof", "run-proof"))
          drainWithMainLooper { withTimeout(10_000) { viewModel.requestedHomeDestination.first { it == HomeDestination.Chat } } }
        }

        EstablishedConnectionAction.Forget -> {
          app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(inactiveEndpoint, null))
          viewModel.forgetGateway(inactiveEndpoint.stableId)
          drainWithMainLooper {
            withTimeout(10_000) {
              app.prefs.gatewayRegistry.entries
                .first { entries -> entries.none { it.stableId == inactiveEndpoint.stableId } }
            }
          }
        }
      }
      assertTrue("Unrelated activity must retain the connected gateway", runtime.gatewayConnectionDisplay.value.isConnected)
      runtime.setCameraEnabled(false)
      val refreshedRoles = List(2) { connections.poll(10, TimeUnit.SECONDS) }
      assertTrue("Camera policy change must reach the established node connection: $refreshedRoles", "node" in refreshedRoles)
      drainWithMainLooper { withTimeout(10_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value } } }
      assertEquals(endpoint.stableId, app.prefs.gatewayRegistry.activeStableId.value)
    } finally {
      viewModels.clear()
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
      inactiveGateway.shutdown()
    }
  }

  private enum class QueuedGatewayAction {
    Connect,
    Refresh,
    Save,
    Notification,
    Forget,
  }

  private fun assertStopRetiresQueuedGatewayAction(
    action: QueuedGatewayAction,
    gateAtConnectEntry: Boolean = false,
    resumeFromAnotherActivity: Boolean = false,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    app.prefs.setOnboardingCompleted(true)
    val runtime = app.ensureBackgroundRuntime()
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("lifetime", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val initialGateway = lifetimeGateway(hello = ::bootstrapHello)
    val nextGateway = lifetimeGateway()
    val gate = RuntimeReturnGate()
    val appFixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)

    try {
      runtime.connect(
        GatewayEndpoint.manual("127.0.0.1", initialGateway.port),
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "synthetic-bootstrap-token", password = null),
      )
      drainWithMainLooper {
        withTimeout(10_000) {
          runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value }
        }
      }
      while (initialGateway.takeRequest(0, TimeUnit.MILLISECONDS) != null) {
        // The initial ready sockets are not requests issued by the queued action.
      }
      if (gateAtConnectEntry) {
        Shadow.extract<ConnectAdmissionShadow>(runtime).entryGate = gate
      } else {
        appFixture.runtimeReturnGate = gate
      }
      val existingOperations =
        viewModel.viewModelScope.coroutineContext.job.children
          .toSet()
      val nextEndpoint = GatewayEndpoint.manual("127.0.0.1", nextGateway.port)
      when (action) {
        QueuedGatewayAction.Connect -> {
          viewModel.connect(nextEndpoint, "synthetic-lifetime-token", null, null)
        }

        QueuedGatewayAction.Refresh -> {
          viewModel.refreshGatewayConnection()
        }

        QueuedGatewayAction.Forget -> {
          viewModel.forgetGateway(GatewayEndpoint.manual("127.0.0.1", initialGateway.port).stableId)
        }

        QueuedGatewayAction.Notification -> {
          app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(nextEndpoint, null))
          app.prefs.saveGatewayCredentials(nextEndpoint.stableId, "synthetic-lifetime-token", null, null)
          viewModel.openConversationNotification(
            ConversationNotificationTarget(nextEndpoint.stableId, "main", "agent:main:notification-proof", "run-proof"),
          )
        }

        QueuedGatewayAction.Save -> {
          app.prefs.saveGatewayCredentials(nextEndpoint.stableId, "synthetic-lifetime-token", null, null)
          viewModel.saveGatewayConfigAndConnect(
            GatewayConnectPlan(
              GatewayConnectConfig("127.0.0.1", nextGateway.port, false, "", "", ""),
              GatewaySavedAuthAction.PRESERVE,
            ),
          )
        }
      }
      assertTrue("Queued action did not reach runtime adoption", gate.entered.await(10, TimeUnit.SECONDS))
      val operation =
        viewModel.viewModelScope.coroutineContext.job.children
          .single { it !in existingOperations }

      val stopOwner =
        if (resumeFromAnotherActivity) {
          MainViewModel(app, app.prefs, SavedStateHandle()).also { viewModels.put("newer-activity", it) }
        } else {
          viewModel
        }
      val processOwner = ReflectionHelpers.getField<CoroutineScope>(app, "runtimeScope").coroutineContext.job
      val processTasksBeforeStop = processOwner.children.toSet()
      if (gateAtConnectEntry) assertNull(nextGateway.takeRequest(0, TimeUnit.MILLISECONDS))
      stopOwner.disconnect()
      generateSequence { Shadows.shadowOf(app).nextStartedService }
        .forEachIndexed { index, intent -> controller.get().onStartCommand(intent, 0, index + 1) }
      drainWithMainLooper { withTimeout(10_000) { runtime.nodeConnected.first { !it } } }
      if (gateAtConnectEntry) {
        val stopTasks = processOwner.children.filterNot(processTasksBeforeStop::contains).toList()
        drainWithMainLooper { withTimeout(10_000) { stopTasks.joinAll() } }
        assertNull(nextGateway.takeRequest(0, TimeUnit.MILLISECONDS))
      }
      if (resumeFromAnotherActivity) {
        Shadow.extract<ConnectAdmissionShadow>(runtime).entryGate = null
        stopOwner.connect(GatewayEndpoint.manual("127.0.0.1", initialGateway.port), "synthetic-lifetime-token", null, null)
        drainWithMainLooper {
          withTimeout(10_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value } }
        }
      }
      gate.release.countDown()
      drainWithMainLooper { withTimeout(10_000) { operation.join() } }
      if (gateAtConnectEntry) assertFalse("Call-through probe must not crash the gateway operation", operation.isCancelled)

      if (action == QueuedGatewayAction.Forget) {
        val savedId = GatewayEndpoint.manual("127.0.0.1", initialGateway.port).stableId
        assertTrue(
          "Stop must retire queued Forget before deleting the saved gateway",
          app.prefs.gatewayRegistry.entries.value
            .any { it.stableId == savedId },
        )
      } else {
        val target = if (action == QueuedGatewayAction.Refresh) initialGateway else nextGateway
        assertNull("Stopped activity work must not open another Gateway socket", target.takeRequest(10, TimeUnit.SECONDS))
      }
      if (resumeFromAnotherActivity) assertTrue(runtime.gatewayConnectionDisplay.value.isConnected && runtime.nodeConnected.value)
    } finally {
      gate.release.countDown()
      appFixture.runtimeReturnGate = null
      viewModels.clear()
      closeNodeServiceTestFixture(controller, app)
      initialGateway.shutdown()
      nextGateway.shutdown()
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun stopRetiresNodeBootstrapOperatorPromotion() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val fixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val authRead = RuntimeReturnGate()
    val stoppingNode = CountDownLatch(1)
    val stoppedNode = CountDownLatch(1)
    val nodeSession = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
    Shadow.extract<SessionDisconnectShadow>(nodeSession).apply {
      entered = stoppingNode
      completed = stoppedNode
    }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val gateway =
      lifetimeGateway { role ->
        if (role == "node") fixture.operatorTokenReadGate = authRead
        bootstrapHello(role)
      }

    try {
      runtime.connect(
        GatewayEndpoint.manual("127.0.0.1", gateway.port),
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "synthetic-bootstrap-token", password = null),
      )
      assertTrue("Node hello did not reach its operator credential read", authRead.entered.await(10, TimeUnit.SECONDS))
      assertNotNull(gateway.takeRequest(10, TimeUnit.SECONDS))
      NodeForegroundService.stop(app)
      assertTrue("Stop did not reach node teardown", stoppingNode.await(10, TimeUnit.SECONDS))
      assertFalse(runtime.nodeConnected.value)
      authRead.release.countDown()
      assertTrue("Node teardown did not complete", stoppedNode.await(10, TimeUnit.SECONDS))
      assertNull("Stopped node bootstrap must not promote an operator connection", gateway.takeRequest(10, TimeUnit.SECONDS))
    } finally {
      authRead.release.countDown()
      fixture.operatorTokenReadGate = null
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun stopRetiresSecondaryConnectionAfterAuthRead() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val fixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val authRead = RuntimeReturnGate()
    val stoppedNode = CountDownLatch(1)
    val nodeSession = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
    Shadow.extract<SessionDisconnectShadow>(nodeSession).completed = stoppedNode
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val gateway = lifetimeGateway()
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    app.prefs.saveGatewayCredentials(endpoint.stableId, "synthetic-secondary-token", null, null)

    try {
      runtime.setForeground(true)
      fixture.operatorTokenReadGate = authRead
      runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
      assertTrue("Secondary connection did not reach its credential read", authRead.entered.await(10, TimeUnit.SECONDS))
      NodeForegroundService.stop(app)
      assertTrue("Stop did not finish its runtime teardown", stoppedNode.await(10, TimeUnit.SECONDS))
      assertNull(fixture.sessionConnections.poll())

      authRead.release.countDown()

      assertNull(
        "Stopped fleet work must not start an authenticated secondary connection",
        fixture.sessionConnections.poll(10, TimeUnit.SECONDS),
      )
    } finally {
      authRead.release.countDown()
      fixture.operatorTokenReadGate = null
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun forgetAfterStopWaitsForSecondaryTokenPersistence() = assertStoppedSecondaryAuthCleanup(forget = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun authResetAfterStopWaitsForSecondaryTokenPersistence() = assertStoppedSecondaryAuthCleanup(forget = false)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun reenabledSecondaryDoesNotOverwriteItsNewTokenWithARetiredHello() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.SecondaryReenable)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun stoppedPrimaryReconnectReadsItsAcceptedOperatorToken() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.PrimaryReconnect)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun focusingSecondaryReadsItsAcceptedOperatorToken() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.SecondaryFocus)

  private enum class GatewayTokenTransition { SecondaryReenable, PrimaryReconnect, SecondaryFocus }

  private fun assertReconnectDrainsAcceptedOperatorToken(transition: GatewayTokenTransition) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val fixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val tokenWrite = RuntimeReturnGate()
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val helloCount = AtomicInteger()
    val wireTokens = LinkedBlockingQueue<String>()
    val gateway =
      lifetimeGateway(onConnect = { frame ->
        val params = frame.getValue("params").jsonObject
        if (params["role"]?.jsonPrimitive?.content == "operator") {
          wireTokens.add(
            params
              .getValue("auth")
              .jsonObject
              .getValue("token")
              .jsonPrimitive.content,
          )
        }
      }) { role ->
        if (role == "operator") {
          val token = if (helloCount.incrementAndGet() == 1) "synthetic-old-token" else "synthetic-new-token"
          """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{},"auth":{"deviceToken":"$token","role":"operator","scopes":["operator.read","operator.write"]}}"""
        } else {
          """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{}}"""
        }
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    val deviceId = DeviceIdentityStore.withPrefs(app, app.prefs).loadOrCreate().deviceId
    val authStore = DeviceAuthStore(app.prefs)
    authStore.saveToken(endpoint.stableId, deviceId, "operator", "synthetic-initial-token", listOf("operator.read", "operator.write"))
    assertEquals("synthetic-initial-token", fixture.operatorTokenWrites.tryReceive().getOrNull())

    try {
      runtime.setForeground(true)
      fixture.operatorTokenWriteGate = tokenWrite
      if (transition == GatewayTokenTransition.PrimaryReconnect) {
        runtime.connect(endpoint)
      } else {
        runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
      }
      assertTrue("First operator hello did not reach token persistence", tokenWrite.entered.await(10, TimeUnit.SECONDS))
      val first = generateSequence { fixture.sessionConnections.poll() }.first { it.role == "operator" }.session
      assertEquals("synthetic-initial-token", wireTokens.remove())
      val drained = CompletableDeferred<Unit>()
      Shadow.extract<SessionDisconnectShadow>(first).joinStarted = drained
      val replacement =
        if (transition == GatewayTokenTransition.SecondaryReenable) {
          first
        } else {
          ReflectionHelpers.getField<GatewaySession>(runtime, "operatorSession")
        }
      val admitted = CompletableDeferred<Unit>()
      Shadow.extract<SessionDisconnectShadow>(replacement).connectStarted = admitted
      when (transition) {
        GatewayTokenTransition.SecondaryReenable -> {
          runtime.setGatewayConnectionEnabled(endpoint.stableId, false)
          runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
        }

        GatewayTokenTransition.PrimaryReconnect -> {
          val stopped = CountDownLatch(1)
          val nodeSession = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
          Shadow.extract<SessionDisconnectShadow>(nodeSession).completed = stopped
          NodeForegroundService.stop(app)
          assertTrue("Stop did not complete before reconnect", stopped.await(10, TimeUnit.SECONDS))
          runtime.connect(endpoint)
        }

        GatewayTokenTransition.SecondaryFocus -> {
          runtime.connect(endpoint)
        }
      }
      val completedWrites = mutableListOf<String>()
      drainWithMainLooper {
        try {
          val waitingForOldOwner =
            withTimeout(10_000) {
              select {
                drained.onAwait { true }
                admitted.onAwait { false }
              }
            }
          if (!waitingForOldOwner) {
            completedWrites += withTimeout(10_000) { fixture.operatorTokenWrites.receive() }
          }
        } finally {
          tokenWrite.release.countDown()
        }
        withTimeout(10_000) {
          while (completedWrites.size < 2) completedWrites += fixture.operatorTokenWrites.receive()
          replacement.disconnectAndJoin()
        }
      }
      assertEquals(2, helloCount.get())
      println("GATEWAY_TOKEN_ORDER transition=$transition writes=$completedWrites secondAuth=${wireTokens.peek()}")
      assertEquals(
        "A retired hello must not overwrite the newer connection token",
        "synthetic-new-token",
        authStore.loadToken(endpoint.stableId, deviceId, "operator"),
      )
      assertEquals("Reconnect must read auth after the accepted old write", "synthetic-old-token", wireTokens.remove())
      assertEquals(listOf("synthetic-old-token", "synthetic-new-token"), completedWrites)
    } finally {
      tokenWrite.release.countDown()
      fixture.operatorTokenWriteGate = null
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  private fun assertStoppedSecondaryAuthCleanup(forget: Boolean) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val fixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val tokenWrite = RuntimeReturnGate()
    val stoppedNode = CountDownLatch(1)
    val nodeSession = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
    Shadow.extract<SessionDisconnectShadow>(nodeSession).completed = stoppedNode
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val gateway =
      lifetimeGateway {
        """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{},"auth":{"deviceToken":"synthetic-secondary-issued-token","role":"operator","scopes":["operator.read","operator.write"]}}"""
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    app.prefs.saveGatewayCredentials(endpoint.stableId, "synthetic-secondary-token", null, null)
    var completedBeforeWrite: Boolean? = null

    try {
      runtime.setForeground(true)
      fixture.operatorTokenWriteGate = tokenWrite
      runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
      assertTrue("Secondary hello did not reach token persistence", tokenWrite.entered.await(10, TimeUnit.SECONDS))
      val connection = fixture.sessionConnections.remove()
      assertEquals(endpoint, connection.endpoint)
      assertEquals("operator", connection.role)
      val secondary = connection.session
      val secondaryDrain = CompletableDeferred<Unit>()
      Shadow.extract<SessionDisconnectShadow>(secondary).joinStarted = secondaryDrain
      NodeForegroundService.stop(app)
      assertTrue("Stop did not finish its runtime teardown", stoppedNode.await(10, TimeUnit.SECONDS))

      drainWithMainLooper {
        coroutineScope {
          val cleanup =
            async {
              if (forget) runtime.forgetGateway(endpoint.stableId) else runtime.resetGatewaySetupAuth(endpoint.stableId)
            }
          try {
            completedBeforeWrite =
              withTimeout(10_000) {
                select {
                  cleanup.onAwait { it }
                  secondaryDrain.onAwait { null }
                }
              }
          } finally {
            tokenWrite.release.countDown()
          }
          assertTrue(withTimeout(10_000) { cleanup.await() })
          withTimeout(10_000) { secondary.disconnectAndJoin() }
        }
      }

      val deviceId = DeviceIdentityStore.withPrefs(app, app.prefs).loadOrCreate().deviceId
      assertNull(
        "Accepted secondary token must not reappear after authentication cleanup",
        DeviceAuthStore(app.prefs).loadToken(endpoint.stableId, deviceId, "operator"),
      )
      assertNull("Authentication cleanup must wait for the stopped secondary's accepted write", completedBeforeWrite)
      assertEquals(
        !forget,
        app.prefs.gatewayRegistry.entries.value
          .any { it.stableId == endpoint.stableId },
      )
    } finally {
      tokenWrite.release.countDown()
      fixture.operatorTokenWriteGate = null
      closeNodeServiceTestFixture(controller, app)
      gateway.shutdown()
    }
  }

  @Test
  fun backgroundRuntimeStartsWithoutForegroundCapabilitiesOrMicRestore() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences("node-service-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setVoiceMicEnabled(true)
    val runtime = NodeRuntime(app, prefs, initialForeground = false)

    try {
      assertFalse(runtime.isForeground.value)
      assertFalse(prefs.voiceMicEnabled.value)
    } finally {
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  @Test
  fun buildNotificationSetsLaunchIntent() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()
    val notification = buildNotification(service)

    val pendingIntent = notification.contentIntent
    assertNotNull(pendingIntent)

    val savedIntent = Shadows.shadowOf(pendingIntent).savedIntent
    assertNotNull(savedIntent)
    assertEquals(MainActivity::class.java.name, savedIntent.component?.className)

    val expectedFlags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    assertEquals(expectedFlags, savedIntent.flags and expectedFlags)
  }

  @Test
  fun foregroundServiceTypes_addsOnlyActiveSensitiveTypes() {
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      foregroundServiceTypes(VoiceCaptureMode.Off, backgroundLocationActive = false),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      foregroundServiceTypes(VoiceCaptureMode.ManualMic, backgroundLocationActive = false),
    )
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      foregroundServiceTypes(VoiceCaptureMode.TalkMode, backgroundLocationActive = true),
    )
  }

  @Test
  fun backgroundLocationNotificationSuffix_disclosesActiveAlwaysMode() {
    assertEquals("", backgroundLocationNotificationSuffix(active = false))
    assertEquals(" · Location: Always", backgroundLocationNotificationSuffix(active = true))
  }

  @Test
  fun voiceNotificationSuffixReflectsActiveCaptureMode() {
    assertEquals("", voiceNotificationSuffix(VoiceCaptureMode.Off, false, false, false, false))
    assertEquals(
      " · Mic: Listening",
      voiceNotificationSuffix(VoiceCaptureMode.ManualMic, true, true, false, false),
    )
    assertEquals(
      " · Talk: Speaking",
      voiceNotificationSuffix(VoiceCaptureMode.TalkMode, false, false, true, true),
    )
  }

  private fun buildNotification(service: NodeForegroundService): Notification {
    val method =
      NodeForegroundService::class.java.getDeclaredMethod(
        "buildNotification",
        String::class.java,
        String::class.java,
      )
    method.isAccessible = true
    return method.invoke(service, "Title", "Text") as Notification
  }

  private data class HeldDispatch(
    val context: CoroutineContext,
    val block: Runnable,
  )

  @Implements(NodeApp::class, isInAndroidSdk = false)
  class ServiceRuntimePrefsShadow : ShadowApplication() {
    @RealObject private lateinit var app: NodeApp

    @Volatile var runtimeReturnGate: RuntimeReturnGate? = null

    @Volatile var prefsReadGate: RuntimeReturnGate? = null

    @Volatile var operatorTokenReadGate: RuntimeReturnGate? = null

    @Volatile var operatorTokenWriteGate: RuntimeReturnGate? = null
    val sessionConnections = LinkedBlockingQueue<SessionConnection>()
    val operatorTokenWrites = Channel<String>(Channel.UNLIMITED)
    private val testPrefs by lazy {
      val backing = app.getSharedPreferences("service-lifetime-proof", Context.MODE_PRIVATE)
      SecurePrefs(
        app,
        securePrefsOverride =
          object : SharedPreferences by backing {
            override fun edit(): SharedPreferences.Editor {
              val editor = backing.edit()
              return object : SharedPreferences.Editor by editor {
                private var savesOperatorToken = false
                private var operatorToken: String? = null

                override fun putString(
                  key: String?,
                  value: String?,
                ): SharedPreferences.Editor {
                  if (key?.startsWith("gateway.deviceToken.") == true && key.endsWith(".operator")) {
                    savesOperatorToken = true
                    operatorToken = value
                  }
                  editor.putString(key, value)
                  return this
                }

                override fun apply() {
                  if (savesOperatorToken) {
                    operatorTokenWriteGate?.let { gate ->
                      if (gate.claimed.compareAndSet(false, true)) {
                        gate.entered.countDown()
                        check(gate.release.await(10, TimeUnit.SECONDS)) { "Operator token write was not released" }
                      }
                    }
                  }
                  editor.apply()
                  operatorToken?.let { operatorTokenWrites.trySend(it) }
                }
              }
            }

            override fun getString(
              key: String?,
              defValue: String?,
            ): String? {
              if (key?.startsWith("gateway.deviceToken.") == true && key.endsWith(".operator")) {
                operatorTokenReadGate?.let { gate ->
                  if (gate.claimed.compareAndSet(false, true)) {
                    gate.entered.countDown()
                    check(gate.release.await(10, TimeUnit.SECONDS)) { "Operator credential read was not released" }
                  }
                }
              }
              return backing.getString(key, defValue)
            }
          },
      )
    }

    @Implementation
    protected fun getPrefs(): SecurePrefs {
      prefsReadGate?.let { gate ->
        gate.entered.countDown()
        check(gate.release.await(10, TimeUnit.SECONDS)) { "Runtime construction gate was not released" }
      }
      return testPrefs
    }

    @Implementation
    protected fun ensureRuntime(): NodeRuntime {
      val runtime = Shadow.directlyOn<NodeRuntime, NodeApp>(app, NodeApp::class.java, "ensureRuntime")
      runtimeReturnGate?.let { gate ->
        gate.entered.countDown()
        check(gate.release.await(10, TimeUnit.SECONDS)) { "Runtime adoption gate was not released" }
      }
      return runtime
    }
  }

  @Implements(NodeRuntime::class, isInAndroidSdk = false)
  class ConnectAdmissionShadow {
    @RealObject private lateinit var runtime: NodeRuntime

    @Volatile var entryGate: RuntimeReturnGate? = null

    @Implementation
    protected fun connectSwitchingGateway(
      endpoint: GatewayEndpoint?,
      auth: NodeRuntime.GatewayConnectAuth?,
      isCurrent: (() -> Boolean)?,
      continuation: Continuation<Boolean>,
    ): Any? {
      if (endpoint != null) {
        entryGate?.let { gate ->
          gate.entered.countDown()
          check(gate.release.await(10, TimeUnit.SECONDS)) { "Connect admission gate was not released" }
        }
      }
      return Shadow.directlyOn<Any, NodeRuntime>(
        runtime,
        NodeRuntime::class.java,
        "connectSwitchingGateway",
        ReflectionHelpers.ClassParameter.from(GatewayEndpoint::class.java, endpoint),
        ReflectionHelpers.ClassParameter.from(NodeRuntime.GatewayConnectAuth::class.java, auth),
        ReflectionHelpers.ClassParameter.from(Function0::class.java, isCurrent),
        ReflectionHelpers.ClassParameter.from(Continuation::class.java, continuation),
      )
    }
  }

  @Implements(GatewaySession::class, isInAndroidSdk = false)
  class SessionDisconnectShadow {
    @RealObject private lateinit var session: GatewaySession
    var entered: CountDownLatch? = null
    var completed: CountDownLatch? = null
    var joinStarted: CompletableDeferred<Unit>? = null
    var connectStarted: CompletableDeferred<Unit>? = null

    @Implementation
    protected fun disconnectAndJoin(continuation: Continuation<Unit>): Any? {
      joinStarted?.complete(Unit)
      return Shadow.directlyOn<Any, GatewaySession>(
        session,
        GatewaySession::class.java,
        "disconnectAndJoin",
        ReflectionHelpers.ClassParameter.from(Continuation::class.java, continuation),
      )
    }

    @Implementation
    protected fun connect(
      endpoint: GatewayEndpoint,
      token: String?,
      bootstrapToken: String?,
      password: String?,
      options: GatewayConnectOptions,
      tls: GatewayTlsParams?,
    ) {
      connectStarted?.complete(Unit)
      Shadow
        .extract<ServiceRuntimePrefsShadow>(RuntimeEnvironment.getApplication())
        .sessionConnections
        .add(SessionConnection(session, endpoint, options.role))
      Shadow.directlyOn<Any, GatewaySession>(
        session,
        GatewaySession::class.java,
        "connect",
        ReflectionHelpers.ClassParameter.from(GatewayEndpoint::class.java, endpoint),
        ReflectionHelpers.ClassParameter.from(String::class.java, token),
        ReflectionHelpers.ClassParameter.from(String::class.java, bootstrapToken),
        ReflectionHelpers.ClassParameter.from(String::class.java, password),
        ReflectionHelpers.ClassParameter.from(GatewayConnectOptions::class.java, options),
        ReflectionHelpers.ClassParameter.from(GatewayTlsParams::class.java, tls),
      )
    }

    @Implementation
    protected fun disconnect() {
      entered?.countDown()
      try {
        Shadow.directlyOn<Any, GatewaySession>(session, GatewaySession::class.java, "disconnect")
      } finally {
        completed?.countDown()
      }
    }
  }

  class RuntimeReturnGate {
    val claimed = AtomicBoolean()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
  }

  data class SessionConnection(
    val session: GatewaySession,
    val endpoint: GatewayEndpoint,
    val role: String,
  )

  private class HeldMainDispatch : CoroutineDispatcher() {
    private val main = Handler(Looper.getMainLooper()).asCoroutineDispatcher()
    private val holdNext = AtomicBoolean(true)
    private val held = LinkedBlockingQueue<HeldDispatch>()
    private val pending = AtomicReference<HeldDispatch?>()

    override fun dispatch(
      context: CoroutineContext,
      block: Runnable,
    ) {
      if (holdNext.compareAndSet(true, false)) {
        val dispatch = HeldDispatch(context, block)
        pending.set(dispatch)
        held.put(dispatch)
      } else {
        main.dispatch(context, block)
      }
    }

    fun awaitHeldDispatch(): HeldDispatch = checkNotNull(held.poll(10, TimeUnit.SECONDS)) { "Service activation did not reach Main" }

    fun release(dispatch: HeldDispatch) {
      if (pending.compareAndSet(dispatch, null)) main.dispatch(dispatch.context, dispatch.block)
    }

    fun releaseRemaining() {
      holdNext.set(false)
      pending.get()?.let(::release)
    }
  }

  private fun bootstrapHello(role: String): String =
    if (role == "node") {
      """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{},"auth":{"deviceTokens":[{"role":"operator","deviceToken":"synthetic-operator-token","scopes":["operator.read","operator.write"]}]}}"""
    } else {
      """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{}}"""
    }

  private fun lifetimeGateway(
    onConnect: ((JsonObject) -> Unit)? = null,
    hello: (String) -> String = {
      """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{}}"""
    },
  ): MockWebServer =
    MockWebServer().apply {
      dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse =
            MockResponse().withWebSocketUpgrade(
              object : WebSocketListener() {
                override fun onOpen(
                  webSocket: WebSocket,
                  response: Response,
                ) {
                  webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"lifetime-proof","ts":${System.currentTimeMillis()}}}""")
                }

                override fun onMessage(
                  webSocket: WebSocket,
                  text: String,
                ) {
                  val frame = Json.parseToJsonElement(text).jsonObject
                  val id = frame["id"] ?: return
                  val payload =
                    if (frame["method"]?.jsonPrimitive?.content == "connect") {
                      onConnect?.invoke(frame)
                      hello(
                        frame["params"]
                          ?.jsonObject
                          ?.get("role")
                          ?.jsonPrimitive
                          ?.content
                          .orEmpty(),
                      )
                    } else {
                      "{}"
                    }
                  webSocket.send("""{"type":"res","id":$id,"ok":true,"payload":$payload}""")
                }
              },
            )
        }
      start(InetAddress.getByName("127.0.0.1"), 0)
    }
}
