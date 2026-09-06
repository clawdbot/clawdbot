package ai.openclaw.app.voice

import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CancellationException

/** WebRTC shares native capture's focus/mode and communication-route ownership. */
internal class WebRtcAudioRouting private constructor(
  private val manager: AudioManager,
  private val preferredKey: String?,
  private val setPreferredInput: (AudioDeviceInfo?) -> Unit,
  private val isCurrent: () -> Boolean,
  private val onFocusLost: () -> Unit,
  private val onInputRequested: (String?) -> Unit,
) : AutoCloseable {
  companion object {
    fun open(
      manager: AudioManager,
      preferredKey: String?,
      setPreferredInput: (AudioDeviceInfo?) -> Unit,
      isCurrent: () -> Boolean = { true },
      onFocusLost: () -> Unit = {},
      onInputRequested: (String?) -> Unit = {},
    ): WebRtcAudioRouting {
      val route = WebRtcAudioRouting(manager, preferredKey, setPreferredInput, isCurrent, onFocusLost, onInputRequested)
      try {
        route.start()
        if (!route.current()) throw CancellationException("audio capture replaced")
        return route
      } catch (error: RuntimeException) {
        route.close()
        throw error
      }
    }
  }

  private var closed = false
  private var callbackRegistered = false
  private var focus: RealtimeCommunicationAudio? = null
  private val owner = bluetoothCommunicationRoute.newOwner()
  private var requestedInput: AudioDeviceInfo? = null
  private var requestedBluetooth: AudioDeviceInfo? = null
  private val handler = Handler(Looper.getMainLooper())
  private val current = { !closed && isCurrent() }
  private val devices =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
    }

  private fun start() {
    if (!current()) throw CancellationException("audio capture replaced")
    focus = RealtimeCommunicationAudio.open(manager, current, onFocusLost)
    if (!bluetoothCommunicationRoute.begin(owner, current)) throw CancellationException("audio capture replaced")
    manager.registerAudioDeviceCallback(devices, handler)
    callbackRegistered = true
    refresh()
  }

  private fun refresh() {
    if (!current()) return
    try {
      val inputs = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
      val preferred = resolvePreferredAudioInput(inputs, preferredKey)
      val outputs = manager.availableCommunicationDevices
      val bluetooth = if (preferred == null) selectBluetoothDevice(outputs, requestedBluetooth) else selectCommunicationDevice(outputs, preferred)
      // Keep native Talk's external-output/speaker policy when communication mode is active.
      val output =
        bluetooth ?: outputs.firstOrNull { it.type in externalCommunicationOutputs }
          ?: outputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
      val selected = bluetoothCommunicationRoute.update(manager, owner, output, current)
      requestedBluetooth = bluetooth.takeIf { selected }
      requestedInput = preferred ?: selectBluetoothInput(inputs, requestedInput, requestedBluetooth)
      if (current()) {
        setPreferredInput(requestedInput)
        if (current()) onInputRequested(preferredKey.takeIf { preferred != null })
      }
      // JavaAudioDeviceModule's setter returns no result and exposes no routed recorder.
      // This is a request, never evidence for onAppliedAudioInputChanged.
    } catch (error: RuntimeException) {
      if (current()) {
        Log.w("TalkAudio", "WebRTC input routing unavailable")
        bluetoothCommunicationRoute.close(manager, owner)
        requestedInput = null
        requestedBluetooth = null
        setPreferredInput(null)
        if (current()) onInputRequested(null)
      }
    }
  }

  override fun close() {
    if (closed) return
    closed = true
    if (callbackRegistered) runCatching { manager.unregisterAudioDeviceCallback(devices) }
    // The peer stops capture before releasing this lease. SDK device preferences
    // belong to its module and cannot be cleared through the public null-unsafe setter.
    try {
      bluetoothCommunicationRoute.close(manager, owner)
    } finally {
      focus?.close()
      focus = null
    }
  }
}
