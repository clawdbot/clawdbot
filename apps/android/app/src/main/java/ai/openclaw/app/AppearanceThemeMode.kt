package ai.openclaw.app

/** User-selectable app theme mode for Android appearance settings. */
enum class AppearanceThemeMode(
  val rawValue: String,
  val displayLabel: String,
) {
  System(rawValue = "system", displayLabel = "System"),
  Dark(rawValue = "dark", displayLabel = "Dark"),
  Light(rawValue = "light", displayLabel = "Light"),
  ;

  fun isDark(systemDark: Boolean): Boolean =
    when (this) {
      System -> systemDark
      Dark -> true
      Light -> false
    }

  companion object {
    fun fromRawValue(value: String?): AppearanceThemeMode = entries.firstOrNull { it.rawValue == value?.trim()?.lowercase() } ?: Dark

    fun fromDisplayLabel(label: String): AppearanceThemeMode = entries.firstOrNull { it.displayLabel.equals(label.trim(), ignoreCase = true) } ?: Dark
  }
}
