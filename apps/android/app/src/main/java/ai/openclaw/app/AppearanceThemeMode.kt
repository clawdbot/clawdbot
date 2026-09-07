package ai.openclaw.app

/** User-selectable app theme mode for Android appearance settings. */
enum class AppearanceThemeMode(
  val rawValue: String,
) {
  System(rawValue = "system"),
  Dark(rawValue = "dark"),
  Light(rawValue = "light"),
  ;

  fun isDark(systemDark: Boolean): Boolean =
    when (this) {
      System -> systemDark
      Dark -> true
      Light -> false
    }

  companion object {
    fun fromRawValue(value: String?): AppearanceThemeMode = entries.firstOrNull { it.rawValue == value?.trim()?.lowercase() } ?: Dark
  }
}
