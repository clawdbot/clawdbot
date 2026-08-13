package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceNoteRecorderControllerTest {
  private class FakeEngine(
    var durationMs: Long = 1_200L,
    var outputBytes: ByteArray = byteArrayOf(1, 2, 3),
  ) : VoiceNoteRecordingEngine {
    var startCount = 0
    var stopCount = 0
    var cancelCount = 0
    var outputFile: File? = null
    var amplitude = 0

    override fun start(outputFile: File) {
      startCount += 1
      this.outputFile = outputFile
      outputFile.writeBytes(outputBytes)
    }

    override fun stop(): Long {
      stopCount += 1
      return durationMs
    }

    override fun cancel() {
      cancelCount += 1
    }

    override fun pollAmplitude(): Int = amplitude
  }

  @Test
  fun startTransitionsToRecordingAndPublishesElapsedTime() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      var now = 1_000L
      val engine = FakeEngine()
      val controller = controller(directory, engine, elapsedRealtimeMillis = { now })

      assertTrue(controller.start())
      assertEquals(VoiceNoteRecorderState.Recording(startedAtMillis = 1_000L), controller.state.value)

      now = 3_500L
      advanceTimeBy(250L)
      runCurrent()
      assertEquals(2_500L, controller.elapsedMs.value)

      controller.cancel()
      directory.deleteRecursively()
    }

  @Test
  fun stopReturnsRetainedFileAndDuration() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine(durationMs = 4_321L)
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add)

      controller.start()
      assertTrue(controller.finish())

      val recording = finished.single()
      assertEquals(4_321L, recording.durationMs)
      assertTrue(recording.file.exists())
      assertEquals(VoiceNoteRecorderState.Preparing, controller.state.value)
      controller.completePreparation()
      assertEquals(VoiceNoteRecorderState.Idle, controller.state.value)
      recording.file.delete()
      directory.deleteRecursively()
    }

  @Test
  fun stopMarksMpeg4ContainerAsM4aForGatewaySniffing() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val mpeg4 = ByteArray(24)
      "ftypmp42".toByteArray(Charsets.US_ASCII).copyInto(mpeg4, destinationOffset = 4)
      val engine = FakeEngine(outputBytes = mpeg4)
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add)

      controller.start()
      controller.finish()

      val recording = finished.single()
      val majorBrand =
        recording.file
          .readBytes()
          .copyOfRange(8, 12)
          .toString(Charsets.US_ASCII)
      assertEquals("M4A ", majorBrand)
      recording.file.delete()
      directory.deleteRecursively()
    }

  @Test
  fun recordingPublishesSmoothedLevelAndCancelClearsIt() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val controller = controller(directory, engine)

      controller.start()
      engine.amplitude = 32_767
      advanceTimeBy(50L)
      runCurrent()
      assertEquals(0.2f, controller.inputLevel.value, 1e-4f)
      advanceTimeBy(100L)
      runCurrent()
      assertEquals(0.36f, controller.inputLevel.value, 1e-4f)

      controller.cancel()
      assertEquals(0f, controller.inputLevel.value, 0f)
      directory.deleteRecursively()
    }

  @Test
  fun cancelDeletesTemporaryFileAndReturnsIdle() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val controller = controller(directory, engine)

      controller.start()
      val file = requireNotNull(engine.outputFile)
      controller.cancel()

      assertFalse(file.exists())
      assertEquals(1, engine.cancelCount)
      assertEquals(VoiceNoteRecorderState.Idle, controller.state.value)
      directory.deleteRecursively()
    }

  @Test
  fun durationCapUsesNormalFinishPath() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      var now = 1_000L
      val engine = FakeEngine(durationMs = VOICE_NOTE_MAX_DURATION_MS)
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add, elapsedRealtimeMillis = { now })

      controller.start()
      now += VOICE_NOTE_MAX_DURATION_MS
      advanceTimeBy(250L)
      runCurrent()

      assertEquals(1, engine.stopCount)
      assertEquals(VOICE_NOTE_MAX_DURATION_MS, finished.single().durationMs)
      finished.single().file.delete()
      directory.deleteRecursively()
    }

  @Test
  fun oversizeRecordingFailsAndDeletesFile() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine(outputBytes = ByteArray(VOICE_NOTE_MAX_BYTES.toInt() + 1))
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add)

      controller.start()
      val file = requireNotNull(engine.outputFile)
      assertFalse(controller.finish())

      assertFalse(file.exists())
      assertTrue(finished.isEmpty())
      assertEquals(
        VoiceNoteRecorderState.Failure("Voice note is too large. Record a shorter message."),
        controller.state.value,
      )
      directory.deleteRecursively()
    }

  @Test
  fun startIsRefusedWhileAlreadyRecording() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val controller = controller(directory, engine)

      assertTrue(controller.start())
      assertFalse(controller.start())
      assertEquals(1, engine.startCount)

      controller.cancel()
      directory.deleteRecursively()
    }

  @Test
  fun startIsRefusedWhilePreparingAttachment() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add)

      controller.start()
      controller.finish()

      assertFalse(controller.start())
      assertEquals(1, engine.startCount)
      assertEquals(VoiceNoteRecorderState.Preparing, controller.state.value)

      finished.single().file.delete()
      directory.deleteRecursively()
    }

  @Test
  fun cancelDuringPreparingDeletesHandedOffFile() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add)

      controller.start()
      controller.finish()
      assertEquals(VoiceNoteRecorderState.Preparing, controller.state.value)
      assertTrue(finished.single().file.exists())
      assertTrue(controller.canCommitPreparation(finished.single().id))

      // Composition-scoped staging may be cancelled before it runs; cancel()
      // must still delete the handed-off recording.
      controller.cancel()

      assertEquals(VoiceNoteRecorderState.Idle, controller.state.value)
      assertFalse(controller.canCommitPreparation(finished.single().id))
      assertFalse(finished.single().file.exists())
      directory.deleteRecursively()
    }

  @Test
  fun reportFailureDuringPreparingDeletesHandedOffFile() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val finished = mutableListOf<VoiceNoteRecording>()
      val controller = controller(directory, engine, onFinished = finished::add)

      controller.start()
      controller.finish()

      controller.reportFailure("Could not prepare voice note.")

      assertEquals(
        VoiceNoteRecorderState.Failure("Could not prepare voice note."),
        controller.state.value,
      )
      assertFalse(finished.single().file.exists())
      directory.deleteRecursively()
    }

  @Test
  fun startIsRefusedWhileVoiceCaptureOwnsMic() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val controller = controller(directory, engine, acquireMic = { false })

      assertFalse(controller.start())

      assertEquals(0, engine.startCount)
      assertEquals(
        VoiceNoteRecorderState.Failure("Voice capture is already using the microphone."),
        controller.state.value,
      )
      directory.deleteRecursively()
    }

  @Test
  fun permissionDeniedIsUserVisibleAndDoesNotStartEngine() =
    runTest {
      val directory = Files.createTempDirectory("voice-note-test").toFile()
      val engine = FakeEngine()
      val controller = controller(directory, engine, requestPermission = { false })

      assertFalse(controller.start())

      assertEquals(0, engine.startCount)
      assertEquals(
        VoiceNoteRecorderState.Failure("Microphone permission is required to record a voice note."),
        controller.state.value,
      )
      directory.deleteRecursively()
    }

  private fun kotlinx.coroutines.test.TestScope.controller(
    directory: File,
    engine: FakeEngine,
    requestPermission: suspend () -> Boolean = { true },
    acquireMic: () -> Boolean = { true },
    releaseMic: () -> Unit = {},
    onFinished: (VoiceNoteRecording) -> Unit = {},
    elapsedRealtimeMillis: () -> Long = { 1_000L },
  ): VoiceNoteRecorderController =
    VoiceNoteRecorderController(
      scope = this,
      outputDirectory = directory,
      engine = engine,
      requestPermission = requestPermission,
      acquireMic = acquireMic,
      releaseMic = releaseMic,
      onFinished = onFinished,
      elapsedRealtimeMillis = elapsedRealtimeMillis,
    )
}
