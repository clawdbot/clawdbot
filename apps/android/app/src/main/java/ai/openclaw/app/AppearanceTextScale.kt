package ai.openclaw.app

/** Local-only OpenClaw text scaling; Android's system font scale remains additive. */
enum class AppearanceTextScale(
  val rawValue: String,
  val displayLabel: String,
  val factor: Float,
) {
  Small(rawValue = "small", displayLabel = "Small", factor = 0.90f),
  Standard(rawValue = "standard", displayLabel = "Standard", factor = 1.00f),
  Large(rawValue = "large", displayLabel = "Large", factor = 1.15f),
  ;

  companion object {
    fun fromRawValue(value: String?): AppearanceTextScale = entries.firstOrNull { it.rawValue == value?.trim()?.lowercase() } ?: Small

    fun fromDisplayLabel(label: String): AppearanceTextScale = entries.firstOrNull { it.displayLabel.equals(label.trim(), ignoreCase = true) } ?: Small
  }
}
