package ai.openclaw.app

/**
 * Persisted location capture mode advertised to the gateway.
 */
enum class LocationMode(
  val rawValue: String,
) {
  Off("off"),
  WhileUsing("whileUsing"),
  Always("always"),
  ;

  companion object {
    /** Parses persisted location mode text. */
    fun fromRawValue(raw: String?): LocationMode {
      val normalized = raw?.trim()?.lowercase()
      return entries.firstOrNull { it.rawValue.lowercase() == normalized } ?: Off
    }
  }
}

/** Resolves the in-app mode after Android's external background-location settings return. */
internal fun locationModeAfterBackgroundSettings(
  previousMode: LocationMode,
  foregroundGranted: Boolean,
  backgroundGranted: Boolean,
): LocationMode =
  when {
    foregroundGranted && backgroundGranted -> LocationMode.Always
    !foregroundGranted -> LocationMode.Off
    previousMode == LocationMode.Always -> LocationMode.WhileUsing
    else -> previousMode
  }
