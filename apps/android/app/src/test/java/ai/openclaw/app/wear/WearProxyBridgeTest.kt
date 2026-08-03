package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearConnectionFailure
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
import kotlinx.serialization.json.boolean
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
      val (bridge, sent) =
        backgroundScope.recordingBridge(
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
      val response = sent.single().response()
      assertEquals("req-1", response.requestId)
      assertTrue(!response.eventStreamId.isNullOrBlank())
      assertEquals(0L, response.eventSequence)
    }

  @Test
  fun malformedMessageDoesNotRegisterPeer() =
    runTest {
      val (bridge, sent) = backgroundScope.recordingBridge(handleRequest = { _, _ -> error("must not run") })

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
        backgroundScope.testBridge(
          sender =
            WearMessageSender { nodeId, path, data ->
              if (cancelFirstResponse) {
                cancelFirstResponse = false
                throw CancellationException("request canceled")
              }
              sent += SentWearMessage(nodeId, path, data)
            },
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
        actorScope.testBridge(
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
      val (bridge, sent) =
        actorScope.recordingBridge(
          peerResolver =
            WearPeerResolver {
              if (cancelFirstDiscovery) {
                cancelFirstDiscovery = false
                throw CancellationException("discovery canceled")
              }
              setOf("watch-1")
            },
          monotonicMillis = { 1_000L },
        )

      bridge.publishConnection(connected = true, status = "first")
      bridge.publishConnection(connected = true, status = "second")
      bridge.awaitIdleForTests()

      assertEquals(listOf(WearProtocol.EVENT_PATH, WearProtocol.EVENT_PATH), sent.map { it.path })
    }

  @Test
  fun resyncInvalidatesTheWatchSnapshot() =
    withActorScope { actorScope ->
      val (bridge, sent) =
        actorScope.recordingBridge(
          peerResolver = WearPeerResolver { setOf("watch-1") },
          monotonicMillis = { 1_000L },
        )

      bridge.publishResync()
      bridge.awaitIdleForTests()

      val event = sent.single().event()
      assertEquals(WearProtocol.EVENT_PATH, sent.single().path)
      assertEquals(WearEventType.Resync, event.event)
      assertEquals(1L, event.sequence)
      assertEquals(null, event.payload)
    }

  @Test
  fun historyResponseWatermarkExcludesEventsQueuedBehindIt() =
    runTest {
      val requestStarted = CompletableDeferred<Unit>()
      val finishRequest = CompletableDeferred<Unit>()
      val (bridge, sent) =
        backgroundScope.recordingBridge(
          handleRequest = { _, request ->
            requestStarted.complete(Unit)
            finishRequest.await()
            WearMessage.Response(requestId = request.requestId, ok = true)
          },
        )

      val requestJob = async { bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1"))) }
      runCurrent()
      requestStarted.await()
      bridge.publishChat(chatPayload(state = "delta", text = "new"))
      runCurrent()
      assertTrue(sent.isEmpty())

      finishRequest.complete(Unit)
      requestJob.await()
      runCurrent()

      assertEquals(listOf(WearProtocol.RESPONSE_PATH, WearProtocol.EVENT_PATH), sent.map { it.path })
      val response = sent[0].response()
      val event = sent[1].event()
      assertEquals(response.eventStreamId, event.streamId)
      assertEquals(0L, response.eventSequence)
      assertEquals(1L, event.sequence)
    }

  @Test
  fun chatStreamProjectionCarriesCanonicalTextAndFallbackCompleteness() {
    val projector = WearChatStreamProjector()
    val first = projectStreamEvent(projector, state = "delta", runId = "run-1", text = "Hel", message = "Hel")
    val continued = projectStreamEvent(projector, state = "delta", runId = "run-1", text = "lo")
    val unknownPrefix = projectStreamEvent(projector, state = "delta", runId = "run-2", text = "tail")

    assertEquals("Hel", first.getValue("streamText").jsonPrimitive.content)
    assertEquals("true", first.getValue("streamTextComplete").jsonPrimitive.content)
    assertEquals("Hello", continued.getValue("streamText").jsonPrimitive.content)
    assertEquals("true", continued.getValue("streamTextComplete").jsonPrimitive.content)
    assertEquals("tail", unknownPrefix.getValue("streamText").jsonPrimitive.content)
    assertEquals("false", unknownPrefix.getValue("streamTextComplete").jsonPrimitive.content)
  }

  @Test
  fun foreignFinalPreservesTheActiveWatchStream() = assertForeignTerminalPreservesStream("final", runId = "active-run")

  @Test
  fun foreignAbortPreservesTheActiveWatchStream() = assertForeignTerminalPreservesStream("aborted", runId = "active-run")

  @Test
  fun foreignErrorPreservesTheActiveWatchStream() = assertForeignTerminalPreservesStream("error", runId = "active-run")

  @Test
  fun foreignFinalPreservesAnAnonymousWatchStream() = assertForeignTerminalPreservesStream("final")

  @Test
  fun foreignAbortPreservesAnAnonymousWatchStream() = assertForeignTerminalPreservesStream("aborted")

  @Test
  fun foreignErrorPreservesAnAnonymousWatchStream() = assertForeignTerminalPreservesStream("error")

  @Test
  fun identifiedTerminalClearsItsOwnStreamWithoutErasingAnotherRun() {
    val projector = WearChatStreamProjector()
    projectStreamEvent(projector, state = "delta", runId = "older-run", text = "Old", message = "Old")
    projectStreamEvent(projector, state = "delta", runId = "active-run", text = "Hel", message = "Hel")

    projectStreamEvent(projector, state = "final", runId = "older-run")

    val active = projectStreamEvent(projector, state = "delta", runId = "active-run", text = "lo")
    val retired = projectStreamEvent(projector, state = "delta", runId = "older-run", text = "new")
    assertEquals("Hello", active.getValue("streamText").jsonPrimitive.content)
    assertEquals("true", active.getValue("streamTextComplete").jsonPrimitive.content)
    assertEquals("new", retired.getValue("streamText").jsonPrimitive.content)
    assertEquals("false", retired.getValue("streamTextComplete").jsonPrimitive.content)
  }

  @Test
  fun unidentifiedTerminalClearsEveryStreamInItsSession() {
    val projector = WearChatStreamProjector()
    projectStreamEvent(projector, state = "delta", runId = "older-run", text = "old", message = "old")
    projectStreamEvent(projector, state = "delta", runId = "active-run", text = "stale", message = "stale")

    projectStreamEvent(projector, state = "final")

    val next = projectStreamEvent(projector, state = "delta", runId = "active-run", text = "fresh")
    assertEquals("fresh", next.getValue("streamText").jsonPrimitive.content)
    assertEquals("false", next.getValue("streamTextComplete").jsonPrimitive.content)
  }

  @Test
  fun runIdLessDeltasUseSessionSnapshotAndKeepExactAppendSemantics() {
    val projector = WearChatStreamProjector()
    val first = projectStreamEvent(projector, state = "delta", text = "a")
    val second = projectStreamEvent(projector, state = "delta", text = "a")
    val identified = projectStreamEvent(projector, state = "delta", runId = "run-now-known", text = "a")
    projectStreamEvent(projector, state = "final", runId = "run-now-known")
    val afterFinal = projectStreamEvent(projector, state = "delta", text = "a")

    assertEquals("a", first.getValue("streamText").jsonPrimitive.content)
    assertEquals("aa", second.getValue("streamText").jsonPrimitive.content)
    assertEquals("aaa", identified.getValue("streamText").jsonPrimitive.content)
    assertEquals("a", afterFinal.getValue("streamText").jsonPrimitive.content)
  }

  @Test
  fun runIdLessDeltaContinuesTheActiveIdentifiedStream() {
    val projector = WearChatStreamProjector()
    projectStreamEvent(projector, state = "delta", runId = "run-1", text = "H")
    val anonymous = projectStreamEvent(projector, state = "delta", text = "i")
    val identified = projectStreamEvent(projector, state = "delta", runId = "run-1", text = "!")

    assertEquals("Hi", anonymous.getValue("streamText").jsonPrimitive.content)
    assertEquals("Hi!", identified.getValue("streamText").jsonPrimitive.content)
  }

  @Test
  fun connectionResetClearsRunIdLessStreamState() {
    val projector = WearChatStreamProjector()
    projectStreamEvent(projector, state = "delta", text = "stale")

    projector.reset()
    val next = projectStreamEvent(projector, state = "delta", text = "fresh")

    assertEquals("fresh", next.getValue("streamText").jsonPrimitive.content)
  }

  @Test
  fun coldBridgeDiscoversReachableWatchBeforeBackgroundEvent() =
    runTest {
      val (bridge, sent) =
        backgroundScope.recordingBridge(
          peerResolver = WearPeerResolver { setOf("watch-1") },
          monotonicMillis = { 1_000L },
        )

      bridge.publishChat(chatPayload(state = "final"))
      runCurrent()

      assertEquals("watch-1", sent.single().nodeId)
      assertEquals(WearProtocol.EVENT_PATH, sent.single().path)
    }

  @Test
  fun noWatchDiscoveryIsRateLimitedAcrossStreamEvents() =
    runTest {
      var resolutions = 0
      val bridge =
        backgroundScope.testBridge(
          sender = WearMessageSender { _, _, _ -> error("must not send") },
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              emptySet()
            },
          monotonicMillis = { 1_000L },
        )

      repeat(20) { index ->
        bridge.publishChat(chatPayload(state = "delta", text = "$index"))
      }
      runCurrent()

      assertEquals(1, resolutions)
    }

  @Test
  fun terminalEventBypassesCachedEmptyPeerDiscovery() =
    runTest {
      var resolutions = 0
      val (bridge, sent) =
        backgroundScope.recordingBridge(
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              if (resolutions == 1) emptySet() else setOf("watch-1")
            },
          monotonicMillis = { 1_000L },
        )

      bridge.publishChat(chatPayload(state = "delta", text = "working"))
      bridge.publishChat(chatPayload(state = "final"))
      runCurrent()

      assertEquals(2, resolutions)
      assertEquals("watch-1", sent.single().nodeId)
      val event = sent.single().event()
      assertEquals(2L, event.sequence)
    }

  @Test
  fun terminalEventDiscoversAnotherWatchWhileRememberedPeerIsHealthy() =
    runTest {
      var resolutions = 0
      val (bridge, sent) =
        backgroundScope.recordingBridge(
          peerResolver =
            WearPeerResolver {
              resolutions += 1
              setOf("watch-1", "watch-2")
            },
          monotonicMillis = { 1_000L },
        )
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))
      sent.clear()

      bridge.publishChat(chatPayload(state = "final"))
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
        backgroundScope.testBridge(
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
        )
      bridge.handleMessage("watch-stale", WearProtocolCodec.encode(request("req-1")))
      attempts.clear()

      bridge.publishChat(chatPayload(state = "final"))
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
        backgroundScope.testBridge(
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
      val requestStarted = CompletableDeferred<Unit>()
      val finishRequest = CompletableDeferred<Unit>()
      val (bridge, sent) =
        actorScope.recordingBridge(
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
        bridge.publishChat(chatPayload(state = "delta", text = "$index"))
      }
      bridge.publishChat(chatPayload(state = "final", message = "done"))
      finishRequest.complete(Unit)
      requestJob.await()
      bridge.awaitIdleForTests()

      val events =
        sent
          .filter { it.path == WearProtocol.EVENT_PATH }
          .map { it.event() }
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
      val (bridge, sent) = backgroundScope.recordingBridge()
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
          .map { it.event() }
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
  fun connectionEventsCarrySemanticFailureReasons() =
    runTest {
      val (bridge, sent) =
        backgroundScope.recordingBridge(
          peerResolver = WearPeerResolver { setOf("watch-1") },
        )
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))
      sent.clear()

      bridge.publishConnection(
        connected = false,
        status = "Update required",
        failure = WearConnectionFailure.Incompatible,
      )
      bridge.awaitIdleForTests()

      val event =
        sent
          .single { it.path == WearProtocol.EVENT_PATH }
          .event()
      val payload = checkNotNull(event.payload).jsonObject
      assertEquals(false, payload.getValue("connected").jsonPrimitive.boolean)
      assertEquals("incompatible", payload.getValue("failure").jsonPrimitive.content)
    }

  @Test
  fun connectionFailurePreservesProtocolMismatchAndLegacyUpdateSignals() {
    assertEquals(
      WearConnectionFailure.Incompatible,
      wearConnectionFailure(problemCode = "PROTOCOL_MISMATCH", status = "Connection failed"),
    )
    assertEquals(
      WearConnectionFailure.Incompatible,
      wearConnectionFailure(problemCode = null, status = "Update required"),
    )
    assertEquals(
      WearConnectionFailure.GatewayOffline,
      wearConnectionFailure(problemCode = null, status = "Offline"),
    )
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
        actorScope.testBridge(
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

  private fun assertForeignTerminalPreservesStream(
    state: String,
    runId: String? = null,
  ) {
    val projector = WearChatStreamProjector()
    projectStreamEvent(projector, state = "delta", runId = runId, text = "Hel", message = "Hel")

    projectStreamEvent(projector, state = state, runId = "older-run")

    val continued = projectStreamEvent(projector, state = "delta", runId = runId, text = "lo")
    assertEquals("Hello", continued.getValue("streamText").jsonPrimitive.content)
    assertEquals("true", continued.getValue("streamTextComplete").jsonPrimitive.content)
  }

  private fun projectStreamEvent(
    projector: WearChatStreamProjector,
    state: String,
    runId: String? = null,
    text: String? = null,
    message: String? = null,
  ): JsonObject =
    checkNotNull(
      projector.project(chatPayload(state = state, runId = runId, text = text, message = message)),
    )

  private fun CoroutineScope.recordingBridge(
    peerResolver: WearPeerResolver = WearPeerResolver { emptySet() },
    monotonicMillis: (() -> Long)? = null,
    handleRequest: suspend (String, WearMessage.Request) -> WearMessage.Response = ::successResponse,
  ): Pair<WearProxyBridge, MutableList<SentWearMessage>> {
    val sent = mutableListOf<SentWearMessage>()
    val bridge =
      if (monotonicMillis == null) {
        testBridge(sent.recordingSender(), peerResolver, handleRequest)
      } else {
        testBridge(sent.recordingSender(), peerResolver, monotonicMillis, handleRequest)
      }
    return bridge to sent
  }

  private fun CoroutineScope.testBridge(
    sender: WearMessageSender,
    peerResolver: WearPeerResolver = WearPeerResolver { emptySet() },
    handleRequest: suspend (String, WearMessage.Request) -> WearMessage.Response = ::successResponse,
  ): WearProxyBridge = WearProxyBridge(this, sender, peerResolver, handleRequest = handleRequest)

  private fun CoroutineScope.testBridge(
    sender: WearMessageSender,
    peerResolver: WearPeerResolver = WearPeerResolver { emptySet() },
    monotonicMillis: () -> Long,
    handleRequest: suspend (String, WearMessage.Request) -> WearMessage.Response = ::successResponse,
  ): WearProxyBridge = WearProxyBridge(this, sender, peerResolver, monotonicMillis, handleRequest)

  private fun successResponse(
    sourceNodeId: String,
    request: WearMessage.Request,
  ): WearMessage.Response = WearMessage.Response(requestId = request.requestId, ok = true)

  private fun chatPayload(
    state: String,
    runId: String? = null,
    text: String? = null,
    message: String? = null,
  ): JsonObject =
    buildJsonObject {
      put("sessionKey", "main")
      runId?.let { put("runId", it) }
      put("state", state)
      text?.let { put("deltaText", it) }
      message?.let { fullText ->
        put(
          "message",
          buildJsonObject {
            put("role", "assistant")
            put("content", fullText)
          },
        )
      }
    }

  private fun MutableList<SentWearMessage>.recordingSender(): WearMessageSender = WearMessageSender { nodeId, path, data -> add(SentWearMessage(nodeId, path, data)) }

  private fun SentWearMessage.response(): WearMessage.Response = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Response

  private fun SentWearMessage.event(): WearMessage.Event = (WearProtocolCodec.decode(data) as WearDecodeResult.Success).message as WearMessage.Event

  private fun request(requestId: String): WearMessage.Request = WearMessage.Request(requestId = requestId, method = WearRpcMethod.ProxyStatus)
}

private data class SentWearMessage(
  val nodeId: String,
  val path: String,
  val data: ByteArray,
)
