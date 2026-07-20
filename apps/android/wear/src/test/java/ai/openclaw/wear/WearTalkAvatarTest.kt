package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WearTalkAvatarTest {
  @Test
  fun silenceKeepsTheAvatarMouthClosed() {
    val pcm = ByteArray(samplesForFrames(2) * 2)

    assertEquals(listOf(0f, 0f), pcm16LeMouthLevels(pcm))
  }

  @Test
  fun outputPcmProducesOneBoundedMouthLevelPerPlaybackFrame() {
    val pcm = pcm16Le(samplesForFrames(2), sample = 24_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.all { level -> level in 0f..1f })
    assertTrue(levels.all { level -> level > 0.9f })
  }

  @Test
  fun finalPartialPlaybackFrameStillMovesTheMouth() {
    val pcm = pcm16Le(samplesForFrames(1) + 12, sample = 12_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.last() > 0f)
  }

  @Test
  fun consecutiveMaximumSizeChunksPreserveCumulativeWindowsAndFlushTheFinalPartial() {
    val chunks =
      listOf(
        pcm16Le(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES / 2, sample = 4_000),
        pcm16Le(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES / 2, sample = 20_000),
        pcm16Le(100, sample = 12_000),
      )
    val client = realtimeTalkClient()
    val queuedLevels = Channel<Float>(Channel.UNLIMITED)
    client.setPrivateField("activeNodeId", "watch-a")
    client.setPrivateField("mouthFrames", queuedLevels)

    try {
      val writeOutput = WearRealtimeTalkClient::class.java.getDeclaredMethod("writeOutput", ByteArray::class.java)
      writeOutput.isAccessible = true
      chunks.forEach { chunk -> writeOutput.invoke(client, chunk) }
      awaitPlaybackTeardown(client)

      val actualLevels =
        buildList {
          while (true) add(queuedLevels.tryReceive().getOrNull() ?: break)
        }
      assertEquals(pcm16LeMouthLevels(chunks.reduce(ByteArray::plus)), actualLevels)
    } finally {
      client.shutdown()
    }
  }

  @Test
  fun mouthEnvelopeUsesFastAttackAndSoftReleaseWithoutOvershoot() {
    val attack = smoothAvatarMouth(current = 0f, target = 1f, deltaSeconds = 0.02f)
    val release = smoothAvatarMouth(current = 1f, target = 0f, deltaSeconds = 0.02f)

    assertTrue(attack in 0f..1f)
    assertTrue(release in 0f..1f)
    assertTrue(attack > 0f)
    assertTrue(release > attack)
  }

  @Test
  fun mouthEnvelopeConvergesAcrossDisplayFrames() {
    var level = 0f
    repeat(30) { level = smoothAvatarMouth(level, target = 1f, deltaSeconds = 1f / 60f) }

    assertTrue(level > 0.99f)

    repeat(60) { level = smoothAvatarMouth(level, target = 0f, deltaSeconds = 1f / 60f) }

    assertTrue(level < 0.001f)
  }

  private fun samplesForFrames(frameCount: Int): Int = WEAR_REALTIME_SAMPLE_RATE_HZ * MOUTH_FRAME_MILLIS / 1_000 * frameCount

  private fun pcm16Le(
    sampleCount: Int,
    sample: Int,
  ): ByteArray =
    ByteArray(sampleCount * 2).also { bytes ->
      repeat(sampleCount) { index ->
        bytes[index * 2] = (sample and 0xff).toByte()
        bytes[(index * 2) + 1] = ((sample shr 8) and 0xff).toByte()
      }
    }

  private fun realtimeTalkClient(): WearRealtimeTalkClient {
    val requester =
      object : WearRpcRequester {
        override suspend fun request(
          method: WearRpcMethod,
          params: JsonObject,
          expectedNodeId: String?,
          requirePreferredNode: Boolean,
        ): WearRpcResult = error("Unexpected request: $method $params $expectedNodeId $requirePreferredNode")
      }
    return WearRealtimeTalkClient(RuntimeEnvironment.getApplication(), WearGatewayRepository(requester))
  }

  private fun awaitPlaybackTeardown(client: WearRealtimeTalkClient) {
    ShadowSystemClock.advanceBy(Duration.ofSeconds(1L))
    val deadlineNanos = System.nanoTime() + 2_000_000_000L
    while (client.isPlaying.value && System.nanoTime() < deadlineNanos) Thread.sleep(10L)
    assertEquals(false, client.isPlaying.value)
  }

  private fun Any.setPrivateField(
    name: String,
    value: Any,
  ) {
    javaClass.getDeclaredField(name).apply {
      isAccessible = true
      set(this@setPrivateField, value)
    }
  }

  private companion object {
    const val WEAR_REALTIME_SAMPLE_RATE_HZ = 24_000
  }
}
