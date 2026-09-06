package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class RealtimeAgentCoordinatorTest {
  private lateinit var calls: MutableList<GatewayCall>

  @Test
  fun `keyless duplicate stays quarantined when an owned completion is claimed or stopped`() =
    runTest {
      for (stopped in listOf(false, true)) {
        for (keylessFirst in listOf(false, true)) {
          val response = CompletableDeferred<String>()
          val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
          val coordinator =
            coordinator(
              responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
              onUnhandledCompletion = unhandled::add,
            )
          coordinator.beginSession(RealtimeAgentSession("relay-1", "main"))
          coordinator.consult("call-1")
          runCurrent()
          val keys = listOf(null, "agent:voice:main").let { if (keylessFirst) it else it.reversed() }
          keys.forEach { assertTrue(coordinator.complete(it, "run-1", "owned")) }
          if (stopped) coordinator.endSession()
          response.complete("""{"runId":"run-1","agentSessionKey":"agent:voice:main"}""")
          runCurrent()

          assertTrue("Compatible duplicate escaped into ordinary TTS", unhandled.isEmpty())
          assertEquals(if (stopped) 0 else 1, calls.count { it.method == "talk.session.submitToolResult" })
          coordinator.endSession()
        }
      }
    }

  @Test
  fun `wrong session early final cannot displace the owned final`() =
    runTest {
      val response = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "main"))
      coordinator.consult("call-1")
      runCurrent()
      assertTrue(coordinator.complete("other-session", "run-1", "private"))
      assertTrue(coordinator.complete("agent:voice:main", "run-1", "owned"))
      response.complete("""{"runId":"run-1","agentSessionKey":"agent:voice:main"}""")
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"text\":\"owned\""))
      assertEquals(listOf("other-session"), unhandled.map { it.sessionKey })
    }

  @Test
  fun `later duplicate ack cannot steal an earlier pending completion`() =
    runTest {
      val responses = List(2) { CompletableDeferred<String>() }
      var requestIndex = 0
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") responses[requestIndex++].await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "main"))
      coordinator.consult("call-1")
      runCurrent()
      assertTrue(coordinator.complete("agent:voice:main", "run-1", "owned"))
      coordinator.consult("call-2")
      runCurrent()
      val ack = """{"runId":"run-1","agentSessionKey":"agent:voice:main"}"""
      responses[1].complete(ack)
      runCurrent()
      responses[0].complete(ack)
      runCurrent()

      val results = calls.filter { it.method == "talk.session.submitToolResult" }.map { Json.parseToJsonElement(it.params).jsonObject }
      assertEquals(2, results.size)
      assertEquals(
        "tool call returned a duplicate run id",
        results
          .single { it.getValue("callId").jsonPrimitive.content == "call-2" }
          .getValue("result")
          .jsonObject
          .getValue("error")
          .jsonPrimitive.content,
      )
      assertEquals(
        "owned",
        results
          .single { it.getValue("callId").jsonPrimitive.content == "call-1" }
          .getValue("result")
          .jsonObject
          .getValue("text")
          .jsonPrimitive.content,
      )
    }

  @Test
  fun `consult follows acknowledged ownership before and after the ack`() =
    runTest {
      for ((voiceKey, agentKey) in listOf("main" to "agent:voice:main", "global" to "global")) {
        for (early in listOf(false, true)) {
          val response = CompletableDeferred<String>()
          val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
          val coordinator =
            coordinator(
              responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
              onUnhandledCompletion = unhandled::add,
            )
          coordinator.beginSession(RealtimeAgentSession("relay-1", voiceKey))
          coordinator.consult("call-1")
          runCurrent()

          if (early) {
            assertTrue(coordinator.complete("other-session", "unrelated-run", "private"))
            assertTrue(coordinator.complete(agentKey, "run-1", "done"))
            runCurrent()
            assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
          }
          response.complete("""{"runId":"run-1","agentId":"voice","agentSessionKey":"$agentKey"}""")
          runCurrent()
          if (!early) {
            assertFalse(coordinator.complete("other-session", "run-1", "private"))
            assertTrue(coordinator.complete(agentKey, "run-1", "done"))
            runCurrent()
          }

          val consult = calls.single { it.method == "talk.client.toolCall" }
          assertEquals(
            voiceKey,
            Json
              .parseToJsonElement(consult.params)
              .jsonObject
              .getValue("sessionKey")
              .jsonPrimitive.content,
          )
          val result = calls.single { it.method == "talk.session.submitToolResult" }
          val params = Json.parseToJsonElement(result.params).jsonObject
          assertEquals("relay-1", params.getValue("sessionId").jsonPrimitive.content)
          assertEquals(
            "done",
            params
              .getValue("result")
              .jsonObject
              .getValue("text")
              .jsonPrimitive.content,
          )
          assertEquals(if (early) listOf("unrelated-run") else emptyList(), unhandled.map { it.runId })
          coordinator.endSession()
        }
      }
    }

  @Test
  fun `consult correlates the active run and submits its final text`() =
    runTest {
      val working = mutableListOf<RealtimeAgentSession>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"run-1"}""" else "{}" },
          onWorking = working::add,
        )
      val session = RealtimeAgentSession("relay-1", "session-1")
      coordinator.beginSession(session)

      assertTrue(coordinator.consult("call-1"))
      runCurrent()

      assertEquals(listOf(session), working)
      assertFalse(coordinator.complete("other-session", "run-1", "wrong"))
      assertTrue(coordinator.complete("session-1", "run-1", "done"))
      runCurrent()

      val consult = calls.single { it.method == "talk.client.toolCall" }
      assertEquals(15_000L, consult.timeoutMs)
      assertTrue(consult.params.contains("\"name\":\"openclaw_agent_consult\""))
      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-1\""))
      assertTrue(result.params.contains("\"callId\":\"call-1\""))
      assertTrue(result.params.contains("\"text\":\"done\""))
    }

  @Test
  fun `early completion waits for run metadata`() =
    runTest {
      val response = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      coordinator.consult("call-1")
      runCurrent()

      assertTrue(coordinator.complete("session-1", "run-early", "early"))
      response.complete("""{"runId":"run-early"}""")
      runCurrent()

      assertTrue(
        calls
          .single { it.method == "talk.session.submitToolResult" }
          .params
          .contains("\"text\":\"early\""),
      )
    }

  @Test
  fun `validates tool names and dispatches control without a consult`() =
    runTest {
      val coordinator =
        coordinator(
          responses = { method ->
            when (method) {
              "talk.session.steer" -> """{"status":"steered"}"""
              else -> "{}"
            }
          },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      coordinator.handleToolCall(
        callId = "control-1",
        name = "openclaw_agent_control",
        args = Json.parseToJsonElement("""{"text":"stop","mode":"cancel"}"""),
        forced = false,
      )
      coordinator.handleToolCall(
        callId = "unknown-1",
        name = "other_tool",
        args = null,
        forced = false,
      )
      runCurrent()

      assertTrue(calls.none { it.method == "talk.client.toolCall" })
      val steer = calls.single { it.method == "talk.session.steer" }
      assertTrue(steer.params.contains("\"mode\":\"cancel\""))
      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertTrue(results.any { it.params.contains("\"status\":\"steered\"") })
      assertTrue(results.any { it.params.contains("unsupported realtime Talk tool: other_tool") })
    }

  @Test
  fun `forced consult reports working then returns gateway errors`() =
    runTest {
      val errors = mutableListOf<String>()
      val coordinator =
        coordinator(
          responses = { method ->
            if (method == "talk.client.toolCall") error("gateway offline") else "{}"
          },
          onError = errors::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      coordinator.consult("call-1", forced = true)
      runCurrent()

      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertEquals(2, results.size)
      assertTrue(results[0].params.contains("\"status\":\"working\""))
      assertTrue(results[0].params.contains("\"willContinue\":true"))
      assertTrue(results[1].params.contains("\"error\":\"gateway offline\""))
      assertEquals(listOf("realtime toolCall failed: gateway offline"), errors)
    }

  @Test
  fun `session replacement quarantines the old run while a call id is reused`() =
    runTest {
      val oldResponse = CompletableDeferred<String>()
      val newResponse = CompletableDeferred<String>()
      var requestCount = 0
      val coordinator =
        coordinator(
          responses = { method ->
            if (method != "talk.client.toolCall") {
              "{}"
            } else if (requestCount++ == 0) {
              oldResponse.await()
            } else {
              newResponse.await()
            }
          },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-shared")
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      coordinator.consult("call-shared")
      runCurrent()

      assertTrue(coordinator.complete("session-main", "run-new", "fresh"))
      newResponse.complete("""{"runId":"run-new"}""")
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-new\""))
      assertTrue(result.params.contains("\"text\":\"fresh\""))

      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()
      assertTrue(coordinator.complete("session-main", "run-old", "stale"))
      assertEquals(1, calls.count { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `transport reset cancels an old consult before a new gateway session`() =
    runTest {
      val oldResponse = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") oldResponse.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      coordinator.consult("call-old-2")
      runCurrent()
      assertTrue(coordinator.complete("session-main", "cached-old-run", "stale cached"))

      coordinator.resetTransport()
      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      assertTrue(unhandled.isEmpty())
      assertFalse(coordinator.complete("session-main", "run-old", "stale"))
    }

  @Test
  fun `transport reset rejects a reused retired run id without stranding the call`() =
    runTest {
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"shared-run"}""" else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.resetTransport()
      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      coordinator.consult("call-new")
      runCurrent()

      assertTrue(coordinator.complete("session-main", "shared-run", "late"))
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-new\""))
      assertTrue(result.params.contains("\"callId\":\"call-new\""))
      assertTrue(result.params.contains("tool call returned a duplicate run id"))
    }

  @Test
  fun `old session request releases an unrelated completion after its ack`() =
    runTest {
      val oldResponse = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") oldResponse.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-old"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-new"))

      assertTrue(coordinator.complete("session-new", "ordinary-run", "ordinary"))
      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      assertEquals(listOf("ordinary-run"), unhandled.map { it.runId })
    }

  @Test
  fun `new pending calls cannot prolong an unrelated early completion`() =
    runTest {
      val responses = List(2) { CompletableDeferred<String>() }
      var requestIndex = 0
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") responses[requestIndex++].await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      coordinator.consult("call-1")
      runCurrent()
      assertTrue(coordinator.complete("session-1", "ordinary-run", "ordinary"))
      coordinator.consult("call-2")
      runCurrent()

      responses[0].complete("""{"runId":"run-1"}""")
      runCurrent()

      assertEquals(listOf("ordinary-run"), unhandled.map { it.runId })
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      responses[1].complete("""{"runId":"run-2"}""")
      runCurrent()
      coordinator.endSession()
    }

  @Test
  fun `session replacement consumes a known old run with the same session key`() =
    runTest {
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"run-old"}""" else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))

      assertTrue(coordinator.complete("session-main", "run-old", "stale"))
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session end retains unresolved correlation and quarantines its final`() =
    runTest {
      val response = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.endSession("relay-old")
      assertTrue(coordinator.complete("session-main", "run-old", "stale"))
      response.complete("""{"runId":"run-old"}""")
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session end suppresses a late gateway failure`() =
    runTest {
      val response = CompletableDeferred<String>()
      val errors = mutableListOf<String>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onError = errors::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.endSession("relay-old")
      response.completeExceptionally(IllegalStateException("late failure"))
      runCurrent()

      assertTrue(errors.isEmpty())
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session cleanup releases uncertain early completions`() =
    runTest {
      val response = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()
      assertTrue(coordinator.complete("session-main", "uncertain-run", "ordinary"))

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      response.complete("""{"runId":"old-tool-run"}""")
      runCurrent()

      assertEquals(listOf("uncertain-run"), unhandled.map { it.runId })
      assertEquals("final", unhandled.single().state)
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `early completion overflow fails pending calls instead of stranding them`() =
    runTest {
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val responses = List(3) { CompletableDeferred<String>() }
      var responseIndex = 0
      val coordinator =
        coordinator(
          responses = { method ->
            if (method == "talk.client.toolCall") responses[responseIndex++].await() else "{}"
          },
          onUnhandledCompletion = unhandled::add,
          maxCachedCompletions = 2,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      repeat(3) { index ->
        coordinator.consult("call-${index + 1}")
      }
      runCurrent()
      repeat(3) { index ->
        coordinator.complete("session-1", "run-${index + 1}", "result-${index + 1}")
      }
      runCurrent()
      responses.take(2).forEachIndexed { index, response -> response.complete("""{"runId":"run-${index + 1}"}""") }
      runCurrent()

      val submittedResults =
        calls
          .filter { it.method == "talk.session.submitToolResult" }
          .associate { call ->
            val params = Json.parseToJsonElement(call.params) as JsonObject
            params.getValue("callId").jsonPrimitive.content to call.params
          }
      assertTrue(submittedResults.getValue("call-1").contains("correlation buffer overflow"))
      assertTrue(submittedResults.getValue("call-2").contains("correlation buffer overflow"))
      assertTrue(submittedResults.getValue("call-3").contains("too many concurrent"))
      assertEquals(listOf("run-1", "run-2", "run-3"), unhandled.map { it.runId })
      assertEquals(2, calls.count { it.method == "talk.client.toolCall" })
    }

  @Test
  fun `registered runs count against the concurrent call limit`() =
    runTest {
      var runIndex = 0
      val coordinator =
        coordinator(
          responses = { method ->
            if (method == "talk.client.toolCall") """{"runId":"run-${++runIndex}"}""" else "{}"
          },
          maxCachedCompletions = 2,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      repeat(3) { index ->
        coordinator.consult("call-${index + 1}")
        runCurrent()
      }

      assertEquals(2, calls.count { it.method == "talk.client.toolCall" })
      val rejection = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(rejection.params.contains("\"callId\":\"call-3\""))
      assertTrue(rejection.params.contains("too many concurrent realtime Talk tool calls"))
    }

  private fun kotlinx.coroutines.test.TestScope.coordinator(
    responses: suspend (String) -> String,
    onWorking: (RealtimeAgentSession) -> Unit = {},
    onError: (String) -> Unit = {},
    onUnhandledCompletion: (RealtimeAgentUnhandledCompletion) -> Unit = {},
    maxCachedCompletions: Int = 128,
  ): RealtimeAgentCoordinator {
    calls = mutableListOf()
    return RealtimeAgentCoordinator(
      parentScope = backgroundScope,
      requestGateway = { method, params, timeoutMs ->
        calls += GatewayCall(method, params.orEmpty(), timeoutMs)
        responses(method)
      },
      onWorking = onWorking,
      onError = { _, message -> onError(message) },
      onUnhandledCompletion = onUnhandledCompletion,
      maxCachedCompletions = maxCachedCompletions,
    )
  }

  private fun RealtimeAgentCoordinator.consult(
    callId: String,
    forced: Boolean = false,
  ): Boolean = handleToolCall(callId, "openclaw_agent_consult", null, forced)

  private fun RealtimeAgentCoordinator.complete(
    sessionKey: String?,
    runId: String,
    text: String,
  ): Boolean = handleChatEvent(sessionKey, runId, "final", Json.parseToJsonElement("""{"role":"assistant","content":"$text"}"""))

  private data class GatewayCall(
    val method: String,
    val params: String,
    val timeoutMs: Long,
  )
}
