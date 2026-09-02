package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.gateway.GatewayLoadedMedia
import ai.openclaw.app.gateway.GatewayMediaKind
import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.QuestionAnswers
import ai.openclaw.app.gateway.QuestionGetResult
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionRecord
import ai.openclaw.app.gateway.SessionObserverDigest
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveOptionalNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.parseGatewayModels
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.ui.chat.chatModelSendBlocked
import ai.openclaw.app.ui.chat.thinkingSupportedForSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import java.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

// Bounds one-shot search list fetches like the primary session list.
internal const val SESSION_LIST_FETCH_LIMIT = 200
internal const val SESSION_UNREAD_ACK_CAPABILITY = "session-unread-ack-contract"
private const val SESSION_SCOPED_CHAT_METADATA_CAPABILITY = "session-scoped-chat-metadata"
private val QUESTION_REFRESH_RETRY_DELAYS_MS = longArrayOf(1_000L, 2_000L, 4_000L)
private val SWARM_REFRESH_RETRY_DELAYS_MS = longArrayOf(1_000L, 2_000L, 4_000L)
private const val WEAR_AGENT_PULSE_SWARM_MAX_ROWS = 1_000
private const val WEAR_AGENT_PULSE_SWARM_FETCH_LIMIT = WEAR_AGENT_PULSE_SWARM_MAX_ROWS + 1
private const val WEAR_AGENT_PULSE_DIRECT_CHILDREN_GROUP = "__wear_agent_pulse_direct_children__"
private const val SUBAGENT_ACTIVITY_RETENTION_MS = 60_000L
private const val MAX_RETAINED_TERMINAL_SUBAGENT_TASKS = 100
private const val SESSION_EDITOR_MAX_BASE64_CHARS = ((OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES + 2) / 3) * 4
private val MANAGED_MEDIA_PATH_REGEX =
  Regex("^/api/chat/media/outgoing/[^/]+/([0-9a-fA-F-]{36})/full(?:\\?.*)?$")

internal fun chatOutboxQueueFailureText(): NativeText = ChatController.queueFailureText()

internal fun selectChatAgentSessionKey(
  candidates: List<ChatSessionEntry>,
  agentId: String,
  rememberedSessionKey: String?,
  mainSessionKey: String,
): String {
  val normalizedAgentId = agentId.trim()
  val ownerSessions =
    candidates.filter { entry ->
      val owner = resolveAgentIdFromMainSessionKey(entry.key) ?: entry.ownerAgentId
      owner == null || owner == normalizedAgentId
    }
  rememberedSessionKey
    ?.takeIf { remembered -> ownerSessions.any { entry -> entry.key == remembered && entry.archived != true } }
    ?.let { return it }
  return ownerSessions
    .asSequence()
    .filter { entry ->
      entry.archived != true &&
        entry.isMain != true &&
        entry.key != mainSessionKey &&
        entry.key != "main"
    }.maxWithOrNull(
      compareBy<ChatSessionEntry> { entry ->
        entry.lastActivityAt ?: entry.updatedAtMs ?: Long.MIN_VALUE
      }.thenBy { entry -> entry.key },
    )?.key
    ?: mainSessionKey
}

// Capture before suspend points; both fields must still match before gateway data reaches UI state.
internal data class ChatCacheScope(
  val gatewayId: String,
  val connectionGeneration: Long,
)

internal data class ChatAgentSessionSelectionOwner(
  val gatewayStableId: String?,
  val agentId: String,
)

// Reference identity distinguishes a new explicit choice of the same key.
internal class RememberedChatSession(
  val key: String,
  var observedSessionId: String?,
)

internal data class ChatAgentSessionSelection(
  val gatewayScope: ChatCacheScope?,
  val rememberedSession: RememberedChatSession?,
  val rememberedSessionId: String?,
  val targetSessionKey: String?,
)

private fun normalizedChatCacheScope(scope: ChatCacheScope?): ChatCacheScope? {
  val current = scope ?: return null
  val gatewayId = current.gatewayId.trim().takeIf { it.isNotEmpty() } ?: return null
  return if (gatewayId == current.gatewayId) current else current.copy(gatewayId = gatewayId)
}

internal data class MainSessionBinding(
  val key: String,
  val label: String,
)

internal data class ChatSessionDeletion(
  val gatewayId: String?,
  val agentId: String,
  val sessionKey: String,
  val mainSessionKey: String,
)

private class MainSessionReadiness(
  val gatewayScope: ChatCacheScope,
  val binding: MainSessionBinding,
  val ready: CompletableDeferred<Unit>,
) {
  var job: Job? = null
}

private class BranchListingUnsupportedException : IllegalStateException("sessions.branches.list is not supported by this gateway")

private data class ChatMetadataScope(
  val agentId: String,
  val sessionKey: String?,
) {
  fun params(): JsonObject =
    buildJsonObject {
      put("agentId", JsonPrimitive(agentId))
      sessionKey?.let { put("sessionKey", JsonPrimitive(it)) }
    }
}

class ChatController internal constructor(
  private val scope: CoroutineScope,
  private val json: Json,
  private val requestGateway: suspend (method: String, paramsJson: String?) -> String,
  private val requestGatewayForGateway: suspend (gatewayId: String, method: String, paramsJson: String?) -> String =
    { _, method, paramsJson -> requestGateway(method, paramsJson) },
  private val gatewayAdvertisesMethod: (method: String) -> Boolean? = { null },
  private val gatewayAdvertisesCapability: (capability: String) -> Boolean? = { null },
  private val currentGatewayCatalogRevision: () -> Long = { 0L },
  private val captureRequestLease: (gatewayScope: ChatCacheScope?) -> GatewaySession.RequestLease? =
    { gatewayScope ->
      GatewaySession.RequestLease(endpointStableId = gatewayScope?.gatewayId.orEmpty()) { method, paramsJson, _, withEnqueue ->
        withEnqueue {}
        if (gatewayScope == null) {
          requestGateway(method, paramsJson)
        } else {
          requestGatewayForGateway(gatewayScope.gatewayId, method, paramsJson)
        }
      }
    },
  private val transcriptCache: ChatTranscriptCache? = null,
  private val cacheScope: () -> ChatCacheScope? = { null },
  private val currentDefaultAgentId: () -> String? = { "main" },
  private val currentDefaultAgentRevision: () -> Long = { 0L },
  private val loadGatewayImageArtifact: suspend (
    gatewayId: String?,
    sessionKey: String,
    agentId: String?,
    artifactId: String,
  ) -> GatewayLoadedImage? = { _, _, _, _ -> null },
  private val loadGatewayMediaArtifact: suspend (
    gatewayId: String?,
    sessionKey: String,
    agentId: String?,
    artifactId: String,
    kind: GatewayMediaKind,
    playbackRendition: Boolean,
  ) -> GatewayLoadedMedia? = { _, _, _, _, _, _ -> null },
  private val commandOutbox: ChatCommandOutbox? = null,
  private val recordModelRecent: (String) -> Unit = {},
  private val onSessionDeleted: (ChatSessionDeletion) -> Unit = {},
  private val onOfflineDefaultAgentRestored: (String) -> Unit = {},
  private val onAssistantReplyFinalized: (owner: ChatComposerOwner, runId: String, text: String) -> Unit = { _, _, _ -> },
) {
  internal constructor(
    scope: CoroutineScope,
    session: GatewaySession,
    json: Json,
    transcriptCache: ChatTranscriptCache? = null,
    cacheScope: () -> ChatCacheScope? = { null },
    currentDefaultAgentId: () -> String? = { "main" },
    currentDefaultAgentRevision: () -> Long = { 0L },
    gatewayAdvertisesMethod: (method: String) -> Boolean? = { null },
    gatewayAdvertisesCapability: (capability: String) -> Boolean? = { null },
    currentGatewayCatalogRevision: () -> Long = { 0L },
    commandOutbox: ChatCommandOutbox? = null,
    recordModelRecent: (String) -> Unit = {},
    onSessionDeleted: (ChatSessionDeletion) -> Unit = {},
    onOfflineDefaultAgentRestored: (String) -> Unit = {},
    onAssistantReplyFinalized: (owner: ChatComposerOwner, runId: String, text: String) -> Unit = { _, _, _ -> },
  ) : this(
    scope = scope,
    json = json,
    requestGateway = { method, paramsJson -> session.request(method, paramsJson) },
    requestGatewayForGateway = { gatewayId, method, paramsJson ->
      session.requestForEndpoint(gatewayId, method, paramsJson)
    },
    gatewayAdvertisesMethod = gatewayAdvertisesMethod,
    gatewayAdvertisesCapability = gatewayAdvertisesCapability,
    currentGatewayCatalogRevision = currentGatewayCatalogRevision,
    captureRequestLease = { gatewayScope ->
      session.captureRequestLease(gatewayScope?.gatewayId)
    },
    transcriptCache = transcriptCache,
    cacheScope = cacheScope,
    currentDefaultAgentId = currentDefaultAgentId,
    currentDefaultAgentRevision = currentDefaultAgentRevision,
    loadGatewayImageArtifact = { gatewayId, sessionKey, agentId, artifactId ->
      session.loadImageArtifact(gatewayId, sessionKey, agentId, artifactId)
    },
    loadGatewayMediaArtifact = { gatewayId, sessionKey, agentId, artifactId, kind, playbackRendition ->
      session.loadMediaArtifact(gatewayId, sessionKey, agentId, artifactId, kind, playbackRendition)
    },
    commandOutbox = commandOutbox,
    recordModelRecent = recordModelRecent,
    onSessionDeleted = onSessionDeleted,
    onOfflineDefaultAgentRestored = onOfflineDefaultAgentRestored,
    onAssistantReplyFinalized = onAssistantReplyFinalized,
  )

  suspend fun loadImageArtifact(artifactId: String): GatewayLoadedImage? {
    val normalizedArtifactId = artifactId.trim().takeIf(String::isNotEmpty) ?: return null
    val sessionKey = normalizeRequestedSessionKey(_sessionKey.value)
    return loadGatewayImageArtifact(
      currentCacheScope()?.gatewayId,
      sessionKey,
      resolveAgentIdForSessionKey(sessionKey),
      normalizedArtifactId,
    )
  }

  suspend fun loadMediaArtifact(
    artifactId: String,
    kind: GatewayMediaKind,
    playbackRendition: Boolean,
  ): GatewayLoadedMedia? {
    val normalizedArtifactId = artifactId.trim().takeIf(String::isNotEmpty) ?: return null
    if (kind == GatewayMediaKind.Image) return null
    val sessionKey = normalizeRequestedSessionKey(_sessionKey.value)
    return loadGatewayMediaArtifact(
      currentCacheScope()?.gatewayId,
      sessionKey,
      resolveAgentIdForSessionKey(sessionKey),
      normalizedArtifactId,
      kind,
      playbackRendition,
    )
  }

  private var appliedMainSessionKey = "main"

  // Keep durable branch evidence and its visible history ahead of the next admission.
  private val historyPublicationMutex = Mutex()
  private val cacheMutationMutex = Mutex()
  private val defaultAgentPersistenceMutex = Mutex()
  private val defaultAgentPersistenceRevisions = mutableMapOf<String, Long>()

  private data class SessionSettingsKey(
    val gatewayScope: ChatCacheScope?,
    val sessionKey: String,
    val ownerAgentId: String?,
  )

  private data class QueuedSessionSettingsMutation(
    val settingsKey: SessionSettingsKey,
    val requestLease: GatewaySession.RequestLease?,
    val lane: SessionSettingsLane,
    val pending: CompletableDeferred<Boolean>,
    val previous: CompletableDeferred<Boolean>?,
    val thinkingIntent: ThinkingIntent?,
  )

  private class SessionSettingsLane(
    var tail: CompletableDeferred<Boolean>,
    var confirmed: ChatSessionEntry,
    var confirmedThinkingLevel: String,
    var observation: Any = Any(),
    var thinkingIntent: ThinkingIntent? = null,
    var needsRefresh: Boolean = false,
    var reconciliation: SessionSettingsCompletion? = null,
  )

  private data class SessionSettingsCompletion(
    val pending: CompletableDeferred<Boolean>,
    val succeeded: Boolean,
  )

  private data class SessionSettingsSnapshot(
    val entry: ChatSessionEntry,
    val authoritative: Boolean,
  )

  private class SessionSettingsRead(
    val gatewayScope: ChatCacheScope?,
    val ownerAgentId: String,
  ) {
    val settingsSnapshots = mutableMapOf<String, SessionSettingsSnapshot>()

    fun observe(snapshot: SessionSettingsSnapshot) {
      val previous = settingsSnapshots[snapshot.entry.key]
      settingsSnapshots[snapshot.entry.key] =
        if (previous == null) {
          snapshot
        } else {
          SessionSettingsSnapshot(
            mergeChatSessionEntry(previous.entry, snapshot.entry, authoritativeSessionSettings = snapshot.authoritative),
            previous.authoritative || snapshot.authoritative,
          )
        }
    }

    fun hasConflictingSettings(sessions: List<ChatSessionEntry>): Boolean =
      sessions.any { entry ->
        val snapshot = settingsSnapshots[entry.key] ?: return@any false
        !sameSessionSettings(
          entry,
          mergeChatSessionEntry(entry, snapshot.entry, authoritativeSessionSettings = snapshot.authoritative),
        )
      }
  }

  private class ThinkingIntent(
    val level: String,
    var dispatched: Boolean = false,
  )

  private sealed interface SessionSettingsChange {
    data class Model(
      val ref: String?,
    ) : SessionSettingsChange

    data class Thinking(
      val level: String,
    ) : SessionSettingsChange

    data class Permission(
      val mode: ChatPermissionMode?,
      val expectedSessionId: String,
      val expectedPermissionMode: ChatPermissionMode?,
    ) : SessionSettingsChange

    data class FastMode(
      val mode: ChatFastMode?,
    ) : SessionSettingsChange
  }

  private val pendingSettingsMutations = ConcurrentHashMap<SessionSettingsKey, SessionSettingsLane>()
  private val _pendingSessionSettingsKeys = MutableStateFlow<Set<String>>(emptySet())
  val pendingSessionSettingsKeys: StateFlow<Set<String>> =
    _pendingSessionSettingsKeys.asStateFlow()
  private val settingsMutationRevisions = mutableMapOf<ChatCacheScope?, Long>()
  private val activeSessionReads = mutableSetOf<SessionSettingsRead>()
  private val sessionSettingsRefreshError = nativeText("Could not refresh session settings. Refresh before sending.")

  // Guarded by gatewayScopeApplyLock; stable gateway keys retain choices across reconnects.
  private val lastSelectedChatSessionByOwner = mutableMapOf<ChatAgentSessionSelectionOwner, RememberedChatSession>()

  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  // Session-list keys are not always agent-qualified. Preserve the row's captured owner so
  // later gateway-default changes cannot retarget history, composer state, or sends.
  private val _sessionOwnerAgentId = MutableStateFlow<String?>(null)
  val sessionOwnerAgentId: StateFlow<String?> = _sessionOwnerAgentId.asStateFlow()

  private val _sessionId = MutableStateFlow<String?>(null)
  val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

  private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

  private val _transcriptAnchor = MutableStateFlow<ChatTranscriptAnchorState?>(null)
  val transcriptAnchor: StateFlow<ChatTranscriptAnchorState?> = _transcriptAnchor.asStateFlow()

  // True while the transcript shown came from the offline cache and no live history replaced it yet.
  private val _messagesFromCache = MutableStateFlow(false)
  val messagesFromCache: StateFlow<Boolean> = _messagesFromCache.asStateFlow()

  private data class LiveHistoryMarker(
    val sessionKey: String,
    val sessionId: String?,
    val generation: Long,
  )

  private data class PendingRunProjection(
    val owner: ChatComposerOwner,
    val runId: String,
    val optimisticMessage: ChatMessage,
  )

  private data class RunDiagnosticOwner(
    val owner: ChatComposerOwner,
    val runId: String,
  )

  private sealed interface HistoryRefreshResult {
    data class Applied(
      val branchState: ChatOutboxBranchState?,
    ) : HistoryRefreshResult

    data object Superseded : HistoryRefreshResult

    data object BranchInvalidated : HistoryRefreshResult

    data object OwnerUnavailable : HistoryRefreshResult

    data object Failed : HistoryRefreshResult
  }

  @Volatile
  private var liveHistoryMarker: LiveHistoryMarker? = null
  private var lastVerifiedDefaultAgentId = currentDefaultAgentId()?.trim()?.ifEmpty { null }
  private var lastVerifiedDefaultAgentGatewayId = currentCacheScope()?.gatewayId
  private val composerDefaultAgentOwnerMutable =
    MutableStateFlow(
      lastVerifiedDefaultAgentId?.let { agentId ->
        lastVerifiedDefaultAgentGatewayId?.let { gatewayId -> GatewayDefaultAgentOwner(gatewayId, agentId) }
      },
    )
  internal val composerDefaultAgentOwner: StateFlow<GatewayDefaultAgentOwner?> = composerDefaultAgentOwnerMutable.asStateFlow()

  private val _historyLoading = MutableStateFlow(false)
  val historyLoading: StateFlow<Boolean> = _historyLoading.asStateFlow()

  private val _errorText = MutableStateFlow<NativeText?>(null)
  val errorText: StateFlow<String?> = _errorText.resolveOptionalNativeText()

  private val _healthOk = MutableStateFlow(false)
  val healthOk: StateFlow<Boolean> = _healthOk.asStateFlow()

  private val _thinkingLevel = MutableStateFlow("off")
  val thinkingLevel: StateFlow<String> = _thinkingLevel.asStateFlow()

  private val _thinkingLevelSelection = MutableStateFlow(defaultChatThinkingLevelSelection)
  val thinkingLevelSelection: StateFlow<ChatThinkingLevelSelection> = _thinkingLevelSelection.asStateFlow()

  private val _selectedModelRef = MutableStateFlow<String?>(null)
  val selectedModelRef: StateFlow<String?> = _selectedModelRef.asStateFlow()

  private val _modelCatalog = MutableStateFlow<List<GatewayModelSummary>>(emptyList())
  val modelCatalog: StateFlow<List<GatewayModelSummary>> = _modelCatalog.asStateFlow()

  private val _pendingRunCount = MutableStateFlow(0)
  val pendingRunCount: StateFlow<Int> = _pendingRunCount.asStateFlow()

  private val selectedActiveRunPresentationState = MutableStateFlow(ChatActiveRunPresentation())
  internal val selectedActiveRunPresentation: StateFlow<ChatActiveRunPresentation> =
    selectedActiveRunPresentationState.asStateFlow()

  private val _streamingAssistantText = MutableStateFlow<String?>(null)
  val streamingAssistantText: StateFlow<String?> = _streamingAssistantText.asStateFlow()

  private val pendingToolCallsById = ConcurrentHashMap<String, ChatPendingToolCall>()
  private val _pendingToolCalls = MutableStateFlow<List<ChatPendingToolCall>>(emptyList())
  val pendingToolCalls: StateFlow<List<ChatPendingToolCall>> = _pendingToolCalls.asStateFlow()

  private val subagentActivityLock = Any()

  // A null job preserves an expired terminal observation without retaining its UI row.
  private val subagentActivityExpiryJobs = mutableMapOf<String, Job?>()
  private val _subagentActivities = MutableStateFlow<Map<String, ChatSubagentActivity>>(emptyMap())
  val subagentActivities: StateFlow<Map<String, ChatSubagentActivity>> = _subagentActivities.asStateFlow()

  private val _questions = MutableStateFlow<List<ChatQuestionPrompt>>(emptyList())
  val questions: StateFlow<List<ChatQuestionPrompt>> = _questions.asStateFlow()
  private val questionStateLock = Any()
  private var questionStateRevision = 0L
  private var questionRefreshGeneration = 0L

  private data class QuestionEvictionJob(
    val job: Job,
    val observedAtMs: Long?,
  )

  private val questionEvictionJobs = mutableMapOf<String, QuestionEvictionJob>()

  private val _progressCard = MutableStateFlow<ChatProgressCard?>(null)
  val progressCard: StateFlow<ChatProgressCard?> = _progressCard.asStateFlow()

  @Volatile private var progressCardScopeKey: String? = null

  private val _sessions = MutableStateFlow<List<ChatSessionEntry>>(emptyList())
  val sessions: StateFlow<List<ChatSessionEntry>> = _sessions.asStateFlow()

  private val _swarmGroups = MutableStateFlow<List<ChatSwarmGroup>>(emptyList())
  val swarmGroups: StateFlow<List<ChatSwarmGroup>> = _swarmGroups.asStateFlow()

  private data class SwarmRefreshLease(
    val parentKey: String,
    val cacheScope: ChatCacheScope,
    val requestSequence: Long,
  )

  private data class SwarmProjectionSnapshot(
    val parentKey: String,
    val cacheScope: ChatCacheScope,
    val requestSequence: Long,
    val sessions: List<ChatSessionEntry>,
  )

  private val swarmActivityTracker = ChatSwarmActivityTracker()
  private val swarmLock = Any()
  private var swarmSessions: List<ChatSessionEntry> = emptyList()
  private val swarmRequestSequence = AtomicLong(0)
  private var swarmRefreshJob: Job? = null
  private var swarmSessionKey: String? = null
  private var swarmEnabled = false

  internal fun currentSwarmSnapshot(): ChatSwarmSnapshot =
    synchronized(swarmLock) {
      ChatSwarmSnapshot(
        sessionKey = swarmSessionKey,
        enabled = swarmEnabled,
        groups = _swarmGroups.value,
      )
    }

  /** Reads Swarm state for a Wear-selected session without changing the Phone chat selection. */
  internal suspend fun readSwarmSnapshotFor(
    sessionKey: String,
    agentId: String,
  ): ChatSwarmSnapshot? {
    val requestedSessionKey = sessionKey.trim().takeIf(String::isNotEmpty) ?: return null
    val requestedAgentId = agentId.trim().takeIf(String::isNotEmpty) ?: return null
    val scopedSessionKey = normalizeRequestedSessionKey(requestedSessionKey)
    val scopedAgentId = resolveAgentIdFromMainSessionKey(scopedSessionKey)
    val restrictToParentAgent =
      when {
        scopedAgentId == requestedAgentId -> false
        requestedSessionKey == "main" && scopedSessionKey == "main" && scopedAgentId == null -> true
        else -> return null
      }
    val requestCacheScope = currentCacheScope() ?: return null
    val enabled =
      try {
        val params =
          buildJsonObject {
            put("agentId", JsonPrimitive(requestedAgentId))
          }
        val root =
          json
            .parseToJsonElement(
              requestGatewayBound(
                requestCacheScope.gatewayId,
                "chat.metadata",
                params.toString(),
              ),
            ).asObjectOrNull()
        root?.get("swarmEnabled").asBooleanOrNull() == true
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        return null
      }
    if (!enabled) {
      return ChatSwarmSnapshot(
        sessionKey = requestedSessionKey,
        enabled = false,
        groups = emptyList(),
      )
    }
    val rows =
      try {
        val params =
          buildJsonObject {
            put("includeGlobal", JsonPrimitive(false))
            put("includeUnknown", JsonPrimitive(false))
            put("configuredAgentsOnly", JsonPrimitive(true))
            if (restrictToParentAgent) {
              put("agentId", JsonPrimitive(requestedAgentId))
            }
            put("spawnedBy", JsonPrimitive(scopedSessionKey))
            put("limit", JsonPrimitive(WEAR_AGENT_PULSE_SWARM_FETCH_LIMIT))
            put("offset", JsonPrimitive(0))
          }
        val root =
          json
            .parseToJsonElement(
              requestGatewayBound(
                requestCacheScope.gatewayId,
                "sessions.list",
                params.toString(),
              ),
            ).asObjectOrNull()
            ?: return null
        val sessionElements = root["sessions"] as? JsonArray ?: return null
        val parsedRows = sessionElements.mapNotNull { parseSessionEntry(it.asObjectOrNull()) }
        val truncated =
          root["hasMore"].asBooleanOrNull() == true ||
            root["totalCount"].asLongOrNull()?.let { total -> total > sessionElements.size.toLong() } == true ||
            sessionElements.size > WEAR_AGENT_PULSE_SWARM_MAX_ROWS
        if (truncated || parsedRows.size != sessionElements.size) {
          return null
        }
        parsedRows
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        return null
      }
    val projectedRows =
      rows.map { row ->
        val hasExplicitGroup = !row.swarmGroupId.isNullOrBlank()
        val hasSubagentProvenance = row.subagentRunState != null || row.hasActiveSubagentRun != null
        if (!hasExplicitGroup && hasSubagentProvenance) {
          row.copy(swarmGroupId = WEAR_AGENT_PULSE_DIRECT_CHILDREN_GROUP)
        } else {
          row
        }
      }
    if (requestCacheScope != currentCacheScope()) return null
    return ChatSwarmSnapshot(
      sessionKey = requestedSessionKey,
      enabled = true,
      groups = buildChatSwarmGroups(projectedRows) { candidate -> sameOutboxSession(candidate, scopedSessionKey) },
    )
  }

  private val _sessionBranches = MutableStateFlow<List<SessionBranch>>(emptyList())
  val sessionBranches: StateFlow<List<SessionBranch>> = _sessionBranches.asStateFlow()

  private val _sessionBranchesLoading = MutableStateFlow(false)
  val sessionBranchesLoading: StateFlow<Boolean> = _sessionBranchesLoading.asStateFlow()

  private val _sessionBranchSwitching = MutableStateFlow(false)
  val sessionBranchSwitching: StateFlow<Boolean> = _sessionBranchSwitching.asStateFlow()

  private val sessionBranchesRefreshGeneration = AtomicLong(0)
  private val sessionBranchSwitchGeneration = AtomicLong(0)
  private val sessionBranchSwitchClaimed = AtomicBoolean(false)
  private val reconciledOutboxBranchScopes = ConcurrentHashMap.newKeySet<ReconciledOutboxBranchScope>()
  private val ambiguousMutationReconciliationStates = ConcurrentHashMap<ReconciledOutboxBranchScope, ChatOutboxBranchState>()
  private val outboxSessionMutationEventLock = Any()
  private val activeOutboxSessionMutations = ConcurrentHashMap<ReconciledOutboxBranchScope, ActiveOutboxSessionMutation>()
  private val deferredOutboxSessionMutationEvents = mutableMapOf<ReconciledOutboxBranchScope, MutableSet<ChatOutboxMutationLease>>()

  private val _commands = MutableStateFlow<List<ChatCommandEntry>>(emptyList())
  val commands: StateFlow<List<ChatCommandEntry>> = _commands.asStateFlow()

  suspend fun listBackgroundTasks(agentId: String): List<BackgroundTask> {
    suspend fun request(
      statuses: List<String>?,
      limit: Int,
    ): List<BackgroundTask> {
      val params =
        buildJsonObject {
          put("agentId", JsonPrimitive(agentId))
          put("limit", JsonPrimitive(limit))
          statuses?.let { values -> put("status", JsonArray(values.map(::JsonPrimitive))) }
        }
      return parseBackgroundTasks(json, requestGateway("tasks.list", params.toString()))
    }

    val active = request(listOf("queued", "running"), limit = 100)
    val recent = request(listOf("completed", "failed", "cancelled", "timed_out"), limit = 50)
    return mergeBackgroundTasks(active, recent)
  }

  suspend fun getBackgroundTask(taskId: String): BackgroundTask {
    val params = buildJsonObject { put("taskId", JsonPrimitive(taskId)) }
    val root = json.parseToJsonElement(requestGateway("tasks.get", params.toString())).jsonObject
    return root["task"]?.let(::parseBackgroundTask)
      ?: error("Gateway returned no background task")
  }

  private data class LiveRunTelemetryState(
    val highestSequence: Long,
    val outputTokens: Long? = null,
    val terminal: Boolean = false,
  )

  private val pendingRuns = mutableSetOf<String>()
  private val liveRunTelemetryLock = Any()
  private val liveRunTelemetryByRunId = mutableMapOf<String, LiveRunTelemetryState>()
  private val disconnectedPendingRunIds = mutableSetOf<String>()
  private val timedOutRunIds = ConcurrentHashMap.newKeySet<String>()
  private val terminalWithoutReplyRunIds = ConcurrentHashMap.newKeySet<String>()
  private val unknownOutcomeRunIds = ConcurrentHashMap.newKeySet<String>()
  private val pendingRunTimeoutJobs = ConcurrentHashMap<String, Job>()

  // Preserve sent messages locally until chat.history includes the gateway-confirmed copy.
  private val optimisticMessagesByRunId = ConcurrentHashMap<String, ChatMessage>()

  // Keep reply ownership after the user row persists; the assistant row can land later.
  private val unresolvedRepliesByRunId = ConcurrentHashMap<String, ChatMessage>()

  // Session switches clear visible run state. Keep the owning projection separately so an
  // acknowledged run can be restored when its chat returns instead of leaking into another chat.
  private val pendingRunProjectionsByRunId = ConcurrentHashMap<String, PendingRunProjection>()
  private val pendingRunTimeoutMs = 120_000L
  private val recoveryHistoryRetryDelayMs = 750L
  private var recoveryHistoryReconciliationGeneration = -1L
  private var recoveryHistoryReconciliationJob: Job? = null

  // Drops stale history responses after session switches or refresh races.
  private val historyLoadGeneration = AtomicLong(0)
  private val progressCardFetchGeneration = AtomicLong(0)
  private val legacyProgressCardRevision = AtomicInteger(0)

  // Advances when the visible session changes. Sends use it to detect A -> B -> A switches
  // across durable outbox suspension points; same-owner history reloads keep their projection.
  private val chatSelectionGeneration = MutableStateFlow(0L)
  internal val selectionGeneration: StateFlow<Long> = chatSelectionGeneration.asStateFlow()
  private val historyRequestSequence = AtomicLong(0)
  private val settingsPublicationGeneration = AtomicLong(0)
  private val sessionsRequestSequence = AtomicLong(0)

  // Every live history path awaits this gateway/session readiness. Per-gateway locking keeps
  // rapid agent switches from letting an older lookup refresh before the new session is ready.
  private val mainSessionAdoptionLocks = ConcurrentHashMap<String, Mutex>()
  private val desiredMainSessions = ConcurrentHashMap<String, MainSessionBinding>()
  private val mainSessionReadinessLock = Any()
  private var mainSessionReadiness: MainSessionReadiness? = null
  private val gatewayScopeApplyLock = Any()
  private var latestAppliedHistoryRequest = 0L
  private var publishedHistoryBranch: PublishedHistoryBranch? = null
  private var latestAppliedInFlightRunId: String? = null
  private var lastHandledTerminalRunId: String? = null

  // Lifecycle telemetry can retire a run before its canonical chat terminal arrives.
  // Its diagnostic remains owned until that terminal, a newer run, or an owner reset.
  @Volatile private var runDiagnosticOwner: RunDiagnosticOwner? = null
  private var historyLoadErrorGeneration: Long? = null
  private val newChatCreateInFlight = AtomicBoolean(false)

  private var lastHealthPollAtMs: Long? = null
  private val chatMetadataRequestSequence = AtomicLong(0)
  private var chatMetadataScope: ChatMetadataScope? = null
  private var chatMetadataLoadState = ChatMetadataLoadState.Unloaded
  private var sessionsListArchived = false

  // Retained selection and event rows must not enlarge the next requested page.
  private var sessionsListLimit: Int? = null

  // One acknowledgement per unread episode: the pending flag clears when the
  // server-confirmed read (unread=false) arrives, so fresh activity on the open
  // session re-acknowledges without patch loops (lastReadAt is stamped server-side).
  private var unreadPatchSessionKey: String? = null
  private var unreadActivationObserved = false
  private var unreadActivationMarkedUnreadAt: Long? = null
  private var unreadPatchRequested = false

  // Armed on disconnect so the next health event refetches history and re-adopts
  // any run the gateway still reports in flight (chat.history `inFlightRun`).
  private var restoreRunStateOnReconnect = false

  private class HealthRefresh(
    var historyGeneration: Long? = null,
    val force: Boolean = false,
    val refreshSessions: Boolean = false,
  ) {
    // Bootstrap retains ownership across cache reads and branch-history retries.
    var historyOwners = if (historyGeneration == null) 0 else 1
    var claimed = false
  }

  private var pendingHealthRefresh: HealthRefresh? = null

  private fun updateErrorText(
    message: String?,
    historyGeneration: Long? = null,
  ) {
    updateLocalizedErrorText(message?.let(::verbatimText), historyGeneration)
  }

  private fun updateLocalizedErrorText(
    message: NativeText?,
    historyGeneration: Long? = null,
  ) {
    synchronized(gatewayScopeApplyLock) {
      historyLoadErrorGeneration = historyGeneration
      _errorText.value = message
    }
  }

  private val _outboxItems = MutableStateFlow<List<ChatOutboxItem>>(emptyList())
  val outboxItems: StateFlow<List<ChatOutboxItem>> = _outboxItems.asStateFlow()

  // Flush requests are level-triggered: the owner clears one per pass and rechecks after release.
  private val outboxFlushInFlight = AtomicBoolean(false)
  private val outboxFlushRequested = AtomicBoolean(false)
  private val outboxBranchReconcileInFlight = AtomicBoolean(false)
  private val outboxBranchReconcileRequested = AtomicBoolean(false)
  private val outboxBranchReconcileRetryScheduled = AtomicBoolean(false)
  private val outboxRecoveryMutex = Mutex()
  private var outboxPublicationRevision = 0L
  private var outboxRecoveryComplete = false
  private val _outboxPresentationRestored = MutableStateFlow(commandOutbox == null)
  val outboxPresentationRestored: StateFlow<Boolean> = _outboxPresentationRestored.asStateFlow()

  // Counts idle-history snapshots that lacked proof for an orphaned accepted row; rows park as
  // delivery-unconfirmed on the second sighting so one lagging transcript write is not loss.
  private val unconfirmedSightings = ConcurrentHashMap<String, Int>()

  // Gateway ACKs may return a run id that differs from the row's idempotency key; ownership
  // and in-flight checks must recognize both or reconciliation can park a still-live run.
  // Deliberately in-memory: chat.send uses the client idempotency key as the run id, and
  // after a restart canonical-history proof by "<id>:user" retires rows regardless of the
  // acked id; an ambiguous survivor parks for manual review instead of auto-retrying.
  private val acknowledgedRunIdByRowId = ConcurrentHashMap<String, String>()

  private val outboxRecoveryJob =
    commandOutbox?.let { outbox ->
      scope.launch {
        // A killed process can lose the local delete after the gateway accepted a command.
        // Keep that delivery ambiguous and user-visible instead of replaying it automatically.
        if (recoverInterruptedOutboxSends(outbox)) {
          currentCacheScope()?.let { outboxScope ->
            runCatching { outbox.expireStale(outboxScope.gatewayId, System.currentTimeMillis()) }
          }
        }
        publishOutbox()
      }
    }

  /** Clears transient chat state when the operator gateway session disconnects. */
  fun onDisconnected(message: String) {
    chatMetadataRequestSequence.incrementAndGet()
    retireMainSessionReadiness()
    reconciledOutboxBranchScopes.clear()
    ambiguousMutationReconciliationStates.clear()
    synchronized(outboxSessionMutationEventLock) {
      activeOutboxSessionMutations.clear()
      deferredOutboxSessionMutationEvents.clear()
    }
    synchronized(gatewayScopeApplyLock) {
      historyLoadGeneration.incrementAndGet()
      restoreRunStateOnReconnect = true
      pendingHealthRefresh = null
      _healthOk.value = false
    }
    updateErrorText(null)
    clearChatMetadata()
    disableSwarmProgress()
    clearLiveHistoryMarker()
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.addAll(pendingRuns)
    }
    // History can lag the accepted send. Keep the optimistic echo available for the
    // reconnect snapshot to reconcile instead of dropping the user's message.
    clearPendingRuns(
      clearOptimisticMessages = false,
      preserveDisconnectedOwnership = true,
    )
    clearLiveRunUi()
    _historyLoading.value = false
    _sessionId.value = null
    // Failed connect attempts pass through onGatewayScopeChanging, which empties the published
    // outbox rows; repopulate for the still-selected gateway so queued sends stay visible offline.
    scope.launch { publishOutbox() }
  }

  /** Refreshes the connected gateway while preserving recovery ownership after a disconnect. */
  fun onGatewayConnected() {
    refreshConnectedGateway()
  }

  /** Creates/adopts the app-owned main session before connected history can load. */
  internal fun onGatewayConnected(mainSession: MainSessionBinding) {
    val requestScope = currentCacheScope()
    if (requestScope == null) {
      refreshConnectedGateway()
      return
    }
    desiredMainSessions[requestScope.gatewayId] = mainSession
    val readiness =
      MainSessionReadiness(
        gatewayScope = requestScope,
        binding = mainSession,
        ready = CompletableDeferred(),
      )
    val adoptionJob =
      scope.launch(start = CoroutineStart.LAZY) {
        try {
          val adoptionLock = mainSessionAdoptionLocks.computeIfAbsent(requestScope.gatewayId) { Mutex() }
          adoptionLock.withLock {
            if (desiredMainSessions[requestScope.gatewayId] != mainSession) return@withLock
            try {
              val existingSession = fetchSessionDescription(requestScope.gatewayId, mainSession.key)
              if (desiredMainSessions[requestScope.gatewayId] != mainSession) return@withLock
              val existingLabel =
                existingSession
                  ?.get("label")
                  .asStringOrNull()
                  ?.trim()
                  ?.takeIf { it.isNotEmpty() }
              if (existingLabel == null) {
                // Label-only sessions.patch is operator.write-scoped and atomically upserts the row,
                // avoiding the concurrent-session identity race in sessions.create.
                val patchParams =
                  buildJsonObject {
                    put("key", JsonPrimitive(mainSession.key))
                    put("label", JsonPrimitive(mainSession.label))
                  }
                requestGatewayBound(requestScope.gatewayId, "sessions.patch", patchParams.toString())
              }
            } catch (err: CancellationException) {
              throw err
            } catch (_: Throwable) {
              // History remains usable under the already-bound key when adoption cannot be verified.
            }
          }
        } finally {
          readiness.ready.complete(Unit)
        }
        // A superseded connect owns the next refresh and must not inherit this response.
        if (
          synchronized(mainSessionReadinessLock) { mainSessionReadiness === readiness } &&
          requestScope == currentCacheScope() &&
          desiredMainSessions[requestScope.gatewayId] == mainSession
        ) {
          refreshConnectedGateway()
        }
      }
    readiness.job = adoptionJob
    val supersededReadiness =
      synchronized(mainSessionReadinessLock) {
        val current = mainSessionReadiness
        mainSessionReadiness = readiness
        current
      }
    supersededReadiness?.job?.cancel()
    supersededReadiness?.ready?.complete(Unit)
    adoptionJob.start()
  }

  private fun refreshConnectedGateway() {
    refreshQuestions()
    refreshHistoryForRecovery(forceHealth = true)
  }

  /** Invalidates and clears gateway-bound UI state before a target switch can race old responses. */
  fun onGatewayScopeChanging(retireRunState: Boolean = false) {
    val retiredSettings =
      synchronized(gatewayScopeApplyLock) { retireSessionSettingsLanes { _, _ -> true } }
    retiredSettings.forEach { it.complete(false) }
    chatMetadataRequestSequence.incrementAndGet()
    retireMainSessionReadiness()
    disableSwarmProgress()
    synchronized(gatewayScopeApplyLock) {
      if (retireRunState) {
        restoreRunStateOnReconnect = false
        clearPendingRuns()
        clearLiveRunUi()
      }
      appliedMainSessionKey = "main"
      beginHistoryLoad(
        key = "main",
        ownerAgentId = null,
        markLoading = false,
        refreshHealth = false,
      )
      clearProgressCard()
      clearSubagentActivities()
      clearLiveHistoryMarker()
      _sessions.value = emptyList()
      publishRunPresentation()
      clearQuestions()
      applyThinkingMetadata(null)
      sessionsListArchived = false
      sessionsListLimit = null
      unreadPatchSessionKey = null
      unreadActivationObserved = false
      unreadActivationMarkedUnreadAt = null
      unreadPatchRequested = false
      clearChatMetadata()
      lastHealthPollAtMs = null
      // Outbox rows are gateway-scoped too; the next publish repopulates them for the new scope.
      outboxPublicationRevision += 1
      _outboxItems.value = emptyList()
      _outboxPresentationRestored.value = commandOutbox == null
      reconciledOutboxBranchScopes.clear()
      ambiguousMutationReconciliationStates.clear()
      synchronized(outboxSessionMutationEventLock) {
        activeOutboxSessionMutations.clear()
        deferredOutboxSessionMutationEvents.clear()
      }
      _sessionBranches.value = emptyList()
      _sessionBranchesLoading.value = false
      sessionBranchesRefreshGeneration.incrementAndGet()
      sessionBranchSwitchGeneration.incrementAndGet()
      sessionBranchSwitchClaimed.set(false)
      _sessionBranchSwitching.value = false
    }
  }

  private fun retireMainSessionReadiness() {
    val staleReadiness =
      synchronized(mainSessionReadinessLock) {
        val current = mainSessionReadiness
        mainSessionReadiness = null
        current
      }
    staleReadiness?.job?.cancel()
    staleReadiness?.ready?.complete(Unit)
  }

  /** Restores the selected gateway's local state without waiting for transport availability. */
  fun restoreSelectedGatewayOfflineState() {
    refresh()
    scope.launch { publishOutbox() }
  }

  /** Purges cached transcripts and queued sends for one retired authentication scope. */
  internal suspend fun clearGatewayCache(gatewayId: String) {
    clearGatewayCache(gatewayId) { gateway ->
      transcriptCache?.clearGateway(gateway)
      commandOutbox?.clearGateway(gateway)
    }
  }

  /** Serializes an owner-provided cross-store purge with every chat cache/outbox mutation. */
  internal suspend fun clearGatewayCache(
    gatewayId: String,
    clearStores: suspend (String) -> Unit,
  ) {
    val gateway = gatewayId.trim().takeIf { it.isNotEmpty() } ?: return
    synchronized(gatewayScopeApplyLock) {
      lastSelectedChatSessionByOwner.keys.removeAll { it.gatewayStableId == gateway }
    }
    synchronized(defaultAgentPersistenceRevisions) {
      defaultAgentPersistenceRevisions[gateway] = (defaultAgentPersistenceRevisions[gateway] ?: 0L) + 1L
    }
    if (lastVerifiedDefaultAgentGatewayId == gateway) {
      lastVerifiedDefaultAgentId = null
      lastVerifiedDefaultAgentGatewayId = null
      composerDefaultAgentOwnerMutable.value = null
    }
    // Serialize after invalidating the revision. An already-running save finishes first and is
    // deleted here; queued old-owner saves then fail their revision check after this unlocks.
    defaultAgentPersistenceMutex.withLock {
      cacheMutationMutex.withLock {
        clearStores(gateway)
      }
    }
  }

  /** Hydrates the live selection; a remounted screen must not reselect its captured previous chat. */
  fun loadCurrent(mainSessionKey: String) {
    synchronized(gatewayScopeApplyLock) {
      val key = _sessionKey.value.takeUnless { it.isBlank() || it == "main" } ?: mainSessionKey
      load(key, _sessionOwnerAgentId.value)
    }
  }

  /** Loads a chat session, normalizing "main" to the current gateway-provided main session key. */
  fun load(
    sessionKey: String,
    ownerAgentId: String? = null,
  ) {
    val key = normalizeRequestedSessionKey(sessionKey)
    val owner = normalizeSessionSelectionOwner(key, ownerAgentId)
    if (key == _sessionKey.value && owner == _sessionOwnerAgentId.value) {
      if (hasCurrentLiveHistory(key)) return
      refreshHistoryForRecovery(forceHealth = true)
      return
    }
    val generation = beginHistoryLoad(key, ownerAgentId = owner)
    bootstrap(sessionKey = key, generation = generation)
  }

  /** Rebinds chat to a new canonical main session key after gateway hello/agent changes. */
  fun applyMainSessionKey(mainSessionKey: String) {
    bindMainSessionKey(mainSessionKey, loadHistory = true)
  }

  /** Rebinds without loading; the connected lifecycle creates/adopts the session first. */
  internal fun prepareMainSessionKey(mainSessionKey: String) {
    bindMainSessionKey(mainSessionKey, loadHistory = false)
  }

  /** Selects a newly chosen agent's main session without racing history ahead of adoption. */
  internal fun prepareAndSelectMainSessionKey(mainSessionKey: String) {
    val selectedKey = mainSessionKey.trim()
    if (selectedKey.isEmpty()) return
    prepareSessionSelection(selectedKey)
    bindMainSessionKey(mainSessionKey, loadHistory = false)
    val key = normalizeRequestedSessionKey(mainSessionKey)
    if (_sessionKey.value != key || _sessionOwnerAgentId.value != resolveAgentIdFromMainSessionKey(key)) {
      beginHistoryLoad(
        key,
        ownerAgentId = resolveAgentIdFromMainSessionKey(key),
        refreshHealth = false,
      )
    }
  }

  /** Clears and reloads an unscoped chat when the gateway's routing owner changes. */
  internal fun onDefaultAgentChanged(agentId: String?) {
    // A disconnect makes routing temporarily unknown; retain the last verified owner's
    // offline projection until hello proves that ownership actually changed.
    val verifiedAgentId = agentId ?: return
    val previousAgentId = lastVerifiedDefaultAgentId
    lastVerifiedDefaultAgentId = verifiedAgentId
    val verifiedGatewayId = currentCacheScope()?.gatewayId
    lastVerifiedDefaultAgentGatewayId = verifiedGatewayId
    composerDefaultAgentOwnerMutable.value =
      verifiedGatewayId?.let { gatewayId -> GatewayDefaultAgentOwner(gatewayId, verifiedAgentId) }
    if (verifiedGatewayId != null) {
      val persistenceRevision =
        synchronized(defaultAgentPersistenceRevisions) {
          val next = (defaultAgentPersistenceRevisions[verifiedGatewayId] ?: 0L) + 1L
          defaultAgentPersistenceRevisions[verifiedGatewayId] = next
          next
        }
      // The live default is the only authoritative owner for unscoped keys. Persist it so an
      // offline process restart can reopen the same owner's cache without guessing.
      scope.launch {
        defaultAgentPersistenceMutex.withLock {
          val isLatest =
            synchronized(defaultAgentPersistenceRevisions) {
              defaultAgentPersistenceRevisions[verifiedGatewayId] == persistenceRevision
            }
          if (isLatest) {
            runCatching { transcriptCache?.saveLastDefaultAgentId(verifiedGatewayId, verifiedAgentId) }
          }
        }
      }
    }
    val key = normalizeRequestedSessionKey(_sessionKey.value)
    if (resolveAgentIdFromMainSessionKey(key) != null) return
    if (_sessionOwnerAgentId.value != null) return
    if (previousAgentId == verifiedAgentId) return
    // Session titles and model metadata are scoped to the default agent even when the visible
    // session alias stays unchanged. Empty first so offline bootstrap cannot reuse the old owner.
    _sessions.value = emptyList()
    sessionsListArchived = false
    sessionsListLimit = null
    val generation = beginHistoryLoad(key, ownerAgentId = null)
    bootstrap(sessionKey = key, generation = generation)
  }

  private fun bindMainSessionKey(
    mainSessionKey: String,
    loadHistory: Boolean,
  ) {
    val trimmed = mainSessionKey.trim()
    if (trimmed.isEmpty()) return
    val nextState =
      applyMainSessionKey(
        currentSessionKey = normalizeRequestedSessionKey(_sessionKey.value),
        appliedMainSessionKey = appliedMainSessionKey,
        nextMainSessionKey = trimmed,
      )
    appliedMainSessionKey = nextState.appliedMainSessionKey
    if (_sessionKey.value == nextState.currentSessionKey) return
    val generation =
      beginHistoryLoad(
        nextState.currentSessionKey,
        ownerAgentId = resolveAgentIdFromMainSessionKey(nextState.currentSessionKey),
        refreshHealth = loadHistory,
      )
    if (!loadHistory) return
    bootstrap(sessionKey = nextState.currentSessionKey, generation = generation)
  }

  /** Refreshes current chat history and session list without clearing optimistic messages first. */
  fun refresh() {
    updateErrorText(null)
    refreshHistoryForRecovery(forceHealth = true)
  }

  fun refreshSessions(
    limit: Int? = null,
    archived: Boolean = false,
  ) {
    scope.launch { fetchSessions(limit = limit, archived = archived) }
  }

  suspend fun patchSession(
    key: String,
    ownerAgentId: String? = null,
    expectedSessionId: String? = null,
    label: String? = null,
    clearLabel: Boolean = false,
    category: String? = null,
    clearCategory: Boolean = false,
    color: String? = null,
    clearColor: Boolean = false,
    pinned: Boolean? = null,
    archived: Boolean? = null,
    unread: Boolean? = null,
    unreadExpectation: ChatSessionUnreadExpectation? = null,
  ): Boolean {
    val sessionKey = key.trim().takeIf { it.isNotEmpty() } ?: return false
    val requestCacheScope = currentCacheScope()
    val capturedOwnerAgentId =
      resolveAgentIdFromMainSessionKey(sessionKey)
        ?: ownerAgentId?.trim()?.takeIf { it.isNotEmpty() }
        ?: if (sessionKey == _sessionKey.value) resolveAgentIdForSessionKey(sessionKey) else null
    val hasPatch =
      clearLabel ||
        label != null ||
        clearCategory ||
        category != null ||
        clearColor ||
        color != null ||
        pinned != null ||
        archived != null ||
        unread != null
    if (!hasPatch) return false
    val lifecycleSessionId = expectedSessionId?.trim()?.takeIf { it.isNotEmpty() }
    if (archived != null && lifecycleSessionId == null) {
      updateErrorText("Session lifecycle action requires a durable session identity.")
      return false
    }
    try {
      val params =
        buildJsonObject {
          put("key", JsonPrimitive(sessionKey))
          capturedOwnerAgentId?.let { put("agentId", JsonPrimitive(it)) }
          lifecycleSessionId?.let { put("expectedSessionId", JsonPrimitive(it)) }
          if (clearLabel) {
            put("label", JsonNull)
          } else if (label != null) {
            put("label", JsonPrimitive(label))
          }
          if (clearCategory) {
            put("category", JsonNull)
          } else if (category != null) {
            put("category", JsonPrimitive(category))
          }
          if (clearColor) {
            put("color", JsonNull)
          } else if (color != null) {
            put("color", JsonPrimitive(color))
          }
          if (pinned != null) put("pinned", JsonPrimitive(pinned))
          if (archived != null) put("archived", JsonPrimitive(archived))
          if (unread != null) put("unread", JsonPrimitive(unread))
          if (unreadExpectation != null) {
            val marker = unreadExpectation.markedUnreadAt
            put("expectedMarkedUnreadAt", marker?.let(::JsonPrimitive) ?: JsonNull)
          }
        }
      if (archived == true) {
        val defaultAgentRevision = currentDefaultAgentRevision().takeIf { activeSessionTracksDefaultAgent(sessionKey) }
        val rememberedOwner = capturedOwnerAgentId?.let { ChatAgentSessionSelectionOwner(requestCacheScope?.gatewayId, it) }
        val (selection, remembered) =
          synchronized(gatewayScopeApplyLock) {
            val active =
              currentSessionActionSnapshot(sessionKey)?.takeIf {
                it.gatewayScope == requestCacheScope &&
                  it.ownerAgentId == capturedOwnerAgentId?.lowercase() &&
                  _sessionId.value == lifecycleSessionId
              }
            val remembered =
              rememberedOwner
                ?.let { lastSelectedChatSessionByOwner[it] }
                ?.takeIf { it.key == sessionKey && (it.observedSessionId == null || it.observedSessionId == lifecycleSessionId) }
            active to remembered
          }
        val lease = captureRequestLease(requestCacheScope) ?: throw GatewayRequestNotEnqueued("not connected")
        lease.request("sessions.patch", params.toString(), 10 * 60_000L)
        lease.commitIfCurrent {
          synchronized(gatewayScopeApplyLock) {
            // ACK retirement belongs to the captured choice, even after an agent switch.
            // A newer explicit choice or a history-observed successor keeps its intent.
            if (
              requestCacheScope == currentCacheScope() &&
              rememberedOwner != null && remembered != null &&
              (remembered.observedSessionId == null || remembered.observedSessionId == lifecycleSessionId)
            ) {
              lastSelectedChatSessionByOwner.remove(rememberedOwner, remembered)
            }
            // Same-key history and default-owner changes need not move selection generation.
            // Only the selection captured at entry may navigate after the archive completes.
            if (
              selection != null &&
              isCurrentSessionAction(selection) &&
              _sessionId.value == lifecycleSessionId &&
              (defaultAgentRevision == null || defaultAgentRevision == currentDefaultAgentRevision())
            ) {
              fallBackFromRetiredActiveSession(sessionKey)
            }
          }
        }
      } else {
        requestGateway("sessions.patch", params.toString())
      }
      fetchSessionsForCurrentWindow()
      return true
    } catch (err: Throwable) {
      updateErrorText(err.message)
      return false
    }
  }

  /** Renames a session group everywhere: every member session moves to the new category. */
  suspend fun renameSessionGroup(
    from: String,
    to: String,
  ) {
    val fromName = from.trim().takeIf { it.isNotEmpty() } ?: return
    val toName = to.trim().takeIf { it.isNotEmpty() } ?: return
    patchSessionGroupMembers(group = fromName, category = toName)
  }

  /** Deletes a session group: member sessions are kept and move back to Ungrouped. */
  suspend fun dissolveSessionGroup(group: String) {
    val groupName = group.trim().takeIf { it.isNotEmpty() } ?: return
    patchSessionGroupMembers(group = groupName, category = null)
  }

  private suspend fun patchSessionGroupMembers(
    group: String,
    category: String?,
  ) {
    try {
      val ownerAgentId = resolveAgentIdForSessionKey(_sessionKey.value) ?: return
      var firstError: Throwable? = null
      for (member in listSessionGroupMembers(group, ownerAgentId)) {
        try {
          val params =
            buildJsonObject {
              put("key", JsonPrimitive(member.key))
              put("agentId", JsonPrimitive(ownerAgentId))
              put("category", category?.let(::JsonPrimitive) ?: JsonNull)
            }
          requestGateway("sessions.patch", params.toString())
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          // Best-effort: one failed member patch must not strand the rest of the group.
          if (firstError == null) firstError = err
        }
      }
      firstError?.let { updateErrorText(it.message) }
      fetchSessionsForCurrentWindow()
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      updateErrorText(err.message)
    }
  }

  /**
   * Enumerates every session assigned to the group. The UI session list is windowed
   * (limited, archived either-or), so group mutations must not derive membership from
   * it. An absent limit is capped at 100 rows server-side, so both queries send an
   * explicit high bound; sessions.list filters archived rows either-or, hence two calls.
   */
  private suspend fun listSessionGroupMembers(
    group: String,
    ownerAgentId: String,
  ): List<ChatSessionEntry> {
    val members = LinkedHashMap<String, ChatSessionEntry>()
    for (archived in listOf(false, true)) {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          put("agentId", JsonPrimitive(ownerAgentId))
          put("limit", JsonPrimitive(GROUP_MEMBER_FETCH_LIMIT))
          if (archived) put("archived", JsonPrimitive(true))
        }
      val rows = parseSessions(requestGateway("sessions.list", params.toString())).sessions
      for (row in rows) {
        if (row.category?.trim() == group && !members.containsKey(row.key)) members[row.key] = row
      }
    }
    return members.values.toList()
  }

  internal suspend fun deleteSession(
    key: String,
    ownerAgentId: String? = null,
  ): ChatSessionDeletion? {
    val sessionKey = key.trim().takeIf { it.isNotEmpty() } ?: return null
    val capturedOwnerAgentId =
      resolveAgentIdFromMainSessionKey(sessionKey)
        ?: ownerAgentId?.trim()?.takeIf { it.isNotEmpty() }
        ?: return null
    val requestCacheScope = currentCacheScope()
    val requestMainSessionKey = appliedMainSessionKey
    val deleted =
      try {
        val params =
          buildJsonObject {
            put("key", JsonPrimitive(sessionKey))
            put("agentId", JsonPrimitive(capturedOwnerAgentId))
            put("deleteTranscript", JsonPrimitive(true))
            // archive-then-delete: the bounded operator session lacks admin, and
            // the gateway grants write-scope deletes only for archived sessions.
            put("archivedOnly", JsonPrimitive(true))
          }
        val response = requestGatewayBound(requestCacheScope?.gatewayId, "sessions.delete", params.toString())
        json
          .parseToJsonElement(response)
          .asObjectOrNull()
          ?.get("deleted")
          .asBooleanOrNull() == true
      } catch (err: Throwable) {
        updateErrorText(err.message)
        return null
      }
    try {
      if (deleted) {
        removeSessionEntry(sessionKey, ownerAgentId = capturedOwnerAgentId, cacheScope = requestCacheScope)
      }
      fetchSessionsForCurrentWindow()
    } catch (err: Throwable) {
      updateErrorText(err.message)
    }
    return if (deleted) {
      ChatSessionDeletion(
        gatewayId = requestCacheScope?.gatewayId,
        agentId = capturedOwnerAgentId,
        sessionKey = sessionKey,
        mainSessionKey = requestMainSessionKey,
      )
    } else {
      null
    }
  }

  // Archiving or deleting the open chat must not leave the app focused on a
  // retired session; fall back to the gateway main session like web and iOS do.
  private fun fallBackFromRetiredActiveSession(retiredKey: String) {
    if (retiredKey != _sessionKey.value) return
    switchSession("main", rememberSelection = false)
  }

  suspend fun forkSession(
    parentKey: String,
    ownerAgentId: String? = null,
    fromLastCompleted: Boolean = false,
  ): String? {
    val sessionKey = parentKey.trim().takeIf { it.isNotEmpty() } ?: return null
    val requestCacheScope = currentCacheScope()
    val capturedOwnerAgentId =
      resolveAgentIdFromMainSessionKey(sessionKey)
        ?: ownerAgentId?.trim()?.takeIf { it.isNotEmpty() }
        ?: if (sessionKey == _sessionKey.value) resolveAgentIdForSessionKey(sessionKey) else null
    return try {
      val params =
        buildJsonObject {
          put("parentSessionKey", JsonPrimitive(sessionKey))
          put("fork", JsonPrimitive(true))
          if (fromLastCompleted) put("forkFrom", JsonPrimitive("last-completed"))
          // Keep the fork under the selected row's captured agent; omitting agentId can
          // create the child under a newer gateway default for unscoped parent keys.
          capturedOwnerAgentId?.let { put("agentId", JsonPrimitive(it)) }
        }
      val lease = captureRequestLease(requestCacheScope) ?: throw GatewayRequestNotEnqueued("not connected")
      val createdKey = parseCreatedSessionKey(json, requestSessionCreate(requestCacheScope, params, lease))
      fetchSessions(limit = sessionsListLimit, archived = false)
      createdKey
    } catch (err: Throwable) {
      updateErrorText(err.message)
      null
    }
  }

  internal data class SessionActionSnapshot(
    val gatewayScope: ChatCacheScope?,
    val sessionKey: String,
    val ownerAgentId: String,
    val selectionGeneration: Long,
  )

  private data class PublishedHistoryBranch(
    val snapshot: SessionActionSnapshot,
    val generation: Long,
    val state: ChatOutboxBranchState,
  )

  private data class ReconciledOutboxBranchScope(
    val gatewayScope: ChatCacheScope,
    val branchScope: ChatOutboxScope,
  )

  private data class SessionMutationLease(
    val durable: ChatOutboxMutationLease?,
  )

  private data class ActiveOutboxSessionMutation(
    val lease: ChatOutboxMutationLease,
    val expectedEventReason: String?,
  )

  private enum class BranchRefreshPurpose {
    ReadOnly,
    Reconcile,
    FinalizeMutation,
  }

  /** Rewinds the current transcript at one canonical history entry. */
  suspend fun rewindSessionAtEntry(
    sessionKey: String,
    entryId: String,
  ): String? = rewindSessionAtEntryResult(sessionKey, entryId)?.editorText

  suspend fun rewindSessionAtEntryResult(
    sessionKey: String,
    entryId: String,
  ): SessionRewindResult? {
    val entry = entryId.trim().takeIf { it.isNotEmpty() } ?: return null
    val snapshot = currentSessionActionSnapshot(sessionKey) ?: return null
    if (!canPerformMessageSessionAction(snapshot)) return null
    val mutationLease = beginOutboxSessionMutation(snapshot, expectedEventReason = "rewind") ?: return null
    if (!isCurrentSessionAction(snapshot)) {
      cancelOutboxSessionMutation(snapshot, mutationLease)
      return null
    }
    val actionHistoryGeneration = historyLoadGeneration.incrementAndGet()
    return try {
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(snapshot.sessionKey))
          put("agentId", JsonPrimitive(snapshot.ownerAgentId))
          put("entryId", JsonPrimitive(entry))
        }
      val root =
        json
          .parseToJsonElement(requestGatewayBound(snapshot.gatewayScope?.gatewayId, "sessions.rewind", params.toString()))
          .asObjectOrNull()
      if (!isCurrentSessionAction(snapshot)) {
        recoverOutboxAfterSessionMutationRefreshFailure(snapshot, mutationLease)
        return null
      }
      val editorText = root?.get("editorText").asStringOrNull()
      val historyApplied = refreshHistoryForSessionAction(snapshot, actionHistoryGeneration)
      val branchApplied =
        if (historyApplied != null) {
          refreshSessionBranches(
            snapshot,
            previousState = null,
            purpose = BranchRefreshPurpose.FinalizeMutation,
            mutationLease = mutationLease,
          )
        } else {
          false
        }
      if (!branchApplied) recoverOutboxAfterSessionMutationRefreshFailure(snapshot, mutationLease)
      SessionRewindResult(
        editorText = editorText,
        editorAttachments = parseSessionEditorAttachments(root?.get("editorAttachments")),
      )
    } catch (err: CancellationException) {
      withContext(NonCancellable) {
        recoverOutboxAfterSessionMutationRefreshFailure(snapshot, mutationLease)
      }
      throw err
    } catch (err: GatewayRequestDefinitiveFailure) {
      cancelOutboxSessionMutation(snapshot, mutationLease)
      reloadHistoryAfterDefinitiveSessionMutationFailure(snapshot)
      updateErrorText(err.message)
      null
    } catch (err: Throwable) {
      recoverOutboxAfterAmbiguousSessionMutation(snapshot, mutationLease)
      updateErrorText(err.message)
      null
    } finally {
      releaseOutboxSessionMutation(snapshot, mutationLease.durable)
    }
  }

  /** Forks the current transcript at one canonical history entry. */
  suspend fun forkSessionAtEntry(
    sessionKey: String,
    entryId: String,
  ): SessionForkResult? {
    val entry = entryId.trim().takeIf { it.isNotEmpty() } ?: return null
    val snapshot = currentSessionActionSnapshot(sessionKey) ?: return null
    if (!canPerformMessageSessionAction(snapshot)) return null
    val mutationLease = beginOutboxSessionMutation(snapshot, expectedEventReason = null) ?: return null
    if (!isCurrentSessionAction(snapshot)) {
      cancelOutboxSessionMutation(snapshot, mutationLease)
      return null
    }
    return try {
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(snapshot.sessionKey))
          put("agentId", JsonPrimitive(snapshot.ownerAgentId))
          put("entryId", JsonPrimitive(entry))
        }
      val root =
        json
          .parseToJsonElement(requestGatewayBound(snapshot.gatewayScope?.gatewayId, "sessions.fork", params.toString()))
          .asObjectOrNull()
      // Fork leaves the source branch unchanged; its durable lease is only an entry gate.
      cancelOutboxSessionMutation(snapshot, mutationLease)
      val createdKey =
        root
          ?.get("sessionKey")
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?: return null
      if (!isCurrentSessionAction(snapshot)) {
        fetchSessionsForCurrentWindow()
        return null
      }
      SessionForkResult(
        sessionKey = createdKey,
        editorText = root?.get("editorText").asStringOrNull(),
        editorAttachments = parseSessionEditorAttachments(root?.get("editorAttachments")),
      )
    } catch (err: CancellationException) {
      withContext(NonCancellable) {
        cancelOutboxSessionMutation(snapshot, mutationLease)
      }
      throw err
    } catch (err: Throwable) {
      // sessions.fork has no idempotency token, so an outcome-unknown retry can create a duplicate.
      // Web and Swift accept that recoverable extra session; protocol-level idempotency is the
      // follow-up rather than heuristic session-list matching here.
      cancelOutboxSessionMutation(snapshot, mutationLease)
      updateErrorText(err.message)
      null
    }
  }

  suspend fun listSessionBranches(sessionKey: String): List<SessionBranch>? {
    val snapshot = currentSessionActionSnapshot(sessionKey) ?: return null
    return try {
      requestSessionBranches(snapshot)
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      updateErrorText(err.message)
      null
    }
  }

  /** Atomically parks superseded outbox ownership before applying a branch switch. */
  suspend fun switchSessionBranch(
    sessionKey: String,
    leafEntryId: String,
  ): Boolean {
    val leaf = leafEntryId.trim().takeIf { it.isNotEmpty() } ?: return false
    val snapshot = currentSessionActionSnapshot(sessionKey) ?: return false
    if (!canSwitchSessionBranch(snapshot)) return false
    if (_sessionBranches.value.any { it.leafEntryId == leaf && it.active }) return false
    if (!sessionBranchSwitchClaimed.compareAndSet(false, true)) return false
    val switchGeneration = sessionBranchSwitchGeneration.incrementAndGet()
    _sessionBranchSwitching.value = true
    val mutationLease = beginOutboxSessionMutation(snapshot, expectedEventReason = "branch-switch")
    if (mutationLease == null) {
      if (switchGeneration == sessionBranchSwitchGeneration.get()) {
        sessionBranchSwitchClaimed.set(false)
        _sessionBranchSwitching.value = false
      }
      return false
    }
    if (!isCurrentBranchSwitch(snapshot, switchGeneration)) {
      cancelOutboxSessionMutation(snapshot, mutationLease)
      return false
    }
    val actionHistoryGeneration = historyLoadGeneration.incrementAndGet()
    return try {
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(snapshot.sessionKey))
          put("agentId", JsonPrimitive(snapshot.ownerAgentId))
          put("leafEntryId", JsonPrimitive(leaf))
        }
      requestGatewayBound(snapshot.gatewayScope?.gatewayId, "sessions.branches.switch", params.toString())
      val branchConfirmed = confirmOutboxBranchChange(snapshot, leaf, mutationLease)
      if (!isCurrentBranchSwitch(snapshot, switchGeneration)) return false
      val historyApplied = refreshHistoryForSessionAction(snapshot, actionHistoryGeneration)
      val branchesApplied =
        historyApplied?.let { refreshSessionBranches(snapshot, it.branchState, BranchRefreshPurpose.ReadOnly) } == true
      if (!branchConfirmed || historyApplied == null) recoverOutboxAfterSessionMutationRefreshFailure(snapshot, mutationLease)
      branchConfirmed && branchesApplied
    } catch (err: CancellationException) {
      withContext(NonCancellable) {
        recoverOutboxAfterSessionMutationRefreshFailure(snapshot, mutationLease)
      }
      throw err
    } catch (err: GatewayRequestDefinitiveFailure) {
      cancelOutboxSessionMutation(snapshot, mutationLease)
      reloadHistoryAfterDefinitiveSessionMutationFailure(snapshot)
      if (isCurrentSessionAction(snapshot)) updateErrorText(err.message)
      false
    } catch (err: Throwable) {
      recoverOutboxAfterAmbiguousSessionMutation(snapshot, mutationLease)
      if (isCurrentSessionAction(snapshot)) updateErrorText(err.message)
      false
    } finally {
      releaseOutboxSessionMutation(snapshot, mutationLease.durable)
      if (switchGeneration == sessionBranchSwitchGeneration.get()) {
        sessionBranchSwitchClaimed.set(false)
        _sessionBranchSwitching.value = false
      }
    }
  }

  suspend fun refreshSessionBranches(): Boolean {
    val snapshot = currentSessionActionSnapshot(_sessionKey.value) ?: return false
    val previousState = branchState(snapshot)
    val purpose =
      if (previousState?.needsReconciliation == true) {
        BranchRefreshPurpose.Reconcile
      } else {
        BranchRefreshPurpose.ReadOnly
      }
    return refreshSessionBranches(snapshot, previousState = previousState, purpose = purpose)
  }

  private fun currentSessionActionSnapshot(requestedSessionKey: String): SessionActionSnapshot? {
    val key = normalizeRequestedSessionKey(requestedSessionKey)
    if (key != _sessionKey.value) return null
    val owner = resolveAgentIdForSessionKey(key)?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    return SessionActionSnapshot(
      gatewayScope = currentCacheScope(),
      sessionKey = key,
      ownerAgentId = owner,
      selectionGeneration = chatSelectionGeneration.value,
    )
  }

  private fun isCurrentSessionAction(snapshot: SessionActionSnapshot): Boolean =
    snapshot.gatewayScope == currentCacheScope() &&
      snapshot.sessionKey == _sessionKey.value &&
      snapshot.ownerAgentId == resolveAgentIdForSessionKey(_sessionKey.value)?.trim()?.lowercase() &&
      snapshot.selectionGeneration == chatSelectionGeneration.value

  internal fun prepareFullMessageRead(
    owner: ChatComposerOwner,
    selectionGeneration: Long,
    catalogRevision: Long,
    message: ChatMessage,
  ): FullMessageRead? {
    val snapshot =
      synchronized(gatewayScopeApplyLock) {
        currentSessionActionSnapshot(owner.sessionKey)?.takeIf {
          it.selectionGeneration == selectionGeneration &&
            isCurrentFullMessage(it, owner, catalogRevision, message)
        }
      } ?: return null
    // Capture outside the logical lock: hello publishes physical -> logical -> catalog.
    val lease = captureRequestLease(snapshot.gatewayScope)
    return synchronized(gatewayScopeApplyLock) {
      if (!isCurrentFullMessage(snapshot, owner, catalogRevision, message)) return@synchronized null
      val unavailable =
        when {
          lease == null -> ChatFullMessageUnavailable.Disconnected
          gatewayAdvertisesMethod("chat.message.get") != true -> ChatFullMessageUnavailable.GatewayUpdate
          else -> null
        }
      FullMessageRead(snapshot, owner, catalogRevision, message, lease, unavailable)
    }
  }

  private fun isCurrentFullMessage(
    snapshot: SessionActionSnapshot,
    owner: ChatComposerOwner,
    catalogRevision: Long,
    message: ChatMessage,
  ): Boolean =
    isCurrentSessionAction(snapshot) &&
      isCurrentComposerOwner(owner) &&
      catalogRevision == currentGatewayCatalogRevision() &&
      _messages.value.any(message::matchesFullRead)

  /** The admitted read owns its outcome; nothing is published through a retained UI callback. */
  internal inner class FullMessageRead internal constructor(
    private val snapshot: SessionActionSnapshot,
    private val owner: ChatComposerOwner,
    private val catalogRevision: Long,
    private val message: ChatMessage,
    private val lease: GatewaySession.RequestLease?,
    unavailable: ChatFullMessageUnavailable?,
  ) {
    private val result = MutableStateFlow<ChatFullMessageState>(unavailable?.let(ChatFullMessageState::Unavailable) ?: ChatFullMessageState.Loading)
    val state: StateFlow<ChatFullMessageState> = result.asStateFlow()

    suspend fun execute() {
      val capturedLease = lease ?: return
      if (result.value != ChatFullMessageState.Loading) return
      val caller = currentCoroutineContext()
      caller.ensureActive()
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(snapshot.sessionKey))
          put("agentId", JsonPrimitive(snapshot.ownerAgentId))
          put("messageId", JsonPrimitive(message.entryId))
          put("maxChars", JsonPrimitive(FULL_MESSAGE_TEXT_MAX_CHARS))
        }.toString()
      val next =
        try {
          val response =
            capturedLease.request("chat.message.get", params) { enqueue ->
              // Selection retirement and dispatch are one decision, after any transport wait.
              synchronized(gatewayScopeApplyLock) {
                if (!isCurrentFullMessage(snapshot, owner, catalogRevision, message)) {
                  throw GatewayRequestNotEnqueued("full message read retired")
                }
                caller.ensureActive()
                enqueue()
              }
            }
          parseFullMessage(response, message.entryId)
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          ChatFullMessageState.Failed
        }
      capturedLease.commitIfCurrent {
        synchronized(gatewayScopeApplyLock) {
          if (caller.isActive && isCurrentFullMessage(snapshot, owner, catalogRevision, message)) {
            result.value = next
          }
        }
      }
    }
  }

  private fun parseFullMessage(
    payload: String,
    entryId: String?,
  ): ChatFullMessageState {
    val root =
      runCatching { json.parseToJsonElement(payload).asObjectOrNull() }.getOrNull()
        ?: return ChatFullMessageState.Failed
    if (root["ok"] == JsonPrimitive(false)) {
      // Only protocol-defined reasons are terminal; malformed replies remain retryable.
      val reason =
        when (root["unavailableReason"].asJsonStringOrNull()) {
          "not_found", "not_visible" -> ChatFullMessageUnavailable.NotFound
          "oversized" -> ChatFullMessageUnavailable.TooLarge
          else -> return ChatFullMessageState.Failed
        }
      return ChatFullMessageState.Unavailable(reason)
    }
    val obj = root["message"].asObjectOrNull()
    if (root["ok"] != JsonPrimitive(true) ||
      obj == null ||
      obj["role"].asJsonStringOrNull() != "assistant" ||
      obj["__openclaw"].asObjectOrNull()?.get("id").asJsonStringOrNull() != entryId
    ) {
      return ChatFullMessageState.Failed
    }
    val parsed = parseMessage(obj, FULL_MESSAGE_TEXT_MAX_CHARS) ?: return ChatFullMessageState.Failed
    if (parsed.isSyntheticDisplay) return ChatFullMessageState.Failed
    // The canonical get projection is bounded too; ok:true does not promise complete text.
    if (parsed.truncated) return ChatFullMessageState.Unavailable(ChatFullMessageUnavailable.TooLarge)
    if (parsed.content.none { it.type == "text" && !it.text.isNullOrBlank() }) {
      return ChatFullMessageState.Failed
    }
    return ChatFullMessageState.Loaded(parsed.content)
  }

  private fun isCurrentBranchSwitch(
    snapshot: SessionActionSnapshot,
    switchGeneration: Long,
  ): Boolean =
    isCurrentSessionAction(snapshot) &&
      switchGeneration == sessionBranchSwitchGeneration.get() &&
      _sessionBranchSwitching.value

  private fun SessionActionSnapshot.outboxScope(): ChatOutboxScope = ChatOutboxScope(sessionKey = sessionKey, ownerAgentId = ownerAgentId)

  private fun ChatOutboxItem.outboxScope(): ChatOutboxScope? {
    val owner = ownerAgentId ?: resolveAgentIdFromMainSessionKey(sessionKey) ?: return null
    return ChatOutboxScope(normalizeRequestedSessionKey(sessionKey), owner.trim().lowercase())
  }

  private fun reconciledOutboxBranchScope(
    gatewayScope: ChatCacheScope?,
    branchScope: ChatOutboxScope,
  ): ReconciledOutboxBranchScope? = gatewayScope?.let { ReconciledOutboxBranchScope(it, branchScope) }

  private fun isOutboxBranchReconciled(
    gatewayScope: ChatCacheScope?,
    branchScope: ChatOutboxScope,
  ): Boolean = reconciledOutboxBranchScope(gatewayScope, branchScope)?.let(reconciledOutboxBranchScopes::contains) == true

  private fun markOutboxBranchReconciled(
    gatewayScope: ChatCacheScope?,
    branchScope: ChatOutboxScope,
  ): Boolean {
    val key = reconciledOutboxBranchScope(gatewayScope, branchScope) ?: return false
    if (gatewayScope != currentCacheScope()) return false
    reconciledOutboxBranchScopes.add(key)
    return true
  }

  private fun markOutboxBranchUnreconciled(
    gatewayScope: ChatCacheScope?,
    branchScope: ChatOutboxScope,
  ) {
    reconciledOutboxBranchScope(gatewayScope, branchScope)?.let(reconciledOutboxBranchScopes::remove)
  }

  private fun trackOutboxSessionMutation(
    snapshot: SessionActionSnapshot,
    lease: ChatOutboxMutationLease,
    expectedEventReason: String?,
  ) {
    val key = reconciledOutboxBranchScope(snapshot.gatewayScope, snapshot.outboxScope()) ?: return
    synchronized(outboxSessionMutationEventLock) {
      activeOutboxSessionMutations[key] = ActiveOutboxSessionMutation(lease, expectedEventReason)
    }
  }

  private fun releaseOutboxSessionMutation(
    snapshot: SessionActionSnapshot,
    lease: ChatOutboxMutationLease?,
  ) {
    val durable = lease ?: return
    val key = reconciledOutboxBranchScope(snapshot.gatewayScope, snapshot.outboxScope()) ?: return
    val reconcileDeferredEvent =
      synchronized(outboxSessionMutationEventLock) {
        val active = activeOutboxSessionMutations[key]
        if (active?.lease == durable) {
          activeOutboxSessionMutations.remove(key, active)
        }
        val deferredLeases = deferredOutboxSessionMutationEvents[key]
        val deferred = deferredLeases?.remove(durable) == true
        if (deferredLeases?.isEmpty() == true) deferredOutboxSessionMutationEvents.remove(key)
        deferred
      }
    if (reconcileDeferredEvent) {
      scheduleSessionsChangedBranchReconciliation(
        eventGatewayScope = snapshot.gatewayScope,
        sessionKey = snapshot.sessionKey,
        ownerAgentId = snapshot.ownerAgentId,
        matchingScopes = setOf(snapshot.outboxScope()),
      )
    }
  }

  private fun deferOutboxSessionMutationEventIfActive(
    gatewayScope: ChatCacheScope?,
    branchScope: ChatOutboxScope,
    expectedEventReason: String?,
  ): Boolean {
    val key = reconciledOutboxBranchScope(gatewayScope, branchScope) ?: return false
    synchronized(outboxSessionMutationEventLock) {
      val active = activeOutboxSessionMutations[key] ?: return false
      if (active.expectedEventReason != expectedEventReason) return false
      deferredOutboxSessionMutationEvents.getOrPut(key) { mutableSetOf() }.add(active.lease)
      return true
    }
  }

  private fun outboxItemMatches(
    item: ChatOutboxItem,
    snapshot: SessionActionSnapshot,
  ): Boolean = item.outboxScope() == snapshot.outboxScope()

  private fun canPerformMessageSessionAction(snapshot: SessionActionSnapshot): Boolean =
    _pendingRunCount.value == 0 &&
      !_sessionBranchSwitching.value &&
      _outboxPresentationRestored.value &&
      _outboxItems.value.none { item ->
        outboxItemMatches(item, snapshot) && item.status != ChatOutboxStatus.Failed
      }

  private fun canSwitchSessionBranch(snapshot: SessionActionSnapshot): Boolean =
    _pendingRunCount.value == 0 &&
      !_sessionBranchSwitching.value &&
      _outboxPresentationRestored.value &&
      _outboxItems.value.none { outboxItemMatches(it, snapshot) }

  private suspend fun beginOutboxSessionMutation(
    snapshot: SessionActionSnapshot,
    expectedEventReason: String?,
  ): SessionMutationLease? {
    val outbox = commandOutbox ?: return SessionMutationLease(durable = null)
    if (!outbox.supportsBranchCoordination) {
      return if (_outboxItems.value.none { outboxItemMatches(it, snapshot) && it.status != ChatOutboxStatus.Failed }) {
        SessionMutationLease(durable = null)
      } else {
        null
      }
    }
    val gatewayId = snapshot.gatewayScope?.gatewayId ?: return null
    var durable = outbox.beginSessionMutation(gatewayId, snapshot.outboxScope(), System.currentTimeMillis())
    if (durable == null) {
      val branchState = outbox.branchState(gatewayId, snapshot.outboxScope())
      if (branchState?.needsReconciliation == true) {
        markOutboxBranchUnreconciled(snapshot.gatewayScope, snapshot.outboxScope())
        if (refreshSessionBranches(snapshot, branchState, BranchRefreshPurpose.Reconcile)) {
          durable = outbox.beginSessionMutation(gatewayId, snapshot.outboxScope(), System.currentTimeMillis())
        }
      }
    }
    durable ?: return null
    trackOutboxSessionMutation(snapshot, durable, expectedEventReason)
    return SessionMutationLease(durable)
  }

  private suspend fun cancelOutboxSessionMutation(
    snapshot: SessionActionSnapshot,
    mutationLease: SessionMutationLease,
  ) {
    val outbox = commandOutbox ?: return
    if (!outbox.supportsBranchCoordination) return
    val durable = mutationLease.durable ?: return
    val gatewayId = snapshot.gatewayScope?.gatewayId ?: return
    outbox.cancelSessionMutation(gatewayId, snapshot.outboxScope(), durable)
    releaseOutboxSessionMutation(snapshot, durable)
  }

  private suspend fun recoverOutboxAfterSessionMutationRefreshFailure(
    snapshot: SessionActionSnapshot,
    mutationLease: SessionMutationLease,
    requestReconciliation: Boolean = true,
    preserveReconciliationState: Boolean = false,
  ): ChatOutboxBranchState? {
    val outbox = commandOutbox ?: return null
    if (!outbox.supportsBranchCoordination) return null
    val gatewayId = snapshot.gatewayScope?.gatewayId ?: return null
    markOutboxBranchUnreconciled(snapshot.gatewayScope, snapshot.outboxScope())
    val reconciliationState =
      outbox.demoteSessionMutationToReconciliationState(gatewayId, snapshot.outboxScope(), mutationLease.durable)
    if (preserveReconciliationState && reconciliationState != null) {
      // Publish before lease release so newly admitted turns can follow the authoritative branch.
      // A restart loses this process hint and safely parks them instead.
      reconciledOutboxBranchScope(snapshot.gatewayScope, snapshot.outboxScope())?.let { key ->
        ambiguousMutationReconciliationStates[key] = reconciliationState
      }
    }
    releaseOutboxSessionMutation(snapshot, mutationLease.durable)
    if (requestReconciliation && _healthOk.value) requestOutboxFlush()
    return reconciliationState
  }

  private suspend fun recoverOutboxAfterAmbiguousSessionMutation(
    snapshot: SessionActionSnapshot,
    mutationLease: SessionMutationLease,
  ) {
    val previousState =
      recoverOutboxAfterSessionMutationRefreshFailure(
        snapshot,
        mutationLease,
        requestReconciliation = false,
        preserveReconciliationState = true,
      )
    val reconciliationKey = reconciledOutboxBranchScope(snapshot.gatewayScope, snapshot.outboxScope())
    val generation = historyLoadGeneration.incrementAndGet()
    val historyApplied = refreshHistoryForSessionAction(snapshot, generation, previousState)
    val branchesApplied =
      historyApplied?.let { refreshSessionBranches(snapshot, it.branchState, BranchRefreshPurpose.Reconcile) } == true
    if (branchesApplied && reconciliationKey != null && previousState != null) {
      ambiguousMutationReconciliationStates.remove(reconciliationKey, previousState)
    }
    if (!branchesApplied && _healthOk.value) requestOutboxFlush()
  }

  private suspend fun confirmOutboxBranchChange(
    snapshot: SessionActionSnapshot,
    activeLeafEntryId: String?,
    mutationLease: SessionMutationLease,
  ): Boolean {
    val outbox = commandOutbox ?: return true
    if (!outbox.supportsBranchCoordination) return true
    val gatewayId = snapshot.gatewayScope?.gatewayId ?: return false
    val scope = snapshot.outboxScope()
    markOutboxBranchUnreconciled(snapshot.gatewayScope, scope)
    val confirmed =
      outbox.confirmBranchChange(
        gatewayId,
        scope,
        activeLeafEntryId,
        OUTBOX_BRANCH_CHANGED_ERROR,
        mutationLease.durable,
      )
    if (confirmed) {
      markOutboxBranchReconciled(snapshot.gatewayScope, scope)
      publishOutbox()
      requestOutboxFlush()
    }
    return confirmed
  }

  private suspend fun branchState(snapshot: SessionActionSnapshot): ChatOutboxBranchState? {
    val outbox = commandOutbox ?: return null
    if (!outbox.supportsBranchCoordination) return null
    val gatewayId = snapshot.gatewayScope?.gatewayId ?: return null
    return outbox.branchState(gatewayId, snapshot.outboxScope())
  }

  private suspend fun requestSessionBranches(snapshot: SessionActionSnapshot): List<SessionBranch> =
    requestSessionBranches(
      gatewayId = snapshot.gatewayScope?.gatewayId,
      sessionKey = snapshot.sessionKey,
      ownerAgentId = snapshot.ownerAgentId,
    )

  private suspend fun requestSessionBranches(
    gatewayId: String?,
    sessionKey: String,
    ownerAgentId: String,
  ): List<SessionBranch> {
    if (gatewayAdvertisesMethod("sessions.branches.list") == false) throw BranchListingUnsupportedException()
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(sessionKey))
        put("agentId", JsonPrimitive(ownerAgentId))
      }
    val root =
      json
        .parseToJsonElement(requestGatewayBound(gatewayId, "sessions.branches.list", params.toString()))
        .asObjectOrNull()
        ?: throw IllegalStateException("sessions.branches.list returned an invalid response")
    val entries =
      root["branches"].asArrayOrNull()
        ?: throw IllegalStateException("sessions.branches.list returned invalid branches")
    return entries.map { element ->
      val obj =
        element.asObjectOrNull()
          ?: throw IllegalStateException("sessions.branches.list returned an invalid branch")
      val leaf =
        obj["leafEntryId"]
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?: throw IllegalStateException("sessions.branches.list returned a branch without a leaf")
      val headline =
        obj["headline"].asStringOrNull()
          ?: throw IllegalStateException("sessions.branches.list returned a branch without a headline")
      val messageCount =
        obj["messageCount"]
          .asLongOrNull()
          ?.takeIf { it >= 0 }
          ?.coerceAtMost(Int.MAX_VALUE.toLong())
          ?.toInt()
          ?: throw IllegalStateException("sessions.branches.list returned an invalid message count")
      val active =
        obj["active"].asBooleanOrNull()
          ?: throw IllegalStateException("sessions.branches.list returned an invalid active flag")
      val updatedAt =
        obj["updatedAt"]?.let { value ->
          when (value) {
            JsonNull -> {
              null
            }

            else -> {
              value.asStringOrNull()
                ?: throw IllegalStateException("sessions.branches.list returned an invalid timestamp")
            }
          }
        }
      SessionBranch(
        leafEntryId = leaf,
        headline = headline,
        messageCount = messageCount,
        updatedAt = updatedAt,
        active = active,
      )
    }
  }

  private fun activeBranchLeafEntryId(branches: List<SessionBranch>): String? =
    branches
      .singleOrNull { it.active }
      ?.leafEntryId
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

  private suspend fun refreshSessionBranches(
    snapshot: SessionActionSnapshot,
    previousState: ChatOutboxBranchState?,
    purpose: BranchRefreshPurpose,
    mutationLease: SessionMutationLease? = null,
  ): Boolean {
    val generation = sessionBranchesRefreshGeneration.incrementAndGet()
    val historySequence = synchronized(gatewayScopeApplyLock) { latestAppliedHistoryRequest }

    fun isCurrent(): Boolean =
      synchronized(gatewayScopeApplyLock) {
        isCurrentSessionAction(snapshot) &&
          generation == sessionBranchesRefreshGeneration.get() &&
          historySequence == latestAppliedHistoryRequest
      }
    if (isCurrentSessionAction(snapshot)) _sessionBranchesLoading.value = true
    return try {
      val branches = requestSessionBranches(snapshot)
      if (!isCurrent()) return false
      val activeLeaf = if (branches.isEmpty()) null else activeBranchLeafEntryId(branches) ?: return false
      val outbox = commandOutbox
      val gatewayId = snapshot.gatewayScope?.gatewayId
      val scope = snapshot.outboxScope()
      val stateApplied =
        when {
          outbox == null || !outbox.supportsBranchCoordination -> {
            true
          }

          gatewayId == null -> {
            false
          }

          purpose == BranchRefreshPurpose.FinalizeMutation -> {
            confirmOutboxBranchChange(snapshot, activeLeaf, mutationLease ?: return false)
          }

          previousState == null || (purpose == BranchRefreshPurpose.ReadOnly && previousState.needsReconciliation) -> {
            false
          }

          else -> {
            outbox.reconcileBranchScope(
              gatewayId = gatewayId,
              scope = scope,
              evidence = ChatOutboxBranchEvidence.BranchListing(previousState, branches.mapTo(mutableSetOf()) { it.leafEntryId }),
              activeLeafEntryId = activeLeaf,
              activeTranscriptEntryIds = _messages.value.mapNotNullTo(mutableSetOf()) { it.entryId },
              lastError = OUTBOX_BRANCH_CHANGED_ERROR,
            ) != null
          }
        }
      if (!stateApplied) return false
      synchronized(gatewayScopeApplyLock) {
        if (!isCurrent()) return false
        if (outbox?.supportsBranchCoordination == true && !markOutboxBranchReconciled(snapshot.gatewayScope, scope)) {
          return false
        }
        _sessionBranches.value = branches
      }
      publishOutbox()
      requestOutboxFlush()
      true
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      if (!isCurrent()) return false
      if (branchListingUnsupported(err)) {
        if (
          purpose == BranchRefreshPurpose.FinalizeMutation ||
          previousState?.needsReconciliation == true ||
          previousState?.switchPendingSinceMs != null
        ) {
          return false
        }
        val outbox = commandOutbox
        outbox?.supportsBranchCoordination != true ||
          markOutboxBranchReconciled(snapshot.gatewayScope, snapshot.outboxScope())
      } else {
        false
      }
    } finally {
      if (isCurrentSessionAction(snapshot) && generation == sessionBranchesRefreshGeneration.get()) {
        _sessionBranchesLoading.value = false
      }
    }
  }

  private fun branchListingUnsupported(error: Throwable): Boolean =
    error is BranchListingUnsupportedException ||
      error.message?.contains("unknown method: sessions.branches.list", ignoreCase = true) == true

  private suspend fun refreshHistoryForSessionAction(
    snapshot: SessionActionSnapshot,
    generation: Long,
    mutationReconciliationState: ChatOutboxBranchState? = null,
  ): HistoryRefreshResult.Applied? {
    if (!isCurrentSessionAction(snapshot)) return null
    return try {
      fetchAndApplyHistory(
        sessionKey = snapshot.sessionKey,
        generation = generation,
        updateSessionInfo = true,
        mutationReconciliationState = mutationReconciliationState,
      ) as? HistoryRefreshResult.Applied
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun reloadHistoryAfterDefinitiveSessionMutationFailure(snapshot: SessionActionSnapshot) {
    if (!isCurrentSessionAction(snapshot)) return
    val generation = historyLoadGeneration.incrementAndGet()
    refreshHistoryForSessionAction(snapshot, generation)
  }

  /**
   * One-shot session list for the search UI; does not touch the live list
   * state. Falls back to locally filtering the cached active list when the
   * gateway is unreachable; archived rows exist only server-side, so archived
   * search is empty offline.
   */
  suspend fun fetchSessionList(
    search: String?,
    archived: Boolean,
  ): List<ChatSessionEntry> {
    val query = search?.trim()?.takeIf { it.isNotEmpty() }
    val requestCacheScope = currentCacheScope()
    val requestSessionKey = _sessionKey.value
    val requestTracksDefaultAgent = activeSessionTracksDefaultAgent(requestSessionKey)
    val requestDefaultAgentRevision = currentDefaultAgentRevision()
    val ownerAgentId =
      resolveAgentIdForSessionKey(requestSessionKey)
        ?: return when {
          archived -> emptyList()
          query == null -> _sessions.value
          else -> filterSessionEntries(_sessions.value, query)
        }

    fun requestOwnerIsCurrent(): Boolean {
      val currentAgentId = resolveAgentIdForSessionKey(_sessionKey.value)
      return requestCacheScope == currentCacheScope() &&
        currentAgentId == ownerAgentId &&
        (!requestTracksDefaultAgent || currentDefaultAgentRevision() == requestDefaultAgentRevision)
    }
    return try {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          put("agentId", JsonPrimitive(ownerAgentId))
          put("limit", JsonPrimitive(SESSION_LIST_FETCH_LIMIT))
          if (query != null) put("search", JsonPrimitive(query))
          if (archived) put("archived", JsonPrimitive(true))
        }
      val sessions = parseSessions(requestGateway("sessions.list", params.toString())).sessions
      if (!requestOwnerIsCurrent()) return emptyList()
      sessions.map { session ->
        session.copy(ownerAgentId = ownerAgentId)
      }
    } catch (err: CancellationException) {
      // A superseded search owns the results now; never repaint stale fallback rows.
      throw err
    } catch (_: Throwable) {
      if (!requestOwnerIsCurrent()) return emptyList()
      when {
        archived -> emptyList()
        query == null -> _sessions.value
        else -> filterSessionEntries(_sessions.value, query)
      }
    }
  }

  /** Loads sessions for another agent without changing the visible chat owner. */
  internal suspend fun fetchSessionSelectionCandidates(agentId: String): List<ChatSessionEntry>? {
    val ownerAgentId = agentId.trim().takeIf(String::isNotEmpty) ?: return emptyList()
    val requestCacheScope = currentCacheScope()
    val cachedSessions =
      try {
        requestCacheScope
          ?.let { cacheScope ->
            transcriptCache
              ?.loadSessions(cacheScope.gatewayId, ownerAgentId)
              .orEmpty()
              .map { session -> session.copy(ownerAgentId = ownerAgentId) }
          }.orEmpty()
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        emptyList()
      }
    if (requestCacheScope == null) return cachedSessions

    return try {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          put("agentId", JsonPrimitive(ownerAgentId))
          put("limit", JsonPrimitive(SESSION_LIST_FETCH_LIMIT))
        }
      parseSessions(
        requestGatewayBound(requestCacheScope.gatewayId, "sessions.list", params.toString()),
      ).sessions
        .map { session -> session.copy(ownerAgentId = ownerAgentId) }
        .takeIf { requestCacheScope == currentCacheScope() }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      cachedSessions.takeIf { requestCacheScope == currentCacheScope() }
    }
  }

  /** Starts a fresh chat for the active gateway session key. */
  fun startNewChat(worktree: Boolean = false) {
    scope.launch { startNewChatAwait(worktree = worktree) }
  }

  /** Starts a fresh chat and returns whether the gateway created the session. */
  suspend fun startNewChatAwait(
    worktree: Boolean = false,
    catalogId: String? = null,
  ): Boolean {
    val createContext = currentCoroutineContext()
    createContext.ensureActive()
    val selection: SessionActionSnapshot
    val parentSessionId: String?
    val defaultAgentRevision: Long?
    synchronized(gatewayScopeApplyLock) {
      selection = currentSessionActionSnapshot(_sessionKey.value) ?: return false
      parentSessionId = _sessionId.value
      defaultAgentRevision = currentDefaultAgentRevision().takeIf { activeSessionTracksDefaultAgent(selection.sessionKey) }
    }
    val createGatewayScope = selection.gatewayScope
    val parentKey = selection.sessionKey
    val ownerAgentId = selection.ownerAgentId
    if (_pendingRunCount.value > 0) {
      updateLocalizedErrorText(nativeText("Wait for the current response to finish before starting a new chat."))
      return false
    }
    if (!newChatCreateInFlight.compareAndSet(false, true)) {
      return false
    }
    val lease = captureRequestLease(createGatewayScope)
    var loadingGeneration: Long? = null

    fun <T> applyIfCurrent(action: () -> T): T? {
      var result: T? = null

      fun apply() {
        synchronized(gatewayScopeApplyLock) {
          // History refreshes do not cancel New. Selection, known parent identity,
          // routing-owner changes, and the captured socket still fence navigation.
          if (
            isCurrentSessionAction(selection) &&
            (parentSessionId == null || parentSessionId == _sessionId.value) &&
            (defaultAgentRevision == null || defaultAgentRevision == currentDefaultAgentRevision())
          ) {
            result = action()
          }
        }
      }
      if (lease == null) apply() else lease.commitIfCurrent(::apply)
      return result
    }
    val normalizedCatalogId = catalogId?.trim()?.takeIf(String::isNotEmpty)
    return try {
      loadingGeneration =
        applyIfCurrent {
          createContext.ensureActive()
          updateErrorText(null)
          _historyLoading.value = true
          historyLoadGeneration.get()
        }
      if (loadingGeneration == null) return false
      if (lease == null) throw GatewayRequestNotEnqueued("not connected")
      val inheritParent =
        synchronized(gatewayScopeApplyLock) {
          // Plain New starts independently of a native thread. Explicit worktree
          // requests retain their parent so the creation guard can reject them.
          !_sessionId.value.isNullOrBlank() &&
            (worktree || !isSessionModelSelectionLocked(sessionSettingsKey(parentKey, createGatewayScope, ownerAgentId)))
        }
      val params =
        buildJsonObject {
          put("agentId", JsonPrimitive(ownerAgentId))
          if (normalizedCatalogId != null) {
            put("catalogId", JsonPrimitive(normalizedCatalogId))
          } else {
            if (inheritParent) {
              put("parentSessionKey", JsonPrimitive(parentKey))
              put("emitCommandHooks", JsonPrimitive(true))
              put("succeedsParent", JsonPrimitive(false))
            }
            if (worktree) put("worktree", JsonPrimitive(true))
          }
        }
      val res = requestSessionCreate(createGatewayScope, params, lease)
      val createdKey = parseCreatedSessionKey(json, res) ?: parentKey
      val generation =
        applyIfCurrent {
          createContext.ensureActive()
          beginHistoryLoad(
            createdKey,
            ownerAgentId = ownerAgentId,
            rememberSelection = true,
          )
        } ?: return false
      bootstrap(sessionKey = createdKey, generation = generation).await()
      true
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      applyIfCurrent { updateErrorText(err.message) }
      false
    } finally {
      applyIfCurrent {
        if (loadingGeneration == historyLoadGeneration.get()) _historyLoading.value = false
      }
      newChatCreateInFlight.set(false)
    }
  }

  /** Refreshes the available text slash commands for the current gateway. */
  fun refreshCommands() {
    // Retire old reads before queued work runs; keep the last accepted same-scope catalog.
    val requestSequence = chatMetadataRequestSequence.incrementAndGet()
    scope.launch { fetchChatMetadata(requestSequence) }
  }

  /** Updates or clears the explicit Fast Mode override for future runs in one session. */
  fun setSessionFastMode(
    sessionKey: String,
    enabled: Boolean,
    clearOverride: Boolean = false,
  ) {
    val mode =
      if (clearOverride) {
        null
      } else if (enabled) {
        ChatFastMode.On
      } else {
        ChatFastMode.Off
      }
    val queued = enqueueSessionSettingsMutation(sessionSettingsKey(normalizeRequestedSessionKey(sessionKey)))
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      runSessionSettingsMutation(queued, SessionSettingsChange.FastMode(mode))
    }
  }

  /** Persists the normalized thinking level used for subsequent chat sends. */
  fun setThinkingLevel(thinkingLevel: String) {
    val normalized = normalizeThinking(thinkingLevel)
    val selection = _thinkingLevelSelection.value
    if (selection.isGatewayProvided && selection.options.none { it.id == normalized }) return
    if (normalized == _thinkingLevel.value) return
    val key = normalizeRequestedSessionKey(_sessionKey.value)
    val queued = enqueueSessionSettingsMutation(sessionSettingsKey(key), ThinkingIntent(normalized))
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      runSessionSettingsMutation(queued, SessionSettingsChange.Thinking(normalized))
    }
  }

  fun setSessionPermissionMode(
    sessionKey: String,
    permissionMode: ChatPermissionMode?,
  ) {
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      setSessionPermissionModeAwait(sessionKey, permissionMode)
    }
  }

  internal fun canSetSessionPermissionMode(): Boolean =
    gatewayAdvertisesMethod("sessions.patch") == true &&
      gatewayAdvertisesCapability("session-settings-contract") == true &&
      gatewayAdvertisesCapability("session-settings-cas-v1") == true

  internal suspend fun setSessionPermissionModeAwait(
    sessionKey: String,
    permissionMode: ChatPermissionMode?,
  ): Boolean {
    if (!canSetSessionPermissionMode()) {
      updateLocalizedErrorText(nativeText("Update the Gateway to change session permissions."))
      return false
    }
    // A queued permission change keeps the identity and policy the operator saw,
    // rather than adopting a reset session or another client's later selection.
    val (settingsKey, change) =
      synchronized(gatewayScopeApplyLock) {
        val key = sessionSettingsKey(normalizeRequestedSessionKey(sessionKey))
        val entry = _sessions.value.firstOrNull { it.key == key.sessionKey }
        val sessionId = entry?.sessionId?.takeIf { it.isNotBlank() }
        if (entry == null || sessionId == null) {
          updateLocalizedErrorText(nativeText("Refresh this chat before changing permissions."))
          return false
        }
        key to SessionSettingsChange.Permission(permissionMode, sessionId, entry.permissionMode)
      }
    return runSessionSettingsMutation(enqueueSessionSettingsMutation(settingsKey), change)
  }

  fun setSessionModel(
    sessionKey: String,
    modelRef: String?,
  ) {
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      setSessionModelAwait(sessionKey, modelRef)
    }
  }

  internal suspend fun setSessionModelAwait(
    sessionKey: String,
    modelRef: String?,
  ): Boolean =
    runSessionSettingsMutation(
      enqueueSessionSettingsMutation(sessionSettingsKey(normalizeRequestedSessionKey(sessionKey))),
      SessionSettingsChange.Model(modelRef?.trim()?.takeIf(String::isNotEmpty)),
    )

  private fun enqueueSessionSettingsMutation(
    settingsKey: SessionSettingsKey,
    thinkingIntent: ThinkingIntent? = null,
  ): QueuedSessionSettingsMutation {
    // Capture the physical socket before taking the data lock or waiting for a predecessor.
    val requestLease = captureRequestLease(settingsKey.gatewayScope)
    val pending = CompletableDeferred<Boolean>()
    return synchronized(gatewayScopeApplyLock) {
      val previousLane = pendingSettingsMutations[settingsKey]
      val previous = previousLane?.tail
      val existing = _sessions.value.firstOrNull { it.key == settingsKey.sessionKey }
      val lane =
        previousLane ?: SessionSettingsLane(
          tail = pending,
          confirmed =
            existing
              ?: ChatSessionEntry(
                key = settingsKey.sessionKey,
                updatedAtMs = null,
                ownerAgentId = settingsKey.ownerAgentId,
                thinkingLevels =
                  _thinkingLevelSelection.value.options.takeIf {
                    settingsKey.sessionKey == _sessionKey.value && _thinkingLevelSelection.value.isGatewayProvided
                  },
              ),
          confirmedThinkingLevel =
            if (settingsKey.sessionKey == _sessionKey.value) _thinkingLevel.value else existing?.thinkingLevel ?: "off",
        )
      lane.tail = pending
      pendingSettingsMutations[settingsKey] = lane
      if (thinkingIntent != null) {
        lane.thinkingIntent = thinkingIntent
        _thinkingLevel.value = thinkingIntent.level
      }
      // A successor blocked on reconciliation cannot change the server until
      // that read publishes; enqueueing it must not invalidate its own barrier.
      if (lane.reconciliation?.pending?.isCompleted != false) incrementSettingsMutationRevision(settingsKey.gatewayScope)
      publishPendingSessionSettingsKeys()
      QueuedSessionSettingsMutation(settingsKey, requestLease, lane, pending, previous, thinkingIntent)
    }
  }

  private suspend fun runSessionSettingsMutation(
    queued: QueuedSessionSettingsMutation,
    change: SessionSettingsChange,
  ): Boolean {
    val settingsKey = queued.settingsKey
    val lane = queued.lane
    val lease = queued.requestLease
    var dispatchObservation: Any? = null
    var succeeded = false

    fun ownsLane(): Boolean =
      settingsKey == sessionSettingsKey(settingsKey.sessionKey) &&
        pendingSettingsMutations[settingsKey] === lane

    return try {
      queued.previous?.await()
      synchronized(gatewayScopeApplyLock) {
        if (!ownsLane()) return false
        updateErrorText(null)
      }
      val capturedLease = lease ?: throw GatewayRequestNotEnqueued("not connected")
      val params =
        buildJsonObject {
          put("key", JsonPrimitive(settingsKey.sessionKey))
          settingsKey.ownerAgentId?.let { put("agentId", JsonPrimitive(it)) }
          when (change) {
            is SessionSettingsChange.Model -> {
              put("model", change.ref?.let(::JsonPrimitive) ?: JsonNull)
            }

            is SessionSettingsChange.Thinking -> {
              put("thinkingLevel", JsonPrimitive(change.level))
            }

            is SessionSettingsChange.Permission -> {
              put("permissionMode", change.mode?.wireValue?.let(::JsonPrimitive) ?: JsonNull)
              put("expectedSessionId", JsonPrimitive(change.expectedSessionId))
              put("expectedPermissionMode", change.expectedPermissionMode?.wireValue?.let(::JsonPrimitive) ?: JsonNull)
            }

            is SessionSettingsChange.FastMode -> {
              put("fastMode", change.mode?.toWireJson() ?: JsonNull)
            }
          }
        }
      val response =
        capturedLease.request("sessions.patch", params.toString()) { enqueue ->
          // GatewaySession holds its physical-connection lock here. Events during
          // transport waiting precede this write; only successful enqueue records dispatch.
          synchronized(gatewayScopeApplyLock) {
            if (!ownsLane()) throw GatewayRequestNotEnqueued("session settings owner changed")
            if (change is SessionSettingsChange.Model && lane.confirmed.modelSelectionLocked == true) {
              throw GatewayRequestNotEnqueued("Model selection is locked for this session.")
            }
            if (change is SessionSettingsChange.Permission) {
              if (!canSetSessionPermissionMode()) throw GatewayRequestNotEnqueued("Update the Gateway to change session permissions.")
              if (_sessions.value.firstOrNull { it.key == settingsKey.sessionKey }?.sessionId != change.expectedSessionId) {
                throw GatewayRequestNotEnqueued("Refresh this chat before changing permissions.")
              }
            }
            enqueue()
            lane.reconciliation = null
            dispatchObservation = lane.observation
            queued.thinkingIntent?.dispatched = true
          }
        }
      val resolution = parseSessionSettingsPatchResolution(response, settingsKey.sessionKey)
      succeeded = true
      if (change is SessionSettingsChange.Model) change.ref?.let(recordModelRecent)
      var acknowledgedEntry: ChatSessionEntry? = null
      capturedLease.commitIfCurrent {
        synchronized(gatewayScopeApplyLock) {
          if (ownsLane() && dispatchObservation === lane.observation) {
            acknowledgedEntry = applyAcceptedSessionSettings(queued, change, resolution)
            dispatchObservation = null
          }
        }
      }
      acknowledgedEntry?.let { acknowledgeUnreadIfNeeded(it.key, it, requireActive = true) }
      true
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      succeeded = false
      val reportFailure = {
        synchronized(gatewayScopeApplyLock) {
          if (ownsLane()) {
            updateLocalizedErrorText(
              err.message?.let(::verbatimText)
                ?: when (change) {
                  is SessionSettingsChange.Model -> nativeText("Could not update model.")
                  is SessionSettingsChange.Thinking -> nativeText("Could not update thinking level.")
                  is SessionSettingsChange.Permission -> nativeText("Could not update permissions.")
                  is SessionSettingsChange.FastMode -> nativeText("Could not update fast mode.")
                },
            )
          }
        }
      }
      if (lease == null) reportFailure() else lease.commitIfCurrent(reportFailure)
      false
    } finally {
      synchronized(gatewayScopeApplyLock) {
        // A saved write may still reject, or its reply may lose the physical lease.
        // Keep Send gated until the logical session's exact settings read succeeds.
        if (ownsLane() && dispatchObservation != null) lane.needsRefresh = true
        finishThinkingIntent(queued)
      }
      // Cancellation releases this caller, not its position in the queue. Later
      // mutations and readers must still wait for a surviving predecessor.
      val previous = queued.previous
      if (previous == null) {
        completeSessionSettingsMutation(queued, succeeded)
      } else {
        previous.invokeOnCompletion { completeSessionSettingsMutation(queued, succeeded) }
      }
    }
  }

  private fun completeSessionSettingsMutation(
    queued: QueuedSessionSettingsMutation,
    succeeded: Boolean,
  ) {
    val settingsKey = queued.settingsKey
    val lane = queued.lane
    var drainedLane = false
    var ready = succeeded
    val reconciliation =
      synchronized(gatewayScopeApplyLock) {
        if (pendingSettingsMutations[settingsKey] !== lane) ready = false
        if (
          pendingSettingsMutations[settingsKey] === lane &&
          lane.tail === queued.pending &&
          lane.needsRefresh &&
          settingsKey == sessionSettingsKey(settingsKey.sessionKey) &&
          settingsKey.ownerAgentId != null &&
          settingsKey.ownerAgentId == resolveAgentIdForSessionKey(_sessionKey.value)
        ) {
          incrementSettingsMutationRevision(settingsKey.gatewayScope)
          SessionSettingsCompletion(queued.pending, succeeded).also { lane.reconciliation = it }
        } else {
          drainedLane = removeCompletedSessionSettingsLane(settingsKey, lane, queued.pending)
          null
        }
      }
    if (reconciliation != null) {
      // The exact session read owns readiness; a filtered drawer page cannot
      // establish whether this session exists or supply its model capabilities.
      scope.launch { reconcileSessionSettings(settingsKey, lane, reconciliation) }
    } else {
      queued.pending.complete(ready)
      if (drainedLane && ready && _healthOk.value) requestOutboxFlush()
    }
  }

  private fun removeCompletedSessionSettingsLane(
    settingsKey: SessionSettingsKey,
    lane: SessionSettingsLane,
    pending: CompletableDeferred<Boolean>,
  ): Boolean {
    if (pendingSettingsMutations[settingsKey] !== lane) return false
    incrementSettingsMutationRevision(settingsKey.gatewayScope)
    val drained = lane.tail === pending && pendingSettingsMutations.remove(settingsKey, lane)
    publishPendingSessionSettingsKeys()
    pruneSettingsMutationRevision(settingsKey.gatewayScope)
    return drained
  }

  private fun retryFailedSessionSettingsReconciliations(
    gatewayScope: ChatCacheScope?,
    ownerAgentId: String,
  ) {
    val retries =
      synchronized(gatewayScopeApplyLock) {
        pendingSettingsMutations.mapNotNull { (key, lane) ->
          if (key.gatewayScope != gatewayScope || key.ownerAgentId != ownerAgentId) return@mapNotNull null
          val previous = lane.reconciliation ?: return@mapNotNull null
          if (!previous.pending.isCompleted || lane.tail !== previous.pending) return@mapNotNull null
          // Replace only failed readiness, never a running write or a queued successor.
          val completion = SessionSettingsCompletion(CompletableDeferred(), succeeded = true)
          lane.tail = completion.pending
          lane.reconciliation = completion
          incrementSettingsMutationRevision(gatewayScope)
          Triple(key, lane, completion)
        }
      }
    retries.forEach { (key, lane, completion) ->
      scope.launch { reconcileSessionSettings(key, lane, completion) }
    }
  }

  private suspend fun reconcileSessionSettings(
    settingsKey: SessionSettingsKey,
    lane: SessionSettingsLane,
    completion: SessionSettingsCompletion,
  ) {
    val ownerAgentId = settingsKey.ownerAgentId ?: return
    val refresh = SessionSettingsRead(settingsKey.gatewayScope, ownerAgentId)
    var ready = false

    fun ownsReconciliation(): Boolean = pendingSettingsMutations[settingsKey] === lane && lane.reconciliation === completion

    fun ownerIsCurrent(): Boolean =
      settingsKey == sessionSettingsKey(settingsKey.sessionKey) &&
        ownerAgentId == resolveAgentIdForSessionKey(_sessionKey.value)

    synchronized(gatewayScopeApplyLock) { activeSessionReads.add(refresh) }
    try {
      val lease = captureRequestLease(settingsKey.gatewayScope) ?: throw GatewayRequestNotEnqueued("not connected")
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(settingsKey.sessionKey))
          put("agentId", JsonPrimitive(ownerAgentId))
          put("limit", JsonPrimitive(1))
        }
      while (true) {
        var settingsRevision = 0L
        val response =
          lease.request("chat.history", params.toString()) { enqueue ->
            synchronized(gatewayScopeApplyLock) {
              if (!ownsReconciliation() || !ownerIsCurrent()) throw GatewayRequestNotEnqueued("session settings owner changed")
              refresh.settingsSnapshots.clear()
              settingsRevision = settingsMutationRevision(settingsKey.gatewayScope)
              enqueue()
            }
          }
        val root = json.parseToJsonElement(response).asObjectOrNull() ?: error("invalid chat.history response")
        // Store lookup failures also return defaults without a durable identity.
        // Only explicit deletion events/responses authorize purging local state.
        if (root["sessionId"].asStringOrNull().isNullOrBlank()) error("missing durable session identity")
        val info = parseSessionEntry(root["sessionInfo"].asObjectOrNull(), settingsKey.sessionKey) ?: error("missing session settings")
        val thinkingLevel = root["thinkingLevel"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
        val entry = if (thinkingLevel == null) info else info.copy(thinkingLevel = thinkingLevel)
        val entryOwner = resolveAgentIdFromMainSessionKey(entry.key) ?: entry.ownerAgentId ?: ownerAgentId
        if (entry.key != settingsKey.sessionKey || entryOwner != ownerAgentId) error("session settings owner changed")
        lease.commitIfCurrent {
          synchronized(gatewayScopeApplyLock) {
            if (!ownsReconciliation() || !ownerIsCurrent()) return@synchronized
            if (
              settingsRevision != settingsMutationRevision(settingsKey.gatewayScope) ||
              refresh.hasConflictingSettings(listOf(entry))
            ) {
              return@synchronized
            }
            // This read owns settings, not transcript/run/usage publication.
            val current = _sessions.value.firstOrNull { it.key == settingsKey.sessionKey } ?: lane.confirmed
            val settings = mergeChatSessionSettings(current, entry, authoritativeSessionSettings = true)
            upsertSessionEntry(settings.copy(ownerAgentId = ownerAgentId), replace = true, authoritativeSessionSettings = true)
            lane.needsRefresh = false
            lane.reconciliation = null
            removeCompletedSessionSettingsLane(settingsKey, lane, completion.pending)
            if (_errorText.value == sessionSettingsRefreshError) updateErrorText(null)
            ready = true
          }
        }
        if (ready) return
        if (!lease.isCurrent() || !synchronized(gatewayScopeApplyLock) { ownsReconciliation() && ownerIsCurrent() }) return
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      // Readiness fails independently of the already accepted settings write.
    } finally {
      val retired =
        synchronized(gatewayScopeApplyLock) {
          activeSessionReads.remove(refresh)
          val retired =
            if (ownsReconciliation() && !ownerIsCurrent()) {
              retireSessionSettingsLanes { key, candidate -> key == settingsKey && candidate === lane }
            } else {
              if (ownsReconciliation() && !ready) updateLocalizedErrorText(sessionSettingsRefreshError)
              emptyList()
            }
          pruneSettingsMutationRevision(settingsKey.gatewayScope)
          retired
        }
      // Resume outside the data/physical locks; successors retain their queue position.
      completion.pending.complete(ready && completion.succeeded)
      retired.forEach { it.complete(false) }
      if (ready && completion.succeeded && _healthOk.value) requestOutboxFlush()
    }
  }

  private fun retireSessionSettingsLanes(
    shouldRetire: (SessionSettingsKey, SessionSettingsLane) -> Boolean,
  ): List<CompletableDeferred<Boolean>> {
    val retired = linkedSetOf<CompletableDeferred<Boolean>>()
    for ((key, lane) in pendingSettingsMutations) {
      if (shouldRetire(key, lane) && pendingSettingsMutations.remove(key, lane)) {
        lane.thinkingIntent = null
        incrementSettingsMutationRevision(key.gatewayScope)
        pruneSettingsMutationRevision(key.gatewayScope)
        retired += lane.tail
        lane.reconciliation?.pending?.let(retired::add)
      }
    }
    if (retired.isNotEmpty()) publishPendingSessionSettingsKeys()
    return retired.toList()
  }

  private fun finishThinkingIntent(queued: QueuedSessionSettingsMutation) {
    if (queued.thinkingIntent == null || queued.lane.thinkingIntent !== queued.thinkingIntent) return
    queued.lane.thinkingIntent = null
    if (
      queued.settingsKey == sessionSettingsKey(queued.settingsKey.sessionKey) &&
      queued.settingsKey.sessionKey == _sessionKey.value
    ) {
      publishSelectedSessionSettings(queued.lane.confirmed)
    }
  }

  private fun incrementSettingsMutationRevision(gatewayScope: ChatCacheScope?) {
    settingsMutationRevisions[gatewayScope] = (settingsMutationRevisions[gatewayScope] ?: 0L) + 1L
  }

  private fun settingsMutationRevision(gatewayScope: ChatCacheScope?): Long = settingsMutationRevisions[gatewayScope] ?: 0L

  private fun hasPendingSessionSettings(
    gatewayScope: ChatCacheScope?,
  ): Boolean = pendingSettingsMutations.any { (key, lane) -> key.gatewayScope == gatewayScope && !lane.tail.isCompleted }

  private fun publishPendingSessionSettingsKeys() {
    _pendingSessionSettingsKeys.value = pendingSettingsMutations.keys.mapTo(linkedSetOf()) { it.sessionKey }
  }

  private fun pruneSettingsMutationRevision(gatewayScope: ChatCacheScope?) {
    // A drained revision only matters while an in-flight session read can
    // compare it. Retired connection generations must not accumulate forever.
    if (
      pendingSettingsMutations.keys.none { it.gatewayScope == gatewayScope } &&
      activeSessionReads.none { it.gatewayScope == gatewayScope }
    ) {
      settingsMutationRevisions.remove(gatewayScope)
    }
  }

  private suspend fun waitForPendingSessionSettings(sessionKey: String): Boolean = waitForPendingSessionSettings(sessionSettingsKey(sessionKey))

  private suspend fun waitForPendingSessionSettings(settingsKey: SessionSettingsKey): Boolean {
    var pending = pendingSettingsMutations[settingsKey]?.tail ?: return true
    while (true) {
      if (!pending.await()) return false
      val next = pendingSettingsMutations[settingsKey]?.tail
      if (next == null || next === pending) return true
      pending = next
    }
  }

  private suspend fun waitForPendingSessionSettings(gatewayScope: ChatCacheScope?) {
    while (true) {
      val pending =
        synchronized(gatewayScopeApplyLock) {
          pendingSettingsMutations
            .filter { (key, lane) -> key.gatewayScope == gatewayScope && !lane.tail.isCompleted }
            .values
            .map { it.tail }
        }
      if (pending.isEmpty()) return
      pending.forEach { it.await() }
    }
  }

  internal suspend fun resolveSessionSelection(
    owner: ChatAgentSessionSelectionOwner,
    mainSessionKey: String,
  ): ChatAgentSessionSelection? {
    val (requestScope, remembered, rememberedSessionId) =
      synchronized(gatewayScopeApplyLock) {
        val choice = lastSelectedChatSessionByOwner[owner]
        // History may update this choice during discovery; compare its entry-time identity.
        Triple(currentCacheScope(), choice, choice?.observedSessionId)
      }
    val rememberedKey = remembered?.key
    val target =
      try {
        val candidates = fetchSessionSelectionCandidates(owner.agentId) ?: return null
        val candidate = selectChatAgentSessionKey(candidates, owner.agentId, rememberedKey, mainSessionKey)
        if (rememberedKey == null || candidate == rememberedKey) {
          candidate
        } else {
          // Recent pages cannot prove absence. History accepts the captured agent
          // for unscoped keys, unlike sessions.describe, and must identify a real row.
          check(requestScope != null && requestScope.gatewayId == owner.gatewayStableId)
          val params =
            buildJsonObject {
              put("sessionKey", JsonPrimitive(rememberedKey))
              put("agentId", JsonPrimitive(owner.agentId))
              put("limit", JsonPrimitive(1))
            }
          val response = requestGatewayBound(requestScope.gatewayId, "chat.history", params.toString())
          val history = json.parseToJsonElement(response).asObjectOrNull()
          val entry = parseSessionEntry(history?.get("sessionInfo").asObjectOrNull()) ?: error("session description unavailable")
          check(entry.sessionId != null && entry.key == rememberedKey && (entry.ownerAgentId == null || entry.ownerAgentId == owner.agentId))
          when (entry.archived) {
            true -> candidate
            false -> rememberedKey
            null -> error("session description has no archive state")
          }
        }
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        null
      }
    return ChatAgentSessionSelection(requestScope, remembered, rememberedSessionId, target)
  }

  internal fun restoreSessionSelection(
    owner: ChatAgentSessionSelectionOwner,
    selection: ChatAgentSessionSelection,
    mainSessionKey: String,
  ) {
    synchronized(gatewayScopeApplyLock) {
      if (
        selection.gatewayScope != currentCacheScope() ||
        lastSelectedChatSessionByOwner[owner] !== selection.rememberedSession ||
        selection.rememberedSession?.observedSessionId != selection.rememberedSessionId
      ) {
        return
      }
      val target = selection.targetSessionKey
      if (target == null) {
        updateLocalizedErrorText(nativeText("Could not restore the last chat. Select a chat from the sidebar."))
        return
      }
      if (selection.rememberedSession != null && target != selection.rememberedSession.key) {
        lastSelectedChatSessionByOwner.remove(owner, selection.rememberedSession)
      }
      if (target != mainSessionKey) switchSession(target, owner.agentId, rememberSelection = false)
    }
  }

  /** Switches to another gateway chat session and starts a fresh history load. */
  fun switchSession(
    sessionKey: String,
    ownerAgentId: String? = null,
    rememberSelection: Boolean = true,
  ) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key.isEmpty()) return
    val owner = normalizeSessionSelectionOwner(key, ownerAgentId)
    prepareSessionSelection(key)
    val generation =
      synchronized(gatewayScopeApplyLock) {
        if (rememberSelection) rememberSelectedChatSession(key, owner)
        if (key == _sessionKey.value && owner == _sessionOwnerAgentId.value) return
        beginHistoryLoad(key, ownerAgentId = owner, refreshSessions = false)
      }
    bootstrap(sessionKey = key, generation = generation)
  }

  private fun rememberSelectedChatSession(
    key: String,
    ownerAgentId: String?,
  ) {
    val agentId = ownerAgentId ?: effectiveDefaultAgentId() ?: return
    val sessionId = _sessionId.value.takeIf { key == _sessionKey.value && agentId == resolveAgentIdForSessionKey(key) }
    lastSelectedChatSessionByOwner[ChatAgentSessionSelectionOwner(currentCacheScope()?.gatewayId, agentId)] = RememberedChatSession(key, sessionId)
  }

  private fun prepareSessionSelection(key: String) {
    if (key != unreadPatchSessionKey) {
      unreadPatchSessionKey = key
      unreadActivationObserved = false
      unreadActivationMarkedUnreadAt = null
      unreadPatchRequested = false
    }
    acknowledgeUnreadIfNeeded(key, _sessions.value.firstOrNull { it.key == key })
  }

  private fun beginHistoryLoad(
    key: String,
    ownerAgentId: String?,
    markLoading: Boolean = true,
    rememberSelection: Boolean = false,
    refreshHealth: Boolean = true,
    refreshSessions: Boolean = true,
  ): Long {
    val owner = normalizeSessionSelectionOwner(key, ownerAgentId)
    // Commit selection and its reset together: a newer IO refresh must not finish
    // between publishing this generation and clearing its readiness or run state.
    val (generation, selectionChanged) =
      synchronized(gatewayScopeApplyLock) {
        val generation = historyLoadGeneration.incrementAndGet()
        val changed = _sessionKey.value != key || _sessionOwnerAgentId.value != owner
        if (changed) chatSelectionGeneration.update { it + 1 }
        _sessionKey.value = key
        _sessionOwnerAgentId.value = owner
        pendingHealthRefresh = if (refreshHealth) HealthRefresh(generation, force = true, refreshSessions = refreshSessions) else null
        retireSessionSettingsLanes { settingsKey, lane ->
          lane.reconciliation?.pending?.isCompleted == true &&
            (settingsKey.gatewayScope != currentCacheScope() || settingsKey.ownerAgentId != resolveAgentIdForSessionKey(key))
        }
        _messages.value = emptyList()
        _messagesFromCache.value = false
        if (changed) {
          resetSwarmProgress(key)
          sessionBranchesRefreshGeneration.incrementAndGet()
          sessionBranchSwitchGeneration.incrementAndGet()
          sessionBranchSwitchClaimed.set(false)
          _sessionBranches.value = emptyList()
          _sessionBranchesLoading.value = false
          _sessionBranchSwitching.value = false
          clearSubagentActivities()
          clearProgressCard()
        }
        val activeAgentId = resolveAgentIdForSessionKey(key)
        _sessions.value =
          reconcileGlobalObserverDigestOwner(
            // Unscoped keys can name different sessions for each agent. Retire the
            // old owner's rows before history, settings intents, or events can merge.
            _sessions.value.filter { activeAgentId == null || it.ownerAgentId == activeAgentId },
            activeAgentId = activeAgentId,
            adoptOwnerless = false,
          )
        applyThinkingMetadata(_sessions.value.firstOrNull { it.key == key })
        _selectedModelRef.value = null
        lastHandledTerminalRunId = null
        val nextMetadataScope = currentChatMetadataScope()
        if (chatMetadataScope != nextMetadataScope) {
          chatMetadataRequestSequence.incrementAndGet()
          clearChatMetadata(nextMetadataScope)
          disableSwarmProgress(key)
        }
        updateErrorText(null)
        _healthOk.value = false
        clearLiveHistoryMarker()
        clearPendingRuns()
        clearLiveRunUi()
        _sessionId.value = null
        if (rememberSelection) rememberSelectedChatSession(key, owner)
        _historyLoading.value = markLoading
        restorePendingRunProjectionsForCurrentOwner()
        generation to changed
      }
    if (selectionChanged) refreshProgressCard()
    return generation
  }

  private fun clearLiveHistoryMarker() {
    liveHistoryMarker = null
  }

  private fun markLiveHistoryApplied(
    sessionKey: String,
    sessionId: String?,
    generation: Long,
  ) {
    liveHistoryMarker = LiveHistoryMarker(sessionKey = sessionKey, sessionId = sessionId, generation = generation)
  }

  private fun hasCurrentLiveHistory(sessionKey: String): Boolean {
    val marker = liveHistoryMarker ?: return false
    // Same-session load may skip refresh only for the exact live snapshot that
    // applied in the active generation. Cached or stale lifecycle state must refetch.
    return marker.sessionKey == sessionKey &&
      marker.generation == historyLoadGeneration.get() &&
      marker.sessionId == _sessionId.value &&
      !_messagesFromCache.value &&
      _healthOk.value
  }

  private fun normalizeRequestedSessionKey(sessionKey: String): String {
    val key = sessionKey.trim()
    if (key.isEmpty()) return appliedMainSessionKey
    if (key == "main" && appliedMainSessionKey != "main") return appliedMainSessionKey
    return key
  }

  private fun normalizeSessionSelectionOwner(
    sessionKey: String,
    ownerAgentId: String?,
  ): String? =
    resolveAgentIdFromMainSessionKey(sessionKey)
      ?: ownerAgentId?.trim()?.takeIf { it.isNotEmpty() }

  private fun resolveAgentIdForSessionKey(parentKey: String): String? =
    resolveAgentIdFromMainSessionKey(parentKey)
      ?: _sessionOwnerAgentId.value
      ?: effectiveDefaultAgentId()

  private fun activeSessionTracksDefaultAgent(sessionKey: String): Boolean = resolveAgentIdFromMainSessionKey(sessionKey) == null && _sessionOwnerAgentId.value == null

  /** Queues a chat send without waiting for gateway acceptance. */
  fun sendMessage(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ) {
    scope.launch {
      sendMessageAwaitAcceptance(
        message = message,
        thinkingLevel = thinkingLevel,
        attachments = attachments,
      )
    }
  }

  /** Sends a chat message and returns once it is durably admitted or the gateway rejects it. */
  suspend fun sendMessageAwaitAcceptance(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean = sendMessageAwaitAcceptance(message, thinkingLevel, attachments, expectedOwner = null)

  internal suspend fun sendMessageForOwnerAwaitAcceptance(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
    expectedOwner: ChatComposerOwner,
    idempotencyKey: String? = null,
  ): Boolean = sendMessageAwaitAcceptance(message, thinkingLevel, attachments, expectedOwner, idempotencyKey)

  internal suspend fun wasOutboxCommandAdmitted(id: String): Boolean = commandOutbox?.wasAdmitted(id) == true

  internal fun isCurrentComposerOwner(expectedOwner: ChatComposerOwner): Boolean {
    val cacheScope = currentCacheScope()
    val effectiveSessionKey = normalizeRequestedSessionKey(_sessionKey.value)
    if (effectiveSessionKey == "main" && _sessionOwnerAgentId.value == null) return false
    val routingOwner =
      resolveChatComposerRoutingOwner(
        gatewayStableId = cacheScope?.gatewayId,
        gatewayDefaultAgentId = _sessionOwnerAgentId.value ?: effectiveDefaultAgentId(),
        sessionKey = effectiveSessionKey,
        mainSessionKey = appliedMainSessionKey,
      ) ?: return false
    return expectedOwner == routingOwner
  }

  private suspend fun sendMessageAwaitAcceptance(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
    expectedOwner: ChatComposerOwner?,
    idempotencyKey: String? = null,
  ): Boolean {
    val sendCacheScope = currentCacheScope()
    val sendGatewayId = sendCacheScope?.gatewayId
    val sendSelectionGeneration = chatSelectionGeneration.value
    val trimmed = message.trim()
    if (trimmed.isEmpty() && attachments.isEmpty()) return false
    val sessionKey = _sessionKey.value
    val effectiveSessionKey = normalizeRequestedSessionKey(sessionKey)
    // Owner-aware UI sends must wait for Android's device-scoped main key. The legacy `main`
    // alias is resolved by the gateway's mutable default agent and cannot be routed immutably.
    if (expectedOwner != null && !isCurrentComposerOwner(expectedOwner)) return false
    val routingOwner =
      resolveChatComposerRoutingOwner(
        gatewayStableId = sendCacheScope?.gatewayId,
        gatewayDefaultAgentId = _sessionOwnerAgentId.value ?: effectiveDefaultAgentId(),
        sessionKey = effectiveSessionKey,
        mainSessionKey = appliedMainSessionKey,
      )
        ?: return false
    if (expectedOwner != null && expectedOwner != routingOwner) return false
    val capturedOwner = expectedOwner ?: routingOwner
    val tracksDefaultAgent = activeSessionTracksDefaultAgent(effectiveSessionKey)
    val sendDefaultAgentRevision = currentDefaultAgentRevision()

    fun isCapturedOwnerCurrent(): Boolean = capturedOwner.matches(currentCacheScope(), _sessionKey.value)

    fun ownsCapturedUi(): Boolean =
      chatSelectionGeneration.value == sendSelectionGeneration &&
        (!tracksDefaultAgent || currentDefaultAgentRevision() == sendDefaultAgentRevision) &&
        isCapturedOwnerCurrent()

    // Session settings and sends share one ordering boundary; the first post-selection turn
    // must not leave with stale model or thinking state while sessions.patch is in flight.
    if (!waitForPendingSessionSettings(sessionKey)) return false
    if (!ownsCapturedUi()) return false
    if (chatModelSendBlocked(_healthOk.value, _selectedModelRef.value, _modelCatalog.value)) return false
    // agent-command.ts throws for explicit unsupported levels, so hidden controls must send off.
    // Applied at enqueue time too so durable rows never persist a level the selected model
    // rejects; reconnect flushes with a cleared catalog fail open, matching pre-gating behavior.
    val thinking =
      if (thinkingSupportedForCurrentSelection()) {
        normalizeThinking(thinkingLevel)
      } else {
        "off"
      }
    val text = if (trimmed.isEmpty() && attachments.isNotEmpty()) "See attached." else trimmed

    // Every send is journaled before the composer clears or any network attempt can lose
    // ownership; the durable row is the single recovery owner across process death.
    val journaled =
      when (val outbox = commandOutbox) {
        null -> {
          if (!_healthOk.value) {
            updateLocalizedErrorText(nativeText("Gateway health not OK; cannot send"))
            return false
          }
          null
        }

        else -> {
          enqueueDurableSend(
            outbox = outbox,
            outboxScope = sendCacheScope,
            sessionKey = normalizeRequestedSessionKey(sessionKey),
            text = text,
            thinkingLevel = thinking,
            attachments = attachments,
            canPublishUi = ::ownsCapturedUi,
            ownerAgentId = capturedOwner.agentId,
            idempotencyKey = idempotencyKey,
          ) ?: return false
        }
      }
    if (journaled != null && !ownsCapturedUi()) {
      // Restore the draft only when the still-queued row is atomically removed. A reconnect
      // flush may already own it; then the durable row remains the single input owner.
      val deleted =
        try {
          commandOutbox?.deleteIfQueued(journaled.id) == true
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          false
        }
      if (deleted) {
        publishOutbox()
        return false
      }
      publishOutbox()
      return true
    }
    if (journaled != null) {
      if (!_healthOk.value) {
        // Captured for reconnect: the queued bubble is visible and flush delivers it later.
        return true
      }
      if (
        commandOutbox?.supportsBranchCoordination == true &&
        journaled.outboxScope()?.let { isOutboxBranchReconciled(sendCacheScope, it) } != true
      ) {
        // A remote branch mutation invalidates ownership before its async refresh starts.
        // Keep new input durable, but let the reconciled FIFO lane decide its branch.
        requestOutboxFlush()
        return true
      }
      // The startup recovery sweep flips every 'sending' row to delivery-unconfirmed. Claiming
      // only after it completes means the sweep can never hit this live dispatch; a failed
      // sweep leaves the row queued so reconnect flush owns delivery instead.
      outboxRecoveryJob?.join()
      val outbox = commandOutbox
      if (outbox == null || !recoverInterruptedOutboxSends(outbox)) {
        _healthOk.value = false
        publishOutbox()
        return true
      }
      if (sessionHasDurableBacklog(journaled)) {
        // An older row for this session is still queued or unresolved; a direct dispatch
        // would reorder the conversation, so the FIFO flush owns delivery.
        requestOutboxFlush()
        return true
      }
      // Atomically claim the row for this direct dispatch: a vanished row (user delete) or a
      // concurrent flush claim must not lead to a second send of the same idempotency key.
      val claimed =
        try {
          outbox.claimForSendingIfAttempt(journaled.id, journaled.attemptVersion, 0, null)
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          null
        }
      publishOutbox()
      if (claimed == null) {
        // The claim could not be made durable, so the admitted row still has no dispatcher.
        // Hand delivery to the flush lane instead of reporting success with no active owner.
        requestOutboxFlush()
        return true
      }
      if (claimed == 0) return true
      if (journaled.gatedEpoch != null && journaled.gatedEpoch != currentCacheScope()?.connectionGeneration) {
        // A reconnect landed between admission and this claim; command-shaped input never
        // auto-replays across connection epochs, so the claimed row parks for explicit retry.
        persistJournaledSendState(journaled, ChatOutboxStatus.Failed, OUTBOX_CONNECTION_CHANGED_ERROR)
        return true
      }
    }

    val runId = journaled?.id ?: UUID.randomUUID().toString()

    val optimisticMessage = optimisticUserMessage(runId = runId, text = text, attachments = attachments)
    pendingRunProjectionsByRunId[runId] =
      PendingRunProjection(
        owner = capturedOwner,
        runId = runId,
        optimisticMessage = optimisticMessage,
      )

    // Durable admission can suspend while the user changes chats. Route the captured row, but
    // project it only into the exact owner generation that initiated the send.
    fun projectRunToCurrentOwner() {
      pendingRunProjectionsByRunId[runId]?.let(::projectPendingRun)
    }
    if (ownsCapturedUi()) projectRunToCurrentOwner()

    fun settleProjectedRun(settledRunId: String) {
      retireRunTelemetry(settledRunId)
      clearPendingRun(settledRunId)
      removeOptimisticMessage(settledRunId)
      unresolvedRepliesByRunId.remove(settledRunId)
      if (runDiagnosticOwner?.runId == settledRunId) runDiagnosticOwner = null
    }

    // Dispatch ownership lives in the controller scope: cancelling the calling UI scope
    // (leaving the chat screen mid-send) after the durable claim must not strand a Sending
    // row this process can no longer repair; the dispatch completes and settles the row.
    val dispatch =
      scope.async {
        try {
          val params =
            buildChatSendParams(
              // Dispatch exactly what was journaled: the row's captured session key is the
              // idempotent identity a replay after process death would use.
              sessionKey = journaled?.sessionKey ?: sessionKey,
              ownerAgentId = capturedOwner.agentId,
              text = text,
              thinking = thinking,
              idempotencyKey = runId,
              attachments = attachments,
            )
          val res = requestGatewayBound(sendGatewayId, "chat.send", params)
          val ack = parseChatSendAck(json, res)
          // Row transitions are durable state for the dispatching gateway and apply even when the
          // UI scope moved on mid-request; only UI updates below are scope-guarded. A terminal
          // failure ack proves transmission, not that this idempotency key never ran (a timeout ack
          // can outlive a still-admitted run), so the row parks for review instead of deleting.
          if (ack.isTerminalFailure) {
            markJournaledSendUnconfirmed(journaled)
          } else {
            markJournaledSendAccepted(journaled)
            val ackRunId = ack.runId
            if (journaled != null && ackRunId != null && ackRunId != journaled.id) {
              acknowledgedRunIdByRowId[journaled.id] = ackRunId
            }
          }
          val actualRunId = ack.runId ?: runId
          if (!ack.isTerminal) projectRunToCurrentOwner()
          if (actualRunId != runId) {
            transferRunOwnership(runId, actualRunId, optimisticMessage)
          }
          if (!ack.isTerminal && !synchronized(pendingRuns) { actualRunId in pendingRuns }) {
            armPendingRunProjectionDeadline(actualRunId)
          }
          if (ack.isTerminal) {
            settleProjectedRun(actualRunId)
            if (ack.isTerminalSuccess) {
              if (isCapturedOwnerCurrent()) {
                clearLiveRunUi()
                refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(actualRunId))
              }
              true
            } else {
              // Terminal timeout/error means the gateway did not accept a runnable turn.
              // Surface failed acceptance instead of letting a cleared composer look successful.
              if (isCapturedOwnerCurrent()) {
                clearLiveRunUi()
                updateLocalizedErrorText(nativeText("Chat failed before the run started; try again."))
              }
              // The parked row owns the input; restoring the draft would duplicate it.
              journaled != null
            }
          } else {
            true
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: GatewayRequestNotEnqueued) {
          // The frame provably never entered the socket queue. The journaled row stays queued and
          // reconnect flush owns delivery, exactly like the flush path treats not-dispatched sends;
          // deleting here could lose fire-and-forget input if the process died after the delete.
          if (journaled != null) {
            persistJournaledSendState(journaled, ChatOutboxStatus.Queued, err.message)
            settleProjectedRun(runId)
            // The transport is effectively down; drop health so the next health event re-flushes.
            if (sendCacheScope == currentCacheScope()) _healthOk.value = false
            publishOutbox()
            true
          } else {
            settleProjectedRun(runId)
            if (isCapturedOwnerCurrent()) updateErrorText(err.message)
            false
          }
        } catch (err: GatewayRequestDefinitiveFailure) {
          // An ok:false response proves transmission, not that this idempotency key was never run;
          // park the journaled copy for review instead of deleting a possibly delivered send.
          markJournaledSendUnconfirmed(journaled)
          settleProjectedRun(runId)
          if (isCapturedOwnerCurrent()) updateErrorText(err.message)
          // The parked row owns the input; only the journal-less path refuses the send.
          journaled != null
        } catch (_: GatewayRequestOutcomeUnknown) {
          // A transport failure cannot distinguish rejection from an accepted send whose ACK was
          // lost. Keep the journaled row until history confirms or reconciliation parks it.
          markJournaledSendAccepted(journaled)
          if (!isCapturedOwnerCurrent()) {
            settleProjectedRun(runId)
            return@async true
          }
          projectRunToCurrentOwner()
          unknownOutcomeRunIds.add(runId)
          if (_healthOk.value) {
            refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(runId))
          }
          true
        } catch (err: Throwable) {
          // Unexpected failure after dispatch is ambiguous; fail closed and keep the row visible.
          markJournaledSendUnconfirmed(journaled)
          settleProjectedRun(runId)
          if (isCapturedOwnerCurrent()) updateErrorText(err.message)
          // With a journaled row parked for review, the composer must not restore a duplicate
          // draft: the row owns the input now. Only the journal-less path refuses the send.
          journaled != null
        }
      }
    return dispatch.await()
  }

  private fun ChatComposerOwner.matches(
    cacheScope: ChatCacheScope?,
    sessionKey: String,
  ): Boolean =
    this ==
      resolveChatComposerRoutingOwner(
        gatewayStableId = cacheScope?.gatewayId,
        gatewayDefaultAgentId = _sessionOwnerAgentId.value ?: effectiveDefaultAgentId(),
        sessionKey = sessionKey,
        mainSessionKey = appliedMainSessionKey,
      )

  private fun currentChatComposerRoutingOwner(): ChatComposerOwner? =
    resolveChatComposerRoutingOwner(
      gatewayStableId = currentCacheScope()?.gatewayId,
      gatewayDefaultAgentId = _sessionOwnerAgentId.value ?: effectiveDefaultAgentId(),
      sessionKey = _sessionKey.value,
      mainSessionKey = appliedMainSessionKey,
    )

  private fun currentSelectedSession(): ChatSessionEntry? = _sessions.value.firstOrNull { it.key == _sessionKey.value }

  private fun advertisedRunIds(session: ChatSessionEntry? = currentSelectedSession()): List<String> =
    session
      ?.activeRunIds
      .orEmpty()
      .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
      .distinct()

  private fun publishRunPresentation() {
    val localRunIds = synchronized(pendingRuns) { pendingRuns.toSet() }
    val session = currentSelectedSession()
    val rawAdvertisedRunIds = advertisedRunIds(session)
    val telemetry = synchronized(liveRunTelemetryLock) { liveRunTelemetryByRunId.toMap() }
    val liveLocalRunIds = localRunIds.filterTo(mutableSetOf()) { telemetry[it]?.terminal != true }
    val liveAdvertisedRunIds = rawAdvertisedRunIds.filter { telemetry[it]?.terminal != true }
    val selectedRunId =
      resolvePreferredActiveRunId(
        localRunIds = liveLocalRunIds,
        advertisedRunIds = liveAdvertisedRunIds,
      )
    val hasUnknownAdvertisedRun =
      session?.hasActiveRun == true &&
        (rawAdvertisedRunIds.isEmpty() || liveAdvertisedRunIds.isNotEmpty())
    val activeCount =
      resolveSelectedActiveRunCount(
        localRunIds = liveLocalRunIds,
        advertisedRunIds = liveAdvertisedRunIds,
        hasAdvertisedRun = hasUnknownAdvertisedRun,
      )
    val clockKey =
      when {
        selectedRunId != null && selectedRunId in liveLocalRunIds -> {
          pendingRunProjectionsByRunId[selectedRunId]?.optimisticMessage?.id
            ?: optimisticMessagesByRunId[selectedRunId]?.id
            ?: unresolvedRepliesByRunId[selectedRunId]?.id
            ?: selectedRunId
        }

        selectedRunId != null -> {
          selectedRunId
        }

        activeCount > 0 -> {
          session?.startedAt?.let { "${_sessionKey.value}:active:$it" } ?: "${_sessionKey.value}:active"
        }

        else -> {
          null
        }
      }
    _pendingRunCount.value = localRunIds.size
    selectedActiveRunPresentationState.value =
      ChatActiveRunPresentation(
        count = activeCount,
        runId = selectedRunId,
        clockKey = clockKey,
        outputTokens = selectedRunId?.let { telemetry[it]?.outputTokens },
      )
  }

  private fun pruneRunTelemetryToAuthoritativeOwnership() {
    val session = currentSelectedSession() ?: return
    if (!session.hasActiveRunMetadata) return
    val localRunIds = synchronized(pendingRuns) { pendingRuns.toSet() }
    val authoritativeRunIds = advertisedRunIds(session).toSet()
    synchronized(liveRunTelemetryLock) {
      liveRunTelemetryByRunId.keys.removeAll { it !in localRunIds && it !in authoritativeRunIds }
    }
  }

  private fun clearUnownedNonterminalTelemetry(runId: String) {
    val advertised = runId in advertisedRunIds()
    synchronized(liveRunTelemetryLock) {
      if (!advertised && liveRunTelemetryByRunId[runId]?.terminal != true) {
        liveRunTelemetryByRunId.remove(runId)
      }
    }
  }

  private fun clearAllRunTelemetry() {
    synchronized(liveRunTelemetryLock) { liveRunTelemetryByRunId.clear() }
  }

  private fun recordLiveRunUsage(
    runId: String,
    sequence: Long,
    outputTokens: Long,
  ): Boolean =
    synchronized(liveRunTelemetryLock) {
      val current = liveRunTelemetryByRunId[runId]
      if (current?.terminal == true || sequence <= (current?.highestSequence ?: 0L)) {
        return@synchronized false
      }
      val nextOutputTokens = maxOf(outputTokens, current?.outputTokens ?: 0L)
      liveRunTelemetryByRunId[runId] =
        LiveRunTelemetryState(
          highestSequence = sequence,
          outputTokens = nextOutputTokens,
        )
      nextOutputTokens != current?.outputTokens
    }

  private fun applyLiveRunLifecycle(
    runId: String,
    sequence: Long,
    terminal: Boolean,
  ): Boolean =
    synchronized(liveRunTelemetryLock) {
      val current = liveRunTelemetryByRunId[runId]
      if (current?.terminal == true || sequence <= (current?.highestSequence ?: 0L)) {
        return@synchronized false
      }
      liveRunTelemetryByRunId[runId] =
        LiveRunTelemetryState(
          highestSequence = sequence,
          outputTokens = current?.outputTokens,
          terminal = terminal,
        )
      true
    }

  private fun retireRunTelemetry(runId: String) {
    synchronized(liveRunTelemetryLock) {
      val current = liveRunTelemetryByRunId[runId]
      liveRunTelemetryByRunId[runId] =
        LiveRunTelemetryState(
          highestSequence = current?.highestSequence ?: 0L,
          outputTokens = current?.outputTokens,
          terminal = true,
        )
    }
  }

  private fun invalidateIncompleteRunTelemetry() {
    synchronized(liveRunTelemetryLock) {
      liveRunTelemetryByRunId.toMap().forEach { (runId, state) ->
        if (!state.terminal && state.outputTokens != null) {
          liveRunTelemetryByRunId[runId] = state.copy(outputTokens = null)
        }
      }
    }
  }

  private fun transferRunTelemetry(
    oldRunId: String,
    newRunId: String,
  ) {
    synchronized(liveRunTelemetryLock) {
      val old = liveRunTelemetryByRunId.remove(oldRunId) ?: return@synchronized
      val existing = liveRunTelemetryByRunId[newRunId]
      liveRunTelemetryByRunId[newRunId] =
        if (existing == null) {
          old
        } else {
          LiveRunTelemetryState(
            highestSequence = maxOf(old.highestSequence, existing.highestSequence),
            outputTokens = listOfNotNull(old.outputTokens, existing.outputTokens).maxOrNull(),
            terminal = old.terminal || existing.terminal,
          )
        }
    }
  }

  private fun projectPendingRun(projection: PendingRunProjection) {
    if (projection.owner != currentChatComposerRoutingOwner()) {
      unprojectPendingRun(projection.runId)
      return
    }
    val runId = projection.runId
    val optimisticMessage = projection.optimisticMessage
    val stillProjected =
      optimisticMessagesByRunId.containsKey(runId) &&
        synchronized(pendingRuns) { runId in pendingRuns }
    if (stillProjected) return

    optimisticMessagesByRunId[runId] = optimisticMessage
    unresolvedRepliesByRunId[runId] = optimisticMessage
    synchronized(gatewayScopeApplyLock) {
      if (_messages.value.none { it.idempotencyKey == optimisticMessage.idempotencyKey }) {
        _messages.value = _messages.value + optimisticMessage
      }
    }
    armPendingRunTimeout(runId)
    synchronized(pendingRuns) { pendingRuns.add(runId) }
    runDiagnosticOwner = RunDiagnosticOwner(projection.owner, runId)
    updateErrorText(null)
    _streamingAssistantText.value = null
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    publishRunPresentation()
  }

  /** Hides another owner's live run without discarding the ownership needed to restore it. */
  private fun unprojectPendingRun(runId: String) {
    if (runDiagnosticOwner?.runId == runId) runDiagnosticOwner = null
    pendingRunTimeoutJobs.remove(runId)?.cancel()
    removeOptimisticMessage(runId)
    unresolvedRepliesByRunId.remove(runId)
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.remove(runId)
      pendingRuns.remove(runId)
    }
    clearUnownedNonterminalTelemetry(runId)
    clearTransientRunUiIfIdle()
    if (pendingRunProjectionsByRunId.containsKey(runId)) armPendingRunProjectionDeadline(runId)
    publishRunPresentation()
  }

  /** Bounds hidden run ownership when its terminal event is lost before the owner is revisited. */
  private fun armPendingRunProjectionDeadline(runId: String) {
    pendingRunTimeoutJobs[runId]?.cancel()
    pendingRunTimeoutJobs[runId] =
      scope.launch {
        delay(pendingRunTimeoutMs)
        if (synchronized(pendingRuns) { runId in pendingRuns }) return@launch
        if (pendingRunProjectionsByRunId.remove(runId) == null) return@launch
        pendingRunTimeoutJobs.remove(runId)
        parkUnconfirmedDurableSend(runId)
      }
  }

  private fun restorePendingRunProjectionsForCurrentOwner() {
    val owner = currentChatComposerRoutingOwner() ?: return
    pendingRunProjectionsByRunId.values
      .filter { it.owner == owner }
      .sortedBy { it.runId }
      .forEach(::projectPendingRun)
  }

  private fun optimisticUserMessage(
    runId: String,
    text: String,
    attachments: List<OutgoingAttachment>,
  ): ChatMessage {
    val userContent =
      buildList {
        add(ChatMessageContent(type = "text", text = text))
        for (att in attachments) {
          add(
            ChatMessageContent(
              type = att.type,
              mimeType = att.mimeType,
              fileName = att.fileName,
              base64 = att.base64,
              durationMs = att.durationMs,
            ),
          )
        }
      }
    return ChatMessage(
      id = UUID.randomUUID().toString(),
      role = "user",
      content = userContent,
      timestampMs = System.currentTimeMillis(),
      idempotencyKey = "$runId:user",
    )
  }

  private fun buildChatSendParams(
    sessionKey: String,
    ownerAgentId: String,
    text: String,
    thinking: String,
    idempotencyKey: String,
    attachments: List<OutgoingAttachment>,
  ): String =
    buildJsonObject {
      put("sessionKey", JsonPrimitive(sessionKey))
      put("agentId", JsonPrimitive(ownerAgentId))
      put("message", JsonPrimitive(text))
      put("thinking", JsonPrimitive(thinking))
      // No timeoutMs override: it becomes the server-side run expiry, and agent
      // turns can legitimately run for many minutes. Omitting it applies the
      // gateway's configured default, same as other channels.
      put("idempotencyKey", JsonPrimitive(idempotencyKey))
      if (attachments.isNotEmpty()) {
        put(
          "attachments",
          JsonArray(
            attachments.map { att ->
              buildJsonObject {
                put("type", JsonPrimitive(att.type))
                put("mimeType", JsonPrimitive(att.mimeType))
                put("fileName", JsonPrimitive(att.fileName))
                put("content", JsonPrimitive(att.base64))
              }
            },
          ),
        )
      }
    }.toString()

  /** True when an older durable row for the same session must send before this one. */
  private suspend fun sessionHasDurableBacklog(row: ChatOutboxItem): Boolean {
    val outbox = commandOutbox ?: return false
    val outboxScope = currentCacheScope() ?: return false
    val rows = runCatching { outbox.load(outboxScope.gatewayId) }.getOrDefault(emptyList())
    return rows.any { other ->
      other.id != row.id &&
        other.createdAtMs < row.createdAtMs &&
        sameOutboxScope(other, row) &&
        outboxRowUnresolved(other)
    }
  }

  private fun sameOutboxScope(
    left: ChatOutboxItem,
    right: ChatOutboxItem,
  ): Boolean = left.outboxScope() == right.outboxScope()

  // Queued/sending rows are still ahead in FIFO order, and an orphaned accepted row holds its
  // session only until history proof confirms or parks it (a bounded window). Parked failed
  // rows are terminal-manual state and do not strand later turns; explicit Retry re-orders
  // still-queued successors behind the retried head instead.
  private fun outboxRowUnresolved(row: ChatOutboxItem): Boolean =
    when (row.status) {
      ChatOutboxStatus.Queued, ChatOutboxStatus.Sending -> true
      ChatOutboxStatus.Accepted -> !locallyOwnedOutboxRow(row.id)
      ChatOutboxStatus.Failed -> false
    }

  // A row is live-owned when either its idempotency key or the run id the gateway
  // acknowledged it under still has local pending/unknown/unresolved state.
  private fun locallyOwnedOutboxRow(rowId: String): Boolean = locallyOwnedRun(rowId) || acknowledgedRunIdByRowId[rowId]?.let(::locallyOwnedRun) == true

  private fun locallyOwnedRun(runId: String): Boolean =
    synchronized(pendingRuns) { pendingRuns.contains(runId) } ||
      pendingRunProjectionsByRunId.containsKey(runId) ||
      unknownOutcomeRunIds.contains(runId) ||
      unresolvedRepliesByRunId.containsKey(runId)

  private fun locallyOwnedRunIds(): Set<String> =
    buildSet {
      addAll(synchronized(pendingRuns) { pendingRuns.toSet() })
      addAll(pendingRunProjectionsByRunId.keys)
      addAll(unknownOutcomeRunIds)
      addAll(unresolvedRepliesByRunId.keys)
    }

  private fun sameOutboxSession(
    left: String,
    right: String,
  ): Boolean = normalizeRequestedSessionKey(left) == normalizeRequestedSessionKey(right)

  private suspend fun markJournaledSendAccepted(row: ChatOutboxItem?) {
    persistJournaledSendState(row, ChatOutboxStatus.Accepted, null)
  }

  private suspend fun markJournaledSendUnconfirmed(row: ChatOutboxItem?) {
    persistJournaledSendState(row, ChatOutboxStatus.Failed, OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
  }

  // Mirrors the flush path's fail-closed persistence handling: a claimed row whose follow-up
  // state cannot be made durable must not silently stay 'sending' (it would block its session
  // with no user action available); the re-armed recovery sweep parks it once storage recovers.
  private suspend fun persistJournaledSendState(
    row: ChatOutboxItem?,
    status: ChatOutboxStatus,
    lastError: String?,
  ) {
    val outbox = commandOutbox ?: return
    if (row == null) return
    if (status != ChatOutboxStatus.Accepted) acknowledgedRunIdByRowId.remove(row.id)
    val persisted =
      try {
        outbox.updateStatusIfAttempt(
          row.id,
          row.attemptVersion,
          status,
          row.retryCount,
          lastError,
          expectedStatus = ChatOutboxStatus.Sending,
        )
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        null
      }
    if (persisted == null) {
      rearmOutboxRecovery()
      _healthOk.value = false
    }
    publishOutbox()
    kickFlushForRoutedBacklog()
  }

  // Sends routed to the queue while a direct dispatch held their session wait for that dispatch
  // to resolve; re-kick the single-flight flush so they do not idle until the next health event.
  private fun kickFlushForRoutedBacklog() {
    if (!_healthOk.value) return
    requestOutboxFlush()
  }

  /** Sends best-effort abort requests for every currently pending gateway run. */
  fun abort() {
    val abortGatewayId = currentCacheScope()?.gatewayId
    val runIds =
      synchronized(pendingRuns) {
        pendingRuns.toList()
      }
    if (runIds.isEmpty()) return
    scope.launch {
      for (runId in runIds) {
        try {
          val params =
            buildJsonObject {
              put("sessionKey", JsonPrimitive(_sessionKey.value))
              put("runId", JsonPrimitive(runId))
            }
          requestGatewayBound(abortGatewayId, "chat.abort", params.toString())
        } catch (_: Throwable) {
          // best-effort
        }
      }
    }
  }

  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    when (event) {
      "tick" -> {
        if (restoreRunStateOnReconnect) {
          refreshHistoryForRecovery(forceHealth = true)
        } else {
          scope.launch { pollHealthIfNeeded() }
        }
      }

      "health" -> {
        refreshQuestions()
        refreshProgressCard()
        if (restoreRunStateOnReconnect) {
          refreshHistoryForRecovery(forceHealth = true)
        } else {
          markHealthOk()
          refreshCommandsAfterReconnect()
        }
      }

      "seqGap" -> {
        // Metadata notifications can be dropped too, even when history and health remain current.
        refreshCommands()
        // Missed events can hide terminal state or usage for any active run.
        // Keep ownership, discard incomplete telemetry, and recover from snapshots.
        resetSwarmProgress()
        if (isSwarmEnabled()) refreshSwarmSessions()
        invalidateIncompleteRunTelemetry()
        publishRunPresentation()
        clearLiveRunUi()
        clearSubagentActivities()
        refreshQuestions()
        refreshProgressCard()
        refreshHistoryForRecovery()
      }

      "progressCard.changed" -> {
        if (payloadJson.isNullOrBlank()) return
        handleProgressCardChanged(payloadJson)
      }

      "chat" -> {
        if (payloadJson.isNullOrBlank()) return
        handleChatEvent(payloadJson)
      }

      "chat.metadata.changed" -> {
        refreshCommands()
      }

      "sessions.changed" -> {
        if (payloadJson.isNullOrBlank()) {
          refreshSessionsForCurrentWindow()
        } else {
          handleSessionsChangedEvent(payloadJson)
        }
      }

      "session.observer" -> {
        if (payloadJson.isNullOrBlank()) return
        handleSessionObserverEvent(payloadJson)
      }

      "session.message" -> {
        if (payloadJson.isNullOrBlank()) return
        handleSessionMessageEvent(payloadJson)
      }

      "agent" -> {
        if (payloadJson.isNullOrBlank()) return
        handleAgentEvent(payloadJson)
      }

      "task" -> {
        if (payloadJson.isNullOrBlank()) return
        handleTaskEvent(payloadJson)
      }

      "question.requested" -> {
        if (payloadJson.isNullOrBlank()) return
        handleQuestionRequested(payloadJson)
      }

      "question.resolved" -> {
        if (payloadJson.isNullOrBlank()) return
        handleQuestionResolved(payloadJson)
      }
    }
  }

  fun updateQuestionDraft(
    expected: ChatQuestionPrompt,
    update: (ChatQuestionDraft) -> ChatQuestionDraft,
  ) {
    synchronized(questionStateLock) {
      // Draft edits use the current value, but only the same live question may receive them.
      // They do not invalidate an in-flight question.list reconciliation.
      _questions.value =
        _questions.value.map { prompt ->
          if (prompt.promptOwner === expected.promptOwner && prompt.record == expected.record && prompt.status() == ChatQuestionStatus.Pending) {
            prompt.copy(draft = update(prompt.draft))
          } else {
            prompt
          }
        }
    }
  }

  fun resolveQuestion(
    expected: ChatQuestionPrompt,
    answers: Map<String, List<String>>,
  ) = resolveQuestion(expected = expected, answers = answers, cancel = false)

  fun skipQuestion(expected: ChatQuestionPrompt) = resolveQuestion(expected = expected, answers = null, cancel = true)

  private fun resolveQuestion(
    expected: ChatQuestionPrompt,
    answers: Map<String, List<String>>?,
    cancel: Boolean,
  ) {
    val gatewayId = currentCacheScope()?.gatewayId
    var claimedOwner: Any? = null
    var allowedHosts: List<String>? = null
    updateQuestions { prompts ->
      prompts.map { prompt ->
        if (prompt.promptOwner === expected.promptOwner && prompt.status() == ChatQuestionStatus.Pending) {
          claimedOwner = prompt.promptOwner
          allowedHosts = prompt.draft.secretStoreAllowedHosts(prompt.record.questions)
          prompt.copy(submitting = true, skipping = cancel, errorText = null)
        } else {
          prompt
        }
      }
    }
    // updateQuestions owns the question-state lock, so competing answer/skip callbacks
    // observe the first claim as Submitting and cannot launch a second mutation.
    // Terminal fanout preserves this owner; replacement or gateway retirement does not.
    val owner = claimedOwner ?: return
    scope.launch {
      try {
        val params =
          buildJsonObject {
            put("id", JsonPrimitive(expected.record.id))
            if (cancel) {
              put("cancel", JsonPrimitive(true))
            } else {
              allowedHosts?.let { put("secretStoreAllowedHosts", JsonArray(it.map(::JsonPrimitive))) }
              put(
                "answers",
                buildJsonObject {
                  put(
                    "answers",
                    buildJsonObject {
                      answers.orEmpty().forEach { (questionId, values) ->
                        put(questionId, JsonArray(values.map(::JsonPrimitive)))
                      }
                    },
                  )
                },
              )
            }
          }
        val result = json.parseToJsonElement(requestGatewayBound(gatewayId, "question.resolve", params.toString())).jsonObject
        val status = if (cancel) "cancelled" else "answered"
        check(result["status"].asStringOrNull() == status) { "Invalid question.resolve response" }
        // The Gateway owns normalized answers, including secret-store markers; never retain submitted values as the outcome.
        val resolvedAnswers = if (cancel) null else json.decodeFromJsonElement<QuestionAnswers>(result.getValue("answers"))
        updateQuestions { prompts ->
          prompts.map { prompt ->
            if (prompt.promptOwner === owner) {
              prompt.copy(
                record =
                  prompt.record.copy(
                    status = status,
                    answers = resolvedAnswers,
                  ),
                submitting = false,
                skipping = false,
                answeredLocally = !cancel,
                recoveryUnavailable = false,
                terminalObservedAtMs = prompt.terminalObservedAtMs ?: System.currentTimeMillis(),
              )
            } else {
              prompt
            }
          }
        }
      } catch (error: Throwable) {
        updateQuestions { prompts ->
          prompts.map { prompt ->
            if (prompt.promptOwner === owner) {
              prompt.copy(submitting = false, skipping = false, errorText = error.message ?: "Question failed")
            } else {
              prompt
            }
          }
        }
      }
    }
  }

  private fun refreshQuestions() {
    val gatewayScope = currentCacheScope()
    val refreshGeneration =
      synchronized(questionStateLock) {
        questionRefreshGeneration += 1
        questionRefreshGeneration
      }
    scope.launch {
      var retryIndex = 0
      var retryStateRevision: Long? = null
      while (true) {
        val expectedStateRevision = questionRefreshCurrentRevision(refreshGeneration, gatewayScope) ?: return@launch
        if (retryStateRevision != expectedStateRevision) {
          retryStateRevision = expectedStateRevision
          retryIndex = 0
        }
        val complete =
          runCatching {
            refreshQuestions(refreshGeneration, expectedStateRevision, gatewayScope)
          }.getOrDefault(false)
        if (complete) return@launch
        val currentStateRevision = questionRefreshCurrentRevision(refreshGeneration, gatewayScope) ?: return@launch
        if (currentStateRevision != expectedStateRevision) {
          // A local mutation invalidates the whole lookup snapshot, not one transport attempt.
          // Restart the bounded budget so the last attempt cannot strand another question.
          retryStateRevision = currentStateRevision
          retryIndex = 0
        }
        val retryDelayMs = QUESTION_REFRESH_RETRY_DELAYS_MS.getOrNull(retryIndex) ?: return@launch
        retryIndex += 1
        delay(retryDelayMs)
      }
    }
  }

  private suspend fun refreshQuestions(
    refreshGeneration: Long,
    stateRevision: Long,
    gatewayScope: ChatCacheScope?,
  ): Boolean {
    val response =
      if (gatewayAdvertisesMethod("question.list") == false) {
        null
      } else {
        try {
          requestGatewayBound(gatewayScope?.gatewayId, "question.list", "{}")
        } catch (err: GatewayRequestRejected) {
          val unavailable =
            err.gatewayError.missingScope() == "operator.questions" ||
              (
                err.gatewayError.code == "INVALID_REQUEST" &&
                  err.gatewayError.message == "unknown method: question.list"
              )
          if (!unavailable) throw err
          null
        }
      }
    if (response == null) {
      if (!questionRefreshIsCurrent(refreshGeneration, stateRevision, gatewayScope)) return false
      return synchronized(questionStateLock) {
        if (!questionRefreshIsCurrentLocked(refreshGeneration, stateRevision)) return@synchronized false
        publishQuestionsLocked(emptyList())
        true
      }
    }
    if (!questionRefreshIsCurrent(refreshGeneration, stateRevision, gatewayScope)) return false
    val listedRecords = json.decodeFromString<QuestionListResult>(response).questions
    val listedIds = listedRecords.mapTo(mutableSetOf()) { it.id }
    val missingPendingRecords =
      synchronized(questionStateLock) {
        if (!questionRefreshIsCurrentLocked(refreshGeneration, stateRevision)) return false
        _questions.value
          .filter { prompt ->
            prompt.record.id !in listedIds &&
              prompt.record.status == "pending" &&
              !prompt.recoveryUnavailable
          }.map { it.record }
      }
    val fallbackRecords = mutableListOf<QuestionRecord>()
    val unresolvedIds = mutableSetOf<String>()
    val unavailableIds = mutableSetOf<String>()
    for (record in missingPendingRecords) {
      val params = buildJsonObject { put("id", JsonPrimitive(record.id)) }
      try {
        val fallback = requestGatewayBound(gatewayScope?.gatewayId, "question.get", params.toString())
        fallbackRecords += json.decodeFromString<QuestionGetResult>(fallback).question
      } catch (err: CancellationException) {
        throw err
      } catch (err: GatewayRequestRejected) {
        if (err.gatewayError.details?.reason == "QUESTION_NOT_FOUND") {
          // The terminal tombstone has aged out, so the question is no longer actionable,
          // but its answered/cancelled/expired outcome cannot be reconstructed.
          unavailableIds += record.id
        } else {
          unresolvedIds += record.id
        }
      } catch (_: Throwable) {
        unresolvedIds += record.id
      }
    }
    if (!questionRefreshIsCurrent(refreshGeneration, stateRevision, gatewayScope)) return false
    val records = listedRecords + fallbackRecords.filter { it.id !in listedIds }
    return synchronized(questionStateLock) {
      if (!questionRefreshIsCurrentLocked(refreshGeneration, stateRevision)) return@synchronized false
      val current = _questions.value
      val existing = current.associateBy { it.record.id }
      val nowMs = System.currentTimeMillis()
      val refreshedIds = records.mapTo(mutableSetOf()) { it.id }
      val retainedCandidates =
        current
          .filter { prompt ->
            val status = prompt.status(nowMs)
            prompt.record.id !in refreshedIds &&
              (
                prompt.record.id in unresolvedIds ||
                  prompt.record.id in unavailableIds ||
                  (
                    status != ChatQuestionStatus.Pending &&
                      status != ChatQuestionStatus.Submitting
                  )
              )
          }
      val retainedPrompts =
        retainedCandidates.map { prompt ->
          if (prompt.record.id in unavailableIds) {
            prompt.copy(
              submitting = false,
              skipping = false,
              terminalObservedAtMs = prompt.terminalObservedAtMs ?: nowMs,
              recoveryUnavailable = true,
            )
          } else {
            prompt
          }
        }
      val next =
        records.map { record ->
          existing[record.id]?.let { prompt ->
            mergeQuestionPrompt(prompt, record, nowMs)
          } ?: ChatQuestionPrompt(
            record = record,
            terminalObservedAtMs = nowMs.takeIf { record.status != "pending" || nowMs >= record.expiresAtMs },
          )
        } + retainedPrompts
      publishQuestionsLocked(next)
      unresolvedIds.isEmpty()
    }
  }

  private fun questionRefreshCurrentRevision(
    refreshGeneration: Long,
    gatewayScope: ChatCacheScope?,
  ): Long? {
    if (gatewayScope != currentCacheScope()) return null
    return synchronized(questionStateLock) {
      questionStateRevision.takeIf { refreshGeneration == questionRefreshGeneration }
    }
  }

  private fun questionRefreshIsCurrent(
    refreshGeneration: Long,
    stateRevision: Long,
    gatewayScope: ChatCacheScope?,
  ): Boolean =
    gatewayScope == currentCacheScope() &&
      synchronized(questionStateLock) { questionRefreshIsCurrentLocked(refreshGeneration, stateRevision) }

  private fun questionRefreshIsCurrentLocked(
    refreshGeneration: Long,
    stateRevision: Long,
  ): Boolean = refreshGeneration == questionRefreshGeneration && stateRevision == questionStateRevision

  private fun handleQuestionRequested(payloadJson: String) {
    val record = runCatching { json.decodeFromString<QuestionRecord>(payloadJson) }.getOrNull() ?: return
    updateQuestions { prompts ->
      if (prompts.any { it.record.id == record.id }) {
        prompts.map { prompt ->
          if (prompt.record.id == record.id) {
            mergeQuestionPrompt(prompt, record, System.currentTimeMillis())
          } else {
            prompt
          }
        }
      } else {
        prompts + ChatQuestionPrompt(record)
      }
    }
    refreshQuestions()
  }

  private fun mergeQuestionPrompt(
    prompt: ChatQuestionPrompt,
    record: QuestionRecord,
    nowMs: Long,
  ): ChatQuestionPrompt {
    // Gateway terminal state is monotonic. A delayed requested/list replay must not
    // make an already resolved question actionable again.
    if ((prompt.record.status != "pending" || prompt.recoveryUnavailable) && record.status == "pending") return prompt
    // Outcome fields can change within one request; a replaced definition or lifetime owns new input.
    val sameQuestion = record.copy(status = prompt.record.status, answers = prompt.record.answers, resolvedBy = prompt.record.resolvedBy) == prompt.record
    if (!sameQuestion) {
      return ChatQuestionPrompt(record = record, terminalObservedAtMs = nowMs.takeIf { record.status != "pending" || nowMs >= record.expiresAtMs })
    }
    return prompt.copy(
      record = record.copy(answers = record.answers ?: prompt.record.answers),
      submitting = prompt.submitting && record.status == "pending",
      skipping = prompt.skipping && record.status == "pending",
      answeredLocally = prompt.answeredLocally && record.status == "answered",
      recoveryUnavailable = false,
      terminalObservedAtMs =
        if (record.status == "pending" && nowMs < record.expiresAtMs) {
          null
        } else {
          prompt.terminalObservedAtMs ?: nowMs
        },
    )
  }

  private fun handleQuestionResolved(payloadJson: String) {
    val payload = runCatching { json.parseToJsonElement(payloadJson).jsonObject }.getOrNull() ?: return
    val id = payload["id"].asStringOrNull() ?: return
    val status = payload["status"].asStringOrNull() ?: return
    val answers = payload["answers"]?.let { runCatching { json.decodeFromJsonElement<QuestionAnswers>(it) }.getOrNull() }
    val nowMs = System.currentTimeMillis()
    updateQuestions { prompts ->
      prompts.map { prompt ->
        if (prompt.record.id == id) {
          prompt.copy(
            record = prompt.record.copy(status = status, answers = answers ?: prompt.record.answers),
            submitting = false,
            skipping = false,
            recoveryUnavailable = false,
            terminalObservedAtMs = prompt.terminalObservedAtMs ?: nowMs,
          )
        } else {
          prompt
        }
      }
    }
    refreshQuestions()
  }

  private fun updateQuestions(transform: (List<ChatQuestionPrompt>) -> List<ChatQuestionPrompt>) {
    synchronized(questionStateLock) {
      publishQuestionsLocked(transform(_questions.value))
    }
  }

  private fun publishQuestionsLocked(prompts: List<ChatQuestionPrompt>): Boolean {
    // Terminal cards remain in history, but must not retain unsent (possibly secret) input.
    val next =
      prompts.map { prompt ->
        when (prompt.status()) {
          ChatQuestionStatus.Pending, ChatQuestionStatus.Submitting -> prompt
          else -> prompt.copy(draft = ChatQuestionDraft())
        }
      }
    val changed = next != _questions.value
    if (changed) {
      _questions.value = next
      questionStateRevision += 1
    }
    syncQuestionEvictionsLocked()
    return changed
  }

  private fun syncQuestionEvictionsLocked(nowMs: Long = System.currentTimeMillis()) {
    val currentById = _questions.value.associateBy { it.record.id }
    questionEvictionJobs.entries.removeAll { (id, scheduled) ->
      val prompt = currentById[id]
      if (prompt == null || scheduled.observedAtMs != prompt.terminalObservedAtMs) {
        scheduled.job.cancel()
        true
      } else {
        false
      }
    }
    for (prompt in _questions.value) {
      if (questionEvictionJobs.containsKey(prompt.record.id)) continue
      val id = prompt.record.id
      val observedAt = prompt.terminalObservedAtMs
      if (observedAt != null || prompt.record.status != "pending" || prompt.record.expiresAtMs == Long.MAX_VALUE) continue
      val remainingMs = (prompt.record.expiresAtMs - nowMs).coerceAtLeast(0)
      val job =
        scope.launch(start = CoroutineStart.LAZY) {
          delay(remainingMs)
          var shouldRefresh = false
          synchronized(questionStateLock) {
            questionEvictionJobs.remove(id)
            val current = _questions.value
            val next =
              current.map {
                if (it.record.id == id && it.record.status == "pending" && it.terminalObservedAtMs == null) {
                  it.copy(terminalObservedAtMs = System.currentTimeMillis())
                } else {
                  it
                }
              }
            shouldRefresh = publishQuestionsLocked(next)
          }
          // The local deadline is only a presentation fallback. Reconcile outside
          // the state lock in case another surface supplied the terminal outcome.
          if (shouldRefresh) refreshQuestions()
        }
      questionEvictionJobs[id] = QuestionEvictionJob(job, observedAt)
      job.start()
    }
  }

  private fun clearQuestions() {
    synchronized(questionStateLock) {
      questionRefreshGeneration += 1
      publishQuestionsLocked(emptyList())
    }
  }

  /**
   * Reconnect/seq-gap recovery: refetch history for the current session without the
   * beginHistoryLoad transient-state reset. Runs pending when the request begins stay
   * owned until that authoritative snapshot resolves them; resetting healthOk here
   * would block sends after reconnect.
   */
  private fun refreshHistoryForRecovery(forceHealth: Boolean = false) {
    val (key, generation) =
      synchronized(gatewayScopeApplyLock) {
        // Automatic hydration retries history failures without dismissing unrelated action errors.
        if (historyLoadErrorGeneration != null) updateErrorText(null)
        val key = normalizeRequestedSessionKey(_sessionKey.value)
        val generation = historyLoadGeneration.incrementAndGet()
        _sessionKey.value = key
        _historyLoading.value = true
        // A newer history request replaces transcript ownership, not an outstanding forced poll.
        pendingHealthRefresh = HealthRefresh(generation, forceHealth || pendingHealthRefresh?.force == true, refreshSessions = true)
        key to generation
      }
    val restoredRunIds =
      synchronized(pendingRuns) {
        val restored = disconnectedPendingRunIds.toSet()
        pendingRuns.addAll(restored)
        disconnectedPendingRunIds.clear()
        restored
      }
    restoredRunIds.forEach(::armPendingRunTimeout)
    publishRunPresentation()
    val runIdsToReconcile =
      synchronized(pendingRuns) {
        pendingRuns + optimisticMessagesByRunId.keys + unresolvedRepliesByRunId.keys
      }
    bootstrap(sessionKey = key, generation = generation, runIdsToReconcile = runIdsToReconcile)
  }

  // Once a chat is selected, cancelling its UI caller must not abandon hydration.
  private fun bootstrap(
    sessionKey: String,
    generation: Long,
    runIdsToReconcile: Set<String> = emptySet(),
  ) = scope.async {
    val healthRefresh = synchronized(gatewayScopeApplyLock) { pendingHealthRefresh?.takeIf { it.historyGeneration == generation } }
    try {
      // Cache-first cold open: live history always replaces cached rows wholesale.
      primeFromCache(sessionKey, generation)
      var historyResult: HistoryRefreshResult
      do {
        currentCoroutineContext().ensureActive()
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return@async
        historyResult =
          fetchAndApplyHistory(
            sessionKey,
            generation,
            updateSessionInfo = true,
            runIdsToReconcile = runIdsToReconcile,
            refreshBranches = true,
          )
        // Branch evidence can fence the only recovery request without a successor load.
        // Keep this owner, but fetch new history rather than adopting the rejected response.
      } while (historyResult == HistoryRefreshResult.BranchInvalidated)
      if (historyResult !is HistoryRefreshResult.Applied) return@async
      if (isSwarmEnabled()) refreshSwarmSessions()
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      synchronized(gatewayScopeApplyLock) {
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return@async
        updateErrorText(err.message, historyGeneration = generation)
      }
    } finally {
      finishHistoryHealth(healthRefresh, generation)
      synchronized(gatewayScopeApplyLock) {
        if (isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) {
          // Publication already retired history's loading state. Its tail must not clear
          // New's loading state, which can share the same history generation.
          if (liveHistoryMarker?.generation != generation) _historyLoading.value = false
          scheduleRecoveryHistoryReconciliation(sessionKey, generation, runIdsToReconcile)
        }
      }
    }
  }

  private fun finishHistoryHealth(
    refresh: HealthRefresh?,
    generation: Long,
  ) {
    synchronized(gatewayScopeApplyLock) {
      if (refresh == null || pendingHealthRefresh !== refresh || refresh.historyGeneration != generation) return
      refresh.historyOwners -= 1
    }
  }

  /**
   * Requests live history and applies it to controller state, replacing any cached transcript.
   * Reports when a newer load superseded this request (stale responses are dropped).
   */
  private suspend fun fetchAndApplyHistory(
    sessionKey: String,
    generation: Long,
    updateSessionInfo: Boolean,
    runIdsToReconcile: Set<String> = emptySet(),
    markCompletedTranscript: Boolean = false,
    refreshBranches: Boolean = false,
    mutationReconciliationState: ChatOutboxBranchState? = null,
  ): HistoryRefreshResult {
    val requestSequence = historyRequestSequence.incrementAndGet()
    val healthRefresh =
      synchronized(gatewayScopeApplyLock) {
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return HistoryRefreshResult.Superseded
        pendingHealthRefresh?.takeIf { it.historyGeneration?.let { owner -> owner <= generation } == true }?.also {
          // Only current-generation history can finish the obligation; an older request
          // must not release it while a same-generation sibling can still apply.
          if (it.historyGeneration != generation) {
            it.historyGeneration = generation
            it.historyOwners = 0
          }
          it.historyOwners += 1
        }
      }
    try {
      val runIdsOwnedAtRequest = synchronized(pendingRuns) { pendingRuns.toSet() }
      val requestCacheScope = currentCacheScope()
      val requestTracksDefaultAgent = activeSessionTracksDefaultAgent(sessionKey)
      awaitMainSessionReadiness(sessionKey, requestCacheScope)
      val requestSettingsGeneration = settingsPublicationGeneration.get()
      val requestDefaultAgentRevision = currentDefaultAgentRevision()
      val requestAgentId = resolveAgentIdForSessionKey(sessionKey) ?: return HistoryRefreshResult.OwnerUnavailable

      fun requestOwnerIsCurrent(): Boolean =
        resolveAgentIdForSessionKey(_sessionKey.value) == requestAgentId &&
          (
            !requestTracksDefaultAgent ||
              (currentDefaultAgentRevision() == requestDefaultAgentRevision && effectiveDefaultAgentId() == requestAgentId)
          )

      fun isCurrent(): Boolean =
        isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) &&
          requestCacheScope == currentCacheScope() &&
          requestOwnerIsCurrent() &&
          requestSequence >= latestAppliedHistoryRequest

      if (!synchronized(gatewayScopeApplyLock) { isCurrent() }) return HistoryRefreshResult.Superseded
      val branchSnapshot = currentSessionActionSnapshot(sessionKey)
      // Publishing a transcript establishes enqueue intent, not dispatch readiness. A requested
      // listing must still settle the active branch before health can release this scope.
      if (refreshBranches) branchSnapshot?.let { markOutboxBranchUnreconciled(it.gatewayScope, it.outboxScope()) }
      // Only a locally ambiguous mutation carries an earlier adoption boundary. Ordinary history
      // (including remote branch events) must settle earlier input before becoming visible.
      var historyBranchState = mutationReconciliationState ?: branchSnapshot?.let { branchState(it) }
      val history =
        try {
          val historyJson =
            requestGatewayBound(
              requestCacheScope?.gatewayId,
              "chat.history",
              buildJsonObject {
                put("sessionKey", JsonPrimitive(sessionKey))
                put("agentId", JsonPrimitive(requestAgentId))
              }.toString(),
            )
          parseHistory(historyJson, sessionKey = sessionKey, previousMessages = _messages.value)
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (!synchronized(gatewayScopeApplyLock) { isCurrent() }) return HistoryRefreshResult.Superseded
          throw err
        }
      var appliedHistoryEntry: ChatSessionEntry? = null
      val applied =
        historyPublicationMutex.withLock {
          if (!synchronized(gatewayScopeApplyLock) { isCurrent() }) return@withLock HistoryRefreshResult.Superseded
          val previousState =
            historyBranchState?.let { captured ->
              // Continue only a committed history publication from this load. Never recapture after
              // enqueue or borrow authority from branch listings or mutation-lease changes.
              publishedHistoryBranch
                ?.takeIf {
                  mutationReconciliationState == null &&
                    it.snapshot == branchSnapshot &&
                    it.generation == generation &&
                    it.state.revision > captured.revision
                }?.state ?: captured
            }
          historyBranchState = previousState
          if (
            mutationReconciliationState == null &&
            branchSnapshot != null &&
            previousState != null
          ) {
            historyBranchState = reconcileOutboxHistory(
              outbox = commandOutbox ?: return@withLock HistoryRefreshResult.OwnerUnavailable,
              gatewayId = requestCacheScope?.gatewayId ?: return@withLock HistoryRefreshResult.OwnerUnavailable,
              branchScope = branchSnapshot.outboxScope(),
              previousState = previousState,
              history = history,
            ) ?: return@withLock HistoryRefreshResult.BranchInvalidated
          }
          synchronized(gatewayScopeApplyLock) {
            if (!isCurrent()) return@synchronized HistoryRefreshResult.Superseded
            val runIdsOwnedAfterRequest =
              synchronized(pendingRuns) {
                pendingRuns.filterNotTo(mutableSetOf()) { it in runIdsOwnedAtRequest }
              }
            latestAppliedHistoryRequest = requestSequence
            if (mutationReconciliationState == null && branchSnapshot != null && historyBranchState != previousState) {
              historyBranchState?.let { publishedHistoryBranch = PublishedHistoryBranch(branchSnapshot, generation, it) }
            }
            // History may still carry useful messages after a settings write or event.
            // Only its settings projection is stale; do not discard the transcript.
            appliedHistoryEntry =
              updateSessionFromHistory(
                history,
                ownerAgentId = requestAgentId,
                publishRunState = false,
                includeSessionInfo = updateSessionInfo,
                preserveSessionSettings =
                  requestSettingsGeneration != settingsPublicationGeneration.get() ||
                    pendingSettingsMutations.containsKey(sessionSettingsKey(sessionKey)),
              )
            transferLostAckOwnershipFromHistory(history)
            resolvePersistedReplies(history.messages)
            val snapshotRunId =
              history.inFlightRun
                ?.runId
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
            latestAppliedInFlightRunId = snapshotRunId
            val optimisticRunIds = runIdsToReconcile.filterTo(mutableSetOf()) { optimisticMessagesByRunId.containsKey(it) }
            prunePersistedOptimisticMessages(history.messages)
            if (snapshotRunId == null) {
              optimisticRunIds
                .filterNot { runId ->
                  unknownOutcomeRunIds.contains(runId) && unresolvedRepliesByRunId.containsKey(runId)
                }.filterNotTo(mutableSetOf()) { optimisticMessagesByRunId.containsKey(it) }
                .forEach { clearPendingRun(it, publishRunState = false) }
            }
            if (snapshotRunId != null) {
              runIdsToReconcile
                .filterTo(mutableSetOf()) {
                  it != snapshotRunId &&
                    !optimisticMessagesByRunId.containsKey(it) &&
                    !unresolvedRepliesByRunId.containsKey(it)
                }.forEach { clearPendingRun(it, publishRunState = false) }
            }
            val nextMessages = mergeOptimisticMessages(incoming = history.messages, optimistic = optimisticMessagesByRunId.values)
            _messagesFromCache.value = false
            _messages.value = nextMessages
            val previousAnchor = _transcriptAnchor.value?.takeIf { it.sessionKey == sessionKey }
            val completionSettled =
              markCompletedTranscript &&
                runIdsToReconcile.none(unresolvedRepliesByRunId::containsKey) &&
                history.sessionInfo?.endedAt != null
            _transcriptAnchor.value =
              ChatTranscriptAnchorState(
                sessionKey = sessionKey,
                newestItemId = nextMessages.lastOrNull()?.id,
                completedEndedAt =
                  if (completionSettled) history.sessionInfo.endedAt else previousAnchor?.completedEndedAt,
                completedNewestItemId =
                  if (completionSettled) history.messages.lastOrNull()?.id else previousAnchor?.completedNewestItemId,
              )
            _sessionId.value = history.sessionId
            history.sessionId?.let { sessionId ->
              lastSelectedChatSessionByOwner[ChatAgentSessionSelectionOwner(requestCacheScope?.gatewayId, requestAgentId)]
                ?.takeIf { it.key == sessionKey }
                ?.observedSessionId = sessionId
            }
            markLiveHistoryApplied(sessionKey = sessionKey, sessionId = history.sessionId, generation = generation)
            _historyLoading.value = false
            if (historyLoadErrorGeneration == generation) {
              updateErrorText(null)
            }
            if (history.inFlightRun == null) {
              // Empty history is terminal proof for acknowledged runs. An unknown-outcome
              // send stays owned until its reply persists, a terminal arrives, or it expires.
              runIdsToReconcile
                .filterNot { runId ->
                  unknownOutcomeRunIds.contains(runId) && unresolvedRepliesByRunId.containsKey(runId)
                }.forEach { clearPendingRun(it, publishRunState = false) }
            }
            clearTransientRunUiIfIdle()
            // All live history paths (bootstrap, reconnect recovery, cache-first
            // replace) adopt the gateway's in-flight run snapshot so restored
            // runs keep their pending state and streaming text.
            adoptInFlightRun(history, runIdsOwnedAfterRequest)
            publishRunPresentation()
            enqueueTranscriptCacheWrite(requestCacheScope, requestAgentId, sessionKey, history.messages)
            HistoryRefreshResult.Applied(historyBranchState)
          }
        }
      if (applied !is HistoryRefreshResult.Applied) return applied
      // Canonical history retires delivered rows before further RPCs can delay that proof.
      // Resuming their queued successors still waits for branch reconciliation and health.
      val outboxChanged =
        commandOutbox != null && requestCacheScope != null &&
          reconcileDurableSendsAgainstHistory(commandOutbox, requestCacheScope.gatewayId, history, requestAgentId)
      publishOutbox()
      appliedHistoryEntry?.let { acknowledgeUnreadIfNeeded(it.key, it, requireActive = true) }
      if (refreshBranches && branchSnapshot != null) {
        refreshSessionBranches(branchSnapshot, historyBranchState, BranchRefreshPurpose.Reconcile)
      }
      pollHealthIfNeeded(sessionKey, generation)
      if (outboxChanged) kickFlushForRoutedBacklog()
      return applied
    } finally {
      finishHistoryHealth(healthRefresh, generation)
    }
  }

  private suspend fun awaitMainSessionReadiness(
    sessionKey: String,
    requestScope: ChatCacheScope?,
  ) {
    val readiness =
      synchronized(mainSessionReadinessLock) {
        mainSessionReadiness
          ?.takeIf { state ->
            state.gatewayScope == requestScope && state.binding.key == sessionKey
          }?.ready
      }
    readiness?.await()
  }

  private suspend fun reconcileOutboxHistory(
    outbox: ChatCommandOutbox,
    gatewayId: String,
    branchScope: ChatOutboxScope,
    previousState: ChatOutboxBranchState,
    history: ChatHistory,
  ): ChatOutboxBranchState? {
    val tip = history.messages.asReversed().firstNotNullOfOrNull { it.entryId }
    if (previousState.switchPendingSinceMs != null || (tip == null && history.messages.isNotEmpty())) return previousState
    val persistedAttempts =
      if (previousState.lastActiveLeafEntryId == null) history.persistedOutboxAttempts(outbox.load(gatewayId)) else emptyMap()
    // Room validates the captured revision and each attempt before publishing branch ownership.
    return outbox.reconcileBranchScope(
      gatewayId = gatewayId,
      scope = branchScope,
      evidence = ChatOutboxBranchEvidence.History(previousState, persistedAttempts),
      activeLeafEntryId = tip,
      activeTranscriptEntryIds = history.messages.mapNotNullTo(mutableSetOf()) { it.entryId },
      lastError = OUTBOX_BRANCH_CHANGED_ERROR,
    )
  }

  /** Emits cached transcript/session rows for instant cold open; live data replaces them wholesale. */
  private suspend fun primeFromCache(
    sessionKey: String,
    generation: Long,
  ) {
    val cache = transcriptCache ?: return
    val requestCacheScope = currentCacheScope() ?: return
    val explicitAgentId = resolveAgentIdFromMainSessionKey(sessionKey)
    val selectedOwnerAgentId = _sessionOwnerAgentId.value
    val requestTracksDefaultAgent = explicitAgentId == null && selectedOwnerAgentId == null
    val requestDefaultAgentRevision = currentDefaultAgentRevision()
    val liveDefaultAgentId = effectiveDefaultAgentId()
    val requestAgentId =
      explicitAgentId
        ?: selectedOwnerAgentId
        ?: liveDefaultAgentId
        ?: runCatching { cache.loadLastDefaultAgentId(requestCacheScope.gatewayId) }.getOrNull()
        ?: return

    if (requestTracksDefaultAgent && liveDefaultAgentId == null) {
      // Cache I/O suspends. A newer hello/default-owner event must win before this persisted
      // fallback reaches composer state, or an offline owner can overwrite live routing proof.
      val persistedOwnerIsStillCurrent =
        requestCacheScope == currentCacheScope() &&
          currentDefaultAgentRevision() == requestDefaultAgentRevision &&
          currentDefaultAgentId()?.trim().isNullOrEmpty() &&
          effectiveDefaultAgentId() == null
      if (!persistedOwnerIsStillCurrent) return
      // The persisted owner is the routing proof for an offline process restart. Publish it to
      // composer consumers too; otherwise cached history and editable drafts disagree on owner.
      lastVerifiedDefaultAgentId = requestAgentId
      lastVerifiedDefaultAgentGatewayId = requestCacheScope.gatewayId
      composerDefaultAgentOwnerMutable.value = GatewayDefaultAgentOwner(requestCacheScope.gatewayId, requestAgentId)
      // NodeRuntime owns the device-scoped key shape. Rebuild it from persisted routing proof so
      // offline sends target the same immutable session instead of the mutable `main` alias.
      onOfflineDefaultAgentRestored(requestAgentId)
    }

    fun requestOwnerIsCurrent(): Boolean =
      resolveAgentIdForSessionKey(_sessionKey.value) == requestAgentId &&
        (
          !requestTracksDefaultAgent ||
            (
              currentDefaultAgentRevision() == requestDefaultAgentRevision &&
                (effectiveDefaultAgentId() == requestAgentId || (liveDefaultAgentId == null && effectiveDefaultAgentId() == null))
            )
        )
    val cached =
      runCatching { cache.loadTranscript(requestCacheScope.gatewayId, requestAgentId, sessionKey) }
        .getOrDefault(emptyList())
    synchronized(gatewayScopeApplyLock) {
      val projectedMessages = optimisticMessagesByRunId.values.toList()
      val visibleRowsAreOnlyProjected = _messages.value.all { message -> message in projectedMessages }
      if (
        cached.isNotEmpty() &&
        visibleRowsAreOnlyProjected &&
        requestCacheScope == currentCacheScope() &&
        requestOwnerIsCurrent() &&
        isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())
      ) {
        _messagesFromCache.value = true
        _messages.value = mergeOptimisticMessages(incoming = cached, optimistic = projectedMessages)
      }
    }
    if (_sessions.value.isEmpty()) {
      val cachedSessions = runCatching { cache.loadSessions(requestCacheScope.gatewayId, requestAgentId) }.getOrDefault(emptyList())
      synchronized(gatewayScopeApplyLock) {
        if (
          cachedSessions.isNotEmpty() &&
          _sessions.value.isEmpty() &&
          requestCacheScope == currentCacheScope() &&
          requestOwnerIsCurrent()
        ) {
          _sessions.value =
            reconcileGlobalObserverDigestOwner(
              cachedSessions.map { session -> session.copy(ownerAgentId = requestAgentId) },
              activeAgentId = requestAgentId,
            )
        }
      }
    }
  }

  // Write-through uses the scope captured before the live request. Re-resolving here could put
  // an old response under a newly selected gateway. Failures are ignored: the cache is disposable.
  private fun enqueueTranscriptCacheWrite(
    requestCacheScope: ChatCacheScope?,
    agentId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  ) {
    val cache = transcriptCache ?: return
    val capturedScope = requestCacheScope ?: return
    // Enter the cache queue before releasing the publication lock: neither another IO thread
    // nor a reconnect health wait may let a newer snapshot persist ahead of this one.
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      cacheMutationMutex.withLock {
        if (capturedScope != currentCacheScope()) return@withLock
        runCatching { cache.saveTranscript(capturedScope.gatewayId, agentId, sessionKey, messages) }
      }
    }
  }

  private suspend fun persistSessions(
    requestCacheScope: ChatCacheScope?,
    agentId: String,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String?,
  ) {
    val cache = transcriptCache ?: return
    val capturedScope = requestCacheScope ?: return
    cacheMutationMutex.withLock {
      if (capturedScope != currentCacheScope()) return@withLock
      runCatching { cache.saveSessions(capturedScope.gatewayId, agentId, sessions, retainedSessionKey) }
    }
  }

  private suspend fun fetchSessions(
    limit: Int?,
    archived: Boolean = false,
  ): Boolean {
    val requestCacheScope = currentCacheScope()
    val requestLimit = limit?.takeIf { it > 0 }
    val requestTracksDefaultAgent = activeSessionTracksDefaultAgent(_sessionKey.value)
    val requestDefaultAgentRevision = currentDefaultAgentRevision()
    val requestAgentId = resolveAgentIdForSessionKey(_sessionKey.value) ?: return false

    fun requestOwnerIsCurrent(): Boolean {
      val currentAgentId = resolveAgentIdForSessionKey(_sessionKey.value)
      return requestCacheScope == currentCacheScope() &&
        currentAgentId == requestAgentId &&
        (!requestTracksDefaultAgent || currentDefaultAgentRevision() == requestDefaultAgentRevision)
    }
    val requestSequence = sessionsRequestSequence.incrementAndGet()
    val refresh = SessionSettingsRead(requestCacheScope, requestAgentId)
    synchronized(gatewayScopeApplyLock) { activeSessionReads.add(refresh) }
    try {
      retryFailedSessionSettingsReconciliations(requestCacheScope, requestAgentId)
      while (true) {
        // A sessions list must not straddle local settings transactions or newer
        // authoritative session events and restore stale picker state.
        waitForPendingSessionSettings(requestCacheScope)
        if (!requestOwnerIsCurrent() || requestSequence != sessionsRequestSequence.get()) return false
        val settingsRevision =
          synchronized(gatewayScopeApplyLock) {
            refresh.settingsSnapshots.clear()
            settingsMutationRevision(requestCacheScope)
          }
        val params =
          buildJsonObject {
            put("includeGlobal", JsonPrimitive(true))
            put("includeUnknown", JsonPrimitive(false))
            put("agentId", JsonPrimitive(requestAgentId))
            if (requestLimit != null) put("limit", JsonPrimitive(requestLimit))
            if (archived) put("archived", JsonPrimitive(true))
          }
        val res = requestGateway("sessions.list", params.toString())
        val parsed = parseSessions(res)
        val result =
          parsed.copy(
            sessions = parsed.sessions.map { session -> session.copy(ownerAgentId = requestAgentId) },
          )
        var retainedSessionKey: String? = null
        val appliedSessions =
          synchronized(gatewayScopeApplyLock) {
            if (!requestOwnerIsCurrent()) return false
            if (requestSequence != sessionsRequestSequence.get()) return false
            if (
              settingsRevision != settingsMutationRevision(requestCacheScope) ||
              hasPendingSessionSettings(requestCacheScope) ||
              refresh.hasConflictingSettings(result.sessions)
            ) {
              null
            } else {
              val activeSessionKey = _sessionKey.value
              // A filtered drawer page cannot evict the selected history row. Retain only
              // the current owner's row; explicit deletion retires it before publication.
              val selected =
                _sessions.value
                  .firstOrNull {
                    it.key == activeSessionKey && it.ownerAgentId == requestAgentId
                  }?.takeIf { result.sessions.none { row -> row.key == activeSessionKey } }
              val sessions = if (selected == null) result.sessions else result.sessions + selected
              _sessions.value = sessions
              result.sessions.forEach { observeSessionSettings(it) }
              sessionsListArchived = archived
              sessionsListLimit = requestLimit
              val activeOutsideLocalWindow =
                sessions
                  .drop(MAX_CACHED_SESSIONS)
                  .any { session -> session.key == activeSessionKey }
              retainedSessionKey = activeSessionKey.takeIf { selected != null || result.isTruncated || activeOutsideLocalWindow }
              sessions
            }
          }
        if (appliedSessions == null) continue
        pruneRunTelemetryToAuthoritativeOwnership()
        publishRunPresentation()
        unreadPatchSessionKey?.let { trackedKey ->
          acknowledgeUnreadIfNeeded(
            key = trackedKey,
            entry = result.sessions.firstOrNull { it.key == trackedKey },
            requireActive = true,
          )
        }
        if (!archived) {
          persistSessions(requestCacheScope, requestAgentId, appliedSessions, retainedSessionKey)
        }
        return true
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      // best-effort
      return false
    } finally {
      synchronized(gatewayScopeApplyLock) {
        activeSessionReads.remove(refresh)
        pruneSettingsMutationRevision(requestCacheScope)
      }
    }
    return false
  }

  private fun currentChatMetadataScope(): ChatMetadataScope? {
    val sessionKey = _sessionKey.value
    val agentId = resolveAgentIdForSessionKey(sessionKey) ?: return null
    // Stable v2026.7.1-2 accepts only agentId. Retire this negotiation only when the
    // minimum supported Gateway contract guarantees session-scoped chat.metadata.
    return ChatMetadataScope(agentId, sessionKey.takeIf { gatewayAdvertisesCapability(SESSION_SCOPED_CHAT_METADATA_CAPABILITY) == true })
  }

  private fun clearChatMetadata(nextScope: ChatMetadataScope? = null) {
    _commands.value = emptyList()
    _modelCatalog.value = emptyList()
    chatMetadataScope = nextScope
    chatMetadataLoadState = ChatMetadataLoadState.Unloaded
  }

  private suspend fun fetchChatMetadata(requestSequence: Long = chatMetadataRequestSequence.incrementAndGet()) {
    val requestCacheScope = currentCacheScope()
    val metadataScope = currentChatMetadataScope() ?: return
    synchronized(gatewayScopeApplyLock) {
      if (requestSequence != chatMetadataRequestSequence.get()) return
      if (chatMetadataScope != metadataScope) {
        clearChatMetadata(metadataScope)
        disableSwarmProgress()
      }
    }
    var shouldRefreshSwarm = false
    var shouldDisableSwarm = false
    try {
      val res = requestGatewayBound(requestCacheScope?.gatewayId, "chat.metadata", metadataScope.params().toString())
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val metadataSwarmEnabled = root?.get("swarmEnabled").asBooleanOrNull() == true
      synchronized(gatewayScopeApplyLock) {
        if (
          requestSequence == chatMetadataRequestSequence.get() &&
          requestCacheScope == currentCacheScope() &&
          metadataScope == currentChatMetadataScope()
        ) {
          _commands.value = parseChatCommands(json, res)
          val models = parseGatewayModels(root?.get("models") as? JsonArray)
          _modelCatalog.value = models
          // chat.metadata cannot distinguish a valid empty catalog from its timeout fallback.
          // Retry one empty response, then accept empty so health events cannot poll forever.
          chatMetadataLoadState =
            when {
              models.isNotEmpty() -> ChatMetadataLoadState.Loaded
              chatMetadataLoadState == ChatMetadataLoadState.RetryEmptyCatalog -> ChatMetadataLoadState.Loaded
              else -> ChatMetadataLoadState.RetryEmptyCatalog
            }
          synchronized(swarmLock) { swarmEnabled = metadataSwarmEnabled }
          shouldRefreshSwarm = metadataSwarmEnabled
          shouldDisableSwarm = !metadataSwarmEnabled
        }
      }
    } catch (_: Throwable) {
      // A transport failure is not a replacement availability or capability snapshot.
    }
    when {
      shouldRefreshSwarm -> refreshSwarmSessions()
      shouldDisableSwarm -> resetSwarmProgress()
    }
  }

  private fun disableSwarmProgress(sessionKey: String = _sessionKey.value) {
    synchronized(swarmLock) { swarmEnabled = false }
    resetSwarmProgress(sessionKey)
  }

  private fun resetSwarmProgress(sessionKey: String = _sessionKey.value) {
    synchronized(swarmLock) {
      swarmRefreshJob?.cancel()
      swarmRefreshJob = null
      swarmRequestSequence.incrementAndGet()
      swarmSessionKey = sessionKey
      swarmActivityTracker.clear()
      swarmSessions = emptyList()
      _swarmGroups.value = emptyList()
    }
  }

  private fun isSwarmEnabled(): Boolean = synchronized(swarmLock) { swarmEnabled }

  private fun observeSwarmEvent(payload: JsonObject): Boolean {
    if (!isSwarmEnabled()) return false
    val parentKey = _sessionKey.value
    if (!chatSwarmEventBelongsToParent(payload) { candidate -> sameOutboxSession(candidate, parentKey) }) return false
    val observed = synchronized(swarmLock) { swarmActivityTracker.observe(payload) }
    if (!observed) return false
    val source = payload["session"].asObjectOrNull() ?: payload
    val kind = (if ("kind" in payload) payload["kind"] else source["kind"]).asStringOrNull()?.trim()
    if (kind == "phase" || kind == "log") {
      publishSwarmGroups()
    } else {
      scheduleSwarmRefresh()
    }
    return true
  }

  private fun publishSwarmGroups(expectedLease: SwarmRefreshLease? = null) {
    val snapshot =
      synchronized(swarmLock) {
        if (expectedLease != null && !isSwarmRefreshLeaseCurrentLocked(expectedLease)) return
        val projectionCacheScope = expectedLease?.cacheScope ?: currentCacheScope() ?: return
        SwarmProjectionSnapshot(
          parentKey = _sessionKey.value,
          cacheScope = projectionCacheScope,
          requestSequence = swarmRequestSequence.get(),
          sessions = swarmActivityTracker.decorate(swarmSessions),
        )
      }
    val groups =
      buildChatSwarmGroups(snapshot.sessions) { candidate -> sameOutboxSession(candidate, snapshot.parentKey) }
    synchronized(swarmLock) {
      if (
        !swarmEnabled ||
        snapshot.cacheScope != currentCacheScope() ||
        snapshot.requestSequence != swarmRequestSequence.get() ||
        !sameOutboxSession(snapshot.parentKey, _sessionKey.value)
      ) {
        return
      }
      swarmSessionKey = snapshot.parentKey
      _swarmGroups.value = groups
    }
  }

  private fun scheduleSwarmRefresh() {
    scheduleSwarmRefresh(delayMs = 250)
  }

  private fun refreshSwarmSessions() {
    scheduleSwarmRefresh(delayMs = 0)
  }

  private fun scheduleSwarmRefresh(delayMs: Long) {
    synchronized(swarmLock) {
      if (!swarmEnabled) return
      val requestCacheScope = currentCacheScope() ?: return
      val lease =
        SwarmRefreshLease(
          parentKey = _sessionKey.value,
          cacheScope = requestCacheScope,
          requestSequence = swarmRequestSequence.incrementAndGet(),
        )
      swarmRefreshJob?.cancel()
      swarmRefreshJob =
        scope.launch {
          if (delayMs > 0) delay(delayMs)
          fetchSwarmSessions(lease, attempt = 0)
        }
    }
  }

  private fun isSwarmRefreshLeaseCurrent(lease: SwarmRefreshLease): Boolean = synchronized(swarmLock) { isSwarmRefreshLeaseCurrentLocked(lease) }

  private fun isSwarmRefreshLeaseCurrentLocked(lease: SwarmRefreshLease): Boolean =
    swarmEnabled &&
      lease.requestSequence == swarmRequestSequence.get() &&
      lease.cacheScope == currentCacheScope() &&
      sameOutboxSession(lease.parentKey, _sessionKey.value)

  private suspend fun fetchSwarmSessions(
    lease: SwarmRefreshLease,
    attempt: Int,
  ) {
    if (!isSwarmRefreshLeaseCurrent(lease)) return
    val rows =
      try {
        collectChatSwarmChildSessions { offset ->
          if (!isSwarmRefreshLeaseCurrent(lease)) throw CancellationException()
          val params =
            buildJsonObject {
              put("includeGlobal", JsonPrimitive(false))
              put("includeUnknown", JsonPrimitive(false))
              put("configuredAgentsOnly", JsonPrimitive(true))
              put("spawnedBy", JsonPrimitive(lease.parentKey))
              put("limit", JsonPrimitive(10_000))
              put("offset", JsonPrimitive(offset))
            }
          val root =
            json
              .parseToJsonElement(requestGatewayBound(lease.cacheScope.gatewayId, "sessions.list", params.toString()))
              .asObjectOrNull()
              ?: throw IllegalStateException("invalid sessions.list response")
          ChatSwarmSessionPage(
            sessions = root["sessions"].asArrayOrNull().orEmpty().mapNotNull { parseSessionEntry(it.asObjectOrNull()) },
            totalCount = root["totalCount"].asLongOrNull()?.toInt(),
            nextOffset = root["nextOffset"].asLongOrNull()?.toInt(),
            hasMore = root["hasMore"].asBooleanOrNull(),
          )
        }
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        if (isSwarmRefreshLeaseCurrent(lease)) {
          scheduleSwarmRetry(lease, attempt)
        }
        return
      }
    synchronized(swarmLock) {
      if (!isSwarmRefreshLeaseCurrentLocked(lease)) return
      if (swarmSessionKey != lease.parentKey) {
        swarmSessionKey = lease.parentKey
        swarmActivityTracker.clear()
      }
      swarmSessions = swarmActivityTracker.decorate(rows)
    }
    publishSwarmGroups(lease)
  }

  private fun scheduleSwarmRetry(
    lease: SwarmRefreshLease,
    attempt: Int,
  ) {
    val delayMs = SWARM_REFRESH_RETRY_DELAYS_MS.getOrNull(attempt) ?: return
    synchronized(swarmLock) {
      if (!isSwarmRefreshLeaseCurrentLocked(lease)) return
      swarmRefreshJob?.cancel()
      swarmRefreshJob =
        scope.launch {
          delay(delayMs)
          fetchSwarmSessions(lease, attempt = attempt + 1)
        }
    }
  }

  private suspend fun fetchSessionsForCurrentWindow(): Boolean = fetchSessions(limit = sessionsListLimit, archived = sessionsListArchived)

  private fun refreshSessionsForCurrentWindow() {
    scope.launch { fetchSessionsForCurrentWindow() }
  }

  private suspend fun pollHealthIfNeeded(
    sessionKey: String = _sessionKey.value,
    historyGeneration: Long? = null,
  ) {
    val refresh: HealthRefresh
    val requestCacheScope: ChatCacheScope?
    val selection: SessionActionSnapshot?
    val defaultAgentRevision: Long?
    val shouldPoll: Boolean
    synchronized(gatewayScopeApplyLock) {
      refresh =
        if (historyGeneration == null) {
          val pending = pendingHealthRefresh
          // Failed history releases its hold, not Refresh's forced health check.
          if (pending != null && pending.historyGeneration == historyLoadGeneration.get() && pending.historyOwners > 0) return
          pending ?: HealthRefresh()
        } else {
          if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, historyGeneration, historyLoadGeneration.get())) return
          pendingHealthRefresh?.takeIf { it.historyGeneration?.let { owner -> owner <= historyGeneration } == true } ?: return
        }
      if (refresh.claimed) return
      val now = System.currentTimeMillis()
      shouldPoll = refresh.force || lastHealthPollAtMs?.let { now - it >= 10_000 } != false
      if (!shouldPoll && historyGeneration == null) return
      if (shouldPoll) lastHealthPollAtMs = now
      refresh.claimed = true
      pendingHealthRefresh = refresh
      requestCacheScope = currentCacheScope()
      selection = currentSessionActionSnapshot(sessionKey)
      defaultAgentRevision = currentDefaultAgentRevision().takeIf { activeSessionTracksDefaultAgent(sessionKey) }
    }
    val lease = captureRequestLease(requestCacheScope)

    fun ownsSelection(): Boolean =
      requestCacheScope == currentCacheScope() && sessionKey == _sessionKey.value &&
        selection == currentSessionActionSnapshot(sessionKey) &&
        (defaultAgentRevision == null || defaultAgentRevision == currentDefaultAgentRevision())

    fun isCurrent(): Boolean = pendingHealthRefresh === refresh && ownsSelection()

    // A session-action caller can stop awaiting history after this controller claimed its refresh.
    scope
      .async(start = CoroutineStart.UNDISPATCHED) {
        try {
          currentCoroutineContext().ensureActive()
          val healthy =
            if (!shouldPoll) {
              null
            } else {
              try {
                val connection = lease ?: throw GatewayRequestNotEnqueued("not connected")
                connection.request("health", null) { enqueue ->
                  synchronized(gatewayScopeApplyLock) {
                    if (!isCurrent()) throw GatewayRequestNotEnqueued("chat refresh superseded")
                    enqueue()
                  }
                }
                currentCoroutineContext().ensureActive()
                true
              } catch (err: CancellationException) {
                throw err
              } catch (_: Throwable) {
                false
              }
            }
          var applied = false
          val publish = {
            synchronized(gatewayScopeApplyLock) {
              if (isCurrent()) {
                pendingHealthRefresh = null
                if (healthy == true) {
                  if (historyGeneration != null) restoreRunStateOnReconnect = false
                  markHealthOk()
                } else if (healthy == false) {
                  _healthOk.value = false
                }
                applied = true
              }
            }
          }
          // Socket ownership precedes the logical lock, matching request enqueue and disconnect.
          if (lease == null) publish() else lease.commitIfCurrent(publish)
          if (!applied || lease?.isCurrent() != true || !synchronized(gatewayScopeApplyLock) { ownsSelection() }) return@async
          if (healthy == true && !hasCurrentChatMetadata()) fetchChatMetadata()
          if (refresh.refreshSessions && lease.isCurrent() && synchronized(gatewayScopeApplyLock) { ownsSelection() }) fetchSessions(limit = 50)
        } finally {
          synchronized(gatewayScopeApplyLock) { refresh.claimed = false }
        }
      }.await()
  }

  // A healthy observation also releases work whose history waiter was cancelled after retirement.
  // The single-flight dispatcher rechecks branch readiness and connection ownership before sending.
  private fun markHealthOk() {
    _healthOk.value = true
    requestOutboxFlush()
  }

  private fun hasCurrentChatMetadata(): Boolean {
    val currentScope = currentChatMetadataScope() ?: return false
    return chatMetadataLoadState == ChatMetadataLoadState.Loaded && chatMetadataScope == currentScope
  }

  private fun refreshCommandsAfterReconnect() {
    if (hasCurrentChatMetadata()) return
    refreshCommands()
  }

  /**
   * Durably admits one send (text plus decoded attachment bytes) before any network attempt.
   * Returns null after surfacing an actionable error; the composer must keep the draft then.
   */
  private suspend fun enqueueDurableSend(
    outbox: ChatCommandOutbox,
    outboxScope: ChatCacheScope?,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
    canPublishUi: () -> Boolean,
    ownerAgentId: String,
    idempotencyKey: String?,
  ): ChatOutboxItem? {
    if (outboxScope == null) {
      if (canPublishUi()) updateLocalizedErrorText(nativeText("Gateway health not OK; cannot send"))
      return null
    }
    val payloads =
      try {
        attachments.map { att ->
          OutboxAttachmentPayload(
            type = att.type,
            mimeType = att.mimeType,
            fileName = att.fileName,
            durationMs = att.durationMs,
            bytes = Base64.getDecoder().decode(att.base64),
          )
        }
      } catch (_: IllegalArgumentException) {
        if (canPublishUi()) updateLocalizedErrorText(nativeText("Could not stage an attachment for sending."))
        return null
      }
    // Slash commands are connection-gated: they may auto-send only inside the connection epoch
    // that captured them, so a reconnect never silently replays a command-shaped input.
    val gatedEpoch = if (text.startsWith("/")) outboxScope.connectionGeneration else null
    val result =
      try {
        historyPublicationMutex.withLock {
          outbox.enqueue(
            gatewayId = outboxScope.gatewayId,
            sessionKey = sessionKey,
            text = text,
            thinkingLevel = thinkingLevel,
            nowMs = System.currentTimeMillis(),
            attachments = payloads,
            gatedEpoch = gatedEpoch,
            ownerAgentId = ownerAgentId,
            idempotencyKey = idempotencyKey,
          )
        }
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        if (canPublishUi()) updateLocalizedErrorText(chatOutboxQueueFailureText())
        return null
      }
    return when (result) {
      is ChatOutboxEnqueueResult.Queued -> {
        if (canPublishUi()) updateErrorText(null)
        publishOutbox()
        result.item
      }

      ChatOutboxEnqueueResult.QueueFull -> {
        if (canPublishUi()) {
          updateLocalizedErrorText(nativeText("Offline queue is full (\$OUTBOX_MAX_QUEUED messages); delete queued items first.", OUTBOX_MAX_QUEUED))
        }
        null
      }

      ChatOutboxEnqueueResult.AttachmentsTooLarge -> {
        if (canPublishUi()) {
          updateLocalizedErrorText(nativeText("Attachments are too large to queue for one message; remove some and try again."))
        }
        null
      }

      ChatOutboxEnqueueResult.StorageFull -> {
        if (canPublishUi()) {
          updateLocalizedErrorText(nativeText("Offline attachment storage is full; delete queued items first."))
        }
        null
      }

      ChatOutboxEnqueueResult.Unavailable -> {
        if (canPublishUi()) updateLocalizedErrorText(nativeText("Gateway health not OK; cannot send"))
        null
      }
    }
  }

  companion object {
    internal fun queueFailureText(): NativeText = nativeText("Could not queue message for later delivery.")
  }

  /** Re-queues a failed outbox item and flushes immediately when the gateway is healthy. */
  fun retryOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      val outboxScope = currentCacheScope() ?: return@launch
      val row = _outboxItems.value.firstOrNull { it.id == id } ?: return@launch
      // A gated command row is re-armed for the current connection epoch only; retrying it
      // while disconnected parks it again at the next reconnect instead of silently replaying.
      val gatedEpoch = row.gatedEpoch?.let { outboxScope.connectionGeneration }
      val retryOwnerAgentId =
        row.ownerAgentId ?: resolveAgentIdFromMainSessionKey(row.sessionKey)
      if (row.ownerAgentId == null && retryOwnerAgentId == null) return@launch
      // Retry refreshes createdAt and requires this gateway's Failed state. The
      // compare-and-set keeps stale gateway or double Retry taps from reviving an in-flight row.
      val requeued =
        runCatching {
          historyPublicationMutex.withLock {
            outbox.requeueForRetryIfCurrent(
              gatewayId = outboxScope.gatewayId,
              id = id,
              expectedAttemptVersion = row.attemptVersion,
              expectedRetryCount = row.retryCount,
              expectedLastError = row.lastError,
              nowMs = System.currentTimeMillis(),
              gatedEpoch = gatedEpoch,
              ownerAgentId = retryOwnerAgentId,
              replacementId = UUID.randomUUID().toString(),
            )
          }
        }.getOrDefault(0)
      publishOutbox()
      if (requeued > 0) {
        acknowledgedRunIdByRowId.remove(id)
        unconfirmedSightings.remove(id)
        if (_healthOk.value) requestOutboxFlush()
      }
    }
  }

  fun deleteOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      runCatching { outbox.delete(id) }
      acknowledgedRunIdByRowId.remove(id)
      publishOutbox()
      // Deleting an unresolved row can release its session's queued successors.
      if (_healthOk.value) requestOutboxFlush()
    }
  }

  private suspend fun publishOutbox() {
    val outbox = commandOutbox ?: return
    // Supersede older reads without making a claimed send wait on another refresh's I/O.
    val (outboxScope, revision) =
      synchronized(gatewayScopeApplyLock) {
        currentCacheScope() to ++outboxPublicationRevision
      }
    // A cancelled UI caller can still owe its durable claim to the controller-owned dispatcher.
    val items =
      if (outboxScope == null) emptyList() else runCatching { outbox.load(outboxScope.gatewayId) }.getOrNull()
    synchronized(gatewayScopeApplyLock) {
      if (revision == outboxPublicationRevision && outboxScope == currentCacheScope()) {
        if (items != null) _outboxItems.value = items
        _outboxPresentationRestored.value = outboxScope != null && items != null
      }
    }
  }

  /**
   * Sends queued outbox rows strictly createdAt-ordered. Single-flight: health events can fire
   * repeatedly while a flush is already draining the queue.
   */
  private fun requestOutboxFlush() {
    val outbox = commandOutbox ?: return
    outboxFlushRequested.set(true)
    if (outbox.supportsBranchCoordination) {
      outboxBranchReconcileRequested.set(true)
      scope.launch { reconcileOutboxBranchesThenDrain(outbox) }
      return
    }
    scope.launch { drainOutboxFlushRequests() }
  }

  private suspend fun reconcileOutboxBranchesThenDrain(outbox: ChatCommandOutbox) {
    if (!outboxBranchReconcileInFlight.compareAndSet(false, true)) return
    // Reconciliation and delivery have separate single-flight owners. If delivery won the race,
    // leave this request pending so its finally block schedules reconciliation after the drain.
    if (outboxFlushInFlight.get()) {
      outboxBranchReconcileInFlight.set(false)
      return
    }
    try {
      while (outboxBranchReconcileRequested.getAndSet(false)) {
        val gatewayScope = currentCacheScope()
        if (_healthOk.value && gatewayScope != null) {
          reconcilePendingOutboxBranchScopes(outbox, gatewayScope)
        }
      }
    } finally {
      outboxBranchReconcileInFlight.set(false)
    }
    if (outboxBranchReconcileRequested.get()) {
      scope.launch { reconcileOutboxBranchesThenDrain(outbox) }
      return
    }
    drainOutboxFlushRequests()
  }

  private suspend fun drainOutboxFlushRequests() {
    val branchAwareOutbox = commandOutbox?.takeIf { it.supportsBranchCoordination }
    if (!outboxFlushInFlight.compareAndSet(false, true)) return
    try {
      if (
        branchAwareOutbox != null &&
        (outboxBranchReconcileInFlight.get() || outboxBranchReconcileRequested.get())
      ) {
        outboxFlushRequested.set(true)
        if (!outboxBranchReconcileInFlight.get()) {
          scope.launch { reconcileOutboxBranchesThenDrain(branchAwareOutbox) }
        }
        return
      }
      while (outboxFlushRequested.getAndSet(false)) {
        if (
          branchAwareOutbox != null &&
          (outboxBranchReconcileInFlight.get() || outboxBranchReconcileRequested.get())
        ) {
          outboxFlushRequested.set(true)
          if (!outboxBranchReconcileInFlight.get()) {
            scope.launch { reconcileOutboxBranchesThenDrain(branchAwareOutbox) }
          }
          return
        }
        flushOutboxPass()
      }
    } finally {
      outboxFlushInFlight.set(false)
      // Close the release race: a requester that observed in-flight ownership leaves this bit set.
      if (outboxFlushRequested.get()) requestOutboxFlush()
    }
  }

  private fun scheduleOutboxBranchReconciliationRetry() {
    if (!outboxBranchReconcileRetryScheduled.compareAndSet(false, true)) return
    scope.launch {
      delay(recoveryHistoryRetryDelayMs)
      outboxBranchReconcileRetryScheduled.set(false)
      if (_healthOk.value) requestOutboxFlush()
    }
  }

  private suspend fun flushOutboxPass() {
    val outbox = commandOutbox ?: return
    // The unscoped recovery sweep must succeed before this process claims a row. A transient
    // storage failure stays retryable, but never lets younger queued work bypass an ambiguous send.
    outboxRecoveryJob?.join()
    if (!recoverInterruptedOutboxSends(outbox)) {
      _healthOk.value = false
      publishOutbox()
      return
    }
    var flushedAny = false
    try {
      // The whole flush is bound to one gateway scope; a connection switch mid-flush stops it
      // and the next health transition flushes under the new scope.
      val flushScope = currentCacheScope() ?: return
      runCatching { outbox.expireStale(flushScope.gatewayId, System.currentTimeMillis()) }
      publishOutbox()
      while (_healthOk.value && currentCacheScope() == flushScope) {
        val rows = runCatching { outbox.load(flushScope.gatewayId) }.getOrDefault(emptyList())
        if (parkStaleGatedRows(outbox, rows, flushScope)) {
          publishOutbox()
          continue
        }
        val next = nextFlushableRow(rows, flushScope) ?: break
        when (sendOutboxItem(outbox, next, flushScope)) {
          OutboxSendOutcome.Sent -> {
            flushedAny = true
          }

          OutboxSendOutcome.Continue -> {}

          OutboxSendOutcome.Stop -> {
            break
          }
        }
      }
      // Accepted rows from an earlier process have no live run ownership; prove them against
      // canonical history now so restarts either retire them or surface them for review. The
      // second pass (after a short delay) both confirms turns whose transcript write lagged the
      // ACK and provides the second sighting that parks genuinely lost sends. Confirmations can
      // release queued successors in the same session, so they request a rerun of the drain.
      if (reconcileOrphanAcceptedRows(outbox, flushScope) > 0) {
        delay(recoveryHistoryRetryDelayMs)
        if (_healthOk.value && currentCacheScope() == flushScope) {
          reconcileOrphanAcceptedRows(outbox, flushScope)
        }
      }
    } finally {
      publishOutbox()
      if (flushedAny) {
        // Durable history replaces the queued bubbles; reconciliation matches by idempotency key.
        refreshCurrentHistoryBestEffort()
      }
    }
  }

  /**
   * First queued row whose session has no earlier unresolved row. Rows are createdAt-ordered, so
   * an unresolved row (queued behind a dispatch, ambiguous, or awaiting proof) holds only its own
   * session while other sessions keep flushing.
   */
  private fun nextFlushableRow(
    rows: List<ChatOutboxItem>,
    gatewayScope: ChatCacheScope,
  ): ChatOutboxItem? {
    val blockedSessions = mutableSetOf<Any>()
    for (row in rows) {
      val session: Any = row.outboxScope() ?: normalizeRequestedSessionKey(row.sessionKey)
      val branchReady =
        !requireNotNull(commandOutbox).supportsBranchCoordination ||
          row.outboxScope()?.let { isOutboxBranchReconciled(gatewayScope, it) } == true
      if (row.status == ChatOutboxStatus.Queued && session !in blockedSessions && branchReady) return row
      if (outboxRowUnresolved(row)) blockedSessions.add(session)
    }
    return null
  }

  private suspend fun reconcilePendingOutboxBranchScopes(
    outbox: ChatCommandOutbox,
    flushScope: ChatCacheScope,
  ) {
    if (!outbox.supportsBranchCoordination) return
    val rows = runCatching { outbox.load(flushScope.gatewayId) }.getOrDefault(emptyList())
    val grouped =
      rows
        .filter { it.status != ChatOutboxStatus.Failed }
        .mapNotNull { row -> row.outboxScope()?.let { scope -> scope to row } }
        .groupBy(keySelector = { it.first }, valueTransform = { it.second })
    val branchScopes = grouped.keys.toMutableSet()
    ambiguousMutationReconciliationStates.keys
      .asSequence()
      .filter { it.gatewayScope == flushScope }
      .mapTo(branchScopes) { it.branchScope }
    for (branchScope in branchScopes) {
      val scopedRows = grouped[branchScope].orEmpty()
      if (isOutboxBranchReconciled(flushScope, branchScope)) continue
      val state = outbox.branchState(flushScope.gatewayId, branchScope) ?: continue
      val reconciliationKey = ReconciledOutboxBranchScope(flushScope, branchScope)
      val savedCandidate = ambiguousMutationReconciliationStates[reconciliationKey]
      val mutationReconciliationState = savedCandidate?.takeIf { it.revision == state.revision }
      var savedState =
        mutationReconciliationState ?: state.also {
          if (savedCandidate != null) ambiguousMutationReconciliationStates.remove(reconciliationKey, savedCandidate)
        }
      try {
        val sessionKey = normalizeRequestedSessionKey(scopedRows.firstOrNull()?.sessionKey ?: branchScope.sessionKey)
        val isVisibleScope =
          sameOutboxSession(branchScope.sessionKey, _sessionKey.value) &&
            branchScope.ownerAgentId == resolveAgentIdForSessionKey(_sessionKey.value)?.trim()?.lowercase()
        val activeTranscriptEntryIds =
          if (isVisibleScope) {
            val snapshot =
              currentSessionActionSnapshot(_sessionKey.value)
                ?.takeIf { it.outboxScope() == branchScope }
                ?: continue
            val generation = historyLoadGeneration.incrementAndGet()
            val history = refreshHistoryForSessionAction(snapshot, generation, mutationReconciliationState) ?: continue
            savedState = history.branchState ?: continue
            _messages.value.mapNotNullTo(mutableSetOf()) { it.entryId }
          } else {
            val historyJson =
              requestGatewayBound(
                flushScope.gatewayId,
                "chat.history",
                buildJsonObject {
                  put("sessionKey", JsonPrimitive(sessionKey))
                  put("agentId", JsonPrimitive(branchScope.ownerAgentId))
                }.toString(),
              )
            val history = parseHistory(historyJson, sessionKey = sessionKey, previousMessages = emptyList())
            if (mutationReconciliationState == null) {
              savedState = reconcileOutboxHistory(outbox, flushScope.gatewayId, branchScope, savedState, history) ?: continue
            }
            history.messages.mapNotNullTo(mutableSetOf()) { it.entryId }
          }
        val branches =
          requestSessionBranches(
            gatewayId = flushScope.gatewayId,
            sessionKey = sessionKey,
            ownerAgentId = branchScope.ownerAgentId,
          )
        val activeLeaf = if (branches.isEmpty()) null else activeBranchLeafEntryId(branches) ?: continue
        if (
          outbox.reconcileBranchScope(
            gatewayId = flushScope.gatewayId,
            scope = branchScope,
            evidence = ChatOutboxBranchEvidence.BranchListing(savedState, branches.mapTo(mutableSetOf()) { it.leafEntryId }),
            activeLeafEntryId = activeLeaf,
            activeTranscriptEntryIds = activeTranscriptEntryIds,
            lastError = OUTBOX_BRANCH_CHANGED_ERROR,
          ) != null
        ) {
          markOutboxBranchReconciled(flushScope, branchScope)
          if (savedCandidate != null) ambiguousMutationReconciliationStates.remove(reconciliationKey, savedCandidate)
        }
      } catch (err: Throwable) {
        if (err is CancellationException) throw err
        if (
          branchListingUnsupported(err) &&
          !state.needsReconciliation &&
          state.switchPendingSinceMs == null
        ) {
          markOutboxBranchReconciled(flushScope, branchScope)
        }
      } finally {
        if (!isOutboxBranchReconciled(flushScope, branchScope)) {
          // Keep retries on the existing single-flight reconciliation lane; delivery stays
          // gated until authoritative history and branch metadata both reconcile this scope.
          scheduleOutboxBranchReconciliationRetry()
        }
      }
    }
    publishOutbox()
  }

  private data class OutboxSessionOwner(
    val sessionKey: String,
    val agentId: String,
  )

  // Gated command rows enqueued under an older connection epoch park instead of auto-replaying;
  // returns true when any row changed so the flush loop reloads before selecting.
  private suspend fun parkStaleGatedRows(
    outbox: ChatCommandOutbox,
    rows: List<ChatOutboxItem>,
    flushScope: ChatCacheScope,
  ): Boolean {
    var parked = false
    for (row in rows) {
      val stale =
        row.status == ChatOutboxStatus.Queued &&
          row.gatedEpoch != null &&
          row.gatedEpoch != flushScope.connectionGeneration
      if (!stale) continue
      // A park that cannot be persisted must fail closed: reporting it as parked would make
      // the flush loop reload the same queued row and spin while health stays OK.
      val persisted = updateOutboxStatusOrNull(outbox, row, ChatOutboxStatus.Failed, OUTBOX_CONNECTION_CHANGED_ERROR)
      if (persisted == null) {
        // Returning true here re-enters the loop, whose health check now stops the pass;
        // falling through instead would dispatch the still-queued stale row this pass.
        rearmOutboxRecovery()
        _healthOk.value = false
        return true
      }
      parked = true
    }
    return parked
  }

  /** Reconciles orphaned accepted rows against per-session history; returns how many remain. */
  private suspend fun reconcileOrphanAcceptedRows(
    outbox: ChatCommandOutbox,
    flushScope: ChatCacheScope,
  ): Int {
    val rows = runCatching { outbox.load(flushScope.gatewayId) }.getOrDefault(emptyList())
    val orphanSessions =
      rows
        .filter { it.status == ChatOutboxStatus.Accepted && !locallyOwnedOutboxRow(it.id) }
        .mapNotNull { row ->
          val agentId = row.ownerAgentId ?: resolveAgentIdFromMainSessionKey(row.sessionKey) ?: return@mapNotNull null
          OutboxSessionOwner(sessionKey = normalizeRequestedSessionKey(row.sessionKey), agentId = agentId)
        }.toSet()
    if (orphanSessions.isEmpty()) return 0
    var changed = false
    for (owner in orphanSessions) {
      if (!_healthOk.value || currentCacheScope() != flushScope) break
      val history =
        try {
          val branchScope = ChatOutboxScope(owner.sessionKey, owner.agentId)
          val previousState =
            if (outbox.supportsBranchCoordination) outbox.branchState(flushScope.gatewayId, branchScope) ?: continue else null
          if (previousState?.switchPendingSinceMs != null) continue
          val historyJson =
            requestGatewayBound(
              flushScope.gatewayId,
              "chat.history",
              buildJsonObject {
                put("sessionKey", JsonPrimitive(owner.sessionKey))
                put("agentId", JsonPrimitive(owner.agentId))
              }.toString(),
            )
          val history = parseHistory(historyJson, sessionKey = owner.sessionKey, previousMessages = emptyList())
          // Record continuity before retiring the only send that can prove an empty root's
          // first append. Otherwise the next refresh can park its queued successors.
          if (previousState != null && reconcileOutboxHistory(outbox, flushScope.gatewayId, branchScope, previousState, history) == null) {
            continue
          }
          history
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          // Keep the rows accepted; the next flush or history apply reconciles them.
          continue
        }
      changed = reconcileDurableSendsAgainstHistory(outbox, flushScope.gatewayId, history, owner.agentId) || changed
    }
    if (changed) {
      publishOutbox()
      // A confirmed row may have been the head blocking queued successors in its session;
      // the level-triggered request makes the drain run another pass so released rows send.
      outboxFlushRequested.set(true)
    }
    return runCatching { outbox.load(flushScope.gatewayId) }
      .getOrDefault(emptyList())
      .count { it.status == ChatOutboxStatus.Accepted && !locallyOwnedOutboxRow(it.id) }
  }

  /**
   * Applies canonical history proof to durable rows: any row whose `id:user` idempotency key is
   * persisted retires (regardless of state; proof always wins so a manual retry of an actually
   * delivered row can never double-send). Orphaned accepted rows absent from an idle history are
   * parked as delivery-unconfirmed only after two independent sightings, so a transcript write
   * that briefly lags the ACK is not misread as loss.
   */
  private suspend fun reconcileDurableSendsAgainstHistory(
    outbox: ChatCommandOutbox,
    gatewayId: String,
    history: ChatHistory,
    ownerAgentId: String,
  ): Boolean {
    val rows = runCatching { outbox.load(gatewayId) }.getOrDefault(emptyList())
    if (rows.isEmpty()) return false
    val inFlightRunId =
      history.inFlightRun
        ?.runId
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    val sessionRows =
      rows.filter { row ->
        sameOutboxSession(row.sessionKey, history.sessionKey) &&
          (row.ownerAgentId ?: resolveAgentIdFromMainSessionKey(row.sessionKey)) == ownerAgentId
      }
    var changed = false
    val confirmed = history.persistedOutboxAttempts(sessionRows)
    if (confirmed.isNotEmpty()) {
      val removed = runCatching { outbox.confirmDeliveredAttempts(confirmed) }.getOrDefault(0)
      confirmed.keys.forEach(unconfirmedSightings::remove)
      confirmed.keys.forEach(acknowledgedRunIdByRowId::remove)
      changed = removed > 0
    }
    for (row in sessionRows) {
      if (row.status != ChatOutboxStatus.Accepted || row.id in confirmed.keys) continue
      if (locallyOwnedOutboxRow(row.id)) continue
      // inFlightRunId must be non-null before the map compare: a missing in-flight run would
      // otherwise match rows with no acknowledged id (null == null) and block parking forever.
      val rowInFlight =
        inFlightRunId != null &&
          (row.id == inFlightRunId || acknowledgedRunIdByRowId[row.id] == inFlightRunId)
      if (rowInFlight) {
        // The run is still alive on the gateway; its user turn persists with the run.
        unconfirmedSightings.remove(row.id)
        continue
      }
      val sightings = (unconfirmedSightings[row.id] ?: 0) + 1
      if (sightings >= 2) {
        val persisted = updateOutboxStatusOrNull(outbox, row, ChatOutboxStatus.Failed, OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
        if (persisted == null) {
          // The park write failed; reporting a change anyway would spin confirm/park passes
          // against unavailable storage while the row's session stays blocked.
          rearmOutboxRecovery()
          _healthOk.value = false
        } else {
          unconfirmedSightings.remove(row.id)
          acknowledgedRunIdByRowId.remove(row.id)
          changed = true
        }
      } else {
        unconfirmedSightings[row.id] = sightings
      }
    }
    return changed
  }

  /** Extracts the outbox row id from a persisted user turn's `<id>:user` idempotency key. */
  private fun outboxRowIdFromMessage(message: ChatMessage): String? {
    if (message.role.trim().lowercase() != "user") return null
    val key = message.idempotencyKey?.trim() ?: return null
    if (!key.endsWith(":user")) return null
    return key.removeSuffix(":user").takeIf { it.isNotEmpty() }
  }

  private fun ChatHistory.persistedOutboxAttempts(rows: List<ChatOutboxItem>): Map<String, Int> {
    val provenIds = messages.mapNotNull(::outboxRowIdFromMessage).toSet()
    return rows.filter { it.id in provenIds }.associate { it.id to it.attemptVersion }
  }

  // Sent: acknowledged. Continue: row vanished or failed after a gateway response.
  // Stop: transport or persistence state cannot safely advance to younger work.
  private enum class OutboxSendOutcome { Sent, Continue, Stop }

  private enum class GatewayResponseState { Received, Unknown }

  private sealed interface OutboxSendResult {
    data class Accepted(
      val runId: String,
    ) : OutboxSendResult

    /** The request never entered the socket queue, so reconnect may retry it automatically. */
    data class NotDispatched(
      val error: String,
    ) : OutboxSendResult

    /** Dispatch may have succeeded, so only explicit user intent may retry the command. */
    data class DeliveryUnconfirmed(
      val gatewayResponse: GatewayResponseState,
    ) : OutboxSendResult

    /** The canonical alias now resolves to a different agent than the one captured at admission. */
    data object OwnerChanged : OutboxSendResult
  }

  private suspend fun updateOutboxStatusOrNull(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    status: ChatOutboxStatus,
    lastError: String?,
  ): Int? =
    try {
      outbox.updateStatusIfAttempt(
        item.id,
        item.attemptVersion,
        status,
        item.retryCount,
        lastError,
        expectedStatus = item.status,
      )
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      null
    }

  private suspend fun claimOutboxRowOrNull(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
  ): Int? =
    try {
      outbox.claimForSendingIfAttempt(item.id, item.attemptVersion, item.retryCount, item.lastError)
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      null
    }

  private suspend fun sendOutboxItem(
    outbox: ChatCommandOutbox,
    queuedItem: ChatOutboxItem,
    flushScope: ChatCacheScope,
  ): OutboxSendOutcome {
    val ownerAgentId = queuedItem.ownerAgentId ?: resolveAgentIdFromMainSessionKey(queuedItem.sessionKey)
    if (ownerAgentId == null) {
      // Pre-v5 unscoped rows have no durable owner. They must stay visible for manual resend;
      // dispatching now would bind them to whichever default agent happens to be current.
      val parked = updateOutboxStatusOrNull(outbox, queuedItem, ChatOutboxStatus.Failed, OUTBOX_OWNER_CHANGED_ERROR)
      if (parked == null) {
        rearmOutboxRecovery()
        _healthOk.value = false
        return OutboxSendOutcome.Stop
      }
      publishOutbox()
      return OutboxSendOutcome.Continue
    }
    // Reconnect flushes share the live-send settings boundary. Claiming before this wait
    // could durably dispatch a queued turn against the previous model or thinking state. Use
    // the row's owner because the visible chat may switch while this queued turn is waiting.
    val settingsKey =
      sessionSettingsKey(
        sessionKey = normalizeRequestedSessionKey(queuedItem.sessionKey),
        gatewayScope = flushScope,
        ownerAgentId = ownerAgentId,
      )
    if (!waitForPendingSessionSettings(settingsKey)) {
      return OutboxSendOutcome.Stop
    }
    // Claiming changes Queued to Sending without changing the attempt. Carry both forward so
    // completion's attempt/status check still rejects a later delete, retry, or branch change.
    val claimed = claimOutboxRowOrNull(outbox, queuedItem)
    publishOutbox()
    if (claimed == null) {
      // Never bypass an older row when its claim could not be made durable.
      _healthOk.value = false
      return OutboxSendOutcome.Stop
    }
    if (claimed == 0) return OutboxSendOutcome.Continue
    val item = queuedItem.copy(status = ChatOutboxStatus.Sending)
    // Bytes are loaded once per item; a storage failure here parks the row instead of sending
    // a message without the attachments the user staged with it.
    val attachments =
      try {
        loadOutboxAttachmentsForSend(outbox, item)
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        val parked = updateOutboxStatusOrNull(outbox, item, ChatOutboxStatus.Failed, "attachments unavailable")
        if (parked == null) rearmOutboxRecovery()
        publishOutbox()
        return if (parked == null) {
          _healthOk.value = false
          OutboxSendOutcome.Stop
        } else {
          OutboxSendOutcome.Continue
        }
      }
    return when (val result = attemptOutboxSend(outbox, item, flushScope.gatewayId, ownerAgentId, attachments)) {
      is OutboxSendResult.Accepted -> {
        // Ack received: keep the row as accepted until canonical history proves the user turn
        // persisted; the started ACK alone is not durable proof (issue #86946 tracks the gap).
        if (result.runId != item.id) acknowledgedRunIdByRowId[item.id] = result.runId
        val persisted = updateOutboxStatusOrNull(outbox, item, ChatOutboxStatus.Accepted, null)
        if (persisted == null) rearmOutboxRecovery()
        publishOutbox()
        if (persisted == null) {
          // The accepted row is still Sending; the re-armed recovery sweep parks it once
          // storage recovers, and canonical history proof can still retire it later.
          _healthOk.value = false
          OutboxSendOutcome.Stop
        } else {
          // Stale or removed attempts cannot adopt run ownership; history still owns proof.
          if (persisted > 0) {
            adoptFlushedSend(
              item = item,
              attachments = attachments,
              ackRunId = result.runId,
              gatewayId = flushScope.gatewayId,
              ownerAgentId = ownerAgentId,
            )
          }
          OutboxSendOutcome.Sent
        }
      }

      is OutboxSendResult.NotDispatched -> {
        // This frame never entered the socket queue, so reconnect may retry it safely.
        val requeued = updateOutboxStatusOrNull(outbox, item, ChatOutboxStatus.Queued, result.error)
        if (requeued == null) rearmOutboxRecovery()
        publishOutbox()
        _healthOk.value = false
        OutboxSendOutcome.Stop
      }

      OutboxSendResult.OwnerChanged -> {
        val parked = updateOutboxStatusOrNull(outbox, item, ChatOutboxStatus.Failed, OUTBOX_OWNER_CHANGED_ERROR)
        if (parked == null) rearmOutboxRecovery()
        publishOutbox()
        if (parked == null) {
          _healthOk.value = false
          OutboxSendOutcome.Stop
        } else {
          OutboxSendOutcome.Continue
        }
      }

      is OutboxSendResult.DeliveryUnconfirmed -> {
        // Every transmitted failure is ambiguous: gateway error responses can be cached after
        // agent dispatch, and gateway dedupe is process-local and time-bounded.
        val persisted =
          updateOutboxStatusOrNull(
            outbox,
            item,
            ChatOutboxStatus.Failed,
            OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
          )
        if (persisted == null) rearmOutboxRecovery()
        publishOutbox()
        when {
          persisted == null -> {
            // The ambiguous row is still Sending. Stop before younger work; the re-armed
            // recovery sweep will park it after storage becomes available again.
            _healthOk.value = false
            OutboxSendOutcome.Stop
          }

          result.gatewayResponse == GatewayResponseState.Unknown -> {
            _healthOk.value = false
            OutboxSendOutcome.Stop
          }

          else -> {
            // The response lets the drain continue; the store fences stale or retired attempts.
            OutboxSendOutcome.Continue
          }
        }
      }
    }
  }

  private suspend fun loadOutboxAttachmentsForSend(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
  ): List<OutgoingAttachment> {
    if (item.attachments.isEmpty()) return emptyList()
    return outbox.loadAttachments(item.id).map { loaded ->
      OutgoingAttachment(
        type = loaded.attachment.type,
        mimeType = loaded.attachment.mimeType,
        fileName = loaded.attachment.fileName,
        base64 = Base64.getEncoder().encodeToString(loaded.bytes),
        durationMs = loaded.attachment.durationMs,
      )
    }
  }

  /**
   * Adopts run ownership for a flush-dispatched row in the visible session so streaming, the
   * pending spinner, and reply reconciliation behave exactly like a direct send. The optimistic
   * bubble replaces the queued row bubble until canonical history carries the turn.
   */
  private fun adoptFlushedSend(
    item: ChatOutboxItem,
    attachments: List<OutgoingAttachment>,
    ackRunId: String,
    gatewayId: String,
    ownerAgentId: String,
  ) {
    val runId = item.id
    if (locallyOwnedRun(runId) || locallyOwnedRun(ackRunId)) return
    val optimistic = optimisticUserMessage(runId = runId, text = item.text, attachments = attachments)
    val projection =
      PendingRunProjection(
        owner =
          ChatComposerOwner(
            gatewayStableId = gatewayId,
            agentId = ownerAgentId,
            sessionKey = normalizeRequestedSessionKey(item.sessionKey),
          ),
        runId = runId,
        optimisticMessage = optimistic,
      )
    pendingRunProjectionsByRunId[runId] = projection
    armPendingRunProjectionDeadline(runId)
    projectPendingRun(projection)
    // Chat events for this turn arrive under the acknowledged run id; mirroring the direct
    // path's ownership transfer keeps the live run from looking foreign and timing out.
    if (ackRunId != runId) transferRunOwnership(runId, ackRunId, optimistic)
  }

  private suspend fun attemptOutboxSend(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    gatewayId: String,
    ownerAgentId: String,
    attachments: List<OutgoingAttachment>,
  ): OutboxSendResult {
    return try {
      val queuedSessionKey = normalizeRequestedSessionKey(item.sessionKey)
      val canonicalAgentId = resolveAgentIdFromMainSessionKey(queuedSessionKey)
      if (canonicalAgentId != null && canonicalAgentId != ownerAgentId) {
        return OutboxSendResult.OwnerChanged
      }
      if (queuedSessionKey != item.sessionKey) {
        // A row captured under the pre-hello "main" alias resolves exactly once, against the
        // canonical main session active at first dispatch. Pinning it before the request means
        // a later default-agent change can never redirect this input on a retry, so a pin
        // that cannot be made durable must stop the dispatch while the row is still safe.
        val pinned =
          try {
            outbox.pinSessionKey(item.id, queuedSessionKey)
            true
          } catch (err: CancellationException) {
            throw err
          } catch (_: Throwable) {
            false
          }
        if (!pinned) return OutboxSendResult.NotDispatched("could not pin the delivery session")
      }
      // Android only knows the active session's selected model. Unknown queued sessions fail
      // open, preserving the thinking level captured when they were enqueued.
      val thinking =
        if (
          queuedSessionKey == _sessionKey.value && !thinkingSupportedForCurrentSelection()
        ) {
          "off"
        } else {
          item.thinkingLevel
        }
      // The row id is the idempotency key, so gateway-side dedupe makes redelivery of an
      // acked-but-crashed item harmless within the gateway's dedupe window.
      val params =
        buildChatSendParams(
          sessionKey = queuedSessionKey,
          ownerAgentId = ownerAgentId,
          text = item.text,
          thinking = thinking,
          idempotencyKey = item.id,
          attachments = attachments,
        )
      val ack = parseChatSendAck(json, requestGatewayBound(gatewayId, "chat.send", params))
      when (ack.normalizedStatus) {
        "ok", "started", "in_flight" -> {
          if (ack.runId.isNullOrBlank()) {
            OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
          } else {
            OutboxSendResult.Accepted(ack.runId)
          }
        }

        "timeout", "error" -> {
          OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
        }

        else -> {
          OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
        }
      }
    } catch (err: CancellationException) {
      // Teardown must not be recorded as a send failure; the row stays 'sending' and the
      // next startup recovery parks it as delivery-unconfirmed.
      throw err
    } catch (err: GatewayRequestNotEnqueued) {
      OutboxSendResult.NotDispatched(err.message ?: "send failed")
    } catch (_: GatewayRequestDefinitiveFailure) {
      // An ok:false response proves transmission, not that this idempotency key was never run.
      OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
    } catch (_: GatewayRequestOutcomeUnknown) {
      OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Unknown)
    } catch (_: Throwable) {
      OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Unknown)
    }
  }

  private suspend fun recoverInterruptedOutboxSends(outbox: ChatCommandOutbox): Boolean =
    outboxRecoveryMutex.withLock {
      if (outboxRecoveryComplete) return@withLock true
      try {
        outbox.failSendingAfterRestart()
        outboxRecoveryComplete = true
        true
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        false
      }
    }

  private suspend fun rearmOutboxRecovery() {
    outboxRecoveryMutex.withLock { outboxRecoveryComplete = false }
  }

  private fun handleChatEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    val runId = payload["runId"].asStringOrNull()
    val state = payload["state"].asStringOrNull()
    val projection = runId?.let(pendingRunProjectionsByRunId::get)
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) {
      if (state == "final" || state == "aborted" || state == "error") {
        handleInactiveChatTerminal(
          payload = payload,
          runId = runId,
          owner = resolveChatEventRoutingOwner(sessionKey, projection),
        )
      }
      return
    }

    if (projection != null && projection.owner != currentChatComposerRoutingOwner()) {
      if (state == "final" || state == "aborted" || state == "error") {
        handleInactiveChatTerminal(
          payload = payload,
          runId = runId,
          owner = resolveChatEventRoutingOwner(sessionKey, projection),
        )
      }
      return
    }
    val isPending =
      if (runId != null) synchronized(pendingRuns) { pendingRuns.contains(runId) } else true
    val ownsDiagnostic =
      runDiagnosticOwner?.let { it.runId == runId && it.owner == currentChatComposerRoutingOwner() } == true
    val isOwned = isPending || ownsDiagnostic || (runId != null && unresolvedRepliesByRunId.containsKey(runId))

    when (state) {
      "delta" -> {
        // Only show streaming text for runs we initiated in this controller.
        if (!isPending) return
        val text = parseAssistantDeltaText(payload)
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }

      "final", "aborted", "error" -> {
        val terminalHasAssistantMessage =
          state == "final" && payload["message"].asObjectOrNull()?.get("role").asStringOrNull() == "assistant"
        val resolvesWithoutReply = state != "final" || !terminalHasAssistantMessage
        val wasTimedOut = runId != null && timedOutRunIds.remove(runId)
        if (runId != null && runId == lastHandledTerminalRunId) return
        if (runId != null && !isOwned && !wasTimedOut) {
          val hasLocalRun =
            synchronized(pendingRuns) { pendingRuns.isNotEmpty() } || unresolvedRepliesByRunId.isNotEmpty()
          if (!hasLocalRun) {
            // Another client or chat.inject can finish the open session. Refresh
            // idle history without allowing its terminal state to own local UI.
            lastHandledTerminalRunId = runId
            publishAssistantReplyFinalized(
              payload = payload,
              runId = runId,
              owner = currentChatComposerRoutingOwner(),
            )
            refreshCurrentHistoryBestEffort(updateSessionInfo = true)
          }
          return
        }
        if (ownsDiagnostic) runDiagnosticOwner = null
        if (runId != null) {
          lastHandledTerminalRunId = runId
          retireRunTelemetry(runId)
        }
        publishAssistantReplyFinalized(
          payload = payload,
          runId = runId,
          owner = currentChatComposerRoutingOwner(),
        )
        if (wasTimedOut) {
          val hasNewerRun =
            synchronized(pendingRuns) { pendingRuns.isNotEmpty() } || unresolvedRepliesByRunId.isNotEmpty()
          if (!hasNewerRun) {
            clearLiveRunUi()
            updateLocalizedErrorText(
              if (state == "error") {
                payload["errorMessage"].asStringOrNull()?.let(::verbatimText) ?: nativeText("Chat failed")
              } else {
                null
              },
            )
          }
          publishRunPresentation()
          refreshCurrentHistoryBestEffort(updateSessionInfo = true)
          return
        }
        if (state == "error" && (isPending || ownsDiagnostic)) {
          updateLocalizedErrorText(payload["errorMessage"].asStringOrNull()?.let(::verbatimText) ?: nativeText("Chat failed"))
        }
        if (runId != null && !isPending) {
          if (resolvesWithoutReply) terminalWithoutReplyRunIds.add(runId)
          publishRunPresentation()
          refreshCurrentHistoryBestEffort(
            runIdsToReconcile = setOf(runId),
            updateSessionInfo = true,
          )
          return
        }
        val terminalRunIds =
          runId?.let(::setOf)
            ?: (synchronized(pendingRuns) { pendingRuns.toSet() } + unresolvedRepliesByRunId.keys)
        if (runId != null) {
          clearPendingRun(runId)
          if (resolvesWithoutReply) {
            terminalWithoutReplyRunIds.add(runId)
          }
        } else {
          terminalRunIds.forEach(::retireRunTelemetry)
          clearPendingRuns(clearOptimisticMessages = false, clearRunTelemetry = false)
        }
        clearLiveRunUi()
        refreshCurrentHistoryBestEffort(
          runIdsToReconcile = terminalRunIds,
          updateSessionInfo = true,
        )
      }
    }
  }

  private fun handleSessionsChangedEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val swarmEvent = observeSwarmEvent(payload)
    val swarmSource = payload["session"].asObjectOrNull()
    val swarmKindElement = if ("kind" in payload) payload["kind"] else swarmSource?.get("kind")
    val swarmKind = swarmKindElement.asStringOrNull()?.trim()
    if (swarmEvent && (swarmKind == "phase" || swarmKind == "log")) return
    val reason = payload["reason"].asStringOrNull()
    if (isSessionSettingsMutation(payload)) {
      val session = eventSessionObject(payload)
      val key = payload["sessionKey"].asStringOrNull() ?: session?.get("key").asStringOrNull()
      val agentId =
        key?.let(::resolveAgentIdFromMainSessionKey)
          ?: payload["agentId"].asStringOrNull()
          ?: session?.get("ownerAgentId").asStringOrNull()
      val currentScope = currentChatMetadataScope()
      // Profile-only mutations do not change global credentials or the visible session key.
      if (key != null && currentScope?.sessionKey == key && currentScope.agentId == agentId) refreshCommands()
    }
    if (reason == "rewind" || reason == "branch-switch") {
      // Mutation events do not contain a session preview. Refresh the drawer even for a
      // background session and even when this event is deferred behind a local mutation lease.
      refreshSessionsForCurrentWindow()
      val sessionKey =
        (payload["sessionKey"].asStringOrNull() ?: payload["key"].asStringOrNull())
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?: return
      val ownerAgentId = payload["agentId"].asStringOrNull()?.trim()?.lowercase()
      val eventGatewayScope = currentCacheScope()
      val matchingScopes =
        reconciledOutboxBranchScopes
          .filter { candidate ->
            candidate.gatewayScope == eventGatewayScope &&
              sameOutboxSession(candidate.branchScope.sessionKey, sessionKey) &&
              (ownerAgentId == null || candidate.branchScope.ownerAgentId == ownerAgentId)
          }.mapTo(mutableSetOf()) { it.branchScope }
      _outboxItems.value
        .mapNotNull { it.outboxScope() }
        .filterTo(matchingScopes) { candidate ->
          sameOutboxSession(candidate.sessionKey, sessionKey) &&
            (ownerAgentId == null || candidate.ownerAgentId == ownerAgentId)
        }
      if (ownerAgentId != null) {
        matchingScopes += ChatOutboxScope(sessionKey, ownerAgentId)
      }
      matchingScopes.removeAll { candidate ->
        deferOutboxSessionMutationEventIfActive(eventGatewayScope, candidate, reason)
      }
      if (matchingScopes.isEmpty()) return
      scheduleSessionsChangedBranchReconciliation(
        eventGatewayScope = eventGatewayScope,
        sessionKey = sessionKey,
        ownerAgentId = ownerAgentId,
        matchingScopes = matchingScopes,
      )
      return
    }
    if (reason == "delete") {
      val sessionKey = payload["sessionKey"].asStringOrNull() ?: payload["key"].asStringOrNull()
      val ownerAgentId = payload["agentId"].asStringOrNull()
      if (
        !removeSessionEntry(sessionKey, ownerAgentId = ownerAgentId) &&
        sessionKey != null &&
        resolveAgentIdFromMainSessionKey(sessionKey) == null &&
        ownerAgentId == null
      ) {
        // Legacy ownerless hints cannot authorize deleting an agent's local state:
        // absence from a filtered drawer page is not proof that its session was deleted.
        refreshSessionsForCurrentWindow()
      }
      return
    }
    applySessionEvent(
      payload = payload,
      refreshWhenMissing = true,
      authoritativeSessionSettings = true,
    )
  }

  private fun handleSessionObserverEvent(payloadJson: String) {
    val digest = runCatching { json.decodeFromString<SessionObserverDigest>(payloadJson) }.getOrNull() ?: return
    val selectedAgentId = _sessionOwnerAgentId.value ?: resolveAgentIdForSessionKey(_sessionKey.value)
    _sessions.value =
      applySessionObserverDigest(
        _sessions.value,
        digest,
        activeAgentId = selectedAgentId,
      )
  }

  private fun scheduleSessionsChangedBranchReconciliation(
    eventGatewayScope: ChatCacheScope?,
    sessionKey: String,
    ownerAgentId: String?,
    matchingScopes: Set<ChatOutboxScope>,
  ) {
    matchingScopes.forEach { markOutboxBranchUnreconciled(eventGatewayScope, it) }
    val currentSnapshot =
      _sessionKey.value
        .takeIf { sameOutboxSession(it, sessionKey) }
        ?.let(::currentSessionActionSnapshot)
        ?.takeIf { ownerAgentId == null || ownerAgentId == it.ownerAgentId }
    val eventHistoryGeneration = currentSnapshot?.let { historyLoadGeneration.incrementAndGet() }
    scope.launch {
      val outbox = commandOutbox
      val gatewayId = eventGatewayScope?.gatewayId
      if (outbox?.supportsBranchCoordination == true && gatewayId != null) {
        for (branchScope in matchingScopes) {
          outbox.demoteSessionMutationToReconciliationState(gatewayId, branchScope)
        }
      }
      val snapshot = currentSnapshot
      if (snapshot == null || eventHistoryGeneration == null) {
        requestOutboxFlush()
        return@launch
      }
      val historyApplied = refreshHistoryForSessionAction(snapshot, eventHistoryGeneration)
      val branchesApplied =
        historyApplied?.let { refreshSessionBranches(snapshot, it.branchState, BranchRefreshPurpose.Reconcile) } == true
      if (!branchesApplied) requestOutboxFlush()
    }
  }

  private fun handleSessionMessageEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    applySessionEvent(payload = payload, refreshWhenMissing = false)
  }

  private fun applySessionEvent(
    payload: JsonObject,
    refreshWhenMissing: Boolean,
    authoritativeSessionSettings: Boolean = false,
  ) {
    val eventObject = eventSessionObject(payload)
    val entry = eventObject?.let(::parseSessionEntry)
    val eventKey = entry?.key ?: payload["sessionKey"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
    val eventOwner =
      eventKey?.let(::resolveAgentIdFromMainSessionKey)
        ?: entry?.ownerAgentId
        ?: payload["agentId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    val visibleOwner = resolveAgentIdForSessionKey(_sessionKey.value)
    if (entry?.archived == true && eventOwner != null) {
      synchronized(gatewayScopeApplyLock) {
        val owner = ChatAgentSessionSelectionOwner(currentCacheScope()?.gatewayId, eventOwner)
        if (lastSelectedChatSessionByOwner[owner]?.key == entry.key) lastSelectedChatSessionByOwner.remove(owner)
      }
    }
    val metadataMutation = isSessionSettingsMutation(payload)
    if (entry == null) {
      if (refreshWhenMissing) {
        var refreshOwnedByLane = false
        if (metadataMutation && eventKey != null && eventOwner != null && eventOwner == visibleOwner) {
          val reconciliation =
            synchronized(gatewayScopeApplyLock) {
              val settingsKey = sessionSettingsKey(normalizeRequestedSessionKey(eventKey), ownerAgentId = eventOwner)
              val existingLane = pendingSettingsMutations[settingsKey]
              // An idle selected row may be outside the drawer window. Its invalidation
              // needs the same exact-read readiness barrier as a local settings write.
              val started =
                currentSelectedSession()
                  ?.takeIf { existingLane == null && it.key == settingsKey.sessionKey && it.ownerAgentId == eventOwner }
                  ?.let { confirmed ->
                    val completion = SessionSettingsCompletion(CompletableDeferred(), succeeded = true)
                    val lane =
                      SessionSettingsLane(
                        tail = completion.pending,
                        confirmed = confirmed,
                        confirmedThinkingLevel = _thinkingLevel.value,
                        reconciliation = completion,
                      )
                    pendingSettingsMutations[settingsKey] = lane
                    publishPendingSessionSettingsKeys()
                    Triple(settingsKey, lane, completion)
                  }
              (existingLane ?: started?.second)?.let { lane ->
                lane.observation = Any()
                lane.needsRefresh = true
                // In-flight writes drain first; failed reads retain the existing retry path.
                refreshOwnedByLane = lane.reconciliation?.pending?.isCompleted != true
              }
              if (started != null || activeSessionReads.any { it.gatewayScope == settingsKey.gatewayScope }) {
                incrementSettingsMutationRevision(settingsKey.gatewayScope)
              }
              if (settingsKey.sessionKey == _sessionKey.value) settingsPublicationGeneration.incrementAndGet()
              started
            }
          reconciliation?.let { (settingsKey, lane, completion) ->
            scope.launch { reconcileSessionSettings(settingsKey, lane, completion) }
          }
        }
        if (!refreshOwnedByLane) refreshSessionsForCurrentWindow()
      }
      return
    }
    // Session keys can collide across agents. Never merge an ownerless or foreign event into
    // the visible agent-scoped snapshot; an authoritative refresh resolves ambiguous payloads.
    if (eventOwner == null || visibleOwner == null) {
      refreshSessionsForCurrentWindow()
      return
    }
    if (eventOwner != visibleOwner) return
    val ownedEntry = reconcileSessionObserverProjectionOwner(entry, eventOwner)
    val phase = payload["phase"].asStringOrNull()
    val terminalRunId =
      payload["runId"]
        .asStringOrNull()
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.takeIf { phase == "end" || phase == "error" }
    val terminalWasLocal = terminalRunId?.let(::isLocallyOwnedRun) == true
    val terminalWasAdvertised = terminalRunId?.let { it in advertisedRunIds() } == true
    val settlesSelectedRun = terminalRunId != null && (terminalWasLocal || terminalWasAdvertised)
    val applied =
      synchronized(gatewayScopeApplyLock) {
        upsertSessionEntry(
          entry = if (ownedEntry.ownerAgentId == eventOwner) ownedEntry else ownedEntry.copy(ownerAgentId = eventOwner),
          clearedFields = parseExplicitSessionClears(eventObject),
          authoritativeSessionSettings = authoritativeSessionSettings,
          publishRunState = !settlesSelectedRun,
        )
      }
    acknowledgeUnreadIfNeeded(applied.key, applied, requireActive = true)
    if (!settlesSelectedRun) return
    val settledRunId = terminalRunId
    if (!entry.hasActiveRunMetadata) retireRunTelemetry(settledRunId)
    if (terminalWasLocal) {
      clearPendingRun(settledRunId)
      clearTransientRunUiIfIdle()
    } else {
      publishRunPresentation()
    }
  }

  private fun isSessionSettingsMutation(payload: JsonObject): Boolean =
    payload["phase"].asStringOrNull() == "reset" ||
      when (payload["reason"].asStringOrNull()) {
        "patch", "command-metadata", "reset" -> true
        else -> false
      }

  private fun eventSessionObject(payload: JsonObject): JsonObject? =
    payload["session"].asObjectOrNull()
      ?: payload.takeIf {
        it["key"].asStringOrNull() != null ||
          // Full flattened snapshots carry both fields; identity-only invalidations
          // must still refresh instead of clearing omitted settings.
          (it["sessionKey"].asStringOrNull() != null && "permissionMode" in it && "permissionModePending" in it)
      }

  // The gateway sends explicit JSON null for cleared label/category on session
  // events; the merge must apply those clears instead of preserving stale values.
  private fun parseExplicitSessionClears(obj: JsonObject): Set<String> =
    buildSet {
      if (obj["label"] is JsonNull) add("label")
      if (obj["category"] is JsonNull) add("category")
    }

  private fun isLocallyOwnedRun(runId: String): Boolean = synchronized(pendingRuns) { runId in pendingRuns } || unresolvedRepliesByRunId.containsKey(runId)

  private fun ownsLiveRunTelemetry(runId: String): Boolean = isLocallyOwnedRun(runId) || runId in advertisedRunIds()

  private fun parseAgentEventSequence(payload: JsonObject): Long? {
    val raw = payload["seq"] as? JsonPrimitive ?: return null
    if (raw.isString) return null
    return raw.asLongOrNull()?.takeIf { it > 0L }
  }

  private fun parsePositiveOutputTokens(data: JsonObject?): Long? {
    val raw = data?.get("outputTokens") as? JsonPrimitive ?: return null
    if (raw.isString) return null
    return raw.asLongOrNull()?.takeIf { it > 0L }
  }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return
    val runId = payload["runId"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
    val projection = runId?.let(pendingRunProjectionsByRunId::get)
    if (projection != null && projection.owner != currentChatComposerRoutingOwner()) return

    val stream = payload["stream"].asStringOrNull()
    val data = payload["data"].asObjectOrNull()
    if (stream == "usage") {
      val usageRunId = runId?.takeIf(::ownsLiveRunTelemetry) ?: return
      val sequence = parseAgentEventSequence(payload) ?: return
      val outputTokens = parsePositiveOutputTokens(data) ?: return
      if (recordLiveRunUsage(usageRunId, sequence, outputTokens)) publishRunPresentation()
      return
    }
    if (stream == "lifecycle") {
      val phase = data?.get("phase").asStringOrNull()
      val isTerminal = phase == "end" || phase == "error"
      if (runId != null && !ownsLiveRunTelemetry(runId)) return
      if (runId == null && !isTerminal) return
      val lifecycleRunId = runId ?: locallyOwnedRunIds().singleOrNull() ?: return
      val sequence = parseAgentEventSequence(payload)
      when (phase) {
        "start" -> {
          val orderedSequence = sequence ?: return
          if (applyLiveRunLifecycle(lifecycleRunId, orderedSequence, terminal = false)) publishRunPresentation()
        }

        "end", "error" -> {
          val accepted =
            if (sequence == null) {
              retireRunTelemetry(lifecycleRunId)
              true
            } else {
              applyLiveRunLifecycle(lifecycleRunId, sequence, terminal = true)
            }
          if (!accepted) return
          if (isLocallyOwnedRun(lifecycleRunId)) {
            clearPendingRun(lifecycleRunId)
            clearTransientRunUiIfIdle()
          } else {
            publishRunPresentation()
          }
        }
      }
      return
    }

    if (runId != null && !isLocallyOwnedRun(runId)) return
    when (stream) {
      "assistant" -> {
        val text = data?.get("text")?.asStringOrNull()
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }

      "tool" -> {
        val phase = data?.get("phase")?.asStringOrNull()
        val name = data?.get("name")?.asStringOrNull()
        val toolCallId = data?.get("toolCallId")?.asStringOrNull()
        if (phase.isNullOrEmpty() || name.isNullOrEmpty() || toolCallId.isNullOrEmpty()) return

        val ts = payload["ts"].asLongOrNull() ?: System.currentTimeMillis()
        when (phase) {
          "start" -> {
            val existing = pendingToolCallsById[toolCallId]
            pendingToolCallsById[toolCallId] =
              ChatPendingToolCall(
                toolCallId = toolCallId,
                name = name,
                args = data.get("args").asObjectOrNull(),
                startedAtMs = existing?.startedAtMs ?: ts,
                isError = null,
                liveDiff = existing?.liveDiff,
              )
            publishPendingToolCalls()
          }

          "input_delta" -> {
            val diff = parseChatDiffStat(data["diff"], includeFiles = false) ?: return
            val existing = pendingToolCallsById[toolCallId]
            pendingToolCallsById[toolCallId] =
              existing?.copy(name = name, liveDiff = diff)
                ?: ChatPendingToolCall(
                  toolCallId = toolCallId,
                  name = name,
                  startedAtMs = ts,
                  liveDiff = diff,
                )
            publishPendingToolCalls()
          }

          "result" -> {
            pendingToolCallsById.remove(toolCallId)
            publishPendingToolCalls()
          }
        }
      }

      "plan" -> {
        // Released Gateways through v2026.8.x only emit stream:"plan" and lack progressCard.get.
        // SUNSET 2026-10-18: this fallback is a fixed cutover window, not a permanent contract.
        // On that date delete it together with the Gateway's legacy stream:"plan" dual-emit and
        // the Apple twin in ChatViewModel+TransportEvents.swift. Tracked: #125639.
        if (gatewayAdvertisesMethod("progressCard.get") != false) return
        val planData = data ?: return
        if (planData["phase"].asStringOrNull() != "update") return
        val steps = parseChatPlanSteps(planData["steps"])
        if (steps.isEmpty()) {
          clearProgressCard(clearScopeKey = false)
          return
        }
        _progressCard.value =
          ChatProgressCard(
            revision = legacyProgressCardRevision.incrementAndGet(),
            updatedAt = payload["ts"].asLongOrNull() ?: 0L,
            markdown = planData["explanation"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
            steps = steps,
          )
      }

      "error" -> {
        updateLocalizedErrorText(nativeText("Event stream interrupted; try refreshing."))
        if (runId == null) {
          clearPendingRuns()
        } else {
          clearPendingRun(runId)
          clearTransientRunUiIfIdle()
        }
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
      }
    }
  }

  private fun handleInactiveChatTerminal(
    payload: JsonObject,
    runId: String?,
    owner: ChatComposerOwner?,
  ) {
    val normalizedRunId = runId?.trim()?.takeIf(String::isNotEmpty)
    if (normalizedRunId != null && normalizedRunId != lastHandledTerminalRunId) {
      lastHandledTerminalRunId = normalizedRunId
      retireRunTelemetry(normalizedRunId)
      publishAssistantReplyFinalized(
        payload = payload,
        runId = normalizedRunId,
        owner = owner,
      )
    }
    normalizedRunId?.let(::clearPendingRun)
  }

  private fun resolveChatEventRoutingOwner(
    sessionKey: String?,
    projection: PendingRunProjection?,
  ): ChatComposerOwner? {
    val gatewayStableId = currentCacheScope()?.gatewayId
    val normalizedSessionKey = sessionKey?.trim()?.takeIf(String::isNotEmpty)
    if (projection != null) {
      return projection.owner.takeIf { owner ->
        owner.gatewayStableId == gatewayStableId &&
          (normalizedSessionKey == null || owner.sessionKey == normalizedSessionKey)
      }
    }

    val eventSessionKey =
      when (normalizedSessionKey) {
        null -> return null
        "main" -> appliedMainSessionKey.trim().takeIf(String::isNotEmpty) ?: return null
        else -> normalizedSessionKey
      }
    return resolveChatComposerRoutingOwner(
      gatewayStableId = gatewayStableId,
      gatewayDefaultAgentId = effectiveDefaultAgentId(),
      sessionKey = eventSessionKey,
      mainSessionKey = appliedMainSessionKey,
    )
  }

  private fun publishAssistantReplyFinalized(
    payload: JsonObject,
    runId: String?,
    owner: ChatComposerOwner?,
  ) {
    if (payload["state"].asStringOrNull() != "final") return
    val normalizedRunId = runId?.trim()?.takeIf(String::isNotEmpty) ?: return
    val verifiedOwner = owner?.takeIf { it.routingVerified } ?: return
    val text = parseAssistantDeltaText(payload)?.trim()?.takeIf(String::isNotEmpty) ?: return
    runCatching { onAssistantReplyFinalized(verifiedOwner, normalizedRunId, text) }
  }

  private fun parseAssistantDeltaText(payload: JsonObject): String? {
    val message = payload["message"].asObjectOrNull() ?: return null
    if (message["role"].asStringOrNull() != "assistant") return null
    val content = message["content"].asArrayOrNull() ?: return null
    for (item in content) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["type"].asStringOrNull() != "text") continue
      val text = obj["text"].asStringOrNull()
      if (!text.isNullOrEmpty()) {
        return text
      }
    }
    return null
  }

  private fun publishPendingToolCalls() {
    _pendingToolCalls.value =
      pendingToolCallsById.values.sortedBy { it.startedAtMs }
  }

  private fun handleTaskEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    if (payload["action"].asStringOrNull() == "deleted") {
      payload["taskId"]
        .asStringOrNull()
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.let(::removeSubagentActivity)
      return
    }
    val task = payload["task"].asObjectOrNull() ?: return
    if (task["runtime"].asStringOrNull() != "subagent") return
    if (task["sessionKey"].asStringOrNull()?.trim() != _sessionKey.value) return
    val taskId = task["id"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return
    val status = task["status"].asStringOrNull()?.trim()?.lowercase() ?: return
    if (status !in setOf("queued", "running", "completed", "failed", "cancelled", "timed_out")) return

    val terminal = status != "queued" && status != "running"
    val now = System.currentTimeMillis()
    synchronized(subagentActivityLock) {
      val existing = _subagentActivities.value[taskId]
      if (terminal && existing == null && subagentActivityExpiryJobs.containsKey(taskId)) return@synchronized
      val lastActivity = task["lastActivity"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
      val fallback =
        task["progressSummary"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
          ?: task["lastToolName"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
      val activity =
        ChatSubagentActivity(
          id = taskId,
          status = status,
          snippet =
            lastActivity
              ?: if (terminal) existing?.snippet ?: fallback else fallback ?: existing?.snippet,
          diffStat = parseChatDiffStat(task["diffStat"], includeFiles = true) ?: existing?.diffStat,
          terminalSummary =
            task["terminalSummary"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
              ?: existing?.terminalSummary,
          error =
            task["error"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
              ?: existing?.error,
          startedAtMs =
            task["startedAt"]?.let(::parseTaskTimestampMs)
              ?: existing?.startedAtMs
              ?: task["createdAt"]?.let(::parseTaskTimestampMs)
              ?: now,
          endedAtMs =
            if (terminal) {
              task["endedAt"]?.let(::parseTaskTimestampMs) ?: existing?.endedAtMs ?: now
            } else {
              null
            },
          childSessionKey =
            task["childSessionKey"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
              ?: existing?.childSessionKey,
        )
      _subagentActivities.value = _subagentActivities.value + (taskId to activity)
      if (activity.isWorking) {
        subagentActivityExpiryJobs.remove(taskId)?.cancel()
      } else if (terminal && existing?.isWorking != false) {
        // Local receipt starts retention; remote endedAt may be old.
        // Duplicate terminal updates must not extend that retention window.
        subagentActivityExpiryJobs[taskId] =
          scope.launch {
            delay(SUBAGENT_ACTIVITY_RETENTION_MS)
            synchronized(subagentActivityLock) {
              if (subagentActivityExpiryJobs[taskId] !== coroutineContext[Job]) return@synchronized
              _subagentActivities.value = _subagentActivities.value - taskId
              subagentActivityExpiryJobs[taskId] = null
              if (subagentActivityExpiryJobs.count { it.value == null } > MAX_RETAINED_TERMINAL_SUBAGENT_TASKS) {
                subagentActivityExpiryJobs.entries.firstOrNull { it.value == null }?.let {
                  subagentActivityExpiryJobs.remove(it.key)
                }
              }
            }
          }
      }
    }
  }

  private fun removeSubagentActivity(taskId: String) {
    synchronized(subagentActivityLock) {
      subagentActivityExpiryJobs.remove(taskId)?.cancel()
      _subagentActivities.value = _subagentActivities.value - taskId
    }
  }

  private fun clearSubagentActivities() {
    synchronized(subagentActivityLock) {
      subagentActivityExpiryJobs.values.forEach { it?.cancel() }
      subagentActivityExpiryJobs.clear()
      _subagentActivities.value = emptyMap()
    }
  }

  private fun clearLiveRunUi() {
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
  }

  private fun clearProgressCard(clearScopeKey: Boolean = true) {
    progressCardFetchGeneration.incrementAndGet()
    if (clearScopeKey) progressCardScopeKey = null
    _progressCard.value = null
  }

  private fun refreshProgressCard() {
    if (gatewayAdvertisesMethod("progressCard.get") == false) return
    val sessionKey = normalizeRequestedSessionKey(_sessionKey.value)
    val gatewayScope = currentCacheScope()
    val generation = progressCardFetchGeneration.incrementAndGet()
    scope.launch {
      if (generation != progressCardFetchGeneration.get()) return@launch
      try {
        val params = buildJsonObject { put("sessionKey", JsonPrimitive(sessionKey)) }
        val response = requestGatewayBound(gatewayScope?.gatewayId, "progressCard.get", params.toString())
        val parsed = parseChatProgressCardGetResult(json.parseToJsonElement(response))
        if (
          generation != progressCardFetchGeneration.get() ||
          !sameOutboxSession(sessionKey, _sessionKey.value) ||
          gatewayScope != currentCacheScope()
        ) {
          return@launch
        }
        parsed.sessionKey?.let { progressCardScopeKey = it }
        _progressCard.value = parsed.card
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        // Older gateways and malformed responses quietly leave the last durable card intact.
      }
    }
  }

  private fun handleProgressCardChanged(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val eventSessionKey = payload["sessionKey"].asJsonStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return
    if (
      !sameOutboxSession(eventSessionKey, _sessionKey.value) &&
      eventSessionKey != progressCardScopeKey
    ) {
      // Pokes carry the server-derived observer scope key (e.g. agent:<id>:global), which the
      // client only learns from a get response carrying a card. Until then attribution is
      // unknown, so refetch — the get is authoritative and self-corrects — instead of
      // silently dropping the session's first poke.
      if (progressCardScopeKey == null) refreshProgressCard()
      return
    }
    val revisionElement = payload["revision"]
    if (revisionElement is JsonNull) {
      clearProgressCard(clearScopeKey = false)
      return
    }
    val revision =
      (revisionElement as? JsonPrimitive)
        ?.takeUnless { it.isString }
        ?.content
        ?.toLongOrNull()
        ?.takeIf { it in 1..Int.MAX_VALUE }
        ?.toInt()
        ?: return
    if (_progressCard.value?.revision == revision) return
    refreshProgressCard()
  }

  /**
   * Adopts the run the gateway reports still streaming for this session so reconnect,
   * cold start, and seq-gap recovery restore pending/streaming UI state.
   */
  private fun adoptInFlightRun(
    history: ChatHistory,
    runIdsOwnedAfterRequest: Set<String>,
  ) {
    val run = history.inFlightRun ?: return
    val runId = run.runId.trim().takeIf { it.isNotEmpty() } ?: return
    if (runIdsOwnedAfterRequest.isNotEmpty() && runId !in runIdsOwnedAfterRequest) return
    synchronized(pendingRuns) {
      // A different locally-owned run means this snapshot predates it; ignore.
      if (pendingRuns.isNotEmpty() && runId !in pendingRuns) return
      if (pendingRuns.isEmpty() && unresolvedRepliesByRunId.isNotEmpty() && !unresolvedRepliesByRunId.containsKey(runId)) return
      pendingRuns.add(runId)
    }
    runDiagnosticOwner = currentChatComposerRoutingOwner()?.let { RunDiagnosticOwner(it, runId) }
    armPendingRunTimeout(runId)
    if (run.text.isNotEmpty()) {
      _streamingAssistantText.value = run.text
    }
  }

  private fun armPendingRunTimeout(runId: String) {
    pendingRunTimeoutJobs[runId]?.cancel()
    pendingRunTimeoutJobs[runId] =
      scope.launch {
        delay(pendingRunTimeoutMs)
        val watchdogSessionKey = _sessionKey.value
        val latestAppliedBeforeRefresh =
          synchronized(gatewayScopeApplyLock) {
            latestAppliedHistoryRequest
          }
        val historyResult =
          refreshHistorySnapshotBestEffort(
            sessionKey = watchdogSessionKey,
            generation = historyLoadGeneration.get(),
            runIdsToReconcile = emptySet(),
          )
        val refreshState =
          synchronized(gatewayScopeApplyLock) {
            // A concurrent recovery load can supersede this request. Its newer
            // current-session snapshot is equally authoritative confirmation.
            val currentSession = watchdogSessionKey == _sessionKey.value
            val freshSnapshotApplied =
              historyResult is HistoryRefreshResult.Applied || latestAppliedHistoryRequest > latestAppliedBeforeRefresh
            Triple(currentSession, freshSnapshotApplied, latestAppliedInFlightRunId == runId)
          }
        val (currentSession, freshSnapshotApplied, latestRunMatches) = refreshState
        if (currentSession && freshSnapshotApplied && latestRunMatches) {
          // The refreshed snapshot confirms the run is still executing; long agent
          // turns can outlast one timeout window, so keep waiting instead of
          // surfacing a false timeout and dropping the optimistic bubble. Terminal
          // events and the server-side expiry remain the liveness backstop.
          armPendingRunTimeout(runId)
          return@launch
        }
        if (
          currentSession &&
          !freshSnapshotApplied &&
          (historyResult == HistoryRefreshResult.Superseded || historyResult == HistoryRefreshResult.BranchInvalidated)
        ) {
          // A newer load or branch evidence fenced this snapshot. Defer expiry;
          // fresh history or the next watchdog must decide the run.
          armPendingRunTimeout(runId)
          return@launch
        }
        val replyStillUnresolved = unresolvedRepliesByRunId.containsKey(runId)
        clearPendingRun(runId)
        clearTransientRunUiIfIdle()
        if (!replyStillUnresolved) return@launch
        removeOptimisticMessage(runId)
        unresolvedRepliesByRunId.remove(runId)
        terminalWithoutReplyRunIds.remove(runId)
        timedOutRunIds.add(runId)
        updateLocalizedErrorText(nativeText("Timed out waiting for a reply; try again or refresh."))
        // The optimistic bubble is gone, so the journaled row must stay visible for review;
        // history proof still retires it later if the turn did persist.
        parkUnconfirmedDurableSend(runId)
      }
  }

  /** Parks a still-accepted journaled row as delivery-unconfirmed once local ownership expires. */
  private suspend fun parkUnconfirmedDurableSend(runId: String) {
    val outbox = commandOutbox ?: return
    val row =
      _outboxItems.value.firstOrNull {
        it.status == ChatOutboxStatus.Accepted &&
          (it.id == runId || acknowledgedRunIdByRowId[it.id] == runId)
      } ?: return
    val persisted = updateOutboxStatusOrNull(outbox, row, ChatOutboxStatus.Failed, OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
    if (persisted == null) {
      rearmOutboxRecovery()
      _healthOk.value = false
    } else {
      acknowledgedRunIdByRowId.remove(row.id)
    }
    publishOutbox()
  }

  private fun clearPendingRun(
    runId: String,
    publishRunState: Boolean = true,
  ) {
    pendingRunProjectionsByRunId.remove(runId)
    pendingRunTimeoutJobs.remove(runId)?.cancel()
    unknownOutcomeRunIds.remove(runId)
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.remove(runId)
      pendingRuns.remove(runId)
    }
    clearUnownedNonterminalTelemetry(runId)
    if (publishRunState) publishRunPresentation()
  }

  private fun clearTransientRunUiIfIdle() {
    if (synchronized(pendingRuns) { pendingRuns.isNotEmpty() }) return
    clearLiveRunUi()
  }

  private fun clearPendingRuns(
    clearOptimisticMessages: Boolean = true,
    preserveDisconnectedOwnership: Boolean = false,
    clearRunTelemetry: Boolean = true,
  ) {
    for ((_, job) in pendingRunTimeoutJobs) {
      job.cancel()
    }
    pendingRunTimeoutJobs.clear()
    if (clearOptimisticMessages) {
      runDiagnosticOwner = null
      recoveryHistoryReconciliationJob?.cancel()
      recoveryHistoryReconciliationGeneration = -1L
      recoveryHistoryReconciliationJob = null
      optimisticMessagesByRunId.clear()
      unresolvedRepliesByRunId.clear()
      timedOutRunIds.clear()
      terminalWithoutReplyRunIds.clear()
      unknownOutcomeRunIds.clear()
    }
    synchronized(pendingRuns) {
      if (!preserveDisconnectedOwnership) {
        disconnectedPendingRunIds.clear()
      }
      pendingRuns.clear()
    }
    if (clearRunTelemetry) clearAllRunTelemetry()
    pendingRunProjectionsByRunId.keys
      .filterNot { runId -> synchronized(pendingRuns) { runId in pendingRuns } }
      .forEach(::armPendingRunProjectionDeadline)
    publishRunPresentation()
  }

  private fun removeOptimisticMessage(runId: String) {
    val message = optimisticMessagesByRunId.remove(runId) ?: return
    synchronized(gatewayScopeApplyLock) {
      _messages.value = _messages.value.filterNot { it.id == message.id }
    }
  }

  private fun transferRunOwnership(
    oldRunId: String,
    newRunId: String,
    fallbackMessage: ChatMessage,
    messageIdempotencyKey: String? = fallbackMessage.idempotencyKey,
    publishRunState: Boolean = true,
  ) {
    if (oldRunId == newRunId) return
    runDiagnosticOwner?.takeIf { it.runId == oldRunId }?.let { runDiagnosticOwner = it.copy(runId = newRunId) }
    val pendingProjection = pendingRunProjectionsByRunId.remove(oldRunId)
    val optimistic = optimisticMessagesByRunId.remove(oldRunId)
    val unresolved = unresolvedRepliesByRunId.remove(oldRunId)
    val wasPending = synchronized(pendingRuns) { oldRunId in pendingRuns }
    val terminalWithoutReply = terminalWithoutReplyRunIds.remove(oldRunId)
    unknownOutcomeRunIds.remove(oldRunId)
    pendingRunTimeoutJobs.remove(oldRunId)?.cancel()
    val original = optimistic ?: unresolved ?: fallbackMessage
    // Run ownership can change independently of the client key persisted on the
    // user row. Only history proof may replace that transcript identity.
    val rekeyed = original.copy(idempotencyKey = messageIdempotencyKey)
    if (optimistic != null) optimisticMessagesByRunId[newRunId] = rekeyed
    if (unresolved != null) unresolvedRepliesByRunId[newRunId] = rekeyed
    if (terminalWithoutReply) terminalWithoutReplyRunIds.add(newRunId)
    synchronized(gatewayScopeApplyLock) {
      _messages.value = _messages.value.map { if (it.id == original.id) rekeyed else it }
    }
    val wasProjected = optimistic != null || unresolved != null || wasPending
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.remove(oldRunId)
      pendingRuns.remove(oldRunId)
      if (wasProjected) pendingRuns.add(newRunId)
    }
    transferRunTelemetry(oldRunId, newRunId)
    if (wasProjected) armPendingRunTimeout(newRunId)
    if (pendingProjection != null) {
      pendingRunProjectionsByRunId[newRunId] =
        pendingProjection.copy(
          runId = newRunId,
          optimisticMessage = rekeyed,
        )
      if (!wasProjected) armPendingRunProjectionDeadline(newRunId)
    }
    if (publishRunState) publishRunPresentation()
  }

  private fun transferLostAckOwnershipFromHistory(history: ChatHistory) {
    val snapshotRunId =
      history.inFlightRun
        ?.runId
        ?.trim()
        ?.takeIf { it.isNotEmpty() } ?: return
    if (unresolvedRepliesByRunId.containsKey(snapshotRunId)) return
    val localRunId =
      synchronized(pendingRuns) {
        (pendingRuns + disconnectedPendingRunIds).singleOrNull()
      } ?: return
    if (!unknownOutcomeRunIds.contains(localRunId)) return
    val optimistic = unresolvedRepliesByRunId[localRunId] ?: return
    val canonicalUserKey = "$snapshotRunId:user"
    val optimisticUserKey = optimistic.idempotencyKey?.trim()
    val optimisticContentKey = messageContentIdentityKey(optimistic)
    val persistedUser =
      history.messages.firstOrNull { message ->
        val persistedUserKey = message.idempotencyKey?.trim()
        (persistedUserKey == optimisticUserKey || persistedUserKey == canonicalUserKey) &&
          messageContentIdentityKey(message) == optimisticContentKey
      }
    if (persistedUser != null) {
      transferRunOwnership(
        oldRunId = localRunId,
        newRunId = snapshotRunId,
        fallbackMessage = optimistic,
        messageIdempotencyKey = persistedUser.idempotencyKey,
        publishRunState = false,
      )
    }
  }

  private fun prunePersistedOptimisticMessages(incoming: List<ChatMessage>) {
    val retained =
      retainUnmatchedOptimisticMessages(
        incoming = incoming,
        optimistic = optimisticMessagesByRunId.values,
      ).toSet()
    optimisticMessagesByRunId.entries.removeAll { entry -> entry.value !in retained }
  }

  private fun resolvePersistedReplies(incoming: List<ChatMessage>) {
    val resolvedRunIds =
      unresolvedRepliesByRunId
        .filter { (runId, optimistic) ->
          val userIndex = incoming.indexOfFirst { message -> incomingMessageConsumesOptimistic(message, optimistic) }
          if (userIndex < 0) return@filter false
          terminalWithoutReplyRunIds.contains(runId) ||
            incoming
              .drop(userIndex + 1)
              .takeWhile { it.role.trim().lowercase() != "user" }
              .any { it.role.trim().lowercase() == "assistant" }
        }.keys
        .toList()
    resolvedRunIds.forEach(unresolvedRepliesByRunId::remove)
    resolvedRunIds.forEach(terminalWithoutReplyRunIds::remove)
  }

  private fun scheduleRecoveryHistoryReconciliation(
    sessionKey: String,
    generation: Long,
    runIds: Set<String>,
  ) {
    val reconciliationRunIds = runIds + unresolvedRepliesByRunId.keys
    if (reconciliationRunIds.isEmpty()) return
    val hasPendingRun = synchronized(pendingRuns) { reconciliationRunIds.any { it in pendingRuns } }
    if (!hasPendingRun && reconciliationRunIds.none(unresolvedRepliesByRunId::containsKey)) return
    if (generation < recoveryHistoryReconciliationGeneration) return
    recoveryHistoryReconciliationJob?.cancel()
    recoveryHistoryReconciliationGeneration = generation
    recoveryHistoryReconciliationJob =
      scope.launch {
        delay(recoveryHistoryRetryDelayMs)
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return@launch
        if (!_healthOk.value) return@launch
        refreshHistorySnapshotBestEffort(sessionKey, generation, reconciliationRunIds)
        if (synchronized(pendingRuns) { reconciliationRunIds.any { it in pendingRuns } }) return@launch
        if (reconciliationRunIds.none(unresolvedRepliesByRunId::containsKey)) return@launch

        // A persisted user row is not terminal proof: the assistant row can lag
        // behind it even after the run disappears from the history snapshot.
        delay(pendingRunTimeoutMs - recoveryHistoryRetryDelayMs)
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return@launch
        if (!_healthOk.value) return@launch
        refreshHistorySnapshotBestEffort(sessionKey, generation, reconciliationRunIds)
        if (synchronized(pendingRuns) { reconciliationRunIds.any { it in pendingRuns } }) return@launch
        val unresolvedRunIds = reconciliationRunIds.filter(unresolvedRepliesByRunId::containsKey)
        if (unresolvedRunIds.isEmpty()) return@launch
        unresolvedRunIds.forEach(::removeOptimisticMessage)
        unresolvedRunIds.forEach(unresolvedRepliesByRunId::remove)
        unresolvedRunIds.forEach(terminalWithoutReplyRunIds::remove)
        updateLocalizedErrorText(nativeText("Timed out confirming the sent message; refresh to check delivery."))
        // Ownership expired without proof; keep the journaled copies visible for manual review.
        for (unresolvedRunId in unresolvedRunIds) {
          parkUnconfirmedDurableSend(unresolvedRunId)
        }
      }
  }

  private suspend fun refreshHistorySnapshotBestEffort(
    sessionKey: String,
    generation: Long,
    runIdsToReconcile: Set<String>,
  ): HistoryRefreshResult =
    try {
      fetchAndApplyHistory(
        sessionKey,
        generation,
        updateSessionInfo = true,
        runIdsToReconcile = runIdsToReconcile,
        markCompletedTranscript = runIdsToReconcile.isNotEmpty(),
      )
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      // The bounded expiry below remains the final reconciliation path.
      HistoryRefreshResult.Failed
    }

  private fun refreshCurrentHistoryBestEffort(
    runIdsToReconcile: Set<String> = emptySet(),
    updateSessionInfo: Boolean = false,
  ) {
    val sessionKey = _sessionKey.value
    val generation = historyLoadGeneration.get()
    scope.launch {
      try {
        fetchAndApplyHistory(
          sessionKey = sessionKey,
          generation = generation,
          updateSessionInfo = updateSessionInfo,
          runIdsToReconcile = runIdsToReconcile,
          markCompletedTranscript = runIdsToReconcile.isNotEmpty(),
        )
      } catch (_: Throwable) {
        // best-effort
      } finally {
        if (isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) {
          scheduleRecoveryHistoryReconciliation(sessionKey, generation, runIdsToReconcile)
        }
      }
    }
  }

  private fun parseHistory(
    historyJson: String,
    sessionKey: String,
    previousMessages: List<ChatMessage>,
  ): ChatHistory {
    val root = json.parseToJsonElement(historyJson).asObjectOrNull() ?: return ChatHistory(sessionKey, null, null, emptyList())
    val sid = root["sessionId"].asStringOrNull()
    val thinkingLevel = root["thinkingLevel"].asStringOrNull()
    val sessionInfo = root["sessionInfo"].asObjectOrNull()?.let { parseSessionEntry(it, fallbackKey = sessionKey) }
    val array = root["messages"].asArrayOrNull() ?: JsonArray(emptyList())

    val messages = array.mapNotNull { it.asObjectOrNull()?.let { message -> parseMessage(message) } }

    return ChatHistory(
      sessionKey = sessionKey,
      sessionId = sid,
      thinkingLevel = thinkingLevel,
      messages = reconcileMessageIds(previous = previousMessages, incoming = messages),
      sessionInfo = sessionInfo,
      inFlightRun = parseInFlightRun(root),
    )
  }

  private fun parseMessage(
    obj: JsonObject,
    maxChars: Int = 8_000,
  ): ChatMessage? {
    val role = normalizeVisibleChatMessageRole(obj["role"].asStringOrNull()) ?: return null
    val metadata = obj["__openclaw"].asObjectOrNull()
    val content = parseChatMessageContents(obj)
    // v2026.7.1-2 retains entry IDs but signals display caps with an exact terminal suffix.
    // Native clients can outlive their Gateway; normalize here until the minimum supported
    // Gateway guarantees the structural marker. The retrieval cap differs from history's.
    val legacySuffix = "\n...(truncated)..."
    val truncated = metadata?.get("truncated")
    return ChatMessage(
      id = UUID.randomUUID().toString(),
      role = role,
      content = content,
      timestampMs = obj["timestamp"].asLongOrNull(),
      idempotencyKey = obj["idempotencyKey"].asStringOrNull(),
      entryId = metadata?.get("id").asJsonStringOrNull()?.takeIf { it.isNotBlank() },
      isSyntheticDisplay = obj["openclawMessageToolMirror"].asObjectOrNull() != null || obj["openclawStreamFallback"].asObjectOrNull() != null,
      truncated =
        truncated == JsonPrimitive(true) ||
          (truncated == null && content.any { it.type == "text" && it.text?.length == maxChars + legacySuffix.length && it.text.endsWith(legacySuffix) }),
      provenance = parseChatMessageProvenance(obj["provenance"]),
      transcriptMarker = parseChatTranscriptMarker(obj["__openclaw"]),
      senderLabel = obj["senderLabel"].asJsonStringOrNull()?.trim()?.takeIf { role == "user" && it.isNotEmpty() },
    )
  }

  private fun parseChatMessageProvenance(element: JsonElement?): ChatMessageProvenance? {
    val obj = element.asObjectOrNull() ?: return null
    val kind = obj["kind"].asJsonStringOrNull() ?: return null
    return ChatMessageProvenance(
      kind = kind,
      sourceTool = obj["sourceTool"].asJsonStringOrNull(),
    )
  }

  private fun parseChatTranscriptMarker(element: JsonElement?): ChatTranscriptMarker? {
    val obj = element.asObjectOrNull() ?: return null
    val kind = obj["kind"].asJsonStringOrNull() ?: return null
    return ChatTranscriptMarker(
      kind = kind,
      id = obj["id"].asJsonStringOrNull(),
      tokensBefore = obj["tokensBefore"].asJsonNumberOrNull(),
      tokensAfter = obj["tokensAfter"].asJsonNumberOrNull(),
    )
  }

  private fun parseInFlightRun(root: JsonObject): ChatInFlightRun? {
    val obj = root["inFlightRun"].asObjectOrNull() ?: return null
    val runId = obj["runId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return ChatInFlightRun(
      runId = runId,
      text = obj["text"].asStringOrNull().orEmpty(),
    )
  }

  private data class SessionListResult(
    val sessions: List<ChatSessionEntry>,
    val isTruncated: Boolean,
  )

  private data class SessionSettingsPatchResolution(
    val modelProvider: String?,
    val model: String?,
    val agentRuntimeId: String?,
    val thinkingLevel: String?,
    val thinkingLevels: List<ChatThinkingLevelOption>?,
    val entry: ChatSessionEntry?,
  )

  private fun parseSessions(jsonString: String): SessionListResult {
    val root =
      json.parseToJsonElement(jsonString).asObjectOrNull()
        ?: return SessionListResult(emptyList(), isTruncated = false)
    val sessions =
      root["sessions"]
        .asArrayOrNull()
        ?.mapNotNull { item -> parseSessionEntry(item.asObjectOrNull()) }
        .orEmpty()
    val totalCount = root["totalCount"].asLongOrNull()
    val isTruncated =
      root["hasMore"].asBooleanOrNull() == true ||
        (totalCount != null && totalCount > sessions.size)
    return SessionListResult(sessions, isTruncated)
  }

  private fun parseSessionEntry(
    obj: JsonObject?,
    fallbackKey: String? = null,
  ): ChatSessionEntry? {
    if (obj == null) return null
    val key =
      obj["key"]
        .asStringOrNull()
        ?.trim()
        .orEmpty()
        .ifEmpty {
          obj["sessionKey"]
            .asStringOrNull()
            ?.trim()
            .orEmpty()
        }.ifEmpty { fallbackKey?.trim().orEmpty() }
    if (key.isEmpty()) return null
    return ChatSessionEntry(
      key = key,
      sessionId = obj["sessionId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      updatedAtMs = obj["updatedAt"].asLongOrNull(),
      ownerAgentId = obj["agentId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      classification = obj["classification"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      accountId = obj["accountId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      peerKind = obj["peerKind"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      isMain = obj["isMain"].asBooleanOrNull(),
      isBackground = obj["isBackground"].asBooleanOrNull(),
      hasClassificationMetadata =
        "classification" in obj ||
          "accountId" in obj ||
          "peerKind" in obj ||
          "isMain" in obj ||
          "isBackground" in obj,
      displayName = obj["displayName"].asStringOrNull()?.trim(),
      derivedTitle = obj["derivedTitle"].asStringOrNull()?.trim(),
      label = obj["label"].asStringOrNull()?.trim(),
      category = obj["category"].asStringOrNull()?.trim(),
      color =
        obj["color"]
          .asJsonStringOrNull()
          ?.trim()
          ?.lowercase()
          ?.takeIf { it.isNotEmpty() },
      hasColorMetadata = "color" in obj,
      pinned = obj["pinned"].asBooleanOrNull(),
      archived = obj["archived"].asBooleanOrNull(),
      unread = obj["unread"].asBooleanOrNull(),
      lastReadAt = obj["lastReadAt"].asLongOrNull(),
      markedUnreadAt = obj["markedUnreadAt"].asLongOrNull(),
      hasMarkedUnreadMetadata = "markedUnreadAt" in obj,
      agentStatus = parseSessionAgentStatus(obj["agentStatus"]),
      hasAgentStatusMetadata = "agentStatus" in obj,
      observerDigest =
        obj["observerDigest"]
          ?.takeUnless { it is JsonNull }
          ?.let { runCatching { json.decodeFromJsonElement<SessionObserverDigest>(it) }.getOrNull() },
      hasObserverDigestMetadata = "observerDigest" in obj,
      lastActivityAt = obj["lastActivityAt"].asLongOrNull(),
      inputTokens = obj["inputTokens"].asLongOrNull(),
      totalTokens = obj["totalTokens"].asLongOrNull(),
      hasTotalTokensMetadata = "totalTokens" in obj,
      totalTokensFresh = obj["totalTokensFresh"].asBooleanOrNull(),
      modelProvider = obj["modelProvider"].asStringOrNull()?.trim(),
      model = obj["model"].asStringOrNull()?.trim(),
      modelSelectionLocked = obj["modelSelectionLocked"].asBooleanOrNull(),
      agentRuntimeId =
        obj["agentRuntime"]
          .asObjectOrNull()
          ?.get("id")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty),
      thinkingLevel = obj["thinkingLevel"].asStringOrNull()?.trim(),
      thinkingLevels = parseThinkingLevels(obj["thinkingLevels"]),
      thinkingDefault = obj["thinkingDefault"].asStringOrNull()?.trim(),
      permissionMode = ChatPermissionMode.fromWireValue(obj["permissionMode"].asStringOrNull()),
      hasPermissionModeMetadata = "permissionMode" in obj,
      permissionModePending = obj["permissionModePending"].asBooleanOrNull(),
      fastMode = ChatFastMode.fromWireValue(obj["fastMode"].asStringOrNull()),
      effectiveFastMode = ChatFastMode.fromWireValue(obj["effectiveFastMode"].asStringOrNull()),
      hasFastModeMetadata = "fastMode" in obj,
      hasEffectiveFastModeMetadata = "effectiveFastMode" in obj,
      contextTokens = obj["contextTokens"].asLongOrNull(),
      estimatedCostUsd = obj["estimatedCostUsd"].asJsonNumberOrNull()?.takeIf { it.isFinite() && it >= 0.0 },
      hasContextUsageMetadata =
        "totalTokens" in obj ||
          "totalTokensFresh" in obj ||
          "contextTokens" in obj,
      hasActiveRun = obj["hasActiveRun"].asBooleanOrNull(),
      activeRunIds =
        obj["activeRunIds"]
          .asArrayOrNull()
          ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) },
      hasActiveRunMetadata = "hasActiveRun" in obj || "activeRunIds" in obj,
      hasActiveRunIdsMetadata = "activeRunIds" in obj,
      parentSessionKey = obj["parentSessionKey"].asStringOrNull()?.trim(),
      spawnedBy = obj["spawnedBy"].asStringOrNull()?.trim(),
      hasActiveSubagentRun = obj["hasActiveSubagentRun"].asBooleanOrNull(),
      subagentRunState = obj["subagentRunState"].asStringOrNull()?.trim(),
      swarmGroupId = obj["swarmGroupId"].asStringOrNull()?.trim(),
      swarmPhase = obj["swarmPhase"].asStringOrNull()?.trim(),
      swarmPhaseRank = obj["swarmPhaseRank"].asLongOrNull()?.toInt(),
      swarmLog = obj["swarmLog"].asStringOrNull()?.trim(),
      status = obj["status"].asStringOrNull()?.trim(),
      lastRunError = obj["lastRunError"].asStringOrNull()?.trim(),
      startedAt = obj["startedAt"].asLongOrNull(),
      endedAt = obj["endedAt"].asLongOrNull(),
      runtimeMs = obj["runtimeMs"].asLongOrNull(),
      outputTokens = obj["outputTokens"].asLongOrNull(),
      hasSessionUsageMetadata =
        "inputTokens" in obj ||
          "outputTokens" in obj ||
          "estimatedCostUsd" in obj,
      hasRunMetadata =
        "status" in obj ||
          "lastRunError" in obj ||
          "startedAt" in obj ||
          "endedAt" in obj ||
          "runtimeMs" in obj ||
          "outputTokens" in obj,
    )
  }

  private fun parseSessionAgentStatus(element: JsonElement?): ChatSessionAgentStatus? {
    val obj = element.asObjectOrNull() ?: return null
    val note = obj["note"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val expiresAt = obj["expiresAt"].asLongOrNull() ?: return null
    return ChatSessionAgentStatus(
      note = note,
      expiresAt = expiresAt,
      attention = obj["attention"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    )
  }

  private fun parseSessionSettingsPatchResolution(
    jsonString: String,
    key: String,
  ): SessionSettingsPatchResolution? {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    val resolved = root["resolved"].asObjectOrNull()
    val entry = root["entry"].asObjectOrNull()
    if (resolved == null && entry == null) return null
    return SessionSettingsPatchResolution(
      modelProvider = resolved?.get("modelProvider").asStringOrNull()?.trim(),
      model = resolved?.get("model").asStringOrNull()?.trim(),
      // The entry is stored state; the ACK's resolved runtime is the current owner.
      agentRuntimeId =
        resolved
          ?.get("agentRuntime")
          .asObjectOrNull()
          ?.get("id")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty),
      thinkingLevel = resolved?.get("thinkingLevel").asStringOrNull()?.trim(),
      thinkingLevels = parseThinkingLevels(resolved?.get("thinkingLevels")),
      entry = parseSessionEntry(entry, fallbackKey = key),
    )
  }

  private fun parseThinkingLevels(element: JsonElement?): List<ChatThinkingLevelOption>? {
    val array = element.asArrayOrNull() ?: return null
    return array
      .mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val rawId = obj["id"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val id = normalizeThinking(rawId)
        val label = obj["label"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id
        ChatThinkingLevelOption(id = id, label = label)
      }.distinctBy { it.id }
  }

  private fun applyAcceptedSessionSettings(
    queued: QueuedSessionSettingsMutation,
    change: SessionSettingsChange,
    resolution: SessionSettingsPatchResolution?,
  ): ChatSessionEntry {
    val key = queued.settingsKey.sessionKey
    val base = _sessions.value.firstOrNull { it.key == key } ?: queued.lane.confirmed
    val resolvedEntry = resolution?.entry
    var applied =
      base.copy(
        modelProvider = resolution?.modelProvider ?: base.modelProvider,
        model = resolution?.model ?: base.model,
        modelSelectionLocked = resolvedEntry?.modelSelectionLocked ?: base.modelSelectionLocked,
        agentRuntimeId = resolution?.agentRuntimeId ?: base.agentRuntimeId,
        thinkingLevel = resolution?.thinkingLevel?.let(::normalizeThinking) ?: base.thinkingLevel,
        thinkingLevels = resolution?.thinkingLevels ?: base.thinkingLevels,
      )
    applied =
      when (change) {
        is SessionSettingsChange.Model -> {
          val provider = change.ref?.substringBefore('/', missingDelimiterValue = "")?.takeIf(String::isNotEmpty)
          val model = change.ref?.let { it.substringAfter('/', missingDelimiterValue = it) }
          applied.copy(
            modelProvider = resolution?.modelProvider ?: provider ?: base.modelProvider.takeIf { change.ref != null },
            model = resolution?.model ?: model,
            thinkingDefault = null,
          )
        }

        is SessionSettingsChange.Thinking -> {
          applied.copy(thinkingLevel = resolution?.thinkingLevel?.let(::normalizeThinking) ?: change.level)
        }

        is SessionSettingsChange.Permission -> {
          applied.copy(
            permissionMode = if (resolvedEntry?.hasPermissionModeMetadata == true) resolvedEntry.permissionMode else change.mode,
            hasPermissionModeMetadata = true,
            permissionModePending = resolvedEntry?.permissionModePending ?: base.permissionModePending,
          )
        }

        is SessionSettingsChange.FastMode -> {
          val mode = if (resolvedEntry?.hasFastModeMetadata == true) resolvedEntry.fastMode else change.mode
          val effective =
            if (resolvedEntry?.hasEffectiveFastModeMetadata == true) resolvedEntry.effectiveFastMode else mode ?: base.effectiveFastMode
          if (mode == null && resolvedEntry?.hasEffectiveFastModeMetadata != true) queued.lane.needsRefresh = true
          applied.copy(
            fastMode = mode,
            effectiveFastMode = effective,
            hasFastModeMetadata = true,
            hasEffectiveFastModeMetadata = resolvedEntry?.hasEffectiveFastModeMetadata == true || effective != null || base.hasEffectiveFastModeMetadata,
          )
        }
      }
    return upsertSessionEntry(applied, replace = true, authoritativeSessionSettings = true)
  }

  private fun observeSessionSettings(
    entry: ChatSessionEntry,
    snapshot: SessionSettingsSnapshot? = null,
  ) {
    val key =
      sessionSettingsKey(
        normalizeRequestedSessionKey(entry.key),
        ownerAgentId = entry.ownerAgentId ?: resolveAgentIdForSessionKey(entry.key),
      )
    if (snapshot != null) {
      // Keep the received fields, not the richer cached row. A repeated value is
      // still newer evidence, while omitted catalog metadata must not force retries.
      activeSessionReads
        .filter { it.gatewayScope == key.gatewayScope && it.ownerAgentId == key.ownerAgentId }
        .forEach { it.observe(snapshot) }
    }
    pendingSettingsMutations[key]?.let { lane ->
      lane.confirmed = entry
      lane.observation = Any()
    }
    if (entry.key == _sessionKey.value) {
      settingsPublicationGeneration.incrementAndGet()
      publishSelectedSessionSettings(entry)
    }
  }

  private fun publishSelectedSessionSettings(entry: ChatSessionEntry?) {
    val lane = pendingSettingsMutations[sessionSettingsKey(_sessionKey.value)]
    _selectedModelRef.value = entry?.providerQualifiedModelRef()
    applyThinkingMetadata(entry, lane?.confirmedThinkingLevel ?: _thinkingLevel.value)
    lane?.confirmedThinkingLevel = _thinkingLevel.value
    // An unsent successor is still the latest local choice. Once dispatched,
    // canonical observations may supersede it, including before its ACK arrives.
    lane
      ?.thinkingIntent
      ?.takeUnless { it.dispatched }
      ?.let { _thinkingLevel.value = it.level }
  }

  private fun applyThinkingMetadata(
    entry: ChatSessionEntry?,
    fallbackLevel: String = _thinkingLevel.value,
  ) {
    val advertised = entry?.thinkingLevels
    if (advertised == null) {
      _thinkingLevelSelection.value = defaultChatThinkingLevelSelection
      val requestedLevel =
        entry
          ?.thinkingLevel
          ?.takeIf { it.isNotBlank() }
          ?.let(::normalizeThinking)
          ?: normalizeThinking(fallbackLevel)
      _thinkingLevel.value =
        if (entry?.thinkingLevel != null) {
          requestedLevel
        } else {
          requestedLevel.takeIf { candidate ->
            defaultChatThinkingLevelSelection.options.any { it.id == candidate }
          } ?: "off"
        }
      return
    }
    val options =
      advertised
        .map { option ->
          val id = normalizeThinking(option.id)
          ChatThinkingLevelOption(
            id = id,
            label = option.label.trim().takeIf { it.isNotEmpty() } ?: id,
          )
        }.distinctBy { it.id }
        .ifEmpty { listOf(ChatThinkingLevelOption(id = "off", label = "Off")) }
    _thinkingLevelSelection.value =
      ChatThinkingLevelSelection(
        options = options,
        isGatewayProvided = true,
      )
    val selected = entry.thinkingLevel?.let(::normalizeThinking)
    val currentLevel = normalizeThinking(fallbackLevel)
    val defaultLevel = entry.thinkingDefault?.let(::normalizeThinking)
    // Lightweight picker metadata can omit a Gateway-validated effective level.
    // Preserve that send state; only local/default fallbacks require picker membership.
    _thinkingLevel.value =
      selected
        ?: listOf(currentLevel, defaultLevel).firstOrNull { candidate -> options.any { it.id == candidate } }
        ?: options.first().id
  }

  private fun thinkingSupportedForCurrentSelection(): Boolean {
    val selection = _thinkingLevelSelection.value
    return if (selection.isGatewayProvided) {
      selection.options.any { it.id != "off" }
    } else {
      thinkingSupportedForSelection(_selectedModelRef.value, _modelCatalog.value)
    }
  }

  private fun updateSessionFromHistory(
    history: ChatHistory,
    ownerAgentId: String,
    publishRunState: Boolean = true,
    includeSessionInfo: Boolean = true,
    preserveSessionSettings: Boolean = false,
  ): ChatSessionEntry? {
    val thinkingLevel = history.thinkingLevel?.trim()?.takeIf(String::isNotEmpty)
    val info =
      history.sessionInfo.takeIf { includeSessionInfo }
        ?: thinkingLevel?.let { ChatSessionEntry(key = history.sessionKey, updatedAtMs = null, thinkingLevel = it) }
        ?: return null
    return upsertSessionEntry(
      info.copy(ownerAgentId = ownerAgentId, thinkingLevel = thinkingLevel ?: info.thinkingLevel),
      preserveExistingContextUsageWithoutTotal = true,
      replaceActiveRunIds = includeSessionInfo && history.sessionInfo != null,
      publishRunState = publishRunState,
      preserveSessionSettings = preserveSessionSettings,
    )
  }

  private fun upsertSessionEntry(
    entry: ChatSessionEntry,
    preserveExistingContextUsageWithoutTotal: Boolean = false,
    replaceActiveRunIds: Boolean = false,
    clearedFields: Set<String> = emptySet(),
    authoritativeSessionSettings: Boolean = false,
    publishRunState: Boolean = true,
    replace: Boolean = false,
    preserveSessionSettings: Boolean = false,
  ): ChatSessionEntry {
    val current = _sessions.value
    val index = current.indexOfFirst { it.key == entry.key }
    val existing = current.getOrNull(index)
    var applied =
      if (replace || (existing == null && !preserveSessionSettings)) {
        entry
      } else {
        mergeChatSessionEntry(
          existing = existing ?: ChatSessionEntry(key = entry.key, updatedAtMs = null),
          next = entry,
          preserveExistingContextUsageWithoutTotal = preserveExistingContextUsageWithoutTotal,
          replaceActiveRunIds = replaceActiveRunIds,
          authoritativeSessionSettings = authoritativeSessionSettings,
          preserveSessionSettings = preserveSessionSettings,
        )
      }
    if (clearedFields.isNotEmpty()) {
      applied =
        applied.copy(
          label = if ("label" in clearedFields) null else applied.label,
          category = if ("category" in clearedFields) null else applied.category,
        )
    }
    _sessions.value =
      if (index >= 0) current.toMutableList().also { it[index] = applied } else listOf(applied) + current
    if (!preserveSessionSettings && (authoritativeSessionSettings || replace || entry.carriesSessionSettings())) {
      observeSessionSettings(applied, SessionSettingsSnapshot(entry, authoritativeSessionSettings || replace))
    }
    if (applied.key == _sessionKey.value) {
      pruneRunTelemetryToAuthoritativeOwnership()
      if (publishRunState) publishRunPresentation()
    }
    return applied
  }

  /**
   * Acknowledges unread state for the visited session at most once per unread episode: the
   * pending flag resets when the server-confirmed read (unread=false) is observed, so a run
   * finishing while the session stays open re-acknowledges without patch loops (the gateway
   * stamps lastReadAt server-side, which makes the exchange convergent).
   */
  private fun acknowledgeUnreadIfNeeded(
    key: String,
    entry: ChatSessionEntry?,
    requireActive: Boolean = false,
  ) {
    if (key.isEmpty() || key != unreadPatchSessionKey) return
    if (entry == null) return
    if (!unreadActivationObserved) {
      unreadActivationObserved = true
      unreadActivationMarkedUnreadAt = entry.markedUnreadAt
    }
    if (entry.unread == false) {
      unreadActivationMarkedUnreadAt = null
      unreadPatchRequested = false
      return
    }
    val markedUnreadAt = entry.markedUnreadAt
    if (markedUnreadAt != null && markedUnreadAt != unreadActivationMarkedUnreadAt) {
      return
    }
    if (entry.unread != true || unreadPatchRequested) return
    // switchSession acknowledges before _sessionKey updates; background upserts only
    // re-acknowledge the session that is currently open.
    if (requireActive && key != _sessionKey.value) return
    unreadPatchRequested = true
    // Native app and Gateway releases can skew. Only current Gateways accept
    // the closed-schema conditional acknowledgement field.
    val unreadExpectation =
      if (gatewayAdvertisesCapability(SESSION_UNREAD_ACK_CAPABILITY) == true) {
        ChatSessionUnreadExpectation(entry.markedUnreadAt)
      } else {
        null
      }
    scope.launch {
      // A failed read patch must unlatch the episode so later snapshots retry.
      if (
        !patchSession(
          key = key,
          ownerAgentId = entry.ownerAgentId,
          unread = false,
          unreadExpectation = unreadExpectation,
        ) &&
        unreadPatchSessionKey == key
      ) {
        unreadPatchRequested = false
      }
    }
  }

  private fun removeSessionEntry(
    sessionKey: String?,
    ownerAgentId: String? = null,
    cacheScope: ChatCacheScope? = currentCacheScope(),
  ): Boolean {
    val key = sessionKey?.trim()?.takeIf { it.isNotEmpty() } ?: return false
    val owner = resolveAgentIdFromMainSessionKey(key) ?: ownerAgentId?.trim()?.takeIf { it.isNotEmpty() }
    val (removesVisibleEntry, retiredSettings) =
      synchronized(gatewayScopeApplyLock) {
        val retired =
          retireSessionSettingsLanes { settingsKey, _ ->
            owner != null && settingsKey == SessionSettingsKey(cacheScope, key, owner)
          }
        val visibleOwner = resolveAgentIdForSessionKey(_sessionKey.value)
        val removesVisibleEntry = cacheScope == currentCacheScope() && owner != null && owner == visibleOwner
        if (removesVisibleEntry) _sessions.value = _sessions.value.filterNot { it.key == key }
        removesVisibleEntry to retired
      }
    retiredSettings.forEach { it.complete(false) }
    // Gateway-side deletes must also purge the offline copy, or the deleted transcript would
    // reappear on the next offline cold open. Queued commands for the session die with it too.
    if (owner != null) purgeSessionOwnedState(key, owner, cacheScope)
    if (removesVisibleEntry) fallBackFromRetiredActiveSession(key)
    return removesVisibleEntry
  }

  private fun purgeSessionOwnedState(
    sessionKey: String,
    ownerAgentId: String,
    cacheScope: ChatCacheScope?,
  ) {
    synchronized(gatewayScopeApplyLock) {
      val owner = ChatAgentSessionSelectionOwner(cacheScope?.gatewayId, ownerAgentId)
      if (lastSelectedChatSessionByOwner[owner]?.key == sessionKey) lastSelectedChatSessionByOwner.remove(owner)
    }
    if (cacheScope == null) return
    onSessionDeleted(
      ChatSessionDeletion(
        gatewayId = cacheScope.gatewayId,
        agentId = ownerAgentId,
        sessionKey = sessionKey,
        mainSessionKey = appliedMainSessionKey,
      ),
    )
    scope.launch {
      cacheMutationMutex.withLock {
        transcriptCache?.let { runCatching { it.deleteSession(cacheScope.gatewayId, ownerAgentId, sessionKey) } }
        commandOutbox?.let { runCatching { it.deleteForSession(cacheScope.gatewayId, sessionKey, ownerAgentId) } }
      }
      publishOutbox()
    }
  }

  private suspend fun fetchSessionDescription(
    gatewayId: String?,
    sessionKey: String,
  ): JsonObject? {
    val params = buildJsonObject { put("key", JsonPrimitive(sessionKey)) }
    val response = requestGatewayBound(gatewayId, "sessions.describe", params.toString())
    val root = json.parseToJsonElement(response).asObjectOrNull() ?: error("invalid sessions.describe response")
    return when (val session = root["session"]) {
      is JsonObject -> session
      JsonNull -> null
      else -> error("sessions.describe returned no valid session field")
    }
  }

  private suspend fun requestGatewayBound(
    gatewayId: String?,
    method: String,
    paramsJson: String?,
  ): String =
    if (gatewayId == null) {
      requestGateway(method, paramsJson)
    } else {
      requestGatewayForGateway(gatewayId, method, paramsJson)
    }

  private suspend fun requestSessionCreate(
    gatewayScope: ChatCacheScope?,
    params: JsonObject,
    lease: GatewaySession.RequestLease,
  ): String {
    val parent =
      params["parentSessionKey"].asStringOrNull()?.let { key ->
        sessionSettingsKey(key, gatewayScope, params["agentId"].asStringOrNull())
      }

    fun requireMutableParent() {
      if (gatewayScope != currentCacheScope()) throw GatewayRequestNotEnqueued("gateway connection changed")
      if (parent != null && isSessionModelSelectionLocked(parent)) {
        throw GatewayRequestNotEnqueued("Model-selection-locked sessions cannot create child sessions from parent context.")
      }
    }

    synchronized(gatewayScopeApplyLock) { requireMutableParent() }

    suspend fun request(createParams: JsonObject): String =
      lease.request("sessions.create", createParams.toString()) { enqueue ->
        // The runtime owns locked parent lineage. Recheck its current metadata
        // after transport waiting, before the physical socket accepts the child.
        synchronized(gatewayScopeApplyLock) {
          requireMutableParent()
          enqueue()
        }
      }

    return try {
      request(params)
    } catch (err: GatewayRequestRejected) {
      val message = err.gatewayError.message
      val isOlderGateway =
        err.gatewayError.code == "INVALID_REQUEST" &&
          message.contains("invalid sessions.create params") &&
          message.contains("succeedsParent")
      if (!isOlderGateway || "succeedsParent" !in params) throw err

      // Older Gateways cannot express a linked parallel child. Keep New Chat parallel by
      // dropping the parent lifecycle fields instead of falling back to legacy rollover.
      val legacyParams =
        JsonObject(
          params.filterKeys { key ->
            key != "succeedsParent" && key != "parentSessionKey" && key != "emitCommandHooks"
          },
        )
      request(legacyParams)
    }
  }

  private fun currentCacheScope(): ChatCacheScope? = normalizedChatCacheScope(cacheScope())

  private fun isSessionModelSelectionLocked(key: SessionSettingsKey): Boolean =
    (
      pendingSettingsMutations[key]?.confirmed
        ?: _sessions.value.firstOrNull {
          it.key == key.sessionKey && (it.ownerAgentId ?: resolveAgentIdFromMainSessionKey(it.key)) == key.ownerAgentId
        }
    )?.modelSelectionLocked == true

  /** Keeps an unscoped chat bound to its verified agent only while the same gateway reconnects. */
  private fun effectiveDefaultAgentId(): String? {
    currentDefaultAgentId()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    val gatewayId = currentCacheScope()?.gatewayId ?: return null
    return lastVerifiedDefaultAgentId.takeIf { lastVerifiedDefaultAgentGatewayId == gatewayId }
  }

  private fun sessionSettingsKey(
    sessionKey: String,
    gatewayScope: ChatCacheScope? = currentCacheScope(),
    ownerAgentId: String? = resolveAgentIdForSessionKey(sessionKey),
  ): SessionSettingsKey =
    SessionSettingsKey(
      gatewayScope = gatewayScope,
      sessionKey = sessionKey,
      ownerAgentId = ownerAgentId,
    )

  private fun normalizeThinking(raw: String): String = raw.trim().lowercase(Locale.US).ifEmpty { "off" }
}

private enum class ChatMetadataLoadState {
  Unloaded,
  RetryEmptyCatalog,
  Loaded,
}

// Group mutations enumerate whole stores; far past any realistic session count.
private const val GROUP_MEMBER_FETCH_LIMIT = 10_000
private const val FULL_MESSAGE_TEXT_MAX_CHARS = 1_000_000

internal fun isCurrentHistoryLoad(
  requestedSessionKey: String,
  currentSessionKey: String,
  requestGeneration: Long,
  activeGeneration: Long,
): Boolean = requestedSessionKey == currentSessionKey && requestGeneration == activeGeneration

/**
 * Convert gateway chat content parts into Android UI content parts.
 */
internal fun parseChatMessageContent(el: JsonElement): ChatMessageContent? {
  val obj = el.asObjectOrNull() ?: return null
  return when (val type = obj["type"].asStringOrNull() ?: "text") {
    "text", "input_text", "output_text" -> {
      ChatMessageContent(
        type = "text",
        text = obj["text"].asStringOrNull() ?: obj["content"].asStringOrNull(),
      )
    }

    "image", "audio", "video" -> {
      parseChatMediaContent(obj, type)
    }

    "attachment", "file" -> {
      val attachment = obj["attachment"].asObjectOrNull() ?: obj
      val mimeType = attachment["mimeType"].asStringOrNull()
      val type =
        when {
          attachment["kind"].asStringOrNull() == "audio" || mimeType?.startsWith("audio/") == true -> "audio"
          attachment["kind"].asStringOrNull() == "video" || mimeType?.startsWith("video/") == true -> "video"
          attachment["kind"].asStringOrNull() == "document" || !attachment.containsKey("kind") -> "file"
          else -> return null
        }
      parseChatMediaContent(
        obj = attachment,
        type = type,
        fileName = attachment["fileName"].asStringOrNull() ?: (attachment["label"] ?: attachment["name"]).asStringOrNull(),
      )
    }

    "canvas" -> {
      val preview = obj["preview"].asObjectOrNull() ?: return null
      val sandbox = preview["sandbox"].asStringOrNull() ?: return null
      if (preview["kind"].asStringOrNull() != "canvas" ||
        preview["surface"].asStringOrNull() != "assistant_message" ||
        preview["render"].asStringOrNull() != "url" ||
        (sandbox != "scripts" && sandbox != "strict")
      ) {
        return null
      }
      val path = preview["url"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return null
      if (!ChatWidgetUrlResolver.supportsTarget(path)) return null
      ChatMessageContent(
        type = "canvas",
        widget =
          ChatWidgetPreview(
            title = preview["title"].asStringOrNull(),
            path = path,
            preferredHeight = preview["preferredHeight"].asLongOrNull()?.coerceIn(160, 1200)?.toInt(),
            sandbox = sandbox,
          ),
      )
    }

    else -> {
      null
    }
  }
}

private fun parseChatMediaContent(
  obj: JsonObject,
  type: String,
  fileName: String? = obj["fileName"].asStringOrNull(),
): ChatMessageContent {
  val url = obj["url"].asStringOrNull()
  return ChatMessageContent(
    type = type,
    mimeType = obj["mimeType"].asStringOrNull(),
    fileName = fileName,
    artifactId =
      obj["artifactId"].asStringOrNull()
        ?: if (type == "image") managedImageArtifactId(url) else managedMediaArtifactId(url),
    url = url,
    openUrl = obj["openUrl"].asStringOrNull(),
    alt = obj["alt"].asStringOrNull(),
    width = obj["width"].asLongOrNull()?.toInt(),
    height = obj["height"].asLongOrNull()?.toInt(),
    sizeBytes = obj["sizeBytes"].asLongOrNull(),
    base64 = obj["content"].asStringOrNull()?.takeIf { type == "image" && it.isNotBlank() && it.length <= CHAT_IMAGE_MAX_BASE64_CHARS },
    durationMs = obj["durationMs"].asLongOrNull(),
    playback = obj["playback"].asStringOrNull()?.takeIf { it == "native" || it == "transcode" },
  )
}

internal fun managedImageArtifactId(rawUrl: String?): String? {
  val attachmentId = managedMediaAttachmentId(rawUrl) ?: return null
  return "artifact_managed_image_$attachmentId"
}

internal fun managedMediaArtifactId(rawUrl: String?): String? {
  val attachmentId = managedMediaAttachmentId(rawUrl) ?: return null
  return "artifact_managed_media_$attachmentId"
}

private fun managedMediaAttachmentId(rawUrl: String?): String? {
  val match =
    rawUrl
      ?.trim()
      ?.let(MANAGED_MEDIA_PATH_REGEX::matchEntire)
      ?: return null
  return runCatching { UUID.fromString(match.groupValues[1]).toString() }.getOrNull()
}

internal fun parseChatMessageContents(obj: JsonObject): List<ChatMessageContent> {
  val content =
    obj["content"].asArrayOrNull()?.mapNotNull(::parseChatMessageContent)
      ?: obj["content"].asStringOrNull()?.let { listOf(ChatMessageContent(type = "text", text = it)) }
      ?: obj["text"].asStringOrNull()?.let { listOf(ChatMessageContent(type = "text", text = it)) }
      ?: emptyList()
  val transcriptAudio = parseTranscriptAudioContents(obj)
  if (transcriptAudio.isEmpty()) return content
  return content +
    transcriptAudio.filterNot { audio ->
      content.any { it.mimeType == audio.mimeType && it.fileName == audio.fileName }
    }
}

private fun parseTranscriptAudioContents(obj: JsonObject): List<ChatMessageContent> {
  val paths =
    obj["MediaPaths"].asArrayOrNull()?.mapNotNull { it.asStringOrNull() }
      ?: obj["MediaPath"].asStringOrNull()?.let { listOf(it) }
      ?: return emptyList()
  val types =
    obj["MediaTypes"].asArrayOrNull()?.map { it.asStringOrNull().orEmpty() }
      ?: obj["MediaType"].asStringOrNull()?.let { listOf(it) }
      ?: emptyList()
  return paths.mapIndexedNotNull { index, path ->
    val mimeType = types.getOrNull(index)?.takeIf { it.startsWith("audio/") } ?: return@mapIndexedNotNull null
    ChatMessageContent(
      type = "audio",
      mimeType = mimeType,
      fileName = path.substringAfterLast('/').takeIf(String::isNotBlank),
    )
  }
}

private fun parseCreatedSessionKey(
  json: Json,
  sessionJson: String,
): String? {
  val root =
    runCatching { json.parseToJsonElement(sessionJson).asObjectOrNull() }.getOrNull()
      ?: return null

  fun clean(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }
  return clean(root["key"].asStringOrNull())
    ?: clean(root["sessionKey"].asStringOrNull())
    ?: root["session"].asObjectOrNull()?.let { session ->
      clean(session["key"].asStringOrNull()) ?: clean(session["sessionKey"].asStringOrNull())
    }
}

internal fun parseChatCommands(
  json: Json,
  commandsJson: String,
): List<ChatCommandEntry> {
  val root = json.parseToJsonElement(commandsJson).asObjectOrNull() ?: return emptyList()
  val commands = root["commands"].asArrayOrNull() ?: return emptyList()
  return commands.mapNotNull { item -> parseChatCommandEntry(item.asObjectOrNull()) }
}

private fun parseChatCommandEntry(obj: JsonObject?): ChatCommandEntry? {
  if (obj == null) return null
  val aliases =
    obj["textAliases"]
      .asArrayOrNull()
      ?.mapNotNull { alias -> alias.asStringOrNull()?.trim()?.takeIf { it.startsWith("/") && it.length > 1 } }
      ?.distinct()
      .orEmpty()
  val name =
    obj["name"]
      .asStringOrNull()
      ?.trim()
      ?.removePrefix("/")
      ?.takeIf { it.isNotEmpty() }
      ?: aliases.firstOrNull()?.removePrefix("/")
      ?: return null
  return ChatCommandEntry(
    name = name,
    description = obj["description"].asStringOrNull()?.trim().orEmpty(),
    category = obj["category"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    textAliases = aliases,
    acceptsArgs = obj["acceptsArgs"].asBooleanOrNull() ?: false,
  )
}

internal data class MainSessionState(
  val currentSessionKey: String,
  val appliedMainSessionKey: String,
)

/**
 * Rewrite only the active "main" alias when the gateway publishes a new canonical main session key.
 */
internal fun applyMainSessionKey(
  currentSessionKey: String,
  appliedMainSessionKey: String,
  nextMainSessionKey: String,
): MainSessionState {
  if (currentSessionKey == appliedMainSessionKey) {
    return MainSessionState(
      currentSessionKey = nextMainSessionKey,
      appliedMainSessionKey = nextMainSessionKey,
    )
  }
  return MainSessionState(
    currentSessionKey = currentSessionKey,
    appliedMainSessionKey = nextMainSessionKey,
  )
}

/**
 * Keep Compose item identity stable across history refreshes by matching existing messages to incoming copies.
 */
internal fun reconcileMessageIds(
  previous: List<ChatMessage>,
  incoming: List<ChatMessage>,
): List<ChatMessage> {
  if (previous.isEmpty() || incoming.isEmpty()) return incoming

  val messagesByKey = LinkedHashMap<String, ArrayDeque<ChatMessage>>()
  for (message in previous) {
    val key = messageIdentityKey(message) ?: continue
    messagesByKey.getOrPut(key) { ArrayDeque() }.addLast(message)
  }

  return incoming.map { message ->
    val key = messageIdentityKey(message) ?: return@map message
    val matches = messagesByKey[key] ?: return@map message
    val previousMessage = matches.removeFirstOrNull() ?: return@map message
    if (matches.isEmpty()) {
      messagesByKey.remove(key)
    }
    message.copy(
      id = previousMessage.id,
      content = preserveOptimisticAudioDuration(previous = previousMessage, incoming = message),
      entryId = message.entryId,
    )
  }
}

private fun preserveOptimisticAudioDuration(
  previous: ChatMessage,
  incoming: ChatMessage,
): List<ChatMessageContent> {
  val idempotencyKey = incoming.idempotencyKey?.trim().orEmpty()
  if (idempotencyKey.isEmpty() || idempotencyKey != previous.idempotencyKey?.trim()) return incoming.content

  val remainingAudio =
    previous.content
      .filter { it.mimeType?.startsWith("audio/") == true && it.durationMs != null }
      .toMutableList()
  if (remainingAudio.isEmpty()) return incoming.content

  return incoming.content.map { part ->
    if (part.durationMs != null || part.mimeType?.startsWith("audio/") != true) return@map part
    if (remainingAudio.isEmpty()) return@map part
    val exactIndex =
      remainingAudio.indexOfFirst {
        it.mimeType == part.mimeType && it.fileName == part.fileName
      }
    val match = remainingAudio.removeAt(if (exactIndex >= 0) exactIndex else 0)
    part.copy(durationMs = match.durationMs)
  }
}

internal fun mergeOptimisticMessages(
  incoming: List<ChatMessage>,
  optimistic: Collection<ChatMessage>,
): List<ChatMessage> {
  if (optimistic.isEmpty()) return incoming

  val missingOptimistic = retainUnmatchedOptimisticMessages(incoming = incoming, optimistic = optimistic)
  if (missingOptimistic.isEmpty()) return incoming

  return (incoming + missingOptimistic).sortedWith(compareBy<ChatMessage> { it.timestampMs ?: Long.MAX_VALUE }.thenBy { it.id })
}

internal fun retainUnmatchedOptimisticMessages(
  incoming: List<ChatMessage>,
  optimistic: Collection<ChatMessage>,
): List<ChatMessage> {
  if (optimistic.isEmpty()) return emptyList()

  val unmatchedIncoming = incoming.toMutableList()
  return optimistic.filter { message ->
    val matchIndex =
      unmatchedIncoming.indexOfFirst { incomingMessage ->
        incomingMessageConsumesOptimistic(incomingMessage, message)
      }
    if (matchIndex >= 0) {
      unmatchedIncoming.removeAt(matchIndex)
      false
    } else {
      true
    }
  }
}

/**
 * Message identity used only for refresh reconciliation; it avoids exposing gateway ids as UI keys.
 */
internal fun messageIdentityKey(message: ChatMessage): String? {
  val idempotencyKey = message.idempotencyKey?.trim().orEmpty()
  if (idempotencyKey.isNotEmpty()) {
    return listOf(message.role.trim().lowercase(), idempotencyKey).joinToString(separator = "|")
  }
  val contentKey = messageContentIdentityKey(message) ?: return null
  val timestamp = message.timestampMs?.toString().orEmpty()
  if (timestamp.isEmpty() && contentKey.isEmpty()) return null
  return listOf(contentKey, timestamp).joinToString(separator = "|")
}

private fun optimisticMessageIdentityKey(message: ChatMessage): String? = messageContentIdentityKey(message)

private fun incomingMessageConsumesOptimistic(
  incoming: ChatMessage,
  optimistic: ChatMessage,
): Boolean {
  val optimisticIdempotencyKey = optimistic.idempotencyKey?.trim().orEmpty()
  if (optimisticIdempotencyKey.isNotEmpty()) {
    return incoming.idempotencyKey?.trim() == optimisticIdempotencyKey
  }
  if (optimisticMessageIdentityKey(incoming) != optimisticMessageIdentityKey(optimistic)) return false
  val incomingTimestamp = incoming.timestampMs ?: return false
  val optimisticTimestamp = optimistic.timestampMs ?: return true
  return incomingTimestamp >= optimisticTimestamp
}

private fun messageContentIdentityKey(message: ChatMessage): String? {
  val role = message.role.trim().lowercase()
  if (role.isEmpty()) return null

  val contentFingerprint =
    message.content.joinToString(separator = "\u001E") { part ->
      listOf(
        part.type.trim().lowercase(),
        part.text?.trim().orEmpty(),
        part.mimeType
          ?.trim()
          ?.lowercase()
          .orEmpty(),
        part.fileName?.trim().orEmpty(),
        part.artifactId?.trim().orEmpty(),
        part.url?.trim().orEmpty(),
        part.openUrl?.trim().orEmpty(),
        part.base64
          ?.hashCode()
          ?.toString()
          .orEmpty(),
      ).joinToString(separator = "\u001F")
    }

  return listOf(role, contentFingerprint).joinToString(separator = "|")
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

private fun parseSessionEditorAttachments(value: JsonElement?): List<SessionEditorAttachment> =
  value.asArrayOrNull()?.mapNotNull { element ->
    val attachment = element.asObjectOrNull() ?: return@mapNotNull null
    val mimeType =
      attachment["mimeType"]
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.startsWith("image/", ignoreCase = true) }
        ?: return@mapNotNull null
    val data =
      attachment["data"]
        .asStringOrNull()
        ?.takeIf { it.isNotEmpty() && it.length.toLong() <= SESSION_EDITOR_MAX_BASE64_CHARS }
        ?: return@mapNotNull null
    val decoded =
      try {
        Base64.getDecoder().decode(data)
      } catch (_: IllegalArgumentException) {
        return@mapNotNull null
      }
    if (decoded.isEmpty() || decoded.size.toLong() > OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES) return@mapNotNull null
    SessionEditorAttachment(mimeType = mimeType, data = data)
  } ?: emptyList()

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

private fun JsonElement?.asJsonStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf(JsonPrimitive::isString)
    ?.content

private fun JsonElement?.asJsonNumberOrNull(): Double? =
  (this as? JsonPrimitive)
    ?.takeUnless(JsonPrimitive::isString)
    ?.content
    ?.toDoubleOrNull()

private fun JsonElement?.asLongOrNull(): Long? =
  when (this) {
    is JsonPrimitive -> content.toLongOrNull()
    else -> null
  }

private fun JsonElement?.asBooleanOrNull(): Boolean? =
  when (this) {
    is JsonPrimitive -> content.toBooleanStrictOrNull()
    else -> null
  }

private fun parseChatDiffStat(
  element: JsonElement?,
  includeFiles: Boolean,
): ChatDiffStat? {
  val value = element.asObjectOrNull() ?: return null

  fun count(key: String): Int? =
    value[key]
      .asLongOrNull()
      ?.takeIf { it in 0..Int.MAX_VALUE.toLong() }
      ?.toInt()

  val files = if (includeFiles) count("files") ?: return null else null
  return ChatDiffStat(
    added = count("added") ?: return null,
    removed = count("removed") ?: return null,
    files = files,
  )
}

internal fun resolvePreferredActiveRunId(
  localRunIds: Collection<String>,
  advertisedRunIds: List<String>,
): String? =
  advertisedRunIds.firstOrNull(localRunIds::contains)
    ?: localRunIds.minOrNull()
    ?: advertisedRunIds.firstOrNull()

internal fun resolveSelectedActiveRunCount(
  localRunIds: Collection<String>,
  advertisedRunIds: Collection<String>,
  hasAdvertisedRun: Boolean,
): Int =
  maxOf(
    buildSet {
      addAll(localRunIds)
      addAll(advertisedRunIds)
    }.size,
    if (hasAdvertisedRun) 1 else 0,
  )

private fun mergeChatSessionSettings(
  existing: ChatSessionEntry,
  settings: ChatSessionEntry,
  authoritativeSessionSettings: Boolean,
): ChatSessionEntry =
  existing.copy(
    modelProvider = settings.modelProvider ?: existing.modelProvider,
    model = settings.model ?: existing.model,
    modelSelectionLocked = settings.modelSelectionLocked ?: existing.modelSelectionLocked,
    agentRuntimeId = settings.agentRuntimeId ?: existing.agentRuntimeId,
    thinkingLevel = settings.thinkingLevel ?: existing.thinkingLevel,
    thinkingLevels = settings.thinkingLevels ?: existing.thinkingLevels,
    thinkingDefault = settings.thinkingDefault ?: existing.thinkingDefault,
    permissionMode =
      if (authoritativeSessionSettings || settings.hasPermissionModeMetadata) {
        settings.permissionMode
      } else {
        existing.permissionMode
      },
    hasPermissionModeMetadata =
      if (authoritativeSessionSettings) {
        settings.hasPermissionModeMetadata
      } else {
        existing.hasPermissionModeMetadata || settings.hasPermissionModeMetadata
      },
    permissionModePending =
      if (authoritativeSessionSettings) settings.permissionModePending else settings.permissionModePending ?: existing.permissionModePending,
    fastMode =
      if (authoritativeSessionSettings || settings.hasFastModeMetadata) settings.fastMode else existing.fastMode,
    effectiveFastMode =
      if (authoritativeSessionSettings || settings.hasEffectiveFastModeMetadata) {
        settings.effectiveFastMode
      } else {
        existing.effectiveFastMode
      },
    hasFastModeMetadata =
      if (authoritativeSessionSettings) settings.hasFastModeMetadata else existing.hasFastModeMetadata || settings.hasFastModeMetadata,
    hasEffectiveFastModeMetadata =
      if (authoritativeSessionSettings) {
        settings.hasEffectiveFastModeMetadata
      } else {
        existing.hasEffectiveFastModeMetadata || settings.hasEffectiveFastModeMetadata
      },
  )

internal fun mergeChatSessionEntry(
  existing: ChatSessionEntry,
  next: ChatSessionEntry,
  preserveExistingContextUsageWithoutTotal: Boolean = false,
  replaceActiveRunIds: Boolean = false,
  authoritativeSessionSettings: Boolean = false,
  preserveSessionSettings: Boolean = false,
): ChatSessionEntry {
  val settings = if (preserveSessionSettings) existing else next
  val preserveExistingContextUsage = preserveExistingContextUsageWithoutTotal && next.totalTokens == null
  val authoritativeUsageReset =
    next.hasTotalTokensMetadata &&
      (next.totalTokens == null || next.totalTokens == 0L) &&
      !preserveExistingContextUsage
  val replaceSessionUsage = next.hasSessionUsageMetadata || authoritativeUsageReset
  val hasActiveRun = if (next.hasActiveRunMetadata) next.hasActiveRun else existing.hasActiveRun
  val activeRunIds =
    if (replaceActiveRunIds || next.hasActiveRunIdsMetadata) next.activeRunIds else existing.activeRunIds
  val observerDigest =
    reconcileSessionObserverDigest(
      existing = existing.observerDigest,
      next = next.observerDigest,
      hasNextProjection = next.hasObserverDigestMetadata,
      hasActiveRun = hasActiveRun,
      activeRunIds = activeRunIds,
      status = if (next.hasRunMetadata) next.status else existing.status,
    )
  return mergeChatSessionSettings(existing, settings, authoritativeSessionSettings).copy(
    // Partial events may omit identity; retain the last observed occurrence until
    // an authoritative event supplies the replacement session ID.
    sessionId = next.sessionId ?: existing.sessionId,
    updatedAtMs = next.updatedAtMs ?: existing.updatedAtMs,
    ownerAgentId = next.ownerAgentId ?: existing.ownerAgentId,
    classification = if (next.hasClassificationMetadata) next.classification else existing.classification,
    accountId = if (next.hasClassificationMetadata) next.accountId else existing.accountId,
    peerKind = if (next.hasClassificationMetadata) next.peerKind else existing.peerKind,
    isMain = if (next.hasClassificationMetadata) next.isMain else existing.isMain,
    isBackground = if (next.hasClassificationMetadata) next.isBackground else existing.isBackground,
    hasClassificationMetadata = existing.hasClassificationMetadata || next.hasClassificationMetadata,
    displayName = next.displayName ?: existing.displayName,
    label = next.label ?: existing.label,
    category = next.category ?: existing.category,
    // Omitted metadata preserves the tint; explicit null from another client clears it.
    color = if (next.hasColorMetadata) next.color else existing.color,
    hasColorMetadata = existing.hasColorMetadata || next.hasColorMetadata,
    pinned = next.pinned ?: existing.pinned,
    archived = next.archived ?: existing.archived,
    unread = next.unread ?: existing.unread,
    lastReadAt = next.lastReadAt ?: existing.lastReadAt,
    markedUnreadAt =
      if (next.hasMarkedUnreadMetadata) next.markedUnreadAt else existing.markedUnreadAt,
    hasMarkedUnreadMetadata =
      existing.hasMarkedUnreadMetadata || next.hasMarkedUnreadMetadata,
    agentStatus = if (next.hasAgentStatusMetadata) next.agentStatus else existing.agentStatus,
    hasAgentStatusMetadata = existing.hasAgentStatusMetadata || next.hasAgentStatusMetadata,
    observerDigest = observerDigest,
    hasObserverDigestMetadata = existing.hasObserverDigestMetadata || next.hasObserverDigestMetadata,
    lastActivityAt = next.lastActivityAt ?: existing.lastActivityAt,
    inputTokens = if (replaceSessionUsage) next.inputTokens else existing.inputTokens,
    totalTokens =
      when {
        preserveExistingContextUsage -> existing.totalTokens
        next.hasContextUsageMetadata -> next.totalTokens
        else -> null
      },
    hasTotalTokensMetadata =
      when {
        preserveExistingContextUsage -> existing.hasTotalTokensMetadata
        else -> next.hasTotalTokensMetadata
      },
    totalTokensFresh =
      when {
        preserveExistingContextUsage -> existing.totalTokensFresh
        next.hasContextUsageMetadata -> next.totalTokensFresh
        else -> null
      },
    contextTokens =
      when {
        preserveExistingContextUsage -> next.contextTokens ?: existing.contextTokens
        next.hasContextUsageMetadata -> next.contextTokens
        else -> null
      },
    estimatedCostUsd =
      if (replaceSessionUsage) next.estimatedCostUsd else existing.estimatedCostUsd,
    hasContextUsageMetadata =
      when {
        preserveExistingContextUsage -> existing.hasContextUsageMetadata || next.contextTokens != null
        else -> next.hasContextUsageMetadata
      },
    hasActiveRun = hasActiveRun,
    activeRunIds = activeRunIds,
    hasActiveRunMetadata = existing.hasActiveRunMetadata || next.hasActiveRunMetadata,
    hasActiveRunIdsMetadata =
      if (replaceActiveRunIds) {
        next.hasActiveRunIdsMetadata
      } else {
        existing.hasActiveRunIdsMetadata || next.hasActiveRunIdsMetadata
      },
    parentSessionKey = next.parentSessionKey ?: existing.parentSessionKey,
    spawnedBy = next.spawnedBy ?: existing.spawnedBy,
    hasActiveSubagentRun = next.hasActiveSubagentRun ?: existing.hasActiveSubagentRun,
    subagentRunState = next.subagentRunState ?: existing.subagentRunState,
    swarmGroupId = next.swarmGroupId ?: existing.swarmGroupId,
    swarmPhase = next.swarmPhase ?: existing.swarmPhase,
    swarmPhaseRank = next.swarmPhaseRank ?: existing.swarmPhaseRank,
    swarmLog = next.swarmLog ?: existing.swarmLog,
    status = if (next.hasRunMetadata) next.status else existing.status,
    lastRunError = if (next.hasRunMetadata) next.lastRunError else existing.lastRunError,
    startedAt = if (next.hasRunMetadata) next.startedAt else existing.startedAt,
    endedAt = if (next.hasRunMetadata) next.endedAt else existing.endedAt,
    runtimeMs = if (next.hasRunMetadata) next.runtimeMs else existing.runtimeMs,
    outputTokens =
      if (replaceSessionUsage) next.outputTokens else existing.outputTokens,
    hasSessionUsageMetadata =
      if (replaceSessionUsage) next.hasSessionUsageMetadata else existing.hasSessionUsageMetadata,
    hasRunMetadata = existing.hasRunMetadata || next.hasRunMetadata,
  )
}

internal fun applySessionObserverDigest(
  sessions: List<ChatSessionEntry>,
  digest: SessionObserverDigest,
  activeAgentId: String? = null,
): List<ChatSessionEntry> {
  val digestAgentId = normalizedObserverAgentId(digest.agentId)
  val selectedAgentId = normalizedObserverAgentId(activeAgentId)
  val scopedSessions =
    reconcileGlobalObserverDigestOwner(sessions, selectedAgentId, adoptOwnerless = false)
  if (
    digest.sessionKey == "global" &&
    (selectedAgentId == null || digestAgentId == null || selectedAgentId != digestAgentId)
  ) {
    return scopedSessions
  }
  val index = scopedSessions.indexOfFirst { it.key == digest.sessionKey }
  if (index < 0) return scopedSessions
  val session = scopedSessions[index]
  val runId = digest.runId?.trim()?.takeIf { it.isNotEmpty() } ?: return scopedSessions
  val isRunning = session.hasActiveRun == true || session.status?.trim()?.lowercase() == "running"
  val matchesActiveRun = session.activeRunIds.orEmpty().any { it.trim() == runId }
  if (!isRunning || !matchesActiveRun) return scopedSessions
  val previous = session.observerDigest
  if (previous?.runId == runId && !observerDigestIsNewer(digest, previous)) return scopedSessions
  return scopedSessions.toMutableList().also {
    it[index] = session.copy(observerDigest = digest, hasObserverDigestMetadata = true)
  }
}

internal fun reconcileGlobalObserverDigestOwner(
  sessions: List<ChatSessionEntry>,
  activeAgentId: String?,
  adoptOwnerless: Boolean = true,
): List<ChatSessionEntry> {
  // A missing owner is transient disconnect state, not a selection change.
  // Callers retain the last verified offline projection until hello supplies an owner.
  val selectedAgentId = normalizedObserverAgentId(activeAgentId) ?: return sessions
  val index = sessions.indexOfFirst { it.key == "global" }
  if (index < 0) return sessions
  val session = sessions[index]
  val digestAgentId = normalizedObserverAgentId(session.observerDigest?.agentId)
  if (digestAgentId == selectedAgentId) return sessions
  return sessions.toMutableList().also {
    it[index] =
      session.copy(
        observerDigest =
          if (digestAgentId == null && adoptOwnerless) {
            session.observerDigest?.copy(agentId = selectedAgentId)
          } else {
            null
          },
        hasObserverDigestMetadata = true,
      )
  }
}

internal fun reconcileSessionObserverProjectionOwner(
  session: ChatSessionEntry,
  ownerAgentId: String?,
): ChatSessionEntry {
  val digest = session.observerDigest
  if (session.key != "global" || digest == null) return session
  val owner =
    normalizedObserverAgentId(ownerAgentId)
      ?: return session.copy(observerDigest = null, hasObserverDigestMetadata = false)
  val digestOwner = normalizedObserverAgentId(digest.agentId)
  return when (digestOwner) {
    null -> session.copy(observerDigest = digest.copy(agentId = owner))
    owner -> session
    else -> session.copy(observerDigest = null, hasObserverDigestMetadata = false)
  }
}

private fun normalizedObserverAgentId(agentId: String?): String? = agentId?.trim()?.lowercase()?.takeIf(String::isNotEmpty)

private fun reconcileSessionObserverDigest(
  existing: SessionObserverDigest?,
  next: SessionObserverDigest?,
  hasNextProjection: Boolean,
  hasActiveRun: Boolean?,
  activeRunIds: List<String>?,
  status: String?,
): SessionObserverDigest? {
  val isRunning = hasActiveRun == true || status?.trim()?.lowercase() == "running"
  val activeIds = activeRunIds.orEmpty().mapNotNull { it.trim().takeIf(String::isNotEmpty) }.toSet()
  var resolved = existing
  if (isRunning && resolved?.runId?.trim()?.let(activeIds::contains) != true) {
    resolved = null
  }
  if (next != null) {
    val matchesActiveRun = !isRunning || next.runId?.trim()?.let(activeIds::contains) == true
    if (matchesActiveRun) {
      val previous = resolved
      resolved =
        if (previous != null && previous.runId == next.runId && !observerDigestIsNewer(next, previous)) {
          previous
        } else {
          next
        }
    }
  } else if (hasNextProjection) {
    resolved = null
  }
  return resolved
}

private fun observerDigestIsNewer(
  candidate: SessionObserverDigest,
  previous: SessionObserverDigest,
): Boolean =
  candidate.revision > previous.revision ||
    (candidate.revision == previous.revision && candidate.updatedAt > previous.updatedAt)

private fun ChatSessionEntry.carriesSessionSettings(): Boolean =
  modelProvider != null ||
    model != null ||
    modelSelectionLocked != null ||
    agentRuntimeId != null ||
    thinkingLevel != null ||
    thinkingLevels != null ||
    thinkingDefault != null ||
    hasPermissionModeMetadata ||
    permissionModePending != null ||
    hasFastModeMetadata ||
    hasEffectiveFastModeMetadata

private fun sameSessionSettings(
  previous: ChatSessionEntry?,
  next: ChatSessionEntry,
): Boolean =
  previous != null &&
    previous.modelProvider == next.modelProvider &&
    previous.model == next.model &&
    (previous.modelSelectionLocked == true) == (next.modelSelectionLocked == true) &&
    previous.agentRuntimeId == next.agentRuntimeId &&
    previous.thinkingLevel == next.thinkingLevel &&
    previous.thinkingLevels == next.thinkingLevels &&
    previous.thinkingDefault == next.thinkingDefault &&
    previous.permissionMode == next.permissionMode &&
    (previous.permissionModePending == true) == (next.permissionModePending == true) &&
    previous.fastMode == next.fastMode &&
    previous.effectiveFastMode == next.effectiveFastMode

private fun ChatSessionEntry.providerQualifiedModelRef(): String? {
  val model = model?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val provider = modelProvider?.trim()?.takeIf { it.isNotEmpty() } ?: return model
  return if (model.startsWith("$provider/")) model else "$provider/$model"
}
