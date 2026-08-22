#include "media/realtime_media_core.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>

namespace openclaw::media {
namespace {

// 2 s: two orders of magnitude beyond any real callback. Reaching it means the
// device callback thread has stopped answering, which teardown reports rather
// than waits out forever.
constexpr int kPipelineQuiesceAttempts = 2000;

// Leaves the pipeline on every return path out of a device callback, including
// the early ones. A leaked count would make every later teardown refuse to
// touch state nothing is actually using.
struct PipelineScope {
  std::atomic<int>& counter;
  ~PipelineScope() { counter.fetch_sub(1, std::memory_order_seq_cst); }
};


// A run of missing reference frames means the far-end timeline the canceller is
// adapting against no longer lines up with what the speaker played. Past this
// many consecutive 10 ms frames the adaptive state is discarded rather than
// left to describe an echo path that no longer exists. One second is the
// shortest run that cannot be an ordinary callback jitter burst.
constexpr uint64_t kReferenceUnderrunResetFrames = 100;

// How long the control owner waits for the capture callback to leave the
// acoustic processor before giving up on a rebuild. One capture callback is a
// few milliseconds; anything past this is a device that has stopped calling
// back, and the rebuild is retried rather than forced.
constexpr int kProcessorQuiesceAttempts = 200;

// Cheap smoothed RMS in thousandths. The device callbacks already hold the
// buffer, so metering here costs one pass over samples the UI would otherwise
// never see.
int smoothedLevelMilli(int previousMilli, const int16_t* samples, size_t count) {
  if (count == 0) return previousMilli;
  double sum = 0;
  for (size_t i = 0; i < count; ++i) {
    const double value = samples[i];
    sum += value * value;
  }
  const double rms = std::sqrt(sum / static_cast<double>(count)) / 32768.0;
  const int level = static_cast<int>(rms * 1000.0);
  return level > previousMilli ? level : (previousMilli * 3 + level) / 4;
}

EchoControlOwner ownerForRoute(RouteEchoProfile route) {
  switch (route) {
    case RouteEchoProfile::kDeviceOwnedVoiceProcessing:
    case RouteEchoProfile::kBuiltInEarpiece:
      return EchoControlOwner::kPlatformVoiceCommunication;
    case RouteEchoProfile::kBuiltInSpeaker:
      return EchoControlOwner::kSoftwareAcousticProcessor;
    case RouteEchoProfile::kUnknown:
      break;
  }
  return EchoControlOwner::kNone;
}

// Whether the route's echo behaviour lets the microphone stay open while the
// assistant is speaking.
bool routeAllowsConcurrentCapture(RouteEchoProfile route) {
  switch (route) {
    case RouteEchoProfile::kDeviceOwnedVoiceProcessing:
    case RouteEchoProfile::kBuiltInEarpiece:
      return true;
    case RouteEchoProfile::kBuiltInSpeaker:
      // The software canceller runs on this route and its convergence is
      // reported through readiness and the published echo metrics, but
      // promoting the loudspeaker to concurrent capture is an acoustic
      // judgement that needs a measurement on real hardware. Until that exists,
      // the uplink closes while the speaker is presenting.
      return false;
    case RouteEchoProfile::kUnknown:
      break;
  }
  return false;
}

}  // namespace

RealtimeMediaCore::RealtimeMediaCore() = default;
RealtimeMediaCore::~RealtimeMediaCore() { stop(); }

void RealtimeMediaCore::setClockSource(int64_t (*monotonicNanos)()) {
  monotonicNanos_ = monotonicNanos;
}

void RealtimeMediaCore::recordEvent(MediaEventKind kind, int64_t detailA, int64_t detailB) {
  telemetry_.record(kind, detailA, detailB, monotonicNanos_ != nullptr ? monotonicNanos_() : 0);
}

bool RealtimeMediaCore::started() const {
  std::lock_guard<std::mutex> lock(controlMutex_);
  return started_;
}

bool RealtimeMediaCore::start(const EngineConfig& config, RouteEchoProfile route) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (started_) return false;
  config_ = config;
  route_.store(route, std::memory_order_release);
  echoControlOwner_.store(ownerForRoute(route), std::memory_order_release);
  started_ = true;
  deviceWrittenFrames_.store(0, std::memory_order_relaxed);
  devicePresentedFrames_.store(0, std::memory_order_relaxed);
  captureFrameIndex_.store(0, std::memory_order_relaxed);
  hasSentCaptureFrame_ = false;
  measuredStreamDelayMs_.store(-1, std::memory_order_relaxed);
  deviceClockValid_.store(false, std::memory_order_relaxed);
  referenceUnderrunRun_.store(0, std::memory_order_relaxed);
  eligibilityGeneration_.store(eligibilityCounter_.advance().value(), std::memory_order_release);
  renderGeneration_.store(renderCounter_.advance().value(), std::memory_order_release);
  readiness_.store(MediaReadiness::kStarting, std::memory_order_release);
  recordEvent(MediaEventKind::kEngineStarted, static_cast<int64_t>(route),
              static_cast<int64_t>(ownerForRoute(route)));
  recordEvent(MediaEventKind::kReadinessChanged, static_cast<int64_t>(MediaReadiness::kStopped),
              static_cast<int64_t>(MediaReadiness::kStarting));
  return true;
}

void RealtimeMediaCore::stop() {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (!started_) return;
  started_ = false;
  pipelineActive_.store(false, std::memory_order_seq_cst);
  // Published for the owner that frees this object: everything below, and the
  // destructor after it, touches state a callback still inside is reading.
  const bool quiesced = quiescePipeline();
  pipelineQuiesced_.store(quiesced, std::memory_order_release);
  if (!quiesced) {
    recordEvent(MediaEventKind::kPipelineQuiesceTimeout, 0, 1);
    readiness_.store(MediaReadiness::kStopped, std::memory_order_release);
    recordEvent(MediaEventKind::kEngineStopped, 0, 0);
    return;
  }
  if (renderTimeline_ != nullptr) renderTimeline_->stopAndDrain();
  // Stop is the one path that must not leave the processor alive, so it waits
  // through a full quiesce window; the streams are already stopped by here, so
  // the callback cannot be re-entered.
  quiesceAcousticProcessor();
  acoustic_.stop();
  readiness_.store(MediaReadiness::kStopped, std::memory_order_release);
  deviceClockValid_.store(false, std::memory_order_relaxed);
  renderLevelMilli_.store(0, std::memory_order_relaxed);
  captureLevelMilli_.store(0, std::memory_order_relaxed);
  recordEvent(MediaEventKind::kEngineStopped, 0, 0);
}

bool RealtimeMediaCore::beginDeviceEpoch(int deviceInputHz, int deviceOutputHz, int inputLatencyMs,
                                         int outputLatencyMs) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (!started_) return false;
  pipelineActive_.store(false, std::memory_order_seq_cst);
  // Fails closed while a callback from the previous epoch is still inside:
  // `rebuildForEpoch` frees and replaces the buffers it is reading. The wait is
  // retried here because the callback may have left in the meantime; if it has
  // not, the caller closes the streams and reports a media failure rather than
  // opening new ones over a thread that never came back.
  if (!pipelineQuiesced_.load(std::memory_order_acquire)) {
    const bool quiesced = quiescePipeline();
    pipelineQuiesced_.store(quiesced, std::memory_order_release);
    if (!quiesced) {
      recordEvent(MediaEventKind::kPipelineQuiesceTimeout, 0, 2);
      return false;
    }
  }
  if (!rateHasWholeFrame(deviceInputHz) || !rateHasWholeFrame(deviceOutputHz)) {
    // Refused rather than approximated: every stage here is sized in whole
    // 10 ms frames, and a rate without one would drift the capture and render
    // timelines apart. The caller closes the streams and the session degrades
    // to half duplex, which does not depend on them agreeing.
    recordEvent(MediaEventKind::kStreamError, deviceInputHz, deviceOutputHz);
    return false;
  }
  config_.rates.deviceInputHz = deviceInputHz;
  config_.rates.deviceOutputHz = deviceOutputHz;
  config_.rates.apmCaptureHz = chooseApmRate(deviceInputHz);
  config_.rates.apmRenderHz = chooseApmRate(deviceOutputHz);
  // The round trip the microphone actually observes: what the output stream
  // still holds plus what the input stream already held. This is the value
  // upstream seeds its render delay buffer with after a reset.
  measuredStreamDelayMs_.store(std::max(0, inputLatencyMs + outputLatencyMs),
                               std::memory_order_relaxed);

  const AudioDeviceClockEpoch epoch = epochCounter_.advance();
  deviceEpoch_.store(epoch.value(), std::memory_order_release);
  deviceWrittenFrames_.store(0, std::memory_order_relaxed);
  devicePresentedFrames_.store(0, std::memory_order_relaxed);
  captureFrameIndex_.store(0, std::memory_order_relaxed);
  hasSentCaptureFrame_ = false;
  deviceClockValid_.store(false, std::memory_order_relaxed);
  referenceUnderrunRun_.store(0, std::memory_order_relaxed);
  if (!rebuildForEpoch()) {
    // The route needs software echo control and the processor would not start.
    // Reporting the engine as running here is what would leave Talk listening
    // with a capture gate that can never open.
    recordEvent(MediaEventKind::kAcousticProcessorFault, static_cast<int64_t>(epoch.value()), 0);
    return false;
  }
  renderTimeline_->beginEpoch(epoch);
  pipelineActive_.store(true, std::memory_order_release);
  recordEvent(MediaEventKind::kDeviceEpochBegan, static_cast<int64_t>(epoch.value()),
              (static_cast<int64_t>(deviceInputHz) << 32) | deviceOutputHz);
  setReadiness(MediaReadiness::kDeviceSyncing, static_cast<int64_t>(epoch.value()));
  return true;
}

bool RealtimeMediaCore::quiescePipeline() {
  for (int attempt = 0; attempt < kPipelineQuiesceAttempts; ++attempt) {
    if (pipelineInUse_.load(std::memory_order_seq_cst) == 0) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return pipelineInUse_.load(std::memory_order_seq_cst) == 0;
}

void RealtimeMediaCore::breakUplinkContinuity() {
  std::lock_guard<std::mutex> lock(controlMutex_);
  hasSentCaptureFrame_ = false;
}

void RealtimeMediaCore::endDeviceEpoch() {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (!started_) return;
  const uint64_t epoch = deviceEpoch_.load(std::memory_order_acquire);
  pipelineActive_.store(false, std::memory_order_release);
  deviceClockValid_.store(false, std::memory_order_relaxed);
  // Nothing below runs while a callback is still inside: the timeline's
  // consumer-private cursors and pending barriers are exactly what a `pull`
  // in flight is using.
  const bool quiesced = quiescePipeline();
  pipelineQuiesced_.store(quiesced, std::memory_order_release);
  if (!quiesced) {
    // The callback thread stopped answering. Retiring barriers under it would
    // race the consumer, so the epoch ends without touching the timeline —
    // those barriers resolve when `stop()` drains, which is the path that owns
    // the session ending. Recorded rather than silent: this is the only reason
    // an epoch can end without invalidating its in-flight barriers, and it is
    // what makes the next `beginDeviceEpoch` refuse.
    recordEvent(MediaEventKind::kPipelineQuiesceTimeout,
                static_cast<int64_t>(epoch), 0);
  }
  // Not a drain. The device clock epoch and the render content generation are
  // independent lifetimes: a route change or an error restart replaces the
  // frame-position origin, not the reply the assistant is in the middle of.
  // Barriers stamped against the dying origin are invalidated here; queued
  // audio is carried into the next epoch by `rebuildForEpoch`. A session that
  // really is ending drains through `stop()`.
  if (quiesced && renderTimeline_ != nullptr) renderTimeline_->endEpoch();
  // A stream restart creates a new frame-position origin, so the adaptive state
  // is describing an echo path measured against a clock that no longer exists.
  if (acoustic_.active() && quiesceAcousticProcessor()) {
    acoustic_.resetAdaptation(AcousticResetReason::kDeviceClockEpochChanged);
    acousticActive_.store(acoustic_.active(), std::memory_order_release);
    recordEvent(MediaEventKind::kAcousticProcessorReset,
                static_cast<int64_t>(AcousticResetReason::kDeviceClockEpochChanged),
                static_cast<int64_t>(acoustic_.lifetime().value()));
  }
  recordEvent(MediaEventKind::kDeviceEpochEnded, static_cast<int64_t>(epoch), 0);
  setReadiness(MediaReadiness::kStarting, static_cast<int64_t>(epoch));
}

bool RealtimeMediaCore::rebuildForEpoch() {
  const MediaRates& rates = config_.rates;

  // The render queue holds device-rate samples, so it belongs to the device
  // output rate rather than to the epoch. A restart onto the same rate keeps
  // the reply that is still queued; a restart that negotiated a different rate
  // makes those samples unplayable, so they are discarded with every barrier
  // behind them resolved rather than replayed at the wrong speed.
  const bool keepRenderQueue =
      renderTimeline_ != nullptr && renderTimeline_->deviceRateHz() == rates.deviceOutputHz;
  if (renderTimeline_ != nullptr && !keepRenderQueue) renderTimeline_->stopAndDrain();

  // Carry the outgoing timeline's unread outcomes forward. `endDeviceEpoch`
  // records its invalidations into that timeline, and the control loop has not
  // necessarily drained them before the restart replaces it.
  if (renderTimeline_ != nullptr && !keepRenderQueue) {
    MarkEvent drained[64];
    size_t count = renderTimeline_->drainMarkEvents(drained, 64);
    while (count > 0) {
      carriedMarkEvents_.insert(carriedMarkEvents_.end(), drained, drained + count);
      count = renderTimeline_->drainMarkEvents(drained, 64);
    }
  }

  if (!keepRenderQueue) {
    // The wire-rate adapter and the resampler in front of the queue go with it:
    // the adapter's partial frame and the resampler's filter state describe
    // audio that is being discarded.
    renderWireFrames_ = std::make_unique<FrameAdapter>(apmFrameSamples(rates.wireOutputHz));
    renderWireToDevice_ = std::make_unique<ResampleLane>(rates.wireOutputHz, rates.deviceOutputHz);
    renderTimeline_ = std::make_unique<RenderTimeline>(RenderTimeline::Config{
        rates.deviceOutputHz, config_.renderCapacityMs, 2048});
  }

  captureDeviceFrames_ = std::make_unique<FrameAdapter>(apmFrameSamples(rates.deviceInputHz));
  captureDeviceToApm_ = std::make_unique<ResampleLane>(rates.deviceInputHz, rates.apmCaptureHz);
  captureApmToWire_ = std::make_unique<ResampleLane>(rates.apmCaptureHz, rates.wireInputHz);
  captureScratch_.assign(static_cast<size_t>(apmFrameSamples(rates.apmCaptureHz)), 0);
  uplink_ = std::make_unique<CaptureUplinkQueue>(
      static_cast<size_t>(apmFrameSamples(rates.wireInputHz)),
      static_cast<size_t>(std::max(1, config_.uplinkCapacityMs / kApmFrameMs)));

  referenceRing_ = std::make_unique<SampleRing>(
      static_cast<size_t>(millisToSamples(config_.referenceCapacityMs, rates.deviceOutputHz)),
      RingOverflowPolicy::kDropOldest);
  referenceDeviceToApm_ = std::make_unique<ResampleLane>(rates.deviceOutputHz, rates.apmRenderHz);
  referenceScratch_.assign(static_cast<size_t>(apmFrameSamples(rates.deviceOutputHz)), 0);

  if (!quiesceAcousticProcessor()) return false;
  const bool needsSoftwareEcho = echoControlOwner_.load(std::memory_order_acquire) ==
                                 EchoControlOwner::kSoftwareAcousticProcessor;
  bool ok = true;
  if (needsSoftwareEcho) {
    if (acoustic_.start(rates.apmCaptureHz, rates.apmRenderHz, AcousticResetReason::kEngineStart)) {
      recordEvent(MediaEventKind::kAcousticProcessorStarted,
                  static_cast<int64_t>(acoustic_.lifetime().value()),
                  (static_cast<int64_t>(rates.apmCaptureHz) << 32) | rates.apmRenderHz);
    } else {
      recordEvent(MediaEventKind::kAcousticProcessorFault, 0, 0);
      ok = false;
    }
  } else {
    // Exactly one echo control owner. On a route the platform already voice-
    // processes, running a second canceller behind it gives that canceller a
    // reference that no longer matches what the microphone hears.
    acoustic_.stop();
  }
  acousticActive_.store(acoustic_.active(), std::memory_order_release);
  return ok;
}

bool RealtimeMediaCore::setRoute(RouteEchoProfile route) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  const RouteEchoProfile previous = route_.load(std::memory_order_acquire);
  if (!started_) return false;
  if (route == previous) return true;
  route_.store(route, std::memory_order_release);
  const EchoControlOwner owner = ownerForRoute(route);
  echoControlOwner_.store(owner, std::memory_order_release);
  recordEvent(MediaEventKind::kRouteChanged, static_cast<int64_t>(previous),
              static_cast<int64_t>(route));
  // The echo path is a property of the route. Keeping the adaptive state across
  // a route change would have the canceller subtract the previous room.
  if (!quiesceAcousticProcessor()) {
    // The capture callback did not come back out of the processor. Leaving the
    // route unchanged is wrong but survivable; freeing the processor underneath
    // a running callback is not.
    recordEvent(MediaEventKind::kAcousticProcessorFault, static_cast<int64_t>(route), 1);
    route_.store(previous, std::memory_order_release);
    echoControlOwner_.store(ownerForRoute(previous), std::memory_order_release);
    acousticActive_.store(acoustic_.active(), std::memory_order_release);
    return false;
  }
  // The far-end reference describes the room the previous route played into.
  // Carrying it across the boundary would have a freshly started canceller
  // subtract audio that came out of a different speaker. The capture callback
  // owns both the ring and the converter, so it is asked rather than raced.
  pendingReferenceReset_.store(true, std::memory_order_release);
  referenceUnderrunRun_.store(0, std::memory_order_relaxed);

  bool applied = true;
  if (owner == EchoControlOwner::kSoftwareAcousticProcessor) {
    if (acoustic_.start(config_.rates.apmCaptureHz, config_.rates.apmRenderHz,
                        AcousticResetReason::kRouteChanged)) {
      recordEvent(MediaEventKind::kAcousticProcessorReset,
                  static_cast<int64_t>(AcousticResetReason::kRouteChanged),
                  static_cast<int64_t>(acoustic_.lifetime().value()));
    } else {
      // The route now needs a canceller that will not start. Capture on it
      // would be unprocessed loudspeaker audio, so the caller is told the
      // change failed rather than left to assume echo control exists.
      recordEvent(MediaEventKind::kAcousticProcessorFault, static_cast<int64_t>(route), 2);
      applied = false;
    }
  } else {
    acoustic_.stop();
  }
  acousticActive_.store(acoustic_.active(), std::memory_order_release);
  advanceEligibility(static_cast<int64_t>(route));
  // Held closed rather than advanced to the route's steady state. The microphone
  // preset belongs to the route, so the owner reopens the input stream after
  // this returns; publishing full readiness now would let a capture callback on
  // the *old* stream pass the send gate during the swap. The next epoch reopens
  // it, and if no restart follows, the first processed capture frame advances it
  // again through `updateReadinessAfterCapture`.
  setReadiness(MediaReadiness::kDeviceSyncing, static_cast<int64_t>(route));
  return applied;
}

bool RealtimeMediaCore::quiesceAcousticProcessor() {
  // Ordering matters both ways: the flag is cleared before the in-use check,
  // and the callback sets in-use before it reads the flag, so exactly one of
  // the two observes the other.
  acousticActive_.store(false, std::memory_order_seq_cst);
  for (int attempt = 0; attempt < kProcessorQuiesceAttempts; ++attempt) {
    if (!processorInUse_.load(std::memory_order_seq_cst)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return false;
}

void RealtimeMediaCore::advanceEligibility(int64_t reason) {
  const uint64_t next = eligibilityCounter_.advance().value();
  eligibilityGeneration_.store(next, std::memory_order_release);
  recordEvent(MediaEventKind::kCaptureEligibilityChanged, reason, static_cast<int64_t>(next));
}

void RealtimeMediaCore::setReadiness(MediaReadiness next, int64_t detail) {
  const MediaReadiness previous = readiness_.exchange(next, std::memory_order_acq_rel);
  if (previous == next) return;
  recordEvent(MediaEventKind::kReadinessChanged, static_cast<int64_t>(previous),
              (static_cast<int64_t>(next) << 32) | (detail & 0xffffffff));
}

RenderContentGeneration RealtimeMediaCore::beginRenderGeneration() {
  std::lock_guard<std::mutex> lock(controlMutex_);
  const RenderContentGeneration generation = renderCounter_.advance();
  renderGeneration_.store(generation.value(), std::memory_order_release);
  if (renderWireFrames_ != nullptr) renderWireFrames_->reset();
  if (renderWireToDevice_ != nullptr) renderWireToDevice_->reset();
  recordEvent(MediaEventKind::kRenderGenerationBegan, static_cast<int64_t>(generation.value()), 0);
  return generation;
}

RenderContentGeneration RealtimeMediaCore::currentRenderGeneration() const {
  return RenderContentGeneration(renderGeneration_.load(std::memory_order_acquire));
}

bool RealtimeMediaCore::submitWireAudio(RenderContentGeneration generation,
                                        const int16_t* wireSamples, size_t sampleCount) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (!started_ || renderTimeline_ == nullptr) return false;
  if (generation.value() != renderGeneration_.load(std::memory_order_acquire)) return false;
  bool accepted = true;
  renderWireFrames_->push(wireSamples, sampleCount, [&](const int16_t* frame, size_t frameSamples) {
    const int16_t* deviceFrame = renderWireToDevice_->convert(frame, frameSamples);
    if (deviceFrame == nullptr) return;
    if (!renderTimeline_->submitAudio(generation, deviceFrame,
                                      renderWireToDevice_->targetFrameSamples())) {
      accepted = false;
    }
  });
  if (!accepted) {
    recordEvent(MediaEventKind::kRenderQueueOverflow, static_cast<int64_t>(generation.value()),
                static_cast<int64_t>(renderTimeline_->queuedSamples()));
  }
  return accepted;
}

void RealtimeMediaCore::clearRender() {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (!started_ || renderTimeline_ == nullptr) return;
  const RenderContentGeneration cancelled =
      RenderContentGeneration(renderGeneration_.load(std::memory_order_acquire));
  renderTimeline_->cancelThrough(cancelled);
  // The partially converted wire frame belongs to the cancelled generation and
  // must not be spliced onto the next one.
  renderWireFrames_->reset();
  renderWireToDevice_->reset();
  const RenderContentGeneration next = renderCounter_.advance();
  renderGeneration_.store(next.value(), std::memory_order_release);
  recordEvent(MediaEventKind::kRenderCleared, static_cast<int64_t>(cancelled.value()),
              static_cast<int64_t>(next.value()));
  // A cancelled response is not an acoustic event: the room did not change, and
  // discarding the adaptation here would cost the next response its first
  // second of echo control.
}

bool RealtimeMediaCore::submitMark(uint64_t markId) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (!started_ || renderTimeline_ == nullptr) return false;
  const RenderContentGeneration generation =
      RenderContentGeneration(renderGeneration_.load(std::memory_order_acquire));
  // A barrier is placed at the current end of the timeline, so every sample
  // already submitted has to be in it first. The provider emits a barrier after
  // each audio delta, and a delta is rarely a whole 10 ms frame, so without
  // this the tail of the delta the barrier belongs to would sit behind it —
  // acknowledged as played, then dropped at the next generation.
  if (renderWireFrames_ != nullptr && renderWireToDevice_ != nullptr) {
    const int16_t* tail = nullptr;
    const size_t tailSamples = renderWireFrames_->takePending(&tail);
    if (tailSamples > 0) {
      size_t converted = 0;
      const int16_t* deviceTail = renderWireToDevice_->convertPartial(tail, tailSamples, &converted);
      // Submitted before the adapter is cleared: when the negotiated device
      // rate equals the wire rate there is no conversion, so `deviceTail` is
      // the adapter's own storage and clearing it first would hand the timeline
      // a buffer that no longer holds those samples.
      const bool accepted = deviceTail == nullptr || converted == 0 ||
                            renderTimeline_->submitAudio(generation, deviceTail, converted);
      renderWireFrames_->reset();
      if (!accepted) {
        recordEvent(MediaEventKind::kRenderQueueOverflow, static_cast<int64_t>(generation.value()),
                    static_cast<int64_t>(converted));
        return false;
      }
    }
  }
  return renderTimeline_->submitMark(generation, markId);
}

void RealtimeMediaCore::onRenderCallback(int16_t* out, size_t frames, uint64_t presentedFrames) {
  pipelineInUse_.fetch_add(1, std::memory_order_seq_cst);
  const PipelineScope scope{pipelineInUse_};
  if (!pipelineActive_.load(std::memory_order_seq_cst) || renderTimeline_ == nullptr) {
    std::memset(out, 0, frames * sizeof(int16_t));
    return;
  }
  RenderTimeline* timeline = renderTimeline_.get();
  devicePresentedFrames_.store(presentedFrames, std::memory_order_relaxed);
  if (presentedFrames > 0) deviceClockValid_.store(true, std::memory_order_relaxed);
  const RenderTimeline::PullResult result = timeline->pull(out, frames, presentedFrames);
  deviceWrittenFrames_.fetch_add(frames, std::memory_order_relaxed);
  // The reference is exactly what the device was handed: after conversion,
  // after generation cancellation, including the silence the engine synthesised
  // when there was nothing to play, and before the speaker.
  // Only the software echo owner consumes the reference; on a platform-owned
  // route nothing reads this ring, so nothing is written to it either.
  if (acousticActive_.load(std::memory_order_acquire) && referenceRing_ != nullptr) {
    referenceRing_->write(out, frames);
  }
  renderLevelMilli_.store(
      result.audioSamples > 0
          ? smoothedLevelMilli(renderLevelMilli_.load(std::memory_order_relaxed), out, frames)
          : 0,
      std::memory_order_relaxed);
}

void RealtimeMediaCore::feedReferenceFrame() {
  if (!acousticActive_.load(std::memory_order_acquire)) return;
  if (pendingReferenceReset_.exchange(false, std::memory_order_acq_rel)) {
    // Applied here because this is the only thread that reads either of them.
    referenceRing_->clear();
    referenceDeviceToApm_->reset();
  }
  const size_t deviceFrameSamples = referenceScratch_.size();
  const size_t read = referenceRing_->read(referenceScratch_.data(), deviceFrameSamples);
  if (read < deviceFrameSamples) {
    std::memset(referenceScratch_.data() + read, 0, (deviceFrameSamples - read) * sizeof(int16_t));
    acoustic_.recordReferenceUnderrun(1);
    const uint64_t run = referenceUnderrunRun_.fetch_add(1, std::memory_order_relaxed) + 1;
    if (run == kReferenceUnderrunResetFrames) {
      recordEvent(MediaEventKind::kReferenceTimelineUnderrun, static_cast<int64_t>(run),
                  static_cast<int64_t>(acoustic_.lifetime().value()));
      // Rebuilding the processor allocates, which a device callback must not
      // do; the control owner performs it on its next pump.
      pendingAcousticReset_.store(static_cast<int>(AcousticResetReason::kReferenceTimelineLost),
                                  std::memory_order_release);
    }
  } else {
    referenceUnderrunRun_.store(0, std::memory_order_relaxed);
  }
  const int16_t* apmFrame =
      referenceDeviceToApm_->convert(referenceScratch_.data(), deviceFrameSamples);
  if (apmFrame == nullptr) return;
  acoustic_.processRenderReference(apmFrame);
}

void RealtimeMediaCore::onCaptureCallback(const int16_t* in, size_t frames) {
  pipelineInUse_.fetch_add(1, std::memory_order_seq_cst);
  const PipelineScope scope{pipelineInUse_};
  if (!pipelineActive_.load(std::memory_order_seq_cst)) return;
  FrameAdapter* adapter = captureDeviceFrames_.get();
  if (adapter == nullptr || uplink_ == nullptr) return;
  captureLevelMilli_.store(
      smoothedLevelMilli(captureLevelMilli_.load(std::memory_order_relaxed), in, frames),
      std::memory_order_relaxed);
  adapter->push(in, frames, [&](const int16_t* frame, size_t frameSamples) {
    uplink_->recordCaptured();
    // Claimed before anything below can drop the frame. Every captured frame
    // consumes an index, so a frame lost to conversion or to a processor fault
    // leaves a hole the uplink's contiguity check sees, instead of the next
    // frame arriving as if it followed the last one it sent.
    const uint64_t index = captureFrameIndex_.fetch_add(1, std::memory_order_relaxed);
    // The decision is taken before the frame is processed. That is what makes
    // the frame whose own processing flips readiness stay under the old
    // decision, and the next frame the first that can be sent.
    const CaptureEligibility eligibility{
        eligibilityGeneration_.load(std::memory_order_acquire), captureEligibleNow()};

    const int16_t* apmFrame = captureDeviceToApm_->convert(frame, frameSamples);
    if (apmFrame == nullptr) return;
    std::memcpy(captureScratch_.data(), apmFrame, captureScratch_.size() * sizeof(int16_t));

    bool processed = true;
    processorInUse_.store(true, std::memory_order_seq_cst);
    if (acousticActive_.load(std::memory_order_seq_cst)) {
      // Upstream requires the far-end frame before its matching near-end frame.
      feedReferenceFrame();
      processed = acoustic_.processCapture(captureScratch_.data(),
                                           measuredStreamDelayMs_.load(std::memory_order_relaxed));
      if (processed) uplink_->recordProcessed();
    }
    processorInUse_.store(false, std::memory_order_seq_cst);
    if (!processed) {
      // The frame was never echo-processed. On a route where the software
      // canceller owns echo, releasing it would put the loudspeaker's own
      // output on the uplink, so it is dropped and the processor is rebuilt.
      pendingAcousticReset_.store(static_cast<int>(AcousticResetReason::kProcessorFault),
                                  std::memory_order_release);
      return;
    }
    // Readiness is advanced after the decision above was already taken, which
    // is what keeps the frame whose own processing flips readiness under the
    // previous decision.
    updateReadinessAfterCapture();

    const int16_t* wireFrame =
        captureApmToWire_->convert(captureScratch_.data(), captureScratch_.size());
    if (wireFrame == nullptr) return;
    if (!uplink_->offer(eligibility, index,
                        AudioDeviceClockEpoch(deviceEpoch_.load(std::memory_order_acquire)),
                        wireFrame)) {
      recordEvent(MediaEventKind::kUplinkQueueOverflow, static_cast<int64_t>(index), 0);
    }
  });
}

void RealtimeMediaCore::updateReadinessAfterCapture() {
  const MediaReadiness current = readiness_.load(std::memory_order_acquire);
  if (current == MediaReadiness::kStopped || current == MediaReadiness::kStarting) return;
  if (!deviceClockValid_.load(std::memory_order_relaxed)) return;
  const bool softwareEcho = acousticActive_.load(std::memory_order_acquire);
  if (current == MediaReadiness::kDeviceSyncing) {
    // A route the platform voice-processes has nothing to prime: its echo
    // control was already running before this engine opened a stream.
    setReadiness(softwareEcho ? MediaReadiness::kAecPriming : MediaReadiness::kFullDuplexReady, 0);
    return;
  }
  if (current == MediaReadiness::kAecPriming && softwareEcho && acoustic_.echoPathLocated()) {
    // Upstream publishing a delay estimate is its own statement that it has
    // located the echo path. That is a measured fact from the processor, not a
    // frame count someone chose.
    setReadiness(MediaReadiness::kFullDuplexReady,
                 static_cast<int64_t>(acoustic_.lifetime().value()));
  }
}

// Reads only atomics, so both the capture callback and the control owner can
// ask it without either taking the other's lock.
bool RealtimeMediaCore::renderPresenting() const {
  if (renderTimeline_ == nullptr) return false;
  if (renderTimeline_->queuedSamples() > 0) return true;
  // Presentation, not write acceptance. What the device has accepted says
  // nothing about what the speaker has already played, and the total frames
  // handed to the device include the silence the engine synthesises when there
  // is nothing to play.
  return devicePresentedFrames_.load(std::memory_order_relaxed) <
         renderTimeline_->audioEndFrame();
}

bool RealtimeMediaCore::captureEligibleNow() const {
  // Until the device clock has proved itself, "is the assistant still audible"
  // has no trustworthy answer, so the decision fails closed rather than
  // guessing that nothing is playing.
  const MediaReadiness readiness = readiness_.load(std::memory_order_acquire);
  if (readiness == MediaReadiness::kStopped || readiness == MediaReadiness::kStarting ||
      readiness == MediaReadiness::kDeviceSyncing) {
    return false;
  }
  // A stream error invalidates the clock without changing readiness, and
  // without a clock "is the assistant still audible" has no answer. The gate
  // closes for the whole error and restart window rather than guessing.
  if (!deviceClockValid_.load(std::memory_order_relaxed)) return false;
  const RouteEchoProfile route = route_.load(std::memory_order_acquire);
  if (routeAllowsConcurrentCapture(route)) {
    // Concurrent capture — the microphone open while the assistant speaks — is
    // granted only at full readiness. On these routes the echo control is the
    // platform's own pipeline, which is already running before this engine
    // opens a stream, so readiness reaches full duplex without a priming step.
    // Anything that ever promotes the loudspeaker to concurrent capture inherits
    // this check, and with it the requirement that the canceller has located
    // the echo path.
    return readiness == MediaReadiness::kFullDuplexReady;
  }
  // The loudspeaker runs half duplex: the microphone closes while the speaker
  // is presenting. That is the decision, and the canceller cleans the frames it
  // releases rather than authorising them — which is why this route does not
  // wait for convergence, and why it is not promoted to concurrent capture in
  // the first place.
  if (route == RouteEchoProfile::kBuiltInSpeaker &&
      !acousticActive_.load(std::memory_order_acquire)) {
    // A processor being rebuilt is a route with no echo control at all.
    return false;
  }
  return !renderPresenting();
}

void RealtimeMediaCore::pumpControl() {
  std::lock_guard<std::mutex> lock(controlMutex_);
  const int pending = pendingAcousticReset_.exchange(-1, std::memory_order_acq_rel);
  if (pending < 0 || !acoustic_.active()) return;
  if (!quiesceAcousticProcessor()) {
    // The callback did not come back out. Rearm rather than free the processor
    // underneath it; the next pump tries again.
    pendingAcousticReset_.store(pending, std::memory_order_release);
    acousticActive_.store(acoustic_.active(), std::memory_order_release);
    return;
  }
  const auto reason = static_cast<AcousticResetReason>(pending);
  acoustic_.resetAdaptation(reason);
  acousticActive_.store(acoustic_.active(), std::memory_order_release);
  referenceUnderrunRun_.store(0, std::memory_order_relaxed);
  recordEvent(MediaEventKind::kAcousticProcessorReset, static_cast<int64_t>(reason),
              static_cast<int64_t>(acoustic_.lifetime().value()));
  setReadiness(MediaReadiness::kAecPriming, static_cast<int64_t>(reason));
}

bool RealtimeMediaCore::nextUplinkFrame(UplinkFrame* out) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  if (uplink_ == nullptr) return false;
  const CaptureUplinkEligibilityGeneration generation(
      eligibilityGeneration_.load(std::memory_order_acquire));
  const bool permitted = started_ && captureEligibleNow();
  CaptureUplinkQueue::Dequeued dequeued;
  while (uplink_->next(generation, permitted, &dequeued)) {
    if (dequeued.disposition != UplinkDisposition::kSent) continue;
    out->samples = dequeued.samples;
    out->sampleCount = dequeued.sampleCount;
    out->captureFrameIndex = dequeued.captureFrameIndex;
    out->contiguousWithPrevious =
        hasSentCaptureFrame_ && dequeued.captureFrameIndex == lastSentCaptureFrameIndex_ + 1;
    lastSentCaptureFrameIndex_ = dequeued.captureFrameIndex;
    hasSentCaptureFrame_ = true;
    return true;
  }
  return false;
}

size_t RealtimeMediaCore::drainMarkEvents(MarkEvent* out, size_t max) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  size_t written = 0;
  // Outcomes from a retired timeline come first, in the order they happened.
  if (!carriedMarkEvents_.empty()) {
    written = std::min(max, carriedMarkEvents_.size());
    std::copy(carriedMarkEvents_.begin(), carriedMarkEvents_.begin() + written, out);
    carriedMarkEvents_.erase(carriedMarkEvents_.begin(), carriedMarkEvents_.begin() + written);
  }
  if (written == max || renderTimeline_ == nullptr) return written;
  return written + renderTimeline_->drainMarkEvents(out + written, max - written);
}

size_t RealtimeMediaCore::drainTelemetry(MediaEvent* out, size_t max) {
  return telemetry_.drain(out, max);
}

void RealtimeMediaCore::onStreamError(int errorCode, bool isInput) {
  // Realtime callbacks never reopen a stream themselves; they hand the fault to
  // the serialized control owner and stop touching engine state.
  recordEvent(MediaEventKind::kStreamError, errorCode, isInput ? 1 : 0);
  deviceClockValid_.store(false, std::memory_order_relaxed);
  // Readiness has to follow the clock. Leaving it at full duplex would let the
  // send gate keep its answer from before the device stopped reporting.
  setReadiness(MediaReadiness::kDeviceSyncing, errorCode);
}

MediaSnapshot RealtimeMediaCore::snapshot() const {
  std::lock_guard<std::mutex> lock(controlMutex_);
  MediaSnapshot out;
  out.readiness = readiness_.load(std::memory_order_acquire);
  out.route = route_.load(std::memory_order_acquire);
  out.echoControlOwner = echoControlOwner_.load(std::memory_order_acquire);
  out.renderPresenting = renderPresenting();
  out.captureEligibleNow = captureEligibleNow();
  out.rates = config_.rates;
  out.deviceClockEpoch = deviceEpoch_.load(std::memory_order_acquire);
  out.renderContentGeneration = renderGeneration_.load(std::memory_order_acquire);
  out.captureEligibilityGeneration = eligibilityGeneration_.load(std::memory_order_acquire);
  out.acousticProcessorLifetime = acoustic_.lifetime().value();
  out.measuredStreamDelayMs = measuredStreamDelayMs_.load(std::memory_order_relaxed);
  if (renderTimeline_ != nullptr) out.render = renderTimeline_->stats();
  if (uplink_ != nullptr) out.capture = uplink_->stats();
  out.acoustic = acoustic_.stats();
  if (referenceRing_ != nullptr) out.referenceRingDroppedSamples = referenceRing_->droppedSamples();
  out.telemetryDroppedEvents = telemetry_.droppedEvents();
  out.renderLevelMilli = renderLevelMilli_.load(std::memory_order_relaxed);
  out.captureLevelMilli = captureLevelMilli_.load(std::memory_order_relaxed);
  return out;
}

}  // namespace openclaw::media
