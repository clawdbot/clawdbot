package ai.openclaw.app.voice

import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.SpeechRecognizer
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VoiceWakeManagerTest {
  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun repeatedCommandDispatchesInNewRecognitionCycle() =
    runTest {
      val commands = mutableListOf<String>()
      val manager =
        VoiceWakeManager(
          context = RuntimeEnvironment.getApplication(),
          scope = this,
          onCommand = { command -> commands += command },
        )
      manager.setTriggerWords(listOf("claude"))
      val listener = recognitionListener(manager)

      listener.onReadyForSpeech(null)
      listener.onPartialResults(recognitionResults("claude take a photo"))
      listener.onResults(recognitionResults("claude take a photo"))
      advanceUntilIdle()

      listener.onReadyForSpeech(null)
      listener.onResults(recognitionResults("claude take a photo"))
      advanceUntilIdle()

      assertEquals(listOf("take a photo", "take a photo"), commands)
    }

  private fun recognitionResults(text: String): Bundle =
    Bundle().apply {
      putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf(text))
    }

  private fun recognitionListener(manager: VoiceWakeManager): RecognitionListener {
    val field = VoiceWakeManager::class.java.getDeclaredField("listener")
    field.isAccessible = true
    return field.get(manager) as RecognitionListener
  }
}
