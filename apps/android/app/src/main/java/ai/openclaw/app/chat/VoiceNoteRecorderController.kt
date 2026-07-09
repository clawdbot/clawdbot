package ai.openclaw.app.chat

import ai.openclaw.app.voice.TalkAudioLevel
import android.content.Context
import android.media.MediaRecorder
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

internal const val VOICE_NOTE_MAX_DURATION_MS = 180_000L
internal const val VOICE_NOTE_MAX_BYTES = 3_500_000L
internal const val VOICE_NOTE_MIME_TYPE = "audio/mp4"

internal sealed interface VoiceNoteRecorderState {
  data object Idle : VoiceNoteRecorderState

  data class Recording(
    val startedAtMillis: Long,
  ) : VoiceNoteRecorderState

  data object Preparing : VoiceNoteRecorderState

  data class Failure(
    val message: String,
  ) : VoiceNoteRecorderState
}

internal data class VoiceNoteRecording(
  val file: File,
  val durationMs: Long,
)

internal interface VoiceNoteRecordingEngine {
  fun start(outputFile: File)

  fun stop(): Long

  fun cancel()

  /** Peak abs PCM amplitude (0..32767) since the last poll; 0 when not recording. */
  fun pollAmplitude(): Int
}

/** Owns voice-note recording state and temporary-file cleanup. */
internal class VoiceNoteRecorderController(
  private val scope: CoroutineScope,
  private val outputDirectory: File,
  private val engine: VoiceNoteRecordingEngine,
  private val requestPermission: suspend () -> Boolean,
  private val acquireMic: () -> Boolean,
  private val releaseMic: () -> Unit,
  private val onFinished: (VoiceNoteRecording) -> Unit,
  private val elapsedRealtimeMillis: () -> Long = SystemClock::elapsedRealtime,
) {
  private val lock = Any()
  private val _state = MutableStateFlow<VoiceNoteRecorderState>(VoiceNoteRecorderState.Idle)
  val state: StateFlow<VoiceNoteRecorderState> = _state.asStateFlow()

  private val _elapsedMs = MutableStateFlow(0L)
  val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

  private val _inputLevel = MutableStateFlow(0f)
  val inputLevel: StateFlow<Float> = _inputLevel.asStateFlow()

  private var outputFile: File? = null
  private var elapsedJob: Job? = null
  private var ownsMic = false

  suspend fun start(): Boolean {
    synchronized(lock) {
      if (_state.value !is VoiceNoteRecorderState.Idle && _state.value !is VoiceNoteRecorderState.Failure) return false
    }
    if (!requestPermission()) {
      fail("Microphone permission is required to record a voice note.")
      return false
    }

    return synchronized(lock) {
      if (_state.value !is VoiceNoteRecorderState.Idle && _state.value !is VoiceNoteRecorderState.Failure) {
        return@synchronized false
      }
      if (!acquireMic()) {
        failLocked("Voice capture is already using the microphone.")
        return@synchronized false
      }
      ownsMic = true

      val startedAt = elapsedRealtimeMillis()
      val file = File(outputDirectory, "voice-note-${UUID.randomUUID()}.m4a")
      try {
        engine.start(file)
      } catch (_: Throwable) {
        engine.cancel()
        releaseMicLocked()
        file.delete()
        failLocked("Could not start voice-note recording.")
        return@synchronized false
      }

      outputFile = file
      _elapsedMs.value = 0L
      _state.value = VoiceNoteRecorderState.Recording(startedAtMillis = startedAt)
      startElapsedUpdates(startedAt)
      true
    }
  }

  fun finish(): Boolean {
    val recording =
      synchronized(lock) {
        if (_state.value !is VoiceNoteRecorderState.Recording) return false
        val file = outputFile ?: return false
        elapsedJob?.cancel()
        elapsedJob = null

        val durationMs =
          try {
            engine.stop().coerceIn(0L, VOICE_NOTE_MAX_DURATION_MS)
          } catch (_: Throwable) {
            engine.cancel()
            file.delete()
            finishFailureLocked("Could not finish voice-note recording.")
            return false
          }

        try {
          normalizeM4aContainerBrand(file)
        } catch (_: Throwable) {
          file.delete()
          finishFailureLocked("Could not finish voice-note recording.")
          return false
        }

        if (file.length() > VOICE_NOTE_MAX_BYTES) {
          file.delete()
          finishFailureLocked("Voice note is too large. Record a shorter message.")
          return false
        }

        // The file stays owned by the controller through Preparing: the staging
        // coroutine is composition-scoped and may be cancelled before it runs,
        // so cancel() must still be able to delete the handed-off recording.
        _elapsedMs.value = 0L
        _inputLevel.value = 0f
        _state.value = VoiceNoteRecorderState.Preparing
        releaseMicLocked()
        VoiceNoteRecording(file = file, durationMs = durationMs)
      }
    onFinished(recording)
    return true
  }

  fun completePreparation() {
    synchronized(lock) {
      if (_state.value is VoiceNoteRecorderState.Preparing) {
        outputFile = null
        _state.value = VoiceNoteRecorderState.Idle
      }
    }
  }

  fun cancel() {
    synchronized(lock) {
      elapsedJob?.cancel()
      elapsedJob = null
      if (_state.value is VoiceNoteRecorderState.Recording) {
        engine.cancel()
      }
      releaseMicLocked()
      outputFile?.delete()
      outputFile = null
      _elapsedMs.value = 0L
      _inputLevel.value = 0f
      _state.value = VoiceNoteRecorderState.Idle
    }
  }

  fun reportFailure(message: String) {
    synchronized(lock) {
      outputFile?.delete()
      outputFile = null
      failLocked(message)
    }
  }

  private fun startElapsedUpdates(startedAt: Long) {
    elapsedJob?.cancel()
    elapsedJob =
      scope.launch {
        while (isActive && state.value is VoiceNoteRecorderState.Recording) {
          val elapsed = (elapsedRealtimeMillis() - startedAt).coerceIn(0L, VOICE_NOTE_MAX_DURATION_MS)
          _elapsedMs.value = elapsed
          // MediaRecorder exposes only the peak since the last poll; running it
          // through the shared dB window keeps this wave on the same visual
          // scale as the RMS-metered talk and dictation waves.
          val rawLevel = TalkAudioLevel.normalized((engine.pollAmplitude().coerceIn(0, 32_767)) / 32_767.0)
          _inputLevel.value = TalkAudioLevel.smoothed(_inputLevel.value, rawLevel)
          // MediaRecorder's duration callback races its asynchronous auto-stop.
          // Own the cap here so every successful finish calls stop() exactly once.
          if (elapsed >= VOICE_NOTE_MAX_DURATION_MS) {
            finish()
            return@launch
          }
          delay(100L)
        }
      }
  }

  private fun fail(message: String) {
    synchronized(lock) { failLocked(message) }
  }

  private fun failLocked(message: String) {
    _state.value = VoiceNoteRecorderState.Failure(message)
  }

  private fun finishFailureLocked(message: String) {
    releaseMicLocked()
    outputFile = null
    _elapsedMs.value = 0L
    _inputLevel.value = 0f
    _state.value = VoiceNoteRecorderState.Failure(message)
  }

  private fun releaseMicLocked() {
    if (!ownsMic) return
    ownsMic = false
    releaseMic()
  }
}

/** Marks AAC-only MPEG-4 output as audio so gateway byte sniffing cannot classify it as video. */
internal fun normalizeM4aContainerBrand(file: File) {
  RandomAccessFile(file, "rw").use { output ->
    if (output.length() < 12L) return
    output.seek(4L)
    val boxType = ByteArray(4)
    output.readFully(boxType)
    if (!boxType.contentEquals("ftyp".toByteArray(Charsets.US_ASCII))) return
    output.seek(8L)
    output.write("M4A ".toByteArray(Charsets.US_ASCII))
  }
}

/** Android AAC/m4a engine kept behind [VoiceNoteRecordingEngine] for JVM tests. */
internal class AndroidVoiceNoteRecordingEngine(
  private val context: Context,
  private val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime,
) : VoiceNoteRecordingEngine {
  private var recorder: MediaRecorder? = null
  private var startedAtElapsedMs = 0L

  override fun start(outputFile: File) {
    check(recorder == null)
    val next = MediaRecorder(context)
    try {
      next.setAudioSource(MediaRecorder.AudioSource.MIC)
      next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      next.setAudioChannels(1)
      next.setAudioEncodingBitRate(32_000)
      next.setAudioSamplingRate(44_100)
      next.setOutputFile(outputFile.absolutePath)
      next.prepare()
      next.start()
      startedAtElapsedMs = elapsedRealtime()
      recorder = next
    } catch (error: Throwable) {
      next.release()
      throw error
    }
  }

  override fun stop(): Long {
    val active = checkNotNull(recorder)
    recorder = null
    return try {
      active.stop()
      (elapsedRealtime() - startedAtElapsedMs).coerceAtLeast(0L)
    } finally {
      active.release()
    }
  }

  override fun cancel() {
    val active = recorder ?: return
    recorder = null
    runCatching { active.stop() }
    active.release()
  }

  // maxAmplitude throws until sampling starts on some OEMs; a dead meter beats
  // killing the recording.
  override fun pollAmplitude(): Int = recorder?.let { active -> runCatching { active.maxAmplitude }.getOrDefault(0) } ?: 0
}
