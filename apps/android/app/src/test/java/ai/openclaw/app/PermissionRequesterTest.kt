package ai.openclaw.app

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityOptionsCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PermissionRequesterTest {
  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun timedOutRequestCallbackDoesNotCompleteNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val launchers = mutableListOf<FakePermissionLauncher>()
      val requester =
        PermissionRequester(activity()) { callback ->
          FakePermissionLauncher(callback).also { launchers += it }
        }

      try {
        val first = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 10) }
        runCurrent()
        advanceTimeBy(11)
        runCurrent()

        assertTrue(first.isCompleted)
        assertTrue(first.getCompletionExceptionOrNull() is TimeoutCancellationException)
        assertEquals(listOf(listOf(Manifest.permission.CAMERA)), launchers[0].launches)

        val second = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(listOf(listOf(Manifest.permission.CAMERA)), launchers[1].launches)

        launchers[0].deliver(mapOf(Manifest.permission.CAMERA to false))
        runCurrent()

        assertFalse(second.isCompleted)

        launchers[1].deliver(mapOf(Manifest.permission.CAMERA to true))
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to true), second.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun timedOutRequestWithoutCallbackDoesNotBlockNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val launchers = mutableListOf<FakePermissionLauncher>()
      val requester =
        PermissionRequester(activity()) { callback ->
          FakePermissionLauncher(callback).also { launchers += it }
        }

      try {
        val first = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 10) }
        runCurrent()
        advanceTimeBy(11)
        runCurrent()

        assertTrue(first.isCompleted)
        assertTrue(first.getCompletionExceptionOrNull() is TimeoutCancellationException)

        val second = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(listOf(listOf(Manifest.permission.CAMERA)), launchers[1].launches)

        launchers[1].deliver(mapOf(Manifest.permission.CAMERA to true))
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to true), second.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  private fun activity(): ComponentActivity =
    Robolectric
      .buildActivity(ComponentActivity::class.java)
      .setup()
      .get()
}

private class FakePermissionLauncher(
  private val callback: (Map<String, Boolean>) -> Unit,
) : ActivityResultLauncher<Array<String>>() {
  val launches = mutableListOf<List<String>>()
  override val contract: ActivityResultContract<Array<String>, *> = ActivityResultContracts.RequestMultiplePermissions()

  override fun launch(
    input: Array<String>,
    options: ActivityOptionsCompat?,
  ) {
    launches += input.toList()
  }

  override fun unregister() {}

  fun deliver(result: Map<String, Boolean>) {
    callback(result)
  }
}
