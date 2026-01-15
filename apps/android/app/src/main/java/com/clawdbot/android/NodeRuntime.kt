package com.clawdbot.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.clawdbot.android.chat.ChatController
import com.clawdbot.android.chat.ChatMessage
import com.clawdbot.android.chat.ChatPendingToolCall
import com.clawdbot.android.chat.ChatSessionEntry
import com.clawdbot.android.chat.OutgoingAttachment
import com.clawdbot.android.bridge.BridgeDiscovery
import com.clawdbot.android.bridge.BridgeEndpoint
import com.clawdbot.android.bridge.BridgePairingClient
import com.clawdbot.android.bridge.BridgeSession
import com.clawdbot.android.node.CameraCaptureManager
import com.clawdbot.android.node.LocationCaptureManager
import com.clawdbot.android.BuildConfig
import com.clawdbot.android.node.CanvasController
import com.clawdbot.android.node.ScreenRecordManager
import com.clawdbot.android.node.SmsManager
import com.clawdbot.android.protocol.ClawdbotCapability
import com.clawdbot.android.protocol.ClawdbotCameraCommand
import com.clawdbot.android.protocol.ClawdbotCanvasA2UIAction
import com.clawdbot.android.protocol.ClawdbotCanvasA2UICommand
import com.clawdbot.android.protocol.ClawdbotCanvasCommand
import com.clawdbot.android.protocol.ClawdbotScreenCommand
import com.clawdbot.android.protocol.ClawdbotLocationCommand
import com.clawdbot.android.protocol.ClawdbotSmsCommand
import com.clawdbot.android.voice.TalkModeManager
import com.clawdbot.android.voice.VoiceWakeManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.concurrent.atomic.AtomicLong

class NodeRuntime(context: Context) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  val prefs = SecurePrefs(appContext)
  val canvas = CanvasController()
  val camera = CameraCaptureManager(appContext)
  val location = LocationCaptureManager(appContext)
  val screenRecorder = ScreenRecordManager(appContext)
  val sms = SmsManager(appContext)
  private val json = Json { ignoreUnknownKeys = true }

  private val externalAudioCaptureActive = MutableStateFlow(false)

  private val voiceWake: VoiceWakeManager by lazy {
    VoiceWakeManager(
      context = appContext,
      scope = scope,
      onCommand = { command ->
        session.sendEvent(
          event = "agent.request",
          payloadJson =
            buildJsonObject {
              put("message", JsonPrimitive(command))
              put("sessionKey", JsonPrimitive(resolveMainSessionKey()))
              put("thinking", JsonPrimitive(chatThinkingLevel.value))
              put("deliver", JsonPrimitive(false))
            }.toString(),
        )
      },
    )
  }

  val voiceWakeIsListening: StateFlow<Boolean>
    get() = voiceWake.isListening

  val voiceWakeStatusText: StateFlow<String>
    get() = voiceWake.statusText

  val talkStatusText: StateFlow<String>
    get() = talkMode.statusText

  val talkIsListening: StateFlow<Boolean>
    get() = talkMode.isListening

  val talkIsSpeaking: StateFlow<Boolean>
    get() = talkMode.isSpeaking

  private val discovery = BridgeDiscovery(appContext, scope = scope)
  val bridges: StateFlow<List<BridgeEndpoint>> = discovery.bridges
  val discoveryStatusText: StateFlow<String> = discovery.statusText

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

  private val _statusText = MutableStateFlow("Offline")
  val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _mainSessionKey = MutableStateFlow("main")
  val mainSessionKey: StateFlow<String> = _mainSessionKey.asStateFlow()

  private val cameraHudSeq = AtomicLong(0)
  private val _cameraHud = MutableStateFlow<CameraHudState?>(null)
  val cameraHud: StateFlow<CameraHudState?> = _cameraHud.asStateFlow()

  private val _cameraFlashToken = MutableStateFlow(0L)
  val cameraFlashToken: StateFlow<Long> = _cameraFlashToken.asStateFlow()

  private val _screenRecordActive = MutableStateFlow(false)
  val screenRecordActive: StateFlow<Boolean> = _screenRecordActive.asStateFlow()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()

  private val _remoteAddress = MutableStateFlow<String?>(null)
  val remoteAddress: StateFlow<String?> = _remoteAddress.asStateFlow()

  private val _seamColorArgb = MutableStateFlow(DEFAULT_SEAM_COLOR_ARGB)
  val seamColorArgb: StateFlow<Long> = _seamColorArgb.asStateFlow()

  private val _isForeground = MutableStateFlow(true)
  val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

  private var lastAutoA2uiUrl: String? = null

  private val session =
    BridgeSession(
      scope = scope,
      onConnected = { name, remote, mainSessionKey ->
        _statusText.value = "Connected"
        _serverName.value = name
        _remoteAddress.value = remote
        _isConnected.value = true
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        applyMainSessionKey(mainSessionKey)
        scope.launch { refreshBrandingFromGateway() }
        scope.launch { refreshWakeWordsFromGateway() }
        maybeNavigateToA2uiOnConnect()
      },
      onDisconnected = { message -> handleSessionDisconnected(message) },
      onEvent = { event, payloadJson ->
        handleBridgeEvent(event, payloadJson)
      },
      onInvoke = { req ->
        handleInvoke(req.command, req.paramsJson)
      },
    )

  private val chat = ChatController(scope = scope, session = session, json = json)
  private val talkMode: TalkModeManager by lazy {
    TalkModeManager(context = appContext, scope = scope).also { it.attachSession(session) }
  }

  private fun handleSessionDisconnected(message: String) {
    _statusText.value = message
    _serverName.value = null
    _remoteAddress.value = null
    _isConnected.value = false
    _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
    if (!isCanonicalMainSessionKey(_mainSessionKey.value)) {
      _mainSessionKey.value = "main"
    }
    val mainKey = resolveMainSessionKey()
    talkMode.setMainSessionKey(mainKey)
    chat.applyMainSessionKey(mainKey)
    chat.onDisconnected(message)
    showLocalCanvasOnDisconnect()
  }

  private fun applyMainSessionKey(candidate: String?) {
    val trimmed = candidate?.trim().orEmpty()
    if (trimmed.isEmpty()) return
    if (isCanonicalMainSessionKey(_mainSessionKey.value)) return
    if (_mainSessionKey.value == trimmed) return
    _mainSessionKey.value = trimmed
    talkMode.setMainSessionKey(trimmed)
    chat.applyMainSessionKey(trimmed)
  }

  private fun resolveMainSessionKey(): String {
    val trimmed = _mainSessionKey.value.trim()
    return if (trimmed.isEmpty()) "main" else trimmed
  }

  private fun maybeNavigateToA2uiOnConnect() {
    val a2uiUrl = resolveA2uiHostUrl() ?: return
    val current = canvas.currentUrl()?.trim().orEmpty()
    if (current.isEmpty() || current == lastAutoA2uiUrl) {
      lastAutoA2uiUrl = a2uiUrl
      canvas.navigate(a2uiUrl)
    }
  }

  private fun showLocalCanvasOnDisconnect() {
    lastAutoA2uiUrl = null
    canvas.navigate("")
  }

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val locationMode: StateFlow<LocationMode> = prefs.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = prefs.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = prefs.preventSleep
  val wakeWords: StateFlow<List<String>> = prefs.wakeWords
  val voiceWakeMode: StateFlow<VoiceWakeMode> = prefs.voiceWakeMode
  val talkEnabled: StateFlow<Boolean> = prefs.talkEnabled
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled

  private var didAutoConnect = false
  private var suppressWakeWordsSync = false
  private var wakeWordsSyncJob: Job? = null

  val chatSessionKey: StateFlow<String> = chat.sessionKey
  val chatSessionId: StateFlow<String?> = chat.sessionId
  val chatMessages: StateFlow<List<ChatMessage>> = chat.messages
  val chatError: StateFlow<String?> = chat.errorText
  val chatHealthOk: StateFlow<Boolean> = chat.healthOk
  val chatThinkingLevel: StateFlow<String> = chat.thinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = chat.streamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = chat.pendingToolCalls
  val chatSessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val pendingRunCount: StateFlow<Int> = chat.pendingRunCount

  init {
    scope.launch {
      combine(
        voiceWakeMode,
        isForeground,
        externalAudioCaptureActive,
        wakeWords,
      ) { mode, foreground, externalAudio, words ->
        Quad(mode, foreground, externalAudio, words)
      }.distinctUntilChanged()
        .collect { (mode, foreground, externalAudio, words) ->
          voiceWake.setTriggerWords(words)

          val shouldListen =
            when (mode) {
              VoiceWakeMode.Off -> false
              VoiceWakeMode.Foreground -> foreground
              VoiceWakeMode.Always -> true
            } && !externalAudio

          if (!shouldListen) {
            voiceWake.stop(statusText = if (mode == VoiceWakeMode.Off) "Off" else "Paused")
            return@collect
          }

          if (!hasRecordAudioPermission()) {
            voiceWake.stop(statusText = "Microphone permission required")
            return@collect
          }

          voiceWake.start()
        }
    }

    scope.launch {
      talkEnabled.collect { enabled ->
        talkMode.setEnabled(enabled)
        externalAudioCaptureActive.value = enabled
      }
    }

    scope.launch(Dispatchers.Default) {
      bridges.collect { list ->
        if (list.isNotEmpty()) {
          // Persist the last discovered bridge (best-effort UX parity with iOS).
          prefs.setLastDiscoveredStableId(list.last().stableId)
        }

        if (didAutoConnect) return@collect
        if (_isConnected.value) return@collect

        val token = prefs.loadBridgeToken()
        if (token.isNullOrBlank()) return@collect

        if (manualEnabled.value) {
          val host = manualHost.value.trim()
          val port = manualPort.value
          if (host.isNotEmpty() && port in 1..65535) {
            didAutoConnect = true
            connect(BridgeEndpoint.manual(host = host, port = port))
          }
          return@collect
        }

        val targetStableId = lastDiscoveredStableId.value.trim()
        if (targetStableId.isEmpty()) return@collect
        val target = list.firstOrNull { it.stableId == targetStableId } ?: return@collect
        didAutoConnect = true
        connect(target)
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
  }

  fun setForeground(value: Boolean) {
    _isForeground.value = value
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

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.setCanvasDebugStatusEnabled(value)
  }

  fun setWakeWords(words: List<String>) {
    prefs.setWakeWords(words)
    scheduleWakeWordsSyncIfNeeded()
  }

  fun resetWakeWordsDefaults() {
    setWakeWords(SecurePrefs.defaultWakeWords)
  }

  fun setVoiceWakeMode(mode: VoiceWakeMode) {
    prefs.setVoiceWakeMode(mode)
  }

  fun setTalkEnabled(value: Boolean) {
    prefs.setTalkEnabled(value)
  }

  private fun buildInvokeCommands(): List<String> =
    buildList {
      add(ClawdbotCanvasCommand.Present.rawValue)
      add(ClawdbotCanvasCommand.Hide.rawValue)
      add(ClawdbotCanvasCommand.Navigate.rawValue)
      add(ClawdbotCanvasCommand.Eval.rawValue)
      add(ClawdbotCanvasCommand.Snapshot.rawValue)
      add(ClawdbotCanvasA2UICommand.Push.rawValue)
      add(ClawdbotCanvasA2UICommand.PushJSONL.rawValue)
      add(ClawdbotCanvasA2UICommand.Reset.rawValue)
      add(ClawdbotScreenCommand.Record.rawValue)
      if (cameraEnabled.value) {
        add(ClawdbotCameraCommand.Snap.rawValue)
        add(ClawdbotCameraCommand.Clip.rawValue)
      }
      if (locationMode.value != LocationMode.Off) {
        add(ClawdbotLocationCommand.Get.rawValue)
      }
      if (sms.canSendSms()) {
        add(ClawdbotSmsCommand.Send.rawValue)
      }
    }

  private fun buildCapabilities(): List<String> =
    buildList {
      add(ClawdbotCapability.Canvas.rawValue)
      add(ClawdbotCapability.Screen.rawValue)
      if (cameraEnabled.value) add(ClawdbotCapability.Camera.rawValue)
      if (sms.canSendSms()) add(ClawdbotCapability.Sms.rawValue)
      if (voiceWakeMode.value != VoiceWakeMode.Off && hasRecordAudioPermission()) {
        add(ClawdbotCapability.VoiceWake.rawValue)
      }
      if (locationMode.value != LocationMode.Off) {
        add(ClawdbotCapability.Location.rawValue)
      }
    }

  private fun buildPairingHello(token: String?): BridgePairingClient.Hello {
    val modelIdentifier = listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { null }
    val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
    val advertisedVersion =
      if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
        "$versionName-dev"
      } else {
        versionName
      }
    return BridgePairingClient.Hello(
      nodeId = instanceId.value,
      displayName = displayName.value,
      token = token,
      platform = "Android",
      version = advertisedVersion,
      deviceFamily = "Android",
      modelIdentifier = modelIdentifier,
      caps = buildCapabilities(),
      commands = buildInvokeCommands(),
    )
  }

  private fun buildSessionHello(token: String?): BridgeSession.Hello {
    val modelIdentifier = listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { null }
    val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
    val advertisedVersion =
      if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
        "$versionName-dev"
      } else {
        versionName
      }
    return BridgeSession.Hello(
      nodeId = instanceId.value,
      displayName = displayName.value,
      token = token,
      platform = "Android",
      version = advertisedVersion,
      deviceFamily = "Android",
      modelIdentifier = modelIdentifier,
      caps = buildCapabilities(),
      commands = buildInvokeCommands(),
    )
  }

  fun refreshBridgeHello() {
    scope.launch {
      if (!_isConnected.value) return@launch
      val token = prefs.loadBridgeToken()
      if (token.isNullOrBlank()) return@launch
      session.updateHello(buildSessionHello(token))
    }
  }

  fun connect(endpoint: BridgeEndpoint) {
    scope.launch {
      _statusText.value = "Connecting…"
      val storedToken = prefs.loadBridgeToken()
      val resolved =
        if (storedToken.isNullOrBlank()) {
          _statusText.value = "Pairing…"
          BridgePairingClient().pairAndHello(
            endpoint = endpoint,
            hello = buildPairingHello(token = null),
          )
        } else {
          BridgePairingClient.PairResult(ok = true, token = storedToken.trim())
        }

      if (!resolved.ok || resolved.token.isNullOrBlank()) {
        val errorMessage = resolved.error?.trim().orEmpty().ifEmpty { "pairing required" }
        _statusText.value = "Failed: $errorMessage"
        return@launch
      }

      val authToken = requireNotNull(resolved.token).trim()
      prefs.saveBridgeToken(authToken)
      session.connect(
        endpoint = endpoint,
        hello = buildSessionHello(token = authToken),
      )
    }
  }

  private fun hasRecordAudioPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  private fun hasFineLocationPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  private fun hasCoarseLocationPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  private fun hasBackgroundLocationPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  fun connectManual() {
    val host = manualHost.value.trim()
    val port = manualPort.value
    if (host.isEmpty() || port <= 0 || port > 65535) {
      _statusText.value = "Failed: invalid manual host/port"
      return
    }
    connect(BridgeEndpoint.manual(host = host, port = port))
  }

  fun disconnect() {
    session.disconnect()
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
      val actionId = (userActionObj["id"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty {
        java.util.UUID.randomUUID().toString()
      }
      val name = ClawdbotCanvasA2UIAction.extractActionName(userActionObj) ?: return@launch

      val surfaceId =
        (userActionObj["surfaceId"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty { "main" }
      val sourceComponentId =
        (userActionObj["sourceComponentId"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty { "-" }
      val contextJson = (userActionObj["context"] as? JsonObject)?.toString()

      val sessionKey = resolveMainSessionKey()
      val message =
        ClawdbotCanvasA2UIAction.formatAgentMessage(
          actionName = name,
          sessionKey = sessionKey,
          surfaceId = surfaceId,
          sourceComponentId = sourceComponentId,
          host = displayName.value,
          instanceId = instanceId.value.lowercase(),
          contextJson = contextJson,
        )

      val connected = isConnected.value
      var error: String? = null
      if (connected) {
        try {
          session.sendEvent(
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
        } catch (e: Throwable) {
          error = e.message ?: "send failed"
        }
      } else {
        error = "bridge not connected"
      }

      try {
        canvas.eval(
          ClawdbotCanvasA2UIAction.jsDispatchA2UIActionStatus(
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

  fun sendChat(message: String, thinking: String, attachments: List<OutgoingAttachment>) {
    chat.sendMessage(message = message, thinkingLevel = thinking, attachments = attachments)
  }

  private fun handleBridgeEvent(event: String, payloadJson: String?) {
    if (event == "voicewake.changed") {
      if (payloadJson.isNullOrBlank()) return
      try {
        val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
        val array = payload["triggers"] as? JsonArray ?: return
        val triggers = array.mapNotNull { it.asStringOrNull() }
        applyWakeWordsFromGateway(triggers)
      } catch (_: Throwable) {
        // ignore
      }
      return
    }

    talkMode.handleBridgeEvent(event, payloadJson)
    chat.handleBridgeEvent(event, payloadJson)
  }

  private fun applyWakeWordsFromGateway(words: List<String>) {
    suppressWakeWordsSync = true
    prefs.setWakeWords(words)
    suppressWakeWordsSync = false
  }

  private fun scheduleWakeWordsSyncIfNeeded() {
    if (suppressWakeWordsSync) return
    if (!_isConnected.value) return

    val snapshot = prefs.wakeWords.value
    wakeWordsSyncJob?.cancel()
    wakeWordsSyncJob =
      scope.launch {
        delay(650)
        val jsonList = snapshot.joinToString(separator = ",") { it.toJsonString() }
        val params = """{"triggers":[$jsonList]}"""
        try {
          session.request("voicewake.set", params)
        } catch (_: Throwable) {
          // ignore
        }
      }
  }

  private suspend fun refreshWakeWordsFromGateway() {
    if (!_isConnected.value) return
    try {
      val res = session.request("voicewake.get", "{}")
      val payload = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val array = payload["triggers"] as? JsonArray ?: return
      val triggers = array.mapNotNull { it.asStringOrNull() }
      applyWakeWordsFromGateway(triggers)
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun refreshBrandingFromGateway() {
    if (!_isConnected.value) return
    try {
      val res = session.request("config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val ui = config?.get("ui").asObjectOrNull()
      val raw = ui?.get("seamColor").asStringOrNull()?.trim()
      val sessionCfg = config?.get("session").asObjectOrNull()
      val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())
      applyMainSessionKey(mainKey)

      val parsed = parseHexColorArgb(raw)
      _seamColorArgb.value = parsed ?: DEFAULT_SEAM_COLOR_ARGB
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun handleInvoke(command: String, paramsJson: String?): BridgeSession.InvokeResult {
    if (
      command.startsWith(ClawdbotCanvasCommand.NamespacePrefix) ||
        command.startsWith(ClawdbotCanvasA2UICommand.NamespacePrefix) ||
        command.startsWith(ClawdbotCameraCommand.NamespacePrefix) ||
        command.startsWith(ClawdbotScreenCommand.NamespacePrefix)
      ) {
      if (!isForeground.value) {
        return BridgeSession.InvokeResult.error(
          code = "NODE_BACKGROUND_UNAVAILABLE",
          message = "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        )
      }
    }
    if (command.startsWith(ClawdbotCameraCommand.NamespacePrefix) && !cameraEnabled.value) {
      return BridgeSession.InvokeResult.error(
        code = "CAMERA_DISABLED",
        message = "CAMERA_DISABLED: enable Camera in Settings",
      )
    }
    if (command.startsWith(ClawdbotLocationCommand.NamespacePrefix) &&
      locationMode.value == LocationMode.Off
    ) {
      return BridgeSession.InvokeResult.error(
        code = "LOCATION_DISABLED",
        message = "LOCATION_DISABLED: enable Location in Settings",
      )
    }

    return when (command) {
      ClawdbotCanvasCommand.Present.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        BridgeSession.InvokeResult.ok(null)
      }
      ClawdbotCanvasCommand.Hide.rawValue -> BridgeSession.InvokeResult.ok(null)
      ClawdbotCanvasCommand.Navigate.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        BridgeSession.InvokeResult.ok(null)
      }
      ClawdbotCanvasCommand.Eval.rawValue -> {
        val js =
          CanvasController.parseEvalJs(paramsJson)
            ?: return BridgeSession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = "INVALID_REQUEST: javaScript required",
            )
        val result =
          try {
            canvas.eval(js)
          } catch (err: Throwable) {
            return BridgeSession.InvokeResult.error(
              code = "NODE_BACKGROUND_UNAVAILABLE",
              message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
            )
          }
        BridgeSession.InvokeResult.ok("""{"result":${result.toJsonString()}}""")
      }
      ClawdbotCanvasCommand.Snapshot.rawValue -> {
        val snapshotParams = CanvasController.parseSnapshotParams(paramsJson)
        val base64 =
          try {
            canvas.snapshotBase64(
              format = snapshotParams.format,
              quality = snapshotParams.quality,
              maxWidth = snapshotParams.maxWidth,
            )
          } catch (err: Throwable) {
            return BridgeSession.InvokeResult.error(
              code = "NODE_BACKGROUND_UNAVAILABLE",
              message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
            )
          }
        BridgeSession.InvokeResult.ok("""{"format":"${snapshotParams.format.rawValue}","base64":"$base64"}""")
      }
      ClawdbotCanvasA2UICommand.Reset.rawValue -> {
        val a2uiUrl = resolveA2uiHostUrl()
          ?: return BridgeSession.InvokeResult.error(
            code = "A2UI_HOST_NOT_CONFIGURED",
            message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
          )
        val ready = ensureA2uiReady(a2uiUrl)
        if (!ready) {
          return BridgeSession.InvokeResult.error(
            code = "A2UI_HOST_UNAVAILABLE",
            message = "A2UI host not reachable",
          )
        }
        val res = canvas.eval(a2uiResetJS)
        BridgeSession.InvokeResult.ok(res)
      }
      ClawdbotCanvasA2UICommand.Push.rawValue, ClawdbotCanvasA2UICommand.PushJSONL.rawValue -> {
        val messages =
          try {
            decodeA2uiMessages(command, paramsJson)
          } catch (err: Throwable) {
            return BridgeSession.InvokeResult.error(code = "INVALID_REQUEST", message = err.message ?: "invalid A2UI payload")
          }
        val a2uiUrl = resolveA2uiHostUrl()
          ?: return BridgeSession.InvokeResult.error(
            code = "A2UI_HOST_NOT_CONFIGURED",
            message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
          )
        val ready = ensureA2uiReady(a2uiUrl)
        if (!ready) {
          return BridgeSession.InvokeResult.error(
            code = "A2UI_HOST_UNAVAILABLE",
            message = "A2UI host not reachable",
          )
        }
        val js = a2uiApplyMessagesJS(messages)
        val res = canvas.eval(js)
        BridgeSession.InvokeResult.ok(res)
      }
      ClawdbotCameraCommand.Snap.rawValue -> {
        showCameraHud(message = "Taking photo…", kind = CameraHudKind.Photo)
        triggerCameraFlash()
        val res =
          try {
            camera.snap(paramsJson)
          } catch (err: Throwable) {
            val (code, message) = invokeErrorFromThrowable(err)
            showCameraHud(message = message, kind = CameraHudKind.Error, autoHideMs = 2200)
            return BridgeSession.InvokeResult.error(code = code, message = message)
          }
        showCameraHud(message = "Photo captured", kind = CameraHudKind.Success, autoHideMs = 1600)
        BridgeSession.InvokeResult.ok(res.payloadJson)
      }
      ClawdbotCameraCommand.Clip.rawValue -> {
        val includeAudio = paramsJson?.contains("\"includeAudio\":true") != false
        if (includeAudio) externalAudioCaptureActive.value = true
        try {
          showCameraHud(message = "Recording…", kind = CameraHudKind.Recording)
          val res =
            try {
              camera.clip(paramsJson)
            } catch (err: Throwable) {
              val (code, message) = invokeErrorFromThrowable(err)
              showCameraHud(message = message, kind = CameraHudKind.Error, autoHideMs = 2400)
              return BridgeSession.InvokeResult.error(code = code, message = message)
            }
          showCameraHud(message = "Clip captured", kind = CameraHudKind.Success, autoHideMs = 1800)
          BridgeSession.InvokeResult.ok(res.payloadJson)
        } finally {
          if (includeAudio) externalAudioCaptureActive.value = false
        }
      }
      ClawdbotLocationCommand.Get.rawValue -> {
        val mode = locationMode.value
        if (!isForeground.value && mode != LocationMode.Always) {
          return BridgeSession.InvokeResult.error(
            code = "LOCATION_BACKGROUND_UNAVAILABLE",
            message = "LOCATION_BACKGROUND_UNAVAILABLE: background location requires Always",
          )
        }
        if (!hasFineLocationPermission() && !hasCoarseLocationPermission()) {
          return BridgeSession.InvokeResult.error(
            code = "LOCATION_PERMISSION_REQUIRED",
            message = "LOCATION_PERMISSION_REQUIRED: grant Location permission",
          )
        }
        if (!isForeground.value && mode == LocationMode.Always && !hasBackgroundLocationPermission()) {
          return BridgeSession.InvokeResult.error(
            code = "LOCATION_PERMISSION_REQUIRED",
            message = "LOCATION_PERMISSION_REQUIRED: enable Always in system Settings",
          )
        }
        val (maxAgeMs, timeoutMs, desiredAccuracy) = parseLocationParams(paramsJson)
        val preciseEnabled = locationPreciseEnabled.value
        val accuracy =
          when (desiredAccuracy) {
            "precise" -> if (preciseEnabled && hasFineLocationPermission()) "precise" else "balanced"
            "coarse" -> "coarse"
            else -> if (preciseEnabled && hasFineLocationPermission()) "precise" else "balanced"
          }
        val providers =
          when (accuracy) {
            "precise" -> listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            "coarse" -> listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
            else -> listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
          }
        try {
          val payload =
            location.getLocation(
              desiredProviders = providers,
              maxAgeMs = maxAgeMs,
              timeoutMs = timeoutMs,
              isPrecise = accuracy == "precise",
            )
          BridgeSession.InvokeResult.ok(payload.payloadJson)
        } catch (err: TimeoutCancellationException) {
          BridgeSession.InvokeResult.error(
            code = "LOCATION_TIMEOUT",
            message = "LOCATION_TIMEOUT: no fix in time",
          )
        } catch (err: Throwable) {
          val message = err.message ?: "LOCATION_UNAVAILABLE: no fix"
          BridgeSession.InvokeResult.error(code = "LOCATION_UNAVAILABLE", message = message)
        }
      }
      ClawdbotScreenCommand.Record.rawValue -> {
        // Status pill mirrors screen recording state so it stays visible without overlay stacking.
        _screenRecordActive.value = true
        try {
          val res =
            try {
              screenRecorder.record(paramsJson)
            } catch (err: Throwable) {
              val (code, message) = invokeErrorFromThrowable(err)
              return BridgeSession.InvokeResult.error(code = code, message = message)
            }
          BridgeSession.InvokeResult.ok(res.payloadJson)
        } finally {
          _screenRecordActive.value = false
        }
      }
      ClawdbotSmsCommand.Send.rawValue -> {
        val res = sms.send(paramsJson)
        if (res.ok) {
          BridgeSession.InvokeResult.ok(res.payloadJson)
        } else {
          val error = res.error ?: "SMS_SEND_FAILED"
          val idx = error.indexOf(':')
          val code = if (idx > 0) error.substring(0, idx).trim() else "SMS_SEND_FAILED"
          BridgeSession.InvokeResult.error(code = code, message = error)
        }
      }
      else ->
        BridgeSession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: unknown command",
        )
    }
  }

  private fun triggerCameraFlash() {
    // Token is used as a pulse trigger; value doesn't matter as long as it changes.
    _cameraFlashToken.value = SystemClock.elapsedRealtimeNanos()
  }

  private fun showCameraHud(message: String, kind: CameraHudKind, autoHideMs: Long? = null) {
    val token = cameraHudSeq.incrementAndGet()
    _cameraHud.value = CameraHudState(token = token, kind = kind, message = message)

    if (autoHideMs != null && autoHideMs > 0) {
      scope.launch {
        delay(autoHideMs)
        if (_cameraHud.value?.token == token) _cameraHud.value = null
      }
    }
  }

  private fun invokeErrorFromThrowable(err: Throwable): Pair<String, String> {
    val raw = (err.message ?: "").trim()
    if (raw.isEmpty()) return "UNAVAILABLE" to "UNAVAILABLE: camera error"

    val idx = raw.indexOf(':')
    if (idx <= 0) return "UNAVAILABLE" to raw
    val code = raw.substring(0, idx).trim().ifEmpty { "UNAVAILABLE" }
    val message = raw.substring(idx + 1).trim().ifEmpty { raw }
    // Preserve full string for callers/logging, but keep the returned message human-friendly.
    return code to "$code: $message"
  }

  private fun parseLocationParams(paramsJson: String?): Triple<Long?, Long, String?> {
    if (paramsJson.isNullOrBlank()) {
      return Triple(null, 10_000L, null)
    }
    val root =
      try {
        json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      }
    val maxAgeMs = (root?.get("maxAgeMs") as? JsonPrimitive)?.content?.toLongOrNull()
    val timeoutMs =
      (root?.get("timeoutMs") as? JsonPrimitive)?.content?.toLongOrNull()?.coerceIn(1_000L, 60_000L)
        ?: 10_000L
    val desiredAccuracy =
      (root?.get("desiredAccuracy") as? JsonPrimitive)?.content?.trim()?.lowercase()
    return Triple(maxAgeMs, timeoutMs, desiredAccuracy)
  }

  private fun resolveA2uiHostUrl(): String? {
    val raw = session.currentCanvasHostUrl()?.trim().orEmpty()
    if (raw.isBlank()) return null
    val base = raw.trimEnd('/')
    return "${base}/__clawdbot__/a2ui/?platform=android"
  }

  private suspend fun ensureA2uiReady(a2uiUrl: String): Boolean {
    try {
      val already = canvas.eval(a2uiReadyCheckJS)
      if (already == "true") return true
    } catch (_: Throwable) {
      // ignore
    }

    canvas.navigate(a2uiUrl)
    repeat(50) {
      try {
        val ready = canvas.eval(a2uiReadyCheckJS)
        if (ready == "true") return true
      } catch (_: Throwable) {
        // ignore
      }
      delay(120)
    }
    return false
  }

  private fun decodeA2uiMessages(command: String, paramsJson: String?): String {
    val raw = paramsJson?.trim().orEmpty()
    if (raw.isBlank()) throw IllegalArgumentException("INVALID_REQUEST: paramsJSON required")

    val obj =
      json.parseToJsonElement(raw) as? JsonObject
        ?: throw IllegalArgumentException("INVALID_REQUEST: expected object params")

    val jsonlField = (obj["jsonl"] as? JsonPrimitive)?.content?.trim().orEmpty()
    val hasMessagesArray = obj["messages"] is JsonArray

    if (command == ClawdbotCanvasA2UICommand.PushJSONL.rawValue || (!hasMessagesArray && jsonlField.isNotBlank())) {
      val jsonl = jsonlField
      if (jsonl.isBlank()) throw IllegalArgumentException("INVALID_REQUEST: jsonl required")
      val messages =
        jsonl
          .lineSequence()
          .map { it.trim() }
          .filter { it.isNotBlank() }
          .mapIndexed { idx, line ->
            val el = json.parseToJsonElement(line)
            val msg =
              el as? JsonObject
                ?: throw IllegalArgumentException("A2UI JSONL line ${idx + 1}: expected a JSON object")
            validateA2uiV0_8(msg, idx + 1)
            msg
          }
          .toList()
      return JsonArray(messages).toString()
    }

    val arr = obj["messages"] as? JsonArray ?: throw IllegalArgumentException("INVALID_REQUEST: messages[] required")
    val out =
      arr.mapIndexed { idx, el ->
        val msg =
          el as? JsonObject
            ?: throw IllegalArgumentException("A2UI messages[${idx}]: expected a JSON object")
        validateA2uiV0_8(msg, idx + 1)
        msg
      }
    return JsonArray(out).toString()
  }

  private fun validateA2uiV0_8(msg: JsonObject, lineNumber: Int) {
    if (msg.containsKey("createSurface")) {
      throw IllegalArgumentException(
        "A2UI JSONL line $lineNumber: looks like A2UI v0.9 (`createSurface`). Canvas supports v0.8 messages only.",
      )
    }
    val allowed = setOf("beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface")
    val matched = msg.keys.filter { allowed.contains(it) }
    if (matched.size != 1) {
      val found = msg.keys.sorted().joinToString(", ")
      throw IllegalArgumentException(
        "A2UI JSONL line $lineNumber: expected exactly one of ${allowed.sorted().joinToString(", ")}; found: $found",
      )
    }
  }
}

private data class Quad<A, B, C, D>(val first: A, val second: B, val third: C, val fourth: D)

private const val DEFAULT_SEAM_COLOR_ARGB: Long = 0xFF4F7A9A

private const val a2uiReadyCheckJS: String =
  """
  (() => {
    try {
      return !!globalThis.clawdbotA2UI && typeof globalThis.clawdbotA2UI.applyMessages === 'function';
    } catch (_) {
      return false;
    }
  })()
  """

private const val a2uiResetJS: String =
  """
  (() => {
    try {
      if (!globalThis.clawdbotA2UI) return { ok: false, error: "missing clawdbotA2UI" };
      return globalThis.clawdbotA2UI.reset();
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  })()
  """

private fun a2uiApplyMessagesJS(messagesJson: String): String {
  return """
    (() => {
      try {
        if (!globalThis.clawdbotA2UI) return { ok: false, error: "missing clawdbotA2UI" };
        const messages = $messagesJson;
        return globalThis.clawdbotA2UI.applyMessages(messages);
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    })()
  """.trimIndent()
}

private fun String.toJsonString(): String {
  val escaped =
    this.replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
  return "\"$escaped\""
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

private fun parseHexColorArgb(raw: String?): Long? {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return null
  val hex = if (trimmed.startsWith("#")) trimmed.drop(1) else trimmed
  if (hex.length != 6) return null
  val rgb = hex.toLongOrNull(16) ?: return null
  return 0xFF000000L or rgb
}
