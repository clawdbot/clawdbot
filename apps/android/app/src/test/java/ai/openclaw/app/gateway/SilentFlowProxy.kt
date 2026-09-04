package ai.openclaw.app.gateway

import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Drops bytes on existing TCP flows without EOF/reset; newly accepted flows still work. */
internal class SilentFlowProxy(
  private val upstreamPort: Int,
) : Closeable {
  private val listener = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
  private val workers = Executors.newCachedThreadPool()
  private val flows = ConcurrentLinkedQueue<Flow>()
  val port: Int get() = listener.localPort

  private class Flow(
    val downstream: Socket,
    val upstream: Socket,
  ) {
    val dropOutbound = AtomicBoolean()
    val dropInbound = AtomicBoolean()
  }

  private val acceptTask =
    workers.submit {
      while (!listener.isClosed) {
        val downstream =
          try {
            listener.accept()
          } catch (_: java.io.IOException) {
            break
          }
        val flow = Flow(downstream, Socket(InetAddress.getLoopbackAddress(), upstreamPort))
        flows += flow
        workers.submit { forward(flow, flow.downstream, flow.upstream) }
        workers.submit { forward(flow, flow.upstream, flow.downstream) }
      }
    }

  fun blackholeExistingFlows(keepInbound: Boolean = false) {
    flows.forEach {
      it.dropOutbound.set(true)
      it.dropInbound.set(!keepInbound)
    }
  }

  private fun forward(
    flow: Flow,
    source: Socket,
    destination: Socket,
  ) {
    try {
      val bytes = ByteArray(8192)
      while (true) {
        val count = source.getInputStream().read(bytes)
        if (count < 0) break
        val dropped = if (source === flow.downstream) flow.dropOutbound.get() else flow.dropInbound.get()
        if (!dropped) {
          destination.getOutputStream().write(bytes, 0, count)
          destination.getOutputStream().flush()
        }
      }
    } catch (_: java.io.IOException) {
      // Cancellation and teardown close the real sockets, never a synthetic session callback.
    } finally {
      source.close()
      destination.close()
    }
  }

  override fun close() {
    listener.close()
    // Finish registration before draining: an accepted flow must not escape teardown.
    acceptTask.get(8, TimeUnit.SECONDS)
    flows.forEach {
      it.downstream.close()
      it.upstream.close()
    }
    workers.shutdown()
    check(workers.awaitTermination(8, TimeUnit.SECONDS)) { "Silent-flow proxy did not stop" }
  }
}
