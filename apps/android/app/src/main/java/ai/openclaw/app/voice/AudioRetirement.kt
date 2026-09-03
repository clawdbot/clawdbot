package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Retains physical audio cleanup after a manager relinquishes its logical session. */
internal class AudioRetirement(
  private val scope: CoroutineScope,
) {
  private val lock = Any()
  private val _completion = MutableStateFlow<Deferred<Unit>>(CompletableDeferred(Unit))
  val completion: StateFlow<Deferred<Unit>> = _completion
  val pending: Boolean
    get() = completion.value.let { !it.isCompleted || it.isCancelled }

  fun retire(
    capture: Job? = null,
    input: AutoCloseable? = null,
    cleanup: Deferred<Unit>? = null,
  ): Deferred<Unit> =
    synchronized(lock) {
      if (capture == null && input == null && cleanup == null) return@synchronized _completion.value
      capture?.cancel()
      val previous = _completion.value
      scope
        .async(Dispatchers.IO) {
          // Closing on IO unblocks a native read; Job completion includes the recorder's finally.
          try {
            input?.close()
          } finally {
            capture?.join()
          }
          cleanup?.await()
          previous.await()
        }.also {
          _completion.value = it
        }
    }

  suspend fun await(retirement: Deferred<Unit>? = null) {
    while (true) {
      // PTT finishes its captured owner; new microphone admission drains the latest owner.
      val current = retirement ?: completion.value
      try {
        current.await()
      } catch (error: Exception) {
        currentCoroutineContext().ensureActive()
        // Cancellation or exceptional completion does not prove that the device was released.
        throw IllegalStateException("Audio device failed to stop. Restart the app before recording again.", error)
      }
      if (retirement != null || current === completion.value) return
    }
  }
}
