#ifndef OPENCLAW_MEDIA_RESAMPLE_LANE_H_
#define OPENCLAW_MEDIA_RESAMPLE_LANE_H_

#include <algorithm>
#include <cstdint>
#include <memory>
#include <vector>

#include "common_audio/resampler/include/push_resampler.h"

namespace openclaw::media {

// One direction of rate conversion between two of the engine's four rate
// domains, sized for exactly one 10 ms frame.
//
// The converter itself is upstream's `PushResampler`, which carries the filter
// history that makes consecutive frames phase-continuous. That history is the
// reason a lane is owned by a generation: replaying it across a clear, a device
// clock epoch, or an acoustic reset would leak the tail of audio that the
// engine has already decided must never be heard again.
class ResampleLane {
 public:
  ResampleLane(int sourceRateHz, int targetRateHz)
      : sourceRateHz_(sourceRateHz),
        targetRateHz_(targetRateHz),
        sourceFrameSamples_(static_cast<size_t>(sourceRateHz / 100)),
        targetFrameSamples_(static_cast<size_t>(targetRateHz / 100)) {
    if (needsConversion()) {
      resampler_ = std::make_unique<webrtc::PushResampler<int16_t>>(sourceFrameSamples_,
                                                                   targetFrameSamples_, 1);
    }
    output_.resize(targetFrameSamples_);
  }

  bool needsConversion() const { return sourceRateHz_ != targetRateHz_; }
  size_t sourceFrameSamples() const { return sourceFrameSamples_; }
  size_t targetFrameSamples() const { return targetFrameSamples_; }

  // Converts exactly one source frame. The returned span is valid until the
  // next call. Passing a frame of any other length is a programming error the
  // caller prevents with FrameAdapter.
  const int16_t* convert(const int16_t* frame, size_t frameSamples) {
    if (frameSamples != sourceFrameSamples_) return nullptr;
    if (!needsConversion()) return frame;
    resampler_->Resample(webrtc::MonoView<const int16_t>(frame, sourceFrameSamples_),
                         webrtc::MonoView<int16_t>(output_.data(), targetFrameSamples_));
    return output_.data();
  }

  // Converts a partial frame by zero-padding it to a whole one and reporting
  // only the samples the tail itself produced.
  //
  // A barrier must not be placed ahead of audio that was already submitted, so
  // when one arrives with a partial frame still pending, that frame has to
  // reach the timeline first. Padding to a frame boundary and keeping the pad
  // would insert audible silence — the provider emits a barrier after every
  // audio delta — so the pad is dropped and only the tail's own output is
  // kept. The filter sees a real discontinuity there, which is a few samples
  // of imprecision at a boundary the listener hears as one continuous word.
  const int16_t* convertPartial(const int16_t* samples, size_t count, size_t* outCount) {
    if (count == 0 || count >= sourceFrameSamples_) return nullptr;
    *outCount = (count * targetFrameSamples_) / sourceFrameSamples_;
    if (*outCount == 0) return nullptr;
    if (!needsConversion()) return samples;
    padded_.assign(sourceFrameSamples_, 0);
    std::copy(samples, samples + count, padded_.begin());
    resampler_->Resample(webrtc::MonoView<const int16_t>(padded_.data(), sourceFrameSamples_),
                         webrtc::MonoView<int16_t>(output_.data(), targetFrameSamples_));
    return output_.data();
  }

  // Discards the filter history. Called at every boundary that makes the tail
  // of the previous audio invalid, never merely because the stream paused.
  void reset() {
    if (!needsConversion()) return;
    resampler_ = std::make_unique<webrtc::PushResampler<int16_t>>(sourceFrameSamples_,
                                                                 targetFrameSamples_, 1);
  }

 private:
  const int sourceRateHz_;
  const int targetRateHz_;
  const size_t sourceFrameSamples_;
  const size_t targetFrameSamples_;
  std::unique_ptr<webrtc::PushResampler<int16_t>> resampler_;
  std::vector<int16_t> output_;
  std::vector<int16_t> padded_;
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_RESAMPLE_LANE_H_
