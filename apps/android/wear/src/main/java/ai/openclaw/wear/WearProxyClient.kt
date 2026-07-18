package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun interface WearNodeResolver {
  suspend fun reachablePhoneNodeId(): String?
}

internal fun interface WearMessageTransport {
  suspend fun send(
    nodeId: String,
    path: String,
    data: ByteArray,
  )
}

internal interface WearRpcRequester {
  suspend fun request(
    method: WearRpcMethod,
    params: JsonObject,
    expectedNodeId: String?,
    requirePreferredNode: Boolean = false,
  ): WearRpcResult
}

internal data class WearRpcResult(
  val payload: JsonElement,
  val eventSequence: Long?,
  val sourceNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearInboundEvent(
  val sourceNodeId: String,
  val sequence: Long,
  val event: WearEventType,
  val payload: JsonElement?,
  val streamId: String? = null,
)

internal class WearProxyException(
  val code: String,
  override val message: String,
) : IllegalStateException(message)

internal class WearProxyClient private constructor(
  private val nodeResolver: WearNodeResolver,
  private val transport: WearMessageTransport,
) : WearRpcRequester {
  private val pending = ConcurrentHashMap<String, PendingWearRequest>()
  private val selectedPhoneNodeId = AtomicReference<String?>()
  private val preferredPhoneLock = Any()
  private var preferredPhoneKnown = false
  private var preferredPhoneNodeId: String? = null
  private val inboundMutex = Mutex()
  private val mutableEvents =
    MutableSharedFlow<WearInboundEvent>(
      extraBufferCapacity = MAX_BUFFERED_EVENTS,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

  val events: SharedFlow<WearInboundEvent> = mutableEvents
  private val mutablePreferredPhoneChanges =
    MutableSharedFlow<String?>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
  val preferredPhoneChanges: SharedFlow<String?> = mutablePreferredPhoneChanges

  override suspend fun request(
    method: WearRpcMethod,
    params: JsonObject,
    expectedNodeId: String?,
    requirePreferredNode: Boolean,
  ): WearRpcResult =
    try {
      withTimeout(REQUEST_TIMEOUT_MS) {
        requestBeforeDeadline(method, params, expectedNodeId, requirePreferredNode)
      }
    } catch (_: TimeoutCancellationException) {
      throw WearProxyException("timeout", "Paired phone did not respond")
    }

  private suspend fun requestBeforeDeadline(
    method: WearRpcMethod,
    params: JsonObject,
    expectedNodeId: String?,
    requirePreferredNode: Boolean,
  ): WearRpcResult {
    // Stateful RPCs stay on the phone that supplied their session/transcript.
    // Rediscovery here could route a shared session key to a different phone.
    val requiredPreferredNodeId = if (requirePreferredNode) resolvePreferredPhoneNode() else null
    val nodeId = expectedNodeId ?: requiredPreferredNodeId ?: resolvePreferredPhoneNode()
    if (requirePreferredNode && expectedNodeId != null && requiredPreferredNodeId != expectedNodeId) {
      throw WearProxyException("phone_changed", "Preferred phone changed during request")
    }
    val requestId = UUID.randomUUID().toString()
    val response = CompletableDeferred<WearMessage.Response>()
    val pendingRequest = PendingWearRequest(nodeId = nodeId, response = response)
    check(pending.putIfAbsent(requestId, pendingRequest) == null)
    return try {
      try {
        transport.send(
          nodeId = nodeId,
          path = WearProtocol.REQUEST_PATH,
          data =
            WearProtocolCodec.encode(
              WearMessage.Request(requestId = requestId, method = method, params = params),
            ),
        )
      } catch (_: CancellationException) {
        currentCoroutineContext().ensureActive()
        throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
      } catch (_: Throwable) {
        throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
      }
      val envelope = response.await()
      if (
        (expectedNodeId == null || requirePreferredNode || method.requiresPreferredSnapshotSource()) &&
        selectedPhoneNodeId.get() != nodeId
      ) {
        throw WearProxyException("phone_changed", "Preferred phone changed during request")
      }
      if (!envelope.ok) {
        val error = envelope.error
        throw WearProxyException(error?.code ?: "unavailable", error?.message ?: "Phone proxy request failed")
      }
      WearRpcResult(
        payload = envelope.result ?: buildJsonObject {},
        // Phone and watch can update independently. A missing v1 watermark means
        // unknown, so the next event establishes the legacy phone's live baseline.
        eventStreamId = envelope.eventStreamId,
        eventSequence = envelope.eventSequence,
        sourceNodeId = nodeId,
      )
    } finally {
      pending.remove(requestId, pendingRequest)
    }
  }

  suspend fun handleMessage(
    sourceNodeId: String,
    path: String,
    data: ByteArray,
  ): WearInboundEvent? =
    inboundMutex.withLock {
      val message = (WearProtocolCodec.decode(data) as? WearDecodeResult.Success)?.message ?: return@withLock null
      when {
        path == WearProtocol.RESPONSE_PATH && message is WearMessage.Response -> {
          pending[message.requestId]
            ?.takeIf { it.nodeId == sourceNodeId }
            ?.response
            ?.complete(message)
          null
        }
        path == WearProtocol.EVENT_PATH && message is WearMessage.Event -> {
          if (!acceptEventSource(sourceNodeId)) return@withLock null
          val inbound =
            WearInboundEvent(
              sourceNodeId = sourceNodeId,
              streamId = message.streamId,
              sequence = message.sequence,
              event = message.event,
              payload = message.payload,
            )
          mutableEvents.tryEmit(inbound)
          inbound
        }
        else -> null
      }
    }

  private suspend fun resolvePhoneNode(): String =
    try {
      nodeResolver.reachablePhoneNodeId()
    } catch (_: CancellationException) {
      // Play Services can cancel its Task while this request remains active.
      // Preserve actual caller cancellation; map transport cancellation below.
      currentCoroutineContext().ensureActive()
      throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
    } catch (_: Throwable) {
      throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
    } ?: throw WearProxyException("phone_unavailable", "Paired phone is unavailable")

  private suspend fun acceptEventSource(sourceNodeId: String): Boolean {
    val snapshot = preferredPhoneSnapshot()
    if (snapshot.known) {
      val preferred = snapshot.nodeId
      selectedPhoneNodeId.set(preferred)
      return preferred == sourceNodeId
    }
    if (selectedPhoneNodeId.get() == sourceNodeId) return true
    return try {
      resolvePreferredPhoneNode() == sourceNodeId
    } catch (err: CancellationException) {
      throw err
    } catch (_: WearProxyException) {
      false
    }
  }

  /** Capability callbacks invalidate cached routing before another old-phone event is accepted. */
  fun updatePreferredPhoneNodeId(nodeId: String?) {
    val changed =
      synchronized(preferredPhoneLock) {
        val changed = !preferredPhoneKnown || preferredPhoneNodeId != nodeId
        preferredPhoneKnown = true
        preferredPhoneNodeId = nodeId
        changed
      }
    selectedPhoneNodeId.set(nodeId)
    if (changed) mutablePreferredPhoneChanges.tryEmit(nodeId)
  }

  private suspend fun resolvePreferredPhoneNode(): String {
    preferredPhoneSnapshot().takeIf(PreferredPhoneSnapshot::known)?.let { snapshot ->
      return snapshot.nodeId ?: throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
    }
    val resolved = resolvePhoneNode()
    val selected =
      synchronized(preferredPhoneLock) {
        if (!preferredPhoneKnown) {
          preferredPhoneKnown = true
          preferredPhoneNodeId = resolved
        }
        preferredPhoneNodeId
      } ?: throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
    selectedPhoneNodeId.set(selected)
    return selected
  }

  private fun preferredPhoneSnapshot(): PreferredPhoneSnapshot =
    synchronized(preferredPhoneLock) {
      PreferredPhoneSnapshot(known = preferredPhoneKnown, nodeId = preferredPhoneNodeId)
    }

  private data class PreferredPhoneSnapshot(
    val known: Boolean,
    val nodeId: String?,
  )

  private data class PendingWearRequest(
    val nodeId: String,
    val response: CompletableDeferred<WearMessage.Response>,
  )

  companion object {
    private const val REQUEST_TIMEOUT_MS = 10_000L
    private const val MAX_BUFFERED_EVENTS = 64

    fun create(context: Context): WearProxyClient {
      val appContext = context.applicationContext
      val capabilityClient = Wearable.getCapabilityClient(appContext)
      val messageClient = Wearable.getMessageClient(appContext)
      return WearProxyClient(
        nodeResolver =
          WearNodeResolver {
            capabilityClient
              .getCapability(WearProtocol.PHONE_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
              .await()
              .nodes
              .sortedWith(compareByDescending<com.google.android.gms.wearable.Node> { it.isNearby }.thenBy { it.id })
              .firstOrNull()
              ?.id
          },
        transport =
          WearMessageTransport { nodeId, path, data ->
            messageClient.sendMessage(nodeId, path, data).await()
          },
      )
    }

    internal fun createForTests(
      nodeResolver: WearNodeResolver,
      transport: WearMessageTransport,
    ): WearProxyClient = WearProxyClient(nodeResolver, transport)
  }
}

private fun WearRpcMethod.requiresPreferredSnapshotSource(): Boolean = this == WearRpcMethod.ProxyStatus || this == WearRpcMethod.SessionsList || this == WearRpcMethod.ChatHistory

internal enum class WearSequenceDecision {
  Accepted,
  AwaitingSnapshot,
  GapOrReset,
}

internal class WearEventSequenceTracker {
  private var streamId: String? = null
  private var lastSequence: Long? = null
  private var awaitingSnapshot = false

  @Synchronized
  fun adoptSnapshot(
    streamId: String?,
    sequence: Long?,
  ) {
    if (sequence == null) {
      this.streamId = streamId
      lastSequence = null
      awaitingSnapshot = false
      return
    }
    val previous = lastSequence
    val streamChanged = this.streamId != streamId && (this.streamId != null || streamId != null)
    this.streamId = streamId
    if (awaitingSnapshot || previous == null || streamChanged || sequence > previous) lastSequence = sequence
    awaitingSnapshot = false
  }

  @Synchronized
  fun accept(
    streamId: String?,
    sequence: Long,
  ): WearSequenceDecision {
    if (awaitingSnapshot) return WearSequenceDecision.AwaitingSnapshot
    val previous = lastSequence
    if (previous == null) {
      this.streamId = streamId
      lastSequence = sequence
      return WearSequenceDecision.Accepted
    }
    if (this.streamId != streamId && (this.streamId != null || streamId != null)) {
      awaitingSnapshot = true
      return WearSequenceDecision.GapOrReset
    }
    if (sequence == previous + 1) {
      lastSequence = sequence
      return WearSequenceDecision.Accepted
    }
    // Stream epochs expose phone restarts even when the new process happens to
    // produce the next numeric sequence. Legacy null epochs still use gap detection.
    awaitingSnapshot = true
    return WearSequenceDecision.GapOrReset
  }

  @Synchronized
  fun requireSnapshot() {
    awaitingSnapshot = true
  }
}

internal class WearEventSourceTracker {
  private var sourceNodeId: String? = null

  fun adopt(sourceNodeId: String) {
    this.sourceNodeId = sourceNodeId
  }

  fun reset() {
    sourceNodeId = null
  }

  fun changed(sourceNodeId: String): Boolean {
    val previous = this.sourceNodeId
    this.sourceNodeId = sourceNodeId
    return previous != null && previous != sourceNodeId
  }
}

internal class WearEventResyncBuffer(
  private val capacity: Int = MAX_BUFFERED_EVENTS,
) {
  // The response watermark splits events already captured by a snapshot from
  // later events that raced its delivery. A bounded overflow reappears as a gap.
  private val events = LinkedHashMap<Pair<String?, Long>, WearInboundEvent>()
  private var buffering = false

  @Synchronized
  fun begin() {
    events.clear()
    buffering = true
  }

  @Synchronized
  fun start(event: WearInboundEvent) {
    begin()
    appendLocked(event)
  }

  @Synchronized
  fun append(event: WearInboundEvent) {
    if (buffering) appendLocked(event)
  }

  @Synchronized
  fun drainAfterSnapshot(
    streamId: String?,
    sequence: Long?,
  ): List<WearInboundEvent> {
    if (!buffering) return emptyList()
    buffering = false
    val pending =
      if (sequence == null) {
        // A legacy snapshot has no ordering boundary. It already represents
        // pre-response state, so replay could duplicate it; the next live event
        // establishes the new sequence baseline.
        emptyList()
      } else {
        events.values
          .filter { event -> event.streamId == streamId && event.sequence > sequence }
          .sortedBy(WearInboundEvent::sequence)
      }
    events.clear()
    return pending
  }

  private fun appendLocked(event: WearInboundEvent) {
    events[event.streamId to event.sequence] = event
    while (events.size > capacity) events.remove(events.keys.first())
  }

  private companion object {
    const val MAX_BUFFERED_EVENTS = 64
  }
}

private suspend fun <T> Task<T>.await(): T =
  suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { value -> if (continuation.isActive) continuation.resume(value) }
    addOnFailureListener { error -> if (continuation.isActive) continuation.resumeWithException(error) }
    addOnCanceledListener { continuation.cancel() }
  }
