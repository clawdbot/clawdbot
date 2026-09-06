package ai.openclaw.app.voice

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.MediaConstraints
import org.webrtc.MediaSource
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpSender
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  shadows = [StartupPeerFactory::class, StartupPeerFactoryBuilder::class, StartupPeerConnection::class, StartupDataChannel::class, StartupMediaTrack::class, StartupMediaSource::class],
)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimePeerTest {
  @Before fun resetNativeBoundary() {
    StartupPeerConnection.reset()
    StartupDataChannel.reset()
  }

  @Test fun successfulSetupTransfersFailuresToTheRuntimeOwner() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val failures = mutableListOf<String>()
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, { failures.add(it) })
      val start = async { runCatching { peer.start { "v=0" } } }
      try {
        runCurrent()
        if (StartupPeerConnection.offer == null) start.await().getOrThrow()
        StartupPeerConnection.offer!!.onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
        runCurrent()
        assertFalse("Data-channel readiness is still required", start.isCompleted)
        StartupDataChannel.open()
        start.await().getOrThrow()
        assertFalse(StartupPeerConnection.disposed)
        StartupPeerConnection.observer!!.onConnectionChange(PeerConnection.PeerConnectionState.FAILED)
        runCurrent()
        coroutineContext[Job]!!.children.toList().joinAll()
        assertEquals(listOf("Realtime connection closed"), failures)
        assertTrue(StartupPeerConnection.disposed)
      } finally {
        start.cancel()
        start.join()
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun outerDeadlineRemainsCallerCancellation() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, {})
      val start = async { runCatching { withTimeout(1_000) { peer.start { error("No offer expected") } } } }
      try {
        runCurrent()
        if (StartupPeerConnection.offer == null) start.await().getOrThrow()
        val failure = start.await().exceptionOrNull()
        assertTrue(failure is CancellationException)
        assertEquals(1_000, currentTime)
        assertTrue(StartupPeerConnection.disposed)
      } finally {
        start.cancel()
        start.join()
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun setupDeadlineIsAFailureNotAnIntentionalStop() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, {})
      val start = async { runCatching { peer.start { error("SDP creation has not completed") } } }
      try {
        runCurrent()
        if (StartupPeerConnection.offer == null) start.await().getOrThrow()
        assertTrue(StartupPeerConnection.offer != null)
        advanceTimeBy(30_000)
        runCurrent()
        val failure = start.await().exceptionOrNull()
        assertTrue("The peer's own setup deadline must be a startup failure, got $failure", failure is IllegalStateException)
        assertFalse("Setup expiry must not escape as cancellation: $failure", failure is CancellationException)
        assertTrue(StartupPeerConnection.disposed)
      } finally {
        start.cancel()
        start.join()
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun callerCancellationStillCancelsAndDisposesSetup() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val peer = TalkRealtimePeer(RuntimeEnvironment.getApplication(), this, {}, {})
      val start = async { runCatching { peer.start { error("SDP creation has not completed") } } }
      try {
        runCurrent()
        if (StartupPeerConnection.offer == null) start.await().getOrThrow()
        assertTrue(StartupPeerConnection.offer != null)
        start.cancel()
        start.join()
        assertTrue(start.isCancelled)
        assertTrue(StartupPeerConnection.disposed)
      } finally {
        start.cancel()
        start.join()
        peer.close()
        Dispatchers.resetMain()
      }
    }
}

// Replace only the JNI boundary. The real peer owns its deadline, callback dispatch,
// audio focus, lifecycle, and cleanup; tests hold the SDK's asynchronous SDP result.
@Implements(value = PeerConnectionFactory::class, isInAndroidSdk = false)
class StartupPeerFactory {
  companion object {
    @JvmStatic @Implementation
    fun initialize(options: PeerConnectionFactory.InitializationOptions) = Unit
  }

  @Implementation fun createPeerConnection(
    config: PeerConnection.RTCConfiguration,
    observer: PeerConnection.Observer,
  ): PeerConnection {
    StartupPeerConnection.observer = observer
    return Shadow.newInstanceOf(PeerConnection::class.java)
  }

  @Implementation fun createAudioSource(constraints: MediaConstraints): AudioSource = AudioSource(1L)

  @Implementation fun createAudioTrack(
    id: String,
    source: AudioSource,
  ): AudioTrack = AudioTrack(1L)

  @Implementation fun dispose() = Unit
}

@Implements(value = PeerConnectionFactory.Builder::class, isInAndroidSdk = false)
class StartupPeerFactoryBuilder {
  @Implementation fun createPeerConnectionFactory(): PeerConnectionFactory = Shadow.newInstanceOf(PeerConnectionFactory::class.java)
}

@Implements(value = PeerConnection::class, isInAndroidSdk = false)
class StartupPeerConnection {
  companion object {
    var observer: PeerConnection.Observer? = null
    var offer: SdpObserver? = null
    var offerCreated = CompletableDeferred<SdpObserver>()
    var disposed = false

    fun reset() {
      observer = null
      offer = null
      offerCreated = CompletableDeferred()
      disposed = false
    }
  }

  @Implementation fun createOffer(
    observer: SdpObserver,
    constraints: MediaConstraints,
  ) {
    offer = observer
    offerCreated.complete(observer)
  }

  @Implementation fun setLocalDescription(
    observer: SdpObserver,
    description: SessionDescription,
  ) {
    observer.onSetSuccess()
  }

  @Implementation fun setRemoteDescription(
    observer: SdpObserver,
    description: SessionDescription,
  ) {
    observer.onSetSuccess()
  }

  @Implementation fun createDataChannel(
    label: String,
    init: DataChannel.Init,
  ): DataChannel = Shadow.newInstanceOf(DataChannel::class.java)

  @Implementation fun setAudioRecording(enabled: Boolean) = Unit

  @Implementation fun setAudioPlayout(enabled: Boolean) = Unit

  @Implementation fun addTrack(
    track: MediaStreamTrack,
    streamIds: List<String>,
  ): RtpSender? = null

  @Implementation fun dispose() {
    disposed = true
  }
}

@Implements(value = DataChannel::class, isInAndroidSdk = false)
class StartupDataChannel {
  companion object {
    private var observer: DataChannel.Observer? = null
    private var state = DataChannel.State.CONNECTING
    val sent = mutableListOf<String>()

    fun message(payload: String) {
      observer!!.onMessage(DataChannel.Buffer(java.nio.ByteBuffer.wrap(payload.toByteArray()), false))
    }

    fun open() {
      state = DataChannel.State.OPEN
      observer!!.onStateChange()
    }

    fun reset() {
      observer = null
      state = DataChannel.State.CONNECTING
      sent.clear()
    }
  }

  @Implementation fun registerObserver(value: DataChannel.Observer) {
    observer = value
  }

  @Implementation fun state(): DataChannel.State = state

  @Implementation fun send(buffer: DataChannel.Buffer): Boolean {
    val bytes = ByteArray(buffer.data.remaining())
    buffer.data.get(bytes)
    sent.add(bytes.toString(Charsets.UTF_8))
    return true
  }

  @Implementation fun unregisterObserver() = Unit

  @Implementation fun close() = Unit

  @Implementation fun dispose() = Unit
}

@Implements(value = MediaStreamTrack::class, isInAndroidSdk = false)
class StartupMediaTrack {
  @Implementation fun setEnabled(enabled: Boolean): Boolean = true

  @Implementation fun dispose() = Unit
}

@Implements(value = MediaSource::class, isInAndroidSdk = false)
class StartupMediaSource {
  @Implementation fun dispose() = Unit
}
