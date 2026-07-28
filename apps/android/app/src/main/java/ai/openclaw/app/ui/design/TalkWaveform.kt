package ai.openclaw.app.ui.design

import android.provider.Settings
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin

/**
 * Universal OpenClaw talk animation: Compose port of the shared Siri-style
 * waveform in `apps/shared/OpenClawKit/Sources/OpenClawChatUI/TalkWaveformView.swift`.
 * Every constant mirrors the Swift original; change them there first.
 */
internal sealed interface TalkWaveformPhase {
  /** Voice surface is off or unavailable: flat, static, dimmed. */
  data object Idle : TalkWaveformPhase

  /**
   * Connecting or waiting on the agent. No audio exists in this state, so the
   * wave breathes on a slow synthetic swell by design.
   */
  data object Thinking : TalkWaveformPhase

  /**
   * Capturing the user's voice. [level] is the live microphone level in 0..1;
   * [speechActive] raises the floor once endpointing detects actual speech.
   */
  data class Listening(
    val level: Float,
    val speechActive: Boolean,
  ) : TalkWaveformPhase

  /**
   * Agent speech playback. [level] is the live playback envelope in 0..1.
   * `null` means the active voice path exposes no envelope (system TTS and
   * talk.speak compressed playback have no metering); the wave then falls
   * back to a synthetic pulse rather than freezing.
   */
  data class Speaking(
    val level: Float?,
  ) : TalkWaveformPhase
}

/**
 * Wave colors, front to back. Surfaces embedding the wave on tinted backgrounds
 * (for example the voice orb) pass their own colors.
 */
internal data class TalkWaveformPalette(
  val active: List<Color>,
  val inactive: List<Color>,
) {
  companion object {
    val standard =
      TalkWaveformPalette(
        active =
          listOf(
            Color(red = 198 / 255f, green = 62 / 255f, blue = 56 / 255f),
            Color(red = 0.95f, green = 0.45f, blue = 0.30f),
            Color(red = 0.45f, green = 0.08f, blue = 0.12f),
          ),
        inactive =
          listOf(
            Color(red = 0.62f, green = 0.62f, blue = 0.62f),
            Color(red = 0.72f, green = 0.72f, blue = 0.72f),
            Color(red = 0.82f, green = 0.82f, blue = 0.82f),
          ),
      )
  }
}

@Composable
internal fun TalkWaveform(
  phase: TalkWaveformPhase,
  modifier: Modifier = Modifier,
  palette: TalkWaveformPalette = TalkWaveformPalette.standard,
) {
  val context = LocalContext.current
  // Compose frame clocks ignore the system animator scale; honor the OS
  // "remove animations" setting explicitly (same pattern as OpenClawMascot).
  val animationsEnabled =
    remember(context) {
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }
  val idle = phase == TalkWaveformPhase.Idle
  val frozen = !animationsEnabled || idle
  var timeSeconds by remember { mutableDoubleStateOf(0.0) }
  var bornNanos by remember { mutableLongStateOf(Long.MIN_VALUE) }
  LaunchedEffect(frozen) {
    if (frozen) {
      timeSeconds = 0.0
      return@LaunchedEffect
    }
    var lastFrameNanos = Long.MIN_VALUE
    while (true) {
      withInfiniteAnimationFrameNanos { frameNanos ->
        if (bornNanos == Long.MIN_VALUE) bornNanos = frameNanos
        // ~30fps like the iOS TimelineView(minimumInterval: 1/30): skip
        // intermediate vsync callbacks instead of redrawing at display rate.
        if (lastFrameNanos == Long.MIN_VALUE || frameNanos - lastFrameNanos >= 33_000_000L) {
          lastFrameNanos = frameNanos
          timeSeconds = (frameNanos - bornNanos) / 1_000_000_000.0
        }
      }
    }
  }

  val power = TalkWaveformMath.power(phase, timeSeconds)
  val colors = if (idle) palette.inactive else palette.active
  // The applied Claw theme (not the system setting) decides dark rendering.
  val dark = ClawTheme.colors.canvas.luminance() < 0.5f
  val midlineColor = ClawTheme.colors.textMuted.copy(alpha = 0.30f)
  Canvas(
    modifier =
      modifier.graphicsLayer {
        alpha = if (idle) 0.6f else 1f
        // Waves must blend with each other (screen on dark), not with whatever
        // happens to be drawn behind the widget.
        compositingStrategy = CompositingStrategy.Offscreen
      },
  ) {
    val midY = size.height / 2f
    drawLine(
      color = midlineColor,
      start = Offset(0f, midY),
      end = Offset(size.width, midY),
      strokeWidth = 1.dp.toPx(),
    )
    // Screen blend pops on dark; opacity overlap reads better on light.
    val blendMode = if (dark) BlendMode.Screen else BlendMode.SrcOver
    val opacity = if (dark) 0.9f else 0.55f
    colors.forEachIndexed { index, color ->
      drawPath(
        path = wavePath(size = size, time = timeSeconds, seed = index * 7.31, power = power),
        color = color.copy(alpha = color.alpha * opacity),
        blendMode = blendMode,
      )
    }
  }
}

/** One wave = max envelope of three drifting lobes, mirrored around the midline. */
private fun wavePath(
  size: Size,
  time: Double,
  seed: Double,
  power: Double,
): Path {
  val midX = size.width / 2.0
  val midY = size.height / 2.0
  val lobes = TalkWaveformMath.lobes(time, seed)

  val upper = ArrayList<Offset>()
  var x = -midX
  while (x <= midX) {
    val graphX = x / (midX / 9.0)
    var y = 0.0
    for (lobe in lobes) {
      val amplitude = lobe.amplitude * midY * power
      y = max(y, TalkWaveformMath.attenuatedSine(x = graphX, amplitude = amplitude, k = lobe.k, t = lobe.t))
    }
    upper.add(Offset((midX + x).toFloat(), (midY - y).toFloat()))
    x += 2.0
  }

  val path = Path()
  path.moveTo(0f, midY.toFloat())
  for (point in upper) {
    path.lineTo(point.x, point.y)
  }
  for (index in upper.indices.reversed()) {
    val point = upper[index]
    path.lineTo(point.x, (2.0 * midY).toFloat() - point.y)
  }
  path.close()
  return path
}

/**
 * Pure waveform math, split from the composable for unit testing. Canonical
 * reference for every constant is TalkWaveformMath in TalkWaveformView.swift.
 */
internal object TalkWaveformMath {
  data class Lobe(
    val amplitude: Double,
    val k: Double,
    val t: Double,
  )

  /** Per-phase drive for the wave amplitude in 0..1. */
  fun power(
    phase: TalkWaveformPhase,
    time: Double,
  ): Double =
    when (phase) {
      TalkWaveformPhase.Idle -> 0.05
      TalkWaveformPhase.Thinking -> 0.16 + 0.10 * (0.5 + 0.5 * sin(time * 1.6))
      is TalkWaveformPhase.Listening -> {
        val clamped = phase.level.toDouble().coerceIn(0.0, 1.0)
        // Detected speech lifts the floor so the wave visibly commits to the
        // user even when the mic level dips between words.
        if (phase.speechActive) 0.55 + 0.45 * clamped else 0.30 + 0.65 * clamped
      }
      is TalkWaveformPhase.Speaking -> {
        val level = phase.level
        if (level == null) {
          // Synthetic pulse for voice paths with no playback metering.
          0.70 * (0.55 + 0.45 * abs(sin(time * 5.0)))
        } else {
          0.25 + 0.75 * level.toDouble().coerceIn(0.0, 1.0)
        }
      }
    }

  /**
   * Lobe parameters oscillate smoothly so peaks sweep back and forth across
   * the line instead of scrolling off-screen.
   */
  fun lobes(
    time: Double,
    seed: Double,
  ): List<Lobe> =
    (0 until 3).map { index ->
      val f = index.toDouble()
      val ampFrequency = 0.9 + 0.23 * f
      val ampPhase = time * ampFrequency + seed * 2.4 + f * 2.1
      val amplitude = 0.30 + 0.70 * (0.5 + 0.5 * sin(ampPhase))
      val k = 0.62 + 0.11 * f
      val driftFrequency = 0.45 + 0.17 * f
      val driftPhase = time * driftFrequency + seed + f * 1.9
      Lobe(amplitude = amplitude, k = k, t = 2.8 * sin(driftPhase))
    }

  /** |A·sin(kx − t)| shaped by the bell envelope g = (K/(K+(kx−t′)²))^K, K = 4. */
  fun attenuatedSine(
    x: Double,
    amplitude: Double,
    k: Double,
    t: Double,
  ): Double {
    val sine = amplitude * sin(k * x - t)
    val tPrime = t - PI / 2
    val envelope = (4.0 / (4.0 + (k * x - tPrime).pow(2))).pow(4.0)
    return abs(sine * envelope)
  }
}
