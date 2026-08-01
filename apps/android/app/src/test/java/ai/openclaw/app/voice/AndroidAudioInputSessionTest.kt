package ai.openclaw.app.voice

import android.Manifest
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecord
import android.os.Looper
import org.junit.After
import org.junit.Assert.assertEquals
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
import org.robolectric.shadows.ShadowAudioManager
import org.robolectric.util.ReflectionHelpers

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
