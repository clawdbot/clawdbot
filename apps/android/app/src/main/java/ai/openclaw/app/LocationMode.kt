package ai.openclaw.app

enum class LocationMode(
  val rawValue: String,
) {
  Off("off"),
  WhileUsing("whileUsing"),
  ;

  companion object {
    fun fromRawValue(raw: String?): LocationMode {
      val normalized = raw?.trim()?.lowercase()
      if (normalized == "always") return WhileUsing
      return entries.firstOrNull { it.rawValue.lowercase() == normalized } ?: Off
    }
  }
}
