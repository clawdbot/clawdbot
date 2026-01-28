package bot.molt.android

import android.content.Context
import android.os.Build
import android.provider.Settings

object DeviceNames {
  fun bestDefaultNodeName(context: Context): String {
    val deviceName =
      runCatching {
          Settings.Global.getString(context.contentResolver, "device_name")
        }
        .getOrNull()
        ?.trim()
        .orEmpty()

    if (deviceName.isNotEmpty()) return deviceName

    val model =
      listOfNotNull(Build.MANUFACTURER?.takeIf { it.isNotBlank() }, Build.MODEL?.takeIf { it.isNotBlank() })
        .joinToString(" ")
        .trim()

    return model.ifEmpty { "Android Node" }
  }
}
