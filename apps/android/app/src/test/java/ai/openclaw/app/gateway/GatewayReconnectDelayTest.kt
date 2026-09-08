package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Delay
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.InternalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.resume

@OptIn(ExperimentalCoroutinesApi::class, InternalCoroutinesApi::class)
class GatewayReconnectDelayTest {
  @Test
  fun preservesTheFirstSixRetrySlots() {
    assertEquals(listOf(595L, 1011L, 1719L, 2923L, 4969L, 8000L), (1..6).map(::gatewayReconnectDelayMs))
  }

  @Test
  fun persistentFailuresKeepFiniteThirtyToSixtySecondTimers() {
    for (attempt in 7..9) assertTrue(gatewayReconnectDelayMs(attempt) in 8_001L..60_000L)
    for (attempt in listOf(10, 11, 100, Int.MAX_VALUE)) {
      repeat(100) { assertTrue(gatewayReconnectDelayMs(attempt) in 30_000L..60_000L) }
    }
  }

  @Test
  fun receivedWakeSurvivesTimeoutBeforeContinuationResumes() {
    // Control: the former receive-in-timeout primitive loses a consumed wake at this boundary.
    assertFalse(
      wakeBeforeTimeout { signal, delayMs ->
        withTimeoutOrNull(delayMs) {
          signal.receive()
          true
        } ?: false
      },
    )
    assertTrue(wakeBeforeTimeout(::awaitGatewayReconnectSignal))
  }

  private fun wakeBeforeTimeout(wait: suspend (ReceiveChannel<Unit>, Long) -> Boolean): Boolean {
    val dispatcher = RetryBoundaryDispatcher()
    val scope = CoroutineScope(dispatcher)
    val signal = Channel<Unit>(Channel.CONFLATED)
    val result = scope.async(start = CoroutineStart.UNDISPATCHED) { wait(signal, 1_000) }
    try {
      signal.trySend(Unit)
      dispatcher.fireTimeout()
      dispatcher.runQueued()
      return result.getCompleted()
    } finally {
      scope.cancel()
      dispatcher.runQueued()
      signal.cancel()
    }
  }

  @Test
  fun timeoutWinnerLeavesALaterWakeQueuedForTheNextAttempt() {
    val dispatcher = RetryBoundaryDispatcher()
    val scope = CoroutineScope(dispatcher)
    val signal = Channel<Unit>(Channel.CONFLATED)
    val result = scope.async(start = CoroutineStart.UNDISPATCHED) { awaitGatewayReconnectSignal(signal, 1_000) }
    try {
      dispatcher.fireTimeout()
      signal.trySend(Unit)
      dispatcher.runQueued()
      assertFalse(result.getCompleted())
      assertTrue(signal.tryReceive().isSuccess)
    } finally {
      scope.cancel()
      dispatcher.runQueued()
      signal.cancel()
    }
  }

  @Test
  fun cancellationStillRetiresASelectedWake() {
    val dispatcher = RetryBoundaryDispatcher()
    val scope = CoroutineScope(dispatcher)
    val signal = Channel<Unit>(Channel.CONFLATED)
    val result = scope.async(start = CoroutineStart.UNDISPATCHED) { awaitGatewayReconnectSignal(signal, 1_000) }
    signal.trySend(Unit)
    scope.cancel()
    dispatcher.runQueued()
    signal.cancel()
    assertTrue(result.isCancelled)
  }

  @Test
  fun queuedWakeTakesPriorityWhenTheTimeoutIsImmediatelyEligible() =
    runBlocking {
      val signal = Channel<Unit>(Channel.CONFLATED)
      signal.trySend(Unit)
      assertTrue(awaitGatewayReconnectSignal(signal, 0))
      assertFalse(awaitGatewayReconnectSignal(signal, 0))
      signal.cancel()
    }

  // Separate timer firing from continuation dispatch to exercise prompt cancellation without sleeps.
  private class RetryBoundaryDispatcher :
    CoroutineDispatcher(),
    Delay {
    private val queued = ArrayDeque<Runnable>()
    private val timeouts = ArrayDeque<() -> Unit>()

    override fun dispatch(
      context: CoroutineContext,
      block: Runnable,
    ) {
      queued.addLast(block)
    }

    override fun invokeOnTimeout(
      timeMillis: Long,
      block: Runnable,
      context: CoroutineContext,
    ): DisposableHandle {
      var disposed = false
      timeouts.addLast { if (!disposed) block.run() }
      return DisposableHandle { disposed = true }
    }

    override fun scheduleResumeAfterDelay(
      timeMillis: Long,
      continuation: CancellableContinuation<Unit>,
    ) {
      val handle = invokeOnTimeout(timeMillis, Runnable { continuation.resume(Unit) }, continuation.context)
      continuation.invokeOnCancellation { handle.dispose() }
    }

    fun fireTimeout() = timeouts.removeFirst().invoke()

    fun runQueued() {
      while (queued.isNotEmpty()) queued.removeFirst().run()
    }
  }
}
