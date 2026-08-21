package ai.openclaw.wear

import ai.openclaw.wear.shared.WearConnectionFailure
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import java.util.UUID

internal data class WearUiState(
  val loading: Boolean = true,
  val connected: Boolean = false,
  val phoneNodeId: String? = null,
  val agents: List<WearAgent> = emptyList(),
  val activeAgentId: String? = null,
  val selectedModelRef: String? = null,
  val models: List<WearModel> = emptyList(),
  val proxyCapabilities: Set<WearProxyCapability> = emptySet(),
  val sessions: List<WearSession> = emptyList(),
  val selectedSession: WearSession? = null,
  val phoneActiveSessionKey: String? = null,
  val sessionSearchQuery: String? = null,
  val sessionSearchResults: List<WearSession> = emptyList(),
  val sessionSearchHasMore: Boolean = false,
  val sessionSearchNextOffset: Int? = null,
  val modelSearchQuery: String? = null,
  val modelSearchResults: List<WearModel> = emptyList(),
  val messages: List<WearChatMessage> = emptyList(),
  val streamText: String? = null,
  val activeRunId: String? = null,
  val sending: Boolean = false,
  val realtimeTalk: WearRealtimeTalkSnapshot = WearRealtimeTalkSnapshot(),
  val realtimeCapturing: Boolean = false,
  val realtimePlaying: Boolean = false,
  val realtimeMouthLevel: Float = 0f,
  val realtimePlaybackFailed: Boolean = false,
  val talkBusy: Boolean = false,
  val controlBusy: Boolean = false,
  val failure: WearConversationFailure? = null,
  val agentPulse: WearAgentPulseSnapshot? = null,
  val agentPulseLoading: Boolean = false,
  val agentPulseFailure: WearConversationFailure? = null,
)

internal fun WearUiState.resetForPhoneChange(): WearUiState =
  copy(
    loading = true,
    connected = false,
    phoneNodeId = null,
    agents = emptyList(),
    activeAgentId = null,
    selectedModelRef = null,
    models = emptyList(),
    proxyCapabilities = emptySet(),
    sessions = emptyList(),
    selectedSession = null,
    phoneActiveSessionKey = null,
    sessionSearchQuery = null,
    sessionSearchResults = emptyList(),
    sessionSearchHasMore = false,
    sessionSearchNextOffset = null,
    modelSearchQuery = null,
    modelSearchResults = emptyList(),
    messages = emptyList(),
    streamText = null,
    activeRunId = null,
    sending = false,
    realtimeTalk = WearRealtimeTalkSnapshot(),
    realtimeCapturing = false,
    realtimePlaying = false,
    realtimeMouthLevel = 0f,
    realtimePlaybackFailed = false,
    talkBusy = false,
    controlBusy = false,
    failure = null,
    agentPulse = null,
    agentPulseLoading = false,
    agentPulseFailure = null,
  )

internal fun WearUiState.switchAgentContext(agentId: String): WearUiState =
  copy(
    activeAgentId = agentId,
    sessions = emptyList(),
    selectedSession = null,
    phoneActiveSessionKey = null,
    sessionSearchQuery = null,
    sessionSearchResults = emptyList(),
    sessionSearchHasMore = false,
    sessionSearchNextOffset = null,
    modelSearchQuery = null,
    modelSearchResults = emptyList(),
    messages = emptyList(),
    streamText = null,
    activeRunId = null,
    selectedModelRef = null,
    models = emptyList(),
    agentPulse = null,
    agentPulseLoading = false,
    agentPulseFailure = null,
  )

internal fun WearUiState.switchSessionContext(session: WearSession): WearUiState =
  copy(
    selectedSession = session,
    sessionSearchQuery = null,
    sessionSearchResults = emptyList(),
    sessionSearchHasMore = false,
    sessionSearchNextOffset = null,
    modelSearchQuery = null,
    modelSearchResults = emptyList(),
    messages = emptyList(),
    streamText = null,
    activeRunId = null,
    selectedModelRef = session.modelRef,
    models = emptyList(),
    realtimeTalk = WearRealtimeTalkSnapshot(),
    realtimeMouthLevel = 0f,
    talkBusy = false,
    failure = null,
    agentPulse = null,
    agentPulseLoading = false,
    agentPulseFailure = null,
  )

internal fun WearUiState.switchModelContext(modelRef: String): WearUiState {
  val currentSession = selectedSession ?: return this
  val updatedSession = currentSession.copy(modelRef = modelRef)
  return copy(
    selectedModelRef = modelRef,
    selectedSession = updatedSession,
    // The phone preserves the selected model in its bounded catalog slice.
    // A model change therefore invalidates the previous slice.
    models = emptyList(),
    sessions = sessions.map { session -> if (session.key == updatedSession.key) updatedSession else session },
  )
}

internal fun WearUiState.containsModelRef(modelRef: String): Boolean =
  models.any { model -> model.ref == modelRef } ||
    modelSearchResults.any { model -> model.ref == modelRef }

internal fun shouldAcceptWearTalkSnapshot(
  snapshot: WearRealtimeTalkSnapshot,
  attemptId: String?,
): Boolean = snapshot.attemptId != null && snapshot.attemptId == attemptId

internal data class WearTerminalChatTransition(
  val state: WearUiState,
  val reloadHistory: Boolean,
  val observedMessage: WearChatMessage? = null,
)

internal fun reduceWearTerminalChatEvent(
  current: WearUiState,
  event: WearChatEvent,
): WearTerminalChatTransition {
  if (event.sessionKey != current.selectedSession?.key) {
    return WearTerminalChatTransition(state = current, reloadHistory = false)
  }
  val finalMessage = event.message?.takeIf { event.state == "final" }
  val preservedState =
    finalMessage?.let { message ->
      current.copy(messages = mergeEventMessage(current.messages, message))
    } ?: current
  if (current.activeRunId != null && event.runId != null && current.activeRunId != event.runId) {
    // Preserve older finals and notifications without canceling another
    // identified run or replacing it with a stale history snapshot.
    return WearTerminalChatTransition(state = preservedState, reloadHistory = false)
  }
  val hasLiveReply = current.activeRunId != null || !current.streamText.isNullOrBlank()
  if (hasLiveReply && (current.activeRunId == null || event.runId == null)) {
    // Missing run identity cannot distinguish a delayed terminal from the
    // live run's first identified terminal. Preserve the live reply until
    // authoritative history resolves which run actually remains active.
    return WearTerminalChatTransition(
      state = preservedState,
      reloadHistory = true,
      observedMessage = finalMessage,
    )
  }
  return when (event.state) {
    "final" ->
      WearTerminalChatTransition(
        state =
          current.copy(
            messages = event.message?.let { mergeEventMessage(current.messages, it) } ?: current.messages,
            streamText = if (event.message == null) current.streamText else null,
            activeRunId = null,
          ),
        reloadHistory = true,
        observedMessage = event.message,
      )
    "aborted", "error" ->
      WearTerminalChatTransition(
        state = current.copy(streamText = null, activeRunId = null),
        reloadHistory = true,
      )
    else -> WearTerminalChatTransition(state = current, reloadHistory = false)
  }
}

internal class WearViewModel(
  application: Application,
) : AndroidViewModel(application) {
  private val app = application as WearApplication
  private val repository = app.gatewayRepository
  private val realtimeTalkClient = WearRealtimeTalkClient(app, repository)
  private val mutableState = MutableStateFlow(WearUiState())
  private val eventSequenceTracker = WearEventSequenceTracker()
  private val eventSourceTracker = WearEventSourceTracker()
  private val resyncEventBuffer = WearEventResyncBuffer()
  private val historyLoadTracker = WearHistoryLoadTracker()
  private val sendAttemptTracker = WearSendAttemptTracker()
  private val controlBusyOwner = WearControlBusyOwner()
  private var loadJob: Job? = null
  private var sessionSearchJob: Job? = null
  private var phoneRouteGeneration = 0L
  private var agentPulsePollJob: Job? = null
  private var agentPulseVisible = false
  private var agentPulseRequestGeneration = 0L

  // Session switches clear the prior bounded catalog; only the matching phone/session may refill it.
  private var modelLoadJob: Job? = null
  private var talkStartJob: Job? = null
  private var talkAttemptId: String? = null

  val state: StateFlow<WearUiState> = mutableState.asStateFlow()

  init {
    viewModelScope.launch {
      app.proxyClient.events.collect(::handleEvent)
    }
    viewModelScope.launch {
      app.proxyClient.preferredPhoneChanges.collect(::reloadForPreferredPhone)
    }
    viewModelScope.launch {
      realtimeTalkClient.channelFailed.collect { failed ->
        mutableState.update { it.copy(realtimePlaybackFailed = failed) }
        if (failed) {
          talkAttemptId = null
          mutableState.update {
            it.copy(
              realtimeTalk = WearRealtimeTalkSnapshot(),
              realtimeCapturing = false,
              realtimePlaying = false,
              realtimeMouthLevel = 0f,
              talkBusy = false,
              failure = WearConversationFailure.INTERNAL_ERROR,
            )
          }
        }
      }
    }
    viewModelScope.launch {
      realtimeTalkClient.isCapturing.collect { capturing ->
        mutableState.update { it.copy(realtimeCapturing = capturing) }
      }
    }
    viewModelScope.launch {
      realtimeTalkClient.isPlaying.collect { playing ->
        mutableState.update { it.copy(realtimePlaying = playing) }
      }
    }
    viewModelScope.launch {
      realtimeTalkClient.mouthLevel.collect { level ->
        mutableState.update { it.copy(realtimeMouthLevel = level) }
      }
    }
    refresh()
  }

  fun refresh() {
    loadSessions()
  }

  fun setAgentPulseVisible(visible: Boolean) {
    if (agentPulseVisible == visible) {
      if (visible && agentPulsePollJob?.isActive != true) {
        restartAgentPulsePolling(forceLoading = true)
      }
      return
    }
    agentPulseVisible = visible
    if (visible) {
      restartAgentPulsePolling(forceLoading = true)
    } else {
      invalidateAgentPulse(clearSnapshot = true)
    }
  }

  fun refreshAgentPulse() {
    if (!agentPulseVisible) return
    restartAgentPulsePolling(forceLoading = true)
  }

  fun openSession(session: WearSession) {
    val current = mutableState.value
    if (
      current.controlBusy ||
      current.talkBusy ||
      current.realtimeTalk.active ||
      current.realtimeCapturing ||
      current.realtimePlaying ||
      current.selectedSession?.key == session.key
    ) {
      return
    }
    endRealtimeTalkForNavigation()
    cancelModelLoad()
    invalidateAgentPulse(clearSnapshot = true)
    mutableState.update { it.switchSessionContext(session) }
    loadModels(session)
    loadHistory(session)
    restartAgentPulsePolling(forceLoading = true)
  }

  fun searchSessions(query: String) {
    if (WearProxyCapability.SessionSearchPagination !in mutableState.value.proxyCapabilities) return
    val normalized = query.trim()
    if (normalized.isEmpty()) return
    loadSessionSearch(normalized, offset = 0, append = false)
  }

  fun loadMoreSessionSearch() {
    val current = mutableState.value
    if (WearProxyCapability.SessionSearchPagination !in current.proxyCapabilities) return
    val query = current.sessionSearchQuery ?: return
    val offset = current.sessionSearchNextOffset ?: return
    if (!current.sessionSearchHasMore) return
    loadSessionSearch(query, offset = offset, append = true)
  }

  fun clearSessionSearch() {
    sessionSearchJob?.cancel()
    mutableState.update {
      it.copy(
        sessionSearchQuery = null,
        sessionSearchResults = emptyList(),
        sessionSearchHasMore = false,
        sessionSearchNextOffset = null,
      )
    }
  }

  fun searchModels(query: String) {
    if (WearProxyCapability.ModelCatalogSearch !in mutableState.value.proxyCapabilities) return
    val normalized = query.trim()
    if (normalized.isEmpty()) return
    mutableState.value.selectedSession?.let { session -> loadModels(session, normalized) }
  }

  fun clearModelSearch() {
    cancelModelLoad()
    mutableState.update { it.copy(modelSearchQuery = null, modelSearchResults = emptyList()) }
  }

  fun closeSession() {
    endRealtimeTalkForNavigation()
    cancelModelLoad()
    mutableState.update {
      it.copy(
        selectedSession = null,
        messages = emptyList(),
        streamText = null,
        activeRunId = null,
        selectedModelRef = null,
        realtimeTalk = WearRealtimeTalkSnapshot(),
        talkBusy = false,
        failure = null,
      )
    }
    loadSessions()
  }

  private fun endRealtimeTalkForNavigation() {
    if (talkStartJob?.isActive == true) {
      talkStartJob?.cancel()
      talkStartJob = null
      realtimeTalkClient.disconnectLocal()
    } else if (mutableState.value.realtimeTalk.active) {
      stopRealtimeTalk()
    }
    talkAttemptId = null
  }

  fun startRealtimeTalk() {
    val current = mutableState.value
    val selectedSession = current.selectedSession ?: return
    if (current.talkBusy || current.realtimeTalk.active) return
    val capabilities = current.proxyCapabilities
    val attemptId = "wear-${UUID.randomUUID()}"
    talkAttemptId = attemptId
    val startJob =
      viewModelScope.launch(start = CoroutineStart.LAZY) {
        mutableState.update { it.copy(talkBusy = true, failure = null) }
        try {
          val snapshot =
            realtimeTalkClient.start(
              selectedSession,
              attemptId,
              capabilities,
            )
          if (talkAttemptId != attemptId) return@launch
          mutableState.update { it.copy(realtimeTalk = snapshot, talkBusy = false) }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (talkAttemptId != attemptId) return@launch
          talkAttemptId = null
          mutableState.update {
            it.copy(talkBusy = false, failure = err.toWearConversationFailure())
          }
        } finally {
          if (talkStartJob === coroutineContext[Job]) talkStartJob = null
        }
      }
    talkStartJob = startJob
    startJob.start()
  }

  fun stopRealtimeTalk() {
    if (mutableState.value.talkBusy) return
    val attemptId = talkAttemptId
    viewModelScope.launch {
      mutableState.update { it.copy(talkBusy = true) }
      try {
        val snapshot = realtimeTalkClient.stop()
        if (talkAttemptId != attemptId) return@launch
        if (talkAttemptId == snapshot.attemptId) talkAttemptId = null
        mutableState.update { it.copy(realtimeTalk = snapshot, talkBusy = false) }
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        if (talkAttemptId != attemptId) return@launch
        talkAttemptId = null
        realtimeTalkClient.disconnectLocal()
        mutableState.update {
          it.copy(
            realtimeTalk = WearRealtimeTalkSnapshot(),
            talkBusy = false,
            failure = err.toWearConversationFailure(),
          )
        }
      }
    }
  }

  fun sendReply(text: String) {
    val session = mutableState.value.selectedSession ?: return
    val routeGeneration = phoneRouteGeneration
    val normalized = text.trim()
    if (normalized.isEmpty() || mutableState.value.sending) return
    val attempt = sendAttemptTracker.begin(session.key, normalized, session.phoneNodeId)
    viewModelScope.launch {
      if (!isCurrentSessionAction(session, routeGeneration)) return@launch
      mutableState.update { it.copy(sending = true, failure = null) }
      try {
        repository.send(attempt, requirePreferredPhone = true)
        sendAttemptTracker.markSucceeded(attempt)
        reloadHistoryIfSelected(session, routeGeneration)
      } catch (err: CancellationException) {
        sendAttemptTracker.markAmbiguous(attempt)
        throw err
      } catch (err: Throwable) {
        sendAttemptTracker.markAmbiguous(attempt)
        recordFailureForSession(err, session, routeGeneration)
      } finally {
        mutableState.update { state ->
          if (isCurrentSessionAction(session, routeGeneration, state)) {
            state.copy(sending = false)
          } else {
            state
          }
        }
      }
    }
  }

  fun abort() {
    val current = mutableState.value
    val session = current.selectedSession ?: return
    val routeGeneration = phoneRouteGeneration
    viewModelScope.launch {
      if (!isCurrentSessionAction(session, routeGeneration)) return@launch
      try {
        repository.abort(session.key, current.activeRunId, session.phoneNodeId)
        if (!isCurrentSessionAction(session, routeGeneration)) return@launch
        mutableState.update { it.copy(streamText = null, activeRunId = null, failure = null) }
        reloadHistoryIfSelected(session, routeGeneration)
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForSession(err, session, routeGeneration)
      }
    }
  }

  fun selectAgent(agentId: String) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    val routeGeneration = phoneRouteGeneration
    if (
      current.controlBusy ||
      current.talkBusy ||
      current.realtimeTalk.active ||
      current.realtimeCapturing ||
      current.realtimePlaying ||
      current.activeAgentId == agentId ||
      WearProxyCapability.AgentControls !in current.proxyCapabilities
    ) {
      return
    }
    val controlAction = beginControlAction(phoneNodeId, routeGeneration) ?: return
    viewModelScope.launch {
      try {
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        repository.selectAgent(agentId, phoneNodeId, current.proxyCapabilities)
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        mutableState.update { state ->
          if (isCurrentControlRoute(phoneNodeId, routeGeneration, state)) {
            state.switchAgentContext(agentId)
          } else {
            state
          }
        }
        refresh()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForControlRoute(err, phoneNodeId, routeGeneration, loading = false)
      } finally {
        finishControlAction(controlAction)
      }
    }
  }

  fun selectModel(modelRef: String) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    val session = current.selectedSession ?: return
    val routeGeneration = phoneRouteGeneration
    if (
      current.controlBusy ||
      current.talkBusy ||
      current.realtimeTalk.active ||
      current.realtimeCapturing ||
      current.realtimePlaying ||
      current.selectedModelRef == modelRef ||
      !current.containsModelRef(modelRef) ||
      WearProxyCapability.ModelControls !in current.proxyCapabilities
    ) {
      return
    }
    val controlAction = beginControlAction(phoneNodeId, routeGeneration) ?: return
    viewModelScope.launch {
      try {
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        cancelModelLoad()
        val responseRequest = eventSequenceTracker.beginResponseRequest()
        val selection =
          repository.selectModel(
            sessionKey = session.key,
            modelRef = modelRef,
            phoneNodeId = phoneNodeId,
            capabilities = current.proxyCapabilities,
          )
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        val currentSession = mutableState.value.selectedSession ?: return@launch
        if (!wearSessionRequestIsCurrent(session, currentSession, selection.phoneNodeId)) return@launch
        if (
          !eventSequenceTracker.isResponseCurrent(
            responseRequest,
            selection.eventStreamId,
            selection.eventSequence,
          )
        ) {
          // A response older than the accepted event stream cannot overwrite newer session state.
          loadSessions(selection.phoneNodeId)
          return@launch
        }
        val acceptedModelRef = selection.selectedModelRef
        val updatedSession = currentSession.copy(modelRef = acceptedModelRef)
        mutableState.update { state ->
          if (!isCurrentControlRoute(phoneNodeId, routeGeneration, state)) return@update state
          val selectedSession = state.selectedSession ?: return@update state
          if (!wearSessionRequestIsCurrent(session, selectedSession, selection.phoneNodeId)) return@update state
          state.switchModelContext(acceptedModelRef)
        }
        if (isCurrentControlRoute(phoneNodeId, routeGeneration)) {
          loadModels(updatedSession)
        }
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForControlRoute(err, phoneNodeId, routeGeneration)
      } finally {
        finishControlAction(controlAction)
      }
    }
  }

  fun setGatewayEnabled(enabled: Boolean) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    val routeGeneration = phoneRouteGeneration
    if (
      current.controlBusy ||
      current.connected == enabled ||
      WearProxyCapability.GatewayControls !in current.proxyCapabilities
    ) {
      return
    }
    val controlAction = beginControlAction(phoneNodeId, routeGeneration) ?: return
    viewModelScope.launch {
      try {
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        if (!enabled) {
          talkStartJob?.cancel()
          talkStartJob = null
          talkAttemptId = null
          realtimeTalkClient.disconnectLocal()
        }
        val status = repository.setGatewayEnabled(enabled, phoneNodeId, current.proxyCapabilities)
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        mutableState.update { state ->
          if (!isCurrentControlRoute(phoneNodeId, routeGeneration, state)) {
            state
          } else {
            applyWearGatewayControlStatus(state, status, enabled)
          }
        }
        refresh()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForControlRoute(err, phoneNodeId, routeGeneration, loading = false)
      } finally {
        finishControlAction(controlAction)
      }
    }
  }

  private fun loadSessions(expectedNodeId: String? = null) {
    sessionSearchJob?.cancel()
    invalidateAgentPulse(clearSnapshot = true)
    cancelLoad()
    cancelModelLoad()
    loadJob =
      viewModelScope.launch {
        mutableState.update { it.copy(loading = true, failure = null) }
        try {
          val status = repository.status(expectedNodeId)
          val agentList =
            if (status.connected && WearProxyCapability.AgentControls in status.capabilities) {
              repository.agents(status.phoneNodeId, status.capabilities)
            } else {
              WearAgentList(
                agents = emptyList(),
                eventStreamId = status.eventStreamId,
                eventSequence = status.eventSequence,
                phoneNodeId = status.phoneNodeId,
              )
            }
          val previousSession = mutableState.value.selectedSession
          val sessionList =
            if (status.connected) {
              repository.sessions(
                expectedNodeId = status.phoneNodeId,
                selectedSessionKey = previousSession?.key,
                capabilities = status.capabilities,
              )
            } else {
              WearSessionList(
                sessions = emptyList(),
                eventStreamId = status.eventStreamId,
                eventSequence = status.eventSequence,
                phoneNodeId = status.phoneNodeId,
              )
            }
          val activeSessionKey =
            coherentWearActiveSessionKey(
              statusAgentId = status.activeAgentId,
              statusSessionKey = status.activeSessionKey,
              sessionListAgentId = sessionList.activeAgentId,
            )
          val retainedSession =
            previousSession?.takeIf { previous ->
              sessionList.selectedSessionValid &&
                previous.phoneNodeId == sessionList.phoneNodeId &&
                sessionList.sessions.none { session -> session.key == previous.key }
            }
          val listedSessions = retainedSession?.let { listOf(it) + sessionList.sessions } ?: sessionList.sessions
          val projectedSessions =
            activeSessionKey
              ?.takeIf { activeKey -> listedSessions.none { session -> session.key == activeKey } }
              ?.let { activeKey ->
                listOf(
                  WearSession(
                    key = activeKey,
                    title = null,
                    updatedAt = null,
                    hasActiveRun = false,
                    phoneNodeId = sessionList.phoneNodeId,
                    agentId = sessionList.activeAgentId,
                  ),
                ) + listedSessions
              } ?: listedSessions
          val selectedSession =
            projectedSessions.firstOrNull { session -> session.key == previousSession?.key }
              ?: projectedSessions.firstOrNull { session -> session.key == activeSessionKey }
              ?: projectedSessions.firstOrNull()
          val selectedModelRef =
            selectedSession?.modelRef
              ?: wearSelectedModelRef(selectedSession?.key, activeSessionKey, status.selectedModelRef)
          val modelList =
            if (status.connected && WearProxyCapability.ModelControls in status.capabilities) {
              repository.models(
                expectedNodeId = status.phoneNodeId,
                capabilities = status.capabilities,
                selectedModelRef = selectedModelRef,
              )
            } else {
              WearModelList(
                models = emptyList(),
                eventStreamId = sessionList.eventStreamId,
                eventSequence = sessionList.eventSequence,
                phoneNodeId = sessionList.phoneNodeId,
              )
            }
          if (
            !wearSnapshotSourcesMatch(
              firstPhoneNodeId = sessionList.phoneNodeId,
              firstStreamId = sessionList.eventStreamId,
              secondPhoneNodeId = modelList.phoneNodeId,
              secondStreamId = modelList.eventStreamId,
            )
          ) {
            loadSessions(status.phoneNodeId)
            return@launch
          }
          if (mutableState.value.selectedSession != previousSession) return@launch
          val selectionChanged = selectedSession?.key != previousSession?.key
          val pendingEvents =
            finishSequenceSnapshot(
              // sessions.list owns the state snapshot. models.list is fetched later and cannot
              // cover session or transcript events emitted between the two responses.
              streamId = sessionList.eventStreamId,
              sequence = sessionList.eventSequence,
              sourceNodeId = sessionList.phoneNodeId,
            )
          loadJob = null
          mutableState.update {
            it.copy(
              loading = false,
              connected = status.connected,
              phoneNodeId = status.phoneNodeId,
              agents = agentList.agents,
              activeAgentId =
                sessionList.activeAgentId
                  ?: status.activeAgentId
                  ?: agentList.agents.firstOrNull(WearAgent::selected)?.id,
              selectedModelRef = selectedModelRef,
              models = modelList.models,
              proxyCapabilities = status.capabilities,
              sessions = projectedSessions,
              selectedSession = selectedSession,
              phoneActiveSessionKey = activeSessionKey,
              sessionSearchQuery = null,
              sessionSearchResults = emptyList(),
              sessionSearchHasMore = false,
              sessionSearchNextOffset = null,
              modelSearchQuery = null,
              modelSearchResults = emptyList(),
              messages = if (selectionChanged || !status.connected) emptyList() else it.messages,
              streamText = if (selectionChanged || !status.connected) null else it.streamText,
              activeRunId = if (selectionChanged || !status.connected) null else it.activeRunId,
            )
          }
          pendingEvents.forEach(::handleEvent)
          if (status.connected && selectedSession != null) {
            loadHistory(selectedSession)
          } else {
            restartAgentPulsePolling(forceLoading = true)
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (err is WearProxyException && err.code == "phone_changed") {
            loadJob = null
            reloadForPreferredPhone(nodeId = null)
            return@launch
          }
          mutableState.update {
            it.copy(
              loading = false,
              connected = false,
              phoneNodeId = null,
              agents = emptyList(),
              activeAgentId = null,
              selectedModelRef = null,
              models = emptyList(),
              proxyCapabilities = emptySet(),
              sessions = emptyList(),
              selectedSession = null,
              messages = emptyList(),
              failure = err.toWearConversationFailure(),
            )
          }
          loadJob = null
        }
      }
  }

  private fun loadHistory(
    session: WearSession,
    observedMessage: WearChatMessage? = null,
  ) {
    cancelLoad()
    val loadToken = historyLoadTracker.start(session.key)
    loadJob =
      viewModelScope.launch {
        mutableState.update { it.copy(loading = true, failure = null) }
        try {
          val transcript = repository.history(session.key, session.phoneNodeId)
          val currentSession = mutableState.value.selectedSession ?: return@launch
          if (
            !wearTranscriptRequestIsCurrent(session, currentSession, transcript.phoneNodeId) ||
            !historyLoadTracker.isCurrent(loadToken)
          ) {
            return@launch
          }
          val loadResult = historyLoadTracker.finish(loadToken)
          val loadedSession =
            currentSession.copy(
              phoneNodeId = transcript.phoneNodeId,
              modelRef =
                if (currentSession.modelRef != session.modelRef) {
                  currentSession.modelRef
                } else {
                  transcript.selectedModelRef ?: session.modelRef
                },
            )
          val catalogScopeChanged = wearModelCatalogScopeChanged(currentSession, loadedSession)
          val pendingEvents =
            finishSequenceSnapshot(
              streamId = transcript.eventStreamId,
              sequence = transcript.eventSequence,
              sourceNodeId = transcript.phoneNodeId,
            )
          loadJob = null
          mutableState.update {
            it.copy(
              loading = false,
              connected = true,
              selectedSession = loadedSession,
              selectedModelRef = loadedSession.modelRef,
              models = if (catalogScopeChanged) emptyList() else it.models,
              sessions =
                it.sessions.map { item ->
                  if (item.key == session.key) {
                    item.copy(modelRef = loadedSession.modelRef)
                  } else {
                    item
                  }
                },
              messages =
                observedMessage?.let { message ->
                  mergeObservedMessageIntoSnapshot(transcript.messages, message)
                } ?: transcript.messages,
              streamText =
                loadResult.liveStream?.let { live ->
                  reconcileWearStreamSnapshot(transcript.activeText, live.text, live.complete)
                } ?: transcript.activeText,
              activeRunId = loadResult.liveStream?.runId ?: transcript.activeRunId,
            )
          }
          pendingEvents.forEach(::handleEvent)
          restartAgentPulsePolling(forceLoading = true)
          if (catalogScopeChanged) loadModels(loadedSession)
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          val currentLoad = historyLoadTracker.isCurrent(loadToken)
          if (currentLoad) {
            historyLoadTracker.cancel()
            loadJob = null
          }
          if (currentLoad && err is WearProxyException && err.code == "phone_changed") {
            reloadForPreferredPhone(nodeId = null)
            return@launch
          }
          if (currentLoad && mutableState.value.selectedSession?.key == session.key) {
            recordFailure(err, loading = false)
            restartAgentPulsePolling(forceLoading = true)
          }
        }
      }
  }

  private fun loadSessionSearch(
    query: String,
    offset: Int,
    append: Boolean,
  ) {
    val current = mutableState.value
    if (WearProxyCapability.SessionSearchPagination !in current.proxyCapabilities) return
    val phoneNodeId = current.phoneNodeId ?: return
    if (!current.connected) return
    val routeGeneration = phoneRouteGeneration
    sessionSearchJob?.cancel()
    sessionSearchJob =
      viewModelScope.launch {
        try {
          val result =
            repository.sessions(
              expectedNodeId = phoneNodeId,
              capabilities = current.proxyCapabilities,
              limit = 50,
              offset = offset,
              search = query,
            )
          if (routeGeneration != phoneRouteGeneration || mutableState.value.phoneNodeId != result.phoneNodeId) {
            return@launch
          }
          mutableState.update { state ->
            val results =
              if (append && state.sessionSearchQuery == query) {
                (state.sessionSearchResults + result.sessions).distinctBy(WearSession::key)
              } else {
                result.sessions
              }
            state.copy(
              sessionSearchQuery = query,
              sessionSearchResults = results,
              sessionSearchHasMore = result.hasMore,
              sessionSearchNextOffset = result.nextOffset,
              failure = null,
            )
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          recordFailureForControlRoute(err, phoneNodeId, routeGeneration, loading = false)
        }
      }
  }

  private fun loadModels(
    session: WearSession,
    query: String? = null,
  ) {
    val current = mutableState.value
    val capabilities = current.proxyCapabilities
    if (
      WearProxyCapability.ModelControls !in capabilities ||
      (query != null && WearProxyCapability.ModelCatalogSearch !in capabilities) ||
      !wearSessionRequestIsCurrent(session, current.selectedSession, session.phoneNodeId)
    ) {
      return
    }
    cancelModelLoad()
    val responseRequest = eventSequenceTracker.beginResponseRequest()
    modelLoadJob =
      viewModelScope.launch {
        try {
          val modelList =
            repository.models(
              expectedNodeId = session.phoneNodeId,
              capabilities = capabilities,
              selectedModelRef = session.modelRef,
              query = query,
            )
          val selectedSession = mutableState.value.selectedSession
          if (!wearSessionRequestIsCurrent(session, selectedSession, modelList.phoneNodeId)) return@launch
          if (
            !eventSequenceTracker.isResponseCurrent(
              responseRequest,
              modelList.eventStreamId,
              modelList.eventSequence,
            )
          ) {
            // Rebuild from a canonical snapshot instead of exposing a catalog from an old cursor.
            loadSessions(modelList.phoneNodeId)
            return@launch
          }
          mutableState.update { state ->
            if (!wearSessionRequestIsCurrent(session, state.selectedSession, modelList.phoneNodeId)) {
              state
            } else {
              if (query == null) {
                state.copy(models = modelList.models, modelSearchQuery = null, modelSearchResults = emptyList())
              } else {
                state.copy(modelSearchQuery = query, modelSearchResults = modelList.models)
              }
            }
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          val selectedSession = mutableState.value.selectedSession
          if (wearSessionRequestIsCurrent(session, selectedSession, session.phoneNodeId)) {
            recordFailure(err)
          }
        }
      }
  }

  private fun handleEvent(event: WearInboundEvent) {
    if (eventSourceTracker.changed(event.sourceNodeId)) {
      beginSequenceResync(event, sourceChanged = true)
      return
    }
    when (eventSequenceTracker.accept(event.streamId, event.sequence)) {
      WearSequenceDecision.GapOrReset -> {
        beginSequenceResync(event, sourceChanged = false)
        return
      }
      WearSequenceDecision.AwaitingSnapshot -> {
        resyncEventBuffer.append(event)
        return
      }
      WearSequenceDecision.Accepted -> Unit
    }
    when (event.event) {
      WearEventType.Connection -> handleConnectionEvent(event.payload as? JsonObject)
      WearEventType.Chat -> handleChatEvent(event)
      WearEventType.Resync -> refresh()
      WearEventType.Talk -> {
        val payload = event.payload ?: return
        runCatching { WearRealtimeTalkCodec.decode(payload) }
          .getOrNull()
          ?.let { snapshot ->
            if (!shouldAcceptWearTalkSnapshot(snapshot, talkAttemptId)) return@let
            if (!snapshot.active) {
              talkStartJob?.cancel()
              talkStartJob = null
              talkAttemptId = null
              realtimeTalkClient.disconnectLocal()
            }
            mutableState.update {
              it.copy(
                realtimeTalk = snapshot,
                talkBusy = talkStartJob?.isActive == true,
              )
            }
          }
      }
    }
  }

  private fun beginSequenceResync(
    event: WearInboundEvent,
    sourceChanged: Boolean,
  ) {
    // A source switch or sequence gap invalidates the old phone's live state.
    invalidateAgentPulse(clearSnapshot = true)
    // Buffer this boundary event until the selected phone supplies a watermark.
    eventSequenceTracker.requireSnapshot()
    resyncEventBuffer.start(event)
    if (sourceChanged) {
      // Session keys are phone-local identities. Resolve the new phone's catalog
      // before issuing any history, reply, or abort request against that source.
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
      resetForPhoneRouteChange()
      loadSessions(event.sourceNodeId)
      return
    }
    val selected = mutableState.value.selectedSession
    if (selected != null) {
      mutableState.update { it.copy(streamText = null, activeRunId = null) }
      loadHistory(selected)
    } else {
      mutableState.update { it.copy(streamText = null, activeRunId = null) }
      loadSessions(event.sourceNodeId)
    }
  }

  private fun reloadForPreferredPhone(nodeId: String?) {
    talkStartJob?.cancel()
    talkStartJob = null
    talkAttemptId = null
    realtimeTalkClient.disconnectLocal()
    cancelLoad()
    eventSequenceTracker.requireSnapshot()
    resyncEventBuffer.begin()
    if (nodeId == null) {
      eventSourceTracker.reset()
    } else {
      eventSourceTracker.adopt(nodeId)
    }
    resetForPhoneRouteChange()
    loadSessions(nodeId)
  }

  private fun resetForPhoneRouteChange() {
    invalidateAgentPulse(clearSnapshot = true)
    phoneRouteGeneration += 1
    controlBusyOwner.reset()
    mutableState.update(WearUiState::resetForPhoneChange)
  }

  private fun finishSequenceSnapshot(
    streamId: String?,
    sequence: Long?,
    sourceNodeId: String,
  ): List<WearInboundEvent> {
    eventSourceTracker.adopt(sourceNodeId)
    val pendingEvents = resyncEventBuffer.drainAfterSnapshot(streamId, sequence)
    eventSequenceTracker.adoptSnapshot(streamId, sequence)
    return pendingEvents
  }

  private fun handleConnectionEvent(payload: JsonObject?) {
    cancelLoad()
    val connected = payload.boolean("connected") ?: false
    if (!connected) {
      invalidateAgentPulse(clearSnapshot = true)
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
    }
    mutableState.update {
      it.copy(
        loading = false,
        connected = connected,
        streamText = if (connected) it.streamText else null,
        activeRunId = if (connected) it.activeRunId else null,
        realtimeTalk = if (connected) it.realtimeTalk else WearRealtimeTalkSnapshot(),
        talkBusy = if (connected) it.talkBusy else false,
        failure = wearConversationFailureForConnection(payload),
      )
    }
    if (connected) refresh()
  }

  private fun handleChatEvent(inbound: WearInboundEvent) {
    val event = parseWearChatEvent(inbound.payload) ?: return
    val selected = mutableState.value.selectedSession ?: return
    if (event.sessionKey != selected.key) return
    when (event.state) {
      "delta" -> {
        mutableState.update { current ->
          val projectedText = event.streamText ?: event.message?.text
          val projectedComplete = event.streamTextComplete || event.message != null || event.replace
          val nextText =
            if (projectedText != null) {
              reconcileWearStreamSnapshot(current.streamText, projectedText, projectedComplete)
            } else {
              updateWearStreamText(current = current.streamText, delta = event.deltaText, replace = event.replace)
            }
          historyLoadTracker.observeDelta(
            sessionKey = selected.key,
            text = nextText,
            complete = projectedComplete,
            runId = event.runId,
          )
          current.copy(
            loading = false,
            streamText = nextText,
            activeRunId = event.runId ?: current.activeRunId,
          )
        }
      }
      "final", "aborted", "error" -> {
        val transition = reduceWearTerminalChatEvent(mutableState.value, event)
        if (transition.reloadHistory) cancelLoad()
        mutableState.value = transition.state
        if (transition.reloadHistory) {
          loadHistory(selected, observedMessage = transition.observedMessage)
        }
      }
      else ->
        event.message?.let { message ->
          cancelLoad()
          mutableState.update { it.copy(messages = mergeEventMessage(it.messages, message)) }
          loadHistory(selected, observedMessage = message)
        }
    }
  }

  private fun cancelLoad() {
    historyLoadTracker.cancel()
    loadJob?.cancel()
    loadJob = null
  }

  private fun cancelModelLoad() {
    modelLoadJob?.cancel()
    modelLoadJob = null
    eventSequenceTracker.invalidateResponseRequests()
  }

  private fun restartAgentPulsePolling(forceLoading: Boolean = false) {
    invalidateAgentPulse(clearSnapshot = false)
    val initialState = mutableState.value
    if (!shouldPollAgentPulse(initialState, agentPulseVisible)) {
      mutableState.update {
        it.copy(
          agentPulse = null,
          agentPulseLoading = false,
          agentPulseFailure = null,
        )
      }
      return
    }
    val phoneNodeId = initialState.phoneNodeId ?: return
    val activeAgentId = initialState.activeAgentId
    val selectedSessionKey = initialState.selectedSession?.key
    val routeGeneration = phoneRouteGeneration
    val requestGeneration = agentPulseRequestGeneration
    agentPulsePollJob =
      viewModelScope.launch {
        var showForcedLoading = forceLoading
        try {
          while (
            isCurrentAgentPulseRoute(
              phoneNodeId = phoneNodeId,
              activeAgentId = activeAgentId,
              selectedSessionKey = selectedSessionKey,
              routeGeneration = routeGeneration,
              requestGeneration = requestGeneration,
            )
          ) {
            mutableState.update { state ->
              if (
                isCurrentAgentPulseRoute(
                  phoneNodeId,
                  activeAgentId,
                  selectedSessionKey,
                  routeGeneration,
                  requestGeneration,
                  state,
                )
              ) {
                state.copy(
                  agentPulseLoading = showForcedLoading || state.agentPulse == null,
                  agentPulseFailure = null,
                )
              } else {
                state
              }
            }
            try {
              val responseRequest = eventSequenceTracker.beginReadOnlyResponseRequest()
              val pulse =
                repository.agentPulse(
                  expectedNodeId = phoneNodeId,
                  capabilities = initialState.proxyCapabilities,
                  selectedSessionKey = selectedSessionKey,
                )
              if (
                pulse.phoneNodeId != phoneNodeId ||
                !isCurrentAgentPulseRoute(
                  phoneNodeId,
                  activeAgentId,
                  selectedSessionKey,
                  routeGeneration,
                  requestGeneration,
                )
              ) {
                return@launch
              }
              if (
                !eventSequenceTracker.isReadOnlyResponseCurrent(
                  responseRequest,
                  pulse.eventStreamId,
                  pulse.eventSequence,
                )
              ) {
                // Rebuild from a canonical snapshot instead of exposing an old Phone cursor.
                loadSessions(pulse.phoneNodeId)
                return@launch
              }
              mutableState.update { state ->
                if (
                  isCurrentAgentPulseRoute(
                    phoneNodeId,
                    activeAgentId,
                    selectedSessionKey,
                    routeGeneration,
                    requestGeneration,
                    state,
                  )
                ) {
                  state.copy(
                    agentPulse = pulse,
                    agentPulseLoading = false,
                    agentPulseFailure = null,
                  )
                } else {
                  state
                }
              }
            } catch (err: CancellationException) {
              throw err
            } catch (err: Throwable) {
              if (
                err is WearProxyException &&
                err.code == "phone_changed" &&
                requestGeneration == agentPulseRequestGeneration
              ) {
                reloadForPreferredPhone(nodeId = null)
                return@launch
              }
              mutableState.update { state ->
                if (
                  isCurrentAgentPulseRoute(
                    phoneNodeId,
                    activeAgentId,
                    selectedSessionKey,
                    routeGeneration,
                    requestGeneration,
                    state,
                  )
                ) {
                  state.copy(
                    agentPulse = if (err.isConnectivityFailure()) null else state.agentPulse,
                    agentPulseLoading = false,
                    agentPulseFailure = err.toWearConversationFailure(),
                  )
                } else {
                  state
                }
              }
            }
            showForcedLoading = false
            delay(AGENT_PULSE_POLL_INTERVAL_MS)
          }
        } finally {
          if (agentPulsePollJob === coroutineContext[Job]) agentPulsePollJob = null
        }
      }
  }

  private fun isCurrentAgentPulseRoute(
    phoneNodeId: String,
    activeAgentId: String?,
    selectedSessionKey: String?,
    routeGeneration: Long,
    requestGeneration: Long,
    state: WearUiState = mutableState.value,
  ): Boolean =
    wearAgentPulseRouteIsCurrent(
      requestedPhoneNodeId = phoneNodeId,
      requestedAgentId = activeAgentId,
      requestedSessionKey = selectedSessionKey,
      requestedRouteGeneration = routeGeneration,
      currentRouteGeneration = phoneRouteGeneration,
      requestedGeneration = requestGeneration,
      currentGeneration = agentPulseRequestGeneration,
      pulseVisible = agentPulseVisible,
      state = state,
    )

  private fun invalidateAgentPulse(clearSnapshot: Boolean) {
    agentPulseRequestGeneration += 1
    agentPulsePollJob?.cancel()
    agentPulsePollJob = null
    mutableState.update {
      it.copy(
        agentPulse = if (clearSnapshot) null else it.agentPulse,
        agentPulseLoading = false,
        agentPulseFailure = null,
      )
    }
  }

  private fun reloadHistoryIfSelected(
    session: WearSession,
    routeGeneration: Long,
  ) {
    val current = mutableState.value
    if (!isCurrentSessionAction(session, routeGeneration, current)) return
    val selected = current.selectedSession ?: return
    loadHistory(selected)
  }

  private fun isCurrentSessionAction(
    session: WearSession,
    routeGeneration: Long,
    state: WearUiState = mutableState.value,
  ): Boolean =
    wearSessionActionIsCurrent(
      requestedSession = session,
      currentState = state,
      requestedRouteGeneration = routeGeneration,
      currentRouteGeneration = phoneRouteGeneration,
    )

  private fun isCurrentControlRoute(
    phoneNodeId: String,
    routeGeneration: Long,
    state: WearUiState = mutableState.value,
  ): Boolean =
    wearControlRouteIsCurrent(
      requestedPhoneNodeId = phoneNodeId,
      currentState = state,
      requestedRouteGeneration = routeGeneration,
      currentRouteGeneration = phoneRouteGeneration,
    )

  private fun beginControlAction(
    phoneNodeId: String,
    routeGeneration: Long,
  ): Long? {
    val owner = controlBusyOwner.claim() ?: return null
    while (true) {
      val state = mutableState.value
      if (state.controlBusy || !isCurrentControlRoute(phoneNodeId, routeGeneration, state)) {
        controlBusyOwner.release(owner)
        return null
      }
      if (mutableState.compareAndSet(state, state.copy(controlBusy = true, failure = null))) {
        return owner
      }
    }
  }

  private fun finishControlAction(owner: Long) {
    if (!controlBusyOwner.release(owner)) return
    mutableState.update { state -> state.copy(controlBusy = false) }
  }

  private fun recordFailure(
    error: Throwable,
    loading: Boolean = mutableState.value.loading,
  ) {
    val disconnected = error.isConnectivityFailure()
    if (disconnected) {
      invalidateAgentPulse(clearSnapshot = true)
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
    }
    mutableState.update {
      it.copy(
        loading = loading,
        connected = if (disconnected) false else it.connected,
        streamText = if (disconnected) null else it.streamText,
        activeRunId = if (disconnected) null else it.activeRunId,
        realtimeTalk = if (disconnected) WearRealtimeTalkSnapshot() else it.realtimeTalk,
        talkBusy = if (disconnected) false else it.talkBusy,
        failure = error.toWearConversationFailure(),
      )
    }
  }

  private fun recordFailureForSession(
    error: Throwable,
    session: WearSession,
    routeGeneration: Long,
  ) {
    val current = mutableState.value
    if (routeGeneration != phoneRouteGeneration || current.phoneNodeId != session.phoneNodeId) return
    if (error.isConnectivityFailure() || isCurrentSessionAction(session, routeGeneration, current)) {
      recordFailure(error)
    }
  }

  private fun recordFailureForControlRoute(
    error: Throwable,
    phoneNodeId: String,
    routeGeneration: Long,
    loading: Boolean = mutableState.value.loading,
  ) {
    if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return
    recordFailure(error, loading)
  }

  override fun onCleared() {
    modelLoadJob?.cancel()
    agentPulseVisible = false
    agentPulseRequestGeneration += 1
    agentPulsePollJob?.cancel()
    agentPulsePollJob = null
    talkStartJob?.cancel()
    realtimeTalkClient.shutdown()
  }
}

private const val AGENT_PULSE_POLL_INTERVAL_MS = 15_000L

internal fun shouldPollAgentPulse(
  state: WearUiState,
  pulseVisible: Boolean,
): Boolean =
  pulseVisible &&
    state.connected &&
    !state.phoneNodeId.isNullOrBlank() &&
    WearProxyCapability.AgentPulse in state.proxyCapabilities

internal fun wearAgentPulseRouteIsCurrent(
  requestedPhoneNodeId: String,
  requestedAgentId: String?,
  requestedSessionKey: String?,
  requestedRouteGeneration: Long,
  currentRouteGeneration: Long,
  requestedGeneration: Long,
  currentGeneration: Long,
  pulseVisible: Boolean,
  state: WearUiState,
): Boolean =
  requestedRouteGeneration == currentRouteGeneration &&
    requestedGeneration == currentGeneration &&
    shouldPollAgentPulse(state, pulseVisible) &&
    state.phoneNodeId == requestedPhoneNodeId &&
    state.activeAgentId == requestedAgentId &&
    state.selectedSession?.key == requestedSessionKey

internal fun coherentWearActiveSessionKey(
  statusAgentId: String?,
  statusSessionKey: String?,
  sessionListAgentId: String?,
): String? {
  // A phone-side agent switch can land between status and sessions.list. The
  // later list owns session selection; never attach its agent to a stale key.
  return statusSessionKey.takeIf { sessionListAgentId == null || sessionListAgentId == statusAgentId }
}

internal fun wearSelectedModelRef(
  selectedSessionKey: String?,
  activeSessionKey: String?,
  selectedModelRef: String?,
): String? = selectedModelRef.takeIf { selectedSessionKey != null && selectedSessionKey == activeSessionKey }

internal fun wearModelCatalogScopeChanged(
  requestedSession: WearSession,
  loadedSession: WearSession,
): Boolean =
  loadedSession.phoneNodeId != requestedSession.phoneNodeId ||
    loadedSession.modelRef != requestedSession.modelRef

internal fun wearSessionRequestIsCurrent(
  requestedSession: WearSession,
  currentSession: WearSession?,
  responsePhoneNodeId: String,
): Boolean =
  currentSession?.key == requestedSession.key &&
    currentSession.phoneNodeId == requestedSession.phoneNodeId &&
    responsePhoneNodeId == requestedSession.phoneNodeId &&
    currentSession.modelRef == requestedSession.modelRef

internal fun wearTranscriptRequestIsCurrent(
  requestedSession: WearSession,
  currentSession: WearSession?,
  responsePhoneNodeId: String,
): Boolean =
  currentSession?.key == requestedSession.key &&
    currentSession.phoneNodeId == requestedSession.phoneNodeId &&
    responsePhoneNodeId == requestedSession.phoneNodeId

internal fun wearSessionActionIsCurrent(
  requestedSession: WearSession,
  currentState: WearUiState,
  requestedRouteGeneration: Long,
  currentRouteGeneration: Long,
): Boolean =
  requestedRouteGeneration == currentRouteGeneration &&
    currentState.phoneNodeId == requestedSession.phoneNodeId &&
    wearTranscriptRequestIsCurrent(
      requestedSession,
      currentState.selectedSession,
      requestedSession.phoneNodeId,
    )

internal fun wearControlRouteIsCurrent(
  requestedPhoneNodeId: String,
  currentState: WearUiState,
  requestedRouteGeneration: Long,
  currentRouteGeneration: Long,
): Boolean =
  requestedRouteGeneration == currentRouteGeneration &&
    currentState.phoneNodeId == requestedPhoneNodeId

internal class WearControlBusyOwner {
  private var nextOwner = 0L
  private var activeOwner: Long? = null

  fun claim(): Long? {
    if (activeOwner != null) return null
    nextOwner += 1
    return nextOwner.also { owner -> activeOwner = owner }
  }

  fun release(owner: Long): Boolean {
    if (activeOwner != owner) return false
    activeOwner = null
    return true
  }

  fun reset() {
    activeOwner = null
  }
}

internal fun applyWearGatewayControlStatus(
  state: WearUiState,
  status: WearProxyStatus,
  enabled: Boolean,
): WearUiState =
  state.copy(
    connected = status.connected,
    phoneNodeId = status.phoneNodeId,
    activeAgentId = status.activeAgentId ?: state.activeAgentId,
    selectedModelRef =
      wearSelectedModelRef(
        state.selectedSession?.key,
        status.activeSessionKey,
        status.selectedModelRef ?: state.selectedModelRef,
      ),
    proxyCapabilities = status.capabilities,
    realtimeTalk = if (enabled) state.realtimeTalk else WearRealtimeTalkSnapshot(),
  )

internal fun wearSnapshotSourcesMatch(
  firstPhoneNodeId: String,
  firstStreamId: String?,
  secondPhoneNodeId: String,
  secondStreamId: String?,
): Boolean = firstPhoneNodeId == secondPhoneNodeId && firstStreamId == secondStreamId

internal fun mergeEventMessage(
  messages: List<WearChatMessage>,
  message: WearChatMessage,
): List<WearChatMessage> {
  val matchIndex =
    messages.indexOfFirst { existing ->
      when {
        message.id != null -> existing.id == message.id
        message.timestamp != null ->
          existing.id == null &&
            existing.timestamp == message.timestamp &&
            existing.role == message.role
        else -> false
      }
    }
  val merged =
    if (matchIndex >= 0) {
      messages.toMutableList().also { it[matchIndex] = message }
    } else {
      messages + message
    }
  return merged.takeLast(MAX_TRANSCRIPT_MESSAGES)
}

internal fun mergeObservedMessageIntoSnapshot(
  messages: List<WearChatMessage>,
  message: WearChatMessage,
): List<WearChatMessage> {
  val canonicalTail = messages.lastOrNull()
  if (
    message.id == null &&
    canonicalTail != null &&
    canonicalTail.role == message.role &&
    canonicalTail.text == message.text &&
    (message.timestamp == null || canonicalTail.timestamp == message.timestamp)
  ) {
    // History is authoritative after a final event. A matching tail may have
    // gained an ID that the event lacked; appending it would duplicate the reply.
    return messages.takeLast(MAX_TRANSCRIPT_MESSAGES)
  }
  return mergeEventMessage(messages, message)
}

internal fun updateWearStreamText(
  current: String?,
  delta: String?,
  replace: Boolean,
): String? {
  val next = if (replace) delta else current.orEmpty() + delta.orEmpty()
  if (next.isNullOrEmpty()) return next
  val codePointCount = next.codePointCount(0, next.length)
  if (codePointCount <= MAX_STREAM_CODE_POINTS) return next
  val start = next.offsetByCodePoints(0, codePointCount - MAX_STREAM_CODE_POINTS)
  return next.substring(start)
}

internal data class WearLiveStreamSnapshot(
  val text: String?,
  val complete: Boolean,
  val runId: String?,
)

internal fun reconcileWearStreamSnapshot(
  snapshot: String?,
  live: String?,
  liveComplete: Boolean,
): String? {
  if (live.isNullOrEmpty()) return snapshot
  if (snapshot.isNullOrEmpty()) return live
  val merged =
    if (liveComplete) {
      when {
        live.startsWith(snapshot) -> live
        snapshot.startsWith(live) -> snapshot
        else -> live
      }
    } else {
      if (snapshot.startsWith(live)) {
        snapshot
      } else {
        val maxOverlap = minOf(snapshot.length, live.length)
        val overlap =
          (maxOverlap downTo 1).firstOrNull { count ->
            snapshot.hasCodePointBoundary(snapshot.length - count) &&
              live.hasCodePointBoundary(count) &&
              snapshot.endsWith(live.take(count))
          } ?: 0
        snapshot + live.drop(overlap)
      }
    }
  return updateWearStreamText(current = null, delta = merged, replace = true)
}

private fun String.hasCodePointBoundary(index: Int): Boolean = index <= 0 || index >= length || !(this[index - 1].isHighSurrogate() && this[index].isLowSurrogate())

internal data class WearHistoryLoadResult(
  val liveStream: WearLiveStreamSnapshot?,
)

internal class WearHistoryLoadTracker {
  private var generation = 0L
  private var sessionKey: String? = null
  private var liveStream: WearLiveStreamSnapshot? = null

  fun start(sessionKey: String): Long {
    generation += 1
    this.sessionKey = sessionKey
    liveStream = null
    return generation
  }

  fun cancel() {
    generation += 1
    sessionKey = null
    liveStream = null
  }

  fun observeDelta(
    sessionKey: String,
    text: String?,
    complete: Boolean,
    runId: String?,
  ) {
    if (this.sessionKey == sessionKey) {
      liveStream = WearLiveStreamSnapshot(text = text, complete = complete, runId = runId)
    }
  }

  fun isCurrent(token: Long): Boolean = token == generation && sessionKey != null

  fun finish(
    token: Long,
  ): WearHistoryLoadResult {
    if (!isCurrent(token)) return WearHistoryLoadResult(liveStream = null)
    val result = WearHistoryLoadResult(liveStream)
    sessionKey = null
    liveStream = null
    return result
  }
}

internal fun Throwable.toWearConversationFailure(): WearConversationFailure =
  when ((this as? WearProxyException)?.code) {
    "phone_unavailable", "unavailable", "timeout" -> WearConversationFailure.PHONE_UNAVAILABLE
    "unsupported_peer" -> WearConversationFailure.INCOMPATIBLE
    "not_found", "selection_not_found" -> WearConversationFailure.NOT_FOUND
    "action_rejected", "rejected" -> WearConversationFailure.ACTION_REJECTED
    else -> WearConversationFailure.INTERNAL_ERROR
  }

internal fun wearConversationFailureForConnection(payload: JsonObject?): WearConversationFailure? {
  if (payload.boolean("connected") == true) return null
  return when (WearConnectionFailure.fromWireValue(payload.string("failure"))) {
    WearConnectionFailure.Incompatible -> WearConversationFailure.INCOMPATIBLE
    WearConnectionFailure.GatewayOffline -> WearConversationFailure.GATEWAY_OFFLINE
    null ->
      if (payload.string("status")?.contains("update", ignoreCase = true) == true) {
        // Older protocol-v1 phones only sent status text for incompatibility.
        WearConversationFailure.INCOMPATIBLE
      } else {
        WearConversationFailure.GATEWAY_OFFLINE
      }
  }
}

private fun Throwable.isConnectivityFailure(): Boolean = this is WearProxyException && code in setOf("phone_unavailable", "unavailable", "timeout")

private fun JsonObject?.string(name: String): String? = (this?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject?.boolean(name: String): Boolean? = (this?.get(name) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private const val MAX_TRANSCRIPT_MESSAGES = 20
private const val MAX_STREAM_CODE_POINTS = 2_000
