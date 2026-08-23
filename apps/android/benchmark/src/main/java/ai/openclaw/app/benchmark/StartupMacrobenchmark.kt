package ai.openclaw.app.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StartupMacrobenchmark {
  @get:Rule
  val benchmarkRule = MacrobenchmarkRule()

  private val packageName = "ai.openclaw.app"

  @Test
  fun coldStartup() {
    runBenchmarkOrSkip {
      benchmarkRule.measureRepeated(
        packageName = packageName,
        metrics = listOf(StartupTimingMetric()),
        startupMode = StartupMode.COLD,
        compilationMode = CompilationMode.None(),
        iterations = 10,
      ) {
        pressHome()
        startActivityAndWait()
      }
    }
  }

  @Test
  fun startupAndScrollFrameTiming() {
    runBenchmarkOrSkip {
      benchmarkRule.measureRepeated(
        packageName = packageName,
        metrics = listOf(FrameTimingMetric()),
        startupMode = StartupMode.WARM,
        compilationMode = CompilationMode.None(),
        iterations = 10,
      ) {
        startActivityAndWait()
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val x = device.displayWidth / 2
        val yStart = (device.displayHeight * 0.8f).toInt()
        val yEnd = (device.displayHeight * 0.25f).toInt()
        repeat(4) {
          device.swipe(x, yStart, x, yEnd, 24)
          device.waitForIdle()
        }
      }
    }
  }

  private fun runBenchmarkOrSkip(run: () -> Unit) {
    try {
      run()
    } catch (err: IllegalStateException) {
      val message = err.message.orEmpty()
      val knownDeviceIssue =
        message.contains("Unable to confirm activity launch completion") ||
          message.contains("no renderthread slices", ignoreCase = true)
      if (knownDeviceIssue) {
        assumeTrue("Skipping benchmark on this device: $message", false)
      }
      throw err
    }
  }
}
