package ai.openclaw.wear

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
  val status: String = "Checking phone",
  val phoneNodeId: String? = null,
  val agents: List<WearAgent> = emptyList(),
  val activeAgentId: String? = null,
  val selectedModelRef: String? = null,
  val proxyCapabilities: Set<WearProxyCapability> = emptySet(),
  val sessions: List<WearSession> = emptyList(),
  val selectedSession: WearSession? = null,
  val messages: List<WearChatMessage> = emptyList(),
  val streamText: String? = null,
  val activeRunId: String? = null,
  val sending: Boolean = false,
  val realtimeTalk: WearRealtimeTalkSnapshot = WearRealtimeTalkSnapshot(),
  val realtimeCapturing: Boolean = false,
  val realtimePlaying: Boolean = false,
  val realtimePlaybackFailed: Boolean = false,
  val talkBusy: Boolean = false,
  val controlBusy: Boolean = false,
  val error: String? = null,
)

internal fun WearUiState.resetForPhoneChange(): WearUiState =
  copy(
    loading = true,
    connected = false,
    status = "Checking phone",
    phoneNodeId = null,
    agents = emptyList(),
    activeAgentId = null,
    selectedModelRef = null,
    proxyCapabilities = emptySet(),
    sessions = emptyList(),
    selectedSession = null,
    messages = emptyList(),
    streamText = null,
    activeRunId = null,
    realtimeTalk = WearRealtimeTalkSnapshot(),
    realtimeCapturing = false,
    realtimePlaying = false,
    realtimePlaybackFailed = false,
    talkBusy = false,
    controlBusy = false,
    error = null,
  )

internal fun shouldAcceptWearTalkSnapshot(
  snapshot: WearRealtimeTalkSnapshot,
  attemptId: String?,
): Boolean = snapshot.attemptId != null && snapshot.attemptId == attemptId

internal class WearViewModel(
  application: Application,
) : AndroidViewModel(application) {
  private val app = application as WearApplication
  private val repository = app.gatewayRepository
  private val realtimeTalkClient = app.realtimeTalkClient
  private val mutableState = MutableStateFlow(WearUiState())
  private val eventSequenceTracker = WearEventSequenceTracker()
  private val eventSourceTracker = WearEventSourceTracker()
  private val resyncEventBuffer = WearEventResyncBuffer()
  private val historyLoadTracker = WearHistoryLoadTracker()
  private val sendAttemptTracker = WearSendAttemptTracker()
  private var loadJob: Job? = null
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
              talkBusy = false,
              error = "Watch audio link disconnected",
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
    refresh()
  }

  fun refresh() {
    loadSessions()
  }

  fun openSession(session: WearSession) {
    endRealtimeTalkForNavigation()
    mutableState.update {
      it.copy(
        selectedSession = session,
        messages = emptyList(),
        streamText = null,
        activeRunId = null,
        selectedModelRef = null,
        realtimeTalk = WearRealtimeTalkSnapshot(),
        talkBusy = false,
        error = null,
      )
    }
    loadHistory(session)
  }

  fun closeSession() {
    endRealtimeTalkForNavigation()
    mutableState.update {
      it.copy(
        selectedSession = null,
        messages = emptyList(),
        streamText = null,
        activeRunId = null,
        selectedModelRef = null,
        realtimeTalk = WearRealtimeTalkSnapshot(),
        talkBusy = false,
        error = null,
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
    val selectedSession = mutableState.value.selectedSession ?: return
    if (mutableState.value.talkBusy || mutableState.value.realtimeTalk.active) return
    val attemptId = "wear-${UUID.randomUUID()}"
    talkAttemptId = attemptId
    val startJob =
      viewModelScope.launch(start = CoroutineStart.LAZY) {
        mutableState.update { it.copy(talkBusy = true, error = null) }
        try {
          val snapshot = realtimeTalkClient.start(selectedSession, attemptId)
          if (talkAttemptId != attemptId) return@launch
          mutableState.update { it.copy(realtimeTalk = snapshot, talkBusy = false) }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (talkAttemptId != attemptId) return@launch
          talkAttemptId = null
          mutableState.update { it.copy(talkBusy = false, error = err.userMessage()) }
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
          it.copy(realtimeTalk = WearRealtimeTalkSnapshot(), talkBusy = false, error = err.userMessage())
        }
      }
    }
  }

  fun sendReply(text: String) {
    val session = mutableState.value.selectedSession ?: return
    val normalized = text.trim()
    if (normalized.isEmpty() || mutableState.value.sending) return
    val attempt = sendAttemptTracker.begin(session.key, normalized, session.phoneNodeId)
    viewModelScope.launch {
      mutableState.update { it.copy(sending = true, error = null) }
      try {
        repository.send(attempt, requirePreferredPhone = true)
        sendAttemptTracker.markSucceeded(attempt)
        reloadHistoryIfSelected(session.key)
      } catch (err: CancellationException) {
        sendAttemptTracker.markAmbiguous(attempt)
        throw err
      } catch (err: Throwable) {
        sendAttemptTracker.markAmbiguous(attempt)
        recordFailureForSession(err, session.key)
      } finally {
        mutableState.update { it.copy(sending = false) }
      }
    }
  }

  fun abort() {
    val current = mutableState.value
    val session = current.selectedSession ?: return
    viewModelScope.launch {
      try {
        repository.abort(session.key, current.activeRunId, session.phoneNodeId)
        if (mutableState.value.selectedSession?.key != session.key) return@launch
        mutableState.update { it.copy(streamText = null, activeRunId = null, error = null) }
        reloadHistoryIfSelected(session.key)
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForSession(err, session.key)
      }
    }
  }

  fun selectAgent(agentId: String) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
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
    viewModelScope.launch {
      mutableState.update { it.copy(controlBusy = true, error = null) }
      try {
        repository.selectAgent(agentId, phoneNodeId, current.proxyCapabilities)
        mutableState.update {
          it.copy(
            activeAgentId = agentId,
            sessions = emptyList(),
            selectedSession = null,
            messages = emptyList(),
            streamText = null,
            activeRunId = null,
            selectedModelRef = null,
          )
        }
        refresh()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailure(err, loading = false)
      } finally {
        mutableState.update { it.copy(controlBusy = false) }
      }
    }
  }

  fun setGatewayEnabled(enabled: Boolean) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    if (
      current.controlBusy ||
      current.connected == enabled ||
      WearProxyCapability.GatewayControls !in current.proxyCapabilities
    ) {
      return
    }
    viewModelScope.launch {
      mutableState.update { it.copy(controlBusy = true, error = null) }
      try {
        if (!enabled) {
          talkStartJob?.cancel()
          talkStartJob = null
          talkAttemptId = null
          realtimeTalkClient.disconnectLocal()
        }
        val status = repository.setGatewayEnabled(enabled, phoneNodeId, current.proxyCapabilities)
        mutableState.update {
          it.copy(
            connected = status.connected,
            status = status.detail,
            phoneNodeId = status.phoneNodeId,
            activeAgentId = status.activeAgentId ?: it.activeAgentId,
            selectedModelRef =
              wearSelectedModelRef(
                it.selectedSession?.key,
                status.activeSessionKey,
                status.selectedModelRef ?: it.selectedModelRef,
              ),
            proxyCapabilities = status.capabilities,
            realtimeTalk = if (enabled) it.realtimeTalk else WearRealtimeTalkSnapshot(),
          )
        }
        refresh()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailure(err, loading = false)
      } finally {
        mutableState.update { it.copy(controlBusy = false) }
      }
    }
  }

  private fun loadSessions(expectedNodeId: String? = null) {
    cancelLoad()
    loadJob =
      viewModelScope.launch {
        mutableState.update { it.copy(loading = true, error = null) }
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
          if (mutableState.value.selectedSession?.key != previousSession?.key) return@launch
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
                    title = "Current session",
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
          val selectionChanged = selectedSession?.key != previousSession?.key
          val pendingEvents =
            finishSequenceSnapshot(
              streamId = sessionList.eventStreamId,
              sequence = sessionList.eventSequence,
              sourceNodeId = sessionList.phoneNodeId,
            )
          loadJob = null
          mutableState.update {
            it.copy(
              loading = false,
              connected = status.connected,
              status = status.detail,
              phoneNodeId = status.phoneNodeId,
              agents = agentList.agents,
              activeAgentId =
                sessionList.activeAgentId
                  ?: status.activeAgentId
                  ?: agentList.agents.firstOrNull(WearAgent::selected)?.id,
              selectedModelRef = wearSelectedModelRef(selectedSession?.key, activeSessionKey, status.selectedModelRef),
              proxyCapabilities = status.capabilities,
              sessions = projectedSessions,
              selectedSession = selectedSession,
              messages = if (selectionChanged || !status.connected) emptyList() else it.messages,
              streamText = if (selectionChanged || !status.connected) null else it.streamText,
              activeRunId = if (selectionChanged || !status.connected) null else it.activeRunId,
            )
          }
          pendingEvents.forEach(::handleEvent)
          if (status.connected && selectedSession != null) {
            loadHistory(selectedSession)
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
              status = "Phone unavailable",
              phoneNodeId = null,
              agents = emptyList(),
              activeAgentId = null,
              selectedModelRef = null,
              proxyCapabilities = emptySet(),
              sessions = emptyList(),
              selectedSession = null,
              messages = emptyList(),
              error = err.userMessage(),
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
        mutableState.update { it.copy(loading = true, error = null) }
        try {
          val transcript = repository.history(session.key, session.phoneNodeId)
          if (
            mutableState.value.selectedSession?.key != session.key ||
            !historyLoadTracker.isCurrent(loadToken)
          ) {
            return@launch
          }
          val loadResult = historyLoadTracker.finish(loadToken)
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
              selectedSession = session.copy(phoneNodeId = transcript.phoneNodeId),
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
      mutableState.update { it.resetForPhoneChange() }
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
    mutableState.update(WearUiState::resetForPhoneChange)
    loadSessions(nodeId)
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
    val status = payload.string("status") ?: if (connected) "Connected" else "Gateway offline"
    if (!connected) {
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
    }
    mutableState.update {
      it.copy(
        loading = false,
        connected = connected,
        status = status,
        streamText = if (connected) it.streamText else null,
        activeRunId = if (connected) it.activeRunId else null,
        realtimeTalk = if (connected) it.realtimeTalk else WearRealtimeTalkSnapshot(),
        talkBusy = if (connected) it.talkBusy else false,
        error = if (connected) null else status,
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
      "final" -> {
        cancelLoad()
        mutableState.update { current ->
          current.copy(
            messages = event.message?.let { mergeEventMessage(current.messages, it) } ?: current.messages,
            streamText = if (event.message == null) current.streamText else null,
            activeRunId = null,
          )
        }
        loadHistory(selected, observedMessage = event.message)
      }
      "aborted", "error" -> {
        cancelLoad()
        mutableState.update { it.copy(streamText = null, activeRunId = null) }
        loadHistory(selected)
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

  private fun reloadHistoryIfSelected(sessionKey: String) {
    val selected = mutableState.value.selectedSession?.takeIf { it.key == sessionKey } ?: return
    loadHistory(selected)
  }

  private fun recordFailure(
    error: Throwable,
    loading: Boolean = mutableState.value.loading,
  ) {
    val message = error.userMessage()
    val disconnected = error.isConnectivityFailure()
    if (disconnected) {
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
    }
    mutableState.update {
      it.copy(
        loading = loading,
        connected = if (disconnected) false else it.connected,
        status = if (disconnected) message else it.status,
        streamText = if (disconnected) null else it.streamText,
        activeRunId = if (disconnected) null else it.activeRunId,
        realtimeTalk = if (disconnected) WearRealtimeTalkSnapshot() else it.realtimeTalk,
        talkBusy = if (disconnected) false else it.talkBusy,
        error = message,
      )
    }
  }

  private fun recordFailureForSession(
    error: Throwable,
    sessionKey: String,
  ) {
    if (error.isConnectivityFailure() || mutableState.value.selectedSession?.key == sessionKey) {
      recordFailure(error)
    }
  }

  override fun onCleared() {
    talkStartJob?.cancel()
    realtimeTalkClient.shutdown()
  }
}

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

private fun Throwable.userMessage(): String =
  when (this) {
    is WearProxyException -> message
    else -> "Phone proxy unavailable"
  }

private fun Throwable.isConnectivityFailure(): Boolean = this is WearProxyException && code in setOf("phone_unavailable", "unavailable", "timeout")

private fun JsonObject?.string(name: String): String? = (this?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject?.boolean(name: String): Boolean? = (this?.get(name) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private const val MAX_TRANSCRIPT_MESSAGES = 20
private const val MAX_STREAM_CODE_POINTS = 2_000
