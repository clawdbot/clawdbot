package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkAudioPlayerTest {
  @Test
  fun resolvesPcmPlaybackFromOutputFormat() {
    val mode =
      TalkAudioPlayer.resolvePlaybackMode(
        outputFormat = "pcm_24000",
        mimeType = null,
        fileExtension = null,
      )

    assertEquals(TalkPlaybackMode.Pcm(sampleRate = 24_000), mode)
  }

  @Test
  fun resolvesCompressedPlaybackFromMimeType() {
    val mode =
      TalkAudioPlayer.resolvePlaybackMode(
        outputFormat = null,
        mimeType = "audio/mpeg",
        fileExtension = null,
      )

    assertEquals(TalkPlaybackMode.Compressed(fileExtension = ".mp3"), mode)
  }

  @Test
  fun preservesProvidedExtensionForCompressedPlayback() {
    val mode =
      TalkAudioPlayer.resolvePlaybackMode(
        outputFormat = null,
        mimeType = "audio/webm",
        fileExtension = "webm",
      )

    assertTrue(mode is TalkPlaybackMode.Compressed)
    assertEquals(".webm", (mode as TalkPlaybackMode.Compressed).fileExtension)
  }
}
