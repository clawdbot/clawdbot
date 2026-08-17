package ai.openclaw.app.voice

import android.Manifest
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AudioEffect
import android.os.Looper
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
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.shadows.ShadowAudioEffect
import org.robolectric.shadows.ShadowAudioManager
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidAudioInputSessionTest {
  private val context = RuntimeEnvironment.getApplication()
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val shadowAudioManager: ShadowAudioManager = shadowOf(audioManager)
  private var nextDeviceId = 1

  @Before
  fun setUp() {
    shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
  }

  @After
  fun tearDown() {
    shadowAudioManager.setInputDevices(emptyList())
    shadowAudioManager.setAvailableCommunicationDevices(emptyList())
    audioManager.clearCommunicationDevice()
    ShadowAudioEffect.reset()
  }

  @Test
  fun prefersBleHeadsetInputAndCommunicationRoute() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(sco, ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, bleOutput))

    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, session.requestedInputType)
    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, audioManager.communicationDevice?.type)
    session.close()
  }

  @Test
  fun removalFallsBackToClassicBluetoothInput() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(sco, ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, bleOutput))
    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput))
    shadowAudioManager.removeInputDevice(ble, true)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, session.requestedInputType)
    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, audioManager.communicationDevice?.type)
    session.close()
  }

  @Test
  fun communicationCaptureSelectsBuiltInSpeakerWhenNoBluetoothIsAvailable() {
    // Without an explicit selection Android's phone strategy routes
    // STREAM_VOICE_CALL to the earpiece, which is what made hands-free Talk
    // unusable. Talk must claim the loudspeaker instead.
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    val earpiece = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(earpiece, speaker))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, audioManager.communicationDevice?.type)
    assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, session.appliedCommunicationDeviceType)
    session.close()
  }

  @Test
  fun communicationCaptureNeverFallsThroughToTheEarpiece() {
    // Even when the earpiece is the first available communication device, it must
    // never be the one Talk ends up on.
    val earpiece = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(earpiece, speaker))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertFalse(audioManager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    assertFalse(session.appliedCommunicationDeviceType == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    session.close()
  }

  @Test
  fun communicationCaptureLeavesWiredHeadsetRoutingAlone() {
    // A wired headset already outranks the earpiece in Android's own routing, so
    // forcing the speaker here would play out of the phone while headphones are
    // plugged in. Only the built-in-only case needs an explicit choice.
    val wired = audioDevice(AudioDeviceInfo.TYPE_WIRED_HEADSET)
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    val earpiece = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(earpiece, speaker, wired))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertNull(audioManager.communicationDevice)
    assertNull(session.appliedCommunicationDeviceType)
    session.close()
  }

  @Test
  fun communicationCaptureLeavesUsbHeadsetRoutingAlone() {
    val usb = audioDevice(AudioDeviceInfo.TYPE_USB_HEADSET)
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    val earpiece = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(earpiece, speaker, usb))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertNull(audioManager.communicationDevice)
    assertNull(session.appliedCommunicationDeviceType)
    session.close()
  }

  @Test
  fun communicationCapturePrefersBluetoothOverTheBuiltInSpeaker() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowAudioManager.setInputDevices(listOf(sco))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, speaker))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, audioManager.communicationDevice?.type)
    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, session.appliedCommunicationDeviceType)
    session.close()
  }

  @Test
  fun bluetoothDisconnectDuringCommunicationCaptureFallsBackToTheBuiltInSpeaker() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowAudioManager.setInputDevices(listOf(sco))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, speaker))
    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )
    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, session.appliedCommunicationDeviceType)

    shadowAudioManager.setAvailableCommunicationDevices(listOf(speaker))
    shadowAudioManager.removeInputDevice(sco, true)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, audioManager.communicationDevice?.type)
    assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, session.appliedCommunicationDeviceType)
    session.close()
  }

  @Test
  fun closingCommunicationCaptureReleasesTheRouteItHeld() {
    // Talk-owned routing must not leak into unrelated app audio after Talk stops.
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(speaker))
    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )
    assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, audioManager.communicationDevice?.type)

    session.close()

    assertNull(audioManager.communicationDevice)
    assertNull(session.appliedCommunicationDeviceType)
  }

  @Test
  fun rejectedSpeakerSelectionIsReportedAsUnheldRatherThanAssumedSuccessful() {
    // setCommunicationDevice() returning false is a routing failure, not a
    // silent success: the session must not claim it holds the speaker.
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(speaker))
    shadowAudioManager.lockCommunicationDevice(true)

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertNull(session.appliedCommunicationDeviceType)
    session.close()
    shadowAudioManager.lockCommunicationDevice(false)
  }

  @Test
  fun recognitionCaptureDoesNotClaimAnyCommunicationRoute() {
    // Manual Mic/STT semantics are unchanged: it never took ownership of the
    // process communication route and must not start now.
    val speaker = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    val earpiece = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    shadowAudioManager.setAvailableCommunicationDevices(listOf(speaker, earpiece))

    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    assertNull(audioManager.communicationDevice)
    assertNull(session.appliedCommunicationDeviceType)
    session.close()
  }

  @Test
  fun presentPreferredInputResolvesByStableKey() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)

    val resolved = resolvePreferredAudioInput(listOf(ble, sco), audioInputDeviceKey(sco))

    assertEquals(sco.id, resolved?.id)
    assertEquals(sco.type, resolved?.type)
  }

  @Test
  fun rejectedPreferredInputRestoresAutomaticBluetoothRouting() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(sco, ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, bleOutput))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        preferredDeviceKey = audioInputDeviceKey(sco),
      )

    assertEquals(ble.type, session.requestedInputType)
    assertNull(session.appliedPreferredDeviceKey)
    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, audioManager.communicationDevice?.type)
    session.close()
  }

  @Test
  fun unresolvedPreferredInputKeepsAutomaticBluetoothRouting() {
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(bleOutput))

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        preferredDeviceKey = "missing",
      )

    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, session.requestedInputType)
    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, audioManager.communicationDevice?.type)
    session.close()
  }

  @Test
  fun stableInputKeyUsesDeviceAttributesInsteadOfRuntimeId() {
    val key = audioInputDeviceKey(type = 26, address = "usb:1", productName = "Desk Mic")

    assertEquals("26|usb%3A1|Desk+Mic", key)
    assertEquals(AudioInputDeviceOption(key, "Desk Mic", 26), audioInputDeviceOptionFromKey(key))
  }

  @Test
  fun unavailablePreferredInputIsRetainedWhenItAppearsLater() {
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val wired = audioDevice(AudioDeviceInfo.TYPE_WIRED_HEADSET)
    val preferredDeviceKey = audioInputDeviceKey(wired)
    shadowAudioManager.setInputDevices(listOf(ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(bleOutput))
    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        preferredDeviceKey = preferredDeviceKey,
        setPreferredDevice = { true },
      )

    shadowAudioManager.addInputDevice(wired, true)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(wired.type, session.requestedInputType)
    session.close()
  }

  @Test
  fun deviceObserverTracksHotPlugAndStopsAfterClose() {
    val builtIn = audioDevice(AudioDeviceInfo.TYPE_BUILTIN_MIC)
    shadowAudioManager.setInputDevices(listOf(builtIn))
    val snapshots = mutableListOf<List<AudioInputDeviceOption>>()

    val observer = AndroidAudioInputSession.observeAvailableDevices(context, snapshots::add)
    assertEquals(listOf(builtIn.type), snapshots.last().map(AudioInputDeviceOption::type))

    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.addInputDevice(ble, true)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(setOf(builtIn.type, ble.type), snapshots.last().mapTo(mutableSetOf(), AudioInputDeviceOption::type))

    observer.close()
    val snapshotCount = snapshots.size
    shadowAudioManager.addInputDevice(audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO), true)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(snapshotCount, snapshots.size)
  }

  @Test
  fun closeRestoresDefaultInputAndUnregistersDeviceCallback() {
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(bleOutput))
    val session = AndroidAudioInputSession.open(context, sampleRateHz = 8_000, frameBytes = 1_600)

    session.close()

    assertNull(session.requestedInputType)
    assertNull(audioManager.communicationDevice)
    shadowAudioManager.addInputDevice(audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET), true)
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(session.requestedInputType)
  }

  @Test
  fun delayedOldCloseDoesNotClearNewerCommunicationRoute() {
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(bleOutput))
    val oldSession = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)
    val newSession = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    oldSession.close()

    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, audioManager.communicationDevice?.type)
    newSession.close()
    assertNull(audioManager.communicationDevice)
  }

  @Test
  fun audioRecordErrorsFailTheSharedCaptureSession() {
    assertEquals(0, checkAudioRecordReadResult(0))
    assertEquals(32, checkAudioRecordReadResult(32))

    val deadObject =
      runCatching { checkAudioRecordReadResult(AudioRecord.ERROR_DEAD_OBJECT) }
        .exceptionOrNull()
    assertTrue(deadObject is IllegalStateException)
    assertEquals("microphone read failed: ERROR_DEAD_OBJECT", deadObject?.message)

    val unknown = runCatching { checkAudioRecordReadResult(-99) }.exceptionOrNull()
    assertTrue(unknown is IllegalStateException)
    assertEquals("microphone read failed: code=-99", unknown?.message)
  }

  @Test
  fun defaultProfileOpensVoiceRecognitionAudioSource() {
    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    assertEquals(MediaRecorder.AudioSource.VOICE_RECOGNITION, capturedAudioSource(session))
    session.close()
  }

  @Test
  fun communicationProfileOpensVoiceCommunicationAudioSource() {
    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertEquals(MediaRecorder.AudioSource.VOICE_COMMUNICATION, capturedAudioSource(session))
    session.close()
  }

  @Test
  fun recognitionProfileNeverCreatesAcousticEchoCanceler() {
    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    assertFalse(session.communicationEchoCancellationEnabled)
    session.close()
  }

  @Test
  fun communicationProfileWithoutPlatformAecReportsDisabled() {
    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    // No AudioEffect.Descriptor registered in this Robolectric environment, so
    // platform AEC is unavailable — the safe-fallback surface (no crash, no
    // false "enabled") that a device without AEC hardware also exercises.
    assertFalse(session.communicationEchoCancellationEnabled)
    session.close()
  }

  @Test
  fun communicationProfileWithPlatformAecReportsEnabled() {
    registerFakeAcousticEchoCancelerEffect()

    val session =
      AndroidAudioInputSession.open(
        context,
        sampleRateHz = 24_000,
        frameBytes = 4_800,
        profile = AndroidAudioInputProfile.VoiceCommunication,
      )

    assertTrue(session.communicationEchoCancellationEnabled)
    session.close()
  }

  @Test
  fun recognitionProfileIgnoresAvailablePlatformAec() {
    registerFakeAcousticEchoCancelerEffect()

    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    // Manual Mic/STT never requests communication-profile AEC ownership, even
    // when the platform effect is available for other capture sessions.
    assertFalse(session.communicationEchoCancellationEnabled)
    session.close()
  }

  private fun registerFakeAcousticEchoCancelerEffect() {
    val descriptor = AudioEffect.Descriptor()
    descriptor.type = AudioEffect.EFFECT_TYPE_AEC
    descriptor.uuid = UUID.randomUUID()
    descriptor.connectMode = AudioEffect.EFFECT_PRE_PROCESSING
    descriptor.name = "Test AEC"
    descriptor.implementor = "Test"
    ShadowAudioEffect.addEffect(descriptor)
  }

  private fun capturedAudioSource(session: AndroidAudioInputSession): Int {
    val field = session.javaClass.getDeclaredField("audioRecord")
    field.isAccessible = true
    return (field.get(session) as AudioRecord).audioSource
  }

  private fun audioDevice(type: Int): AudioDeviceInfo {
    val device =
      AudioDeviceInfoBuilder
        .newBuilder()
        .setType(type)
        .build()
    val port = ReflectionHelpers.getField<Any>(device, "mPort")
    val handle = ReflectionHelpers.getField<Any>(port, "mHandle")
    ReflectionHelpers.setField(handle, "mId", nextDeviceId++)
    return device
  }
}
