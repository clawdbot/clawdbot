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
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
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
  private val preferredPhoneLock = Any()
  private var preferredPhoneGeneration = 0L
  private var registeredPhone: PreferredPhoneRegistration? = null
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
  ): WearRpcResult {
    var attemptedPreferredPhone: PreferredPhoneRegistration? = null
    val result =
      withTimeoutOrNull(REQUEST_TIMEOUT_MS) {
        requestBeforeDeadline(method, params, expectedNodeId, requirePreferredNode) { registration ->
          attemptedPreferredPhone = registration
        }
      }
    if (result != null) return result

    // MessageClient success only proves the request was queued. A silent phone
    // must be rediscovered just like a node that rejected the send outright.
    invalidatePreferredPhone(attemptedPreferredPhone)
    throw WearProxyException("timeout", "Paired phone did not respond")
  }

  private suspend fun requestBeforeDeadline(
    method: WearRpcMethod,
    params: JsonObject,
    expectedNodeId: String?,
    requirePreferredNode: Boolean,
    recordPreferredPhoneAttempt: (PreferredPhoneRegistration?) -> Unit,
  ): WearRpcResult {
    // Stateful RPCs stay on the phone that supplied their session/transcript.
    // Rediscovery here could route a shared session key to a different phone.
    val preferredPhone =
      when {
        requirePreferredNode || expectedNodeId == null -> resolvePreferredPhone()
        else -> preferredPhoneRegistration(expectedNodeId)
      }
    val nodeId = expectedNodeId ?: checkNotNull(preferredPhone).nodeId
    if (requirePreferredNode && expectedNodeId != null && preferredPhone?.nodeId != expectedNodeId) {
      throw WearProxyException("phone_changed", "Preferred phone changed during request")
    }
    recordPreferredPhoneAttempt(preferredPhone?.takeIf { it.nodeId == nodeId })
    val requestId = UUID.randomUUID().toString()
    val response = CompletableDeferred<WearMessage.Response>()
    val pendingRequest =
      PendingWearRequest(
        nodeId = nodeId,
        response = response,
        preferredPhone = preferredPhone?.takeIf { it.nodeId == nodeId },
      )
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
        invalidatePreferredPhone(preferredPhone?.takeIf { it.nodeId == nodeId })
        throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
      } catch (_: Throwable) {
        invalidatePreferredPhone(preferredPhone?.takeIf { it.nodeId == nodeId })
        throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
      }
      val envelope = response.await()
      if (
        (expectedNodeId == null || requirePreferredNode || method.requiresPreferredSnapshotSource()) &&
        currentPreferredPhone()?.nodeId != nodeId
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
            ?.let { request ->
              // Correlation is the reachability proof. Advance the registration
              // before a concurrently expiring request can invalidate it.
              confirmPreferredPhoneResponse(request.preferredPhone)
              request.response.complete(message)
            }
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
    val preferredPhone = currentPreferredPhone()
    if (preferredPhone != null) {
      return preferredPhone.nodeId == sourceNodeId
    }
    return try {
      resolvePreferredPhone().nodeId == sourceNodeId
    } catch (err: CancellationException) {
      throw err
    } catch (_: WearProxyException) {
      false
    }
  }

  /** A unique directly connected phone becomes the preferred routing source immediately. */
  fun updatePreferredPhoneNodeId(nodeId: String) {
    val changed =
      synchronized(preferredPhoneLock) {
        val changed = registeredPhone?.nodeId != nodeId
        preferredPhoneGeneration += 1
        registeredPhone = PreferredPhoneRegistration(nodeId, preferredPhoneGeneration)
        changed
      }
    if (changed) mutablePreferredPhoneChanges.tryEmit(nodeId)
  }

  /** Capability callbacks are not reachability-filtered, so ambiguous results force fresh discovery. */
  fun invalidatePreferredPhoneNode() {
    val changed =
      synchronized(preferredPhoneLock) {
        val changed = registeredPhone != null
        preferredPhoneGeneration += 1
        registeredPhone = null
        changed
      }
    if (changed) mutablePreferredPhoneChanges.tryEmit(null)
  }

  private suspend fun resolvePreferredPhone(): PreferredPhoneRegistration {
    // Capability callbacks can invalidate the route while discovery suspends.
    // Only a result from the same generation may repopulate it.
    val discoveryGeneration =
      synchronized(preferredPhoneLock) {
        registeredPhone?.let { return it }
        preferredPhoneGeneration
      }
    val resolved = resolvePhoneNode()
    return synchronized(preferredPhoneLock) {
      registeredPhone ?: if (preferredPhoneGeneration == discoveryGeneration) {
        preferredPhoneGeneration += 1
        PreferredPhoneRegistration(resolved, preferredPhoneGeneration).also { registeredPhone = it }
      } else {
        null
      }
    } ?: throw WearProxyException("phone_unavailable", "Paired phone is unavailable")
  }

  private fun currentPreferredPhone(): PreferredPhoneRegistration? =
    synchronized(preferredPhoneLock) {
      registeredPhone
    }

  private fun preferredPhoneRegistration(nodeId: String): PreferredPhoneRegistration? =
    synchronized(preferredPhoneLock) {
      registeredPhone?.takeIf { it.nodeId == nodeId }
    }

  private fun invalidatePreferredPhone(registration: PreferredPhoneRegistration?) {
    if (registration == null) return
    val invalidated =
      synchronized(preferredPhoneLock) {
        if (registeredPhone == registration) {
          // A capability callback can refresh the same node while an older request
          // is failing. Clear only the registration that owned this transport attempt.
          preferredPhoneGeneration += 1
          registeredPhone = null
          true
        } else {
          false
        }
      }
    if (invalidated) mutablePreferredPhoneChanges.tryEmit(null)
  }

  private fun confirmPreferredPhoneResponse(registration: PreferredPhoneRegistration?) {
    if (registration == null) return
    synchronized(preferredPhoneLock) {
      if (registeredPhone == registration) {
        // Any correlated response proves this registration is reachable. Advance
        // it so an older parallel request cannot clear it on a later timeout.
        preferredPhoneGeneration += 1
        registeredPhone = registration.copy(generation = preferredPhoneGeneration)
      }
    }
  }

  private data class PreferredPhoneRegistration(
    val nodeId: String,
    val generation: Long,
  )

  private data class PendingWearRequest(
    val nodeId: String,
    val response: CompletableDeferred<WearMessage.Response>,
    val preferredPhone: PreferredPhoneRegistration?,
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
            selectReachablePhoneNodeId(
              capabilityClient
                .getCapability(WearProtocol.PHONE_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
                .await()
                .nodes
                .map { node -> WearReachablePhoneNode(id = node.id, isNearby = node.isNearby) },
            )
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

internal data class WearReachablePhoneNode(
  val id: String,
  val isNearby: Boolean,
)

internal fun selectReachablePhoneNodeId(nodes: Collection<WearReachablePhoneNode>): String? {
  val distinctNodes = nodes.distinctBy(WearReachablePhoneNode::id)
  val nearbyNodes = distinctNodes.filter(WearReachablePhoneNode::isNearby)
  return when {
    nearbyNodes.size == 1 -> nearbyNodes.single().id
    nearbyNodes.isNotEmpty() -> null
    distinctNodes.size == 1 -> distinctNodes.single().id
    else -> null
  }
}

private fun WearRpcMethod.requiresPreferredSnapshotSource(): Boolean = this == WearRpcMethod.ProxyStatus || this == WearRpcMethod.SessionsList || this == WearRpcMethod.ChatHistory

internal enum class WearSequenceDecision {
  Accepted,
  AwaitingSnapshot,
  GapOrReset,
}

internal data class WearResponseRequest(
  val responseGeneration: Long,
  val eventGeneration: Long,
)

internal class WearEventSequenceTracker {
  private var streamId: String? = null
  private var lastSequence: Long? = null
  private var awaitingSnapshot = false
  private var responseGeneration = 0L
  private var eventGeneration = 0L

  @Synchronized
  fun adoptSnapshot(
    streamId: String?,
    sequence: Long?,
  ) {
    eventGeneration += 1
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
      eventGeneration += 1
      return WearSequenceDecision.Accepted
    }
    if (this.streamId != streamId && (this.streamId != null || streamId != null)) {
      awaitingSnapshot = true
      eventGeneration += 1
      return WearSequenceDecision.GapOrReset
    }
    if (sequence == previous + 1) {
      lastSequence = sequence
      eventGeneration += 1
      return WearSequenceDecision.Accepted
    }
    // Stream epochs expose phone restarts even when the new process happens to
    // produce the next numeric sequence. Legacy null epochs still use gap detection.
    awaitingSnapshot = true
    eventGeneration += 1
    return WearSequenceDecision.GapOrReset
  }

  // Only the newest model RPC may mutate UI state. The event generation also
  // rejects legacy unwatermarked responses when live state advanced meanwhile.
  @Synchronized
  fun beginResponseRequest(): WearResponseRequest {
    responseGeneration += 1
    return WearResponseRequest(responseGeneration = responseGeneration, eventGeneration = eventGeneration)
  }

  @Synchronized
  fun invalidateResponseRequests() {
    responseGeneration += 1
  }

  @Synchronized
  fun isResponseCurrent(
    request: WearResponseRequest,
    streamId: String?,
    sequence: Long?,
  ): Boolean {
    if (request.responseGeneration != responseGeneration) return false
    if (awaitingSnapshot) return false
    if (this.streamId != streamId && (this.streamId != null || streamId != null)) return false
    val currentSequence = lastSequence
    return if (sequence == null) {
      request.eventGeneration == eventGeneration
    } else {
      sequence == currentSequence
    }
  }

  @Synchronized
  fun requireSnapshot() {
    awaitingSnapshot = true
    eventGeneration += 1
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
