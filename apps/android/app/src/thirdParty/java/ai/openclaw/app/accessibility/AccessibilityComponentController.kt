package ai.openclaw.app.accessibility

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

internal class AccessibilityComponentController(
  context: Context,
) {
  private val appContext = context.applicationContext
  private val components =
    listOf(
      ComponentName(appContext, OpenClawAccessibilityService::class.java),
      ComponentName(appContext, AccessibilityDevActivity::class.java),
    )

  fun setEnabled(enabled: Boolean) {
    val state = accessibilityComponentEnabledState(enabled)
    components.forEach { component ->
      appContext.packageManager.setComponentEnabledSetting(
        component,
        state,
        PackageManager.DONT_KILL_APP,
      )
    }
  }
}

internal fun accessibilityComponentEnabledState(enabled: Boolean): Int =
  if (enabled) {
    PackageManager.COMPONENT_ENABLED_STATE_ENABLED
  } else {
    PackageManager.COMPONENT_ENABLED_STATE_DISABLED
  }
