package ai.openclaw.app

import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.GatewayConnectConfig
import ai.openclaw.app.ui.GatewayConnectPlan
import ai.openclaw.app.ui.GatewaySavedAuthAction
import ai.openclaw.app.ui.SettingsRoute
import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Bundle
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
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
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.DERBitString
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.Certificate
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Time
import org.bouncycastle.asn1.x509.V3TBSCertificateGenerator
import org.bouncycastle.asn1.x509.Validity
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
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowApplication
import org.robolectric.shadows.ShadowBroadcastPendingResult
import org.robolectric.shadows.ShadowBroadcastReceiver
import org.robolectric.shadows.ShadowToast
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.cert.CertificateFactory
import java.util.Date
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
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
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
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
      val processOwner = ReflectionHelpers.getField<CoroutineScope>(app, "runtimeScope").coroutineContext.job
      val processTasksBeforeStop = processOwner.children.toSet()
      NodeForegroundService.stop(app)
      val stopTasks = processOwner.children.filterNot(processTasksBeforeStop::contains).toList()
      controller.destroy()
      gate.release.countDown()
      drainWithMainLooper {
        withTimeout(10_000) {
          ReflectionHelpers
            .getField<CoroutineScope>(controller.get(), "scope")
            .coroutineContext.job
            .join()
          stopTasks.joinAll()
          val runtime = requireNotNull(app.peekRuntime())
          // The runtime owns final Offline callbacks after both startup jobs return.
          listOf("nodeSession", "operatorSession").forEach { field ->
            val session = ReflectionHelpers.getField<GatewaySession>(runtime, field)
            requireNotNull(ReflectionHelpers.getField<Job?>(session, "disconnectTail")).join()
          }
        }
      }

      val runtime = requireNotNull(app.peekRuntime())
      assertFalse(runtime.nodeConnected.value)
      assertFalse(runtime.isForeground.value)
      assertEquals("Offline", runtime.gatewayConnectionDisplay.value.statusText)
      // A startup socket's HTTP upgrade can reach the server after Stop retires it.
      // Observe new session admissions instead of the asynchronous server request queue.
      fixture.sessionConnections.clear()
      runtime.setForeground(true)
      assertNull("Foreground re-entry must not reconnect a stopped runtime", fixture.sessionConnections.poll(10, TimeUnit.SECONDS))
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
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
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
  @Config(shadows = [ServiceRuntimePrefsShadow::class, ConnectAdmissionShadow::class, SessionDisconnectShadow::class])
  fun stopRetiresConnectAfterViewModelAdmissionCheck() = assertStopRetiresQueuedGatewayAction(QueuedGatewayAction.Connect, gateAtConnectEntry = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, ConnectAdmissionShadow::class, SessionDisconnectShadow::class])
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

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun notificationReplyReconnectsAfterCompletedDisconnect() = assertNotificationReplyReconnectsAfterCompletedDisconnect(includeGeneration = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun preUpdateNotificationReplyWithoutGenerationStillReconnectsAndAdmits() = assertNotificationReplyReconnectsAfterCompletedDisconnect(includeGeneration = false)

  private fun assertNotificationReplyReconnectsAfterCompletedDisconnect(includeGeneration: Boolean) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val appShadow = Shadows.shadowOf(app)
    appShadow.grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("notification-reply", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val connections = LinkedBlockingQueue<String>()
    val sends = LinkedBlockingQueue<JsonObject>()
    val gateway =
      lifetimeGateway(
        onRequest = { frame ->
          when (frame["method"]?.jsonPrimitive?.content) {
            "chat.history" -> {
              """{"sessionId":"notification-proof-session","messages":[]}"""
            }

            "health" -> {
              """{"ok":true}"""
            }

            "chat.send" -> {
              val params = requireNotNull(frame["params"]).jsonObject
              sends.add(params)
              """{"runId":${params["idempotencyKey"]},"status":"started"}"""
            }

            else -> {
              "{}"
            }
          }
        },
      ) { role ->
        connections.add(role)
        bootstrapHello(role)
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    val target = ConversationNotificationTarget(endpoint.stableId, "main", "agent:main:notification-proof", "run-proof")
    val manager = app.getSystemService(NotificationManager::class.java)

    try {
      // Await this reconnect fixture's real stores before starting connection deadlines.
      drainWithMainLooper {
        ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases").clientStateDatabase()
      }
      viewModel.connect(endpoint, null, "synthetic-bootstrap-token", null)
      drainWithMainLooper {
        withTimeout(10_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value } }
      }
      runtime.switchChatSession(target.sessionKey, target.agentId)
      drainWithMainLooper { withTimeout(10_000) { runtime.chatHealthOk.first { it } } }
      assertTrue(ConversationReplyNotifier(app).show(target.toComposerOwner(), target.runId, "Synthetic assistant reply"))
      val posted = manager.activeNotifications.single { it.tag == target.notificationTag }
      var notification = posted.notification
      if (!includeGeneration) {
        // Reproduce v2026.9.1's Reply envelope, without changing the receiver or its admission path.
        val originalAction = notification.actions.single()
        val legacyAction =
          Notification.Action
            .Builder(
              null,
              originalAction.title,
              PendingIntent.getBroadcast(
                app,
                1,
                conversationNotificationReplyIntent(app, target)
                  .setData(Uri.parse("openclaw://conversation-notification/reply/${target.intentIdentityDigest}")),
                PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_MUTABLE,
              ),
            ).addRemoteInput(originalAction.remoteInputs.single())
            .setAllowGeneratedReplies(true)
            .setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
            .build()
        notification =
          Notification.Builder
            .recoverBuilder(app, notification)
            .setActions(legacyAction)
            .build()
        notification.extras.remove("ai.openclaw.app.extra.CONVERSATION_PUBLICATION_GENERATION")
        manager.notify(posted.tag, posted.id, notification)
      }
      val action = notification.actions.single()
      val parsedReply = requireNotNull(parseConversationNotificationReplyIntent(Shadows.shadowOf(action.actionIntent).savedIntent))
      assertEquals(target, parsedReply.target)
      assertEquals(includeGeneration, parsedReply.generation != null)
      val newerNotification =
        if (includeGeneration) {
          null
        } else {
          assertTrue(ConversationReplyNotifier(app).show(target.toComposerOwner(), "newer-run", "Newer assistant reply"))
          manager.activeNotifications.single { it.tag == target.notificationTag }.notification
        }
      val receiver =
        appShadow.registeredReceivers
          .map { it.broadcastReceiver }
          .filterIsInstance<ConversationReplyReceiver>()
          .single()

      disconnectThroughNotification(controller, app, runtime)
      assertEquals(endpoint.stableId, app.prefs.gatewayRegistry.activeStableId.value)
      assertEquals("Offline", runtime.gatewayConnectionDisplay.value.statusText)
      assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
      connections.clear()
      assertTrue(sends.isEmpty())

      val text = "Synthetic notification reply after Disconnect"
      val fillIn = Intent()
      RemoteInput.addResultsToIntent(
        action.remoteInputs,
        fillIn,
        Bundle().apply { putCharSequence(action.remoteInputs.single().resultKey, text) },
      )
      if (newerNotification != null) {
        val newerIntent = Shadows.shadowOf(newerNotification.actions.single().actionIntent).savedIntent
        val newerReply = requireNotNull(parseConversationNotificationReplyIntent(newerIntent))
        // An old mutable sender can add extras, but cannot turn its fixed v1 data into the new envelope.
        fillIn.setData(newerIntent.data).putExtra("ai.openclaw.app.extra.CONVERSATION_PUBLICATION_GENERATION", newerReply.generation)
      }
      action.actionIntent.send(app, 0, fillIn)
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      val receiverShadow = Shadow.extract<ShadowBroadcastReceiver>(receiver)
      assertTrue("The actual Reply receiver must own a goAsync result", receiverShadow.wentAsync())
      val finished = Shadow.extract<ShadowBroadcastPendingResult>(requireNotNull(receiverShadow.originalPendingResult)).future
      drainWithMainLooper {
        withTimeout(10_000) {
          while (!finished.isDone) yield()
          finished.get()
        }
      }

      assertTrue("An explicit Reply after Disconnect must admit a new operator connection to saved A", "operator" in connections)
      drainWithMainLooper { withTimeout(10_000) { while (sends.isEmpty()) yield() } }
      val sent = requireNotNull(sends.poll())
      assertEquals(target.sessionKey, sent["sessionKey"]?.jsonPrimitive?.content)
      assertEquals(target.agentId, sent["agentId"]?.jsonPrimitive?.content)
      assertEquals(text, sent["message"]?.jsonPrimitive?.content)
      val commandId = conversationNotificationReplyIdempotencyKey(target)
      assertEquals(commandId, sent["idempotencyKey"]?.jsonPrimitive?.content)
      assertTrue("The observed Reply must have only one chat.send", sends.isEmpty())
      drainWithMainLooper { assertTrue(runtime.wasChatOutboxCommandAdmitted(commandId)) }
      if (includeGeneration) {
        val acknowledged = manager.activeNotifications.singleOrNull { it.tag == target.notificationTag }
        assertNotNull("Durable admission must retain a current Reply acknowledgment", acknowledged)
        assertEquals(posted.id, requireNotNull(acknowledged).id)
        val update = acknowledged.notification
        assertEquals(notification.contentIntent, update.contentIntent)
        assertEquals(Notification.VISIBILITY_PRIVATE, update.visibility)
        assertEquals(Notification.GROUP_ALERT_SUMMARY, update.groupAlertBehavior)
        assertEquals(
          "Chat",
          update.publicVersion.extras
            .getCharSequence(Notification.EXTRA_TEXT)
            .toString(),
        )
        assertNull(update.publicVersion.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
        assertEquals("Reply queued", update.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertTrue(
          update.extras
            .getCharSequence(Notification.EXTRA_BIG_TEXT)
            .toString()
            .contains(text),
        )
        assertEquals(
          "Open conversation",
          update.actions
            .single()
            .title
            .toString(),
        )
        assertTrue(
          update.actions
            .single()
            .remoteInputs
            .isNullOrEmpty(),
        )
      } else {
        val retained = manager.activeNotifications.single { it.tag == target.notificationTag }.notification
        assertEquals(requireNotNull(newerNotification).contentIntent, retained.contentIntent)
        assertEquals("Newer assistant reply", retained.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
      }
    } finally {
      runCatching { manager.cancel(target.notificationTag, 1) }
      closeNotificationViewModelFixture(viewModels, viewModel, controller, app, gateway)
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun notificationReplyContinuesAfterApprovingTlsTrust() {
    val tlsSocketFactory = lifetimeGatewayTlsSocketFactory()
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val appShadow = Shadows.shadowOf(app)
    appShadow.grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    app.prefs.setManualTls(true)
    val runtime = app.ensureBackgroundRuntime()
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val connections = LinkedBlockingQueue<String>()
    val sends = LinkedBlockingQueue<JsonObject>()
    val gateway =
      lifetimeGateway(
        sslSocketFactory = tlsSocketFactory,
        onRequest = { frame ->
          when (frame["method"]?.jsonPrimitive?.content) {
            "chat.history" -> {
              """{"sessionId":"notification-tls-session","messages":[]}"""
            }

            "health" -> {
              """{"ok":true}"""
            }

            "chat.send" -> {
              val params = requireNotNull(frame["params"]).jsonObject
              sends.add(params)
              """{"runId":${params["idempotencyKey"]},"status":"started"}"""
            }

            else -> {
              "{}"
            }
          }
        },
      ) { role ->
        connections.add(role)
        bootstrapHello(role)
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port, tlsEnabled = true)
    val target = ConversationNotificationTarget(endpoint.stableId, "main", "agent:main:notification-tls", "tls-reply")
    val commandId = conversationNotificationReplyIdempotencyKey(target)
    val manager = app.getSystemService(NotificationManager::class.java)

    try {
      // A saved assistant-reply notice presupposes initialized app stores.
      drainWithMainLooper {
        ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases").clientStateDatabase()
      }
      runtime.disconnect()
      drainWithMainLooper { withTimeout(10_000) { joinRuntimeDisconnectTails(runtime) } }
      app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
      app.prefs.gatewayRegistry.setActive(endpoint.stableId)
      app.prefs.saveGatewayCredentials(endpoint.stableId, token = "synthetic-tls-token")
      assertTrue(ConversationReplyNotifier(app).show(target.toComposerOwner(), target.runId, "Synthetic assistant reply"))
      val action =
        manager.activeNotifications
          .single { it.tag == target.notificationTag }
          .notification.actions
          .single()
      val receiver =
        appShadow.registeredReceivers
          .map { it.broadcastReceiver }
          .filterIsInstance<ConversationReplyReceiver>()
          .single()
      val text = "Synthetic reply through TLS approval"
      val fillIn = Intent()
      RemoteInput.addResultsToIntent(
        action.remoteInputs,
        fillIn,
        Bundle().apply { putCharSequence(action.remoteInputs.single().resultKey, text) },
      )
      action.actionIntent.send(app, 0, fillIn)
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      val receiverShadow = Shadow.extract<ShadowBroadcastReceiver>(receiver)
      assertTrue(receiverShadow.wentAsync())
      val finished = Shadow.extract<ShadowBroadcastPendingResult>(requireNotNull(receiverShadow.originalPendingResult)).future
      drainWithMainLooper {
        val prompt = requireNotNull(withTimeout(10_000) { runtime.pendingGatewayTrust.first { it != null } })
        assertEquals(endpoint.stableId, prompt.endpoint.stableId)
        assertNotNull(prompt.fingerprintSha256)
        assertFalse("Reply must still be waiting for its TLS decision", finished.isDone)
        assertTrue("Unapproved TLS must not authenticate a gateway session", connections.isEmpty())
        assertTrue(sends.isEmpty())

        runtime.acceptGatewayTrustPrompt()
        withTimeout(10_000) {
          while (!finished.isDone) yield()
          finished.get()
          runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value }
        }
        assertTrue("Approved TLS must leave the gateway ready", runtime.gatewayConnectionDisplay.value.isConnected)
        assertTrue("TLS approval must preserve the waiting Reply's outbox admission", runtime.wasChatOutboxCommandAdmitted(commandId))
        assertEquals(prompt.fingerprintSha256, app.prefs.loadGatewayTlsFingerprint(endpoint.stableId))
      }

      drainWithMainLooper { withTimeout(10_000) { while (sends.isEmpty()) yield() } }
      val sent = requireNotNull(sends.poll())
      assertEquals(target.sessionKey, sent["sessionKey"]?.jsonPrimitive?.content)
      assertEquals(target.agentId, sent["agentId"]?.jsonPrimitive?.content)
      assertEquals(text, sent["message"]?.jsonPrimitive?.content)
      assertEquals(commandId, sent["idempotencyKey"]?.jsonPrimitive?.content)
      assertTrue("The approved Reply must produce exactly one chat.send", sends.isEmpty())
      val update = manager.activeNotifications.single { it.tag == target.notificationTag }.notification
      assertEquals("Reply queued", update.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
      assertTrue(
        update.extras
          .getCharSequence(Notification.EXTRA_BIG_TEXT)
          .toString()
          .contains(text),
      )
    } finally {
      runCatching { manager.cancel(target.notificationTag, 1) }
      try {
        closeNodeServiceTestFixture(controller, app)
      } finally {
        gateway.shutdown()
      }
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun sameViewModelNotificationAndForegroundReentryPreserveHeldTlsTrustPrompt() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val probeJob = CompletableDeferred<Job>()
    val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
    val probeCount = AtomicInteger()
    assertNull(app.peekRuntime())
    val runtime =
      NodeRuntime(app, app.prefs, tlsFingerprintProbe = { _, _ ->
        probeCount.incrementAndGet()
        probeJob.complete(currentCoroutineContext().job)
        probeResult.await()
      })
    ReflectionHelpers.setField(app, "runtimeInstance", runtime)
    val gateway = lifetimeGateway()
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port, tlsEnabled = true)
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("held-tls", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val fingerprint = "ab".repeat(32)
    val target = ConversationNotificationTarget(endpoint.stableId, "main", "agent:main:notification-proof", "run-proof")
    val notificationManager = app.getSystemService(NotificationManager::class.java)

    try {
      runtime.setForeground(false)
      // Begin from the stopped owner before arming saved A, so cold auto-connect cannot own the probe.
      runtime.disconnect()
      drainWithMainLooper { withTimeout(10_000) { joinRuntimeDisconnectTails(runtime) } }
      app.prefs.setManualTls(true)
      app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
      app.prefs.gatewayRegistry.setActive(endpoint.stableId)
      viewModel.connect(endpoint, "synthetic-lifetime-token", null, null)
      drainWithMainLooper { withTimeout(10_000) { probeJob.await() } }
      assertNull(runtime.pendingGatewayTrust.value)
      Shadows.shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
      assertTrue(ConversationReplyNotifier(app).show(target.toComposerOwner(), target.runId, "Synthetic reply"))
      val posted = notificationManager.activeNotifications.single { it.tag == target.notificationTag }
      val notification = posted.notification
      notification.contentIntent.send()
      val launch = requireNotNull(Shadows.shadowOf(app).nextStartedActivity)
      val trampoline = Robolectric.buildActivity(ConversationNotificationLaunchActivity::class.java, launch).create()
      val forwarded =
        try {
          requireNotNull(Shadows.shadowOf(trampoline.get()).nextStartedActivity)
        } finally {
          trampoline.destroy()
        }
      val delivered = requireNotNull(parseConversationNotificationLaunchIntent(forwarded, app.conversationNotificationLaunchStore::take))
      assertEquals(target, delivered)
      val existingOperations =
        viewModel.viewModelScope.coroutineContext.job.children
          .toSet()
      viewModel.openConversationNotification(delivered)
      val notificationOperations =
        viewModel.viewModelScope.coroutineContext.job.children
          .filterNot(existingOperations::contains)
          .toList()
      drainWithMainLooper { withTimeout(10_000) { notificationOperations.joinAll() } }
      assertEquals(HomeDestination.Chat, viewModel.requestedHomeDestination.value)

      val runtimeJob = ReflectionHelpers.getField<CoroutineScope>(runtime, "scope").coroutineContext.job
      val beforeForeground = runtimeJob.children.toSet()
      // Reenter while the probe is still held, not after its trust dialog is published.
      runtime.setForeground(true)
      val foregroundOperations = runtimeJob.children.filterNot(beforeForeground::contains).toList()
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = fingerprint))
      drainWithMainLooper {
        withTimeout(10_000) {
          foregroundOperations.joinAll()
          // A queued reconnect can launch a probe before completing; drain that child too.
          runtimeJob.children
            .filterNot(beforeForeground::contains)
            .toList()
            .joinAll()
          probeJob.await().join()
          runtime.pendingGatewayTrust.first { it != null }
        }
      }

      val prompt = requireNotNull(runtime.pendingGatewayTrust.value) { "The same-target notification retired the original TLS continuation" }
      assertEquals(endpoint.stableId, prompt.endpoint.stableId)
      assertEquals(fingerprint, prompt.fingerprintSha256)
      assertEquals("Notification and foreground reentry must retain the original probe, not replace it", 1, probeCount.get())
      assertEquals("Unapproved TLS trust must not open a Gateway socket", 0, gateway.requestCount)
    } finally {
      runCatching { notificationManager.cancel(target.notificationTag, 1) }
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = fingerprint))
      closeNotificationViewModelFixture(viewModels, viewModel, controller, app, gateway)
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun forgettingInactiveGatewayPreservesSameViewModelHeldTlsAttempt() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    assertNull(app.peekRuntime())
    val probeJob = CompletableDeferred<Job>()
    val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
    val probeCount = AtomicInteger()
    val runtime =
      NodeRuntime(app, app.prefs, tlsFingerprintProbe = { _, _ ->
        probeCount.incrementAndGet()
        probeJob.complete(currentCoroutineContext().job)
        probeResult.await()
      })
    ReflectionHelpers.setField(app, "runtimeInstance", runtime)
    val gateway = lifetimeGateway()
    val active = GatewayEndpoint.manual("127.0.0.1", gateway.port, tlsEnabled = true)
    val inactive = GatewayEndpoint.manual("localhost", gateway.port)
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("inactive-forget", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val fingerprint = "bc".repeat(32)

    try {
      runtime.setForeground(false)
      runtime.disconnect()
      drainWithMainLooper { withTimeout(10_000) { joinRuntimeDisconnectTails(runtime) } }
      assertFalse(active.stableId == inactive.stableId)
      app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(inactive, null))
      app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(active, null))
      app.prefs.gatewayRegistry.setActive(active.stableId)
      viewModel.connect(active, "synthetic-held-b-token", null, null)
      drainWithMainLooper { withTimeout(10_000) { probeJob.await() } }
      val beforeForget =
        viewModel.viewModelScope.coroutineContext.job.children
          .toSet()

      viewModel.forgetGateway(inactive.stableId)
      val forgetOperations =
        viewModel.viewModelScope.coroutineContext.job.children
          .filterNot(beforeForget::contains)
          .toList()
      drainWithMainLooper { withTimeout(10_000) { forgetOperations.joinAll() } }
      assertFalse(
        app.prefs.gatewayRegistry.entries.value
          .any { it.stableId == inactive.stableId },
      )
      assertEquals(active.stableId, app.prefs.gatewayRegistry.activeStableId.value)
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = fingerprint))
      drainWithMainLooper {
        withTimeout(10_000) {
          probeJob.await().join()
          runtime.pendingGatewayTrust.first { it != null }
        }
      }

      val prompt = requireNotNull(runtime.pendingGatewayTrust.value)
      assertEquals(active.stableId, prompt.endpoint.stableId)
      assertEquals(fingerprint, prompt.fingerprintSha256)
      assertEquals(1, probeCount.get())
      assertEquals(0, gateway.requestCount)
    } finally {
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = fingerprint))
      closeNotificationViewModelFixture(viewModels, viewModel, controller, app, gateway)
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun forgottenGatewayNotificationShowsSettingsWithoutDisturbingHealthyGateway() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("forgotten-notification", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val connections = LinkedBlockingQueue<String>()
    val gateway =
      lifetimeGateway { role ->
        connections.add(role)
        bootstrapHello(role)
      }
    val active = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    val forgotten = GatewayEndpoint.manual("localhost", gateway.port)
    val target = ConversationNotificationTarget(forgotten.stableId, "main", "agent:main:forgotten", "forgotten-reply")
    val notificationManager = app.getSystemService(NotificationManager::class.java)

    try {
      viewModel.connect(active, null, "synthetic-bootstrap-token", null)
      drainWithMainLooper {
        withTimeout(10_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value } }
      }
      runtime.switchChatSession("agent:main:healthy-b", "main")
      app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(forgotten, null))
      Shadows.shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
      assertTrue(ConversationReplyNotifier(app).show(target.toComposerOwner(), target.runId, "Synthetic stale reply"))
      val posted = notificationManager.activeNotifications.single { it.tag == target.notificationTag }
      val notification = posted.notification
      val draft = ChatDraft("Keep this B draft", ChatDraftPlacement.Replace, ConversationNotificationTarget(active.stableId, "main", "agent:main:healthy-b", "draft").toComposerOwner())
      viewModel.setChatDraft(draft)
      val beforeForget =
        viewModel.viewModelScope.coroutineContext.job.children
          .toSet()
      viewModel.forgetGateway(forgotten.stableId)
      val forgetOperations =
        viewModel.viewModelScope.coroutineContext.job.children
          .filterNot(beforeForget::contains)
          .toList()
      drainWithMainLooper { withTimeout(10_000) { forgetOperations.joinAll() } }
      assertFalse(
        app.prefs.gatewayRegistry.entries.value
          .any { it.stableId == forgotten.stableId },
      )
      val beforeConnection = runtime.gatewayConnectionDisplay.value
      val beforeCredentials = app.prefs.loadGatewayCredentials(active.stableId)
      val beforeSession = runtime.chatSessionKey.value
      connections.clear()
      ShadowToast.reset()

      notification.contentIntent.send()
      val launch = requireNotNull(Shadows.shadowOf(app).nextStartedActivity)
      val trampoline = Robolectric.buildActivity(ConversationNotificationLaunchActivity::class.java, launch).create()
      val forwarded =
        try {
          requireNotNull(Shadows.shadowOf(trampoline.get()).nextStartedActivity)
        } finally {
          trampoline.destroy()
        }
      val delivered = requireNotNull(parseConversationNotificationLaunchIntent(forwarded, app.conversationNotificationLaunchStore::take))
      assertEquals(target, delivered)
      val beforeOpen =
        viewModel.viewModelScope.coroutineContext.job.children
          .toSet()
      viewModel.openConversationNotification(delivered)
      val openOperations =
        viewModel.viewModelScope.coroutineContext.job.children
          .filterNot(beforeOpen::contains)
          .toList()
      drainWithMainLooper { withTimeout(10_000) { openOperations.joinAll() } }

      assertEquals(nativeString("Gateway unavailable"), ShadowToast.getTextOfLatestToast())
      assertEquals(1, ShadowToast.shownToastCount())
      assertEquals(SettingsRoute.Gateway, viewModel.requestedSettingsRoute.value)
      assertEquals(HomeDestination.Settings, viewModel.requestedHomeDestination.value)
      assertEquals(beforeConnection, runtime.gatewayConnectionDisplay.value)
      assertEquals(active.stableId, app.prefs.gatewayRegistry.activeStableId.value)
      assertEquals(beforeCredentials, app.prefs.loadGatewayCredentials(active.stableId))
      assertEquals(beforeSession, runtime.chatSessionKey.value)
      assertSame(draft, viewModel.chatDraft.value)
      assertTrue(connections.isEmpty())
      assertTrue(runtime.nodeConnected.value)
    } finally {
      runCatching { notificationManager.cancel(target.notificationTag, 1) }
      closeNotificationViewModelFixture(viewModels, viewModel, controller, app, gateway)
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun stoppedColdReplyDoesNotBorrowLaterResumeIntent() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val appShadow = Shadows.shadowOf(app)
    val appFixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val prefs = app.prefs
    appShadow.grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    prefs.setManualTls(false)
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val construction = RuntimeReturnGate()
    val connections = LinkedBlockingQueue<String>()
    val sends = LinkedBlockingQueue<JsonObject>()
    val gateway =
      lifetimeGateway(
        onRequest = { frame ->
          when (frame["method"]?.jsonPrimitive?.content) {
            "chat.history" -> {
              """{"sessionId":"notification-proof-session","messages":[]}"""
            }

            "chat.send" -> {
              val params = requireNotNull(frame["params"]).jsonObject
              sends.add(params)
              """{"runId":${params["idempotencyKey"]},"status":"started"}"""
            }

            else -> {
              "{}"
            }
          }
        },
      ) { role ->
        connections.add(role)
        bootstrapHello(role)
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    val target = ConversationNotificationTarget(endpoint.stableId, "main", "agent:main:notification-proof", "retired-reply")
    val notifier = ConversationReplyNotifier(app)
    val manager = app.getSystemService(NotificationManager::class.java)
    val receiver =
      appShadow.registeredReceivers
        .map { it.broadcastReceiver }
        .filterIsInstance<ConversationReplyReceiver>()
        .single()

    fun replyTo(replyTarget: ConversationNotificationTarget) {
      assertTrue(notifier.show(replyTarget.toComposerOwner(), replyTarget.runId, "Synthetic assistant reply"))
      val notification = manager.activeNotifications.single { it.tag == replyTarget.notificationTag }.notification
      val action = notification.actions.single()
      val fillIn = Intent()
      RemoteInput.addResultsToIntent(
        action.remoteInputs,
        fillIn,
        Bundle().apply { putCharSequence(action.remoteInputs.single().resultKey, "Synthetic follow-up") },
      )
      action.actionIntent.send(app, 0, fillIn)
      Shadows.shadowOf(Looper.getMainLooper()).idle()
    }

    fun joinReply() {
      val receiverShadow = Shadow.extract<ShadowBroadcastReceiver>(receiver)
      assertTrue(receiverShadow.wentAsync())
      val finished = Shadow.extract<ShadowBroadcastPendingResult>(requireNotNull(receiverShadow.originalPendingResult)).future
      drainWithMainLooper {
        withTimeout(10_000) {
          while (!finished.isDone) yield()
          finished.get()
        }
      }
    }

    try {
      prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
      prefs.saveGatewayCredentials(endpoint.stableId, token = "synthetic-lifetime-token")
      assertNull(prefs.gatewayRegistry.activeStableId.value)
      assertNull(app.peekRuntime())
      appFixture.prefsReadGate = construction
      replyTo(target)
      assertTrue("Reply did not enter cold runtime construction", construction.entered.await(10, TimeUnit.SECONDS))

      NodeForegroundService.stop(app)
      val resumed = NodeForegroundService.resume(app, startNow = false)
      assertTrue(resumed())
      appFixture.prefsReadGate = null
      construction.release.countDown()
      joinReply()

      val runtime = requireNotNull(app.peekRuntime())
      assertTrue(connections.isEmpty())
      assertTrue(sends.isEmpty())
      assertNull(prefs.gatewayRegistry.activeStableId.value)
      drainWithMainLooper { assertFalse(runtime.wasChatOutboxCommandAdmitted(conversationNotificationReplyIdempotencyKey(target))) }
      val retained = manager.activeNotifications.single { it.tag == target.notificationTag }.notification
      assertEquals("Synthetic assistant reply", retained.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())

      val fresh = target.copy(runId = "fresh-reply")
      replyTo(fresh)
      joinReply()
      drainWithMainLooper { withTimeout(10_000) { while (sends.isEmpty()) yield() } }
      val sent = requireNotNull(sends.poll())
      assertEquals(fresh.sessionKey, sent["sessionKey"]?.jsonPrimitive?.content)
      assertEquals(conversationNotificationReplyIdempotencyKey(fresh), sent["idempotencyKey"]?.jsonPrimitive?.content)
      assertTrue(sends.isEmpty())
      drainWithMainLooper { assertTrue(runtime.wasChatOutboxCommandAdmitted(conversationNotificationReplyIdempotencyKey(fresh))) }
    } finally {
      appFixture.prefsReadGate = null
      construction.release.countDown()
      try {
        closeNodeServiceTestFixture(controller, app)
      } finally {
        gateway.shutdown()
      }
    }
  }

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun notificationReplyRetiresOriginalIntentAfterPendingSettings() = assertNotificationReplyAfterPendingSettings(retireIntent = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class])
  fun notificationReplyKeepsCurrentIntentAfterPendingSettings() = assertNotificationReplyAfterPendingSettings(retireIntent = false)

  private fun assertNotificationReplyAfterPendingSettings(retireIntent: Boolean) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val viewModel = MainViewModel(app, app.prefs, SavedStateHandle())
    val viewModels = ViewModelStore().apply { put("settings-reply", viewModel) }
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val settingsStarted = CountDownLatch(1)
    val settingsRelease = CountDownLatch(1)
    val connections = LinkedBlockingQueue<String>()
    val sends = LinkedBlockingQueue<JsonObject>()
    val gateway =
      lifetimeGateway(
        onRequest = { frame ->
          when (frame["method"]?.jsonPrimitive?.content) {
            "chat.history" -> {
              """{"sessionId":"notification-settings-session","messages":[]}"""
            }

            "sessions.patch" -> {
              settingsStarted.countDown()
              check(settingsRelease.await(10, TimeUnit.SECONDS)) { "Settings reply was not released" }
              "{}"
            }

            "chat.send" -> {
              val params = requireNotNull(frame["params"]).jsonObject
              sends.add(params)
              """{"runId":${params["idempotencyKey"]},"status":"started"}"""
            }

            else -> {
              "{}"
            }
          }
        },
      ) { role ->
        connections.add(role)
        bootstrapHello(role)
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    val target = ConversationNotificationTarget(endpoint.stableId, "main", "agent:main:notification-settings", "settings-reply")
    val commandId = conversationNotificationReplyIdempotencyKey(target)

    try {
      viewModel.connect(endpoint, null, "synthetic-bootstrap-token", null)
      drainWithMainLooper {
        withTimeout(10_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value } }
      }
      runtime.switchChatSession(target.sessionKey, target.agentId)
      drainWithMainLooper { withTimeout(10_000) { runtime.chatHealthOk.first { it } } }
      val originalIntent = NodeForegroundService.resume(app, startNow = false)
      runtime.setChatThinkingLevel("high")
      assertTrue("Session settings did not reach the real requester", settingsStarted.await(10, TimeUnit.SECONDS))
      assertTrue(target.sessionKey in runtime.chatPendingSessionSettingsKeys.value)
      connections.clear()

      drainWithMainLooper {
        coroutineScope {
          val acceptedAttempt = runtime.switchToGateway(endpoint.stableId) as GatewayTargetSelection.Selected
          val reply =
            async(start = CoroutineStart.UNDISPATCHED) {
              runtime.sendConversationNotificationReply(target, "Synthetic settings reply", commandId, originalIntent)
            }
          assertFalse(reply.isCompleted)
          assertTrue(runtime.canSendForOwner(target.toComposerOwner()))
          if (retireIntent) {
            // The normal owner callback orders Resume before posted disconnect cleanup.
            // Keep the accepted connection so only the original action can reject this send.
            app.updateNodeServiceIntent(allowStart = false) {
              assertTrue(NodeForegroundService.resume(app, startNow = false)())
            }
            assertFalse(originalIntent())
          } else {
            assertTrue(originalIntent())
          }
          assertTrue(acceptedAttempt.isCurrent())
          assertTrue(runtime.gatewayConnectionDisplay.value.isConnected)
          assertEquals(target.sessionKey, runtime.chatSessionKey.value)
          assertTrue(runtime.canSendForOwner(target.toComposerOwner()))
          settingsRelease.countDown()
          assertEquals(!retireIntent, withTimeout(10_000) { reply.await() })
          assertEquals(!retireIntent, runtime.wasChatOutboxCommandAdmitted(commandId))
          assertTrue(acceptedAttempt.isCurrent())
        }
      }
      assertTrue(connections.isEmpty())
      if (retireIntent) {
        assertTrue(sends.isEmpty())
      } else {
        drainWithMainLooper { withTimeout(10_000) { while (sends.isEmpty()) yield() } }
        val sent = requireNotNull(sends.poll())
        assertEquals(commandId, sent["idempotencyKey"]?.jsonPrimitive?.content)
        assertEquals(target.sessionKey, sent["sessionKey"]?.jsonPrimitive?.content)
        assertTrue(sends.isEmpty())
      }
    } finally {
      settingsRelease.countDown()
      closeNotificationViewModelFixture(viewModels, viewModel, controller, app, gateway)
    }
  }

  private fun closeNotificationViewModelFixture(
    viewModels: ViewModelStore,
    viewModel: MainViewModel,
    controller: ServiceController<NodeForegroundService>,
    app: NodeApp,
    gateway: MockWebServer,
  ) {
    try {
      viewModels.clear()
      drainWithMainLooper {
        withTimeout(10_000) {
          viewModel.viewModelScope.coroutineContext.job
            .join()
        }
      }
    } finally {
      try {
        closeNodeServiceTestFixture(controller, app)
      } finally {
        gateway.shutdown()
      }
    }
  }

  private fun disconnectThroughNotification(
    controller: ServiceController<NodeForegroundService>,
    app: NodeApp,
    runtime: NodeRuntime,
  ) {
    val appShadow = Shadows.shadowOf(app)
    generateSequence { appShadow.nextStartedService }.forEachIndexed { index, intent ->
      controller.get().onStartCommand(intent, 0, index + 1)
    }
    val processOwner = ReflectionHelpers.getField<CoroutineScope>(app, "runtimeScope").coroutineContext.job
    val beforeStop = processOwner.children.toSet()
    buildNotification(controller.get())
      .actions
      .single()
      .actionIntent
      .send()
    val stop = requireNotNull(appShadow.nextStartedService)
    assertEquals(Service.START_NOT_STICKY, controller.get().onStartCommand(stop, 0, 100))
    drainWithMainLooper {
      withTimeout(10_000) {
        processOwner.children
          .filterNot(beforeStop::contains)
          .toList()
          .joinAll()
        joinRuntimeDisconnectTails(runtime)
      }
    }
  }

  private suspend fun joinRuntimeDisconnectTails(runtime: NodeRuntime) {
    // Join the tails created by the public Stop; do not issue a second disconnect to obtain a waiter.
    listOf("operatorSession", "nodeSession")
      .mapNotNull { field ->
        val session = ReflectionHelpers.getField<GatewaySession>(runtime, field)
        ReflectionHelpers.getField<Job?>(session, "disconnectTail")
      }.joinAll()
  }

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
      if (action == QueuedGatewayAction.Connect) {
        val initialRoles =
          appFixture.sessionConnections
            .filter { it.endpoint.port == initialGateway.port }
            .map { it.role }
            .toSet()
        assertEquals(setOf("node", "operator"), initialRoles)
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
      if (action == QueuedGatewayAction.Connect) {
        assertTrue(
          "Queued Connect target must remain unknown to background gateway selection",
          app.prefs.gatewayRegistry.entries.value
            .none { it.stableId == nextEndpoint.stableId },
        )
      }
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
      if (action == QueuedGatewayAction.Connect) assertFalse("Call-through probe must not crash the gateway operation", operation.isCancelled)

      if (action == QueuedGatewayAction.Forget) {
        val savedId = GatewayEndpoint.manual("127.0.0.1", initialGateway.port).stableId
        assertTrue(
          "Stop must retire queued Forget before deleting the saved gateway",
          app.prefs.gatewayRegistry.entries.value
            .any { it.stableId == savedId },
        )
      } else if (action == QueuedGatewayAction.Connect) {
        // This unsaved cleartext target reaches session admission before the direct operation returns.
        // Observe admission rather than delayed HTTP arrival; newer activity sockets remain valid.
        assertTrue(
          "Stopped activity work must not admit another Gateway connection",
          appFixture.sessionConnections.none { it.endpoint.stableId == nextEndpoint.stableId },
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
  fun stopRetiresSecondaryConnectionAfterAuthRead() = assertSecondaryAdmissionAfterStop(reenable = false)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun reenablingSecondaryAfterStopRetriesItsPendingAdmission() = assertSecondaryAdmissionAfterStop(reenable = true)

  private fun assertSecondaryAdmissionAfterStop(reenable: Boolean) {
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
      // Capture the held admission's completion before Stop can retire it; the queue below owns the verdict.
      val stoppedAdmission =
        if (reenable) {
          null
        } else {
          ReflectionHelpers.getField<CompletableDeferred<Unit>>(runtime, "gatewayConnectOperationsDrained").also {
            assertFalse("Held secondary admission must remain unfinished", it.isCompleted)
          }
        }
      if (reenable) {
        runtime.disconnect()
        runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
      } else {
        NodeForegroundService.stop(app)
      }
      assertTrue("Stop did not finish its runtime teardown", stoppedNode.await(10, TimeUnit.SECONDS))
      assertNull(fixture.sessionConnections.poll())

      authRead.release.countDown()

      if (reenable) {
        val connection = fixture.sessionConnections.poll(10, TimeUnit.SECONDS)
        assertNotNull("Reenabled admission must reach the session owner", connection)
        assertEquals("operator", connection!!.role)
        assertNotNull("Reenabled admission must reach the Gateway", gateway.takeRequest(10, TimeUnit.SECONDS))
      } else {
        drainWithMainLooper { withTimeout(10_000) { checkNotNull(stoppedAdmission).await() } }
        assertNull("Stopped fleet work must not start an authenticated secondary connection", fixture.sessionConnections.poll())
      }
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
  fun foregroundRoundTripPreservesAcceptedOperatorTokenOrder() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.ForegroundRoundTrip)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun stoppedPrimaryReconnectReadsItsAcceptedOperatorToken() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.PrimaryReconnect)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun focusingSecondaryReadsItsAcceptedOperatorToken() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.SecondaryFocus)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class, ConnectAdmissionShadow::class])
  fun focusingSecondaryKeepsItsAdmittedOperatorWhileHelloPersists() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.SecondaryFocus, holdPrimaryWriteUntilNode = true)

  @Test
  @Config(shadows = [ServiceRuntimePrefsShadow::class, SessionDisconnectShadow::class])
  fun supersededSecondaryFocusPreservesAcceptedOperatorTokenOrder() = assertReconnectDrainsAcceptedOperatorToken(GatewayTokenTransition.SecondaryFocus, supersedeFocus = true)

  private enum class GatewayTokenTransition { SecondaryReenable, PrimaryReconnect, SecondaryFocus, ForegroundRoundTrip }

  private fun assertReconnectDrainsAcceptedOperatorToken(
    transition: GatewayTokenTransition,
    holdPrimaryWriteUntilNode: Boolean = false,
    supersedeFocus: Boolean = false,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app.prefs.setManualTls(false)
    val runtime = app.ensureBackgroundRuntime()
    val viewModel = if (supersedeFocus) MainViewModel(app, app.prefs, SavedStateHandle()) else null
    val viewModels = viewModel?.let { ViewModelStore().apply { put("secondary-focus", it) } }
    val fixture = Shadow.extract<ServiceRuntimePrefsShadow>(app)
    val tokenWrite = RuntimeReturnGate()
    val controller = Robolectric.buildService(NodeForegroundService::class.java).create()
    val helloCount = AtomicInteger()
    val primaryWrite = RuntimeReturnGate()
    val heldNodeHello = RuntimeReturnGate()
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
          if (holdPrimaryWriteUntilNode && heldNodeHello.claimed.compareAndSet(false, true)) {
            heldNodeHello.entered.countDown()
            check(heldNodeHello.release.await(10, TimeUnit.SECONDS)) { "Node hello was not released" }
          }
          """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{}}"""
        }
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.port)
    app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null))
    val undiscoverableId = "undiscoverable-focus-target"
    if (supersedeFocus) {
      app.prefs.gatewayRegistry.upsert(gatewayRegistryEntry(endpoint, null).copy(stableId = undiscoverableId, kind = GatewayRegistryEntryKind.DISCOVERED))
    }
    val deviceId = DeviceIdentityStore.withPrefs(app, app.prefs).loadOrCreate().deviceId
    val authStore = DeviceAuthStore(app.prefs)
    authStore.saveToken(endpoint.stableId, deviceId, "operator", "synthetic-initial-token", listOf("operator.read", "operator.write"))
    assertEquals("synthetic-initial-token", fixture.operatorTokenWrites.tryReceive().getOrNull())

    try {
      viewModel?.setForeground(true)
      runtime.setForeground(true)
      fixture.operatorTokenWriteGate = tokenWrite
      if (transition == GatewayTokenTransition.PrimaryReconnect) {
        runtime.connect(endpoint)
      } else {
        runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
      }
      assertTrue("First operator hello did not reach token persistence", tokenWrite.entered.await(10, TimeUnit.SECONDS))
      if (holdPrimaryWriteUntilNode) fixture.operatorTokenWriteGate = primaryWrite
      val first = generateSequence { fixture.sessionConnections.poll() }.first { it.role == "operator" }.session
      assertEquals("synthetic-initial-token", wireTokens.remove())
      val drained = CompletableDeferred<Unit>()
      Shadow.extract<SessionDisconnectShadow>(first).joinStarted = drained
      val replacement =
        if (supersedeFocus || transition == GatewayTokenTransition.SecondaryReenable || transition == GatewayTokenTransition.ForegroundRoundTrip) {
          first
        } else {
          ReflectionHelpers.getField<GatewaySession>(runtime, "operatorSession")
        }
      val admitted = CompletableDeferred<Unit>()
      Shadow.extract<SessionDisconnectShadow>(replacement).connectStarted = admitted
      val existingOperations =
        viewModel
          ?.let {
            it.viewModelScope.coroutineContext.job.children
              .toSet()
          }.orEmpty()
      when (transition) {
        GatewayTokenTransition.SecondaryReenable -> {
          runtime.setGatewayConnectionEnabled(endpoint.stableId, false)
          runtime.setGatewayConnectionEnabled(endpoint.stableId, true)
        }

        GatewayTokenTransition.ForegroundRoundTrip -> {
          runtime.setForeground(false)
          runtime.setForeground(true)
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
          if (viewModel == null) runtime.connect(endpoint) else viewModel.switchToGateway(endpoint.stableId)
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
          viewModel?.let {
            assertTrue("Promotion must join the accepted write before supersession", waitingForOldOwner)
            it.switchToGateway(undiscoverableId)
          }
        } finally {
          tokenWrite.release.countDown()
        }
        viewModel?.let {
          val operations =
            it.viewModelScope.coroutineContext.job.children
              .filterNot(existingOperations::contains)
              .toList()
          withTimeout(10_000) { operations.joinAll() }
          assertTrue("Superseded UI operations must finish normally", operations.none { it.isCancelled })
          assertTrue("The selecting Activity must remain foreground", runtime.isForeground.value)
        }
        if (holdPrimaryWriteUntilNode) {
          assertTrue("Primary hello did not reach its held persistence", primaryWrite.entered.await(10, TimeUnit.SECONDS))
          assertTrue("Node hello did not reach its held response", heldNodeHello.entered.await(10, TimeUnit.SECONDS))
          val nodeAdmissionFinished = CountDownLatch(1)
          val admission = Shadow.extract<ConnectAdmissionShadow>(runtime)
          admission.lifecycleDecision = nodeAdmissionFinished
          try {
            heldNodeHello.release.countDown()
            assertTrue("Node operator admission did not finish", nodeAdmissionFinished.await(10, TimeUnit.SECONDS))
            assertTrue(runtime.nodeConnected.value)
          } finally {
            admission.lifecycleDecision = null
            primaryWrite.release.countDown()
          }
        }
        withTimeout(10_000) {
          while (completedWrites.size < 2) completedWrites += fixture.operatorTokenWrites.receive()
          if (holdPrimaryWriteUntilNode) {
            runtime.gatewayConnectionDisplay.first { it.isConnected && runtime.nodeConnected.value }
          }
          // Retire the runtime intent before either role is joined; a delayed node hello
          // must not recover an operator socket deliberately closed by this fixture.
          runtime.disconnect()
          replacement.disconnectAndJoin()
        }
      }
      assertEquals(2, helloCount.get())
      assertEquals(
        "A retired hello must not overwrite the newer connection token",
        "synthetic-new-token",
        authStore.loadToken(endpoint.stableId, deviceId, "operator"),
      )
      assertEquals("Reconnect must read auth after the accepted old write", "synthetic-old-token", wireTokens.remove())
      assertEquals(listOf("synthetic-old-token", "synthetic-new-token"), completedWrites)
    } finally {
      primaryWrite.release.countDown()
      heldNodeHello.release.countDown()
      tokenWrite.release.countDown()
      fixture.operatorTokenWriteGate = null
      viewModels?.clear()
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

    @Volatile var lifecycleDecision: CountDownLatch? = null

    @Implementation
    protected fun launchGatewayLifecycle(
      isCurrent: () -> Boolean,
      block: () -> Unit,
    ) {
      val completed = lifecycleDecision
      val observed =
        if (completed == null) {
          block
        } else {
          {
            try {
              block()
            } finally {
              completed.countDown()
            }
          }
        }
      Shadow.directlyOn<Any, NodeRuntime>(
        runtime,
        NodeRuntime::class.java,
        "launchGatewayLifecycle",
        ReflectionHelpers.ClassParameter.from(Function0::class.java, isCurrent),
        ReflectionHelpers.ClassParameter.from(Function0::class.java, observed),
      )
    }

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

  private fun lifetimeGatewayTlsSocketFactory(): SSLSocketFactory {
    val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    val algorithm = AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE)
    val subject = X500Name("CN=notification-tls-test")
    val now = System.currentTimeMillis()
    val tbs =
      V3TBSCertificateGenerator()
        .apply {
          setSerialNumber(ASN1Integer.ONE)
          setSignature(algorithm)
          setIssuer(subject)
          setSubject(subject)
          setValidity(Validity(Time(Date(now - 60_000)), Time(Date(now + 86_400_000))))
          setSubjectPublicKeyInfo(SubjectPublicKeyInfo.getInstance(keyPair.public.encoded))
        }.generateTBSCertificate()
    val signature =
      Signature.getInstance("SHA256withRSA").apply {
        initSign(keyPair.private)
        update(tbs.encoded)
      }
    val encoded = Certificate(tbs, algorithm, DERBitString(signature.sign())).encoded
    val certificate = CertificateFactory.getInstance("X.509").generateCertificate(encoded.inputStream())
    val password = charArrayOf()
    val keyStore =
      KeyStore.getInstance("PKCS12").apply {
        load(null, null)
        setKeyEntry("server", keyPair.private, password, arrayOf(certificate))
      }
    val keyManagers =
      KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
        init(keyStore, password)
      }
    return SSLContext.getInstance("TLS").apply { init(keyManagers.keyManagers, null, null) }.socketFactory
  }

  private fun lifetimeGateway(
    onRequest: (JsonObject) -> String = { "{}" },
    onConnect: ((JsonObject) -> Unit)? = null,
    sslSocketFactory: SSLSocketFactory? = null,
    hello: (String) -> String = {
      """{"type":"hello-ok","server":{"host":"lifetime-proof"},"features":{"methods":[]},"snapshot":{}}"""
    },
  ): MockWebServer =
    MockWebServer().apply {
      sslSocketFactory?.let { useHttps(it, false) }
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
                      onRequest(frame)
                    }
                  webSocket.send("""{"type":"res","id":$id,"ok":true,"payload":$payload}""")
                }
              },
            )
        }
      start(InetAddress.getByName("127.0.0.1"), 0)
    }
}
