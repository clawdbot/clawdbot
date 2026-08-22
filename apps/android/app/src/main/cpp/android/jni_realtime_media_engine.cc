// JNI surface for the Android realtime media engine.
//
// Two rules shape this file. Nothing here runs per 10 ms frame: audio crosses
// the boundary in bulk, and every drain fills a caller-owned array so no call
// allocates. And no JNIEnv is ever retained — the device error path records a
// telemetry event that the control loop already polls, instead of calling back
// into Java from an Oboe thread whose attachment we would then have to own.

#include <jni.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <mutex>
#include <vector>

#include <android/log.h>
#include <time.h>

#include "android/oboe_device_io.h"
#include "media/realtime_media_core.h"

namespace {

using openclaw::media::DeviceStreamConfig;
using openclaw::media::DeviceStreamState;
using openclaw::media::InputPresetChoice;
using openclaw::media::MarkEvent;
using openclaw::media::MediaEvent;
using openclaw::media::MediaSnapshot;
using openclaw::media::OboeDeviceIo;
using openclaw::media::RealtimeMediaCore;
using openclaw::media::RenderContentGeneration;
using openclaw::media::RouteEchoProfile;

int64_t monotonicNanos() {
  timespec now{};
  clock_gettime(CLOCK_MONOTONIC, &now);
  return static_cast<int64_t>(now.tv_sec) * 1000000000LL + now.tv_nsec;
}

// Owns the engine and its device streams for one Talk session.
class EngineHandle {
 public:
  EngineHandle() : device_(core_, [](int, bool) {}) {
    core_.setClockSource(&monotonicNanos);
    carry_.reserve(4096);
    scratch_.reserve(65536);
  }

  RealtimeMediaCore& core() { return core_; }
  OboeDeviceIo& device() { return device_; }

  // Drain scratch, reused across polls. The control loop drains at 100 Hz for
  // the whole conversation and usually finds nothing; allocating per poll is
  // native heap churn the steady state is meant to be free of. Only ever
  // touched from the control thread, which is the only caller of the drains.
  std::vector<MarkEvent>& markScratch(size_t capacity) {
    if (markScratch_.size() < capacity) markScratch_.resize(capacity);
    return markScratch_;
  }

  std::vector<MediaEvent>& telemetryScratch(size_t capacity) {
    if (telemetryScratch_.size() < capacity) telemetryScratch_.resize(capacity);
    return telemetryScratch_;
  }

  std::vector<jlong>& longScratch(size_t capacity) {
    if (longScratch_.size() < capacity) longScratch_.resize(capacity);
    return longScratch_;
  }

  // Collects the next run of contiguous uplink audio, bounded by `capacity`.
  //
  // A frame that does not fit, or that follows a gap, is held rather than
  // dropped: it has already left the engine's queue, so discarding it here
  // would delete captured speech at the boundary between two payloads.
  const std::vector<int8_t>& collectUplink(size_t capacity) {
    scratch_.clear();
    const uint64_t generation = core_.currentEligibilityGeneration().value();
    // The device clock epoch is part of the frame's identity too: a stream
    // restart gives the capture timeline a new origin without necessarily
    // moving the eligibility decision, and a frame held across it belongs to
    // the stream that no longer exists.
    const uint64_t epoch = core_.currentDeviceEpoch().value();
    if (!carry_.empty()) {
      // A held frame passed the send gate under the decision in force when it
      // was captured. If that decision has moved on — a route change, a stream
      // restart — it is dropped for the same reason a queued frame would be,
      // rather than prepended to a payload the new decision would refuse.
      if (carryGeneration_ != generation || carryEpoch_ != epoch) {
        // The engine already counted this frame as sent, so the next one would
        // be reported as following it with no gap. Dropping it here without
        // saying so would present a hole in the user's speech as continuous.
        carry_.clear();
        core_.breakUplinkContinuity();
      } else if (carry_.size() > capacity) {
        return scratch_;
      } else {
        scratch_.insert(scratch_.end(), carry_.begin(), carry_.end());
        carry_.clear();
      }
    }
    RealtimeMediaCore::UplinkFrame frame;
    while (core_.nextUplinkFrame(&frame)) {
      const auto* bytes = reinterpret_cast<const int8_t*>(frame.samples);
      const size_t frameBytes = frame.sampleCount * sizeof(int16_t);
      const bool gap = !scratch_.empty() && !frame.contiguousWithPrevious;
      if (gap || scratch_.size() + frameBytes > capacity) {
        carry_.assign(bytes, bytes + frameBytes);
        carryGeneration_ = generation;
        carryEpoch_ = epoch;
        break;
      }
      scratch_.insert(scratch_.end(), bytes, bytes + frameBytes);
    }
    return scratch_;
  }

 private:
  RealtimeMediaCore core_;
  OboeDeviceIo device_;
  std::vector<int8_t> carry_;
  uint64_t carryGeneration_ = 0;
  uint64_t carryEpoch_ = 0;
  std::vector<int8_t> scratch_;
  std::vector<MarkEvent> markScratch_;
  std::vector<MediaEvent> telemetryScratch_;
  std::vector<jlong> longScratch_;
};

EngineHandle* handleOf(jlong pointer) { return reinterpret_cast<EngineHandle*>(pointer); }

constexpr size_t kSnapshotLongs = 55;
constexpr size_t kTelemetryTupleLongs = 5;
constexpr size_t kMarkTupleLongs = 2;

int64_t milliDb(bool present, double value) {
  return present ? static_cast<int64_t>(value * 1000.0) : 0;
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeCreate(JNIEnv*, jclass) {
  return reinterpret_cast<jlong>(new EngineHandle());
}

JNIEXPORT void JNICALL
Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeRelease(JNIEnv*, jclass, jlong pointer) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return;
  if (!handle->device().callbacksQuiesced() || !handle->core().pipelineQuiesced()) {
    // A device callback never came back out of the pipeline, so this memory is
    // still reachable from a realtime thread. One leaked engine per wedged
    // session is a bounded cost; freeing it is a use-after-free on the audio
    // thread. The engine is stopped either way, so it holds no device streams.
    __android_log_print(ANDROID_LOG_WARN, "RealtimeMedia",
                        "engine retained: a device callback did not leave the pipeline");
    return;
  }
  delete handle;
}

JNIEXPORT jboolean JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeStart(
    JNIEnv*, jclass, jlong pointer, jint wireInputHz, jint wireOutputHz, jint requestedDeviceHz,
    jint routeProfile, jint inputPreset, jint preferredInputDeviceId, jint renderCapacityMs,
    jint uplinkCapacityMs) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return JNI_FALSE;
  openclaw::media::EngineConfig config;
  config.rates.wireInputHz = wireInputHz;
  config.rates.wireOutputHz = wireOutputHz;
  config.rates.requestedDeviceInputHz = requestedDeviceHz;
  config.rates.requestedDeviceOutputHz = requestedDeviceHz;
  config.renderCapacityMs = renderCapacityMs;
  config.uplinkCapacityMs = uplinkCapacityMs;
  if (!handle->core().start(config, static_cast<RouteEchoProfile>(routeProfile))) return JNI_FALSE;
  DeviceStreamConfig deviceConfig;
  deviceConfig.inputPreset = static_cast<InputPresetChoice>(inputPreset);
  deviceConfig.preferredInputDeviceId = preferredInputDeviceId;
  if (!handle->device().start(deviceConfig)) {
    handle->core().stop();
    return JNI_FALSE;
  }
  return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeStop(JNIEnv*, jclass, jlong pointer) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return;
  handle->device().stop();
  handle->core().stop();
}

JNIEXPORT jboolean JNICALL
Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeRestartStreams(JNIEnv*, jclass,
                                                                         jlong pointer,
                                                                         jint inputPreset,
                                                                         jint preferredInputDeviceId) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return JNI_FALSE;
  handle->device().stop();
  DeviceStreamConfig deviceConfig;
  deviceConfig.inputPreset = static_cast<InputPresetChoice>(inputPreset);
  deviceConfig.preferredInputDeviceId = preferredInputDeviceId;
  return handle->device().start(deviceConfig) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeSetRoute(
    JNIEnv*, jclass, jlong pointer, jint routeProfile) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return JNI_FALSE;
  return handle->core().setRoute(static_cast<RouteEchoProfile>(routeProfile)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jlong JNICALL
Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeBeginRenderGeneration(JNIEnv*, jclass,
                                                                                 jlong pointer) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return 0;
  return static_cast<jlong>(handle->core().beginRenderGeneration().value());
}

JNIEXPORT jboolean JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeSubmitAudio(
    JNIEnv* env, jclass, jlong pointer, jlong generation, jbyteArray pcm, jint byteCount) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr || pcm == nullptr || byteCount <= 0) return JNI_FALSE;
  jboolean copied = JNI_FALSE;
  jbyte* raw = env->GetByteArrayElements(pcm, &copied);
  if (raw == nullptr) return JNI_FALSE;
  const bool accepted = handle->core().submitWireAudio(
      RenderContentGeneration(static_cast<uint64_t>(generation)),
      reinterpret_cast<const int16_t*>(raw), static_cast<size_t>(byteCount) / sizeof(int16_t));
  env->ReleaseByteArrayElements(pcm, raw, JNI_ABORT);
  return accepted ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeClearRender(
    JNIEnv*, jclass, jlong pointer) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return;
  handle->core().clearRender();
}

JNIEXPORT jboolean JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeSubmitMark(
    JNIEnv*, jclass, jlong pointer, jlong markId) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr) return JNI_FALSE;
  return handle->core().submitMark(static_cast<uint64_t>(markId)) ? JNI_TRUE : JNI_FALSE;
}

// Fills `out` with as many consecutive uplink frames as fit, stopping at the
// first gap so a batched payload never presents a discontinuity as continuous
// speech. Returns the byte count written.
JNIEXPORT jint JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeDrainUplink(
    JNIEnv* env, jclass, jlong pointer, jbyteArray out) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr || out == nullptr) return 0;
  handle->core().pumpControl();
  const jsize capacity = env->GetArrayLength(out);
  const std::vector<int8_t>& collected =
      handle->collectUplink(static_cast<size_t>(std::max<jsize>(0, capacity)));
  if (collected.empty()) return 0;
  // Collected outside any JNI critical region: `nextUplinkFrame` takes the
  // engine's control lock, and holding a pinned array across a lock is how a
  // drain ends up blocking the collector.
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(collected.size()),
                          reinterpret_cast<const jbyte*>(collected.data()));
  return static_cast<jint>(collected.size());
}

JNIEXPORT jint JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeDrainMarkEvents(
    JNIEnv* env, jclass, jlong pointer, jlongArray out) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr || out == nullptr) return 0;
  const size_t capacity = static_cast<size_t>(env->GetArrayLength(out)) / kMarkTupleLongs;
  if (capacity == 0) return 0;
  // Reused across polls. The control loop drains at 100 Hz for the whole
  // conversation, and allocating two vectors per poll to usually find nothing
  // is native heap churn the steady state is supposed to be free of.
  std::vector<MarkEvent>& events = handle->markScratch(capacity);
  const size_t drained = handle->core().drainMarkEvents(events.data(), capacity);
  if (drained == 0) return 0;
  std::vector<jlong>& flat = handle->longScratch(drained * kMarkTupleLongs);
  for (size_t i = 0; i < drained; ++i) {
    flat[i * kMarkTupleLongs] = static_cast<jlong>(events[i].markId);
    flat[i * kMarkTupleLongs + 1] = static_cast<jlong>(events[i].outcome);
  }
  env->SetLongArrayRegion(out, 0, static_cast<jsize>(drained * kMarkTupleLongs), flat.data());
  return static_cast<jint>(drained);
}

JNIEXPORT jint JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeDrainTelemetry(
    JNIEnv* env, jclass, jlong pointer, jlongArray out) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr || out == nullptr) return 0;
  const size_t capacity = static_cast<size_t>(env->GetArrayLength(out)) / kTelemetryTupleLongs;
  if (capacity == 0) return 0;
  std::vector<MediaEvent>& events = handle->telemetryScratch(capacity);
  const size_t drained = handle->core().drainTelemetry(events.data(), capacity);
  if (drained == 0) return 0;
  std::vector<jlong>& flat = handle->longScratch(drained * kTelemetryTupleLongs);
  for (size_t i = 0; i < drained; ++i) {
    flat[i * kTelemetryTupleLongs] = static_cast<jlong>(events[i].kind);
    flat[i * kTelemetryTupleLongs + 1] = static_cast<jlong>(events[i].sequence);
    flat[i * kTelemetryTupleLongs + 2] = events[i].monotonicNanos;
    flat[i * kTelemetryTupleLongs + 3] = events[i].detailA;
    flat[i * kTelemetryTupleLongs + 4] = events[i].detailB;
  }
  env->SetLongArrayRegion(out, 0, static_cast<jsize>(drained * kTelemetryTupleLongs), flat.data());
  return static_cast<jint>(drained);
}

// Layout is mirrored by `RealtimeMediaSnapshot.kt`; both sides name the same
// index constants so a field added on one side without the other fails to
// build rather than shifting every value silently.
JNIEXPORT jboolean JNICALL Java_ai_openclaw_app_voice_NativeRealtimeMediaEngine_nativeSnapshot(
    JNIEnv* env, jclass, jlong pointer, jlongArray out) {
  EngineHandle* handle = handleOf(pointer);
  if (handle == nullptr || out == nullptr) return JNI_FALSE;
  if (static_cast<size_t>(env->GetArrayLength(out)) < kSnapshotLongs) return JNI_FALSE;
  const MediaSnapshot snapshot = handle->core().snapshot();
  const DeviceStreamState device = handle->device().state();
  jlong values[kSnapshotLongs] = {};
  size_t index = 0;
  values[index++] = static_cast<jlong>(snapshot.readiness);
  values[index++] = static_cast<jlong>(snapshot.route);
  values[index++] = static_cast<jlong>(snapshot.echoControlOwner);
  values[index++] = snapshot.renderPresenting ? 1 : 0;
  values[index++] = snapshot.captureEligibleNow ? 1 : 0;
  values[index++] = snapshot.rates.wireInputHz;
  values[index++] = snapshot.rates.wireOutputHz;
  values[index++] = snapshot.rates.deviceInputHz;
  values[index++] = snapshot.rates.deviceOutputHz;
  values[index++] = snapshot.rates.apmCaptureHz;
  values[index++] = snapshot.rates.apmRenderHz;
  values[index++] = static_cast<jlong>(snapshot.deviceClockEpoch);
  values[index++] = static_cast<jlong>(snapshot.renderContentGeneration);
  values[index++] = static_cast<jlong>(snapshot.captureEligibilityGeneration);
  values[index++] = static_cast<jlong>(snapshot.acousticProcessorLifetime);
  values[index++] = snapshot.measuredStreamDelayMs;
  values[index++] = static_cast<jlong>(snapshot.render.submittedSamples);
  values[index++] = static_cast<jlong>(snapshot.render.presentedSamples);
  values[index++] = static_cast<jlong>(snapshot.render.cancelledSamples);
  values[index++] = static_cast<jlong>(snapshot.render.overflowRejectedSamples);
  values[index++] = static_cast<jlong>(snapshot.render.starvedSilenceSamples);
  values[index++] = static_cast<jlong>(snapshot.render.idleSilenceSamples);
  values[index++] = static_cast<jlong>(snapshot.render.markCompletions);
  values[index++] = static_cast<jlong>(snapshot.render.markInvalidations);
  values[index++] = static_cast<jlong>(snapshot.render.markEventOverflows);
  values[index++] = static_cast<jlong>(snapshot.capture.capturedFrames);
  values[index++] = static_cast<jlong>(snapshot.capture.processedFrames);
  values[index++] = static_cast<jlong>(snapshot.capture.eligibleFrames);
  values[index++] = static_cast<jlong>(snapshot.capture.droppedIneligibleAtCapture);
  values[index++] = static_cast<jlong>(snapshot.capture.droppedEligibilityChanged);
  values[index++] = static_cast<jlong>(snapshot.capture.droppedSendGateClosed);
  values[index++] = static_cast<jlong>(snapshot.capture.droppedQueueOverflow);
  values[index++] = static_cast<jlong>(snapshot.capture.sentFrames);
  values[index++] = snapshot.acoustic.active ? 1 : 0;
  values[index++] = static_cast<jlong>(snapshot.acoustic.renderFramesProcessed);
  values[index++] = static_cast<jlong>(snapshot.acoustic.captureFramesProcessed);
  values[index++] = static_cast<jlong>(snapshot.acoustic.referenceUnderrunFrames);
  values[index++] = static_cast<jlong>(snapshot.acoustic.resets);
  values[index++] = static_cast<jlong>(snapshot.acoustic.faults);
  values[index++] = snapshot.acoustic.hasEchoReturnLoss ? 1 : 0;
  values[index++] = milliDb(snapshot.acoustic.hasEchoReturnLoss, snapshot.acoustic.echoReturnLossDb);
  values[index++] = snapshot.acoustic.hasEchoReturnLossEnhancement ? 1 : 0;
  values[index++] = milliDb(snapshot.acoustic.hasEchoReturnLossEnhancement,
                            snapshot.acoustic.echoReturnLossEnhancementDb);
  values[index++] = snapshot.acoustic.hasDelayMs ? 1 : 0;
  values[index++] = snapshot.acoustic.delayMs;
  values[index++] = static_cast<jlong>(snapshot.referenceRingDroppedSamples);
  values[index++] = static_cast<jlong>(snapshot.telemetryDroppedEvents);
  values[index++] = device.inputBurstFrames;
  values[index++] = device.outputBurstFrames;
  values[index++] = device.inputPreset;
  values[index++] = device.performanceMode;
  values[index++] = device.running ? 1 : 0;
  values[index++] = snapshot.renderLevelMilli;
  values[index++] = snapshot.captureLevelMilli;
  values[index++] = device.inputDeviceId;
  env->SetLongArrayRegion(out, 0, static_cast<jsize>(kSnapshotLongs), values);
  return JNI_TRUE;
}

}  // extern "C"
