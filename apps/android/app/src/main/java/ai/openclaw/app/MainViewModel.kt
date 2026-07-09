package ai.openclaw.app

import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayUpdateAvailableSummary
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.node.SmsManager
import ai.openclaw.app.ui.GatewayConnectPlan
import ai.openclaw.app.ui.GatewaySavedAuthAction
import ai.openclaw.app.voice.VoiceConversationEntry
import android.Manifest
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicLong

enum class ChatDraftPlacement {
  Replace,
  BeforeExisting,
}

data class ChatDraft(
  val text: String,
  val placement: ChatDraftPlacement,
)

internal fun shouldStartRuntimeOnForeground(
  foreground: Boolean,
  onboardingCompleted: Boolean,
): Boolean = foreground && onboardingCompleted

/**
 * UI-facing bridge that exposes NodeRuntime and preference state as Compose-friendly StateFlows.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModel(
  app: Application,
) : AndroidViewModel(app) {
  private val nodeApp = app as NodeApp
  private val prefs = nodeApp.prefs
  private val runtimeRef = MutableStateFlow<NodeRuntime?>(null)
  private val gatewayConfigOperationSeq = AtomicLong()
  private val gatewayConfigOperationMutex = Mutex()

  @Volatile private var permissionRequester: PermissionRequester? = null

  @Volatile private var foreground = false

  @Volatile private var runtimeStartupQueued = false
  private val initialIntentGate = MainActivityInitialIntentGate()

  private val _requestedHomeDestination = MutableStateFlow<HomeDestination?>(null)
  val requestedHomeDestination: StateFlow<HomeDestination?> = _requestedHomeDestination
  private val _startOnboardingAtGatewaySetup = MutableStateFlow(false)
  val startOnboardingAtGatewaySetup: StateFlow<Boolean> = _startOnboardingAtGatewaySetup
  private val _chatDraft = MutableStateFlow<ChatDraft?>(null)
  val chatDraft: StateFlow<ChatDraft?> = _chatDraft
  private val _pendingAssistantAutoSend = MutableStateFlow<String?>(null)
  val pendingAssistantAutoSend: StateFlow<String?> = _pendingAssistantAutoSend
  private val _assistantAutoSendInFlight = MutableStateFlow(false)
  val assistantAutoSendInFlight: StateFlow<Boolean> = _assistantAutoSendInFlight

  /**
   * Lazily starts NodeRuntime and preserves the current foreground bit across startup.
   */
  private fun ensureRuntime(): NodeRuntime {
    runtimeRef.value?.let { return it }
    val runtime = nodeApp.ensureRuntime()
    runtime.setForeground(foreground)
    runtimeRef.value = runtime
    return runtime
  }

  internal fun claimInitialIntentRouting(): Boolean = initialIntentGate.claim()

  internal fun enterScreenshotFixtureMode(scene: AndroidScreenshotScene) {
    check(BuildConfig.DEBUG) { "Android screenshot fixtures require a debug build" }
    runtimeRef.value?.let { runtime ->
      // The ViewModel survives locale recreation; keep the fixture runtime instead of
      // treating the restored Activity as a second fixture startup.
      check(runtime.mode == NodeRuntimeMode.ScreenshotFixture) {
        "Screenshot fixture mode must be selected before live runtime startup"
      }
      runtime.setForeground(foreground)
      _requestedHomeDestination.value = scene.homeDestination
      return
    }
    prefs.setOnboardingCompleted(true)
    prefs.setAppearanceThemeMode(AppearanceThemeMode.Dark)
    prefs.setDisplayName("Pixel")
    prefs.setSpeakerEnabled(true)
    val runtime = nodeApp.ensureScreenshotFixtureRuntime()
    runtime.setForeground(foreground)
    runtimeRef.value = runtime
    _requestedHomeDestination.value = scene.homeDestination
  }

  /**
   * Starts the node runtime off the main thread so fresh installs can render
   * the shell before encrypted prefs, device identity, and gateway setup warm up.
   */
  private fun queueRuntimeStartup() {
    if (runtimeRef.value != null || runtimeStartupQueued) return
    runtimeStartupQueued = true
    viewModelScope.launch(Dispatchers.Default) {
      runCatching { ensureRuntime() }
      runtimeStartupQueued = false
    }
  }

  /**
   * Adapts a runtime StateFlow to a stable ViewModel StateFlow before runtime startup.
   */
  private fun <T> runtimeState(
    initial: T,
    selector: (NodeRuntime) -> StateFlow<T>,
  ): StateFlow<T> =
    runtimeRef
      .flatMapLatest { runtime -> runtime?.let(selector) ?: flowOf(initial) }
      .stateIn(viewModelScope, SharingStarted.Eagerly, initial)

  val runtimeInitialized: StateFlow<Boolean> =
    runtimeRef
      .flatMapLatest { runtime -> flowOf(runtime != null) }
      .stateIn(viewModelScope, SharingStarted.Eagerly, false)

  val canvasCurrentUrl: StateFlow<String?> = runtimeState(initial = null) { it.canvas.currentUrl }
  val canvasA2uiHydrated: StateFlow<Boolean> = runtimeState(initial = false) { it.canvasA2uiHydrated }
  val canvasRehydratePending: StateFlow<Boolean> = runtimeState(initial = false) { it.canvasRehydratePending }
  val canvasRehydrateErrorText: StateFlow<String?> = runtimeState(initial = null) { it.canvasRehydrateErrorText }

  val gateways: StateFlow<List<GatewayEndpoint>> = runtimeState(initial = emptyList()) { it.gateways }
  val discoveryStatusText: StateFlow<String> = runtimeState(initial = "Searching…") { it.discoveryStatusText }
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

  val isConnected: StateFlow<Boolean> = runtimeState(initial = false) { it.isConnected }
  val gatewayControlPage: StateFlow<NodeRuntime.GatewayControlPage?> =
    runtimeState(initial = null) { it.gatewayControlPage }
  val isNodeConnected: StateFlow<Boolean> = runtimeState(initial = false) { it.nodeConnected }
  val nodeCapabilityApproval: StateFlow<GatewayNodeCapabilityApproval> =
    runtimeState(initial = GatewayNodeCapabilityApproval.Loading) { it.nodeCapabilityApproval }
  val statusText: StateFlow<String> = runtimeState(initial = "Offline") { it.statusText }
  val gatewayConnectionProblem: StateFlow<GatewayConnectionProblem?> = runtimeState(initial = null) { it.gatewayConnectionProblem }
  val gatewayConnectionDisplay: StateFlow<GatewayConnectionDisplay> =
    runtimeState(initial = GatewayConnectionDisplay(false, "Offline", null)) { it.gatewayConnectionDisplay }
  val operatorAdminScopeAvailable: StateFlow<Boolean> = runtimeState(initial = false) { it.operatorAdminScopeAvailable }
  val serverName: StateFlow<String?> = runtimeState(initial = null) { it.serverName }
  val remoteAddress: StateFlow<String?> = runtimeState(initial = null) { it.remoteAddress }
  val gatewayVersion: StateFlow<String?> = runtimeState(initial = null) { it.gatewayVersion }
  val gatewayUpdateAvailable: StateFlow<GatewayUpdateAvailableSummary?> = runtimeState(initial = null) { it.gatewayUpdateAvailable }
  val modelCatalog: StateFlow<List<GatewayModelSummary>> = runtimeState(initial = emptyList()) { it.modelCatalog }
  val modelAuthProviders: StateFlow<List<GatewayModelProviderSummary>> = runtimeState(initial = emptyList()) { it.modelAuthProviders }
  val modelCatalogRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.modelCatalogRefreshing }
  val modelCatalogErrorText: StateFlow<String?> = runtimeState(initial = null) { it.modelCatalogErrorText }
  val modelFavorites: StateFlow<List<String>> = prefs.modelFavorites
  val modelRecents: StateFlow<List<String>> = prefs.modelRecents
  val sessionCustomGroups: StateFlow<List<String>> = prefs.sessionCustomGroups
  val talkSetupReadiness: StateFlow<GatewayTalkSetupReadiness> =
    runtimeState(initial = GatewayTalkSetupReadiness.unverified()) { it.talkSetupReadiness }
  val gatewayDefaultAgentId: StateFlow<String?> = runtimeState(initial = null) { it.gatewayDefaultAgentId }
  val gatewayAgents: StateFlow<List<GatewayAgentSummary>> = runtimeState(initial = emptyList()) { it.gatewayAgents }
  val cronStatus: StateFlow<GatewayCronStatus> = runtimeState(initial = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)) { it.cronStatus }
  val cronJobs: StateFlow<List<GatewayCronJobSummary>> = runtimeState(initial = emptyList()) { it.cronJobs }
  val cronRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.cronRefreshing }
  val cronErrorText: StateFlow<String?> = runtimeState(initial = null) { it.cronErrorText }
  val cronJobDetailState: StateFlow<GatewayCronJobDetailState> = runtimeState(initial = GatewayCronJobDetailState.Idle) { it.cronJobDetailState }
  val usageSummary: StateFlow<GatewayUsageSummary> = runtimeState(initial = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())) { it.usageSummary }
  val usageRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.usageRefreshing }
  val usageErrorText: StateFlow<String?> = runtimeState(initial = null) { it.usageErrorText }
  val skillsSummary: StateFlow<GatewaySkillsSummary> = runtimeState(initial = GatewaySkillsSummary(skills = emptyList())) { it.skillsSummary }
  val skillsRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.skillsRefreshing }
  val skillsErrorText: StateFlow<String?> = runtimeState(initial = null) { it.skillsErrorText }
  val skillWorkshopSummary: StateFlow<GatewaySkillWorkshopSummary> =
    runtimeState(initial = GatewaySkillWorkshopSummary(proposals = emptyList())) { it.skillWorkshopSummary }
  val skillWorkshopRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.skillWorkshopRefreshing }
  val skillWorkshopErrorText: StateFlow<String?> = runtimeState(initial = null) { it.skillWorkshopErrorText }
  val skillWorkshopNoticeText: StateFlow<String?> = runtimeState(initial = null) { it.skillWorkshopNoticeText }
  val skillWorkshopInspectingProposalId: StateFlow<String?> = runtimeState(initial = null) { it.skillWorkshopInspectingProposalId }
  val skillWorkshopMutatingProposalId: StateFlow<String?> = runtimeState(initial = null) { it.skillWorkshopMutatingProposalId }
  val nodesDevicesSummary: StateFlow<GatewayNodesDevicesSummary> =
    runtimeState(initial = GatewayNodesDevicesSummary(nodes = emptyList(), pendingDevices = emptyList(), pairedDevices = emptyList())) { it.nodesDevicesSummary }
  val nodesDevicesRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.nodesDevicesRefreshing }
  val nodesDevicesErrorText: StateFlow<String?> = runtimeState(initial = null) { it.nodesDevicesErrorText }
  val channelsSummary: StateFlow<GatewayChannelsSummary> =
    runtimeState(initial = GatewayChannelsSummary(channels = emptyList())) { it.channelsSummary }
  val channelsRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.channelsRefreshing }
  val channelsErrorText: StateFlow<String?> = runtimeState(initial = null) { it.channelsErrorText }
  val dreamingSummary: StateFlow<GatewayDreamingSummary> =
    runtimeState(initial = GatewayDreamingSummary()) { it.dreamingSummary }
  val dreamingRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.dreamingRefreshing }
  val dreamingErrorText: StateFlow<String?> = runtimeState(initial = null) { it.dreamingErrorText }
  val healthLogsSummary: StateFlow<GatewayHealthLogsSummary> =
    runtimeState(initial = GatewayHealthLogsSummary()) { it.healthLogsSummary }
  val healthLogsRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.healthLogsRefreshing }
  val healthLogsErrorText: StateFlow<String?> = runtimeState(initial = null) { it.healthLogsErrorText }
  val pendingGatewayTrust: StateFlow<NodeRuntime.GatewayTrustPrompt?> = runtimeState(initial = null) { it.pendingGatewayTrust }
  val seamColorArgb: StateFlow<Long> = runtimeState(initial = 0xFF0EA5E9) { it.seamColorArgb }
  val mainSessionKey: StateFlow<String> = runtimeState(initial = "main") { it.mainSessionKey }

  val cameraHud: StateFlow<CameraHudState?> = runtimeState(initial = null) { it.cameraHud }

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
  val pairedGateways: StateFlow<List<GatewayRegistryEntry>> = prefs.gatewayRegistry.entries
  val activeGatewayStableId: StateFlow<String?> = prefs.gatewayRegistry.activeStableId
  val onboardingCompleted: StateFlow<Boolean> = prefs.onboardingCompleted
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled
  val installedAppsSharingEnabled: StateFlow<Boolean> = prefs.installedAppsSharingEnabled
  val speakerEnabled: StateFlow<Boolean> = prefs.speakerEnabled
  val appearanceThemeMode: StateFlow<AppearanceThemeMode> = prefs.appearanceThemeMode
  val voiceCaptureMode: StateFlow<VoiceCaptureMode> = runtimeState(initial = VoiceCaptureMode.Off) { it.voiceCaptureMode }
  val micEnabled: StateFlow<Boolean> = runtimeState(initial = false) { it.micEnabled }

  val micCooldown: StateFlow<Boolean> = runtimeState(initial = false) { it.micCooldown }
  val micStatusText: StateFlow<String> = runtimeState(initial = "Mic off") { it.micStatusText }
  val micLiveTranscript: StateFlow<String?> = runtimeState(initial = null) { it.micLiveTranscript }
  val micIsListening: StateFlow<Boolean> = runtimeState(initial = false) { it.micIsListening }
  val micQueuedMessages: StateFlow<List<String>> = runtimeState(initial = emptyList()) { it.micQueuedMessages }
  val micConversation: StateFlow<List<VoiceConversationEntry>> = runtimeState(initial = emptyList()) { it.micConversation }
  val micInputLevel: StateFlow<Float> = runtimeState(initial = 0f) { it.micInputLevel }
  val micIsSending: StateFlow<Boolean> = runtimeState(initial = false) { it.micIsSending }
  val talkModeEnabled: StateFlow<Boolean> = runtimeState(initial = false) { it.talkModeEnabled }
  val talkModeListening: StateFlow<Boolean> = runtimeState(initial = false) { it.talkModeListening }
  val talkModeSpeaking: StateFlow<Boolean> = runtimeState(initial = false) { it.talkModeSpeaking }
  val talkInputLevel: StateFlow<Float> = runtimeState(initial = 0f) { it.talkInputLevel }
  val talkOutputLevel: StateFlow<Float?> = runtimeState(initial = null) { it.talkOutputLevel }
  val talkSpeechActive: StateFlow<Boolean> = runtimeState(initial = false) { it.talkSpeechActive }
  val talkAwaitingAgent: StateFlow<Boolean> = runtimeState(initial = false) { it.talkAwaitingAgent }
  val talkModeStatusText: StateFlow<String> = runtimeState(initial = "Off") { it.talkModeStatusText }
  val talkModeConversation: StateFlow<List<VoiceConversationEntry>> =
    runtimeState(initial = emptyList()) { it.talkModeConversation }

  val chatSessionKey: StateFlow<String> = runtimeState(initial = "main") { it.chatSessionKey }
  val chatSessionId: StateFlow<String?> = runtimeState(initial = null) { it.chatSessionId }
  val chatMessages: StateFlow<List<ChatMessage>> = runtimeState(initial = emptyList()) { it.chatMessages }
  val chatHistoryLoading: StateFlow<Boolean> = runtimeState(initial = false) { it.chatHistoryLoading }
  val chatError: StateFlow<String?> = runtimeState(initial = null) { it.chatError }
  val chatHealthOk: StateFlow<Boolean> = runtimeState(initial = false) { it.chatHealthOk }
  val chatThinkingLevel: StateFlow<String> = runtimeState(initial = "off") { it.chatThinkingLevel }
  val chatSelectedModelRef: StateFlow<String?> = runtimeState(initial = null) { it.chatSelectedModelRef }
  val chatModelCatalog: StateFlow<List<GatewayModelSummary>> = runtimeState(initial = emptyList()) { it.chatModelCatalog }
  val chatStreamingAssistantText: StateFlow<String?> = runtimeState(initial = null) { it.chatStreamingAssistantText }
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = runtimeState(initial = emptyList()) { it.chatPendingToolCalls }
  val chatSessions: StateFlow<List<ChatSessionEntry>> = runtimeState(initial = emptyList()) { it.chatSessions }
  val pendingRunCount: StateFlow<Int> = runtimeState(initial = 0) { it.pendingRunCount }
  val chatCommands: StateFlow<List<ChatCommandEntry>> = runtimeState(initial = emptyList<ChatCommandEntry>()) { it.chatCommands }
  val chatOutboxItems: StateFlow<List<ChatOutboxItem>> = runtimeState(initial = emptyList()) { it.chatOutboxItems }
  internal val chatMessageSpeech: StateFlow<MessageSpeechState?> =
    runtimeState(initial = null) { it.messageSpeechState }
  val execApprovals: StateFlow<List<GatewayExecApprovalSummary>> = runtimeState(initial = emptyList()) { it.execApprovals }
  val execApprovalsRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.execApprovalsRefreshing }
  val execApprovalsErrorText: StateFlow<String?> = runtimeState(initial = null) { it.execApprovalsErrorText }

  val canvas: CanvasController
    get() = ensureRuntime().canvas

  val camera: CameraCaptureManager
    get() = ensureRuntime().camera

  val sms: SmsManager
    get() = ensureRuntime().sms

  /**
   * Attaches Activity-owned permission and lifecycle seams after runtime initialization.
   */
  fun attachRuntimeUi(
    owner: LifecycleOwner,
    permissionRequester: PermissionRequester,
  ) {
    val runtime = runtimeRef.value ?: return
    runtime.camera.attachLifecycleOwner(owner)
    runtime.camera.attachPermissionRequester(permissionRequester)
    runtime.sms.attachPermissionRequester(permissionRequester)
    this.permissionRequester = permissionRequester
  }

  /**
   * Starts runtime on foreground entry only after onboarding has completed.
   */
  fun setForeground(value: Boolean) {
    // The ViewModel survives configuration recreation. Ignore the replacement
    // Activity's duplicate true edge so it cannot restart gateway work.
    if (foreground == value) return
    foreground = value
    if (
      shouldStartRuntimeOnForeground(
        foreground = value,
        onboardingCompleted = prefs.onboardingCompleted.value,
      )
    ) {
      queueRuntimeStartup()
    }
    runtimeRef.value?.setForeground(value)
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

  /** Clears setup credentials without starting the runtime just to discard first-run pairing auth. */
  private suspend fun resetGatewaySetupAuth(stableId: String): Boolean {
    val reset = nodeApp.resetGatewaySetupAuth(stableId)
    nodeApp.peekRuntime()?.let { runtimeRef.value = it }
    return reset
  }

  internal fun saveGatewayConfigAndConnect(plan: GatewayConnectPlan) {
    val operation = gatewayConfigOperationSeq.incrementAndGet()
    // Gateway pairing touches encrypted prefs, identity files, and sockets; keep
    // the whole sequence off the Compose thread so retries cannot trigger ANRs.
    viewModelScope.launch(Dispatchers.Default) {
      gatewayConfigOperationMutex.withLock {
        if (operation != gatewayConfigOperationSeq.get()) return@withLock
        val config = plan.config
        val endpoint = GatewayEndpoint.manual(host = config.host, port = config.port)
        val targetAlreadyPaired =
          prefs.gatewayRegistry.entries.value
            .any { it.stableId == endpoint.stableId }
        val blankCredentials = config.token.isEmpty() && config.bootstrapToken.isEmpty() && config.password.isEmpty()
        val preservesPairedTarget =
          targetAlreadyPaired && blankCredentials && plan.savedAuthAction == GatewaySavedAuthAction.REPLACE_ENDPOINT
        val replacesSavedAuth = plan.savedAuthAction != GatewaySavedAuthAction.PRESERVE && !preservesPairedTarget
        if (replacesSavedAuth && !resetGatewaySetupAuth(endpoint.stableId)) return@launch
        if (operation != gatewayConfigOperationSeq.get()) return@launch
        prefs.setManualEnabled(true)
        prefs.setManualHost(config.host)
        prefs.setManualPort(config.port)
        prefs.setManualTls(config.tls)

        // A blank same-endpoint save means "keep access". Secrets remain runtime-owned,
        // including password-only setups that Compose deliberately cannot read back.
        if (replacesSavedAuth) {
          prefs.saveGatewayCredentials(
            stableId = endpoint.stableId,
            token = config.token,
            bootstrapToken = config.bootstrapToken,
            password = config.password,
          )
        }

        prefs.gatewayRegistry.upsert(
          GatewayRegistryEntry(
            stableId = endpoint.stableId,
            kind = GatewayRegistryEntryKind.MANUAL,
            name = endpoint.name,
            host = config.host,
            port = config.port,
            tls = config.tls,
          ),
        )

        val runtime = ensureRuntime()
        if (replacesSavedAuth) {
          runtime.connectSwitchingGateway(
            endpoint,
            NodeRuntime.GatewayConnectAuth(
              token = config.token.ifEmpty { null },
              bootstrapToken = config.bootstrapToken.ifEmpty { null },
              password = config.password.ifEmpty { null },
            ),
          )
        } else {
          runtime.connectSwitchingGateway(endpoint)
        }
      }
    }
  }

  /** Per-gateway proxy credential headers; values are secrets and must never be logged. */
  fun gatewayCustomHeaders(stableId: String): Map<String, String> = prefs.loadGatewayCustomHeaders(stableId)

  fun setGatewayCustomHeaders(
    stableId: String,
    headers: Map<String, String>,
  ) {
    prefs.saveGatewayCustomHeaders(stableId, headers)
  }

  /** Marks onboarding complete and starts the runtime before UI observes connected-state flows. */
  fun setOnboardingCompleted(value: Boolean) {
    if (value) {
      ensureRuntime()
    }
    prefs.setOnboardingCompleted(value)
  }

  /** Re-enters gateway setup after disconnecting and clearing one-time setup credentials. */
  fun pairNewGateway() {
    val operation = gatewayConfigOperationSeq.incrementAndGet()
    viewModelScope.launch(Dispatchers.Default) {
      gatewayConfigOperationMutex.withLock {
        if (operation != gatewayConfigOperationSeq.get()) return@withLock
        nodeApp.peekRuntime()?.also { runtime ->
          runtimeRef.value = runtime
          runtime.prepareForGatewaySetup()
        }
        // Pairing another gateway no longer forgets existing gateways; per-gateway
        // credentials and proxy headers are removed only by forgetGateway.
        prefs.setOnboardingCompleted(false)
        _startOnboardingAtGatewaySetup.value = true
      }
    }
  }

  /** Acknowledges the one-shot request that opens onboarding at the gateway setup step. */
  fun clearGatewaySetupStartRequest() {
    _startOnboardingAtGatewaySetup.value = false
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.setCanvasDebugStatusEnabled(value)
  }

  fun setInstalledAppsSharingEnabled(value: Boolean) {
    ensureRuntime().setInstalledAppsSharingEnabled(value)
  }

  fun setNotificationForwardingEnabled(value: Boolean) {
    ensureRuntime().setNotificationForwardingEnabled(value)
  }

  fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    ensureRuntime().setNotificationForwardingMode(mode)
  }

  fun setNotificationForwardingPackagesCsv(csv: String) {
    val packages =
      csv
        .split(',')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
    ensureRuntime().setNotificationForwardingPackages(packages)
  }

  fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean = ensureRuntime().setNotificationForwardingQuietHours(enabled = enabled, start = start, end = end)

  fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    ensureRuntime().setNotificationForwardingMaxEventsPerMinute(value)
  }

  fun setNotificationForwardingSessionKey(value: String?) {
    ensureRuntime().setNotificationForwardingSessionKey(value)
  }

  fun setVoiceScreenActive(active: Boolean) {
    ensureRuntime().setVoiceScreenActive(active)
  }

  /** Routes assistant intents into chat, either as a draft or queued auto-send prompt. */
  fun handleAssistantLaunch(request: AssistantLaunchRequest) {
    _requestedHomeDestination.value = HomeDestination.Chat
    if (request.autoSend) {
      _pendingAssistantAutoSend.value = request.prompt
      _chatDraft.value = null
      return
    }
    _pendingAssistantAutoSend.value = null
    _chatDraft.value = request.prompt?.let { ChatDraft(text = it, placement = ChatDraftPlacement.Replace) }
  }

  fun clearRequestedHomeDestination() {
    _requestedHomeDestination.value = null
  }

  fun requestHomeDestination(destination: HomeDestination) {
    _requestedHomeDestination.value = destination
  }

  fun clearChatDraft() {
    _chatDraft.value = null
  }

  fun setChatReplyDraft(value: String) {
    _pendingAssistantAutoSend.value = null
    _chatDraft.value = ChatDraft(text = value, placement = ChatDraftPlacement.BeforeExisting)
  }

  /** Claims an assistant prompt before sending so Compose effect restarts cannot dispatch it twice. */
  fun dispatchPendingAssistantAutoSend(
    pendingPrompt: String,
    thinking: String,
  ) {
    val prompt = pendingPrompt.trim().ifEmpty { return }
    if (!chatHealthOk.value || pendingRunCount.value > 0) return
    if (!_assistantAutoSendInFlight.compareAndSet(false, true)) return
    if (_pendingAssistantAutoSend.value != pendingPrompt) {
      _assistantAutoSendInFlight.value = false
      return
    }
    viewModelScope.launch {
      try {
        sendChatAwaitAcceptance(
          message = prompt,
          thinking = thinking,
          attachments = emptyList(),
        )
        // A definitive rejection is surfaced by chatError; it must not strand the
        // one-shot assistant prompt or overwrite text typed into the composer.
        _pendingAssistantAutoSend.compareAndSet(pendingPrompt, null)
      } finally {
        // Observable release wakes a newer prompt queued while this send was in flight.
        _assistantAutoSendInFlight.value = false
      }
    }
  }

  fun setMicEnabled(enabled: Boolean) {
    ensureRuntime().setMicEnabled(enabled)
  }

  fun cancelMicCapture() {
    ensureRuntime().cancelMicCapture()
  }

  fun setTalkModeEnabled(enabled: Boolean) {
    ensureRuntime().setTalkModeEnabled(enabled)
  }

  suspend fun requestVoiceNotePermission(): Boolean {
    val requester = permissionRequester ?: return false
    return try {
      requester.requestIfMissing(listOf(Manifest.permission.RECORD_AUDIO))[Manifest.permission.RECORD_AUDIO] == true
    } catch (error: CancellationException) {
      throw error
    } catch (_: Throwable) {
      false
    }
  }

  internal fun tryAcquireVoiceNoteMic(): Boolean = runtimeRef.value?.tryAcquireVoiceNoteMic() == true

  internal fun releaseVoiceNoteMic() {
    runtimeRef.value?.releaseVoiceNoteMic()
  }

  fun setSpeakerEnabled(enabled: Boolean) {
    ensureRuntime().setSpeakerEnabled(enabled)
  }

  fun setAppearanceThemeMode(mode: AppearanceThemeMode) {
    prefs.setAppearanceThemeMode(mode)
  }

  fun refreshGatewayConnection() {
    viewModelScope.launch(Dispatchers.Default) {
      ensureRuntime().refreshGatewayConnection()
    }
  }

  fun startGatewayDiscovery() {
    queueRuntimeStartup()
  }

  fun connect(endpoint: GatewayEndpoint) {
    viewModelScope.launch(Dispatchers.Default) {
      ensureRuntime().connectSwitchingGateway(endpoint)
    }
  }

  fun connectInBackground(endpoint: GatewayEndpoint) {
    viewModelScope.launch(Dispatchers.Default) {
      ensureRuntime().connectSwitchingGateway(endpoint)
    }
  }

  fun connect(
    endpoint: GatewayEndpoint,
    token: String?,
    bootstrapToken: String?,
    password: String?,
  ) {
    viewModelScope.launch(Dispatchers.Default) {
      ensureRuntime().connectSwitchingGateway(
        endpoint,
        NodeRuntime.GatewayConnectAuth(
          token = token,
          bootstrapToken = bootstrapToken,
          password = password,
        ),
      )
    }
  }

  fun connectManual() {
    ensureRuntime().connectManual()
  }

  fun switchToGateway(stableId: String) {
    val operation = gatewayConfigOperationSeq.incrementAndGet()
    viewModelScope.launch(Dispatchers.Default) {
      gatewayConfigOperationMutex.withLock {
        if (operation == gatewayConfigOperationSeq.get()) {
          ensureRuntime().switchToGateway(stableId)
        }
      }
    }
  }

  fun forgetGateway(stableId: String) {
    val operation = gatewayConfigOperationSeq.incrementAndGet()
    viewModelScope.launch(Dispatchers.Default) {
      gatewayConfigOperationMutex.withLock {
        if (operation == gatewayConfigOperationSeq.get()) {
          ensureRuntime().forgetGateway(stableId)
        }
      }
    }
  }

  fun disconnect() {
    val operation = gatewayConfigOperationSeq.incrementAndGet()
    viewModelScope.launch(Dispatchers.Default) {
      gatewayConfigOperationMutex.withLock {
        if (operation == gatewayConfigOperationSeq.get()) {
          runtimeRef.value?.disconnect()
        }
      }
    }
  }

  fun acceptGatewayTrustPrompt() {
    runtimeRef.value?.acceptGatewayTrustPrompt()
  }

  fun declineGatewayTrustPrompt() {
    runtimeRef.value?.declineGatewayTrustPrompt()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    ensureRuntime().handleCanvasA2UIActionFromWebView(payloadJson)
  }

  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean = ensureRuntime().isTrustedCanvasActionUrl(rawUrl)

  fun requestCanvasRehydrate(source: String = "screen_tab") {
    ensureRuntime().requestCanvasRehydrate(source = source, force = true)
  }

  fun refreshHomeCanvasOverviewIfConnected() {
    ensureRuntime().refreshHomeCanvasOverviewIfConnected()
  }

  fun refreshModelCatalog() {
    ensureRuntime().refreshModelCatalog()
  }

  fun refreshTalkSetupReadiness() {
    ensureRuntime().refreshTalkSetupReadiness()
  }

  fun refreshAgents() {
    ensureRuntime().refreshAgents()
  }

  fun refreshCronJobs() {
    ensureRuntime().refreshCronJobs()
  }

  fun loadCronJobDetail(id: String) {
    ensureRuntime().loadCronJobDetail(id)
  }

  fun clearCronJobDetail() {
    ensureRuntime().clearCronJobDetail()
  }

  fun refreshUsage() {
    ensureRuntime().refreshUsage()
  }

  fun refreshSkills() {
    ensureRuntime().refreshSkills()
  }

  fun refreshSkillWorkshopProposals(agentId: String? = null) {
    ensureRuntime().refreshSkillWorkshopProposals(agentId = agentId)
  }

  fun resetSkillWorkshopAgentScope(agentId: String? = null) {
    ensureRuntime().resetSkillWorkshopAgentScope(agentId = agentId)
  }

  fun inspectSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    ensureRuntime().inspectSkillWorkshopProposal(proposalId = proposalId, agentId = agentId)
  }

  fun applySkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    ensureRuntime().applySkillWorkshopProposal(proposalId = proposalId, agentId = agentId)
  }

  fun rejectSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    ensureRuntime().rejectSkillWorkshopProposal(proposalId = proposalId, agentId = agentId)
  }

  fun quarantineSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    ensureRuntime().quarantineSkillWorkshopProposal(proposalId = proposalId, agentId = agentId)
  }

  fun clearSkillWorkshopMessage() {
    ensureRuntime().clearSkillWorkshopMessage()
  }

  fun refreshNodesDevices() {
    ensureRuntime().refreshNodesDevices()
  }

  fun refreshExecApprovals() {
    ensureRuntime().refreshExecApprovals()
  }

  fun resolveExecApproval(
    id: String,
    decision: String,
  ) {
    ensureRuntime().resolveExecApproval(id = id, decision = decision)
  }

  fun refreshChannels() {
    ensureRuntime().refreshChannels()
  }

  fun refreshDreaming() {
    ensureRuntime().refreshDreaming()
  }

  fun refreshHealthLogs() {
    ensureRuntime().refreshHealthLogs()
  }

  fun loadChat(sessionKey: String) {
    ensureRuntime().loadChat(sessionKey)
  }

  fun refreshChat() {
    ensureRuntime().refreshChat()
  }

  fun refreshChatSessions(
    limit: Int? = null,
    archived: Boolean = false,
  ) {
    ensureRuntime().refreshChatSessions(limit = limit, archived = archived)
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
    ensureRuntime().patchChatSession(
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

  suspend fun deleteChatSession(key: String) {
    ensureRuntime().deleteChatSession(key)
  }

  /** Remembers a custom session group locally so it renders as an empty section. */
  fun addChatSessionGroup(name: String) {
    val trimmed = name.trim()
    if (trimmed.isEmpty()) return
    prefs.setSessionCustomGroups(prefs.sessionCustomGroups.value + trimmed)
  }

  suspend fun renameChatSessionGroup(
    from: String,
    to: String,
  ) {
    val stored = prefs.sessionCustomGroups.value
    // Web semantics: replace a stored name in place, otherwise remember the new name.
    prefs.setSessionCustomGroups(if (from in stored) stored.map { if (it == from) to else it } else stored + to)
    ensureRuntime().renameChatSessionGroup(from = from, to = to)
  }

  suspend fun deleteChatSessionGroup(group: String) {
    prefs.setSessionCustomGroups(prefs.sessionCustomGroups.value.filterNot { it == group })
    ensureRuntime().dissolveChatSessionGroup(group)
  }

  suspend fun forkChatSession(parentKey: String): String? = ensureRuntime().forkChatSession(parentKey)

  suspend fun listWorkspaceFiles(
    path: String?,
    offset: Int? = null,
  ): GatewayWorkspaceListing = ensureRuntime().listWorkspaceFiles(path = path, offset = offset)

  suspend fun fetchWorkspaceFile(path: String): GatewayWorkspaceFile = ensureRuntime().fetchWorkspaceFile(path)

  fun setChatThinkingLevel(level: String) {
    ensureRuntime().setChatThinkingLevel(level)
  }

  fun setChatSessionModel(
    sessionKey: String,
    modelRef: String?,
  ) {
    ensureRuntime().setChatSessionModel(sessionKey = sessionKey, modelRef = modelRef)
  }

  fun toggleModelFavorite(ref: String) {
    prefs.toggleModelFavorite(ref)
  }

  fun toggleChatMessageSpeech(
    messageId: String,
    text: String,
  ) {
    ensureRuntime().toggleMessageSpeech(messageId = messageId, text = text)
  }

  fun stopChatMessageSpeech() {
    runtimeRef.value?.stopMessageSpeech()
  }

  fun switchChatSession(sessionKey: String) {
    ensureRuntime().switchChatSession(sessionKey)
  }

  fun selectChatAgent(agentId: String) {
    ensureRuntime().selectChatAgent(agentId)
  }

  suspend fun fetchChatSessionList(
    search: String?,
    archived: Boolean,
  ): List<ChatSessionEntry> = ensureRuntime().fetchChatSessionList(search = search, archived = archived)

  fun abortChat() {
    ensureRuntime().abortChat()
  }

  fun startNewChat(worktree: Boolean = false) {
    ensureRuntime().startNewChat(worktree = worktree)
  }

  fun refreshChatCommands() {
    ensureRuntime().refreshChatCommands()
  }

  fun retryChatOutboxCommand(id: String) {
    ensureRuntime().retryChatOutboxCommand(id)
  }

  fun deleteChatOutboxCommand(id: String) {
    ensureRuntime().deleteChatOutboxCommand(id)
  }

  fun sendChat(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ) {
    ensureRuntime().sendChat(message = message, thinking = thinking, attachments = attachments)
  }

  suspend fun sendChatAwaitAcceptance(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean =
    ensureRuntime().sendChatAwaitAcceptance(
      message = message,
      thinking = thinking,
      attachments = attachments,
    )
}
