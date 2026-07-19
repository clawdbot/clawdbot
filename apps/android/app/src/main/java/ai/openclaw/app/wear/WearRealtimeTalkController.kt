package ai.openclaw.app.wear

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
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
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
  private val sendWatchFrame: suspend (nodeId: String, type: WearRealtimeAudioFrameType, payload: ByteArray) -> Unit,
  private val onSnapshot: (WearRealtimeTalkSnapshot) -> Unit = {},
  private val onForceCloseWatchChannel: (String) -> Unit = {},
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val lifecycleMutex = Mutex()
  private val lifecycleStateLock = Any()
  private val lifecycleGeneration = AtomicLong()
  private val canceledAttempts = LinkedHashSet<WearRealtimeAttemptKey>()
  private val _snapshot = MutableStateFlow(WearRealtimeTalkSnapshot())
  val snapshot: StateFlow<WearRealtimeTalkSnapshot> = _snapshot

  @Volatile private var sessionId: String? = null

  @Volatile private var ownerNodeId: String? = null

  @Volatile private var ownerSessionKey: String? = null

  @Volatile private var ownerAttemptId: String? = null

  private var audioFrames: Channel<ByteArray>? = null
  private var appendJob: Job? = null
  private var outputMessages: Channel<WearRealtimeOutputMessage>? = null
  private var outputJob: Job? = null
  private var playbackIdleJob: Job? = null
  private var playbackEndsAtMillis = 0L
  private var userEntryId: String? = null
  private var assistantEntryId: String? = null

  suspend fun start(
    nodeId: String,
    sessionKey: String,
    attemptId: String,
    language: String?,
  ): Boolean =
    lifecycleMutex.withLock {
      val startGeneration =
        synchronized(lifecycleStateLock) {
          if (!isConnected()) return@withLock false
          if (WearRealtimeAttemptKey(nodeId, attemptId) in canceledAttempts) return@withLock false
          if (sessionId != null) {
            if (ownerNodeId != nodeId || ownerSessionKey != sessionKey || ownerAttemptId != attemptId) {
              return@withLock false
            }
            return@withLock true
          }

          ownerNodeId = nodeId
          ownerSessionKey = sessionKey
          ownerAttemptId = attemptId
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

      fun startIsStale(): Boolean =
        startGeneration != lifecycleGeneration.get() ||
          !isConnected() ||
          ownerNodeId != nodeId ||
          ownerSessionKey != sessionKey ||
          ownerAttemptId != attemptId

      val payload =
        try {
          requestRealtimeSession(sessionKey, language)
        } catch (err: Throwable) {
          synchronized(lifecycleStateLock) {
            if (!startIsStale()) fail(err.message ?: "Unable to start Real-Time Talk")
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
            if (ownerAttemptId == attemptId) resetLocked()
            false
          } else if (createdSessionId.isNullOrBlank()) {
            fail("Real-Time Talk returned no session")
            false
          } else {
            sessionId = createdSessionId
            startOutputLoop(createdSessionId)
            startAppendLoop(createdSessionId)
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
          if (
            (nodeId != null && ownerNodeId != null && ownerNodeId != nodeId) ||
            (attemptId != null && ownerAttemptId != null && ownerAttemptId != attemptId)
          ) {
            null
          } else {
            accepted = true
            sessionId.also { resetLocked() }
          }
        }
      if (!accepted) {
        return@withLock false
      }
      if (!closingSession.isNullOrBlank()) {
        runCatching {
          val params = buildJsonObject { put("sessionId", JsonPrimitive(closingSession)) }
          requestGateway("talk.session.close", params.toString(), 5_000L)
        }
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
    val closingNodeId =
      synchronized(lifecycleStateLock) {
        lifecycleGeneration.incrementAndGet()
        val nodeId = ownerNodeId
        resetLocked()
        nodeId
      }
    closingNodeId?.let(onForceCloseWatchChannel)
  }

  fun appendAudio(
    nodeId: String,
    payload: ByteArray,
  ) {
    if (
      payload.isEmpty() ||
      payload.size > WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES ||
      ownerNodeId != nodeId ||
      sessionId == null ||
      _snapshot.value.speaking
    ) {
      return
    }
    audioFrames?.trySend(payload.copyOf())
  }

  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event != "talk.event" || payloadJson.isNullOrBlank()) return
    val obj =
      runCatching { json.parseToJsonElement(payloadJson).asObjectOrNull() }
        .getOrNull()
        ?: return
    val eventSessionId =
      obj["relaySessionId"].asStringOrNull()
        ?: obj["sessionId"].asStringOrNull()
    val currentSessionId = sessionId
    if (currentSessionId == null || eventSessionId != currentSessionId) return

    when (obj["type"].asStringOrNull()) {
      "ready", "inputAudio" ->
        updateState(
          active = true,
          listening = true,
          speaking = false,
          status = WearRealtimeTalkStatus.LISTENING,
          statusText = "Listening",
        )
      "audio" -> {
        val encoded = obj["audioBase64"].asStringOrNull() ?: return
        val bytes =
          runCatching { Base64.decode(encoded, Base64.DEFAULT) }
            .getOrNull()
            ?.takeIf(ByteArray::isNotEmpty)
            ?: return
        val chunks =
          runCatching { chunkWearRealtimeOutput(bytes) }
            .getOrElse {
              fail("Invalid Watch audio frame")
              return
            }
        if (
          chunks.any { chunk ->
            !enqueueOutput(
              type = WearRealtimeAudioFrameType.OUTPUT_PCM,
              payload = chunk,
            )
          }
        ) {
          return
        }
        updateState(
          active = true,
          listening = false,
          speaking = true,
          status = WearRealtimeTalkStatus.SPEAKING,
          statusText = "Speaking…",
        )
      }
      "clear" -> {
        enqueueOutput(WearRealtimeAudioFrameType.CLEAR_OUTPUT, byteArrayOf())
      }
      "mark" -> {
        val markName = obj["markName"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return
        scope.launch {
          runCatching {
            val params =
              buildJsonObject {
                put("sessionId", JsonPrimitive(currentSessionId))
                put("markName", JsonPrimitive(markName))
              }
            requestGateway("talk.session.acknowledgeMark", params.toString(), 8_000L)
          }
        }
      }
      "transcript" -> {
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
      "error" -> fail(obj["message"].asStringOrNull() ?: "Real-Time Talk failed")
      "close" -> abort()
    }
  }

  private fun startOutputLoop(activeSessionId: String) {
    outputMessages?.close()
    outputJob?.cancel()
    val messages = Channel<WearRealtimeOutputMessage>(capacity = OUTPUT_QUEUE_CAPACITY)
    outputMessages = messages
    outputJob =
      scope.launch {
        for (message in messages) {
          if (sessionId != activeSessionId) continue
          val nodeId = ownerNodeId ?: continue
          try {
            sendWatchFrame(nodeId, message.type, message.payload)
          } catch (err: Throwable) {
            if (err is CancellationException) throw err
            fail(
              "Unable to send audio to Watch",
              expectedSessionId = activeSessionId,
            )
            break
          }
          when (message.type) {
            WearRealtimeAudioFrameType.OUTPUT_PCM -> {
              val sampleCount = message.payload.size / PCM_16_BYTES
              val durationMillis =
                (
                  sampleCount *
                    1_000L /
                    WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ
                ).coerceAtLeast(1L)
              playbackEndsAtMillis =
                maxOf(SystemClock.elapsedRealtime(), playbackEndsAtMillis) + durationMillis
              schedulePlaybackIdle()
            }
            WearRealtimeAudioFrameType.CLEAR_OUTPUT -> {
              playbackEndsAtMillis = 0L
              playbackIdleJob?.cancel()
              updateState(
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

  private fun enqueueOutput(
    type: WearRealtimeAudioFrameType,
    payload: ByteArray,
  ): Boolean {
    val messages = outputMessages
    if (
      messages == null ||
      !messages.trySend(WearRealtimeOutputMessage(type, payload)).isSuccess
    ) {
      fail("Watch audio link is unavailable")
      return false
    }
    return true
  }

  private fun startAppendLoop(activeSessionId: String) {
    audioFrames?.close()
    appendJob?.cancel()
    val frames =
      Channel<ByteArray>(
        capacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    audioFrames = frames
    appendJob =
      scope.launch {
        for (frame in frames) {
          if (sessionId != activeSessionId) continue
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
            ) { message -> fail(message, expectedSessionId = activeSessionId) }
          } catch (err: Throwable) {
            if (err is CancellationException) throw err
            fail(
              err.message ?: "Unable to send Watch audio",
              expectedSessionId = activeSessionId,
            )
          }
        }
      }
  }

  private fun schedulePlaybackIdle() {
    playbackIdleJob?.cancel()
    playbackIdleJob =
      scope.launch {
        while (SystemClock.elapsedRealtime() < playbackEndsAtMillis) {
          delay(20L)
        }
        if (sessionId != null) {
          updateState(
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
        attemptId = ownerAttemptId,
      ),
    )
  }

  private fun fail(
    message: String,
    expectedSessionId: String? = null,
  ) {
    val (closingSession, closingNodeId) =
      synchronized(lifecycleStateLock) {
        // Transport callbacks and non-cancellable I/O can outlive their relay.
        // Only that relay may own teardown, or a late error can stop its replacement.
        if (expectedSessionId != null && sessionId != expectedSessionId) return
        Log.w(TAG, message)
        val currentSession = sessionId
        val currentNodeId = ownerNodeId
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
        ownerNodeId = null
        ownerSessionKey = null
        ownerAttemptId = null
        audioFrames?.close()
        audioFrames = null
        appendJob?.cancel()
        appendJob = null
        outputMessages?.close()
        outputMessages = null
        outputJob?.cancel()
        outputJob = null
        playbackIdleJob?.cancel()
        playbackIdleJob = null
        playbackEndsAtMillis = 0L
        currentSession to currentNodeId
      }
    if (!closingSession.isNullOrBlank()) {
      scope.launch {
        runCatching {
          val params = buildJsonObject { put("sessionId", JsonPrimitive(closingSession)) }
          requestGateway("talk.session.close", params.toString(), 5_000L)
        }
      }
    }
    closingNodeId?.let(onForceCloseWatchChannel)
  }

  private fun resetLocked() {
    val closingAttemptId = ownerAttemptId
    sessionId = null
    ownerNodeId = null
    ownerSessionKey = null
    ownerAttemptId = null
    audioFrames?.close()
    audioFrames = null
    appendJob?.cancel()
    appendJob = null
    outputMessages?.close()
    outputMessages = null
    outputJob?.cancel()
    outputJob = null
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
    const val OUTPUT_QUEUE_CAPACITY = 64
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
