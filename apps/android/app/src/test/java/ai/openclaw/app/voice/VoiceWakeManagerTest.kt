package ai.openclaw.app.voice

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalCoroutinesApi::class)
class VoiceWakeManagerTest {
  @Test
  fun retiredRecognitionSessionDropsLateCallbacks() {
    val events = mutableListOf<VoiceWakeRecognitionEvent>()
    val session = VoiceWakeRecognitionSession(events::add)

    session.emit(VoiceWakeRecognitionEvent.Ready)
    session.retire()
    session.emit(VoiceWakeRecognitionEvent.Transcript("openclaw stale command", isFinal = true))

    assertEquals(listOf(VoiceWakeRecognitionEvent.Ready), events)
  }

  @Test
  fun enabledForegroundRecognizerDispatchesCommandAndRestarts() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      val commands = mutableListOf<VoiceWakeMatch>()
      val manager =
        manager(recognizer = recognizer) { match ->
          commands += match
          true
        }

      manager.setForeground(true)
      manager.setEnabled(true)
      recognizer.emit(VoiceWakeRecognitionEvent.Ready)

      assertTrue(manager.isListening.value)
      assertEquals("Listening", manager.statusText.value)

      recognizer.emit(VoiceWakeRecognitionEvent.Transcript("OpenClaw, show", isFinal = false))
      runCurrent()
      assertEquals(emptyList<VoiceWakeMatch>(), commands)

      recognizer.emit(VoiceWakeRecognitionEvent.Transcript("OpenClaw, show status", isFinal = true))
      runCurrent()

      assertEquals(listOf(VoiceWakeMatch("OpenClaw", "show status")), commands)
      assertEquals("show status", manager.lastTriggeredCommand.value)
      assertEquals(1, recognizer.stopCount)

      advanceUntilIdle()
      assertEquals(2, recognizer.startCount)
    }

  @Test
  fun suppressionStopsAndResumesRecognizer() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)
      manager.setSuppressed(VoiceWakeSuppressionReason.VoiceCapture, true)

      assertEquals("Paused", manager.statusText.value)
      assertEquals(1, recognizer.stopCount)

      manager.setSuppressed(VoiceWakeSuppressionReason.VoiceCapture, false)
      assertEquals(2, recognizer.startCount)
    }

  @Test
  fun suppressionDoesNotHoldManagerLockWhileStoppingRecognizer() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer(callbackDuringStop = true)
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)
      manager.setSuppressed(VoiceWakeSuppressionReason.VoiceCapture, true)

      assertTrue(recognizer.stopCallbackCompleted)
      assertEquals("Paused", manager.statusText.value)
    }

  @Test
  fun oneAudioOwnerCannotReleaseAnotherOwnersSuppression() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)
      manager.setSuppressed(VoiceWakeSuppressionReason.Camera, true)
      manager.setSuppressed(VoiceWakeSuppressionReason.VoiceCapture, true)
      manager.setSuppressed(VoiceWakeSuppressionReason.Camera, false)

      assertEquals("Paused", manager.statusText.value)
      assertEquals(1, recognizer.startCount)

      manager.setSuppressed(VoiceWakeSuppressionReason.VoiceCapture, false)
      assertEquals(2, recognizer.startCount)
    }

  @Test
  fun staleSuppressionRevisionCannotReleaseNewAudioOwner() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)
      manager.setSuppressed(VoiceWakeSuppressionReason.Camera, true, revision = 2)
      manager.setSuppressed(VoiceWakeSuppressionReason.Camera, false, revision = 1)

      assertEquals("Paused", manager.statusText.value)
      assertEquals(1, recognizer.startCount)
    }

  @Test
  fun suppressionCancelsPendingCommandDispatch() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      var commandStarted = false
      var commandCancelled = false
      val manager =
        manager(recognizer = recognizer) {
          commandStarted = true
          try {
            awaitCancellation()
          } finally {
            commandCancelled = true
          }
        }

      manager.setForeground(true)
      manager.setEnabled(true)
      recognizer.emit(VoiceWakeRecognitionEvent.Transcript("openclaw show status", isFinal = true))
      runCurrent()
      assertTrue(commandStarted)

      manager.setSuppressed(VoiceWakeSuppressionReason.VoiceNote, true)
      runCurrent()

      assertTrue(commandCancelled)
      assertEquals("Paused", manager.statusText.value)
    }

  @Test
  fun permissionRefreshStartsAfterGrant() =
    runTest {
      var permissionGranted = false
      val recognizer = FakeVoiceWakeRecognizer()
      val manager = manager(recognizer = recognizer, hasPermission = { permissionGranted })

      manager.setForeground(true)
      manager.setEnabled(true)
      assertEquals("Microphone permission required", manager.statusText.value)
      assertEquals(0, recognizer.startCount)

      permissionGranted = true
      manager.refreshPermission()
      assertEquals(1, recognizer.startCount)
    }

  @Test
  fun unavailableRecognizerNeverStarts() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer(isAvailable = false)
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)

      assertFalse(manager.isListening.value)
      assertEquals("On-device speech recognition unavailable", manager.statusText.value)
      assertEquals(0, recognizer.startCount)
    }

  @Test
  fun permanentLanguageErrorDoesNotRetry() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)
      recognizer.emit(VoiceWakeRecognitionEvent.Error(android.speech.SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE))
      advanceUntilIdle()

      assertEquals("On-device language model unavailable", manager.statusText.value)
      assertEquals(1, recognizer.startCount)
    }

  @Test
  fun quotaErrorUsesLongBackoff() =
    runTest {
      val recognizer = FakeVoiceWakeRecognizer()
      val manager = manager(recognizer = recognizer)

      manager.setForeground(true)
      manager.setEnabled(true)
      recognizer.emit(VoiceWakeRecognitionEvent.Error(android.speech.SpeechRecognizer.ERROR_TOO_MANY_REQUESTS))

      advanceTimeBy(14_999)
      runCurrent()
      assertEquals(1, recognizer.startCount)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(2, recognizer.startCount)
    }

  private fun kotlinx.coroutines.test.TestScope.manager(
    recognizer: FakeVoiceWakeRecognizer,
    hasPermission: () -> Boolean = { true },
    onCommand: suspend (VoiceWakeMatch) -> Boolean = { true },
  ): VoiceWakeManager =
    VoiceWakeManager(
      context = RuntimeEnvironment.getApplication(),
      scope = this,
      recognizer = recognizer,
      initialTriggerWords = listOf("openclaw"),
      onCommand = onCommand,
      restartDelayMs = 1,
      hasRecordAudioPermission = hasPermission,
    )

  private class FakeVoiceWakeRecognizer(
    override val isAvailable: Boolean = true,
    private val callbackDuringStop: Boolean = false,
  ) : VoiceWakeRecognizer {
    var startCount = 0
    var stopCount = 0
    var destroyCount = 0
    var stopCallbackCompleted = false
    private var onEvent: ((VoiceWakeRecognitionEvent) -> Unit)? = null

    override fun start(
      operationId: Long,
      onEvent: (VoiceWakeRecognitionEvent) -> Unit,
    ) {
      startCount += 1
      this.onEvent = onEvent
    }

    override fun stop(operationId: Long) {
      stopCount += 1
      if (callbackDuringStop) {
        val completed = CountDownLatch(1)
        Thread {
          onEvent?.invoke(VoiceWakeRecognitionEvent.Error(android.speech.SpeechRecognizer.ERROR_CLIENT))
          completed.countDown()
        }.start()
        stopCallbackCompleted = completed.await(1, TimeUnit.SECONDS)
      }
    }

    override fun destroy(operationId: Long) {
      destroyCount += 1
    }

    fun emit(event: VoiceWakeRecognitionEvent) {
      onEvent?.invoke(event)
    }
  }
}
