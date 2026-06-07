package ai.openclaw.app

import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayDiscovery
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.gateway.GatewayUpdateAvailableSummary
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprint
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
import ai.openclaw.app.voice.MicCaptureManager
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceConversationRole
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

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

class NodeRuntime(
  context: Context,
  val prefs: SecurePrefs = SecurePrefs(context.applicationContext),
  private val tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult = ::probeGatewayTlsFingerprint,
) {
  /**
   * Authentication material supplied by setup/manual connect flows before gateway session routing.
   */
  data class GatewayConnectAuth(
    val token: String?,
    val bootstrapToken: String?,
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
      triggerCameraFlash = ::triggerCameraFlash,
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
      manualTls = { manualTls.value },
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
  private val _nodeConnected = MutableStateFlow(false)
  val nodeConnected: StateFlow<Boolean> = _nodeConnected.asStateFlow()

  private val _statusText = MutableStateFlow("Offline")
  val statusText: StateFlow<String> = _statusText.asStateFlow()
  private val _gatewayConnectionProblem = MutableStateFlow<GatewayConnectionProblem?>(null)
  val gatewayConnectionProblem: StateFlow<GatewayConnectionProblem?> = _gatewayConnectionProblem.asStateFlow()

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

  private val _cameraFlashToken = MutableStateFlow(0L)
  val cameraFlashToken: StateFlow<Long> = _cameraFlashToken.asStateFlow()

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
  private val _gatewayDefaultAgentId = MutableStateFlow<String?>(null)
  val gatewayDefaultAgentId: StateFlow<String?> = _gatewayDefaultAgentId.asStateFlow()
  private val _gatewayAgents = MutableStateFlow<List<GatewayAgentSummary>>(emptyList())
  val gatewayAgents: StateFlow<List<GatewayAgentSummary>> = _gatewayAgents.asStateFlow()
  private val _cronStatus = MutableStateFlow(GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null))
  val cronStatus: StateFlow<GatewayCronStatus> = _cronStatus.asStateFlow()
  private val _cronJobs = MutableStateFlow<List<GatewayCronJobSummary>>(emptyList())
  val cronJobs: StateFlow<List<GatewayCronJobSummary>> = _cronJobs.asStateFlow()
  private val _cronRefreshing = MutableStateFlow(false)
  val cronRefreshing: StateFlow<Boolean> = _cronRefreshing.asStateFlow()
  private val _cronErrorText = MutableStateFlow<String?>(null)
  val cronErrorText: StateFlow<String?> = _cronErrorText.asStateFlow()
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

  private var didAutoRequestCanvasRehydrate = false
  private val canvasRehydrateSeq = AtomicLong(0)

  @Volatile private var nodePresenceAliveLastSuccessAtMs: Long? = null
  private var operatorConnected = false
  private var operatorStatusText: String = "Offline"
  private var nodeStatusText: String = "Offline"

  private val operatorSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { hello ->
        _gatewayConnectionProblem.value = null
        operatorConnected = true
        operatorStatusText = "Connected"
        _serverName.value = hello.serverName
        _remoteAddress.value = hello.remoteAddress
        _gatewayVersion.value = hello.serverVersion
        _gatewayUpdateAvailable.value = hello.updateAvailable
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        syncMainSessionKey(resolveAgentIdFromMainSessionKey(hello.mainSessionKey))
        updateStatus()
        micCapture.onGatewayConnectionChanged(true)
        scope.launch {
          refreshHomeCanvasOverviewIfConnected()
          if (voiceReplySpeakerLazy.isInitialized()) {
            voiceReplySpeaker.refreshConfig()
          }
        }
      },
      onDisconnected = { message ->
        operatorConnected = false
        operatorStatusText = message
        _serverName.value = null
        _remoteAddress.value = null
        _gatewayVersion.value = null
        _gatewayUpdateAvailable.value = null
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        _gatewayDefaultAgentId.value = null
        _gatewayAgents.value = emptyList()
        _modelCatalog.value = emptyList()
        _modelAuthProviders.value = emptyList()
        _cronStatus.value = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)
        _cronJobs.value = emptyList()
        _usageSummary.value = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())
        _skillsSummary.value = GatewaySkillsSummary(skills = emptyList())
        _nodesDevicesSummary.value =
          GatewayNodesDevicesSummary(
            nodes = emptyList(),
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          )
        _channelsSummary.value = GatewayChannelsSummary(channels = emptyList())
        _dreamingSummary.value = GatewayDreamingSummary()
        _healthLogsSummary.value = GatewayHealthLogsSummary()
        chat.applyMainSessionKey(resolveMainSessionKey())
        chat.onDisconnected(message)
        updateStatus()
        micCapture.onGatewayConnectionChanged(false)
      },
      onConnectFailure = ::handleGatewayConnectFailure,
      onEvent = { event, payloadJson ->
        handleGatewayEvent(event, payloadJson)
      },
    )

  private val nodeSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = {
        _gatewayConnectionProblem.value = null
        _nodeConnected.value = true
        nodeStatusText = "Connected"
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus()
        showLocalCanvasOnConnect()
        publishNodePresenceAliveBeacon(NodePresenceAliveBeacon.Trigger.Connect)
        val endpoint = connectedEndpoint
        val auth = activeGatewayAuth
        if (endpoint != null && auth != null) {
          maybeStartOperatorSessionAfterNodeConnect(endpoint, auth)
        }
      },
      onDisconnected = { message ->
        _nodeConnected.value = false
        nodeStatusText = message
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus()
        showLocalCanvasOnDisconnect()
      },
      onConnectFailure = ::handleGatewayConnectFailure,
      onEvent = { _, _ -> },
      onInvoke = { req ->
        invokeDispatcher.handleInvoke(req.command, req.paramsJson)
      },
      onTlsFingerprint = { stableId, fingerprint ->
        prefs.saveGatewayTlsFingerprint(stableId, fingerprint)
      },
    )

  init {
    DeviceNotificationListenerService.setNodeEventSink { event, payloadJson ->
      scope.launch {
        nodeSession.sendNodeEvent(event = event, payloadJson = payloadJson)
      }
    }
  }

  private val chat: ChatController =
    ChatController(
      scope = scope,
      session = operatorSession,
      json = json,
    ).also {
      it.applyMainSessionKey(_mainSessionKey.value)
    }
  private val voiceReplySpeakerLazy: Lazy<TalkModeManager> =
    lazy {
      // Reuse the existing TalkMode speech engine for native Android TTS playback
      // without enabling the legacy talk capture loop.
      TalkModeManager(
        context = appContext,
        scope = scope,
        session = operatorSession,
        isConnected = { _isConnected.value },
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
        val params =
          buildJsonObject {
            put("mode", JsonPrimitive("transcription"))
            put("transport", JsonPrimitive("gateway-relay"))
            put("brain", JsonPrimitive("none"))
          }
        val response =
          operatorSession.request(
            "talk.session.create",
            params.toString(),
            timeoutMs = 15_000,
          )
        parseTalkSessionId(response)
      },
      appendTranscriptionAudio = { sessionId, audio, onError ->
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("audioBase64", JsonPrimitive(Base64.encodeToString(audio, Base64.NO_WRAP)))
            put("timestamp", JsonPrimitive(SystemClock.elapsedRealtime()))
          }
        operatorSession.sendRequestFrame(
          "talk.session.appendAudio",
          params.toString(),
          timeoutMs = 8_000,
        ) { error -> onError(error.message) }
      },
      closeTranscriptionSession = { sessionId ->
        val params = buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) }
        operatorSession.request(
          "talk.session.close",
          params.toString(),
          timeoutMs = 5_000,
        )
      },
      sendToGateway = { message, onRunIdKnown ->
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
        val response = operatorSession.request("chat.send", params.toString())
        parseChatSendRunId(response) ?: idempotencyKey
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
      isConnected = { _isConnected.value },
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

  private fun updateStatus() {
    _isConnected.value = operatorConnected
    val operator = operatorStatusText.trim()
    val node = nodeStatusText.trim()
    _statusText.value =
      when {
        operatorConnected && _nodeConnected.value -> "Connected"
        operatorConnected && !_nodeConnected.value -> "Connected (node offline)"
        !operatorConnected && _nodeConnected.value ->
          if (operator.isNotEmpty() && operator != "Offline") {
            "Connected (operator: $operator)"
          } else {
            "Connected (operator offline)"
          }
        operator.isNotBlank() && operator != "Offline" -> operator
        else -> node
      }
    updateHomeCanvasState()
  }

  private fun handleGatewayConnectFailure(
    error: GatewaySession.ErrorShape,
    pauseReconnect: Boolean,
  ) {
    val details = error.details
    _gatewayConnectionProblem.value =
      GatewayConnectionProblem(
        code = details?.code ?: error.code,
        message = error.message,
        reason = details?.reason,
        requestId = details?.requestId,
        recommendedNextStep = details?.recommendedNextStep,
        pauseReconnect = pauseReconnect || details?.pauseReconnect == true,
        retryable = details?.retryable == true,
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
    if (!operatorConnected) {
      updateHomeCanvasState()
      return
    }
    scope.launch {
      refreshBrandingFromGateway()
      refreshAgentsFromGateway()
      refreshModelCatalogFromGateway()
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
    scope.launch {
      refreshModelCatalogFromGateway()
    }
  }

  fun refreshAgents() {
    scope.launch {
      refreshAgentsFromGateway()
    }
  }

  fun refreshCronJobs() {
    scope.launch {
      refreshCronFromGateway()
    }
  }

  fun refreshUsage() {
    scope.launch {
      refreshUsageFromGateway()
    }
  }

  fun refreshSkills() {
    scope.launch {
      refreshSkillsFromGateway()
    }
  }

  fun refreshNodesDevices() {
    scope.launch {
      refreshNodesDevicesFromGateway()
    }
  }

  fun refreshChannels() {
    scope.launch {
      refreshChannelsFromGateway()
    }
  }

  fun refreshDreaming() {
    scope.launch {
      refreshDreamingFromGateway()
    }
  }

  fun refreshHealthLogs() {
    scope.launch {
      refreshHealthLogsFromGateway()
    }
  }

  fun requestCanvasRehydrate(
    source: String = "manual",
    force: Boolean = true,
  ) {
    scope.launch {
      if (!_nodeConnected.value) {
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
        nodeSession.sendNodeEvent(
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
  val gatewayToken: StateFlow<String> = prefs.gatewayToken
  val onboardingCompleted: StateFlow<Boolean> = prefs.onboardingCompleted

  fun setGatewayToken(value: String) = prefs.setGatewayToken(value)

  fun setGatewayBootstrapToken(value: String) = prefs.setGatewayBootstrapToken(value)

  fun setGatewayPassword(value: String) = prefs.setGatewayPassword(value)

  /** Clears setup credentials plus paired device tokens for both Android gateway roles. */
  fun resetGatewaySetupAuth() {
    prefs.clearGatewaySetupAuth()
    val deviceId = identityStore.loadOrCreate().deviceId
    deviceAuthStore.clearToken(deviceId, "node")
    deviceAuthStore.clearToken(deviceId, "operator")
  }

  /** Persists onboarding state; callers decide whether runtime startup is needed first. */
  fun setOnboardingCompleted(value: Boolean) = prefs.setOnboardingCompleted(value)

  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId
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
  val chatStreamingAssistantText: StateFlow<String?> = chat.streamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = chat.pendingToolCalls
  val chatSessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val pendingRunCount: StateFlow<Int> = chat.pendingRunCount

  init {
    if (prefs.voiceWakeMode.value != VoiceWakeMode.Off) {
      prefs.setVoiceWakeMode(VoiceWakeMode.Off)
    }

    scope.launch {
      prefs.loadGatewayToken()
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
    if (value) {
      reconnectPreferredGatewayOnForeground()
    } else {
      stopManualVoiceSession()
      publishNodePresenceAliveBeacon(NodePresenceAliveBeacon.Trigger.Background, throttleRecentSuccess = true)
    }
  }

  private fun publishNodePresenceAliveBeacon(
    trigger: NodePresenceAliveBeacon.Trigger,
    throttleRecentSuccess: Boolean = false,
  ) {
    scope.launch {
      sendNodePresenceAliveBeacon(trigger = trigger, throttleRecentSuccess = throttleRecentSuccess)
    }
  }

  private suspend fun sendNodePresenceAliveBeacon(
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
      nodeSession.sendNodeEventDetailed(
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
    if (manualEnabled.value) {
      val host = manualHost.value.trim()
      val port = manualPort.value
      if (host.isEmpty() || port !in 1..65535) return null
      return GatewayEndpoint.manual(host = host, port = port)
    }

    val targetStableId = lastDiscoveredStableId.value.trim()
    if (targetStableId.isEmpty()) return null
    val endpoint = gateways.value.firstOrNull { it.stableId == targetStableId } ?: return null
    val storedFingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim().orEmpty()
    if (storedFingerprint.isEmpty()) return null
    return endpoint
  }

  private fun autoConnectIfNeeded() {
    if (didAutoConnect) return
    if (_isConnected.value) return
    val endpoint = resolvePreferredGatewayEndpoint() ?: return
    // Only attempt the stored preferred gateway once per runtime lifetime; users
    // can still reconnect explicitly from the UI after a failed auto attempt.
    didAutoConnect = true
    connect(endpoint)
  }

  private fun reconnectPreferredGatewayOnForeground() {
    if (_isConnected.value) return
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
    prefs.setNotificationForwardingEnabled(value)
  }

  fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    prefs.setNotificationForwardingMode(mode)
  }

  fun setNotificationForwardingPackages(packages: List<String>) {
    prefs.setNotificationForwardingPackages(packages)
  }

  fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean = prefs.setNotificationForwardingQuietHours(enabled = enabled, start = start, end = end)

  fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    prefs.setNotificationForwardingMaxEventsPerMinute(value)
  }

  fun setNotificationForwardingSessionKey(value: String?) {
    prefs.setNotificationForwardingSessionKey(value)
  }

  fun setVoiceScreenActive(active: Boolean) {
    if (!active) {
      stopManualVoiceSession()
    }
    // Don't re-enable on active=true; mic toggle drives that
  }

  fun setMicEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.ManualMic else VoiceCaptureMode.Off)
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
    runPreparedTalkPttCommand {
      val payload = talkMode.beginPushToTalk()
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttStop(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      val payload = talkMode.endPushToTalk()
      finishTalkCaptureIfIdle()
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttCancel(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      val payload = talkMode.cancelPushToTalk()
      finishTalkCaptureIfIdle()
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttOnce(): GatewaySession.InvokeResult =
    runPreparedTalkPttCommand {
      val payload = talkMode.runPushToTalkOnce()
      finishTalkCaptureIfIdle()
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun runPreparedTalkPttCommand(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult =
    runTalkPttCommand {
      prepareTalkCapture()
      try {
        block()
      } catch (err: Throwable) {
        cleanupFailedTalkCapture()
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

  private suspend fun prepareTalkCapture() {
    if (!hasRecordAudioPermission()) {
      throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    }
    micCapture.setMicEnabled(false)
    stopVoicePlayback()
    NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.TalkMode)
    talkMode.ttsOnAllResponses = true
    talkMode.setPlaybackEnabled(speakerEnabled.value)
    talkMode.refreshConfig()
    externalAudioCaptureActive.value = true
  }

  private suspend fun cleanupFailedTalkCapture() {
    runCatching { talkMode.cancelPushToTalk() }
    talkMode.ttsOnAllResponses = false
    NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
    externalAudioCaptureActive.value = false
  }

  private fun finishTalkCaptureIfIdle() {
    if (!talkMode.isEnabled.value && !talkMode.isListening.value && !talkMode.isSpeaking.value) {
      talkMode.ttsOnAllResponses = false
      NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
      externalAudioCaptureActive.value = false
    }
  }

  private fun finishTalkModeAfterRelayClose() {
    if (_voiceCaptureMode.value != VoiceCaptureMode.TalkMode) return
    _voiceCaptureMode.value = VoiceCaptureMode.Off
    talkMode.ttsOnAllResponses = false
    NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
    externalAudioCaptureActive.value = false
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
    if (!_isConnected.value) {
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
    if (mode == VoiceCaptureMode.TalkMode && !hasRecordAudioPermission()) {
      _voiceCaptureMode.value = VoiceCaptureMode.Off
      externalAudioCaptureActive.value = false
      return
    }
    if (_voiceCaptureMode.value == mode) return
    _voiceCaptureMode.value = mode
    when (mode) {
      VoiceCaptureMode.Off -> {
        talkMode.ttsOnAllResponses = false
        talkMode.setEnabled(false)
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
        talkMode.setEnabled(false)
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
        talkMode.setEnabled(true)
        externalAudioCaptureActive.value = true
      }
    }
  }

  private fun stopManualVoiceSession() {
    if (_voiceCaptureMode.value != VoiceCaptureMode.ManualMic) return
    setVoiceCaptureMode(VoiceCaptureMode.Off)
  }

  private fun stopActiveVoiceSession() {
    talkMode.ttsOnAllResponses = false
    talkMode.setEnabled(false)
    stopVoicePlayback()
    micCapture.setMicEnabled(false)
    prefs.setVoiceMicEnabled(false)
    NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
    _voiceCaptureMode.value = VoiceCaptureMode.Off
    externalAudioCaptureActive.value = false
  }

  private fun stopVoicePlayback() {
    talkMode.stopTts()
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.stopTts()
    }
  }

  fun refreshGatewayConnection() {
    val endpoint = connectedEndpoint
    if (endpoint == null) {
      resolvePreferredGatewayEndpoint()?.let(::connect)
        ?: run {
          _statusText.value = "Failed: no saved gateway endpoint"
        }
      return
    }
    operatorStatusText = "Connecting…"
    updateStatus()
    connectWithAuth(endpoint = endpoint, auth = resolveGatewayConnectAuth(), reconnect = true)
  }

  private fun refreshNodeSurfaceAfterSharingChange() {
    val endpoint = connectedEndpoint ?: return
    connectWithAuth(endpoint = endpoint, auth = resolveGatewayConnectAuth(), reconnect = true)
  }

  private fun connectWithAuth(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    reconnect: Boolean = false,
  ) {
    activeGatewayAuth = auth
    val tls = connectionManager.resolveTlsParams(endpoint)
    val operatorAuth =
      resolveOperatorSessionConnectAuth(
        auth = auth,
        storedOperatorToken = loadStoredRoleDeviceToken("operator"),
      )
    if (operatorAuth == null) {
      operatorConnected = false
      operatorStatusText = "Offline"
      operatorSession.disconnect()
      updateStatus()
    } else {
      operatorSession.connect(
        endpoint,
        operatorAuth.token,
        operatorAuth.bootstrapToken,
        operatorAuth.password,
        connectionManager.buildOperatorConnectOptions(),
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

  private fun beginConnect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    val connectAttemptId = connectAttemptSeq.incrementAndGet()
    _pendingGatewayTrust.value = null
    val tls = connectionManager.resolveTlsParams(endpoint)
    if (tls?.required == true) {
      val expectedFingerprint =
        tls.expectedFingerprint
          ?.let(::normalizeGatewayTlsFingerprint)
          ?.takeIf { it.isNotBlank() }
      _statusText.value = "Verify gateway TLS fingerprint…"
      scope.launch {
        val tlsProbe = tlsFingerprintProbe(endpoint.host, endpoint.port)
        if (!isCurrentConnectAttempt(connectAttemptId)) return@launch
        val fp =
          tlsProbe.fingerprintSha256 ?: run {
            if (expectedFingerprint == null) {
              _statusText.value = gatewayTlsProbeFailureMessage(tlsProbe.failure)
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
          _pendingGatewayTrust.value =
            GatewayTrustPrompt(
              endpoint = endpoint,
              fingerprintSha256 = observedFingerprint,
              auth = auth,
              previousFingerprintSha256 = previousFingerprint,
            )
          return@launch
        }
        connectAfterTlsCheck(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
      }
      return
    }

    connectAfterTlsCheck(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
  }

  private fun isCurrentConnectAttempt(connectAttemptId: Long): Boolean = connectAttemptSeq.get() == connectAttemptId

  private fun connectAfterTlsCheck(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    connectAttemptId: Long,
  ) {
    if (!isCurrentConnectAttempt(connectAttemptId)) return
    _gatewayConnectionProblem.value = null
    connectedEndpoint = endpoint
    operatorStatusText = "Connecting…"
    nodeStatusText = "Connecting…"
    updateStatus()
    connectWithAuth(endpoint = endpoint, auth = auth)
  }

  fun connect(endpoint: GatewayEndpoint) {
    beginConnect(endpoint = endpoint, auth = resolveGatewayConnectAuth())
  }

  fun connect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    beginConnect(endpoint = endpoint, auth = resolveGatewayConnectAuth(auth))
  }

  internal fun resolveGatewayConnectAuth(explicitAuth: GatewayConnectAuth? = null): GatewayConnectAuth =
    explicitAuth
      ?: GatewayConnectAuth(
        token = prefs.loadGatewayToken(),
        bootstrapToken = prefs.loadGatewayBootstrapToken(),
        password = prefs.loadGatewayPassword(),
      )

  fun acceptGatewayTrustPrompt() {
    val prompt = _pendingGatewayTrust.value ?: return
    _pendingGatewayTrust.value = null
    prefs.saveGatewayTlsFingerprint(prompt.endpoint.stableId, prompt.fingerprintSha256)
    beginConnect(endpoint = prompt.endpoint, auth = prompt.auth)
  }

  fun declineGatewayTrustPrompt() {
    _pendingGatewayTrust.value = null
    _statusText.value = "Offline"
  }

  private fun gatewayTlsProbeFailureMessage(failure: GatewayTlsProbeFailure?): String =
    when (failure) {
      GatewayTlsProbeFailure.TLS_UNAVAILABLE ->
        "Failed: this host requires wss:// or Tailscale Serve. No TLS endpoint detected."
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
      _statusText.value = "Failed: invalid manual host/port"
      return
    }
    connect(GatewayEndpoint.manual(host = host, port = port))
  }

  private fun loadStoredRoleDeviceToken(role: String): String? {
    val deviceId = identityStore.loadOrCreate().deviceId
    return deviceAuthStore.loadToken(deviceId, role)
  }

  private fun maybeStartOperatorSessionAfterNodeConnect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    if (operatorConnected) {
      return
    }
    val operatorAuth =
      resolveOperatorSessionConnectAuth(
        auth = auth,
        storedOperatorToken = loadStoredRoleDeviceToken("operator"),
      ) ?: return
    operatorStatusText = "Connecting…"
    updateStatus()
    operatorSession.connect(
      endpoint,
      operatorAuth.token,
      operatorAuth.bootstrapToken,
      operatorAuth.password,
      connectionManager.buildOperatorConnectOptions(),
      connectionManager.resolveTlsParams(endpoint),
    )
  }

  fun disconnect() {
    connectAttemptSeq.incrementAndGet()
    stopActiveVoiceSession()
    connectedEndpoint = null
    activeGatewayAuth = null
    _gatewayConnectionProblem.value = null
    _pendingGatewayTrust.value = null
    operatorSession.disconnect()
    nodeSession.disconnect()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
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
      if (connected) {
        val sent =
          nodeSession.sendNodeEvent(
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

  fun refreshChatSessions(limit: Int? = null) {
    chat.refreshSessions(limit = limit)
  }

  fun setChatThinkingLevel(level: String) {
    chat.setThinkingLevel(level)
  }

  fun switchChatSession(sessionKey: String) {
    chat.switchSession(sessionKey)
  }

  fun abortChat() {
    chat.abort()
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

  private fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event == "update.available") {
      _gatewayUpdateAvailable.value = parseGatewayUpdateAvailable(payloadJson)
    }
    micCapture.handleGatewayEvent(event, payloadJson)
    talkMode.handleGatewayEvent(event, payloadJson)
    chat.handleGatewayEvent(event, payloadJson)
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

  private fun parseChatSendRunId(response: String): String? {
    return try {
      val root = json.parseToJsonElement(response).asObjectOrNull() ?: return null
      root["runId"].asStringOrNull()
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

  private suspend fun refreshBrandingFromGateway() {
    if (!_isConnected.value) return
    try {
      val res = operatorSession.request("config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val ui = config?.get("ui").asObjectOrNull()
      val raw = ui?.get("seamColor").asStringOrNull()?.trim()
      syncMainSessionKey(gatewayDefaultAgentId.value)

      val parsed = parseHexColorArgb(raw)
      _seamColorArgb.value = parsed ?: DEFAULT_SEAM_COLOR_ARGB
      updateHomeCanvasState()
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun refreshAgentsFromGateway() {
    if (!operatorConnected) return
    try {
      val res = operatorSession.request("agents.list", "{}")
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
          )
        } ?: emptyList()

      _gatewayDefaultAgentId.value = defaultAgentId.ifEmpty { null }
      _gatewayAgents.value = agents
      syncMainSessionKey(resolveAgentIdFromMainSessionKey(mainKey) ?: gatewayDefaultAgentId.value)
      updateHomeCanvasState()
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun refreshModelCatalogFromGateway() {
    _modelCatalogRefreshing.value = true
    _modelCatalogErrorText.value = null
    if (!operatorConnected) {
      _modelCatalog.value = emptyList()
      _modelAuthProviders.value = emptyList()
      _modelCatalogRefreshing.value = false
      return
    }
    try {
      val modelsRes = operatorSession.request("models.list", "{}")
      val modelsRoot = json.parseToJsonElement(modelsRes).asObjectOrNull()
      _modelCatalog.value = parseGatewayModels(modelsRoot?.get("models") as? JsonArray)

      val authRes = operatorSession.request("models.authStatus", "{}")
      val authRoot = json.parseToJsonElement(authRes).asObjectOrNull()
      _modelAuthProviders.value = parseGatewayModelProviders(authRoot?.get("providers") as? JsonArray)
    } catch (_: Throwable) {
      _modelCatalogErrorText.value = "Could not load provider catalog."
    } finally {
      _modelCatalogRefreshing.value = false
    }
  }

  private suspend fun refreshCronFromGateway() {
    _cronRefreshing.value = true
    _cronErrorText.value = null
    if (!operatorConnected) {
      _cronStatus.value = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)
      _cronJobs.value = emptyList()
      _cronRefreshing.value = false
      return
    }
    try {
      val statusRes = operatorSession.request("cron.status", "{}")
      val statusRoot = json.parseToJsonElement(statusRes).asObjectOrNull()
      _cronStatus.value =
        GatewayCronStatus(
          enabled = statusRoot.boolean("enabled"),
          jobs = statusRoot.long("jobs")?.toInt() ?: 0,
          nextWakeAtMs = statusRoot.long("nextWakeAtMs"),
        )

      val listRes = operatorSession.request("cron.list", """{"includeDisabled":true,"limit":20,"sortBy":"nextRunAtMs","sortDir":"asc"}""")
      val listRoot = json.parseToJsonElement(listRes).asObjectOrNull()
      _cronJobs.value = parseCronJobs(listRoot?.get("jobs") as? JsonArray)
    } catch (_: Throwable) {
      _cronErrorText.value = "Could not load cron jobs."
    } finally {
      _cronRefreshing.value = false
    }
  }

  private suspend fun refreshUsageFromGateway() {
    _usageRefreshing.value = true
    _usageErrorText.value = null
    if (!operatorConnected) {
      _usageSummary.value = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())
      _usageRefreshing.value = false
      return
    }
    try {
      val res = operatorSession.request("usage.status", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      _usageSummary.value =
        GatewayUsageSummary(
          updatedAtMs = root.long("updatedAt"),
          providers = parseUsageProviders(root?.get("providers") as? JsonArray),
        )
    } catch (_: Throwable) {
      _usageErrorText.value = "Could not load usage."
    } finally {
      _usageRefreshing.value = false
    }
  }

  private suspend fun refreshSkillsFromGateway() {
    _skillsRefreshing.value = true
    _skillsErrorText.value = null
    if (!operatorConnected) {
      _skillsSummary.value = GatewaySkillsSummary(skills = emptyList())
      _skillsRefreshing.value = false
      return
    }
    try {
      val res = operatorSession.request("skills.status", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      _skillsSummary.value =
        GatewaySkillsSummary(
          managedSkillsDirAvailable =
            root
              ?.get("managedSkillsDir")
              .asStringOrNull()
              ?.trim()
              ?.isNotEmpty() == true,
          skills = parseSkillSummaries(root?.get("skills") as? JsonArray),
        )
    } catch (_: Throwable) {
      _skillsErrorText.value = "Could not load skills."
    } finally {
      _skillsRefreshing.value = false
    }
  }

  private suspend fun refreshNodesDevicesFromGateway() {
    _nodesDevicesRefreshing.value = true
    _nodesDevicesErrorText.value = null
    if (!operatorConnected) {
      _nodesDevicesSummary.value =
        GatewayNodesDevicesSummary(
          nodes = emptyList(),
          pendingDevices = emptyList(),
          pairedDevices = emptyList(),
        )
      _nodesDevicesRefreshing.value = false
      return
    }
    try {
      val nodesRes = operatorSession.request("node.list", "{}")
      val nodesRoot = json.parseToJsonElement(nodesRes).asObjectOrNull()
      val devicesRoot =
        try {
          val devicesRes = operatorSession.request("device.pair.list", "{}")
          json.parseToJsonElement(devicesRes).asObjectOrNull()
        } catch (_: Throwable) {
          null
        }
      _nodesDevicesSummary.value =
        GatewayNodesDevicesSummary(
          nodes = parseGatewayNodes(nodesRoot?.get("nodes") as? JsonArray),
          pendingDevices = parsePendingDevices(devicesRoot?.get("pending") as? JsonArray),
          pairedDevices = parsePairedDevices(devicesRoot?.get("paired") as? JsonArray),
          devicePairingAvailable = devicesRoot != null,
        )
    } catch (_: Throwable) {
      _nodesDevicesErrorText.value = "Could not load nodes and devices."
    } finally {
      _nodesDevicesRefreshing.value = false
    }
  }

  private suspend fun refreshChannelsFromGateway() {
    _channelsRefreshing.value = true
    _channelsErrorText.value = null
    if (!operatorConnected) {
      _channelsSummary.value = GatewayChannelsSummary(channels = emptyList())
      _channelsRefreshing.value = false
      return
    }
    try {
      val res = operatorSession.request("channels.status", """{"probe":false,"timeoutMs":8000}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      _channelsSummary.value =
        GatewayChannelsSummary(
          updatedAtMs = root.long("ts"),
          partial = root.boolean("partial"),
          warnings = parseStringArray(root?.get("warnings") as? JsonArray),
          channels = parseChannelSummaries(root),
        )
    } catch (_: Throwable) {
      _channelsErrorText.value = "Could not load channels."
    } finally {
      _channelsRefreshing.value = false
    }
  }

  private suspend fun refreshDreamingFromGateway() {
    _dreamingRefreshing.value = true
    _dreamingErrorText.value = null
    if (!operatorConnected) {
      _dreamingSummary.value = GatewayDreamingSummary()
      _dreamingRefreshing.value = false
      return
    }
    try {
      val statusRes = operatorSession.request("doctor.memory.status", "{}")
      val statusRoot = json.parseToJsonElement(statusRes).asObjectOrNull()
      val diaryRes = operatorSession.request("doctor.memory.dreamDiary", "{}")
      val diaryRoot = json.parseToJsonElement(diaryRes).asObjectOrNull()
      val dreaming = statusRoot?.get("dreaming").asObjectOrNull()
      _dreamingSummary.value =
        parseDreamingSummary(
          dreaming = dreaming,
          diary = diaryRoot,
        )
    } catch (_: Throwable) {
      _dreamingErrorText.value = "Could not load dreaming."
    } finally {
      _dreamingRefreshing.value = false
    }
  }

  private suspend fun refreshHealthLogsFromGateway() {
    _healthLogsRefreshing.value = true
    _healthLogsErrorText.value = null
    if (!operatorConnected) {
      _healthLogsSummary.value = GatewayHealthLogsSummary()
      _healthLogsRefreshing.value = false
      return
    }
    try {
      val res = operatorSession.request("logs.tail", """{"limit":40,"maxBytes":65536}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val lines = (root?.get("lines") as? JsonArray)?.mapNotNull { it.asStringOrNull() }.orEmpty()
      _healthLogsSummary.value =
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
    } catch (_: Throwable) {
      _healthLogsErrorText.value = "Could not load gateway logs."
    } finally {
      _healthLogsRefreshing.value = false
    }
  }

  private fun parseGatewayModels(models: JsonArray?): List<GatewayModelSummary> =
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

  private fun parseGatewayLogEntry(line: String): GatewayLogEntry {
    val root =
      try {
        json.parseToJsonElement(line).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return GatewayLogEntry(time = null, level = null, subsystem = null, message = line.trim().ifEmpty { "Empty log entry" })
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
      message
        .trim()
        .replace(Regex("\\s+"), " ")
        .take(240)
        .ifEmpty { "Log entry" }
    return GatewayLogEntry(
      time = time,
      level = level,
      subsystem = subsystem?.trim()?.takeIf { it.isNotEmpty() },
      message = normalizedMessage,
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

  private fun skillMissingCount(missing: JsonObject?): Int = listOf("bins", "env", "config", "os").sumOf { key -> (missing?.get(key) as? JsonArray)?.size ?: 0 }

  private fun parseGatewayNodes(nodes: JsonArray?): List<GatewayNodeSummary> =
    nodes
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj["nodeId"].asStringOrNull()?.trim().orEmpty()
        if (id.isEmpty()) return@mapNotNull null
        GatewayNodeSummary(
          id = id,
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          version = obj["version"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          deviceFamily = obj["deviceFamily"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          paired = obj.boolean("paired"),
          connected = obj.boolean("connected"),
          capabilities = parseStringArray(obj["caps"] as? JsonArray),
          commands = parseStringArray(obj["commands"] as? JsonArray),
        )
      }.orEmpty()

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
      "every" -> schedule.long("everyMs")?.let(::formatEverySchedule) ?: "Repeating"
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

  private fun formatEverySchedule(everyMs: Long): String {
    val minutes = everyMs / 60_000L
    val hours = minutes / 60L
    val days = hours / 24L
    return when {
      days >= 1 && hours % 24L == 0L -> "Every ${days}d"
      hours >= 1 && minutes % 60L == 0L -> "Every ${hours}h"
      minutes >= 1 -> "Every ${minutes}m"
      else -> "Repeating"
    }
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
    val lower = _statusText.value.trim().lowercase()
    return when {
      _isConnected.value -> HomeCanvasGatewayState.Connected
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

  private fun triggerCameraFlash() {
    // Token is used as a pulse trigger; value doesn't matter as long as it changes.
    _cameraFlashToken.value = SystemClock.elapsedRealtimeNanos()
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

internal fun shouldConnectOperatorSession(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): Boolean = resolveOperatorSessionConnectAuth(auth, storedOperatorToken) != null

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

data class GatewaySkillSummary(
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

data class GatewayNodeSummary(
  val id: String,
  val displayName: String?,
  val remoteIp: String?,
  val version: String?,
  val deviceFamily: String?,
  val paired: Boolean,
  val connected: Boolean,
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
)

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
