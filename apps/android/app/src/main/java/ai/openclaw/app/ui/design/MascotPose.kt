package ai.openclaw.app.ui.design

enum class MascotMood {
  Idle,
  Curious,
  Thinking,
  Working,
  Happy,
  Celebrating,
  Sad,
  Sleepy,
  Attentive,
}

enum class MascotEffect {
  None,
  Sparkles,
  Zzz,
  Sparks,
  Sweat,
}

data class MascotGaze(
  val x: Double = 0.0,
  val y: Double = 0.0,
)

data class MascotPose(
  var floatOffset: Double = 0.0,
  var antennaDegrees: Double = 0.0,
  var antennaDroop: Double = 0.0,
  var leftClawDegrees: Double = 0.0,
  var rightClawDegrees: Double = 0.0,
  var eyeGlowAlpha: Double = 1.0,
  var glowScale: Double = 1.0,
  var leftEyeOpenness: Double = 1.0,
  var rightEyeOpenness: Double = 1.0,
  var happyEyes: Double = 0.0,
  var gaze: MascotGaze = MascotGaze(),
  var mouthCurve: Double = 0.0,
  var mouthOpen: Double = 0.0,
  var mouthRound: Double = 0.0,
  var blush: Double = 0.0,
  var hardHat: Double = 0.0,
  var bodyTilt: Double = 0.0,
  var bodyStretch: Double = 1.0,
  var effect: MascotEffect = MascotEffect.None,
  var effectPhase: Double = 0.0,
) {
  /** Keeps every channel inside the drawable 120x120 art-space bounds. */
  fun clamp(): MascotPose {
    floatOffset = floatOffset.coerceIn(-12.0, 2.0)
    antennaDegrees = antennaDegrees.coerceIn(-14.0, 14.0)
    antennaDroop = antennaDroop.coerceIn(0.0, 1.0)
    leftClawDegrees = leftClawDegrees.coerceIn(-45.0, 45.0)
    rightClawDegrees = rightClawDegrees.coerceIn(-45.0, 45.0)
    eyeGlowAlpha = eyeGlowAlpha.coerceIn(0.0, 1.0)
    glowScale = glowScale.coerceIn(0.5, 1.6)
    leftEyeOpenness = leftEyeOpenness.coerceIn(0.0, 1.0)
    rightEyeOpenness = rightEyeOpenness.coerceIn(0.0, 1.0)
    happyEyes = happyEyes.coerceIn(0.0, 1.0)
    gaze = MascotGaze(gaze.x.coerceIn(-1.2, 1.2), gaze.y.coerceIn(-1.2, 1.2))
    mouthCurve = mouthCurve.coerceIn(-1.0, 1.0)
    mouthOpen = mouthOpen.coerceIn(0.0, 1.0)
    mouthRound = mouthRound.coerceIn(0.0, 1.0)
    blush = blush.coerceIn(0.0, 1.0)
    hardHat = hardHat.coerceIn(0.0, 1.0)
    bodyTilt = bodyTilt.coerceIn(-8.0, 8.0)
    bodyStretch = bodyStretch.coerceIn(0.86, 1.05)
    return this
  }

  companion object {
    /** Motionless mood expression used when Android animations are disabled. */
    fun staticPose(mood: MascotMood): MascotPose =
      MascotPose().apply {
        when (mood) {
          MascotMood.Idle,
          MascotMood.Curious,
          MascotMood.Attentive,
          -> Unit
          MascotMood.Thinking -> gaze = MascotGaze(x = 0.3, y = -0.5)
          MascotMood.Working -> {
            hardHat = 1.0
            rightClawDegrees = -28.0
            gaze = MascotGaze(x = 0.4, y = 0.35)
            mouthCurve = 0.15
            bodyTilt = 2.0
          }
          MascotMood.Happy -> {
            mouthCurve = 0.6
            happyEyes = 0.4
          }
          MascotMood.Celebrating -> {
            mouthCurve = 0.9
            mouthOpen = 0.4
            happyEyes = 0.8
            leftClawDegrees = 30.0
            rightClawDegrees = -30.0
          }
          MascotMood.Sad -> {
            antennaDroop = 0.75
            mouthCurve = -0.55
            eyeGlowAlpha = 0.6
            gaze = MascotGaze(x = 0.0, y = 0.5)
          }
          MascotMood.Sleepy -> {
            leftEyeOpenness = 0.25
            rightEyeOpenness = 0.25
            eyeGlowAlpha = 0.5
            antennaDroop = 0.35
          }
        }
      }
  }
}

fun staticPose(mood: MascotMood): MascotPose = MascotPose.staticPose(mood)

/**
 * Tinted silhouettes stay on the ambient idle loop: mood faces cannot read in
 * monochrome, and tiny tinted toolbar marks must not hammer or celebrate.
 */
internal fun effectiveMascotMood(
  mood: MascotMood,
  tinted: Boolean,
): MascotMood = if (tinted) MascotMood.Idle else mood
