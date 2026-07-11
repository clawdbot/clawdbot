package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.parseGatewayModels
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.ui.chat.thinkingSupportedForSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
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

class ChatController internal constructor(
  private val scope: CoroutineScope,
  private val json: Json,
  private val requestGateway: suspend (method: String, paramsJson: String?) -> String,
  private val requestGatewayForGateway: suspend (gatewayId: String, method: String, paramsJson: String?) -> String =
    { _, method, paramsJson -> requestGateway(method, paramsJson) },
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
    transcriptCache = transcriptCache,
    cacheScope = cacheScope,
    commandOutbox = commandOutbox,
    recordModelRecent = recordModelRecent,
  )

  private var appliedMainSessionKey = "main"
  private val cacheMutationMutex = Mutex()
  private val modelSelectionMutex = Mutex()
  private val pendingModelSelections = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
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

  private val _errorText = MutableStateFlow<String?>(null)
  val errorText: StateFlow<String?> = _errorText.asStateFlow()

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
  }

  /** Refreshes the connected gateway while preserving recovery ownership after a disconnect. */
  fun onGatewayConnected() {
    if (!restoreRunStateOnReconnect) {
      refresh()
      return
    }
    updateErrorText(null)
    refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
  }

  /** Invalidates and clears gateway-bound UI state before a target switch can race old responses. */
  fun onGatewayScopeChanging(retireRunState: Boolean = false) {
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
      updateErrorText("Wait for the current response to finish before starting a new chat.")
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
    _thinkingLevel.value = normalized
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
    val normalizedModelRef = modelRef?.trim()?.takeIf { it.isNotEmpty() }
    val pendingSelection = CompletableDeferred<Boolean>()
    pendingModelSelections[key] = pendingSelection
    return try {
      val succeeded =
        modelSelectionMutex.withLock {
          updateErrorText(null)
          try {
            val params =
              buildJsonObject {
                put("key", JsonPrimitive(key))
                put("model", normalizedModelRef?.let(::JsonPrimitive) ?: JsonNull)
              }
            val response = requestGateway("sessions.patch", params.toString())
            val resolution = parseSessionModelPatchResolution(response)
            normalizedModelRef?.let(recordModelRecent)
            applyAcceptedModelPatch(key = key, modelRef = normalizedModelRef, resolution = resolution)
            if (_sessionKey.value == key) {
              modelSelectionGeneration.incrementAndGet()
              _selectedModelRef.value = normalizedModelRef
            }
            true
          } catch (err: CancellationException) {
            throw err
          } catch (err: Throwable) {
            updateErrorText(err.message ?: "Could not update model.")
            false
          }
        }
      pendingSelection.complete(succeeded)
      succeeded
    } catch (err: CancellationException) {
      pendingSelection.complete(false)
      throw err
    } finally {
      pendingModelSelections.remove(key, pendingSelection)
    }
  }

  /** Switches to another gateway chat session and starts a fresh history load. */
  fun switchSession(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key.isEmpty()) return
    if (key != unreadPatchSessionKey) {
      unreadPatchSessionKey = key
      unreadPatchRequested = false
    }
    acknowledgeUnreadIfNeeded(key, _sessions.value.firstOrNull { it.key == key })
    if (key == _sessionKey.value) return
    val generation = beginHistoryLoad(key, clearMessages = true)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = false)
    }
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

  /** Sends a chat message and returns once the gateway accepts or rejects the request. */
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
    // Model patches and sends share one ordering boundary; the first post-selection turn
    // must not leave on the previous model while sessions.patch is still in flight.
    val pendingSelection = pendingModelSelections[sessionKey]
    if (pendingSelection != null && !pendingSelection.await()) return false
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
    if (!_healthOk.value) {
      // Offline capture: text-only commands become durable outbox rows and flush on reconnect.
      // Attachments stay blocked (text-only v1) so large payloads never sit in the database.
      if (commandOutbox == null || attachments.isNotEmpty()) {
        updateErrorText("Gateway health not OK; cannot send")
        return false
      }
      return enqueueOfflineCommand(text = trimmed, thinkingLevel = thinking)
    }

    val runId = UUID.randomUUID().toString()
    val text = if (trimmed.isEmpty() && attachments.isNotEmpty()) "See attached." else trimmed

    // Optimistic user message keeps the composer responsive while chat.send and history refresh complete.
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
    val optimisticMessage =
      ChatMessage(
        id = UUID.randomUUID().toString(),
        role = "user",
        content = userContent,
        timestampMs = System.currentTimeMillis(),
        idempotencyKey = "$runId:user",
      )
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

    return try {
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(sessionKey))
          put("message", JsonPrimitive(text))
          put("thinking", JsonPrimitive(thinking))
          put("timeoutMs", JsonPrimitive(30_000))
          put("idempotencyKey", JsonPrimitive(runId))
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
        }
      val res = requestGatewayBound(sendGatewayId, "chat.send", params.toString())
      if (sendCacheScope != currentCacheScope()) return true
      val ack = parseChatSendAck(json, res)
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
          updateErrorText("Chat failed before the run started; try again.")
          false
        }
      } else {
        true
      }
    } catch (err: CancellationException) {
      throw err
    } catch (err: GatewayRequestDefinitiveFailure) {
      if (sendCacheScope != currentCacheScope()) return true
      clearPendingRun(runId)
      removeOptimisticMessage(runId)
      unresolvedRepliesByRunId.remove(runId)
      updateErrorText(err.message)
      false
    } catch (_: GatewayRequestOutcomeUnknown) {
      if (sendCacheScope != currentCacheScope()) return true
      // A transport failure cannot distinguish rejection from an accepted send whose
      // ACK was lost. Keep the idempotency-key-backed row to prevent a duplicate retry.
      unknownOutcomeRunIds.add(runId)
      if (_healthOk.value) {
        refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(runId))
      }
      true
    } catch (err: Throwable) {
      if (sendCacheScope != currentCacheScope()) return true
      clearPendingRun(runId)
      removeOptimisticMessage(runId)
      unresolvedRepliesByRunId.remove(runId)
      updateErrorText(err.message)
      false
    }
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
    return true
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
    try {
      val requestCacheScope = currentCacheScope()
      val requestSequence = sessionsRequestSequence.incrementAndGet()
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          if (limit != null && limit > 0) put("limit", JsonPrimitive(limit))
          if (archived) put("archived", JsonPrimitive(true))
        }
      val res = requestGateway("sessions.list", params.toString())
      val result = parseSessions(res)
      val retainedSessionKey =
        synchronized(gatewayScopeApplyLock) {
          if (requestCacheScope != currentCacheScope()) return
          if (requestSequence != sessionsRequestSequence.get()) return
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
    } catch (_: Throwable) {
      // best-effort
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

  private suspend fun enqueueOfflineCommand(
    text: String,
    thinkingLevel: String,
  ): Boolean {
    val outbox = commandOutbox ?: return false
    val outboxScope =
      currentCacheScope() ?: run {
        updateErrorText("Gateway health not OK; cannot send")
        return false
      }
    val result =
      try {
        outbox.enqueue(
          gatewayId = outboxScope.gatewayId,
          sessionKey = _sessionKey.value,
          text = text,
          thinkingLevel = thinkingLevel,
          nowMs = System.currentTimeMillis(),
        )
      } catch (_: Throwable) {
        updateErrorText("Could not queue message for later delivery.")
        return false
      }
    return when (result) {
      is ChatOutboxEnqueueResult.Queued -> {
        updateErrorText(null)
        publishOutbox()
        true
      }
      ChatOutboxEnqueueResult.QueueFull -> {
        updateErrorText("Offline queue is full ($OUTBOX_MAX_QUEUED messages); delete queued items first.")
        false
      }
      ChatOutboxEnqueueResult.Unavailable -> {
        updateErrorText("Gateway health not OK; cannot send")
        false
      }
    }
  }

  /** Re-queues a failed outbox item and flushes immediately when the gateway is healthy. */
  fun retryOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      val outboxScope = currentCacheScope() ?: return@launch
      // requeueForRetry refreshes createdAt and requires this gateway's Failed state. The
      // compare-and-set keeps stale gateway or double Retry taps from reviving an in-flight row.
      val requeued =
        runCatching { outbox.requeueForRetry(gatewayId = outboxScope.gatewayId, id = id, nowMs = System.currentTimeMillis()) }
          .getOrDefault(0)
      publishOutbox()
      if (requeued > 0 && _healthOk.value) requestOutboxFlush()
    }
  }

  fun deleteOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      runCatching { outbox.delete(id) }
      publishOutbox()
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
        val next =
          runCatching { outbox.load(flushScope.gatewayId) }
            .getOrDefault(emptyList())
            .firstOrNull { it.status == ChatOutboxStatus.Queued } ?: break
        when (sendOutboxItem(outbox, next, flushScope)) {
          OutboxSendOutcome.Sent -> flushedAny = true
          OutboxSendOutcome.Continue -> {}
          OutboxSendOutcome.Stop -> break
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

  // Sent: acked and removed. Continue: row vanished or failed after a gateway response.
  // Stop: transport or persistence state cannot safely advance to younger work.
  private enum class OutboxSendOutcome { Sent, Continue, Stop }

  private enum class GatewayResponseState { Received, Unknown }

  private sealed interface OutboxSendResult {
    data object Accepted : OutboxSendResult

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

  private suspend fun sendOutboxItem(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    flushScope: ChatCacheScope,
  ): OutboxSendOutcome {
    // Claim the row before sending: 0 updated rows means it was deleted since the load, and a
    // deleted command must never be sent. Continue (like an acknowledged failure) lets the
    // flush advance to younger rows without replaying this one.
    val claimed = updateOutboxStatusOrNull(outbox, item, ChatOutboxStatus.Sending, item.lastError)
    publishOutbox()
    if (claimed == null) {
      // Never bypass an older row when its claim could not be made durable.
      _healthOk.value = false
      return OutboxSendOutcome.Stop
    }
    if (claimed == 0) return OutboxSendOutcome.Continue
    return when (val result = attemptOutboxSend(item, flushScope.gatewayId)) {
      OutboxSendResult.Accepted -> {
        // Ack received: delete the row so the flushed history copy is the only bubble left.
        val deleted =
          try {
            outbox.delete(item.id)
            true
          } catch (err: CancellationException) {
            throw err
          } catch (_: Throwable) {
            false
          }
        if (!deleted) rearmOutboxRecovery()
        publishOutbox()
        if (deleted) {
          OutboxSendOutcome.Sent
        } else {
          _healthOk.value = false
          OutboxSendOutcome.Stop
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

  private suspend fun attemptOutboxSend(
    item: ChatOutboxItem,
    gatewayId: String,
  ): OutboxSendResult =
    try {
      val queuedSessionKey = normalizeRequestedSessionKey(item.sessionKey)
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
      val params =
        buildJsonObject {
          // Rows enqueued under the pre-hello "main" alias must flush to the canonical main
          // session the gateway announced, matching how the UI attributes those rows.
          put("sessionKey", JsonPrimitive(queuedSessionKey))
          put("message", JsonPrimitive(item.text))
          put("thinking", JsonPrimitive(thinking))
          put("timeoutMs", JsonPrimitive(30_000))
          // The row id is the idempotency key, so gateway-side dedupe makes redelivery of an
          // acked-but-crashed item harmless.
          put("idempotencyKey", JsonPrimitive(item.id))
        }
      val ack = parseChatSendAck(json, requestGatewayBound(gatewayId, "chat.send", params.toString()))
      when (ack.normalizedStatus) {
        "ok", "started", "in_flight" ->
          if (ack.runId.isNullOrBlank()) {
            OutboxSendResult.DeliveryUnconfirmed(GatewayResponseState.Received)
          } else {
            OutboxSendResult.Accepted
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
            updateErrorText(if (state == "error") payload["errorMessage"].asStringOrNull() ?: "Chat failed" else null)
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
          updateErrorText(payload["errorMessage"].asStringOrNull() ?: "Chat failed")
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
        updateErrorText("Event stream interrupted; try refreshing.")
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
        updateErrorText("Timed out waiting for a reply; try again or refresh.")
      }
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
        updateErrorText("Timed out confirming the sent message; refresh to check delivery.")
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

  private data class SessionModelPatchResolution(
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

  private fun parseSessionModelPatchResolution(jsonString: String): SessionModelPatchResolution? {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    val resolved = root["resolved"].asObjectOrNull() ?: return null
    return SessionModelPatchResolution(
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
    modelRef: String?,
    resolution: SessionModelPatchResolution?,
  ) {
    val fallbackProvider = modelRef?.substringBefore('/', missingDelimiterValue = "")?.takeIf { it.isNotEmpty() }
    val fallbackModel =
      modelRef?.let { ref -> ref.substringAfter('/', missingDelimiterValue = ref) }?.takeIf { it.isNotEmpty() }
    val current = _sessions.value
    val index = current.indexOfFirst { it.key == key }
    val existing = current.getOrNull(index)
    val applied =
      (existing ?: ChatSessionEntry(key = key, updatedAtMs = null)).copy(
        modelProvider = resolution?.modelProvider ?: fallbackProvider ?: existing?.modelProvider,
        model = resolution?.model ?: fallbackModel ?: existing?.model,
        thinkingLevel = resolution?.thinkingLevel,
        thinkingLevels = resolution?.thinkingLevels,
        thinkingDefault = null,
      )
    if (index >= 0) {
      _sessions.value = current.toMutableList().also { it[index] = applied }
    }
    if (_sessionKey.value == key) {
      applyThinkingMetadata(applied)
    }
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
        .ifEmpty { listOf(ChatThinkingLevelOption(id = "off", label = "off")) }
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

  private fun currentCacheScope(): ChatCacheScope? {
    val scope = cacheScope() ?: return null
    val gatewayId = scope.gatewayId.trim().takeIf { it.isNotEmpty() } ?: return null
    return if (gatewayId == scope.gatewayId) scope else scope.copy(gatewayId = gatewayId)
  }

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

    "image", "audio" ->
      ChatMessageContent(
        type = obj["type"].asStringOrNull() ?: "image",
        mimeType = obj["mimeType"].asStringOrNull(),
        fileName = obj["fileName"].asStringOrNull(),
        base64 = obj["content"].asStringOrNull()?.takeIf { it.isNotBlank() },
      )

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
