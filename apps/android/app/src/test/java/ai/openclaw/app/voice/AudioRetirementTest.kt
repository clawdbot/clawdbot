package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioRetirementTest {
  @Test
  fun failedCapturedClearNeverAuthorizesAnotherMicrophoneEvenAfterRepeatedStop() =
    runTest {
      for (cancelled in listOf(true, false)) {
        val scope = CoroutineScope(coroutineContext + SupervisorJob())
        try {
          val owner = AudioRetirement(scope)
          val clear = CompletableDeferred<Unit>()
          val captured = owner.retire(cleanup = clear)
          if (cancelled) clear.cancel() else clear.completeExceptionally(IllegalStateException("Device release failed"))
          owner.retire()

          for (retirement in listOf(captured, null)) {
            val failure = runCatching { owner.await(retirement) }.exceptionOrNull()
            assertTrue(failure is IllegalStateException)
            assertTrue(failure?.message.orEmpty().contains("Restart the app"))
            assertTrue(owner.pending)
          }
        } finally {
          scope.cancel()
        }
      }
    }

  @Test
  fun capturedRetirementFinishesWithoutWaitingForAReplacementOwner() =
    runTest {
      val owner = AudioRetirement(this)
      val oldClear = CompletableDeferred<Unit>()
      val captured = owner.retire(cleanup = oldClear)
      val previous = async(start = CoroutineStart.UNDISPATCHED) { owner.await(captured) }
      val admission = async(start = CoroutineStart.UNDISPATCHED) { owner.await() }
      val newClear = CompletableDeferred<Unit>()
      owner.retire(cleanup = newClear)

      oldClear.complete(Unit)
      previous.await()
      assertTrue(owner.pending)
      assertFalse(admission.isCompleted)

      newClear.complete(Unit)
      admission.await()
      assertFalse(owner.pending)
    }
}
