package ai.openclaw.app

import android.Manifest
import android.app.Dialog
import android.content.pm.PackageManager
import android.os.Looper
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PermissionRequesterTest {
  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun timedOutRequestCallbackDoesNotCompleteNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = requester(activity(), requests)

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
      val requester = requester(activity(), requests)

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
      val requester = requester(activity(), requests)

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
  fun cancelledPermissionDialogsDismissAndReleaseNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        for (showRationale in listOf(true, false)) {
          val originalActivity = if (showRationale) rationaleActivity() else activity()
          val requests = FakePermissionRequests()
          val requester = requester(originalActivity, requests)
          val cancelled = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
          runCurrent()
          if (!showRationale) {
            assertTrue(requests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
            runCurrent()
          }

          val dialog = checkNotNull(ShadowDialog.getLatestDialog())
          assertTrue(dialog.isShowing)
          cancelled.cancelAndJoin()
          shadowOf(Looper.getMainLooper()).idle()
          runCurrent()
          assertFalse("rationale=$showRationale", dialog.isShowing)

          val replacementActivity = activity()
          val replacementRequests = FakePermissionRequests()
          requester.attach(replacementActivity, replacementRequests::request)
          requester.activate(replacementActivity)
          val recovered =
            async { requester.requestIfMissing(listOf(Manifest.permission.RECORD_AUDIO), timeoutMs = 1_000) }
          runCurrent()
          assertEquals(1, replacementRequests.size)
          assertTrue(replacementRequests.deliver(requester, 0, mapOf(Manifest.permission.RECORD_AUDIO to true)))
          runCurrent()
          assertEquals(mapOf(Manifest.permission.RECORD_AUDIO to true), recovered.await())
        }
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
      val requester = requester(activity(), requests)

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

        cancelDialog(checkNotNull(ShadowDialog.getLatestDialog()))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun replacementActivityCompletesPendingRequestAndOwnsLaterPrompts() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(1, originalRequests.size)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        requester.deactivate(originalActivity)
        requester.detach(originalActivity)

        assertTrue(originalRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), pending.await())

        val replacementPrompt =
          async { requester.requestIfMissing(listOf(Manifest.permission.RECORD_AUDIO), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(1, replacementRequests.size)
        replacementPrompt.cancelAndJoin()
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun requestWaitsForReplacementActivityAcrossRecreationGap() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        requester.deactivate(originalActivity)
        requester.detach(originalActivity)

        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(0, originalRequests.size)
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        assertEquals(1, replacementRequests.size)
        assertFalse(pending.isCompleted)
        assertTrue(replacementRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun resumedEarlierTaskReclaimsPermissionPromptOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val firstActivity = activity()
      val firstRequests = FakePermissionRequests()
      val requester = requester(firstActivity, firstRequests)
      val secondActivity = activity()
      val secondRequests = FakePermissionRequests()

      try {
        requester.deactivate(firstActivity)
        requester.attach(secondActivity, secondRequests::request)
        requester.activate(secondActivity)
        requester.deactivate(secondActivity)
        requester.activate(firstActivity)

        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(1, firstRequests.size)
        assertEquals(0, secondRequests.size)
        pending.cancelAndJoin()
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun permanentDenialWaitsForReplacementActivity() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertTrue(originalRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        requester.deactivate(originalActivity)
        requester.detach(originalActivity)
        runCurrent()
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        val settingsDialog = checkNotNull(ShadowDialog.getLatestDialog())
        assertTrue(settingsDialog.isShowing)
        assertFalse(pending.isCompleted)

        cancelDialog(settingsDialog)
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun permanentDenialPromptMovesToNewActiveActivity() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertTrue(originalRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        runCurrent()

        val originalDialog = checkNotNull(ShadowDialog.getLatestDialog())
        assertTrue(originalDialog.isShowing)
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        val replacementDialog = checkNotNull(ShadowDialog.getLatestDialog())
        assertFalse(originalDialog.isShowing)
        assertTrue(replacementDialog !== originalDialog)
        assertTrue(replacementDialog.isShowing)
        assertFalse(pending.isCompleted)

        cancelDialog(replacementDialog)
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun rationaleHostLossRetriesOnReplacementActivity() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val rationaleActivity = rationaleActivity()
      val rationaleRequests = FakePermissionRequests()
      val requester = requester(rationaleActivity, rationaleRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(0, rationaleRequests.size)
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        assertEquals(0, rationaleRequests.size)
        assertEquals(1, replacementRequests.size)
        assertTrue(replacementRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), pending.await())
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

  private fun rationaleActivity(): ComponentActivity =
    Robolectric
      .buildActivity(PermissionRationaleActivity::class.java)
      .setup()
      .get()

  private fun cancelDialog(dialog: Dialog) {
    checkNotNull(shadowOf(dialog).onCancelListener).onCancel(dialog)
  }

  private fun requester(
    activity: ComponentActivity,
    requests: FakePermissionRequests,
  ): PermissionRequester =
    PermissionRequester(activity.applicationContext).also { requester ->
      requester.attach(activity, requests::request)
      requester.activate(activity)
    }
}

class PermissionRationaleActivity : ComponentActivity() {
  override fun shouldShowRequestPermissionRationale(permission: String): Boolean = true
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
