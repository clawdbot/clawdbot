package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.TalkWaveform
import ai.openclaw.app.ui.design.TalkWaveformPhase
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.SideEffect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
  fun reflectsAnimatorDurationScaleChangesWhileComposed() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    val observed = mutableListOf<Boolean>()

    controller.get().setContent {
      val enabled = rememberSystemAnimationsEnabled()
      SideEffect { observed.add(enabled) }
    }
    idleMainLooper()
    assertEquals(true, observed.last())

    // User turns "remove animations" on while the screen stays mounted.
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    resolver.notifyChange(uri, null)
    idleMainLooper()
    assertEquals(false, observed.last())

    // And back off again.
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    resolver.notifyChange(uri, null)
    idleMainLooper()
    assertEquals(true, observed.last())
  }

  @Test
  fun unregistersObserverOnDispose() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver

    controller.get().setContent { rememberSystemAnimationsEnabled() }
    idleMainLooper()
    assertTrue(shadowOf(resolver).getContentObservers(uri).isNotEmpty())

    controller.pause().stop().destroy()
    idleMainLooper()
    assertTrue(shadowOf(resolver).getContentObservers(uri).isEmpty())
  }

  @Test
  fun mascotAndWaveformObserveTheReducedMotionSetting() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    // Disable animations so both composables settle in their static branch (no frame loop).
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)

    controller.get().setContent {
      OpenClawMascot()
      TalkWaveform(phase = TalkWaveformPhase.Idle)
    }
    idleMainLooper()

    // Each composable wires a reactive observer on the animator-scale setting;
    // before the shared helper they used a one-shot read and registered none.
    assertEquals(2, shadowOf(resolver).getContentObservers(uri).size)
  }
}
