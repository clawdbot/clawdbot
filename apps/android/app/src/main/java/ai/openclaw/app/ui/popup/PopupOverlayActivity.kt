package ai.openclaw.app.ui.popup

import ai.openclaw.app.NodeApp
import ai.openclaw.app.ui.OpenClawTheme
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.delay

/**
 * Full-screen takeover popup for `system.notify` calls with `delivery: "overlay"`.
 * Launched over the lock screen via a full-screen-intent notification (see SystemHandler)
 * so a message you shouldn't miss (e.g. while driving) can't be swiped away like a normal one.
 */
class PopupOverlayActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
    val subtitle = intent.getStringExtra(EXTRA_SUBTITLE)
    val body = intent.getStringExtra(EXTRA_BODY).orEmpty()
    val timestampMillis = intent.getLongExtra(EXTRA_TIMESTAMP_MILLIS, System.currentTimeMillis())
    val prefs = (application as NodeApp).prefs

    setContent {
      val backgroundImageUris by prefs.popupBackgroundImageUris.collectAsState()
      val opacity by prefs.popupOpacity.collectAsState()
      val autoDismissSeconds by prefs.popupAutoDismissSeconds.collectAsState()
      val backgroundImageUri = remember(backgroundImageUris) { backgroundImageUris.randomOrNull() }

      OpenClawTheme {
        PopupOverlayScreen(
          title = title,
          subtitle = subtitle,
          body = body,
          timestampMillis = timestampMillis,
          backgroundImageUri = backgroundImageUri,
          opacity = opacity,
          autoDismissSeconds = autoDismissSeconds,
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

/** Entering -> Visible is the slide-in/fade-in; Visible -> Exiting is the slide-out/fade-out before finish(). */
private enum class PopupPhase { Entering, Visible, Exiting }

private const val ENTER_ANIMATION_MS = 260
private const val EXIT_ANIMATION_MS = 260L

@Composable
private fun PopupOverlayScreen(
  title: String,
  subtitle: String?,
  body: String,
  timestampMillis: Long,
  backgroundImageUri: String?,
  opacity: Float,
  autoDismissSeconds: Int,
  onDismiss: () -> Unit,
) {
  var phase by remember { mutableStateOf(PopupPhase.Entering) }

  LaunchedEffect(Unit) { phase = PopupPhase.Visible }

  LaunchedEffect(phase, autoDismissSeconds) {
    if (phase == PopupPhase.Visible) {
      delay(autoDismissSeconds * 1_000L)
      phase = PopupPhase.Exiting
    }
  }

  LaunchedEffect(phase) {
    if (phase == PopupPhase.Exiting) {
      delay(EXIT_ANIMATION_MS)
      onDismiss()
    }
  }

  BackHandler(enabled = phase == PopupPhase.Visible) { phase = PopupPhase.Exiting }

  AnimatedVisibility(
    visible = phase == PopupPhase.Visible,
    enter = slideInVertically(animationSpec = tween(ENTER_ANIMATION_MS)) { it / 3 } + fadeIn(tween(ENTER_ANIMATION_MS)),
    exit = slideOutVertically(animationSpec = tween(EXIT_ANIMATION_MS.toInt())) { it / 3 } + fadeOut(tween(EXIT_ANIMATION_MS.toInt())),
  ) {
    Box(
      modifier =
        Modifier
          .fillMaxSize()
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
          ) { phase = PopupPhase.Exiting },
    ) {
      backgroundImageUri?.let { uri ->
        AsyncImage(
          model = uri,
          contentDescription = null,
          modifier = Modifier.fillMaxSize(),
          contentScale = ContentScale.Crop,
        )
      }
      Box(
        modifier =
          Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = opacity)),
      )
      Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.Center,
      ) {
        Text(
          text = title.uppercase(),
          color = Color.White.copy(alpha = 0.75f),
          fontSize = 15.sp,
          fontWeight = FontWeight.SemiBold,
        )
        Spacer(modifier = Modifier.height(4.dp))
        if (subtitle != null) {
          Text(text = subtitle, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold)
          Spacer(modifier = Modifier.height(4.dp))
        }
        Text(text = formatLocalTime(timestampMillis), color = Color.White.copy(alpha = 0.65f), fontSize = 14.sp)
        Spacer(modifier = Modifier.height(20.dp))
        Text(text = body, color = Color.White, fontSize = 19.sp)
      }
    }
  }
}

private fun formatLocalTime(millis: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(millis))
