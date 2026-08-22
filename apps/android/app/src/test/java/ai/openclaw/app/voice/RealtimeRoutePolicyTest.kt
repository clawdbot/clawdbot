package ai.openclaw.app.voice

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RealtimeRoutePolicyTest {
  @Test
  fun onlyTheBuiltInSpeakerIsTreatedAsAcousticallyCoupled() {
    // This is the line the shipped iOS client already draws: the microphone
    // closes during output only when the route contains the built-in speaker.
    assertEquals(
      RealtimeRouteProfile.BuiltInSpeaker,
      realtimeRouteProfileForOutput(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER),
    )
    assertEquals(
      RealtimeRouteProfile.BuiltInSpeaker,
      realtimeRouteProfileForOutput(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE),
    )
    assertEquals(
      RealtimeRouteProfile.BuiltInEarpiece,
      realtimeRouteProfileForOutput(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE),
    )
    for (
    headset in
    listOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_HEARING_AID,
    )
    ) {
      assertEquals(
        "type $headset should keep barge-in",
        RealtimeRouteProfile.DeviceOwnedVoiceProcessing,
        realtimeRouteProfileForOutput(headset),
      )
    }
  }

  @Test
  fun anUnrecognisedOutputFailsClosed() {
    // Guessing the permissive answer for a route nobody classified is what puts
    // the assistant's own voice on the uplink.
    assertEquals(
      RealtimeRouteProfile.Unknown,
      realtimeRouteProfileForOutput(AudioDeviceInfo.TYPE_HDMI),
    )
  }

  @Test
  fun aGenericUsbOutputIsNotTreatedAsAHeadset() {
    // Android reports a USB headset as its own type. The generic one is a dock,
    // a speaker or an audio interface, and granting concurrent capture there
    // opens the microphone into a loudspeaker with nothing cancelling it.
    assertEquals(
      RealtimeRouteProfile.Unknown,
      realtimeRouteProfileForOutput(AudioDeviceInfo.TYPE_USB_DEVICE),
    )
    assertEquals(
      RealtimeRouteProfile.DeviceOwnedVoiceProcessing,
      realtimeRouteProfileForOutput(AudioDeviceInfo.TYPE_USB_HEADSET),
    )
  }

  @Test
  fun softwareEchoRouteAsksForTheLeastPreprocessedMicrophone() {
    assertEquals(
      RealtimeInputPreset.Unprocessed,
      realtimeInputPresetForRoute(RealtimeRouteProfile.BuiltInSpeaker, unprocessedSupported = true),
    )
    assertEquals(
      RealtimeInputPreset.VoiceRecognition,
      realtimeInputPresetForRoute(RealtimeRouteProfile.BuiltInSpeaker, unprocessedSupported = false),
    )
  }

  @Test
  fun theSpeakerAndHeadsetRoutesDisagreeAboutThePreset() {
    // This is why a route change has to reopen the input stream rather than
    // flip a flag: the microphone preset is a property of the stream, and
    // leaving a communication-preset microphone on a route the software
    // canceller now owns puts two cancellers on the same signal.
    val speaker = realtimeInputPresetForRoute(RealtimeRouteProfile.BuiltInSpeaker, unprocessedSupported = false)
    val headset =
      realtimeInputPresetForRoute(RealtimeRouteProfile.DeviceOwnedVoiceProcessing, unprocessedSupported = false)
    assertNotEquals(speaker, headset)
  }

  @Test
  fun platformEchoRoutesAskForTheCommunicationPreset() {
    // Exactly one echo control owner: where the platform owns it, the
    // communication preset is what turns that pipeline on.
    for (
    route in
    listOf(
      RealtimeRouteProfile.DeviceOwnedVoiceProcessing,
      RealtimeRouteProfile.BuiltInEarpiece,
      RealtimeRouteProfile.Unknown,
    )
    ) {
      assertEquals(
        RealtimeInputPreset.VoiceCommunication,
        realtimeInputPresetForRoute(route, unprocessedSupported = true),
      )
    }
  }
}
