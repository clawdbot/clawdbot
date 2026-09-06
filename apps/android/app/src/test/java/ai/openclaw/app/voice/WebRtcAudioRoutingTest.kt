package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import kotlinx.coroutines.CancellationException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WebRtcAudioRoutingTest {
  private val manager = RuntimeEnvironment.getApplication().getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val routes = mutableListOf<WebRtcAudioRouting>()
  private var id = 1

  private fun device(type: Int): AudioDeviceInfo {
    val device = AudioDeviceInfoBuilder.newBuilder().setType(type).build()
    val port = ReflectionHelpers.getField<Any>(device, "mPort")
    ReflectionHelpers.setField(ReflectionHelpers.getField<Any>(port, "mHandle"), "mId", id++)
    return device
  }

  @After fun cleanup() {
    routes.forEach { it.close() }
    shadowOf(manager).setInputDevices(emptyList())
    shadowOf(manager).setAvailableCommunicationDevices(emptyList())
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test fun savedUsbIsRequestedWhileFocusAndHandsFreeOutputAreOwned() {
    val usb = device(AudioDeviceInfo.TYPE_USB_DEVICE)
    val speaker = device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowOf(manager).setInputDevices(listOf(usb))
    shadowOf(manager).setAvailableCommunicationDevices(listOf(speaker))
    var requested: AudioDeviceInfo? = null
    val states = mutableListOf<AudioInputPreferenceState>()
    val route =
      WebRtcAudioRouting
        .open(
          manager,
          audioInputDeviceKey(usb),
          { requested = it },
          onInputRequested = { states.add(AudioInputPreferenceState.Requested(it)) },
        ).also { routes += it }
    assertEquals(usb, requested)
    assertEquals(speaker, manager.communicationDevice)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
    assertEquals(AudioInputPreferenceState.Requested(audioInputDeviceKey(usb)), states.last())
    assertTrue(states.none { it is AudioInputPreferenceState.Applied })
    route.close()
    assertEquals(usb, requested)
    assertNull(manager.communicationDevice)
    assertEquals(AudioManager.MODE_NORMAL, manager.mode)
  }

  @Test fun unavailablePreferenceUsesNativeAutomaticBluetoothPriorityAndHotplug() {
    val missing = device(AudioDeviceInfo.TYPE_USB_DEVICE)
    val ble = device(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val sco = device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    shadowOf(manager).setInputDevices(listOf(sco, ble))
    shadowOf(manager).setAvailableCommunicationDevices(listOf(sco, ble))
    var requested: AudioDeviceInfo? = null
    var requestedKey: String? = "not-yet-observed"
    WebRtcAudioRouting
      .open(
        manager,
        audioInputDeviceKey(missing),
        { requested = it },
        onInputRequested = { requestedKey = it },
      ).also { routes += it }
    assertEquals(ble, requested)
    assertNull(requestedKey)
    shadowOf(manager).setAvailableCommunicationDevices(listOf(sco))
    shadowOf(manager).removeInputDevice(ble, true)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(sco, requested)
    assertEquals(sco, manager.communicationDevice)
  }

  @Test fun oldCleanupAndFocusCallbacksCannotRevokeReplacement() {
    val speaker = device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    shadowOf(manager).setAvailableCommunicationDevices(listOf(speaker))
    var losses = 0
    val old = WebRtcAudioRouting.open(manager, null, {}, onFocusLost = { losses++ }).also { routes += it }
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    val replacement = WebRtcAudioRouting.open(manager, null, {}, onFocusLost = { losses++ }).also { routes += it }
    old.close()
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(0, losses)
    assertEquals(speaker, manager.communicationDevice)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
    shadowOf(manager).lastAudioFocusRequest.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
    replacement.close()
    assertEquals(AudioManager.MODE_NORMAL, manager.mode)
  }

  @Test fun rejectedOrStaleAcquisitionDoesNotLeaveFocusOrRoute() {
    manager.mode = AudioManager.MODE_IN_CALL
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    assertThrows(IllegalStateException::class.java) { WebRtcAudioRouting.open(manager, null, {}) }
    assertEquals(AudioManager.MODE_IN_CALL, manager.mode)
    assertNull(manager.communicationDevice)
    assertThrows(CancellationException::class.java) { WebRtcAudioRouting.open(manager, null, {}, isCurrent = { false }) }
  }

  @Test fun cancellationDuringRequestedCallbackClosesTheUnpublishedLease() {
    var current = true
    assertThrows(CancellationException::class.java) {
      WebRtcAudioRouting.open(manager, null, {}, isCurrent = { current }, onInputRequested = { current = false })
    }
    assertEquals(AudioManager.MODE_NORMAL, manager.mode)
    assertNull(manager.communicationDevice)
  }
}
