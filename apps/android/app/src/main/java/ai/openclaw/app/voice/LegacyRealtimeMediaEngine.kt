package ai.openclaw.app.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * The safe half-duplex fallback.
 *
 * This is the shape Android Talk shipped before the native engine: an
 * `AudioRecord` at the wire rate, an `AudioTrack` at the wire rate, and the
 * microphone closed while the assistant is audible. It exists so a device that
 * cannot open the low-latency streams — or cannot load the native library at
 * all — still holds a conversation instead of failing.
 *
 * It never claims concurrent capture. Falling back means half duplex, not
 * full duplex with the echo control quietly removed.
 */
internal class LegacyRealtimeMediaEngine(
  private val context: Context,
  private val preferredAudioInputDevice: () -> String?,
  private val onAppliedAudioInputChanged: (String?) -> Unit,
  private val onInputLevel: (Float) -> Unit,
  private val onOutputLevel: (Float?) -> Unit,
) : RealtimeMediaEngine {
  private val running = AtomicBoolean(false)
  private val renderGeneration = AtomicLong(1)
  private val cancelThroughGeneration = AtomicLong(0)

  // Unbounded on purpose, and not a realtime PCM path: an outcome that cannot
  // be enqueued is a Gateway barrier that never resolves. Its size is bounded
  // in practice by the render queue, since every outcome corresponds to a mark
  // that fit in it.
  private val markEvents = ConcurrentLinkedQueue<RealtimeMarkEvent>()
  private val telemetryEvents = ArrayBlockingQueue<RealtimeMediaEvent>(128)
  private val telemetrySequence = AtomicLong(0)
  private val uplinkQueue = ArrayBlockingQueue<UplinkFrame>(UPLINK_QUEUE_FRAMES)
  private val renderQueue = ArrayBlockingQueue<RenderItem>(RENDER_QUEUE_ITEMS)
  private val pendingMarks = AtomicReference<List<PendingMark>>(emptyList())
  private val presentingUntilMs = AtomicLong(0)
  private val droppedUplinkFrames = AtomicLong(0)
  private val rejectedRenderSubmissions = AtomicLong(0)
  private val flushRequested = AtomicBoolean(false)

  // Set when a drain discards queued capture because the send gate closed. The
  // producer consumes it so the next frame is reported as following a gap; a
  // queue emptied by an ordinary send leaves it alone.
  private val uplinkGapPending = AtomicBoolean(false)
  private val renderWorkerStalled = AtomicBoolean(false)
  private val activeTrack = AtomicReference<AudioTrack?>(null)
  private val activeInputSession = AtomicReference<AndroidAudioInputSession?>(null)
  private val renderLevel = AtomicLong(0)
  private val captureLevel = AtomicLong(0)

  @Volatile private var config: RealtimeMediaConfig? = null

  @Volatile private var captureThread: Thread? = null

  @Volatile private var renderThread: Thread? = null

  @Volatile private var route: RealtimeRouteProfile = RealtimeRouteProfile.Unknown

  private data class RenderItem(
    val generation: Long,
    val pcm: ByteArray?,
    val markId: Long?,
  )

  // Carries whether the frame follows the previous one with no gap. A payload
  // never spans a hole, so a dropped interval cannot reach the provider as
  // continuous speech.
  private data class UplinkFrame(
    val pcm: ByteArray,
    val contiguousWithPrevious: Boolean,
  )

  private data class PendingMark(
    val markId: Long,
    val generation: Long,
    val targetFrame: Long,
  )

  override val supportsConcurrentCapture: Boolean = false

  override fun start(config: RealtimeMediaConfig): Boolean {
    // A worker from a previous instance that outlived its join still owns the
    // `AudioRecord`/`AudioTrack`. Opening a second pair against the same device
    // gives a microphone that fails to open or two overlapping playbacks, so
    // this refuses and lets the owner report a media failure instead.
    if (deviceWorkers.get() > 0) {
      Log.w(tag, "fallback start refused: a previous worker still owns the device")
      return false
    }
    if (!running.compareAndSet(false, true)) return false
    this.config = config
    route = config.route
    record(RealtimeMediaEventKind.EngineStarted, config.route.ordinal.toLong(), 0)
    record(RealtimeMediaEventKind.FallbackEngaged, 0, 0)
    deviceWorkers.addAndGet(2)
    captureThread = Thread({ runCapture(config) }, "openclaw-talk-capture").apply { start() }
    renderThread = Thread({ runRender(config) }, "openclaw-talk-render").apply { start() }
    return true
  }

  override fun stop() {
    // Not gated on `running`: the render worker clears it itself when its track
    // dies, and returning here would leave the recorder open, the workers
    // unjoined and the device ownership count raised — so every later start
    // would be refused. Idempotent instead: with nothing left to release the
    // body is a sequence of no-ops.
    val wasRunning = running.getAndSet(false)
    renderQueue.clear()
    val capture = captureThread
    val render = renderThread
    captureThread = null
    renderThread = null
    capture?.interrupt()
    render?.interrupt()
    // Interrupting a Java thread does not return it from a blocking
    // `AudioTrack.write`. Pausing the track does, which is what makes the join
    // below mean something.
    activeTrack.get()?.let { track -> runCatching { track.pause() } }
    // The same for capture: interrupting does not return a thread from
    // `AudioRecord.read`, and a reader still inside one owns the microphone
    // after this call returns — so a push-to-talk recorder or a restart would
    // open a second one against a device the first has not let go of. The
    // reading thread still owns the release; this only makes its read return.
    activeInputSession.get()?.let { session -> runCatching { session.stopRecording() } }
    // Joined before the barriers are drained. A render worker that is between
    // dequeuing a barrier and recording it would otherwise add it back after
    // the drain, with no worker left to resolve it — a silently stranded
    // Gateway barrier during teardown.
    runCatching { capture?.join(WORKER_JOIN_TIMEOUT_MS) }
    runCatching { render?.join(WORKER_JOIN_TIMEOUT_MS) }
    if (capture?.isAlive == true) {
      // Reported rather than absorbed: the next recorder opens against a
      // microphone this one still holds, and `AudioRecord` failing to open is
      // the symptom the owner would otherwise have to explain from nothing.
      Log.w(tag, "fallback capture worker did not stop; the microphone is still held")
      record(RealtimeMediaEventKind.StreamError, 0, 1)
    }
    if (render?.isAlive == true) {
      // The render worker still owns the track and could still play through it.
      // Presentation stays asserted so the half-duplex guarantee holds for a
      // push-to-talk capture or a restart that follows.
      Log.w(tag, "fallback render worker did not stop; keeping capture closed")
      renderWorkerStalled.set(true)
      record(RealtimeMediaEventKind.StreamError, 0, 0)
    }
    // Barriers still in flight resolve rather than strand: an unresolved
    // barrier reads to the Gateway exactly like a turn that never finished.
    invalidatePendingMarks(RealtimeMarkOutcome.InvalidatedByStop)
    if (wasRunning) record(RealtimeMediaEventKind.EngineStopped, 0, 0)
    onInputLevel(0f)
    onOutputLevel(null)
  }

  override fun release() = stop()

  override val appliesInputDeviceSelection: Boolean = false

  override fun setRoute(
    route: RealtimeRouteProfile,
    inputPreset: RealtimeInputPreset,
    preferredInputDeviceId: Int,
  ): Boolean {
    // The fallback is half duplex on every route, so a route change does not
    // change what it does; the preset it opened with is the platform's own
    // communication preset either way. `AndroidAudioInputSession` owns the
    // microphone choice on this path and re-resolves the operator's preference
    // when it opens, so the id is not this object's to apply.
    if (this.route == route) return true
    record(RealtimeMediaEventKind.RouteChanged, this.route.ordinal.toLong(), route.ordinal.toLong())
    this.route = route
    return true
  }

  override fun beginRenderGeneration(): Long = renderGeneration.incrementAndGet()

  override fun submitAssistantAudio(
    generation: Long,
    pcm: ByteArray,
  ): Boolean {
    if (!running.get()) return false
    val accepted = renderQueue.offer(RenderItem(generation, pcm, null))
    if (!accepted) {
      rejectedRenderSubmissions.incrementAndGet()
      record(RealtimeMediaEventKind.RenderQueueOverflow, generation, pcm.size.toLong())
    }
    return accepted
  }

  override fun clearRender() {
    val cancelled = renderGeneration.get()
    cancelThroughGeneration.set(cancelled)
    // Drains the queue itself, so barriers still waiting to be picked up by the
    // render worker get an outcome instead of disappearing with the queue.
    invalidatePendingMarks(RealtimeMarkOutcome.Cancelled)
    // PCM the track has already accepted keeps playing until the track is
    // flushed. Without this the snapshot would report nothing presenting while
    // the speaker was still audible, and capture would reopen into it.
    // The flush happens on the render worker, which can be inside a blocking
    // `AudioTrack.write` right now. Presentation stays asserted until that
    // worker reports the track actually flushed, or capture would reopen into
    // assistant audio that is still coming out of the speaker.
    flushRequested.set(true)
    presentingUntilMs.set(0)
    val next = renderGeneration.incrementAndGet()
    record(RealtimeMediaEventKind.RenderCleared, cancelled, next)
  }

  override fun submitMark(markId: Long): Boolean {
    if (!running.get()) return false
    val accepted = renderQueue.offer(RenderItem(renderGeneration.get(), null, markId))
    if (!accepted) markEvents.offer(RealtimeMarkEvent(markId, RealtimeMarkOutcome.RejectedByOverflow))
    return accepted
  }

  override fun drainUplink(into: ByteArray): Int {
    // The send gate is checked again here, not only at capture. A frame that
    // was eligible when it was recorded is not eligible once the assistant
    // started speaking, and this path has no canceller to clean it — so what
    // is queued is dropped rather than sent, and the next frame starts a new
    // payload because the interval between them never reached the provider.
    if (flushRequested.get() || SystemClock.elapsedRealtime() < presentingUntilMs.get()) {
      if (uplinkQueue.isNotEmpty()) {
        uplinkQueue.clear()
        uplinkGapPending.set(true)
        droppedUplinkFrames.incrementAndGet()
        record(RealtimeMediaEventKind.CaptureEligibilityChanged, droppedUplinkFrames.get(), 0)
      }
      return 0
    }
    var written = 0
    while (true) {
      val head = uplinkQueue.peek() ?: break
      // A payload never spans a capture gap. Concatenating across one presents
      // the two sides of a dropped interval to the provider as one continuous
      // utterance, which is what the native path splits for as well.
      if (written > 0 && !head.contiguousWithPrevious) break
      if (written + head.pcm.size > into.size) break
      uplinkQueue.poll()
      head.pcm.copyInto(into, written)
      written += head.pcm.size
    }
    return written
  }

  override fun drainMarkEvents(): List<RealtimeMarkEvent> {
    if (markEvents.isEmpty()) return emptyList()
    val drained = ArrayList<RealtimeMarkEvent>()
    while (true) drained.add(markEvents.poll() ?: break)
    return drained
  }

  override fun drainTelemetry(): List<RealtimeMediaEvent> {
    if (telemetryEvents.isEmpty()) return emptyList()
    val drained = ArrayList<RealtimeMediaEvent>(telemetryEvents.size)
    telemetryEvents.drainTo(drained)
    return drained
  }

  override fun snapshot(): RealtimeMediaSnapshot {
    val current = config
    val presenting =
      renderWorkerStalled.get() || flushRequested.get() || SystemClock.elapsedRealtime() < presentingUntilMs.get()
    return RealtimeMediaSnapshot(
      readiness = if (running.get()) RealtimeMediaReadiness.FullDuplexReady else RealtimeMediaReadiness.Stopped,
      route = route,
      // The platform owns whatever echo control exists on this path; the
      // fallback never runs a software canceller.
      echoControlOwner = if (running.get()) RealtimeEchoControlOwner.PlatformVoiceCommunication else RealtimeEchoControlOwner.None,
      renderPresenting = presenting,
      captureEligibleNow = running.get() && !presenting,
      rates =
        RealtimeMediaRates(
          wireInputHz = current?.wireInputHz ?: 0,
          wireOutputHz = current?.wireOutputHz ?: 0,
          deviceInputHz = current?.wireInputHz ?: 0,
          deviceOutputHz = current?.wireOutputHz ?: 0,
          apmCaptureHz = 0,
          apmRenderHz = 0,
        ),
      deviceClockEpoch = if (running.get()) 1 else 0,
      renderContentGeneration = renderGeneration.get(),
      captureEligibilityGeneration = 1,
      acousticProcessorLifetime = 0,
      measuredStreamDelayMs = -1,
      render =
        RealtimeRenderStats(
          submittedSamples = 0,
          presentedSamples = 0,
          cancelledSamples = 0,
          overflowRejectedSamples = rejectedRenderSubmissions.get(),
          starvedSilenceSamples = 0,
          idleSilenceSamples = 0,
          markCompletions = 0,
          markInvalidations = 0,
          markEventOverflows = 0,
        ),
      capture =
        RealtimeCaptureStats(
          capturedFrames = 0,
          processedFrames = 0,
          eligibleFrames = 0,
          droppedIneligibleAtCapture = 0,
          droppedEligibilityChanged = 0,
          droppedSendGateClosed = 0,
          droppedQueueOverflow = droppedUplinkFrames.get(),
          sentFrames = 0,
        ),
      acoustic = RealtimeAcousticStats(false, 0, 0, 0, 0, 0, null, null, null),
      referenceRingDroppedSamples = 0,
      telemetryDroppedEvents = 0,
      device = RealtimeDeviceStreamStats(0, 0, 0, 0, running.get(), 0),
      renderLevel = renderLevel.get().takeIf { it > 0 }?.let { it / 1000f },
      captureLevel = captureLevel.get() / 1000f,
    )
  }

  @SuppressLint("MissingPermission")
  private fun runCapture(config: RealtimeMediaConfig) {
    val frameBytes = config.wireInputHz * 2 * CAPTURE_FRAME_MS / 1000
    var session: AndroidAudioInputSession? = null
    try {
      session =
        AndroidAudioInputSession.open(
          context,
          config.wireInputHz,
          frameBytes,
          preferredAudioInputDevice(),
          ::reportAppliedInput,
          setPreferredDevice = null,
          // Half duplex on every route, so the platform's own voice pipeline is
          // the only echo protection this path has. Opening with the
          // recognition source would turn that off while the engine reported
          // the communication preset as applied.
          audioSource = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        )
      activeInputSession.set(session)
      val buffer = ByteArray(frameBytes)
      session.startRecording()
      // The first frame of a session has nothing before it, and every frame
      // after a suppressed or dropped one starts a fresh payload.
      var contiguousWithPrevious = false
      while (running.get() && !Thread.currentThread().isInterrupted) {
        val read = session.read(buffer, 0, buffer.size)
        if (read <= 0) continue
        val level = TalkAudioLevel.pcm16Level(buffer, read)
        captureLevel.set((level * 1000).toLong())
        onInputLevel(level)
        // Half duplex: audio recorded while the assistant is audible never
        // leaves the endpoint, and it is dropped rather than held so a later
        // reopening cannot release it.
        if (flushRequested.get() || SystemClock.elapsedRealtime() < presentingUntilMs.get()) {
          // The frame after a suppressed stretch does not follow the last sent
          // one in time, so it starts a new payload.
          contiguousWithPrevious = false
          continue
        }
        val pcm = buffer.copyOf(read)
        // A drain that found the gate closed discarded what was queued, so the
        // frame after it does not follow the last one the provider received.
        // A queue emptied by an ordinary send is a different thing and does not
        // break continuity.
        if (uplinkGapPending.compareAndSet(true, false)) contiguousWithPrevious = false
        if (uplinkQueue.offer(UplinkFrame(pcm, contiguousWithPrevious))) {
          contiguousWithPrevious = true
          continue
        }
        uplinkQueue.poll()
        droppedUplinkFrames.incrementAndGet()
        // The dropped frame is a hole in the middle of the queue, so what is
        // still queued and what comes next are no longer one utterance.
        uplinkQueue.offer(UplinkFrame(pcm, contiguousWithPrevious = false))
        contiguousWithPrevious = true
        record(RealtimeMediaEventKind.UplinkQueueOverflow, droppedUplinkFrames.get(), 0)
      }
    } catch (err: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (err: RuntimeException) {
      Log.w(tag, "fallback capture failed: ${err.message ?: err::class.simpleName}")
      record(RealtimeMediaEventKind.StreamError, 0, 1)
    } finally {
      activeInputSession.compareAndSet(session, null)
      session?.close()
      onInputLevel(0f)
      // Released only once the recorder is actually closed, which is what makes
      // the ownership check in `start` mean something.
      deviceWorkers.decrementAndGet()
    }
  }

  /**
   * Reports the microphone this engine actually opened.
   *
   * Routing callbacks arrive asynchronously and a capture worker can outlive
   * its teardown join, so one can land after the session it belongs to is
   * over. Letting it through would overwrite the microphone the *next* session
   * applied; a retired engine reports nothing, and the running one owns that
   * fact.
   */
  private fun reportAppliedInput(key: String?) {
    if (running.get()) onAppliedAudioInputChanged(key)
  }

  private fun runRender(config: RealtimeMediaConfig) {
    val track =
      buildTrack(config.wireOutputHz) ?: run {
        deviceWorkers.decrementAndGet()
        return
      }
    activeTrack.set(track)
    var writtenFrames = 0L
    try {
      while (running.get() && !Thread.currentThread().isInterrupted) {
        if (flushRequested.compareAndSet(true, false)) {
          runCatching { track.pause() }
          runCatching { track.flush() }
          // The track's playback head restarts at zero after a flush, so the
          // frame counter barrier targets are measured against has to as well.
          writtenFrames = 0
          renderLevel.set(0)
          onOutputLevel(null)
        }
        val item = renderQueue.poll(RENDER_POLL_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        completeReachedMarks(track)
        if (item == null) {
          if (SystemClock.elapsedRealtime() >= presentingUntilMs.get()) {
            renderLevel.set(0)
            onOutputLevel(null)
          }
          continue
        }
        val markId = item.markId
        if (item.generation <= cancelThroughGeneration.get()) {
          // A barrier this worker had already dequeued when the clear drained
          // the queue is invisible to `invalidatePendingMarks`. Dropping it
          // silently leaves the Gateway waiting on a turn that cannot finish.
          markId?.let { markEvents.offer(RealtimeMarkEvent(it, RealtimeMarkOutcome.Cancelled)) }
          continue
        }
        if (markId != null) {
          pendingMarks.updateAndGet { it + PendingMark(markId, item.generation, writtenFrames) }
          continue
        }
        val pcm = item.pcm ?: continue
        // Published before the speaker can be audible: `play()` makes it so, and
        // this fallback has no canceller, so a capture gate that closes even a
        // callback later lets assistant audio into the uplink. It also has to
        // precede the write, which blocks until the buffer accepts. A short
        // write leaves the window longer than the audio — the safe direction.
        val chunkMs = (pcm.size / 2L) * 1000L / config.wireOutputHz
        presentingUntilMs.set(maxOf(SystemClock.elapsedRealtime(), presentingUntilMs.get()) + chunkMs)
        // Started before the write, not after it: `AudioTrack.write` blocks
        // until the buffer accepts, and a track that is not playing never
        // drains — a chunk larger than the buffer would block here forever.
        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
        var offset = 0
        while (offset < pcm.size && running.get()) {
          if (item.generation <= cancelThroughGeneration.get() || flushRequested.get()) break
          val written = track.write(pcm, offset, pcm.size - offset)
          if (written < 0) {
            // A negative result is a dead or invalid track — `ERROR_DEAD_OBJECT`
            // after a device or route failure. Continuing the loop would keep
            // Talk running while every later chunk went nowhere.
            Log.w(tag, "fallback playback write failed: $written")
            record(RealtimeMediaEventKind.StreamError, written.toLong(), 0)
            running.set(false)
            break
          }
          if (written == 0) break
          offset += written
        }
        if (offset <= 0) continue
        writtenFrames += offset / 2L
        // The write only queued the samples; the device still holds whatever
        // the playback head has not reached. That backlog is the honest end of
        // presentation — the estimate above is derived from acceptance, which
        // is the very distinction this change exists to stop relying on. It can
        // only lengthen the window: shortening it would reopen the microphone
        // while the last buffered samples were still audible.
        val playbackHead = track.playbackHeadPosition.toLong().coerceAtLeast(0L)
        val queuedFrames = (writtenFrames - playbackHead).coerceAtLeast(0L)
        val drainsAtMs = SystemClock.elapsedRealtime() + queuedFrames * 1000L / config.wireOutputHz
        presentingUntilMs.set(maxOf(presentingUntilMs.get(), drainsAtMs))
        val level = TalkAudioLevel.pcm16Level(pcm, offset)
        renderLevel.set((level * 1000).toLong())
        onOutputLevel(level)
      }
    } catch (err: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (err: RuntimeException) {
      // `play` and `write` throw on a track the platform has invalidated. Left
      // uncaught this thread simply ends: the engine keeps reporting a live
      // session, the control loop keeps accepting PCM and playback barriers,
      // and nothing drains them — so the Gateway waits on a turn that can never
      // finish. Reporting it as a stream error ends the session instead, the
      // same as the capture worker does.
      Log.w(tag, "fallback playback failed: ${err.message ?: err::class.simpleName}")
      record(RealtimeMediaEventKind.StreamError, 0, 0)
      running.set(false)
    } finally {
      activeTrack.set(null)
      runCatching { track.pause() }
      runCatching { track.flush() }
      runCatching { track.stop() }
      track.release()
      renderWorkerStalled.set(false)
      onOutputLevel(null)
      deviceWorkers.decrementAndGet()
    }
  }

  private fun buildTrack(sampleRateHz: Int): AudioTrack? {
    val minBuffer =
      AudioTrack.getMinBufferSize(sampleRateHz, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) {
      Log.w(tag, "fallback playback unavailable: no AudioTrack buffer")
      record(RealtimeMediaEventKind.StreamError, 0, 0)
      return null
    }
    return runCatching {
      AudioTrack
        .Builder()
        .setAudioAttributes(
          AudioAttributes
            .Builder()
            // A conversation, not media playback: the routing and volume
            // stream that follow from this are the ones a call would use.
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        ).setAudioFormat(
          AudioFormat
            .Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRateHz)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        ).setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(maxOf(minBuffer * 2, sampleRateHz * 2 * PLAYBACK_BUFFER_MS / 1000))
        .build()
    }.onFailure {
      Log.w(tag, "fallback playback unavailable: ${it.message ?: it::class.simpleName}")
      record(RealtimeMediaEventKind.StreamError, 0, 0)
    }.getOrNull()
  }

  /** A barrier completes on the track's own playback head, never on write acceptance. */
  private fun completeReachedMarks(track: AudioTrack) {
    val pending = pendingMarks.get()
    if (pending.isEmpty()) return
    val played = track.playbackHeadPosition.toLong() and 0xffff_ffffL
    val cancelThrough = cancelThroughGeneration.get()
    val remaining = ArrayList<PendingMark>(pending.size)
    for (mark in pending) {
      when {
        mark.generation <= cancelThrough -> markEvents.offer(RealtimeMarkEvent(mark.markId, RealtimeMarkOutcome.Cancelled))
        played >= mark.targetFrame -> markEvents.offer(RealtimeMarkEvent(mark.markId, RealtimeMarkOutcome.Completed))
        else -> remaining.add(mark)
      }
    }
    pendingMarks.set(remaining)
  }

  private fun invalidatePendingMarks(outcome: RealtimeMarkOutcome) {
    val pending = pendingMarks.getAndSet(emptyList())
    for (mark in pending) markEvents.offer(RealtimeMarkEvent(mark.markId, outcome))
    var queued = renderQueue.poll()
    while (queued != null) {
      queued.markId?.let { markEvents.offer(RealtimeMarkEvent(it, outcome)) }
      queued = renderQueue.poll()
    }
  }

  private fun record(
    kind: RealtimeMediaEventKind,
    detailA: Long,
    detailB: Long,
  ) {
    telemetryEvents.offer(
      RealtimeMediaEvent(
        kind = kind,
        sequence = telemetrySequence.incrementAndGet(),
        monotonicNanos = SystemClock.elapsedRealtimeNanos(),
        detailA = detailA,
        detailB = detailB,
      ),
    )
  }

  companion object {
    private const val tag = "RealtimeMedia"
    private const val CAPTURE_FRAME_MS = 100
    private const val PLAYBACK_BUFFER_MS = 240
    private const val RENDER_POLL_MS = 20L
    private const val UPLINK_QUEUE_FRAMES = 8
    private const val RENDER_QUEUE_ITEMS = 512
    private const val WORKER_JOIN_TIMEOUT_MS = 500L

    // Device workers alive across every instance of this engine. A stalled one
    // keeps the microphone and the output track, so the next instance must not
    // open its own pair on top of it.
    private val deviceWorkers = AtomicInteger(0)
  }
}
