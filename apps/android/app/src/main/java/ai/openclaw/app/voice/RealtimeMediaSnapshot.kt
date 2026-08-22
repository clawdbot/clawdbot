package ai.openclaw.app.voice

/**
 * One sanitized read of the media engine's state.
 *
 * Every counter names the coordinate domain it lives in, because comparing an
 * epoch-local frame position with a session total is exactly the class of
 * mistake that produced a confident and wrong conclusion during the prototype
 * work this engine replaces. Nothing here carries PCM, transcript text or a
 * credential.
 */
internal data class RealtimeMediaSnapshot(
  val readiness: RealtimeMediaReadiness,
  val route: RealtimeRouteProfile,
  val echoControlOwner: RealtimeEchoControlOwner,
  /** True while the device has assistant audio it has not finished presenting. */
  val renderPresenting: Boolean,
  val captureEligibleNow: Boolean,
  val rates: RealtimeMediaRates,
  /** Epoch-local: one device stream's frame-position origin. */
  val deviceClockEpoch: Long,
  val renderContentGeneration: Long,
  val captureEligibilityGeneration: Long,
  val acousticProcessorLifetime: Long,
  /** Round trip measured from the negotiated stream latencies, or -1 before the streams open. */
  val measuredStreamDelayMs: Int,
  val render: RealtimeRenderStats,
  val capture: RealtimeCaptureStats,
  val acoustic: RealtimeAcousticStats,
  val referenceRingDroppedSamples: Long,
  val telemetryDroppedEvents: Long,
  val device: RealtimeDeviceStreamStats,
  /** Smoothed assistant-playback envelope, 0..1, or null when nothing is playing. */
  val renderLevel: Float?,
  /** Smoothed microphone envelope, 0..1. */
  val captureLevel: Float,
) {
  companion object {
    /** Number of longs the native snapshot writes. Mirrored by `kSnapshotLongs` in the JNI bridge. */
    const val NATIVE_FIELD_COUNT: Int = 55

    fun fromNative(values: LongArray): RealtimeMediaSnapshot {
      require(values.size >= NATIVE_FIELD_COUNT) { "snapshot buffer too small" }
      var index = 0

      fun next(): Long = values[index++]
      val readiness = RealtimeMediaReadiness.entries[next().toInt()]
      val route = RealtimeRouteProfile.entries[next().toInt()]
      val owner = RealtimeEchoControlOwner.entries[next().toInt()]
      val renderPresenting = next() != 0L
      val captureEligibleNow = next() != 0L
      val rates =
        RealtimeMediaRates(
          wireInputHz = next().toInt(),
          wireOutputHz = next().toInt(),
          deviceInputHz = next().toInt(),
          deviceOutputHz = next().toInt(),
          apmCaptureHz = next().toInt(),
          apmRenderHz = next().toInt(),
        )
      val deviceClockEpoch = next()
      val renderContentGeneration = next()
      val captureEligibilityGeneration = next()
      val acousticProcessorLifetime = next()
      val measuredStreamDelayMs = next().toInt()
      val render =
        RealtimeRenderStats(
          submittedSamples = next(),
          presentedSamples = next(),
          cancelledSamples = next(),
          overflowRejectedSamples = next(),
          starvedSilenceSamples = next(),
          idleSilenceSamples = next(),
          markCompletions = next(),
          markInvalidations = next(),
          markEventOverflows = next(),
        )
      val capture =
        RealtimeCaptureStats(
          capturedFrames = next(),
          processedFrames = next(),
          eligibleFrames = next(),
          droppedIneligibleAtCapture = next(),
          droppedEligibilityChanged = next(),
          droppedSendGateClosed = next(),
          droppedQueueOverflow = next(),
          sentFrames = next(),
        )
      // Each optional metric is a presence flag followed by its value, and both
      // are always read: skipping the value when the flag is false would shift
      // every field after it.
      val acousticActive = next() != 0L
      val renderFramesProcessed = next()
      val captureFramesProcessed = next()
      val referenceUnderrunFrames = next()
      val acousticResets = next()
      val acousticFaults = next()
      val hasEchoReturnLoss = next() != 0L
      val echoReturnLossMilliDb = next()
      val hasEchoReturnLossEnhancement = next() != 0L
      val echoReturnLossEnhancementMilliDb = next()
      val hasDelayMs = next() != 0L
      val delayMs = next().toInt()
      val acoustic =
        RealtimeAcousticStats(
          active = acousticActive,
          renderFramesProcessed = renderFramesProcessed,
          captureFramesProcessed = captureFramesProcessed,
          referenceUnderrunFrames = referenceUnderrunFrames,
          resets = acousticResets,
          faults = acousticFaults,
          echoReturnLossDb = optionalMilliDb(hasEchoReturnLoss, echoReturnLossMilliDb),
          echoReturnLossEnhancementDb =
            optionalMilliDb(hasEchoReturnLossEnhancement, echoReturnLossEnhancementMilliDb),
          delayMs = if (hasDelayMs) delayMs else null,
        )
      val referenceRingDroppedSamples = next()
      val telemetryDroppedEvents = next()
      val deviceStats =
        RealtimeDeviceStreamStats(
          inputBurstFrames = next().toInt(),
          outputBurstFrames = next().toInt(),
          inputPreset = next().toInt(),
          performanceMode = next().toInt(),
          running = next() != 0L,
          inputDeviceId = 0,
        )
      val renderLevelMilli = next()
      val captureLevelMilli = next()
      // The applied input device is read last so adding it did not move any
      // field that was already decoded above.
      val inputDeviceId = next().toInt()
      return RealtimeMediaSnapshot(
        readiness = readiness,
        route = route,
        echoControlOwner = owner,
        renderPresenting = renderPresenting,
        captureEligibleNow = captureEligibleNow,
        rates = rates,
        deviceClockEpoch = deviceClockEpoch,
        renderContentGeneration = renderContentGeneration,
        captureEligibilityGeneration = captureEligibilityGeneration,
        acousticProcessorLifetime = acousticProcessorLifetime,
        measuredStreamDelayMs = measuredStreamDelayMs,
        render = render,
        capture = capture,
        acoustic = acoustic,
        referenceRingDroppedSamples = referenceRingDroppedSamples,
        telemetryDroppedEvents = telemetryDroppedEvents,
        device = deviceStats.copy(inputDeviceId = inputDeviceId),
        renderLevel = renderLevelMilli.takeIf { it > 0 }?.let { it / 1000f },
        captureLevel = captureLevelMilli / 1000f,
      )
    }

    /** An absent metric stays absent: the processor not having measured a value is not the same fact as measuring zero. */
    private fun optionalMilliDb(
      present: Boolean,
      milliDb: Long,
    ): Double? = if (present) milliDb / 1000.0 else null
  }
}

/**
 * Four independent rates. A negotiated device rate that differs from the
 * requested one is a fact to convert against, not an error: a Xiaomi 11T Pro
 * opened a 24 kHz recorder that ran and produced only zero samples.
 */
internal data class RealtimeMediaRates(
  val wireInputHz: Int,
  val wireOutputHz: Int,
  val deviceInputHz: Int,
  val deviceOutputHz: Int,
  val apmCaptureHz: Int,
  val apmRenderHz: Int,
)

internal data class RealtimeRenderStats(
  val submittedSamples: Long,
  /** Epoch-local presentation position reported by the device clock. */
  val presentedSamples: Long,
  val cancelledSamples: Long,
  val overflowRejectedSamples: Long,
  /** Silence synthesised while content was still queued. */
  val starvedSilenceSamples: Long,
  /** Silence after a response finished playing. Not a fault. */
  val idleSilenceSamples: Long,
  val markCompletions: Long,
  val markInvalidations: Long,
  val markEventOverflows: Long,
)

internal data class RealtimeCaptureStats(
  val capturedFrames: Long,
  val processedFrames: Long,
  val eligibleFrames: Long,
  val droppedIneligibleAtCapture: Long,
  val droppedEligibilityChanged: Long,
  val droppedSendGateClosed: Long,
  val droppedQueueOverflow: Long,
  val sentFrames: Long,
)

internal data class RealtimeAcousticStats(
  val active: Boolean,
  /** Processor-lifetime domain: cleared with the adaptive state it describes. */
  val renderFramesProcessed: Long,
  val captureFramesProcessed: Long,
  val referenceUnderrunFrames: Long,
  val resets: Long,
  val faults: Long,
  val echoReturnLossDb: Double?,
  val echoReturnLossEnhancementDb: Double?,
  val delayMs: Int?,
)

internal data class RealtimeDeviceStreamStats(
  val inputBurstFrames: Int,
  val outputBurstFrames: Int,
  val inputPreset: Int,
  val performanceMode: Int,
  val running: Boolean,
  /** The microphone the platform actually routed to, which need not be the one requested. */
  val inputDeviceId: Int,
)
