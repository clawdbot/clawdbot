package ai.openclaw.app.ui.popup

import ai.openclaw.app.NodeApp
import ai.openclaw.app.ui.OpenClawTheme
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier

/**
 * Locked-screen takeover host for `system.notify` calls with `delivery: "overlay"`.
 * Launched over the lock screen via a full-screen-intent notification (see SystemHandler)
 * so a message you shouldn't miss (e.g. while driving) can't be swiped away like a normal one.
 * While unlocked, PopupOverlayWindow is used instead — see SystemHandler.resolvePopupDeliveryMode.
 */
class PopupOverlayActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
    val subtitle = intent.getStringExtra(EXTRA_SUBTITLE)
    val body = intent.getStringExtra(EXTRA_BODY).orEmpty()
    val timestampMillis = intent.getLongExtra(EXTRA_TIMESTAMP_MILLIS, System.currentTimeMillis())
    val app = application as NodeApp
    val prefs = app.prefs

    setContent {
      val opacity by prefs.popupOpacity.collectAsState()
      val autoDismissSeconds by prefs.popupAutoDismissSeconds.collectAsState()
      val cardColor by prefs.popupCardColor.collectAsState()
      val cornerRadiusDp by prefs.popupCardCornerRadiusDp.collectAsState()

      OpenClawTheme {
        PopupOverlayContent(
          title = title,
          subtitle = subtitle,
          body = body,
          timestampMillis = timestampMillis,
          cardColorArgb = cardColor,
          opacity = opacity,
          cornerRadiusDp = cornerRadiusDp,
          autoDismissSeconds = autoDismissSeconds,
          cardWidthModifier = Modifier.fillMaxWidth(0.9f),
          showScrimBackdrop = true,
          enableBackHandler = true,
          speaker = app.popupSpeechSpeaker,
          onDismiss = { finish() },
        )
      }
    }
  }

  companion object {
    private const val EXTRA_TITLE = "ai.openclaw.app.popup.EXTRA_TITLE"
    private const val EXTRA_SUBTITLE = "ai.openclaw.app.popup.EXTRA_SUBTITLE"
    private const val EXTRA_BODY = "ai.openclaw.app.popup.EXTRA_BODY"
    private const val EXTRA_TIMESTAMP_MILLIS = "ai.openclaw.app.popup.EXTRA_TIMESTAMP_MILLIS"

    /** Builds the takeover intent a full-screen-intent notification launches. */
    fun launchIntent(
      context: Context,
      title: String,
      subtitle: String?,
      body: String,
      timestampMillis: Long?,
    ): Intent =
      Intent(context, PopupOverlayActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(EXTRA_TITLE, title)
        subtitle?.let { putExtra(EXTRA_SUBTITLE, it) }
        putExtra(EXTRA_BODY, body)
        putExtra(EXTRA_TIMESTAMP_MILLIS, timestampMillis ?: System.currentTimeMillis())
      }
  }
}
