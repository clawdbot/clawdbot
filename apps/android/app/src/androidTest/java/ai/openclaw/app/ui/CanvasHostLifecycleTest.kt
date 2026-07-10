package ai.openclaw.app.ui

import ai.openclaw.app.node.CanvasController
import android.content.pm.ActivityInfo
import android.os.SystemClock
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CanvasHostLifecycleTest {
  @get:Rule
  val activityRule = ActivityScenarioRule(CanvasLifecycleTestActivity::class.java)

  @Before
  fun resetMetrics() {
    CanvasLifecycleTestMetrics.reset()
  }

  @Test
  fun hiddenHostRetainsOneWebViewWithoutBlockingShellInput() {
    activityRule.scenario.onActivity { activity ->
      assertEquals(CanvasController.PresentationState.Unmounted, activity.controller.presentationState.value)
      assertNull(activity.host)
    }

    val presentElapsedMs = activityRule.scenario.readActivity { activity -> activity.presentSlowPage() }

    assertTrue(
      "present waited for the remote page: ${presentElapsedMs}ms",
      presentElapsedMs < canvasLifecycleSlowPageDelayMs / 2,
    )
    assertTrue("slow page never finished", activityRule.scenario.waitForPageFinished())

    val firstWebView =
      activityRule.scenario.readActivity { activity ->
        val host = checkNotNull(activity.host)
        assertEquals(1, host.childCount)
        assertEquals(CanvasController.PresentationState.Visible, activity.controller.presentationState.value)
        val webView = checkNotNull(activity.currentWebView())
        activity.hideCanvas()
        assertEquals(CanvasController.PresentationState.Hidden, activity.controller.presentationState.value)
        webView
      }
    assertTrue(
      "hidden host remained visible",
      activityRule.scenario.waitUntilActivity { activity -> activity.host?.visibility == View.INVISIBLE },
    )

    val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    assertTrue(device.click(device.displayWidth / 2, device.displayHeight / 2))
    device.waitForIdle()

    activityRule.scenario.onActivity { activity ->
      assertEquals(1, activity.underlayClickCount)
      repeat(3) {
        activity.presentFastPage()
        activity.hideCanvas()
      }
      assertEquals(1, activity.host?.childCount)
      assertTrue(firstWebView === activity.currentWebView())
    }
  }

  @Test
  fun stalePageCompletionCannotReshowCanvasAfterHide() {
    activityRule.scenario.onActivity { activity -> activity.presentSlowPage() }
    assertTrue(
      "Canvas host was not attached",
      activityRule.scenario.waitUntilActivity { activity -> activity.currentWebView() != null },
    )
    activityRule.scenario.onActivity { activity -> activity.hideCanvas() }
    assertTrue(
      "hidden host remained visible",
      activityRule.scenario.waitUntilActivity { activity -> activity.host?.visibility == View.INVISIBLE },
    )

    assertTrue("slow page never finished", activityRule.scenario.waitForPageFinished())
    activityRule.scenario.onActivity { activity ->
      assertEquals(CanvasController.PresentationState.Hidden, activity.controller.presentationState.value)
      assertEquals(View.INVISIBLE, checkNotNull(activity.host).visibility)
      assertNotNull(activity.currentWebView())
    }
  }

  @Test
  fun rendererTerminationForgetsFailedPageAndNextShowRecreatesIt() {
    activityRule.scenario.onActivity { activity -> activity.presentFastPage() }
    assertTrue("initial page never finished", activityRule.scenario.waitForPageFinished())

    val firstWebView =
      activityRule.scenario.readActivity { activity ->
        assertNotNull(activity.controller.currentUrl())
        checkNotNull(activity.currentWebView())
      }
    val terminated =
      activityRule.scenario.readActivity { activity ->
        activity.currentWebView()?.webViewRenderProcess?.terminate() == true
      }
    assertTrue("WebView renderer did not terminate", terminated)
    assertTrue(
      "renderer loss did not clear the invalid WebView",
      activityRule.scenario.waitUntilActivity { activity -> activity.currentWebView() == null },
    )

    activityRule.scenario.onActivity { activity ->
      assertEquals(CanvasController.PresentationState.Hidden, activity.controller.presentationState.value)
      assertNull(activity.controller.currentUrl())
      assertEquals(0, activity.host?.childCount)
      activity.showCanvas()
    }
    assertTrue(
      "next show did not create a replacement WebView",
      activityRule.scenario.waitUntilActivity { activity -> activity.currentWebView() != null },
    )
    assertTrue("replacement scaffold never finished", activityRule.scenario.waitForPageFinished())
    activityRule.scenario.onActivity { activity ->
      assertEquals(CanvasController.PresentationState.Visible, activity.controller.presentationState.value)
      assertEquals(1, activity.host?.childCount)
      assertNotEquals(firstWebView, activity.currentWebView())
    }
  }

  @Test
  fun configurationChangesKeepTheSameHostAndWebView() {
    activityRule.scenario.onActivity { activity -> activity.presentFastPage() }
    assertTrue("initial page never finished", activityRule.scenario.waitForPageFinished())
    val firstHost = activityRule.scenario.readActivity { activity -> checkNotNull(activity.host) }
    val firstWebView = activityRule.scenario.readActivity { activity -> checkNotNull(activity.currentWebView()) }

    activityRule.scenario.onActivity { activity ->
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    }
    UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).waitForIdle()

    activityRule.scenario.onActivity { activity ->
      assertTrue(firstHost === activity.host)
      assertTrue(firstWebView === activity.currentWebView())
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
  }
}

@RunWith(AndroidJUnit4::class)
class CanvasHostReleaseTest {
  @Before
  fun resetMetrics() {
    CanvasLifecycleTestMetrics.reset()
  }

  @Test
  fun activityTeardownReleasesTheHostAndWebView() {
    ActivityScenario.launch(CanvasLifecycleTestActivity::class.java).use { scenario ->
      scenario.onActivity { activity -> activity.presentFastPage() }
    }

    assertTrue(
      "AndroidView onRelease was not called",
      waitUntil { CanvasLifecycleTestMetrics.hostReleaseCount.get() == 1 },
    )
    assertEquals(1, CanvasLifecycleTestMetrics.webViewDestroyCount.get())
  }
}

private inline fun <T> ActivityScenario<CanvasLifecycleTestActivity>.readActivity(crossinline block: (CanvasLifecycleTestActivity) -> T): T {
  var result: Result<T>? = null
  onActivity { activity -> result = runCatching { block(activity) } }
  return checkNotNull(result).getOrThrow()
}

private fun ActivityScenario<CanvasLifecycleTestActivity>.waitForPageFinished(): Boolean = waitUntilActivity { activity -> activity.currentWebView()?.progress == 100 }

private inline fun ActivityScenario<CanvasLifecycleTestActivity>.waitUntilActivity(
  timeoutMs: Long = 5_000L,
  crossinline predicate: (CanvasLifecycleTestActivity) -> Boolean,
): Boolean =
  waitUntil(timeoutMs) {
    readActivity(predicate)
  }

private fun waitUntil(
  timeoutMs: Long = 5_000L,
  predicate: () -> Boolean,
): Boolean {
  val deadline = SystemClock.elapsedRealtime() + timeoutMs
  while (SystemClock.elapsedRealtime() < deadline) {
    if (predicate()) return true
    SystemClock.sleep(20)
  }
  return predicate()
}
