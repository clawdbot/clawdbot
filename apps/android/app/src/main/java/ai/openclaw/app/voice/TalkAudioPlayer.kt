package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

internal interface TalkAudioPlaying {
  suspend fun play(audio: TalkSpeakAudio)

  fun stop()
}

internal class TalkAudioPlayer(
  private val context: Context,
) : TalkAudioPlaying {
  private val lock = Any()
  private var active: ActivePlayback? = null

  override suspend fun play(audio: TalkSpeakAudio) {
    when (val mode = resolvePlaybackMode(audio)) {
      is TalkPlaybackMode.Pcm -> playPcm(audio.bytes, mode.sampleRate)
      is TalkPlaybackMode.Compressed -> playCompressed(audio.bytes, mode.fileExtension)
    }
  }

  override fun stop() {
    synchronized(lock) {
      active?.cancel()
      active = null
    }
  }

  internal fun resolvePlaybackMode(audio: TalkSpeakAudio): TalkPlaybackMode =
    resolvePlaybackMode(
      outputFormat = audio.outputFormat,
      mimeType = audio.mimeType,
      fileExtension = audio.fileExtension,
    )

  companion object {
    internal fun resolvePlaybackMode(
      outputFormat: String?,
      mimeType: String?,
      fileExtension: String?,
    ): TalkPlaybackMode {
      val normalizedOutputFormat = outputFormat?.trim()?.lowercase()
      if (normalizedOutputFormat != null) {
        val pcmSampleRate = parsePcmSampleRate(normalizedOutputFormat)
        if (pcmSampleRate != null) {
          return TalkPlaybackMode.Pcm(sampleRate = pcmSampleRate)
        }
      }
      val normalizedMimeType = mimeType?.trim()?.lowercase()
      val extension =
        normalizeExtension(
          fileExtension ?: inferExtension(outputFormat = normalizedOutputFormat, mimeType = normalizedMimeType),
        )
      if (extension != null) {
        return TalkPlaybackMode.Compressed(fileExtension = extension)
      }
      throw IllegalStateException("Unsupported talk audio format")
    }

    private fun parsePcmSampleRate(outputFormat: String): Int? =
      when (outputFormat) {
        "pcm_16000" -> 16_000
        "pcm_22050" -> 22_050
        "pcm_24000" -> 24_000
        "pcm_44100" -> 44_100
        else -> null
      }

    private fun inferExtension(
      outputFormat: String?,
      mimeType: String?,
    ): String? =
      when {
        outputFormat == "mp3" || outputFormat?.startsWith("mp3_") == true || mimeType == "audio/mpeg" -> ".mp3"
        outputFormat == "opus" || outputFormat?.startsWith("opus_") == true || mimeType == "audio/ogg" -> ".ogg"
        outputFormat?.endsWith("-wav") == true || mimeType == "audio/wav" -> ".wav"
        outputFormat?.endsWith("-webm") == true || mimeType == "audio/webm" -> ".webm"
        else -> null
      }

    private fun normalizeExtension(value: String?): String? {
      val trimmed = value?.trim()?.lowercase().orEmpty()
      if (trimmed.isEmpty()) return null
      return if (trimmed.startsWith(".")) trimmed else ".$trimmed"
    }
  }

  private suspend fun playPcm(
    bytes: ByteArray,
    sampleRate: Int,
  ) {
    withContext(Dispatchers.IO) {
      val minBufferSize =
        AudioTrack.getMinBufferSize(
          sampleRate,
          AudioFormat.CHANNEL_OUT_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
      if (minBufferSize <= 0) {
        throw IllegalStateException("AudioTrack buffer unavailable")
      }
      val track =
        AudioTrack
          .Builder()
          .setAudioAttributes(
            AudioAttributes
              .Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build(),
          ).setAudioFormat(
            AudioFormat
              .Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(sampleRate)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build(),
          ).setTransferMode(AudioTrack.MODE_STATIC)
          .setBufferSizeInBytes(maxOf(minBufferSize, bytes.size))
          .build()
      val finished = CompletableDeferred<Unit>()
      val playback =
        ActivePlayback(
          cancel = {
            finished.completeExceptionally(CancellationException("assistant speech cancelled"))
            runCatching { track.pause() }
            runCatching { track.flush() }
            runCatching { track.stop() }
          },
        )
      register(playback)
      try {
        val written = track.write(bytes, 0, bytes.size)
        if (written != bytes.size) {
          throw IllegalStateException("AudioTrack write failed")
        }
        val totalFrames = bytes.size / 2
        track.play()
        while (track.playState == AudioTrack.PLAYSTATE_PLAYING) {
          if (track.playbackHeadPosition >= totalFrames) {
            finished.complete(Unit)
            break
          }
          delay(20)
        }
        if (!finished.isCompleted) {
          finished.complete(Unit)
        }
        finished.await()
      } finally {
        clear(playback)
        runCatching { track.pause() }
        runCatching { track.flush() }
        runCatching { track.stop() }
        track.release()
      }
    }
  }

  private suspend fun playCompressed(
    bytes: ByteArray,
    fileExtension: String,
  ) {
    val tempFile =
      withContext(Dispatchers.IO) {
        File.createTempFile("talk-audio-", fileExtension, context.cacheDir).apply {
          writeBytes(bytes)
        }
      }
    try {
      val finished = CompletableDeferred<Unit>()
      val player =
        withContext(Dispatchers.Main) {
          MediaPlayer().apply {
            setAudioAttributes(
              AudioAttributes
                .Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            )
            setDataSource(tempFile.absolutePath)
            setOnCompletionListener {
              finished.complete(Unit)
            }
            setOnErrorListener { _, what, extra ->
              finished.completeExceptionally(IllegalStateException("MediaPlayer error ($what/$extra)"))
              true
            }
            prepare()
          }
        }
      val playback =
        ActivePlayback(
          cancel = {
            finished.completeExceptionally(CancellationException("assistant speech cancelled"))
            runCatching { player.stop() }
          },
        )
      register(playback)
      try {
        withContext(Dispatchers.Main) {
          player.start()
        }
        finished.await()
      } finally {
        clear(playback)
        withContext(Dispatchers.Main) {
          runCatching { player.stop() }
          player.release()
        }
      }
    } finally {
      withContext(Dispatchers.IO) {
        tempFile.delete()
      }
    }
  }

  private fun register(playback: ActivePlayback) {
    synchronized(lock) {
      active?.cancel()
      active = playback
    }
  }

  private fun clear(playback: ActivePlayback) {
    synchronized(lock) {
      if (active === playback) {
        active = null
      }
    }
  }
}

internal sealed interface TalkPlaybackMode {
  data class Pcm(
    val sampleRate: Int,
  ) : TalkPlaybackMode

  data class Compressed(
    val fileExtension: String,
  ) : TalkPlaybackMode
}

private class ActivePlayback(
  val cancel: () -> Unit,
)
