package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context

internal fun testDeviceIdentityStore(context: Context): DeviceIdentityStore {
  val backing =
    context.getSharedPreferences(
      "openclaw.node.secure.test.device-identity",
      Context.MODE_PRIVATE,
    )
  return DeviceIdentityStore.withPrefs(
    context,
    SecurePrefs(context, securePrefsOverride = backing),
  )
}
