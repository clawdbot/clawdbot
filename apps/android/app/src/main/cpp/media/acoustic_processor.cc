#include "media/acoustic_processor.h"

#include <atomic>

#include "api/audio/audio_processing.h"
#include "api/audio/audio_processing_statistics.h"
#include "api/scoped_refptr.h"
#include "media/media_rates.h"

namespace openclaw::media {

struct AcousticProcessor::Impl {
  rtc::scoped_refptr<webrtc::AudioProcessing> apm;
  int captureRateHz = 0;
  int renderRateHz = 0;
  webrtc::StreamConfig captureConfig;
  webrtc::StreamConfig renderConfig;

  // Processor-lifetime domain. Reset together with `apm`, because a counter
  // that outlives the state it describes is how a stale readiness decision gets
  // made from a fresh-looking number.
  std::atomic<uint64_t> renderFrames{0};
  std::atomic<uint64_t> captureFrames{0};
  std::atomic<uint64_t> referenceUnderrunFrames{0};
  std::atomic<uint64_t> resets{0};
  std::atomic<uint64_t> faults{0};
  std::atomic<bool> delaySeen{false};

  // Upstream's `GetStatistics` takes the processor's capture lock. Reading it
  // from the control thread on every snapshot would contend with the realtime
  // capture callback, so the capture callback refreshes this cache once a
  // second and the snapshot only reads atomics.
  std::atomic<bool> hasEchoReturnLoss{false};
  std::atomic<int64_t> echoReturnLossMilliDb{0};
  std::atomic<bool> hasEchoReturnLossEnhancement{false};
  std::atomic<int64_t> echoReturnLossEnhancementMilliDb{0};
  std::atomic<bool> hasDelayMs{false};
  std::atomic<int32_t> delayMs{0};
  std::atomic<bool> hasResidualEchoLikelihood{false};
  std::atomic<int64_t> residualEchoLikelihoodMilli{0};
};

// One second of 10 ms frames. Upstream aggregates its echo metrics over the
// same window, so refreshing faster would republish the same numbers.
constexpr uint64_t kStatsRefreshFrames = 100;

namespace {

webrtc::AudioProcessing::Config buildConfig() {
  webrtc::AudioProcessing::Config config;
  // AEC3. `mobile_mode` selects AECM, the fixed-point mobile canceller with no
  // linear filter and no ERL/ERLE reporting; this engine wants the full
  // canceller and its published metrics.
  config.echo_canceller.enabled = true;
  config.echo_canceller.mobile_mode = false;
  config.high_pass_filter.enabled = true;
  // Noise suppression and the adaptive digital gain controller are upstream's
  // own defaults for a communication capture chain, and AEC3's suppressor is
  // tuned alongside them. Turning them off here would be a tuning decision this
  // task has no physical measurement to justify.
  config.noise_suppression.enabled = true;
  config.noise_suppression.level = webrtc::AudioProcessing::Config::NoiseSuppression::kModerate;
  config.gain_controller2.enabled = true;
  // The analog gain controller drives a hardware mic-level API that Android
  // does not expose to an app, so leaving it on would have it chase a level it
  // can never change.
  config.gain_controller1.enabled = false;
  return config;
}

}  // namespace

AcousticProcessor::AcousticProcessor() : impl_(std::make_unique<Impl>()) {}
AcousticProcessor::~AcousticProcessor() = default;

bool AcousticProcessor::active() const { return impl_->apm != nullptr; }

bool AcousticProcessor::start(int captureRateHz, int renderRateHz, AcousticResetReason reason) {
  stop();
  impl_->apm = webrtc::AudioProcessingBuilder().SetConfig(buildConfig()).Create();
  if (impl_->apm == nullptr) {
    lastError_ = "AudioProcessingBuilder returned no processor";
    impl_->faults.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  impl_->captureRateHz = captureRateHz;
  impl_->renderRateHz = renderRateHz;
  impl_->captureConfig = webrtc::StreamConfig(captureRateHz, 1);
  impl_->renderConfig = webrtc::StreamConfig(renderRateHz, 1);
  impl_->renderFrames.store(0, std::memory_order_relaxed);
  impl_->captureFrames.store(0, std::memory_order_relaxed);
  impl_->referenceUnderrunFrames.store(0, std::memory_order_relaxed);
  impl_->delaySeen.store(false, std::memory_order_relaxed);
  impl_->hasEchoReturnLoss.store(false, std::memory_order_relaxed);
  impl_->hasEchoReturnLossEnhancement.store(false, std::memory_order_relaxed);
  impl_->hasDelayMs.store(false, std::memory_order_relaxed);
  impl_->hasResidualEchoLikelihood.store(false, std::memory_order_relaxed);
  lifetime_ = lifetimeCounter_.advance();
  if (reason != AcousticResetReason::kEngineStart) {
    impl_->resets.fetch_add(1, std::memory_order_relaxed);
  }
  lastError_.clear();
  return true;
}

void AcousticProcessor::stop() {
  impl_->apm = nullptr;
  impl_->captureRateHz = 0;
  impl_->renderRateHz = 0;
}

void AcousticProcessor::resetAdaptation(AcousticResetReason reason) {
  if (impl_->apm == nullptr) return;
  const int captureRateHz = impl_->captureRateHz;
  const int renderRateHz = impl_->renderRateHz;
  start(captureRateHz, renderRateHz, reason);
}

void AcousticProcessor::processRenderReference(const int16_t* frame) {
  if (impl_->apm == nullptr) return;
  // Upstream writes the processed far-end back into `dest`; the engine ignores
  // that output, so the frame is processed in place in the caller's scratch.
  int16_t* mutableFrame = const_cast<int16_t*>(frame);
  const int status = impl_->apm->ProcessReverseStream(mutableFrame, impl_->renderConfig,
                                                      impl_->renderConfig, mutableFrame);
  if (status != webrtc::AudioProcessing::kNoError) {
    impl_->faults.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  impl_->renderFrames.fetch_add(1, std::memory_order_relaxed);
}

void AcousticProcessor::recordReferenceUnderrun(size_t frames) {
  impl_->referenceUnderrunFrames.fetch_add(frames, std::memory_order_relaxed);
}

bool AcousticProcessor::processCapture(int16_t* frame, int streamDelayMs) {
  if (impl_->apm == nullptr) return false;
  if (streamDelayMs >= 0) {
    // Upstream consumes this only as the initial render-buffer delay after a
    // reset (`RenderDelayBufferImpl::Reset`), and afterwards to log a mismatch
    // against its own estimate. Supplying a measured value therefore shortens
    // convergence without taking over the operating delay.
    impl_->apm->set_stream_delay_ms(streamDelayMs);
  }
  const int status = impl_->apm->ProcessStream(frame, impl_->captureConfig, impl_->captureConfig,
                                               frame);
  if (status != webrtc::AudioProcessing::kNoError) {
    impl_->faults.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  const uint64_t frames = impl_->captureFrames.fetch_add(1, std::memory_order_relaxed) + 1;
  // Until the echo path is located, the delay estimate is what readiness is
  // waiting on, so it is polled every frame; afterwards the whole cache
  // refreshes on upstream's own aggregation cadence.
  if (!impl_->delaySeen.load(std::memory_order_relaxed) || frames % kStatsRefreshFrames == 0) {
    refreshStatsCache();
  }
  return true;
}

bool AcousticProcessor::echoPathLocated() const {
  if (impl_->apm == nullptr) return false;
  return impl_->delaySeen.load(std::memory_order_relaxed);
}

void AcousticProcessor::refreshStatsCache() {
  if (impl_->apm == nullptr) return;
  const webrtc::AudioProcessingStats stats = impl_->apm->GetStatistics();
  impl_->hasEchoReturnLoss.store(stats.echo_return_loss.has_value(), std::memory_order_relaxed);
  impl_->echoReturnLossMilliDb.store(
      static_cast<int64_t>(stats.echo_return_loss.value_or(0.0) * 1000.0),
      std::memory_order_relaxed);
  impl_->hasEchoReturnLossEnhancement.store(stats.echo_return_loss_enhancement.has_value(),
                                            std::memory_order_relaxed);
  impl_->echoReturnLossEnhancementMilliDb.store(
      static_cast<int64_t>(stats.echo_return_loss_enhancement.value_or(0.0) * 1000.0),
      std::memory_order_relaxed);
  impl_->hasResidualEchoLikelihood.store(stats.residual_echo_likelihood.has_value(),
                                         std::memory_order_relaxed);
  impl_->residualEchoLikelihoodMilli.store(
      static_cast<int64_t>(stats.residual_echo_likelihood.value_or(0.0) * 1000.0),
      std::memory_order_relaxed);
  if (stats.delay_ms.has_value()) {
    impl_->hasDelayMs.store(true, std::memory_order_relaxed);
    impl_->delayMs.store(*stats.delay_ms, std::memory_order_relaxed);
    impl_->delaySeen.store(true, std::memory_order_relaxed);
  }
}

AcousticProcessorStats AcousticProcessor::stats() const {
  AcousticProcessorStats out;
  out.active = impl_->apm != nullptr;
  out.lifetime = lifetime_.value();
  out.renderFramesProcessed = impl_->renderFrames.load(std::memory_order_relaxed);
  out.captureFramesProcessed = impl_->captureFrames.load(std::memory_order_relaxed);
  out.referenceUnderrunFrames = impl_->referenceUnderrunFrames.load(std::memory_order_relaxed);
  out.resets = impl_->resets.load(std::memory_order_relaxed);
  out.faults = impl_->faults.load(std::memory_order_relaxed);
  if (impl_->apm == nullptr) return out;
  out.hasEchoReturnLoss = impl_->hasEchoReturnLoss.load(std::memory_order_relaxed);
  out.echoReturnLossDb = impl_->echoReturnLossMilliDb.load(std::memory_order_relaxed) / 1000.0;
  out.hasEchoReturnLossEnhancement =
      impl_->hasEchoReturnLossEnhancement.load(std::memory_order_relaxed);
  out.echoReturnLossEnhancementDb =
      impl_->echoReturnLossEnhancementMilliDb.load(std::memory_order_relaxed) / 1000.0;
  out.hasDelayMs = impl_->hasDelayMs.load(std::memory_order_relaxed);
  out.delayMs = impl_->delayMs.load(std::memory_order_relaxed);
  out.hasResidualEchoLikelihood =
      impl_->hasResidualEchoLikelihood.load(std::memory_order_relaxed);
  out.residualEchoLikelihood =
      impl_->residualEchoLikelihoodMilli.load(std::memory_order_relaxed) / 1000.0;
  return out;
}

}  // namespace openclaw::media
