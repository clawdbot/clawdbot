package ai.openclaw.app.voice

import android.media.AudioFormat
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.os.SystemClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.coroutines.coroutineContext

/** The only owner of the realtime AudioTrack. Gateway callbacks enqueue; they never touch it. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class RealtimePlayout(
  scope: CoroutineScope,
  dispatcher: CoroutineDispatcher,
  private val sampleRate: Int,
) {
  class Session(
    val onState: (Boolean, Float?, Any?) -> Unit,
    val onMark: (String) -> Unit,
    val onFailure: (String) -> Unit,
  ) {
    @Volatile var active = true
      internal set

    @Volatile internal var epoch = 0L
  }

  private sealed interface Command {
    data class Audio(
      val session: Session,
      val epoch: Long,
      val bytes: ByteArray,
      val statusOwner: Any?,
    ) : Command

    data class Mark(
      val session: Session,
      val epoch: Long,
      val name: String,
    ) : Command

    data class RefreshState(
      val session: Session,
      val statusOwner: Any?,
    ) : Command

    data class Clear(
      val session: Session,
      val acknowledge: Boolean,
      val completion: CompletableDeferred<Unit>,
    ) : Command
  }

  private data class Mark(
    val name: String,
    val frame: Long,
  )

  // Epoch changes and admission share one lock: new audio can never overtake its clear.
  private val mailboxLock = Any()
  private var queuedBytes = 0L
  private var queuedMedia = 0
  private val commands =
    Channel<Command>(4_096 + 32, onUndeliveredElement = {
      if (it is Command.Clear) it.completion.cancel()
    })
  private var track: AudioTrack? = null
  private var owner: Session? = null
  private var statusOwner: Any? = null
  private var writtenFrames = 0L
  private val timestamp = AudioTimestamp()
  private var approximateEndMs = 0L
  private var timestampOriginNs = 0L
  private var lastHeadPosition = 0L
  private var stalledMs = 0L
  private val marks = mutableListOf<Mark>()
  private var level = 0f

  @Volatile var isPlaying = false
    private set

  init {
    scope
      .launch(dispatcher) {
        try {
          while (true) {
            coroutineContext.ensureActive()
            val command =
              select<Command?> {
                commands.onReceive { it }
                if (isPlaying) onTimeout(20) { null }
              }
            if (command == null) {
              poll(periodic = true)
              continue
            }
            if (command !is Command.Clear) {
              synchronized(mailboxLock) {
                if (command is Command.Audio) queuedBytes -= command.bytes.size
                queuedMedia--
              }
            }
            when (command) {
              is Command.Audio -> {
                if (!command.session.active || command.epoch != command.session.epoch) continue
                try {
                  write(command)
                } catch (error: CancellationException) {
                  coroutineContext.ensureActive()
                  fail(command.session, "audio playback stalled")
                } catch (error: RuntimeException) {
                  fail(command.session, error.message ?: "audio playback failed")
                }
              }

              is Command.Mark -> {
                if (!command.session.active) continue
                if (owner === command.session) {
                  marks += Mark(command.name, writtenFrames)
                  // An interrupted mark acknowledges only after the queued clear has flushed audio.
                  if (command.epoch == command.session.epoch) poll()
                } else {
                  command.session.onMark(command.name)
                }
              }

              is Command.RefreshState -> {
                if (command.session.active) {
                  if (owner === command.session) {
                    statusOwner = command.statusOwner
                    poll()
                    if (isPlaying) command.session.onState(true, level, command.statusOwner)
                  } else {
                    command.session.onState(false, null, command.statusOwner)
                  }
                }
              }

              is Command.Clear -> {
                try {
                  if (owner === command.session) retire(command.acknowledge)
                  command.completion.complete(Unit)
                } catch (error: RuntimeException) {
                  command.completion.completeExceptionally(error)
                }
              }
            }
          }
        } finally {
          retire(acknowledge = false)
        }
      }.invokeOnCompletion {
        // Also runs when cancellation wins before the actor body starts.
        val pending = mutableListOf<CompletableDeferred<Unit>>()
        synchronized(mailboxLock) {
          commands.close()
          while (true) {
            val command = commands.tryReceive().getOrNull() ?: break
            if (command is Command.Clear) pending += command.completion
          }
        }
        pending.forEach { it.cancel() }
      }
  }

  fun audio(
    session: Session,
    bytes: ByteArray,
    statusOwner: Any,
  ): (() -> Unit)? = if (bytes.isNotEmpty()) offer(session, bytes.size) { Command.Audio(session, session.epoch, bytes, statusOwner) } else null

  fun mark(
    session: Session,
    name: String,
  ) = offer(session, 0) { Command.Mark(session, session.epoch, name) }

  fun refreshState(
    session: Session,
    statusOwner: Any,
  ) = offer(session, 0) { Command.RefreshState(session, statusOwner) }

  private fun offer(
    session: Session,
    bytes: Int,
    command: () -> Command,
  ): (() -> Unit)? {
    val overflow =
      synchronized(mailboxLock) {
        if (!session.active) return null
        if (queuedMedia >= 4_096 || queuedBytes + bytes > 12L * 1024 * 1024 || !commands.trySend(command()).isSuccess) {
          true
        } else {
          queuedMedia++
          queuedBytes += bytes
          false
        }
      }
    if (overflow) {
      clear(session, acknowledge = false)
      // Admission may hold the caller's lifecycle lock; outward failure notification may not.
      return { session.onFailure("audio playback queue overflow") }
    }
    return null
  }

  fun clear(
    session: Session,
    acknowledge: Boolean = true,
  ): CompletableDeferred<Unit> =
    synchronized(mailboxLock) {
      session.epoch++
      if (!acknowledge) session.active = false
      CompletableDeferred<Unit>().also { completion ->
        if (!commands.trySend(Command.Clear(session, acknowledge, completion)).isSuccess) completion.cancel()
      }
    }

  private suspend fun write(command: Command.Audio) {
    if (owner !== command.session) {
      retire(acknowledge = false)
      owner = command.session
    }
    statusOwner = command.statusOwner
    val bytes = command.bytes
    val output =
      track ?: AudioTrack
        .Builder()
        .setAudioAttributes(RealtimeCommunicationAudio.playbackAttributes())
        .setAudioFormat(
          AudioFormat
            .Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        ).setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(
          maxOf(
            AudioTrack.getMinBufferSize(
              sampleRate,
              AudioFormat.CHANNEL_OUT_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
            ),
            sampleRate * 2 * 240 / 1000,
          ),
        ).build()
        .also {
          track = it
          // Streaming defaults to a full buffer; a short final reply might never start.
          it.setStartThresholdInFrames(1)
        }
    // A timestamp from before an empty buffer cannot predict newly submitted audio after an idle gap.
    if (output.playbackHeadPosition.toLong().and(0xffff_ffffL) >= writtenFrames) timestampOriginNs = System.nanoTime()
    isPlaying = true
    command.session.onState(true, level, statusOwner)
    if (output.playState != AudioTrack.PLAYSTATE_PLAYING) output.play()
    val bufferMs = output.bufferSizeInFrames.toLong() * 1000 / sampleRate
    withTimeout((bufferMs * 4).coerceAtLeast(400) + bytes.size.toLong() * 1000 / (sampleRate * 2)) {
      var offset = 0
      while (offset < bytes.size && command.session.active && command.epoch == command.session.epoch) {
        val accepted = output.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_NON_BLOCKING)
        check(accepted >= 0) { "audio playback device error $accepted" }
        if (accepted == 0) {
          delay((bufferMs / 16).coerceIn(2, 10))
        } else {
          offset += accepted
          writtenFrames += accepted / 2
          // Account at acceptance: paced writes have already played part of a large chunk.
          approximateEndMs = maxOf(SystemClock.elapsedRealtime(), approximateEndMs) + accepted.toLong() * 1000 / (sampleRate * 2)
          yield()
        }
      }
    }
    if (!command.session.active || command.epoch != command.session.epoch) return
    level = TalkAudioLevel.smoothed(level, TalkAudioLevel.pcm16Level(bytes, bytes.size))
    command.session.onState(true, level, statusOwner)
  }

  private fun poll(periodic: Boolean = false) {
    val session = owner ?: return
    val output = track ?: return
    val headPosition = output.playbackHeadPosition.toLong().and(0xffff_ffffL)
    // Android timestamps are clock anchors, not completion counters; a drained server anchor can stop advancing.
    // False queries leave the object unchanged, so retain a known future commitment across temporary loss.
    val available = output.getTimestamp(timestamp)
    val nowNs = System.nanoTime()
    val hasTimestamp = (available || timestamp.nanoTime > nowNs) && timestamp.nanoTime >= timestampOriginNs
    val futureNs = if (hasTimestamp) (timestamp.nanoTime - nowNs).coerceAtLeast(0) else 0
    if (futureNs > 0) {
      val remainingNs = futureNs + (writtenFrames - timestamp.framePosition).coerceAtLeast(0) * 1_000_000_000 / sampleRate
      approximateEndMs = maxOf(approximateEndMs, SystemClock.elapsedRealtime() + (remainingNs + 999_999) / 1_000_000)
    }
    val remainingMs = (approximateEndMs - SystemClock.elapsedRealtime()).coerceAtLeast(0)
    val presented =
      if (hasTimestamp) {
        timestamp.framePosition + Math.floorDiv((nowNs - timestamp.nanoTime) * sampleRate, 1_000_000_000)
      } else {
        // Android recommends the approximate head when timestamps are unavailable; retain the PCM-duration floor.
        writtenFrames - (remainingMs * sampleRate + 999) / 1000
      }.coerceIn(0, minOf(headPosition, writtenFrames))
    val waitingForPresentation = if (hasTimestamp) futureNs > 0 else remainingMs > 0
    val ready = marks.filter { it.frame <= presented }
    marks.removeAll(ready.toSet())
    if (session.active) ready.forEach { session.onMark(it.name) }
    stalledMs = if (headPosition > lastHeadPosition || waitingForPresentation) 0 else stalledMs + if (periodic) 20 else 0
    lastHeadPosition = headPosition
    if (presented >= writtenFrames && !waitingForPresentation) {
      stalledMs = 0
      isPlaying = false
      session.onState(false, null, statusOwner)
    } else if (stalledMs >= (output.bufferSizeInFrames.toLong() * 4_000 / sampleRate).coerceAtLeast(400)) {
      fail(session, "audio playback stalled")
    }
  }

  private fun fail(
    session: Session,
    message: String,
  ) {
    clear(session, acknowledge = false)
    try {
      if (owner === session) retire(acknowledge = false)
    } finally {
      session.onFailure(message)
    }
  }

  private fun retire(acknowledge: Boolean) {
    val session = owner
    try {
      track?.let { output ->
        runCatching { output.pause() }
        runCatching { output.flush() }
        runCatching { output.stop() }
        output.release()
      }
    } finally {
      track = null
      owner = null
      writtenFrames = 0
      approximateEndMs = 0
      timestamp.nanoTime = 0
      lastHeadPosition = 0
      stalledMs = 0
      isPlaying = false
      level = 0f
      session?.onState(false, null, statusOwner)
      statusOwner = null
      val discarded = marks.toList()
      marks.clear()
      if (acknowledge && session?.active == true) discarded.forEach { session.onMark(it.name) }
    }
  }
}
