package ai.openclaw.wear

import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.wear.compose.material3.AppScaffold

internal const val extraWearScreenshotMode = "openclaw.screenshotMode"
internal const val extraWearScreenshotScene = "openclaw.screenshotScene"

internal enum class WearScreenshotScene(
  val rawValue: String,
  val initialPage: WearHomePage,
) {
  Chat("chat", WearHomePage.Chat),
  Voice("voice", WearHomePage.Voice),
  Controls("controls", WearHomePage.Controls),
  ;

  companion object {
    fun fromRawValue(raw: String?): WearScreenshotScene = entries.firstOrNull { scene -> scene.rawValue == raw?.trim()?.lowercase() } ?: Chat
  }
}

internal fun parseWearScreenshotModeIntent(intent: Intent?): WearScreenshotScene? {
  if (intent?.getBooleanExtra(extraWearScreenshotMode, false) != true) return null
  return WearScreenshotScene.fromRawValue(intent.getStringExtra(extraWearScreenshotScene))
}

internal object WearScreenshotFixture {
  val snapshot =
    WearConversationSnapshot(
      gatewayState = WearGatewayState.CONNECTED,
      activeAgentId = "main",
      agents =
        listOf(
          WearAgentSummary(
            id = "main",
            name = "Molty",
            emoji = "M",
            selected = true,
          ),
        ),
      agentControlsSupported = true,
      gatewayControlsSupported = true,
      activeSessionId = "release-planning",
      sessions =
        listOf(
          WearSessionSummary(
            id = "release-planning",
            title = "Release planning",
            updatedAtEpochMillis = 1_783_555_320_000,
            selected = true,
          ),
        ),
      models =
        listOf(
          WearModelSummary(
            ref = "openai/gpt-5.2",
            name = "GPT-5.2",
            selected = true,
          ),
        ),
      modelControlsSupported = true,
      messages =
        listOf(
          WearChatMessage(
            id = "release-question",
            role = "user",
            text = "Is the Android release ready?",
            timestamp = 1_783_555_260_000,
          ),
          WearChatMessage(
            id = "release-answer",
            role = "assistant",
            text = "Ready after the final store checks.",
            timestamp = 1_783_555_320_000,
          ),
        ),
      selectedModelRef = "openai/gpt-5.2",
    )
}

@Composable
internal fun OpenClawWearScreenshotApp(scene: WearScreenshotScene) {
  OpenClawWearTheme(themeMode = WearThemeMode.Dark) {
    AppScaffold {
      OpenClawWearScreens(
        snapshot = WearScreenshotFixture.snapshot,
        failure = null,
        loading = false,
        interaction = WearInteractionState.READY,
        speaking = false,
        realtimeCapturing = false,
        realtimePlaying = false,
        realtimeMouthLevel = 0f,
        realtimePlaybackFailed = false,
        realtimeThinkingOverride = false,
        actionBusy = false,
        inputEnabled = true,
        canAbort = false,
        themeMode = WearThemeMode.Dark,
        autoSpeak = false,
        notificationsGranted = true,
        initialPage = scene.initialPage,
        voiceSwipeHintEnabled = false,
        onTalk = {},
        onType = {},
        onRealtimeTalk = {},
        onAbort = {},
        onSelectAgent = {},
        onSelectSession = {},
        onSelectModel = {},
        onRefresh = {},
        onGatewayEnabledChange = {},
        onThemeModeChange = {},
        onAutoSpeakChange = {},
        onRequestNotifications = {},
        onOpenNotificationSettings = {},
        onSpeakLatest = {},
        onStopSpeaking = {},
      )
    }
  }
}
