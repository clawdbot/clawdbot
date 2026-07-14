package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveOptionalNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.parseGatewayModels
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.ui.chat.thinkingSupportedForSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

// Bounds one-shot search list fetches like the primary session list.
internal const val SESSION_LIST_FETCH_LIMIT = 200

// Capture before suspend points; both fields must still match before gateway data reaches UI state.
internal data class ChatCacheScope(
  val gatewayId: String,
  val connectionGeneration: Long,
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

private class MainSessionReadiness(
  val gatewayScope: ChatCacheScope,
  val binding: MainSessionBinding,
  val ready: CompletableDeferred<Unit>,
) {
  var job: Job? = null
}

class ChatController internal constructor(
  private val scope: CoroutineScope,
  private val json: Json,
  private val requestGateway: suspend (method: String, paramsJson: String?) -> String,
  private val requestGatewayForGateway: suspend (gatewayId: String, method: String, paramsJson: String?) -> String =
    { _, method, paramsJson -> requestGateway(method, paramsJson) },
  private val captureSettingsRequestLease: (gatewayScope: ChatCacheScope?) -> GatewaySession.RequestLease? =
    { gatewayScope ->
      GatewaySession.RequestLease(endpointStableId = gatewayScope?.gatewayId.orEmpty()) { method, paramsJson, _ ->
        if (gatewayScope == null) {
          requestGateway(method, paramsJson)
        } else {
          requestGatewayForGateway(gatewayScope.gatewayId, method, paramsJson)
        }
      }
    },
  private val transcriptCache: ChatTranscriptCache? = null,
  private val cacheScope: () -> ChatCacheScope? = { null },
  private val commandOutbox: ChatCommandOutbox? = null,
  private val recordModelRecent: (String) -> Unit = {},
) {
  internal constructor(
    scope: CoroutineScope,
    session: GatewaySession,
    json: Json,
    transcriptCache: ChatTranscriptCache? = null,
    cacheScope: () -> ChatCacheScope? = { null },
    commandOutbox: ChatCommandOutbox? = null,
    recordModelRecent: (String) -> Unit = {},
  ) : this(
    scope = scope,
    json = json,
    requestGateway = { method, paramsJson -> session.request(method, paramsJson) },
    requestGatewayForGateway = { gatewayId, method, paramsJson ->
      session.requestForEndpoint(gatewayId, method, paramsJson)
    },
    captureSettingsRequestLease = { gatewayScope ->
      session.captureRequestLease(gatewayScope?.gatewayId)
    },
    transcriptCache = transcriptCache,
    cacheScope = cacheScope,
    commandOutbox = commandOutbox,
    recordModelRecent = recordModelRecent,
  )

  private var appliedMainSessionKey = "main"
  private val cacheMutationMutex = Mutex()

  private data class SessionSettingsKey(
    val gatewayScope: ChatCacheScope?,
    val sessionKey: String,
  )

  private data class QueuedSessionSettingsMutation(
    val settingsKey: SessionSettingsKey,
    val requestLease: GatewaySession.RequestLease?,
    val pending: CompletableDeferred<Boolean>,
    val previous: CompletableDeferred<Boolean>?,
  )

  private val pendingSettingsMutations = ConcurrentHashMap<SessionSettingsKey, CompletableDeferred<Boolean>>()
  private val settingsMutationRevisions = mutableMapOf<ChatCacheScope?, Long>()
  private val activeSessionRefreshesByScope = mutableMapOf<ChatCacheScope?, Int>()

  private data class ThinkingIntent(
    val requestId: Long,
    val level: String,
  )

  private data class AcceptedThinkingState(
    val level: String,
    val thinkingLevels: List<ChatThinkingLevelOption>?,
  )

  private val thinkingRequestSequence = AtomicLong(0)
  private val latestThinkingIntents = ConcurrentHashMap<SessionSettingsKey, ThinkingIntent>()
  private val latestAcceptedThinkingStates = ConcurrentHashMap<SessionSettingsKey, AcceptedThinkingState>()
  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  private val _sessionId = MutableStateFlow<String?>(null)
  val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

  private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

  // True while the transcript shown came from the offline cache and no live history replaced it yet.
  private val _messagesFromCache = MutableStateFlow(false)
  val messagesFromCache: StateFlow<Boolean> = _messagesFromCache.asStateFlow()

  private data class LiveHistoryMarker(
    val sessionKey: String,
    val sessionId: String?,
    val generation: Long,
  )

  @Volatile
  private var liveHistoryMarker: LiveHistoryMarker? = null

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

  private val _streamingAssistantText = MutableStateFlow<String?>(null)
  val streamingAssistantText: StateFlow<String?> = _streamingAssistantText.asStateFlow()

  private val pendingToolCallsById = ConcurrentHashMap<String, ChatPendingToolCall>()
  private val _pendingToolCalls = MutableStateFlow<List<ChatPendingToolCall>>(emptyList())
  val pendingToolCalls: StateFlow<List<ChatPendingToolCall>> = _pendingToolCalls.asStateFlow()

  private val _sessions = MutableStateFlow<List<ChatSessionEntry>>(emptyList())
  val sessions: StateFlow<List<ChatSessionEntry>> = _sessions.asStateFlow()

  private val _commands = MutableStateFlow<List<ChatCommandEntry>>(emptyList())
  val commands: StateFlow<List<ChatCommandEntry>> = _commands.asStateFlow()

  private val pendingRuns = mutableSetOf<String>()
  private val disconnectedPendingRunIds = mutableSetOf<String>()
  private val timedOutRunIds = ConcurrentHashMap.newKeySet<String>()
  private val terminalWithoutReplyRunIds = ConcurrentHashMap.newKeySet<String>()
  private val unknownOutcomeRunIds = ConcurrentHashMap.newKeySet<String>()
  private val pendingRunTimeoutJobs = ConcurrentHashMap<String, Job>()

  // Preserve sent messages locally until chat.history includes the gateway-confirmed copy.
  private val optimisticMessagesByRunId = ConcurrentHashMap<String, ChatMessage>()

  // Keep reply ownership after the user row persists; the assistant row can land later.
  private val unresolvedRepliesByRunId = ConcurrentHashMap<String, ChatMessage>()
  private val pendingRunTimeoutMs = 120_000L
  private val recoveryHistoryRetryDelayMs = 750L
  private var recoveryHistoryReconciliationGeneration = -1L
  private var recoveryHistoryReconciliationJob: Job? = null

  // Drops stale history responses after session switches or refresh races.
  private val historyLoadGeneration = AtomicLong(0)
  private val historyRequestSequence = AtomicLong(0)
  private val modelSelectionGeneration = AtomicLong(0)
  private val sessionsRequestSequence = AtomicLong(0)

  // Every live history path awaits this gateway/session readiness. Per-gateway locking keeps
  // rapid agent switches from letting an older lookup refresh before the new session is ready.
  private val mainSessionAdoptionLocks = ConcurrentHashMap<String, Mutex>()
  private val desiredMainSessions = ConcurrentHashMap<String, MainSessionBinding>()
  private val mainSessionReadinessLock = Any()
  private var mainSessionReadiness: MainSessionReadiness? = null
  private val gatewayScopeApplyLock = Any()
  private var latestAppliedHistoryRequest = 0L
  private var latestAppliedInFlightRunId: String? = null
  private var lastHandledTerminalRunId: String? = null
  private var historyLoadErrorGeneration: Long? = null
  private val newChatCreateInFlight = AtomicBoolean(false)

  private var lastHealthPollAtMs: Long? = null
  private var chatMetadataAgentId: String? = null
  private var chatMetadataLoadState = ChatMetadataLoadState.Unloaded
  private var sessionsListArchived = false

  // One acknowledgement per unread episode: the pending flag clears when the
  // server-confirmed read (unread=false) arrives, so fresh activity on the open
  // session re-acknowledges without patch loops (lastReadAt is stamped server-side).
  private var unreadPatchSessionKey: String? = null
  private var unreadPatchRequested = false

  // Armed on disconnect so the next health event refetches history and re-adopts
  // any run the gateway still reports in flight (chat.history `inFlightRun`).
  private var restoreRunStateOnReconnect = false
  private var reconnectRecoveryGeneration: Long? = null

  private fun updateErrorText(
    message: String?,
    historyGeneration: Long? = null,
  ) {
    _errorText.value = message?.let(::verbatimText)
    historyLoadErrorGeneration = historyGeneration
  }

  private fun updateLocalizedErrorText(
    message: NativeText?,
    historyGeneration: Long? = null,
  ) {
    _errorText.value = message
    historyLoadErrorGeneration = historyGeneration
  }

  private val _outboxItems = MutableStateFlow<List<ChatOutboxItem>>(emptyList())
  val outboxItems: StateFlow<List<ChatOutboxItem>> = _outboxItems.asStateFlow()

  // Flush requests are level-triggered: the owner clears one per pass and rechecks after release.
  private val outboxFlushInFlight = AtomicBoolean(false)
  private val outboxFlushRequested = AtomicBoolean(false)
  private val outboxRecoveryMutex = Mutex()
  private var outboxRecoveryComplete = false

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
    retireMainSessionReadiness()
    historyLoadGeneration.incrementAndGet()
    restoreRunStateOnReconnect = true
    reconnectRecoveryGeneration = null
    _healthOk.value = false
    updateErrorText(null)
    _commands.value = emptyList()
    _modelCatalog.value = emptyList()
    chatMetadataAgentId = null
    chatMetadataLoadState = ChatMetadataLoadState.Unloaded
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
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
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
              val describeParams = buildJsonObject { put("key", JsonPrimitive(mainSession.key)) }
              val describeResponse =
                requestGatewayBound(requestScope.gatewayId, "sessions.describe", describeParams.toString())
              val describeRoot = json.parseToJsonElement(describeResponse).asObjectOrNull() ?: error("invalid sessions.describe response")
              if (!describeRoot.containsKey("session")) error("sessions.describe returned no session field")
              if (desiredMainSessions[requestScope.gatewayId] != mainSession) return@withLock
              val existingSession = describeRoot["session"].asObjectOrNull()
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
    if (!restoreRunStateOnReconnect) {
      refresh()
      return
    }
    updateErrorText(null)
    refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
  }

  /** Invalidates and clears gateway-bound UI state before a target switch can race old responses. */
  fun onGatewayScopeChanging(retireRunState: Boolean = false) {
    retireMainSessionReadiness()
    synchronized(gatewayScopeApplyLock) {
      if (retireRunState) {
        restoreRunStateOnReconnect = false
        clearPendingRuns()
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
      }
      appliedMainSessionKey = "main"
      beginHistoryLoad(
        key = "main",
        clearMessages = true,
        markLoading = false,
      )
      clearLiveHistoryMarker()
      _sessions.value = emptyList()
      applyThinkingMetadata(null)
      sessionsListArchived = false
      unreadPatchSessionKey = null
      unreadPatchRequested = false
      _commands.value = emptyList()
      _modelCatalog.value = emptyList()
      chatMetadataAgentId = null
      chatMetadataLoadState = ChatMetadataLoadState.Unloaded
      lastHealthPollAtMs = null
      // Outbox rows are gateway-scoped too; the next publish repopulates them for the new scope.
      _outboxItems.value = emptyList()
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
    cacheMutationMutex.withLock {
      transcriptCache?.clearGateway(gatewayId)
      commandOutbox?.clearGateway(gatewayId)
    }
  }

  /** Loads a chat session, normalizing "main" to the current gateway-provided main session key. */
  fun load(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key == _sessionKey.value) {
      if (hasCurrentLiveHistory(key)) return
      refresh()
      return
    }
    val generation = beginHistoryLoad(key, clearMessages = true)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = true)
    }
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
    if (_sessionKey.value != key) beginHistoryLoad(key, clearMessages = true)
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
    val generation = beginHistoryLoad(nextState.currentSessionKey, clearMessages = true)
    if (!loadHistory) return
    scope.launch {
      bootstrap(
        sessionKey = nextState.currentSessionKey,
        generation = generation,
        forceHealth = true,
        refreshSessions = true,
      )
    }
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
    label: String? = null,
    clearLabel: Boolean = false,
    category: String? = null,
    clearCategory: Boolean = false,
    pinned: Boolean? = null,
    archived: Boolean? = null,
    unread: Boolean? = null,
  ): Boolean {
    val sessionKey = key.trim().takeIf { it.isNotEmpty() } ?: return false
    val hasPatch = clearLabel || label != null || clearCategory || category != null || pinned != null || archived != null || unread != null
    if (!hasPatch) return false
    try {
      val params =
        buildJsonObject {
          put("key", JsonPrimitive(sessionKey))
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
          if (pinned != null) put("pinned", JsonPrimitive(pinned))
          if (archived != null) put("archived", JsonPrimitive(archived))
          if (unread != null) put("unread", JsonPrimitive(unread))
        }
      requestGateway("sessions.patch", params.toString())
      if (archived == true) {
        fallBackFromRetiredActiveSession(sessionKey)
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
      var firstError: Throwable? = null
      for (member in listSessionGroupMembers(group)) {
        try {
          val params =
            buildJsonObject {
              put("key", JsonPrimitive(member.key))
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
  private suspend fun listSessionGroupMembers(group: String): List<ChatSessionEntry> {
    val members = LinkedHashMap<String, ChatSessionEntry>()
    for (archived in listOf(false, true)) {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
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

  suspend fun deleteSession(key: String) {
    val sessionKey = key.trim().takeIf { it.isNotEmpty() } ?: return
    try {
      val params =
        buildJsonObject {
          put("key", JsonPrimitive(sessionKey))
          put("deleteTranscript", JsonPrimitive(true))
          // archive-then-delete: the bounded operator session lacks admin, and
          // the gateway grants write-scope deletes only for archived sessions.
          put("archivedOnly", JsonPrimitive(true))
        }
      requestGateway("sessions.delete", params.toString())
      fallBackFromRetiredActiveSession(sessionKey)
      fetchSessionsForCurrentWindow()
    } catch (err: Throwable) {
      updateErrorText(err.message)
    }
  }

  // Archiving or deleting the open chat must not leave the app focused on a
  // retired session; fall back to the gateway main session like web and iOS do.
  private fun fallBackFromRetiredActiveSession(retiredKey: String) {
    if (retiredKey != _sessionKey.value) return
    switchSession("main")
  }

  suspend fun forkSession(parentKey: String): String? {
    val sessionKey = parentKey.trim().takeIf { it.isNotEmpty() } ?: return null
    return try {
      val params =
        buildJsonObject {
          put("parentSessionKey", JsonPrimitive(sessionKey))
          put("fork", JsonPrimitive(true))
          // Keep the fork under the parent's agent; omitting agentId would create the
          // child under the gateway's default agent for agent-qualified parents.
          resolveAgentIdFromMainSessionKey(sessionKey)?.let { put("agentId", JsonPrimitive(it)) }
        }
      val createdKey = parseCreatedSessionKey(json, requestGateway("sessions.create", params.toString()))
      fetchSessions(limit = currentSessionWindowLimit(), archived = false)
      createdKey
    } catch (err: Throwable) {
      updateErrorText(err.message)
      null
    }
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
    return try {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          put("limit", JsonPrimitive(SESSION_LIST_FETCH_LIMIT))
          if (query != null) put("search", JsonPrimitive(query))
          if (archived) put("archived", JsonPrimitive(true))
        }
      parseSessions(requestGateway("sessions.list", params.toString())).sessions
    } catch (err: CancellationException) {
      // A superseded search owns the results now; never repaint stale fallback rows.
      throw err
    } catch (_: Throwable) {
      when {
        archived -> emptyList()
        query == null -> _sessions.value
        else -> filterSessionEntries(_sessions.value, query)
      }
    }
  }

  /** Starts a fresh chat for the active gateway session key. */
  fun startNewChat(worktree: Boolean = false) {
    scope.launch { startNewChatAwait(worktree = worktree) }
  }

  /** Starts a fresh chat and returns whether the gateway created the session. */
  suspend fun startNewChatAwait(worktree: Boolean = false): Boolean {
    val createGatewayId = currentCacheScope()?.gatewayId
    val parentKey = normalizeRequestedSessionKey(_sessionKey.value)
    if (parentKey.isEmpty()) return false
    if (_pendingRunCount.value > 0) {
      updateLocalizedErrorText(nativeText("Wait for the current response to finish before starting a new chat."))
      return false
    }
    if (!newChatCreateInFlight.compareAndSet(false, true)) {
      return false
    }
    val requestGeneration = historyLoadGeneration.get()
    updateErrorText(null)
    _historyLoading.value = true
    return try {
      val label = nextNewChatSessionLabel(_sessions.value)
      val hasLoadedParentSession = !_sessionId.value.isNullOrBlank()
      val params =
        buildJsonObject {
          put("agentId", JsonPrimitive(resolveAgentIdForSessionKey(parentKey)))
          if (hasLoadedParentSession) {
            put("parentSessionKey", JsonPrimitive(parentKey))
            put("emitCommandHooks", JsonPrimitive(true))
          }
          put("label", JsonPrimitive(label))
          if (worktree) put("worktree", JsonPrimitive(true))
        }
      val res = requestGatewayBound(createGatewayId, "sessions.create", params.toString())
      if (!isCurrentHistoryLoad(parentKey, _sessionKey.value, requestGeneration, historyLoadGeneration.get())) {
        return false
      }
      val createdKey = parseCreatedSessionKey(json, res) ?: parentKey
      val generation = beginHistoryLoad(createdKey, clearMessages = true)
      bootstrap(sessionKey = createdKey, generation = generation, forceHealth = true, refreshSessions = true)
      true
    } catch (err: Throwable) {
      updateErrorText(err.message)
      _historyLoading.value = false
      false
    } finally {
      newChatCreateInFlight.set(false)
    }
  }

  /** Refreshes the available text slash commands for the current gateway. */
  fun refreshCommands() {
    scope.launch { fetchChatMetadata() }
  }

  /** Persists the normalized thinking level used for subsequent chat sends. */
  fun setThinkingLevel(thinkingLevel: String) {
    val normalized = normalizeThinking(thinkingLevel)
    val selection = _thinkingLevelSelection.value
    if (selection.isGatewayProvided && selection.options.none { it.id == normalized }) {
      return
    }
    if (normalized == _thinkingLevel.value) return
    val key = normalizeRequestedSessionKey(_sessionKey.value)
    val rollbackEntry = _sessions.value.firstOrNull { it.key == key }
    val rollbackLevel =
      rollbackEntry
        ?.thinkingLevel
        ?.let(::normalizeThinking)
        ?: _thinkingLevel.value
    val settingsKey = sessionSettingsKey(key)
    val queuedMutation = enqueueSessionSettingsMutation(settingsKey)
    latestAcceptedThinkingStates.putIfAbsent(
      settingsKey,
      AcceptedThinkingState(
        level = rollbackLevel,
        thinkingLevels =
          rollbackEntry?.thinkingLevels
            ?: selection.options.takeIf { selection.isGatewayProvided },
      ),
    )
    val intent = ThinkingIntent(requestId = thinkingRequestSequence.incrementAndGet(), level = normalized)
    latestThinkingIntents[settingsKey] = intent
    _thinkingLevel.value = normalized
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      setSessionThinkingLevelAwait(
        sessionKey = key,
        thinkingLevel = normalized,
        fallbackRollbackLevel = rollbackLevel,
        settingsKey = settingsKey,
        intent = intent,
        queuedMutation = queuedMutation,
      )
    }
  }

  /** Patches the active session model without blocking the Compose caller. */
  fun setSessionModel(
    sessionKey: String,
    modelRef: String?,
  ) {
    // Enter the model-selection queue before returning so an immediate send cannot overtake it.
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      setSessionModelAwait(sessionKey = sessionKey, modelRef = modelRef)
    }
  }

  /** Patches a session model and updates picker state only after gateway acceptance. */
  internal suspend fun setSessionModelAwait(
    sessionKey: String,
    modelRef: String?,
  ): Boolean {
    val key = normalizeRequestedSessionKey(sessionKey)
    val settingsKey = sessionSettingsKey(key)
    val normalizedModelRef = modelRef?.trim()?.takeIf { it.isNotEmpty() }
    return runSessionSettingsMutation(settingsKey) { requestLease ->
      if (settingsKey == sessionSettingsKey(key)) updateErrorText(null)
      try {
        val lease = requestLease ?: throw GatewayRequestNotEnqueued("not connected")
        val params =
          buildJsonObject {
            put("key", JsonPrimitive(key))
            put("model", normalizedModelRef?.let(::JsonPrimitive) ?: JsonNull)
          }
        val response = lease.request("sessions.patch", params.toString())
        val resolution = parseSessionSettingsPatchResolution(response)
        normalizedModelRef?.let(recordModelRecent)
        applyAcceptedModelPatch(
          key = key,
          settingsKey = settingsKey,
          modelRef = normalizedModelRef,
          resolution = resolution,
        )
        if (_sessionKey.value == key && settingsKey == sessionSettingsKey(key)) {
          modelSelectionGeneration.incrementAndGet()
          _selectedModelRef.value = normalizedModelRef
        }
        true
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        if (settingsKey == sessionSettingsKey(key)) {
          updateLocalizedErrorText(err.message?.let(::verbatimText) ?: nativeText("Could not update model."))
        }
        false
      }
    }
  }

  private suspend fun setSessionThinkingLevelAwait(
    sessionKey: String,
    thinkingLevel: String,
    fallbackRollbackLevel: String,
    settingsKey: SessionSettingsKey,
    intent: ThinkingIntent,
    queuedMutation: QueuedSessionSettingsMutation,
  ): Boolean =
    runSessionSettingsMutation(queuedMutation) { requestLease ->
      val rollbackEntry = _sessions.value.firstOrNull { it.key == sessionKey }
      val rollbackState =
        latestAcceptedThinkingStates[settingsKey]
          ?: AcceptedThinkingState(
            level = rollbackEntry?.thinkingLevel?.let(::normalizeThinking) ?: fallbackRollbackLevel,
            thinkingLevels =
              rollbackEntry?.thinkingLevels
                ?: _thinkingLevelSelection.value.options.takeIf {
                  _thinkingLevelSelection.value.isGatewayProvided
                },
          )
      if (settingsKey == sessionSettingsKey(sessionKey)) updateErrorText(null)
      try {
        val lease = requestLease ?: throw GatewayRequestNotEnqueued("not connected")
        val params =
          buildJsonObject {
            put("key", JsonPrimitive(sessionKey))
            put("thinkingLevel", JsonPrimitive(thinkingLevel))
          }
        val response = lease.request("sessions.patch", params.toString())
        val resolution = parseSessionSettingsPatchResolution(response)
        applyAcceptedThinkingPatch(sessionKey, settingsKey, thinkingLevel, intent, resolution)
        true
      } catch (err: CancellationException) {
        latestThinkingIntents.remove(settingsKey, intent)
        throw err
      } catch (err: Throwable) {
        if (
          _sessionKey.value == sessionKey &&
          settingsKey == sessionSettingsKey(sessionKey) &&
          latestThinkingIntents[settingsKey]?.requestId == intent.requestId
        ) {
          val current = _sessions.value
          val index = current.indexOfFirst { it.key == sessionKey }
          val applied =
            (current.getOrNull(index) ?: ChatSessionEntry(key = sessionKey, updatedAtMs = null)).copy(
              thinkingLevel = rollbackState.level,
              thinkingLevels = rollbackState.thinkingLevels,
            )
          if (index >= 0) {
            _sessions.value = current.toMutableList().also { it[index] = applied }
          }
          _thinkingLevel.value = rollbackState.level
          applyThinkingMetadata(applied)
        }
        latestThinkingIntents.remove(settingsKey, intent)
        if (settingsKey == sessionSettingsKey(sessionKey)) {
          updateLocalizedErrorText(
            err.message?.let(::verbatimText) ?: nativeText("Could not update thinking level."),
          )
        }
        false
      }
    }

  private suspend fun runSessionSettingsMutation(
    settingsKey: SessionSettingsKey,
    operation: suspend (GatewaySession.RequestLease?) -> Boolean,
  ): Boolean = runSessionSettingsMutation(enqueueSessionSettingsMutation(settingsKey), operation)

  private fun enqueueSessionSettingsMutation(settingsKey: SessionSettingsKey): QueuedSessionSettingsMutation {
    // Capture the physical socket before waiting. A reconnect may retire this
    // lease, but queued work can never resolve the replacement connection.
    val requestLease = captureSettingsRequestLease(settingsKey.gatewayScope)
    val pending = CompletableDeferred<Boolean>()
    return synchronized(gatewayScopeApplyLock) {
      val previous = pendingSettingsMutations.put(settingsKey, pending)
      incrementSettingsMutationRevision(settingsKey.gatewayScope)
      QueuedSessionSettingsMutation(
        settingsKey = settingsKey,
        requestLease = requestLease,
        pending = pending,
        previous = previous,
      )
    }
  }

  private suspend fun runSessionSettingsMutation(
    queuedMutation: QueuedSessionSettingsMutation,
    operation: suspend (GatewaySession.RequestLease?) -> Boolean,
  ): Boolean {
    val settingsKey = queuedMutation.settingsKey
    val pending = queuedMutation.pending
    var succeeded = false
    var drainedLane = false
    return try {
      queuedMutation.previous?.await()
      // A queued mutation captured a concrete gateway generation. Never let it
      // fall through to the replacement connection after waiting its turn.
      succeeded =
        if (settingsKey == sessionSettingsKey(settingsKey.sessionKey)) {
          operation(queuedMutation.requestLease)
        } else {
          false
        }
      succeeded
    } finally {
      synchronized(gatewayScopeApplyLock) {
        incrementSettingsMutationRevision(settingsKey.gatewayScope)
        drainedLane = pendingSettingsMutations.remove(settingsKey, pending)
        if (drainedLane) {
          // These baselines bridge adjacent operations in one lane only. After
          // drain, refreshed session metadata is authoritative rollback state.
          latestAcceptedThinkingStates.remove(settingsKey)
          latestThinkingIntents.remove(settingsKey)
        }
        pruneSettingsMutationRevision(settingsKey.gatewayScope)
      }
      // Publish only after registry cleanup so a resumed scope waiter cannot
      // repeatedly observe this completed mutation before finally removes it.
      pending.complete(succeeded)
      if (drainedLane && succeeded && _healthOk.value) {
        // A failed predecessor can stop a reconnect flush while its successor is queued.
        // The successful lane tail must hand durable rows back to the flush owner.
        requestOutboxFlush()
      }
    }
  }

  private fun incrementSettingsMutationRevision(gatewayScope: ChatCacheScope?) {
    settingsMutationRevisions[gatewayScope] = (settingsMutationRevisions[gatewayScope] ?: 0L) + 1L
  }

  private fun settingsMutationRevision(gatewayScope: ChatCacheScope?): Long = settingsMutationRevisions[gatewayScope] ?: 0L

  private fun hasPendingSessionSettings(gatewayScope: ChatCacheScope?): Boolean = pendingSettingsMutations.keys.any { it.gatewayScope == gatewayScope }

  private fun pruneSettingsMutationRevision(gatewayScope: ChatCacheScope?) {
    // A drained revision only matters while an in-flight list request can
    // compare it. Retired connection generations must not accumulate forever.
    if (
      !hasPendingSessionSettings(gatewayScope) &&
      activeSessionRefreshesByScope[gatewayScope] == null
    ) {
      settingsMutationRevisions.remove(gatewayScope)
    }
  }

  private suspend fun waitForPendingSessionSettings(sessionKey: String): Boolean {
    val settingsKey = sessionSettingsKey(sessionKey)
    var pending = pendingSettingsMutations[settingsKey] ?: return true
    while (true) {
      if (!pending.await()) return false
      val next = pendingSettingsMutations[settingsKey]
      if (next == null || next === pending) return true
      pending = next
    }
  }

  private suspend fun waitForPendingSessionSettings(gatewayScope: ChatCacheScope?) {
    while (true) {
      val pending =
        synchronized(gatewayScopeApplyLock) {
          pendingSettingsMutations
            .filterKeys { it.gatewayScope == gatewayScope }
            .values
            .toList()
        }
      if (pending.isEmpty()) return
      pending.forEach { it.await() }
    }
  }

  /** Switches to another gateway chat session and starts a fresh history load. */
  fun switchSession(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key.isEmpty()) return
    prepareSessionSelection(key)
    if (key == _sessionKey.value) return
    val generation = beginHistoryLoad(key, clearMessages = true)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = false)
    }
  }

  private fun prepareSessionSelection(key: String) {
    if (key != unreadPatchSessionKey) {
      unreadPatchSessionKey = key
      unreadPatchRequested = false
    }
    acknowledgeUnreadIfNeeded(key, _sessions.value.firstOrNull { it.key == key })
  }

  private fun beginHistoryLoad(
    key: String,
    clearMessages: Boolean,
    markLoading: Boolean = true,
  ): Long {
    val generation = historyLoadGeneration.incrementAndGet()
    _sessionKey.value = key
    applyThinkingMetadata(_sessions.value.firstOrNull { it.key == key })
    _selectedModelRef.value = null
    lastHandledTerminalRunId = null
    val nextAgentId = resolveAgentIdForSessionKey(key)
    if (chatMetadataAgentId != nextAgentId) {
      _commands.value = emptyList()
      _modelCatalog.value = emptyList()
      chatMetadataAgentId = null
      chatMetadataLoadState = ChatMetadataLoadState.Unloaded
    }
    updateErrorText(null)
    _healthOk.value = false
    clearLiveHistoryMarker()
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
    _historyLoading.value = markLoading
    if (clearMessages) {
      _messages.value = emptyList()
      _messagesFromCache.value = false
    }
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
      _errorText.value == null &&
      _healthOk.value
  }

  private fun normalizeRequestedSessionKey(sessionKey: String): String {
    val key = sessionKey.trim()
    if (key.isEmpty()) return appliedMainSessionKey
    if (key == "main" && appliedMainSessionKey != "main") return appliedMainSessionKey
    return key
  }

  private fun resolveAgentIdForSessionKey(parentKey: String): String = resolveAgentIdFromMainSessionKey(parentKey) ?: "main"

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
  ): Boolean {
    val sendCacheScope = currentCacheScope()
    val sendGatewayId = sendCacheScope?.gatewayId
    val trimmed = message.trim()
    if (trimmed.isEmpty() && attachments.isEmpty()) return false
    val sessionKey = _sessionKey.value
    // Session settings and sends share one ordering boundary; the first post-selection turn
    // must not leave with stale model or thinking state while sessions.patch is in flight.
    if (!waitForPendingSessionSettings(sessionKey)) return false
    if (_sessionKey.value != sessionKey) return false
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
        else ->
          enqueueDurableSend(
            outbox = outbox,
            outboxScope = sendCacheScope,
            sessionKey = normalizeRequestedSessionKey(sessionKey),
            text = text,
            thinkingLevel = thinking,
            attachments = attachments,
          ) ?: return false
      }
    if (journaled != null) {
      if (!_healthOk.value) {
        // Captured for reconnect: the queued bubble is visible and flush delivers it later.
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
          outbox.claimForSending(journaled.id, 0, null)
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

    // Optimistic user message keeps the composer responsive while chat.send and history refresh complete.
    val optimisticMessage = optimisticUserMessage(runId = runId, text = text, attachments = attachments)
    optimisticMessagesByRunId[runId] = optimisticMessage
    unresolvedRepliesByRunId[runId] = optimisticMessage
    _messages.value = _messages.value + optimisticMessage

    armPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }

    updateErrorText(null)
    _streamingAssistantText.value = null
    pendingToolCallsById.clear()
    publishPendingToolCalls()

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
          if (sendCacheScope != currentCacheScope()) return@async true
          val actualRunId = ack.runId ?: runId
          if (actualRunId != runId) {
            transferRunOwnership(runId, actualRunId, optimisticMessage)
          }
          if (ack.isTerminal) {
            clearPendingRun(actualRunId)
            removeOptimisticMessage(actualRunId)
            pendingToolCallsById.clear()
            publishPendingToolCalls()
            _streamingAssistantText.value = null
            if (ack.isTerminalSuccess) {
              unresolvedRepliesByRunId.remove(actualRunId)
              refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(actualRunId))
              true
            } else {
              // Terminal timeout/error means the gateway did not accept a runnable turn.
              // Surface failed acceptance instead of letting a cleared composer look successful.
              unresolvedRepliesByRunId.remove(actualRunId)
              updateLocalizedErrorText(nativeText("Chat failed before the run started; try again."))
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
            if (sendCacheScope != currentCacheScope()) return@async true
            clearPendingRun(runId)
            removeOptimisticMessage(runId)
            unresolvedRepliesByRunId.remove(runId)
            // The transport is effectively down; drop health so the next health event re-flushes.
            _healthOk.value = false
            publishOutbox()
            true
          } else {
            if (sendCacheScope != currentCacheScope()) return@async true
            clearPendingRun(runId)
            removeOptimisticMessage(runId)
            unresolvedRepliesByRunId.remove(runId)
            updateErrorText(err.message)
            false
          }
        } catch (err: GatewayRequestDefinitiveFailure) {
          // An ok:false response proves transmission, not that this idempotency key was never run;
          // park the journaled copy for review instead of deleting a possibly delivered send.
          markJournaledSendUnconfirmed(journaled)
          if (sendCacheScope != currentCacheScope()) return@async true
          clearPendingRun(runId)
          removeOptimisticMessage(runId)
          unresolvedRepliesByRunId.remove(runId)
          updateErrorText(err.message)
          // The parked row owns the input; only the journal-less path refuses the send.
          journaled != null
        } catch (_: GatewayRequestOutcomeUnknown) {
          // A transport failure cannot distinguish rejection from an accepted send whose ACK was
          // lost. Keep the journaled row until history confirms or reconciliation parks it.
          markJournaledSendAccepted(journaled)
          if (sendCacheScope != currentCacheScope()) return@async true
          unknownOutcomeRunIds.add(runId)
          if (_healthOk.value) {
            refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(runId))
          }
          true
        } catch (err: Throwable) {
          // Unexpected failure after dispatch is ambiguous; fail closed and keep the row visible.
          markJournaledSendUnconfirmed(journaled)
          if (sendCacheScope != currentCacheScope()) return@async true
          clearPendingRun(runId)
          removeOptimisticMessage(runId)
          unresolvedRepliesByRunId.remove(runId)
          updateErrorText(err.message)
          // With a journaled row parked for review, the composer must not restore a duplicate
          // draft: the row owns the input now. Only the journal-less path refuses the send.
          journaled != null
        }
      }
    return dispatch.await()
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
    text: String,
    thinking: String,
    idempotencyKey: String,
    attachments: List<OutgoingAttachment>,
  ): String =
    buildJsonObject {
      put("sessionKey", JsonPrimitive(sessionKey))
      put("message", JsonPrimitive(text))
      put("thinking", JsonPrimitive(thinking))
      put("timeoutMs", JsonPrimitive(30_000))
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
        sameOutboxSession(other.sessionKey, row.sessionKey) &&
        outboxRowUnresolved(other)
    }
  }

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
      unknownOutcomeRunIds.contains(runId) ||
      unresolvedRepliesByRunId.containsKey(runId)

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
        outbox.updateStatus(row.id, status, row.retryCount, lastError)
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
          refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
        } else {
          scope.launch { pollHealthIfNeeded(force = false) }
        }
      }
      "health" -> {
        if (restoreRunStateOnReconnect) {
          refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
        } else {
          markHealthOk()
          refreshCommandsAfterReconnect()
        }
      }
      "seqGap" -> {
        // Missed events may include deltas or the terminal state of a pending run;
        // retain local ownership until the recovery snapshot can reconcile it.
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        refreshHistoryForRecovery()
      }
      "chat" -> {
        if (payloadJson.isNullOrBlank()) return
        handleChatEvent(payloadJson)
      }
      "sessions.changed" -> {
        if (payloadJson.isNullOrBlank()) {
          refreshSessionsForCurrentWindow()
        } else {
          handleSessionsChangedEvent(payloadJson)
        }
      }
      "session.message" -> {
        if (payloadJson.isNullOrBlank()) return
        handleSessionMessageEvent(payloadJson)
      }
      "agent" -> {
        if (payloadJson.isNullOrBlank()) return
        handleAgentEvent(payloadJson)
      }
    }
  }

  /**
   * Reconnect/seq-gap recovery: refetch history for the current session without the
   * beginHistoryLoad transient-state reset. Runs pending when the request begins stay
   * owned until that authoritative snapshot resolves them; resetting healthOk here
   * would block sends after reconnect.
   */
  private fun refreshHistoryForRecovery(
    forceHealth: Boolean = false,
    completesReconnectRecovery: Boolean = false,
  ) {
    val key = normalizeRequestedSessionKey(_sessionKey.value)
    val generation = historyLoadGeneration.incrementAndGet()
    if (completesReconnectRecovery) {
      synchronized(gatewayScopeApplyLock) {
        reconnectRecoveryGeneration = generation
      }
    }
    val restoredRunIds =
      synchronized(pendingRuns) {
        val restored = disconnectedPendingRunIds.toSet()
        pendingRuns.addAll(restored)
        disconnectedPendingRunIds.clear()
        _pendingRunCount.value = pendingRuns.size
        restored
      }
    restoredRunIds.forEach(::armPendingRunTimeout)
    val runIdsToReconcile =
      synchronized(pendingRuns) {
        pendingRuns + optimisticMessagesByRunId.keys + unresolvedRepliesByRunId.keys
      }
    _sessionKey.value = key
    _historyLoading.value = true
    scope.launch {
      bootstrap(
        sessionKey = key,
        generation = generation,
        forceHealth = forceHealth,
        refreshSessions = true,
        runIdsToReconcile = runIdsToReconcile,
      )
    }
  }

  private suspend fun bootstrap(
    sessionKey: String,
    generation: Long,
    forceHealth: Boolean,
    refreshSessions: Boolean,
    runIdsToReconcile: Set<String> = emptySet(),
  ) {
    val ownsReconnectRecovery =
      synchronized(gatewayScopeApplyLock) {
        reconnectRecoveryGeneration == generation
      }
    // Cache-first cold open: prime before the live request so ordering is deterministic and the
    // live chat.history response always replaces cached rows wholesale.
    primeFromCache(sessionKey, generation)
    try {
      val historyApplied =
        fetchAndApplyHistory(
          sessionKey,
          generation,
          updateSessionInfo = true,
          runIdsToReconcile = runIdsToReconcile,
        )
      if (!historyApplied) return

      if (!ownsReconnectRecovery) {
        pollHealthIfNeeded(force = forceHealth)
      }
      if (refreshSessions) {
        fetchSessions(limit = 50)
      }
    } catch (err: Throwable) {
      if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return
      updateErrorText(err.message, historyGeneration = generation)
      _historyLoading.value = false
    } finally {
      if (isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) {
        scheduleRecoveryHistoryReconciliation(
          sessionKey = sessionKey,
          generation = generation,
          runIds = runIdsToReconcile,
        )
      }
    }
  }

  /**
   * Requests live history and applies it to controller state, replacing any cached transcript.
   * Returns false when a newer load superseded this request (stale responses are dropped).
   */
  private suspend fun fetchAndApplyHistory(
    sessionKey: String,
    generation: Long,
    updateSessionInfo: Boolean,
    runIdsToReconcile: Set<String> = emptySet(),
  ): Boolean {
    val requestSequence = historyRequestSequence.incrementAndGet()
    val requestModelSelectionGeneration = modelSelectionGeneration.get()
    val requestCacheScope = currentCacheScope()
    awaitMainSessionReadiness(sessionKey, requestCacheScope)
    if (
      !isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) ||
      requestCacheScope != currentCacheScope()
    ) {
      return false
    }
    val history =
      try {
        val historyJson =
          requestGatewayBound(
            requestCacheScope?.gatewayId,
            "chat.history",
            buildJsonObject { put("sessionKey", JsonPrimitive(sessionKey)) }.toString(),
          )
        parseHistory(historyJson, sessionKey = sessionKey, previousMessages = _messages.value)
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        val superseded =
          synchronized(gatewayScopeApplyLock) {
            !isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) ||
              requestCacheScope != currentCacheScope() ||
              requestSequence < latestAppliedHistoryRequest
          }
        if (superseded) return false
        throw err
      }
    val applied =
      synchronized(gatewayScopeApplyLock) {
        if (
          !isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) ||
          requestCacheScope != currentCacheScope() ||
          requestSequence < latestAppliedHistoryRequest
        ) {
          return@synchronized false
        }
        latestAppliedHistoryRequest = requestSequence
        if (updateSessionInfo) {
          updateSessionFromHistory(history)
          if (requestModelSelectionGeneration == modelSelectionGeneration.get()) {
            _selectedModelRef.value = history.sessionInfo?.providerQualifiedModelRef()
          }
        }
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
            .forEach(::clearPendingRun)
        }
        if (snapshotRunId != null) {
          runIdsToReconcile
            .filterTo(mutableSetOf()) {
              it != snapshotRunId &&
                !optimisticMessagesByRunId.containsKey(it) &&
                !unresolvedRepliesByRunId.containsKey(it)
            }.forEach(::clearPendingRun)
        }
        _messagesFromCache.value = false
        _messages.value = mergeOptimisticMessages(incoming = history.messages, optimistic = optimisticMessagesByRunId.values)
        _sessionId.value = history.sessionId
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
            }.forEach(::clearPendingRun)
        }
        clearTransientRunUiIfIdle()
        // All live history paths (bootstrap, reconnect recovery, cache-first
        // replace) adopt the gateway's in-flight run snapshot so restored
        // runs keep their pending state and streaming text.
        adoptInFlightRun(history.inFlightRun)
        history.thinkingLevel
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let { _thinkingLevel.value = it }
        true
      }
    if (!applied) return false
    completeReconnectRecoveryIfOwned(sessionKey, generation)
    persistTranscript(requestCacheScope, sessionKey, history.messages)
    confirmDurableSendsFromHistory(requestCacheScope, history)
    return true
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

  /** Canonical history is the only proof that retires journaled sends; every apply checks it. */
  private suspend fun confirmDurableSendsFromHistory(
    requestCacheScope: ChatCacheScope?,
    history: ChatHistory,
  ) {
    val outbox = commandOutbox ?: return
    val gatewayId = requestCacheScope?.gatewayId ?: return
    if (reconcileDurableSendsAgainstHistory(outbox, gatewayId, history)) {
      publishOutbox()
      // Retired rows may have been session heads holding queued successors; resume delivery.
      kickFlushForRoutedBacklog()
    }
  }

  /** Lets whichever same-generation history request wins finish reconnect health recovery. */
  private suspend fun completeReconnectRecoveryIfOwned(
    sessionKey: String,
    generation: Long,
  ) {
    val ownsRecovery =
      synchronized(gatewayScopeApplyLock) {
        reconnectRecoveryGeneration == generation &&
          isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())
      }
    if (!ownsRecovery) return
    pollHealthIfNeeded(force = true)
    synchronized(gatewayScopeApplyLock) {
      if (
        reconnectRecoveryGeneration == generation &&
        isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) &&
        _healthOk.value
      ) {
        reconnectRecoveryGeneration = null
        restoreRunStateOnReconnect = false
      }
    }
  }

  /** Emits cached transcript/session rows for instant cold open; live data replaces them wholesale. */
  private suspend fun primeFromCache(
    sessionKey: String,
    generation: Long,
  ) {
    val cache = transcriptCache ?: return
    val requestCacheScope = currentCacheScope() ?: return
    if (_messages.value.isEmpty()) {
      val cached = runCatching { cache.loadTranscript(requestCacheScope.gatewayId, sessionKey) }.getOrDefault(emptyList())
      synchronized(gatewayScopeApplyLock) {
        if (
          cached.isNotEmpty() &&
          _messages.value.isEmpty() &&
          requestCacheScope == currentCacheScope() &&
          isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())
        ) {
          _messagesFromCache.value = true
          _messages.value = cached
        }
      }
    }
    if (_sessions.value.isEmpty()) {
      val cachedSessions = runCatching { cache.loadSessions(requestCacheScope.gatewayId) }.getOrDefault(emptyList())
      synchronized(gatewayScopeApplyLock) {
        if (cachedSessions.isNotEmpty() && _sessions.value.isEmpty() && requestCacheScope == currentCacheScope()) {
          _sessions.value = cachedSessions
        }
      }
    }
  }

  // Write-through uses the scope captured before the live request. Re-resolving here could put
  // an old response under a newly selected gateway. Failures are ignored: the cache is disposable.
  private suspend fun persistTranscript(
    requestCacheScope: ChatCacheScope?,
    sessionKey: String,
    messages: List<ChatMessage>,
  ) {
    val cache = transcriptCache ?: return
    val capturedScope = requestCacheScope ?: return
    cacheMutationMutex.withLock {
      if (capturedScope != currentCacheScope()) return@withLock
      runCatching { cache.saveTranscript(capturedScope.gatewayId, sessionKey, messages) }
    }
  }

  private suspend fun persistSessions(
    requestCacheScope: ChatCacheScope?,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String?,
  ) {
    val cache = transcriptCache ?: return
    val capturedScope = requestCacheScope ?: return
    cacheMutationMutex.withLock {
      if (capturedScope != currentCacheScope()) return@withLock
      runCatching { cache.saveSessions(capturedScope.gatewayId, sessions, retainedSessionKey) }
    }
  }

  private suspend fun fetchSessions(
    limit: Int?,
    archived: Boolean = false,
  ) {
    val requestCacheScope = currentCacheScope()
    val requestSequence = sessionsRequestSequence.incrementAndGet()
    synchronized(gatewayScopeApplyLock) {
      activeSessionRefreshesByScope[requestCacheScope] =
        (activeSessionRefreshesByScope[requestCacheScope] ?: 0) + 1
    }
    try {
      while (true) {
        // A sessions list is one authoritative snapshot. Do not let it straddle
        // any per-session settings transaction and restore stale picker state.
        waitForPendingSessionSettings(requestCacheScope)
        val settingsRevision =
          synchronized(gatewayScopeApplyLock) {
            settingsMutationRevision(requestCacheScope)
          }
        val params =
          buildJsonObject {
            put("includeGlobal", JsonPrimitive(true))
            put("includeUnknown", JsonPrimitive(false))
            if (limit != null && limit > 0) put("limit", JsonPrimitive(limit))
            if (archived) put("archived", JsonPrimitive(true))
          }
        val res = requestGateway("sessions.list", params.toString())
        val result = parseSessions(res)
        val settingsChanged =
          synchronized(gatewayScopeApplyLock) {
            settingsRevision != settingsMutationRevision(requestCacheScope) ||
              hasPendingSessionSettings(requestCacheScope)
          }
        if (settingsChanged) continue
        val retainedSessionKey =
          synchronized(gatewayScopeApplyLock) {
            if (requestCacheScope != currentCacheScope()) return
            if (requestSequence != sessionsRequestSequence.get()) return
            if (
              settingsRevision != settingsMutationRevision(requestCacheScope) ||
              hasPendingSessionSettings(requestCacheScope)
            ) {
              null
            } else {
              _sessions.value = result.sessions
              result.sessions
                .firstOrNull { it.key == _sessionKey.value }
                ?.let(::applyThinkingMetadata)
              sessionsListArchived = archived
              val activeSessionKey = _sessionKey.value
              val activeOutsideLocalWindow =
                result.sessions
                  .drop(MAX_CACHED_SESSIONS)
                  .any { session -> session.key == activeSessionKey }
              activeSessionKey.takeIf { result.isTruncated || activeOutsideLocalWindow }
            }
          }
        if (
          synchronized(gatewayScopeApplyLock) {
            settingsRevision != settingsMutationRevision(requestCacheScope) ||
              hasPendingSessionSettings(requestCacheScope)
          }
        ) {
          continue
        }
        unreadPatchSessionKey?.let { trackedKey ->
          acknowledgeUnreadIfNeeded(
            key = trackedKey,
            entry = result.sessions.firstOrNull { it.key == trackedKey },
            requireActive = true,
          )
        }
        if (!archived) {
          persistSessions(requestCacheScope, result.sessions, retainedSessionKey)
        }
        return
      }
    } catch (_: Throwable) {
      // best-effort
    } finally {
      synchronized(gatewayScopeApplyLock) {
        val remaining = (activeSessionRefreshesByScope[requestCacheScope] ?: 1) - 1
        if (remaining > 0) {
          activeSessionRefreshesByScope[requestCacheScope] = remaining
        } else {
          activeSessionRefreshesByScope.remove(requestCacheScope)
          pruneSettingsMutationRevision(requestCacheScope)
        }
      }
    }
  }

  private suspend fun fetchChatMetadata() {
    val requestCacheScope = currentCacheScope()
    val agentId = resolveAgentIdForSessionKey(_sessionKey.value)
    try {
      val params =
        buildJsonObject {
          put("agentId", JsonPrimitive(agentId))
        }
      val res = requestGatewayBound(requestCacheScope?.gatewayId, "chat.metadata", params.toString())
      synchronized(gatewayScopeApplyLock) {
        if (requestCacheScope == currentCacheScope() && agentId == resolveAgentIdForSessionKey(_sessionKey.value)) {
          _commands.value = parseChatCommands(json, res)
          val root = json.parseToJsonElement(res).asObjectOrNull()
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
          chatMetadataAgentId = agentId
        }
      }
    } catch (_: Throwable) {
      synchronized(gatewayScopeApplyLock) {
        if (requestCacheScope == currentCacheScope() && agentId == resolveAgentIdForSessionKey(_sessionKey.value)) {
          _commands.value = emptyList()
          _modelCatalog.value = emptyList()
          chatMetadataAgentId = null
          chatMetadataLoadState = ChatMetadataLoadState.Unloaded
        }
      }
    }
  }

  private fun currentSessionWindowLimit(): Int = _sessions.value.size.takeIf { it > 0 } ?: 100

  private suspend fun fetchSessionsForCurrentWindow() {
    fetchSessions(limit = currentSessionWindowLimit(), archived = sessionsListArchived)
  }

  private fun refreshSessionsForCurrentWindow() {
    scope.launch { fetchSessionsForCurrentWindow() }
  }

  private suspend fun pollHealthIfNeeded(force: Boolean) {
    val requestCacheScope = currentCacheScope()
    val now = System.currentTimeMillis()
    val last = lastHealthPollAtMs
    if (!force && last != null && now - last < 10_000) return
    lastHealthPollAtMs = now
    try {
      requestGatewayBound(requestCacheScope?.gatewayId, "health", null)
      if (requestCacheScope != currentCacheScope()) return
      markHealthOk()
      if (!hasCurrentChatMetadata()) {
        fetchChatMetadata()
      }
    } catch (_: Throwable) {
      if (requestCacheScope == currentCacheScope()) {
        _healthOk.value = false
      }
    }
  }

  // Gateway-health transition is the single reconnect trigger for the outbox flush; it avoids a
  // second reachability source (ConnectivityManager) that could disagree with gateway state.
  private fun markHealthOk() {
    val wasOk = _healthOk.value
    _healthOk.value = true
    if (!wasOk && commandOutbox != null) {
      requestOutboxFlush()
    }
  }

  private fun hasCurrentChatMetadata(): Boolean =
    chatMetadataLoadState == ChatMetadataLoadState.Loaded &&
      chatMetadataAgentId == resolveAgentIdForSessionKey(_sessionKey.value)

  private fun refreshCommandsAfterReconnect() {
    if (hasCurrentChatMetadata()) return
    scope.launch { fetchChatMetadata() }
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
  ): ChatOutboxItem? {
    if (outboxScope == null) {
      updateLocalizedErrorText(nativeText("Gateway health not OK; cannot send"))
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
        updateLocalizedErrorText(nativeText("Could not stage an attachment for sending."))
        return null
      }
    // Slash commands are connection-gated: they may auto-send only inside the connection epoch
    // that captured them, so a reconnect never silently replays a command-shaped input.
    val gatedEpoch = if (text.startsWith("/")) outboxScope.connectionGeneration else null
    val result =
      try {
        outbox.enqueue(
          gatewayId = outboxScope.gatewayId,
          sessionKey = sessionKey,
          text = text,
          thinkingLevel = thinkingLevel,
          nowMs = System.currentTimeMillis(),
          attachments = payloads,
          gatedEpoch = gatedEpoch,
        )
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        updateLocalizedErrorText(nativeText("Could not queue message for later delivery."))
        return null
      }
    return when (result) {
      is ChatOutboxEnqueueResult.Queued -> {
        updateErrorText(null)
        publishOutbox()
        result.item
      }
      ChatOutboxEnqueueResult.QueueFull -> {
        updateLocalizedErrorText(nativeText("Offline queue is full (\$OUTBOX_MAX_QUEUED messages); delete queued items first.", OUTBOX_MAX_QUEUED))
        null
      }
      ChatOutboxEnqueueResult.AttachmentsTooLarge -> {
        updateLocalizedErrorText(nativeText("Attachments are too large to queue for one message; remove some and try again."))
        null
      }
      ChatOutboxEnqueueResult.StorageFull -> {
        updateLocalizedErrorText(nativeText("Offline attachment storage is full; delete queued items first."))
        null
      }
      ChatOutboxEnqueueResult.Unavailable -> {
        updateLocalizedErrorText(nativeText("Gateway health not OK; cannot send"))
        null
      }
    }
  }

  /** Re-queues a failed outbox item and flushes immediately when the gateway is healthy. */
  fun retryOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      val outboxScope = currentCacheScope() ?: return@launch
      val row = _outboxItems.value.firstOrNull { it.id == id }
      // A gated command row is re-armed for the current connection epoch only; retrying it
      // while disconnected parks it again at the next reconnect instead of silently replaying.
      val gatedEpoch = row?.gatedEpoch?.let { outboxScope.connectionGeneration }
      // requeueForRetry refreshes createdAt and requires this gateway's Failed state. The
      // compare-and-set keeps stale gateway or double Retry taps from reviving an in-flight row.
      val requeued =
        runCatching {
          outbox.requeueForRetry(
            gatewayId = outboxScope.gatewayId,
            id = id,
            nowMs = System.currentTimeMillis(),
            gatedEpoch = gatedEpoch,
          )
        }.getOrDefault(0)
      publishOutbox()
      if (requeued > 0 && _healthOk.value) requestOutboxFlush()
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
    val outboxScope = currentCacheScope()
    if (outboxScope == null) {
      _outboxItems.value = emptyList()
      return
    }
    val items = runCatching { outbox.load(outboxScope.gatewayId) }.getOrDefault(emptyList())
    // Publish under the scope lock so rows loaded for an old gateway cannot land after a switch.
    synchronized(gatewayScopeApplyLock) {
      if (outboxScope == currentCacheScope()) {
        _outboxItems.value = items
      }
    }
  }

  /**
   * Sends queued outbox rows strictly createdAt-ordered. Single-flight: health events can fire
   * repeatedly while a flush is already draining the queue.
   */
  private fun requestOutboxFlush() {
    if (commandOutbox == null) return
    outboxFlushRequested.set(true)
    scope.launch { drainOutboxFlushRequests() }
  }

  private suspend fun drainOutboxFlushRequests() {
    if (!outboxFlushInFlight.compareAndSet(false, true)) return
    try {
      while (outboxFlushRequested.getAndSet(false)) {
        flushOutboxPass()
      }
    } finally {
      outboxFlushInFlight.set(false)
      // Close the release race: a requester that observed in-flight ownership leaves this bit set.
      if (outboxFlushRequested.get()) requestOutboxFlush()
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
        val next = nextFlushableRow(rows) ?: break
        when (sendOutboxItem(outbox, next, flushScope)) {
          OutboxSendOutcome.Sent -> flushedAny = true
          OutboxSendOutcome.Continue -> {}
          OutboxSendOutcome.Stop -> break
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
  private fun nextFlushableRow(rows: List<ChatOutboxItem>): ChatOutboxItem? {
    val blockedSessions = mutableSetOf<String>()
    for (row in rows) {
      val session = normalizeRequestedSessionKey(row.sessionKey)
      if (row.status == ChatOutboxStatus.Queued && session !in blockedSessions) return row
      if (outboxRowUnresolved(row)) blockedSessions.add(session)
    }
    return null
  }

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
        .map { normalizeRequestedSessionKey(it.sessionKey) }
        .toSet()
    if (orphanSessions.isEmpty()) return 0
    var changed = false
    for (sessionKey in orphanSessions) {
      if (!_healthOk.value || currentCacheScope() != flushScope) break
      val history =
        try {
          val historyJson =
            requestGatewayBound(
              flushScope.gatewayId,
              "chat.history",
              buildJsonObject { put("sessionKey", JsonPrimitive(sessionKey)) }.toString(),
            )
          parseHistory(historyJson, sessionKey = sessionKey, previousMessages = emptyList())
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          // Keep the rows accepted; the next flush or history apply reconciles them.
          continue
        }
      changed = reconcileDurableSendsAgainstHistory(outbox, flushScope.gatewayId, history) || changed
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
  ): Boolean {
    val rows = runCatching { outbox.load(gatewayId) }.getOrDefault(emptyList())
    if (rows.isEmpty()) return false
    val provenIds = history.messages.mapNotNull(::outboxRowIdFromMessage).toSet()
    val inFlightRunId =
      history.inFlightRun
        ?.runId
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    val sessionRows = rows.filter { sameOutboxSession(it.sessionKey, history.sessionKey) }
    var changed = false
    val confirmed = sessionRows.filter { it.id in provenIds }.map { it.id }.toSet()
    if (confirmed.isNotEmpty()) {
      val removed = runCatching { outbox.confirmDelivered(confirmed) }.getOrDefault(0)
      confirmed.forEach(unconfirmedSightings::remove)
      confirmed.forEach(acknowledgedRunIdByRowId::remove)
      changed = removed > 0
    }
    for (row in sessionRows) {
      if (row.status != ChatOutboxStatus.Accepted || row.id in confirmed) continue
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

  // Sent: acked and removed. Continue: row vanished or failed after a gateway response.
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
  }

  private suspend fun updateOutboxStatusOrNull(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    status: ChatOutboxStatus,
    lastError: String?,
  ): Int? =
    try {
      outbox.updateStatus(item.id, status, item.retryCount, lastError)
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
      outbox.claimForSending(item.id, item.retryCount, item.lastError)
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      null
    }

  private suspend fun sendOutboxItem(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    flushScope: ChatCacheScope,
  ): OutboxSendOutcome {
    // Reconnect flushes share the live-send settings boundary. Claiming before this wait
    // could durably dispatch a queued turn against the previous model or thinking state.
    if (!waitForPendingSessionSettings(normalizeRequestedSessionKey(item.sessionKey))) {
      return OutboxSendOutcome.Stop
    }
    // Atomically claim the row before sending: null means the claim could not be made durable,
    // and 0 means the row vanished or a direct dispatch claimed it first; neither may dispatch.
    val claimed = claimOutboxRowOrNull(outbox, item)
    publishOutbox()
    if (claimed == null) {
      // Never bypass an older row when its claim could not be made durable.
      _healthOk.value = false
      return OutboxSendOutcome.Stop
    }
    if (claimed == 0) return OutboxSendOutcome.Continue
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
    return when (val result = attemptOutboxSend(outbox, item, flushScope.gatewayId, attachments)) {
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
          // A zero update means a concurrent delete raced the ack; history still owns proof.
          if (persisted > 0) adoptFlushedSend(item, attachments, result.runId)
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
            // Sending is controller-owned and Retry only transitions Failed. A zero update can
            // only mean a concurrent delete removed the claimed row; a received response makes
            // either zero or a durable Failed transition safe to advance past.
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
  ) {
    if (normalizeRequestedSessionKey(item.sessionKey) != _sessionKey.value) return
    val runId = item.id
    if (locallyOwnedRun(runId) || locallyOwnedRun(ackRunId)) return
    val optimistic = optimisticUserMessage(runId = runId, text = item.text, attachments = attachments)
    optimisticMessagesByRunId[runId] = optimistic
    unresolvedRepliesByRunId[runId] = optimistic
    _messages.value = _messages.value + optimistic
    armPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }
    // Chat events for this turn arrive under the acknowledged run id; mirroring the direct
    // path's ownership transfer keeps the live run from looking foreign and timing out.
    if (ackRunId != runId) transferRunOwnership(runId, ackRunId, optimistic)
  }

  private suspend fun attemptOutboxSend(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    gatewayId: String,
    attachments: List<OutgoingAttachment>,
  ): OutboxSendResult =
    try {
      val queuedSessionKey = normalizeRequestedSessionKey(item.sessionKey)
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
          text = item.text,
          thinking = thinking,
          idempotencyKey = item.id,
          attachments = attachments,
        )
      val ack = parseChatSendAck(json, requestGatewayBound(gatewayId, "chat.send", params))
      when (ack.normalizedStatus) {
        "ok", "started", "in_flight" ->
          if (ack.runId.isNullOrBlank()) {
            OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
          } else {
            OutboxSendResult.Accepted(ack.runId)
          }
        "timeout", "error" -> OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
        else -> OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
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
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return

    val runId = payload["runId"].asStringOrNull()
    val isPending =
      if (runId != null) synchronized(pendingRuns) { pendingRuns.contains(runId) } else true
    val isOwned = isPending || (runId != null && unresolvedRepliesByRunId.containsKey(runId))

    val state = payload["state"].asStringOrNull()
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
            refreshCurrentHistoryBestEffort(updateSessionInfo = true)
          }
          return
        }
        if (runId != null) lastHandledTerminalRunId = runId
        if (wasTimedOut) {
          val hasNewerRun =
            synchronized(pendingRuns) { pendingRuns.isNotEmpty() } || unresolvedRepliesByRunId.isNotEmpty()
          if (!hasNewerRun) {
            pendingToolCallsById.clear()
            publishPendingToolCalls()
            _streamingAssistantText.value = null
            updateLocalizedErrorText(
              if (state == "error") {
                payload["errorMessage"].asStringOrNull()?.let(::verbatimText) ?: nativeText("Chat failed")
              } else {
                null
              },
            )
          }
          refreshCurrentHistoryBestEffort(updateSessionInfo = true)
          return
        }
        if (runId != null && !isPending) {
          if (resolvesWithoutReply) terminalWithoutReplyRunIds.add(runId)
          refreshCurrentHistoryBestEffort(
            runIdsToReconcile = setOf(runId),
            updateSessionInfo = true,
          )
          return
        }
        if (state == "error") {
          updateLocalizedErrorText(payload["errorMessage"].asStringOrNull()?.let(::verbatimText) ?: nativeText("Chat failed"))
        }
        if (runId != null) {
          clearPendingRun(runId)
          if (resolvesWithoutReply) {
            terminalWithoutReplyRunIds.add(runId)
          }
        } else {
          clearPendingRuns(clearOptimisticMessages = false)
        }
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        val terminalRunIds = runId?.let(::setOf) ?: unresolvedRepliesByRunId.keys.toSet()
        refreshCurrentHistoryBestEffort(
          runIdsToReconcile = terminalRunIds,
          updateSessionInfo = true,
        )
      }
    }
  }

  private fun handleSessionsChangedEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    if (payload["reason"].asStringOrNull() == "delete") {
      removeSessionEntry(payload["sessionKey"].asStringOrNull() ?: payload["key"].asStringOrNull())
      return
    }
    val eventObject = eventSessionObject(payload)
    val entry = eventObject?.let(::parseSessionEntry)
    if (entry != null) {
      upsertSessionEntry(entry, clearedFields = parseExplicitSessionClears(eventObject))
    } else {
      refreshSessionsForCurrentWindow()
    }
  }

  private fun handleSessionMessageEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val eventObject = eventSessionObject(payload)
    val entry = eventObject?.let(::parseSessionEntry)
    if (entry != null) {
      upsertSessionEntry(entry, clearedFields = parseExplicitSessionClears(eventObject))
    }
  }

  private fun eventSessionObject(payload: JsonObject): JsonObject? = payload["session"].asObjectOrNull() ?: payload.takeIf { it["key"].asStringOrNull() != null }

  // The gateway sends explicit JSON null for cleared label/category on session
  // events; the merge must apply those clears instead of preserving stale values.
  private fun parseExplicitSessionClears(obj: JsonObject): Set<String> =
    buildSet {
      if (obj["label"] is JsonNull) add("label")
      if (obj["category"] is JsonNull) add("category")
    }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return
    val runId = payload["runId"].asStringOrNull()
    if (
      runId != null &&
      synchronized(pendingRuns) { runId !in pendingRuns } &&
      !unresolvedRepliesByRunId.containsKey(runId)
    ) {
      return
    }

    val stream = payload["stream"].asStringOrNull()
    val data = payload["data"].asObjectOrNull()

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
        if (phase == "start") {
          val args = data.get("args").asObjectOrNull()
          pendingToolCallsById[toolCallId] =
            ChatPendingToolCall(
              toolCallId = toolCallId,
              name = name,
              args = args,
              startedAtMs = ts,
              isError = null,
            )
          publishPendingToolCalls()
        } else if (phase == "result") {
          pendingToolCallsById.remove(toolCallId)
          publishPendingToolCalls()
        }
      }
      "error" -> {
        updateLocalizedErrorText(nativeText("Event stream interrupted; try refreshing."))
        clearPendingRuns()
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
      }
    }
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

  /**
   * Adopts the run the gateway reports still streaming for this session so reconnect,
   * cold start, and seq-gap recovery restore pending/streaming UI state. Snapshot absence
   * never clears local state: live terminal events and the pending-run timeout own
   * completion, and a snapshot fetched before our own send must not cancel that run.
   */
  private fun adoptInFlightRun(run: ChatInFlightRun?) {
    if (run == null) return
    val runId = run.runId.trim()
    if (runId.isEmpty()) return
    synchronized(pendingRuns) {
      // A different locally-owned run means this snapshot predates it; ignore.
      if (pendingRuns.isNotEmpty() && runId !in pendingRuns) return
      if (pendingRuns.isEmpty() && unresolvedRepliesByRunId.isNotEmpty() && !unresolvedRepliesByRunId.containsKey(runId)) return
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }
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
        refreshHistorySnapshotBestEffort(
          sessionKey = _sessionKey.value,
          generation = historyLoadGeneration.get(),
          runIdsToReconcile = emptySet(),
        )
        val runStillInFlight = synchronized(gatewayScopeApplyLock) { latestAppliedInFlightRunId == runId }
        val replyStillUnresolved = unresolvedRepliesByRunId.containsKey(runId)
        if (!runStillInFlight) {
          clearPendingRun(runId)
          clearTransientRunUiIfIdle()
          if (!replyStillUnresolved) return@launch
        }
        val stillPending =
          synchronized(pendingRuns) {
            pendingRuns.contains(runId)
          }
        if (!stillPending && !replyStillUnresolved) return@launch
        clearPendingRun(runId)
        clearTransientRunUiIfIdle()
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

  private fun clearPendingRun(runId: String) {
    pendingRunTimeoutJobs.remove(runId)?.cancel()
    unknownOutcomeRunIds.remove(runId)
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.remove(runId)
      pendingRuns.remove(runId)
      _pendingRunCount.value = pendingRuns.size
    }
  }

  private fun clearTransientRunUiIfIdle() {
    if (synchronized(pendingRuns) { pendingRuns.isNotEmpty() }) return
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
  }

  private fun clearPendingRuns(
    clearOptimisticMessages: Boolean = true,
    preserveDisconnectedOwnership: Boolean = false,
  ) {
    for ((_, job) in pendingRunTimeoutJobs) {
      job.cancel()
    }
    pendingRunTimeoutJobs.clear()
    if (clearOptimisticMessages) {
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
      _pendingRunCount.value = 0
    }
  }

  private fun removeOptimisticMessage(runId: String) {
    val message = optimisticMessagesByRunId.remove(runId) ?: return
    _messages.value = _messages.value.filterNot { it.id == message.id }
  }

  private fun transferRunOwnership(
    oldRunId: String,
    newRunId: String,
    fallbackMessage: ChatMessage,
    messageIdempotencyKey: String? = fallbackMessage.idempotencyKey,
  ) {
    if (oldRunId == newRunId) return
    val optimistic = optimisticMessagesByRunId.remove(oldRunId)
    val unresolved = unresolvedRepliesByRunId.remove(oldRunId)
    val terminalWithoutReply = terminalWithoutReplyRunIds.remove(oldRunId)
    unknownOutcomeRunIds.remove(oldRunId)
    val original = optimistic ?: unresolved ?: fallbackMessage
    // Run ownership can change independently of the client key persisted on the
    // user row. Only history proof may replace that transcript identity.
    val rekeyed = original.copy(idempotencyKey = messageIdempotencyKey)
    if (optimistic != null) optimisticMessagesByRunId[newRunId] = rekeyed
    if (unresolved != null) unresolvedRepliesByRunId[newRunId] = rekeyed
    if (terminalWithoutReply) terminalWithoutReplyRunIds.add(newRunId)
    _messages.value = _messages.value.map { if (it.id == original.id) rekeyed else it }
    clearPendingRun(oldRunId)
    synchronized(pendingRuns) {
      pendingRuns.add(newRunId)
      _pendingRunCount.value = pendingRuns.size
    }
    armPendingRunTimeout(newRunId)
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
  ) {
    try {
      fetchAndApplyHistory(
        sessionKey,
        generation,
        updateSessionInfo = true,
        runIdsToReconcile = runIdsToReconcile,
      )
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      // The bounded expiry below remains the final reconciliation path.
    }
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

    val messages =
      array.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = normalizeVisibleChatMessageRole(obj["role"].asStringOrNull()) ?: return@mapNotNull null
        val content = parseChatMessageContents(obj)
        val ts = obj["timestamp"].asLongOrNull()
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = role,
          content = content,
          timestampMs = ts,
          idempotencyKey = obj["idempotencyKey"].asStringOrNull(),
        )
      }

    return ChatHistory(
      sessionKey = sessionKey,
      sessionId = sid,
      thinkingLevel = thinkingLevel,
      messages = reconcileMessageIds(previous = previousMessages, incoming = messages),
      sessionInfo = sessionInfo,
      inFlightRun = parseInFlightRun(root),
    )
  }

  private fun parseInFlightRun(root: JsonObject): ChatInFlightRun? {
    val obj = root["inFlightRun"].asObjectOrNull() ?: return null
    val runId = obj["runId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return ChatInFlightRun(runId = runId, text = obj["text"].asStringOrNull().orEmpty())
  }

  private data class SessionListResult(
    val sessions: List<ChatSessionEntry>,
    val isTruncated: Boolean,
  )

  private data class SessionSettingsPatchResolution(
    val modelProvider: String?,
    val model: String?,
    val thinkingLevel: String?,
    val thinkingLevels: List<ChatThinkingLevelOption>?,
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
      updatedAtMs = obj["updatedAt"].asLongOrNull(),
      displayName = obj["displayName"].asStringOrNull()?.trim(),
      label = obj["label"].asStringOrNull()?.trim(),
      category = obj["category"].asStringOrNull()?.trim(),
      pinned = obj["pinned"].asBooleanOrNull(),
      archived = obj["archived"].asBooleanOrNull(),
      unread = obj["unread"].asBooleanOrNull(),
      lastReadAt = obj["lastReadAt"].asLongOrNull(),
      lastActivityAt = obj["lastActivityAt"].asLongOrNull(),
      totalTokens = obj["totalTokens"].asLongOrNull(),
      totalTokensFresh = obj["totalTokensFresh"].asBooleanOrNull(),
      modelProvider = obj["modelProvider"].asStringOrNull()?.trim(),
      model = obj["model"].asStringOrNull()?.trim(),
      thinkingLevel = obj["thinkingLevel"].asStringOrNull()?.trim(),
      thinkingLevels = parseThinkingLevels(obj["thinkingLevels"]),
      thinkingDefault = obj["thinkingDefault"].asStringOrNull()?.trim(),
      contextTokens = obj["contextTokens"].asLongOrNull(),
      hasContextUsageMetadata =
        "totalTokens" in obj ||
          "totalTokensFresh" in obj ||
          "contextTokens" in obj,
    )
  }

  private fun parseSessionSettingsPatchResolution(jsonString: String): SessionSettingsPatchResolution? {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    val resolved = root["resolved"].asObjectOrNull() ?: return null
    return SessionSettingsPatchResolution(
      modelProvider = resolved["modelProvider"].asStringOrNull()?.trim(),
      model = resolved["model"].asStringOrNull()?.trim(),
      thinkingLevel = resolved["thinkingLevel"].asStringOrNull()?.trim(),
      thinkingLevels = parseThinkingLevels(resolved["thinkingLevels"]),
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

  private fun applyAcceptedModelPatch(
    key: String,
    settingsKey: SessionSettingsKey,
    modelRef: String?,
    resolution: SessionSettingsPatchResolution?,
  ) {
    val current = _sessions.value
    val index = current.indexOfFirst { it.key == key }
    val existing = current.getOrNull(index)
    val previousThinkingState =
      latestAcceptedThinkingStates[settingsKey]
        ?: AcceptedThinkingState(
          level =
            existing?.thinkingLevel?.let(::normalizeThinking)
              ?: _thinkingLevel.value.takeIf { _sessionKey.value == key }
              ?: "off",
          thinkingLevels =
            existing?.thinkingLevels
              ?: _thinkingLevelSelection.value.options.takeIf {
                _sessionKey.value == key && _thinkingLevelSelection.value.isGatewayProvided
              },
        )
    val acceptedThinkingState =
      if (resolution?.thinkingLevel != null || resolution?.thinkingLevels != null) {
        AcceptedThinkingState(
          level = resolution.thinkingLevel?.let(::normalizeThinking) ?: previousThinkingState.level,
          thinkingLevels = resolution.thinkingLevels ?: previousThinkingState.thinkingLevels,
        )
      } else {
        previousThinkingState
      }
    latestAcceptedThinkingStates[settingsKey] = acceptedThinkingState
    if (settingsKey != sessionSettingsKey(key)) return
    val fallbackProvider = modelRef?.substringBefore('/', missingDelimiterValue = "")?.takeIf { it.isNotEmpty() }
    val fallbackModel =
      modelRef?.let { ref -> ref.substringAfter('/', missingDelimiterValue = ref) }?.takeIf { it.isNotEmpty() }
    val applied =
      (existing ?: ChatSessionEntry(key = key, updatedAtMs = null)).copy(
        modelProvider = resolution?.modelProvider ?: fallbackProvider ?: existing?.modelProvider,
        model = resolution?.model ?: fallbackModel ?: existing?.model,
        thinkingLevel = acceptedThinkingState.level,
        thinkingLevels = resolution?.thinkingLevels ?: acceptedThinkingState.thinkingLevels,
        thinkingDefault = null,
      )
    if (index >= 0) {
      _sessions.value = current.toMutableList().also { it[index] = applied }
    }
    if (_sessionKey.value == key) {
      val pendingThinkingLevel = latestThinkingIntents[settingsKey]?.level
      applyThinkingMetadata(applied)
      // A queued thinking patch owns the visible intent until it succeeds or
      // rolls back; the preceding model response must not replace that intent.
      pendingThinkingLevel?.let { _thinkingLevel.value = it }
    }
  }

  private fun applyAcceptedThinkingPatch(
    key: String,
    settingsKey: SessionSettingsKey,
    requestedLevel: String,
    intent: ThinkingIntent,
    resolution: SessionSettingsPatchResolution?,
  ) {
    val acceptedLevel = resolution?.thinkingLevel?.let(::normalizeThinking) ?: requestedLevel
    latestAcceptedThinkingStates[settingsKey] =
      AcceptedThinkingState(
        level = acceptedLevel,
        thinkingLevels = resolution?.thinkingLevels ?: latestAcceptedThinkingStates[settingsKey]?.thinkingLevels,
      )
    if (settingsKey != sessionSettingsKey(key)) {
      latestThinkingIntents.remove(settingsKey, intent)
      return
    }
    val current = _sessions.value
    val index = current.indexOfFirst { it.key == key }
    if (index >= 0) {
      val existing = current[index]
      _sessions.value =
        current.toMutableList().also { sessions ->
          sessions[index] =
            existing.copy(
              modelProvider = resolution?.modelProvider ?: existing.modelProvider,
              model = resolution?.model ?: existing.model,
              thinkingLevel = acceptedLevel,
              thinkingLevels = resolution?.thinkingLevels ?: existing.thinkingLevels,
            )
        }
    }
    if (_sessionKey.value == key && latestThinkingIntents[settingsKey]?.requestId == intent.requestId) {
      _thinkingLevel.value = acceptedLevel
      resolution?.thinkingLevels?.let { levels ->
        applyThinkingMetadata(
          (_sessions.value.getOrNull(index) ?: ChatSessionEntry(key = key, updatedAtMs = null)).copy(
            thinkingLevel = acceptedLevel,
            thinkingLevels = levels,
          ),
        )
      }
    }
    latestThinkingIntents.remove(settingsKey, intent)
  }

  private fun applyThinkingMetadata(entry: ChatSessionEntry?) {
    val advertised = entry?.thinkingLevels
    if (advertised == null) {
      _thinkingLevelSelection.value = defaultChatThinkingLevelSelection
      val requestedLevel =
        entry
          ?.thinkingLevel
          ?.takeIf { it.isNotBlank() }
          ?.let(::normalizeThinking)
          ?: normalizeThinking(_thinkingLevel.value)
      _thinkingLevel.value =
        requestedLevel.takeIf { candidate ->
          defaultChatThinkingLevelSelection.options.any { it.id == candidate }
        } ?: "off"
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
    val currentLevel = normalizeThinking(_thinkingLevel.value)
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

  private fun updateSessionFromHistory(history: ChatHistory) {
    val info = history.sessionInfo ?: return
    upsertSessionEntry(info, preserveExistingContextUsageWithoutTotal = true)
  }

  private fun upsertSessionEntry(
    entry: ChatSessionEntry,
    preserveExistingContextUsageWithoutTotal: Boolean = false,
    clearedFields: Set<String> = emptySet(),
  ) {
    val current = _sessions.value
    val index = current.indexOfFirst { it.key == entry.key }
    var applied = entry
    _sessions.value =
      if (index >= 0) {
        current.toMutableList().also {
          applied =
            mergeChatSessionEntry(
              existing = it[index],
              next = entry,
              preserveExistingContextUsageWithoutTotal = preserveExistingContextUsageWithoutTotal,
            )
          if (clearedFields.isNotEmpty()) {
            applied =
              applied.copy(
                label = if ("label" in clearedFields) null else applied.label,
                category = if ("category" in clearedFields) null else applied.category,
              )
          }
          it[index] = applied
        }
      } else {
        listOf(entry) + current
      }
    if (applied.key == _sessionKey.value) {
      applyThinkingMetadata(applied)
    }
    acknowledgeUnreadIfNeeded(applied.key, applied, requireActive = true)
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
    if (entry?.unread == false) {
      unreadPatchRequested = false
      return
    }
    if (entry?.unread != true || unreadPatchRequested) return
    // switchSession acknowledges before _sessionKey updates; background upserts only
    // re-acknowledge the session that is currently open.
    if (requireActive && key != _sessionKey.value) return
    unreadPatchRequested = true
    _sessions.value = _sessions.value.map { if (it.key == key) it.copy(unread = false) else it }
    scope.launch {
      // A failed read patch must unlatch the episode so later snapshots retry.
      if (!patchSession(key = key, unread = false) && unreadPatchSessionKey == key) {
        unreadPatchRequested = false
      }
    }
  }

  private fun removeSessionEntry(sessionKey: String?) {
    val key = sessionKey?.trim()?.takeIf { it.isNotEmpty() } ?: return
    _sessions.value = _sessions.value.filterNot { it.key == key }
    // Gateway-side deletes must also purge the offline copy, or the deleted transcript would
    // reappear on the next offline cold open. Queued commands for the session die with it too.
    val requestCacheScope = currentCacheScope() ?: return
    scope.launch {
      cacheMutationMutex.withLock {
        if (requestCacheScope != currentCacheScope()) return@withLock
        transcriptCache?.let { runCatching { it.deleteSession(requestCacheScope.gatewayId, key) } }
        commandOutbox?.let { runCatching { it.deleteForSession(requestCacheScope.gatewayId, key) } }
      }
      publishOutbox()
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

  private fun currentCacheScope(): ChatCacheScope? = normalizedChatCacheScope(cacheScope())

  private fun sessionSettingsKey(sessionKey: String): SessionSettingsKey = SessionSettingsKey(gatewayScope = currentCacheScope(), sessionKey = sessionKey)

  private fun normalizeThinking(raw: String): String = raw.trim().lowercase(Locale.US).ifEmpty { "off" }
}

private enum class ChatMetadataLoadState {
  Unloaded,
  RetryEmptyCatalog,
  Loaded,
}

private const val NEW_CHAT_SESSION_LABEL = "New chat"

// Group mutations enumerate whole stores; far past any realistic session count.
private const val GROUP_MEMBER_FETCH_LIMIT = 10_000

internal fun nextNewChatSessionLabel(sessions: List<ChatSessionEntry>): String {
  val baseLabel = NEW_CHAT_SESSION_LABEL
  val existingLabels =
    sessions
      .mapNotNull { session -> session.displayName?.trim()?.takeIf { it.isNotEmpty() } }
      .toSet()
  if (baseLabel !in existingLabels) return baseLabel

  var suffix = 2
  while (newChatSessionLabelWithSuffix(suffix) in existingLabels) {
    suffix += 1
  }
  return newChatSessionLabelWithSuffix(suffix)
}

private fun newChatSessionLabelWithSuffix(suffix: Int): String = NEW_CHAT_SESSION_LABEL + ' ' + suffix

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
  return when (obj["type"].asStringOrNull() ?: "text") {
    "text", "input_text", "output_text" ->
      ChatMessageContent(
        type = "text",
        text = obj["text"].asStringOrNull() ?: obj["content"].asStringOrNull(),
      )

    "image", "audio" -> {
      val type = obj["type"].asStringOrNull() ?: "image"
      val inlineContent = obj["content"].asStringOrNull()?.takeIf { it.isNotBlank() }
      ChatMessageContent(
        type = type,
        mimeType = obj["mimeType"].asStringOrNull(),
        fileName = obj["fileName"].asStringOrNull(),
        base64 = inlineContent?.takeIf { type != "image" || it.length <= CHAT_IMAGE_MAX_BASE64_CHARS },
      )
    }

    "attachment" -> {
      val attachment = obj["attachment"].asObjectOrNull() ?: return null
      val mimeType = attachment["mimeType"].asStringOrNull()
      if (attachment["kind"].asStringOrNull() != "audio" && mimeType?.startsWith("audio/") != true) return null
      ChatMessageContent(
        type = "audio",
        mimeType = mimeType,
        fileName = attachment["label"].asStringOrNull(),
      )
    }

    else -> null
  }
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

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

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

internal fun mergeChatSessionEntry(
  existing: ChatSessionEntry,
  next: ChatSessionEntry,
  preserveExistingContextUsageWithoutTotal: Boolean = false,
): ChatSessionEntry {
  val preserveExistingContextUsage = preserveExistingContextUsageWithoutTotal && next.totalTokens == null
  return existing.copy(
    updatedAtMs = next.updatedAtMs ?: existing.updatedAtMs,
    displayName = next.displayName ?: existing.displayName,
    label = next.label ?: existing.label,
    category = next.category ?: existing.category,
    pinned = next.pinned ?: existing.pinned,
    archived = next.archived ?: existing.archived,
    unread = next.unread ?: existing.unread,
    lastReadAt = next.lastReadAt ?: existing.lastReadAt,
    lastActivityAt = next.lastActivityAt ?: existing.lastActivityAt,
    totalTokens =
      when {
        preserveExistingContextUsage -> existing.totalTokens
        next.hasContextUsageMetadata -> next.totalTokens
        else -> null
      },
    totalTokensFresh =
      when {
        preserveExistingContextUsage -> existing.totalTokensFresh
        next.hasContextUsageMetadata -> next.totalTokensFresh
        else -> null
      },
    modelProvider = next.modelProvider ?: existing.modelProvider,
    model = next.model ?: existing.model,
    thinkingLevel = next.thinkingLevel ?: existing.thinkingLevel,
    thinkingLevels = next.thinkingLevels ?: existing.thinkingLevels,
    thinkingDefault = next.thinkingDefault ?: existing.thinkingDefault,
    contextTokens =
      when {
        preserveExistingContextUsage -> next.contextTokens ?: existing.contextTokens
        next.hasContextUsageMetadata -> next.contextTokens
        else -> null
      },
    hasContextUsageMetadata =
      when {
        preserveExistingContextUsage -> existing.hasContextUsageMetadata || next.contextTokens != null
        else -> next.hasContextUsageMetadata
      },
  )
}

private fun ChatSessionEntry.providerQualifiedModelRef(): String? {
  val model = model?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val provider = modelProvider?.trim()?.takeIf { it.isNotEmpty() } ?: return model
  return if (model.startsWith("$provider/")) model else "$provider/$model"
}
