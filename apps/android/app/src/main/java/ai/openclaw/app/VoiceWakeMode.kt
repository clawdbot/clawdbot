package ai.openclaw.app

/**
 * Persisted wake-word mode; raw values are stored in secure preferences.
 */
enum class VoiceWakeMode(
  val rawValue: String,
) {
  Off("off"),
  Foreground("foreground"),
  Always("always"),
  ;

  companion object {
    /**
     * Invalid stored values fall back to foreground wake so hands-free behavior stays opt-in.
     */
    fun fromRawValue(raw: String?): VoiceWakeMode = entries.firstOrNull { it.rawValue == raw?.trim()?.lowercase() } ?: Foreground
  }
}
