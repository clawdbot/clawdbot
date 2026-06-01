package ai.openclaw.app

import android.content.Context
import android.os.Build
import android.provider.Settings

object DeviceNames {
  /** Prefers the user-visible Android device name, then falls back to manufacturer/model text. */
  fun bestDefaultNodeName(context: Context): String {
    val deviceName =
      runCatching {
        Settings.Global.getString(context.contentResolver, "device_name")
      }.getOrNull()
        ?.trim()
        .orEmpty()

    if (deviceName.isNotEmpty()) return deviceName

    // Manufacturer/model are best-effort platform fields; keep the final
    // fallback stable so stored default names do not become blank.
    val model =
      listOfNotNull(Build.MANUFACTURER?.takeIf { it.isNotBlank() }, Build.MODEL?.takeIf { it.isNotBlank() })
        .joinToString(" ")
        .trim()

    return model.ifEmpty { "Android Node" }
  }
}
