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

/** Owns one recorder and its Bluetooth route for the full capture lifecycle. */
internal class AndroidAudioInputSession private constructor(
  private val audioManager: AudioManager,
  private val audioRecord: AudioRecord,
  private val preferredInputKey: String?,
  private val onAppliedPreferredDeviceChanged: (String?) -> Unit,
  private val setPreferredDevice: (AudioDeviceInfo?) -> Boolean,
) : AutoCloseable {
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
          .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
          .setAudioFormat(
            AudioFormat
              .Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(sampleRateHz)
              .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
              .build(),
          ).setBufferSizeInBytes(maxOf(minBuffer, frameBytes * 4))
          .build()
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      return AndroidAudioInputSession(
        audioManager = audioManager,
        audioRecord = audioRecord,
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
  private val communicationRouteOwner = bluetoothCommunicationRoute.newOwner()
  private val callbackHandler = Handler(Looper.getMainLooper())
  private var closed = false
  private var callbackRegistered = false
  private var routingListenerRegistered = false
  private var requestedInput: AudioDeviceInfo? = null
  private var requestedCommunicationDevice: AudioDeviceInfo? = null
  private var selectedInput: AudioDeviceInfo? = null
  private var appliedPreferredInputKey: String? = null

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

  fun startRecording() {
    synchronized(lock) {
      check(!closed) { "audio input session closed" }
      audioRecord.addOnRoutingChangedListener(routingChangedListener, callbackHandler)
      routingListenerRegistered = true
    }
    audioRecord.startRecording()
    refreshActualRouteSafely()
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
    bluetoothCommunicationRoute.begin(communicationRouteOwner)
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
      if (closed) return
      val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
      val preferredInput = resolvePreferredAudioInput(inputs, preferredInputKey)
      if (preferredInput != null && applyRoute(inputs, preferredInput)) {
        return
      }
      // A rejected record preference may have set a Bluetooth communication route.
      // Recalculate automatic priority instead of retaining that rejected target.
      if (preferredInput != null) requestedCommunicationDevice = null
      setAppliedPreferredInputKey(null)
      applyRoute(inputs, null)
    }
  }

  private fun applyRoute(
    inputs: List<AudioDeviceInfo>,
    preferredInput: AudioDeviceInfo?,
  ): Boolean {
    val communicationDevice =
      if (preferredInput == null) {
        selectBluetoothDevice(audioManager.availableCommunicationDevices, requestedCommunicationDevice)
      } else {
        selectCommunicationDevice(audioManager.availableCommunicationDevices, preferredInput)
      }
    val communicationSelected = bluetoothCommunicationRoute.update(audioManager, communicationRouteOwner, communicationDevice)
    requestedCommunicationDevice = communicationDevice.takeIf { communicationSelected }
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
    synchronized(lock) {
      if (closed) return
      val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
      val expectedInput = resolvePreferredAudioInput(inputs, preferredInputKey)
      if (expectedInput == null) {
        setAppliedPreferredInputKey(null)
        applyRoute(inputs, null)
        return
      }
      val routedInput = audioRecord.routedDevice
      if (sameDevice(routedInput, expectedInput)) {
        setAppliedPreferredInputKey(preferredInputKey)
        return
      }
      setAppliedPreferredInputKey(null)
    }
  }

  override fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
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
      runCatching { audioRecord.release() }
      bluetoothCommunicationRoute.close(audioManager, communicationRouteOwner)
      requestedCommunicationDevice = null
    }
  }
}

/** Serializes Android's process-wide communication route across overlapping capture cleanup. */
private class BluetoothCommunicationRoute {
  private var nextOwner = 0L
  private var latestOwner = 0L
  private var activeOwner: Long? = null

  @Synchronized
  fun newOwner(): Long = ++nextOwner

  @Synchronized
  fun begin(owner: Long) {
    if (owner > latestOwner) latestOwner = owner
  }

  @Synchronized
  fun update(
    audioManager: AudioManager,
    owner: Long,
    device: AudioDeviceInfo?,
  ): Boolean {
    if (owner < latestOwner) return false
    latestOwner = owner
    if (device == null) {
      if (activeOwner != null) audioManager.clearCommunicationDevice()
      activeOwner = null
      return false
    }
    if (!audioManager.setCommunicationDevice(device)) {
      if (activeOwner != null) audioManager.clearCommunicationDevice()
      activeOwner = null
      return false
    }
    activeOwner = owner
    return true
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

private val bluetoothCommunicationRoute = BluetoothCommunicationRoute()

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
