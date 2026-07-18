package ai.openclaw.app

import ai.openclaw.app.chat.BackgroundTask
import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatPlanStep
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatThinkingLevelSelection
import ai.openclaw.app.chat.ChatWidgetResource
import ai.openclaw.app.chat.GatewayDefaultAgentOwner
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.chat.defaultChatThinkingLevelSelection
import ai.openclaw.app.chat.resolveChatComposerOwner
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayUpdateAvailableSummary
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.node.SmsManager
import ai.openclaw.app.ui.GatewayConnectPlan
import ai.openclaw.app.ui.GatewaySavedAuthAction
import ai.openclaw.app.ui.SettingsRoute
import ai.openclaw.app.ui.chat.ChatComposerSendStartResult
import ai.openclaw.app.ui.chat.ChatComposerStateStore
import ai.openclaw.app.ui.chat.PendingAttachment
import ai.openclaw.app.ui.chat.chatComposerTextDraftsFromSnapshot
import ai.openclaw.app.ui.chat.matchesSession
import ai.openclaw.app.ui.chat.shouldMigrateComposerDraft
import ai.openclaw.app.ui.chat.toOutgoingAttachment
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceWakePreferences
import android.Manifest
import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

enum class ChatDraftPlacement {
  Replace,
  BeforeExisting,
}

internal data class ChatDraft(
  val text: String,
  val placement: ChatDraftPlacement,
  val owner: ChatComposerOwner? = null,
)

internal fun claimChatDraftForOwner(
  draft: ChatDraft,
  owner: ChatComposerOwner,
  mainSessionKey: String,
): ChatDraft? {
  val capturedOwner = draft.owner ?: return draft
  if (capturedOwner == owner) return draft
  if (!shouldMigrateComposerDraft(capturedOwner, owner, mainSessionKey)) return null
  return draft.copy(owner = owner)
}

internal data class PendingAssistantAutoSend(
  val prompt: String,
  val owner: ChatComposerOwner,
  val id: String = UUID.randomUUID().toString(),
)

private data class AssistantAutoSendOperation(
  var owner: ChatComposerOwner,
  val pendingId: String,
  val composerSendId: String,
)

internal fun clearCompletedAssistantAutoSend(
  current: PendingAssistantAutoSend?,
  completedId: String,
): PendingAssistantAutoSend? = current?.takeUnless { it.id == completedId }

internal fun retainRefusedAssistantPrompt(
  prompt: String,
  existing: String,
): String =
  when {
    existing.isBlank() -> prompt
    prompt.isBlank() || existing == prompt -> existing
    else -> "$prompt\n\n$existing"
  }

data class ChatShareDraft(
  val id: Long,
  val text: String?,
  val imageUris: List<Uri>,
  val droppedImageCount: Int,
)

internal const val MAX_PENDING_CHAT_SHARES = 16
private const val CHAT_COMPOSER_DRAFTS_STATE_KEY = "chat-composer-text-drafts"

/** Bounded process-local queue whose stable head survives Activity recreation with the ViewModel. */
internal class ChatShareDraftQueue(
  private val capacity: Int = MAX_PENDING_CHAT_SHARES,
) {
  private val lock = Any()
  private val drafts = ArrayDeque<ChatShareDraft>()
  private val ownersById = mutableMapOf<Long, ChatComposerOwner>()
  private val headLease = Mutex()
  private val _head = MutableStateFlow<ChatShareDraft?>(null)
  val head: StateFlow<ChatShareDraft?> = _head.asStateFlow()
  private val _queued = MutableStateFlow<List<ChatShareDraft>>(emptyList())
  val queued: StateFlow<List<ChatShareDraft>> = _queued.asStateFlow()
  private val _ownerRevision = MutableStateFlow(0L)
  val ownerRevision: StateFlow<Long> = _ownerRevision.asStateFlow()

  init {
    require(capacity > 0)
  }

  fun enqueue(
    draft: ChatShareDraft,
    owner: ChatComposerOwner,
  ): Boolean =
    synchronized(lock) {
      if (drafts.size >= capacity) return@synchronized false
      drafts.addLast(draft)
      ownersById[draft.id] = owner
      publishQueueLocked()
      true
    }

  /** Only the active loader may advance the queue; stale effects cannot acknowledge a newer head. */
  fun acknowledgeHead(
    id: Long,
    owner: ChatComposerOwner,
  ): Boolean =
    synchronized(lock) {
      val ownedHead = firstForOwnerLocked(owner)
      if (ownedHead?.id != id) return@synchronized false
      drafts.remove(ownedHead)
      ownersById.remove(id)
      publishQueueLocked()
      true
    }

  /** Serializes loaders across overlapping Activity instances while rechecking the stable head. */
  suspend fun withHeadLease(
    id: Long,
    owner: ChatComposerOwner,
    block: suspend () -> Unit,
  ): Boolean =
    headLease.withLock {
      val claimed =
        synchronized(lock) {
          firstForOwnerLocked(owner)?.id == id
        }
      if (!claimed) return@withLock false
      block()
      true
    }

  fun migrateOwner(
    from: ChatComposerOwner,
    to: ChatComposerOwner,
  ) {
    if (from == to) return
    synchronized(lock) {
      var changed = false
      for ((id, owner) in ownersById.toMap()) {
        if (owner == from) {
          ownersById[id] = to
          changed = true
        }
      }
      if (changed) _ownerRevision.value += 1
    }
  }

  fun clear() {
    synchronized(lock) {
      drafts.clear()
      ownersById.clear()
      publishQueueLocked()
    }
  }

  suspend fun removeOwners(matches: (ChatComposerOwner) -> Boolean) {
    headLease.withLock {
      synchronized(lock) {
        val removedIds = ownersById.filterValues(matches).keys
        if (removedIds.isEmpty()) return@synchronized
        drafts.removeAll { it.id in removedIds }
        removedIds.forEach(ownersById::remove)
        publishQueueLocked()
      }
    }
  }

  fun ownerOf(id: Long): ChatComposerOwner? = synchronized(lock) { ownersById[id] }

  internal fun size(): Int = synchronized(lock) { drafts.size }

  private fun firstForOwnerLocked(owner: ChatComposerOwner): ChatShareDraft? = drafts.firstOrNull { draft -> ownersById[draft.id] == owner }

  private fun publishQueueLocked() {
    _head.value = drafts.firstOrNull()
    _queued.value = drafts.toList()
  }
}

internal fun shouldStartRuntimeOnForeground(
  foreground: Boolean,
  onboardingCompleted: Boolean,
): Boolean = foreground && onboardingCompleted

internal class CronEditorDraftMemory {
  private var retained: Pair<String, CronEditorDraftState>? = null

  fun get(jobId: String): CronEditorDraftState? = retained?.takeIf { it.first == jobId }?.second

  fun set(
    jobId: String,
    state: CronEditorDraftState?,
  ) {
    if (state == null) {
      clear(jobId)
    } else {
      retained = jobId to state
    }
  }

  fun clear(jobId: String) {
    if (retained?.first == jobId) retained = null
  }
}

/**
 * UI-facing bridge that exposes NodeRuntime and preference state as Compose-friendly StateFlows.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModel private constructor(
  app: Application,
  private val prefs: SecurePrefs,
  savedStateHandle: SavedStateHandle,
) : AndroidViewModel(app) {
  constructor(
    app: Application,
    savedStateHandle: SavedStateHandle,
  ) : this(app, (app as NodeApp).prefs, savedStateHandle)

  internal constructor(
    app: NodeApp,
    prefs: SecurePrefs,
    savedStateHandle: SavedStateHandle,
  ) : this(app as Application, prefs, savedStateHandle)

  private val nodeApp = app as NodeApp
  private val runtimeRef = MutableStateFlow<NodeRuntime?>(null)
  private val gatewayConfigOperationSeq = AtomicLong()
  private val gatewayConfigOperationMutex = Mutex()

  // Multiple MainActivity instances can overlap across sender tasks; the process owns one queue.
  private val chatShareDraftSeq = nodeApp.chatShareDraftSeq
  private val chatShareDraftQueue = nodeApp.chatShareDraftQueue

  // One bounded heap-only slot follows the ViewModel across Activity recreation.
  // Detail disposal clears it; process death drops it with the ViewModel.
  internal val cronEditorDraftMemory = CronEditorDraftMemory()

  @Volatile private var permissionRequester: PermissionRequester? = null

  @Volatile private var foreground = false

  @Volatile private var runtimeStartupQueued = false
  private val initialIntentGate = MainActivityInitialIntentGate()

  private val _requestedHomeDestination = MutableStateFlow<HomeDestination?>(null)
  val requestedHomeDestination: StateFlow<HomeDestination?> = _requestedHomeDestination
  private val requestedSettingsRouteState = MutableStateFlow<SettingsRoute?>(null)
  internal val requestedSettingsRoute: StateFlow<SettingsRoute?> get() = requestedSettingsRouteState
  private val _startOnboardingAtGatewaySetup = MutableStateFlow(false)
  val startOnboardingAtGatewaySetup: StateFlow<Boolean> = _startOnboardingAtGatewaySetup
  private val chatDraftState = MutableStateFlow<ChatDraft?>(null)
  internal val chatDraft: StateFlow<ChatDraft?> = chatDraftState
  private val chatDraftLock = Any()
  private var attachedComposerRuntime: NodeRuntime? = null
  private var removeChatSessionDeletionListener: (() -> Unit)? = null

  // SavedStateHandle preserves a bounded set of complete owner-scoped drafts through process
  // recreation. Durable admission clears only the accepted snapshot, so later edits survive.
  internal val chatComposerState =
    ChatComposerStateStore(
      initialDrafts = chatComposerTextDraftsFromSnapshot(savedStateHandle[CHAT_COMPOSER_DRAFTS_STATE_KEY]),
      onDraftSnapshotChanged = { snapshot -> savedStateHandle[CHAT_COMPOSER_DRAFTS_STATE_KEY] = snapshot },
    )
  private val assistantAutoSendLock = Any()

  init {
    val recoveredChatComposerSends = chatComposerState.recoveredSends()
    if (recoveredChatComposerSends.isNotEmpty()) {
      // A pending checkpoint is hidden until the durable outbox gives a definitive answer.
      // Database errors leave it parked instead of exposing text that may already be sending.
      viewModelScope.launch {
        val runtime = runCatching { ensureRuntime() }.getOrNull() ?: return@launch
        recoveredChatComposerSends.forEach { pending ->
          val admitted =
            runCatching { runtime.wasChatOutboxCommandAdmitted(pending.commandId) }.getOrNull() ?: return@forEach
          chatComposerState.resolveRecoveredSend(
            commandId = pending.commandId,
            fallbackOwner = pending.owner,
            admitted = admitted,
          )
        }
      }
    }
  }

  val chatShareDraft: StateFlow<ChatShareDraft?> = chatShareDraftQueue.head
  internal val chatShareDrafts: StateFlow<List<ChatShareDraft>> = chatShareDraftQueue.queued
  internal val chatShareDraftOwnerRevision: StateFlow<Long> = chatShareDraftQueue.ownerRevision
  private val pendingAssistantAutoSendMutable = MutableStateFlow<PendingAssistantAutoSend?>(null)
  internal val pendingAssistantAutoSend: StateFlow<PendingAssistantAutoSend?> = pendingAssistantAutoSendMutable
  private val _assistantAutoSendInFlight = MutableStateFlow(false)
  val assistantAutoSendInFlight: StateFlow<Boolean> = _assistantAutoSendInFlight
  private var assistantAutoSendOperation: AssistantAutoSendOperation? = null

  /**
   * Lazily starts NodeRuntime and preserves the current foreground bit across startup.
   */
  private fun ensureRuntime(): NodeRuntime {
    runtimeRef.value?.let { return it }
    val runtime = nodeApp.ensureRuntime()
    runtime.setForeground(foreground)
    attachComposerRuntime(runtime)
    return runtime
  }

  private fun attachComposerRuntime(runtime: NodeRuntime) {
    if (attachedComposerRuntime === runtime) {
      runtimeRef.value = runtime
      return
    }
    removeChatSessionDeletionListener?.invoke()
    attachedComposerRuntime = runtime
    removeChatSessionDeletionListener =
      runtime.addChatSessionDeletionListener { deletion ->
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
          deletion.gatewayId?.let { gatewayId ->
            clearChatComposerSession(
              gatewayStableId = gatewayId,
              agentId = deletion.agentId,
              sessionKey = deletion.sessionKey,
              mainSessionKey = deletion.mainSessionKey,
            )
          }
        }
      }
    runtimeRef.value = runtime
  }

  override fun onCleared() {
    removeChatSessionDeletionListener?.invoke()
    removeChatSessionDeletionListener = null
    attachedComposerRuntime = null
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
      runtime.setVoiceWakeEnabled(scene == AndroidScreenshotScene.VoiceWake)
      _requestedHomeDestination.value = scene.homeDestination
      requestedSettingsRouteState.value = scene.settingsRoute
      return
    }
    prefs.setOnboardingCompleted(true)
    prefs.setAppearanceThemeMode(AppearanceThemeMode.Dark)
    prefs.setDisplayName("Pixel")
    prefs.setSpeakerEnabled(true)
    prefs.setVoiceWakeEnabled(scene == AndroidScreenshotScene.VoiceWake)
    prefs.setVoiceWakeWords(VoiceWakePreferences.defaultTriggerWords)
    val runtime = nodeApp.ensureScreenshotFixtureRuntime()
    runtime.setForeground(foreground)
    attachComposerRuntime(runtime)
    _requestedHomeDestination.value = scene.homeDestination
    requestedSettingsRouteState.value = scene.settingsRoute
  }

  /** Acknowledges the one-shot settings-route request that accompanies a home destination. */
  fun clearRequestedSettingsRoute() {
    requestedSettingsRouteState.value = null
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

  internal fun resumeNodeServiceForConnection() {
    if (!prefs.onboardingCompleted.value) return
    NodeForegroundService.resume(context = nodeApp, startNow = true)
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
  val canvasPresentationState: StateFlow<CanvasController.PresentationState> =
    runtimeState(initial = CanvasController.PresentationState.Unmounted) { it.canvas.presentationState }
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
  val providerModelCatalog: StateFlow<List<GatewayModelSummary>> = runtimeState(initial = emptyList()) { it.providerModelCatalog }
  val providerModelCatalogRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.providerModelCatalogRefreshing }
  val providerModelCatalogErrorText: StateFlow<String?> = runtimeState(initial = null) { it.providerModelCatalogErrorText }
  val modelAuthProviders: StateFlow<List<GatewayModelProviderSummary>> = runtimeState(initial = emptyList()) { it.modelAuthProviders }
  val modelCatalogRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.modelCatalogRefreshing }
  val modelCatalogErrorText: StateFlow<String?> = runtimeState(initial = null) { it.modelCatalogErrorText }
  val modelFavorites: StateFlow<List<String>> = prefs.modelFavorites
  val modelRecents: StateFlow<List<String>> = prefs.modelRecents
  val sessionCustomGroups: StateFlow<List<String>> = prefs.sessionCustomGroups
  val talkSetupReadiness: StateFlow<GatewayTalkSetupReadiness> =
    runtimeState(initial = GatewayTalkSetupReadiness.unverified()) { it.talkSetupReadiness }
  val gatewayDefaultAgentId: StateFlow<String?> = runtimeState(initial = null) { it.gatewayDefaultAgentId }
  internal val gatewayComposerDefaultAgentOwner: StateFlow<GatewayDefaultAgentOwner?> =
    runtimeState(initial = null) { it.gatewayComposerDefaultAgentOwner }
  val gatewayAgents: StateFlow<List<GatewayAgentSummary>> = runtimeState(initial = emptyList()) { it.gatewayAgents }
  val cronStatus: StateFlow<GatewayCronStatus> = runtimeState(initial = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)) { it.cronStatus }
  val cronJobs: StateFlow<List<GatewayCronJobSummary>> = runtimeState(initial = emptyList()) { it.cronJobs }
  val cronRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.cronRefreshing }
  val cronErrorText: StateFlow<String?> = runtimeState(initial = null) { it.cronErrorText }
  val cronJobDetailState: StateFlow<GatewayCronJobDetailState> = runtimeState(initial = GatewayCronJobDetailState.Idle) { it.cronJobDetailState }
  val cronRunHistoryState: StateFlow<GatewayCronRunHistoryState> = runtimeState(initial = GatewayCronRunHistoryState.Idle) { it.cronRunHistoryState }
  val cronActionState: StateFlow<GatewayCronActionState> = runtimeState(initial = GatewayCronActionState.Idle) { it.cronActionState }
  val pendingCronRunJobIds: StateFlow<Set<String>> = runtimeState(initial = emptySet()) { it.pendingCronRunJobIds }
  val usageSummary: StateFlow<GatewayUsageSummary> = runtimeState(initial = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())) { it.usageSummary }
  val usageRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.usageRefreshing }
  val usageErrorText: StateFlow<String?> = runtimeState(initial = null) { it.usageErrorText }
  val skillsSummary: StateFlow<GatewaySkillsSummary> = runtimeState(initial = GatewaySkillsSummary(skills = emptyList())) { it.skillsSummary }
  val skillsRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.skillsRefreshing }
  val skillsErrorText: StateFlow<String?> = runtimeState(initial = null) { it.skillsErrorText }
  val clawHubSkillMethodsAvailable: StateFlow<Boolean> =
    runtimeState(initial = false) { it.clawHubSkillMethodsAvailable }
  val skillMutationKeys: StateFlow<Set<String>> = runtimeState(initial = emptySet()) { it.skillMutationKeys }
  val clawHubSkillSearchState: StateFlow<GatewayClawHubSkillSearchState> =
    runtimeState(initial = GatewayClawHubSkillSearchState()) { it.clawHubSkillSearchState }
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
  val voiceWakeEnabled: StateFlow<Boolean> = prefs.voiceWakeEnabled
  val voiceWakeWords: StateFlow<List<String>> = prefs.voiceWakeWords
  val voiceWakeAvailable: StateFlow<Boolean> = runtimeState(initial = false) { it.voiceWakeAvailable }
  val voiceWakeIsListening: StateFlow<Boolean> = runtimeState(initial = false) { it.voiceWakeIsListening }
  val voiceWakeStatusText: StateFlow<String> = runtimeState(initial = "Off") { it.voiceWakeStatusText }
  val voiceWakeLastTriggeredCommand: StateFlow<String?> =
    runtimeState(initial = null) { it.voiceWakeLastTriggeredCommand }
  val voiceWakeWordsSaving: StateFlow<Boolean> = runtimeState(initial = false) { it.voiceWakeWordsSaving }
  val voiceWakeWordsNoticeText: StateFlow<String?> = runtimeState(initial = null) { it.voiceWakeWordsNoticeText }
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
  val chatSessionOwnerAgentId: StateFlow<String?> = runtimeState(initial = null) { it.chatSessionOwnerAgentId }
  val chatSessionId: StateFlow<String?> = runtimeState(initial = null) { it.chatSessionId }
  val chatMessages: StateFlow<List<ChatMessage>> = runtimeState(initial = emptyList()) { it.chatMessages }
  val chatHistoryLoading: StateFlow<Boolean> = runtimeState(initial = false) { it.chatHistoryLoading }
  val chatError: StateFlow<String?> = runtimeState(initial = null) { it.chatError }
  val chatHealthOk: StateFlow<Boolean> = runtimeState(initial = false) { it.chatHealthOk }
  val chatThinkingLevel: StateFlow<String> = runtimeState(initial = "off") { it.chatThinkingLevel }
  val chatThinkingLevelSelection: StateFlow<ChatThinkingLevelSelection> =
    runtimeState(initial = defaultChatThinkingLevelSelection) { it.chatThinkingLevelSelection }
  val chatSelectedModelRef: StateFlow<String?> = runtimeState(initial = null) { it.chatSelectedModelRef }
  val chatModelCatalog: StateFlow<List<GatewayModelSummary>> = runtimeState(initial = emptyList()) { it.chatModelCatalog }
  val chatStreamingAssistantText: StateFlow<String?> = runtimeState(initial = null) { it.chatStreamingAssistantText }
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = runtimeState(initial = emptyList()) { it.chatPendingToolCalls }
  val chatQuestions: StateFlow<List<ChatQuestionPrompt>> = runtimeState(initial = emptyList()) { it.chatQuestions }
  val chatPlanSteps: StateFlow<List<ChatPlanStep>> = runtimeState(initial = emptyList()) { it.chatPlanSteps }
  val chatSessions: StateFlow<List<ChatSessionEntry>> = runtimeState(initial = emptyList()) { it.chatSessions }
  val pendingRunCount: StateFlow<Int> = runtimeState(initial = 0) { it.pendingRunCount }
  val chatCommands: StateFlow<List<ChatCommandEntry>> = runtimeState(initial = emptyList<ChatCommandEntry>()) { it.chatCommands }
  val chatOutboxItems: StateFlow<List<ChatOutboxItem>> = runtimeState(initial = emptyList()) { it.chatOutboxItems }
  internal val chatMessageSpeech: StateFlow<MessageSpeechState?> =
    runtimeState(initial = null) { it.messageSpeechState }
  val execApprovals: StateFlow<List<GatewayExecApprovalSummary>> = runtimeState(initial = emptyList()) { it.execApprovals }
  val execApprovalsRefreshing: StateFlow<Boolean> = runtimeState(initial = false) { it.execApprovalsRefreshing }
  val execApprovalsErrorText: StateFlow<String?> = runtimeState(initial = null) { it.execApprovalsErrorText }
  val execApprovalsNotice: StateFlow<GatewayExecApprovalNotice?> = runtimeState(initial = null) { it.execApprovalsNotice }

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
    runtimeRef.value?.setCameraEnabled(value) ?: prefs.setCameraEnabled(value)
  }

  fun setLocationMode(mode: LocationMode) {
    runtimeRef.value?.setLocationMode(mode) ?: prefs.setLocationMode(mode)
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
    nodeApp.peekRuntime()?.let(::attachComposerRuntime)
    if (reset) clearChatComposerGateway(stableId)
    return reset
  }

  /** Auth replacement retires the old gateway identity, including every retained composer owner. */
  internal suspend fun clearChatComposerGateway(stableId: String) {
    val gateway = stableId.trim()
    if (gateway.isEmpty()) return
    clearChatComposerOwners { it.gatewayStableId == gateway }
  }

  internal suspend fun clearChatComposerSession(
    gatewayStableId: String,
    agentId: String,
    sessionKey: String,
    mainSessionKey: String,
  ) {
    val gateway = gatewayStableId.trim()
    val agent = agentId.trim()
    val key = sessionKey.trim()
    if (gateway.isEmpty() || agent.isEmpty() || key.isEmpty()) return
    clearChatComposerOwners { owner ->
      owner.matchesSession(
        gatewayStableId = gateway,
        agentId = agent,
        sessionKey = key,
        mainSessionKey = mainSessionKey,
      )
    }
  }

  private suspend fun clearChatComposerOwners(matches: (ChatComposerOwner) -> Boolean) {
    chatComposerState.removeMediaOwners(matches)
    chatShareDraftQueue.removeOwners(matches)
    synchronized(assistantAutoSendLock) {
      // Read the live operation id while its start/finally paths are excluded so cleanup retains
      // exactly that gate after removing other state owned by the retired identity.
      chatComposerState.removeOwners(matches, assistantAutoSendOperation?.composerSendId)
    }
    pendingAssistantAutoSendMutable.update { pending ->
      pending?.takeIf { !matches(it.owner) }
    }
    synchronized(chatDraftLock) {
      chatDraftState.value = chatDraftState.value?.takeIf { draft -> draft.owner?.let(matches) != true }
    }
    // Repeat after suspending share cleanup. Any callback that raced the first tombstone is
    // serialized with this final token-and-attachment purge before cleanup returns.
    chatComposerState.removeMediaOwners(matches)
  }

  internal fun saveGatewayConfigAndConnect(plan: GatewayConnectPlan) {
    resumeNodeServiceForConnection()
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

  /** Marks onboarding complete and starts the runtime before UI observes connected-state flows. */
  fun setOnboardingCompleted(value: Boolean) {
    if (value) {
      ensureRuntime()
    }
    prefs.setOnboardingCompleted(value)
    if (value) {
      NodeForegroundService.resume(nodeApp, startNow = true)
    }
  }

  /** Re-enters gateway setup after disconnecting and clearing one-time setup credentials. */
  fun pairNewGateway() {
    NodeForegroundService.stop(nodeApp)
    val operation = gatewayConfigOperationSeq.incrementAndGet()
    viewModelScope.launch(Dispatchers.Default) {
      gatewayConfigOperationMutex.withLock {
        if (operation != gatewayConfigOperationSeq.get()) return@withLock
        nodeApp.peekRuntime()?.also { runtime ->
          attachComposerRuntime(runtime)
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

  fun grantInstalledAppsDisclosureConsent() {
    ensureRuntime().grantInstalledAppsDisclosureConsent()
  }

  fun revokeInstalledAppsDisclosureConsent() {
    ensureRuntime().revokeInstalledAppsDisclosureConsent()
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
    chatShareDraftQueue.clear()
    val owner = currentOrProvisionalChatComposerOwner()
    if (request.autoSend) {
      pendingAssistantAutoSendMutable.value = request.prompt?.let { PendingAssistantAutoSend(prompt = it, owner = owner) }
      setChatDraft(null)
      return
    }
    pendingAssistantAutoSendMutable.value = null
    setChatDraft(request.prompt?.let { ChatDraft(text = it, placement = ChatDraftPlacement.Replace, owner = owner) })
  }

  /** Opens shared content as a fresh composer draft; sending still requires an explicit tap. */
  fun handleShareLaunch(request: ShareLaunchRequest): Boolean {
    val owner = currentOrProvisionalChatComposerOwner()
    val accepted =
      chatShareDraftQueue.enqueue(
        ChatShareDraft(
          id = chatShareDraftSeq.incrementAndGet(),
          text = request.text,
          imageUris = request.imageUris,
          droppedImageCount = request.droppedImageCount,
        ),
        owner,
      )
    if (!accepted) return false
    _requestedHomeDestination.value = HomeDestination.Chat
    pendingAssistantAutoSendMutable.value = null
    setChatDraft(null)
    return true
  }

  fun clearRequestedHomeDestination() {
    _requestedHomeDestination.value = null
  }

  fun requestHomeDestination(destination: HomeDestination) {
    _requestedHomeDestination.value = destination
  }

  internal fun consumeChatDraft(
    expected: ChatDraft,
    owner: ChatComposerOwner,
    mainSessionKey: String,
  ): ChatDraft? =
    synchronized(chatDraftLock) {
      val current = chatDraftState.value
      if (current !== expected) return@synchronized null
      val claimed = claimChatDraftForOwner(current, owner, mainSessionKey) ?: return@synchronized null
      chatDraftState.value = null
      claimed
    }

  private fun setChatDraft(value: ChatDraft?) {
    synchronized(chatDraftLock) {
      chatDraftState.value = value
    }
  }

  internal fun acknowledgeChatShareDraft(
    id: Long,
    owner: ChatComposerOwner,
  ): Boolean = chatShareDraftQueue.acknowledgeHead(id, owner)

  internal suspend fun withChatShareDraftLease(
    id: Long,
    owner: ChatComposerOwner,
    block: suspend () -> Unit,
  ): Boolean = chatShareDraftQueue.withHeadLease(id, owner, block)

  internal fun chatShareDraftTargetsOwner(
    id: Long,
    owner: ChatComposerOwner,
    mainSessionKey: String,
  ): Boolean {
    val captured = chatShareDraftQueue.ownerOf(id) ?: return false
    return captured == owner || shouldMigrateComposerDraft(captured, owner, mainSessionKey)
  }

  internal fun chatShareDraftForOwner(
    owner: ChatComposerOwner,
    mainSessionKey: String,
  ): ChatShareDraft? =
    chatShareDraftQueue.queued.value.firstOrNull { draft ->
      chatShareDraftTargetsOwner(draft.id, owner, mainSessionKey)
    }

  internal fun resolveChatShareDraftOwner(
    id: Long?,
    owner: ChatComposerOwner,
    mainSessionKey: String,
  ) {
    if (id == null) return
    val captured = chatShareDraftQueue.ownerOf(id) ?: return
    if (shouldMigrateComposerDraft(captured, owner, mainSessionKey)) {
      chatShareDraftQueue.migrateOwner(captured, owner)
    }
  }

  internal fun setChatReplyDraft(
    value: String,
    owner: ChatComposerOwner,
  ) {
    if (!isCurrentChatComposerOwner(owner)) return
    pendingAssistantAutoSendMutable.value = null
    setChatDraft(ChatDraft(text = value, placement = ChatDraftPlacement.BeforeExisting, owner = owner))
  }

  /** Claims an assistant prompt before sending so Compose effect restarts cannot dispatch it twice. */
  internal fun dispatchPendingAssistantAutoSend(
    pending: PendingAssistantAutoSend,
    thinking: String,
  ) {
    val prompt = pending.prompt.trim().ifEmpty { return }
    if (!chatHealthOk.value || pendingRunCount.value > 0) return
    if (!isCurrentChatComposerOwner(pending.owner)) return
    if (runtimeRef.value?.canSendForOwner(pending.owner) != true) return
    val operation =
      synchronized(assistantAutoSendLock) {
        if (!_assistantAutoSendInFlight.compareAndSet(false, true)) return
        if (pendingAssistantAutoSendMutable.value != pending) {
          _assistantAutoSendInFlight.value = false
          return
        }
        val composerSendId = chatComposerState.tryBeginTrackedSend(pending.owner)
        if (composerSendId == null) {
          _assistantAutoSendInFlight.value = false
          return
        }
        val started =
          AssistantAutoSendOperation(
            owner = pending.owner,
            pendingId = pending.id,
            composerSendId = composerSendId,
          )
        assistantAutoSendOperation = started
        started
      }
    viewModelScope.launch {
      try {
        val accepted =
          sendChatForOwnerAwaitAcceptance(
            owner = pending.owner,
            message = prompt,
            thinking = thinking,
            attachments = emptyList(),
            idempotencyKey = UUID.randomUUID().toString(),
          )
        if (accepted) {
          pendingAssistantAutoSendMutable.update { current ->
            clearCompletedAssistantAutoSend(current, operation.pendingId)
          }
        } else {
          val current = pendingAssistantAutoSendMutable.value
          if (current?.id == operation.pendingId && pendingAssistantAutoSendMutable.compareAndSet(current, null)) {
            // Refusal can mean owner validation changed before admission. Preserve the one-shot
            // prompt as editable text, using the operation owner that alias migration updates.
            val currentDraft = chatComposerState.textDrafts[operation.owner]
            chatComposerState.textDrafts[operation.owner] = retainRefusedAssistantPrompt(current.prompt, currentDraft)
          }
        }
      } finally {
        synchronized(assistantAutoSendLock) {
          if (assistantAutoSendOperation === operation) {
            chatComposerState.finishTrackedSend(operation.composerSendId)
            assistantAutoSendOperation = null
            // Observable releases wake a prompt blocked by this or a manual send admission.
            _assistantAutoSendInFlight.value = false
          }
        }
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

  fun setVoiceWakeEnabled(enabled: Boolean) {
    ensureRuntime().setVoiceWakeEnabled(enabled)
  }

  fun setVoiceWakeWords(values: List<String>) {
    ensureRuntime().setVoiceWakeWords(values)
  }

  fun refreshVoiceWakePermission() {
    ensureRuntime().refreshVoiceWakePermission()
  }

  fun setAppearanceThemeMode(mode: AppearanceThemeMode) {
    prefs.setAppearanceThemeMode(mode)
  }

  fun refreshGatewayConnection() {
    resumeNodeServiceForConnection()
    viewModelScope.launch(Dispatchers.Default) {
      ensureRuntime().refreshGatewayConnection()
    }
  }

  fun startGatewayDiscovery() {
    queueRuntimeStartup()
  }

  fun connect(endpoint: GatewayEndpoint) {
    resumeNodeServiceForConnection()
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
    resumeNodeServiceForConnection()
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
    resumeNodeServiceForConnection()
    ensureRuntime().connectManual()
  }

  fun switchToGateway(stableId: String) {
    resumeNodeServiceForConnection()
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
    NodeForegroundService.stop(nodeApp)
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

  internal suspend fun resolveInlineWidgetResource(
    path: String,
    failedResource: ChatWidgetResource?,
  ) = ensureRuntime().resolveInlineWidgetResource(path, failedResource)

  fun requestCanvasRehydrate(source: String = "screen_tab") {
    ensureRuntime().requestCanvasRehydrate(source = source, force = true)
  }

  fun showCanvas() {
    ensureRuntime().canvas.show()
  }

  fun hideCanvas() {
    runtimeRef.value?.canvas?.hide()
  }

  fun refreshHomeCanvasOverviewIfConnected() {
    ensureRuntime().refreshHomeCanvasOverviewIfConnected()
  }

  fun refreshModelCatalog() {
    ensureRuntime().refreshModelCatalog()
  }

  fun refreshProviderModels() {
    ensureRuntime().refreshProviderModels()
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

  fun refreshCronRunHistory(id: String) {
    ensureRuntime().refreshCronRunHistory(id)
  }

  fun clearCronJobDetail() {
    ensureRuntime().clearCronJobDetail()
  }

  fun dismissCronActionNotice(id: String) {
    ensureRuntime().dismissCronActionNotice(id)
  }

  fun runCronJob(id: String) {
    ensureRuntime().runCronJob(id)
  }

  fun setCronJobEnabled(
    id: String,
    enabled: Boolean,
  ) {
    ensureRuntime().setCronJobEnabled(id = id, enabled = enabled)
  }

  fun updateCronJob(
    original: GatewayCronJobDetail,
    edit: GatewayCronJobEdit,
  ) {
    ensureRuntime().updateCronJob(original = original, edit = edit)
  }

  fun deleteCronJob(id: String) {
    ensureRuntime().deleteCronJob(id)
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

  fun setSkillEnabled(
    skillKey: String,
    enabled: Boolean,
  ) {
    ensureRuntime().setSkillEnabled(skillKey, enabled)
  }

  fun searchClawHubSkills(query: String) {
    ensureRuntime().searchClawHubSkills(query)
  }

  fun reviewClawHubSkillInstall(skill: GatewayClawHubSkillSummary) {
    ensureRuntime().reviewClawHubSkillInstall(skill)
  }

  fun dismissClawHubSkillInstallReview() {
    ensureRuntime().dismissClawHubSkillInstallReview()
  }

  fun installClawHubSkill(
    slug: String,
    acknowledgeClawHubRisk: Boolean = false,
    version: String? = null,
  ) {
    ensureRuntime().installClawHubSkill(slug, acknowledgeClawHubRisk, version)
  }

  fun clearClawHubSkillMessage() {
    ensureRuntime().clearClawHubSkillMessage()
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

  fun dismissExecApprovalsNotice(expected: GatewayExecApprovalNotice) {
    ensureRuntime().dismissExecApprovalsNotice(expected)
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

  fun loadChat(
    sessionKey: String,
    ownerAgentId: String? = null,
  ) {
    ensureRuntime().loadChat(sessionKey, ownerAgentId)
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
    ownerAgentId: String? = null,
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
      ownerAgentId = ownerAgentId,
      label = label,
      clearLabel = clearLabel,
      category = category,
      clearCategory = clearCategory,
      pinned = pinned,
      archived = archived,
      unread = unread,
    )
  }

  suspend fun deleteChatSession(
    key: String,
    ownerAgentId: String?,
  ) {
    val deleted = ensureRuntime().deleteChatSession(key, ownerAgentId) ?: return
    deleted.gatewayId?.let { gatewayId ->
      clearChatComposerSession(
        gatewayStableId = gatewayId,
        agentId = deleted.agentId,
        sessionKey = deleted.sessionKey,
        mainSessionKey = deleted.mainSessionKey,
      )
    }
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

  suspend fun forkChatSession(
    parentKey: String,
    ownerAgentId: String? = null,
  ): String? = ensureRuntime().forkChatSession(parentKey, ownerAgentId)

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

  fun switchChatSession(
    sessionKey: String,
    ownerAgentId: String? = null,
  ) {
    ensureRuntime().switchChatSession(sessionKey, ownerAgentId)
  }

  /** Reads the authoritative flows at commit time so stale Compose callbacks cannot cross chats. */
  private fun currentChatComposerOwner(): ChatComposerOwner? {
    val runtime = runtimeRef.value ?: return null
    return resolveChatComposerOwner(
      gatewayStableId = activeGatewayStableId.value,
      gatewayDefaultAgentId = runtime.chatSessionOwnerAgentId.value ?: runtime.gatewayDefaultAgentId.value,
      lastVerifiedOwner = runtime.gatewayComposerDefaultAgentOwner.value,
      sessionKey = runtime.chatSessionKey.value,
      mainSessionKey = runtime.mainSessionKey.value,
    )
  }

  /** Captures a share before async runtime startup; later hello/alias resolution may migrate it. */
  private fun currentOrProvisionalChatComposerOwner(): ChatComposerOwner =
    currentChatComposerOwner()
      ?: resolveChatComposerOwner(
        gatewayStableId = activeGatewayStableId.value,
        gatewayDefaultAgentId = chatSessionOwnerAgentId.value ?: gatewayDefaultAgentId.value,
        lastVerifiedOwner = gatewayComposerDefaultAgentOwner.value,
        sessionKey = chatSessionKey.value,
        mainSessionKey = mainSessionKey.value,
      )

  internal fun isCurrentChatComposerOwner(expected: ChatComposerOwner): Boolean =
    (
      currentChatComposerOwner() ?: currentOrProvisionalChatComposerOwner()
    ) == expected

  internal fun resolveChatComposerOwnerAliases(
    to: ChatComposerOwner,
    mainSessionKey: String,
  ) {
    val (composerSources, operationSource) =
      synchronized(assistantAutoSendLock) {
        // The gate and operation owner must move together so finally releases the migrated key.
        val sources = chatComposerState.resolveAliases(to = to, mainSessionKey = mainSessionKey)
        val operationSource =
          assistantAutoSendOperation?.let { operation ->
            operation.owner.takeIf { source -> shouldMigrateComposerDraft(source, to, mainSessionKey) }?.also {
              operation.owner = to
            }
          }
        sources to operationSource
      }
    val pendingAutoSend = pendingAssistantAutoSendMutable.value
    val pendingAutoSendSource =
      pendingAutoSend
        ?.owner
        ?.takeIf { source -> shouldMigrateComposerDraft(source, to, mainSessionKey) }
    if (pendingAutoSendSource != null) {
      pendingAssistantAutoSendMutable.compareAndSet(pendingAutoSend, pendingAutoSend.copy(owner = to))
    }
    val sources = composerSources + listOfNotNull(pendingAutoSendSource, operationSource)
    sources.forEach { source -> chatShareDraftQueue.migrateOwner(from = source, to = to) }
  }

  /** The ViewModel owns image decoding so Activity recreation cannot cancel an accepted picker result. */
  internal fun importChatComposerAttachments(
    owner: ChatComposerOwner,
    mediaAuthorizationId: String,
    mainSessionKey: String,
    expectedCount: Int,
    load: suspend () -> List<PendingAttachment>,
  ) {
    val importId =
      chatComposerState.beginMediaImport(owner, mediaAuthorizationId, mainSessionKey) ?: return
    viewModelScope.launch(Dispatchers.IO) {
      try {
        val loaded =
          try {
            load()
          } catch (err: CancellationException) {
            throw err
          } catch (_: Throwable) {
            emptyList()
          }
        chatComposerState.completeMediaImport(
          importId = importId,
          candidates = loaded,
          failedCount = expectedCount - loaded.size,
        )
      } catch (err: CancellationException) {
        chatComposerState.cancelMediaImport(importId)
        throw err
      }
    }
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

  fun resolveChatQuestion(
    id: String,
    answers: Map<String, List<String>>,
  ) {
    ensureRuntime().resolveChatQuestion(id, answers)
  }

  suspend fun listBackgroundTasks(agentId: String): List<BackgroundTask> = ensureRuntime().listBackgroundTasks(agentId)

  suspend fun getBackgroundTask(taskId: String): BackgroundTask = ensureRuntime().getBackgroundTask(taskId)

  fun sendChat(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ) {
    ensureRuntime().sendChat(message = message, thinking = thinking, attachments = attachments)
  }

  internal suspend fun sendChatForOwnerAwaitAcceptance(
    owner: ChatComposerOwner,
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
    idempotencyKey: String,
  ): Boolean =
    ensureRuntime().sendChatForOwnerAwaitAcceptance(
      owner = owner,
      message = message,
      thinking = thinking,
      attachments = attachments,
      idempotencyKey = idempotencyKey,
    )

  /** Admission outlives the composing Activity; accepted payloads clear by owner and snapshot. */
  internal fun beginChatComposerSend(
    owner: ChatComposerOwner,
    thinking: String,
  ): ChatComposerSendStartResult {
    if (!isCurrentChatComposerOwner(owner)) return ChatComposerSendStartResult.Unavailable
    val start = chatComposerState.beginSend(owner)
    val request = start.request ?: return start.result
    val outgoing = request.attachments.map(PendingAttachment::toOutgoingAttachment)
    viewModelScope.launch {
      var accepted: Boolean? = null
      try {
        accepted =
          sendChatForOwnerAwaitAcceptance(
            owner = request.owner,
            message = request.message,
            thinking = thinking,
            attachments = outgoing,
            idempotencyKey = request.commandId,
          )
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        accepted = false
      } finally {
        chatComposerState.completeSend(request, accepted)
      }
    }
    return ChatComposerSendStartResult.Started
  }

  internal fun acknowledgeChatComposerSendAdmission(
    owner: ChatComposerOwner,
    id: String,
  ) {
    chatComposerState.acknowledgeSendAdmission(owner, id)
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
