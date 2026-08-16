package ai.openclaw.wear

import android.animation.ValueAnimator
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import androidx.annotation.RequiresApi
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.flow.collect
import kotlin.coroutines.coroutineContext
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.sin

// Canonical 120x120 mascot geometry from ui/public/favicon.svg. Parts stay
// separate so the original silhouette can react without substituting artwork.
private val BodyPath by lazy {
  PathParser()
    .parsePathString(
      "M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 " +
        "C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z",
    ).toPath()
}
private val LeftClawPath by lazy {
  PathParser().parsePathString("M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z").toPath()
}
private val RightClawPath by lazy {
  PathParser().parsePathString("M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z").toPath()
}
private val LeftAntennaPath by lazy { PathParser().parsePathString("M45 15 Q35 5 30 8").toPath() }
private val RightAntennaPath by lazy { PathParser().parsePathString("M75 15 Q85 5 90 8").toPath() }

private val CoralBright = Color(0xFFFF4D4D)
private val CoralDark = Color(0xFF991B1B)
private val EyeDark = Color(0xFF050810)
private val EyeGlow = Color(0xFF00E5CC)
private val Tongue = Color(0xFFFF9EAE)
private val LeftClawPivot = Offset(26f, 53f)
private val RightClawPivot = Offset(94f, 53f)
private val LeftAntennaPivot = Offset(37.5f, 11f)
private val RightAntennaPivot = Offset(82.5f, 11f)
private val LeftEyeCenter = Offset(45f, 35f)
private val RightEyeCenter = Offset(75f, 35f)

internal data class WearAvatarPose(
  val floatOffset: Float,
  val bodyTilt: Float,
  val bodyStretch: Float,
  val antennaDegrees: Float,
  val antennaDroop: Float,
  val leftClawDegrees: Float,
  val rightClawDegrees: Float,
  val eyeOpenness: Float,
  val gaze: Offset,
  val mouthLevel: Float,
  val haloPulse: Float,
)

@Composable
internal fun WearTalkAvatar(
  state: RealtimeVoiceButtonState,
  mouthLevel: Float,
  syntheticSpeech: Boolean,
  accent: Color,
  danger: Color,
  modifier: Modifier = Modifier,
  animatorScaleSource: WearAnimatorScaleSource? = null,
  motionDurationScale: MotionDurationScale? = null,
  frameClock: WearAvatarFrameClock = ComposeWearAvatarFrameClock,
  onAnimationStateChanged: ((WearAvatarAnimationState) -> Unit)? = null,
) {
  val animationScale = rememberAnimatorDurationScale(animatorScaleSource, motionDurationScale)
  val animationsEnabled = animationScale > 0f
  val latestState by rememberUpdatedState(state)
  val latestMouthLevel by rememberUpdatedState(mouthLevel)
  val latestSyntheticSpeech by rememberUpdatedState(syntheticSpeech)
  var animationSeconds by remember { mutableFloatStateOf(0f) }
  var smoothedMouth by remember { mutableFloatStateOf(0f) }

  LaunchedEffect(animationScale, frameClock) {
    if (!animationsEnabled) {
      animationSeconds = 0f
      smoothedMouth = 0f
      return@LaunchedEffect
    }
    var lastFrameNanos = 0L
    while (true) {
      frameClock.awaitFrame { frameNanos ->
        if (lastFrameNanos != 0L) {
          val deltaSeconds =
            scaledAvatarDeltaSeconds(
              deltaSeconds = (frameNanos - lastFrameNanos) / 1_000_000_000f,
              durationScale = animationScale,
            )
          animationSeconds = (animationSeconds + deltaSeconds) % AVATAR_ANIMATION_CYCLE_SECONDS
          val targetMouth =
            if (latestState == RealtimeVoiceButtonState.SPEAKING) {
              max(
                latestMouthLevel.coerceIn(0f, 1f),
                if (latestSyntheticSpeech) syntheticSpeechMouth(animationSeconds) else 0f,
              )
            } else {
              0f
            }
          smoothedMouth = smoothAvatarMouth(smoothedMouth, targetMouth, deltaSeconds)
        }
        lastFrameNanos = frameNanos
      }
    }
  }

  val motionInputs = avatarMotionInputs(animationsEnabled, animationSeconds, smoothedMouth)
  val pose = avatarPoseAt(state, motionInputs.animationSeconds, motionInputs.mouthLevel)
  val stateColor = if (state == RealtimeVoiceButtonState.ERROR) danger else accent

  SideEffect {
    onAnimationStateChanged?.invoke(
      WearAvatarAnimationState(
        durationScale = animationScale,
        animationSeconds = motionInputs.animationSeconds,
        mouthLevel = motionInputs.mouthLevel,
      ),
    )
  }

  Canvas(modifier = modifier) {
    val unit = size.minDimension
    val center = Offset(size.width / 2f, size.height / 2f)
    drawCircle(
      color = stateColor.copy(alpha = 0.3f + (0.28f * pose.haloPulse)),
      radius = unit * (0.455f + (0.012f * pose.haloPulse)),
      center = center,
      style = Stroke(width = unit * 0.025f),
    )

    val artScale = unit / CANONICAL_ART_BOX
    val artLeft = center.x - ((CANONICAL_ART_SIZE * artScale) / 2f)
    val artTop = center.y - ((CANONICAL_ART_SIZE * artScale) / 2f) + (unit * 0.025f)
    withTransform({ translate(left = artLeft, top = artTop) }) {
      withTransform({ scale(artScale, artScale, pivot = Offset.Zero) }) {
        drawCanonicalAvatar(pose, state, motionInputs.animationSeconds)
      }
    }
  }
}

@Composable
internal fun rememberAnimatorDurationScale(
  animatorScaleSource: WearAnimatorScaleSource? = null,
  motionDurationScale: MotionDurationScale? = null,
): Float {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val effectiveScaleSource =
    animatorScaleSource
      ?: remember(context, lifecycleOwner) {
        AndroidWearAnimatorScaleSource(context.applicationContext, lifecycleOwner)
      }
  val effectiveScale = rememberEffectiveAnimatorScale(effectiveScaleSource)
  var canonicalScale by remember(motionDurationScale) {
    mutableFloatStateOf(motionDurationScale?.scaleFactor?.coerceAtLeast(0f) ?: 1f)
  }

  LaunchedEffect(motionDurationScale) {
    val composeScale = motionDurationScale ?: coroutineContext[MotionDurationScale]
    if (composeScale == null) {
      canonicalScale = 1f
      return@LaunchedEffect
    }
    // Compose lazily starts its Android scale observer from this getter, which
    // may write snapshot state and therefore must run before snapshotFlow.
    canonicalScale = composeScale.scaleFactor.coerceAtLeast(0f)
    snapshotFlow { composeScale.scaleFactor.coerceAtLeast(0f) }
      .collect { scale -> canonicalScale = scale }
  }

  return resolvedAvatarAnimationScale(canonicalScale, effectiveScale)
}

@Composable
private fun rememberEffectiveAnimatorScale(source: WearAnimatorScaleSource): Float {
  var effectiveScale by remember(source) { mutableFloatStateOf(source.currentScale()) }

  DisposableEffect(source) {
    effectiveScale = source.currentScale()
    val subscription = source.subscribe { scale -> effectiveScale = scale.coerceAtLeast(0f) }
    onDispose { subscription.dispose() }
  }

  return effectiveScale
}

internal fun resolvedAvatarAnimationScale(
  canonicalScale: Float,
  effectiveScale: Float,
): Float = if (canonicalScale > 0f && effectiveScale > 0f) canonicalScale else 0f

internal fun interface WearAnimatorScaleSubscription {
  fun dispose()
}

internal interface WearAnimatorScaleSource {
  fun currentScale(): Float

  fun subscribe(onScaleChanged: (Float) -> Unit): WearAnimatorScaleSubscription
}

internal class AndroidWearAnimatorScaleSource(
  private val context: Context,
  private val lifecycleOwner: LifecycleOwner,
) : WearAnimatorScaleSource {
  private val powerManager = context.getSystemService(PowerManager::class.java)

  override fun currentScale(): Float =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ValueAnimator.getDurationScale().coerceAtLeast(0f)
    } else {
      // Compose owns the user duration scale. Legacy Android exposes no listener
      // for Battery Saver's separate override, so keep only that signal here.
      if (powerManager.isPowerSaveMode) 0f else 1f
    }

  override fun subscribe(onScaleChanged: (Float) -> Unit): WearAnimatorScaleSubscription =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      subscribeToDurationScale(onScaleChanged)
    } else {
      subscribeToLegacyEffectiveScale(onScaleChanged)
    }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun subscribeToDurationScale(
    onScaleChanged: (Float) -> Unit,
  ): WearAnimatorScaleSubscription {
    val listener =
      ValueAnimator.DurationScaleChangeListener { scale ->
        onScaleChanged(scale.coerceAtLeast(0f))
      }
    ValueAnimator.registerDurationScaleChangeListener(listener)
    onScaleChanged(currentScale())
    return WearAnimatorScaleSubscription {
      ValueAnimator.unregisterDurationScaleChangeListener(listener)
    }
  }

  @Suppress("UnspecifiedRegisterReceiverFlag")
  private fun subscribeToLegacyEffectiveScale(onScaleChanged: (Float) -> Unit): WearAnimatorScaleSubscription {
    val refresh = { onScaleChanged(currentScale()) }
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(
          context: Context?,
          intent: Intent?,
        ) {
          refresh()
        }
      }
    val lifecycleObserver =
      object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
          refresh()
        }

        override fun onResume(owner: LifecycleOwner) {
          refresh()
        }
      }

    context.registerReceiver(receiver, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    lifecycleOwner.lifecycle.addObserver(lifecycleObserver)
    refresh()

    return WearAnimatorScaleSubscription {
      context.unregisterReceiver(receiver)
      lifecycleOwner.lifecycle.removeObserver(lifecycleObserver)
    }
  }
}

internal fun interface WearAvatarFrameClock {
  suspend fun awaitFrame(onFrame: (Long) -> Unit)
}

private val ComposeWearAvatarFrameClock = WearAvatarFrameClock { onFrame -> withFrameNanos(onFrame) }

internal data class WearAvatarAnimationState(
  val durationScale: Float,
  val animationSeconds: Float,
  val mouthLevel: Float,
)

internal data class WearAvatarMotionInputs(
  val animationSeconds: Float,
  val mouthLevel: Float,
)

internal fun avatarMotionInputs(
  animationsEnabled: Boolean,
  animationSeconds: Float,
  mouthLevel: Float,
): WearAvatarMotionInputs =
  if (animationsEnabled) {
    WearAvatarMotionInputs(
      animationSeconds = animationSeconds,
      mouthLevel = mouthLevel.coerceIn(0f, 1f),
    )
  } else {
    WearAvatarMotionInputs(animationSeconds = 0f, mouthLevel = 0f)
  }

private fun DrawScope.drawCanonicalAvatar(
  pose: WearAvatarPose,
  state: RealtimeVoiceButtonState,
  animationSeconds: Float,
) {
  val stretchX = (1f + ((1f - pose.bodyStretch) * 0.5f)).coerceIn(0.96f, 1.04f)
  withTransform({ translate(top = pose.floatOffset) }) {
    withTransform({
      scale(stretchX, pose.bodyStretch, pivot = Offset(60f, 110f))
      rotate(pose.bodyTilt, pivot = Offset(60f, 60f))
    }) {
      drawPath(
        path = BodyPath,
        brush =
          Brush.linearGradient(
            colors = listOf(CoralBright, CoralDark),
            start = Offset(15f, 10f),
            end = Offset(105f, 110f),
          ),
      )
      withTransform({ rotate(pose.leftClawDegrees, pivot = LeftClawPivot) }) {
        drawPath(
          path = LeftClawPath,
          brush =
            Brush.linearGradient(
              colors = listOf(CoralBright, CoralDark),
              start = Offset(3.125f, 43.67f),
              end = Offset(26.197f, 65.451f),
            ),
        )
      }
      withTransform({ rotate(pose.rightClawDegrees, pivot = RightClawPivot) }) {
        drawPath(
          path = RightClawPath,
          brush =
            Brush.linearGradient(
              colors = listOf(CoralBright, CoralDark),
              start = Offset(93.803f, 43.67f),
              end = Offset(116.875f, 65.451f),
            ),
        )
      }

      val antennaStroke = Stroke(width = 2f, cap = StrokeCap.Round)
      val wiggle = pose.antennaDegrees * (1f - pose.antennaDroop)
      withTransform({ rotate((-pose.antennaDroop * 40f), pivot = Offset(45f, 15f)) }) {
        withTransform({ rotate(wiggle, pivot = LeftAntennaPivot) }) {
          drawPath(LeftAntennaPath, CoralBright, style = antennaStroke)
        }
      }
      withTransform({ rotate((pose.antennaDroop * 40f), pivot = Offset(75f, 15f)) }) {
        withTransform({ rotate(wiggle, pivot = RightAntennaPivot) }) {
          drawPath(RightAntennaPath, CoralBright, style = antennaStroke)
        }
      }

      drawCanonicalEye(LeftEyeCenter, pose.eyeOpenness, pose.gaze)
      drawCanonicalEye(RightEyeCenter, pose.eyeOpenness, pose.gaze)
      drawCanonicalMouth(state, pose.mouthLevel, animationSeconds)
    }
  }
}

private fun DrawScope.drawCanonicalEye(
  center: Offset,
  openness: Float,
  gaze: Offset,
) {
  val eyeHeight = max(1.2f, 12f * openness)
  val eyeCenterY = center.y - 6f + ((12f - eyeHeight) * 0.65f) + (eyeHeight / 2f)
  drawOval(
    color = EyeDark,
    topLeft = Offset(center.x - 6f, eyeCenterY - (eyeHeight / 2f)),
    size = Size(12f, eyeHeight),
  )
  if (openness <= 0.16f) return

  val pupil =
    Offset(
      x = center.x + (gaze.x * 2.7f),
      y = center.y - 1f + (gaze.y * 2.1f),
    )
  drawCircle(
    color = EyeGlow,
    radius = 2.1f,
    center = pupil,
    alpha = ((openness - 0.16f) / 0.84f).coerceIn(0f, 1f),
  )
}

private fun DrawScope.drawCanonicalMouth(
  state: RealtimeVoiceButtonState,
  mouthLevel: Float,
  animationSeconds: Float,
) {
  if (state == RealtimeVoiceButtonState.ERROR) {
    val frown =
      Path().apply {
        moveTo(52.5f, 54f)
        quadraticTo(60f, 47f, 67.5f, 54f)
      }
    drawPath(frown, EyeDark, style = Stroke(width = 2.2f, cap = StrokeCap.Round))
    return
  }
  if (state != RealtimeVoiceButtonState.SPEAKING || mouthLevel <= 0.025f) return

  val vowelShape = 0.5f + (0.5f * sin(animationSeconds * 2f * PI.toFloat() / 0.31f))
  val radiusX = 2.2f + (mouthLevel * (4.7f + (1.6f * vowelShape)))
  val radiusY = 1.1f + (mouthLevel * (6.5f - (1.3f * vowelShape)))
  drawOval(
    color = EyeDark,
    topLeft = Offset(60f - radiusX, 52f - radiusY),
    size = Size(radiusX * 2f, radiusY * 2f),
  )
  if (mouthLevel > 0.48f) {
    drawOval(
      color = Tongue,
      topLeft = Offset(60f - (radiusX * 0.55f), 52f + (radiusY * 0.24f)),
      size = Size(radiusX * 1.1f, radiusY * 0.42f),
      alpha = ((mouthLevel - 0.48f) / 0.52f).coerceIn(0f, 0.82f),
    )
  }
}

internal fun avatarPoseAt(
  state: RealtimeVoiceButtonState,
  animationSeconds: Float,
  mouthLevel: Float,
): WearAvatarPose {
  val tau = 2f * PI.toFloat()
  val breathing = sin(animationSeconds * tau / 3.8f)
  var floatOffset = -2.6f * (1f - cos(animationSeconds * tau / 4.2f))
  var bodyTilt = 0.8f * sin(animationSeconds * tau / 6.4f)
  var bodyStretch = 1f + (0.012f * breathing)
  var antennaDegrees = -3f * sin(animationSeconds * tau / 2.1f)
  var antennaDroop = 0f
  var leftClawDegrees = 0f
  var rightClawDegrees = 0f
  var gaze = Offset(0.45f * sin(animationSeconds * tau / 7.5f), 0.2f * sin(animationSeconds * tau / 5.8f))
  var eyeOpenness = 1f - (0.96f * avatarBlinkClosure(animationSeconds))
  var haloPulse = 0.5f + (0.5f * sin(animationSeconds * tau / 2.4f))

  when (state) {
    RealtimeVoiceButtonState.IDLE -> Unit
    RealtimeVoiceButtonState.CONNECTING -> {
      val orbit = animationSeconds * tau / 1.65f
      gaze = Offset(cos(orbit) * 1.05f, sin(orbit) * 0.82f)
      bodyTilt = 2f * sin(animationSeconds * tau / 2.8f)
      antennaDegrees = -7f * sin(animationSeconds * tau / 1.1f)
      leftClawDegrees = 3f * sin(animationSeconds * tau / 1.4f)
      rightClawDegrees = -leftClawDegrees
      haloPulse = 0.5f + (0.5f * sin(animationSeconds * tau / 0.9f))
    }
    RealtimeVoiceButtonState.LISTENING -> {
      val attentivePulse = 0.5f + (0.5f * sin(animationSeconds * tau / 1.25f))
      gaze = Offset(0.2f * sin(animationSeconds * tau / 3.2f), 0.34f)
      bodyStretch += 0.018f * attentivePulse
      leftClawDegrees = 4f + (2f * attentivePulse)
      rightClawDegrees = -leftClawDegrees
      antennaDegrees = -4f * sin(animationSeconds * tau / 1.45f)
      haloPulse = attentivePulse
    }
    RealtimeVoiceButtonState.THINKING -> {
      val orbit = animationSeconds * tau / 2.15f
      gaze = Offset(cos(orbit) * 1.15f, sin(orbit) * 0.92f)
      bodyTilt = 2.8f * sin(animationSeconds * tau / 4.5f)
      antennaDegrees = -7f * sin(animationSeconds * tau / 1.25f)
      leftClawDegrees = 5f + (2f * sin(animationSeconds * tau / 2.7f))
      rightClawDegrees = -10f - (3f * sin(animationSeconds * tau / 2.2f))
      haloPulse = 0.5f + (0.5f * sin(animationSeconds * tau / 1.4f))
    }
    RealtimeVoiceButtonState.SPEAKING -> {
      val speechBeat = sin(animationSeconds * tau / 0.72f)
      floatOffset -= mouthLevel * 2.2f
      bodyStretch += (mouthLevel * 0.055f) + (speechBeat * 0.008f)
      bodyTilt = 1.5f * sin(animationSeconds * tau / 2.1f)
      antennaDegrees = -5f * sin(animationSeconds * tau / 0.95f)
      leftClawDegrees = 4f + (mouthLevel * 10f) + (speechBeat * 2f)
      rightClawDegrees = -leftClawDegrees
      gaze = Offset(0.18f * sin(animationSeconds * tau / 2.6f), 0.12f)
      haloPulse = (0.25f + (mouthLevel * 0.75f)).coerceIn(0f, 1f)
    }
    RealtimeVoiceButtonState.ERROR -> {
      bodyTilt = 2.2f * sin(animationSeconds * tau / 0.42f)
      antennaDroop = 0.72f
      leftClawDegrees = -5f
      rightClawDegrees = 5f
      gaze = Offset(0f, 0.7f)
      eyeOpenness *= 0.72f
      haloPulse = 0.72f + (0.28f * sin(animationSeconds * tau / 0.8f))
    }
  }

  return WearAvatarPose(
    floatOffset = floatOffset,
    bodyTilt = bodyTilt,
    bodyStretch = bodyStretch.coerceIn(0.94f, 1.08f),
    antennaDegrees = antennaDegrees,
    antennaDroop = antennaDroop,
    leftClawDegrees = leftClawDegrees,
    rightClawDegrees = rightClawDegrees,
    eyeOpenness = eyeOpenness.coerceIn(0.04f, 1f),
    gaze = gaze,
    mouthLevel = mouthLevel.coerceIn(0f, 1f),
    haloPulse = haloPulse.coerceIn(0f, 1f),
  )
}

internal fun smoothAvatarMouth(
  current: Float,
  target: Float,
  deltaSeconds: Float,
): Float {
  val safeCurrent = current.coerceIn(0f, 1f)
  val safeTarget = target.coerceIn(0f, 1f)
  val safeDelta = deltaSeconds.coerceIn(0f, 0.05f)
  if (safeDelta == 0f) return safeCurrent

  val responseSeconds = if (safeTarget > safeCurrent) MOUTH_ATTACK_SECONDS else MOUTH_RELEASE_SECONDS
  val blend = (1.0 - exp((-safeDelta / responseSeconds).toDouble())).toFloat()
  return (safeCurrent + ((safeTarget - safeCurrent) * blend)).coerceIn(0f, 1f)
}

internal fun scaledAvatarDeltaSeconds(
  deltaSeconds: Float,
  durationScale: Float,
): Float {
  if (durationScale <= 0f) return 0f
  return (deltaSeconds / durationScale).coerceIn(0f, 0.05f)
}

private fun syntheticSpeechMouth(animationSeconds: Float): Float {
  val tau = 2f * PI.toFloat()
  val syllable = 0.5f + (0.5f * sin(animationSeconds * tau / 0.19f))
  val phrase = 0.68f + (0.32f * sin(animationSeconds * tau / 0.83f))
  return (0.1f + (0.72f * syllable * phrase)).coerceIn(0.08f, 0.86f)
}

private fun avatarBlinkClosure(animationSeconds: Float): Float {
  val phase = animationSeconds % BLINK_CYCLE_SECONDS
  return when {
    phase in FIRST_BLINK_START..FIRST_BLINK_END ->
      smoothBell((phase - FIRST_BLINK_START) / (FIRST_BLINK_END - FIRST_BLINK_START))
    phase in SECOND_BLINK_START..SECOND_BLINK_END ->
      smoothBell((phase - SECOND_BLINK_START) / (SECOND_BLINK_END - SECOND_BLINK_START))
    else -> 0f
  }
}

private fun smoothBell(value: Float): Float {
  val mirrored = if (value < 0.5f) value * 2f else (1f - value) * 2f
  val clamped = mirrored.coerceIn(0f, 1f)
  return clamped * clamped * (3f - (2f * clamped))
}

private const val CANONICAL_ART_SIZE = 120f
private const val CANONICAL_ART_BOX = 126f
private const val AVATAR_ANIMATION_CYCLE_SECONDS = 60f
private const val MOUTH_ATTACK_SECONDS = 0.045f
private const val MOUTH_RELEASE_SECONDS = 0.11f
private const val BLINK_CYCLE_SECONDS = 5.4f
private const val FIRST_BLINK_START = 3.58f
private const val FIRST_BLINK_END = 3.76f
private const val SECOND_BLINK_START = 4.02f
private const val SECOND_BLINK_END = 4.17f
