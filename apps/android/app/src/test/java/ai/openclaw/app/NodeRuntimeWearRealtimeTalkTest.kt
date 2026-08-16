package ai.openclaw.app

import ai.openclaw.app.wear.WearRealtimeAttemptOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NodeRuntimeWearRealtimeTalkTest {
  @Test
  fun `replacement during relay creation stops the stale session and rejects start`() =
    runTest {
      val owner = WearRealtimeAttemptOwner("watch-a", "attempt-a", 1L)
      val startEntered = CompletableDeferred<Unit>()
      val releaseStart = CompletableDeferred<Unit>()
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()
      var currentOwner: WearRealtimeAttemptOwner? = owner

      val result =
        async {
          startWearRealtimeTalkWhileCurrent(
            owner = owner,
            isCurrent = { candidate -> currentOwner == candidate },
            start = { onSessionActivated ->
              startEntered.complete(Unit)
              releaseStart.await()
              onSessionActivated()
              true
            },
            stop = { staleOwner -> stoppedOwners += staleOwner },
          )
        }

      startEntered.await()
      currentOwner = WearRealtimeAttemptOwner("watch-a", "attempt-b", 2L)
      releaseStart.complete(Unit)

      assertFalse(result.await())
      assertEquals(listOf(owner), stoppedOwners)
    }

  @Test
  fun `cancellation after relay activation still stops the uncommitted session`() =
    runTest {
      val owner = WearRealtimeAttemptOwner("watch-a", "attempt-a", 1L)
      val relayActivated = CompletableDeferred<Unit>()
      val stoppedOwners = mutableListOf<WearRealtimeAttemptOwner>()

      val result =
        async {
          startWearRealtimeTalkWhileCurrent(
            owner = owner,
            isCurrent = { true },
            start = { onSessionActivated ->
              onSessionActivated()
              relayActivated.complete(Unit)
              awaitCancellation()
            },
            stop = { staleOwner -> stoppedOwners += staleOwner },
          )
        }

      relayActivated.await()
      result.cancelAndJoin()

      assertEquals(listOf(owner), stoppedOwners)
    }
}
