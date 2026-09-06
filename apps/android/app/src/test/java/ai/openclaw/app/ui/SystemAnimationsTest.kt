package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.TalkWaveform
import ai.openclaw.app.ui.design.TalkWaveformPhase
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class SystemAnimationsTest {
  // Keep ActivityController lifecycle coverage while synchronizing Compose snapshots and frames.
  @get:Rule
  val composeRule = createEmptyComposeRule()

  private val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)

  private fun idleMainLooper() = shadowOf(Looper.getMainLooper()).idle()

  @Test
  fun reflectsAnimatorDurationScaleChangesWhileComposed() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    val originalScale = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    val observed = mutableListOf<Boolean>()
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

    try {
      controller.get().setContent {
        val enabled = rememberSystemAnimationsEnabled()
        SideEffect { observed.add(enabled) }
      }
      composeRule.waitForIdle()
      assertEquals(true, observed.last())

      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      resolver.notifyChange(uri, null)
      composeRule.waitForIdle()
      assertEquals(false, observed.last())

      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
      resolver.notifyChange(uri, null)
      composeRule.waitForIdle()
      assertEquals(true, observed.last())
    } finally {
      controller.pause().stop().destroy()
      idleMainLooper()
      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  @Test
  fun initialCompositionRespectsDisabledAnimations() {
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
      composeRule.waitForIdle()
      assertEquals(false, observed.first())
      assertEquals(false, observed.last())
    } finally {
      controller.pause().stop().destroy()
      idleMainLooper()
      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  @Test
  fun unregistersObserverOnDispose() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver

    controller.get().setContent { rememberSystemAnimationsEnabled() }
    composeRule.waitForIdle()
    assertTrue(shadowOf(resolver).getContentObservers(uri).isNotEmpty())

    controller.pause().stop().destroy()
    idleMainLooper()
    assertTrue(shadowOf(resolver).getContentObservers(uri).isEmpty())
  }

  @Test
  fun mascotAndWaveformObserveTheReducedMotionSetting() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    val originalScale = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)

    try {
      controller.get().setContent {
        OpenClawMascot()
        TalkWaveform(phase = TalkWaveformPhase.Idle)
      }
      composeRule.waitForIdle()

      assertEquals(2, shadowOf(resolver).getContentObservers(uri).size)
    } finally {
      controller.pause().stop().destroy()
      idleMainLooper()
      Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }
}
