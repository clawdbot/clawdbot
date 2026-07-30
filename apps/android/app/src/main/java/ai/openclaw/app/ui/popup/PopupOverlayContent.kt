package ai.openclaw.app.ui.popup

import ai.openclaw.app.chat.LocalSpeechSpeaking
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Entering -> Visible is the slide-in/fade-in; Visible -> Exiting is the slide-out/fade-out before onDismiss(). */
internal enum class PopupPhase { Entering, Visible, Exiting }

private const val ENTER_ANIMATION_MS = 260
private const val EXIT_ANIMATION_MS = 260L

/**
 * Shared popup card UI plus phase/timer/dismiss/TTS logic for both display hosts:
 * the locked-screen takeover (PopupOverlayActivity) and the unlocked floating
 * window (PopupOverlayWindow). Hosts differ only in card width, whether a
 * full-size dim backdrop renders, and whether back-press is wired (the floating
 * window is non-focusable and never receives back events).
 */
@Composable
internal fun PopupOverlayContent(
  title: String,
  subtitle: String?,
  body: String,
  timestampMillis: Long,
  cardColorArgb: Int,
  opacity: Float,
  cornerRadiusDp: Int,
  autoDismissSeconds: Int,
  cardWidthModifier: Modifier,
  showScrimBackdrop: Boolean,
  enableBackHandler: Boolean,
  speaker: LocalSpeechSpeaking,
  onDismiss: () -> Unit,
) {
  var phase by remember { mutableStateOf(PopupPhase.Entering) }
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    phase = PopupPhase.Visible
    scope.launch { speaker.speak(popupSpokenText(subtitle, body)) }
  }

  // Covers tap-dismiss, auto-dismiss, back-press, and host teardown (finish()/window removal)
  // uniformly: composition leaving is the single point where speech must stop.
  DisposableEffect(Unit) { onDispose { speaker.stop() } }

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

  if (enableBackHandler) {
    BackHandler(enabled = phase == PopupPhase.Visible) { phase = PopupPhase.Exiting }
  }

  AnimatedVisibility(
    visible = phase == PopupPhase.Visible,
    enter = slideInVertically(animationSpec = tween(ENTER_ANIMATION_MS)) { it / 3 } + fadeIn(tween(ENTER_ANIMATION_MS)),
    exit = slideOutVertically(animationSpec = tween(EXIT_ANIMATION_MS.toInt())) { it / 3 } + fadeOut(tween(EXIT_ANIMATION_MS.toInt())),
  ) {
    val dismiss = { phase = PopupPhase.Exiting }
    if (showScrimBackdrop) {
      // Activity host: full-size root so the card can anchor to the bottom and a dim
      // scrim can sit behind it. The floating-window host has no root of its own — see
      // below — since fillMaxSize() there would force the WRAP_CONTENT window to expand
      // to the full screen.
      Box(modifier = Modifier.fillMaxSize()) {
        Box(
          modifier =
            Modifier
              .fillMaxSize()
              .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss)
              .background(Color.Black.copy(alpha = opacity * 0.4f)),
        )
        PopupCard(
          title = title,
          subtitle = subtitle,
          body = body,
          timestampMillis = timestampMillis,
          cardColorArgb = cardColorArgb,
          opacity = opacity,
          cornerRadiusDp = cornerRadiusDp,
          modifier = Modifier.align(Alignment.BottomCenter).then(cardWidthModifier).padding(bottom = 32.dp),
          onClick = dismiss,
        )
      }
    } else {
      PopupCard(
        title = title,
        subtitle = subtitle,
        body = body,
        timestampMillis = timestampMillis,
        cardColorArgb = cardColorArgb,
        opacity = opacity,
        cornerRadiusDp = cornerRadiusDp,
        modifier = cardWidthModifier,
        onClick = dismiss,
      )
    }
  }
}

@Composable
private fun PopupCard(
  title: String,
  subtitle: String?,
  body: String,
  timestampMillis: Long,
  cardColorArgb: Int,
  opacity: Float,
  cornerRadiusDp: Int,
  modifier: Modifier,
  onClick: () -> Unit,
) {
  Column(
    modifier =
      modifier
        .clip(RoundedCornerShape(cornerRadiusDp.dp))
        .background(Color(cardColorArgb).copy(alpha = opacity))
        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
        .padding(20.dp),
  ) {
    Text(
      text = title.uppercase(),
      color = Color.White.copy(alpha = 0.75f),
      fontSize = 15.sp,
      fontWeight = FontWeight.SemiBold,
    )
    Spacer(modifier = Modifier.height(4.dp))
    if (subtitle != null) {
      Text(text = subtitle, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
      Spacer(modifier = Modifier.height(4.dp))
    }
    Text(text = formatLocalTime(timestampMillis), color = Color.White.copy(alpha = 0.65f), fontSize = 13.sp)
    Spacer(modifier = Modifier.height(12.dp))
    Text(text = body, color = Color.White, fontSize = 17.sp)
  }
}

/** What the popup speaks aloud; the core purpose of overlay delivery, so it always runs. */
internal fun popupSpokenText(
  subtitle: String?,
  body: String,
): String = if (subtitle != null) "Message from $subtitle: $body" else body

private fun formatLocalTime(millis: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(millis))
