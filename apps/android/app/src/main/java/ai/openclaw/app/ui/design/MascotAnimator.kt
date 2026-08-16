package ai.openclaw.app.ui.design

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

private const val NONZERO_SEED: ULong = 0x9E37_79B9_7F4A_7C15uL
private const val XORSHIFT_MULTIPLIER: ULong = 2_685_821_657_736_338_717uL
private const val TAU = PI * 2.0
private const val BLINK_DURATION = 0.16
private const val CATCH_DURATION = 0.8

private enum class Gesture {
  Wave,
  Hop,
  Celebrate,
  Sigh,
  Yawn,
  ClawSnap,
  DonHardHat,
  WipeBrow,
}

private fun clamp(
  value: Double,
  min: Double = 0.0,
  max: Double = 1.0,
): Double = value.coerceIn(min, max)

private fun cyclePhase(
  time: Double,
  period: Double,
): Double {
  val normalized = (time / period) % 1.0
  return if (normalized < 0.0) normalized + 1.0 else normalized
}

private fun easeInOut(value: Double): Double {
  val t = clamp(value)
  return t * t * (3.0 - 2.0 * t)
}

private fun bell(value: Double): Double {
  val t = clamp(value)
  return easeInOut(if (t < 0.5) t * 2.0 else (1.0 - t) * 2.0)
}

private fun plateau(
  value: Double,
  attack: Double,
  release: Double,
): Double {
  val t = clamp(value)
  if (t < attack) return easeInOut(t / attack)
  if (t > release) return easeInOut((1.0 - t) / (1.0 - release))
  return 1.0
}

private fun gestureDuration(gesture: Gesture): Double =
  when (gesture) {
    Gesture.Wave -> 1.5
    Gesture.Hop -> 0.7
    Gesture.Celebrate -> 2.4
    Gesture.Sigh -> 1.8
    Gesture.Yawn,
    Gesture.WipeBrow,
    -> 2.0
    Gesture.ClawSnap -> 0.6
    Gesture.DonHardHat -> 1.0
  }

private class SeededGenerator(
  seed: ULong,
) {
  private var state = if (seed == 0uL) NONZERO_SEED else seed

  fun next(): ULong {
    state = state xor (state shr 12)
    state = state xor (state shl 25)
    state = state xor (state shr 27)
    return state * XORSHIFT_MULTIPLIER
  }

  fun unit(): Double = (next() shr 11).toDouble() / 9_007_199_254_740_992.0
}

/** Pure deterministic mood loops plus randomized blink, gaze, claw-snap, and mood-beat schedules. */
class MascotAnimator(
  seed: ULong = System.nanoTime().toULong(),
) {
  private val rng = SeededGenerator(seed)
  private var currentMood = MascotMood.Idle
  private var startTime: Double? = null
  private var lastPoseTime = 0.0
  private var activeGesture: Gesture? = null
  private var activeGestureStart = 0.0
  private var pendingGesture: Gesture? = null
  private var pendingGestureAt = 0.0
  private var nextBlinkAt = 0.0
  private var pendingDoubleBlink = false
  private val blinkStarts = mutableListOf<Double>()
  private var nextGlanceAt = 0.0
  private var gazeHoldUntil = 0.0
  private var gazeTarget = MascotGaze()
  private var currentGaze = MascotGaze()
  private var nextClawSnapAt = 0.0
  private var nextMoodBeatAt = 0.0
  private var teaseActive = false
  private var teaseChangedAt = 0.0
  private var catchStartedAt: Double? = null

  fun setMood(
    mood: MascotMood,
    timeSeconds: Double,
  ) {
    if (mood == currentMood) return
    currentMood = mood
    // Do not let a queued hello or old mood gesture leak into the new body language.
    pendingGesture = null
    activeGesture = null
    rescheduleMoodBeat(timeSeconds)
    entranceGesture(mood)?.let { startGesture(it, timeSeconds) }
  }

  fun setTease(
    active: Boolean,
    timeSeconds: Double,
  ) {
    teaseActive = active
    teaseChangedAt = timeSeconds
  }

  fun playCatch(timeSeconds: Double) {
    catchStartedAt = timeSeconds
  }

  fun poseAt(timeSeconds: Double): MascotPose {
    if (startTime == null) begin(timeSeconds)
    val dt = clamp(timeSeconds - lastPoseTime, 0.0, 0.1)
    lastPoseTime = timeSeconds
    advanceSchedules(timeSeconds)

    // TS and Swift phase ambient loops from their host clocks. startTime only
    // gates first-run schedules; raw time here preserves cross-platform parity.
    val pose = basePose(currentMood, timeSeconds)
    applyGaze(pose, currentMood, timeSeconds, dt)
    applyBlinks(pose, timeSeconds)

    activeGesture?.let { gesture ->
      val progress = (timeSeconds - activeGestureStart) / gestureDuration(gesture)
      if (progress >= 1.0) {
        activeGesture = null
      } else {
        applyGesture(gesture, pose, progress)
      }
    }

    if (teaseActive && timeSeconds >= teaseChangedAt) {
      pose.mouthRound = max(pose.mouthRound, 0.5)
      pose.gaze = MascotGaze(x = 0.0, y = 0.6)
    }
    catchStartedAt?.let { startedAt ->
      val progress = (timeSeconds - startedAt) / CATCH_DURATION
      if (progress >= 1.0) {
        catchStartedAt = null
      } else if (progress >= 0.0) {
        val flash = bell(progress)
        applyGesture(Gesture.ClawSnap, pose, clamp(progress / 0.75))
        pose.happyEyes = max(pose.happyEyes, 0.9 * flash)
        pose.mouthCurve = max(pose.mouthCurve, 0.7 * flash)
        pose.blush = max(pose.blush, 0.65 * flash)
      }
    }

    return pose.clamp()
  }

  private fun begin(timeSeconds: Double) {
    startTime = timeSeconds
    lastPoseTime = timeSeconds
    nextBlinkAt = timeSeconds + random(0.8, 2.4)
    nextGlanceAt = timeSeconds + random(1.5, 4.0)
    nextClawSnapAt = timeSeconds + random(2.0, 5.0)
    rescheduleMoodBeat(timeSeconds)
    if (currentMood == MascotMood.Idle || currentMood == MascotMood.Curious || currentMood == MascotMood.Happy) {
      pendingGesture = Gesture.Wave
      pendingGestureAt = timeSeconds + 0.9
    }
  }

  private fun advanceSchedules(timeSeconds: Double) {
    if (timeSeconds >= nextBlinkAt) {
      blinkStarts.add(timeSeconds)
      if (pendingDoubleBlink) {
        pendingDoubleBlink = false
        nextBlinkAt = timeSeconds + blinkInterval()
      } else if (random(0.0, 1.0) < 0.14) {
        pendingDoubleBlink = true
        nextBlinkAt = timeSeconds + 0.34
      } else {
        nextBlinkAt = timeSeconds + blinkInterval()
      }
    }
    blinkStarts.removeAll { start -> timeSeconds - start > BLINK_DURATION }

    if (timeSeconds >= nextGlanceAt) {
      gazeTarget = randomGlanceTarget()
      gazeHoldUntil = timeSeconds + random(0.7, 1.9)
      nextGlanceAt = gazeHoldUntil + glanceInterval()
    } else if (timeSeconds >= gazeHoldUntil) {
      gazeTarget = MascotGaze()
    }

    if (timeSeconds >= nextClawSnapAt) {
      if (activeGesture == null && currentMood != MascotMood.Sad && currentMood != MascotMood.Working) {
        startGesture(Gesture.ClawSnap, timeSeconds)
      }
      nextClawSnapAt = timeSeconds + random(4.0, 9.0)
    }

    if (timeSeconds >= nextMoodBeatAt) {
      if (activeGesture == null) {
        when (currentMood) {
          MascotMood.Sad -> startGesture(Gesture.Sigh, timeSeconds)
          MascotMood.Sleepy -> startGesture(Gesture.Yawn, timeSeconds)
          MascotMood.Working -> startGesture(Gesture.WipeBrow, timeSeconds)
          else -> Unit
        }
      }
      rescheduleMoodBeat(timeSeconds)
    }

    val pending = pendingGesture
    if (pending != null && timeSeconds >= pendingGestureAt && activeGesture == null) {
      pendingGesture = null
      startGesture(pending, timeSeconds)
    }
  }

  private fun basePose(
    mood: MascotMood,
    timeSeconds: Double,
  ): MascotPose {
    val pose = MascotPose()
    when (mood) {
      MascotMood.Idle -> {
        pose.floatOffset = -4.8 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 4.0)))
        pose.antennaDegrees = -3.0 * sin(TAU * cyclePhase(timeSeconds, 2.0))
      }
      MascotMood.Curious -> {
        pose.floatOffset = -4.2 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 3.4)))
        pose.antennaDegrees = -4.0 * sin(TAU * cyclePhase(timeSeconds, 1.7))
        pose.bodyTilt = 1.6 * sin(TAU * cyclePhase(timeSeconds, 5.2))
      }
      MascotMood.Thinking -> {
        pose.floatOffset = -3.2 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 5.0)))
        pose.antennaDegrees = -5.0 * sin(TAU * cyclePhase(timeSeconds, 1.3))
        pose.bodyTilt = 2.0 * sin(TAU * cyclePhase(timeSeconds, 6.0))
        pose.eyeGlowAlpha = 0.9 + 0.1 * sin(TAU * cyclePhase(timeSeconds, 0.8))
      }
      MascotMood.Working -> {
        val phase = cyclePhase(timeSeconds, 0.95)
        pose.rightClawDegrees =
          when {
            phase < 0.05 -> -6.0
            phase < 0.6 -> -6.0 - 28.0 * easeInOut((phase - 0.05) / 0.55)
            phase < 0.72 -> {
              val strike = clamp((phase - 0.6) / 0.12)
              -34.0 + 46.0 * strike * strike
            }
            else -> 12.0 - 18.0 * easeInOut((phase - 0.72) / 0.28)
          }
        pose.leftClawDegrees = 4.0 + 2.0 * sin(TAU * phase)
        val impact = bell(clamp((phase - 0.72) / 0.14))
        pose.floatOffset = -2.0 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 3.8))) + 0.8 * impact
        pose.bodyStretch = 1.0 - 0.03 * impact
        pose.bodyTilt = 2.2 + 0.6 * sin(TAU * cyclePhase(timeSeconds, 5.0))
        if (phase >= 0.72) {
          val recoil = clamp((phase - 0.72) / 0.28)
          pose.antennaDegrees = 6.0 * (1.0 - recoil) * sin(recoil * 3.0 * PI)
        }
        pose.leftEyeOpenness = 0.85
        pose.rightEyeOpenness = 0.85
        pose.mouthCurve = 0.18
        pose.hardHat = 1.0
        pose.effect = MascotEffect.Sparks
        val strikePhase = (phase - 0.72) % 1.0
        pose.effectPhase = if (strikePhase < 0.0) strikePhase + 1.0 else strikePhase
      }
      MascotMood.Happy -> {
        pose.floatOffset = -6.0 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 3.0)))
        pose.antennaDegrees = -4.5 * sin(TAU * cyclePhase(timeSeconds, 1.6))
        pose.mouthCurve = 0.55 + 0.1 * sin(TAU * cyclePhase(timeSeconds, 3.0))
        pose.happyEyes = 0.35
      }
      MascotMood.Celebrating -> {
        val hop = abs(sin(TAU * cyclePhase(timeSeconds, 1.6)))
        pose.floatOffset = -9.0 * hop
        pose.bodyStretch = 1.0 + 0.03 * hop
        pose.antennaDegrees = -6.0 * sin(TAU * cyclePhase(timeSeconds, 0.8))
        val clawWave = sin(TAU * cyclePhase(timeSeconds, 0.9))
        pose.leftClawDegrees = 20.0 + 8.0 * clawWave
        pose.rightClawDegrees = -20.0 + 8.0 * clawWave
        pose.mouthCurve = 0.9
        pose.mouthOpen = 0.35
        pose.happyEyes = 0.7
        pose.glowScale = 1.1
        pose.effect = MascotEffect.Sparkles
        pose.effectPhase = cyclePhase(timeSeconds, 2.2)
      }
      MascotMood.Sad -> {
        pose.floatOffset = -2.4 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 5.5)))
        pose.antennaDegrees = -1.5 * sin(TAU * cyclePhase(timeSeconds, 3.0))
        pose.antennaDroop = 0.75
        pose.mouthCurve = -0.55
        pose.eyeGlowAlpha = 0.6
      }
      MascotMood.Sleepy -> {
        pose.floatOffset = -2.0 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 6.0)))
        pose.antennaDroop = 0.35
        pose.leftEyeOpenness = 0.22 + 0.08 * sin(TAU * cyclePhase(timeSeconds, 3.0))
        pose.rightEyeOpenness = pose.leftEyeOpenness
        pose.eyeGlowAlpha = 0.5
        pose.mouthRound = 0.15
        pose.bodyTilt = 2.5 * sin(TAU * cyclePhase(timeSeconds, 6.0))
        pose.effect = MascotEffect.Zzz
        pose.effectPhase = cyclePhase(timeSeconds, 3.0)
      }
      MascotMood.Attentive -> {
        pose.floatOffset = -3.0 * (1.0 - cos(TAU * cyclePhase(timeSeconds, 4.0)))
        pose.antennaDegrees = -2.5 * sin(TAU * cyclePhase(timeSeconds, 2.0))
        pose.mouthCurve = 0.25
      }
    }
    return pose
  }

  private fun applyGaze(
    pose: MascotPose,
    mood: MascotMood,
    timeSeconds: Double,
    dt: Double,
  ) {
    val target =
      when (mood) {
        MascotMood.Thinking -> MascotGaze(x = 0.4 * sin(TAU * cyclePhase(timeSeconds, 3.8)), y = -0.55)
        MascotMood.Working ->
          MascotGaze(
            x = 0.55 + 0.04 * sin(TAU * cyclePhase(timeSeconds, 4.6)),
            y = 0.45 + 0.02 * cos(TAU * cyclePhase(timeSeconds, 3.9)),
          )
        MascotMood.Attentive -> MascotGaze(x = gazeTarget.x * 0.5, y = 0.35)
        MascotMood.Sad -> MascotGaze(x = gazeTarget.x * 0.3, y = 0.5)
        MascotMood.Sleepy -> MascotGaze(x = 0.0, y = 0.4)
        MascotMood.Idle,
        MascotMood.Curious,
        MascotMood.Happy,
        MascotMood.Celebrating,
        -> gazeTarget
      }
    val blend = 1.0 - exp(-dt * 9.0)
    currentGaze =
      MascotGaze(
        x = currentGaze.x + (target.x - currentGaze.x) * blend,
        y = currentGaze.y + (target.y - currentGaze.y) * blend,
      )
    pose.gaze = currentGaze
  }

  private fun applyBlinks(
    pose: MascotPose,
    timeSeconds: Double,
  ) {
    if (pose.happyEyes >= 0.6) return
    for (start in blinkStarts) {
      val progress = (timeSeconds - start) / BLINK_DURATION
      if (progress < 0.0 || progress > 1.0) continue
      val closure = bell(progress)
      pose.leftEyeOpenness = min(pose.leftEyeOpenness, 1.0 - closure)
      pose.rightEyeOpenness = min(pose.rightEyeOpenness, 1.0 - closure)
      pose.eyeGlowAlpha *= max(0.3, 1.0 - closure)
    }
  }

  private fun applyGesture(
    gesture: Gesture,
    pose: MascotPose,
    progress: Double,
  ) {
    val p = clamp(progress)
    when (gesture) {
      Gesture.Wave -> {
        val raised = plateau(p, 0.18, 0.82)
        pose.rightClawDegrees += raised * (-28.0 + 9.0 * sin(p * 6.0 * PI))
        pose.bodyTilt += -2.0 * raised
        pose.mouthCurve = max(pose.mouthCurve, 0.5 * raised)
      }
      Gesture.Hop -> {
        val air = bell(clamp((p - 0.2) / 0.6))
        pose.floatOffset += -9.0 * air
        pose.bodyStretch +=
          0.045 * air -
          0.1 * bell(clamp(p / 0.2)) -
          0.06 * bell(clamp((p - 0.82) / 0.18))
        pose.mouthCurve = max(pose.mouthCurve, 0.4 * air)
      }
      Gesture.Celebrate -> {
        val envelope = plateau(p, 0.12, 0.88)
        val hops = abs(sin(p * 4.0 * PI))
        pose.floatOffset += -11.0 * hops * envelope
        pose.bodyStretch += 0.035 * hops * envelope
        pose.leftClawDegrees += 38.0 * envelope
        pose.rightClawDegrees += -38.0 * envelope
        pose.happyEyes = max(pose.happyEyes, envelope)
        pose.mouthCurve = max(pose.mouthCurve, envelope)
        pose.mouthOpen = max(pose.mouthOpen, 0.6 * bell(p))
        pose.antennaDroop = 0.0
        pose.glowScale = max(pose.glowScale, 1.0 + 0.2 * envelope)
        pose.effect = MascotEffect.Sparkles
        pose.effectPhase = p
      }
      Gesture.Sigh -> {
        val rise = easeInOut(clamp(p / 0.3))
        val fall = easeInOut(clamp((p - 0.3) / 0.45))
        pose.bodyStretch += 0.025 * rise - 0.08 * fall * (1.0 - clamp((p - 0.85) / 0.15))
        pose.gaze = MascotGaze(x = pose.gaze.x, y = 0.5 * fall)
        pose.antennaDroop = min(1.0, pose.antennaDroop + 0.15 * fall)
      }
      Gesture.Yawn -> {
        val openness = plateau(p, 0.3, 0.75)
        pose.mouthRound = max(pose.mouthRound, 0.9 * openness)
        pose.leftEyeOpenness = min(pose.leftEyeOpenness, 1.0 - 0.9 * openness)
        pose.rightEyeOpenness = min(pose.rightEyeOpenness, 1.0 - 0.9 * openness)
        pose.bodyStretch += 0.03 * openness
        pose.bodyTilt += -2.0 * openness
      }
      Gesture.ClawSnap -> {
        pose.leftClawDegrees += -8.0 * bell(clamp(p / 0.7))
        pose.rightClawDegrees += -8.0 * bell(clamp((p - 0.25) / 0.7))
      }
      Gesture.DonHardHat -> {
        val drop = easeInOut(clamp(p / 0.55))
        pose.hardHat = min(pose.hardHat, drop)
        if (p < 0.55) pose.gaze = MascotGaze(x = 0.0, y = -0.9 * (1.0 - p))
        pose.bodyStretch -= 0.04 * bell(clamp((p - 0.5) / 0.2))
        val ready = bell(clamp((p - 0.7) / 0.3))
        pose.leftClawDegrees += -8.0 * ready
        pose.rightClawDegrees += 8.0 * ready
      }
      Gesture.WipeBrow -> {
        val envelope = plateau(p, 0.2, 0.8)
        pose.leftClawDegrees *= 1.0 - envelope
        pose.rightClawDegrees *= 1.0 - envelope
        pose.leftClawDegrees += 38.0 * envelope * (0.9 + 0.1 * sin(p * 5.0 * PI))
        pose.bodyTilt *= 1.0 - envelope
        pose.bodyStretch += 0.02 * envelope
        pose.happyEyes = max(pose.happyEyes, 0.7 * envelope)
        pose.mouthCurve = max(pose.mouthCurve, 0.5 * envelope)
        pose.gaze = MascotGaze(x = pose.gaze.x * (1.0 - envelope), y = pose.gaze.y * (1.0 - envelope))
        pose.effect = MascotEffect.Sweat
        pose.effectPhase = p
      }
    }
  }

  private fun entranceGesture(mood: MascotMood): Gesture? =
    when (mood) {
      MascotMood.Happy -> Gesture.Hop
      MascotMood.Celebrating -> Gesture.Celebrate
      MascotMood.Sad -> Gesture.Sigh
      MascotMood.Sleepy -> Gesture.Yawn
      MascotMood.Working -> Gesture.DonHardHat
      MascotMood.Idle,
      MascotMood.Curious,
      MascotMood.Thinking,
      MascotMood.Attentive,
      -> null
    }

  private fun startGesture(
    gesture: Gesture,
    timeSeconds: Double,
  ) {
    activeGesture = gesture
    activeGestureStart = timeSeconds
  }

  private fun random(
    min: Double,
    max: Double,
  ): Double = min + (max - min) * rng.unit()

  private fun blinkInterval(): Double = if (currentMood == MascotMood.Attentive) random(1.8, 4.0) else random(2.2, 5.5)

  private fun glanceInterval(): Double =
    when (currentMood) {
      MascotMood.Curious -> random(1.6, 4.0)
      MascotMood.Thinking -> random(1.2, 3.0)
      else -> random(3.0, 8.0)
    }

  private fun randomGlanceTarget(): MascotGaze {
    val magnitude = random(0.5, 1.0)
    val angle = random(0.0, TAU)
    return MascotGaze(x = cos(angle) * magnitude, y = sin(angle) * magnitude * 0.6)
  }

  private fun rescheduleMoodBeat(timeSeconds: Double) {
    nextMoodBeatAt = timeSeconds + random(6.0, 12.0)
  }
}
