#ifndef OPENCLAW_MEDIA_FRAME_ADAPTER_H_
#define OPENCLAW_MEDIA_FRAME_ADAPTER_H_

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace openclaw::media {

// Device callbacks deliver whatever burst size the audio HAL chose; the
// acoustic processor accepts exactly one 10 ms frame. This adapter is the only
// place the two meet, so eligibility and generation semantics never depend on
// how many samples a particular device handed us.
//
// It never duplicates, loses, or reorders a sample. The one sample-dropping
// operation is `reset()`, which exists because a partial frame must not be
// stitched onto audio from a different generation or device clock epoch.
class FrameAdapter {
 public:
  explicit FrameAdapter(int frameSamples) : frameSamples_(static_cast<size_t>(frameSamples)) {
    pending_.reserve(frameSamples_ * 2);
  }

  size_t frameSamples() const { return frameSamples_; }
  size_t pendingSamples() const { return pending_.size(); }

  // Calls `sink(const int16_t* frame, size_t frameSamples)` once per complete
  // frame, in order.
  template <typename Sink>
  void push(const int16_t* samples, size_t count, Sink&& sink) {
    size_t consumed = 0;
    while (consumed < count) {
      const size_t need = frameSamples_ - pending_.size();
      const size_t take = std::min(need, count - consumed);
      pending_.insert(pending_.end(), samples + consumed, samples + consumed + take);
      consumed += take;
      if (pending_.size() == frameSamples_) {
        sink(pending_.data(), frameSamples_);
        pending_.clear();
      }
    }
  }

  // Hands back the partial frame and clears it, for a caller that must place
  // something after every sample submitted so far. Returns 0 when there is
  // nothing pending.
  size_t takePending(const int16_t** samples) {
    if (pending_.empty()) return 0;
    *samples = pending_.data();
    return pending_.size();
  }

  // Drops the partial frame. Carrying it across a generation or epoch boundary
  // would splice two unrelated timelines into one processor frame.
  //
  // The samples are overwritten, not merely forgotten: a caller holding the
  // pointer `takePending` handed out must not be able to read audio this
  // engine has decided will never be heard again.
  void reset() {
    std::fill(pending_.begin(), pending_.end(), 0);
    pending_.clear();
  }

 private:
  const size_t frameSamples_;
  std::vector<int16_t> pending_;
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_FRAME_ADAPTER_H_
