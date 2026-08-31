package ai.openclaw.wear

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.core.content.edit
import androidx.wear.compose.material3.MaterialTheme

internal enum class WearThemeMode(
  val rawValue: String,
) {
  Dark(rawValue = "dark"),
  Light(rawValue = "light"),
  ;

  companion object {
    fun fromRawValue(value: String?): WearThemeMode = entries.firstOrNull { mode -> mode.rawValue == value?.trim()?.lowercase() } ?: Dark
  }
}

internal data class WearSettings(
  val themeMode: WearThemeMode,
  val autoSpeak: Boolean,
)

internal class WearSettingsStore internal constructor(
  private val preferences: SharedPreferences,
) {
  constructor(context: Context) :
    this(
      context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
      ),
    )

  fun read(): WearSettings =
    WearSettings(
      themeMode = WearThemeMode.fromRawValue(preferences.getString(THEME_MODE_KEY, null)),
      autoSpeak = preferences.getBoolean(AUTO_SPEAK_KEY, DEFAULT_AUTO_SPEAK),
    )

  fun writeThemeMode(mode: WearThemeMode) {
    preferences.edit {
      putString(THEME_MODE_KEY, mode.rawValue)
    }
  }

  fun writeAutoSpeak(enabled: Boolean) {
    preferences.edit {
      putBoolean(AUTO_SPEAK_KEY, enabled)
    }
  }

  private companion object {
    // One Watch-owned store is the durable owner for local UI preferences. These
    // keys have not shipped in a tagged release, so defaults are the only upgrade path.
    const val DEFAULT_AUTO_SPEAK = false
    const val PREFERENCES_NAME = "openclaw.wear.settings"
    const val THEME_MODE_KEY = "appearance.themeMode"
    const val AUTO_SPEAK_KEY = "conversation.autoSpeak"
  }
}

@Immutable
internal data class WearColors(
  val canvas: Color,
  val surface: Color,
  val surfaceRaised: Color,
  val surfacePressed: Color,
  val border: Color,
  val borderStrong: Color,
  val text: Color,
  val textMuted: Color,
  val primary: Color,
  val primaryText: Color,
  val voiceAccent: Color,
  val voiceAccentSoft: Color,
  val onVoiceAccent: Color,
  val success: Color,
  val warning: Color,
  val danger: Color,
)

// Keep the companion surfaces aligned with the canonical Phone ClawTheme.
// Voice blue comes from the Phone MobileUiTokens and is intentionally not the
// general control or panel color.
private val DarkWearColors =
  WearColors(
    canvas = Color(0xFF030303),
    surface = Color(0xFF0A0A0A),
    surfaceRaised = Color(0xFF111111),
    surfacePressed = Color(0xFF1A1A1A),
    border = Color(0xFF242424),
    borderStrong = Color(0xFF3A3A3A),
    text = Color(0xFFF8F8F8),
    textMuted = Color(0xFFA8A8A8),
    primary = Color(0xFFFFFFFF),
    primaryText = Color(0xFF050505),
    voiceAccent = Color(0xFF6EA8FF),
    voiceAccentSoft = Color(0xFF1A2A44),
    onVoiceAccent = Color(0xFF050505),
    success = Color(0xFF3EDB82),
    warning = Color(0xFFE6B956),
    danger = Color(0xFFFF6B6B),
  )

private val LightWearColors =
  WearColors(
    canvas = Color(0xFFFAFBFC),
    surface = Color(0xFFFFFEFB),
    surfaceRaised = Color(0xFFFFFFFF),
    surfacePressed = Color(0xFFE9EDF3),
    border = Color(0xFFDDE3EC),
    borderStrong = Color(0xFFC7D0DC),
    text = Color(0xFF111318),
    textMuted = Color(0xFF505865),
    primary = Color(0xFF111827),
    primaryText = Color(0xFFFFFFFF),
    voiceAccent = Color(0xFF1B5ACB),
    voiceAccentSoft = Color(0xFFEAF2FF),
    onVoiceAccent = Color(0xFFFFFFFF),
    success = Color(0xFF217747),
    warning = Color(0xFFA56F17),
    danger = Color(0xFFB82929),
  )

internal fun wearColorsFor(themeMode: WearThemeMode): WearColors =
  when (themeMode) {
    WearThemeMode.Dark -> DarkWearColors
    WearThemeMode.Light -> LightWearColors
  }

private val LocalWearColors = staticCompositionLocalOf { DarkWearColors }

internal object OpenClawWearTheme {
  val colors: WearColors
    @Composable
    @ReadOnlyComposable
    get() = LocalWearColors.current
}

@Composable
internal fun OpenClawWearTheme(
  themeMode: WearThemeMode,
  content: @Composable () -> Unit,
) {
  val colors = wearColorsFor(themeMode)
  val colorScheme =
    MaterialTheme.colorScheme.copy(
      primary = colors.primary,
      primaryContainer = colors.surfaceRaised,
      onPrimary = colors.primaryText,
      onPrimaryContainer = colors.text,
      surfaceContainerLow = colors.surface,
      surfaceContainer = colors.surface,
      surfaceContainerHigh = colors.surfaceRaised,
      onSurface = colors.text,
      onSurfaceVariant = colors.textMuted,
      outline = colors.borderStrong,
      outlineVariant = colors.border,
      background = colors.canvas,
      onBackground = colors.text,
      error = colors.danger,
      onError = colors.primaryText,
    )

  MaterialTheme(colorScheme = colorScheme) {
    CompositionLocalProvider(
      LocalWearColors provides colors,
      content = content,
    )
  }
}
