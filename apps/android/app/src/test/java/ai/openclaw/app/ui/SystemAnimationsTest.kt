package ai.openclaw.app.ui

import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.MotionDurationScale
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class SystemAnimationsTest {
  private val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)

  private fun idleMainLooper() = shadowOf(Looper.getMainLooper()).idle()

  @Test
  fun followsComposeMotionDurationScaleWhileComposed() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val motionDurationScale = FakeMotionDurationScale(initialScale = 1f)
    val observed = mutableListOf<Boolean>()

    controller.get().setContent {
      val enabled = rememberSystemAnimationsEnabled(motionDurationScale)
      SideEffect { observed.add(enabled) }
    }
    idleMainLooper()
    assertEquals(true, observed.last())

    motionDurationScale.scaleFactor = 0f
    idleMainLooper()
    assertEquals(false, observed.last())

    motionDurationScale.scaleFactor = 1f
    idleMainLooper()
    assertEquals(true, observed.last())
  }

  @Test
  fun productionMotionScaleTracksAndroidSetting() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    val originalScale = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    val observed = mutableListOf<Boolean>()
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)

    try {
      controller.get().setContent {
        val enabled = rememberSystemAnimationsEnabled()
        SideEffect { observed.add(enabled) }
      }
      idleMainLooper()
      assertEquals(false, observed.first())
      assertEquals(false, observed.last())

      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
      resolver.notifyChange(uri, null)
      idleMainLooper()
      assertEquals(true, observed.last())

      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      resolver.notifyChange(uri, null)
      idleMainLooper()
      assertEquals(false, observed.last())
    } finally {
      controller.pause().stop().destroy()
      idleMainLooper()
      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private class FakeMotionDurationScale(
    initialScale: Float,
  ) : MotionDurationScale {
    override var scaleFactor by mutableFloatStateOf(initialScale)
  }
}
