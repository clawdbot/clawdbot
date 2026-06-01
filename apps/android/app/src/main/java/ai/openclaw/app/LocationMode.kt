package ai.openclaw.app

/**
 * Persisted location capture mode advertised to the gateway.
 */
enum class LocationMode(
  val rawValue: String,
) {
  Off("off"),
  WhileUsing("whileUsing"),
  ;

  companion object {
    /** Parses persisted location mode text while migrating old always-on configs to while-using. */
    fun fromRawValue(raw: String?): LocationMode {
      val normalized = raw?.trim()?.lowercase()
      // Older configs used "always"; Android node currently exposes while-using location only.
      if (normalized == "always") return WhileUsing
      return entries.firstOrNull { it.rawValue.lowercase() == normalized } ?: Off
    }
  }
}
