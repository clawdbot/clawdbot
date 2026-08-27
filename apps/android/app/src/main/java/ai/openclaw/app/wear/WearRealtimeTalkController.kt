package ai.openclaw.app.wear

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import ai.openclaw.app.voice.RealtimeAgentCoordinator
import ai.openclaw.app.voice.RealtimeAgentSession
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeAudioFrameType
import ai.openclaw.wear.shared.WearRealtimeTalkEntry
import ai.openclaw.wear.shared.WearRealtimeTalkRole
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

private data class WearRealtimeOutputMessage(
  val type: WearRealtimeAudioFrameType,
  val payload: ByteArray,
)

private class WearRealtimeOutputQueue(
  val messages: Channel<WearRealtimeOutputMessage>,
  var retainedAudioBytes: Int = 0,
)

private data class WearRealtimeAttemptKey(
  val nodeId: String,
  val attemptId: String,
)

internal fun chunkWearRealtimeOutput(
  payload: ByteArray,
  maxFrameBytes: Int = WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES,
): List<ByteArray> {
  require(maxFrameBytes > 0 && maxFrameBytes % PCM_16_BYTES == 0)
  require(payload.size % PCM_16_BYTES == 0)
  if (payload.isEmpty()) return emptyList()
  return buildList {
    var offset = 0
    while (offset < payload.size) {
      val end = minOf(offset + maxFrameBytes, payload.size)
      add(payload.copyOfRange(offset, end))
      offset = end
    }
  }
}

internal fun advanceWearRealtimePlaybackDeadline(
  currentEndsAtMillis: Long,
  deliveredAtMillis: Long,
  audioByteCount: Int,
): Long {
  require(audioByteCount >= 0 && audioByteCount % PCM_16_BYTES == 0)
  val sampleCount = audioByteCount / PCM_16_BYTES
  val durationMillis =
    (
      sampleCount *
        1_000L /
        WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ
    ).coerceAtLeast(1L)
  return maxOf(deliveredAtMillis, currentEndsAtMillis) + durationMillis
}

internal class WearRealtimeTalkController(
  private val scope: CoroutineScope,
  private val isConnected: () -> Boolean,
  private val requestGateway: suspend (method: String, paramsJson: String?, timeoutMs: Long) -> String,
  private val sendGatewayFrame:
    suspend (
      method: String,
      paramsJson: String?,
      timeoutMs: Long,
      onError: (String) -> Unit,
    ) -> Unit,
  private val sendWatchFrame:
    suspend (
      owner: WearRealtimeAttemptOwner,
      type: WearRealtimeAudioFrameType,
      payload: ByteArray,
    ) -> Unit,
  private val onSnapshot: (WearRealtimeTalkSnapshot) -> Unit = {},
  private val onForceCloseWatchChannel: (WearRealtimeAttemptOwner) -> Unit = {},
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val lifecycleMutex = Mutex()
  private val lifecycleStateLock = Any()
  private val lifecycleGeneration = AtomicLong()
  private val canceledAttempts = LinkedHashSet<WearRealtimeAttemptKey>()
  private val _snapshot = MutableStateFlow(WearRealtimeTalkSnapshot())
  val snapshot: StateFlow<WearRealtimeTalkSnapshot> = _snapshot

  @Volatile private var sessionId: String? = null

  @Volatile private var activeOwner: WearRealtimeAttemptOwner? = null

  @Volatile private var ownerSessionKey: String? = null

  private var audioFrames: Channel<ByteArray>? = null
  private var appendJob: Job? = null
  private val outputQueueLock = Any()
  private var outputQueue: WearRealtimeOutputQueue? = null
  private var outputJob: Job? = null
  private var playbackIdleJob: Job? = null
  private var eventDispatchScope: CoroutineScope? = null

  private var playbackEndsAtMillis = 0L
  private var userEntryId: String? = null
  private var assistantEntryId: String? = null
  private val realtimeAgentCoordinator =
    RealtimeAgentCoordinator(
      parentScope = scope,
      requestGateway = requestGateway,
      onWorking = { activeSession ->
        synchronized(lifecycleStateLock) {
          if (sessionId == activeSession.relaySessionId) {
            updateState(
              active = true,
              listening = false,
              speaking = false,
              status = WearRealtimeTalkStatus.THINKING,
              statusText = "Agent working",
            )
          }
        }
      },
      onError = { _, message -> Log.w(TAG, message) },
    )

  suspend fun start(
    owner: WearRealtimeAttemptOwner,
    sessionKey: String,
    language: String?,
    onSessionActivated: () -> Unit = {},
  ): Boolean =
    lifecycleMutex.withLock {
      var existingSession = false
      val startGeneration =
        synchronized(lifecycleStateLock) {
          if (!isConnected()) return@withLock false
          if (WearRealtimeAttemptKey(owner.nodeId, owner.attemptId) in canceledAttempts) {
            return@withLock false
          }
          if (sessionId != null) {
            if (activeOwner != owner || ownerSessionKey != sessionKey) {
              return@withLock false
            }
            existingSession = true
            return@synchronized lifecycleGeneration.get()
          }

          activeOwner = owner
          ownerSessionKey = sessionKey
          val generation = lifecycleGeneration.get()
          updateState(
            active = true,
            listening = false,
            speaking = false,
            status = WearRealtimeTalkStatus.CONNECTING,
            statusText = "Connecting…",
          )
          generation
        }
      if (existingSession) {
        onSessionActivated()
        return@withLock true
      }

      fun startIsStale(): Boolean =
        startGeneration != lifecycleGeneration.get() ||
          !isConnected() ||
          activeOwner != owner ||
          ownerSessionKey != sessionKey

      val payload =
        try {
          requestRealtimeSession(sessionKey, language)
        } catch (err: Throwable) {
          synchronized(lifecycleStateLock) {
            if (!startIsStale()) fail(err.message ?: "Unable to start Real-Time Talk", expectedOwner = owner)
          }
          return@withLock false
        }
      val root =
        runCatching { json.parseToJsonElement(payload).asObjectOrNull() }
          .getOrNull()
      val createdSessionId =
        root
          ?.get("relaySessionId")
          .asStringOrNull()
          ?: root
            ?.get("sessionId")
            .asStringOrNull()
      // The state lock makes activation linearizable with abort(): either Talk commits first and
      // abort tears it down, or abort wins and the late relay is closed without resurrection.
      val activated =
        synchronized(lifecycleStateLock) {
          if (startIsStale()) {
            if (activeOwner == owner) resetLocked()
            false
          } else if (createdSessionId.isNullOrBlank()) {
            fail("Real-Time Talk returned no session", expectedOwner = owner)
            false
          } else {
            realtimeAgentCoordinator.beginSession(
              RealtimeAgentSession(
                relaySessionId = createdSessionId,
                sessionKey = sessionKey,
              ),
            )
            sessionId = createdSessionId
            eventDispatchScope?.cancel()
            eventDispatchScope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
            startOutputLoop(owner, createdSessionId)
            startAppendLoop(owner, createdSessionId)
            updateState(
              active = true,
              listening = true,
              speaking = false,
              status = WearRealtimeTalkStatus.LISTENING,
              statusText = "Listening",
            )
            true
          }
        }
      if (!activated) {
        if (!createdSessionId.isNullOrBlank()) {
          runCatching {
            val params = buildJsonObject { put("sessionId", JsonPrimitive(createdSessionId)) }
            requestGateway("talk.session.close", params.toString(), 5_000L)
          }
        }
        return@withLock false
      }
      onSessionActivated()
      true
    }

  private suspend fun requestRealtimeSession(
    sessionKey: String,
    language: String?,
  ): String {
    try {
      return requestGateway(
        "talk.session.create",
        buildSessionCreateParams(sessionKey, language).toString(),
        SESSION_CREATE_TIMEOUT_MILLIS,
      )
    } catch (err: GatewayRequestRejected) {
      if (language != null && err.gatewayError.isUnsupportedSessionLanguageParam()) {
        return requestGateway(
          "talk.session.create",
          buildSessionCreateParams(sessionKey, language = null).toString(),
          SESSION_CREATE_TIMEOUT_MILLIS,
        )
      }
      throw err
    }
  }

  private fun buildSessionCreateParams(
    sessionKey: String,
    language: String?,
  ) = buildJsonObject {
    put("sessionKey", JsonPrimitive(sessionKey))
    put("mode", JsonPrimitive("realtime"))
    put("transport", JsonPrimitive("gateway-relay"))
    put("brain", JsonPrimitive("agent-consult"))
    if (language != null) {
      put("language", JsonPrimitive(language))
    }
  }

  suspend fun stop(
    nodeId: String? = null,
    attemptId: String? = null,
  ): Boolean =
    lifecycleMutex.withLock {
      var accepted = false
      val closingSession =
        synchronized(lifecycleStateLock) {
          if (nodeId != null && attemptId != null) rememberCanceledAttemptLocked(nodeId, attemptId)
          val owner = activeOwner
          val identityMatches =
            when {
              owner != null ->
                (nodeId == null || owner.nodeId == nodeId) &&
                  (attemptId == null || owner.attemptId == attemptId)
              nodeId != null && attemptId != null -> true
              nodeId == null && attemptId == null -> true
              else -> false
            }
          if (!identityMatches) {
            null
          } else {
            accepted = true
            sessionId.also { resetLocked() }
          }
        }
      if (!accepted) return@withLock false
      if (!closingSession.isNullOrBlank()) {
        runCatching { closeGatewaySession(closingSession) }
      }
      true
    }

  suspend fun stop(owner: WearRealtimeAttemptOwner): Boolean =
    lifecycleMutex.withLock {
      val closingSession =
        synchronized(lifecycleStateLock) {
          if (activeOwner != owner) return@withLock false
          sessionId.also { resetLocked() }
        }
      if (!closingSession.isNullOrBlank()) {
        scope.launch { runCatching { closeGatewaySession(closingSession) } }
      }
      true
    }

  private fun rememberCanceledAttemptLocked(
    nodeId: String,
    attemptId: String,
  ) {
    // A canceled request may overtake its in-flight start on Data Layer.
    // Keep a bounded tombstone so a late start cannot resurrect the relay.
    canceledAttempts += WearRealtimeAttemptKey(nodeId, attemptId)
    while (canceledAttempts.size > MAX_CANCELED_ATTEMPTS) {
      canceledAttempts.remove(canceledAttempts.iterator().next())
    }
  }

  fun abort() {
    val closingOwner =
      synchronized(lifecycleStateLock) {
        lifecycleGeneration.incrementAndGet()
        val owner = activeOwner
        resetLocked()
        owner
      }
    closingOwner?.let(onForceCloseWatchChannel)
  }

  private fun abort(
    expectedOwner: WearRealtimeAttemptOwner?,
    expectedSessionId: String?,
  ) {
    val closingOwner =
      synchronized(lifecycleStateLock) {
        if (expectedOwner != null && activeOwner != expectedOwner) return
        if (expectedSessionId != null && sessionId != expectedSessionId) return
        lifecycleGeneration.incrementAndGet()
        val owner = activeOwner
        resetLocked()
        owner
      }
    closingOwner?.let(onForceCloseWatchChannel)
  }

  fun appendAudio(
    owner: WearRealtimeAttemptOwner,
    payload: ByteArray,
  ) {
    if (
      payload.isEmpty() ||
      payload.size > WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES ||
      activeOwner != owner ||
      sessionId == null ||
      _snapshot.value.speaking
    ) {
      return
    }
    val activeSessionId = sessionId ?: return
    if (audioFrames?.trySend(payload.copyOf())?.isSuccess != true) {
      fail(
        "Watch audio input is unavailable",
        expectedOwner = owner,
        expectedSessionId = activeSessionId,
      )
    }
  }

  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (payloadJson.isNullOrBlank()) return
    val obj =
      runCatching { json.parseToJsonElement(payloadJson).asObjectOrNull() }
        .getOrNull()
        ?: return
    if (event == "chat") {
      handleChatEvent(obj)
      return
    }
    if (event != "talk.event") return
    val eventSessionId =
      obj["relaySessionId"].asStringOrNull()
        ?: obj["sessionId"].asStringOrNull()
    // The gateway creates every relaySessionId with randomUUID(); it is the canonical
    // correlation token for rejecting events from a retired session.
    val (owner, currentSessionId) =
      synchronized(lifecycleStateLock) {
        val currentSessionId = sessionId
        if (currentSessionId == null || eventSessionId != currentSessionId) return
        val owner = activeOwner ?: return
        owner to currentSessionId
      }

    when (obj["type"].asStringOrNull()) {
      "ready", "inputAudio" ->
        updateStateIfCurrent(
          owner = owner,
          sessionId = currentSessionId,
          active = true,
          listening = true,
          speaking = false,
          status = WearRealtimeTalkStatus.LISTENING,
          statusText = "Listening",
        )
      "audio" -> {
        val encoded = obj["audioBase64"].asStringOrNull() ?: return
        if (encoded.length > OUTPUT_QUEUE_BASE64_CHAR_CAPACITY) {
          fail(
            "Watch audio output exceeds the relay buffer",
            expectedOwner = owner,
            expectedSessionId = currentSessionId,
          )
          return
        }
        val bytes =
          runCatching { Base64.decode(encoded, Base64.DEFAULT) }
            .getOrNull()
            ?.takeIf(ByteArray::isNotEmpty)
            ?: return
        if (bytes.size % PCM_16_BYTES != 0) {
          fail("Invalid Watch audio frame", expectedOwner = owner, expectedSessionId = currentSessionId)
          return
        }
        if (!enqueueOutput(owner, currentSessionId, WearRealtimeAudioFrameType.OUTPUT_PCM, bytes)) {
          return
        }
        updateStateIfCurrent(
          owner = owner,
          sessionId = currentSessionId,
          active = true,
          listening = false,
          speaking = true,
          status = WearRealtimeTalkStatus.SPEAKING,
          statusText = "Speaking…",
        )
      }
      "clear" -> {
        enqueueOutput(owner, currentSessionId, WearRealtimeAudioFrameType.CLEAR_OUTPUT, byteArrayOf())
      }
      "mark" -> {
        val markName = obj["markName"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return
        acknowledgeMark(owner, currentSessionId, markName)
      }
      "transcript" -> handleTranscriptEvent(owner, currentSessionId, obj)
      "toolCall" -> handleToolCallEvent(owner, currentSessionId, obj)
      "toolResult" -> Unit
      "error" ->
        fail(
          obj["message"].asStringOrNull() ?: "Real-Time Talk failed",
          expectedOwner = owner,
          expectedSessionId = currentSessionId,
        )
      "close" -> abort(owner, currentSessionId)
    }
  }

  private fun acknowledgeMark(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
    markName: String,
  ) {
    val ownerScope =
      synchronized(lifecycleStateLock) {
        eventDispatchScope.takeIf { isCurrent(owner, activeSessionId) }
      } ?: return
    ownerScope.launch {
      synchronized(lifecycleStateLock) {
        if (!isCurrent(owner, activeSessionId)) return@launch
      }
      runCatching {
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(activeSessionId))
            put("markName", JsonPrimitive(markName))
          }
        requestGateway("talk.session.acknowledgeMark", params.toString(), 8_000L)
      }
    }
  }

  private fun handleTranscriptEvent(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
    obj: JsonObject,
  ) {
    synchronized(lifecycleStateLock) {
      if (!isCurrent(owner, activeSessionId)) return
      val text = obj["text"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return
      val final = obj["final"].asBooleanOrNull() == true
      when (obj["role"].asStringOrNull()) {
        "user" -> {
          upsertConversation(WearRealtimeTalkRole.USER, text, final)
          if (final) {
            updateState(
              active = true,
              listening = false,
              speaking = false,
              status = WearRealtimeTalkStatus.THINKING,
              statusText = "Agent working",
            )
          }
        }
        "assistant" -> upsertConversation(WearRealtimeTalkRole.ASSISTANT, text, final)
      }
    }
  }

  private fun handleToolCallEvent(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
    obj: JsonObject,
  ) {
    synchronized(lifecycleStateLock) {
      if (!isCurrent(owner, activeSessionId)) return
      val callId = obj["callId"].asStringOrNull() ?: return
      val name = obj["name"].asStringOrNull() ?: return
      realtimeAgentCoordinator.handleToolCall(
        callId = callId,
        name = name,
        args = obj["args"],
        forced = obj["forced"].asBooleanOrNull() == true,
      )
    }
  }

  private fun handleChatEvent(obj: JsonObject) {
    val runId = obj["runId"].asStringOrNull() ?: return
    val state = obj["state"].asStringOrNull() ?: return
    val eventSessionKey = obj["sessionKey"].asStringOrNull()
    realtimeAgentCoordinator.handleChatEvent(
      sessionKey = eventSessionKey,
      runId = runId,
      state = state,
      message = obj["message"],
    )
  }

  private fun startOutputLoop(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
  ) {
    val messages = Channel<WearRealtimeOutputMessage>(capacity = OUTPUT_QUEUE_CAPACITY)
    val queue = WearRealtimeOutputQueue(messages)
    synchronized(outputQueueLock) { outputQueue.also { outputQueue = queue } }
      ?.messages
      ?.close()
    outputJob?.cancel()
    outputJob =
      scope.launch {
        for (message in messages) {
          var delivered = false
          try {
            if (!isCurrent(owner, activeSessionId)) continue
            when (message.type) {
              WearRealtimeAudioFrameType.OUTPUT_PCM -> {
                delivered = true
                for (chunk in chunkWearRealtimeOutput(message.payload)) {
                  if (!isCurrentOutput(owner, activeSessionId)) {
                    delivered = false
                    break
                  }
                  sendWatchFrame(owner, message.type, chunk)
                  if (!isCurrentOutput(owner, activeSessionId)) {
                    delivered = false
                    break
                  }
                  playbackEndsAtMillis =
                    advanceWearRealtimePlaybackDeadline(
                      currentEndsAtMillis = playbackEndsAtMillis,
                      deliveredAtMillis = SystemClock.elapsedRealtime(),
                      audioByteCount = chunk.size,
                    )
                }
                if (!isCurrentOutput(owner, activeSessionId)) {
                  delivered = false
                }
              }
              WearRealtimeAudioFrameType.CLEAR_OUTPUT -> {
                sendWatchFrame(owner, message.type, message.payload)
                delivered = isCurrentOutput(owner, activeSessionId)
              }
              WearRealtimeAudioFrameType.INPUT_PCM -> error("Phone cannot emit Watch input audio")
            }
          } catch (err: Throwable) {
            if (err is CancellationException) throw err
            fail(
              "Unable to send audio to Watch",
              expectedOwner = owner,
              expectedSessionId = activeSessionId,
            )
            break
          } finally {
            if (message.type == WearRealtimeAudioFrameType.OUTPUT_PCM) {
              synchronized(outputQueueLock) {
                queue.retainedAudioBytes =
                  (queue.retainedAudioBytes - message.payload.size).coerceAtLeast(0)
              }
            }
          }
          if (!delivered) continue
          when (message.type) {
            WearRealtimeAudioFrameType.OUTPUT_PCM -> {
              schedulePlaybackIdle(owner, activeSessionId)
            }
            WearRealtimeAudioFrameType.CLEAR_OUTPUT -> {
              playbackEndsAtMillis = 0L
              playbackIdleJob?.cancel()
              updateStateIfCurrent(
                owner = owner,
                sessionId = activeSessionId,
                active = true,
                listening = true,
                speaking = false,
                status = WearRealtimeTalkStatus.LISTENING,
                statusText = "Listening",
              )
            }
            WearRealtimeAudioFrameType.INPUT_PCM -> error("Phone cannot emit Watch input audio")
          }
        }
      }
  }

  private suspend fun isCurrentOutput(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
  ): Boolean =
    currentCoroutineContext().isActive &&
      sessionId == activeSessionId &&
      activeOwner == owner

  private fun enqueueOutput(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
    type: WearRealtimeAudioFrameType,
    payload: ByteArray,
  ): Boolean {
    val accepted =
      synchronized(outputQueueLock) {
        if (!isCurrent(owner, activeSessionId)) return@synchronized false
        val queue = outputQueue ?: return@synchronized false
        val audioBytes = payload.size.takeIf { type == WearRealtimeAudioFrameType.OUTPUT_PCM } ?: 0
        if (audioBytes > OUTPUT_QUEUE_BYTE_CAPACITY - queue.retainedAudioBytes) {
          return@synchronized false
        }
        queue.retainedAudioBytes += audioBytes
        queue.messages.trySend(WearRealtimeOutputMessage(type, payload)).isSuccess.also { sent ->
          if (!sent) queue.retainedAudioBytes -= audioBytes
        }
      }
    if (!accepted) {
      fail(
        "Watch audio link is unavailable",
        expectedOwner = owner,
        expectedSessionId = activeSessionId,
      )
      return false
    }
    return true
  }

  private fun startAppendLoop(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
  ) {
    audioFrames?.close()
    appendJob?.cancel()
    val frames = Channel<ByteArray>(capacity = INPUT_QUEUE_CAPACITY)
    audioFrames = frames
    appendJob =
      scope.launch {
        for (frame in frames) {
          if (!isCurrent(owner, activeSessionId)) continue
          val params =
            buildJsonObject {
              put("sessionId", JsonPrimitive(activeSessionId))
              put(
                "audioBase64",
                JsonPrimitive(Base64.encodeToString(frame, Base64.NO_WRAP)),
              )
              put("timestamp", JsonPrimitive(SystemClock.elapsedRealtime()))
            }
          try {
            sendGatewayFrame(
              "talk.session.appendAudio",
              params.toString(),
              8_000L,
            ) { message ->
              fail(
                message,
                expectedOwner = owner,
                expectedSessionId = activeSessionId,
              )
            }
          } catch (err: Throwable) {
            if (err is CancellationException) throw err
            fail(
              err.message ?: "Unable to send Watch audio",
              expectedOwner = owner,
              expectedSessionId = activeSessionId,
            )
          }
        }
      }
  }

  private fun schedulePlaybackIdle(
    owner: WearRealtimeAttemptOwner,
    activeSessionId: String,
  ) {
    playbackIdleJob?.cancel()
    playbackIdleJob =
      scope.launch {
        while (SystemClock.elapsedRealtime() < playbackEndsAtMillis) {
          delay(20L)
        }
        if (isCurrent(owner, activeSessionId)) {
          updateStateIfCurrent(
            owner = owner,
            sessionId = activeSessionId,
            active = true,
            listening = true,
            speaking = false,
            status = WearRealtimeTalkStatus.LISTENING,
            statusText = "Listening",
          )
        }
      }
  }

  private fun upsertConversation(
    role: WearRealtimeTalkRole,
    text: String,
    final: Boolean,
  ) {
    val currentId =
      when (role) {
        WearRealtimeTalkRole.USER -> userEntryId
        WearRealtimeTalkRole.ASSISTANT -> assistantEntryId
      }
    val entries = _snapshot.value.conversation.toMutableList()
    val entryId = currentId ?: UUID.randomUUID().toString()
    val index = entries.indexOfFirst { entry -> entry.id == entryId }
    val entry =
      WearRealtimeTalkEntry(
        id = entryId,
        role = role,
        text = text.take(MAX_TRANSCRIPT_LENGTH),
        streaming = !final,
      )
    if (index >= 0) {
      entries[index] = entry
    } else {
      entries += entry
    }
    when (role) {
      WearRealtimeTalkRole.USER -> userEntryId = if (final) null else entryId
      WearRealtimeTalkRole.ASSISTANT -> assistantEntryId = if (final) null else entryId
    }
    setSnapshot(
      _snapshot.value.copy(
        conversation = entries.takeLast(MAX_CONVERSATION_ENTRIES),
      ),
    )
  }

  private fun updateState(
    active: Boolean,
    listening: Boolean,
    speaking: Boolean,
    status: WearRealtimeTalkStatus,
    statusText: String,
  ) {
    setSnapshot(
      _snapshot.value.copy(
        active = active,
        listening = listening,
        speaking = speaking,
        status = status,
        statusText = statusText,
        attemptId = activeOwner?.attemptId,
      ),
    )
  }

  private fun updateStateIfCurrent(
    owner: WearRealtimeAttemptOwner,
    sessionId: String,
    active: Boolean,
    listening: Boolean,
    speaking: Boolean,
    status: WearRealtimeTalkStatus,
    statusText: String,
  ) {
    synchronized(lifecycleStateLock) {
      if (!isCurrent(owner, sessionId)) return
      updateState(active, listening, speaking, status, statusText)
    }
  }

  private fun isCurrent(
    owner: WearRealtimeAttemptOwner,
    expectedSessionId: String,
  ): Boolean = activeOwner == owner && sessionId == expectedSessionId

  private fun fail(
    message: String,
    expectedOwner: WearRealtimeAttemptOwner? = null,
    expectedSessionId: String? = null,
  ) {
    var closingSession: String? = null
    val closingOwner =
      synchronized(lifecycleStateLock) {
        // Transport callbacks and non-cancellable I/O can outlive their relay.
        // Only that relay may own teardown, or a late error can stop its replacement.
        if (expectedOwner != null && activeOwner != expectedOwner) return
        if (expectedSessionId != null && sessionId != expectedSessionId) return
        Log.w(TAG, message)
        val currentSession = sessionId
        val currentOwner = activeOwner
        closingSession = currentSession
        realtimeAgentCoordinator.resetTransport()
        setSnapshot(
          _snapshot.value.copy(
            active = false,
            listening = false,
            speaking = false,
            status = WearRealtimeTalkStatus.ERROR,
            statusText = message.take(MAX_STATUS_LENGTH),
          ),
        )
        sessionId = null
        activeOwner = null
        ownerSessionKey = null
        audioFrames?.close()
        audioFrames = null
        appendJob?.cancel()
        appendJob = null
        synchronized(outputQueueLock) { outputQueue.also { outputQueue = null } }
          ?.messages
          ?.close()
        outputJob?.cancel()
        outputJob = null
        eventDispatchScope?.cancel()
        eventDispatchScope = null
        playbackIdleJob?.cancel()
        playbackIdleJob = null
        playbackEndsAtMillis = 0L
        currentOwner
      }
    closingSession?.takeIf(String::isNotBlank)?.let { session ->
      scope.launch { runCatching { closeGatewaySession(session) } }
    }
    closingOwner?.let(onForceCloseWatchChannel)
  }

  private suspend fun closeGatewaySession(closingSession: String) {
    val params = buildJsonObject { put("sessionId", JsonPrimitive(closingSession)) }
    requestGateway("talk.session.close", params.toString(), 5_000L)
  }

  private fun resetLocked() {
    val closingAttemptId = activeOwner?.attemptId
    realtimeAgentCoordinator.resetTransport()
    sessionId = null
    activeOwner = null
    ownerSessionKey = null
    audioFrames?.close()
    audioFrames = null
    appendJob?.cancel()
    appendJob = null
    synchronized(outputQueueLock) { outputQueue.also { outputQueue = null } }
      ?.messages
      ?.close()
    outputJob?.cancel()
    outputJob = null
    eventDispatchScope?.cancel()
    eventDispatchScope = null
    playbackIdleJob?.cancel()
    playbackIdleJob = null
    playbackEndsAtMillis = 0L
    userEntryId = null
    assistantEntryId = null
    setSnapshot(WearRealtimeTalkSnapshot(attemptId = closingAttemptId))
  }

  private fun setSnapshot(snapshot: WearRealtimeTalkSnapshot) {
    _snapshot.value = snapshot
    onSnapshot(snapshot)
  }

  private companion object {
    const val TAG = "WearRealtimeTalk"
    const val MAX_CONVERSATION_ENTRIES = 20
    const val MAX_CANCELED_ATTEMPTS = 32
    const val MAX_TRANSCRIPT_LENGTH = 1_500
    const val MAX_STATUS_LENGTH = 160
    const val INPUT_QUEUE_CAPACITY = 64
    const val OUTPUT_QUEUE_CAPACITY = 64
    const val OUTPUT_QUEUE_BYTE_CAPACITY = WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES * 128
    const val OUTPUT_QUEUE_BASE64_CHAR_CAPACITY = (OUTPUT_QUEUE_BYTE_CAPACITY + 2) / 3 * 4
    const val SESSION_CREATE_TIMEOUT_MILLIS = 15_000L
  }
}

private fun JsonElement?.asBooleanOrNull(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull

private fun GatewaySession.ErrorShape.isUnsupportedSessionLanguageParam(): Boolean =
  code == "INVALID_REQUEST" &&
    message
      .lowercase(Locale.ROOT)
      .contains("invalid talk.session.create params")

private const val PCM_16_BYTES = 2
