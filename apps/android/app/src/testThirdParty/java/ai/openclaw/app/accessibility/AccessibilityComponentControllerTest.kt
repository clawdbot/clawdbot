package ai.openclaw.app.accessibility

import android.content.ComponentName
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class AccessibilityComponentControllerTest {
  @Test
  fun componentState_mapsEnabledAndDisabled() {
    assertEquals(
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      accessibilityComponentEnabledState(enabled = true),
    )
    assertEquals(
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      accessibilityComponentEnabledState(enabled = false),
    )
  }

  @Test
  fun setEnabled_updatesServiceAndDevActivity() {
    val context = RuntimeEnvironment.getApplication()
    val packageManager = context.packageManager
    val service = ComponentName(context, OpenClawAccessibilityService::class.java)
    val activity = ComponentName(context, AccessibilityDevActivity::class.java)
    val controller = AccessibilityComponentController(context)

    controller.setEnabled(true)

    assertEquals(
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      packageManager.getComponentEnabledSetting(service),
    )
    assertEquals(
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      packageManager.getComponentEnabledSetting(activity),
    )

    controller.setEnabled(false)

    assertEquals(
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      packageManager.getComponentEnabledSetting(service),
    )
    assertEquals(
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      packageManager.getComponentEnabledSetting(activity),
    )
  }
}
