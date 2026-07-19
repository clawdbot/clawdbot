package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcError
import android.content.Context
import android.os.SystemClock
import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun interface WearMessageSender {
  suspend fun send(
    nodeId: String,
    path: String,
    data: ByteArray,
  )
}

internal fun interface WearPeerResolver {
  suspend fun reachableWatchNodeIds(): Set<String>
}

internal class GoogleWearMessageSender(
  context: Context,
) : WearMessageSender {
  private val messageClient = Wearable.getMessageClient(context.applicationContext)

  override suspend fun send(
    nodeId: String,
    path: String,
    data: ByteArray,
  ) {
    messageClient.sendMessage(nodeId, path, data).awaitWearTask()
  }
}

internal class GoogleWearPeerResolver(
  context: Context,
) : WearPeerResolver {
  private val capabilityClient = Wearable.getCapabilityClient(context.applicationContext)

  override suspend fun reachableWatchNodeIds(): Set<String> =
    capabilityClient
      .getCapability(WearProtocol.WATCH_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .awaitWearTask()
      .nodes
      .mapTo(linkedSetOf()) { it.id }
}

internal class WearProxyBridge(
  private val scope: CoroutineScope,
  private val sender: WearMessageSender,
  private val peerResolver: WearPeerResolver = WearPeerResolver { emptySet() },
  private val monotonicMillis: () -> Long = SystemClock::elapsedRealtime,
  private val handleRequest: suspend (String, WearMessage.Request) -> WearMessage.Response,
) {
  private val peerLock = Any()
  private val peers = LinkedHashMap<String, Long>()
  private val missingPeers = LinkedHashSet<String>()
  private var peerGeneration = 0L
  private val nextSequence = AtomicLong()
  private val eventStreamId = UUID.randomUUID().toString()
  private val overflowLock = Any()
  private val pendingTerminalEvents = ArrayDeque<WearMessage.Event>()
  private val chatStreamProjector = WearChatStreamProjector()
  private val requestPermits = Semaphore(MAX_PENDING_REQUESTS)
  private var pendingEventCount = 0
  private var resyncRequired = false
  private var lastPeerDiscoveryAtMillis: Long? = null

  // Events and requests are bounded before entering this single actor. An overflow
  // marker occupies the exact queue position where dropped sequences become visible.
  private val operations = Channel<WearBridgeOperation>(capacity = Channel.UNLIMITED)

  init {
    scope.launch {
      var lastDeliveredSequence = 0L
      for (operation in operations) {
        try {
          lastDeliveredSequence = processOperation(operation, lastDeliveredSequence)
        } catch (err: CancellationException) {
          // A transport implementation may surface cancellation as its failure result. Keep the
          // shared actor alive unless its owning scope was actually canceled.
          currentCoroutineContext().ensureActive()
        }
      }
    }
  }

  private suspend fun processOperation(
    operation: WearBridgeOperation,
    lastDeliveredSequence: Long,
  ): Long =
    when (operation) {
      is WearBridgeOperation.Event -> {
        markEventDequeued()
        sendEventPreservingActor(operation.message)
        operation.message.sequence
      }
      is WearBridgeOperation.Request -> {
        try {
          val response =
            handleRequest(operation.sourcePeer.nodeId, operation.message).copy(
              eventStreamId = eventStreamId,
              eventSequence = lastDeliveredSequence,
            )
          operation.completion.complete(
            sendResponseToPeer(operation.sourcePeer, encodeResponse(response)),
          )
        } catch (err: Throwable) {
          operation.completion.completeExceptionally(err)
          // A canceled request or Play Services task must not kill the process actor.
          // Parent-scope cancellation still propagates and terminates the bridge.
          if (err is CancellationException) currentCoroutineContext().ensureActive()
        }
        lastDeliveredSequence
      }
      WearBridgeOperation.Overflow -> {
        val overflow = takeOverflow()
        var deliveredSequence = lastDeliveredSequence
        for (terminal in overflow.terminalEvents.sortedBy { it.sequence }) {
          sendEventPreservingActor(terminal)
          deliveredSequence = terminal.sequence
        }
        overflow.resyncEvent?.let { resync ->
          sendEventPreservingActor(resync)
          deliveredSequence = resync.sequence
        }
        deliveredSequence
      }
      is WearBridgeOperation.Barrier -> {
        operation.completion.complete(Unit)
        lastDeliveredSequence
      }
    }

  suspend fun handleMessage(
    sourceNodeId: String,
    data: ByteArray,
  ): Boolean {
    if (sourceNodeId.isBlank()) return false
    val request =
      (WearProtocolCodec.decode(data) as? WearDecodeResult.Success)
        ?.message as? WearMessage.Request ?: return false
    val peer = rememberPeer(sourceNodeId)
    return requestPermits.withPermit {
      val completion = CompletableDeferred<Boolean>()
      operations.send(WearBridgeOperation.Request(peer, request, completion))
      completion.await()
    }
  }

  fun publishConnection(
    connected: Boolean,
    status: String,
  ) {
    synchronized(overflowLock) {
      if (!connected) chatStreamProjector.reset()
      publishEventLocked(
        WearEventType.Connection,
        buildJsonObject {
          put("connected", connected)
          put("status", status)
        },
      )
    }
  }

  fun publishChat(payload: JsonElement) {
    synchronized(overflowLock) {
      chatStreamProjector.project(payload)?.let { projected ->
        val state = (projected["state"] as? JsonPrimitive)?.contentOrNull
        publishEventLocked(
          type = WearEventType.Chat,
          payload = projected,
          terminal = state == "final" || state == "aborted" || state == "error",
        )
      }
    }
  }

  fun publishTalk(payload: JsonElement) {
    synchronized(overflowLock) {
      publishEventLocked(WearEventType.Talk, payload)
    }
  }

  fun publishResync() {
    synchronized(overflowLock) {
      publishEventLocked(WearEventType.Resync)
    }
  }

  /** Test-only actor barrier; proves every operation queued before this call has settled. */
  internal suspend fun awaitIdleForTests() {
    val completion = CompletableDeferred<Unit>()
    operations.send(WearBridgeOperation.Barrier(completion))
    completion.await()
  }

  /** Projection/reset, sequence allocation, and actor insertion share [overflowLock]. */
  private fun publishEventLocked(
    type: WearEventType,
    payload: JsonElement? = null,
    terminal: Boolean = false,
  ) {
    val event =
      WearMessage.Event(
        streamId = eventStreamId,
        sequence = nextSequence.incrementAndGet(),
        event = type,
        payload = payload,
      )
    if (resyncRequired || pendingEventCount >= MAX_BUFFERED_EVENTS) {
      if (!resyncRequired) {
        resyncRequired = true
        operations.trySend(WearBridgeOperation.Overflow).getOrThrow()
      }
      resyncRequired = true
      if (terminal) {
        if (pendingTerminalEvents.size == MAX_PENDING_TERMINAL_EVENTS) {
          pendingTerminalEvents.removeFirst()
        }
        pendingTerminalEvents.addLast(event)
      }
    } else {
      pendingEventCount += 1
      operations.trySend(WearBridgeOperation.Event(event)).getOrThrow()
    }
  }

  private fun markEventDequeued() {
    synchronized(overflowLock) {
      check(pendingEventCount > 0)
      pendingEventCount -= 1
    }
  }

  private fun takeOverflow(): WearOverflowSnapshot =
    synchronized(overflowLock) {
      val resyncEvent =
        if (resyncRequired) {
          WearMessage.Event(
            streamId = eventStreamId,
            sequence = nextSequence.incrementAndGet(),
            event = WearEventType.Resync,
          )
        } else {
          null
        }
      WearOverflowSnapshot(
        terminalEvents = pendingTerminalEvents.toList(),
        resyncEvent = resyncEvent,
      ).also {
        pendingTerminalEvents.clear()
        resyncRequired = false
      }
    }

  private sealed interface WearBridgeOperation {
    data class Request(
      val sourcePeer: PeerRegistration,
      val message: WearMessage.Request,
      val completion: CompletableDeferred<Boolean>,
    ) : WearBridgeOperation

    data class Event(
      val message: WearMessage.Event,
    ) : WearBridgeOperation

    data object Overflow : WearBridgeOperation

    data class Barrier(
      val completion: CompletableDeferred<Unit>,
    ) : WearBridgeOperation
  }

  private data class WearOverflowSnapshot(
    val terminalEvents: List<WearMessage.Event>,
    val resyncEvent: WearMessage.Event?,
  )

  private suspend fun sendEvent(event: WearMessage.Event) {
    val encoded = runCatching { WearProtocolCodec.encode(event) }.getOrNull() ?: return
    val terminalChatEvent = event.isTerminalChatEvent()
    // A terminal reply may need to notify a watch that has not contacted this phone
    // process yet, even while another remembered watch remains healthy.
    discoverPeers(forceRefresh = terminalChatEvent, bypassNegativeCache = terminalChatEvent)
    val initialPeers = peerSnapshot()
    if (initialPeers.isEmpty()) return
    val initialResult = sendToPeers(initialPeers, encoded)
    if (initialResult.failed.isEmpty()) return

    // Refresh after any stale peer, but do not redeliver the sequence to watches
    // that already accepted it. Newly reachable and recovered peers get one retry.
    discoverPeers(forceRefresh = true, bypassNegativeCache = true)
    val retryPeers = peerSnapshot().filterNot { it.nodeId in initialResult.delivered }
    sendToPeers(retryPeers, encoded)
  }

  private suspend fun sendEventPreservingActor(event: WearMessage.Event) {
    try {
      sendEvent(event)
    } catch (err: CancellationException) {
      // Play Services may cancel one transport Task without canceling this actor.
      // Only parent-scope cancellation should terminate the shared event/request loop.
      currentCoroutineContext().ensureActive()
    }
  }

  private fun WearMessage.Event.isTerminalChatEvent(): Boolean {
    if (event != WearEventType.Chat) return false
    val state = ((payload as? JsonObject)?.get("state") as? JsonPrimitive)?.contentOrNull
    return state == "final" || state == "aborted" || state == "error"
  }

  private suspend fun sendToPeers(
    peers: List<PeerRegistration>,
    data: ByteArray,
  ): WearPeerSendResult {
    val delivered = linkedSetOf<String>()
    val failed = linkedSetOf<String>()
    for (peer in peers) {
      if (sendToPeer(peer, WearProtocol.EVENT_PATH, data)) {
        delivered += peer.nodeId
      } else {
        failed += peer.nodeId
      }
    }
    return WearPeerSendResult(delivered = delivered, failed = failed)
  }

  private suspend fun sendResponseToPeer(
    peer: PeerRegistration,
    data: ByteArray,
  ): Boolean {
    if (sendToPeer(peer, WearProtocol.RESPONSE_PATH, data)) return true
    // The request proves this exact node was reachable moments ago. Retry one
    // transport failure directly; a successful retry restores it to the peer set.
    if (!sendToPeer(peer, WearProtocol.RESPONSE_PATH, data)) return false
    rememberPeer(peer.nodeId)
    return true
  }

  private suspend fun discoverPeers(
    forceRefresh: Boolean,
    bypassNegativeCache: Boolean,
  ) {
    if (!forceRefresh && hasPeers() && !needsPeerRefresh()) return
    val now = monotonicMillis()
    val previousDiscovery = lastPeerDiscoveryAtMillis
    if (
      !bypassNegativeCache &&
      previousDiscovery != null &&
      now >= previousDiscovery &&
      now - previousDiscovery < PEER_DISCOVERY_RETRY_MILLIS
    ) {
      return
    }
    lastPeerDiscoveryAtMillis = now
    val resolvedPeers = resolvePeers()
    resolvedPeers.sorted().take(MAX_PEERS).forEach(::rememberPeer)
  }

  private suspend fun resolvePeers(): Set<String> {
    repeat(2) { attempt ->
      try {
        return peerResolver.reachableWatchNodeIds()
      } catch (_: WearTaskCanceledException) {
        if (attempt == 1) return emptySet()
      } catch (err: CancellationException) {
        // A custom resolver may use cancellation as a transient discovery failure.
        // Preserve parent cancellation and retry this event once.
        currentCoroutineContext().ensureActive()
        if (attempt == 1) return emptySet()
      } catch (_: Throwable) {
        return emptySet()
      }
    }
    return emptySet()
  }

  private suspend fun sendToPeer(
    peer: PeerRegistration,
    path: String,
    data: ByteArray,
  ): Boolean {
    try {
      sender.send(peer.nodeId, path, data)
      return true
    } catch (err: CancellationException) {
      // Custom senders may use cancellation for transport failure. Keep the actor
      // cancellation contract while retrying this peer normally.
      currentCoroutineContext().ensureActive()
      markPeerFailed(peer)
      return false
    } catch (_: Throwable) {
      markPeerFailed(peer)
      return false
    }
  }

  private fun encodeResponse(response: WearMessage.Response): ByteArray =
    runCatching { WearProtocolCodec.encode(response) }
      .getOrElse {
        WearProtocolCodec.encode(
          WearMessage.Response(
            requestId = response.requestId,
            ok = false,
            error = WearRpcError(code = "response_too_large", message = "Phone response exceeds Wear transport limits"),
            eventStreamId = response.eventStreamId,
            eventSequence = response.eventSequence,
          ),
        )
      }

  private fun rememberPeer(nodeId: String): PeerRegistration =
    synchronized(peerLock) {
      peerGeneration += 1
      missingPeers.remove(nodeId)
      peers.remove(nodeId)
      peers[nodeId] = peerGeneration
      while (peers.size > MAX_PEERS) {
        peers.remove(peers.keys.first())
      }
      PeerRegistration(nodeId = nodeId, generation = peerGeneration)
    }

  private fun markPeerFailed(peer: PeerRegistration) {
    synchronized(peerLock) {
      // A stale send may fail after a newer request refreshed the same watch.
      // Remove only the registration that actually owned this transport attempt.
      if (peers[peer.nodeId] == peer.generation) {
        peers.remove(peer.nodeId)
        missingPeers.add(peer.nodeId)
      }
    }
  }

  private fun hasPeers(): Boolean = synchronized(peerLock) { peers.isNotEmpty() }

  private fun needsPeerRefresh(): Boolean = synchronized(peerLock) { missingPeers.isNotEmpty() }

  private fun peerSnapshot(): List<PeerRegistration> =
    synchronized(peerLock) {
      peers.map { (nodeId, generation) -> PeerRegistration(nodeId = nodeId, generation = generation) }
    }

  internal fun peerCountForTests(): Int = synchronized(peerLock) { peers.size }

  private data class WearPeerSendResult(
    val delivered: Set<String>,
    val failed: Set<String>,
  )

  private companion object {
    const val MAX_PEERS = 8
    const val MAX_BUFFERED_EVENTS = 32
    const val MAX_PENDING_REQUESTS = 8
    const val MAX_PENDING_TERMINAL_EVENTS = 8
    const val PEER_DISCOVERY_RETRY_MILLIS = 30_000L
  }
}

private data class PeerRegistration(
  val nodeId: String,
  val generation: Long,
)

internal class WearChatStreamProjector {
  private data class StreamKey(
    val sessionKey: String,
    val runId: String?,
  )

  private data class StreamState(
    val text: String,
    val complete: Boolean,
  )

  private val streams = LinkedHashMap<StreamKey, StreamState>()

  @Synchronized
  fun reset() {
    streams.clear()
  }

  @Synchronized
  fun project(payload: JsonElement): JsonObject? {
    val projected = projectWearChatEvent(payload) ?: return null
    val state = (projected["state"] as? JsonPrimitive)?.contentOrNull
    val streamKey = streamKey(projected)
    if (state != "delta") {
      if (state == "final" || state == "aborted" || state == "error") {
        streamKey?.let { terminalKey ->
          streams.keys.removeAll { key -> key.sessionKey == terminalKey.sessionKey }
        }
      }
      return projected
    }
    val delta = (projected["deltaText"] as? JsonPrimitive)?.contentOrNull.orEmpty()
    val replace = (projected["replace"] as? JsonPrimitive)?.contentOrNull == "true"
    val fullMessage = projectedWearMessageText(projected["message"])
    if (streamKey == null && fullMessage == null && !replace) {
      // Events without a session cannot affect a selected watch transcript.
      return projected
    }
    val stateKey =
      streamKey?.let { key ->
        if (key.runId != null) {
          key
        } else {
          // A gateway may omit runId on any delta, not only at run start.
          // Keep such deltas on the session's active identified accumulator.
          streams.keys.lastOrNull { candidate -> candidate.sessionKey == key.sessionKey && candidate.runId != null } ?: key
        }
      }
    val previous =
      stateKey?.let { key ->
        streams[key]
          ?: key.runId?.let {
            // Some gateways reveal runId after initial anonymous deltas. Adopt
            // that accumulator so the identified stream keeps its prefix.
            streams.remove(StreamKey(sessionKey = key.sessionKey, runId = null))
          }
      }
    val next =
      when {
        fullMessage != null -> StreamState(fullMessage, complete = true)
        replace -> StreamState(delta, complete = true)
        previous != null -> StreamState(previous.text + delta, complete = previous.complete)
        else -> StreamState(delta, complete = false)
      }.bounded()
    if (stateKey != null) {
      streams.remove(stateKey)
      streams[stateKey] = next
      while (streams.size > MAX_STREAMS) streams.remove(streams.keys.first())
    }
    return buildJsonObject {
      projected.forEach { (key, value) -> put(key, value) }
      put("streamText", next.text)
      put("streamTextComplete", next.complete)
    }
  }

  private fun streamKey(projected: JsonObject): StreamKey? {
    val sessionKey =
      (projected["sessionKey"] as? JsonPrimitive)
        ?.contentOrNull
        ?.takeIf { it.isNotBlank() } ?: return null
    val runId = (projected["runId"] as? JsonPrimitive)?.contentOrNull
    // Some gateway deltas omit runId. Sessions serialize active runs, and every
    // terminal event clears all keys for that session before another run starts.
    return StreamKey(sessionKey = sessionKey, runId = runId)
  }

  private fun StreamState.bounded(): StreamState {
    val count = text.codePointCount(0, text.length)
    if (count <= MAX_STREAM_CODE_POINTS) return this
    val start = text.offsetByCodePoints(0, count - MAX_STREAM_CODE_POINTS)
    return copy(text = text.substring(start))
  }

  private companion object {
    const val MAX_STREAMS = 32
    const val MAX_STREAM_CODE_POINTS = 2_000
  }
}

internal class WearTaskCanceledException : IllegalStateException("Wear message task was canceled")

private val directTaskExecutor = Executor(Runnable::run)

internal suspend fun <T> Task<T>.awaitWearTask(): T =
  suspendCancellableCoroutine { continuation ->
    addOnSuccessListener(directTaskExecutor) { value ->
      if (continuation.isActive) continuation.resume(value)
    }
    addOnFailureListener(directTaskExecutor) { error ->
      if (continuation.isActive) continuation.resumeWithException(error)
    }
    addOnCanceledListener(directTaskExecutor) {
      if (continuation.isActive) continuation.resumeWithException(WearTaskCanceledException())
    }
  }
