package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkSpeakAudio
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

private fun speechClip(bytes: ByteArray = byteArrayOf(1, 2, 3)): TalkSpeakAudio =
  TalkSpeakAudio(
    bytes = bytes,
    provider = "openai",
    outputFormat = "mp3",
    voiceCompatible = null,
    mimeType = "audio/mpeg",
    fileExtension = ".mp3",
  )

private class FakePlayer : TalkAudioPlaying {
  val played = mutableListOf<TalkSpeakAudio>()
  var stopCount = 0
  var gate: CompletableDeferred<Unit>? = null
  var failure: Throwable? = null
  private var activeGate: CompletableDeferred<Unit>? = null

  override suspend fun play(audio: TalkSpeakAudio) {
    played += audio
    failure?.let { throw it }
    val currentGate = gate
    activeGate = currentGate
    currentGate?.await()
  }

  override fun stop() {
    stopCount += 1
    activeGate?.cancel()
    activeGate = null
  }
}

private class FakeLocalSpeech : LocalSpeechSpeaking {
  val spoken = mutableListOf<String>()
  var stopCount = 0

  override suspend fun speak(text: String) {
    spoken += text
  }

  override fun stop() {
    stopCount += 1
  }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MessageSpeechControllerTest {
  @Test
  fun clientRequestsTtsSpeakAndPreservesPlaybackMetadata() =
    runTest {
      var method = ""
      var params = ""
      var timeoutMs = 0L
      val client =
        MessageSpeechClient(
          requestDetailed = { requestMethod, requestParams, requestTimeoutMs ->
            method = requestMethod
            params = requestParams
            timeoutMs = requestTimeoutMs
            GatewaySession.RpcResult(
              ok = true,
              payloadJson =
                """{"audioBase64":"AQID","provider":"openai","outputFormat":"mp3","mimeType":"audio/mpeg","fileExtension":".mp3"}""",
              error = null,
            )
          },
        )

      val audio = checkNotNull(client.synthesize("Hello"))

      assertEquals("tts.speak", method)
      assertEquals("""{"text":"Hello"}""", params)
      assertEquals(60_000L, timeoutMs)
      assertArrayEquals(byteArrayOf(1, 2, 3), audio.bytes)
      assertEquals("openai", audio.provider)
      assertEquals("mp3", audio.outputFormat)
      assertEquals("audio/mpeg", audio.mimeType)
      assertEquals(".mp3", audio.fileExtension)
    }

  @Test
  fun playsGatewayClipAndClearsState() =
    runTest {
      val player = FakePlayer().also { it.gate = CompletableDeferred() }
      val local = FakeLocalSpeech()
      val controller = controller(player = player, local = local)

      controller.toggle(messageId = "m1", text = "Hello there.")
      assertEquals(
        MessageSpeechState(messageId = "m1", phase = MessageSpeechPhase.Preparing),
        controller.state.value,
      )

      runCurrent()
      assertEquals(
        MessageSpeechState(messageId = "m1", phase = MessageSpeechPhase.Speaking),
        controller.state.value,
      )
      assertEquals(1, player.played.size)

      player.gate?.complete(Unit)
      advanceUntilIdle()
      assertNull(controller.state.value)
      assertTrue(local.spoken.isEmpty())
    }

  @Test
  fun fallsBackToLocalSpeechWhenGatewayCannotRender() =
    runTest {
      val player = FakePlayer()
      val local = FakeLocalSpeech()
      val controller = controller(player = player, local = local, synthesizer = { null })

      controller.toggle(messageId = "m1", text = "Read me aloud")
      advanceUntilIdle()

      assertEquals(listOf("Read me aloud"), local.spoken)
      assertTrue(player.played.isEmpty())
      assertNull(controller.state.value)
    }

  @Test
  fun fallsBackToLocalSpeechWhenClipPlaybackFails() =
    runTest {
      val player = FakePlayer().also { it.failure = IllegalStateException("Unsupported talk audio format") }
      val local = FakeLocalSpeech()
      val controller = controller(player = player, local = local)

      controller.toggle(messageId = "m1", text = "Broken clip")
      advanceUntilIdle()

      assertEquals(listOf("Broken clip"), local.spoken)
      assertNull(controller.state.value)
    }

  @Test
  fun toggleWhileActiveStopsWithoutFallback() =
    runTest {
      val player = FakePlayer().also { it.gate = CompletableDeferred() }
      val local = FakeLocalSpeech()
      val controller = controller(player = player, local = local)

      controller.toggle(messageId = "m1", text = "Long reply")
      runCurrent()
      controller.toggle(messageId = "m1", text = "Long reply")

      assertNull(controller.state.value)
      assertTrue(player.stopCount > 0)
      advanceUntilIdle()
      assertTrue(local.spoken.isEmpty())
      assertNull(controller.state.value)
    }

  @Test
  fun startingAnotherMessageSupersedesTheFirst() =
    runTest {
      val player = FakePlayer().also { it.gate = CompletableDeferred() }
      val local = FakeLocalSpeech()
      val controller = controller(player = player, local = local)

      controller.toggle(messageId = "m1", text = "First message")
      runCurrent()
      player.gate = CompletableDeferred()
      controller.toggle(messageId = "m2", text = "Second message")
      runCurrent()

      assertEquals(
        MessageSpeechState(messageId = "m2", phase = MessageSpeechPhase.Speaking),
        controller.state.value,
      )
      player.gate?.complete(Unit)
      advanceUntilIdle()
      assertNull(controller.state.value)
      assertTrue(local.spoken.isEmpty())
    }

  @Test
  fun blankTextStaysIdle() =
    runTest {
      val player = FakePlayer()
      val local = FakeLocalSpeech()
      val controller = controller(player = player, local = local)

      controller.toggle(messageId = "m1", text = "   \n ")
      advanceUntilIdle()

      assertNull(controller.state.value)
      assertTrue(player.played.isEmpty())
      assertTrue(local.spoken.isEmpty())
    }

  private fun kotlinx.coroutines.test.TestScope.controller(
    player: FakePlayer,
    local: FakeLocalSpeech,
    synthesizer: MessageSpeechSynthesizing = MessageSpeechSynthesizing { speechClip() },
  ): MessageSpeechController =
    MessageSpeechController(
      scope = this,
      synthesizer = synthesizer,
      player = player,
      localSpeech = local,
    )
}
