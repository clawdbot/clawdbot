package ai.openclaw.app

enum class VoiceWakeMode(
  val rawValue: String,
) {
  Off("off"),
  Foreground("foreground"),
  Always("always"),
  ;

  companion object {
    fun fromRawValue(raw: String?): VoiceWakeMode = entries.firstOrNull { it.rawValue == raw?.trim()?.lowercase() } ?: Foreground
  }
}
