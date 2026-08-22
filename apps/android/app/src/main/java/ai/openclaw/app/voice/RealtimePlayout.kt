package ai.openclaw.app.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.CompletableDeferred

/**
 * Work handed to the single realtime playout owner.
 *
 * The Gateway message pump only ever `trySend`s one of these. It never touches the output
 * device, the pending-barrier map, or any lock the owner holds, so an inbound Gateway frame
 * can never end up waiting on hardware backpressure.
 *
 * [Audio] and [Mark] carry the playback epoch that was current when the Gateway event
 * arrived. [Clear] and [Stop] invalidate that epoch on the requesting thread before they are
 * queued, so audio belonging to a cancelled response is discarded by the owner instead of
 * reaching the speaker after the fact.
 */
internal sealed interface RealtimePlaybackCommand {
  /** Assistant audio produced under [epoch]. */
  data class Audio(
    val epoch: Long,
    val bytes: ByteArray,
  ) : RealtimePlaybackCommand

  /** A provider playback barrier registered under [epoch]. */
  data class Mark(
    val epoch: Long,
    val sessionId: String,
    val name: String,
  ) : RealtimePlaybackCommand

  /**
   * Barge-in or provider clear: retire the device and release every pending barrier.
   *
   * [turnId] is the provider output turn this clear belongs to. It is carried rather than read
   * from shared state because the waiter must be completed with the identity the clear arrived
   * with -- `cancelOutput` checks it against the turn it asked to cancel, and a later turn
   * overwriting the field mid-flight would otherwise complete the waiter with the wrong identity.
   */
  data class Clear(
    val turnId: String?,
    val completion: CompletableDeferred<String?>?,
  ) : RealtimePlaybackCommand

  /**
   * Playback teardown. [terminal] is true only for relay teardown, which drops pending barriers
   * unacknowledged because there is no provider left to release; every other stop answers them,
   * because retiring the device invalidates the frame counter their targets were measured
   * against and a carried-over barrier could never complete.
   */
  data class Stop(
    val terminal: Boolean,
  ) : RealtimePlaybackCommand

  /** Re-evaluate barrier completion and playback idleness without new audio. */
  data object PollIdle : RealtimePlaybackCommand
}

/**
 * One opened realtime output device, owned end to end by the playout owner.
 *
 * [write] must not block. The owner answers Clear and Stop on the same coroutine, so a
 * blocking data-transfer call here would delay barge-in by however long the hardware buffer
 * takes to drain.
 */
internal interface RealtimeAudioSink : AutoCloseable {
  /** How much audio the hardware buffer holds. The owner derives its retry budget from it. */
  val bufferDurationMs: Long

  /**
   * Frames the device reports as presented. Monotonic while the sink is open -- the owner never
   * flushes except through [close] -- and, like the platform counter it comes from, wraps at
   * 2^32 frames (roughly 49 hours at the realtime rate).
   */
  val presentedFrames: Long

  /** Starts presentation. A full buffer only drains once this has been called. */
  fun play()

  /**
   * Accepts at most [length] bytes starting at [offset] without blocking. Returns the
   * accepted byte count, which may be 0 while the buffer is full, or a negative device
   * error code.
   */
  fun write(
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int

  /** Silences and releases the device. Called by the owner only. */
  override fun close()
}

/**
 * Attributes for realtime assistant playback.
 *
 * Communication usage rather than media: this is the far end of a two-way conversation, and it is
 * the usage the platform's own voice pipeline -- including the echo canceller attached to the
 * matching communication capture path -- is built around. Media usage would place the same audio
 * on a stream that pipeline does not treat as the call's downlink.
 */
internal fun realtimeCommunicationPlaybackAttributes(): AudioAttributes =
  AudioAttributes
    .Builder()
    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

/** Opens the realtime output device. Production always uses [AudioTrackBacked]. */
internal fun interface RealtimeAudioSinkFactory {
  fun open(
    sampleRateHz: Int,
    playbackBufferMs: Int,
    firstWriteBytes: Int,
  ): RealtimeAudioSink

  companion object {
    val AudioTrackBacked =
      RealtimeAudioSinkFactory { sampleRateHz, playbackBufferMs, firstWriteBytes ->
        val minBuffer =
          AudioTrack.getMinBufferSize(
            sampleRateHz,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
          )
        val bufferSizeBytes =
          maxOf(
            minBuffer * 2,
            sampleRateHz * 2 * playbackBufferMs / 1000,
            firstWriteBytes * 4,
          )
        val track =
          AudioTrack
            .Builder()
            .setAudioAttributes(realtimeCommunicationPlaybackAttributes())
            .setAudioFormat(
              AudioFormat
                .Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRateHz)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
            ).setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(bufferSizeBytes)
            .build()
        AudioTrackRealtimeAudioSink(
          track = track,
          bufferDurationMs = bufferSizeBytes.toLong() / 2L * 1000L / sampleRateHz.toLong(),
        )
      }
  }
}

private class AudioTrackRealtimeAudioSink(
  private val track: AudioTrack,
  override val bufferDurationMs: Long,
) : RealtimeAudioSink {
  override val presentedFrames: Long
    // playbackHeadPosition is an unsigned frame counter exposed as a signed Int.
    get() = track.playbackHeadPosition.toLong() and 0xffff_ffffL

  override fun play() {
    if (track.playState != AudioTrack.PLAYSTATE_PLAYING) {
      track.play()
    }
  }

  override fun write(
    bytes: ByteArray,
    offset: Int,
    length: Int,
  ): Int = track.write(bytes, offset, length, AudioTrack.WRITE_NON_BLOCKING)

  override fun close() {
    runCatching { track.pause() }
    runCatching { track.flush() }
    runCatching { track.stop() }
    runCatching { track.release() }
  }
}

/**
 * How long to wait before retrying a write the device refused.
 *
 * A non-blocking write can only be refused while the hardware buffer is full, so the retry
 * cadence is a fraction of that buffer's own duration: short enough that the device is never
 * left starved, long enough that retrying is not a busy loop.
 */
internal fun realtimePlaybackWriteRetryDelayMs(bufferDurationMs: Long): Long = (bufferDurationMs / 16L).coerceIn(2L, 10L)

/**
 * How long the device may keep refusing a write before playback is treated as failed.
 *
 * Expressed in the same buffer duration: a buffer that has not made room in several
 * buffer-lengths is not draining at all, rather than merely running behind, and retrying
 * past that point would hold the owner — and therefore Clear and Stop — indefinitely.
 */
internal fun realtimePlaybackWriteStallBudgetMs(bufferDurationMs: Long): Long = (bufferDurationMs * 4L).coerceAtLeast(400L)
