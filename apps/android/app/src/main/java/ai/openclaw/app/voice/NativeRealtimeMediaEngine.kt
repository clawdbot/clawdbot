package ai.openclaw.app.voice

import android.util.Log

/**
 * JNI-backed realtime media engine.
 *
 * Nothing here runs per 10 ms frame. Assistant audio goes down in whole
 * provider chunks, captured audio comes back in whole runs, and the drains fill
 * arrays this object owns, so a steady conversation performs no allocation on
 * the Kotlin side either.
 *
 * The native library is loaded once and its absence is a normal outcome, not a
 * crash: a device that cannot load it falls back to [LegacyRealtimeMediaEngine]
 * and keeps the product working in half duplex.
 */
internal class NativeRealtimeMediaEngine private constructor(
  private var handle: Long,
) : RealtimeMediaEngine {
  // Every native call runs under this lock and re-reads the handle inside it.
  // Release is the last thing that can happen to a handle, so a control call
  // racing a teardown either runs before the free or sees a zeroed handle — it
  // can never dereference a pointer that release is in the middle of deleting.
  private val handleLock = Any()
  private val snapshotBuffer = LongArray(RealtimeMediaSnapshot.NATIVE_FIELD_COUNT)
  private val markBuffer = LongArray(MARK_DRAIN_CAPACITY * 2)
  private val telemetryBuffer = LongArray(TELEMETRY_DRAIN_CAPACITY * 5)
  private var inputPreset: RealtimeInputPreset = RealtimeInputPreset.VoiceRecognition
  private var preferredInputDeviceId: Int = RealtimeMediaConfig.UNSPECIFIED_DEVICE_ID

  override val supportsConcurrentCapture: Boolean = true

  override fun start(config: RealtimeMediaConfig): Boolean =
    synchronized(handleLock) {
      if (handle == 0L) return false
      inputPreset = config.inputPreset
      preferredInputDeviceId = config.preferredInputDeviceId
      nativeStart(
        handle,
        config.wireInputHz,
        config.wireOutputHz,
        config.requestedDeviceHz,
        config.route.ordinal,
        config.inputPreset.ordinal,
        config.preferredInputDeviceId,
        config.renderCapacityMs,
        config.uplinkCapacityMs,
      )
    }

  override fun stop() =
    synchronized(handleLock) {
      if (handle != 0L) nativeStop(handle)
    }

  override fun release() =
    synchronized(handleLock) {
      val current = handle
      if (current != 0L) {
        handle = 0L
        nativeStop(current)
        nativeRelease(current)
      }
    }

  override val appliesInputDeviceSelection: Boolean = true

  override fun setRoute(
    route: RealtimeRouteProfile,
    inputPreset: RealtimeInputPreset,
    preferredInputDeviceId: Int,
  ): Boolean =
    synchronized(handleLock) {
      if (handle == 0L) return false
      // The engine reports whether it actually took the route: a change it
      // could not carry leaves it on the previous one, and treating that as
      // success is how Talk ends up believing it has echo control it does not.
      if (!nativeSetRoute(handle, route.ordinal)) return false
      if (inputPreset == this.inputPreset && preferredInputDeviceId == this.preferredInputDeviceId) return true
      // Both are properties of the stream, not runtime flags. Leaving a
      // communication-preset microphone on a route the software canceller now
      // owns means two cancellers fighting over the same signal, and holding a
      // per-boot device id across a re-plug points the stream at a device that
      // is gone.
      this.inputPreset = inputPreset
      this.preferredInputDeviceId = preferredInputDeviceId
      nativeRestartStreams(handle, inputPreset.ordinal, preferredInputDeviceId)
    }

  /**
   * Reopens both device streams after an asynchronous stream error. The control
   * owner calls this; the realtime callbacks only report the fault.
   */
  fun restartStreams(): Boolean =
    synchronized(handleLock) {
      handle != 0L && nativeRestartStreams(handle, inputPreset.ordinal, preferredInputDeviceId)
    }

  override fun beginRenderGeneration(): Long =
    synchronized(handleLock) {
      if (handle == 0L) 0L else nativeBeginRenderGeneration(handle)
    }

  override fun submitAssistantAudio(
    generation: Long,
    pcm: ByteArray,
  ): Boolean =
    synchronized(handleLock) {
      handle != 0L && nativeSubmitAudio(handle, generation, pcm, pcm.size)
    }

  override fun clearRender() =
    synchronized(handleLock) {
      if (handle != 0L) nativeClearRender(handle)
    }

  override fun submitMark(markId: Long): Boolean =
    synchronized(handleLock) {
      handle != 0L && nativeSubmitMark(handle, markId)
    }

  override fun drainUplink(into: ByteArray): Int =
    synchronized(handleLock) {
      if (handle == 0L) 0 else nativeDrainUplink(handle, into)
    }

  override fun drainMarkEvents(): List<RealtimeMarkEvent> {
    val count = synchronized(handleLock) { if (handle == 0L) 0 else nativeDrainMarkEvents(handle, markBuffer) }
    if (count <= 0) return emptyList()
    return (0 until count).map { index ->
      RealtimeMarkEvent(
        markId = markBuffer[index * 2],
        outcome = RealtimeMarkOutcome.entries[markBuffer[index * 2 + 1].toInt()],
      )
    }
  }

  override fun drainTelemetry(): List<RealtimeMediaEvent> {
    val count = synchronized(handleLock) { if (handle == 0L) 0 else nativeDrainTelemetry(handle, telemetryBuffer) }
    if (count <= 0) return emptyList()
    return (0 until count).map { index ->
      val base = index * 5
      RealtimeMediaEvent(
        kind = RealtimeMediaEventKind.entries[telemetryBuffer[base].toInt()],
        sequence = telemetryBuffer[base + 1],
        monotonicNanos = telemetryBuffer[base + 2],
        detailA = telemetryBuffer[base + 3],
        detailB = telemetryBuffer[base + 4],
      )
    }
  }

  override fun snapshot(): RealtimeMediaSnapshot =
    synchronized(handleLock) {
      if (handle == 0L || !nativeSnapshot(handle, snapshotBuffer)) {
        stoppedSnapshot
      } else {
        RealtimeMediaSnapshot.fromNative(snapshotBuffer)
      }
    }

  companion object {
    private const val tag = "RealtimeMedia"
    private const val MARK_DRAIN_CAPACITY = 32
    private const val TELEMETRY_DRAIN_CAPACITY = 64

    /** Enough room for a provider-sized uplink payload without splitting a run per call. */
    const val UPLINK_DRAIN_BYTES: Int = 24_000 * 2 * 200 / 1000

    private val libraryLoaded: Boolean by lazy {
      try {
        System.loadLibrary("openclaw_media")
        true
      } catch (err: UnsatisfiedLinkError) {
        // A device without the native engine is not a broken device; it is a
        // device that talks in half duplex. The reason is recorded here so the
        // fallback is never a silent downgrade.
        Log.w(tag, "native media engine unavailable: ${err.message ?: err::class.simpleName}")
        false
      }
    }

    private val stoppedSnapshot =
      RealtimeMediaSnapshot(
        readiness = RealtimeMediaReadiness.Stopped,
        route = RealtimeRouteProfile.Unknown,
        echoControlOwner = RealtimeEchoControlOwner.None,
        renderPresenting = false,
        captureEligibleNow = false,
        rates = RealtimeMediaRates(0, 0, 0, 0, 0, 0),
        deviceClockEpoch = 0,
        renderContentGeneration = 0,
        captureEligibilityGeneration = 0,
        acousticProcessorLifetime = 0,
        measuredStreamDelayMs = -1,
        render = RealtimeRenderStats(0, 0, 0, 0, 0, 0, 0, 0, 0),
        capture = RealtimeCaptureStats(0, 0, 0, 0, 0, 0, 0, 0),
        acoustic = RealtimeAcousticStats(false, 0, 0, 0, 0, 0, null, null, null),
        referenceRingDroppedSamples = 0,
        telemetryDroppedEvents = 0,
        device = RealtimeDeviceStreamStats(0, 0, 0, 0, false, 0),
        renderLevel = null,
        captureLevel = 0f,
      )

    /** Returns null when the native engine cannot be used on this device. */
    fun createOrNull(): NativeRealtimeMediaEngine? {
      if (!libraryLoaded) return null
      val handle = nativeCreate()
      if (handle == 0L) return null
      return NativeRealtimeMediaEngine(handle)
    }

    @JvmStatic private external fun nativeCreate(): Long

    @JvmStatic private external fun nativeRelease(handle: Long)

    @JvmStatic private external fun nativeStart(
      handle: Long,
      wireInputHz: Int,
      wireOutputHz: Int,
      requestedDeviceHz: Int,
      routeProfile: Int,
      inputPreset: Int,
      preferredInputDeviceId: Int,
      renderCapacityMs: Int,
      uplinkCapacityMs: Int,
    ): Boolean

    @JvmStatic private external fun nativeStop(handle: Long)

    @JvmStatic private external fun nativeRestartStreams(
      handle: Long,
      inputPreset: Int,
      preferredInputDeviceId: Int,
    ): Boolean

    @JvmStatic private external fun nativeSetRoute(
      handle: Long,
      routeProfile: Int,
    ): Boolean

    @JvmStatic private external fun nativeBeginRenderGeneration(handle: Long): Long

    @JvmStatic private external fun nativeSubmitAudio(
      handle: Long,
      generation: Long,
      pcm: ByteArray,
      byteCount: Int,
    ): Boolean

    @JvmStatic private external fun nativeClearRender(handle: Long)

    @JvmStatic private external fun nativeSubmitMark(
      handle: Long,
      markId: Long,
    ): Boolean

    @JvmStatic private external fun nativeDrainUplink(
      handle: Long,
      out: ByteArray,
    ): Int

    @JvmStatic private external fun nativeDrainMarkEvents(
      handle: Long,
      out: LongArray,
    ): Int

    @JvmStatic private external fun nativeDrainTelemetry(
      handle: Long,
      out: LongArray,
    ): Int

    @JvmStatic private external fun nativeSnapshot(
      handle: Long,
      out: LongArray,
    ): Boolean
  }
}
