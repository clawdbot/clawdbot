package ai.openclaw.app.voice

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.shadows.ShadowAudioEffect
import org.robolectric.shadows.ShadowAudioManager
import org.robolectric.shadows.ShadowAudioRecord
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Covers the communication-audio session realtime Talk owns: the capture profile, the platform
 * echo canceller and the read-back that decides whether the uplink may stay open, the
 * communication mode, and the communication output route.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [ShadowObservableAudioEffect::class])
class RealtimeCommunicationAudioTest {
  @Before
  fun setUp() {
    ShadowObservableAudioEffect.clearObservations()
  }

  @After
  fun tearDown() {
    ShadowAudioRecord.clearSource()
    ShadowAudioEffect.reset()
  }

  // ---- capture profile ---------------------------------------------------------------------

  @Test
  fun theTwoCaptureProfilesMapToTheirAndroidAudioSources() {
    assertEquals(MediaRecorder.AudioSource.VOICE_COMMUNICATION, AndroidAudioInputProfile.VoiceCommunication.audioSource)
    assertEquals(MediaRecorder.AudioSource.VOICE_RECOGNITION, AndroidAudioInputProfile.VoiceRecognition.audioSource)
  }

  @Test
  fun aSessionOpenedWithoutAProfileStaysOnRecognitionCapture() {
    // Manual Mic/STT and push-to-talk call open() without naming a profile. They must not be
    // migrated onto communication capture as a side effect of realtime Talk adopting it.
    val sources = recordCaptureSources()

    AndroidAudioInputSession.open(app(), 8_000, 1_600).use { session ->
      readOneFrame(session)
      assertEquals(listOf(MediaRecorder.AudioSource.VOICE_RECOGNITION), sources)
    }
  }

  @Test
  fun aCommunicationProfileSessionOpensCommunicationCapture() {
    val sources = recordCaptureSources()

    openCommunicationCapture().use { session ->
      readOneFrame(session)
      assertEquals(listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION), sources)
    }
  }

  // ---- echo canceller ----------------------------------------------------------------------

  @Test
  fun anEchoCancellerThePlatformEnablesMakesTheCapabilityTrue() {
    installPlatformEchoCanceler()

    openCommunicationCapture().use { session ->
      assertTrue(session.communicationEchoCancellationEnabled)
    }
  }

  @Test
  fun anEchoCancellerThePlatformRefusesToEnableMakesTheCapabilityFalse() {
    ShadowObservableAudioEffect.refuseEnable = true
    // create() succeeded and the effect object exists; only the read-back says it is not running.
    // Anything that trusted create() instead would open the uplink into an uncancelled speaker.
    installPlatformEchoCanceler()

    openCommunicationCapture().use { session ->
      assertTrue("the effect was reachable, so this is a read-back result", AcousticEchoCanceler.isAvailable())
      assertFalse(session.communicationEchoCancellationEnabled)
    }
  }

  @Test
  fun aDeviceWithNoEchoCancellerStillCapturesAndReportsNoCapability() {
    // No effect registered, so AcousticEchoCanceler.isAvailable() is false.
    openCommunicationCapture().use { session ->
      assertFalse(session.communicationEchoCancellationEnabled)
      assertEquals(48_000, session.actualSampleRateHz)
    }
  }

  @Test
  fun theCapabilityIsReadLiveSoItCanFallBackWithinASession() {
    installPlatformEchoCanceler()

    openCommunicationCapture().use { session ->
      assertTrue(session.communicationEchoCancellationEnabled)

      // A route change under a running recorder can take the canceller away. A capability that
      // was snapshotted at open could never answer that, and the uplink would stay open.
      ShadowObservableAudioEffect.forceDisabled = true

      assertFalse(session.communicationEchoCancellationEnabled)
    }
  }

  @Test
  fun aClosedSessionReportsNoEchoCancellation() {
    installPlatformEchoCanceler()
    val session = openCommunicationCapture()
    assertTrue(session.communicationEchoCancellationEnabled)

    session.close()

    assertFalse(session.communicationEchoCancellationEnabled)
  }

  @Test
  fun theEchoCancellerIsReleasedWithTheCaptureSession() {
    installPlatformEchoCanceler()
    val session = openCommunicationCapture()
    assertTrue(session.communicationEchoCancellationEnabled)
    assertEquals(0, ShadowObservableAudioEffect.releaseCount)

    session.close()

    // The effect belongs to the recorder's lifetime: it must not outlive the session that owns it.
    assertEquals(1, ShadowObservableAudioEffect.releaseCount)
  }

  // ---- communication mode ------------------------------------------------------------------

  @Test
  fun communicationModeIsEnteredOnceAndRestoredOnTeardown() {
    val audioManager = audioManager()
    audioManager.mode = AudioManager.MODE_NORMAL
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(audioManager)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, audioManager.mode)

    owner.restore(audioManager, token)
    assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
  }

  @Test
  fun communicationAudioFocusIsHeldForTheSessionAndReleasedWithIt() {
    // Without focus another app keeps playing into the same loudspeaker the platform canceller
    // uses as its reference -- the one signal it cannot subtract.
    val audioManager = audioManager()
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(audioManager)
    val held = shadowOf(audioManager).lastAudioFocusRequest
    assertEquals(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT, held.audioFocusRequest.focusGain)
    assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION, held.audioFocusRequest.audioAttributes.usage)

    owner.restore(audioManager, token)

    assertEquals(held.audioFocusRequest, shadowOf(audioManager).lastAbandonedAudioFocusRequest)
  }

  @Test
  fun aSecondAcquisitionDoesNotRecordCommunicationModeAsTheModeToRestore() {
    // A stop racing a restart would otherwise capture MODE_IN_COMMUNICATION as "the previous
    // mode" and hand the device back still in it, long after Talk ended.
    val audioManager = audioManager()
    audioManager.mode = AudioManager.MODE_NORMAL
    val owner = RealtimeCommunicationAudioOwner()

    owner.enter(audioManager)
    val second = owner.enter(audioManager)
    owner.restore(audioManager, second)

    assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
  }

  @Test
  fun aStaleOwnerCannotRestoreModeOverALiveSession() {
    val audioManager = audioManager()
    audioManager.mode = AudioManager.MODE_NORMAL
    val owner = RealtimeCommunicationAudioOwner()

    val stale = owner.enter(audioManager)
    owner.enter(audioManager)
    owner.restore(audioManager, stale)

    assertEquals(AudioManager.MODE_IN_COMMUNICATION, audioManager.mode)
  }

  @Test
  fun aSessionThatNeverAcquiredTheModeRestoresNothing() {
    val audioManager = audioManager()
    val owner = RealtimeCommunicationAudioOwner()
    owner.enter(audioManager)

    owner.restore(audioManager, RealtimeCommunicationAudioOwner.NO_OWNER)

    assertEquals(AudioManager.MODE_IN_COMMUNICATION, audioManager.mode)
  }

  // ---- playback attributes -----------------------------------------------------------------

  @Test
  fun realtimePlaybackUsesCommunicationAttributes() {
    val attributes = realtimeCommunicationPlaybackAttributes()

    assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION, attributes.usage)
    assertEquals(AudioAttributes.CONTENT_TYPE_SPEECH, attributes.contentType)
  }

  // ---- communication output route ------------------------------------------------------------

  @Test
  fun handsFreeTalkOnAHandsetRequestsTheBuiltInSpeaker() {
    // Left to itself the phone strategy sends communication audio to the earpiece, which is the
    // difference between hands-free Talk and holding the device to your ear.
    setAvailableCommunicationDevices(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)

    openCommunicationCapture().use { session ->
      assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, session.appliedCommunicationDeviceType)
      assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, audioManager().communicationDevice?.type)
    }
  }

  @Test
  fun anAlwaysPresentUnrelatedOutputDoesNotDisableTheHandsFreeOverride() {
    // Telephony is simply always there on a handset. Treating anything that is not the built-in
    // pair as a deliberate choice would leave hands-free Talk on the earpiece for whole device
    // classes, with nothing distinguishing it from working.
    setAvailableCommunicationDevices(
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
      AudioDeviceInfo.TYPE_TELEPHONY,
    )

    openCommunicationCapture().use { session ->
      assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, session.appliedCommunicationDeviceType)
    }
  }

  @Test
  fun anExternalCommunicationOutputIsNotStolen() {
    // A wired headset already outranks the earpiece, so there is nothing to correct and taking
    // the route would move audio to the loudspeaker while someone is wearing headphones.
    setAvailableCommunicationDevices(
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
    )

    openCommunicationCapture().use { session ->
      assertNull(session.appliedCommunicationDeviceType)
    }
  }

  @Test
  fun recognitionCaptureNeverTakesTheCommunicationOutput() {
    setAvailableCommunicationDevices(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)

    AndroidAudioInputSession.open(app(), 8_000, 1_600).use { session ->
      assertNull(session.appliedCommunicationDeviceType)
    }
  }

  @Test
  fun aRouteRequestThePlatformRefusesIsNotReportedAsAcquired() {
    setAvailableCommunicationDevices(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    shadowOf(audioManager()).lockCommunicationDevice(true)

    openCommunicationCapture().use { session ->
      assertNull(session.appliedCommunicationDeviceType)
    }
  }

  @Test
  @Config(shadows = [ShadowAcceptingButNotApplyingAudioManager::class])
  fun aRouteRequestThePlatformAcceptsButDoesNotApplyIsNotReportedAsAcquired() {
    // setCommunicationDevice returning true is a request being accepted, not a route being held.
    // Only what the platform says it selected may be reported as the route Talk is on.
    setAvailableCommunicationDevices(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)

    openCommunicationCapture().use { session ->
      assertNull(session.appliedCommunicationDeviceType)
    }
  }

  // ---- helpers -------------------------------------------------------------------------------

  private fun app() = RuntimeEnvironment.getApplication()

  private fun audioManager() = app().getSystemService(AudioManager::class.java)

  private fun openCommunicationCapture(): AndroidAudioInputSession =
    AndroidAudioInputSession.open(
      app(),
      48_000,
      9_600,
      profile = AndroidAudioInputProfile.VoiceCommunication,
    )

  /** Makes AcousticEchoCanceler.isAvailable() true for this test. */
  private fun installPlatformEchoCanceler() {
    ShadowAudioEffect.addEffect(
      AudioEffect.Descriptor(
        AudioEffect.EFFECT_TYPE_AEC.toString(),
        "9a2f0f34-1c5e-4d3a-9b64-3a1b2c4d5e6f",
        AudioEffect.EFFECT_INSERT,
        "Test AEC",
        "Robolectric",
      ),
    )
  }

  private fun recordCaptureSources(): List<Int> {
    val sources = CopyOnWriteArrayList<Int>()
    ShadowAudioRecord.setSourceProvider { record ->
      sources += record.audioSource
      object : ShadowAudioRecord.AudioRecordSource {
        override fun readInByteArray(
          audioData: ByteArray,
          offsetInBytes: Int,
          sizeInBytes: Int,
          isBlocking: Boolean,
        ): Int = sizeInBytes
      }
    }
    return sources
  }

  /** The shadow consults its source provider on the first read, not when the recorder is built. */
  private fun readOneFrame(session: AndroidAudioInputSession) {
    session.startRecording()
    session.read(ByteArray(64), 0, 64)
  }

  private fun setAvailableCommunicationDevices(vararg types: Int) {
    val devices = types.map { type -> AudioDeviceInfoBuilder.newBuilder().setType(type).build() }
    shadowOf(audioManager()).setAvailableCommunicationDevices(devices)
  }
}

/** Accepts every communication-device request and then holds none of them. */
@Implements(AudioManager::class)
class ShadowAcceptingButNotApplyingAudioManager : ShadowAudioManager() {
  @Implementation
  override fun setCommunicationDevice(device: AudioDeviceInfo): Boolean = true

  @Implementation
  override fun getCommunicationDevice(): AudioDeviceInfo? = null
}

/**
 * One AudioEffect shadow for every echo-canceller behavior this suite needs: refusing to enable,
 * losing its enabled state mid-session, and being released. Applied at class level so all tests
 * share one Robolectric sandbox, which is what keeps these statics observable.
 */
@Implements(AudioEffect::class)
class ShadowObservableAudioEffect : ShadowAudioEffect() {
  @Implementation
  override fun native_setEnabled(enabled: Boolean): Int = if (refuseEnable) AudioEffect.ERROR_INVALID_OPERATION else super.native_setEnabled(enabled)

  @Implementation
  override fun native_getEnabled(): Boolean = !forceDisabled && super.native_getEnabled()

  @Implementation
  override fun native_release() {
    releaseCount += 1
    super.native_release()
  }

  companion object {
    @JvmStatic var refuseEnable = false

    @JvmStatic var forceDisabled = false

    @JvmStatic var releaseCount = 0

    @JvmStatic
    fun clearObservations() {
      refuseEnable = false
      forceDisabled = false
      releaseCount = 0
    }
  }
}
