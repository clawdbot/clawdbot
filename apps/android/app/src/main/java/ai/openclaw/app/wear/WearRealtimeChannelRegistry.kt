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
) {
  constructor(context: Context, scope: CoroutineScope) : this(
    scope,
    GoogleWearRealtimeChannelTransport(context),
  )

  private val lifecycleMutex = Mutex()
  private val channelGeneration = AtomicLong()
  private val connections = mutableMapOf<String, Connection>()

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
      val resources = transport.open(channel) ?: return@launch
      val connection = Connection(channel, resources, generation)
      var published = false
      val displaced =
        lifecycleMutex.withLock {
          val current = connections[channel.nodeId]
          if (current != null && current.generation > generation) {
            null
          } else {
            published = true
            connection.predecessor = current
            connections.put(channel.nodeId, connection)
          }
        }
      if (!published) {
        connection.retire(transport, stopTalk)
        return@launch
      }
      displaced?.retire(transport, stopTalk)
      connection.predecessor = null
      lifecycleMutex.withLock {
        if (connections[channel.nodeId] === connection) connection.ready = true
      }
      try {
        while (isCurrent(connection)) {
          val frame = WearRealtimeAudioFraming.read(resources.input) ?: break
          if (frame.type != WearRealtimeAudioFrameType.INPUT_PCM) break
          val owner = lifecycleMutex.withLock { connection.owner.takeIf { connections[channel.nodeId] === connection } }
          if (owner != null) appendAudio(owner, frame.payload)
        }
      } catch (err: CancellationException) {
        currentCoroutineContext().ensureActive()
      } catch (_: Throwable) {
        // A malformed frame or transport failure owns this channel only.
      } finally {
        retireCurrentConnection(connection, stopTalk)
      }
    }
  }

  suspend fun claim(
    nodeId: String,
    attemptId: String,
  ): WearRealtimeChannelClaim? =
    withTimeoutOrNull(CONNECTION_READY_TIMEOUT_MILLIS) {
      val expectedPath = WearProtocol.realtimeAudioChannelPath(attemptId)
      while (true) {
        lifecycleMutex.withLock {
          connections[nodeId]?.let { connection ->
            if (!connection.ready || connection.channel.path != expectedPath) return@withLock
            val current = connection.owner
            if (current == null) {
              val owner = WearRealtimeAttemptOwner(nodeId, attemptId, connection.generation)
              connection.owner = owner
              return@withTimeoutOrNull WearRealtimeChannelClaim(owner, newlyAcquired = true)
            }
            if (current.attemptId == attemptId) {
              return@withTimeoutOrNull WearRealtimeChannelClaim(current, newlyAcquired = false)
            }
          }
        }
        delay(CONNECTION_POLL_MILLIS)
      }
      null
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

  suspend fun close(
    owner: WearRealtimeAttemptOwner,
    stopTalk: suspend (owner: WearRealtimeAttemptOwner) -> Unit,
  ) {
    val connection =
      lifecycleMutex.withLock {
        connections[owner.nodeId]
          ?.takeIf { it.owner == owner }
          ?.also { it.ready = false }
      }
    connection?.let { retireCurrentConnection(it, stopTalk) }
  }

  private suspend fun isCurrent(item: Connection): Boolean = lifecycleMutex.withLock { isCurrentLocked(item) }

  private fun isCurrentLocked(item: Connection): Boolean = connections[item.channel.nodeId] === item

  private suspend fun retireCurrentConnection(
    connection: Connection,
    stopTalk: suspend (owner: WearRealtimeAttemptOwner) -> Unit,
  ) {
    lifecycleMutex.withLock {
      if (isCurrentLocked(connection)) connection.ready = false
    }
    connection.retire(transport, stopTalk)
    lifecycleMutex.withLock {
      if (isCurrentLocked(connection)) connections.remove(connection.channel.nodeId)
    }
  }

  private suspend fun Connection.retire(
    transport: WearRealtimeChannelTransport,
    stopTalk: suspend (owner: WearRealtimeAttemptOwner) -> Unit,
  ) {
    if (retirementStarted.compareAndSet(false, true)) {
      val retiringOwner = owner
      withContext(NonCancellable) {
        try {
          predecessor?.retire(transport, stopTalk)
          predecessor = null
          close(transport)
          retiringOwner?.let { runCatching { stopTalk(it) } }
        } finally {
          retirementComplete.complete(Unit)
        }
      }
    } else {
      retirementComplete.await()
    }
  }

  private class Connection(
    val channel: ChannelClient.Channel,
    val resources: WearRealtimeChannelResources,
    val generation: Long,
  ) {
    private val writeMutex = Mutex()
    private val closed = AtomicBoolean()
    val retirementStarted = AtomicBoolean()
    val retirementComplete = CompletableDeferred<Unit>()

    @Volatile var predecessor: Connection? = null

    @Volatile var owner: WearRealtimeAttemptOwner? = null

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
      if (!closed.compareAndSet(false, true)) return
      transport.close(channel, resources)
    }
  }

  private companion object {
    const val CONNECTION_POLL_MILLIS = 25L
    const val CONNECTION_READY_TIMEOUT_MILLIS = 3_000L
  }
}

private fun java.io.Closeable?.closeQuietly() {
  runCatching { this?.close() }
}
