package ai.openclaw.app.voice

/**
 * How the current acoustic route behaves.
 *
 * The line that matters is which output the assistant's voice leaves from,
 * because that decides whether the microphone hears it. The shipped iOS client
 * draws the same line: it closes the microphone during output only when the
 * route contains the built-in speaker, and keeps barge-in everywhere else.
 *
 * Ordinals are the wire format for the native engine; do not reorder.
 */
internal enum class RealtimeRouteProfile {
  /** Not resolved yet. Treated as acoustically coupled, because guessing the permissive answer here is what puts the assistant's own voice on the uplink. */
  Unknown,

  /** Headset, wired or Bluetooth. The device's voice pipeline owns echo control. */
  DeviceOwnedVoiceProcessing,

  /** Handset receiver, held at the ear. */
  BuiltInEarpiece,

  /** Loudspeaker. Software echo control owns this route. */
  BuiltInSpeaker,
}

/** How far the media pipeline has got in bringing full duplex up. Ordinals mirror the native enum. */
internal enum class RealtimeMediaReadiness {
  Stopped,
  Starting,
  DeviceSyncing,
  AecPriming,
  FullDuplexReady,
}

/** Which layer is responsible for keeping the assistant's voice off the uplink. Ordinals mirror the native enum. */
internal enum class RealtimeEchoControlOwner {
  None,
  PlatformVoiceCommunication,
  SoftwareAcousticProcessor,
}

/** Microphone preset requested from the platform. Ordinals mirror the native enum. */
internal enum class RealtimeInputPreset {
  VoiceCommunication,
  VoiceRecognition,
  Unprocessed,
}

/** Outcome of one playback barrier. Ordinals mirror the native enum. */
internal enum class RealtimeMarkOutcome {
  Completed,
  Cancelled,
  InvalidatedByEpoch,
  InvalidatedByStop,
  RejectedByOverflow,
}

internal data class RealtimeMarkEvent(
  val markId: Long,
  val outcome: RealtimeMarkOutcome,
)

/**
 * Kinds mirror the native `MediaEventKind`. The engine records a transition at
 * the boundary that owns it, so "when did readiness change" is answerable
 * without correlating two periodic counter samples.
 */
internal enum class RealtimeMediaEventKind {
  EngineStarted,
  EngineStopped,
  DeviceEpochBegan,
  DeviceEpochEnded,
  ReadinessChanged,
  RouteChanged,
  AcousticProcessorStarted,
  AcousticProcessorReset,
  AcousticProcessorFault,
  RenderGenerationBegan,
  RenderCleared,
  CaptureEligibilityChanged,
  ReferenceTimelineUnderrun,
  RenderQueueOverflow,
  UplinkQueueOverflow,
  StreamError,
  FallbackEngaged,
  PipelineQuiesceTimeout,
}

internal data class RealtimeMediaEvent(
  val kind: RealtimeMediaEventKind,
  val sequence: Long,
  val monotonicNanos: Long,
  val detailA: Long,
  val detailB: Long,
)

internal data class RealtimeMediaConfig(
  val wireInputHz: Int,
  val wireOutputHz: Int,
  val requestedDeviceHz: Int,
  val route: RealtimeRouteProfile,
  val inputPreset: RealtimeInputPreset,
  /** `AudioDeviceInfo.id` of the operator's chosen microphone, or [UNSPECIFIED_DEVICE_ID]. */
  val preferredInputDeviceId: Int = UNSPECIFIED_DEVICE_ID,
  val renderCapacityMs: Int = 30_000,
  val uplinkCapacityMs: Int = 1_500,
) {
  companion object {
    /** Oboe's "let the platform choose" device id. */
    const val UNSPECIFIED_DEVICE_ID: Int = 0
  }
}

/**
 * The realtime media data plane.
 *
 * TalkMode owns the conversation; this owns the audio. Nothing behind this
 * interface knows a provider event name, a Gateway frame or a transcript — it
 * moves PCM, decides when captured audio may leave the endpoint, and reports
 * what it did.
 */
internal interface RealtimeMediaEngine {
  /** True when this engine can carry a two-way conversation on the current route. */
  val supportsConcurrentCapture: Boolean

  fun start(config: RealtimeMediaConfig): Boolean

  fun stop()

  fun release()

  /**
   * A route change invalidates the echo path, the decision made about the
   * uplink under it, and the microphone preset that was chosen for the old
   * route. Returns false when the engine could not carry the change, which the
   * caller must treat as a media failure rather than a cosmetic one.
   *
   * `preferredInputDeviceId` is re-resolved by the caller on every change,
   * because `AudioDeviceInfo.id` is assigned per boot: a microphone that was
   * unplugged and plugged back in is the same operator preference under a
   * different id, and reapplying the one the session opened with would hold the
   * stream on a device that no longer exists.
   */
  fun setRoute(
    route: RealtimeRouteProfile,
    inputPreset: RealtimeInputPreset,
    preferredInputDeviceId: Int,
  ): Boolean

  /**
   * True when [setRoute] actually applies `preferredInputDeviceId`.
   *
   * The fallback answers false: it re-resolves the operator's microphone from
   * the stored preference when it opens the recorder, and does not reopen it
   * mid-session. The caller must not record a device id as applied on an engine
   * that says false, or it would suppress the next attempt on the strength of a
   * change that never happened. What that path did open is reported from the
   * capture session itself, so the operator still sees the microphone in use.
   */
  val appliesInputDeviceSelection: Boolean

  /** Opens a new assistant response. Its audio and barriers must carry the returned generation. */
  fun beginRenderGeneration(): Long

  /** Wire-format assistant PCM. Returns false when the bounded queue refused it. */
  fun submitAssistantAudio(
    generation: Long,
    pcm: ByteArray,
  ): Boolean

  /** Discards everything the device has not reached, and opens the next generation. */
  fun clearRender()

  /** Queues a barrier behind the audio submitted so far. */
  fun submitMark(markId: Long): Boolean

  /**
   * Fills [into] with the next run of contiguous uplink audio that passed both
   * the capture-time and send-time gates, and returns the byte count. Stops at
   * a gap so one payload never presents a discontinuity as continuous speech.
   */
  fun drainUplink(into: ByteArray): Int

  fun drainMarkEvents(): List<RealtimeMarkEvent>

  fun drainTelemetry(): List<RealtimeMediaEvent>

  fun snapshot(): RealtimeMediaSnapshot
}
