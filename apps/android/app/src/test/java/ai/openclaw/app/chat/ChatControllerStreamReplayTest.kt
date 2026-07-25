package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Deterministic streaming replay scenarios: a ScriptedGateway replays scripted
 * chat.event/chat.history sequences into ChatController under virtual time.
 */
class ChatControllerStreamReplayTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = ChatController(scope = this, json = json, requestGateway = gateway::request)

  private fun transcript(controller: ChatController): List<Pair<String, String?>> =
    controller.messages.value.map { message ->
      val text =
        message.content
          .firstOrNull { it.type == "text" }
          ?.text
      message.role to text
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cleanRunStreamsV3AndV4DeltasThenConvergesToHistoryWithoutDuplicates() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("Hello there", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      assertEquals(1, controller.pendingRunCount.value)
      val optimisticUserId =
        controller.messages.value
          .single { it.role == "user" }
          .id

      // V3 deltas carry the accumulated message without v4's deltaText field.
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", runId, 1, null, "Str"))
      assertEquals("Str", controller.streamingAssistantText.value)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", runId, 2, "eamed reply.", "Streamed reply."),
      )
      assertEquals("Streamed reply.", controller.streamingAssistantText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "Hello there", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Streamed reply.", 2_000),
            ),
        ),
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = 3, assistantText = "Streamed reply."),
      )
      advanceUntilIdle()

      assertEquals(
        listOf("user" to "Hello there", "assistant" to "Streamed reply."),
        transcript(controller),
      )
      // Gateway copy replaces the optimistic echo in place: same row identity, no duplicate.
      assertEquals(
        optimisticUserId,
        controller.messages.value
          .single { it.role == "user" }
          .id,
      )
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals("session-1", controller.sessionId.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun duplicateDeltaAndTerminalDeliveryProducesNoDuplicateRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("dedupe me", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val delta = chatDeltaPayload("main", runId, 1, "Only once.", "Only once.")
      controller.handleGatewayEvent("chat", delta)
      controller.handleGatewayEvent("chat", delta)
      assertEquals("Only once.", controller.streamingAssistantText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "dedupe me", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Only once.", 2_000),
            ),
        ),
      )
      val terminal = chatTerminalPayload("main", runId, seq = 2, assistantText = "Only once.")
      controller.handleGatewayEvent("chat", terminal)
      advanceUntilIdle()
      val idsAfterFirstTerminal = controller.messages.value.map { it.id }

      // Once ownership resolves, redelivered terminal events are ignored.
      controller.handleGatewayEvent("chat", terminal)
      advanceUntilIdle()

      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(
        listOf("user" to "dedupe me", "assistant" to "Only once."),
        transcript(controller),
      )
      // Row identities stay stable across the duplicate refresh.
      assertEquals(idsAfterFirstTerminal, controller.messages.value.map { it.id })
      assertEquals(0, controller.pendingRunCount.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun optimisticAckTimeoutDiscardsUserEchoUnderVirtualTime() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("never answered", "off", emptyList()))
      assertEquals(1, controller.pendingRunCount.value)

      // One virtual millisecond before the 120s ack deadline nothing changes.
      advanceTimeBy(119_999)
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)
      assertTrue(transcript(controller).contains("user" to "never answered"))
      assertNull(controller.errorText.value)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(0, controller.pendingRunCount.value)
      assertFalse(transcript(controller).contains("user" to "never answered"))
      assertEquals("Timed out waiting for a reply; try again or refresh.", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun failedTerminalKeepsAcceptedUserUntilHistoryConfirmsIt() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("failed send", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId, seq = 1, state = "error"))
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertTrue(transcript(controller).contains("user" to "failed send"))
      assertEquals("Chat failed", controller.errorText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(ReplayHistoryMessage("user", "failed send", 1_000, idempotencyKey = "$runId:user")),
        ),
      )
      advanceTimeBy(750)
      runCurrent()
      assertEquals(listOf("user" to "failed send"), transcript(controller))
      assertEquals("Chat failed", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun messageLessSuccessfulTerminalResolvesAfterUserPersists() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("no output", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(ReplayHistoryMessage("user", "no output", 1_000, idempotencyKey = "$runId:user")),
        ),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId, seq = 1))
      runCurrent()

      assertEquals(listOf("user" to "no output"), transcript(controller))
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)

      advanceTimeBy(120_000)
      runCurrent()
      assertEquals(listOf("user" to "no output"), transcript(controller))
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectMidRunClearsTransientStateAndHistoryConverges() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("survive reconnect", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val optimisticUserId =
        controller.messages.value
          .single { it.role == "user" }
          .id

      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", runId, 1, "partial ans", "partial ans"),
      )
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$runId","seq":2,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )
      assertEquals("partial ans", controller.streamingAssistantText.value)
      assertEquals(1, controller.pendingToolCalls.value.size)

      controller.onDisconnected("connection lost")
      assertNull(controller.streamingAssistantText.value)
      assertEquals(0, controller.pendingRunCount.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
      assertNull(controller.sessionId.value)
      assertFalse(controller.healthOk.value)
      // The local echo stays rendered until the next history load resolves it.
      assertTrue(transcript(controller).contains("user" to "survive reconnect"))

      controller.handleGatewayEvent("health", null)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "survive reconnect", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Recovered reply.", 2_000),
            ),
        ),
      )
      controller.refresh()
      advanceUntilIdle()

      assertEquals(
        listOf("user" to "survive reconnect", "assistant" to "Recovered reply."),
        transcript(controller),
      )
      assertEquals(
        optimisticUserId,
        controller.messages.value
          .single { it.role == "user" }
          .id,
      )
      assertEquals("session-1", controller.sessionId.value)

      // Disconnect cancelled the 120s ack timer: the converged transcript must not decay.
      advanceTimeBy(120_000)
      runCurrent()
      assertNull(controller.errorText.value)
      assertEquals(2, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleHistoryResponseIsDroppedByGenerationTracking() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))

      // Gate the next "main" history fetch so its response arrives after a session switch.
      val staleMainGate = CompletableDeferred<Unit>()
      gateway.respond("chat.history") { paramsJson ->
        when (gateway.sessionKeyOf(paramsJson)) {
          "other" ->
            historyResponse(
              sessionId = "session-other",
              messages = listOf(ReplayHistoryMessage("assistant", "other transcript", 3_000)),
            )
          else -> {
            staleMainGate.await()
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("assistant", "stale main row", 9_000)),
            )
          }
        }
      }

      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId = "external-run", seq = 1),
      )
      runCurrent() // history refetch for "main" is now suspended on the gate
      assertEquals(2, gateway.callCount("chat.history"))

      controller.switchSession("other")
      advanceUntilIdle()
      assertEquals(listOf("assistant" to "other transcript"), transcript(controller))
      assertEquals("session-other", controller.sessionId.value)

      staleMainGate.complete(Unit)
      advanceUntilIdle()

      // The stale "main" response resolved after the switch and must be dropped.
      assertEquals(listOf("assistant" to "other transcript"), transcript(controller))
      assertEquals("session-other", controller.sessionId.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun loadOfCurrentLiveSessionDoesNotRefreshOrMarkHistoryLoading() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      val historyCallsAfterLiveLoad = gateway.callCount("chat.history")
      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))

      controller.load("main")

      assertEquals(historyCallsAfterLiveLoad, gateway.callCount("chat.history"))
      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun explicitRefreshFetchesAfterSameSessionLoadGate() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      val historyCallsAfterLiveLoad = gateway.callCount("chat.history")

      controller.load("main")
      assertEquals(historyCallsAfterLiveLoad, gateway.callCount("chat.history"))

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "refreshed transcript", 2_000)),
        ),
      )
      controller.refresh()
      advanceUntilIdle()

      assertEquals(historyCallsAfterLiveLoad + 1, gateway.callCount("chat.history"))
      assertEquals(listOf("assistant" to "refreshed transcript"), transcript(controller))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun loadOfCurrentUnhealthyLiveSessionRefreshesToRecoverHealth() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)
      gateway.respond("health") { error("gateway down") }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )

      controller.load("main")
      advanceUntilIdle()
      assertFalse(controller.healthOk.value)
      assertFalse(controller.historyLoading.value)

      controller.load("main")

      assertTrue(controller.historyLoading.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unknownTerminalRefreshesIdleTranscript() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(ReplayHistoryMessage("assistant", "from another client", 2_000)),
        ),
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", "external-run", seq = 1, assistantText = "from another client"),
      )
      runCurrent()

      assertEquals(listOf("assistant" to "from another client"), transcript(controller))
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun markdownFixtureStreamsByteIdenticalAndConvergesLosslessly() =
    runTest {
      val fixture =
        checkNotNull(javaClass.getResourceAsStream("/chat/markdown_stream_fixture.md")) {
          "missing markdown stream fixture resource"
        }.readBytes().toString(Charsets.UTF_8)
      val fixtureBytes = fixture.toByteArray(Charsets.UTF_8)

      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("render markdown shapes", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      // Odd chunk size on purpose so boundaries fall inside words, escapes, and emoji.
      val chunks = chunkPreservingCodePoints(fixture, chunkSize = 47)
      assertTrue("fixture should stream in many chunks", chunks.size > 10)
      var accumulated = ""
      for ((index, chunk) in chunks.withIndex()) {
        accumulated += chunk
        controller.handleGatewayEvent(
          "chat",
          chatDeltaPayload("main", runId, index + 1, chunk, accumulated),
        )
        assertEquals(accumulated, controller.streamingAssistantText.value)
      }

      val streamed = requireNotNull(controller.streamingAssistantText.value)
      assertArrayEquals(fixtureBytes, streamed.toByteArray(Charsets.UTF_8))

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-md",
          messages =
            listOf(
              ReplayHistoryMessage("user", "render markdown shapes", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", fixture, 2_000),
            ),
        ),
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = chunks.size + 1, assistantText = fixture),
      )
      advanceUntilIdle()

      val confirmed =
        controller.messages.value
          .single { it.role == "assistant" }
          .content
          .single { it.type == "text" }
          .text
      assertArrayEquals(fixtureBytes, requireNotNull(confirmed).toByteArray(Charsets.UTF_8))
      assertNull(controller.streamingAssistantText.value)
      assertEquals(0, controller.pendingRunCount.value)
    }
}
