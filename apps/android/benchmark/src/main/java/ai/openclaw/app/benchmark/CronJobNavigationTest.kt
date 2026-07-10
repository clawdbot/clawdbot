package ai.openclaw.app.benchmark

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CronJobNavigationTest {
  private lateinit var device: UiDevice

  @Before
  fun setUp() {
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    device.executeShellCommand("am force-stop $packageName")
    device.executeShellCommand(
      "am start -W -n $packageName/.MainActivity " +
        "--ez openclaw.screenshotMode true --es openclaw.screenshotScene settings",
    )
    assertNotNull(device.wait(Until.findObject(By.text("Settings")), waitTimeoutMs))
  }

  @Test
  fun opensCronJobFixtureDetail() {
    findTextAfterScrolling("Cron Jobs").click()

    val cronJobLabel = findTextAfterScrolling("Android release digest")
    val cronJobRow =
      checkNotNull(
        generateSequence(cronJobLabel) { it.parent }
          .firstOrNull { it.isClickable },
      ) { "Cron fixture row must expose a click action" }
    assertTrue("Cron fixture row must expose a click action", cronJobRow.isClickable)
    assertFalse(device.hasObject(By.text("Inspect scheduled gateway work.")))
    cronJobRow.click()

    assertNotNull(device.wait(Until.findObject(By.text("Inspect scheduled gateway work.")), waitTimeoutMs))
    assertNotNull(findTextAfterScrolling("Run Now"))
    assertNotNull(findTextAfterScrolling("Recent Runs"))
    assertNotNull(findTextAfterScrolling("Release checklist ready", exact = false))
    assertNotNull(findTextAfterScrolling("OK"))
    assertNotNull(findTextAfterScrolling("Play publish blocked", exact = false))
    assertNotNull(findTextAfterScrolling("Issue"))
  }

  private fun findTextAfterScrolling(
    text: String,
    exact: Boolean = true,
  ): UiObject2 {
    val selector = if (exact) By.text(text) else By.textContains(text)
    repeat(maxScrolls + 1) { attempt ->
      device.wait(Until.findObject(selector), shortWaitMs)?.let { return it }
      if (attempt < maxScrolls) {
        device.swipe(
          device.displayWidth / 2,
          (device.displayHeight * 0.8f).toInt(),
          device.displayWidth / 2,
          (device.displayHeight * 0.25f).toInt(),
          24,
        )
        device.waitForIdle()
      }
    }
    error("Could not find UI text: $text")
  }

  private companion object {
    const val packageName = "ai.openclaw.app"
    const val waitTimeoutMs = 10_000L
    const val shortWaitMs = 1_000L
    const val maxScrolls = 6
  }
}
