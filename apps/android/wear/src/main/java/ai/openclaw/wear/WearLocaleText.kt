package ai.openclaw.wear

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import java.util.Locale

@Composable
internal fun localizedWearUppercase(value: String): String = wearUppercase(value, LocalConfiguration.current.locales[0])

internal fun wearUppercase(
  value: String,
  locale: Locale = Locale.getDefault(),
): String = value.uppercase(locale)
