package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearProxyBridgeTest {
  private fun withActorScope(block: suspend CoroutineScope.(CoroutineScope) -> Unit) =
    runBlocking {
      withTimeout(ACTOR_TEST_TIMEOUT_MILLIS) {
        val actorJob = Job(coroutineContext[Job])
        val actorScope = CoroutineScope(actorJob + Dispatchers.Default)
        try {
          block(actorScope)
        } finally {
          actorJob.cancelAndJoin()
        }
      }
    }

  private companion object {
    const val ACTOR_TEST_TIMEOUT_MILLIS = 30_000L
  }

  @Test
  fun validRequestRegistersPeerAndReturnsCorrelatedResponse() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { _, request ->
            WearMessage.Response(
              requestId = request.requestId,
              ok = true,
              result = buildJsonObject { put("connected", true) },
            )
          },
        )

      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))

      assertEquals(1, bridge.peerCountForTests())
      assertEquals(1, sent.size)
      assertEquals("watch-1", sent.single().nodeId)
      assertEquals(WearProtocol.RESPONSE_PATH, sent.single().path)
      val response = (WearProtocolCodec.decode(sent.single().data) as WearDecodeResult.Success).message as WearMessage.Response
      assertEquals("req-1", response.requestId)
      assertTrue(!response.eventStreamId.isNullOrBlank())
      assertEquals(0L, response.eventSequence)
    }

  @Test
  fun malformedMessageDoesNotRegisterPeer() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { _, _ -> error("must not run") },
        )

      bridge.handleMessage("watch-1", "not-json".encodeToByteArray())

      assertEquals(0, bridge.peerCountForTests())
      assertTrue(sent.isEmpty())
    }

  @Test
  fun responseSendCancellationRetriesWithoutTerminatingActor() =
    runTest {
      var cancelFirstResponse = true
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender =
            WearMessageSender { nodeId, path, data ->
              if (cancelFirstResponse) {
                cancelFirstResponse = false
                throw CancellationException("request canceled")
              }
              sent += SentWearMessage(nodeId, path, data)
            },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      assertTrue(bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1"))))
      assertEquals(1, bridge.peerCountForTests())

      assertTrue(bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-2"))))

      assertEquals(listOf(WearProtocol.RESPONSE_PATH, WearProtocol.RESPONSE_PATH), sent.map { it.path })
    }

  @Test
  fun eventSendCancellationDoesNotTerminateRequestActor() =
    withActorScope { actorScope ->
      var cancelFirstEvent = true
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = actorScope,
          sender =
            WearMessageSender { nodeId, path, data ->
              if (path == WearProtocol.EVENT_PATH && cancelFirstEvent) {
                cancelFirstEvent = false
                throw CancellationException("event canceled")
              }
              sent += SentWearMessage(nodeId, path, data)
            },
          peerResolver = WearPeerResolver { setOf("watch-1") },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      bridge.publishConnection(connected = true, status = "Connected")
      bridge.awaitIdleForTests()
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))

      assertEquals(listOf(WearProtocol.EVENT_PATH, WearProtocol.RESPONSE_PATH), sent.map { it.path })
    }

  @Test
  fun discoveryTaskCancellationDoesNotTerminateEventActor() =
    withActorScope { actorScope ->
      var cancelFirstDiscovery = true
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = actorScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          peerResolver =
            WearPeerResolver {
              if (cancelFirstDiscovery) {
                cancelFirstDiscovery = false
                throw CancellationException("discovery canceled")
              }
              setOf("watch-1")
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      bridge.publishConnection(connected = true, status = "first")
      bridge.publishConnection(connected = true, status = "second")
      bridge.awaitIdleForTests()

      assertEquals(listOf(WearProtocol.EVENT_PATH, WearProtocol.EVENT_PATH), sent.map { it.path })
    }

  @Test
  fun historyResponseWatermarkExcludesEventsQueuedBehindIt() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val requestStarted = CompletableDeferred<Unit>()
      val finishRequest = CompletableDeferred<Unit>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { _, request ->
            requestStarted.complete(Unit)
            finishRequest.await()
            WearMessage.Response(requestId = request.requestId, ok = true)
          },
        )

      val requestJob = async { bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1"))) }
      runCurrent()
      requestStarted.await()
      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "delta")
          put("deltaText", "new")
        },
      )
      runCurrent()
      assertTrue(sent.isEmpty())

      finishRequest.complete(Unit)
      requestJob.await()
      runCurrent()

      assertEquals(listOf(WearProtocol.RESPONSE_PATH, WearProtocol.EVENT_PATH), sent.map { it.path })
      val response = (WearProtocolCodec.decode(sent[0].data) as WearDecodeResult.Success).message as WearMessage.Response
      val event = (WearProtocolCodec.decode(sent[1].data) as WearDecodeResult.Success).message as WearMessage.Event
      assertEquals(response.eventStreamId, event.streamId)
      assertEquals(0L, response.eventSequence)
      assertEquals(1L, event.sequence)
    }

  @Test
  fun chatStreamProjectionCarriesCanonicalTextAndFallbackCompleteness() {
    val projector = WearChatStreamProjector()
    val first =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("runId", "run-1")
            put("state", "delta")
            put("deltaText", "Hel")
            put(
              "message",
              buildJsonObject {
                put("role", "assistant")
                put("content", "Hel")
              },
            )
          },
        ),
      )
    val continued =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("runId", "run-1")
            put("state", "delta")
            put("deltaText", "lo")
          },
        ),
      )
    val unknownPrefix =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("runId", "run-2")
            put("state", "delta")
            put("deltaText", "tail")
          },
        ),
      )

    assertEquals("Hel", first.getValue("streamText").jsonPrimitive.content)
    assertEquals("true", first.getValue("streamTextComplete").jsonPrimitive.content)
    assertEquals("Hello", continued.getValue("streamText").jsonPrimitive.content)
    assertEquals("true", continued.getValue("streamTextComplete").jsonPrimitive.content)
    assertEquals("tail", unknownPrefix.getValue("streamText").jsonPrimitive.content)
    assertEquals("false", unknownPrefix.getValue("streamTextComplete").jsonPrimitive.content)
  }

  @Test
  fun runIdLessDeltasUseSessionSnapshotAndKeepExactAppendSemantics() {
    val projector = WearChatStreamProjector()

    val first =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("state", "delta")
            put("deltaText", "a")
          },
        ),
      )
    val second =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("state", "delta")
            put("deltaText", "a")
          },
        ),
      )
    val identified =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("runId", "run-now-known")
            put("state", "delta")
            put("deltaText", "a")
          },
        ),
      )
    checkNotNull(
      projector.project(
        buildJsonObject {
          put("sessionKey", "main")
          put("runId", "run-now-known")
          put("state", "final")
        },
      ),
    )
    val afterFinal =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("state", "delta")
            put("deltaText", "a")
          },
        ),
      )

    assertEquals("a", first.getValue("streamText").jsonPrimitive.content)
    assertEquals("aa", second.getValue("streamText").jsonPrimitive.content)
    assertEquals("aaa", identified.getValue("streamText").jsonPrimitive.content)
    assertEquals("a", afterFinal.getValue("streamText").jsonPrimitive.content)
  }

  @Test
  fun runIdLessDeltaContinuesTheActiveIdentifiedStream() {
    val projector = WearChatStreamProjector()

    fun delta(
      text: String,
      runId: String? = null,
    ): JsonObject =
      buildJsonObject {
        put("sessionKey", "main")
        runId?.let { put("runId", it) }
        put("state", "delta")
        put("deltaText", text)
      }

    checkNotNull(projector.project(delta("H", runId = "run-1")))
    val anonymous = checkNotNull(projector.project(delta("i")))
    val identified = checkNotNull(projector.project(delta("!", runId = "run-1")))

    assertEquals("Hi", anonymous.getValue("streamText").jsonPrimitive.content)
    assertEquals("Hi!", identified.getValue("streamText").jsonPrimitive.content)
  }

  @Test
  fun connectionResetClearsRunIdLessStreamState() {
    val projector = WearChatStreamProjector()
    checkNotNull(
      projector.project(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "delta")
          put("deltaText", "stale")
        },
      ),
    )

    projector.reset()
    val next =
      checkNotNull(
        projector.project(
          buildJsonObject {
            put("sessionKey", "main")
            put("state", "delta")
            put("deltaText", "fresh")
          },
        ),
      )

    assertEquals("fresh", next.getValue("streamText").jsonPrimitive.content)
  }

  @Test
  fun coldBridgeDiscoversReachableWatchBeforeBackgroundEvent() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          peerResolver = WearPeerResolver { setOf("watch-1") },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "final")
        },
      )
      runCurrent()

      assertEquals("watch-1", sent.single().nodeId)
      assertEquals(WearProtocol.EVENT_PATH, sent.single().path)
    }

  @Test
  fun noWatchDiscoveryIsRateLimitedAcrossStreamEvents() =
    runTest {
      var resolutions = 0
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { _, _, _ -> error("must not send") },
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              emptySet()
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      repeat(20) { index ->
        bridge.publishChat(
          buildJsonObject {
            put("sessionKey", "main")
            put("state", "delta")
            put("deltaText", "$index")
          },
        )
      }
      runCurrent()

      assertEquals(1, resolutions)
    }

  @Test
  fun terminalEventBypassesCachedEmptyPeerDiscovery() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      var resolutions = 0
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              if (resolutions == 1) emptySet() else setOf("watch-1")
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "delta")
          put("deltaText", "working")
        },
      )
      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "final")
        },
      )
      runCurrent()

      assertEquals(2, resolutions)
      assertEquals("watch-1", sent.single().nodeId)
      val event = (WearProtocolCodec.decode(sent.single().data) as WearDecodeResult.Success).message as WearMessage.Event
      assertEquals(2L, event.sequence)
    }

  @Test
  fun terminalEventDiscoversAnotherWatchWhileRememberedPeerIsHealthy() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      var resolutions = 0
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              setOf("watch-1", "watch-2")
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))
      sent.clear()

      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "final")
        },
      )
      bridge.awaitIdleForTests()

      assertEquals(1, resolutions)
      assertEquals(listOf("watch-1", "watch-2"), sent.map { it.nodeId })
      assertTrue(sent.all { it.path == WearProtocol.EVENT_PATH })
    }

  @Test
  fun staleRememberedPeerTriggersDiscoveryAndCurrentEventRetry() =
    runTest {
      val attempts = mutableListOf<SentWearMessage>()
      var resolutions = 0
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender =
            WearMessageSender { nodeId, path, data ->
              attempts += SentWearMessage(nodeId, path, data)
              if (nodeId == "watch-stale" && path == WearProtocol.EVENT_PATH) {
                error("stale node")
              }
            },
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              setOf("watch-current")
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      bridge.handleMessage("watch-stale", WearProtocolCodec.encode(request("req-1")))
      attempts.clear()

      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "final")
        },
      )
      bridge.awaitIdleForTests()

      // Terminal delivery refreshes before sending; the stale failure then forces a second
      // discovery so a watch that appeared during that send still receives the terminal state.
      assertEquals(2, resolutions)
      assertEquals(listOf("watch-stale", "watch-current"), attempts.map { it.nodeId })
      assertTrue(attempts.all { it.path == WearProtocol.EVENT_PATH })
    }

  @Test
  fun partialPeerFailureRediscoversAndRetriesOnlyTheFailedWatch() =
    runTest {
      val attempts = mutableListOf<String>()
      var failSecondWatch = true
      var resolutions = 0
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender =
            WearMessageSender { nodeId, path, _ ->
              if (path != WearProtocol.EVENT_PATH) return@WearMessageSender
              attempts += nodeId
              if (nodeId == "watch-2" && failSecondWatch) {
                failSecondWatch = false
                error("transient")
              }
            },
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              setOf("watch-1", "watch-2")
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))
      bridge.handleMessage("watch-2", WearProtocolCodec.encode(request("req-2")))
      attempts.clear()

      bridge.publishConnection(connected = true, status = "Connected")
      runCurrent()

      assertEquals(1, resolutions)
      assertEquals(listOf("watch-1", "watch-2", "watch-2"), attempts)
    }

  @Test
  fun queueOverflowRetainsTerminalEventAndEmitsResync() =
    withActorScope { actorScope ->
      val sent = mutableListOf<SentWearMessage>()
      val requestStarted = CompletableDeferred<Unit>()
      val finishRequest = CompletableDeferred<Unit>()
      val bridge =
        WearProxyBridge(
          scope = actorScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request ->
            requestStarted.complete(Unit)
            finishRequest.await()
            WearMessage.Response(requestId = request.requestId, ok = true)
          },
        )
      val requestJob = async { bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1"))) }
      requestStarted.await()

      repeat(40) { index ->
        bridge.publishChat(
          buildJsonObject {
            put("sessionKey", "main")
            put("state", "delta")
            put("deltaText", "$index")
          },
        )
      }
      bridge.publishChat(
        buildJsonObject {
          put("sessionKey", "main")
          put("state", "final")
          put(
            "message",
            buildJsonObject {
              put("role", "assistant")
              put("content", "done")
            },
          )
        },
      )
      finishRequest.complete(Unit)
      requestJob.await()
      bridge.awaitIdleForTests()

      val events =
        sent
          .filter { it.path == WearProtocol.EVENT_PATH }
          .map { (WearProtocolCodec.decode(it.data) as WearDecodeResult.Success).message as WearMessage.Event }
      assertTrue(events.any { it.event == WearEventType.Resync })
      assertTrue(
        events.any { event ->
          event.event == WearEventType.Chat &&
            event.payload
              ?.jsonObject
              ?.get("state")
              ?.jsonPrimitive
              ?.content == "final"
        },
      )
      assertEquals(events.map { it.sequence }.sorted(), events.map { it.sequence })
      assertEquals(WearEventType.Resync, events.last().event)
    }

  @Test
  fun eventQueuePreservesSequenceAndBoundsPeers() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      repeat(9) { index -> bridge.handleMessage("watch-$index", WearProtocolCodec.encode(request("req-$index"))) }
      sent.clear()

      bridge.publishConnection(connected = true, status = "Connected")
      bridge.publishChat(
        buildJsonObject {
          put("runId", "run-1")
          put("sessionKey", "main")
          put("seq", 1)
          put("state", "delta")
          put("deltaText", "hello")
          put("privateField", "drop me")
        },
      )
      runCurrent()

      assertEquals(8, bridge.peerCountForTests())
      val events =
        sent
          .filter { it.path == WearProtocol.EVENT_PATH }
          .map { (WearProtocolCodec.decode(it.data) as WearDecodeResult.Success).message as WearMessage.Event }
      assertEquals(16, events.size)
      assertEquals(setOf(1L, 2L), events.map { it.sequence }.toSet())
      assertEquals(setOf(WearEventType.Connection, WearEventType.Chat), events.map { it.event }.toSet())
      val chat = events.first { it.event == WearEventType.Chat }
      val payload = checkNotNull(chat.payload).jsonObject
      assertEquals(
        setOf("runId", "sessionKey", "seq", "state", "deltaText", "streamText", "streamTextComplete"),
        payload.keys,
      )
      assertEquals("hello", payload.getValue("deltaText").jsonPrimitive.content)
      assertEquals("hello", payload.getValue("streamText").jsonPrimitive.content)
    }

  @Test
  fun canceledGoogleTaskResumesAsSendFailure() =
    runTest {
      val failure = runCatching { Tasks.forCanceled<Int>().awaitWearTask() }.exceptionOrNull()

      assertTrue(failure is WearTaskCanceledException)
    }

  @Test
  fun callerCancellationWinsLaterGoogleTaskCompletion() =
    runTest {
      val source = TaskCompletionSource<Int>()
      val awaiting = backgroundScope.async { source.task.awaitWearTask() }
      runCurrent()

      awaiting.cancel()
      runCurrent()
      source.setResult(1)
      runCurrent()

      assertTrue(awaiting.isCancelled)
    }

  @Test
  fun staleEventFailureDoesNotRemoveRefreshedPeer() =
    withActorScope { actorScope ->
      val eventStarted = CompletableDeferred<Unit>()
      val releaseEvent = CompletableDeferred<Unit>()
      val sent = mutableListOf<SentWearMessage>()
      var failFirstEvent = true
      val bridge =
        WearProxyBridge(
          scope = actorScope,
          sender =
            WearMessageSender { nodeId, path, data ->
              if (path == WearProtocol.EVENT_PATH && failFirstEvent) {
                failFirstEvent = false
                eventStarted.complete(Unit)
                releaseEvent.await()
                error("stale send failed")
              }
              sent += SentWearMessage(nodeId, path, data)
            },
          monotonicMillis = { 1_000L },
          handleRequest = { _, request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))

      bridge.publishConnection(connected = true, status = "Connected")
      eventStarted.await()
      val refreshed =
        async(start = CoroutineStart.UNDISPATCHED) {
          bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-2")))
        }
      releaseEvent.complete(Unit)
      assertTrue(refreshed.await())
      bridge.awaitIdleForTests()

      bridge.publishConnection(connected = false, status = "Offline")
      bridge.awaitIdleForTests()

      assertEquals(1, bridge.peerCountForTests())
      // The stale send is retried after discovery, then the later offline event also delivers.
      assertEquals(2, sent.count { it.path == WearProtocol.EVENT_PATH })
    }

  private fun request(requestId: String): WearMessage.Request = WearMessage.Request(requestId = requestId, method = WearRpcMethod.ProxyStatus)
}

private data class SentWearMessage(
  val nodeId: String,
  val path: String,
  val data: ByteArray,
)
