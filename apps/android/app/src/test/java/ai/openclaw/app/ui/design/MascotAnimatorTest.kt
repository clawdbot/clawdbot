package ai.openclaw.app.ui.design

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MascotAnimatorTest {
  @Test
  fun allMoodChannelsStayInsideBoundsForThirtySeconds() {
    MascotMood.entries.forEachIndexed { index, mood ->
      val animator = MascotAnimator(seed = (index + 1).toULong())
      animator.setMood(mood, 0.0)

      repeat(3_001) { frame ->
        val pose = animator.poseAt(frame / 100.0)
        assertInBounds(pose, mood, frame)
      }
    }
  }

  @Test
  fun sameSeedProducesIdenticalPoses() {
    val first = MascotAnimator(seed = 0xCAFE_BABEuL)
    val second = MascotAnimator(seed = 0xCAFE_BABEuL)
    first.setMood(MascotMood.Curious, 0.0)
    second.setMood(MascotMood.Curious, 0.0)

    repeat(1_500) { frame ->
      val time = frame * 0.023
      if (frame == 400) {
        first.setMood(MascotMood.Thinking, time)
        second.setMood(MascotMood.Thinking, time)
      }
      if (frame == 900) {
        first.setMood(MascotMood.Happy, time)
        second.setMood(MascotMood.Happy, time)
      }
      assertEquals(first.poseAt(time), second.poseAt(time))
    }
  }

  @Test
  fun workingCycleSeatsHatSwingsClawAndShowsWorkEffects() {
    val animator = MascotAnimator(seed = 7uL)
    animator.setMood(MascotMood.Working, 0.0)
    var minRightClaw = Double.POSITIVE_INFINITY
    var maxRightClaw = Double.NEGATIVE_INFINITY
    var seatedHat = false
    var sawSparks = false
    var sawSweat = false

    repeat(2_001) { frame ->
      val time = frame / 100.0
      val pose = animator.poseAt(time)
      minRightClaw = minOf(minRightClaw, pose.rightClawDegrees)
      maxRightClaw = maxOf(maxRightClaw, pose.rightClawDegrees)
      seatedHat = seatedHat || (time >= 1.0 && pose.hardHat >= 0.99)
      sawSparks = sawSparks || pose.effect == MascotEffect.Sparks
      sawSweat = sawSweat || pose.effect == MascotEffect.Sweat
    }

    assertTrue("hard hat never seated", seatedHat)
    assertTrue("hammer swing was ${maxRightClaw - minRightClaw}°", maxRightClaw - minRightClaw > 25.0)
    assertTrue("impact sparks never appeared", sawSparks)
    assertTrue("wipe-brow sweat never appeared", sawSweat)
  }

  @Test
  fun moodChangeCancelsQueuedAndActiveGestures() {
    val animator = MascotAnimator(seed = 11uL)
    animator.poseAt(0.0)
    animator.poseAt(0.95)
    animator.setMood(MascotMood.Thinking, 0.95)

    val afterWaveCancellation = animator.poseAt(1.0)
    assertEquals(0.0, afterWaveCancellation.rightClawDegrees, 0.000_001)

    animator.setMood(MascotMood.Working, 1.1)
    assertTrue(animator.poseAt(1.3).hardHat < 1.0)
    animator.setMood(MascotMood.Sad, 1.3)

    val afterHatCancellation = animator.poseAt(1.31)
    assertEquals(0.0, afterHatCancellation.hardHat, 0.000_001)
  }

  @Test
  fun staticPoseSignaturesMatchMoodContract() {
    assertEquals(MascotPose(), staticPose(MascotMood.Idle))
    assertEquals(MascotGaze(x = 0.3, y = -0.5), staticPose(MascotMood.Thinking).gaze)

    val working = staticPose(MascotMood.Working)
    assertEquals(1.0, working.hardHat, 0.0)
    assertEquals(-28.0, working.rightClawDegrees, 0.0)

    val celebrating = staticPose(MascotMood.Celebrating)
    assertEquals(0.8, celebrating.happyEyes, 0.0)
    assertEquals(30.0, celebrating.leftClawDegrees, 0.0)
    assertEquals(-30.0, celebrating.rightClawDegrees, 0.0)

    val sad = staticPose(MascotMood.Sad)
    assertEquals(0.75, sad.antennaDroop, 0.0)
    assertEquals(-0.55, sad.mouthCurve, 0.0)

    val sleepy = staticPose(MascotMood.Sleepy)
    assertEquals(0.25, sleepy.leftEyeOpenness, 0.0)
    assertEquals(0.5, sleepy.eyeGlowAlpha, 0.0)
  }

  @Test
  fun clampCoversEveryBoundedChannel() {
    val pose =
      MascotPose(
        floatOffset = 100.0,
        antennaDegrees = -100.0,
        antennaDroop = 2.0,
        leftClawDegrees = -100.0,
        rightClawDegrees = 100.0,
        eyeGlowAlpha = -1.0,
        glowScale = 9.0,
        leftEyeOpenness = -1.0,
        rightEyeOpenness = 2.0,
        happyEyes = 2.0,
        gaze = MascotGaze(x = -9.0, y = 9.0),
        mouthCurve = -9.0,
        mouthOpen = 9.0,
        mouthRound = -9.0,
        blush = 9.0,
        hardHat = -9.0,
        bodyTilt = 90.0,
        bodyStretch = 9.0,
        effect = MascotEffect.Sweat,
        effectPhase = 0.75,
      ).clamp()

    assertEquals(2.0, pose.floatOffset, 0.0)
    assertEquals(-14.0, pose.antennaDegrees, 0.0)
    assertEquals(1.0, pose.antennaDroop, 0.0)
    assertEquals(-45.0, pose.leftClawDegrees, 0.0)
    assertEquals(45.0, pose.rightClawDegrees, 0.0)
    assertEquals(0.0, pose.eyeGlowAlpha, 0.0)
    assertEquals(1.6, pose.glowScale, 0.0)
    assertEquals(0.0, pose.leftEyeOpenness, 0.0)
    assertEquals(1.0, pose.rightEyeOpenness, 0.0)
    assertEquals(1.0, pose.happyEyes, 0.0)
    assertEquals(MascotGaze(x = -1.2, y = 1.2), pose.gaze)
    assertEquals(-1.0, pose.mouthCurve, 0.0)
    assertEquals(1.0, pose.mouthOpen, 0.0)
    assertEquals(0.0, pose.mouthRound, 0.0)
    assertEquals(1.0, pose.blush, 0.0)
    assertEquals(0.0, pose.hardHat, 0.0)
    assertEquals(8.0, pose.bodyTilt, 0.0)
    assertEquals(1.05, pose.bodyStretch, 0.0)
    assertEquals(MascotEffect.Sweat, pose.effect)
    assertEquals(0.75, pose.effectPhase, 0.0)
  }

  private fun assertInBounds(
    pose: MascotPose,
    mood: MascotMood,
    frame: Int,
  ) {
    val location = "$mood frame $frame"
    assertTrue(location, pose.floatOffset in -12.0..2.0)
    assertTrue(location, pose.antennaDegrees in -14.0..14.0)
    assertTrue(location, pose.antennaDroop in 0.0..1.0)
    assertTrue(location, pose.leftClawDegrees in -45.0..45.0)
    assertTrue(location, pose.rightClawDegrees in -45.0..45.0)
    assertTrue(location, pose.eyeGlowAlpha in 0.0..1.0)
    assertTrue(location, pose.glowScale in 0.5..1.6)
    assertTrue(location, pose.leftEyeOpenness in 0.0..1.0)
    assertTrue(location, pose.rightEyeOpenness in 0.0..1.0)
    assertTrue(location, pose.happyEyes in 0.0..1.0)
    assertTrue(location, pose.gaze.x in -1.2..1.2)
    assertTrue(location, pose.gaze.y in -1.2..1.2)
    assertTrue(location, pose.mouthCurve in -1.0..1.0)
    assertTrue(location, pose.mouthOpen in 0.0..1.0)
    assertTrue(location, pose.mouthRound in 0.0..1.0)
    assertTrue(location, pose.blush in 0.0..1.0)
    assertTrue(location, pose.hardHat in 0.0..1.0)
    assertTrue(location, pose.bodyTilt in -8.0..8.0)
    assertTrue(location, pose.bodyStretch in 0.86..1.05)
    assertTrue(location, pose.effectPhase in 0.0..1.0)
  }
}

class EffectiveMascotMoodTest {
  @Test
  fun `tinted mascots stay ambient regardless of requested mood`() {
    for (mood in MascotMood.entries) {
      assertEquals(MascotMood.Idle, effectiveMascotMood(mood = mood, tinted = true))
      assertEquals(mood, effectiveMascotMood(mood = mood, tinted = false))
    }
  }
}
