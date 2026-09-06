package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import org.webrtc.audio.JavaAudioDeviceModule.AudioRecordErrorCallback
import org.webrtc.audio.JavaAudioDeviceModule.AudioRecordStartErrorCode
import org.webrtc.audio.JavaAudioDeviceModule.AudioTrackErrorCallback
import org.webrtc.audio.JavaAudioDeviceModule.AudioTrackStartErrorCode
import java.nio.ByteBuffer
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** One WebRTC call. All JNI ownership is serialized on Main, never on a native callback thread. */
internal class TalkRealtimePeer(
  private val context: Context,
  private val scope: CoroutineScope,
  private val onEvent: (String) -> Unit,
  private val onFailure: (String) -> Unit,
  private val preferredAudioInputDevice: () -> String? = { null },
  private val onInputRequested: (String?) -> Unit = {},
) {
  private var factory: PeerConnectionFactory? = null
  private var audioDevice: JavaAudioDeviceModule? = null
  private var audioRouting: WebRtcAudioRouting? = null
  private var selectedAudioInputKey: String? = null
  private var inputPreferenceSet = false
  private var source: AudioSource? = null
  private var track: AudioTrack? = null
  private var peer: PeerConnection? = null
  private var channel: DataChannel? = null
  private var closing: Deferred<Unit>? = null
  private val closed: Boolean get() = closing != null
  private var startup: CompletableDeferred<Unit>? = null
  private var captureEnabled = true
  private var playbackEnabled = true
  private val ready = CompletableDeferred<Unit>()
  private val callbackLock = ReentrantLock()
  private val callbacksDrained = callbackLock.newCondition()
  private var acceptingCallbacks = true
  private var callbacksInFlight = 0
  private val events = Channel<String>(64)
  private val eventPump: Job =
    scope.launch(Dispatchers.Main.immediate) {
      try {
        for (event in events) onEvent(event)
      } catch (error: Exception) {
        if (error !is CancellationException) fail("Realtime event processing failed")
      }
    }

  suspend fun start(exchangeOffer: suspend (String) -> String) =
    withContext(Dispatchers.Main.immediate) {
      check(!closed && peer == null) { "Realtime peer is not available" }
      val setup = CompletableDeferred<Unit>(coroutineContext[Job]).also { startup = it }
      try {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
        val audio =
          JavaAudioDeviceModule
            .builder(context)
            .setAudioAttributes(RealtimeCommunicationAudio.playbackAttributes())
            .setAudioRecordErrorCallback(audioRecordErrors)
            .setAudioTrackErrorCallback(audioTrackErrors)
            .createAudioDeviceModule()
        audioDevice = audio
        selectedAudioInputKey = preferredAudioInputDevice()
        updateAudioRouting()
        val createdFactory = PeerConnectionFactory.builder().setAudioDeviceModule(audio).createPeerConnectionFactory()
        factory = createdFactory
        val config =
          PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
          }
        val createdPeer = checkNotNull(createdFactory.createPeerConnection(config, observer)) { "Could not create realtime peer" }
        peer = createdPeer
        createdPeer.setAudioRecording(captureEnabled)
        createdPeer.setAudioPlayout(playbackEnabled)
        val createdSource = createdFactory.createAudioSource(MediaConstraints())
        source = createdSource
        val createdTrack = createdFactory.createAudioTrack("openclaw-talk-audio", createdSource)
        track = createdTrack
        createdTrack.setEnabled(captureEnabled)
        createdPeer.addTrack(createdTrack, listOf("openclaw-talk"))
        val createdChannel = checkNotNull(createdPeer.createDataChannel("oai-events", DataChannel.Init()))
        channel = createdChannel
        createdChannel.registerObserver(
          object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit

            override fun onStateChange() {
              scope.launch(Dispatchers.Main.immediate) {
                if (closed || channel !== createdChannel) return@launch
                when (createdChannel.state()) {
                  DataChannel.State.OPEN -> ready.complete(Unit)
                  DataChannel.State.CLOSED -> fail("Realtime data channel closed")
                  else -> Unit
                }
              }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
              callbackLock.withLock {
                if (!acceptingCallbacks) return
                callbacksInFlight++
              }
              try {
                // WebRTC frees the native buffer after this callback returns (DataChannel.java).
                if (buffer.binary || buffer.data.remaining() > 1_048_576) {
                  scope.launch(Dispatchers.Main.immediate) { fail("Invalid realtime event") }
                  return
                }
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                if (events.trySend(bytes.toString(Charsets.UTF_8)).isFailure) {
                  scope.launch(Dispatchers.Main.immediate) { fail("Realtime event queue overflow") }
                }
              } finally {
                callbackLock.withLock {
                  callbacksInFlight--
                  callbacksDrained.signalAll()
                }
              }
            }
          },
        )
        withTimeoutOrNull(30_000) {
          val offer = CompletableDeferred<SessionDescription>()
          createdPeer.createOffer(SdpResult(offer), MediaConstraints())
          val local = offer.await()
          checkCurrent(createdPeer)
          val localSet = CompletableDeferred<Unit>()
          createdPeer.setLocalDescription(SdpResult(set = localSet), local)
          localSet.await()
          checkCurrent(createdPeer)
          val answer = exchangeOffer(local.description)
          checkCurrent(createdPeer)
          val remoteSet = CompletableDeferred<Unit>()
          createdPeer.setRemoteDescription(SdpResult(set = remoteSet), SessionDescription(SessionDescription.Type.ANSWER, answer))
          remoteSet.await()
          checkCurrent(createdPeer)
          ready.await()
          checkCurrent(createdPeer)
        } ?: error("Realtime connection timed out")
      } catch (error: Throwable) {
        close()
        throw error
      } finally {
        startup = null
        setup.complete(Unit)
      }
    }

  suspend fun send(event: String) =
    withContext(Dispatchers.Main.immediate) {
      val current = channel
      check(!closed && current?.state() == DataChannel.State.OPEN) { "Realtime data channel is not open" }
      check(current.send(DataChannel.Buffer(ByteBuffer.wrap(event.toByteArray(Charsets.UTF_8)), false))) { "Realtime event was not sent" }
    }

  suspend fun setCaptureEnabled(enabled: Boolean) =
    withContext(Dispatchers.Main.immediate) {
      // Disabling capture is a physical handoff even when close already owns cleanup.
      closing?.let { return@withContext if (enabled) Unit else it.await() }
      updateAudioState {
        captureEnabled = enabled
        // Muting samples alone leaves AudioRecord alive and races PTT microphone ownership.
        if (enabled) updateAudioRouting()
        track?.setEnabled(enabled)
        peer?.setAudioRecording(enabled)
        if (!enabled) updateAudioRouting()
      }
    }

  suspend fun setPlaybackEnabled(enabled: Boolean) =
    withContext(Dispatchers.Main.immediate) {
      if (closed) return@withContext
      updateAudioState {
        playbackEnabled = enabled
        if (enabled) updateAudioRouting()
        peer?.setAudioPlayout(enabled)
        if (!enabled) updateAudioRouting()
      }
    }

  private inline fun updateAudioState(action: () -> Unit) {
    try {
      action()
    } catch (error: CancellationException) {
      throw error
    } catch (_: RuntimeException) {
      fail("Realtime audio routing or focus unavailable")
    }
  }

  private fun requestInput(
    audio: JavaAudioDeviceModule,
    device: AudioDeviceInfo?,
  ) {
    if (device != null) {
      audio.setPreferredInputDevice(device)
      inputPreferenceSet = true
    } else if (inputPreferenceSet) {
      // This pinned SDK dereferences null and has no public clear-preference API.
      // A fresh call can use Auto; never retain a vanished device while claiming Auto.
      fail("Realtime microphone route changed; restart Talk to use automatic input")
    }
  }

  private fun updateAudioRouting() {
    val audio = audioDevice ?: return
    if (closed) return
    if (captureEnabled || playbackEnabled) {
      if (audioRouting == null) {
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioRouting =
          WebRtcAudioRouting.open(
            manager,
            selectedAudioInputKey,
            { device -> requestInput(audio, device) },
            isCurrent = { !closed && (captureEnabled || playbackEnabled) },
            onFocusLost = { fail("Realtime audio focus lost") },
            onInputRequested = onInputRequested,
          )
      }
    } else {
      audioRouting?.close()
      audioRouting = null
    }
  }

  suspend fun close(): Unit =
    withContext(NonCancellable + Dispatchers.Main.immediate) {
      // Publish one cleanup before it can run; every caller awaits its physical result.
      val cleanup =
        closing ?: async(start = CoroutineStart.LAZY) {
          try {
            ready.cancel()
            channel?.unregisterObserver()
            callbackLock.withLock { acceptingCallbacks = false }
            withContext(Dispatchers.IO) {
              callbackLock.withLock {
                while (callbacksInFlight > 0) callbacksDrained.await()
              }
            }
            events.close()
            eventPump.join()
            channel?.let {
              it.close()
              it.dispose()
            }
            channel = null
            peer?.dispose()
            peer = null
            track?.dispose()
            track = null
            source?.dispose()
            source = null
            factory?.dispose()
            factory = null
            audioDevice?.release()
            audioDevice = null
          } finally {
            audioRouting?.close()
            audioRouting = null
          }
        }.also { closing = it }
      cleanup.await()
    }

  private fun checkCurrent(expected: PeerConnection) {
    check(!closed && peer === expected) { "Realtime call stopped during setup" }
  }

  private fun fail(message: String) {
    if (closed) return
    // Fail the startup scope at any SDP/HTTP/readiness wait. Its caller owns cleanup
    // and recovery; the runtime callback must not disable Auto first.
    startup?.let {
      it.completeExceptionally(IllegalStateException(message))
      return
    }
    try {
      onFailure(message)
    } finally {
      scope.launch(Dispatchers.Main.immediate) { close() }
    }
  }

  private fun audioFailure(message: String) {
    scope.launch(Dispatchers.Main.immediate) { fail(message) }
  }

  private val audioRecordErrors =
    object : AudioRecordErrorCallback {
      override fun onWebRtcAudioRecordInitError(error: String) = audioFailure("Realtime microphone initialization failed")

      override fun onWebRtcAudioRecordStartError(
        code: AudioRecordStartErrorCode,
        error: String,
      ) = audioFailure("Realtime microphone start failed")

      override fun onWebRtcAudioRecordError(error: String) = audioFailure("Realtime microphone failed")
    }

  private val audioTrackErrors =
    object : AudioTrackErrorCallback {
      override fun onWebRtcAudioTrackInitError(error: String) = audioFailure("Realtime speaker initialization failed")

      override fun onWebRtcAudioTrackStartError(
        code: AudioTrackStartErrorCode,
        error: String,
      ) = audioFailure("Realtime speaker start failed")

      override fun onWebRtcAudioTrackError(error: String) = audioFailure("Realtime speaker failed")
    }

  private val observer =
    object : PeerConnection.Observer {
      override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

      override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit

      override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

      override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit

      override fun onIceCandidate(candidate: IceCandidate) = Unit

      override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

      override fun onAddStream(stream: MediaStream) = Unit

      override fun onRemoveStream(stream: MediaStream) = Unit

      override fun onDataChannel(channel: DataChannel) = Unit

      override fun onRenegotiationNeeded() = Unit

      override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
        if (state == PeerConnection.PeerConnectionState.FAILED || state == PeerConnection.PeerConnectionState.CLOSED) {
          scope.launch(Dispatchers.Main.immediate) { fail("Realtime connection closed") }
        }
      }
    }

  private class SdpResult(
    private val offer: CompletableDeferred<SessionDescription>? = null,
    private val set: CompletableDeferred<Unit>? = null,
  ) : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) {
      offer?.complete(description)
    }

    override fun onSetSuccess() {
      set?.complete(Unit)
    }

    override fun onCreateFailure(error: String) {
      offer?.completeExceptionally(IllegalStateException("Realtime SDP creation failed"))
    }

    override fun onSetFailure(error: String) {
      set?.completeExceptionally(IllegalStateException("Realtime SDP setup failed"))
    }
  }
}
