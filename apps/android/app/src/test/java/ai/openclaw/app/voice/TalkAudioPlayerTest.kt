package ai.openclaw.app.voice

import android.media.MediaPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowMediaPlayer
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class TalkAudioPlayerTest {
  private val context = RuntimeEnvironment.getApplication()

  @Before
  fun setUpPlayback() {
    Dispatchers.setMain(Dispatchers.Unconfined)
    ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(60_000, 0) }
  }

  @After
  fun cleanUpPlayback() {
    speechFiles().forEach(File::delete)
    ShadowMediaPlayer.resetStaticState()
    Dispatchers.resetMain()
  }

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

  @Test
  fun cancelledCompressedPlaybackReleasesMediaPlayer() {
    val outcome = cancelCompressedPlayback()

    assertEquals(ShadowMediaPlayer.State.END, outcome.playerState)
  }

  @Test
  fun cancelledCompressedPlaybackDeletesPrivateSpeechFile() {
    val outcome = cancelCompressedPlayback()

    assertEquals(emptyList<String>(), outcome.remainingSpeechFiles)
  }

  @Test
  fun compressedPlaybackSetupFailureReleasesAllocatedMediaPlayer() =
    runBlocking {
      val createdPlayer = AtomicReference<MediaPlayer>()
      val createdShadow = AtomicReference<ShadowMediaPlayer>()
      ShadowMediaPlayer.setCreateListener { player, shadow ->
        createdPlayer.set(player)
        createdShadow.set(shadow)
      }
      ShadowMediaPlayer.setMediaInfoProvider { throw IllegalStateException("synthetic media initialization failed") }

      try {
        val failure = runCatching { TalkAudioPlayer(context).play(syntheticAudio()) }.exceptionOrNull()

        assertEquals("synthetic media initialization failed", failure?.message)
        assertEquals(ShadowMediaPlayer.State.END, checkNotNull(createdShadow.get()).state)
        assertEquals(emptyList<String>(), speechFiles().map(File::getName))
      } finally {
        runCatching { createdPlayer.get()?.release() }
        speechFiles().forEach(File::delete)
      }
    }

  @Test
  fun cancellationBeforeCreatedFileReturnsDeletesPrivateSpeechFile() =
    runBlocking {
      val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
      val blockerScope = CoroutineScope(dispatcher)
      val callerBlocked = CountDownLatch(1)
      val releaseCaller = CountDownLatch(1)
      val player = TalkAudioPlayer(context)
      val playback =
        launch(dispatcher) {
          blockerScope.launch {
            callerBlocked.countDown()
            releaseCaller.await()
          }
          player.play(syntheticAudio())
        }

      try {
        withTimeout(5_000) {
          while (callerBlocked.count > 0 || speechFiles().isEmpty()) {
            delay(10)
          }
        }
        assertEquals(1, speechFiles().size)

        playback.cancel()
        releaseCaller.countDown()
        playback.join()

        assertEquals(emptyList<String>(), speechFiles().map(File::getName))
      } finally {
        releaseCaller.countDown()
        playback.cancelAndJoin()
        blockerScope.cancel()
        dispatcher.close()
        speechFiles().forEach(File::delete)
      }
    }

  private fun cancelCompressedPlayback(): CancelledPlaybackOutcome =
    runBlocking {
      val createdPlayer = AtomicReference<MediaPlayer>()
      val createdShadow = AtomicReference<ShadowMediaPlayer>()
      ShadowMediaPlayer.setCreateListener { player, shadow ->
        createdPlayer.set(player)
        createdShadow.set(shadow)
      }
      val player = TalkAudioPlayer(context)
      val playback = launch(Dispatchers.Default) { player.play(syntheticAudio()) }

      try {
        withTimeout(5_000) {
          while (createdShadow.get()?.state != ShadowMediaPlayer.State.STARTED) {
            delay(10)
          }
        }
        val activeFiles = speechFiles()
        assertEquals(1, activeFiles.size)

        playback.cancelAndJoin()

        CancelledPlaybackOutcome(
          playerState = checkNotNull(createdShadow.get()).state,
          remainingSpeechFiles = speechFiles().map(File::getName),
        )
      } finally {
        playback.cancelAndJoin()
        runCatching { createdPlayer.get()?.release() }
        speechFiles().forEach(File::delete)
      }
    }

  private fun speechFiles(): List<File> {
    val files = context.cacheDir.listFiles().orEmpty()
    return files.filter { it.name.startsWith("talk-audio-") }
  }

  private fun syntheticAudio(): TalkSpeakAudio =
    TalkSpeakAudio(
      bytes = byteArrayOf(1, 2, 3),
      provider = "test",
      outputFormat = null,
      voiceCompatible = null,
      mimeType = "audio/mpeg",
      fileExtension = null,
    )

  private data class CancelledPlaybackOutcome(
    val playerState: ShadowMediaPlayer.State,
    val remainingSpeechFiles: List<String>,
  )
}
