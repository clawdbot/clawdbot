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
import org.junit.Assert.assertNotNull
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
  fun losingTheCancellerMidSessionShrinksTheCapabilityOnTheNextRefresh() {
    installPlatformEchoCanceler()

    openCommunicationCapture().use { session ->
      assertTrue(session.communicationEchoCancellationEnabled)

      // A route change under a running recorder can take the canceller away. The capability is
      // cached rather than measured per read, so it shrinks when its owner re-measures -- but it
      // must actually shrink, or the uplink would stay open on a route with no canceller.
      ShadowObservableAudioEffect.forceDisabled = true

      assertFalse(session.refreshCommunicationEchoCancellation())
      assertFalse(session.communicationEchoCancellationEnabled)
    }
  }

  @Test
  fun readingTheCapabilityCostsNoEffectIpc() {
    // The capture loop consults this once per frame. Measuring the effect there would take the
    // session lifecycle lock, which a route refresh holds across several AudioManager binder
    // calls -- putting a route change on the critical path of AudioRecord.read.
    installPlatformEchoCanceler()

    openCommunicationCapture().use { session ->
      val baseline = ShadowObservableAudioEffect.getEnabledCount

      repeat(500) { assertTrue(session.communicationEchoCancellationEnabled) }

      assertEquals("500 capability reads must issue zero effect reads", baseline, ShadowObservableAudioEffect.getEnabledCount)

      // ...and the explicit refresh is the one thing that does pay for an IPC.
      session.refreshCommunicationEchoCancellation()
      assertTrue(ShadowObservableAudioEffect.getEnabledCount > baseline)
    }
  }

  @Test
  fun capabilityReadsStayFastWhileTheEffectIsBeingReMeasuredConcurrently() {
    // The regression this pins: the getter used to take the same lifecycle lock refreshRoute
    // holds across its AudioManager binder calls, so a slow route change stalled the capture read
    // loop. Now only the re-measure takes that lock; readers never contend with it.
    installPlatformEchoCanceler()

    openCommunicationCapture().use { session ->
      val stop =
        java.util.concurrent.atomic
          .AtomicBoolean(false)
      val failure =
        java.util.concurrent.atomic
          .AtomicReference<Throwable?>(null)
      val refresher =
        Thread {
          runCatching {
            while (!stop.get()) session.refreshCommunicationEchoCancellation()
          }.onFailure(failure::set)
        }
      refresher.start()
      try {
        val startedAtMs = System.nanoTime()
        // Far more reads than a real session performs in a route-change window (one per 100 ms
        // frame), so a reader that contended for the lock could not finish this quickly.
        repeat(20_000) { session.communicationEchoCancellationEnabled }
        val elapsedMs = (System.nanoTime() - startedAtMs) / 1_000_000
        assertTrue("20000 capability reads took ${elapsedMs}ms against a concurrent re-measure", elapsedMs < 1_000)
      } finally {
        stop.set(true)
        refresher.join(5_000)
      }
      assertNull(failure.get())
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
  fun ownershipIsClaimedOnlyWhenTheModeReadsBackAsCommunication() {
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(audioManager())

    assertTrue("a confirmed read-back must yield a real token", token != RealtimeCommunicationAudioOwner.NO_OWNER)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, audioManager().mode)
    assertTrue(owner.communicationModeActive)
  }

  @Test
  @Config(shadows = [ShadowForeignModeOwnerAudioManager::class])
  fun aModeSetterThatSilentlyLosesToAnotherOwnerYieldsNoOwnership() {
    // AudioManager.mode is a void setter recording a per-app request. Another app can hold the
    // mode and this setter still returns normally. Treating "did not throw" as ownership is what
    // let full duplex open against a speaker the canceller had no reference for.
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(audioManager())

    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, token)
    assertFalse(owner.communicationModeActive)
  }

  @Test
  @Config(shadows = [ShadowThrowingModeAudioManager::class])
  fun aModeSetterThatThrowsYieldsNoOwnership() {
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(audioManager())

    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, token)
    assertFalse(owner.communicationModeActive)
  }

  @Test
  fun focusDenialPreventsModeOwnershipAndLeavesTheModeAlone() {
    // Focus is requested before the mode precisely so this case can decline without having
    // touched device state: without focus this app is not the one the platform routes around.
    shadowOf(audioManager()).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    val before = audioManager().mode
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(audioManager())

    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, token)
    assertFalse(owner.communicationModeActive)
    assertEquals("a denied acquisition must not move the device mode", before, audioManager().mode)
  }

  @Test
  @Config(shadows = [ShadowForeignModeOwnerAudioManager::class])
  fun aFailedAcquisitionReleasesTheFocusItTookAndUndoesItsOwnModeWrite() {
    val manager = audioManager()
    val owner = RealtimeCommunicationAudioOwner()

    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, owner.enter(manager))

    // It requested focus, so it must hand it back; leaving it held would duck other apps for a
    // session that never started.
    assertNotNull("the failed attempt must abandon its own focus request", shadowOf(manager).lastAbandonedAudioFocusRequest)
  }

  @Test
  @Config(shadows = [ShadowToggleableModeOwnerAudioManager::class])
  fun aFailedAcquisitionCannotDisturbALiveOwner() {
    // Shared with the other test using this shadow: same sandbox, so the same static.
    ShadowToggleableModeOwnerAudioManager.foreignOwner = false
    val manager = audioManager()
    val owner = RealtimeCommunicationAudioOwner()
    val live = owner.enter(manager)
    assertTrue(live != RealtimeCommunicationAudioOwner.NO_OWNER)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)

    // Something else takes the mode, so the next acquisition cannot read it back. It must not
    // reach over the session that is still running to "undo" a write that is not its own.
    ShadowToggleableModeOwnerAudioManager.foreignOwner = true
    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, owner.enter(manager))

    // The capability correctly shrinks -- the attempt just read the device back as not in
    // communication mode, and that evidence must reach the full-duplex gate immediately rather
    // than waiting for the next watcher tick.
    assertFalse("a refuted read-back must close full duplex", owner.communicationModeActive)
    assertFalse(owner.communicationModeActiveUnsynchronized)

    // What must NOT happen is the live owner losing its token, its focus, or its mode: the failed
    // attempt may not reach over a session that is still running.
    ShadowToggleableModeOwnerAudioManager.foreignOwner = false
    assertEquals("the failed attempt must not have rewritten the mode", AudioManager.MODE_IN_COMMUNICATION, manager.mode)
    assertNull("the live owner's focus must not be abandoned", shadowOf(manager).lastAbandonedAudioFocusRequest)

    owner.restore(manager, RealtimeCommunicationAudioOwner.NO_OWNER)
    assertEquals("NO_OWNER must never restore", AudioManager.MODE_IN_COMMUNICATION, manager.mode)

    // The live token still works, which is the property that keeps teardown able to unwind.
    owner.restore(manager, live)
    assertFalse(owner.communicationModeActive)
    assertNotNull("teardown must abandon the focus the live owner held", shadowOf(manager).lastAbandonedAudioFocusRequest)
  }

  @Test
  @Config(shadows = [ShadowToggleableModeOwnerAudioManager::class])
  fun losingTheModeMidSessionDropsOwnershipSoTheCapabilityCanShrink() {
    ShadowToggleableModeOwnerAudioManager.foreignOwner = false
    // Acquisition proves ownership at one instant. If another app takes the mode afterwards the
    // canceller is no longer referencing this session's downlink, and full duplex must close.
    val manager = audioManager()
    val owner = RealtimeCommunicationAudioOwner()
    val token = owner.enter(manager)
    assertTrue(token != RealtimeCommunicationAudioOwner.NO_OWNER)
    assertTrue(owner.verifyCommunicationModeActive(manager))

    ShadowToggleableModeOwnerAudioManager.foreignOwner = true

    assertFalse("a lost mode must close full duplex", owner.verifyCommunicationModeActive(manager))
    assertFalse(owner.communicationModeActive)

    // The token must still work. Marking the mode lost by nulling the owner would orphan it:
    // teardown would abandon no focus and withdraw no mode request, leaving every other app
    // ducked and this process's stale request standing.
    ShadowToggleableModeOwnerAudioManager.foreignOwner = false
    owner.restore(manager, token)
    assertNotNull("teardown must still abandon focus after a lost mode", shadowOf(manager).lastAbandonedAudioFocusRequest)
    assertEquals("teardown must still withdraw the mode request", AudioManager.MODE_NORMAL, manager.mode)
  }

  @Test
  fun aTransientFocusRefusalIsRecoveredRatherThanLeavingTheSessionHalfDuplex() {
    // Focus denial is fatal to the mode, so a notification chime at the wrong instant would
    // otherwise leave a whole Talk session half duplex with only a log line to show for it.
    val manager = audioManager()
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    val owner = RealtimeCommunicationAudioOwner()
    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, owner.enter(manager))
    assertFalse(owner.communicationModeActive)
    assertFalse(owner.communicationModeActiveUnsynchronized)

    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    val recovered = owner.retryIfUnclaimed(manager)

    assertTrue("the retry must claim the mode once focus is available", recovered != RealtimeCommunicationAudioOwner.NO_OWNER)
    assertTrue(owner.communicationModeActive)
    assertTrue("the lock-free mirror must track it", owner.communicationModeActiveUnsynchronized)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)

    // And a retry against a session that already holds it must be a no-op, not a second claim.
    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, owner.retryIfUnclaimed(manager))
  }

  @Test
  @Config(shadows = [ShadowAcceptingButNotApplyingAudioManager::class])
  fun aCommunicationDeviceTheReadBackDoesNotConfirmIsReportedUnheldButLeftStanding() {
    // Reported honestly as not confirmed, and deliberately NOT torn down: setCommunicationDevice
    // accepted the request, and on Bluetooth the link comes up asynchronously, so an immediately
    // disagreeing read-back is the expected transient. Clearing it would cancel a route that was
    // about to establish, and the resulting device callbacks would re-request it in a loop.
    ShadowAcceptingButNotApplyingAudioManager.clearCalls = 0
    setAvailableCommunicationDevices(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)

    openCommunicationCapture().use { session ->
      assertNull("an unconfirmed route must not be reported as held", session.appliedCommunicationDeviceType)
      assertEquals(
        "an unconfirmed route must not be torn down",
        0,
        ShadowAcceptingButNotApplyingAudioManager.clearCalls,
      )
    }
  }

  @Test
  @Config(shadows = [ShadowForeignModeOwnerAudioManager::class])
  fun aModeRefusalIsNeverRetriedSoItCannotThrashAudioFocus() {
    // Retrying a mode refusal re-acquires and re-abandons focus on every watcher tick, which
    // pauses and resumes whatever else is playing twice a second for the whole session. Half
    // duplex is the correct answer here, not a retry loop.
    val manager = audioManager()
    val owner = RealtimeCommunicationAudioOwner()
    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, owner.enter(manager))

    repeat(10) {
      assertEquals(
        "a mode refusal must not be retried",
        RealtimeCommunicationAudioOwner.NO_OWNER,
        owner.retryIfUnclaimed(manager),
      )
    }
    assertFalse(owner.communicationModeActive)
  }

  @Test
  fun theFocusRetryBudgetIsBoundedSoADevicePermanentlyRefusingFocusStopsBeingAsked() {
    val manager = audioManager()
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    val owner = RealtimeCommunicationAudioOwner()
    assertEquals(RealtimeCommunicationAudioOwner.NO_OWNER, owner.enter(manager))

    var attempts = 0
    repeat(50) {
      if (owner.retryIfUnclaimed(manager) == RealtimeCommunicationAudioOwner.NO_OWNER && attempts < 50) attempts += 1
    }

    // Bounded: the budget runs out and the owner stops asking rather than retrying forever.
    assertFalse(owner.communicationModeActive)
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    assertEquals(
      "an exhausted budget must not resume retrying",
      RealtimeCommunicationAudioOwner.NO_OWNER,
      owner.retryIfUnclaimed(manager),
    )
  }

  @Test
  fun findingTheDeviceAlreadyInCommunicationModeDoesNotMakeTeardownReAssertIt() {
    // getMode() reports the device's effective mode; setMode records this app's request. Replaying
    // the first as the second is how a session that merely *found* the device in communication
    // mode -- because another app left it there -- ends up holding a standing request of its own
    // that nothing ever withdraws, keeping the device on the communication path indefinitely.
    val manager = audioManager()
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    val owner = RealtimeCommunicationAudioOwner()

    val token = owner.enter(manager)
    assertTrue(token != RealtimeCommunicationAudioOwner.NO_OWNER)

    owner.restore(manager, token)

    assertEquals(
      "teardown must withdraw this app's request, not re-assert communication mode",
      AudioManager.MODE_NORMAL,
      manager.mode,
    )
    assertFalse(owner.communicationModeActive)
  }

  @Test
  fun teardownWithdrawsToNormalWhateverModeTheDeviceWasFoundIn() {
    // Withdrawing this app's request means asking for normal. Replaying the mode that happened to
    // be effective at start would have a non-telephony app asserting MODE_IN_CALL or
    // MODE_RINGTONE as its own standing request -- the same shape as the communication-mode
    // replay, just for a different value. Since API 31 the platform arbitrates per-app requests,
    // so asking for normal withdraws only this entry and cannot unseat the app that owns the mode.
    for (found in listOf(AudioManager.MODE_RINGTONE, AudioManager.MODE_IN_CALL, AudioManager.MODE_NORMAL)) {
      val manager = audioManager()
      manager.mode = found
      val owner = RealtimeCommunicationAudioOwner()

      val token = owner.enter(manager)
      assertTrue("found=$found", token != RealtimeCommunicationAudioOwner.NO_OWNER)
      assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)

      owner.restore(manager, token)

      assertEquals("found=$found must be withdrawn to normal", AudioManager.MODE_NORMAL, manager.mode)
    }
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

/** Accepts the mode write, but the mode belongs to somebody else -- the read-back says so. */
@Implements(AudioManager::class)
class ShadowForeignModeOwnerAudioManager : ShadowAudioManager() {
  @Implementation
  override fun setMode(mode: Int) {
    // Recorded by the platform as a request and then lost to the current owner.
  }

  @Implementation
  override fun getMode(): Int = AudioManager.MODE_NORMAL
}

/** Applies the mode write until [foreignOwner] is set, after which the read-back stops agreeing. */
@Implements(AudioManager::class)
class ShadowToggleableModeOwnerAudioManager : ShadowAudioManager() {
  private var requested = AudioManager.MODE_NORMAL

  @Implementation
  override fun setMode(mode: Int) {
    requested = mode
  }

  @Implementation
  override fun getMode(): Int = if (foreignOwner) AudioManager.MODE_NORMAL else requested

  companion object {
    @JvmStatic var foreignOwner = false
  }
}

/** Refuses the mode write outright. */
@Implements(AudioManager::class)
class ShadowThrowingModeAudioManager : ShadowAudioManager() {
  @Implementation
  override fun setMode(mode: Int): Unit = throw SecurityException("mode denied")
}

/** Accepts every communication-device request and then holds none of them. */
@Implements(AudioManager::class)
class ShadowAcceptingButNotApplyingAudioManager : ShadowAudioManager() {
  @Implementation
  override fun setCommunicationDevice(device: AudioDeviceInfo): Boolean = true

  @Implementation
  override fun getCommunicationDevice(): AudioDeviceInfo? = null

  @Implementation
  override fun clearCommunicationDevice() {
    clearCalls += 1
  }

  companion object {
    @JvmStatic var clearCalls = 0
  }
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
  override fun native_getEnabled(): Boolean {
    getEnabledCount += 1
    return !forceDisabled && super.native_getEnabled()
  }

  @Implementation
  override fun native_release() {
    releaseCount += 1
    super.native_release()
  }

  companion object {
    @JvmStatic var refuseEnable = false

    @JvmStatic var forceDisabled = false

    @JvmStatic var releaseCount = 0

    /** Every effect read is one IPC; the capture hot path must add none of them. */
    @JvmStatic var getEnabledCount = 0

    @JvmStatic
    fun clearObservations() {
      refuseEnable = false
      forceDisabled = false
      releaseCount = 0
      getEnabledCount = 0
    }
  }
}
