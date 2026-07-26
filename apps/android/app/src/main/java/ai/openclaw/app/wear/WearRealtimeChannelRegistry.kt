package ai.openclaw.app.wear

import ai.openclaw.app.NodeRuntime
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeAudioFrameType
import ai.openclaw.wear.shared.WearRealtimeAudioFraming
import android.content.Context
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
import java.util.concurrent.ConcurrentHashMap

internal class WearRealtimeChannelRegistry(
  context: Context,
  private val scope: CoroutineScope,
) {
  private val channelClient = Wearable.getChannelClient(context.applicationContext)
  private val connections = ConcurrentHashMap<String, Connection>()

  fun accept(
    channel: ChannelClient.Channel,
    runtime: () -> NodeRuntime,
  ) {
    if (channel.path != WearProtocol.REALTIME_AUDIO_CHANNEL_PATH || channel.nodeId.isBlank()) {
      scope.launch { runCatching { channelClient.close(channel).awaitWearTask() } }
      return
    }
    scope.launch(Dispatchers.IO) {
      val input = runCatching { channelClient.getInputStream(channel).awaitWearTask() }.getOrNull()
      val output = runCatching { channelClient.getOutputStream(channel).awaitWearTask() }.getOrNull()
      if (input == null || output == null) {
        input.closeQuietly()
        output.closeQuietly()
        runCatching { channelClient.close(channel).awaitWearTask() }
        return@launch
      }
      val connection = Connection(channel, input, output)
      connections.put(channel.nodeId, connection)?.close(channelClient)
      try {
        while (connections[channel.nodeId] === connection) {
          val frame = WearRealtimeAudioFraming.read(input) ?: break
          if (frame.type != WearRealtimeAudioFrameType.INPUT_PCM) break
          runtime().appendWearRealtimeAudio(channel.nodeId, frame.payload)
        }
      } catch (err: CancellationException) {
        currentCoroutineContext().ensureActive()
      } catch (_: Throwable) {
        // A malformed frame or transport failure owns this channel only.
      } finally {
        if (connections.remove(channel.nodeId, connection)) {
          connection.close(channelClient)
          runCatching { runtime().stopWearRealtimeTalk(channel.nodeId) }
        }
      }
    }
  }

  suspend fun send(
    nodeId: String,
    type: WearRealtimeAudioFrameType,
    payload: ByteArray,
  ) {
    val connection =
      withTimeoutOrNull(CONNECTION_READY_TIMEOUT_MILLIS) {
        var current = connections[nodeId]
        while (current == null) {
          delay(CONNECTION_POLL_MILLIS)
          current = connections[nodeId]
        }
        current
      } ?: error("Wear realtime audio channel is unavailable")
    connection.write(type, payload)
  }

  suspend fun close(nodeId: String) {
    connections.remove(nodeId)?.close(channelClient)
  }

  private class Connection(
    val channel: ChannelClient.Channel,
    val input: InputStream,
    val output: OutputStream,
  ) {
    private val writeMutex = Mutex()

    suspend fun write(
      type: WearRealtimeAudioFrameType,
      payload: ByteArray,
    ) {
      writeMutex.withLock {
        withContext(Dispatchers.IO) {
          WearRealtimeAudioFraming.write(output, type, payload)
        }
      }
    }

    suspend fun close(client: ChannelClient) {
      input.closeQuietly()
      output.closeQuietly()
      runCatching { client.close(channel).awaitWearTask() }
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
