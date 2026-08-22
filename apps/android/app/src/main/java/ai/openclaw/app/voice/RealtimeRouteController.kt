package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Chooses and tracks the communication route for one Talk session.
 *
 * Route selection is a request, never an outcome: the platform decides what it
 * actually selects, so every decision here is taken from the device the
 * platform reports back rather than the one that was asked for. Route changes
 * are generation-safe — a callback that fires after the session moved on is
 * dropped instead of overwriting a newer route.
 */
internal class RealtimeRouteController(
  context: Context,
  private val sessionPolicy: RealtimeAudioSessionPolicy,
  private val onRouteChanged: (RealtimeRouteProfile) -> Unit,
) : AutoCloseable {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val handler = Handler(Looper.getMainLooper())
  private val generation = AtomicLong(0)

  @Volatile private var sessionOwner: Long = 0

  @Volatile private var currentProfile: RealtimeRouteProfile = RealtimeRouteProfile.Unknown

  @Volatile private var registered = false

  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh(generation.get())

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh(generation.get())
    }

  // The device list changing is not the same event as the route changing.
  // Android can move the selected communication device on its own — a call
  // starting, another app taking the route — without any device appearing or
  // disappearing, and a stale route profile is what would keep the microphone
  // open into a loudspeaker.
  private val communicationDeviceListener =
    AudioManager.OnCommunicationDeviceChangedListener { device ->
      // The generation is read here, on the thread the platform reported on,
      // and carried into the posted work. Reading it inside the posted body
      // would stamp an event from the previous session with the new session's
      // generation and let it through.
      val observed = generation.get()
      handler.post {
        // Only a route change: the device set did not change, so nothing about
        // the microphone preference can have moved with it.
        publish(observed, device)
      }
    }

  val route: RealtimeRouteProfile
    get() = currentProfile

  /** Selects the best available communication route and starts tracking changes. */
  fun start(sessionOwner: Long): RealtimeRouteProfile {
    this.sessionOwner = sessionOwner
    val owned = generation.incrementAndGet()
    if (!registered) {
      audioManager.registerAudioDeviceCallback(deviceCallback, handler)
      // Direct executor: the listener body only reads the generation and posts.
      audioManager.addOnCommunicationDeviceChangedListener({ it.run() }, communicationDeviceListener)
      registered = true
    }
    refresh(owned)
    return currentProfile
  }

  override fun close() {
    generation.incrementAndGet()
    sessionOwner = 0
    if (registered) {
      runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
      runCatching { audioManager.removeOnCommunicationDeviceChangedListener(communicationDeviceListener) }
      registered = false
    }
    currentProfile = RealtimeRouteProfile.Unknown
  }

  private fun refresh(owner: Long) {
    // A device callback queued before `close()` can run after it and read the
    // generation the close installed, which would pass the check below. The
    // registration flag is the fact that cannot be re-read into agreement: a
    // closed controller has none, and must not publish a route over whatever
    // session came next.
    if (!registered) return
    if (owner != generation.get()) return
    val preferred = preferredCommunicationDevice(audioManager.availableCommunicationDevices)
    if (publish(owner, sessionPolicy.selectCommunicationDevice(sessionOwner, preferred))) return
    // The device list changed without moving the output route — a USB
    // microphone unplugged while the reply plays on the loudspeaker. The
    // operator's microphone preference resolves to a per-boot device id, so the
    // route is reported again to make the owner re-resolve it. The owner
    // reopens the streams only if something it applied actually changed.
    if (owner != generation.get()) return
    onRouteChanged(currentProfile)
  }

  /**
   * Publishes the route the platform actually selected, never the one
   * requested. Returns true when it reported a change.
   */
  private fun publish(
    owner: Long,
    selected: AudioDeviceInfo?,
  ): Boolean {
    // A stale callback that lost the race must not publish its route over a
    // newer one.
    if (owner != generation.get()) return false
    val resolved = selected?.let { realtimeRouteProfileForOutput(it.type) } ?: RealtimeRouteProfile.Unknown
    if (resolved == currentProfile) return false
    Log.d(tag, "route ${currentProfile.name} -> ${resolved.name}")
    currentProfile = resolved
    onRouteChanged(resolved)
    return true
  }

  companion object {
    private const val tag = "RealtimeMedia"

    /**
     * A hands-free assistant belongs on the loudspeaker when no headset is
     * present. Leaving the choice to the platform lands a communication session
     * on the earpiece, which is the wrong product for a device sitting on a
     * desk.
     */
    internal fun preferredCommunicationDevice(available: List<AudioDeviceInfo>): AudioDeviceInfo? {
      val ranked =
        available.mapNotNull { device ->
          val rank =
            when (device.type) {
              AudioDeviceInfo.TYPE_BLE_HEADSET -> 0
              AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 1
              AudioDeviceInfo.TYPE_HEARING_AID -> 2
              AudioDeviceInfo.TYPE_USB_HEADSET -> 3
              AudioDeviceInfo.TYPE_WIRED_HEADSET -> 4
              AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> 5
              AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 6
              AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> 7
              else -> null
            }
          rank?.let { it to device }
        }
      return ranked.minWithOrNull(compareBy({ it.first }, { it.second.id }))?.second
    }
  }
}
