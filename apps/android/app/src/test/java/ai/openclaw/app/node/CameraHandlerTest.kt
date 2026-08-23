package ai.openclaw.app.node

import android.Manifest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class CameraHandlerTest {
  @Before
  fun setUpMainDispatcher() {
    Dispatchers.setMain(Dispatchers.Unconfined)
  }

  @After
  fun resetMainDispatcher() {
    Dispatchers.resetMain()
  }

  @Test
  fun snapFailsImmediatelyWhenCameraPermissionIsMissing() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.CAMERA)

    val error =
      assertThrows(IllegalStateException::class.java) {
        runBlocking { CameraCaptureManager(app).snap(null) }
      }

    assertEquals("CAMERA_PERMISSION_REQUIRED: grant Camera permission", error.message)
  }

  @Test
  fun clipFailsImmediatelyWhenCameraPermissionIsMissing() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.CAMERA)

    val error =
      assertThrows(IllegalStateException::class.java) {
        runBlocking { CameraCaptureManager(app).clip("""{"includeAudio":false}""") }
      }

    assertEquals("CAMERA_PERMISSION_REQUIRED: grant Camera permission", error.message)
  }

  @Test
  fun clipFailsImmediatelyWhenMicrophonePermissionIsMissing() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    val camera = CameraCaptureManager(app)

    val error =
      assertThrows(IllegalStateException::class.java) {
        runBlocking { camera.clip("""{"includeAudio":true}""") }
      }

    assertEquals("MIC_PERMISSION_REQUIRED: grant Microphone permission", error.message)
  }

  @Test
  fun clipWithAudioFailsBeforeCameraStartsWhenMicrophoneIsBusy() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val handler =
        CameraHandler(
          appContext = app,
          camera = CameraCaptureManager(app),
          setCameraAudioCaptureActive = { false },
          showCameraHud = { _, _, _ -> },
          invokeErrorFromThrowable = { "UNAVAILABLE" to (it.message ?: "camera failed") },
        )

      val result = handler.handleClip("""{"includeAudio":true}""")

      assertFalse(result.ok)
      assertEquals("MIC_BUSY", result.error?.code)
    }

  @Test
  fun isCameraClipWithinPayloadLimit_allowsZeroAndLimit() {
    assertTrue(isCameraClipWithinPayloadLimit(0L))
    assertTrue(isCameraClipWithinPayloadLimit(CAMERA_CLIP_MAX_RAW_BYTES))
  }

  @Test
  fun isCameraClipWithinPayloadLimit_rejectsNegativeAndTooLarge() {
    assertFalse(isCameraClipWithinPayloadLimit(-1L))
    assertFalse(isCameraClipWithinPayloadLimit(CAMERA_CLIP_MAX_RAW_BYTES + 1L))
  }

  @Test
  fun cameraClipMaxRawBytes_matchesExpectedBudget() {
    assertEquals(18L * 1024L * 1024L, CAMERA_CLIP_MAX_RAW_BYTES)
  }

  @Test
  fun cameraClipSession_closesRecordingUnbindsAndDeletesOwnedFile() {
    val tempFile = File.createTempFile("openclaw-clip-test-", ".mp4")
    val cleanup = mutableListOf<String>()
    val session =
      CameraClipSession(
        unbind = { cleanup += "unbind" },
        deleteTemporaryFile = { file ->
          cleanup += "file"
          assertSame(tempFile, file)
          file.delete()
        },
      )
    session.ownRecording(AutoCloseable { cleanup += "recording" })
    session.ownFile(tempFile)

    session.close()
    session.close()

    assertEquals(listOf("recording", "unbind", "file"), cleanup)
    assertFalse(tempFile.exists())
  }

  @Test
  fun cameraClipSession_unbindsBeforeRecordingStarts() {
    val cleanup = mutableListOf<String>()

    CameraClipSession(
      unbind = { cleanup += "unbind" },
      deleteTemporaryFile = { cleanup += "file" },
    ).close()

    assertEquals(listOf("unbind"), cleanup)
  }

  @Test
  fun cameraClipSession_keepsFileTransferredToCaller() {
    val tempFile = File.createTempFile("openclaw-clip-test-", ".mp4")
    try {
      val cleanup = mutableListOf<String>()
      val session =
        CameraClipSession(
          unbind = { cleanup += "unbind" },
          deleteTemporaryFile = { cleanup += "file" },
        )
      session.ownRecording(AutoCloseable { cleanup += "recording" })
      session.ownFile(tempFile)

      assertSame(tempFile, session.transferFile())
      session.close()

      assertEquals(listOf("recording", "unbind"), cleanup)
      assertTrue(tempFile.exists())
    } finally {
      tempFile.delete()
    }
  }
}
