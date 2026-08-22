#include "android/oboe_device_io.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>

namespace openclaw::media {
namespace {
// 2 s: far beyond any real callback, bounded so a device whose callback thread
// has stopped answering cannot hold teardown forever.
constexpr int kAdmissionQuiesceAttempts = 2000;

// Leaves on every return path out of a callback, including the early ones. A
// leaked count would make every later teardown refuse to free an engine nothing
// is actually using.
struct AdmissionScope {
  std::atomic<int>& counter;
  ~AdmissionScope() { counter.fetch_sub(1, std::memory_order_seq_cst); }
};

oboe::InputPreset toOboePreset(InputPresetChoice choice) {
  switch (choice) {
    case InputPresetChoice::kVoiceCommunication:
      return oboe::InputPreset::VoiceCommunication;
    case InputPresetChoice::kUnprocessed:
      return oboe::InputPreset::Unprocessed;
    case InputPresetChoice::kVoiceRecognition:
      break;
  }
  return oboe::InputPreset::VoiceRecognition;
}

int latencyMs(const std::shared_ptr<oboe::AudioStream>& stream) {
  if (stream == nullptr) return 0;
  const auto latency = stream->calculateLatencyMillis();
  if (!latency) return 0;
  return static_cast<int>(latency.value() + 0.5);
}

}  // namespace

oboe::DataCallbackResult OboeCallbackShim::onAudioReady(oboe::AudioStream* stream, void* audioData,
                                                        int32_t numFrames) {
  // Admitted before the owner is read. A detach that stores null after this
  // still waits for the dispatch below; one that stores null before it is seen
  // here and turns the callback away.
  admitted_.fetch_add(1, std::memory_order_seq_cst);
  const AdmissionScope admission{admitted_};
  OboeDeviceIo* owner = owner_.load(std::memory_order_seq_cst);
  if (owner == nullptr) {
    // Detached: the stream is still handing us a buffer, so it gets silence
    // rather than whatever was in it.
    if (stream->getDirection() == oboe::Direction::Output) {
      std::memset(audioData, 0, static_cast<size_t>(std::max(0, numFrames)) * sizeof(int16_t));
    }
    return oboe::DataCallbackResult::Continue;
  }
  return owner->onAudioReady(stream, audioData, numFrames);
}

void OboeCallbackShim::onErrorAfterClose(oboe::AudioStream* stream, oboe::Result result) {
  admitted_.fetch_add(1, std::memory_order_seq_cst);
  const AdmissionScope admission{admitted_};
  OboeDeviceIo* owner = owner_.load(std::memory_order_seq_cst);
  if (owner != nullptr) owner->onErrorAfterClose(stream, result);
}

bool OboeCallbackShim::detachAndDrain() {
  owner_.store(nullptr, std::memory_order_seq_cst);
  for (int attempt = 0; attempt < kAdmissionQuiesceAttempts; ++attempt) {
    if (admitted_.load(std::memory_order_seq_cst) == 0) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return admitted_.load(std::memory_order_seq_cst) == 0;
}

OboeDeviceIo::OboeDeviceIo(RealtimeMediaCore& core, ErrorHandler onError)
    : core_(core), onError_(std::move(onError)),
      shim_(std::make_shared<OboeCallbackShim>(this)) {}

OboeDeviceIo::~OboeDeviceIo() {
  stop();
  // Detach first, then drain: after this, a callback Oboe still delivers finds
  // no owner, and one already inside has left. Oboe may keep the shim alive
  // past this destructor, which is the point of it being separate.
  if (!shim_->detachAndDrain()) {
    state_.lastError = "audio callback did not leave before teardown";
  }
}

bool OboeDeviceIo::openOutput() {
  oboe::AudioStreamBuilder builder;
  builder.setDirection(oboe::Direction::Output)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
      ->setSharingMode(oboe::SharingMode::Exclusive)
      ->setFormat(oboe::AudioFormat::I16)
      ->setChannelCount(oboe::ChannelCount::Mono)
      // Take the device's native rate and convert explicitly in the engine.
      // Naming a rate here makes Oboe insert its own converting stream, so the
      // audio would be resampled twice and the engine would be reasoning about
      // a rate the hardware is not running at.
      ->setSampleRate(oboe::Unspecified)
      ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::None)
      // Communication output semantics: this is a conversation, not media
      // playback, and the routing and volume stream follow from that.
      ->setUsage(oboe::Usage::VoiceCommunication)
      ->setContentType(oboe::ContentType::Speech)
      ->setDataCallback(shim_)
      ->setErrorCallback(shim_);
  const oboe::Result result = builder.openStream(output_);
  if (result != oboe::Result::OK) {
    state_.lastError = std::string("output open: ") + oboe::convertToText(result);
    return false;
  }
  return true;
}

bool OboeDeviceIo::openInput(const DeviceStreamConfig& config) {
  oboe::AudioStreamBuilder builder;
  builder.setDirection(oboe::Direction::Input)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
      ->setSharingMode(oboe::SharingMode::Exclusive)
      ->setFormat(oboe::AudioFormat::I16)
      ->setChannelCount(oboe::ChannelCount::Mono)
      ->setSampleRate(oboe::Unspecified)
      ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::None)
      ->setInputPreset(toOboePreset(config.inputPreset))
      ->setDeviceId(config.preferredInputDeviceId)
      ->setDataCallback(shim_)
      ->setErrorCallback(shim_);
  const oboe::Result result = builder.openStream(input_);
  if (result != oboe::Result::OK) {
    state_.lastError = std::string("input open: ") + oboe::convertToText(result);
    return false;
  }
  return true;
}

bool OboeDeviceIo::start(const DeviceStreamConfig& config) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (running_.load(std::memory_order_acquire)) return true;
  state_ = DeviceStreamState{};
  if (epochOpen_.load(std::memory_order_acquire)) {
    // A previous epoch was closed by an error callback rather than by `stop`.
    // Retire it before opening new streams.
    epochOpen_.store(false, std::memory_order_release);
    awaitCallbackQuiescence();
    core_.endDeviceEpoch();
  }
  if (!openOutput() || !openInput(config)) {
    if (output_ != nullptr) output_->close();
    if (input_ != nullptr) input_->close();
    output_.reset();
    input_.reset();
    return false;
  }

  // The negotiated configuration is the fact the engine converts against. A
  // device that answers with a different rate than the one requested is normal.
  state_.inputSampleRateHz = input_->getSampleRate();
  state_.outputSampleRateHz = output_->getSampleRate();
  state_.inputBurstFrames = input_->getFramesPerBurst();
  state_.outputBurstFrames = output_->getFramesPerBurst();
  state_.inputPreset = static_cast<int32_t>(input_->getInputPreset());
  state_.inputDeviceId = input_->getDeviceId();
  state_.performanceMode = static_cast<int32_t>(output_->getPerformanceMode());
  state_.inputLatencyMs = latencyMs(input_);
  state_.outputLatencyMs = latencyMs(output_);

  if (!core_.beginDeviceEpoch(state_.inputSampleRateHz, state_.outputSampleRateHz,
                              state_.inputLatencyMs, state_.outputLatencyMs)) {
    // The engine refused this configuration — on a software-echo route that
    // means the canceller would not start. Running the streams anyway would
    // leave Talk listening with a capture gate that can never open.
    state_.lastError = "engine refused the negotiated device configuration";
    output_->close();
    input_->close();
    output_.reset();
    input_.reset();
    return false;
  }

  // The engine now holds an epoch, so a later teardown owes it an end.
  epochOpen_.store(true, std::memory_order_release);
  currentOutput_.store(output_.get(), std::memory_order_release);
  currentInput_.store(input_.get(), std::memory_order_release);
  // Armed before the first `requestStart`, because the output stream's first
  // data callback fires from inside that call. A callback that arrives before
  // the flag is set and answers `Stop` would retire the stream permanently.
  running_.store(true, std::memory_order_release);
  const oboe::Result outputStart = output_->requestStart();
  const oboe::Result inputStart = input_->requestStart();
  if (outputStart != oboe::Result::OK || inputStart != oboe::Result::OK) {
    running_.store(false, std::memory_order_release);
    currentOutput_.store(nullptr, std::memory_order_release);
    currentInput_.store(nullptr, std::memory_order_release);
    state_.lastError = std::string("stream start: ") +
                       oboe::convertToText(outputStart != oboe::Result::OK ? outputStart : inputStart);
    output_->close();
    input_->close();
    output_.reset();
    input_.reset();
    epochOpen_.store(false, std::memory_order_release);
    awaitCallbackQuiescence();
    core_.endDeviceEpoch();
    return false;
  }
  state_.running = true;
  return true;
}

void OboeDeviceIo::stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  running_.store(false, std::memory_order_release);
  currentOutput_.store(nullptr, std::memory_order_release);
  currentInput_.store(nullptr, std::memory_order_release);
  // Both callbacks are quiesced before the engine is told the epoch ended, so
  // no late callback can touch a pipeline that is being rebuilt.
  if (input_ != nullptr) {
    input_->requestStop();
    input_->close();
    input_.reset();
  }
  if (output_ != nullptr) {
    output_->requestStop();
    output_->close();
    output_.reset();
  }
  state_.running = false;
  // Ends the epoch exactly once, including after an asynchronous error close
  // that already cleared `running_`. Skipping it there would let the next start
  // replace the render timeline with barriers still queued in it, and the
  // provider would wait forever for a completion that can no longer arrive.
  // Waited for whether or not an epoch is open: the free that may follow this
  // stop needs the same guarantee.
  awaitCallbackQuiescence();
  if (epochOpen_.exchange(false, std::memory_order_acq_rel)) {
    core_.endDeviceEpoch();
  }
}



uint64_t OboeDeviceIo::presentedFrames(oboe::AudioStream* output) {
  if (output == nullptr) return 0;
  // The device's own presentation position. Where the device declines to report
  // one, the write position minus the buffer it still holds is the conservative
  // substitute: it can only under-report, so a barrier completes late rather
  // than claiming audio was heard that was not.
  const auto timestamp = output->getTimestamp(CLOCK_MONOTONIC);
  if (timestamp) return static_cast<uint64_t>(std::max<int64_t>(0, timestamp.value().position));
  const int64_t written = output->getFramesWritten();
  const int64_t buffered = output->getBufferSizeInFrames();
  return static_cast<uint64_t>(std::max<int64_t>(0, written - buffered));
}

bool OboeDeviceIo::awaitCallbackQuiescence() {
  for (int attempt = 0; attempt < kAdmissionQuiesceAttempts; ++attempt) {
    if (shim_->quiesced()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  if (!shim_->quiesced()) {
    state_.lastError = "audio callback did not leave before teardown";
    return false;
  }
  return true;
}

oboe::DataCallbackResult OboeDeviceIo::onAudioReady(oboe::AudioStream* stream, void* audioData,
                                                    int32_t numFrames) {
  const size_t frames = static_cast<size_t>(std::max(0, numFrames));
  const bool output = stream->getDirection() == oboe::Direction::Output;
  // The same identity check `onErrorAfterClose` makes, for the same reason: a
  // restart publishes the replacement streams before arming `running_`, so a
  // late callback from a stream this object has already retired matches
  // neither pointer. Letting one through would feed the pipeline that replaced
  // it — stale far-end audio into the canceller's reference, or capture from a
  // microphone this epoch does not own.
  const oboe::AudioStream* current = output ? currentOutput_.load(std::memory_order_acquire)
                                            : currentInput_.load(std::memory_order_acquire);
  // Never `Stop`: stopping is the control owner's decision, taken through
  // `requestStop`. A callback that retires its own stream leaves the engine
  // believing it has a running device that will never call back again.
  if (stream != current || !running_.load(std::memory_order_seq_cst)) {
    if (output) std::memset(audioData, 0, frames * sizeof(int16_t));
    return oboe::DataCallbackResult::Continue;
  }
  if (output) {
    core_.onRenderCallback(static_cast<int16_t*>(audioData), frames, presentedFrames(stream));
  } else {
    core_.onCaptureCallback(static_cast<const int16_t*>(audioData), frames);
  }
  return oboe::DataCallbackResult::Continue;
}

void OboeDeviceIo::onErrorAfterClose(oboe::AudioStream* stream, oboe::Result result) {
  // Reported here rather than from `onError`, because Oboe still owns the stop
  // and close at that point. Recovery that began earlier would race Oboe's own
  // teardown of the stream it is about to hand back.
  //
  // The pointer comparison is the generation check: `stop()` and a successful
  // restart both reset these, so a late callback from a stream this object has
  // already retired matches neither and is ignored instead of tearing down the
  // replacement.
  const bool input = stream->getDirection() == oboe::Direction::Input;
  const bool current = stream == currentInput_.load(std::memory_order_acquire) ||
                       stream == currentOutput_.load(std::memory_order_acquire);
  if (!current) return;
  running_.store(false, std::memory_order_release);
  core_.onStreamError(static_cast<int>(result), input);
  if (onError_) onError_(static_cast<int>(result), input);
}

DeviceStreamState OboeDeviceIo::state() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_;
}

}  // namespace openclaw::media
