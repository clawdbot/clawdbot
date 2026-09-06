package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.util.ReflectionHelpers
import org.webrtc.audio.JavaAudioDeviceModule
import org.webrtc.audio.JavaAudioDeviceModule.AudioRecordErrorCallback
import org.webrtc.audio.JavaAudioDeviceModule.AudioTrackErrorCallback

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimePeerAudioTest {
  @Test fun concurrentCloseWaitsForTheSamePhysicalRetirement() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, {})
      try {
        withContext(Dispatchers.Main.immediate) {
          val first = async(start = CoroutineStart.UNDISPATCHED) { peer.close() }
          val second = async(start = CoroutineStart.UNDISPATCHED) { peer.close() }
          try {
            assertFalse("A second close must wait while the first cleanup is suspended", second.isCompleted)
          } finally {
            first.await()
            second.await()
          }
        }
      } finally {
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun asynchronousAudioDeviceFailuresCloseTheCallVisibly() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val failures = mutableListOf<String>()
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, { failures.add(it) })
      val record = realtimeTestField(peer, "audioRecordErrors").get(peer) as AudioRecordErrorCallback
      record.onWebRtcAudioRecordInitError("redacted")
      runCurrent()
      assertEquals(listOf("Realtime microphone initialization failed"), failures)
      peer.close()
      val trackPeer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, { failures.add(it) })
      val track = realtimeTestField(trackPeer, "audioTrackErrors").get(trackPeer) as AudioTrackErrorCallback
      track.onWebRtcAudioTrackError("redacted")
      runCurrent()
      assertEquals("Realtime speaker failed", failures.last())
      trackPeer.close()
      Dispatchers.resetMain()
    }

  @Test fun closeDrainsProviderEventsAcceptedBeforeObserverRetirement() =
    runTest {
      val dispatcher = StandardTestDispatcher(testScheduler)
      Dispatchers.setMain(dispatcher)
      val received = mutableListOf<String>()
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, { received += it }, {})
      try {
        @Suppress("UNCHECKED_CAST")
        val events = realtimeTestField(peer, "events").get(peer) as Channel<String>
        assertTrue(events.trySend("accepted-before-close").isSuccess)
        val closing = launch { peer.close() }
        runCurrent()
        closing.join()
        assertEquals(listOf("accepted-before-close"), received)
      } finally {
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun pauseResumeAndCloseOwnFocusWithoutAllocatingANativeCall() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val failures = mutableListOf<String>()
      val peer = TalkRealtimePeer(context, this, {}, { failures.add(it) })
      try {
        peer.setCaptureEnabled(false)
        peer.setPlaybackEnabled(false)
        // The Java module can be configured before JNI allocation; this exercises the
        // real peer toggle path without making a provider call or creating a recorder.
        ReflectionHelpers.setField(peer, "audioDevice", JavaAudioDeviceModule.builder(context).createAudioDeviceModule())
        peer.setCaptureEnabled(true)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
        val first = shadowOf(manager).lastAudioFocusRequest.audioFocusRequest
        peer.setCaptureEnabled(false)
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
        peer.setPlaybackEnabled(true)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
        assertNotSame(first, shadowOf(manager).lastAudioFocusRequest.audioFocusRequest)
        peer.close()
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
        peer.setPlaybackEnabled(true)
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
        assertTrue(failures.isEmpty())
      } finally {
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun lostSelectedInputEndsTheCallRatherThanCallingTheSdkWithNull() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val device = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_USB_DEVICE).build()
      shadowOf(manager).setInputDevices(listOf(device))
      val failures = mutableListOf<String>()
      val requested = mutableListOf<String?>()
      val peer = TalkRealtimePeer(context, this, {}, { failures.add(it) }, { audioInputDeviceKey(device) }, { requested.add(it) })
      try {
        peer.setCaptureEnabled(false)
        peer.setPlaybackEnabled(false)
        ReflectionHelpers.setField(peer, "audioDevice", JavaAudioDeviceModule.builder(context).createAudioDeviceModule())
        ReflectionHelpers.setField(peer, "selectedAudioInputKey", audioInputDeviceKey(device))
        peer.setCaptureEnabled(true)
        assertEquals(audioInputDeviceKey(device), requested.last())
        shadowOf(manager).removeInputDevice(device, true)
        shadowOf(Looper.getMainLooper()).idle()
        // Await the failure-triggered cleanup, without initiating close from the test.
        coroutineContext[Job]!!.children.toList().joinAll()
        assertEquals(listOf("Realtime microphone route changed; restart Talk to use automatic input"), failures)
        assertTrue(requested.all { it == audioInputDeviceKey(device) })
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
      } finally {
        peer.close()
        shadowOf(manager).setInputDevices(emptyList())
        Dispatchers.resetMain()
      }
    }

  @Test fun refusedFocusOnResumeReportsFailureRatherThanSilentlyStalling() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val failures = mutableListOf<String>()
      val peer = TalkRealtimePeer(context, this, {}, { failures.add(it) })
      try {
        peer.setCaptureEnabled(false)
        peer.setPlaybackEnabled(false)
        ReflectionHelpers.setField(peer, "audioDevice", JavaAudioDeviceModule.builder(context).createAudioDeviceModule())
        shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        peer.setCaptureEnabled(true)
        assertEquals(listOf("Realtime audio routing or focus unavailable"), failures)
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
      } finally {
        peer.close()
        Dispatchers.resetMain()
      }
    }
}
