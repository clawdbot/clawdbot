package bot.molt.android

enum class LocationMode(val rawValue: String) {
  Off("off"),
  WhileUsing("whileUsing"),
  Always("always"),
  ;

  companion object {
    fun fromRawValue(raw: String?): LocationMode {
      val normalized = raw?.trim()?.lowercase()
      return entries.firstOrNull { it.rawValue.lowercase() == normalized } ?: Off
    }
  }
}
