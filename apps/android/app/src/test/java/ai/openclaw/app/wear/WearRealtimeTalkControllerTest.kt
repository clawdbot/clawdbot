package ai.openclaw.app.wear

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeAudioFrameType
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import android.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class WearRealtimeTalkControllerTest {
  @Test
  fun `stop before a delayed start prevents relay resurrection`() =
    runTest {
      var gatewayCalls = 0
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { _, _, _ ->
            gatewayCalls += 1
            """{"relaySessionId":"relay-late"}"""
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
        )

      assertTrue(controller.stop("watch-a", "attempt-a"))
      assertFalse(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )
      assertEquals(0, gatewayCalls)
    }

  @Test
  fun `abort during connecting keeps a missing late session off`() =
    runTest {
      val forcedChannelCloses = mutableListOf<String>()
      lateinit var controller: WearRealtimeTalkController
      controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { _, _, _ -> """{"ok":true}""" },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
          onSnapshot = { snapshot ->
            if (snapshot.status == WearRealtimeTalkStatus.CONNECTING) controller.abort()
          },
          onForceCloseWatchChannel = { nodeId -> forcedChannelCloses += nodeId },
        )

      assertFalse(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )
      assertEquals(listOf("watch-a"), forcedChannelCloses)
      assertEquals(WearRealtimeTalkStatus.OFF, controller.snapshot.value.status)
      assertEquals("attempt-a", controller.snapshot.value.attemptId)
    }

  @Test
  fun `disconnect during session creation closes a late relay`() =
    runTest {
      var connected = true
      val createStarted = CompletableDeferred<Unit>()
      val createResult = CompletableDeferred<String>()
      val gatewayMethods = mutableListOf<String>()
      val forcedChannelCloses = mutableListOf<String>()
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { connected },
          requestGateway = { method, _, _ ->
            gatewayMethods += method
            if (method == "talk.session.create") {
              createStarted.complete(Unit)
              createResult.await()
            } else {
              """{"ok":true}"""
            }
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
          onForceCloseWatchChannel = { nodeId -> forcedChannelCloses += nodeId },
        )

      val startResult =
        async {
          controller.start(
            nodeId = "watch-a",
            sessionKey = "session-a",
            attemptId = "attempt-a",
            language = "de",
          )
        }
      createStarted.await()
      connected = false
      controller.abort()
      createResult.complete("""{"relaySessionId":"relay-late"}""")

      assertFalse(startResult.await())
      assertEquals(listOf("talk.session.create", "talk.session.close"), gatewayMethods)
      assertEquals(listOf("watch-a"), forcedChannelCloses)
      assertEquals(WearRealtimeTalkStatus.OFF, controller.snapshot.value.status)
      assertEquals("attempt-a", controller.snapshot.value.attemptId)
    }

  @Test
  fun `active session remains owned by the node that started it`() =
    runTest {
      val forcedChannelCloses = mutableListOf<String>()
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { method, _, _ ->
            if (method == "talk.session.create") {
              """{"relaySessionId":"relay-1"}"""
            } else {
              """{"ok":true}"""
            }
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
          onForceCloseWatchChannel = { nodeId -> forcedChannelCloses += nodeId },
        )

      assertTrue(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )
      assertFalse(
        controller.start(
          nodeId = "watch-b",
          sessionKey = "session-a",
          attemptId = "attempt-b",
          language = "de",
        ),
      )
      assertFalse(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-b",
          attemptId = "attempt-b",
          language = "de",
        ),
      )

      assertFalse(controller.stop("watch-b"))
      assertFalse(controller.stop("watch-a", "attempt-b"))
      assertTrue(controller.stop("watch-a", "attempt-a"))
      assertTrue(forcedChannelCloses.isEmpty())
    }

  @Test
  fun `retries without language when an older gateway rejects only that field`() =
    runTest {
      val createParams = mutableListOf<String?>()
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { method, params, _ ->
            if (method != "talk.session.create") {
              """{"ok":true}"""
            } else {
              createParams += params
              if (createParams.size == 1) {
                throw GatewayRequestRejected(
                  GatewaySession.ErrorShape(
                    code = "INVALID_REQUEST",
                    message =
                      "invalid talk.session.create params: at root: unexpected property 'language'",
                  ),
                )
              }
              """{"relaySessionId":"relay-legacy"}"""
            }
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
        )

      assertTrue(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )

      assertEquals(2, createParams.size)
      assertTrue(createParams.first().orEmpty().contains("\"sessionKey\":\"session-a\""))
      assertTrue(createParams.first().orEmpty().contains(""""language":"de""""))
      assertFalse(createParams.last().orEmpty().contains(""""language""""))
      assertEquals(WearRealtimeTalkStatus.LISTENING, controller.snapshot.value.status)
      controller.stop("watch-a")
    }

  @Test
  fun `does not retry unrelated invalid requests`() =
    runTest {
      var createAttempts = 0
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { method, _, _ ->
            if (method == "talk.session.create") {
              createAttempts += 1
              throw GatewayRequestRejected(
                GatewaySession.ErrorShape(
                  code = "INVALID_REQUEST",
                  message = "invalid talk.session.appendAudio params",
                ),
              )
            }
            """{"ok":true}"""
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> },
        )

      assertFalse(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )
      assertEquals(1, createAttempts)
    }

  @Test
  fun `chunks provider audio and sends clear in order`() =
    runTest {
      val output = mutableListOf<Pair<WearRealtimeAudioFrameType, ByteArray>>()
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { method, _, _ ->
            if (method == "talk.session.create") {
              """{"relaySessionId":"relay-1"}"""
            } else {
              """{"ok":true}"""
            }
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, type, payload -> output += type to payload },
        )
      assertTrue(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )
      val audio =
        ByteArray(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES * 2 + 8) { index ->
          (index % 127).toByte()
        }

      controller.handleGatewayEvent(
        "talk.event",
        """
        {
          "relaySessionId":"relay-1",
          "type":"audio",
          "audioBase64":"${Base64.encodeToString(audio, Base64.NO_WRAP)}"
        }
        """.trimIndent(),
      )
      controller.handleGatewayEvent(
        "talk.event",
        """{"relaySessionId":"relay-1","type":"clear"}""",
      )
      runCurrent()

      assertEquals(
        listOf(
          WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES,
          WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES,
          8,
        ),
        output
          .filter { it.first == WearRealtimeAudioFrameType.OUTPUT_PCM }
          .map { it.second.size },
      )
      val deliveredAudio =
        output
          .filter { it.first == WearRealtimeAudioFrameType.OUTPUT_PCM }
          .flatMap { it.second.asIterable() }
          .toByteArray()
      assertArrayEquals(audio, deliveredAudio)
      assertEquals(WearRealtimeAudioFrameType.CLEAR_OUTPUT, output.last().first)
      assertTrue(controller.stop("watch-a"))
    }

  @Test
  fun `reports an error and closes the relay when watch audio delivery fails`() =
    runTest {
      val gatewayMethods = mutableListOf<String>()
      val forcedChannelCloses = mutableListOf<String>()
      val controller =
        WearRealtimeTalkController(
          scope = this,
          isConnected = { true },
          requestGateway = { method, _, _ ->
            gatewayMethods += method
            if (method == "talk.session.create") {
              """{"relaySessionId":"relay-1"}"""
            } else {
              """{"ok":true}"""
            }
          },
          sendGatewayFrame = { _, _, _, _ -> },
          sendWatchFrame = { _, _, _ -> error("wear link down") },
          onForceCloseWatchChannel = { nodeId -> forcedChannelCloses += nodeId },
        )
      assertTrue(
        controller.start(
          nodeId = "watch-a",
          sessionKey = "session-a",
          attemptId = "attempt-a",
          language = "de",
        ),
      )

      controller.handleGatewayEvent(
        "talk.event",
        """
        {
          "relaySessionId":"relay-1",
          "type":"audio",
          "audioBase64":"${Base64.encodeToString(ByteArray(16), Base64.NO_WRAP)}"
        }
        """.trimIndent(),
      )
      runCurrent()

      assertEquals(WearRealtimeTalkStatus.ERROR, controller.snapshot.value.status)
      assertEquals("Unable to send audio to Watch", controller.snapshot.value.statusText)
      assertTrue("talk.session.close" in gatewayMethods)
      assertEquals(listOf("watch-a"), forcedChannelCloses)
    }
}
