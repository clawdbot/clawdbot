package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeAudioFrameType
import ai.openclaw.wear.shared.WearRealtimeAudioFraming
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.SystemClock
import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.ceil
import kotlin.math.sqrt

internal class WearRealtimeTalkClient(
  context: Context,
  private val repository: WearGatewayRepository,
) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val channelClient = Wearable.getChannelClient(context.applicationContext)
  private val lifecycleLock = Mutex()
  private val channelLock = Mutex()
  private val audioLock = Any()
  private val audioFocus = WearAudioFocusController(context) { scope.launch { clearOutput(resumeCapture = true) } }
  private val _isCapturing = MutableStateFlow(false)
  val isCapturing: StateFlow<Boolean> = _isCapturing
  private val _isPlaying = MutableStateFlow(false)
  val isPlaying: StateFlow<Boolean> = _isPlaying
  private val _mouthLevel = MutableStateFlow(0f)
  val mouthLevel: StateFlow<Float> = _mouthLevel
  private val _channelFailed = MutableStateFlow(false)
  val channelFailed: StateFlow<Boolean> = _channelFailed

  @Volatile private var activeNodeId: String? = null

  @Volatile private var activeAttemptId: String? = null

  @Volatile private var audioRecord: AudioRecord? = null
  private var channel: ChannelClient.Channel? = null
  private var channelInput: InputStream? = null
  private var channelOutput: OutputStream? = null
  private var captureJob: Job? = null
  private var readJob: Job? = null
  private var playbackIdleJob: Job? = null
  private var mouthJob: Job? = null
  private var mouthFrames: Channel<Float>? = null
  private val mouthLevelAccumulator = Pcm16MouthLevelAccumulator()
  private var audioTrack: AudioTrack? = null
  private var playbackEndsAtMillis = 0L

  private data class ChannelResources(
    val channel: ChannelClient.Channel,
    val input: InputStream,
    val output: OutputStream,
  )

  suspend fun start(
    session: WearSession,
    attemptId: String,
  ): WearRealtimeTalkSnapshot =
    lifecycleLock.withLock {
      _channelFailed.value = false
      val nodeId = session.phoneNodeId
      var channelOpened = false
      try {
        openChannel(nodeId)
        channelOpened = true
        val language =
          Locale
            .getDefault()
            .language
            .lowercase(Locale.ROOT)
            .takeIf { value -> value.length == ISO_639_1_LANGUAGE_LENGTH }
        val snapshot = repository.startRealtimeTalk(session.key, attemptId, language, nodeId)
        activeNodeId = nodeId
        activeAttemptId = attemptId
        startReader(nodeId, attemptId)
        startCapture(nodeId)
        snapshot
      } catch (err: Throwable) {
        closeLocal()
        if (channelOpened) {
          // Finish ambiguous-start cleanup before another attempt can acquire
          // the lifecycle lock and create a replacement relay for this Watch.
          withContext(NonCancellable) { runCatching { repository.stopRealtimeTalk(nodeId, attemptId) } }
        }
        throw err
      }
    }

  suspend fun stop(): WearRealtimeTalkSnapshot =
    lifecycleLock.withLock {
      val nodeId = activeNodeId
      val attemptId = activeAttemptId
      try {
        if (nodeId == null || attemptId == null) {
          WearRealtimeTalkSnapshot()
        } else {
          repository.stopRealtimeTalk(nodeId, attemptId)
        }
      } finally {
        closeLocal()
      }
    }

  fun shutdown() {
    closeLocal()
    scope.cancel()
  }

  fun disconnectLocal() {
    closeLocal()
  }

  private suspend fun openChannel(nodeId: String) {
    var lastError: Throwable? = null
    repeat(CHANNEL_OPEN_ATTEMPTS) { attempt ->
      var opened: ChannelClient.Channel? = null
      var input: InputStream? = null
      var output: OutputStream? = null
      try {
        opened = channelClient.openChannel(nodeId, WearProtocol.REALTIME_AUDIO_CHANNEL_PATH).awaitRealtimeTask()
        input = channelClient.getInputStream(opened).awaitRealtimeTask()
        output = channelClient.getOutputStream(opened).awaitRealtimeTask()
        installChannel(opened, input, output)
        return
      } catch (err: Throwable) {
        if (err is CancellationException) throw err
        lastError = err
        input.closeQuietly()
        output.closeQuietly()
        opened?.let { channel -> runCatching { channelClient.close(channel).awaitRealtimeTask() } }
        if (attempt + 1 < CHANNEL_OPEN_ATTEMPTS) delay(CHANNEL_RETRY_DELAY_MILLIS)
      }
    }
    throw WearProxyException("phone_unavailable", lastError?.message ?: "Unable to open Watch audio channel")
  }

  private fun startReader(
    nodeId: String,
    attemptId: String,
  ) {
    val input = checkNotNull(channelInput)
    readJob?.cancel()
    readJob =
      scope.launch {
        try {
          while (activeNodeId == nodeId && activeAttemptId == attemptId) {
            val frame = WearRealtimeAudioFraming.read(input) ?: break
            if (activeNodeId != nodeId || activeAttemptId != attemptId) break
            when (frame.type) {
              WearRealtimeAudioFrameType.OUTPUT_PCM -> writeOutput(frame.payload)
              WearRealtimeAudioFrameType.CLEAR_OUTPUT -> clearOutput(resumeCapture = true)
              WearRealtimeAudioFrameType.INPUT_PCM -> error("Phone sent an invalid Watch audio frame")
            }
          }
          if (activeNodeId == nodeId) handleChannelFailure(nodeId)
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          if (activeNodeId == nodeId) handleChannelFailure(nodeId)
        }
      }
  }

  @SuppressLint("MissingPermission")
  private fun startCapture(nodeId: String) {
    synchronized(audioLock) { startCaptureLocked(nodeId) }
  }

  @SuppressLint("MissingPermission")
  private fun startCaptureLocked(nodeId: String) {
    if (_isCapturing.value || _isPlaying.value || activeNodeId != nodeId) return
    val frameBytes =
      WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ * PCM_16_BYTES *
        WearProtocol.REALTIME_AUDIO_FRAME_MILLIS / 1_000
    val minimumBuffer =
      AudioRecord.getMinBufferSize(
        WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    require(minimumBuffer > 0)
    val recorder =
      AudioRecord
        .Builder()
        .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
        .setAudioFormat(
          AudioFormat
            .Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build(),
        ).setBufferSizeInBytes(maxOf(minimumBuffer * 2, frameBytes * 4))
        .build()
    check(recorder.state == AudioRecord.STATE_INITIALIZED)
    audioRecord = recorder
    recorder.startRecording()
    _isCapturing.value = true
    captureJob =
      scope.launch {
        val buffer = ByteArray(frameBytes)
        try {
          while (
            currentCoroutineContext().isActive &&
            _isCapturing.value &&
            audioRecord === recorder &&
            activeNodeId == nodeId
          ) {
            val read = recorder.read(buffer, 0, buffer.size)
            val evenBytes = read - (read and 1)
            if (!_isCapturing.value || audioRecord !== recorder) break
            check(read >= 0) { "Watch microphone read failed: $read" }
            if (evenBytes == 0) {
              yield()
              continue
            }
            sendInputFrame(buffer.copyOf(evenBytes))
          }
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          if (activeNodeId == nodeId) handleChannelFailure(nodeId)
        } finally {
          runCatching { recorder.stop() }
          runCatching { recorder.release() }
          if (audioRecord === recorder) audioRecord = null
        }
      }
  }

  private suspend fun sendInputFrame(payload: ByteArray) {
    channelLock.withLock {
      val output = channelOutput ?: error("Wear audio channel is closed")
      withContext(Dispatchers.IO) {
        WearRealtimeAudioFraming.write(output, WearRealtimeAudioFrameType.INPUT_PCM, payload)
      }
    }
  }

  private fun writeOutput(bytes: ByteArray) {
    synchronized(audioLock) {
      if (activeNodeId == null) return
      if (!_isPlaying.value) {
        pauseCaptureLocked()
        check(audioFocus.request())
      }
      val mouthLevels = mouthLevelAccumulator.append(bytes)
      val track = audioTrack ?: createAudioTrack(bytes.size).also { audioTrack = it }
      var written = 0
      while (written < bytes.size) {
        val count = track.write(bytes, written, bytes.size - written)
        if (count <= 0) break
        written += count
      }
      check(written == bytes.size)
      if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
      _isPlaying.value = true
      if (mouthLevels.isNotEmpty()) {
        val timeline = mouthTimelineLocked()
        mouthLevels.forEach { level -> timeline.trySend(level) }
      }
      val durationMillis =
        ((written / PCM_16_BYTES.toDouble()) / WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ * 1_000.0)
          .toLong()
          .coerceAtLeast(1L)
      playbackEndsAtMillis = maxOf(SystemClock.elapsedRealtime(), playbackEndsAtMillis) + durationMillis
      schedulePlaybackIdle()
    }
  }

  private fun mouthTimelineLocked(): Channel<Float> {
    mouthFrames?.let { return it }
    val frames =
      Channel<Float>(
        capacity = MOUTH_QUEUE_CAPACITY,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
    mouthFrames = frames
    mouthJob =
      scope.launch {
        try {
          for (level in frames) {
            _mouthLevel.value = level
            delay(MOUTH_FRAME_MILLIS.toLong())
          }
        } finally {
          if (mouthFrames === frames) _mouthLevel.value = 0f
        }
      }
    return frames
  }

  private fun createAudioTrack(frameBytes: Int): AudioTrack {
    val minimumBuffer =
      AudioTrack.getMinBufferSize(
        WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    require(minimumBuffer > 0)
    return AudioTrack
      .Builder()
      .setAudioAttributes(wearSpeechAudioAttributes)
      .setAudioFormat(
        AudioFormat
          .Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build(),
      ).setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minimumBuffer * 2, frameBytes * 4))
      .build()
      .also { check(it.state == AudioTrack.STATE_INITIALIZED) }
  }

  private fun schedulePlaybackIdle() {
    playbackIdleJob?.cancel()
    val scheduledPlaybackEndMillis = playbackEndsAtMillis
    val finalFrameDurationMillis = mouthLevelAccumulator.pendingFrameDurationMillis()
    playbackIdleJob =
      scope.launch {
        if (finalFrameDurationMillis > 0L) {
          val finalFrameStartsAtMillis = scheduledPlaybackEndMillis - finalFrameDurationMillis
          // Emit the residual at its cumulative sample position; clear/reset below
          // discards it only when the matching AudioTrack tail is also discarded.
          while (SystemClock.elapsedRealtime() < finalFrameStartsAtMillis) delay(MOUTH_FRAME_MILLIS.toLong())
          synchronized(audioLock) {
            if (playbackEndsAtMillis == scheduledPlaybackEndMillis) {
              mouthLevelAccumulator.flush().forEach { level -> mouthTimelineLocked().trySend(level) }
            }
          }
        }
        while (SystemClock.elapsedRealtime() < scheduledPlaybackEndMillis) delay(MOUTH_FRAME_MILLIS.toLong())
        delay(PLAYBACK_DRAIN_GRACE_MILLIS)
        synchronized(audioLock) {
          if (
            playbackEndsAtMillis == scheduledPlaybackEndMillis &&
            SystemClock.elapsedRealtime() >= scheduledPlaybackEndMillis
          ) {
            clearOutputLocked(resumeCapture = true)
          }
        }
      }
  }

  private fun clearOutput(resumeCapture: Boolean) {
    synchronized(audioLock) { clearOutputLocked(resumeCapture) }
  }

  private fun clearOutputLocked(resumeCapture: Boolean) {
    playbackIdleJob?.cancel()
    playbackIdleJob = null
    playbackEndsAtMillis = 0L
    val activeMouthFrames = mouthFrames
    mouthFrames = null
    activeMouthFrames?.close()
    mouthJob?.cancel()
    mouthJob = null
    mouthLevelAccumulator.reset()
    _mouthLevel.value = 0f
    runCatching {
      audioTrack?.pause()
      audioTrack?.flush()
      audioTrack?.stop()
      audioTrack?.release()
    }
    audioTrack = null
    _isPlaying.value = false
    audioFocus.abandon()
    if (resumeCapture) activeNodeId?.let { nodeId -> runCatching { startCaptureLocked(nodeId) } }
  }

  private fun pauseCaptureLocked() {
    _isCapturing.value = false
    captureJob?.cancel()
    captureJob = null
    val recorder = audioRecord
    audioRecord = null
    runCatching { recorder?.stop() }
    runCatching { recorder?.release() }
  }

  private fun handleChannelFailure(nodeId: String) {
    val attemptId = activeAttemptId ?: return
    _channelFailed.value = true
    closeLocal()
    scope.launch { runCatching { repository.stopRealtimeTalk(nodeId, attemptId) } }
  }

  private fun closeLocal() {
    activeNodeId = null
    activeAttemptId = null
    synchronized(audioLock) {
      pauseCaptureLocked()
      clearOutputLocked(resumeCapture = false)
    }
    readJob?.cancel()
    readJob = null
    val resources = detachChannel()
    scope.launch { closeChannel(resources) }
  }

  private suspend fun closeChannel() {
    closeChannel(detachChannel())
  }

  @Synchronized
  private fun installChannel(
    opened: ChannelClient.Channel,
    input: InputStream,
    output: OutputStream,
  ) {
    check(channel == null)
    channel = opened
    channelInput = input
    channelOutput = output
  }

  @Synchronized
  private fun detachChannel(): ChannelResources? {
    val current = channel ?: return null
    val input = channelInput
    val output = channelOutput
    channel = null
    channelInput = null
    channelOutput = null
    if (input == null || output == null) {
      input.closeQuietly()
      output.closeQuietly()
      return null
    }
    return ChannelResources(current, input, output)
  }

  private suspend fun closeChannel(resources: ChannelResources?) {
    if (resources == null) return
    resources.input.closeQuietly()
    resources.output.closeQuietly()
    runCatching { channelClient.close(resources.channel).awaitRealtimeTask() }
  }

  private companion object {
    const val CHANNEL_OPEN_ATTEMPTS = 2
    const val CHANNEL_RETRY_DELAY_MILLIS = 250L
    const val ISO_639_1_LANGUAGE_LENGTH = 2
    const val MOUTH_QUEUE_CAPACITY = 256
    const val PCM_16_BYTES = 2
    const val PLAYBACK_DRAIN_GRACE_MILLIS = 120L
  }
}

internal fun pcm16LeMouthLevels(
  pcm: ByteArray,
  sampleRateHz: Int = WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ,
  frameMillis: Int = MOUTH_FRAME_MILLIS,
): List<Float> =
  Pcm16MouthLevelAccumulator(sampleRateHz, frameMillis).run {
    append(pcm) + flush()
  }

internal class Pcm16MouthLevelAccumulator(
  private val sampleRateHz: Int = WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ,
  frameMillis: Int = MOUTH_FRAME_MILLIS,
) {
  private val samplesPerFrame: Int
  private var squareSum = 0.0
  private var sampleCount = 0

  init {
    require(sampleRateHz > 0 && frameMillis > 0)
    samplesPerFrame = (sampleRateHz * frameMillis / 1_000).coerceAtLeast(1)
  }

  fun append(pcm: ByteArray): List<Float> {
    require(pcm.size % PCM_BYTES_PER_SAMPLE == 0)
    return buildList {
      var byteIndex = 0
      while (byteIndex < pcm.size) {
        val low = pcm[byteIndex].toInt() and 0xff
        val high = pcm[byteIndex + 1].toInt()
        val sample = ((high shl 8) or low).toShort().toInt()
        val normalized = sample / 32_768.0
        squareSum += normalized * normalized
        sampleCount += 1
        byteIndex += PCM_BYTES_PER_SAMPLE
        if (sampleCount == samplesPerFrame) add(finishFrame())
      }
    }
  }

  fun flush(): List<Float> = if (sampleCount == 0) emptyList() else listOf(finishFrame())

  fun reset() {
    squareSum = 0.0
    sampleCount = 0
  }

  fun pendingFrameDurationMillis(): Long =
    if (sampleCount == 0) {
      0L
    } else {
      ceil(sampleCount * 1_000.0 / sampleRateHz).toLong()
    }

  private fun finishFrame(): Float {
    val rms = sqrt(squareSum / sampleCount)
    val gated = ((rms - RMS_NOISE_GATE) / RMS_SPEECH_RANGE).coerceIn(0.0, 1.0)
    reset()
    return sqrt(gated).toFloat()
  }
}

internal const val MOUTH_FRAME_MILLIS = 20
private const val PCM_BYTES_PER_SAMPLE = 2
private const val RMS_NOISE_GATE = 0.015
private const val RMS_SPEECH_RANGE = 0.2

private fun java.io.Closeable?.closeQuietly() {
  runCatching { this?.close() }
}

private suspend fun <T> Task<T>.awaitRealtimeTask(): T =
  suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { value -> if (continuation.isActive) continuation.resume(value) }
    addOnFailureListener { error -> if (continuation.isActive) continuation.resumeWithException(error) }
    addOnCanceledListener { continuation.cancel() }
  }
