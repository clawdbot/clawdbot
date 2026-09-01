package ai.openclaw.app.voice

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowTextToSpeech

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class SystemSpeechSpeakerTest {
  @Test
  fun longReplyPreservesEveryCharacterInOrderedPlatformSizedUtterances() =
    runTest {
      withSpeaker { speaker ->
        val limit = TextToSpeech.getMaxSpeechInputLength()
        val text = "a".repeat(limit - 1) + "🦞" + " words.\n".repeat(600)
        val speech = launch { speaker.speak(text) }
        runCurrent()
        val shadow = initializeEngine()
        runCurrent()

        assertEquals(1, shadow.spokenTextList.size)
        // Each callback drain finishes one submitted utterance; the next must await it.
        while (!speech.isCompleted) {
          val submitted = shadow.spokenTextList.size
          assertTrue(submitted <= text.length)
          assertTrue(shadow.spokenTextList.all { it.length <= limit })
          drainCallbacks()
          assertEquals(submitted + if (speech.isCompleted) 0 else 1, shadow.spokenTextList.size)
        }

        assertFalse(speech.isCancelled)
        val utterances = shadow.spokenTextList
        assertEquals(text, utterances.joinToString(""))
        assertTrue(utterances.size > 1)
        assertTrue(utterances.all { it.isNotEmpty() && it.length <= limit })
        assertTrue(utterances.none { it.first().isLowSurrogate() || it.last().isHighSurrogate() })
      }
    }

  @Test
  fun stopDuringInitializationCannotSpeakAfterLateReady() =
    runTest {
      withSpeaker { speaker ->
        val speech = launch { speaker.speak("Stopped before ready") }
        runCurrent()
        val shadow = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))

        speaker.stop()
        shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
        drainCallbacks()

        assertTrue(speech.isCancelled)
        assertTrue(shadow.spokenTextList.isEmpty())
      }
    }

  @Test
  fun shutdownDuringInitializationCannotReviveRetiredEngine() =
    runTest {
      withSpeaker { speaker ->
        val retiredSpeech = launch { speaker.speak("Retired") }
        runCurrent()
        val retired = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
        speaker.shutdown()

        val nextSpeech = launch { speaker.speak("Replacement") }
        runCurrent()
        val replacement = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
        assertNotSame(retired, replacement)
        shadowOf(retired).onInitListener.onInit(TextToSpeech.SUCCESS)
        runCurrent()
        assertTrue(shadowOf(replacement).spokenTextList.isEmpty())
        initializeEngine()
        runCurrent()
        drainCallbacks()

        assertTrue(retiredSpeech.isCancelled)
        assertTrue(shadowOf(retired).isShutdown)
        assertTrue(shadowOf(retired).spokenTextList.isEmpty())
        assertEquals(listOf("Replacement"), shadowOf(replacement).spokenTextList)
        assertTrue(nextSpeech.isCompleted && !nextSpeech.isCancelled)
      }
    }

  @Test
  fun stopBeforeMainDispatchDoesNotAllocateAnEngine() =
    runTest {
      withSpeaker { speaker ->
        val speech = launch(start = CoroutineStart.UNDISPATCHED) { speaker.speak("Never submitted") }
        speaker.stop()
        runCurrent()

        assertTrue(speech.isCancelled)
        assertNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
      }
    }

  @Test
  fun stoppingOrCancellingAfterChunkCompletionCannotSubmitTheTail() =
    runTest {
      for (stopOwner in listOf(true, false)) {
        withSpeaker { speaker ->
          val text = "x".repeat(TextToSpeech.getMaxSpeechInputLength() + 1)
          val speech = launch { speaker.speak(text) }
          runCurrent()
          val shadow = initializeEngine()
          runCurrent()
          assertEquals(1, shadow.spokenTextList.size)

          shadowOf(Looper.getMainLooper()).idle()
          if (stopOwner) speaker.stop() else speech.cancel()
          runCurrent()
          drainCallbacks()

          assertTrue(speech.isCancelled)
          assertEquals(listOf(text.take(TextToSpeech.getMaxSpeechInputLength())), shadow.spokenTextList)
        }
      }
    }

  @Test
  fun supersedingSpeechDropsTheTailAndIgnoresOldCallbacks() =
    runTest {
      withSpeaker { speaker ->
        val oldText = "x".repeat(TextToSpeech.getMaxSpeechInputLength() + 1)
        val oldSpeech = launch { speaker.speak(oldText) }
        runCurrent()
        val shadow = initializeEngine()
        runCurrent()
        val nextSpeech = launch { speaker.speak("New reply") }
        runCurrent()

        // The stock shadow retains old callbacks after stop, as an in-flight SDK callback can.
        val main = shadowOf(Looper.getMainLooper())
        repeat(3) {
          main.runOneTask()
          runCurrent()
        }
        assertTrue(oldSpeech.isCancelled)
        assertFalse(nextSpeech.isCompleted)
        drainCallbacks()

        assertTrue(nextSpeech.isCompleted && !nextSpeech.isCancelled)
        assertEquals(listOf(oldText.take(TextToSpeech.getMaxSpeechInputLength()), "New reply"), shadow.spokenTextList)
      }
    }

  @Test
  fun alreadyCancelledCallerCannotSupersedeHealthySpeech() =
    runTest {
      withSpeaker { speaker ->
        val healthy = launch { speaker.speak("Healthy reply") }
        runCurrent()
        val shadow = initializeEngine()
        runCurrent()

        val cancelled =
          launch(start = CoroutineStart.UNDISPATCHED) {
            currentCoroutineContext().cancel()
            speaker.speak("Cancelled caller")
          }
        runCurrent()
        assertFalse(healthy.isCompleted)
        drainCallbacks()

        assertTrue(cancelled.isCancelled)
        assertTrue(healthy.isCompleted && !healthy.isCancelled)
        assertEquals(listOf("Healthy reply"), shadow.spokenTextList)
      }
    }

  @Test
  fun cancellationFromBeforeSpeakDoesNotSubmitAudio() =
    runTest {
      withSpeaker { speaker ->
        val speech = launch { speaker.speak("Never submitted", locale = null, speechRate = null, beforeSpeak = speaker::stop) }
        runCurrent()
        val shadow = initializeEngine()
        runCurrent()
        drainCallbacks()

        assertTrue(speech.isCancelled)
        assertTrue(shadow.spokenTextList.isEmpty())
      }
    }

  @Test
  fun initializationFailureIsReportedAndRetryCreatesAFreshEngine() =
    runTest {
      withSpeaker { speaker ->
        val failed = async { runCatching { speaker.speak("First attempt") } }
        runCurrent()
        val retired = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
        shadowOf(retired).onInitListener.onInit(TextToSpeech.ERROR)
        runCurrent()
        assertTrue(failed.await().exceptionOrNull() is IllegalStateException)
        assertTrue(shadowOf(retired).isShutdown)

        val retry = launch { speaker.speak("Retry") }
        runCurrent()
        assertNotSame(retired, ShadowTextToSpeech.getLastTextToSpeechInstance())
        val shadow = initializeEngine()
        runCurrent()
        drainCallbacks()

        assertTrue(retry.isCompleted && !retry.isCancelled)
        assertEquals(listOf("Retry"), shadow.spokenTextList)
      }
    }

  @Test
  @Config(shadows = [FailingTextToSpeechShadow::class])
  fun platformStartAndCallbackErrorsStopTheRequestAndPermitRetry() =
    runTest {
      for (mode in SpeechFailureMode.entries) {
        withSpeaker { speaker ->
          val failed = async { runCatching { speaker.speak("x".repeat(TextToSpeech.getMaxSpeechInputLength() + 1)) } }
          runCurrent()
          val engine = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
          val shadow = Shadow.extract<FailingTextToSpeechShadow>(engine)
          shadow.failureMode = mode
          shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
          runCurrent()
          drainCallbacks()

          assertTrue(failed.await().exceptionOrNull() is IllegalStateException)
          assertEquals(1, shadow.submitted.size)
          shadow.failureMode = null
          val retry = launch { speaker.speak("Retry") }
          runCurrent()
          drainCallbacks()

          assertTrue(retry.isCompleted && !retry.isCancelled)
          assertEquals(listOf("x".repeat(TextToSpeech.getMaxSpeechInputLength()), "Retry"), shadow.submitted)
        }
      }
    }

  private fun initializeEngine(): ShadowTextToSpeech =
    shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())).also {
      it.onInitListener.onInit(TextToSpeech.SUCCESS)
    }

  private fun TestScope.drainCallbacks() {
    shadowOf(Looper.getMainLooper()).idle()
    runCurrent()
  }

  private suspend fun TestScope.withSpeaker(block: suspend TestScope.(SystemSpeechSpeaker) -> Unit) {
    Dispatchers.setMain(StandardTestDispatcher(testScheduler))
    val speaker = SystemSpeechSpeaker(ApplicationProvider.getApplicationContext())
    try {
      block(speaker)
    } finally {
      speaker.shutdown()
      drainCallbacks()
      Dispatchers.resetMain()
    }
  }
}

enum class SpeechFailureMode { Immediate, Callback }

/** Injects SDK failures only; content/limit/ordering tests use the unmodified platform shadow. */
@Implements(TextToSpeech::class)
class FailingTextToSpeechShadow : ShadowTextToSpeech() {
  var failureMode: SpeechFailureMode? = null
  val submitted = mutableListOf<String>()

  @Implementation
  override fun speak(
    text: CharSequence,
    queueMode: Int,
    params: Bundle?,
    utteranceId: String?,
  ): Int {
    submitted += text.toString()
    return when (failureMode) {
      SpeechFailureMode.Immediate -> TextToSpeech.ERROR
      SpeechFailureMode.Callback -> {
        Handler(Looper.getMainLooper()).post {
          utteranceProgressListener.onError(utteranceId, TextToSpeech.ERROR_SYNTHESIS)
        }
        TextToSpeech.SUCCESS
      }
      null -> super.speak(text, queueMode, params, utteranceId)
    }
  }
}
