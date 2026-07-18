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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

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
        startReader(nodeId)
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

  private fun startReader(nodeId: String) {
    val input = checkNotNull(channelInput)
    readJob?.cancel()
    readJob =
      scope.launch {
        try {
          while (activeNodeId == nodeId) {
            val frame = WearRealtimeAudioFraming.read(input) ?: break
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
          while (_isCapturing.value && activeNodeId == nodeId) {
            val read = recorder.read(buffer, 0, buffer.size)
            val evenBytes = read - (read and 1)
            if (evenBytes <= 0) continue
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
      val durationMillis =
        ((written / PCM_16_BYTES.toDouble()) / WearProtocol.REALTIME_AUDIO_SAMPLE_RATE_HZ * 1_000.0)
          .toLong()
          .coerceAtLeast(1L)
      playbackEndsAtMillis = maxOf(SystemClock.elapsedRealtime(), playbackEndsAtMillis) + durationMillis
      schedulePlaybackIdle()
    }
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
    playbackIdleJob =
      scope.launch {
        while (SystemClock.elapsedRealtime() < playbackEndsAtMillis) delay(20L)
        delay(PLAYBACK_DRAIN_GRACE_MILLIS)
        synchronized(audioLock) {
          if (SystemClock.elapsedRealtime() >= playbackEndsAtMillis) clearOutputLocked(resumeCapture = true)
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
    const val PCM_16_BYTES = 2
    const val PLAYBACK_DRAIN_GRACE_MILLIS = 120L
  }
}

private fun java.io.Closeable?.closeQuietly() {
  runCatching { this?.close() }
}

private suspend fun <T> Task<T>.awaitRealtimeTask(): T =
  suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { value -> if (continuation.isActive) continuation.resume(value) }
    addOnFailureListener { error -> if (continuation.isActive) continuation.resumeWithException(error) }
    addOnCanceledListener { continuation.cancel() }
  }
