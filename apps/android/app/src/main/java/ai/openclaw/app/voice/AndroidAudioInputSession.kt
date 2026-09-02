package ai.openclaw.app.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.URLDecoder
import java.net.URLEncoder

internal data class AudioInputDeviceOption(
  val key: String,
  val productName: String,
  val type: Int,
)

/**
 * The capture semantics one [AndroidAudioInputSession] is opened with.
 *
 * Two lanes, deliberately not merged. Manual Mic/STT and push-to-talk want the recognition
 * preset; realtime Talk wants the communication preset, which is the capture path Android's own
 * echo canceller attaches to.
 */
internal enum class AndroidAudioInputProfile(
  internal val audioSource: Int,
) {
  VoiceRecognition(MediaRecorder.AudioSource.VOICE_RECOGNITION),
  VoiceCommunication(MediaRecorder.AudioSource.VOICE_COMMUNICATION),
}

/** Owns one recorder and its Bluetooth route for the full capture lifecycle. */
internal class AndroidAudioInputSession private constructor(
  private val audioManager: AudioManager,
  private val audioRecord: AudioRecord,
  private val acousticEchoCanceler: AcousticEchoCanceler?,
  private val profile: AndroidAudioInputProfile,
  private val preferredInputKey: String?,
  private val onAppliedPreferredDeviceChanged: (String?) -> Unit,
  private val setPreferredDevice: (AudioDeviceInfo?) -> Boolean,
) : RealtimeCaptureCandidate {
  companion object {
    private const val tag = "AudioInput"

    @SuppressLint("MissingPermission")
    fun open(
      context: Context,
      sampleRateHz: Int,
      frameBytes: Int,
      preferredDeviceKey: String? = null,
      onAppliedPreferredDeviceChanged: (String?) -> Unit = {},
      setPreferredDevice: ((AudioDeviceInfo?) -> Boolean)? = null,
      profile: AndroidAudioInputProfile = AndroidAudioInputProfile.VoiceRecognition,
    ): AndroidAudioInputSession {
      val minBuffer =
        AudioRecord.getMinBufferSize(
          sampleRateHz,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
      if (minBuffer <= 0) {
        throw IllegalStateException("AudioRecord buffer unavailable")
      }
      val audioRecord =
        AudioRecord
          .Builder()
          .setAudioSource(profile.audioSource)
          .setAudioFormat(
            AudioFormat
              .Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(sampleRateHz)
              .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
              .build(),
          ).setBufferSizeInBytes(maxOf(minBuffer, frameBytes * 4))
          .build()
      // The effect is optional: the caller's forwarding policy already falls back to half duplex
      // without it, so an echo canceller that cannot be set up must never cost the session its
      // microphone.
      val acousticEchoCanceler = openAcousticEchoCanceler(profile, audioRecord.audioSessionId)
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      return AndroidAudioInputSession(
        audioManager = audioManager,
        audioRecord = audioRecord,
        acousticEchoCanceler = acousticEchoCanceler,
        profile = profile,
        preferredInputKey = preferredDeviceKey,
        onAppliedPreferredDeviceChanged = onAppliedPreferredDeviceChanged,
        setPreferredDevice = setPreferredDevice ?: audioRecord::setPreferredDevice,
      ).also { session ->
        try {
          session.openRoute()
        } catch (err: RuntimeException) {
          session.close()
          throw err
        }
      }
    }

    /**
     * Attaches the platform echo canceller to the recorder's own effect session.
     *
     * Communication profile only, and only ever a request: whether the platform actually enabled
     * it is read back by the caller from the effect itself. `create` succeeding says nothing --
     * AOSP documents that an AEC may already be inserted, or not, depending on the audio source,
     * and tells applications to read the enabled state back per session.
     */
    private fun openAcousticEchoCanceler(
      profile: AndroidAudioInputProfile,
      audioSessionId: Int,
    ): AcousticEchoCanceler? {
      if (profile != AndroidAudioInputProfile.VoiceCommunication) return null
      if (!runCatching { AcousticEchoCanceler.isAvailable() }.getOrDefault(false)) return null
      val canceler = runCatching { AcousticEchoCanceler.create(audioSessionId) }.getOrNull() ?: return null
      val enableResult = runCatching { if (canceler.enabled) AudioEffect.SUCCESS else canceler.setEnabled(true) }
      val result = enableResult.getOrNull()
      if (result == null) {
        // Release the half-configured effect rather than leaking it; the caller keeps half duplex.
        Log.w(tag, "AcousticEchoCanceler enable threw: ${enableResult.exceptionOrNull()?.message ?: "unknown"}")
        runCatching { canceler.release() }
        return null
      }
      if (result != AudioEffect.SUCCESS) {
        Log.w(tag, "AcousticEchoCanceler enable returned $result")
      }
      return canceler
    }

    fun listAvailableDevices(context: Context): List<AudioInputDeviceOption> {
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      return audioManager
        .getDevices(AudioManager.GET_DEVICES_INPUTS)
        .map { device ->
          AudioInputDeviceOption(
            key = audioInputDeviceKey(device),
            productName = device.productName.toString().trim(),
            type = device.type,
          )
        }.distinctBy(AudioInputDeviceOption::key)
        .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER, AudioInputDeviceOption::productName).thenBy(AudioInputDeviceOption::type))
    }

    fun observeAvailableDevices(
      context: Context,
      onChanged: (List<AudioInputDeviceOption>) -> Unit,
    ): AutoCloseable {
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val callback =
        object : AudioDeviceCallback() {
          override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            onChanged(listAvailableDevices(context))
          }

          override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            onChanged(listAvailableDevices(context))
          }
        }
      audioManager.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
      onChanged(listAvailableDevices(context))
      return AutoCloseable { audioManager.unregisterAudioDeviceCallback(callback) }
    }
  }

  private val lock = Any()
  private val communicationRouteOwner = communicationRoute.newOwner()
  private val callbackHandler = Handler(Looper.getMainLooper())
  private var closed = false
  private var callbackRegistered = false
  private var routingListenerRegistered = false
  private var requestedInput: AudioDeviceInfo? = null
  private var requestedCommunicationDevice: AudioDeviceInfo? = null
  private var selectedInput: AudioDeviceInfo? = null
  private var appliedPreferredInputKey: String? = null
  private var appliedCommunicationType: Int? = null

  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
        refreshRouteSafely()
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
        refreshRouteSafely()
      }
    }
  private val routingChangedListener = AudioRouting.OnRoutingChangedListener { refreshActualRouteSafely() }
  internal val preferredInputType: Int?
    get() = synchronized(lock) { selectedInput?.type }

  internal val requestedInputType: Int?
    get() = synchronized(lock) { requestedInput?.type }

  internal val appliedPreferredDeviceKey: String?
    get() = synchronized(lock) { appliedPreferredInputKey }

  /**
   * Whether the platform reports echo cancellation as actually enabled for this capture session.
   *
   * Read back from the effect, never inferred from the audio source, from `isAvailable`, from the
   * route, or from `create` succeeding -- but served from a cached value rather than measured on
   * the caller's thread. The capture loop consults this once per frame, and the effect read is an
   * IPC guarded by the same [lock] that [refreshRoute] holds across several `AudioManager` binder
   * calls; answering it inline would put a route change on the critical path of `AudioRecord.read`
   * and overrun the recorder. Nothing here blocks, so a slow route refresh cannot stall capture.
   *
   * The cache is refreshed by whoever owns the effect's lifecycle -- at open, on every route
   * change, and by the caller's own watcher -- via [refreshCommunicationEchoCancellation].
   */
  @Volatile
  private var cachedEchoCancellationEnabled = false

  internal val communicationEchoCancellationEnabled: Boolean
    get() = cachedEchoCancellationEnabled

  /**
   * Re-measures the effect and republishes the cache. Takes [lock], performs IPC, and may block
   * behind a route refresh, so it must never be called from the capture read loop.
   *
   * Returns the freshly measured value. A closed session always answers false, which is what
   * makes the capability shrink on teardown rather than linger at its last true reading.
   */
  internal fun refreshCommunicationEchoCancellation(): Boolean =
    // Measured and published under the same lock. Publishing outside it would let a watcher that
    // measured `true` before a concurrent close overwrite the `false` that close just published,
    // leaving the capability granted for a released effect.
    synchronized(lock) {
      val enabled = if (closed) false else runCatching { acousticEchoCanceler?.enabled == true }.getOrDefault(false)
      cachedEchoCancellationEnabled = enabled
      enabled
    }

  /**
   * The communication output this session actually holds, or null when it holds none -- either
   * because it is a recognition-profile session or because the platform rejected the request.
   * Never inferred from what was asked for.
   */
  internal val appliedCommunicationDeviceType: Int?
    get() = synchronized(lock) { appliedCommunicationType }

  /**
   * The rate the recorder negotiated, read back from it rather than assumed from the request.
   *
   * This session owns the capture clock; callers converting capture to a wire rate must build that
   * conversion from this value, because a recorder is free to grant a rate other than the one it
   * was asked for.
   */
  override val actualSampleRateHz: Int
    get() = audioRecord.sampleRate

  fun startRecording() {
    synchronized(lock) {
      check(!closed) { "audio input session closed" }
      audioRecord.addOnRoutingChangedListener(routingChangedListener, callbackHandler)
      routingListenerRegistered = true
    }
    audioRecord.startRecording()
    refreshActualRouteSafely()
    // Seed the cache from the running recorder. Until this lands the capability reads false, so a
    // session is half duplex until the effect has actually been measured, never before.
    refreshCommunicationEchoCancellation()
    Log.d(tag, "capture started preferred=${preferredInputType ?: "default"} routed=${audioRecord.routedDevice?.type ?: "pending"}")
  }

  fun read(
    buffer: ByteArray,
    offset: Int,
    size: Int,
  ): Int = checkAudioRecordReadResult(audioRecord.read(buffer, offset, size))

  private fun openRoute() {
    audioManager.registerAudioDeviceCallback(deviceCallback, callbackHandler)
    synchronized(lock) { callbackRegistered = true }
    communicationRoute.begin(communicationRouteOwner)
    refreshRouteSafely()
  }

  private fun refreshRouteSafely() {
    try {
      refreshRoute()
    } catch (err: RuntimeException) {
      // Routing is a preference; default capture remains better than losing the voice session.
      Log.w(tag, "Bluetooth route update failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private fun refreshRoute() {
    synchronized(lock) {
      if (closed) return@synchronized
      val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
      val preferredInput = resolvePreferredAudioInput(inputs, preferredInputKey)
      if (preferredInput != null && applyRoute(inputs, preferredInput)) {
        // return@synchronized, not return: `synchronized` is inline, so a bare return here would
        // leave refreshRoute entirely and skip the re-measure below -- on the branch that fires
        // whenever a preferred input is configured, i.e. the common case for anyone who used the
        // device picker.
        return@synchronized
      }
      // A rejected record preference may have set a Bluetooth communication route.
      // Recalculate automatic priority instead of retaining that rejected target.
      if (preferredInput != null) requestedCommunicationDevice = null
      setAppliedPreferredInputKey(null)
      applyRoute(inputs, null)
    }
    // Outside the monitor above, and after it: a route change is the event that can hand the
    // canceller a different reference signal or none, so the cached capability is re-measured
    // here rather than left at whatever the previous route reported.
    refreshCommunicationEchoCancellation()
  }

  private fun applyRoute(
    inputs: List<AudioDeviceInfo>,
    preferredInput: AudioDeviceInfo?,
  ): Boolean {
    val available = audioManager.availableCommunicationDevices
    val bluetoothDevice =
      if (preferredInput == null) {
        selectBluetoothDevice(available, requestedCommunicationDevice)
      } else {
        selectCommunicationDevice(available, preferredInput)
      }
    // Communication capture owns the output route too. Without an explicit selection Android's
    // phone strategy sends communication audio to the earpiece, which turns hands-free Talk into
    // hold-it-to-your-ear Talk. Only the built-in pair is ever overridden: any external
    // communication output was chosen deliberately and already outranks the earpiece.
    val communicationDevice = bluetoothDevice ?: handsFreeBuiltInSpeaker(available)
    val appliedCommunicationDevice = communicationRoute.update(audioManager, communicationRouteOwner, communicationDevice)
    appliedCommunicationType = appliedCommunicationDevice?.type
    // Input following stays Bluetooth-only: the built-in speaker is an output and must never be
    // handed to the input selector as if it were a headset.
    requestedCommunicationDevice = bluetoothDevice.takeIf { appliedCommunicationDevice != null }
    val input = preferredInput ?: selectBluetoothInput(inputs, requestedInput, requestedCommunicationDevice)
    if (sameDevice(requestedInput, input) && sameDevice(selectedInput, input)) return true
    requestedInput = input
    return if (setPreferredDevice(input)) {
      selectedInput = input
      Log.d(tag, "preferred input changed type=${input?.type ?: "default"}")
      true
    } else {
      selectedInput = null
      Log.w(tag, "preferred input rejected type=${input?.type ?: "default"}")
      false
    }
  }

  /**
   * The built-in speaker, but only when choosing it is the difference between the loudspeaker and
   * the earpiece. Any external communication output present means the platform already has a
   * better answer than the earpiece, and taking it would be stealing an intentional route.
   */
  private fun handsFreeBuiltInSpeaker(available: List<AudioDeviceInfo>): AudioDeviceInfo? {
    if (profile != AndroidAudioInputProfile.VoiceCommunication) return null
    if (available.any { isDeliberateExternalOutput(it.type) }) return null
    return available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
  }

  /**
   * Outputs a person plugged in, paired, or docked into, and therefore chose over the handset.
   *
   * Deliberately an allowlist. `availableCommunicationDevices` can also carry entries that are
   * simply always there -- telephony on a handset, a bus on Automotive -- and treating "anything
   * that is not the built-in pair" as a deliberate choice would silently leave hands-free Talk on
   * the earpiece for a whole class of devices, with nothing to distinguish it from working.
   */
  private fun isDeliberateExternalOutput(type: Int): Boolean =
    when (type) {
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_USB_ACCESSORY,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_HEARING_AID,
      AudioDeviceInfo.TYPE_DOCK,
      AudioDeviceInfo.TYPE_HDMI,
      -> true

      else -> false
    }

  private fun setAppliedPreferredInputKey(value: String?) {
    if (appliedPreferredInputKey == value) return
    appliedPreferredInputKey = value
    onAppliedPreferredDeviceChanged(value)
  }

  private fun refreshActualRouteSafely() {
    try {
      refreshActualRoute()
    } catch (err: RuntimeException) {
      Log.w(tag, "audio route verification failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private fun refreshActualRoute() {
    val routeChanged =
      synchronized(lock) {
        if (closed) return@synchronized false
        val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
        val expectedInput = resolvePreferredAudioInput(inputs, preferredInputKey)
        if (expectedInput == null) {
          setAppliedPreferredInputKey(null)
          applyRoute(inputs, null)
          return@synchronized true
        }
        val routedInput = audioRecord.routedDevice
        if (sameDevice(routedInput, expectedInput)) {
          setAppliedPreferredInputKey(preferredInputKey)
          return@synchronized false
        }
        setAppliedPreferredInputKey(null)
        false
      }
    // Only when the route was actually touched. The two no-op exits above -- closed, and the
    // routed device already matching -- change nothing the canceller depends on, and this call
    // costs an effect IPC and a second lock acquisition on the main thread.
    if (routeChanged) refreshCommunicationEchoCancellation()
  }

  override fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
      // Shrink first: a caller reading the cache during teardown must never be told the effect is
      // still cancelling for a recorder that is being released.
      cachedEchoCancellationEnabled = false
      if (callbackRegistered) {
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
        callbackRegistered = false
      }
      if (routingListenerRegistered) {
        runCatching { audioRecord.removeOnRoutingChangedListener(routingChangedListener) }
        routingListenerRegistered = false
      }
      runCatching { audioRecord.setPreferredDevice(null) }
      requestedInput = null
      selectedInput = null
      setAppliedPreferredInputKey(null)
      if (audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
        runCatching { audioRecord.stop() }
      }
      // Before the recorder: the effect is attached to that recorder's audio session id.
      runCatching { acousticEchoCanceler?.release() }
      runCatching { audioRecord.release() }
      communicationRoute.close(audioManager, communicationRouteOwner)
      requestedCommunicationDevice = null
      appliedCommunicationType = null
    }
  }
}

/**
 * Serializes Android's process-wide communication route across overlapping capture cleanup.
 *
 * [activeOwner] is whichever capture is responsible for the selection currently standing on the
 * platform -- not necessarily the one that made it. Responsibility follows the newest capture (see
 * [claim]), so that exactly one close path can always clear the selection.
 */
private class CommunicationDeviceRoute {
  private val tag = "AudioInput"
  private var nextOwner = 0L
  private var latestOwner = 0L
  private var activeOwner: Long? = null

  @Synchronized
  fun newOwner(): Long = ++nextOwner

  @Synchronized
  fun begin(owner: Long) {
    claim(owner)
  }

  /**
   * Makes [owner] the newest capture, handing it the standing selection, or reports it superseded.
   *
   * Runs before any fallible platform call, at both entry points: [begin], and [update], which the
   * platform's initial device callback can reach first. Everything after this point -- device
   * discovery, `setCommunicationDevice` -- can throw, and [update] and [close] each decline to act
   * for a superseded owner. Advancing [latestOwner] without moving [activeOwner] would therefore
   * leave a replacement whose setup threw with a previous owner that may no longer clear and a new
   * owner that never became active: the process-wide selection would outlive every capture that
   * could have released it.
   */
  private fun claim(owner: Long): Boolean {
    if (owner < latestOwner) return false
    if (owner > latestOwner) {
      latestOwner = owner
      if (activeOwner != null) activeOwner = owner
    }
    return true
  }

  /** Returns the device the platform actually selected, or null when it selected none. */
  @Synchronized
  fun update(
    audioManager: AudioManager,
    owner: Long,
    device: AudioDeviceInfo?,
  ): AudioDeviceInfo? {
    if (!claim(owner)) return null
    if (device == null) {
      if (activeOwner != null) audioManager.clearCommunicationDevice()
      activeOwner = null
      return null
    }
    if (!audioManager.setCommunicationDevice(device)) {
      if (activeOwner != null) audioManager.clearCommunicationDevice()
      activeOwner = null
      return null
    }
    activeOwner = owner
    // A request is not an outcome. Report what the platform says it selected, so nothing upstream
    // claims a route Android did not actually give it.
    val applied = audioManager.communicationDevice
    if (applied == null || applied.id != device.id) {
      // Reported as "not held" but deliberately NOT torn down. setCommunicationDevice accepted the
      // request; on Bluetooth the SCO link is established asynchronously, so an immediate
      // disagreeing read-back is the expected transient rather than a rejection. Clearing here
      // would cancel a route that was about to come up, and the resulting device callbacks would
      // drive the same request again -- an audible connect/disconnect cycle that never settles.
      // The request stays standing; only the reported value is honest about what is confirmed.
      Log.w(tag, "communication device requested id=${device.id} but platform selected id=${applied?.id}")
      return null
    }
    return applied
  }

  @Synchronized
  fun close(
    audioManager: AudioManager,
    owner: Long,
  ) {
    if (activeOwner != owner || owner < latestOwner) return
    audioManager.clearCommunicationDevice()
    activeOwner = null
  }
}

private val communicationRoute = CommunicationDeviceRoute()

/** Converts AudioRecord's negative return codes into capture-session failures. */
internal fun checkAudioRecordReadResult(result: Int): Int {
  if (result >= 0) return result
  val label =
    when (result) {
      AudioRecord.ERROR -> "ERROR"
      AudioRecord.ERROR_BAD_VALUE -> "ERROR_BAD_VALUE"
      AudioRecord.ERROR_INVALID_OPERATION -> "ERROR_INVALID_OPERATION"
      AudioRecord.ERROR_DEAD_OBJECT -> "ERROR_DEAD_OBJECT"
      else -> "code=$result"
    }
  throw IllegalStateException("microphone read failed: $label")
}

private fun selectBluetoothDevice(
  devices: List<AudioDeviceInfo>,
  current: AudioDeviceInfo? = null,
): AudioDeviceInfo? {
  current
    ?.takeIf { candidate ->
      bluetoothPriority(candidate.type) != null && devices.any { sameDevice(it, candidate) }
    }?.let { return it }
  return devices
    .asSequence()
    .mapNotNull { device -> bluetoothPriority(device.type)?.let { priority -> priority to device } }
    .minWithOrNull(compareBy<Pair<Int, AudioDeviceInfo>> { it.first }.thenBy { it.second.id })
    ?.second
}

private fun selectBluetoothInput(
  devices: List<AudioDeviceInfo>,
  current: AudioDeviceInfo?,
  communicationDevice: AudioDeviceInfo?,
): AudioDeviceInfo? {
  if (communicationDevice == null) return selectBluetoothDevice(devices, current)
  val candidates = devices.filter { it.type == communicationDevice.type }
  current?.takeIf { candidate -> candidates.any { sameDevice(it, candidate) } }?.let { return it }
  val address = communicationDevice.address.trim()
  if (address.isNotEmpty()) {
    candidates.firstOrNull { it.address == address }?.let { return it }
  }
  // setCommunicationDevice chooses the matching source; only override it when unambiguous.
  return candidates.singleOrNull()
}

private fun selectCommunicationDevice(
  devices: List<AudioDeviceInfo>,
  input: AudioDeviceInfo,
): AudioDeviceInfo? {
  if (bluetoothPriority(input.type) == null) return null
  val candidates = devices.filter { it.type == input.type }
  val address = input.address.trim()
  return candidates.firstOrNull { address.isNotEmpty() && it.address == address } ?: candidates.singleOrNull()
}

internal fun audioInputDeviceKey(device: AudioDeviceInfo): String = audioInputDeviceKey(device.type, device.address, device.productName.toString())

internal fun resolvePreferredAudioInput(
  devices: List<AudioDeviceInfo>,
  preferredDeviceKey: String?,
): AudioDeviceInfo? = preferredDeviceKey?.let { key -> devices.firstOrNull { audioInputDeviceKey(it) == key } }

internal fun audioInputDeviceKey(
  type: Int,
  address: String,
  productName: String,
): String {
  // AudioDeviceInfo.id is per-boot; persist routing attributes and re-resolve each session.
  // Fields are URL-encoded so the key stays XML-safe in SharedPreferences; a raw
  // control-char separator can corrupt the whole plain prefs file on reload.
  return listOf(type.toString(), address, productName).joinToString("|") { URLEncoder.encode(it, "UTF-8") }
}

internal fun audioInputDeviceOptionFromKey(key: String): AudioInputDeviceOption? {
  val parts = key.split("|", limit = 3).map { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() ?: return null }
  if (parts.size != 3) return null
  return AudioInputDeviceOption(
    key = key,
    productName = parts[2],
    type = parts[0].toIntOrNull() ?: return null,
  )
}

private fun bluetoothPriority(type: Int): Int? =
  when (type) {
    AudioDeviceInfo.TYPE_BLE_HEADSET -> 0
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 1
    else -> null
  }

private fun sameDevice(
  left: AudioDeviceInfo?,
  right: AudioDeviceInfo?,
): Boolean = left?.id == right?.id && left?.type == right?.type
