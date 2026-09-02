package ai.openclaw.app.ui.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.Socket
import java.util.concurrent.TimeUnit

class ChatInlineWidgetCleanupTest {
  @Test
  fun pinnedClientCleanupCancelsCallsAndClosesIdleConnectionsOffCaller() =
    runBlocking {
      MockWebServer().use { idleServer ->
        MockWebServer().use { activeServer ->
          val caller = Thread.currentThread()
          val idleSocket = CompletableDeferred<Socket>()
          val cancellationThread = CompletableDeferred<Thread>()
          val client =
            OkHttpClient
              .Builder()
              .eventListener(
                object : EventListener() {
                  override fun connectionAcquired(
                    call: Call,
                    connection: Connection,
                  ) {
                    idleSocket.complete(connection.socket())
                  }

                  override fun canceled(call: Call) {
                    cancellationThread.complete(Thread.currentThread())
                  }
                },
              ).build()
          try {
            idleServer.enqueue(MockResponse().setBody("widget"))
            client.newCall(Request.Builder().url(idleServer.url("/widget")).build()).execute().use { response ->
              assertEquals("widget", response.body.string())
            }
            assertEquals(1, client.connectionPool.idleConnectionCount())

            // A different server keeps the first connection idle during the pending fetch.
            activeServer.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val activeCall = client.newCall(Request.Builder().url(activeServer.url("/pending")).build())
            val result =
              async(Dispatchers.IO) {
                runCatching { activeCall.execute().use { it.body.string() } }
              }
            assertNotNull(activeServer.takeRequest(5, TimeUnit.SECONDS))

            closePinnedWidgetClientAsync(client)

            withTimeout(5_000) {
              assertNotSame(caller, cancellationThread.await())
              assertTrue(activeCall.isCanceled())
              assertTrue(result.await().exceptionOrNull() is IOException)
              val socket = idleSocket.await()
              while (!socket.isClosed) delay(10)
            }
            assertEquals(0, client.connectionPool.connectionCount())
          } finally {
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
          }
        }
      }
    }
}
