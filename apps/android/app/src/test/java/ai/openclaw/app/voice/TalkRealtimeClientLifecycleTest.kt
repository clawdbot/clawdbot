package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewayRealtimeOffer
import ai.openclaw.app.gateway.GatewaySession
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import org.webrtc.SessionDescription
import java.util.concurrent.Executors

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  shadows = [StartupPeerFactory::class, StartupPeerFactoryBuilder::class, StartupPeerConnection::class, StartupDataChannel::class, StartupMediaTrack::class, StartupMediaSource::class],
)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimeClientLifecycleTest {
  @Test fun closeBoundsSlowAcceptedTranscriptDrainAndRetiresActualJobs() =
    runTest {
      for (ackDelay in listOf(4_000L, 10_000L, 1_000L)) {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val owner = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val sent = mutableListOf<String>()
        val failures = mutableListOf<String>()
        val visibleFailures = mutableListOf<String>()
        val loggedBeforeCallback = mutableListOf<Boolean>()
        var retired = false
        ShadowLog.clear()
        val enqueues = mutableListOf<(() -> Unit) -> Unit>()
        var persisted = 0
        var completed = 0
        val lease =
          GatewaySession.RequestLease("fixture", requestImpl = { method, _, timeout, enqueue ->
            enqueue { sent.add(method) }
            if (method == "talk.client.transcript") {
              enqueues.add(enqueue)
              try {
                delay(ackDelay)
                if (ackDelay == timeout) error("request timeout")
                persisted++
              } finally {
                completed++
              }
            }
            "{}"
          })
        val client =
          TalkRealtimeClient(RuntimeEnvironment.getApplication(), owner, lease, "main", {}, { _, _, _ -> }, {
            loggedBeforeCallback.add(ShadowLog.getLogsForTag("TalkRealtime").any { entry -> entry.type == Log.WARN && entry.msg == "Voice transcript could not be saved" })
            failures.add(it)
            // Model the manager's retained identity guard: retirement cannot change a new call UI.
            if (!retired) visibleFailures.add(it)
          })
        try {
          // The existing JNI tests cover held callbacks. Accept speech first, then
          // join actual physical retirement without advancing the virtual RPC clock.
          val peer =
            client.javaClass
              .getDeclaredField("peer")
              .apply { isAccessible = true }
              .get(client) as TalkRealtimePeer
          client.javaClass
            .getDeclaredField("voiceSessionId")
            .apply { isAccessible = true }
            .set(client, "voice-drain")
          val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
          for (index in 1..4) {
            val previous = if (index == 1) "null" else "\"u${index - 1}\""
            event.invoke(client, """{"type":"input_audio_buffer.committed","item_id":"u$index","previous_item_id":$previous}""")
            event.invoke(client, """{"type":"conversation.item.input_audio_transcription.completed","item_id":"u$index","transcript":"accepted $index"}""")
          }
          retired = true
          val physical = owner.async { peer.close() }
          runBlocking { withTimeout(5_000) { physical.await() } }
          val start = currentTime
          val first = async { client.close() }
          val second = async { client.close() }
          first.await()
          second.await()
          assertTrue("Drain must share one existing 10s transcript budget, not one per item", currentTime - start <= 10_000)
          assertEquals(1, sent.count { it == "talk.client.close" })
          val expectedLoss = if (ackDelay == 1_000L) emptyList<String>() else listOf("Voice transcript could not be saved")
          assertEquals(expectedLoss, failures)
          assertEquals("The producer must record loss before invoking a possibly ignored callback", expectedLoss.map { true }, loggedBeforeCallback)
          assertTrue("Retired callbacks must not replace the active call UI", visibleFailures.isEmpty())
          val diagnostics = ShadowLog.getLogsForTag("TalkRealtime").filter { it.type == Log.WARN }
          assertEquals("A retired callback must not erase the redacted loss diagnostic", expectedLoss, diagnostics.map { it.msg })
          assertTrue("Diagnostics must not attach transcript-bearing exceptions", diagnostics.all { it.throwable == null })
          assertEquals(
            when (ackDelay) {
              1_000L -> 4
              4_000L -> 2
              else -> 0
            },
            persisted,
          )
          for (enqueue in enqueues) assertTrue("A retained final-enqueue guard must reject a retired owner", runCatching { enqueue { sent.add("late") } }.isFailure)
          val count = sent.size
          advanceTimeBy(60_000)
          runCurrent()
          assertEquals("Retired jobs must not enqueue after logical close", count, sent.size)
          assertEquals(sent.count { it == "talk.client.transcript" }, completed)
        } finally {
          client.close()
          owner.cancel()
          Dispatchers.resetMain()
        }
      }
    }

  @Test fun cancelWithoutProtocolEvidenceEndsTheCallInsteadOfGuessingGa() =
    runBlocking {
      for (event in listOf(null, """{"type":"session.updated","session":{}}""")) {
        withStartedClient(null) { client, failures, requests ->
          event?.let(StartupDataChannel::message)
          yield()
          client.cancelOutput()
          client.close()
          assertTrue("Unknown protocol must not send GA controls", StartupDataChannel.sent.isEmpty())
          assertEquals(listOf("Realtime response cancellation ended the call"), failures)
          assertEquals(1, requests.count { it == "talk.client.close" })
        }
      }
    }

  @Test fun oldFramelessWireAndExplicitDelegationEndInsteadOfSendingGaControls() =
    runBlocking {
      for ((source, event) in listOf(
        null to """{"type":"session.started","session":{"id":"native"}}""",
        null to """{"type":"turn.done","turn":{"role":"user","transcript":"hello"}}""",
        "delegation" to null,
      )) {
        withStartedClient(source) { client, failures, requests ->
          event?.let(StartupDataChannel::message)
          yield()
          client.cancelOutput()
          client.close()
          assertTrue("Frameless must not send GA controls", StartupDataChannel.sent.isEmpty())
          assertEquals(listOf("Realtime response cancellation ended the call"), failures)
          assertEquals(1, requests.count { it == "talk.client.close" })
        }
      }
    }

  @Test fun framelessFinalPersistsBeforeLogicalClose() =
    runBlocking {
      withStartedClient("delegation") { client, failures, requests ->
        StartupDataChannel.message("""{"type":"turn.done","turn":{"role":"user","transcript":"accepted native final"}}""")
        yield()
        client.close()
        assertEquals(emptyList<String>(), failures)
        assertEquals(listOf("talk.client.create", "talk.client.transcript", "talk.client.close"), requests)
      }
    }

  @Test fun oldGaWireAndExplicitTranscriptRetainOutputCancellation() =
    runBlocking {
      for ((source, event) in listOf(
        null to """{"type":"session.created","session":{"id":"ga"}}""",
        null to """{"type":"response.created","response":{"id":"response"}}""",
        "transcript" to null,
      )) {
        withStartedClient(source) { client, failures, requests ->
          event?.let(StartupDataChannel::message)
          yield()
          client.cancelOutput()
          assertTrue(failures.isEmpty())
          assertFalse(requests.contains("talk.client.close"))
          assertTrue(StartupDataChannel.sent.any { it.contains("output_audio_buffer.clear") })
          if (event?.contains("response.created") == true) assertTrue(StartupDataChannel.sent.any { it.contains("response.cancel") })
        }
      }
    }

  @Test fun rejectsOversizedRetainedProviderIdsBeforeToolOrTranscriptWork() =
    runBlocking {
      val oversized = "x".repeat(1025)
      val cases =
        listOf(
          listOf("""{"type":"response.done","response":{"id":"$oversized","status":"completed","output":[]}}"""),
          listOf("""{"type":"response.created","response":{"id":"$oversized"}}"""),
          listOf(
            """{"type":"input_audio_buffer.committed","item_id":"$oversized","previous_item_id":null}""",
            """{"type":"conversation.item.input_audio_transcription.completed","item_id":"$oversized","transcript":"accepted"}""",
          ),
          listOf("""{"type":"input_audio_buffer.committed","item_id":"child","previous_item_id":"$oversized"}"""),
          listOf("""{"type":"conversation.item.created","previous_item_id":null,"item":{"id":"$oversized","type":"function_call"}}"""),
          listOf("""{"type":"response.done","response":{"id":"normal","status":"completed","output":[{"type":"function_call","status":"completed","call_id":"$oversized","name":"openclaw_agent_consult","arguments":"{}"}]}}"""),
        )
      for (events in cases) {
        withStartedClient("transcript") { client, failures, requests ->
          events.forEach(StartupDataChannel::message)
          yield()
          client.cancelOutput()
          client.close()
          assertEquals("Over-limit identities must end the call visibly", 1, failures.size)
          assertTrue("Diagnostics must not echo the rejected identity", failures.none { it.contains(oversized) })
          assertFalse(requests.contains("talk.client.toolCall"))
          assertFalse(requests.contains("talk.client.transcript"))
          assertTrue("Rejected response IDs must not be sent in cancellation controls", StartupDataChannel.sent.isEmpty())
          assertEquals(1, requests.count { it == "talk.client.close" })
        }
      }
    }

  @Test fun exactBoundaryIdsKeepCancellationAndTranscriptDedupeWithoutTruncation() =
    runBlocking {
      val first = "é".repeat(1024)
      val second = "é".repeat(1023) + "x"
      withStartedClient("transcript") { client, failures, requests ->
        StartupDataChannel.message("""{"type":"response.created","response":{"id":"$first"}}""")
        yield()
        client.cancelOutput()
        client.cancelOutput()
        StartupDataChannel.message("""{"type":"response.done","response":{"id":"$first","status":"cancelled"}}""")
        StartupDataChannel.message("""{"type":"response.done","response":{"id":"$first","status":"cancelled"}}""")
        var previous = "null"
        for (id in listOf(first, second)) {
          StartupDataChannel.message("""{"type":"input_audio_buffer.committed","item_id":"$id","previous_item_id":$previous}""")
          repeat(2) { StartupDataChannel.message("""{"type":"conversation.item.input_audio_transcription.completed","item_id":"$id","transcript":"accepted"}""") }
          previous = "\"$id\""
        }
        yield()
        client.close()
        assertTrue(failures.isEmpty())
        assertEquals(2, requests.count { it == "talk.client.transcript" })
        assertEquals(1, StartupDataChannel.sent.count { it.contains("response.cancel") })
        assertTrue(StartupDataChannel.sent.any { it.contains(first) })
      }
    }

  private suspend fun withStartedClient(
    controlSource: String?,
    check: suspend CoroutineScope.(TalkRealtimeClient, List<String>, List<String>) -> Unit,
  ) {
    // Protocol tests use real HTTP callbacks but no virtual-time assertions. Keep
    // the entire client on one Main executor rather than advancing timers across IO.
    val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    Dispatchers.setMain(main)
    try {
      withContext(main) {
        StartupPeerConnection.reset()
        StartupDataChannel.reset()
        val failures = mutableListOf<String>()
        val requests = mutableListOf<String>()
        val http =
          OkHttpClient
            .Builder()
            .addInterceptor { chain ->
              Response
                .Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body("v=0".toResponseBody())
                .build()
            }.build()
        val lease =
          GatewaySession.RequestLease("fixture", offerRouteImpl = { url -> GatewayRealtimeOffer(url, http, emptyMap()) { true } }, requestImpl = { method, _, _, enqueue ->
            enqueue { requests.add(method) }
            if (method == "talk.client.create") {
              // v2026.9.2's allocation omits controlSource; model remains opaque.
              val control = controlSource?.let { ",\"controlSource\":\"$it\"" } ?: ""
              """{"provider":"openai","transport":"webrtc","voiceSessionId":"voice-control","clientSecret":"fixture","offerUrl":"https://example.invalid/offer","model":"synthetic-voice-model","voice":"synthetic-voice"$control}"""
            } else {
              "{}"
            }
          })
        val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, { failures.add(it) })
        try {
          val starting = async { client.start() }
          val offer = withTimeout(5_000) { StartupPeerConnection.offerCreated.await() }
          offer.onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
          StartupDataChannel.open()
          withTimeout(5_000) { starting.await() }
          check(client, failures, requests)
        } finally {
          client.close()
          http.dispatcher.executorService.shutdown()
          http.connectionPool.evictAll()
        }
      }
    } finally {
      Dispatchers.resetMain()
      main.close()
    }
  }
}
