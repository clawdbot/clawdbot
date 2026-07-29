package ai.openclaw.app

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
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
      val requests = FakePermissionRequests()
      val requester = PermissionRequester(activity(), requests::request)

      try {
        val first = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 10) }
        runCurrent()
        advanceTimeBy(11)
        runCurrent()

        assertTrue(first.isCompleted)
        assertTrue(first.getCompletionExceptionOrNull() is TimeoutCancellationException)
        assertEquals(listOf(Manifest.permission.CAMERA), requests[0].permissions)

        val second = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(listOf(Manifest.permission.CAMERA), requests[1].permissions)

        assertFalse(requests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        runCurrent()

        assertFalse(second.isCompleted)

        assertTrue(requests.deliver(requester, 1, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to true), second.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun repeatedTimedOutRequestsWithoutCallbacksDoNotBlockNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = PermissionRequester(activity(), requests::request)

      try {
        repeat(4) { index ->
          val timedOut = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 10) }
          runCurrent()
          advanceTimeBy(11)
          runCurrent()

          assertTrue(timedOut.isCompleted)
          assertTrue(timedOut.getCompletionExceptionOrNull() is TimeoutCancellationException)
          assertEquals(listOf(Manifest.permission.CAMERA), requests[index].permissions)
        }

        val recovered = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(5, requests.size)
        assertEquals(listOf(Manifest.permission.CAMERA), requests[4].permissions)

        assertTrue(requests.deliver(requester, 4, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to true), recovered.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cancelledRequestCallbackDoesNotCompleteNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = PermissionRequester(activity(), requests::request)

      try {
        val cancelled = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        cancelled.cancelAndJoin()

        val recovered = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(2, requests.size)
        assertFalse(requests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        runCurrent()
        assertFalse(recovered.isCompleted)

        assertTrue(requests.deliver(requester, 1, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), recovered.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun emptyPlatformCallbackTreatsRequestedPermissionsAsDenied() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = PermissionRequester(activity(), requests::request)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertTrue(
          requester.onRequestPermissionsResult(
            requests[0].requestCode,
            emptyArray(),
            intArrayOf(),
          ),
        )
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun requestCodeAllocatorWrapsWithinLegacyRangeAndSkipsLiveCodes() {
    val allocator =
      PermissionRequestCodeAllocator(PermissionRequestCodeAllocator.LAST_PERMISSION_REQUEST_CODE)

    assertEquals(PermissionRequestCodeAllocator.LAST_PERMISSION_REQUEST_CODE, allocator.allocate { false })
    assertEquals(
      PermissionRequestCodeAllocator.FIRST_PERMISSION_REQUEST_CODE + 1,
      allocator.allocate { requestCode ->
        requestCode == PermissionRequestCodeAllocator.FIRST_PERMISSION_REQUEST_CODE
      },
    )
  }

  private fun activity(): ComponentActivity =
    Robolectric
      .buildActivity(ComponentActivity::class.java)
      .setup()
      .get()
}

private class FakePermissionRequest(
  val permissions: List<String>,
  val requestCode: Int,
)

private class FakePermissionRequests {
  private val requests = mutableListOf<FakePermissionRequest>()

  val size: Int
    get() = requests.size

  operator fun get(index: Int): FakePermissionRequest = requests[index]

  fun request(
    permissions: Array<String>,
    requestCode: Int,
  ) {
    requests += FakePermissionRequest(permissions.toList(), requestCode)
  }

  fun deliver(
    requester: PermissionRequester,
    index: Int,
    result: Map<String, Boolean>,
  ): Boolean {
    val request = requests[index]
    val grantResults =
      request.permissions
        .map { permission ->
          if (result[permission] == true) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
        }.toIntArray()
    return requester.onRequestPermissionsResult(
      request.requestCode,
      request.permissions.toTypedArray(),
      grantResults,
    )
  }
}
