package ai.openclaw.app.voice

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Classifies an Android output device into the engine's route profile.
 *
 * Only the built-in loudspeaker is acoustically coupled enough to close the
 * uplink on. Everything else — wired headsets, USB headsets, Bluetooth, the
 * handset receiver — keeps the microphone open, which is the contract the iOS
 * client already ships.
 *
 * `TYPE_USB_DEVICE` is deliberately not in that list. Android reports a USB
 * headset as `TYPE_USB_HEADSET`; the generic type is a dock, a speaker or an
 * audio interface, and granting concurrent capture there would open the
 * microphone into a loudspeaker with nothing cancelling it. It falls through
 * to [RealtimeRouteProfile.Unknown], which runs half duplex — a route we
 * cannot classify never fails open.
 */
internal fun realtimeRouteProfileForOutput(type: Int): RealtimeRouteProfile =
  when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE,
    -> RealtimeRouteProfile.BuiltInSpeaker
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> RealtimeRouteProfile.BuiltInEarpiece
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_HEARING_AID,
    -> RealtimeRouteProfile.DeviceOwnedVoiceProcessing
    else -> RealtimeRouteProfile.Unknown
  }

/**
 * Picks the microphone preset for a route.
 *
 * On a route where software echo control owns the echo path, the least
 * preprocessed microphone Android will give us is the right input: a
 * device-side canceller in front of it changes the near-end signal without
 * changing the far-end reference the software canceller subtracts, and the two
 * fight. On a route the platform already voice-processes, the communication
 * preset is what turns that pipeline on.
 */
internal fun realtimeInputPresetForRoute(
  route: RealtimeRouteProfile,
  unprocessedSupported: Boolean,
): RealtimeInputPreset =
  when (route) {
    RealtimeRouteProfile.BuiltInSpeaker ->
      if (unprocessedSupported) RealtimeInputPreset.Unprocessed else RealtimeInputPreset.VoiceRecognition
    RealtimeRouteProfile.DeviceOwnedVoiceProcessing,
    RealtimeRouteProfile.BuiltInEarpiece,
    -> RealtimeInputPreset.VoiceCommunication
    // An unresolved route runs half duplex anyway, so the communication preset
    // keeps whatever protection the platform offers until the route is known.
    RealtimeRouteProfile.Unknown -> RealtimeInputPreset.VoiceCommunication
  }

/** What the platform reports about its own capture effects. Availability is a capability bit, never proof of acoustic quality. */
internal data class PlatformCaptureEffectReport(
  val acousticEchoCancelerAvailable: Boolean,
  val automaticGainControlAvailable: Boolean,
  val noiseSuppressorAvailable: Boolean,
)

internal fun readPlatformCaptureEffects(): PlatformCaptureEffectReport =
  PlatformCaptureEffectReport(
    acousticEchoCancelerAvailable = runCatching { AcousticEchoCanceler.isAvailable() }.getOrDefault(false),
    automaticGainControlAvailable = runCatching { AutomaticGainControl.isAvailable() }.getOrDefault(false),
    noiseSuppressorAvailable = runCatching { NoiseSuppressor.isAvailable() }.getOrDefault(false),
  )

/**
 * Owns the Android communication audio session for one Talk session.
 *
 * Three things make this safe. The mode and focus are acquired once per Talk
 * session rather than per assistant response, so a response boundary cannot
 * leave the device in the wrong mode. Every release checks that it still owns
 * the session, so a slow teardown cannot restore state over a newer session
 * that has already started. And acquisition and release are serialized against
 * each other, because a release that ran while an acquisition was between
 * changing the mode and publishing its ownership would decide it had nothing to
 * restore and leave the device in call mode.
 */
internal class RealtimeAudioSessionPolicy(
  private val audioManager: AudioManager,
) {
  private val generation = AtomicLong(0)

  @Volatile private var activeGeneration: Long = 0

  @Volatile private var previousMode: Int = AudioManager.MODE_NORMAL

  @Volatile private var focusRequest: AudioFocusRequest? = null

  /** Returns the generation that owns the session, or 0 when acquisition failed. */
  @Synchronized
  fun acquire(): Long {
    val owned = generation.incrementAndGet()
    // Only the first acquisition records what to restore. A rapid stop and
    // restart can overlap, and a second acquisition that recorded the mode it
    // had just set would restore the device into call mode after Talk stops.
    if (activeGeneration == 0L) previousMode = audioManager.mode
    // Communication and routing context. This is never read back as a
    // statement about echo safety: `MODE_IN_COMMUNICATION` says how audio is
    // routed and mixed, not whether the microphone can hear the speaker.
    runCatching { audioManager.mode = AudioManager.MODE_IN_COMMUNICATION }
      .onFailure { Log.w(tag, "audio mode not applied: ${it.message ?: it::class.simpleName}") }
    val request =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(
          AudioAttributes
            .Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        ).build()
    focusRequest = request
    val granted = runCatching { audioManager.requestAudioFocus(request) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    activeGeneration = owned
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.w(tag, "audio focus not granted (code $granted); continuing without exclusive focus")
    }
    return owned
  }

  /** Applies a communication device and reports the device the platform actually selected. */
  @Synchronized
  fun selectCommunicationDevice(
    owner: Long,
    device: AudioDeviceInfo?,
  ): AudioDeviceInfo? {
    if (owner != activeGeneration) return null
    if (device == null) {
      runCatching { audioManager.clearCommunicationDevice() }
      return audioManager.communicationDevice
    }
    val accepted = runCatching { audioManager.setCommunicationDevice(device) }.getOrDefault(false)
    if (!accepted) {
      Log.w(tag, "communication device rejected type=${device.type}")
    }
    // The request is not the outcome. Read back what the platform selected
    // rather than assuming the requested device took effect.
    return audioManager.communicationDevice
  }

  fun currentCommunicationDevice(): AudioDeviceInfo? = runCatching { audioManager.communicationDevice }.getOrNull()

  @Synchronized
  fun release(owner: Long) {
    // A teardown that lost the race must not restore state over the session
    // that replaced it, and a session that never acquired has nothing to give
    // back.
    if (owner == 0L || owner != activeGeneration) return
    activeGeneration = 0
    focusRequest?.let { request ->
      runCatching { audioManager.abandonAudioFocusRequest(request) }
    }
    focusRequest = null
    runCatching { audioManager.clearCommunicationDevice() }
    runCatching { audioManager.mode = previousMode }
  }

  companion object {
    private const val tag = "RealtimeMedia"
  }
}
