package ai.openclaw.app.ui.design

import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

// Canonical 120x120 mascot geometry from ui/public/favicon.svg; parts stay
// separate paths so claws, antennae, and eyes can animate independently.
private val BodyPath =
  PathParser()
    .parsePathString(
      "M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 " +
        "C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z",
    ).toPath()
private val LeftClawPath =
  PathParser().parsePathString("M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z").toPath()
private val RightClawPath =
  PathParser().parsePathString("M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z").toPath()
private val LeftAntennaPath = PathParser().parsePathString("M45 15 Q35 5 30 8").toPath()
private val RightAntennaPath = PathParser().parsePathString("M75 15 Q85 5 90 8").toPath()
private val HardHatDomePath =
  PathParser().parsePathString("M45 15 C47 7 54 3 60 3 C66 3 73 7 75 15 L45 15 Z").toPath()

private val CoralBright = Color(0xFFFF4D4D)
private val CoralDark = Color(0xFF991B1B)
private val EyeDark = Color(0xFF050810)
private val EyeGlow = Color(0xFF00E5CC)
private val Blush = Color(0xFFFF9EAE)
private val HatAmber = Color(0xFFF2A833)
private val HatLight = Color(0xFFFFD659)
private val HatOutline = Color(0xB8B8731F)
private val SweatBlue = Color(0xFF80D4FF)

private val LeftClawPivot = Offset(26f, 53f)
private val RightClawPivot = Offset(94f, 53f)
private val LeftAntennaPivot = Offset(37.5f, 11f)
private val RightAntennaPivot = Offset(82.5f, 11f)
private val LeftEyeCenter = Offset(45f, 35f)
private val RightEyeCenter = Offset(75f, 35f)

/** Animated 120x120 OpenClaw mascot. [tint] keeps the single-color icon rendering path. */
@Composable
fun OpenClawMascot(
  modifier: Modifier = Modifier,
  tint: Color? = null,
  contentDescription: String? = null,
  mood: MascotMood = MascotMood.Idle,
) {
  val context = LocalContext.current
  val animationsEnabled =
    remember(context) {
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }
  val animator = remember { MascotAnimator() }
  var pose by remember { mutableStateOf(staticPose(mood)) }

  LaunchedEffect(animationsEnabled, mood, tint) {
    if (!animationsEnabled) {
      pose = staticPose(effectiveMascotMood(mood = mood, tinted = tint != null))
      return@LaunchedEffect
    }
    while (true) {
      withFrameNanos { frameTimeNanos ->
        val timeSeconds = frameTimeNanos / 1_000_000_000.0
        animator.setMood(effectiveMascotMood(mood = mood, tinted = tint != null), timeSeconds)
        pose = animator.poseAt(timeSeconds)
      }
    }
  }

  val semantics =
    if (contentDescription == null) {
      Modifier
    } else {
      Modifier.semantics {
        this.contentDescription = contentDescription
        role = Role.Image
      }
    }
  Canvas(modifier = modifier.then(semantics)) {
    val artScale = size.minDimension / 120f
    withTransform({
      scale(artScale, artScale, pivot = Offset.Zero)
      translate(top = pose.floatOffset.toFloat())
    }) {
      drawMascot(pose, tint)
    }
  }
}

private fun DrawScope.drawMascot(
  pose: MascotPose,
  tint: Color?,
) {
  val stretchY = pose.bodyStretch.toFloat()
  val stretchX = (1.0 + (1.0 - pose.bodyStretch) * 0.5).coerceIn(0.97, 1.03).toFloat()
  withTransform({
    if (stretchY != 1f) scale(stretchX, stretchY, pivot = Offset(60f, 110f))
    if (pose.bodyTilt != 0.0) rotate(pose.bodyTilt.toFloat(), pivot = Offset(60f, 60f))
  }) {
    val bodyBrush =
      tint?.let(::SolidColor)
        ?: Brush.linearGradient(
          colors = listOf(CoralBright, CoralDark),
          start = Offset(15f, 10f),
          end = Offset(105f, 110f),
        )
    val leftClawBrush =
      tint?.let(::SolidColor)
        ?: Brush.linearGradient(
          colors = listOf(CoralBright, CoralDark),
          start = Offset(3.125f, 43.67f),
          end = Offset(26.197f, 65.451f),
        )
    val rightClawBrush =
      tint?.let(::SolidColor)
        ?: Brush.linearGradient(
          colors = listOf(CoralBright, CoralDark),
          start = Offset(93.803f, 43.67f),
          end = Offset(116.875f, 65.451f),
        )

    drawPath(BodyPath, bodyBrush)
    withTransform({ rotate(pose.leftClawDegrees.toFloat(), pivot = LeftClawPivot) }) {
      drawPath(LeftClawPath, leftClawBrush)
    }
    withTransform({ rotate(pose.rightClawDegrees.toFloat(), pivot = RightClawPivot) }) {
      drawPath(RightClawPath, rightClawBrush)
    }

    val antennaColor = tint ?: CoralBright
    val antennaStroke = Stroke(width = 2f, cap = StrokeCap.Round)
    val wiggle = (pose.antennaDegrees * (1.0 - pose.antennaDroop)).toFloat()
    withTransform({ rotate((-pose.antennaDroop * 40.0).toFloat(), pivot = Offset(45f, 15f)) }) {
      withTransform({ rotate(wiggle, pivot = LeftAntennaPivot) }) {
        drawPath(LeftAntennaPath, antennaColor, style = antennaStroke)
      }
    }
    withTransform({ rotate((pose.antennaDroop * 40.0).toFloat(), pivot = Offset(75f, 15f)) }) {
      withTransform({ rotate(wiggle, pivot = RightAntennaPivot) }) {
        drawPath(RightAntennaPath, antennaColor, style = antennaStroke)
      }
    }

    drawHardHat(pose.hardHat.toFloat(), tint)
    if (tint == null) {
      drawBlush(pose)
      drawEye(LeftEyeCenter, pose.leftEyeOpenness, pose)
      drawEye(RightEyeCenter, pose.rightEyeOpenness, pose)
      drawMouth(pose)
      drawEffect(pose)
    }
  }
}

private fun DrawScope.drawEye(
  center: Offset,
  openness: Double,
  pose: MascotPose,
) {
  val shifted =
    Offset(
      x = center.x + (pose.gaze.x * 2.0).toFloat(),
      y = center.y + (pose.gaze.y * 1.5).toFloat(),
    )
  if (pose.happyEyes < 1.0) {
    val height = max(1.2, 12.0 * openness * (1.0 - 0.6 * pose.happyEyes)).toFloat()
    val eyeCenterY = shifted.y - 6f + (12f - height) * 0.65f + height / 2f
    drawOval(
      color = EyeDark,
      topLeft = Offset(shifted.x - 6f, eyeCenterY - height / 2f),
      size = Size(12f, height),
      alpha = (1.0 - pose.happyEyes).toFloat(),
    )
  }
  if (pose.happyEyes > 0.0) {
    val arc =
      Path().apply {
        moveTo(shifted.x - 6f, shifted.y + 2f)
        quadraticTo(shifted.x, shifted.y - 5.5f, shifted.x + 6f, shifted.y + 2f)
      }
    drawPath(
      path = arc,
      color = EyeDark,
      alpha = pose.happyEyes.toFloat(),
      style = Stroke(width = 2.6f, cap = StrokeCap.Round),
    )
  }

  val glowVisibility = pose.eyeGlowAlpha * openness * (1.0 - pose.happyEyes)
  if (glowVisibility <= 0.01) return
  val glowRadius = (2.0 * pose.glowScale).toFloat()
  val glowCenter =
    Offset(
      x = shifted.x + 1f + (pose.gaze.x * 1.2).toFloat(),
      y = shifted.y - 1f + (pose.gaze.y * 0.9).toFloat(),
    )
  drawCircle(EyeGlow, radius = glowRadius, center = glowCenter, alpha = glowVisibility.toFloat())
}

private fun DrawScope.drawMouth(pose: MascotPose) {
  when {
    pose.mouthRound > 0.05 -> {
      val radiusX = (1.0 + 3.2 * pose.mouthRound).toFloat()
      val radiusY = (1.0 + 4.2 * pose.mouthRound).toFloat()
      drawOval(
        color = EyeDark,
        topLeft = Offset(60f - radiusX, 51f - radiusY),
        size = Size(radiusX * 2f, radiusY * 2f),
      )
    }
    pose.mouthOpen > 0.05 -> {
      val grin =
        Path().apply {
          moveTo(52.5f, 48.5f)
          quadraticTo(60f, (48.5 + 14.0 * pose.mouthOpen).toFloat(), 67.5f, 48.5f)
          close()
        }
      drawPath(grin, EyeDark)
    }
    kotlin.math.abs(pose.mouthCurve) > 0.05 -> {
      val curve =
        Path().apply {
          moveTo(52.5f, 49f)
          quadraticTo(60f, (49.0 + 8.0 * pose.mouthCurve).toFloat(), 67.5f, 49f)
        }
      drawPath(curve, EyeDark, style = Stroke(width = 2.2f, cap = StrokeCap.Round))
    }
  }
}

private fun DrawScope.drawBlush(pose: MascotPose) {
  if (pose.blush <= 0.02) return
  val alpha = (pose.blush * 0.55).toFloat()
  drawOval(Blush, topLeft = Offset(32.5f, 42.5f), size = Size(9f, 5f), alpha = alpha)
  drawOval(Blush, topLeft = Offset(78.5f, 42.5f), size = Size(9f, 5f), alpha = alpha)
}

private fun DrawScope.drawHardHat(
  amount: Float,
  tint: Color?,
) {
  if (amount <= 0.01f) return
  withTransform({
    translate(top = -14f * (1f - amount))
    rotate(-5f, pivot = Offset(60f, 15f))
  }) {
    val fill =
      tint?.let(::SolidColor)
        ?: Brush.verticalGradient(colors = listOf(HatLight, HatAmber), startY = 3f, endY = 16f)
    drawPath(HardHatDomePath, fill, alpha = amount)
    if (tint == null) {
      drawPath(HardHatDomePath, HatOutline, alpha = amount, style = Stroke(width = 0.8f))
    }
    drawRoundRect(
      brush = tint?.let(::SolidColor) ?: SolidColor(HatAmber),
      topLeft = Offset(41f, 14f),
      size = Size(38f, 5f),
      cornerRadius = CornerRadius(2f, 2f),
      alpha = amount,
    )
    if (tint == null) {
      drawRoundRect(
        color = HatOutline,
        topLeft = Offset(41f, 14f),
        size = Size(38f, 5f),
        cornerRadius = CornerRadius(2f, 2f),
        alpha = amount,
        style = Stroke(width = 0.8f),
      )
    }
  }
}

private fun DrawScope.drawEffect(pose: MascotPose) {
  when (pose.effect) {
    MascotEffect.None -> Unit
    MascotEffect.Sparkles -> {
      repeat(6) { index ->
        val phase = (pose.effectPhase + index * 0.37) % 1.0
        val alpha = effectBell(phase)
        if (alpha > 0.05) {
          val angle = PI + PI * (index + 0.5) / 6.0
          val center =
            Offset(
              x = (60.0 + cos(angle) * (50.0 + index % 3 * 4.0)).toFloat(),
              y = (55.0 + sin(angle) * (40.0 + (index * 5) % 3 * 4.0)).toFloat(),
            )
          drawPath(
            sparklePath(center, (2.5 + 2.0 * alpha).toFloat()),
            if (index % 2 == 0) EyeGlow else CoralBright,
            alpha = alpha.toFloat(),
          )
        }
      }
    }
    MascotEffect.Zzz -> {
      repeat(3) { index ->
        val phase = (pose.effectPhase + index * 0.33) % 1.0
        val alpha = if (phase < 0.2) phase / 0.2 else 1.0 - (phase - 0.2) / 0.8
        if (alpha > 0.05) {
          drawZ(
            position =
              Offset(
                x = (86.0 + 14.0 * phase + 2.0 * sin(phase * 4.0 * PI)).toFloat(),
                y = (24.0 - 20.0 * phase).toFloat(),
              ),
            size = (6.0 + 4.0 * phase).toFloat(),
            alpha = alpha.toFloat(),
          )
        }
      }
    }
    MascotEffect.Sparks -> {
      repeat(5) { index ->
        val rawPhase = pose.effectPhase - index * 0.025
        if (rawPhase >= 0.0 && rawPhase < 0.45) {
          val alpha = if (rawPhase < 0.08) rawPhase / 0.08 else 1.0 - (rawPhase - 0.08) / 0.37
          val angle = Math.toRadians(-160.0 + index * 35.0)
          val radius = 5.0 + 12.0 * rawPhase / 0.45
          val particleSize = (2.2 + index % 3 * 0.8).toFloat()
          val center =
            Offset(
              x = (106.0 + cos(angle) * radius).coerceIn(particleSize.toDouble(), 120.0 - particleSize).toFloat(),
              y = (66.0 + sin(angle) * radius).coerceIn(particleSize.toDouble(), 120.0 - particleSize).toFloat(),
            )
          drawPath(
            sparklePath(center, particleSize),
            if (index % 2 == 0) EyeGlow else HatAmber,
            alpha = alpha.toFloat(),
          )
        }
      }
    }
    MascotEffect.Sweat -> {
      val alpha = effectBell(pose.effectPhase)
      if (alpha > 0.02) {
        val center = Offset(42f, (24.0 + 7.0 * pose.effectPhase).toFloat())
        val drop =
          Path().apply {
            moveTo(center.x, center.y - 3f)
            cubicTo(center.x - 4f, center.y + 1f, center.x - 2f, center.y + 3f, center.x, center.y + 3f)
            cubicTo(center.x + 2f, center.y + 3f, center.x + 4f, center.y + 1f, center.x, center.y - 3f)
            close()
          }
        drawPath(drop, SweatBlue, alpha = alpha.toFloat())
      }
    }
  }
}

private fun sparklePath(
  center: Offset,
  size: Float,
): Path =
  Path().apply {
    moveTo(center.x, center.y - size)
    listOf(1f to 0f, 0f to 1f, -1f to 0f, 0f to -1f).forEach { (dx, dy) ->
      quadraticTo(center.x, center.y, center.x + size * dx, center.y + size * dy)
    }
    close()
  }

private fun DrawScope.drawZ(
  position: Offset,
  size: Float,
  alpha: Float,
) {
  val width = size * 0.62f
  val height = size * 0.78f
  val path =
    Path().apply {
      moveTo(position.x - width / 2f, position.y - height / 2f)
      lineTo(position.x + width / 2f, position.y - height / 2f)
      lineTo(position.x - width / 2f, position.y + height / 2f)
      lineTo(position.x + width / 2f, position.y + height / 2f)
    }
  drawPath(
    path = path,
    color = EyeGlow,
    alpha = alpha * 0.9f,
    style = Stroke(width = max(1.2f, size * 0.16f), cap = StrokeCap.Round, join = StrokeJoin.Round),
  )
}

private fun effectBell(value: Double): Double {
  val t = value.coerceIn(0.0, 1.0)
  val edge = if (t < 0.5) t * 2.0 else (1.0 - t) * 2.0
  return edge * edge * (3.0 - 2.0 * edge)
}
