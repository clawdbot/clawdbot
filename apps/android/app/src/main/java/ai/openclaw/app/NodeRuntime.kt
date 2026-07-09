package ai.openclaw.app

import ai.openclaw.app.chat.ChatCacheDatabase
import ai.openclaw.app.chat.ChatCacheScope
import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.ChatCommandOutbox
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatTranscriptCache
import ai.openclaw.app.chat.MessageSpeechClient
import ai.openclaw.app.chat.MessageSpeechController
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.chat.RoomChatCommandOutbox
import ai.openclaw.app.chat.RoomChatTranscriptCache
import ai.openclaw.app.chat.SystemSpeechSpeaker
import ai.openclaw.app.gateway.DeviceAuthEntry
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayDiscovery
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.gateway.GatewayUpdateAvailableSummary
import ai.openclaw.app.gateway.NetworkMonitor
import ai.openclaw.app.gateway.NodeEventSendOutcome
import ai.openclaw.app.gateway.formatGatewayAuthority
import ai.openclaw.app.gateway.normalizeGatewayApprovalRequestId
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprint
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.gateway.probeGatewayTlsFingerprint
import ai.openclaw.app.node.A2UIHandler
import ai.openclaw.app.node.CalendarHandler
import ai.openclaw.app.node.CallLogHandler
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.CameraHandler
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.node.ContactsHandler
import ai.openclaw.app.node.DEFAULT_SEAM_COLOR_ARGB
import ai.openclaw.app.node.DebugHandler
import ai.openclaw.app.node.DeviceHandler
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.node.LocationCaptureManager
import ai.openclaw.app.node.LocationHandler
import ai.openclaw.app.node.MotionHandler
import ai.openclaw.app.node.NodePresenceAliveBeacon
import ai.openclaw.app.node.NotificationsHandler
import ai.openclaw.app.node.PhotosHandler
import ai.openclaw.app.node.Quad
import ai.openclaw.app.node.SmsHandler
import ai.openclaw.app.node.SmsManager
import ai.openclaw.app.node.SystemHandler
import ai.openclaw.app.node.TalkHandler
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import ai.openclaw.app.node.invokeErrorFromThrowable
import ai.openclaw.app.node.parseHexColorArgb
import ai.openclaw.app.protocol.OpenClawCanvasA2UIAction
import ai.openclaw.app.voice.GatewayTranscriptionSession
import ai.openclaw.app.voice.MicCaptureManager
import ai.openclaw.app.voice.TalkAudioPlayer
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.TalkPttOnceStart
import ai.openclaw.app.voice.TalkPttStopPayload
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceConversationRole
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val MAX_PENDING_NOTIFICATION_EVENTS = 128
private const val NODE_APPROVAL_COMMAND_FRESH_MS = 30_000L
private const val OperatorAdminScope = "operator.admin"

private enum class SkillWorkshopGatewayAction(
  val methodSuffix: String,
  val expectedStatus: String,
  val notice: String,
  val verb: String,
) {
  Apply("apply", "applied", "Proposal applied.", "apply"),
  Reject("reject", "rejected", "Proposal rejected.", "reject"),
  Quarantine("quarantine", "quarantined", "Proposal quarantined.", "quarantine"),
}

internal data class PendingNotificationNodeEvent(
  val event: String,
  val payloadJson: String?,
  val gatewayId: String? = null,
)

private data class QueuedNotificationNodeEvent(
  val generation: Long,
  val event: PendingNotificationNodeEvent,
)

internal class NotificationNodeEventOutbox(
  private val capacity: Int = MAX_PENDING_NOTIFICATION_EVENTS,
  private val isAuthorized: (PendingNotificationNodeEvent) -> Boolean = { true },
  private val isConnected: () -> Boolean = { true },
  private val deliveryIntervalMs: () -> Long = { 0L },
  private val nowEpochMs: () -> Long = System::currentTimeMillis,
  private val sleep: suspend (Long) -> Unit = { delay(it) },
  private val invalidateConnection: () -> Unit = {},
  private val send: suspend (PendingNotificationNodeEvent) -> NodeEventSendOutcome,
) {
  private val stateLock = Any()
  private val generation = AtomicLong()
  private val lastDeliveryAtMs = AtomicLong(-1L)
  private val pending = ArrayDeque<QueuedNotificationNodeEvent>(capacity)
  private val wakeDelivery = Channel<Unit>(Channel.CONFLATED)
  private var inFlight: QueuedNotificationNodeEvent? = null

  init {
    require(capacity > 0) { "capacity must be positive" }
  }

  fun enqueue(event: PendingNotificationNodeEvent) {
    synchronized(stateLock) {
      if (pending.size == capacity) pending.removeFirst()
      pending.addLast(QueuedNotificationNodeEvent(generation = generation.get(), event = event))
    }
    wakeDelivery.trySend(Unit)
  }

  fun clear() {
    synchronized(stateLock) {
      clearLocked()
    }
    wakeDelivery.trySend(Unit)
  }

  fun <T> updatePolicy(update: () -> T): T {
    val result =
      synchronized(stateLock) {
        // Admission checks share this lock, so the new policy is visible before the next generation.
        update().also { clearLocked() }
      }
    wakeDelivery.trySend(Unit)
    return result
  }

  fun onConnected() {
    wakeDelivery.trySend(Unit)
  }

  suspend fun deliver() {
    while (true) {
      wakeDelivery.receive()
      while (true) {
        val queued = synchronized(stateLock) { pending.firstOrNull() } ?: break
        if (queued.generation != generation.get() || !isAuthorized(queued.event)) {
          synchronized(stateLock) {
            if (pending.firstOrNull() === queued) pending.removeFirst()
          }
          continue
        }
        if (!isConnected()) break
        if (!awaitDeliverySlot(queued)) continue
        val admitted =
          synchronized(stateLock) {
            if (
              pending.firstOrNull() !== queued ||
              queued.generation != generation.get() ||
              !isAuthorized(queued.event) ||
              !isConnected()
            ) {
              false
            } else {
              pending.removeFirst()
              inFlight = queued
              true
            }
          }
        if (!admitted) continue

        val outcome = send(queued.event)
        synchronized(stateLock) {
          if (inFlight === queued) inFlight = null
          if (queued.generation == generation.get() && isAuthorized(queued.event)) {
            when (outcome) {
              NodeEventSendOutcome.COMPLETED -> lastDeliveryAtMs.set(nowEpochMs())
              NodeEventSendOutcome.DISCONNECTED -> {
                // This outcome is rejected before send, so it is safe to retain for reconnect.
                if (pending.size == capacity) pending.removeLast()
                pending.addFirst(queued)
              }
              // Ambiguous failures may have reached the gateway: do not retry, but charge their rate slot.
              NodeEventSendOutcome.FAILED -> lastDeliveryAtMs.set(nowEpochMs())
            }
          }
        }
        if (outcome == NodeEventSendOutcome.DISCONNECTED) break
      }
    }
  }

  private suspend fun awaitDeliverySlot(queued: QueuedNotificationNodeEvent): Boolean {
    while (queued.generation == generation.get() && isAuthorized(queued.event)) {
      val lastDelivery = lastDeliveryAtMs.get()
      if (lastDelivery < 0L) return true
      val waitMs = lastDelivery + deliveryIntervalMs().coerceAtLeast(0L) - nowEpochMs()
      if (waitMs <= 0L) return true
      // Short slices make policy/gateway invalidation responsive without charging stale quota.
      sleep(minOf(waitMs, 250L))
    }
    return false
  }

  private fun clearLocked() {
    // Only an admitted RPC needs transport invalidation; queued payloads have no socket side effect.
    if (inFlight?.generation == generation.get()) invalidateConnection()
    generation.incrementAndGet()
    lastDeliveryAtMs.set(-1L)
    pending.clear()
  }
}

/**
 * Process runtime that owns gateway sessions, node command handlers, capture managers, and UI-facing state.
 */
data class GatewayConnectionProblem(
  val code: String?,
  val message: String,
  val reason: String?,
  val requestId: String?,
  val recommendedNextStep: String?,
  val pauseReconnect: Boolean,
  val retryable: Boolean,
  val clientMinProtocol: Int? = null,
  val clientMaxProtocol: Int? = null,
  val expectedProtocol: Int? = null,
  val minimumProbeProtocol: Int? = null,
) {
  val isPairingRequired: Boolean = code == "PAIRING_REQUIRED"
  val canAutoRetry: Boolean =
    isPairingRequired &&
      (
        retryable ||
          !pauseReconnect ||
          recommendedNextStep == "wait_then_retry"
      )
}

data class GatewayConnectionDisplay(
  val isConnected: Boolean,
  val statusText: String,
  val problem: GatewayConnectionProblem?,
)

private fun gatewayProblemAfterDisconnect(
  problem: GatewayConnectionProblem?,
  statusText: String,
): GatewayConnectionProblem? =
  // Automatic bootstrap pairing retries need their approval guidance until success or a different failure.
  problem?.takeIf { statusText == "Reconnecting…" && it.canAutoRetry }

internal fun gatewayConnectionDisplay(
  operatorConnected: Boolean,
  nodeConnected: Boolean,
  operatorStatusText: String,
  nodeStatusText: String,
  operatorProblem: GatewayConnectionProblem?,
  nodeProblem: GatewayConnectionProblem?,
): GatewayConnectionDisplay {
  val operator = operatorStatusText.trim()
  val node = nodeStatusText.trim()
  return when {
    operatorConnected && nodeConnected -> GatewayConnectionDisplay(true, "Connected", null)
    operatorConnected -> GatewayConnectionDisplay(true, "Connected (node offline)", nodeProblem)
    nodeConnected ->
      GatewayConnectionDisplay(
        isConnected = false,
        statusText =
          if (operator.isNotEmpty() && operator != "Offline") {
            "Connected (operator: $operator)"
          } else {
            "Connected (operator offline)"
          },
        problem = operatorProblem,
      )
    operator.isNotBlank() && operator != "Offline" -> GatewayConnectionDisplay(false, operator, operatorProblem)
    else -> GatewayConnectionDisplay(false, node, nodeProblem)
  }
}

private data class AndroidChatStores(
  val transcriptCache: ChatTranscriptCache,
  val commandOutbox: ChatCommandOutbox,
)

internal enum class NodeRuntimeMode {
  Live,
  ScreenshotFixture,
}

private fun openAndroidChatStores(context: Context): AndroidChatStores {
  val database = ChatCacheDatabase.open(context.applicationContext)
  return AndroidChatStores(
    transcriptCache = RoomChatTranscriptCache(database),
    commandOutbox = RoomChatCommandOutbox(database),
  )
}

class NodeRuntime private constructor(
  context: Context,
  val prefs: SecurePrefs,
  private val tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult,
  chatStores: AndroidChatStores,
  internal val mode: NodeRuntimeMode,
) {
  private val chatTranscriptCache = chatStores.transcriptCache
  private val chatCommandOutbox = chatStores.commandOutbox
  private val gatewayAuthLifecycleLock = Any()
  private var gatewayAuthResetInProgress = false
  private var gatewayConnectOperationsInFlight = 0
  private var gatewayConnectOperationsDrained = CompletableDeferred(Unit)

  @Volatile private var connectingEndpointStableId: String? = null
  private val gatewayDataScopeLock = Any()
  private val gatewaySwitchMutex = Mutex()
  private val gatewayLifecycleIntentLock = Any()
  private val gatewayLifecycleIntentSeq = AtomicLong()
  private var gatewayDataGeneration = 0L

  private data class GatewayDataScope(
    val stableId: String,
    val generation: Long,
  )

  constructor(
    context: Context,
    prefs: SecurePrefs = SecurePrefs(context.applicationContext),
    tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult = ::probeGatewayTlsFingerprint,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = tlsFingerprintProbe,
    chatStores = openAndroidChatStores(context),
    mode = NodeRuntimeMode.Live,
  )

  internal constructor(
    context: Context,
    prefs: SecurePrefs,
    mode: NodeRuntimeMode,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = ::probeGatewayTlsFingerprint,
    chatStores = openAndroidChatStores(context),
    mode = mode,
  )

  internal constructor(
    context: Context,
    prefs: SecurePrefs,
    chatTranscriptCache: ChatTranscriptCache,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = ::probeGatewayTlsFingerprint,
    chatStores =
      AndroidChatStores(
        transcriptCache = chatTranscriptCache,
        commandOutbox = RoomChatCommandOutbox(ChatCacheDatabase.open(context.applicationContext)),
      ),
    mode = NodeRuntimeMode.Live,
  )

  /**
   * Authentication material supplied by setup/manual connect flows before gateway session routing.
   */
  data class GatewayConnectAuth(
    val token: String?,
    val bootstrapToken: String?,
    val password: String?,
  )

  /**
   * HTTP(S) page origin of the connected gateway plus the shared credential a
   * gateway-served page (e.g. the `?view=terminal` Control UI document) can
   * authenticate with. Derived from the same endpoint/auth the WS sessions use.
   */
  data class GatewayControlPage(
    val baseUrl: String,
    val token: String?,
    val password: String?,
  )

  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val deviceAuthStore = DeviceAuthStore(prefs)
  val canvas = CanvasController()
  val camera = CameraCaptureManager(appContext)
  val location = LocationCaptureManager(appContext)
  val sms = SmsManager(appContext)
  private val json = Json { ignoreUnknownKeys = true }

  private val externalAudioCaptureActive = MutableStateFlow(false)
  private val _voiceCaptureMode = MutableStateFlow(VoiceCaptureMode.Off)
  val voiceCaptureMode: StateFlow<VoiceCaptureMode> = _voiceCaptureMode.asStateFlow()

  private val discovery = GatewayDiscovery(appContext, scope = scope)
  val gateways: StateFlow<List<GatewayEndpoint>> = discovery.gateways
  val discoveryStatusText: StateFlow<String> = discovery.statusText

  private val identityStore = DeviceIdentityStore(appContext)
  private var connectedEndpoint: GatewayEndpoint? = null
  private var activeGatewayAuth: GatewayConnectAuth? = null

  private val cameraHandler: CameraHandler =
    CameraHandler(
      appContext = appContext,
      camera = camera,
      externalAudioCaptureActive = externalAudioCaptureActive,
      showCameraHud = ::showCameraHud,
      invokeErrorFromThrowable = { invokeErrorFromThrowable(it) },
    )

  private val debugHandler: DebugHandler =
    DebugHandler(
      appContext = appContext,
      identityStore = identityStore,
    )

  private val locationHandler: LocationHandler =
    LocationHandler(
      appContext = appContext,
      location = location,
      json = json,
      isForeground = { _isForeground.value },
      locationMode = { locationMode.value },
      backgroundLocationEnabled = { SensitiveFeatureConfig.backgroundLocationEnabled },
      locationPreciseEnabled = { locationPreciseEnabled.value },
    )

  private val deviceHandler: DeviceHandler =
    DeviceHandler(
      appContext = appContext,
      smsEnabled = SensitiveFeatureConfig.smsEnabled,
      callLogEnabled = SensitiveFeatureConfig.callLogEnabled,
    )

  private val notificationsHandler: NotificationsHandler =
    NotificationsHandler(
      appContext = appContext,
    )

  private val systemHandler: SystemHandler =
    SystemHandler(
      appContext = appContext,
    )

  private val photosHandler: PhotosHandler =
    PhotosHandler(
      appContext = appContext,
    )

  private val contactsHandler: ContactsHandler =
    ContactsHandler(
      appContext = appContext,
    )

  private val calendarHandler: CalendarHandler =
    CalendarHandler(
      appContext = appContext,
    )

  private val callLogHandler: CallLogHandler =
    CallLogHandler(
      appContext = appContext,
    )

  private val motionHandler: MotionHandler =
    MotionHandler(
      appContext = appContext,
    )

  private val smsHandlerImpl: SmsHandler =
    SmsHandler(
      sms = sms,
    )

  private val a2uiHandler: A2UIHandler =
    A2UIHandler(
      canvas = canvas,
      json = json,
    )

  private val connectionManager: ConnectionManager =
    ConnectionManager(
      prefs = prefs,
      cameraEnabled = { cameraEnabled.value },
      locationMode = { locationMode.value },
      voiceWakeMode = { VoiceWakeMode.Off },
      motionActivityAvailable = { motionHandler.isActivityAvailable() },
      motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
      sendSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canSendSms() },
      readSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canReadSms() },
      smsSearchPossible = { SensitiveFeatureConfig.smsEnabled && sms.hasTelephonyFeature() },
      callLogAvailable = { SensitiveFeatureConfig.callLogEnabled },
      photosAvailable = { SensitiveFeatureConfig.photosEnabled },
      hasRecordAudioPermission = { hasRecordAudioPermission() },
      installedAppsSharingEnabled = { installedAppsSharingEnabled.value },
      manualTls = { endpoint ->
        prefs.gatewayRegistry.entries.value
          .firstOrNull { it.stableId == endpoint.stableId }
          ?.tls ?: manualTls.value
      },
    )

  private val invokeDispatcher: InvokeDispatcher =
    InvokeDispatcher(
      canvas = canvas,
      cameraHandler = cameraHandler,
      locationHandler = locationHandler,
      deviceHandler = deviceHandler,
      notificationsHandler = notificationsHandler,
      systemHandler = systemHandler,
      talkHandler =
        object : TalkHandler {
          override suspend fun handlePttStart(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttStart()

          override suspend fun handlePttStop(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttStop()

          override suspend fun handlePttCancel(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttCancel()

          override suspend fun handlePttOnce(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttOnce()
        },
      photosHandler = photosHandler,
      contactsHandler = contactsHandler,
      calendarHandler = calendarHandler,
      motionHandler = motionHandler,
      smsHandler = smsHandlerImpl,
      a2uiHandler = a2uiHandler,
      debugHandler = debugHandler,
      callLogHandler = callLogHandler,
      isForeground = { _isForeground.value },
      cameraEnabled = { cameraEnabled.value },
      locationEnabled = { locationMode.value != LocationMode.Off },
      sendSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canSendSms() },
      readSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canReadSms() },
      smsFeatureEnabled = { SensitiveFeatureConfig.smsEnabled },
      smsTelephonyAvailable = { sms.hasTelephonyFeature() },
      callLogAvailable = { SensitiveFeatureConfig.callLogEnabled },
      photosAvailable = { SensitiveFeatureConfig.photosEnabled },
      installedAppsSharingEnabled = { installedAppsSharingEnabled.value },
      debugBuild = { BuildConfig.DEBUG },
      onCanvasA2uiPush = {
        _canvasA2uiHydrated.value = true
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
      },
      onCanvasA2uiReset = { _canvasA2uiHydrated.value = false },
      motionActivityAvailable = { motionHandler.isActivityAvailable() },
      motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
    )

  /**
   * Pending TLS trust decision when a gateway certificate is new or has changed.
   */
  data class GatewayTrustPrompt(
    val endpoint: GatewayEndpoint,
    val fingerprintSha256: String,
    val auth: GatewayConnectAuth,
    val previousFingerprintSha256: String? = null,
  )

  data class VoiceE2eSliceResult(
    val mode: String,
    val status: String,
    val userText: String?,
    val assistantText: String?,
  )

  data class VoiceE2eResult(
    val normal: VoiceE2eSliceResult?,
    val realtime: VoiceE2eSliceResult?,
  )

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()
  private val _gatewayControlPage = MutableStateFlow<GatewayControlPage?>(null)
  val gatewayControlPage: StateFlow<GatewayControlPage?> = _gatewayControlPage.asStateFlow()
  private val _nodeConnected = MutableStateFlow(false)
  val nodeConnected: StateFlow<Boolean> = _nodeConnected.asStateFlow()
  private val _nodeCapabilityApproval = MutableStateFlow<GatewayNodeCapabilityApproval>(GatewayNodeCapabilityApproval.Loading)
  val nodeCapabilityApproval: StateFlow<GatewayNodeCapabilityApproval> = _nodeCapabilityApproval.asStateFlow()

  private val _gatewayConnectionDisplay = MutableStateFlow(GatewayConnectionDisplay(false, "Offline", null))
  val gatewayConnectionDisplay: StateFlow<GatewayConnectionDisplay> = _gatewayConnectionDisplay.asStateFlow()
  private val _statusText = MutableStateFlow("Offline")
  val statusText: StateFlow<String> = _statusText.asStateFlow()
  private val _gatewayConnectionProblem = MutableStateFlow<GatewayConnectionProblem?>(null)
  val gatewayConnectionProblem: StateFlow<GatewayConnectionProblem?> = _gatewayConnectionProblem.asStateFlow()
  private val _operatorScopes = MutableStateFlow<List<String>>(emptyList())
  val operatorScopes: StateFlow<List<String>> = _operatorScopes.asStateFlow()
  val operatorAdminScopeAvailable: StateFlow<Boolean> =
    operatorScopes
      .map { scopes -> scopes.any { it == OperatorAdminScope } }
      .stateIn(scope, SharingStarted.Eagerly, false)

  private val _pendingGatewayTrust = MutableStateFlow<GatewayTrustPrompt?>(null)
  val pendingGatewayTrust: StateFlow<GatewayTrustPrompt?> = _pendingGatewayTrust.asStateFlow()
  private val connectAttemptSeq = AtomicLong(0)

  /**
   * Builds the node-owned session key from stable device identity plus optional active agent.
   */
  private fun resolveNodeMainSessionKey(agentId: String? = null): String {
    val deviceId = identityStore.loadOrCreate().deviceId
    return buildNodeMainSessionKey(deviceId, agentId)
  }

  private val _mainSessionKey = MutableStateFlow(resolveNodeMainSessionKey())
  val mainSessionKey: StateFlow<String> = _mainSessionKey.asStateFlow()

  private val cameraHudSeq = AtomicLong(0)
  private val _cameraHud = MutableStateFlow<CameraHudState?>(null)
  val cameraHud: StateFlow<CameraHudState?> = _cameraHud.asStateFlow()

  private val _canvasA2uiHydrated = MutableStateFlow(false)
  val canvasA2uiHydrated: StateFlow<Boolean> = _canvasA2uiHydrated.asStateFlow()
  private val _canvasRehydratePending = MutableStateFlow(false)
  val canvasRehydratePending: StateFlow<Boolean> = _canvasRehydratePending.asStateFlow()
  private val _canvasRehydrateErrorText = MutableStateFlow<String?>(null)
  val canvasRehydrateErrorText: StateFlow<String?> = _canvasRehydrateErrorText.asStateFlow()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()

  private val _remoteAddress = MutableStateFlow<String?>(null)
  val remoteAddress: StateFlow<String?> = _remoteAddress.asStateFlow()

  private val _gatewayVersion = MutableStateFlow<String?>(null)
  val gatewayVersion: StateFlow<String?> = _gatewayVersion.asStateFlow()

  private val _gatewayUpdateAvailable = MutableStateFlow<GatewayUpdateAvailableSummary?>(null)
  val gatewayUpdateAvailable: StateFlow<GatewayUpdateAvailableSummary?> = _gatewayUpdateAvailable.asStateFlow()

  private val _seamColorArgb = MutableStateFlow(DEFAULT_SEAM_COLOR_ARGB)
  val seamColorArgb: StateFlow<Long> = _seamColorArgb.asStateFlow()
  private val _modelCatalog = MutableStateFlow<List<GatewayModelSummary>>(emptyList())
  val modelCatalog: StateFlow<List<GatewayModelSummary>> = _modelCatalog.asStateFlow()
  private val _modelAuthProviders = MutableStateFlow<List<GatewayModelProviderSummary>>(emptyList())
  val modelAuthProviders: StateFlow<List<GatewayModelProviderSummary>> = _modelAuthProviders.asStateFlow()
  private val _modelCatalogRefreshing = MutableStateFlow(false)
  val modelCatalogRefreshing: StateFlow<Boolean> = _modelCatalogRefreshing.asStateFlow()
  private val _modelCatalogErrorText = MutableStateFlow<String?>(null)
  val modelCatalogErrorText: StateFlow<String?> = _modelCatalogErrorText.asStateFlow()
  private val _talkSetupReadiness = MutableStateFlow(GatewayTalkSetupReadiness.unverified())
  val talkSetupReadiness: StateFlow<GatewayTalkSetupReadiness> = _talkSetupReadiness.asStateFlow()
  private val _gatewayDefaultAgentId = MutableStateFlow<String?>(null)
  val gatewayDefaultAgentId: StateFlow<String?> = _gatewayDefaultAgentId.asStateFlow()
  private val _gatewayAgents = MutableStateFlow<List<GatewayAgentSummary>>(emptyList())
  val gatewayAgents: StateFlow<List<GatewayAgentSummary>> = _gatewayAgents.asStateFlow()

  // Preserve an explicit user choice across metadata refreshes. Gateway reconnects
  // clear it so the newly connected gateway's canonical main agent wins again.
  @Volatile private var selectedChatAgentId: String? = null
  private val _cronStatus = MutableStateFlow(GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null))
  val cronStatus: StateFlow<GatewayCronStatus> = _cronStatus.asStateFlow()
  private val _cronJobs = MutableStateFlow<List<GatewayCronJobSummary>>(emptyList())
  val cronJobs: StateFlow<List<GatewayCronJobSummary>> = _cronJobs.asStateFlow()
  private val _cronRefreshing = MutableStateFlow(false)
  val cronRefreshing: StateFlow<Boolean> = _cronRefreshing.asStateFlow()
  private val _cronErrorText = MutableStateFlow<String?>(null)
  val cronErrorText: StateFlow<String?> = _cronErrorText.asStateFlow()
  private val _cronJobDetailState = MutableStateFlow<GatewayCronJobDetailState>(GatewayCronJobDetailState.Idle)
  val cronJobDetailState: StateFlow<GatewayCronJobDetailState> = _cronJobDetailState.asStateFlow()
  private val cronJobDetailRequestGuard = CronJobDetailRequestGuard()
  private val _usageSummary = MutableStateFlow(GatewayUsageSummary(updatedAtMs = null, providers = emptyList()))
  val usageSummary: StateFlow<GatewayUsageSummary> = _usageSummary.asStateFlow()
  private val _usageRefreshing = MutableStateFlow(false)
  val usageRefreshing: StateFlow<Boolean> = _usageRefreshing.asStateFlow()
  private val _usageErrorText = MutableStateFlow<String?>(null)
  val usageErrorText: StateFlow<String?> = _usageErrorText.asStateFlow()
  private val _skillsSummary = MutableStateFlow(GatewaySkillsSummary(skills = emptyList()))
  val skillsSummary: StateFlow<GatewaySkillsSummary> = _skillsSummary.asStateFlow()
  private val _skillsRefreshing = MutableStateFlow(false)
  val skillsRefreshing: StateFlow<Boolean> = _skillsRefreshing.asStateFlow()
  private val _skillsErrorText = MutableStateFlow<String?>(null)
  val skillsErrorText: StateFlow<String?> = _skillsErrorText.asStateFlow()
  private val _skillWorkshopSummary = MutableStateFlow(GatewaySkillWorkshopSummary(proposals = emptyList()))
  val skillWorkshopSummary: StateFlow<GatewaySkillWorkshopSummary> = _skillWorkshopSummary.asStateFlow()
  private val _skillWorkshopRefreshing = MutableStateFlow(false)
  val skillWorkshopRefreshing: StateFlow<Boolean> = _skillWorkshopRefreshing.asStateFlow()
  private val _skillWorkshopErrorText = MutableStateFlow<String?>(null)
  val skillWorkshopErrorText: StateFlow<String?> = _skillWorkshopErrorText.asStateFlow()
  private val _skillWorkshopNoticeText = MutableStateFlow<String?>(null)
  val skillWorkshopNoticeText: StateFlow<String?> = _skillWorkshopNoticeText.asStateFlow()
  private val _skillWorkshopInspectingProposalId = MutableStateFlow<String?>(null)
  val skillWorkshopInspectingProposalId: StateFlow<String?> = _skillWorkshopInspectingProposalId.asStateFlow()
  private val _skillWorkshopMutatingProposalId = MutableStateFlow<String?>(null)
  val skillWorkshopMutatingProposalId: StateFlow<String?> = _skillWorkshopMutatingProposalId.asStateFlow()
  private val skillWorkshopListSeq = AtomicLong(0)
  private val skillWorkshopInspectSeq = AtomicLong(0)
  private val skillWorkshopMutationSeq = AtomicLong(0)
  private val _nodesDevicesSummary =
    MutableStateFlow(
      GatewayNodesDevicesSummary(
        nodes = emptyList(),
        pendingDevices = emptyList(),
        pairedDevices = emptyList(),
      ),
    )
  val nodesDevicesSummary: StateFlow<GatewayNodesDevicesSummary> = _nodesDevicesSummary.asStateFlow()
  private val _nodesDevicesRefreshing = MutableStateFlow(false)
  val nodesDevicesRefreshing: StateFlow<Boolean> = _nodesDevicesRefreshing.asStateFlow()
  private val _nodesDevicesErrorText = MutableStateFlow<String?>(null)
  val nodesDevicesErrorText: StateFlow<String?> = _nodesDevicesErrorText.asStateFlow()
  private val nodeApprovalRefreshGuard = GatewayNodeApprovalRefreshGuard()
  private val _execApprovals = MutableStateFlow<List<GatewayExecApprovalSummary>>(emptyList())
  val execApprovals: StateFlow<List<GatewayExecApprovalSummary>> = _execApprovals.asStateFlow()
  private val _execApprovalsRefreshing = MutableStateFlow(false)
  val execApprovalsRefreshing: StateFlow<Boolean> = _execApprovalsRefreshing.asStateFlow()
  private val _execApprovalsErrorText = MutableStateFlow<String?>(null)
  val execApprovalsErrorText: StateFlow<String?> = _execApprovalsErrorText.asStateFlow()
  private val execApprovalsRefreshSeq = AtomicLong(0)
  private val execApprovalsStateLock = Any()
  private val resolvedExecApprovalIds = Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())
  private val _channelsSummary = MutableStateFlow(GatewayChannelsSummary(channels = emptyList()))
  val channelsSummary: StateFlow<GatewayChannelsSummary> = _channelsSummary.asStateFlow()
  private val _channelsRefreshing = MutableStateFlow(false)
  val channelsRefreshing: StateFlow<Boolean> = _channelsRefreshing.asStateFlow()
  private val _channelsErrorText = MutableStateFlow<String?>(null)
  val channelsErrorText: StateFlow<String?> = _channelsErrorText.asStateFlow()
  private val _dreamingSummary = MutableStateFlow(GatewayDreamingSummary())
  val dreamingSummary: StateFlow<GatewayDreamingSummary> = _dreamingSummary.asStateFlow()
  private val _dreamingRefreshing = MutableStateFlow(false)
  val dreamingRefreshing: StateFlow<Boolean> = _dreamingRefreshing.asStateFlow()
  private val _dreamingErrorText = MutableStateFlow<String?>(null)
  val dreamingErrorText: StateFlow<String?> = _dreamingErrorText.asStateFlow()
  private val _healthLogsSummary = MutableStateFlow(GatewayHealthLogsSummary())
  val healthLogsSummary: StateFlow<GatewayHealthLogsSummary> = _healthLogsSummary.asStateFlow()
  private val _healthLogsRefreshing = MutableStateFlow(false)
  val healthLogsRefreshing: StateFlow<Boolean> = _healthLogsRefreshing.asStateFlow()
  private val _healthLogsErrorText = MutableStateFlow<String?>(null)
  val healthLogsErrorText: StateFlow<String?> = _healthLogsErrorText.asStateFlow()

  private val _isForeground = MutableStateFlow(true)
  val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

  private data class TalkPttOwnership(
    val captureId: String,
    val epoch: Long,
  )

  private val voiceLifecycleEpoch = AtomicLong()
  private val voiceCaptureOwnershipEpoch = AtomicLong()
  private val talkPttCommandEpoch = AtomicLong()
  private val talkPttOwnership = AtomicReference<TalkPttOwnership?>()

  // Keep ownership epochs and their service/capture state transitions atomic.
  // Otherwise stale PTT cleanup can pass its epoch check before a UI mode change.
  private val voiceCaptureOwnershipLock = Any()
  private var voiceNoteOwnsMic = false
  private val voiceCapturePreparationMutex = Mutex()

  private var didAutoRequestCanvasRehydrate = false
  private val canvasRehydrateSeq = AtomicLong(0)

  @Volatile private var nodePresenceAliveLastSuccessAtMs: Long? = null
  private var operatorConnected = false
  private var operatorStatusText: String = "Offline"
  private var nodeStatusText: String = "Offline"
  private var operatorConnectionProblem: GatewayConnectionProblem? = null
  private var nodeConnectionProblem: GatewayConnectionProblem? = null
  private val gatewayStatusLock = Any()

  private val operatorSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { hello ->
        recordConnectedGateway()
        _serverName.value = hello.serverName
        _remoteAddress.value = hello.remoteAddress
        _gatewayVersion.value = hello.serverVersion
        _gatewayUpdateAvailable.value = hello.updateAvailable
        _operatorScopes.value = normalizeOperatorScopes(hello.authScopes)
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        syncMainSessionKey(resolveAgentIdFromMainSessionKey(hello.mainSessionKey))
        // Every successful connection refreshes history; reconnects preserve local run ownership.
        chat.onGatewayConnected()
        refreshGatewayControlPage()
        updateStatus {
          operatorConnectionProblem = null
          operatorConnected = true
          operatorStatusText = "Connected"
        }
        micCapture.onGatewayConnectionChanged(true)
        scope.launch {
          subscribeOperatorSessionEvents()
          refreshExecApprovalsFromGateway()
          refreshHomeCanvasOverviewIfConnected()
          if (voiceReplySpeakerLazy.isInitialized()) {
            voiceReplySpeaker.refreshConfig()
          }
        }
      },
      onDisconnected = { message ->
        clearOperatorGatewayState()
        chat.applyMainSessionKey(resolveMainSessionKey())
        chat.onDisconnected(message)
        updateStatus {
          operatorConnected = false
          operatorStatusText = message
          operatorConnectionProblem = gatewayProblemAfterDisconnect(operatorConnectionProblem, message)
        }
        micCapture.onGatewayConnectionChanged(false)
      },
      onConnectFailure = { error, pauseReconnect ->
        updateStatus {
          operatorConnectionProblem = gatewayConnectionProblem(error, pauseReconnect)
        }
      },
      onEvent = { event, payloadJson ->
        handleGatewayEvent(event, payloadJson)
      },
      customHeadersProvider = prefs::loadGatewayCustomHeaders,
    )

  private fun clearOperatorGatewayState() {
    invalidateNodeCapabilityApprovalState()
    _serverName.value = null
    _remoteAddress.value = null
    _gatewayVersion.value = null
    _gatewayUpdateAvailable.value = null
    _operatorScopes.value = emptyList()
    _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
    _gatewayDefaultAgentId.value = null
    _gatewayAgents.value = emptyList()
    selectedChatAgentId = null
    _modelCatalog.value = emptyList()
    _modelAuthProviders.value = emptyList()
    _modelCatalogRefreshing.value = false
    _modelCatalogErrorText.value = null
    _talkSetupReadiness.value = GatewayTalkSetupReadiness.unverified()
    _cronStatus.value = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)
    _cronJobs.value = emptyList()
    _cronRefreshing.value = false
    _cronErrorText.value = null
    cronJobDetailRequestGuard.cancel { _cronJobDetailState.value = GatewayCronJobDetailState.Idle }
    _usageSummary.value = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())
    _usageRefreshing.value = false
    _usageErrorText.value = null
    _skillsSummary.value = GatewaySkillsSummary(skills = emptyList())
    _skillsRefreshing.value = false
    _skillsErrorText.value = null
    _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(proposals = emptyList())
    _skillWorkshopRefreshing.value = false
    _skillWorkshopErrorText.value = null
    _skillWorkshopNoticeText.value = null
    _skillWorkshopInspectingProposalId.value = null
    _skillWorkshopMutatingProposalId.value = null
    skillWorkshopListSeq.incrementAndGet()
    skillWorkshopInspectSeq.incrementAndGet()
    skillWorkshopMutationSeq.incrementAndGet()
    _nodesDevicesSummary.value =
      GatewayNodesDevicesSummary(
        nodes = emptyList(),
        pendingDevices = emptyList(),
        pairedDevices = emptyList(),
      )
    invalidateExecApprovalRefreshes()
    resolvedExecApprovalIds.clear()
    _execApprovals.value = emptyList()
    _execApprovalsRefreshing.value = false
    _execApprovalsErrorText.value = null
    _channelsSummary.value = GatewayChannelsSummary(channels = emptyList())
    _channelsRefreshing.value = false
    _channelsErrorText.value = null
    _dreamingSummary.value = GatewayDreamingSummary()
    _dreamingRefreshing.value = false
    _dreamingErrorText.value = null
    _healthLogsSummary.value = GatewayHealthLogsSummary()
    _healthLogsRefreshing.value = false
    _healthLogsErrorText.value = null
  }

  private suspend fun subscribeOperatorSessionEvents() {
    try {
      operatorSession.request("sessions.subscribe", null)
    } catch (err: Throwable) {
      Log.d("OpenClawRuntime", "sessions.subscribe failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private val nodeSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = {
        recordConnectedGateway()
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus {
          nodeConnectionProblem = null
          _nodeConnected.value = true
          nodeStatusText = "Connected"
        }
        notificationOutbox.onConnected()
        showLocalCanvasOnConnect()
        publishNodePresenceAliveBeacon(NodePresenceAliveBeacon.Trigger.Connect)
        val endpoint = connectedEndpoint
        val auth = activeGatewayAuth
        if (operatorConnected) {
          scope.launch { refreshNodesDevicesFromGateway() }
        } else if (endpoint != null && auth != null) {
          maybeStartOperatorSessionAfterNodeConnect(endpoint, auth)
        }
      },
      onDisconnected = { message ->
        invalidateNodeCapabilityApprovalState()
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus {
          _nodeConnected.value = false
          nodeStatusText = message
          nodeConnectionProblem = gatewayProblemAfterDisconnect(nodeConnectionProblem, message)
        }
        showLocalCanvasOnDisconnect()
      },
      onConnectFailure = { error, pauseReconnect ->
        updateStatus {
          nodeConnectionProblem = gatewayConnectionProblem(error, pauseReconnect)
        }
        if (operatorConnected && nodeConnectFailureNeedsApprovalRefresh(error)) {
          scope.launch { refreshNodesDevicesFromGateway() }
        }
      },
      onEvent = { _, _ -> },
      onInvoke = { req ->
        invokeDispatcher.handleInvoke(req.command, req.paramsJson)
      },
      onTlsFingerprint = { stableId, fingerprint ->
        prefs.saveGatewayTlsFingerprint(stableId, fingerprint)
      },
      customHeadersProvider = prefs::loadGatewayCustomHeaders,
    )

  /**
   * Triggers an immediate gateway reconnect when Android reports a validated transport
   * restore, instead of waiting for the time-based backoff slot in [GatewaySession].
   * Each session keeps ownership of desired-connection and auth-pause decisions.
   */
  private val networkMonitor = NetworkMonitor(appContext, ::retryGatewaySessionsAfterNetworkRestore)

  private fun retryGatewaySessionsAfterNetworkRestore() {
    launchGatewayLifecycle {
      operatorSession.retryAfterNetworkRestore()
      nodeSession.retryAfterNetworkRestore()
    }
  }

  private val notificationOutbox: NotificationNodeEventOutbox by lazy {
    NotificationNodeEventOutbox(
      isAuthorized = ::isNotificationEventStillAuthorized,
      isConnected = nodeSession::isReady,
      deliveryIntervalMs = ::notificationDeliveryIntervalMs,
      invalidateConnection = nodeSession::reconnect,
      send = { pending ->
        nodeSession.sendNodeEventWithOutcomeForEndpoint(
          expectedEndpointStableId = pending.gatewayId,
          event = pending.event,
          payloadJson = pending.payloadJson,
        )
      },
    )
  }

  private fun notificationDeliveryIntervalMs(): Long {
    val maxEvents =
      prefs.notificationForwardingMaxEventsPerMinute.value
        .coerceAtLeast(1)
        .toLong()
    return (60_000L + maxEvents - 1L) / maxEvents
  }

  private fun isNotificationEventStillAuthorized(event: PendingNotificationNodeEvent): Boolean {
    if (event.event != "notifications.changed") return false
    if (!DeviceNotificationListenerService.isAccessEnabled(appContext)) return false
    val payload =
      runCatching { event.payloadJson?.let(json::parseToJsonElement).asObjectOrNull() }
        .getOrNull()
        ?: return false
    val packageName = payload["packageName"].asStringOrNull()?.trim().orEmpty()
    if (packageName.isEmpty()) return false
    val policy = prefs.getNotificationForwardingPolicy(appPackageName = appContext.packageName)
    if (event.gatewayId != null && event.gatewayId != prefs.gatewayRegistry.activeStableId.value) return false
    val eventSessionKey = payload["sessionKey"].asStringOrNull()?.trim()?.ifEmpty { null }
    return policy.enabled &&
      policy.sessionKey == eventSessionKey &&
      policy.allowsPackage(packageName) &&
      !policy.isWithinQuietHours(nowEpochMs = System.currentTimeMillis())
  }

  init {
    if (mode == NodeRuntimeMode.Live) {
      scope.launch { notificationOutbox.deliver() }
      DeviceNotificationListenerService.setNodeEventSink { event, payloadJson ->
        notificationOutbox.enqueue(
          PendingNotificationNodeEvent(
            event = event,
            payloadJson = payloadJson,
            gatewayId = prefs.gatewayRegistry.activeStableId.value,
          ),
        )
      }
    }
  }

  private val chat: ChatController =
    when (mode) {
      NodeRuntimeMode.Live ->
        ChatController(
          scope = scope,
          session = operatorSession,
          json = json,
          transcriptCache = chatTranscriptCache,
          cacheScope = ::chatCacheScope,
          commandOutbox = chatCommandOutbox,
          recordModelRecent = prefs::recordModelRecent,
        )
      NodeRuntimeMode.ScreenshotFixture ->
        ChatController(
          scope = scope,
          json = json,
          requestGateway = AndroidScreenshotFixture::request,
        )
    }.also {
      it.applyMainSessionKey(_mainSessionKey.value)
    }

  private val messageSpeechControllerLazy =
    lazy {
      MessageSpeechController(
        scope = scope,
        synthesizer = MessageSpeechClient(session = operatorSession, json = json),
        player = TalkAudioPlayer(appContext),
        localSpeech = SystemSpeechSpeaker(appContext),
      )
    }
  private val messageSpeechController: MessageSpeechController
    get() = messageSpeechControllerLazy.value
  internal val messageSpeechState: StateFlow<MessageSpeechState?>
    get() = messageSpeechController.state

  /**
   * Stable per-gateway scope for the offline chat cache; resolved per call so cached transcripts
   * never leak across gateways. Null (nothing paired/configured) disables cache reads and writes.
   */
  private fun chatCacheGatewayId(): String? {
    connectedEndpoint?.stableId?.let { return it }
    return prefs.gatewayRegistry.activeStableId.value
  }

  private fun chatCacheScope(): ChatCacheScope? =
    chatCacheGatewayId()?.let { gatewayId ->
      ChatCacheScope(gatewayId = gatewayId, connectionGeneration = connectAttemptSeq.get())
    }

  private val voiceReplySpeakerLazy: Lazy<TalkModeManager> =
    lazy {
      // Reuse the existing TalkMode speech engine for native Android TTS playback
      // without enabling the legacy talk capture loop.
      TalkModeManager(
        context = appContext,
        scope = scope,
        session = operatorSession,
        isConnected = { gatewayConnectionDisplay.value.isConnected },
        gatewayStableId = { connectedEndpoint?.stableId },
        onBeforeSpeak = { micCapture.pauseForTts() },
        onAfterSpeak = { micCapture.resumeAfterTts() },
      ).also { speaker ->
        speaker.setPlaybackEnabled(prefs.speakerEnabled.value)
      }
    }
  private val voiceReplySpeaker: TalkModeManager
    get() = voiceReplySpeakerLazy.value

  private val micCapture: MicCaptureManager by lazy {
    MicCaptureManager(
      context = appContext,
      scope = scope,
      createTranscriptionSession = {
        val gatewayId = connectedEndpoint?.stableId ?: error("not connected")
        val params =
          buildJsonObject {
            put("mode", JsonPrimitive("transcription"))
            put("transport", JsonPrimitive("gateway-relay"))
            put("brain", JsonPrimitive("none"))
          }
        val response =
          operatorSession.requestForEndpoint(
            gatewayId,
            "talk.session.create",
            params.toString(),
            timeoutMs = 15_000,
          )
        GatewayTranscriptionSession(
          id = parseTalkSessionId(response),
          gatewayId = gatewayId,
        )
      },
      appendTranscriptionAudio = { session, audio, onError ->
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(session.id))
            put("audioBase64", JsonPrimitive(Base64.encodeToString(audio, Base64.NO_WRAP)))
            put("timestamp", JsonPrimitive(SystemClock.elapsedRealtime()))
          }
        operatorSession.sendRequestFrameForEndpoint(
          session.gatewayId,
          "talk.session.appendAudio",
          params.toString(),
          timeoutMs = 8_000,
        ) { error -> onError(error.message) }
      },
      closeTranscriptionSession = { session ->
        val params = buildJsonObject { put("sessionId", JsonPrimitive(session.id)) }
        operatorSession.requestForEndpoint(
          session.gatewayId,
          "talk.session.close",
          params.toString(),
          timeoutMs = 5_000,
        )
      },
      sendToGateway = { message, onRunIdKnown ->
        val gatewayId = connectedEndpoint?.stableId ?: error("not connected")
        val idempotencyKey = UUID.randomUUID().toString()
        // Notify MicCaptureManager of the idempotency key *before* the network
        // call so pendingRunId is set before any chat events can arrive.
        onRunIdKnown(idempotencyKey)
        val params =
          buildJsonObject {
            put("sessionKey", JsonPrimitive(resolveMainSessionKey()))
            put("message", JsonPrimitive(message))
            put("thinking", JsonPrimitive(chatThinkingLevel.value))
            put("timeoutMs", JsonPrimitive(30_000))
            put("idempotencyKey", JsonPrimitive(idempotencyKey))
          }
        val response = operatorSession.requestForEndpoint(gatewayId, "chat.send", params.toString())
        val ack = parseChatSendAck(json, response)
        ack.copy(runId = ack.runId ?: idempotencyKey)
      },
      refreshAfterTerminalSuccess = {
        chat.refresh()
      },
      speakAssistantReply = { text ->
        // Voice-tab replies should speak through the dedicated reply speaker.
        // Relying on talkMode.ttsOnAllResponses here can drop playback if the
        // chat-event path misses the terminal event for this turn.
        voiceReplySpeaker.speakAssistantReply(text)
      },
    )
  }

  val micStatusText: StateFlow<String>
    get() = micCapture.statusText

  val micLiveTranscript: StateFlow<String?>
    get() = micCapture.liveTranscript

  val micIsListening: StateFlow<Boolean>
    get() = micCapture.isListening

  val micEnabled: StateFlow<Boolean>
    get() = micCapture.micEnabled

  val micCooldown: StateFlow<Boolean>
    get() = micCapture.micCooldown

  val micQueuedMessages: StateFlow<List<String>>
    get() = micCapture.queuedMessages

  val micConversation: StateFlow<List<VoiceConversationEntry>>
    get() = micCapture.conversation

  val micInputLevel: StateFlow<Float>
    get() = micCapture.inputLevel

  val micIsSending: StateFlow<Boolean>
    get() = micCapture.isSending

  private val talkMode: TalkModeManager by lazy {
    TalkModeManager(
      context = appContext,
      scope = scope,
      session = operatorSession,
      isConnected = { gatewayConnectionDisplay.value.isConnected },
      gatewayStableId = { connectedEndpoint?.stableId },
      onBeforeSpeak = { micCapture.pauseForTts() },
      onAfterSpeak = { micCapture.resumeAfterTts() },
      onStoppedByRelay = { finishTalkModeAfterRelayClose() },
    )
  }

  val talkModeEnabled: StateFlow<Boolean>
    get() = talkMode.isEnabled

  val talkModeListening: StateFlow<Boolean>
    get() = talkMode.isListening

  val talkModeSpeaking: StateFlow<Boolean>
    get() = talkMode.isSpeaking

  val talkModeStatusText: StateFlow<String>
    get() = talkMode.statusText

  val talkModeConversation: StateFlow<List<VoiceConversationEntry>>
    get() = talkMode.conversation

  private fun syncMainSessionKey(agentId: String?) {
    val resolvedKey = resolveNodeMainSessionKey(agentId)
    // Always push the resolved session key into TalkMode, even when the
    // state flow value is unchanged, so lazy TalkMode instances do not
    // stay on the default "main" session key.
    talkMode.setMainSessionKey(resolvedKey)
    if (_mainSessionKey.value == resolvedKey) return
    _mainSessionKey.value = resolvedKey
    chat.applyMainSessionKey(resolvedKey)
    updateHomeCanvasState()
  }

  private fun updateStatus(update: () -> Unit = {}) {
    synchronized(gatewayStatusLock) {
      update()
      // Select and publish text plus diagnostics atomically; operator and node callbacks run concurrently.
      val display =
        gatewayConnectionDisplay(
          operatorConnected = operatorConnected,
          nodeConnected = _nodeConnected.value,
          operatorStatusText = operatorStatusText,
          nodeStatusText = nodeStatusText,
          operatorProblem = operatorConnectionProblem,
          nodeProblem = nodeConnectionProblem,
        )
      _gatewayConnectionDisplay.value = display
      _isConnected.value = display.isConnected
      _statusText.value = display.statusText
      _gatewayConnectionProblem.value = display.problem
    }
    updateHomeCanvasState()
  }

  private fun setStandaloneGatewayStatus(statusText: String) {
    synchronized(gatewayStatusLock) {
      val display = GatewayConnectionDisplay(operatorConnected, statusText, null)
      _gatewayConnectionDisplay.value = display
      _isConnected.value = display.isConnected
      _statusText.value = display.statusText
      _gatewayConnectionProblem.value = display.problem
    }
    updateHomeCanvasState()
  }

  private fun gatewayConnectionProblem(
    error: GatewaySession.ErrorShape,
    pauseReconnect: Boolean,
  ): GatewayConnectionProblem {
    val details = error.details
    return GatewayConnectionProblem(
      code = details?.code ?: error.code,
      message = error.message,
      reason = details?.reason,
      requestId = details?.requestId,
      recommendedNextStep = details?.recommendedNextStep,
      pauseReconnect = pauseReconnect || details?.pauseReconnect == true,
      retryable = details?.retryable == true,
      clientMinProtocol = details?.clientMinProtocol,
      clientMaxProtocol = details?.clientMaxProtocol,
      expectedProtocol = details?.expectedProtocol,
      minimumProbeProtocol = details?.minimumProbeProtocol,
    )
  }

  private fun resolveMainSessionKey(): String {
    val trimmed = _mainSessionKey.value.trim()
    return if (trimmed.isEmpty()) "main" else trimmed
  }

  private fun showLocalCanvasOnConnect() {
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  private fun showLocalCanvasOnDisconnect() {
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  fun refreshHomeCanvasOverviewIfConnected() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (!operatorConnected) {
      updateHomeCanvasState()
      return
    }
    scope.launch {
      refreshBrandingFromGateway()
      refreshAgentsFromGateway()
      refreshModelCatalogFromGateway()
      refreshTalkSetupReadinessFromGateway()
      refreshCronFromGateway()
      refreshUsageFromGateway()
      refreshSkillsFromGateway()
      refreshNodesDevicesFromGateway()
      refreshChannelsFromGateway()
      refreshDreamingFromGateway()
      refreshHealthLogsFromGateway()
    }
  }

  fun refreshModelCatalog() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshModelCatalogFromGateway()
    }
  }

  fun refreshTalkSetupReadiness() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch { refreshTalkSetupReadinessFromGateway() }
  }

  fun refreshAgents() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshAgentsFromGateway()
    }
  }

  fun refreshCronJobs() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshCronFromGateway()
    }
  }

  fun loadCronJobDetail(id: String) {
    val request = cronJobDetailRequestGuard.begin(id) ?: return
    _cronJobDetailState.value = GatewayCronJobDetailState.Loading(request.id)
    scope.launch {
      loadCronJobDetailFromGateway(request)
    }
  }

  fun clearCronJobDetail() {
    cronJobDetailRequestGuard.cancel {
      _cronJobDetailState.value = GatewayCronJobDetailState.Idle
    }
  }

  fun refreshUsage() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshUsageFromGateway()
    }
  }

  fun refreshSkills() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshSkillsFromGateway()
    }
  }

  fun refreshSkillWorkshopProposals(agentId: String? = null) {
    scope.launch {
      refreshSkillWorkshopProposalsFromGateway(agentId = agentId)
    }
  }

  fun resetSkillWorkshopAgentScope(agentId: String? = null) {
    val normalizedAgentId = normalizeSkillWorkshopAgentId(agentId)
    skillWorkshopListSeq.incrementAndGet()
    skillWorkshopInspectSeq.incrementAndGet()
    skillWorkshopMutationSeq.incrementAndGet()
    _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = normalizedAgentId, proposals = emptyList())
    _skillWorkshopRefreshing.value = false
    _skillWorkshopErrorText.value = null
    _skillWorkshopNoticeText.value = null
    _skillWorkshopInspectingProposalId.value = null
    _skillWorkshopMutatingProposalId.value = null
  }

  fun inspectSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    val normalized = proposalId.trim()
    if (normalized.isEmpty()) return
    scope.launch {
      inspectSkillWorkshopProposalFromGateway(proposalId = normalized, agentId = agentId)
    }
  }

  fun applySkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    mutateSkillWorkshopProposal(proposalId = proposalId, agentId = agentId, action = SkillWorkshopGatewayAction.Apply)
  }

  fun rejectSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    mutateSkillWorkshopProposal(proposalId = proposalId, agentId = agentId, action = SkillWorkshopGatewayAction.Reject)
  }

  fun quarantineSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    mutateSkillWorkshopProposal(proposalId = proposalId, agentId = agentId, action = SkillWorkshopGatewayAction.Quarantine)
  }

  private fun mutateSkillWorkshopProposal(
    proposalId: String,
    agentId: String?,
    action: SkillWorkshopGatewayAction,
  ) {
    val normalized = proposalId.trim()
    if (normalized.isEmpty()) return
    scope.launch {
      mutateSkillWorkshopProposalOnGateway(proposalId = normalized, agentId = agentId, action = action)
    }
  }

  fun clearSkillWorkshopMessage() {
    _skillWorkshopErrorText.value = null
    _skillWorkshopNoticeText.value = null
  }

  fun refreshNodesDevices() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshNodesDevicesFromGateway()
    }
  }

  fun refreshExecApprovals() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshExecApprovalsFromGateway()
    }
  }

  fun resolveExecApproval(
    id: String,
    decision: String,
  ) {
    val normalizedId = id.trim()
    val normalizedDecision = decision.trim()
    if (normalizedId.isEmpty() || normalizedDecision.isEmpty()) return
    scope.launch {
      resolveExecApprovalOnGateway(id = normalizedId, decision = normalizedDecision)
    }
  }

  fun refreshChannels() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshChannelsFromGateway()
    }
  }

  fun refreshDreaming() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshDreamingFromGateway()
    }
  }

  fun refreshHealthLogs() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshHealthLogsFromGateway()
    }
  }

  fun requestCanvasRehydrate(
    source: String = "manual",
    force: Boolean = true,
  ) {
    val gatewayId = connectedEndpoint?.stableId
    scope.launch {
      if (gatewayId == null || !_nodeConnected.value) {
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = "Node offline. Reconnect and retry."
        return@launch
      }
      if (!force && didAutoRequestCanvasRehydrate) return@launch
      didAutoRequestCanvasRehydrate = true
      val requestId = canvasRehydrateSeq.incrementAndGet()
      _canvasRehydratePending.value = true
      _canvasRehydrateErrorText.value = null

      val sessionKey = resolveMainSessionKey()
      val prompt =
        "Restore canvas now for session=$sessionKey source=$source. " +
          "If existing A2UI state exists, replay it immediately. " +
          "If not, create and render a compact mobile-friendly dashboard in Canvas."
      val sent =
        nodeSession.sendNodeEventForEndpoint(
          expectedEndpointStableId = gatewayId,
          event = "agent.request",
          payloadJson =
            buildJsonObject {
              put("message", JsonPrimitive(prompt))
              put("sessionKey", JsonPrimitive(sessionKey))
              put("thinking", JsonPrimitive("low"))
              put("deliver", JsonPrimitive(false))
            }.toString(),
        )
      if (!sent) {
        if (!force) {
          didAutoRequestCanvasRehydrate = false
        }
        if (canvasRehydrateSeq.get() == requestId) {
          _canvasRehydratePending.value = false
          _canvasRehydrateErrorText.value = "Failed to request restore. Tap to retry."
        }
        Log.w("OpenClawCanvas", "canvas rehydrate request failed ($source): transport unavailable")
        return@launch
      }
      scope.launch {
        delay(20_000)
        if (canvasRehydrateSeq.get() != requestId) return@launch
        if (!_canvasRehydratePending.value) return@launch
        if (_canvasA2uiHydrated.value) return@launch
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = "No canvas update yet. Tap to retry."
      }
    }
  }

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val locationMode: StateFlow<LocationMode> = prefs.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = prefs.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = prefs.preventSleep
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val manualTls: StateFlow<Boolean> = prefs.manualTls
  val onboardingCompleted: StateFlow<Boolean> = prefs.onboardingCompleted

  /** Clears setup credentials plus paired device tokens for both Android gateway roles. */
  suspend fun resetGatewaySetupAuth(stableId: String): Boolean =
    gatewayLifecycleIntentSeq.incrementAndGet().let { intent ->
      gatewaySwitchMutex.withLock {
        if (intent != gatewayLifecycleIntentSeq.get()) false else resetGatewaySetupAuthLocked(stableId)
      }
    }

  private suspend fun resetGatewaySetupAuthLocked(stableId: String): Boolean {
    val connectOperationsDrained =
      synchronized(gatewayAuthLifecycleLock) {
        if (gatewayAuthResetInProgress) {
          null
        } else {
          gatewayAuthResetInProgress = true
          gatewayConnectOperationsDrained
        }
      }
        ?: return false
    return try {
      connectOperationsDrained.await()
      if (connectedEndpoint?.stableId == stableId) {
        disconnectAndJoin()
      }
      if (connectingEndpointStableId == stableId) {
        connectAttemptSeq.incrementAndGet()
        connectingEndpointStableId = null
        _pendingGatewayTrust.value = null
        chat.onGatewayScopeChanging(retireRunState = true)
      }
      drainIdleGatewaySessionTails()
      // A deliberate disconnect retains reconnect ownership. Authentication replacement does not.
      chat.onGatewayScopeChanging(retireRunState = true)
      // Replacing authentication retires the old identity even when the endpoint is unchanged.
      // Purge only that gateway; ordinary switches retain every gateway's offline state.
      val cacheCleared =
        runCatching { chat.clearGatewayCache(stableId) }
          .onFailure { err ->
            Log.e("OpenClawRuntime", "Failed to purge gateway chat data before auth reset", err)
            setStandaloneGatewayStatus("Failed: couldn't clear offline chat data. Retry sign out.")
          }.isSuccess
      if (!cacheCleared) return false
      prefs.clearGatewayCredentials(stableId)
      val deviceId = identityStore.loadOrCreate().deviceId
      deviceAuthStore.clearToken(stableId, deviceId, "node")
      deviceAuthStore.clearToken(stableId, deviceId, "operator")
      true
    } finally {
      synchronized(gatewayAuthLifecycleLock) { gatewayAuthResetInProgress = false }
    }
  }

  /** Persists onboarding state; callers decide whether runtime startup is needed first. */
  fun setOnboardingCompleted(value: Boolean) = prefs.setOnboardingCompleted(value)

  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId
  val pairedGateways: StateFlow<List<GatewayRegistryEntry>> = prefs.gatewayRegistry.entries
  val activeGatewayStableId: StateFlow<String?> = prefs.gatewayRegistry.activeStableId
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled
  val installedAppsSharingEnabled: StateFlow<Boolean> = prefs.installedAppsSharingEnabled
  val notificationForwardingEnabled: StateFlow<Boolean> = prefs.notificationForwardingEnabled
  val notificationForwardingMode: StateFlow<NotificationPackageFilterMode> =
    prefs.notificationForwardingMode
  val notificationForwardingPackages: StateFlow<Set<String>> = prefs.notificationForwardingPackages
  val notificationForwardingQuietHoursEnabled: StateFlow<Boolean> =
    prefs.notificationForwardingQuietHoursEnabled
  val notificationForwardingQuietStart: StateFlow<String> = prefs.notificationForwardingQuietStart
  val notificationForwardingQuietEnd: StateFlow<String> = prefs.notificationForwardingQuietEnd
  val notificationForwardingMaxEventsPerMinute: StateFlow<Int> =
    prefs.notificationForwardingMaxEventsPerMinute
  val notificationForwardingSessionKey: StateFlow<String?> = prefs.notificationForwardingSessionKey

  private var didAutoConnect = false

  val chatSessionKey: StateFlow<String> = chat.sessionKey
  val chatSessionId: StateFlow<String?> = chat.sessionId
  val chatMessages: StateFlow<List<ChatMessage>> = chat.messages
  val chatHistoryLoading: StateFlow<Boolean> = chat.historyLoading
  val chatError: StateFlow<String?> = chat.errorText
  val chatHealthOk: StateFlow<Boolean> = chat.healthOk
  val chatThinkingLevel: StateFlow<String> = chat.thinkingLevel
  val chatSelectedModelRef: StateFlow<String?> = chat.selectedModelRef
  val chatModelCatalog: StateFlow<List<GatewayModelSummary>> = chat.modelCatalog
  val chatStreamingAssistantText: StateFlow<String?> = chat.streamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = chat.pendingToolCalls
  val chatSessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val pendingRunCount: StateFlow<Int> = chat.pendingRunCount
  val chatCommands: StateFlow<List<ChatCommandEntry>> = chat.commands
  val chatOutboxItems: StateFlow<List<ChatOutboxItem>> = chat.outboxItems

  fun retryChatOutboxCommand(id: String) = chat.retryOutboxCommand(id)

  fun deleteChatOutboxCommand(id: String) = chat.deleteOutboxCommand(id)

  private fun applyScreenshotFixture() {
    check(BuildConfig.DEBUG) { "Android screenshot fixtures require a debug build" }
    _serverName.value = "OpenClaw Gateway"
    _remoteAddress.value = "Mac Studio on local network"
    _gatewayVersion.value = BuildConfig.VERSION_NAME
    _gatewayDefaultAgentId.value = "main"
    _gatewayAgents.value = AndroidScreenshotFixture.agents
    _modelCatalog.value = AndroidScreenshotFixture.models
    _modelAuthProviders.value = AndroidScreenshotFixture.providers
    _talkSetupReadiness.value =
      GatewayTalkSetupReadiness(
        realtimeTalk = GatewayTalkSetupState.Ready(GatewayTalkProvider("openai", "OpenAI")),
        dictation = GatewayTalkSetupState.Ready(GatewayTalkProvider("openai", "OpenAI")),
      )
    _cronStatus.value =
      GatewayCronStatus(
        enabled = true,
        jobs = 2,
        nextWakeAtMs = 1_783_641_600_000,
      )
    _nodesDevicesSummary.value = AndroidScreenshotFixture.nodes
    _channelsSummary.value = AndroidScreenshotFixture.channels
    _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Approved
    _mainSessionKey.value = AndroidScreenshotFixture.mainSessionKey
    chat.applyMainSessionKey(AndroidScreenshotFixture.mainSessionKey)
    updateStatus {
      operatorConnected = true
      operatorStatusText = "Connected"
      _nodeConnected.value = true
      nodeStatusText = "Connected"
      operatorConnectionProblem = null
      nodeConnectionProblem = null
    }
    chat.refreshSessions(limit = 20)
  }

  init {
    if (mode == NodeRuntimeMode.Live) {
      if (prefs.voiceWakeMode.value != VoiceWakeMode.Off) {
        prefs.setVoiceWakeMode(VoiceWakeMode.Off)
      }

      if (prefs.voiceMicEnabled.value) {
        setVoiceCaptureMode(VoiceCaptureMode.ManualMic, persistManualMic = false)
      }

      scope.launch(Dispatchers.Default) {
        gateways.collect { list ->
          seedLastDiscoveredGateway(list)
          autoConnectIfNeeded()
        }
      }
    } else {
      applyScreenshotFixture()
    }

    scope.launch {
      combine(
        canvasDebugStatusEnabled,
        statusText,
        serverName,
        remoteAddress,
      ) { debugEnabled, status, server, remote ->
        Quad(debugEnabled, status, server, remote)
      }.distinctUntilChanged()
        .collect { (debugEnabled, status, server, remote) ->
          canvas.setDebugStatusEnabled(debugEnabled)
          if (!debugEnabled) return@collect
          canvas.setDebugStatus(status, server ?: remote)
        }
    }

    updateHomeCanvasState()
  }

  /** Updates foreground state and triggers reconnect/presence behavior on app visibility changes. */
  fun setForeground(value: Boolean) {
    _isForeground.value = value
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (!value) {
      voiceLifecycleEpoch.incrementAndGet()
    }
    if (value) {
      reconnectPreferredGatewayOnForeground()
      scope.launch {
        refreshExecApprovalsFromGateway()
      }
    } else {
      stopMessageSpeech()
      stopActiveVoiceSession()
      publishNodePresenceAliveBeacon(NodePresenceAliveBeacon.Trigger.Background, throttleRecentSuccess = true)
    }
  }

  private fun publishNodePresenceAliveBeacon(
    trigger: NodePresenceAliveBeacon.Trigger,
    throttleRecentSuccess: Boolean = false,
  ) {
    val gatewayId = connectedEndpoint?.stableId ?: return
    scope.launch {
      sendNodePresenceAliveBeacon(
        gatewayId = gatewayId,
        trigger = trigger,
        throttleRecentSuccess = throttleRecentSuccess,
      )
    }
  }

  private suspend fun sendNodePresenceAliveBeacon(
    gatewayId: String,
    trigger: NodePresenceAliveBeacon.Trigger,
    throttleRecentSuccess: Boolean,
  ) {
    if (!_nodeConnected.value) return
    val nowMs = System.currentTimeMillis()
    if (
      throttleRecentSuccess &&
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        nowMs = nowMs,
        lastSuccessAtMs = nodePresenceAliveLastSuccessAtMs,
      )
    ) {
      return
    }

    val client = connectionManager.buildClientInfo(clientId = "openclaw-android", clientMode = "node")
    val payloadJson =
      NodePresenceAliveBeacon.makePayloadJson(
        trigger = trigger,
        sentAtMs = nowMs,
        displayName = client.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: "Android",
        version = client.version,
        platform = NodePresenceAliveBeacon.androidPlatformLabel(),
        deviceFamily = client.deviceFamily,
        modelIdentifier = client.modelIdentifier,
      )
    val result =
      nodeSession.sendNodeEventDetailedForEndpoint(
        expectedEndpointStableId = gatewayId,
        event = NodePresenceAliveBeacon.EVENT_NAME,
        payloadJson = payloadJson,
      )
    if (!result.ok) return
    val response = NodePresenceAliveBeacon.decodeResponse(result.payloadJson)
    if (response?.handled == true) {
      nodePresenceAliveLastSuccessAtMs = nowMs
    } else {
      Log.d(
        "OpenClawNode",
        "node.presence.alive not handled: ${NodePresenceAliveBeacon.sanitizeReasonForLog(response?.reason)}",
      )
    }
  }

  private fun seedLastDiscoveredGateway(list: List<GatewayEndpoint>) {
    if (list.isEmpty()) return
    if (lastDiscoveredStableId.value.trim().isNotEmpty()) return
    prefs.setLastDiscoveredStableId(list.first().stableId)
  }

  private fun resolvePreferredGatewayEndpoint(): GatewayEndpoint? {
    val entry = prefs.gatewayRegistry.activeEntry() ?: return null
    return when (entry.kind) {
      GatewayRegistryEntryKind.MANUAL -> {
        val host = entry.host?.trim().orEmpty()
        val port = entry.port ?: return null
        if (host.isEmpty() || port !in 1..65535) return null
        GatewayEndpoint.manual(host = host, port = port)
      }
      GatewayRegistryEntryKind.DISCOVERED -> {
        val endpoint = gateways.value.firstOrNull { it.stableId == entry.stableId } ?: return null
        val storedFingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim().orEmpty()
        endpoint.takeIf { storedFingerprint.isNotEmpty() }
      }
    }
  }

  suspend fun switchToGateway(stableId: String): Boolean {
    val entry =
      prefs.gatewayRegistry.entries.value
        .firstOrNull { it.stableId == stableId } ?: return false
    val endpoint =
      when (entry.kind) {
        GatewayRegistryEntryKind.MANUAL -> {
          val host = entry.host?.trim().orEmpty()
          val port = entry.port ?: return false
          if (host.isEmpty() || port !in 1..65535) return false
          GatewayEndpoint.manual(host, port)
        }
        GatewayRegistryEntryKind.DISCOVERED ->
          gateways.value.firstOrNull { it.stableId == stableId }
            ?: run {
              setStandaloneGatewayStatus("Gateway not currently discoverable")
              return false
            }
      }
    return connectSwitchingGateway(endpoint)
  }

  suspend fun connectSwitchingGateway(
    endpoint: GatewayEndpoint,
    explicitAuth: GatewayConnectAuth? = null,
  ): Boolean {
    val intent = gatewayLifecycleIntentSeq.incrementAndGet()
    return gatewaySwitchMutex.withLock {
      if (intent != gatewayLifecycleIntentSeq.get()) return@withLock false
      val currentStableId =
        connectedEndpoint?.stableId
          ?: connectingEndpointStableId
          ?: prefs.gatewayRegistry.activeStableId.value
      if (currentStableId != null && currentStableId != endpoint.stableId) {
        disconnectAndJoin()
      }
      if (prefs.gatewayRegistry.entries.value
          .any { it.stableId == endpoint.stableId }
      ) {
        prefs.gatewayRegistry.setActive(endpoint.stableId)
      }
      val started =
        synchronized(gatewayLifecycleIntentLock) {
          if (intent != gatewayLifecycleIntentSeq.get()) {
            false
          } else {
            beginConnect(endpoint, resolveGatewayConnectAuth(endpoint, explicitAuth))
            true
          }
        }
      if (!started) return@withLock false
      chat.restoreSelectedGatewayOfflineState()
      true
    }
  }

  private fun autoConnectIfNeeded() {
    if (didAutoConnect) return
    if (gatewayConnectionDisplay.value.isConnected) return
    val endpoint = resolvePreferredGatewayEndpoint() ?: return
    // Only attempt the stored preferred gateway once per runtime lifetime; users
    // can still reconnect explicitly from the UI after a failed auto attempt.
    didAutoConnect = true
    // Cold-start fallback only: discovery can emit late, so atomically claim the very first
    // lifecycle intent. If any explicit connect/disconnect/switch intent already exists, stand
    // down permanently instead of overriding the user's decision with a stale auto-connect.
    if (!gatewayLifecycleIntentSeq.compareAndSet(0L, 1L)) return
    launchConnect(endpoint, explicitAuth = null)
  }

  private fun reconnectPreferredGatewayOnForeground() {
    if (gatewayConnectionDisplay.value.isConnected) return
    if (_pendingGatewayTrust.value != null) return
    if (connectedEndpoint != null) {
      refreshGatewayConnection()
      return
    }
    resolvePreferredGatewayEndpoint()?.let(::connect)
  }

  fun setDisplayName(value: String) {
    prefs.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    prefs.setCameraEnabled(value)
  }

  fun setLocationMode(mode: LocationMode) {
    prefs.setLocationMode(mode)
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    prefs.setLocationPreciseEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    prefs.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    prefs.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    prefs.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    prefs.setManualPort(value)
  }

  fun setManualTls(value: Boolean) {
    prefs.setManualTls(value)
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.setCanvasDebugStatusEnabled(value)
  }

  fun setInstalledAppsSharingEnabled(value: Boolean) {
    if (prefs.installedAppsSharingEnabled.value == value) return
    prefs.setInstalledAppsSharingEnabled(value)
    refreshNodeSurfaceAfterSharingChange()
  }

  fun setNotificationForwardingEnabled(value: Boolean) {
    if (prefs.notificationForwardingEnabled.value == value) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingEnabled(value) }
  }

  fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    if (prefs.notificationForwardingMode.value == mode) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingMode(mode) }
  }

  fun setNotificationForwardingPackages(packages: List<String>) {
    val normalized = packages.map(String::trim).filter(String::isNotEmpty).toSet()
    if (prefs.notificationForwardingPackages.value == normalized) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingPackages(normalized.toList()) }
  }

  fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean {
    if (!enabled) {
      if (!prefs.notificationForwardingQuietHoursEnabled.value) return true
      return notificationOutbox.updatePolicy {
        prefs.setNotificationForwardingQuietHours(enabled = false, start = start, end = end)
      }
    }
    val normalizedStart = normalizeLocalHourMinute(start) ?: return false
    val normalizedEnd = normalizeLocalHourMinute(end) ?: return false
    val unchanged =
      prefs.notificationForwardingQuietHoursEnabled.value &&
        prefs.notificationForwardingQuietStart.value == normalizedStart &&
        prefs.notificationForwardingQuietEnd.value == normalizedEnd
    if (unchanged) return true
    return notificationOutbox.updatePolicy {
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = normalizedStart,
        end = normalizedEnd,
      )
    }
  }

  fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    val normalized = value.coerceAtLeast(1)
    if (prefs.notificationForwardingMaxEventsPerMinute.value == normalized) return
    notificationOutbox.updatePolicy {
      prefs.setNotificationForwardingMaxEventsPerMinute(normalized)
    }
  }

  fun setNotificationForwardingSessionKey(value: String?) {
    val normalized = value?.trim()?.takeIf(String::isNotEmpty)
    if (prefs.notificationForwardingSessionKey.value == normalized) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingSessionKey(normalized) }
  }

  fun setVoiceScreenActive(active: Boolean) {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (!active) {
      stopManualVoiceSession()
    } else {
      refreshTalkSetupReadiness()
    }
    // Don't re-enable on active=true; mic toggle drives that
  }

  fun setMicEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.ManualMic else VoiceCaptureMode.Off)
  }

  internal fun tryAcquireVoiceNoteMic(): Boolean =
    synchronized(voiceCaptureOwnershipLock) {
      if (voiceNoteOwnsMic || !isVoiceCaptureModeActive(VoiceCaptureMode.Off)) return@synchronized false
      voiceNoteOwnsMic = true
      true
    }

  internal fun releaseVoiceNoteMic() {
    synchronized(voiceCaptureOwnershipLock) {
      voiceNoteOwnsMic = false
    }
  }

  fun cancelMicCapture() {
    micCapture.cancelMicCapture()
    setVoiceCaptureMode(VoiceCaptureMode.Off, persistManualMic = false)
    prefs.setVoiceMicEnabled(false)
  }

  fun setTalkModeEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.TalkMode else VoiceCaptureMode.Off)
  }

  private suspend fun handleTalkPttStart(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      talkMode.finishingPushToTalkCaptureId?.let {
        return@runTalkPttCommand GatewaySession.InvokeResult.error(
          code = "PTT_BUSY",
          message = "PTT_BUSY: previous push-to-talk turn is still finishing",
        )
      }
      val lifecycleEpoch = voiceLifecycleEpoch.get()
      val commandEpoch = talkPttCommandEpoch.get()
      if (!_isForeground.value) {
        val payload = talkMode.beginPushToTalk(allowNewCapture = false)
        return@runTalkPttCommand GatewaySession.InvokeResult.ok(payload.toJson())
      }
      val payload =
        withPreparedTalkPttCommand(lifecycleEpoch, commandEpoch) { ownershipEpoch ->
          val started =
            talkMode.beginPushToTalk(
              allowNewCapture = true,
              canStartCapture = {
                _isForeground.value &&
                  voiceLifecycleEpoch.get() == lifecycleEpoch &&
                  talkPttCommandEpoch.get() == commandEpoch &&
                  voiceCaptureOwnershipEpoch.get() == ownershipEpoch
              },
            )
          recordTalkPttOwnership(captureId = started.captureId, ownershipEpoch = ownershipEpoch)
          started
        }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttStop(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      val payload = stopPreparedTalkPttCapture { talkMode.endPushToTalk() }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttCancel(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      val payload = stopPreparedTalkPttCapture { talkMode.cancelPushToTalk() }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttOnce(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      currentTalkPttOnceBusy()?.let { busy ->
        return@runTalkPttCommand GatewaySession.InvokeResult.ok(busy.payload.toJson())
      }
      val lifecycleEpoch = voiceLifecycleEpoch.get()
      val commandEpoch = talkPttCommandEpoch.get()
      val start =
        withPreparedTalkPttCommand(
          lifecycleEpoch = lifecycleEpoch,
          commandEpoch = commandEpoch,
          beforePrepare = ::currentTalkPttOnceBusy,
        ) { ownershipEpoch ->
          val started =
            talkMode.beginPushToTalkOnce(
              canStartCapture = {
                _isForeground.value &&
                  voiceLifecycleEpoch.get() == lifecycleEpoch &&
                  talkPttCommandEpoch.get() == commandEpoch &&
                  voiceCaptureOwnershipEpoch.get() == ownershipEpoch
              },
            )
          when (started) {
            is TalkPttOnceStart.Busy -> cleanupFailedTalkCapture(ownershipEpoch)
            is TalkPttOnceStart.Started ->
              recordTalkPttOwnership(captureId = started.captureId, ownershipEpoch = ownershipEpoch)
          }
          started
        }
      val payload =
        try {
          talkMode.awaitPushToTalkOnce(start)
        } finally {
          if (start is TalkPttOnceStart.Started) {
            finishTalkCaptureIfIdleAfterPreparation(start.captureId)
          }
        }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private fun currentTalkPttOnceBusy(): TalkPttOnceStart.Busy? {
    val captureId = talkMode.activePushToTalkCaptureId ?: talkMode.finishingPushToTalkCaptureId ?: return null
    return TalkPttOnceStart.Busy(
      TalkPttStopPayload(captureId = captureId, transcript = null, status = "busy"),
    )
  }

  private suspend fun <T> withPreparedTalkPttCommand(
    lifecycleEpoch: Long,
    commandEpoch: Long,
    beforePrepare: () -> T? = { null },
    block: suspend (ownershipEpoch: Long) -> T,
  ): T =
    voiceCapturePreparationMutex.withLock {
      // Preparation suspends while gateway config loads. Serialize ownership so
      // a stale command cannot clean up a newer command before capture starts.
      if (
        !_isForeground.value ||
        voiceLifecycleEpoch.get() != lifecycleEpoch ||
        talkPttCommandEpoch.get() != commandEpoch
      ) {
        throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
      }
      beforePrepare()?.let { return@withLock it }
      val ownershipEpoch = prepareTalkCapture(lifecycleEpoch, commandEpoch)
      try {
        if (
          !_isForeground.value ||
          voiceLifecycleEpoch.get() != lifecycleEpoch ||
          talkPttCommandEpoch.get() != commandEpoch ||
          voiceCaptureOwnershipEpoch.get() != ownershipEpoch
        ) {
          throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
        }
        block(ownershipEpoch)
      } catch (err: Throwable) {
        cleanupFailedTalkCapture(ownershipEpoch)
        throw err
      }
    }

  private suspend fun runTalkPttCommand(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult =
    try {
      block()
    } catch (err: Throwable) {
      val (code, message) = invokeErrorFromThrowable(err)
      GatewaySession.InvokeResult.error(code = code, message = message)
    }

  private suspend fun prepareTalkCapture(
    lifecycleEpoch: Long,
    commandEpoch: Long,
  ): Long {
    // Publish preparation on Main with lifecycle shutdown. After this block
    // yields, preparation must not write capture state that backgrounding cleared.
    val ownershipEpoch =
      withContext(Dispatchers.Main) {
        synchronized(voiceCaptureOwnershipLock) {
          if (
            !_isForeground.value ||
            voiceLifecycleEpoch.get() != lifecycleEpoch ||
            talkPttCommandEpoch.get() != commandEpoch
          ) {
            throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
          }
          if (voiceNoteOwnsMic) {
            throw IllegalStateException("MIC_BUSY: voice note recording is active")
          }
          if (!hasRecordAudioPermission()) {
            throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
          }
          val epoch = voiceCaptureOwnershipEpoch.incrementAndGet()
          micCapture.setMicEnabled(false)
          stopVoicePlayback()
          NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.TalkMode)
          talkMode.ttsOnAllResponses = true
          talkMode.setPlaybackEnabled(speakerEnabled.value)
          externalAudioCaptureActive.value = true
          epoch
        }
      }
    try {
      talkMode.refreshConfig()
      return ownershipEpoch
    } catch (err: Throwable) {
      cleanupFailedTalkCapture(ownershipEpoch)
      throw err
    }
  }

  private fun cleanupFailedTalkCapture(ownershipEpoch: Long) {
    synchronized(voiceCaptureOwnershipLock) {
      // TalkModeManager owns capture-scoped cancellation. A stale invoke must not
      // tear down a newer capture after a background/foreground transition.
      if (voiceCaptureOwnershipEpoch.get() == ownershipEpoch) {
        talkMode.activePushToTalkCaptureId?.let { captureId ->
          // An idempotent retry can fail while the original capture remains live.
          // Transfer preparation ownership so its eventual stop still cleans up.
          talkPttOwnership.set(TalkPttOwnership(captureId = captureId, epoch = ownershipEpoch))
          return
        }
      }
      finishTalkCaptureIfIdleUnderOwnershipLock(ownershipEpoch)
    }
  }

  private fun recordTalkPttOwnership(
    captureId: String,
    ownershipEpoch: Long,
  ) {
    synchronized(voiceCaptureOwnershipLock) {
      if (voiceCaptureOwnershipEpoch.get() == ownershipEpoch) {
        talkPttOwnership.set(TalkPttOwnership(captureId = captureId, epoch = ownershipEpoch))
      }
    }
  }

  private suspend fun finishTalkCaptureIfIdleAfterPreparation(captureId: String) {
    withContext(NonCancellable) {
      voiceCapturePreparationMutex.withLock {
        finishTalkCaptureIfIdleLocked(captureId)
      }
    }
  }

  private suspend fun stopPreparedTalkPttCapture(
    stopCapture: suspend () -> TalkPttStopPayload,
  ): TalkPttStopPayload {
    // Preparation can suspend on gateway config. Invalidate it before waiting,
    // while later starts queue behind this stop with the new command epoch.
    talkPttCommandEpoch.incrementAndGet()
    return withContext(NonCancellable) {
      voiceCapturePreparationMutex.withLock {
        val payload = stopCapture()
        finishTalkCaptureIfIdleLocked(payload.captureId)
        payload
      }
    }
  }

  private fun finishTalkCaptureIfIdleLocked(captureId: String) {
    synchronized(voiceCaptureOwnershipLock) {
      val ownership = talkPttOwnership.get()
      if (ownership?.captureId != captureId || !talkPttOwnership.compareAndSet(ownership, null)) return
      finishTalkCaptureIfIdleUnderOwnershipLock(ownership.epoch)
    }
  }

  private fun finishTalkCaptureIfIdleUnderOwnershipLock(ownershipEpoch: Long) {
    if (ownershipEpoch == 0L || voiceCaptureOwnershipEpoch.get() != ownershipEpoch) return
    if (!talkMode.isEnabled.value && !talkMode.isListening.value && !talkMode.isSpeaking.value) {
      talkMode.ttsOnAllResponses = false
      NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
      externalAudioCaptureActive.value = false
    }
  }

  private fun finishTalkModeAfterRelayClose() {
    synchronized(voiceCaptureOwnershipLock) {
      if (_voiceCaptureMode.value != VoiceCaptureMode.TalkMode) return
      talkPttCommandEpoch.incrementAndGet()
      voiceCaptureOwnershipEpoch.incrementAndGet()
      _voiceCaptureMode.value = VoiceCaptureMode.Off
      talkMode.ttsOnAllResponses = false
      NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
      externalAudioCaptureActive.value = false
    }
  }

  val speakerEnabled: StateFlow<Boolean>
    get() = prefs.speakerEnabled

  fun setSpeakerEnabled(value: Boolean) {
    prefs.setSpeakerEnabled(value)
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.setPlaybackEnabled(value)
    }
    // Keep TalkMode in sync so any active Talk playback also respects speaker mute.
    talkMode.setPlaybackEnabled(value)
  }

  suspend fun runVoiceE2e(
    mode: String,
    transcript: String,
    realtimeAssistantText: String,
    timeoutMs: Long,
  ): VoiceE2eResult {
    if (!BuildConfig.DEBUG) {
      throw IllegalStateException("voice e2e is debug-only")
    }
    if (!gatewayConnectionDisplay.value.isConnected) {
      throw IllegalStateException("gateway not connected")
    }
    if (!hasRecordAudioPermission()) {
      throw IllegalStateException("microphone permission missing")
    }

    val normalizedMode = mode.trim().lowercase().ifEmpty { "both" }
    val runNormal = normalizedMode == "both" || normalizedMode == "normal" || normalizedMode == "dictation"
    val runRealtime = normalizedMode == "both" || normalizedMode == "realtime" || normalizedMode == "talk"
    if (!runNormal && !runRealtime) {
      throw IllegalArgumentException("unknown voice e2e mode: $mode")
    }

    val previousSpeakerEnabled = speakerEnabled.value
    setSpeakerEnabled(false)
    var completed = false
    return try {
      VoiceE2eResult(
        normal =
          if (runNormal) {
            runNormalVoiceE2e(transcript = transcript, timeoutMs = timeoutMs)
          } else {
            null
          },
        realtime =
          if (runRealtime) {
            runRealtimeVoiceE2e(
              transcript = transcript,
              assistantText = realtimeAssistantText,
              timeoutMs = timeoutMs,
            )
          } else {
            null
          },
      ).also { completed = true }
    } finally {
      if (!completed) {
        stopActiveVoiceSession()
      }
      setSpeakerEnabled(previousSpeakerEnabled)
    }
  }

  private suspend fun runNormalVoiceE2e(
    transcript: String,
    timeoutMs: Long,
  ): VoiceE2eSliceResult {
    stopActiveVoiceSession()
    setVoiceCaptureMode(VoiceCaptureMode.ManualMic)
    micCapture.submitTranscribedMessage(transcript)
    awaitVoiceConversation(timeoutMs = timeoutMs) {
      micCapture.conversation.value.any { it.role == VoiceConversationRole.Assistant && !it.isStreaming }
    }
    val entries = micCapture.conversation.value
    return VoiceE2eSliceResult(
      mode = "normal",
      status = micCapture.statusText.value,
      userText = entries.lastOrNull { it.role == VoiceConversationRole.User }?.text,
      assistantText = entries.lastOrNull { it.role == VoiceConversationRole.Assistant }?.text,
    )
  }

  private suspend fun runRealtimeVoiceE2e(
    transcript: String,
    assistantText: String,
    timeoutMs: Long,
  ): VoiceE2eSliceResult {
    stopActiveVoiceSession()
    setVoiceCaptureMode(VoiceCaptureMode.TalkMode)
    talkMode.runE2eRealtimeTurn(
      userText = transcript,
      assistantText = assistantText,
      timeoutMs = timeoutMs,
    )
    awaitVoiceConversation(timeoutMs = timeoutMs) {
      val entries = talkMode.conversation.value
      entries.any { it.role == VoiceConversationRole.User && !it.isStreaming } &&
        entries.any { it.role == VoiceConversationRole.Assistant && !it.isStreaming }
    }
    val entries = talkMode.conversation.value
    return VoiceE2eSliceResult(
      mode = "realtime",
      status = talkMode.statusText.value,
      userText = entries.lastOrNull { it.role == VoiceConversationRole.User }?.text,
      assistantText = entries.lastOrNull { it.role == VoiceConversationRole.Assistant }?.text,
    )
  }

  private suspend fun awaitVoiceConversation(
    timeoutMs: Long,
    ready: () -> Boolean,
  ) {
    withTimeout(timeoutMs) {
      while (!ready()) {
        delay(100L)
      }
    }
  }

  private fun setVoiceCaptureMode(
    mode: VoiceCaptureMode,
    persistManualMic: Boolean = true,
  ) {
    synchronized(voiceCaptureOwnershipLock) {
      if (mode != VoiceCaptureMode.Off && voiceNoteOwnsMic) return
      talkPttCommandEpoch.incrementAndGet()
      voiceCaptureOwnershipEpoch.incrementAndGet()
      val permissionDenied = mode.requiresMicrophonePermission && !hasRecordAudioPermission()
      val captureMode = if (permissionDenied) VoiceCaptureMode.Off else mode
      if (permissionDenied) prefs.setVoiceMicEnabled(false)
      if (_voiceCaptureMode.value == captureMode && isVoiceCaptureModeActive(captureMode)) return
      talkPttOwnership.set(null)
      _voiceCaptureMode.value = captureMode
      when (captureMode) {
        VoiceCaptureMode.Off -> {
          talkMode.ttsOnAllResponses = false
          talkMode.stopAllCapture()
          stopVoicePlayback()
          micCapture.setMicEnabled(false)
          if (persistManualMic) {
            prefs.setVoiceMicEnabled(false)
          }
          NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
          externalAudioCaptureActive.value = false
        }

        VoiceCaptureMode.ManualMic -> {
          talkMode.ttsOnAllResponses = false
          talkMode.stopAllCapture()
          NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.ManualMic)
          if (persistManualMic) {
            prefs.setVoiceMicEnabled(true)
          }
          // Tapping mic on interrupts any active TTS (barge-in).
          stopVoicePlayback()
          scope.launch { talkMode.refreshConfig() }
          micCapture.setMicEnabled(true)
          externalAudioCaptureActive.value = true
        }

        VoiceCaptureMode.TalkMode -> {
          if (persistManualMic) {
            prefs.setVoiceMicEnabled(false)
          }
          micCapture.setMicEnabled(false)
          NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.TalkMode)
          talkMode.ttsOnAllResponses = true
          talkMode.setPlaybackEnabled(speakerEnabled.value)
          scope.launch { talkMode.refreshConfig() }
          talkMode.stopAllCapture()
          talkMode.setEnabled(true)
          externalAudioCaptureActive.value = true
        }
      }
    }
  }

  private fun stopManualVoiceSession() {
    if (_voiceCaptureMode.value != VoiceCaptureMode.ManualMic) return
    setVoiceCaptureMode(VoiceCaptureMode.Off)
  }

  private fun stopActiveVoiceSession() {
    synchronized(voiceCaptureOwnershipLock) {
      talkPttCommandEpoch.incrementAndGet()
      voiceCaptureOwnershipEpoch.incrementAndGet()
      talkPttOwnership.set(null)
      talkMode.ttsOnAllResponses = false
      talkMode.stopAllCapture()
      stopVoicePlayback()
      micCapture.setMicEnabled(false)
      prefs.setVoiceMicEnabled(false)
      NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
      _voiceCaptureMode.value = VoiceCaptureMode.Off
      externalAudioCaptureActive.value = false
    }
  }

  private fun stopVoicePlayback() {
    talkMode.stopTts()
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.stopTts()
    }
  }

  private val VoiceCaptureMode.requiresMicrophonePermission: Boolean
    get() = this == VoiceCaptureMode.ManualMic || this == VoiceCaptureMode.TalkMode

  private fun isVoiceCaptureModeActive(mode: VoiceCaptureMode): Boolean =
    when (mode) {
      VoiceCaptureMode.Off ->
        !externalAudioCaptureActive.value &&
          !micCapture.micEnabled.value &&
          !talkMode.isEnabled.value &&
          talkMode.activePushToTalkCaptureId == null
      VoiceCaptureMode.ManualMic ->
        externalAudioCaptureActive.value &&
          micCapture.micEnabled.value &&
          !talkMode.isEnabled.value &&
          talkMode.activePushToTalkCaptureId == null
      VoiceCaptureMode.TalkMode ->
        externalAudioCaptureActive.value &&
          !micCapture.micEnabled.value &&
          talkMode.isEnabled.value &&
          talkMode.activePushToTalkCaptureId == null
    }

  fun refreshGatewayConnection() {
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      val endpoint = connectedEndpoint
      if (endpoint == null) {
        val preferred = resolvePreferredGatewayEndpoint()
        if (preferred == null) {
          setStandaloneGatewayStatus("Failed: no saved gateway endpoint")
        } else {
          prepareGatewayTarget(preferred)
          beginConnect(preferred, resolveGatewayConnectAuth(preferred))
        }
        return@launchGatewayLifecycle
      }
      updateStatus {
        operatorStatusText = "Connecting…"
        operatorConnectionProblem = null
      }
      connectWithAuth(endpoint = endpoint, auth = resolveGatewayConnectAuth(endpoint), reconnect = true)
    }
  }

  private fun refreshNodeSurfaceAfterSharingChange() {
    launchGatewayLifecycle {
      val endpoint = connectedEndpoint ?: return@launchGatewayLifecycle
      connectWithAuth(endpoint = endpoint, auth = resolveGatewayConnectAuth(endpoint), reconnect = true)
    }
  }

  private fun launchGatewayLifecycle(block: () -> Unit) {
    val intent = gatewayLifecycleIntentSeq.get()
    val guardedBlock = {
      synchronized(gatewayLifecycleIntentLock) {
        if (intent == gatewayLifecycleIntentSeq.get()) block()
      }
    }
    if (gatewaySwitchMutex.tryLock()) {
      try {
        guardedBlock()
      } finally {
        gatewaySwitchMutex.unlock()
      }
    } else {
      scope.launch { gatewaySwitchMutex.withLock { guardedBlock() } }
    }
  }

  private fun connectWithAuth(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    reconnect: Boolean = false,
    beforeConnect: () -> Unit = {},
  ): Boolean =
    runGatewayConnectOperation {
      beforeConnect()
      activeGatewayAuth = auth
      val tls = connectionManager.resolveTlsParams(endpoint)
      val storedOperatorEntry = loadStoredRoleDeviceAuthEntry(endpoint, "operator")
      refreshGatewayControlPage(endpoint, auth, storedOperatorEntry?.token)
      val usesStoredOperatorDeviceToken =
        operatorSessionUsesStoredDeviceToken(auth, storedOperatorEntry?.token)
      val operatorAuth =
        resolveOperatorSessionConnectAuth(
          auth = auth,
          storedOperatorToken = storedOperatorEntry?.token,
        )
      if (operatorAuth == null) {
        updateStatus {
          operatorConnected = false
          operatorStatusText = "Offline"
          operatorConnectionProblem = null
        }
        operatorSession.disconnect()
      } else {
        operatorSession.connect(
          endpoint,
          operatorAuth.token,
          operatorAuth.bootstrapToken,
          operatorAuth.password,
          connectionManager.buildOperatorConnectOptions(
            scopes =
              operatorConnectScopesForAuth(
                usesStoredDeviceToken = usesStoredOperatorDeviceToken,
                storedOperatorScopes = storedOperatorEntry?.scopes,
              ),
          ),
          tls,
        )
      }
      nodeSession.connect(
        endpoint,
        auth.token,
        auth.bootstrapToken,
        auth.password,
        connectionManager.buildNodeConnectOptions(),
        tls,
      )
      if (reconnect && operatorAuth != null) {
        operatorSession.reconnect()
      }
      if (reconnect) {
        nodeSession.reconnect()
      }
    }

  // Auth reset waits for claimed connection starts before disconnecting. Session calls stay outside
  // this monitor because GatewaySession invokes callbacks while holding its own lifecycle monitor.
  private fun runGatewayConnectOperation(block: () -> Unit): Boolean {
    val claimed =
      synchronized(gatewayAuthLifecycleLock) {
        if (gatewayAuthResetInProgress) {
          false
        } else {
          if (gatewayConnectOperationsInFlight == 0) {
            gatewayConnectOperationsDrained = CompletableDeferred()
          }
          gatewayConnectOperationsInFlight += 1
          true
        }
      }
    if (!claimed) return false
    try {
      block()
      return true
    } finally {
      val drained =
        synchronized(gatewayAuthLifecycleLock) {
          gatewayConnectOperationsInFlight -= 1
          gatewayConnectOperationsDrained.takeIf { gatewayConnectOperationsInFlight == 0 }
        }
      drained?.complete(Unit)
    }
  }

  private fun beginConnect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    synchronized(gatewayAuthLifecycleLock) {
      if (gatewayAuthResetInProgress) return
    }
    // A user-selected connect target must never inherit notification content from another gateway.
    notificationOutbox.clear()
    invalidateNodeCapabilityApprovalState()
    val connectAttemptId = connectAttemptSeq.incrementAndGet()
    connectingEndpointStableId = endpoint.stableId
    chat.onGatewayScopeChanging()
    _pendingGatewayTrust.value = null
    val tls = connectionManager.resolveTlsParams(endpoint)
    if (tls?.required == true) {
      val expectedFingerprint =
        tls.expectedFingerprint
          ?.let(::normalizeGatewayTlsFingerprint)
          ?.takeIf { it.isNotBlank() }
      setStandaloneGatewayStatus("Verify gateway TLS fingerprint…")
      scope.launch {
        val tlsProbe = tlsFingerprintProbe(endpoint.host, endpoint.port)
        if (!isCurrentConnectAttempt(connectAttemptId)) return@launch
        val fp =
          tlsProbe.fingerprintSha256 ?: run {
            if (expectedFingerprint == null) {
              connectingEndpointStableId = null
              setStandaloneGatewayStatus(gatewayTlsProbeFailureMessage(tlsProbe.failure))
            } else {
              connectAfterTlsCheck(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
            }
            return@launch
          }
        val observedFingerprint =
          normalizeGatewayTlsFingerprint(fp)
            .takeIf { it.isNotBlank() }
            ?: fp
        val previousFingerprint = expectedFingerprint?.takeUnless { it == observedFingerprint }
        if (expectedFingerprint == null || previousFingerprint != null) {
          publishGatewayTrustPromptIfCurrent(
            connectAttemptId = connectAttemptId,
            prompt =
              GatewayTrustPrompt(
                endpoint = endpoint,
                fingerprintSha256 = observedFingerprint,
                auth = auth,
                previousFingerprintSha256 = previousFingerprint,
              ),
          )
          return@launch
        }
        connectAfterTlsCheck(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
      }
      return
    }

    connectAfterTlsCheckLocked(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
  }

  private fun isCurrentConnectAttempt(connectAttemptId: Long): Boolean = connectAttemptSeq.get() == connectAttemptId

  private fun publishGatewayTrustPromptIfCurrent(
    connectAttemptId: Long,
    prompt: GatewayTrustPrompt,
  ): Boolean =
    synchronized(gatewayAuthLifecycleLock) {
      if (gatewayAuthResetInProgress || !isCurrentConnectAttempt(connectAttemptId)) {
        false
      } else {
        _pendingGatewayTrust.value = prompt
        true
      }
    }

  private fun refreshGatewayControlPage(
    endpoint: GatewayEndpoint? = connectedEndpoint,
    auth: GatewayConnectAuth? = activeGatewayAuth,
    storedOperatorToken: String? = endpoint?.let { loadStoredRoleDeviceAuthEntry(it, "operator")?.token },
  ) {
    if (endpoint == null) {
      _gatewayControlPage.value = null
      return
    }
    val pageAuth = resolveGatewayControlPageAuth(auth ?: resolveGatewayConnectAuth(endpoint), storedOperatorToken)
    _gatewayControlPage.value =
      GatewayControlPage(
        baseUrl = gatewayControlPageBaseUrl(endpoint),
        token = pageAuth.token,
        password = pageAuth.password,
      )
  }

  private fun connectAfterTlsCheck(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    connectAttemptId: Long,
  ) {
    launchGatewayLifecycle { connectAfterTlsCheckLocked(endpoint, auth, connectAttemptId) }
  }

  private fun connectAfterTlsCheckLocked(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    connectAttemptId: Long,
  ) {
    if (!isCurrentConnectAttempt(connectAttemptId)) return
    connectWithAuth(endpoint = endpoint, auth = auth) {
      connectedEndpoint = endpoint
      connectingEndpointStableId = null
      updateStatus {
        operatorConnectionProblem = null
        nodeConnectionProblem = null
        operatorStatusText = "Connecting…"
        nodeStatusText = "Connecting…"
      }
    }
  }

  fun connect(endpoint: GatewayEndpoint) {
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchConnect(endpoint, explicitAuth = null)
  }

  fun connect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchConnect(endpoint, explicitAuth = auth)
  }

  private fun launchConnect(
    endpoint: GatewayEndpoint,
    explicitAuth: GatewayConnectAuth?,
  ) {
    launchGatewayLifecycle {
      prepareGatewayTarget(endpoint)
      beginConnect(endpoint = endpoint, auth = resolveGatewayConnectAuth(endpoint, explicitAuth))
    }
  }

  private fun prepareGatewayTarget(endpoint: GatewayEndpoint) {
    if (connectedEndpoint?.stableId?.let { it != endpoint.stableId } == true) {
      // Closing both sockets is synchronous; cleanup callbacks may finish later, but no event can
      // cross the active-pointer change on the old authenticated transport.
      disconnect(retireRunState = true)
    }
    if (prefs.gatewayRegistry.entries.value
        .any { it.stableId == endpoint.stableId }
    ) {
      prefs.gatewayRegistry.setActive(endpoint.stableId)
    }
  }

  /** HTTP(S) origin serving the connected gateway's Control UI pages. */
  private fun gatewayControlPageBaseUrl(endpoint: GatewayEndpoint): String {
    val scheme = if (endpoint.tlsEnabled) "https" else "http"
    return "$scheme://${formatGatewayAuthority(endpoint.host, endpoint.port)}"
  }

  internal fun resolveGatewayConnectAuth(
    endpoint: GatewayEndpoint,
    explicitAuth: GatewayConnectAuth? = null,
  ): GatewayConnectAuth =
    explicitAuth
      ?: prefs.loadGatewayCredentials(endpoint.stableId).let { credentials ->
        GatewayConnectAuth(
          token = credentials.token,
          bootstrapToken = credentials.bootstrapToken,
          password = credentials.password,
        )
      }

  fun acceptGatewayTrustPrompt() {
    val prompt = _pendingGatewayTrust.value ?: return
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      if (_pendingGatewayTrust.value != prompt) return@launchGatewayLifecycle
      _pendingGatewayTrust.value = null
      prefs.saveGatewayTlsFingerprint(prompt.endpoint.stableId, prompt.fingerprintSha256)
      registerGateway(prompt.endpoint, setActive = true)
      beginConnect(endpoint = prompt.endpoint, auth = prompt.auth)
    }
  }

  fun declineGatewayTrustPrompt() {
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      _pendingGatewayTrust.value = null
      connectingEndpointStableId = null
      setStandaloneGatewayStatus("Offline")
    }
  }

  private fun gatewayTlsProbeFailureMessage(failure: GatewayTlsProbeFailure?): String =
    when (failure) {
      GatewayTlsProbeFailure.TLS_UNAVAILABLE ->
        "Failed: no secure gateway endpoint was detected. Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address with Unencrypted selected."
      GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT ->
        "Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry."
      GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE, null ->
        "Failed: couldn't reach the secure gateway endpoint for this host."
    }

  private fun hasRecordAudioPermission(): Boolean =
    (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    )

  fun connectManual() {
    val host = manualHost.value.trim()
    val port = manualPort.value
    if (host.isEmpty() || port <= 0 || port > 65535) {
      setStandaloneGatewayStatus("Failed: invalid manual host/port")
      return
    }
    connect(GatewayEndpoint.manual(host = host, port = port))
  }

  private fun loadStoredRoleDeviceAuthEntry(
    endpoint: GatewayEndpoint,
    role: String,
  ): DeviceAuthEntry? {
    val deviceId = identityStore.loadOrCreate().deviceId
    return deviceAuthStore.loadEntry(endpoint.stableId, deviceId, role)
  }

  private fun maybeStartOperatorSessionAfterNodeConnect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    val selectedGatewayId = connectedEndpoint?.stableId ?: connectingEndpointStableId
    if (selectedGatewayId != null && selectedGatewayId != endpoint.stableId) return
    runGatewayConnectOperation {
      if (operatorConnected) return@runGatewayConnectOperation
      val storedOperatorEntry = loadStoredRoleDeviceAuthEntry(endpoint, "operator")
      val usesStoredOperatorDeviceToken =
        operatorSessionUsesStoredDeviceToken(auth, storedOperatorEntry?.token)
      val operatorAuth =
        resolveOperatorSessionConnectAuth(
          auth = auth,
          storedOperatorToken = storedOperatorEntry?.token,
        ) ?: return@runGatewayConnectOperation
      updateStatus {
        operatorStatusText = "Connecting…"
        operatorConnectionProblem = null
      }
      operatorSession.connect(
        endpoint,
        operatorAuth.token,
        operatorAuth.bootstrapToken,
        operatorAuth.password,
        connectionManager.buildOperatorConnectOptions(
          scopes =
            operatorConnectScopesForAuth(
              usesStoredDeviceToken = usesStoredOperatorDeviceToken,
              storedOperatorScopes = storedOperatorEntry?.scopes,
            ),
        ),
        connectionManager.resolveTlsParams(endpoint),
      )
    }
  }

  fun disconnect() {
    synchronized(gatewayLifecycleIntentLock) {
      gatewayLifecycleIntentSeq.incrementAndGet()
      disconnect(retireRunState = false)
    }
  }

  fun prepareForGatewaySetup() {
    synchronized(gatewayLifecycleIntentLock) {
      gatewayLifecycleIntentSeq.incrementAndGet()
      disconnect(retireRunState = true)
    }
  }

  private fun disconnect(retireRunState: Boolean) {
    prepareDisconnect(retireRunState)
    operatorSession.disconnect()
    nodeSession.disconnect()
  }

  suspend fun forgetGateway(stableId: String): Boolean =
    gatewayLifecycleIntentSeq.incrementAndGet().let { intent ->
      gatewaySwitchMutex.withLock {
        if (intent != gatewayLifecycleIntentSeq.get()) false else forgetGatewayLocked(stableId)
      }
    }

  private suspend fun forgetGatewayLocked(stableId: String): Boolean {
    val normalized = stableId.trim()
    if (normalized.isEmpty()) return false
    val wasActive = prefs.gatewayRegistry.activeStableId.value == normalized
    val connectOperationsDrained =
      synchronized(gatewayAuthLifecycleLock) {
        if (gatewayAuthResetInProgress) {
          null
        } else {
          gatewayAuthResetInProgress = true
          gatewayConnectOperationsDrained
        }
      }
        ?: return false
    return try {
      connectOperationsDrained.await()
      if (connectedEndpoint?.stableId == normalized) {
        disconnectAndJoin()
      } else if (connectingEndpointStableId == normalized) {
        connectAttemptSeq.incrementAndGet()
        connectingEndpointStableId = null
        _pendingGatewayTrust.value = null
        chat.onGatewayScopeChanging(retireRunState = true)
      } else if (wasActive) {
        prepareDisconnect(retireRunState = true)
      }
      drainIdleGatewaySessionTails()
      val cacheCleared =
        runCatching { chat.clearGatewayCache(normalized) }
          .onFailure { err ->
            Log.e("OpenClawRuntime", "Failed to purge forgotten gateway chat data", err)
            setStandaloneGatewayStatus("Failed: couldn't clear offline gateway data. Retry forget.")
          }.isSuccess
      if (!cacheCleared) return false
      val deviceId = identityStore.loadOrCreate().deviceId
      deviceAuthStore.clearToken(normalized, deviceId, "node")
      deviceAuthStore.clearToken(normalized, deviceId, "operator")
      prefs.clearGatewayCredentials(normalized)
      prefs.clearGatewayCustomHeaders(normalized)
      prefs.clearGatewayTlsFingerprint(normalized)
      prefs.clearNotificationForwardingSessionKey(normalized)
      prefs.gatewayRegistry.remove(normalized)
      true
    } finally {
      synchronized(gatewayAuthLifecycleLock) { gatewayAuthResetInProgress = false }
    }
  }

  private fun recordConnectedGateway() {
    val endpoint = connectedEndpoint ?: return
    registerGateway(endpoint, setActive = true)
    prefs.gatewayRegistry.markConnected(endpoint.stableId, System.currentTimeMillis())
  }

  private fun registerGateway(
    endpoint: GatewayEndpoint,
    setActive: Boolean,
  ) {
    val existing =
      prefs.gatewayRegistry.entries.value
        .firstOrNull { it.stableId == endpoint.stableId }
    val entry =
      if (endpoint.stableId.startsWith("manual|")) {
        GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = endpoint.name,
          host = endpoint.host,
          port = endpoint.port,
          tls = existing?.tls ?: manualTls.value,
          lastConnectedAtMs = existing?.lastConnectedAtMs ?: 0L,
        )
      } else {
        GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.DISCOVERED,
          name = endpoint.name,
          tls = true,
          lastConnectedAtMs = existing?.lastConnectedAtMs ?: 0L,
        )
      }
    prefs.gatewayRegistry.upsert(entry)
    if (setActive) prefs.gatewayRegistry.setActive(endpoint.stableId)
  }

  private suspend fun disconnectAndJoin() {
    prepareDisconnect(retireRunState = true)
    // Both sockets close before either reconnect loop is joined, so no authenticated role stays
    // live while reset waits for the other role's terminal callback.
    coroutineScope {
      launch { operatorSession.disconnectAndJoin() }
      launch { nodeSession.disconnectAndJoin() }
    }
  }

  private suspend fun drainIdleGatewaySessionTails() {
    if (connectedEndpoint != null || connectingEndpointStableId != null) return
    coroutineScope {
      launch { operatorSession.disconnectAndJoin() }
      launch { nodeSession.disconnectAndJoin() }
    }
  }

  private fun prepareDisconnect(retireRunState: Boolean) {
    notificationOutbox.clear()
    connectAttemptSeq.incrementAndGet()
    synchronized(gatewayDataScopeLock) {
      gatewayDataGeneration += 1
      clearOperatorGatewayState()
    }
    chat.onGatewayScopeChanging(retireRunState)
    stopMessageSpeech()
    micCapture.onGatewayScopeChanging()
    stopActiveVoiceSession()
    talkMode.onGatewayScopeChanging()
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.onGatewayScopeChanging()
    }
    if (retireRunState) {
      val defaultMainSessionKey = resolveNodeMainSessionKey()
      _mainSessionKey.value = defaultMainSessionKey
      talkMode.setMainSessionKey(defaultMainSessionKey)
    }
    connectedEndpoint = null
    connectingEndpointStableId = null
    _gatewayControlPage.value = null
    activeGatewayAuth = null
    updateStatus {
      operatorConnected = false
      _nodeConnected.value = false
      operatorStatusText = "Offline"
      nodeStatusText = "Offline"
      operatorConnectionProblem = null
      nodeConnectionProblem = null
    }
    _pendingGatewayTrust.value = null
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    val gatewayId = connectedEndpoint?.stableId
    scope.launch {
      val trimmed = payloadJson.trim()
      if (trimmed.isEmpty()) return@launch

      val root =
        try {
          json.parseToJsonElement(trimmed).asObjectOrNull() ?: return@launch
        } catch (_: Throwable) {
          return@launch
        }

      val userActionObj = (root["userAction"] as? JsonObject) ?: root
      val actionId =
        (userActionObj["id"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty {
          java.util.UUID
            .randomUUID()
            .toString()
        }
      val name = OpenClawCanvasA2UIAction.extractActionName(userActionObj) ?: return@launch

      val surfaceId =
        (userActionObj["surfaceId"] as? JsonPrimitive)
          ?.content
          ?.trim()
          .orEmpty()
          .ifEmpty { "main" }
      val sourceComponentId =
        (userActionObj["sourceComponentId"] as? JsonPrimitive)
          ?.content
          ?.trim()
          .orEmpty()
          .ifEmpty { "-" }
      val contextJson = (userActionObj["context"] as? JsonObject)?.toString()

      val sessionKey = resolveMainSessionKey()
      val message =
        OpenClawCanvasA2UIAction.formatAgentMessage(
          actionName = name,
          sessionKey = sessionKey,
          surfaceId = surfaceId,
          sourceComponentId = sourceComponentId,
          host = displayName.value,
          instanceId = instanceId.value.lowercase(),
          contextJson = contextJson,
        )

      val connected = _nodeConnected.value
      var error: String? = null
      if (connected && gatewayId != null) {
        val sent =
          nodeSession.sendNodeEventForEndpoint(
            expectedEndpointStableId = gatewayId,
            event = "agent.request",
            payloadJson =
              buildJsonObject {
                put("message", JsonPrimitive(message))
                put("sessionKey", JsonPrimitive(sessionKey))
                put("thinking", JsonPrimitive("low"))
                put("deliver", JsonPrimitive(false))
                put("key", JsonPrimitive(actionId))
              }.toString(),
          )
        if (!sent) {
          error = "send failed"
        }
      } else {
        error = "gateway not connected"
      }

      try {
        canvas.eval(
          OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
            actionId = actionId,
            ok = connected && error == null,
            error = error,
          ),
        )
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean = a2uiHandler.isTrustedCanvasActionUrl(rawUrl)

  fun loadChat(sessionKey: String) {
    val key = sessionKey.trim().ifEmpty { resolveMainSessionKey() }
    chat.load(key)
  }

  fun refreshChat() {
    chat.refresh()
  }

  fun refreshChatSessions(
    limit: Int? = null,
    archived: Boolean = false,
  ) {
    chat.refreshSessions(limit = limit, archived = archived)
  }

  suspend fun patchChatSession(
    key: String,
    label: String? = null,
    clearLabel: Boolean = false,
    category: String? = null,
    clearCategory: Boolean = false,
    pinned: Boolean? = null,
    archived: Boolean? = null,
    unread: Boolean? = null,
  ) {
    chat.patchSession(
      key = key,
      label = label,
      clearLabel = clearLabel,
      category = category,
      clearCategory = clearCategory,
      pinned = pinned,
      archived = archived,
      unread = unread,
    )
  }

  suspend fun renameChatSessionGroup(
    from: String,
    to: String,
  ) {
    chat.renameSessionGroup(from = from, to = to)
  }

  suspend fun dissolveChatSessionGroup(group: String) {
    chat.dissolveSessionGroup(group)
  }

  suspend fun deleteChatSession(key: String) {
    chat.deleteSession(key)
  }

  suspend fun forkChatSession(parentKey: String): String? = chat.forkSession(parentKey)

  fun setChatThinkingLevel(level: String) {
    chat.setThinkingLevel(level)
  }

  fun setChatSessionModel(
    sessionKey: String,
    modelRef: String?,
  ) {
    chat.setSessionModel(sessionKey = sessionKey, modelRef = modelRef)
  }

  fun switchChatSession(sessionKey: String) {
    stopMessageSpeech()
    chat.switchSession(sessionKey)
  }

  fun selectChatAgent(agentId: String) {
    val normalizedAgentId = agentId.trim()
    if (normalizedAgentId.isEmpty()) return
    stopMessageSpeech()
    // Agent selection owns every main-session consumer; switching chat alone would
    // leave Talk mode and the home canvas bound to the previous agent.
    selectedChatAgentId = normalizedAgentId
    syncMainSessionKey(normalizedAgentId)
    chat.switchSession(_mainSessionKey.value)
  }

  suspend fun fetchChatSessionList(
    search: String?,
    archived: Boolean,
  ): List<ChatSessionEntry> = chat.fetchSessionList(search = search, archived = archived)

  fun abortChat() {
    chat.abort()
  }

  fun startNewChat(worktree: Boolean = false) {
    stopMessageSpeech()
    chat.startNewChat(worktree = worktree)
  }

  fun toggleMessageSpeech(
    messageId: String,
    text: String,
  ) {
    messageSpeechController.toggle(messageId = messageId, text = text)
  }

  fun stopMessageSpeech() {
    if (messageSpeechControllerLazy.isInitialized()) messageSpeechController.stop()
  }

  fun sendChat(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ) {
    chat.sendMessage(message = message, thinkingLevel = thinking, attachments = attachments)
  }

  suspend fun sendChatAwaitAcceptance(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean = chat.sendMessageAwaitAcceptance(message = message, thinkingLevel = thinking, attachments = attachments)

  fun refreshChatCommands() {
    chat.refreshCommands()
  }

  private fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event == "update.available") {
      _gatewayUpdateAvailable.value = parseGatewayUpdateAvailable(payloadJson)
    }
    handleExecApprovalGatewayEvent(event = event, payloadJson = payloadJson)
    micCapture.handleGatewayEvent(event, payloadJson)
    talkMode.handleGatewayEvent(event, payloadJson)
    chat.handleGatewayEvent(event, payloadJson)
  }

  private fun handleExecApprovalGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    when (event) {
      "exec.approval.requested" -> {
        val approvalId = parseExecApprovalEventId(payloadJson)
        approvalId?.let(resolvedExecApprovalIds::remove)
        scope.launch {
          if (approvalId == null) {
            refreshExecApprovalsFromGateway()
          } else {
            refreshExecApprovalFromGateway(approvalId)
          }
        }
      }
      "exec.approval.resolved" -> {
        val approvalId = parseExecApprovalEventId(payloadJson) ?: return
        markExecApprovalResolved(approvalId)
      }
    }
  }

  private fun parseExecApprovalEventId(payloadJson: String?): String? =
    try {
      payloadJson
        ?.let { json.parseToJsonElement(it).asObjectOrNull() }
        ?.get("id")
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    } catch (_: Throwable) {
      null
    }

  private fun parseGatewayUpdateAvailable(payloadJson: String?): GatewayUpdateAvailableSummary? {
    return try {
      val root = payloadJson?.let { json.parseToJsonElement(it).asObjectOrNull() }
      val update = root?.get("updateAvailable").asObjectOrNull() ?: return null
      GatewayUpdateAvailableSummary(
        currentVersion = update["currentVersion"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        latestVersion = update["latestVersion"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        channel = update["channel"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun parseTalkSessionId(response: String): String {
    val root = json.parseToJsonElement(response).asObjectOrNull()
    val sessionId =
      root?.get("transcriptionSessionId").asStringOrNull()
        ?: root?.get("sessionId").asStringOrNull()
    if (sessionId.isNullOrBlank()) {
      throw IllegalStateException("talk.session.create returned no session id")
    }
    return sessionId
  }

  private fun captureGatewayDataScope(): GatewayDataScope? =
    synchronized(gatewayDataScopeLock) {
      connectedEndpoint?.stableId?.let { GatewayDataScope(it, gatewayDataGeneration) }
    }

  private suspend fun requestGatewayData(
    gatewayScope: GatewayDataScope,
    method: String,
    paramsJson: String?,
  ): String {
    val response = operatorSession.requestForEndpoint(gatewayScope.stableId, method, paramsJson)
    if (!isGatewayDataScopeCurrent(gatewayScope)) throw CancellationException("gateway scope changed")
    return response
  }

  private fun isGatewayDataScopeCurrent(gatewayScope: GatewayDataScope): Boolean =
    synchronized(gatewayDataScopeLock) {
      gatewayScope.generation == gatewayDataGeneration && connectedEndpoint?.stableId == gatewayScope.stableId
    }

  private inline fun publishGatewayData(
    gatewayScope: GatewayDataScope,
    publish: () -> Unit,
  ): Boolean =
    synchronized(gatewayDataScopeLock) {
      if (gatewayScope.generation != gatewayDataGeneration || connectedEndpoint?.stableId != gatewayScope.stableId) {
        false
      } else {
        publish()
        true
      }
    }

  private suspend fun refreshBrandingFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!gatewayConnectionDisplay.value.isConnected) return
    try {
      val res = requestGatewayData(gatewayScope, "config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val ui = config?.get("ui").asObjectOrNull()
      val raw = ui?.get("seamColor").asStringOrNull()?.trim()
      val parsed = parseHexColorArgb(raw)
      publishGatewayData(gatewayScope) {
        _seamColorArgb.value = parsed ?: DEFAULT_SEAM_COLOR_ARGB
        updateHomeCanvasState()
      }
    } catch (_: Throwable) {
      // ignore
    }
  }

  /** Lists one directory of the active agent's workspace (read-only RPC). */
  suspend fun listWorkspaceFiles(
    path: String?,
    offset: Int? = null,
  ): GatewayWorkspaceListing {
    val params =
      buildJsonObject {
        put("agentId", JsonPrimitive(workspaceAgentId()))
        if (!path.isNullOrEmpty()) put("path", JsonPrimitive(path))
        if (offset != null && offset > 0) put("offset", JsonPrimitive(offset))
      }
    val res = operatorSession.request("agents.workspace.list", params.toString())
    return parseWorkspaceListing(json.parseToJsonElement(res))
      ?: throw IllegalStateException("agents.workspace.list returned no listing")
  }

  /** Fetches one workspace file preview (UTF-8 text or base64 image). */
  suspend fun fetchWorkspaceFile(path: String): GatewayWorkspaceFile {
    val params =
      buildJsonObject {
        put("agentId", JsonPrimitive(workspaceAgentId()))
        put("path", JsonPrimitive(path))
      }
    val res = operatorSession.request("agents.workspace.get", params.toString(), timeoutMs = 30_000)
    return parseWorkspaceFile(json.parseToJsonElement(res))
      ?: throw IllegalStateException("agents.workspace.get returned no file")
  }

  private fun workspaceAgentId(): String = resolveActiveAgentId().ifEmpty { "main" }

  private suspend fun refreshAgentsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) return
    try {
      val res = requestGatewayData(gatewayScope, "agents.list", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val defaultAgentId = root["defaultId"].asStringOrNull()?.trim().orEmpty()
      val mainKey = normalizeMainKey(root["mainKey"].asStringOrNull())
      val agents =
        (root["agents"] as? JsonArray)?.mapNotNull { item ->
          val obj = item.asObjectOrNull() ?: return@mapNotNull null
          val id = obj["id"].asStringOrNull()?.trim().orEmpty()
          if (id.isEmpty()) return@mapNotNull null
          val name = obj["name"].asStringOrNull()?.trim()
          val emoji =
            obj["identity"]
              .asObjectOrNull()
              ?.get("emoji")
              .asStringOrNull()
              ?.trim()
          GatewayAgentSummary(
            id = id,
            name = name?.takeIf { it.isNotEmpty() },
            emoji = emoji?.takeIf { it.isNotEmpty() },
            workspaceGit = (obj["workspaceGit"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() == true,
          )
        } ?: emptyList()

      publishGatewayData(gatewayScope) {
        _gatewayDefaultAgentId.value = defaultAgentId.ifEmpty { null }
        _gatewayAgents.value = agents
        val selectedAgentId = selectedChatAgentId?.takeIf { id -> agents.any { it.id == id } }
        selectedChatAgentId = selectedAgentId
        syncMainSessionKey(selectedAgentId ?: resolveAgentIdFromMainSessionKey(mainKey) ?: gatewayDefaultAgentId.value)
        updateHomeCanvasState()
      }
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun refreshModelCatalogFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _modelCatalogRefreshing.value = true
      _modelCatalogErrorText.value = null
    }
    if (!operatorConnected) {
      _modelCatalog.value = emptyList()
      _modelAuthProviders.value = emptyList()
      _modelCatalogRefreshing.value = false
      return
    }
    try {
      val modelsRes = requestGatewayData(gatewayScope, "models.list", "{}")
      val modelsRoot = json.parseToJsonElement(modelsRes).asObjectOrNull()
      val models = parseGatewayModels(modelsRoot?.get("models") as? JsonArray)
      val authRes = requestGatewayData(gatewayScope, "models.authStatus", "{}")
      val authRoot = json.parseToJsonElement(authRes).asObjectOrNull()
      val providers = parseGatewayModelProviders(authRoot?.get("providers") as? JsonArray)
      publishGatewayData(gatewayScope) {
        _modelCatalog.value = models
        _modelAuthProviders.value = providers
      }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _modelCatalogErrorText.value = "Could not load provider catalog." }
    } finally {
      publishGatewayData(gatewayScope) { _modelCatalogRefreshing.value = false }
    }
  }

  private suspend fun refreshTalkSetupReadinessFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) {
      _talkSetupReadiness.value = GatewayTalkSetupReadiness.unverified()
      return
    }
    val readiness =
      try {
        val response = requestGatewayData(gatewayScope, "talk.catalog", "{}")
        parseGatewayTalkSetupReadiness(json.parseToJsonElement(response).asObjectOrNull())
      } catch (_: Throwable) {
        GatewayTalkSetupReadiness.unverified(GatewayTalkSetupIssue.CatalogLoadFailed)
      }
    publishGatewayData(gatewayScope) { _talkSetupReadiness.value = readiness }
  }

  private suspend fun refreshCronFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _cronRefreshing.value = true
      _cronErrorText.value = null
    }
    if (!operatorConnected) {
      _cronStatus.value = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)
      _cronJobs.value = emptyList()
      _cronRefreshing.value = false
      return
    }
    try {
      val statusRes = requestGatewayData(gatewayScope, "cron.status", "{}")
      val statusRoot = json.parseToJsonElement(statusRes).asObjectOrNull()
      val status =
        GatewayCronStatus(
          enabled = statusRoot.boolean("enabled"),
          jobs = statusRoot.long("jobs")?.toInt() ?: 0,
          nextWakeAtMs = statusRoot.long("nextWakeAtMs"),
        )

      val listRes = requestGatewayData(gatewayScope, "cron.list", """{"includeDisabled":true,"limit":20,"sortBy":"nextRunAtMs","sortDir":"asc"}""")
      val listRoot = json.parseToJsonElement(listRes).asObjectOrNull()
      val jobs = parseCronJobs(listRoot?.get("jobs") as? JsonArray)
      publishGatewayData(gatewayScope) {
        _cronStatus.value = status
        _cronJobs.value = jobs
      }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _cronErrorText.value = "Could not load cron jobs." }
    } finally {
      publishGatewayData(gatewayScope) { _cronRefreshing.value = false }
    }
  }

  private suspend fun loadCronJobDetailFromGateway(request: CronJobDetailRequest) {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) {
      cronJobDetailRequestGuard.publishIfCurrent(request) {
        _cronJobDetailState.value = GatewayCronJobDetailState.Error(request.id, "Connect the gateway to inspect cron jobs.")
      }
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "cron.get", cronJobGetParams(request.id))
      val root = json.parseToJsonElement(res).asObjectOrNull()
      cronJobDetailRequestGuard.publishIfCurrent(request) {
        _cronJobDetailState.value =
          parseGatewayCronJobDetail(root)?.let(GatewayCronJobDetailState::Loaded)
            ?: GatewayCronJobDetailState.Error(request.id, "Gateway returned an invalid cron job.")
      }
    } catch (_: Throwable) {
      cronJobDetailRequestGuard.publishIfCurrent(request) {
        _cronJobDetailState.value = GatewayCronJobDetailState.Error(request.id, "Could not load cron job.")
      }
    }
  }

  private suspend fun refreshUsageFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _usageRefreshing.value = true
      _usageErrorText.value = null
    }
    if (!operatorConnected) {
      _usageSummary.value = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())
      _usageRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "usage.status", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val summary =
        GatewayUsageSummary(
          updatedAtMs = root.long("updatedAt"),
          providers = parseUsageProviders(root?.get("providers") as? JsonArray),
        )
      publishGatewayData(gatewayScope) { _usageSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _usageErrorText.value = "Could not load usage." }
    } finally {
      publishGatewayData(gatewayScope) { _usageRefreshing.value = false }
    }
  }

  private suspend fun refreshSkillsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _skillsRefreshing.value = true
      _skillsErrorText.value = null
    }
    if (!operatorConnected) {
      _skillsSummary.value = GatewaySkillsSummary(skills = emptyList())
      _skillsRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "skills.status", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val summary =
        GatewaySkillsSummary(
          managedSkillsDirAvailable =
            root
              ?.get("managedSkillsDir")
              .asStringOrNull()
              ?.trim()
              ?.isNotEmpty() == true,
          skills = parseSkillSummaries(root?.get("skills") as? JsonArray),
        )
      publishGatewayData(gatewayScope) { _skillsSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _skillsErrorText.value = "Could not load skills." }
    } finally {
      publishGatewayData(gatewayScope) { _skillsRefreshing.value = false }
    }
  }

  private suspend fun refreshSkillWorkshopProposalsFromGateway(agentId: String?) {
    val listSeq = skillWorkshopListSeq.incrementAndGet()
    val requestAgentId = normalizeSkillWorkshopAgentId(agentId)
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = requestAgentId, proposals = emptyList())
      _skillWorkshopRefreshing.value = false
      _skillWorkshopErrorText.value = "Connect the gateway to load Skill Workshop proposals."
      return
    }
    publishGatewayData(gatewayScope) {
      _skillWorkshopRefreshing.value = true
      _skillWorkshopErrorText.value = null
      if (_skillWorkshopSummary.value.agentId != requestAgentId) {
        _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = requestAgentId, proposals = emptyList())
        _skillWorkshopNoticeText.value = null
        _skillWorkshopInspectingProposalId.value = null
        _skillWorkshopMutatingProposalId.value = null
        skillWorkshopInspectSeq.incrementAndGet()
        skillWorkshopMutationSeq.incrementAndGet()
      }
    }
    try {
      val res =
        requestGatewayData(
          gatewayScope,
          "skills.proposals.list",
          skillWorkshopParams(agentId = agentId).toString(),
        )
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val previousById =
        _skillWorkshopSummary.value
          .takeIf { it.agentId == requestAgentId }
          ?.proposals
          ?.associateBy { it.id }
          .orEmpty()
      val proposals = parseSkillWorkshopProposals(root?.get("proposals") as? JsonArray, previousById)
      publishGatewayData(gatewayScope) {
        if (skillWorkshopListSeq.get() == listSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = requestAgentId, proposals = proposals)
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopListSeq.get() == listSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopErrorText.value = "Could not load Skill Workshop proposals."
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopListSeq.get() == listSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopRefreshing.value = false
        }
      }
    }
  }

  private suspend fun inspectSkillWorkshopProposalFromGateway(
    proposalId: String,
    agentId: String?,
  ) {
    var inspectSeq = 0L
    val requestAgentId = normalizeSkillWorkshopAgentId(agentId)
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillWorkshopErrorText.value = "Connect the gateway to inspect Skill Workshop proposals."
      return
    }
    var inspectStarted = false
    val scopeCurrent =
      publishGatewayData(gatewayScope) {
        val currentSummary = _skillWorkshopSummary.value
        if (
          currentSummary.agentId == requestAgentId &&
          currentSummary.proposals.any { it.id == proposalId } &&
          _skillWorkshopMutatingProposalId.value == null
        ) {
          inspectStarted = true
          inspectSeq = skillWorkshopInspectSeq.incrementAndGet()
          _skillWorkshopInspectingProposalId.value = proposalId
          _skillWorkshopErrorText.value = null
        }
      }
    if (!scopeCurrent || !inspectStarted) {
      return
    }
    try {
      val res =
        requestGatewayData(
          gatewayScope,
          "skills.proposals.inspect",
          skillWorkshopParams(agentId = agentId, proposalId = proposalId).toString(),
        )
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val previous =
        _skillWorkshopSummary.value
          .takeIf { it.agentId == requestAgentId }
          ?.proposals
          ?.firstOrNull { it.id == proposalId }
      val inspected =
        parseSkillWorkshopProposalInspect(root, previous)
          ?: throw IllegalStateException("skills.proposals.inspect returned no proposal")
      publishGatewayData(gatewayScope) {
        val currentSummary = _skillWorkshopSummary.value
        if (
          skillWorkshopInspectSeq.get() == inspectSeq &&
          currentSummary.agentId == requestAgentId &&
          currentSummary.proposals.any { it.id == proposalId }
        ) {
          _skillWorkshopSummary.value = _skillWorkshopSummary.value.withProposal(inspected)
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopInspectSeq.get() == inspectSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopErrorText.value = "Could not inspect Skill Workshop proposal."
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopInspectSeq.get() == inspectSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopInspectingProposalId.value = null
        }
      }
    }
  }

  private suspend fun mutateSkillWorkshopProposalOnGateway(
    proposalId: String,
    agentId: String?,
    action: SkillWorkshopGatewayAction,
  ) {
    var mutationSeq = 0L
    val requestAgentId = normalizeSkillWorkshopAgentId(agentId)
    if (!operatorAdminScopeAvailable.value) {
      _skillWorkshopErrorText.value = "Skill Workshop proposal actions require operator.admin scope."
      return
    }
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillWorkshopErrorText.value = "Connect the gateway to update Skill Workshop proposals."
      return
    }
    var mutationStarted = false
    val scopeCurrent =
      publishGatewayData(gatewayScope) {
        val currentSummary = _skillWorkshopSummary.value
        if (
          currentSummary.agentId == requestAgentId &&
          currentSummary.proposals.any { it.id == proposalId } &&
          _skillWorkshopMutatingProposalId.value == null
        ) {
          mutationStarted = true
          mutationSeq = skillWorkshopMutationSeq.incrementAndGet()
          // A lifecycle action supersedes any older detail read. Without this
          // guard, a late inspect response can restore the pre-action status.
          skillWorkshopInspectSeq.incrementAndGet()
          _skillWorkshopInspectingProposalId.value = null
          _skillWorkshopMutatingProposalId.value = proposalId
          _skillWorkshopErrorText.value = null
          _skillWorkshopNoticeText.value = null
        }
      }
    if (!scopeCurrent || !mutationStarted) {
      return
    }
    try {
      val res =
        requestGatewayData(
          gatewayScope,
          "skills.proposals.${action.methodSuffix}",
          skillWorkshopParams(agentId = agentId, proposalId = proposalId).toString(),
        )
      val updatedProposal =
        parseSkillWorkshopProposalActionResult(
          root = json.parseToJsonElement(res).asObjectOrNull(),
          previous =
            _skillWorkshopSummary.value
              .takeIf { it.agentId == requestAgentId }
              ?.proposals
              ?.firstOrNull { it.id == proposalId },
        )
      var mutationConfirmed = false
      publishGatewayData(gatewayScope) {
        if (skillWorkshopMutationSeq.get() == mutationSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          if (updatedProposal?.status == action.expectedStatus) {
            _skillWorkshopSummary.value = _skillWorkshopSummary.value.withProposal(updatedProposal)
            _skillWorkshopNoticeText.value = action.notice
            mutationConfirmed = true
          } else {
            val statusLabel = updatedProposal?.status?.takeIf { it.isNotBlank() } ?: "unknown"
            _skillWorkshopErrorText.value =
              "Gateway returned status '$statusLabel' after ${action.verb}."
          }
        }
      }
      if (!mutationConfirmed) return
      var refreshStillCurrent = false
      publishGatewayData(gatewayScope) {
        refreshStillCurrent =
          skillWorkshopMutationSeq.get() == mutationSeq &&
          _skillWorkshopSummary.value.agentId == requestAgentId
      }
      if (refreshStillCurrent) {
        refreshSkillWorkshopProposalsFromGateway(agentId = agentId)
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopMutationSeq.get() == mutationSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopErrorText.value = "Could not ${action.verb} Skill Workshop proposal."
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopMutationSeq.get() == mutationSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopMutatingProposalId.value = null
        }
      }
    }
  }

  private fun normalizeSkillWorkshopAgentId(agentId: String?): String = agentId?.trim().orEmpty()

  private fun skillWorkshopParams(
    agentId: String?,
    proposalId: String? = null,
  ): JsonObject =
    buildJsonObject {
      val normalizedAgentId = agentId?.trim()?.takeIf { it.isNotEmpty() }
      if (normalizedAgentId != null) put("agentId", JsonPrimitive(normalizedAgentId))
      val normalizedProposalId = proposalId?.trim()?.takeIf { it.isNotEmpty() }
      if (normalizedProposalId != null) put("proposalId", JsonPrimitive(normalizedProposalId))
    }

  private suspend fun refreshNodesDevicesFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    val refreshGeneration = nodeApprovalRefreshGuard.begin()
    var refreshStarted = false
    val currentScope =
      publishGatewayData(gatewayScope) {
        refreshStarted =
          nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
            _nodesDevicesRefreshing.value = true
            _nodesDevicesErrorText.value = null
            _nodesDevicesSummary.value = _nodesDevicesSummary.value.withoutExactApprovalRequestIds()
            val pendingFallback = _nodeCapabilityApproval.value.withoutExactRequestId()
            if (pendingFallback != null) {
              _nodeCapabilityApproval.value = pendingFallback
            } else if (
              _nodeCapabilityApproval.value !is GatewayNodeCapabilityApproval.PendingApproval &&
              _nodeCapabilityApproval.value !is GatewayNodeCapabilityApproval.PendingReapproval
            ) {
              _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Loading
            }
          }
      }
    if (!currentScope || !refreshStarted) return
    if (!operatorConnected) {
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Loading
          _nodesDevicesSummary.value =
            GatewayNodesDevicesSummary(
              nodes = emptyList(),
              pendingDevices = emptyList(),
              pairedDevices = emptyList(),
            )
          _nodesDevicesRefreshing.value = false
        }
      }
      return
    }
    try {
      val nodesRes = requestGatewayData(gatewayScope, "node.list", "{}")
      val nodesRoot = json.parseToJsonElement(nodesRes).asObjectOrNull()
      val nodes = parseGatewayNodeList(nodesRoot)
      val selfNodeId = identityStore.loadOrCreate().deviceId
      val approval =
        currentNodeCapabilityApproval(
          nodes = nodes,
          selfNodeId = selfNodeId,
        )
      val selfNodeConnected = nodes.firstOrNull { it.id == selfNodeId }?.connected == true
      var approvalPublished = false
      val scopePublished =
        publishGatewayData(gatewayScope) {
          approvalPublished =
            nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
              _nodeCapabilityApproval.value = approval
            }
        }
      if (!scopePublished || !approvalPublished) {
        return
      }
      publishGatewayData(gatewayScope) {
        if (selfNodeConnected && !_nodeConnected.value) {
          updateStatus {
            nodeConnectionProblem = null
            _nodeConnected.value = true
            nodeStatusText = "Connected"
          }
        }
      }
      scheduleNodeApprovalCommandRefresh(gatewayScope, refreshGeneration, approval)
      val devicesRoot =
        try {
          val devicesRes = requestGatewayData(gatewayScope, "device.pair.list", "{}")
          json.parseToJsonElement(devicesRes).asObjectOrNull()
        } catch (_: Throwable) {
          null
        }
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodesDevicesSummary.value =
            GatewayNodesDevicesSummary(
              nodes = nodes,
              pendingDevices = parsePendingDevices(devicesRoot?.get("pending") as? JsonArray),
              pairedDevices = parsePairedDevices(devicesRoot?.get("paired") as? JsonArray),
              devicePairingAvailable = devicesRoot != null,
            )
        }
      }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodesDevicesErrorText.value = "Could not load nodes and devices."
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodesDevicesRefreshing.value = false
        }
      }
    }
  }

  private fun scheduleNodeApprovalCommandRefresh(
    gatewayScope: GatewayDataScope,
    refreshGeneration: Long,
    approval: GatewayNodeCapabilityApproval,
  ) {
    val fallback = approval.withoutExactRequestId() ?: return
    scope.launch {
      delay(NODE_APPROVAL_COMMAND_FRESH_MS)
      // Pairing request IDs expire on the Gateway. Age out cached commands before rechecking so
      // recovery never leaves an old exact ID visible when a refresh fails or races disconnect.
      var approvalPublished = false
      val scopePublished =
        publishGatewayData(gatewayScope) {
          approvalPublished =
            nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
              _nodeCapabilityApproval.value = fallback
              _nodesDevicesSummary.value = _nodesDevicesSummary.value.withoutExactApprovalRequestIds()
            }
        }
      if (scopePublished && approvalPublished && operatorConnected) {
        refreshNodesDevicesFromGateway()
      }
    }
  }

  private suspend fun refreshExecApprovalsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    val refreshGeneration = execApprovalsRefreshSeq.incrementAndGet()
    publishGatewayData(gatewayScope) {
      _execApprovalsRefreshing.value = true
      _execApprovalsErrorText.value = null
    }
    if (!operatorConnected) {
      publishGatewayData(gatewayScope) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration) {
          _execApprovals.value = emptyList()
          _execApprovalsRefreshing.value = false
        }
      }
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "exec.approval.list", "{}")
      val existing = _execApprovals.value.associateBy { it.id }
      val rows =
        parseGatewayExecApprovalListPayload(res, json)
          .filterNot { it.id in resolvedExecApprovalIds }
          .map { row ->
            val hydrated =
              try {
                fetchExecApprovalDetailFromGateway(
                  gatewayScope = gatewayScope,
                  id = row.id,
                  createdAtMs = row.createdAtMs ?: System.currentTimeMillis(),
                )
              } catch (_: Throwable) {
                null
              } ?: row.copy(errorText = "Could not load approval details. Refresh and try again.")
            val current = existing[row.id]
            if (current == null) {
              hydrated
            } else {
              hydrated.copy(
                resolvingDecision = current.resolvingDecision,
                errorText = current.errorText ?: hydrated.errorText,
              )
            }
          }
      publishExecApprovalsIfCurrent(gatewayScope, refreshGeneration, rows)
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration) {
          _execApprovalsErrorText.value = "Could not load approvals."
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration) {
          _execApprovalsRefreshing.value = false
        }
      }
    }
  }

  private suspend fun refreshExecApprovalFromGateway(id: String) {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) return
    if (id in resolvedExecApprovalIds) return
    try {
      val current = _execApprovals.value.firstOrNull { it.id == id }
      val row =
        fetchExecApprovalDetailFromGateway(
          gatewayScope = gatewayScope,
          id = id,
          createdAtMs = current?.createdAtMs ?: System.currentTimeMillis(),
        ) ?: return
      publishGatewayData(gatewayScope) {
        if (id !in resolvedExecApprovalIds) {
          invalidateExecApprovalRefreshes()
          upsertExecApproval(row)
        }
      }
    } catch (_: Throwable) {
      if (isGatewayDataScopeCurrent(gatewayScope)) {
        refreshExecApprovalsFromGateway()
      }
    }
  }

  private suspend fun fetchExecApprovalDetailFromGateway(
    gatewayScope: GatewayDataScope,
    id: String,
    createdAtMs: Long,
  ): GatewayExecApprovalSummary? {
    val params = buildJsonObject { put("id", JsonPrimitive(id)) }.toString()
    val res = requestGatewayData(gatewayScope, "exec.approval.get", params)
    val root = json.parseToJsonElement(res).asObjectOrNull() ?: return null
    return parseGatewayExecApprovalDetail(root, createdAtMs = createdAtMs)
  }

  private suspend fun resolveExecApprovalOnGateway(
    id: String,
    decision: String,
  ) {
    val gatewayScope = captureGatewayDataScope() ?: return
    var markedResolving = false
    val currentScope =
      publishGatewayData(gatewayScope) {
        synchronized(execApprovalsStateLock) {
          if (!operatorConnected || id in resolvedExecApprovalIds) return@synchronized
          val currentRows = _execApprovals.value
          if (currentRows.none { it.id == id }) return@synchronized
          invalidateExecApprovalRefreshes()
          _execApprovals.value =
            currentRows.map { row ->
              if (row.id == id) row.copy(resolvingDecision = decision, errorText = null) else row
            }
          markedResolving = true
        }
      }
    if (!currentScope || !markedResolving) return
    try {
      val params =
        buildJsonObject {
          put("id", JsonPrimitive(id))
          put("decision", JsonPrimitive(decision))
        }.toString()
      requestGatewayData(gatewayScope, "exec.approval.resolve", params)
      publishGatewayData(gatewayScope) { markExecApprovalResolved(id) }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        synchronized(execApprovalsStateLock) {
          if (!operatorConnected || id in resolvedExecApprovalIds) return@synchronized
          _execApprovals.value =
            _execApprovals.value.map { row ->
              if (row.id == id) {
                row.copy(resolvingDecision = null, errorText = "Could not resolve approval. Refresh and try again.")
              } else {
                row
              }
            }
        }
      }
    }
  }

  private fun upsertExecApproval(row: GatewayExecApprovalSummary) {
    synchronized(execApprovalsStateLock) {
      if (!operatorConnected || row.id in resolvedExecApprovalIds) return
      if (row.isExpiredExecApproval()) return
      val rows = _execApprovals.value
      val replaced = rows.any { it.id == row.id }
      val nextRows =
        (
          if (replaced) {
            rows.map { current ->
              if (current.id == row.id) {
                row.copy(
                  resolvingDecision = current.resolvingDecision,
                  errorText = current.errorText,
                )
              } else {
                current
              }
            }
          } else {
            rows + row
          }
        ).filterActiveExecApprovals()
          .sortedBy { it.createdAtMs ?: Long.MAX_VALUE }
      _execApprovals.value = nextRows
      scheduleExecApprovalExpiryPrune(nextRows)
    }
  }

  private fun invalidateExecApprovalRefreshes() {
    execApprovalsRefreshSeq.incrementAndGet()
    _execApprovalsRefreshing.value = false
  }

  private fun markExecApprovalResolved(id: String) {
    synchronized(execApprovalsStateLock) {
      resolvedExecApprovalIds.add(id)
      invalidateExecApprovalRefreshes()
      _execApprovals.value = _execApprovals.value.filterNot { it.id == id }
    }
  }

  private fun publishExecApprovalsIfCurrent(
    gatewayScope: GatewayDataScope,
    refreshGeneration: Long,
    rows: List<GatewayExecApprovalSummary>,
  ) {
    publishGatewayData(gatewayScope) {
      synchronized(execApprovalsStateLock) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration && operatorConnected) {
          val nextRows = rows.filterNot { it.id in resolvedExecApprovalIds }.filterActiveExecApprovals()
          _execApprovals.value = nextRows
          scheduleExecApprovalExpiryPrune(nextRows)
        }
      }
    }
  }

  private fun scheduleExecApprovalExpiryPrune(rows: List<GatewayExecApprovalSummary>) {
    val now = System.currentTimeMillis()
    val nextExpiry = rows.mapNotNull { it.expiresAtMs }.filter { it > now }.minOrNull() ?: return
    scope.launch {
      delay((nextExpiry - now + 250).coerceAtLeast(0))
      pruneExpiredExecApprovals()
    }
  }

  private fun pruneExpiredExecApprovals() {
    synchronized(execApprovalsStateLock) {
      _execApprovals.value = _execApprovals.value.filterActiveExecApprovals()
    }
  }

  private fun GatewayExecApprovalSummary.isExpiredExecApproval(nowMs: Long = System.currentTimeMillis()): Boolean = expiresAtMs?.let { it <= nowMs } == true

  private fun List<GatewayExecApprovalSummary>.filterActiveExecApprovals(
    nowMs: Long = System.currentTimeMillis(),
  ): List<GatewayExecApprovalSummary> = filterNot { it.isExpiredExecApproval(nowMs) }

  private fun invalidateNodeCapabilityApprovalState() {
    val refreshGeneration = nodeApprovalRefreshGuard.begin()
    nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
      _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Loading
      _nodesDevicesSummary.value = _nodesDevicesSummary.value.withoutExactApprovalRequestIds()
      _nodesDevicesRefreshing.value = false
    }
  }

  private suspend fun refreshChannelsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _channelsRefreshing.value = true
      _channelsErrorText.value = null
    }
    if (!operatorConnected) {
      _channelsSummary.value = GatewayChannelsSummary(channels = emptyList())
      _channelsRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "channels.status", """{"probe":false,"timeoutMs":8000}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val summary =
        GatewayChannelsSummary(
          updatedAtMs = root.long("ts"),
          partial = root.boolean("partial"),
          warnings = parseStringArray(root?.get("warnings") as? JsonArray),
          channels = parseChannelSummaries(root),
        )
      publishGatewayData(gatewayScope) { _channelsSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _channelsErrorText.value = "Could not load channels." }
    } finally {
      publishGatewayData(gatewayScope) { _channelsRefreshing.value = false }
    }
  }

  private suspend fun refreshDreamingFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _dreamingRefreshing.value = true
      _dreamingErrorText.value = null
    }
    if (!operatorConnected) {
      _dreamingSummary.value = GatewayDreamingSummary()
      _dreamingRefreshing.value = false
      return
    }
    try {
      val statusRes = requestGatewayData(gatewayScope, "doctor.memory.status", "{}")
      val statusRoot = json.parseToJsonElement(statusRes).asObjectOrNull()
      val diaryRes = requestGatewayData(gatewayScope, "doctor.memory.dreamDiary", "{}")
      val diaryRoot = json.parseToJsonElement(diaryRes).asObjectOrNull()
      val dreaming = statusRoot?.get("dreaming").asObjectOrNull()
      val summary =
        parseDreamingSummary(
          dreaming = dreaming,
          diary = diaryRoot,
        )
      publishGatewayData(gatewayScope) { _dreamingSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _dreamingErrorText.value = "Could not load dreaming." }
    } finally {
      publishGatewayData(gatewayScope) { _dreamingRefreshing.value = false }
    }
  }

  private suspend fun refreshHealthLogsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _healthLogsRefreshing.value = true
      _healthLogsErrorText.value = null
    }
    if (!operatorConnected) {
      _healthLogsSummary.value = GatewayHealthLogsSummary()
      _healthLogsRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "logs.tail", """{"limit":40,"maxBytes":65536}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val lines = (root?.get("lines") as? JsonArray)?.mapNotNull { it.asStringOrNull() }.orEmpty()
      val summary =
        GatewayHealthLogsSummary(
          fileName =
            root
              ?.get("file")
              .asStringOrNull()
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?.substringAfterLast('/')
              ?.substringAfterLast('\\'),
          cursor = root.long("cursor"),
          truncated = root.boolean("truncated"),
          entries = lines.map { parseGatewayLogEntry(it) },
        )
      publishGatewayData(gatewayScope) { _healthLogsSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _healthLogsErrorText.value = "Could not load gateway logs." }
    } finally {
      publishGatewayData(gatewayScope) { _healthLogsRefreshing.value = false }
    }
  }

  private fun parseGatewayLogEntry(line: String): GatewayLogEntry {
    val sanitizedLine = sanitizeGatewayLogText(line)
    val root =
      try {
        json.parseToJsonElement(line).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return GatewayLogEntry(
        time = null,
        level = null,
        subsystem = null,
        message = sanitizedLine.trim().ifEmpty { "Empty log entry" },
        raw = sanitizedLine,
      )
    val meta = root["_meta"].asObjectOrNull()
    val time = root["time"].asStringOrNull() ?: meta?.get("date").asStringOrNull()
    val level = normalizeLogLevel(meta?.get("logLevelName").asStringOrNull() ?: meta?.get("level").asStringOrNull())
    val contextCandidate = root["0"].asStringOrNull() ?: meta?.get("name").asStringOrNull()
    val contextObject = parseMaybeJsonObject(contextCandidate)
    val subsystem =
      contextObject?.get("subsystem").asStringOrNull()
        ?: contextObject?.get("module").asStringOrNull()
        ?: contextCandidate?.takeIf { it.length < 80 && contextObject == null }
    val contextMessage = if (contextObject == null) root["0"].asStringOrNull() else null
    val message =
      root["1"].asStringOrNull()
        ?: root["2"].asStringOrNull()
        ?: contextMessage
        ?: root["message"].asStringOrNull()
        ?: line
    val normalizedMessage =
      sanitizeGatewayLogText(message)
        .trim()
        .replace(Regex("\\s+"), " ")
        .take(240)
        .ifEmpty { "Log entry" }
    return GatewayLogEntry(
      time = time,
      level = level,
      subsystem = subsystem?.let(::sanitizeGatewayLogText)?.trim()?.takeIf { it.isNotEmpty() },
      message = normalizedMessage,
      raw = sanitizedLine,
    )
  }

  private fun parseMaybeJsonObject(value: String?): JsonObject? {
    val trimmed = value?.trim().orEmpty()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null
    return try {
      json.parseToJsonElement(trimmed).asObjectOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private fun normalizeLogLevel(value: String?): String? {
    val level = value?.trim()?.lowercase().orEmpty()
    return if (level in setOf("trace", "debug", "info", "warn", "error", "fatal")) level else null
  }

  private fun parseGatewayModelProviders(providers: JsonArray?): List<GatewayModelProviderSummary> =
    providers
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj["provider"].asStringOrNull()?.trim().orEmpty()
        if (id.isEmpty()) return@mapNotNull null
        GatewayModelProviderSummary(
          id = id,
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: providerDisplayName(id),
          status = obj["status"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unknown",
          profileCount = ((obj["profiles"] as? JsonArray)?.size ?: 0),
        )
      }.orEmpty()

  private fun parseCronJobs(jobs: JsonArray?): List<GatewayCronJobSummary> =
    jobs
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj["id"].asStringOrNull()?.trim().orEmpty()
        val name = obj["name"].asStringOrNull()?.trim().orEmpty()
        if (id.isEmpty() || name.isEmpty()) return@mapNotNull null
        val schedule = obj["schedule"].asObjectOrNull()
        val state = obj["state"].asObjectOrNull()
        val payload = obj["payload"].asObjectOrNull()
        GatewayCronJobSummary(
          id = id,
          name = name,
          enabled = obj.boolean("enabled"),
          scheduleLabel = cronScheduleLabel(schedule),
          promptPreview = cronPayloadPreview(payload),
          nextRunAtMs = state.long("nextRunAtMs"),
          lastRunStatus = cronJobLastRunStatus(state),
        )
      }.orEmpty()

  private fun parseUsageProviders(providers: JsonArray?): List<GatewayUsageProviderSummary> =
    providers
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val displayName = obj["displayName"].asStringOrNull()?.trim().orEmpty()
        if (displayName.isEmpty()) return@mapNotNull null
        GatewayUsageProviderSummary(
          displayName = displayName,
          plan = obj["plan"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          error = obj["error"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          windows = parseUsageWindows(obj["windows"] as? JsonArray),
        )
      }.orEmpty()

  private fun parseUsageWindows(windows: JsonArray?): List<GatewayUsageWindowSummary> =
    windows
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val label = obj["label"].asStringOrNull()?.trim().orEmpty()
        if (label.isEmpty()) return@mapNotNull null
        GatewayUsageWindowSummary(
          label = label,
          usedPercent = obj.double("usedPercent") ?: 0.0,
          resetAtMs = obj.long("resetAt"),
        )
      }.orEmpty()

  private fun parseSkillSummaries(skills: JsonArray?): List<GatewaySkillSummary> =
    skills
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val name = obj["name"].asStringOrNull()?.trim().orEmpty()
        if (name.isEmpty()) return@mapNotNull null
        val missing = obj["missing"].asObjectOrNull()
        GatewaySkillSummary(
          skillKey = obj["skillKey"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: name,
          name = name,
          description = obj["description"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          source = obj["source"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unknown",
          emoji = obj["emoji"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          disabled = obj.boolean("disabled"),
          eligible = obj.boolean("eligible"),
          blockedByAllowlist = obj.boolean("blockedByAllowlist"),
          bundled = obj.boolean("bundled"),
          missingCount = skillMissingCount(missing),
          installCount = (obj["install"] as? JsonArray)?.size ?: 0,
        )
      }.orEmpty()

  private fun parseSkillWorkshopProposals(
    proposals: JsonArray?,
    previousById: Map<String, GatewaySkillWorkshopProposal>,
  ): List<GatewaySkillWorkshopProposal> {
    val parsed =
      proposals?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj.skillWorkshopString("id") ?: return@mapNotNull null
        val previous = previousById[id]
        val updatedAt = obj.skillWorkshopString("updatedAt").orEmpty()
        GatewaySkillWorkshopProposal(
          id = id,
          kind = obj.skillWorkshopString("kind") ?: "proposal",
          status = obj.skillWorkshopString("status") ?: "pending",
          title = obj.skillWorkshopString("title") ?: obj.skillWorkshopString("skillName") ?: id,
          description = obj.skillWorkshopString("description"),
          skillName = obj.skillWorkshopString("skillName") ?: id,
          skillKey = obj.skillWorkshopString("skillKey") ?: id,
          createdAt = obj.skillWorkshopString("createdAt").orEmpty(),
          updatedAt = updatedAt,
          scanState = obj.skillWorkshopString("scanState"),
          content = previous?.content?.takeIf { previous.updatedAt == updatedAt },
          supportFiles = previous?.supportFiles?.takeIf { previous.updatedAt == updatedAt }.orEmpty(),
        )
      }
    return parsed.orEmpty().sortedByDescending { it.updatedAt }
  }

  private fun parseSkillWorkshopProposalInspect(
    root: JsonObject?,
    previous: GatewaySkillWorkshopProposal?,
  ): GatewaySkillWorkshopProposal? {
    val source = root ?: return null
    val record = source["record"].asObjectOrNull() ?: return null
    val id = record.skillWorkshopString("id") ?: previous?.id ?: return null
    val target = record["target"].asObjectOrNull()
    val updatedAt = record.skillWorkshopString("updatedAt").orEmpty()
    return GatewaySkillWorkshopProposal(
      id = id,
      kind = record.skillWorkshopString("kind") ?: previous?.kind ?: "proposal",
      status = record.skillWorkshopString("status") ?: previous?.status ?: "pending",
      title = record.skillWorkshopString("title") ?: target?.skillWorkshopString("skillName") ?: previous?.title ?: id,
      description = record.skillWorkshopString("description") ?: previous?.description,
      skillName = target?.skillWorkshopString("skillName") ?: previous?.skillName ?: id,
      skillKey = target?.skillWorkshopString("skillKey") ?: previous?.skillKey ?: id,
      createdAt = record.skillWorkshopString("createdAt") ?: previous?.createdAt.orEmpty(),
      updatedAt = updatedAt.ifEmpty { previous?.updatedAt.orEmpty() },
      scanState = record.skillWorkshopString("scanState") ?: previous?.scanState,
      content = stripSkillWorkshopFrontmatter(source["content"].asStringOrNull().orEmpty()),
      supportFiles = parseSkillWorkshopSupportFiles(source["supportFiles"] as? JsonArray),
    )
  }

  private fun parseSkillWorkshopProposalActionResult(
    root: JsonObject?,
    previous: GatewaySkillWorkshopProposal?,
  ): GatewaySkillWorkshopProposal? {
    val record =
      root?.get("record").asObjectOrNull()
        ?: root?.takeIf { it.skillWorkshopString("status") != null }
        ?: return null
    val id = record.skillWorkshopString("id") ?: previous?.id ?: return null
    val target = record["target"].asObjectOrNull()
    val updatedAt = record.skillWorkshopString("updatedAt").orEmpty()
    return GatewaySkillWorkshopProposal(
      id = id,
      kind = record.skillWorkshopString("kind") ?: previous?.kind ?: "proposal",
      status = record.skillWorkshopString("status") ?: previous?.status ?: "pending",
      title = record.skillWorkshopString("title") ?: target?.skillWorkshopString("skillName") ?: previous?.title ?: id,
      description = record.skillWorkshopString("description") ?: previous?.description,
      skillName = target?.skillWorkshopString("skillName") ?: previous?.skillName ?: id,
      skillKey = target?.skillWorkshopString("skillKey") ?: previous?.skillKey ?: id,
      createdAt = record.skillWorkshopString("createdAt") ?: previous?.createdAt.orEmpty(),
      updatedAt = updatedAt.ifEmpty { previous?.updatedAt.orEmpty() },
      scanState =
        record["scan"].asObjectOrNull()?.skillWorkshopString("state")
          ?: record.skillWorkshopString("scanState")
          ?: previous?.scanState,
      content = previous?.content,
      supportFiles = previous?.supportFiles.orEmpty(),
    )
  }

  private fun parseSkillWorkshopSupportFiles(files: JsonArray?): List<GatewaySkillWorkshopSupportFile> {
    val parsed =
      files?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val path = obj.skillWorkshopString("path") ?: return@mapNotNull null
        GatewaySkillWorkshopSupportFile(
          path = path,
          content = obj["content"].asStringOrNull()?.takeIf { it.isNotEmpty() },
        )
      }
    return parsed.orEmpty()
  }

  private fun stripSkillWorkshopFrontmatter(content: String): String {
    val withoutFrontmatter = content.replace(Regex("(?s)^---\\r?\\n.*?\\r?\\n---\\r?\\n?"), "")
    return withoutFrontmatter.trim()
  }

  private fun JsonObject.skillWorkshopString(key: String): String? =
    get(key)
      .asStringOrNull()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

  private fun skillMissingCount(missing: JsonObject?): Int = listOf("bins", "env", "config", "os").sumOf { key -> (missing?.get(key) as? JsonArray)?.size ?: 0 }

  private fun parsePendingDevices(devices: JsonArray?): List<GatewayPendingDeviceSummary> =
    devices
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val requestId = obj["requestId"].asStringOrNull()?.trim().orEmpty()
        val deviceId = obj["deviceId"].asStringOrNull()?.trim().orEmpty()
        if (requestId.isEmpty() || deviceId.isEmpty()) return@mapNotNull null
        GatewayPendingDeviceSummary(
          requestId = requestId,
          deviceId = deviceId,
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          roles = parseStringArray(obj["roles"] as? JsonArray),
          scopes = parseStringArray(obj["scopes"] as? JsonArray),
          requestedAtMs = obj.long("ts"),
          repair = obj.boolean("isRepair"),
        )
      }.orEmpty()

  private fun parsePairedDevices(devices: JsonArray?): List<GatewayPairedDeviceSummary> =
    devices
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val deviceId = obj["deviceId"].asStringOrNull()?.trim().orEmpty()
        if (deviceId.isEmpty()) return@mapNotNull null
        GatewayPairedDeviceSummary(
          deviceId = deviceId,
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          roles = parseStringArray(obj["roles"] as? JsonArray),
          scopes = parseStringArray(obj["scopes"] as? JsonArray),
          tokens = parseDeviceTokens(obj["tokens"] as? JsonArray),
          approvedAtMs = obj.long("approvedAtMs"),
        )
      }.orEmpty()

  private fun parseDeviceTokens(tokens: JsonArray?): List<GatewayDeviceTokenSummary> =
    tokens
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = obj["role"].asStringOrNull()?.trim().orEmpty()
        if (role.isEmpty()) return@mapNotNull null
        GatewayDeviceTokenSummary(
          role = role,
          scopes = parseStringArray(obj["scopes"] as? JsonArray),
          revoked = obj.long("revokedAtMs") != null,
          updatedAtMs = obj.long("rotatedAtMs") ?: obj.long("createdAtMs") ?: obj.long("lastUsedAtMs"),
        )
      }.orEmpty()

  private fun parseChannelSummaries(root: JsonObject?): List<GatewayChannelSummary> {
    val order = parseStringArray(root?.get("channelOrder") as? JsonArray)
    val labels = parseStringMap(root?.get("channelLabels").asObjectOrNull())
    val channels = root?.get("channels").asObjectOrNull()
    val accounts = root?.get("channelAccounts").asObjectOrNull()
    val ids = (order + channels.orEmpty().keys + accounts.orEmpty().keys).distinct()
    return ids
      .map { id ->
        val summary = channels?.get(id).asObjectOrNull()
        val accountRows = parseChannelAccounts(accounts?.get(id) as? JsonArray)
        GatewayChannelSummary(
          id = id,
          label = labels[id] ?: channelDisplayLabel(id),
          accountCount = accountRows.size,
          enabled = summary.boolean("enabled") || accountRows.any { it.enabled },
          configured = summary.boolean("configured") || accountRows.any { it.configured },
          linked = summary.boolean("linked") || accountRows.any { it.linked },
          running = summary.boolean("running") || accountRows.any { it.running },
          connected = summary.boolean("connected") || accountRows.any { it.connected },
          error =
            summary
              ?.get("lastError")
              .asStringOrNull()
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?: accountRows.firstNotNullOfOrNull { it.error },
        )
      }.sortedWith(compareByDescending<GatewayChannelSummary> { it.enabled || it.configured }.thenBy { it.label.lowercase() })
  }

  private fun parseChannelAccounts(accounts: JsonArray?): List<GatewayChannelAccountSummary> =
    accounts
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val accountId = obj["accountId"].asStringOrNull()?.trim().orEmpty()
        if (accountId.isEmpty()) return@mapNotNull null
        GatewayChannelAccountSummary(
          enabled = obj.boolean("enabled"),
          configured = obj.boolean("configured"),
          linked = obj.boolean("linked"),
          running = obj.boolean("running"),
          connected = obj.boolean("connected"),
          error =
            obj["lastError"]
              .asStringOrNull()
              ?.trim()
              ?.takeIf { it.isNotEmpty() },
        )
      }.orEmpty()

  private fun parseStringMap(map: JsonObject?): Map<String, String> =
    map
      ?.mapNotNull { (key, value) ->
        value
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let { key to it }
      }?.toMap()
      .orEmpty()

  private fun parseDreamingSummary(
    dreaming: JsonObject?,
    diary: JsonObject?,
  ): GatewayDreamingSummary {
    val diaryContent = diary?.get("content").asStringOrNull()
    val entries = if (diary.boolean("found")) parseDreamDiaryEntries(diaryContent) else emptyList()
    val timezone =
      dreaming
        ?.get("timezone")
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    val storeHealthy =
      dreaming
        ?.get("storeError")
        .asStringOrNull()
        ?.trim()
        .isNullOrEmpty()
    val phaseSignalHealthy =
      dreaming
        ?.get("phaseSignalError")
        .asStringOrNull()
        ?.trim()
        .isNullOrEmpty()
    return GatewayDreamingSummary(
      enabled = dreaming.boolean("enabled"),
      timezone = timezone,
      shortTermCount = dreaming.long("shortTermCount")?.toInt() ?: 0,
      groundedSignalCount = dreaming.long("groundedSignalCount")?.toInt() ?: 0,
      totalSignalCount = dreaming.long("totalSignalCount")?.toInt() ?: 0,
      promotedToday = dreaming.long("promotedToday")?.toInt() ?: 0,
      promotedTotal = dreaming.long("promotedTotal")?.toInt() ?: 0,
      nextRunAtMs = dreamingNextRunAtMs(dreaming),
      storeHealthy = storeHealthy,
      phaseSignalHealthy = phaseSignalHealthy,
      diaryFound = diary.boolean("found"),
      diaryEntries = entries,
      diaryEntryCount = entries.size,
    )
  }

  private fun dreamingNextRunAtMs(dreaming: JsonObject?): Long? {
    val phases = dreaming?.get("phases").asObjectOrNull()
    return listOf("light", "deep", "rem")
      .mapNotNull { phase -> phases?.get(phase).asObjectOrNull().long("nextRunAtMs") }
      .minOrNull()
  }

  private fun parseDreamDiaryEntries(content: String?): List<GatewayDreamDiaryEntry> {
    val raw = content?.trim().orEmpty()
    if (raw.isEmpty()) return emptyList()
    val body = raw.substringAfter("<!-- openclaw:dreaming:diary:start -->", raw).substringBefore("<!-- openclaw:dreaming:diary:end -->")
    return body
      .split(Regex("\\n---\\n"))
      .mapNotNull(::parseDreamDiaryEntry)
      .asReversed()
      .take(4)
  }

  private fun parseDreamDiaryEntry(block: String): GatewayDreamDiaryEntry? {
    val lines = block.trim().lines()
    val date =
      lines
        .firstOrNull { line ->
          val trimmed = line.trim()
          trimmed.length > 2 && trimmed.startsWith("*") && trimmed.endsWith("*")
        }?.trim()
        ?.trim('*')
        ?.takeIf { it.isNotEmpty() }
    val text =
      lines
        .map { it.trim() }
        .filter { line -> line.isNotEmpty() && !line.startsWith("#") && !line.startsWith("<!--") && !(line.startsWith("*") && line.endsWith("*")) }
        .joinToString(" ")
        .replace(Regex("\\s+"), " ")
        .takeIf { it.isNotEmpty() }
    return text?.let { GatewayDreamDiaryEntry(date = date ?: "Dream", text = it) }
  }

  private fun parseStringArray(items: JsonArray?): List<String> =
    items
      ?.mapNotNull { item -> item.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } }
      .orEmpty()

  private fun cronScheduleLabel(schedule: JsonObject?): String =
    when (schedule?.get("kind").asStringOrNull()) {
      "at" -> "One time"
      "every" -> schedule.long("everyMs")?.let(::formatCronInterval) ?: "Repeating"
      "cron" ->
        schedule
          ?.get("expr")
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() } ?: "Cron"
      else -> "Scheduled"
    }

  private fun cronPayloadPreview(payload: JsonObject?): String {
    val text =
      when (payload?.get("kind").asStringOrNull()) {
        "systemEvent" -> payload?.get("text").asStringOrNull()
        "agentTurn" -> payload?.get("message").asStringOrNull()
        else -> null
      }
    return text?.trim()?.replace(Regex("\\s+"), " ")?.takeIf { it.isNotEmpty() } ?: "No prompt"
  }

  private fun updateHomeCanvasState() {
    val payload =
      try {
        json.encodeToString(makeHomeCanvasPayload())
      } catch (_: Throwable) {
        null
      }
    canvas.updateHomeCanvasState(payload)
  }

  private fun makeHomeCanvasPayload(): HomeCanvasPayload {
    val state = resolveHomeCanvasGatewayState()
    val gatewayName = normalized(_serverName.value)
    val gatewayAddress = normalized(_remoteAddress.value)
    val gatewayLabel = gatewayName ?: gatewayAddress ?: "Gateway"
    val activeAgentId = resolveActiveAgentId()
    val agents = homeCanvasAgents(activeAgentId)

    return when (state) {
      HomeCanvasGatewayState.Connected ->
        HomeCanvasPayload(
          gatewayState = "connected",
          eyebrow = "Connected to $gatewayLabel",
          title = "Your agents are ready",
          subtitle =
            "This phone stays dormant until the gateway needs it, then wakes, syncs, and goes back to sleep.",
          gatewayLabel = gatewayLabel,
          activeAgentName = resolveActiveAgentName(activeAgentId),
          activeAgentBadge = agents.firstOrNull { it.isActive }?.badge ?: "OC",
          activeAgentCaption = "Selected on this phone",
          agentCount = agents.size,
          agents = agents.take(6),
          footer = "The overview refreshes on reconnect and when this screen opens.",
        )
      HomeCanvasGatewayState.Connecting ->
        HomeCanvasPayload(
          gatewayState = "connecting",
          eyebrow = "Reconnecting",
          title = "OpenClaw is syncing back up",
          subtitle =
            "The gateway session is coming back online. Agent shortcuts should settle automatically in a moment.",
          gatewayLabel = gatewayLabel,
          activeAgentName = resolveActiveAgentName(activeAgentId),
          activeAgentBadge = "OC",
          activeAgentCaption = "Gateway session in progress",
          agentCount = agents.size,
          agents = agents.take(4),
          footer = "If the gateway is reachable, reconnect should complete without intervention.",
        )
      HomeCanvasGatewayState.Error, HomeCanvasGatewayState.Offline ->
        HomeCanvasPayload(
          gatewayState = if (state == HomeCanvasGatewayState.Error) "error" else "offline",
          eyebrow = "Welcome to OpenClaw",
          title = "Your phone stays quiet until it is needed",
          subtitle =
            "Pair this device to your gateway to wake it only for real work, keep a live agent overview handy, and avoid battery-draining background loops.",
          gatewayLabel = gatewayLabel,
          activeAgentName = "Main",
          activeAgentBadge = "OC",
          activeAgentCaption = "Connect to load your agents",
          agentCount = agents.size,
          agents = agents.take(4),
          footer = "When connected, the gateway can wake the phone with a silent push instead of holding an always-on session.",
        )
    }
  }

  private fun resolveHomeCanvasGatewayState(): HomeCanvasGatewayState {
    val display = gatewayConnectionDisplay.value
    val lower = display.statusText.trim().lowercase()
    return when {
      display.isConnected -> HomeCanvasGatewayState.Connected
      lower.contains("connecting") || lower.contains("reconnecting") -> HomeCanvasGatewayState.Connecting
      lower.contains("error") || lower.contains("failed") -> HomeCanvasGatewayState.Error
      else -> HomeCanvasGatewayState.Offline
    }
  }

  private fun resolveActiveAgentId(): String {
    val mainKey = _mainSessionKey.value.trim()
    if (mainKey.startsWith("agent:")) {
      val agentId = mainKey.removePrefix("agent:").substringBefore(':').trim()
      if (agentId.isNotEmpty()) return agentId
    }
    return gatewayDefaultAgentId.value?.trim().orEmpty()
  }

  private fun resolveActiveAgentName(activeAgentId: String): String {
    if (activeAgentId.isNotEmpty()) {
      gatewayAgents.value.firstOrNull { it.id == activeAgentId }?.let { agent ->
        return normalized(agent.name) ?: agent.id
      }
      return activeAgentId
    }
    return gatewayAgents.value.firstOrNull()?.let { normalized(it.name) ?: it.id } ?: "Main"
  }

  private fun homeCanvasAgents(activeAgentId: String): List<HomeCanvasAgentCard> {
    val defaultAgentId = gatewayDefaultAgentId.value?.trim().orEmpty()
    return gatewayAgents.value
      .map { agent ->
        val isActive = activeAgentId.isNotEmpty() && agent.id == activeAgentId
        val isDefault = defaultAgentId.isNotEmpty() && agent.id == defaultAgentId
        HomeCanvasAgentCard(
          id = agent.id,
          name = normalized(agent.name) ?: agent.id,
          badge = homeCanvasBadge(agent),
          caption =
            when {
              isActive -> "Active on this phone"
              isDefault -> "Default agent"
              else -> "Ready"
            },
          isActive = isActive,
        )
      }.sortedWith(compareByDescending<HomeCanvasAgentCard> { it.isActive }.thenBy { it.name.lowercase() })
  }

  private fun homeCanvasBadge(agent: GatewayAgentSummary): String {
    val emoji = normalized(agent.emoji)
    if (emoji != null) return emoji
    val initials =
      (normalized(agent.name) ?: agent.id)
        .split(' ', '-', '_')
        .filter { it.isNotBlank() }
        .take(2)
        .mapNotNull { token -> token.firstOrNull()?.uppercaseChar()?.toString() }
        .joinToString("")
    return if (initials.isNotEmpty()) initials else "OC"
  }

  private fun normalized(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    return trimmed.ifEmpty { null }
  }

  private fun showCameraHud(
    message: String,
    kind: CameraHudKind,
    autoHideMs: Long? = null,
  ) {
    val token = cameraHudSeq.incrementAndGet()
    _cameraHud.value = CameraHudState(token = token, kind = kind, message = message)

    if (autoHideMs != null && autoHideMs > 0) {
      scope.launch {
        delay(autoHideMs)
        if (_cameraHud.value?.token == token) _cameraHud.value = null
      }
    }
  }
}

internal fun resolveOperatorSessionConnectAuth(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): NodeRuntime.GatewayConnectAuth? {
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = explicitToken,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitPassword != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = explicitPassword,
    )
  }

  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitBootstrapToken = auth.bootstrapToken?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitBootstrapToken != null) {
    return null
  }

  return NodeRuntime.GatewayConnectAuth(
    token = null,
    bootstrapToken = null,
    password = null,
  )
}

internal fun resolveGatewayControlPageAuth(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): NodeRuntime.GatewayConnectAuth {
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = explicitToken,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitPassword != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = explicitPassword,
    )
  }

  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = storedToken,
      bootstrapToken = null,
      password = null,
    )
  }

  return NodeRuntime.GatewayConnectAuth(
    token = null,
    bootstrapToken = null,
    password = null,
  )
}

internal fun operatorSessionUsesStoredDeviceToken(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): Boolean {
  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken == null) return false
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  return explicitToken == null && explicitPassword == null
}

internal fun operatorConnectScopesForAuth(
  usesStoredDeviceToken: Boolean,
  storedOperatorScopes: List<String>?,
): List<String> {
  if (usesStoredDeviceToken && storedOperatorScopes != null) {
    return ConnectionManager.operatorScopesForStoredDeviceToken(storedOperatorScopes)
  }
  return ConnectionManager.nativeClientOperatorScopes
}

internal fun normalizeOperatorScopes(scopes: List<String>): List<String> =
  scopes
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .distinct()
    .sorted()

private enum class HomeCanvasGatewayState {
  Connected,
  Connecting,
  Error,
  Offline,
}

data class GatewayAgentSummary(
  val id: String,
  val name: String?,
  val emoji: String?,
  val workspaceGit: Boolean = false,
)

data class GatewayModelSummary(
  val id: String,
  val name: String,
  val provider: String,
  val available: Boolean?,
  val supportsVision: Boolean,
  val supportsAudio: Boolean,
  val supportsDocuments: Boolean,
  val supportsReasoning: Boolean,
  val contextTokens: Long?,
)

internal fun parseGatewayModels(models: JsonArray?): List<GatewayModelSummary> =
  models
    ?.mapNotNull { item ->
      val obj = item.asObjectOrNull() ?: return@mapNotNull null
      val id = obj["id"].asStringOrNull()?.trim().orEmpty()
      if (id.isEmpty()) return@mapNotNull null
      val provider = obj["provider"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id.substringBefore('/', "default")
      val inputTypes = (obj["input"] as? JsonArray)?.mapNotNull { it.asStringOrNull()?.trim()?.lowercase() }?.toSet().orEmpty()
      GatewayModelSummary(
        id = id,
        name = obj["name"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id,
        provider = provider,
        available = obj.optionalBoolean("available"),
        supportsVision = "image" in inputTypes,
        supportsAudio = "audio" in inputTypes,
        supportsDocuments = "document" in inputTypes,
        supportsReasoning = obj["reasoning"].toString().trim() == "true",
        contextTokens = obj["contextWindow"].toString().toLongOrNull() ?: obj["contextTokens"].toString().toLongOrNull(),
      )
    }.orEmpty()

data class GatewayModelProviderSummary(
  val id: String,
  val displayName: String,
  val status: String,
  val profileCount: Int,
)

data class GatewayCronStatus(
  val enabled: Boolean,
  val jobs: Int,
  val nextWakeAtMs: Long?,
)

data class GatewayCronJobSummary(
  val id: String,
  val name: String,
  val enabled: Boolean,
  val scheduleLabel: String,
  val promptPreview: String,
  val nextRunAtMs: Long?,
  val lastRunStatus: String?,
)

data class GatewayUsageSummary(
  val updatedAtMs: Long?,
  val providers: List<GatewayUsageProviderSummary>,
)

data class GatewayUsageProviderSummary(
  val displayName: String,
  val plan: String?,
  val error: String?,
  val windows: List<GatewayUsageWindowSummary>,
)

data class GatewayUsageWindowSummary(
  val label: String,
  val usedPercent: Double,
  val resetAtMs: Long?,
)

data class GatewaySkillsSummary(
  val managedSkillsDirAvailable: Boolean = false,
  val skills: List<GatewaySkillSummary>,
)

data class GatewaySkillWorkshopSummary(
  val agentId: String = "",
  val proposals: List<GatewaySkillWorkshopProposal>,
) {
  fun withProposal(proposal: GatewaySkillWorkshopProposal): GatewaySkillWorkshopSummary =
    copy(
      proposals =
        (proposals.filterNot { it.id == proposal.id } + proposal)
          .sortedByDescending { it.updatedAt },
    )
}

data class GatewaySkillWorkshopProposal(
  val id: String,
  val kind: String,
  val status: String,
  val title: String,
  val description: String?,
  val skillName: String,
  val skillKey: String,
  val createdAt: String,
  val updatedAt: String,
  val scanState: String?,
  val content: String? = null,
  val supportFiles: List<GatewaySkillWorkshopSupportFile> = emptyList(),
)

data class GatewaySkillWorkshopSupportFile(
  val path: String,
  val content: String?,
)

data class GatewaySkillSummary(
  val skillKey: String,
  val name: String,
  val description: String?,
  val source: String,
  val emoji: String?,
  val disabled: Boolean,
  val eligible: Boolean,
  val blockedByAllowlist: Boolean,
  val bundled: Boolean,
  val missingCount: Int,
  val installCount: Int,
)

data class GatewayNodesDevicesSummary(
  val nodes: List<GatewayNodeSummary>,
  val pendingDevices: List<GatewayPendingDeviceSummary>,
  val pairedDevices: List<GatewayPairedDeviceSummary>,
  val devicePairingAvailable: Boolean = true,
)

enum class GatewayNodeApprovalState {
  Loading,
  Unsupported,
  Approved,
  PendingApproval,
  PendingReapproval,
  Unapproved,
}

/** Current phone approval state; only pending variants can carry an approval target. */
sealed interface GatewayNodeCapabilityApproval {
  data object Loading : GatewayNodeCapabilityApproval

  data object Unsupported : GatewayNodeCapabilityApproval

  data object Approved : GatewayNodeCapabilityApproval

  data class PendingApproval(
    val requestId: String?,
  ) : GatewayNodeCapabilityApproval

  data class PendingReapproval(
    val requestId: String?,
  ) : GatewayNodeCapabilityApproval

  data object Unapproved : GatewayNodeCapabilityApproval
}

internal fun GatewayNodeCapabilityApproval.withoutExactRequestId(): GatewayNodeCapabilityApproval? =
  when (this) {
    is GatewayNodeCapabilityApproval.PendingApproval ->
      requestId?.let { GatewayNodeCapabilityApproval.PendingApproval(requestId = null) }
    is GatewayNodeCapabilityApproval.PendingReapproval ->
      requestId?.let { GatewayNodeCapabilityApproval.PendingReapproval(requestId = null) }
    else -> null
  }

internal fun GatewayNodesDevicesSummary.withoutExactApprovalRequestIds(): GatewayNodesDevicesSummary = copy(nodes = nodes.map { node -> node.copy(pendingRequestId = null) })

/** Prevents older node.list responses from overwriting newer approval state. */
internal class GatewayNodeApprovalRefreshGuard {
  private val lock = Any()
  private var generation = 0L

  fun begin(): Long =
    synchronized(lock) {
      generation += 1
      generation
    }

  fun publishIfCurrent(
    refreshGeneration: Long,
    publish: () -> Unit,
  ): Boolean =
    synchronized(lock) {
      if (refreshGeneration != generation) return@synchronized false
      publish()
      true
    }
}

internal fun parseGatewayNodeApprovalState(raw: String?): GatewayNodeApprovalState =
  when (raw?.trim()?.lowercase()) {
    null, "" -> GatewayNodeApprovalState.Loading
    "approved" -> GatewayNodeApprovalState.Approved
    "pending-approval" -> GatewayNodeApprovalState.PendingApproval
    "pending-reapproval" -> GatewayNodeApprovalState.PendingReapproval
    "unapproved" -> GatewayNodeApprovalState.Unapproved
    else -> GatewayNodeApprovalState.Loading
  }

internal fun nodeConnectFailureNeedsApprovalRefresh(error: GatewaySession.ErrorShape): Boolean = error.details?.code == "PAIRING_REQUIRED"

internal fun currentNodeCapabilityApproval(
  nodes: List<GatewayNodeSummary>,
  selfNodeId: String,
): GatewayNodeCapabilityApproval {
  val node = nodes.firstOrNull { it.id == selfNodeId } ?: return GatewayNodeCapabilityApproval.Loading
  return when (node.approvalState) {
    GatewayNodeApprovalState.Loading -> GatewayNodeCapabilityApproval.Loading
    GatewayNodeApprovalState.Unsupported -> GatewayNodeCapabilityApproval.Unsupported
    GatewayNodeApprovalState.Approved -> GatewayNodeCapabilityApproval.Approved
    GatewayNodeApprovalState.PendingApproval ->
      GatewayNodeCapabilityApproval.PendingApproval(
        normalizeGatewayApprovalRequestId(node.pendingRequestId),
      )
    GatewayNodeApprovalState.PendingReapproval ->
      GatewayNodeCapabilityApproval.PendingReapproval(
        normalizeGatewayApprovalRequestId(node.pendingRequestId),
      )
    GatewayNodeApprovalState.Unapproved -> GatewayNodeCapabilityApproval.Unapproved
  }
}

internal fun parseGatewayNodeSummary(item: JsonElement): GatewayNodeSummary? {
  val obj = item.asObjectOrNull() ?: return null
  val id = obj["nodeId"].asStringOrNull()?.trim().orEmpty()
  if (id.isEmpty()) return null
  return GatewayNodeSummary(
    id = id,
    displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    version = obj["version"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    deviceFamily = obj["deviceFamily"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    paired = obj.boolean("paired"),
    connected = obj.boolean("connected"),
    // Only an omitted field identifies a legacy gateway; malformed and future values stay fail-closed.
    approvalState =
      if (obj.containsKey("approvalState")) {
        parseGatewayNodeApprovalState(obj["approvalState"].asStringOrNull())
      } else {
        GatewayNodeApprovalState.Unsupported
      },
    pendingRequestId = normalizeGatewayApprovalRequestId(obj["pendingRequestId"].asStringOrNull()),
    capabilities = parseGatewayStringArray(obj["caps"] as? JsonArray),
    commands = parseGatewayStringArray(obj["commands"] as? JsonArray),
  )
}

internal fun parseGatewayNodeList(root: JsonObject?): List<GatewayNodeSummary> {
  if (root == null) return emptyList()
  val seen = mutableSetOf<String>()
  val result = mutableListOf<GatewayNodeSummary>()

  fun append(nodes: JsonArray?) {
    for (node in nodes?.mapNotNull(::parseGatewayNodeSummary).orEmpty()) {
      if (seen.add(node.id)) {
        result.add(node)
      }
    }
  }

  append(root["nodes"] as? JsonArray)
  append(root["pending"] as? JsonArray)
  append(root["paired"] as? JsonArray)
  return result
}

data class GatewayNodeSummary(
  val id: String,
  val displayName: String?,
  val remoteIp: String?,
  val version: String?,
  val deviceFamily: String?,
  val paired: Boolean,
  val connected: Boolean,
  val approvalState: GatewayNodeApprovalState,
  val pendingRequestId: String?,
  val capabilities: List<String>,
  val commands: List<String>,
)

data class GatewayPendingDeviceSummary(
  val requestId: String,
  val deviceId: String,
  val displayName: String?,
  val remoteIp: String?,
  val roles: List<String>,
  val scopes: List<String>,
  val requestedAtMs: Long?,
  val repair: Boolean,
)

data class GatewayPairedDeviceSummary(
  val deviceId: String,
  val displayName: String?,
  val remoteIp: String?,
  val roles: List<String>,
  val scopes: List<String>,
  val tokens: List<GatewayDeviceTokenSummary>,
  val approvedAtMs: Long?,
)

data class GatewayDeviceTokenSummary(
  val role: String,
  val scopes: List<String>,
  val revoked: Boolean,
  val updatedAtMs: Long?,
)

data class GatewayChannelsSummary(
  val updatedAtMs: Long? = null,
  val partial: Boolean = false,
  val warnings: List<String> = emptyList(),
  val channels: List<GatewayChannelSummary>,
)

data class GatewayChannelSummary(
  val id: String,
  val label: String,
  val accountCount: Int,
  val enabled: Boolean,
  val configured: Boolean,
  val linked: Boolean,
  val running: Boolean,
  val connected: Boolean,
  val error: String?,
)

private data class GatewayChannelAccountSummary(
  val enabled: Boolean,
  val configured: Boolean,
  val linked: Boolean,
  val running: Boolean,
  val connected: Boolean,
  val error: String?,
)

data class GatewayDreamingSummary(
  val enabled: Boolean = false,
  val timezone: String? = null,
  val shortTermCount: Int = 0,
  val groundedSignalCount: Int = 0,
  val totalSignalCount: Int = 0,
  val promotedToday: Int = 0,
  val promotedTotal: Int = 0,
  val nextRunAtMs: Long? = null,
  val storeHealthy: Boolean = true,
  val phaseSignalHealthy: Boolean = true,
  val diaryFound: Boolean = false,
  val diaryEntries: List<GatewayDreamDiaryEntry> = emptyList(),
  val diaryEntryCount: Int = 0,
)

data class GatewayDreamDiaryEntry(
  val date: String,
  val text: String,
)

data class GatewayHealthLogsSummary(
  val fileName: String? = null,
  val cursor: Long? = null,
  val truncated: Boolean = false,
  val entries: List<GatewayLogEntry> = emptyList(),
)

data class GatewayLogEntry(
  val time: String?,
  val level: String?,
  val subsystem: String?,
  val message: String,
  val raw: String,
)

private val gatewayAnsiControlPattern = Regex("\\u001B\\[[0-?]*[ -/]*[@-~]")
private val gatewayEscapedAnsiControlPattern = Regex("""\\u001[Bb]\[[0-?]*[ -/]*[@-~]""")
private val gatewayVisibleSgrPattern = Regex("\\[(?:0|\\d{1,3}(?:;\\d{1,3})*)m(?!])")

internal fun sanitizeGatewayLogText(value: String): String =
  value
    .replace(gatewayAnsiControlPattern, "")
    .replace(gatewayEscapedAnsiControlPattern, "")
    .replace(gatewayVisibleSgrPattern, "")

private fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toLongOrNull()

private fun JsonObject?.double(key: String): Double? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toDoubleOrNull()

private fun JsonObject?.boolean(key: String): Boolean = (this?.get(key) as? JsonPrimitive)?.content?.trim() == "true"

private fun JsonObject?.optionalBoolean(key: String): Boolean? =
  (this?.get(key) as? JsonPrimitive)?.content?.trim()?.lowercase()?.let { value ->
    when (value) {
      "true" -> true
      "false" -> false
      else -> null
    }
  }

internal fun cronJobLastRunStatus(state: JsonObject?): String? =
  state
    .cronStatus("lastStatus")
    ?: state.cronStatus("lastRunStatus")

private fun JsonObject?.cronStatus(key: String): String? =
  this
    ?.get(key)
    .asStringOrNull()
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

private fun parseGatewayStringArray(items: JsonArray?): List<String> =
  items
    ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf { value -> value.isNotEmpty() } }
    .orEmpty()

fun providerDisplayName(provider: String): String =
  when (provider.trim().lowercase()) {
    "openai" -> "OpenAI"
    "openrouter" -> "OpenRouter"
    "codex" -> "Codex"
    "ollama", "ollama-local" -> "Ollama Local"
    else ->
      provider
        .replace('-', ' ')
        .replace('_', ' ')
        .split(' ')
        .filter { it.isNotBlank() }
        .joinToString(" ") { token -> token.replaceFirstChar { it.uppercase() } }
        .replace(" Ai", " AI")
        .ifBlank { "Provider" }
  }

fun channelDisplayLabel(channel: String): String =
  when (channel.trim().lowercase()) {
    "imessage" -> "iMessage"
    "googlechat" -> "Google Chat"
    "whatsapp" -> "WhatsApp"
    else ->
      channel
        .replace('-', ' ')
        .replace('_', ' ')
        .split(' ')
        .filter { it.isNotBlank() }
        .joinToString(" ") { token -> token.replaceFirstChar { it.uppercase() } }
        .ifBlank { "Channel" }
  }

@Serializable
private data class HomeCanvasPayload(
  val gatewayState: String,
  val eyebrow: String,
  val title: String,
  val subtitle: String,
  val gatewayLabel: String,
  val activeAgentName: String,
  val activeAgentBadge: String,
  val activeAgentCaption: String,
  val agentCount: Int,
  val agents: List<HomeCanvasAgentCard>,
  val footer: String,
)

@Serializable
private data class HomeCanvasAgentCard(
  val id: String,
  val name: String,
  val badge: String,
  val caption: String,
  val isActive: Boolean,
)
