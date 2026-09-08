package ai.openclaw.app

/** Profile-synced OpenClaw theme families supported by the official Web UI. */
enum class AppearanceThemeFamily(
  val rawValue: String,
  val displayLabel: String,
  val previewAccentArgb: Long,
  val previewSecondaryArgb: Long,
  val previewCanvasArgb: Long,
) {
  Claw("claw", "Claw", 0xFFFF5C5C, 0xFF14B8A6, 0xFF0E1015),
  Knot("knot", "Knot", 0xFFE5243B, 0xFFB8BDC4, 0xFF080808),
  Dash("dash", "Dash", 0xFFCF8B4D, 0xFFDCB878, 0xFF1A1210),
  Absolutely("absolutely", "Absolutely", 0xFFD97757, 0xFFB8926A, 0xFF1C1C1A),
  Tide("tide", "Tide", 0xFF5AB6D8, 0xFF7F9BB5, 0xFF10151B),
  Beacon("beacon", "Beacon", 0xFFFFC233, 0xFF8ECDFF, 0xFF000000),
  Phosphor("phosphor", "Phosphor", 0xFF4ADE80, 0xFF8FD6A5, 0xFF0A0F0A),
  Crt("crt", "CRT", 0xFF3AFF7D, 0xFFFFCF5C, 0xFF090A09),
  Manuscript("manuscript", "Manuscript", 0xFF8FA8E0, 0xFFCFA85E, 0xFF211E18),
  Rose("rose", "Ros\u00E9", 0xFFEBBCBA, 0xFFF6C177, 0xFF191724),
  Miami("miami", "Miami", 0xFFF472B6, 0xFF5FD7E8, 0xFF140F1E),
  ;

  companion object {
    fun fromRawValue(value: String?): AppearanceThemeFamily = entries.firstOrNull { it.rawValue == value?.trim()?.lowercase() } ?: Claw
  }
}

internal val appearanceAccentPalette: List<Long> =
  listOf(
    0xFFFFC233,
    0xFFFF5C5C,
    0xFFFF7F6B,
    0xFFF2B84B,
    0xFF5CCFA5,
    0xFF3CB8B0,
    0xFF5A9BEF,
    0xFF9B7AEF,
    0xFFE96CB7,
  )

internal fun appearanceAccentPreferenceValue(argb: Long?): String? = argb?.let { String.format("#%06x", it and 0xFFFFFF) }
