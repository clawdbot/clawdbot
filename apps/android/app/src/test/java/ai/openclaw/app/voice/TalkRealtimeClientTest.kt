package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.concurrent.locks.Condition
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimeClientTest {
  @Test
  fun forwardsSavedMicrophoneIntentWithoutCallingItAnAppliedRoute() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      var selected: String? = "saved-input-key"
      val requests = mutableListOf<String?>()
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {}, { selected }, { requests.add(it) })
      try {
        val peer = realtimeTestField(client, "peer").get(client)
        val readPreference =
          peer.javaClass
            .getDeclaredField("preferredAudioInputDevice")
            .apply { isAccessible = true }
            .get(peer) as Function0<*>
        assertEquals(selected, readPreference())
        selected = null
        assertNull(readPreference())
        assertTrue(requests.isEmpty())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun framelessProviderIdentityNeverCrossesTheGatewayWire() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
      event.invoke(client, """{"type":"turn.done","turn":{"id":"provider:item/ü","role":"user","transcript":"hello"}}""")
      @Suppress("UNCHECKED_CAST")
      val finals = realtimeTestField(client, "finalTranscripts").get(client) as Set<String>
      assertTrue("user:native-1" in finals)
      assertFalse(finals.any { "provider:item" in it })
      client.close()
      Dispatchers.resetMain()
    }

  @Test
  fun consultationWaitsForReservedDelayedUserBeforeEarlyAssistantFinal() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val methods = mutableListOf<String>()
      val lease =
        GatewaySession.RequestLease("fixture", requestImpl = { method, _, _, _ ->
          methods.add(method)
          "{}"
        })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      try {
        realtimeTestField(client, "voiceSessionId").set(client, "voice-fixture")
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        event.invoke(client, """{"type":"input_audio_buffer.committed","item_id":"u1","previous_item_id":null}""")
        event.invoke(client, """{"type":"conversation.item.created","previous_item_id":"u1","item":{"id":"a1","type":"message","role":"assistant","content":[{"type":"audio"}]}}""")
        event.invoke(client, """{"type":"response.output_audio_transcript.done","item_id":"a1","transcript":"answer"}""")
        val transport =
          client.javaClass
            .getDeclaredMethod("clientTransport")
            .apply { isAccessible = true }
            .invoke(client) as RealtimeAgentClientTransport
        val consult = async { transport.request("talk.client.toolCall", "{}", 1_000) }
        runCurrent()
        assertTrue(methods.isEmpty())
        event.invoke(client, """{"type":"conversation.item.input_audio_transcription.completed","item_id":"u1","transcript":"question"}""")
        runCurrent()
        consult.await()
        assertEquals(listOf("talk.client.transcript", "talk.client.transcript", "talk.client.toolCall"), methods)
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun transcriptRequestsMatchTheGatewayProtocolFixture() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val fixture = javaClass.getResourceAsStream("/talk-transcript-protocol.json")!!.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
      val requests = mutableListOf<JsonObject>()
      val lease =
        GatewaySession.RequestLease("fixture", requestImpl = { method, params, _, _ ->
          if (method == "talk.client.transcript") requests.add(Json.parseToJsonElement(checkNotNull(params)).jsonObject)
          "{}"
        })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      try {
        realtimeTestField(client, "voiceSessionId").set(client, "voice-fixture")
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        for (payload in fixture.getValue("events").jsonArray) event.invoke(client, payload.toString())
        runCurrent()
        assertEquals(fixture.getValue("requests"), JsonArray(requests))
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun transcriptFailureIsReportedOnceWhileCloseStillCompletesAndSendsLogicalClose() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val failures = mutableListOf<String>()
      var closes = 0
      val lease =
        GatewaySession.RequestLease("fixture", requestImpl = { method, _, _, _ ->
          when (method) {
            "talk.client.transcript" -> {
              error("persistence failed")
            }

            "talk.client.close" -> {
              closes++
              "{}"
            }

            else -> {
              "{}"
            }
          }
        })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, { failures.add(it) })
      realtimeTestField(client, "voiceSessionId").set(client, "voice-fixture")
      val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
      event.invoke(client, """{"type":"input_audio_buffer.committed","item_id":"u1","previous_item_id":null}""")
      event.invoke(client, """{"type":"conversation.item.input_audio_transcription.completed","item_id":"u1","transcript":"question"}""")
      runCurrent()
      client.close()
      advanceUntilIdle()
      assertEquals(listOf("Voice transcript could not be saved"), failures)
      assertEquals(1, closes)
      Dispatchers.resetMain()
    }

  @Test
  fun completedEmptyResponseReturnsToListeningButNotOverAReplacementOrPlayback() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val states = mutableListOf<String>()
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", { states.add(it) }, { _, _, _ -> }, {})
      try {
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        event.invoke(client, """{"type":"response.created","response":{"id":"first"}}""")
        event.invoke(client, """{"type":"response.done","response":{"id":"first","status":"completed","output":[]}}""")
        assertEquals("Listening", states.last())
        event.invoke(client, """{"type":"response.created","response":{"id":"old"}}""")
        event.invoke(client, """{"type":"response.created","response":{"id":"replacement"}}""")
        event.invoke(client, """{"type":"response.done","response":{"id":"old","status":"completed","output":[]}}""")
        assertEquals("Thinking", states.last())
        event.invoke(client, """{"type":"output_audio_buffer.cleared","response_id":"old"}""")
        assertEquals("Thinking", states.last())
        event.invoke(client, """{"type":"output_audio_buffer.started","response_id":"replacement"}""")
        event.invoke(client, """{"type":"output_audio_buffer.stopped","response_id":"old"}""")
        assertEquals("Speaking", states.last())
        event.invoke(client, """{"type":"response.done","response":{"id":"replacement","status":"completed","output":[]}}""")
        assertEquals("Speaking", states.last())
        event.invoke(client, """{"type":"output_audio_buffer.stopped","response_id":"replacement"}""")
        assertEquals("Listening", states.last())
        event.invoke(client, """{"type":"response.created","response":{"id":"tools"}}""")
        event.invoke(client, """{"type":"response.done","response":{"id":"tools","status":"completed","output":[{"type":"function_call","status":"completed","call_id":"call-1","name":"openclaw_agent_consult","arguments":"{}"}]}}""")
        event.invoke(client, """{"type":"output_audio_buffer.stopped","response_id":"tools"}""")
        assertEquals("Thinking", states.last())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun admissionRetainsOnlyPublishedClientResources() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        for (accepted in listOf(false, true)) {
          val owner = SupervisorJob()
          val clientScope = CoroutineScope(owner + UnconfinedTestDispatcher(testScheduler))
          val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> error("Admission must not allocate a provider session") })
          val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), clientScope, lease, "main", {}, { _, _, _ -> }, {})
          assertTrue(owner.children.any { it.isActive })
          assertEquals(accepted, client.adopt { accepted })
          runCurrent()
          assertEquals(accepted, owner.children.any { it.isActive })
          assertNull(client.snapshot)
          client.close()
          runCurrent()
          assertFalse(owner.children.any { it.isActive })
          owner.cancel()
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun visibleStatusUsesOnlyTheCurrentConfirmedSnapshot() {
    assertEquals(nativeText("Connecting…"), talkRealtimeStatusText("Listening", null))
    val active = TalkRealtimeSnapshot("openai", "gpt-live-1-codex", "oauth", "spruce", "webrtc")
    val nextCall = active.copy(model = "gpt-realtime-2.1", authMethod = "api-key", voice = "alloy")
    val currentText = talkRealtimeStatusText("Thinking", active).resolveNativeText()
    assertTrue(currentText.contains("gpt-live-1-codex / oauth / spruce / webrtc"))
    assertFalse(currentText.contains(nextCall.model!!))
    assertTrue(talkRealtimeStatusText("Listening", nextCall).resolveNativeText().contains("gpt-realtime-2.1 / api-key / alloy / webrtc"))
    assertEquals(nativeText("Connecting…"), talkRealtimeStatusText("Thinking", null))
  }

  @Test
  fun captureResumptionPublishesCurrentStateWithoutWaitingForAnotherProviderEvent() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val states = mutableListOf<String>()
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" }), "main", { states.add(it) }, { _, _, _ -> }, {})
      try {
        client.setCaptureEnabled(true)
        assertEquals(listOf("Connecting"), states)
        // Resume behavior is isolated from allocation; seed the paired ready facts.
        realtimeTestField(client, "started").setBoolean(client, true)
        realtimeTestField(client, "snapshot").set(client, TalkRealtimeSnapshot("example", "synthetic-model", "api-key", "voice", "webrtc"))
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        for ((payload, expected) in listOf(
          """{"type":"response.created","response":{"id":"response"}}""" to "Thinking",
          """{"type":"response.done","response":{"id":"response","status":"completed","output":[]}}""" to "Listening",
          """{"type":"output_audio_buffer.started","response_id":"output"}""" to "Speaking",
        )) {
          event.invoke(client, payload)
          client.setCaptureEnabled(false)
          states.clear()
          client.setCaptureEnabled(true)
          assertEquals(listOf(expected), states)
        }
        client.close()
        states.clear()
        client.setCaptureEnabled(true)
        assertTrue(states.isEmpty())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun providerEventErrorsRemainRecoverableUntilATerminalSignal() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val states = mutableListOf<String>()
      val failures = mutableListOf<String>()
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", { states.add(it) }, { _, _, _ -> }, { failures.add(it) })
      try {
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        val state = realtimeTestField(client, "responseState").get(client) as TalkRealtimeResponseState
        state.requesting("create-event")
        event.invoke(client, """{"type":"error","event_id":"evt-1","error":{"type":"invalid_request_error","message":"recoverable","event_id":"create-event"}}""")
        event.invoke(client, """{"type":"conversation.item.input_audio_transcription.failed","event_id":"evt-2"}""")
        assertTrue(failures.isEmpty())
        assertFalse(
          realtimeTestField(client, "closed").getBoolean(client),
        )
        assertEquals("Listening", states.last())
        assertFalse(state.createInFlight)
        event.invoke(client, """{"type":"response.created","response":{"id":"next"}}""")
        assertEquals("Thinking", states.last())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun failedVadResponsesEndWithAVisibleFailureInsteadOfRemainingBusy() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        for (status in listOf("failed", "incomplete")) {
          val failures = mutableListOf<String>()
          val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
          val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, { failures.add(it) })
          try {
            val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
            event.invoke(client, """{"type":"input_audio_buffer.speech_stopped"}""")
            event.invoke(client, """{"type":"response.created","response":{"id":"automatic-response"}}""")
            event.invoke(client, """{"type":"response.done","response":{"id":"automatic-response","status":"$status","output":[]}}""")
            assertEquals(listOf("Realtime response failed or incomplete"), failures)
            assertTrue(
              realtimeTestField(client, "closed").getBoolean(client),
            )
            runCurrent()
          } finally {
            client.close()
          }
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun providerVadCompletionArmsCancellationBeforeTheResponseIdArrives() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> error("No gateway allocation expected") })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      try {
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        event.invoke(client, """{"type":"input_audio_buffer.speech_stopped"}""")
        val state = realtimeTestField(client, "responseState").get(client) as TalkRealtimeResponseState
        assertTrue(state.createInFlight)
        assertNull(state.cancel())
        // A client event without its own event_id produces an uncorrelated error.
        // It cannot revoke cancellation of a separate VAD response still awaiting its id.
        event.invoke(client, """{"type":"error","event_id":"server-error","error":{"type":"invalid_request_error","code":"synthetic_cancel_error","param":"response_id","message":"Late cancellation request rejected"}}""")
        assertTrue(state.createInFlight)
        assertEquals("automatic-response", state.created("automatic-response"))
        assertNull(state.cancel())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun requestsGatewayDefaultsAndRejectsAnotherTransportWithoutNativeFallback() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val methods = mutableListOf<String>()
        var createParams = ""
        val lease =
          GatewaySession.RequestLease("fixture", requestImpl = { method, params, _, enqueue ->
            enqueue {}
            methods.add(method)
            if (method == "talk.client.create") {
              createParams = checkNotNull(params)
              """{"voiceSessionId":"voice-fixture","transport":"provider-websocket"}"""
            } else {
              "{}"
            }
          })
        val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
        val failure = runCatching { client.start() }.exceptionOrNull()
        assertTrue(failure?.message.orEmpty().contains("unsupported Talk transport"))
        assertEquals(listOf("talk.client.create", "talk.client.close"), methods)
        val params = Json.parseToJsonElement(createParams).jsonObject
        assertEquals("webrtc", params.getValue("transport").jsonPrimitive.content)
        assertFalse(params.containsKey("model"))
        assertFalse(params.containsKey("provider"))
        assertFalse(params.containsKey("authMethod"))
        assertFalse(params.getValue("capabilities").toString().contains("gateway-control-v1"))
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun concurrentCloseWaitsForCallbackDrainAndSingleLogicalAcknowledgement() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val closeRequested = CompletableDeferred<Unit>()
      val acknowledgeClose = CompletableDeferred<Unit>()
      var closeRequests = 0
      val lease =
        GatewaySession.RequestLease("fixture", requestImpl = { method, _, _, _ ->
          if (method == "talk.client.close") {
            closeRequests++
            closeRequested.complete(Unit)
            acknowledgeClose.await()
          }
          "{}"
        })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      realtimeTestField(client, "voiceSessionId").set(client, "voice-retirement")
      val peer = realtimeTestField(client, "peer").get(client) as TalkRealtimePeer
      val callbackLock = realtimeTestField(peer, "callbackLock").get(peer) as ReentrantLock
      val callbacksDrained = realtimeTestField(peer, "callbacksDrained").get(peer) as Condition
      val callbacksInFlight = realtimeTestField(peer, "callbacksInFlight")
      // Hold the real JNI callback-drain boundary without loading native WebRTC.
      callbackLock.withLock { callbacksInFlight.setInt(peer, 1) }
      val first = async { client.close() }
      var second: Deferred<Unit>? = null
      var paused: Deferred<Unit>? = null
      try {
        runCurrent()
        assertFalse(first.isCompleted)
        second = async { client.close() }
        runCurrent()
        assertFalse("A second close must not finish while the native callback is still owned", second.isCompleted)
        paused = async { client.setCaptureEnabled(false) }
        runCurrent()
        assertFalse("Microphone handoff must await a peer already closing", paused.isCompleted)
        callbackLock.withLock {
          callbacksInFlight.setInt(peer, 0)
          callbacksDrained.signalAll()
        }
        closeRequested.await()
        // Physical handoff need not wait for the later logical Gateway ACK.
        paused.await()
        assertFalse(first.isCompleted)
        assertFalse("Every close also waits for the one logical acknowledgement", second.isCompleted)
        acknowledgeClose.complete(Unit)
        first.await()
        second.await()
        assertEquals(1, closeRequests)
      } finally {
        callbackLock.withLock {
          callbacksInFlight.setInt(peer, 0)
          callbacksDrained.signalAll()
        }
        acknowledgeClose.complete(Unit)
        first.await()
        second?.await()
        paused?.await()
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun closesAnAllocationReturnedAfterStopWithoutStartingMedia() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val ack = CompletableDeferred<String>()
        val requested = CompletableDeferred<Unit>()
        val methods = mutableListOf<String>()
        val states = mutableListOf<String>()
        val lease =
          GatewaySession.RequestLease("fixture", requestImpl = { method, _, _, enqueue ->
            enqueue {}
            methods.add(method)
            if (method == "talk.client.create") {
              requested.complete(Unit)
              ack.await()
            } else {
              "{}"
            }
          })
        val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", { states.add(it) }, { _, _, _ -> }, {})
        val starting = async { runCatching { client.start() } }
        requested.await()
        client.close()
        ack.complete("""{"voiceSessionId":"voice-late","transport":"webrtc","clientSecret":"synthetic-capability"}""")
        assertTrue(starting.await().isFailure)
        assertEquals(listOf("talk.client.create", "talk.client.close"), methods)
        assertTrue(states.isEmpty())
        assertNull(client.snapshot)
      } finally {
        Dispatchers.resetMain()
      }
    }
}

internal fun realtimeTestField(
  target: Any,
  name: String,
): Field = target.javaClass.getDeclaredField(name).apply { isAccessible = true }
