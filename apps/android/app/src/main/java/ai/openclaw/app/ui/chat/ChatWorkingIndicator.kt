package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeStringResource
import ai.openclaw.app.ui.rememberSystemAnimationsEnabled
import android.os.SystemClock
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.math.roundToLong
import kotlin.random.Random

private const val DEFAULT_CLAW_CYCLE_MS = 2_400L
private const val DRUMMER_CLAW_CYCLE_MS = 1_200L
private const val FLURRY_CLAW_CYCLE_MS = 1_300L
private const val SPIN_CLAW_CYCLE_MS = 3_600L
private const val ZEN_CLAW_CYCLE_MS = 6_000L
internal const val WORKING_PHRASE_SHOW_AFTER_MS = 30_000L
internal const val WORKING_PHRASE_ROTATE_EVERY_MS = 45_000L

private val clawBodyPath by lazy {
  PathParser()
    .parsePathString(
      "M9.6 9.2 A5.6 5.6 0 1 0 9.6 20.4 A5.6 5.6 0 0 0 9.6 9.2 Z " +
        "M10 20 C14 20.9 17.9 19.5 20.1 16.1 C20.6 15.4 20.05 14.5 19.25 14.65 " +
        "C17.1 15 14.9 14.4 13.2 13 L10.6 16 Z",
    ).toPath()
}
private val clawJawPath by lazy {
  PathParser()
    .parsePathString(
      "M6 10.6 C6.6 4.4 12.4 0.8 17.6 2.8 C20.8 4 22.8 6.8 23 9.8 " +
        "C23.07 10.9 21.9 11.4 21.1 10.7 C19.4 9.2 16.9 8.7 14.7 9.5 " +
        "C13.4 10 12.3 10.9 11.6 12.1 L7.2 12.4 Z",
    ).toPath()
}

internal enum class WorkingClawStance {
  Default,
  Southpaw,
  Flurry,
  Spin,
  Shadowbox,
  Backflip,
  Zen,
  Drummer,
  Peekaboo,
}

private val stanceWeights =
  listOf(
    WorkingClawStance.Default to 63,
    WorkingClawStance.Southpaw to 19,
    WorkingClawStance.Flurry to 5,
    WorkingClawStance.Spin to 4,
    WorkingClawStance.Shadowbox to 3,
    WorkingClawStance.Backflip to 2,
    WorkingClawStance.Zen to 2,
    WorkingClawStance.Drummer to 1,
    WorkingClawStance.Peekaboo to 1,
  )
private val processStanceSalt = Random.nextInt()

internal fun workingClawHash(value: String): Int {
  var hash = 0x811c9dc5.toInt()
  value.forEach { character ->
    hash = (hash xor character.code) * 0x01000193
  }
  return hash
}

internal fun pickWorkingClawStance(
  runKey: String,
  salt: Int = processStanceSalt,
): WorkingClawStance {
  var roll = ((workingClawHash(runKey) xor salt).toUInt().toLong() % 1_000L).toInt()
  stanceWeights.forEach { (stance, weight) ->
    val buckets = weight * 10
    if (roll < buckets) return stance
    roll -= buckets
  }
  return WorkingClawStance.Default
}

private data class ClawKeyframe(
  val phase: Float,
  val value: Float,
)

private val easeOut = CubicBezierEasing(0f, 0f, 0.58f, 1f)
private val easeInOut = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
private val flexFrames =
  frames(0f to 0f, 0.06f to 0f, 0.10f to -4f, 0.16f to 3f, 0.22f to -4f, 0.26f to -4f, 0.32f to 3f, 0.42f to 0f, 1f to 0f)
private val snipFrames =
  frames(0f to -10f, 0.06f to -10f, 0.10f to -26f, 0.16f to 4f, 0.22f to -24f, 0.26f to -24f, 0.32f to 4f, 0.42f to -10f, 1f to -10f)
private val comboXFrames =
  frames(0f to 0f, 0.08f to 0f, 0.12f to -2f, 0.16f to 5f, 0.22f to -2f, 0.26f to -2f, 0.30f to 5f, 0.38f to 0f, 0.46f to -3f, 0.52f to 8f, 0.62f to 0f, 1f to 0f)
private val comboRotationFrames =
  frames(0f to 0f, 0.38f to 0f, 0.46f to -6f, 0.52f to 4f, 0.62f to 0f, 1f to 0f)
private val comboJawFrames =
  frames(0f to -10f, 0.08f to -10f, 0.12f to -16f, 0.16f to 4f, 0.22f to -16f, 0.26f to -16f, 0.30f to 4f, 0.38f to -10f, 0.46f to -18f, 0.52f to 6f, 0.62f to -10f, 1f to -10f)
private val backflipRotationFrames =
  frames(0f to 0f, 0.55f to 0f, 0.62f to -120f, 0.70f to -240f, 0.78f to -360f, 1f to -360f)
private val backflipYFrames = frames(0f to 0f, 0.55f to 0f, 0.62f to -3f, 0.70f to -3f, 0.78f to 0f, 1f to 0f)
private val powAlphaFrames = frames(0f to 0f, 0.46f to 0f, 0.52f to 1f, 0.58f to 0f, 1f to 0f)
private val powScaleFrames = frames(0f to 0.4f, 0.46f to 0.4f, 0.52f to 1.2f, 0.58f to 1.5f, 1f to 1.5f)
private val zenScaleFrames = frames(0f to 1f, 0.30f to 1.08f, 0.55f to 1f, 1f to 1f)
private val zenJawFrames = frames(0f to -10f, 0.60f to -10f, 0.70f to -24f, 0.76f to 2f, 0.86f to -10f, 1f to -10f)
private val drummerRotationFrames = frames(0f to 0f, 0.15f to -8f, 0.30f to 0f, 0.55f to 8f, 0.70f to 0f, 1f to 0f)
private val drummerJawFrames = frames(0f to -10f, 0.10f to -20f, 0.15f to 2f, 0.25f to -10f, 0.50f to -20f, 0.55f to 2f, 0.65f to -10f, 1f to -10f)
private val peekabooScaleFrames = frames(0f to 1f, 0.55f to 1f, 0.62f to 0.72f, 0.72f to 0.72f, 0.78f to 1.06f, 0.84f to 1f, 1f to 1f)
private val peekabooYFrames = frames(0f to 0f, 0.55f to 0f, 0.62f to 5f, 0.72f to 5f, 0.78f to -1.5f, 0.84f to 0f, 1f to 0f)
private val peekabooJawFrames = frames(0f to -10f, 0.55f to -10f, 0.62f to -2f, 0.72f to -2f, 0.78f to -28f, 0.86f to -10f, 1f to -10f)

private fun frames(vararg values: Pair<Float, Float>): List<ClawKeyframe> = values.map { (phase, value) -> ClawKeyframe(phase, value) }

private fun sampleFrames(
  keyframes: List<ClawKeyframe>,
  phase: Float,
  easing: CubicBezierEasing = easeOut,
): Float {
  val bounded = phase.coerceIn(0f, 1f)
  val nextIndex = keyframes.indexOfFirst { it.phase >= bounded }.takeIf { it >= 0 } ?: keyframes.lastIndex
  if (nextIndex == 0) return keyframes.first().value
  val previous = keyframes[nextIndex - 1]
  val next = keyframes[nextIndex]
  if (next.phase == previous.phase) return next.value
  val progress = easing.transform((bounded - previous.phase) / (next.phase - previous.phase))
  return previous.value + (next.value - previous.value) * progress
}

internal data class WorkingClawPose(
  val rotationZ: Float = 0f,
  val rotationY: Float = 0f,
  val translationXDp: Float = 0f,
  val translationYDp: Float = 0f,
  val scale: Float = 1f,
  val jawRotation: Float = -10f,
  val powAlpha: Float = 0f,
  val powScale: Float = 0.4f,
)

internal fun workingClawPose(
  stance: WorkingClawStance,
  phase: Float,
): WorkingClawPose =
  when (stance) {
    WorkingClawStance.Spin ->
      WorkingClawPose(
        rotationY = phase * 360f,
        jawRotation = sampleFrames(snipFrames, phase),
      )
    WorkingClawStance.Shadowbox ->
      WorkingClawPose(
        rotationZ = sampleFrames(comboRotationFrames, phase),
        translationXDp = sampleFrames(comboXFrames, phase),
        jawRotation = sampleFrames(comboJawFrames, phase),
        powAlpha = sampleFrames(powAlphaFrames, phase),
        powScale = sampleFrames(powScaleFrames, phase),
      )
    WorkingClawStance.Backflip ->
      WorkingClawPose(
        rotationZ = sampleFrames(backflipRotationFrames, phase),
        translationYDp = sampleFrames(backflipYFrames, phase),
        jawRotation = sampleFrames(snipFrames, phase),
      )
    WorkingClawStance.Zen ->
      WorkingClawPose(
        scale = sampleFrames(zenScaleFrames, phase, easeInOut),
        jawRotation = sampleFrames(zenJawFrames, phase),
      )
    WorkingClawStance.Drummer ->
      WorkingClawPose(
        rotationZ = sampleFrames(drummerRotationFrames, phase),
        jawRotation = sampleFrames(drummerJawFrames, phase),
      )
    WorkingClawStance.Peekaboo ->
      WorkingClawPose(
        translationYDp = sampleFrames(peekabooYFrames, phase),
        scale = sampleFrames(peekabooScaleFrames, phase),
        jawRotation = sampleFrames(peekabooJawFrames, phase),
      )
    WorkingClawStance.Default,
    WorkingClawStance.Southpaw,
    WorkingClawStance.Flurry,
    ->
      WorkingClawPose(
        rotationZ = sampleFrames(flexFrames, phase),
        jawRotation = sampleFrames(snipFrames, phase),
      )
  }

internal fun workingClawCycleMs(stance: WorkingClawStance): Long =
  when (stance) {
    WorkingClawStance.Drummer -> DRUMMER_CLAW_CYCLE_MS
    WorkingClawStance.Flurry -> FLURRY_CLAW_CYCLE_MS
    WorkingClawStance.Spin -> SPIN_CLAW_CYCLE_MS
    WorkingClawStance.Zen -> ZEN_CLAW_CYCLE_MS
    else -> DEFAULT_CLAW_CYCLE_MS
  }

@Composable
internal fun WorkingClawIcon(
  runKey: String,
  color: Color,
  modifier: Modifier = Modifier,
  parked: Boolean = false,
) {
  val stance = remember(runKey, parked) { if (parked) WorkingClawStance.Default else pickWorkingClawStance(runKey) }
  val density = LocalDensity.current
  val animationsEnabled = rememberSystemAnimationsEnabled() && !parked
  val cycleMs = workingClawCycleMs(stance)
  var phase by remember(runKey) { mutableFloatStateOf(0f) }
  LaunchedEffect(animationsEnabled, runKey, cycleMs) {
    if (!animationsEnabled) {
      phase = 0f
      return@LaunchedEffect
    }
    var bornNanos = Long.MIN_VALUE
    while (true) {
      withFrameNanos { frameNanos ->
        if (bornNanos == Long.MIN_VALUE) bornNanos = frameNanos
        val cycleNanos = cycleMs * 1_000_000L
        phase = ((frameNanos - bornNanos) % cycleNanos).toFloat() / cycleNanos.toFloat()
      }
    }
  }
  val pose =
    when {
      parked -> WorkingClawPose(rotationZ = 8f, jawRotation = -4f)
      animationsEnabled -> workingClawPose(stance, phase)
      else -> WorkingClawPose()
    }
  val iconWidth = if (stance == WorkingClawStance.Shadowbox) 30.dp else 18.dp
  Box(modifier = modifier.size(width = iconWidth, height = 20.dp), contentAlignment = Alignment.CenterStart) {
    Canvas(
      modifier =
        Modifier
          .size(18.dp)
          .graphicsLayer {
            rotationZ = pose.rotationZ
            rotationY = pose.rotationY
            translationX = with(density) { pose.translationXDp.dp.toPx() }
            translationY = with(density) { pose.translationYDp.dp.toPx() }
            scaleX = pose.scale * if (stance == WorkingClawStance.Southpaw) -1f else 1f
            scaleY = pose.scale
            cameraDistance = with(density) { 60.dp.toPx() }
          },
    ) {
      val scale = size.minDimension / 24f
      withTransform({ scale(scale, scale, pivot = Offset.Zero) }) {
        drawPath(path = clawBodyPath, color = color)
        withTransform({ rotate(pose.jawRotation, pivot = Offset(8.6f, 11f)) }) {
          drawPath(path = clawJawPath, color = color)
        }
      }
    }
    if (stance == WorkingClawStance.Shadowbox && animationsEnabled) {
      Text(
        text = nativeStringResource("✦"),
        color = color,
        fontSize = 11.sp,
        lineHeight = 11.sp,
        modifier =
          Modifier
            .offset(x = 19.dp, y = (-4).dp)
            .graphicsLayer {
              alpha = pose.powAlpha
              scaleX = pose.powScale
              scaleY = pose.powScale
            },
      )
    }
  }
}

@Composable
internal fun rememberWorkingElapsedMs(observedAtElapsedMs: Long): Long {
  var nowElapsedMs by remember(observedAtElapsedMs) { mutableLongStateOf(SystemClock.elapsedRealtime()) }
  LaunchedEffect(observedAtElapsedMs) {
    while (true) {
      nowElapsedMs = SystemClock.elapsedRealtime()
      delay(1_000L)
    }
  }
  return (nowElapsedMs - observedAtElapsedMs).coerceAtLeast(0L)
}

internal enum class ChatDurationUnit {
  Day,
  Hour,
  Minute,
  Second,
}

internal fun formatChatDurationCompact(
  durationMs: Long,
  formatPart: (Long, ChatDurationUnit) -> String = ::formatEnglishChatDurationPart,
): String {
  var remaining = (durationMs.coerceAtLeast(1_000L) / 1_000.0).roundToLong().coerceAtLeast(1L)
  val units =
    listOf(
      86_400L to ChatDurationUnit.Day,
      3_600L to ChatDurationUnit.Hour,
      60L to ChatDurationUnit.Minute,
      1L to ChatDurationUnit.Second,
    )
  val parts = mutableListOf<String>()
  units.forEach { (seconds, unit) ->
    if (parts.size == 2) return@forEach
    val count = remaining / seconds
    if (count > 0L) {
      parts += formatPart(count, unit)
      remaining %= seconds
    }
  }
  return parts.joinToString(" ")
}

private fun formatEnglishChatDurationPart(
  count: Long,
  unit: ChatDurationUnit,
): String =
  when (unit) {
    ChatDurationUnit.Day -> "${count}d"
    ChatDurationUnit.Hour -> "${count}h"
    ChatDurationUnit.Minute -> "${count}m"
    ChatDurationUnit.Second -> "${count}s"
  }

internal fun formatLocalizedChatDurationCompact(durationMs: Long): String =
  formatChatDurationCompact(durationMs) { count, unit ->
    when (unit) {
      ChatDurationUnit.Day -> {
        val days = count
        nativeString("\${days}d", days)
      }
      ChatDurationUnit.Hour -> {
        val hours = count
        nativeString("\${hours}h", hours)
      }
      ChatDurationUnit.Minute -> {
        val minutes = count
        nativeString("\${minutes}m", minutes)
      }
      ChatDurationUnit.Second -> {
        val seconds = count
        nativeString("\${seconds}s", seconds)
      }
    }
  }

internal fun workingPhraseIndex(
  seed: String,
  bucket: Long,
): Int {
  val length = WORKING_PHRASE_COUNT
  val offset = workingClawHash("$seed:offset").toUInt().toLong() % length
  val stride = 1L + (workingClawHash("$seed:stride").toUInt().toLong() % (length - 1))
  return ((offset + (bucket % length) * stride) % length).toInt()
}

internal fun workingPhraseIndexForElapsed(
  seed: String,
  elapsedMs: Long,
): Int? {
  if (elapsedMs < WORKING_PHRASE_SHOW_AFTER_MS) return null
  val bucket = (elapsedMs - WORKING_PHRASE_SHOW_AFTER_MS) / WORKING_PHRASE_ROTATE_EVERY_MS
  return workingPhraseIndex(seed, bucket)
}

@Composable
internal fun workingPhraseText(
  seed: String,
  elapsedMs: Long,
): String? = workingPhraseIndexForElapsed(seed, elapsedMs)?.let { localizedWorkingPhrase(it) + "…" }

private const val WORKING_PHRASE_COUNT = 19

@Composable
private fun localizedWorkingPhrase(index: Int): String =
  when (index) {
    0 -> nativeStringResource("Shelling")
    1 -> nativeStringResource("Scuttling")
    2 -> nativeStringResource("Clawing")
    3 -> nativeStringResource("Pinching")
    4 -> nativeStringResource("Molting")
    5 -> nativeStringResource("Bubbling")
    6 -> nativeStringResource("Tiding")
    7 -> nativeStringResource("Reefing")
    8 -> nativeStringResource("Cracking")
    9 -> nativeStringResource("Sifting")
    10 -> nativeStringResource("Brining")
    11 -> nativeStringResource("Nautiling")
    12 -> nativeStringResource("Krilling")
    13 -> nativeStringResource("Barnacling")
    14 -> nativeStringResource("Lobstering")
    15 -> nativeStringResource("Tidepooling")
    16 -> nativeStringResource("Pearling")
    17 -> nativeStringResource("Snapping")
    18 -> nativeStringResource("Surfacing")
    else -> error("working phrase index out of range: $index")
  }
