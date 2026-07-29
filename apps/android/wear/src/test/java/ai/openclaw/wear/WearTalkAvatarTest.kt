package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRpcMethod
import android.animation.ValueAnimator
import android.content.Intent
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowValueAnimator
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WearTalkAvatarTest {
  @Test
  fun silenceKeepsTheAvatarMouthClosed() {
    val pcm = ByteArray(samplesForFrames(2) * 2)

    assertEquals(listOf(0f, 0f), pcm16LeMouthLevels(pcm))
  }

  @Test
  fun outputPcmProducesOneBoundedMouthLevelPerPlaybackFrame() {
    val pcm = pcm16Le(samplesForFrames(2), sample = 24_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.all { level -> level in 0f..1f })
    assertTrue(levels.all { level -> level > 0.9f })
  }

  @Test
  fun finalPartialPlaybackFrameStillMovesTheMouth() {
    val pcm = pcm16Le(samplesForFrames(1) + 12, sample = 12_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.last() > 0f)
  }

  @Test
  fun consecutiveMaximumSizeChunksPreserveCumulativeWindowsAndFlushTheFinalPartial() {
    val chunks =
      listOf(
        pcm16Le(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES / 2, sample = 4_000),
        pcm16Le(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES / 2, sample = 20_000),
        pcm16Le(100, sample = 12_000),
      )
    val client = realtimeTalkClient()
    val queuedLevels = Channel<Float>(Channel.UNLIMITED)
    client.setPrivateField("activeNodeId", "watch-a")
    client.setPrivateField("mouthFrames", queuedLevels)

    try {
      val writeOutput = WearRealtimeTalkClient::class.java.getDeclaredMethod("writeOutput", ByteArray::class.java)
      writeOutput.isAccessible = true
      chunks.forEach { chunk -> writeOutput.invoke(client, chunk) }
      awaitPlaybackTeardown(client)

      val actualLevels =
        buildList {
          while (true) add(queuedLevels.tryReceive().getOrNull() ?: break)
        }
      assertEquals(pcm16LeMouthLevels(chunks.reduce(ByteArray::plus)), actualLevels)
    } finally {
      client.shutdown()
    }
  }

  @Test
  fun mouthEnvelopeUsesFastAttackAndSoftReleaseWithoutOvershoot() {
    val attack = smoothAvatarMouth(current = 0f, target = 1f, deltaSeconds = 0.02f)
    val release = smoothAvatarMouth(current = 1f, target = 0f, deltaSeconds = 0.02f)

    assertTrue(attack in 0f..1f)
    assertTrue(release in 0f..1f)
    assertTrue(attack > 0f)
    assertTrue(release > attack)
  }

  @Test
  fun mouthEnvelopeConvergesAcrossDisplayFrames() {
    var level = 0f
    repeat(30) { level = smoothAvatarMouth(level, target = 1f, deltaSeconds = 1f / 60f) }

    assertTrue(level > 0.99f)

    repeat(60) { level = smoothAvatarMouth(level, target = 0f, deltaSeconds = 1f / 60f) }

    assertTrue(level < 0.001f)
  }

  @Test
  fun avatarFrameDeltaHonorsAnimatorDurationScale() {
    val frameDelta = 1f / 60f

    assertEquals(1f / 30f, scaledAvatarDeltaSeconds(frameDelta, durationScale = 0.5f), 0.000_001f)
    assertEquals(frameDelta, scaledAvatarDeltaSeconds(frameDelta, durationScale = 1f), 0.000_001f)
    assertEquals(1f / 120f, scaledAvatarDeltaSeconds(frameDelta, durationScale = 2f), 0.000_001f)
  }

  @Test
  fun zeroAnimatorDurationScaleStopsAvatarTime() {
    assertEquals(0f, scaledAvatarDeltaSeconds(deltaSeconds = 1f / 60f, durationScale = 0f), 0f)
  }

  @Test
  fun effectiveScaleTransitionsStopAndRestartTheClockWhileComposed() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val scaleSource = FakeWearAnimatorScaleSource(initialScale = 1f)
    val motionDurationScale = FakeMotionDurationScale(initialScale = 1f)
    val frameClock = FakeWearAvatarFrameClock()
    val observedStates = mutableListOf<WearAvatarAnimationState>()

    controller.get().setContent {
      WearTalkAvatar(
        state = RealtimeVoiceButtonState.SPEAKING,
        mouthLevel = 1f,
        syntheticSpeech = false,
        accent = Color.Cyan,
        danger = Color.Red,
        animatorScaleSource = scaleSource,
        motionDurationScale = motionDurationScale,
        frameClock = frameClock,
        onAnimationStateChanged = observedStates::add,
      )
    }
    idleMainLooper()

    assertEquals(1, scaleSource.subscriptionCount)
    assertEquals(1f, observedStates.last().durationScale, 0f)
    frameClock.sendFrame(1_000_000_000L)
    idleMainLooper()
    frameClock.sendFrame(1_016_666_667L)
    idleMainLooper()
    assertTrue(observedStates.last().animationSeconds > 0f)

    scaleSource.emit(0f)
    idleMainLooper()
    assertEquals(0f, observedStates.last().durationScale, 0f)
    assertEquals(0f, observedStates.last().animationSeconds, 0f)
    assertEquals(0f, observedStates.last().mouthLevel, 0f)
    val frameRequestsAtZero = frameClock.awaitCount
    idleMainLooper(Duration.ofMillis(100))
    assertEquals(frameRequestsAtZero, frameClock.awaitCount)

    scaleSource.emit(1f)
    idleMainLooper()
    assertEquals(1f, observedStates.last().durationScale, 0f)
    assertTrue(frameClock.awaitCount > frameRequestsAtZero)

    motionDurationScale.scaleFactor = 2f
    idleMainLooper()
    assertEquals(2f, observedStates.last().durationScale, 0f)

    controller.pause().stop().destroy()
    idleMainLooper()
    assertEquals(1, scaleSource.disposeCount)
    assertEquals(0, scaleSource.activeSubscriptionCount)
  }

  @Test
  @Config(sdk = [32])
  fun api31And32CanonicalScaleRestartsClockWithoutEffectiveScaleCallback() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val lifecycleOwner = TestLifecycleOwner()
    val scaleSource = AndroidWearAnimatorScaleSource(RuntimeEnvironment.getApplication(), lifecycleOwner)
    val motionDurationScale = FakeMotionDurationScale(initialScale = 0f)
    val frameClock = FakeWearAvatarFrameClock()
    val observedStates = mutableListOf<WearAvatarAnimationState>()
    setRobolectricAnimatorDurationScale(0f)

    try {
      assertEquals(false, ValueAnimator.areAnimatorsEnabled())
      controller.get().setContent {
        WearTalkAvatar(
          state = RealtimeVoiceButtonState.IDLE,
          mouthLevel = 0f,
          syntheticSpeech = false,
          accent = Color.Cyan,
          danger = Color.Red,
          animatorScaleSource = scaleSource,
          motionDurationScale = motionDurationScale,
          frameClock = frameClock,
          onAnimationStateChanged = observedStates::add,
        )
      }
      idleMainLooper()

      assertEquals(0f, observedStates.last().durationScale, 0f)
      assertEquals(0, frameClock.awaitCount)

      motionDurationScale.scaleFactor = 1f
      idleMainLooper()

      assertEquals(1f, observedStates.last().durationScale, 0f)
      assertTrue(frameClock.awaitCount > 0)
    } finally {
      controller.pause().stop().destroy()
      idleMainLooper()
      setRobolectricAnimatorDurationScale(1f)
    }
  }

  @Test
  @Config(sdk = [33])
  fun zeroSystemScaleColdStartUsesTheComposeMotionScaleWithoutCrashing() {
    val context = RuntimeEnvironment.getApplication()
    val originalScale =
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    val observedStates = mutableListOf<WearAvatarAnimationState>()
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    setRobolectricAnimatorDurationScale(0f)

    try {
      controller.setup()
      controller.get().setContent {
        WearTalkAvatar(
          state = RealtimeVoiceButtonState.LISTENING,
          mouthLevel = 0f,
          syntheticSpeech = false,
          accent = Color.Cyan,
          danger = Color.Red,
          animatorScaleSource = FakeWearAnimatorScaleSource(initialScale = 1f),
          onAnimationStateChanged = observedStates::add,
        )
      }
      idleMainLooper()

      assertEquals(0f, observedStates.last().durationScale, 0f)
      assertEquals(0f, observedStates.last().animationSeconds, 0f)
    } finally {
      controller.pause().stop().destroy()
      idleMainLooper()
      Settings.Global.putFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        originalScale,
      )
      setRobolectricAnimatorDurationScale(originalScale)
    }
  }

  @Test
  @Config(sdk = [32])
  fun api31And32RefreshEffectiveScaleOnLifecycleAndPowerChangesAndCleanUp() {
    val context = RuntimeEnvironment.getApplication()
    val lifecycleOwner = TestLifecycleOwner()
    val source = AndroidWearAnimatorScaleSource(context, lifecycleOwner)
    val observedScales = mutableListOf<Float>()
    val subscription = source.subscribe(observedScales::add)
    val countAfterSubscribe = observedScales.size

    lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    assertTrue(observedScales.size > countAfterSubscribe)
    val countAfterStart = observedScales.size

    context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    idleMainLooper()
    assertTrue(observedScales.size > countAfterStart)

    subscription.dispose()
    val countAfterDispose = observedScales.size
    lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    idleMainLooper()
    assertEquals(countAfterDispose, observedScales.size)
  }

  @Test
  fun zeroMotionKeepsEveryVoiceStateStaticAndVisuallyDistinct() {
    val poses =
      RealtimeVoiceButtonState.entries.map { state ->
        avatarPoseAt(
          state = state,
          animationSeconds = 0f,
          mouthLevel = 0f,
        )
      }

    assertEquals(RealtimeVoiceButtonState.entries.size, poses.distinct().size)
    assertEquals(0f, poses.first().floatOffset, 0f)
    assertTrue(poses.last().antennaDroop > 0f)
  }

  @Test
  fun disabledAnimationsSuppressClockAndAudioMotionInputs() {
    val inputs =
      avatarMotionInputs(
        animationsEnabled = false,
        animationSeconds = 12.5f,
        mouthLevel = 1f,
      )

    assertEquals(WearAvatarMotionInputs(animationSeconds = 0f, mouthLevel = 0f), inputs)
  }

  @Test
  fun enabledAnimationsPreserveClockAndBoundAudioMotionInput() {
    val inputs =
      avatarMotionInputs(
        animationsEnabled = true,
        animationSeconds = 12.5f,
        mouthLevel = 1.5f,
      )

    assertEquals(WearAvatarMotionInputs(animationSeconds = 12.5f, mouthLevel = 1f), inputs)
  }

  private fun samplesForFrames(frameCount: Int): Int = WEAR_REALTIME_SAMPLE_RATE_HZ * MOUTH_FRAME_MILLIS / 1_000 * frameCount

  private fun pcm16Le(
    sampleCount: Int,
    sample: Int,
  ): ByteArray =
    ByteArray(sampleCount * 2).also { bytes ->
      repeat(sampleCount) { index ->
        bytes[index * 2] = (sample and 0xff).toByte()
        bytes[(index * 2) + 1] = ((sample shr 8) and 0xff).toByte()
      }
    }

  private fun realtimeTalkClient(): WearRealtimeTalkClient {
    val requester =
      object : WearRpcRequester {
        override suspend fun request(
          method: WearRpcMethod,
          params: JsonObject,
          expectedNodeId: String?,
          requirePreferredNode: Boolean,
        ): WearRpcResult = error("Unexpected request: $method $params $expectedNodeId $requirePreferredNode")
      }
    return WearRealtimeTalkClient(RuntimeEnvironment.getApplication(), WearGatewayRepository(requester))
  }

  private fun awaitPlaybackTeardown(client: WearRealtimeTalkClient) {
    ShadowSystemClock.advanceBy(Duration.ofSeconds(1L))
    val deadlineNanos = System.nanoTime() + 2_000_000_000L
    while (client.isPlaying.value && System.nanoTime() < deadlineNanos) Thread.sleep(10L)
    assertEquals(false, client.isPlaying.value)
  }

  private fun idleMainLooper(duration: Duration = Duration.ZERO) {
    shadowOf(Looper.getMainLooper()).idleFor(duration)
  }

  private fun setRobolectricAnimatorDurationScale(scale: Float) {
    ShadowValueAnimator::class.java
      .getDeclaredMethod("setDurationScale", java.lang.Float.TYPE)
      .apply { isAccessible = true }
      .invoke(null, scale)
  }

  private fun Any.setPrivateField(
    name: String,
    value: Any,
  ) {
    javaClass.getDeclaredField(name).apply {
      isAccessible = true
      set(this@setPrivateField, value)
    }
  }

  private companion object {
    const val WEAR_REALTIME_SAMPLE_RATE_HZ = 24_000
  }

  private class FakeMotionDurationScale(
    initialScale: Float,
  ) : MotionDurationScale {
    override var scaleFactor by mutableFloatStateOf(initialScale)
  }

  private class FakeWearAnimatorScaleSource(
    initialScale: Float,
  ) : WearAnimatorScaleSource {
    private var scale = initialScale
    private var listener: ((Float) -> Unit)? = null
    var subscriptionCount = 0
      private set
    var disposeCount = 0
      private set
    val activeSubscriptionCount: Int
      get() = if (listener == null) 0 else 1

    override fun currentScale(): Float = scale

    override fun subscribe(onScaleChanged: (Float) -> Unit): WearAnimatorScaleSubscription {
      subscriptionCount += 1
      listener = onScaleChanged
      return WearAnimatorScaleSubscription {
        if (listener === onScaleChanged) listener = null
        disposeCount += 1
      }
    }

    fun emit(newScale: Float) {
      scale = newScale
      listener?.invoke(newScale)
    }
  }

  private class FakeWearAvatarFrameClock : WearAvatarFrameClock {
    private val frames = Channel<Long>(Channel.UNLIMITED)
    var awaitCount = 0
      private set

    override suspend fun awaitFrame(onFrame: (Long) -> Unit) {
      awaitCount += 1
      onFrame(frames.receive())
    }

    fun sendFrame(frameNanos: Long) {
      assertTrue(frames.trySend(frameNanos).isSuccess)
    }
  }

  private class TestLifecycleOwner : LifecycleOwner {
    val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle = registry
  }
}
