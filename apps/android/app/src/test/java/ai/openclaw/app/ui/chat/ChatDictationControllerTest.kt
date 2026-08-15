package ai.openclaw.app.ui.chat

import android.speech.SpeechRecognizer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatDictationControllerTest {
  private class FakeRecognizer(
    override var isAvailable: Boolean = true,
    private val onCancel: () -> Unit = {},
  ) : ChatDictationRecognizer {
    var listener: ((ChatDictationRecognitionEvent) -> Unit)? = null
    var startCount = 0
    var finishCount = 0
    var cancelCount = 0
    var destroyCount = 0

    override fun start(onEvent: (ChatDictationRecognitionEvent) -> Unit) {
      startCount += 1
      listener = onEvent
    }

    override fun finish() {
      finishCount += 1
    }

    override fun cancel() {
      cancelCount += 1
      onCancel()
      listener = null
    }

    override fun destroy() {
      destroyCount += 1
      listener = null
    }

    fun emit(event: ChatDictationRecognitionEvent) {
      listener?.invoke(event)
    }
  }

  @Test
  fun finalTranscriptCompletesAndReleasesTheMicrophone() =
    runTest {
      val recognizer = FakeRecognizer()
      var acquired = 0
      var released = 0
      val controller =
        controller(
          recognizer = recognizer,
          acquireMic = {
            acquired += 1
            true
          },
          releaseMic = { released += 1 },
        )

      val result = async { controller.start() }
      runCurrent()
      assertEquals(ChatDictationState.Listening, controller.state.value)

      recognizer.emit(ChatDictationRecognitionEvent.Transcript("  hello world  "))

      assertEquals("hello world", result.await())
      assertEquals(ChatDictationState.Idle, controller.state.value)
      assertEquals(1, acquired)
      assertEquals(1, released)
    }

  @Test
  fun finalTranscriptRetiresTheRecognizerBeforeReleasingTheMicrophone() =
    runTest {
      val terminalOrder = mutableListOf<String>()
      val recognizer = FakeRecognizer(onCancel = { terminalOrder += "recognizer" })
      val controller =
        controller(
          recognizer = recognizer,
          releaseMic = { terminalOrder += "microphone" },
        )
      val result = async { controller.start() }
      runCurrent()

      recognizer.emit(ChatDictationRecognitionEvent.Transcript("done"))

      assertEquals("done", result.await())
      assertEquals(listOf("recognizer", "microphone"), terminalOrder)
    }

  @Test
  fun finishRequestsAPlatformFinalResult() =
    runTest {
      val recognizer = FakeRecognizer()
      val controller = controller(recognizer)
      val result = async { controller.start() }
      runCurrent()

      controller.finish()
      recognizer.emit(ChatDictationRecognitionEvent.Transcript("done"))

      assertEquals(1, recognizer.finishCount)
      assertEquals("done", result.await())
    }

  @Test
  fun finishDuringPermissionRequestCancelsBeforeRecognitionStarts() =
    runTest {
      val recognizer = FakeRecognizer()
      val permission = CompletableDeferred<Boolean>()
      val controller =
        controller(
          recognizer = recognizer,
          requestPermission = { permission.await() },
        )
      val result = async { controller.start() }
      runCurrent()

      controller.finish()
      permission.complete(true)
      runCurrent()

      assertNull(result.await())
      assertEquals(0, recognizer.startCount)
      assertEquals(ChatDictationState.Idle, controller.state.value)
    }

  @Test
  fun cancelCompletesWithoutTranscriptAndReleasesTheMicrophone() =
    runTest {
      val recognizer = FakeRecognizer()
      var released = 0
      val controller = controller(recognizer = recognizer, releaseMic = { released += 1 })
      val result = async { controller.start() }
      runCurrent()

      controller.cancel()

      assertNull(result.await())
      assertEquals(ChatDictationState.Idle, controller.state.value)
      assertEquals(1, released)
    }

  @Test
  fun ownerCancellationDuringPermissionRequestCannotStartRecognition() =
    runTest {
      val recognizer = FakeRecognizer()
      val permission = CompletableDeferred<Boolean>()
      val controller =
        ChatDictationController(
          recognizer = recognizer,
          requestPermission = { permission.await() },
          acquireMic = { true },
          releaseMic = {},
        )
      val result = async { controller.start() }
      runCurrent()

      controller.cancel()
      permission.complete(true)
      runCurrent()

      assertNull(result.await())
      assertEquals(0, recognizer.startCount)
      assertEquals(ChatDictationState.Idle, controller.state.value)
    }

  @Test
  fun cancelledPermissionRequestCannotTakeOverARestartedAttempt() =
    runTest {
      val recognizer = FakeRecognizer()
      val firstPermission = CompletableDeferred<Boolean>()
      val secondPermission = CompletableDeferred<Boolean>()
      var permissionRequestCount = 0
      val controller =
        ChatDictationController(
          recognizer = recognizer,
          requestPermission = {
            permissionRequestCount += 1
            if (permissionRequestCount == 1) firstPermission.await() else secondPermission.await()
          },
          acquireMic = { true },
          releaseMic = {},
        )

      val cancelledAttempt = async { controller.start() }
      runCurrent()
      controller.cancel()
      val replacementAttempt = async { controller.start() }
      runCurrent()

      firstPermission.complete(true)
      runCurrent()
      assertNull(cancelledAttempt.await())
      assertEquals(0, recognizer.startCount)
      assertEquals(ChatDictationState.Starting, controller.state.value)

      secondPermission.complete(true)
      runCurrent()
      assertEquals(1, recognizer.startCount)
      recognizer.emit(ChatDictationRecognitionEvent.Transcript("replacement"))

      assertEquals("replacement", replacementAttempt.await())
      assertEquals(ChatDictationState.Idle, controller.state.value)
    }

  @Test
  fun unavailableRecognizerFailsBeforeRequestingPermission() =
    runTest {
      val recognizer = FakeRecognizer(isAvailable = false)
      var permissionRequests = 0
      val controller =
        controller(
          recognizer = recognizer,
          requestPermission = {
            permissionRequests += 1
            true
          },
        )

      assertNull(controller.start())
      assertEquals(ChatDictationState.Failure(ChatDictationFailure.Unavailable), controller.state.value)
      assertEquals(0, permissionRequests)
      assertEquals(0, recognizer.startCount)
    }

  @Test
  fun permissionDenialIsVisibleAndDoesNotAcquireTheMicrophone() =
    runTest {
      val recognizer = FakeRecognizer()
      var acquireCount = 0
      val controller =
        controller(
          recognizer = recognizer,
          requestPermission = { false },
          acquireMic = {
            acquireCount += 1
            true
          },
        )

      assertNull(controller.start())
      assertEquals(ChatDictationState.Failure(ChatDictationFailure.PermissionRequired), controller.state.value)
      assertEquals(0, acquireCount)
    }

  @Test
  fun microphoneContentionIsVisibleAndDoesNotStartRecognition() =
    runTest {
      val recognizer = FakeRecognizer()
      val controller = controller(recognizer = recognizer, acquireMic = { false })

      assertNull(controller.start())
      assertEquals(ChatDictationState.Failure(ChatDictationFailure.Busy), controller.state.value)
      assertEquals(0, recognizer.startCount)
    }

  @Test
  fun platformErrorReleasesTheMicrophoneAndMapsTheFailure() =
    runTest {
      val recognizer = FakeRecognizer()
      var released = 0
      val controller = controller(recognizer = recognizer, releaseMic = { released += 1 })
      val result = async { controller.start() }
      runCurrent()

      recognizer.emit(ChatDictationRecognitionEvent.Error(SpeechRecognizer.ERROR_NETWORK))

      assertNull(result.await())
      assertEquals(ChatDictationState.Failure(ChatDictationFailure.Network), controller.state.value)
      assertEquals(1, released)
    }

  @Test
  fun destroyCancelsCaptureAndDestroysThePlatformRecognizer() =
    runTest {
      val recognizer = FakeRecognizer()
      val controller = controller(recognizer)
      val result = async { controller.start() }
      runCurrent()

      controller.destroy()

      assertNull(result.await())
      assertTrue(recognizer.cancelCount > 0)
      assertEquals(1, recognizer.destroyCount)
    }

  private fun controller(
    recognizer: FakeRecognizer,
    requestPermission: suspend () -> Boolean = { true },
    acquireMic: () -> Boolean = { true },
    releaseMic: () -> Unit = {},
  ): ChatDictationController =
    ChatDictationController(
      recognizer = recognizer,
      requestPermission = requestPermission,
      acquireMic = acquireMic,
      releaseMic = releaseMic,
    )
}
