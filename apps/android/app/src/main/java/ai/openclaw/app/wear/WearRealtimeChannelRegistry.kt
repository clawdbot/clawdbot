package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeAudioFrameType
import ai.openclaw.wear.shared.WearRealtimeAudioFraming
import android.content.Context
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal data class WearRealtimeAttemptOwner(
  val nodeId: String,
  val attemptId: String,
  val channelGeneration: Long,
)

internal data class WearRealtimeChannelClaim(
  val owner: WearRealtimeAttemptOwner,
  val newlyAcquired: Boolean,
)

internal data class WearRealtimeChannelResources(
  val input: InputStream,
  val output: OutputStream,
)

internal interface WearRealtimeChannelTransport {
  suspend fun open(channel: ChannelClient.Channel): WearRealtimeChannelResources?

  suspend fun close(
    channel: ChannelClient.Channel,
    resources: WearRealtimeChannelResources?,
  )
}

private class GoogleWearRealtimeChannelTransport(
  context: Context,
) : WearRealtimeChannelTransport {
  private val client = Wearable.getChannelClient(context.applicationContext)

  override suspend fun open(channel: ChannelClient.Channel): WearRealtimeChannelResources? {
    val input = runCatching { client.getInputStream(channel).awaitWearTask() }.getOrNull()
    val output = runCatching { client.getOutputStream(channel).awaitWearTask() }.getOrNull()
    if (input == null || output == null) {
      input.closeQuietly()
      output.closeQuietly()
      runCatching { client.close(channel).awaitWearTask() }
      return null
    }
    return WearRealtimeChannelResources(input, output)
  }

  override suspend fun close(
    channel: ChannelClient.Channel,
    resources: WearRealtimeChannelResources?,
  ) {
    resources?.input.closeQuietly()
    resources?.output.closeQuietly()
    runCatching { client.close(channel).awaitWearTask() }
  }
}

internal class WearRealtimeChannelRegistry(
  private val scope: CoroutineScope,
  private val transport: WearRealtimeChannelTransport,
  private val connectionReadyTimeoutMillis: Long = DEFAULT_CONNECTION_READY_TIMEOUT_MILLIS,
  private val pendingConnectionTimeoutMillis: Long = WearProtocol.REALTIME_AUDIO_PENDING_CHANNEL_TIMEOUT_MILLIS,
  private val retireCallbackTimeoutMillis: Long = DEFAULT_RETIRE_CALLBACK_TIMEOUT_MILLIS,
  private val maxStagedConnectionsPerNode: Int = DEFAULT_MAX_STAGED_CONNECTIONS_PER_NODE,
  private val maxStagedConnections: Int = DEFAULT_MAX_STAGED_CONNECTIONS,
) {
  private data class ChannelKey(
    val nodeId: String,
    val path: String,
  )

  private data class ChannelPromotion(
    val connection: Connection,
    val displaced: Connection?,
    val claimSequence: Long,
  )

  private sealed interface ChannelClaimSelection {
    data class Claimed(
      val claim: WearRealtimeChannelClaim,
    ) : ChannelClaimSelection

    data class Promote(
      val promotion: ChannelPromotion,
    ) : ChannelClaimSelection

    data object Wait : ChannelClaimSelection

    data object Superseded : ChannelClaimSelection
  }

  constructor(context: Context, scope: CoroutineScope) : this(
    scope,
    GoogleWearRealtimeChannelTransport(context),
  )

  private val lifecycleMutex = Mutex()
  private val channelGeneration = AtomicLong()
  private val claimSequence = AtomicLong()
  private val connections = mutableMapOf<String, Connection>()
  private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  // Channel receipt is not attempt order. Stage exact paths until a start claim reserves promotion.
  private val pendingConnections = mutableMapOf<ChannelKey, Connection>()
  private val promotingConnections = mutableMapOf<ChannelKey, Connection>()
  private val latestClaimSequences = mutableMapOf<String, Long>()
  private val openingConnectionsByNode = mutableMapOf<String, Int>()
  private var openingConnectionCount = 0

  fun accept(
    channel: ChannelClient.Channel,
    appendAudio: (owner: WearRealtimeAttemptOwner, payload: ByteArray) -> Unit,
    stopTalk: suspend (owner: WearRealtimeAttemptOwner) -> Unit,
  ) {
    if (!WearProtocol.isRealtimeAudioChannelPath(channel.path) || channel.nodeId.isBlank()) {
      scope.launch { transport.close(channel, null) }
      return
    }
    val generation = channelGeneration.incrementAndGet()
    scope.launch(Dispatchers.IO) {
      if (!reserveOpeningSlot(channel.nodeId)) {
        runCatching { transport.close(channel, null) }
        return@launch
      }
      var openingSlotReserved = true
      try {
        val resources = transport.open(channel) ?: return@launch
        val connection = Connection(channel, resources, generation, stopTalk)
        var published = false
        var activated = false
        var displacedActive: Connection? = null
        val displacedPending =
          lifecycleMutex.withLock {
            releaseOpeningSlotLocked(channel.nodeId)
            openingSlotReserved = false
            val active = connections[channel.nodeId]
            val pending = pendingConnections[connection.key]
            if (
              active?.generation?.let { it > generation } == true ||
              pending?.generation?.let { it > generation } == true
            ) {
              return@withLock null
            }
            published = true
            connection.ready = true
            if (
              WearProtocol.isAttemptScopedRealtimeAudioChannelPath(channel.path) &&
              active?.takeIf { it.ready && !it.retirementStarted.get() }?.channel?.path == channel.path
            ) {
              // Attempt-scoped reconnects can inherit the live owner before the old reader reports EOF.
              active.ready = false
              connection.owner = active.owner
              connection.claimSequence = active.claimSequence
              active.owner = null
              connections[channel.nodeId] = connection
              displacedActive = active
              activated = true
              pendingConnections.remove(connection.key)
            } else {
              pendingConnections.put(connection.key, connection)
            }
          }
        if (!published) {
          connection.retire(transport)
          return@launch
        }
        displacedPending?.retire(transport)
        displacedActive?.retire(transport)
        if (activated) {
          connection.activation.complete(true)
        } else {
          schedulePendingExpiry(connection)
        }
        try {
          // The Watch starts capture after the start RPC; do not consume its PCM before that claim owns this path.
          if (!connection.activation.await()) return@launch
          while (isKnown(connection)) {
            val frame = WearRealtimeAudioFraming.read(resources.input) ?: break
            if (frame.type != WearRealtimeAudioFrameType.INPUT_PCM) break
            val owner =
              lifecycleMutex.withLock {
                connection.owner.takeIf {
                  connection.ready && connections[channel.nodeId] === connection
                }
              }
            if (owner != null) appendAudio(owner, frame.payload)
          }
        } catch (err: CancellationException) {
          currentCoroutineContext().ensureActive()
        } catch (_: Throwable) {
          // A malformed frame or transport failure owns this channel only.
        } finally {
          retireKnownConnection(connection)
        }
      } finally {
        if (openingSlotReserved) {
          withContext(NonCancellable) {
            releaseOpeningSlot(channel.nodeId)
          }
        }
      }
    }
  }

  suspend fun claim(
    nodeId: String,
    attemptId: String,
    attemptScopedAudio: Boolean = true,
  ): WearRealtimeChannelClaim? {
    val expectedPath =
      if (attemptScopedAudio) {
        WearProtocol.realtimeAudioChannelPath(attemptId)
      } else {
        WearProtocol.LEGACY_REALTIME_AUDIO_CHANNEL_PATH
      }
    val key = ChannelKey(nodeId, expectedPath)
    val sequence = claimSequence.incrementAndGet()
    lifecycleMutex.withLock {
      latestClaimSequences[nodeId] = sequence
    }
    val deadlineNanos =
      System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(connectionReadyTimeoutMillis)
    while (true) {
      currentCoroutineContext().ensureActive()
      when (val selection = reserveClaim(nodeId, attemptId, expectedPath, key, sequence)) {
        is ChannelClaimSelection.Claimed -> {
          return selection.claim
        }

        is ChannelClaimSelection.Promote -> {
          return completePromotion(nodeId, attemptId, key, selection.promotion)
        }

        ChannelClaimSelection.Superseded -> {
          return null
        }

        ChannelClaimSelection.Wait -> {
          val remainingNanos = deadlineNanos - System.nanoTime()
          if (remainingNanos <= 0L) return null
          val waitMillis =
            TimeUnit.NANOSECONDS
              .toMillis(remainingNanos)
              .coerceIn(1L, CONNECTION_POLL_MILLIS)
          delay(waitMillis)
        }
      }
    }
  }

  private suspend fun reserveClaim(
    nodeId: String,
    attemptId: String,
    expectedPath: String,
    key: ChannelKey,
    sequence: Long,
  ): ChannelClaimSelection =
    lifecycleMutex.withLock {
      if (latestClaimSequences[nodeId] != sequence) return@withLock ChannelClaimSelection.Superseded
      if (promotingConnections.keys.any { promotingKey -> promotingKey.nodeId == nodeId }) {
        return@withLock ChannelClaimSelection.Wait
      }
      val connection = pendingConnections.remove(key)
      if (connection != null) {
        val displaced = connections[nodeId]
        // Reservation is the ordering boundary. Later claims wait for this bounded handoff, then may replace it.
        connection.ready = false
        displaced?.ready = false
        promotingConnections[key] = connection
        return@withLock ChannelClaimSelection.Promote(
          ChannelPromotion(
            connection = connection,
            displaced = displaced,
            claimSequence = sequence,
          ),
        )
      }
      connections[nodeId]?.let { active ->
        if (active.claimSequence > sequence) return@withLock ChannelClaimSelection.Superseded
        val current = active.owner
        if (active.ready && active.channel.path == expectedPath) {
          if (current?.attemptId == attemptId) {
            active.claimSequence = sequence
            return@withLock ChannelClaimSelection.Claimed(
              WearRealtimeChannelClaim(current, newlyAcquired = false),
            )
          }
          if (current == null) {
            val owner = WearRealtimeAttemptOwner(nodeId, attemptId, active.generation)
            active.owner = owner
            active.claimSequence = sequence
            return@withLock ChannelClaimSelection.Claimed(
              WearRealtimeChannelClaim(owner, newlyAcquired = true),
            )
          }
        }
      }
      ChannelClaimSelection.Wait
    }

  private suspend fun reserveOpeningSlot(nodeId: String): Boolean =
    lifecycleMutex.withLock {
      val stagedForNode =
        pendingConnections.keys.count { key -> key.nodeId == nodeId } +
          promotingConnections.keys.count { key -> key.nodeId == nodeId } +
          (openingConnectionsByNode[nodeId] ?: 0)
      val stagedTotal = pendingConnections.size + promotingConnections.size + openingConnectionCount
      if (
        stagedForNode >= maxStagedConnectionsPerNode ||
        stagedTotal >= maxStagedConnections
      ) {
        return@withLock false
      }
      openingConnectionsByNode[nodeId] = (openingConnectionsByNode[nodeId] ?: 0) + 1
      openingConnectionCount += 1
      true
    }

  private suspend fun releaseOpeningSlot(nodeId: String) {
    lifecycleMutex.withLock {
      releaseOpeningSlotLocked(nodeId)
    }
  }

  private fun releaseOpeningSlotLocked(nodeId: String) {
    val count = checkNotNull(openingConnectionsByNode[nodeId])
    if (count == 1) {
      openingConnectionsByNode.remove(nodeId)
    } else {
      openingConnectionsByNode[nodeId] = count - 1
    }
    openingConnectionCount -= 1
  }

  private suspend fun completePromotion(
    nodeId: String,
    attemptId: String,
    key: ChannelKey,
    promotion: ChannelPromotion,
  ): WearRealtimeChannelClaim? {
    var connection = promotion.connection
    var promoted = false
    try {
      // Discovery already succeeded, so finish this bounded handoff even if the polling deadline has elapsed.
      promotion.displaced?.let { retireCurrentConnection(it) }
      while (true) {
        currentCoroutineContext().ensureActive()
        var superseded: Connection? = null
        var owner: WearRealtimeAttemptOwner? = null
        val valid =
          lifecycleMutex.withLock {
            if (promotingConnections[key] !== connection || connection.retirementStarted.get()) {
              return@withLock false
            }
            val replacement =
              pendingConnections[key]?.takeIf {
                it.generation > connection.generation && !it.retirementStarted.get()
              }
            if (replacement != null) {
              pendingConnections.remove(key, replacement)
              replacement.ready = false
              promotingConnections[key] = replacement
              superseded = connection
              connection = replacement
            } else {
              promotingConnections.remove(key, connection)
              owner = WearRealtimeAttemptOwner(nodeId, attemptId, connection.generation)
              connection.owner = owner
              connection.claimSequence = promotion.claimSequence
              connection.ready = true
              connections[nodeId] = connection
              promoted = true
            }
            true
          }
        if (!valid) return null
        val retired = superseded
        if (retired != null) {
          // A reconnect can arrive while owner cleanup runs. Publish the newest exact-path channel.
          retired.retire(transport)
          continue
        }
        val committedOwner = checkNotNull(owner)
        connection.activation.complete(true)
        return WearRealtimeChannelClaim(committedOwner, newlyAcquired = true)
      }
    } finally {
      if (!promoted) retirePromotingConnection(connection)
    }
  }

  suspend fun send(
    owner: WearRealtimeAttemptOwner,
    type: WearRealtimeAudioFrameType,
    payload: ByteArray,
  ) {
    val connection =
      lifecycleMutex.withLock {
        connections[owner.nodeId]?.takeIf { it.owner == owner }
      } ?: error("Wear realtime audio channel is unavailable")
    connection.write(type, payload)
  }

  suspend fun release(owner: WearRealtimeAttemptOwner) {
    lifecycleMutex.withLock {
      connections[owner.nodeId]
        ?.takeIf { it.owner == owner }
        ?.owner = null
    }
  }

  suspend fun isCurrent(owner: WearRealtimeAttemptOwner): Boolean =
    lifecycleMutex.withLock {
      connections[owner.nodeId]?.let { connection ->
        connection.ready &&
          !connection.retirementStarted.get() &&
          connection.owner == owner
      } == true
    }

  suspend fun close(owner: WearRealtimeAttemptOwner) {
    val connection =
      lifecycleMutex.withLock {
        connections[owner.nodeId]
          ?.takeIf { it.owner == owner }
          ?.also { it.ready = false }
      }
    connection?.let { retireCurrentConnection(it) }
  }

  private fun schedulePendingExpiry(connection: Connection) {
    scope.launch {
      delay(pendingConnectionTimeoutMillis)
      val expired =
        lifecycleMutex.withLock {
          pendingConnections.remove(connection.key, connection)
        }
      if (expired) connection.retire(transport)
    }
  }

  private suspend fun isKnown(item: Connection): Boolean = lifecycleMutex.withLock { isKnownLocked(item) }

  private fun isKnownLocked(item: Connection): Boolean =
    connections[item.channel.nodeId] === item ||
      pendingConnections[item.key] === item ||
      promotingConnections[item.key] === item

  private fun isCurrentLocked(item: Connection): Boolean = connections[item.channel.nodeId] === item

  private suspend fun retireCurrentConnection(connection: Connection) {
    withContext(NonCancellable) {
      lifecycleMutex.withLock {
        if (isCurrentLocked(connection)) connection.ready = false
      }
      connection.retire(transport)
      lifecycleMutex.withLock {
        if (isCurrentLocked(connection)) connections.remove(connection.channel.nodeId)
      }
    }
  }

  private suspend fun retirePromotingConnection(connection: Connection) {
    withContext(NonCancellable) {
      lifecycleMutex.withLock {
        promotingConnections.remove(connection.key, connection)
      }
      connection.retire(transport)
    }
  }

  private suspend fun retireKnownConnection(connection: Connection) {
    withContext(NonCancellable) {
      lifecycleMutex.withLock {
        if (isCurrentLocked(connection)) connection.ready = false
        pendingConnections.remove(connection.key, connection)
        promotingConnections.remove(connection.key, connection)
      }
      connection.retire(transport)
      lifecycleMutex.withLock {
        if (isCurrentLocked(connection)) connections.remove(connection.channel.nodeId)
      }
    }
  }

  private suspend fun Connection.retire(transport: WearRealtimeChannelTransport) {
    if (retirementStarted.compareAndSet(false, true)) {
      val retiringOwner = owner
      withContext(NonCancellable) {
        try {
          activation.complete(false)
          retiringOwner?.let { owner ->
            val stopJob =
              cleanupScope.launch {
                runCatching { stopTalk(owner) }
              }
            withTimeoutOrNull(retireCallbackTimeoutMillis) {
              stopJob.join()
            }
          }
          val closedWithinHandoff =
            withTimeoutOrNull(retireCallbackTimeoutMillis) {
              runCatching { close(transport) }.isSuccess
            } == true
          if (!closedWithinHandoff) {
            // Keep transport cleanup alive after the bounded owner handoff returns.
            cleanupScope.launch {
              runCatching { close(transport) }
            }
          }
        } finally {
          retirementComplete.complete(Unit)
        }
      }
    } else {
      withContext(NonCancellable) {
        withTimeoutOrNull(RETIRE_COMPLETION_TIMEOUT_MILLIS) {
          retirementComplete.await()
        }
      }
    }
  }

  private class Connection(
    val channel: ChannelClient.Channel,
    val resources: WearRealtimeChannelResources,
    val generation: Long,
    val stopTalk: suspend (owner: WearRealtimeAttemptOwner) -> Unit,
  ) {
    val key = ChannelKey(channel.nodeId, channel.path)
    private val writeMutex = Mutex()
    private val closeMutex = Mutex()
    private var closed = false
    val retirementStarted = AtomicBoolean()
    val retirementComplete = CompletableDeferred<Unit>()
    val activation = CompletableDeferred<Boolean>()

    @Volatile var owner: WearRealtimeAttemptOwner? = null

    @Volatile var claimSequence: Long = 0L

    @Volatile var ready: Boolean = false

    suspend fun write(
      type: WearRealtimeAudioFrameType,
      payload: ByteArray,
    ) {
      writeMutex.withLock {
        withContext(Dispatchers.IO) {
          WearRealtimeAudioFraming.write(resources.output, type, payload)
        }
      }
    }

    suspend fun close(transport: WearRealtimeChannelTransport) {
      // Retirement must not close the stream beneath a frame already selected for this connection.
      writeMutex.withLock {
        closeMutex.withLock {
          if (closed) return
          transport.close(channel, resources)
          closed = true
        }
      }
    }
  }

  private companion object {
    const val CONNECTION_POLL_MILLIS = 25L
    const val DEFAULT_CONNECTION_READY_TIMEOUT_MILLIS = 3_000L
    const val DEFAULT_RETIRE_CALLBACK_TIMEOUT_MILLIS = 1_000L
    const val DEFAULT_MAX_STAGED_CONNECTIONS_PER_NODE = 4
    const val DEFAULT_MAX_STAGED_CONNECTIONS = 16
    const val RETIRE_COMPLETION_TIMEOUT_MILLIS = 2_500L
  }
}

private fun java.io.Closeable?.closeQuietly() {
  runCatching { this?.close() }
}
