package ai.openclaw.app.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log

/** Owns one recorder and its Bluetooth route for the full capture lifecycle. */
internal class AndroidAudioInputSession private constructor(
  private val audioManager: AudioManager,
  private val audioRecord: AudioRecord,
) : AutoCloseable {
  companion object {
    private const val tag = "AudioInput"

    @SuppressLint("MissingPermission")
    fun open(
      context: Context,
      sampleRateHz: Int,
      frameBytes: Int,
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
      return AndroidAudioInputSession(audioManager, audioRecord).also { session ->
        try {
          session.openRoute()
        } catch (err: RuntimeException) {
          session.close()
          throw err
        }
      }
    }
  }

  private val lock = Any()
  private val communicationRouteOwner = bluetoothCommunicationRoute.newOwner()
  private val callbackHandler = Handler(Looper.getMainLooper())
  private var closed = false
  private var callbackRegistered = false
  private var requestedInput: AudioDeviceInfo? = null
  private var requestedCommunicationDevice: AudioDeviceInfo? = null
  private var selectedInput: AudioDeviceInfo? = null

  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
        refreshRouteSafely()
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
        refreshRouteSafely()
      }
    }
  internal val preferredInputType: Int?
    get() = synchronized(lock) { selectedInput?.type }

  internal val requestedInputType: Int?
    get() = synchronized(lock) { requestedInput?.type }

  fun startRecording() {
    audioRecord.startRecording()
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
      val communicationDevice = selectBluetoothDevice(audioManager.availableCommunicationDevices, requestedCommunicationDevice)
      val communicationSelected = bluetoothCommunicationRoute.update(audioManager, communicationRouteOwner, communicationDevice)
      requestedCommunicationDevice = communicationDevice.takeIf { communicationSelected }
      val input = selectBluetoothInput(inputs, requestedInput, requestedCommunicationDevice)
      if (!sameDevice(requestedInput, input) || !sameDevice(selectedInput, input)) {
        requestedInput = input
        if (audioRecord.setPreferredDevice(input)) {
          selectedInput = input
          Log.d(tag, "preferred input changed type=${input?.type ?: "default"}")
        } else {
          selectedInput = null
          Log.w(tag, "preferred input rejected type=${input?.type ?: "default"}")
        }
      }
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
      runCatching { audioRecord.setPreferredDevice(null) }
      requestedInput = null
      selectedInput = null
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
