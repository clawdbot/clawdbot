#ifndef OPENCLAW_MEDIA_RENDER_TIMELINE_H_
#define OPENCLAW_MEDIA_RENDER_TIMELINE_H_

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "media/media_lifetimes.h"

namespace openclaw::media {

// What happened to a playback barrier. A barrier that merely arrived, or was
// merely copied into a buffer, has not completed: the outcome is decided at the
// point the device actually presented the audio in front of it, or at the point
// the engine decided that audio will never be presented.
enum class MarkOutcome : uint8_t {
  // The device presented every sample submitted before the barrier.
  kCompleted = 0,
  // Its render generation was cancelled before the device reached it.
  kCancelled,
  // Its device clock epoch ended before the device reached it. The audio in
  // front of the barrier was never presented on any stream.
  kInvalidatedByEpoch,
  // The engine stopped with the barrier still in the stream.
  kInvalidatedByStop,
  // The stream could not accept it. Reported so a barrier never strands.
  kRejectedByOverflow,
};

struct MarkEvent {
  uint64_t markId = 0;
  MarkOutcome outcome = MarkOutcome::kCompleted;
};

struct RenderTimelineStats {
  // Session-total domain: monotonic for the engine's lifetime.
  uint64_t submittedSamples = 0;
  uint64_t presentedSamples = 0;
  uint64_t cancelledSamples = 0;
  uint64_t overflowRejectedSamples = 0;
  uint64_t overflowRejectedSubmissions = 0;
  // Silence the engine synthesised because the queue was empty while content
  // was still pending. Post-drain idle silence is counted separately, because
  // treating a finished response as starvation is how a healthy engine gets
  // diagnosed as broken.
  uint64_t starvedSilenceSamples = 0;
  uint64_t idleSilenceSamples = 0;
  uint64_t markCompletions = 0;
  uint64_t markInvalidations = 0;
  // A dropped outcome would look exactly like a barrier that never resolved,
  // so the drop is counted rather than inferred from a missing event.
  uint64_t markEventOverflows = 0;
};

// Bounded, generation-aware assistant-audio queue with in-band barriers.
//
// One producer (the control owner, submitting decoded provider audio) and one
// consumer (the device render callback). Cancellation is a single atomic store
// by the producer; the consumer drops cancelled spans as it reaches them, so a
// clear never has to reach into memory the realtime thread is reading.
//
// Barriers travel inside the span stream rather than beside it. That is what
// makes "the barrier for generation N cannot be completed by generation N+1's
// audio" true by construction instead of by a comparison someone has to
// remember to write.
class RenderTimeline {
 public:
  struct Config {
    int deviceRateHz = 48000;
    int capacityMs = 30000;
    size_t maxSpans = 2048;
  };

  explicit RenderTimeline(const Config& config);

  // --- producer side (control thread) ---

  // Returns false when the bounded queue rejects the submission; the caller
  // must surface that, never silently discard it.
  bool submitAudio(RenderContentGeneration generation, const int16_t* samples, size_t count);

  // Returns false when the barrier could not be queued; the caller must then
  // report `kRejectedByOverflow` itself rather than leave it pending forever.
  bool submitMark(RenderContentGeneration generation, uint64_t markId);

  // Discards every span at or below `generation` that the device has not
  // reached. Already-presented audio stays historical truth: it was heard, and
  // the acoustic processor's reference must keep reflecting that.
  void cancelThrough(RenderContentGeneration generation);

  // --- consumer side (device render callback, realtime) ---

  // Fills `out` with up to `count` samples, zero-filling the remainder.
  // `presentedFrames` is the device clock's epoch-local presentation position,
  // used to decide barrier completion. `contentPending` reports whether the
  // silence in this callback was starvation or ordinary post-response idle.
  struct PullResult {
    size_t audioSamples = 0;
    size_t silenceSamples = 0;
    bool contentPending = false;
  };
  PullResult pull(int16_t* out, size_t count, uint64_t presentedFrames);

  // --- lifecycle (control thread, streams stopped) ---

  // The device stream is going away. Barriers already stamped against its
  // frame-position origin are invalidated, because their target is expressed in
  // a coordinate that no longer exists. Audio and barriers still queued are not
  // touched: they are content the assistant has not finished saying, and the
  // device clock epoch is a different lifetime from the render content.
  void endEpoch();

  // A new device stream means a new frame-position origin.
  void beginEpoch(AudioDeviceClockEpoch epoch);

  // Ends the queue itself: everything unplayed is discarded and every barrier
  // resolves, because nothing behind them will ever be presented.
  void stopAndDrain();

  int deviceRateHz() const { return config_.deviceRateHz; }

  // --- observation ---

  // Drains at most `max` barrier outcomes. Returns the number written.
  size_t drainMarkEvents(MarkEvent* out, size_t max);
  RenderTimelineStats stats() const;
  size_t queuedSamples() const;

  // Epoch-local device frame index just past the most recent callback that
  // carried assistant audio. "Is the assistant still audible" is this compared
  // with the device's presentation position — never the total frames handed to
  // the device, which stays permanently ahead of presentation by one buffer.
  uint64_t audioEndFrame() const;

 private:
  enum class SpanKind : uint8_t { kAudio = 0, kMark };

  struct Span {
    SpanKind kind = SpanKind::kAudio;
    uint64_t generation = 0;
    uint64_t begin = 0;   // absolute submitted-sample index
    uint32_t length = 0;  // samples, zero for barriers
    uint64_t markId = 0;
  };

  struct PendingMark {
    uint64_t markId = 0;
    uint64_t targetPresentedFrames = 0;
    uint64_t epoch = 0;
    // Carried so a cancellation that arrives after the consumer reached this
    // barrier still reaches it. Once a barrier leaves the span stream it is no
    // longer covered by the span-level generation check.
    uint64_t generation = 0;
    bool active = false;
  };

  bool pushEvent(uint64_t markId, MarkOutcome outcome);
  void retirePendingMarks(MarkOutcome outcome);

  const Config config_;
  const size_t capacitySamples_;

  std::vector<int16_t> ring_;
  std::vector<Span> spans_;

  // Monotonic counters, session-total domain. The producer owns the write
  // cursors and the consumer owns the read cursors; both are published with
  // release stores so the other side sees the samples before the span.
  std::atomic<uint64_t> writeSamples_{0};
  std::atomic<uint64_t> readSamples_{0};
  std::atomic<uint64_t> spanWrite_{0};
  std::atomic<uint64_t> spanRead_{0};
  std::atomic<uint64_t> cancelThrough_{0};
  std::atomic<uint64_t> epoch_{0};

  // Consumer-private cursors. `deviceWrittenFrames_` is epoch-local: it counts
  // frames handed to the current device stream, which is the coordinate a
  // barrier target is expressed in. Comparing it with anything from another
  // epoch is exactly the cross-coordinate error this engine is built to avoid.
  size_t spanOffset_ = 0;
  uint64_t deviceWrittenFrames_ = 0;

  static constexpr size_t kMaxPendingMarks = 64;
  std::array<PendingMark, kMaxPendingMarks> pendingMarks_{};

  static constexpr size_t kMaxEvents = 256;
  std::array<MarkEvent, kMaxEvents> events_{};
  std::atomic<uint64_t> eventWrite_{0};
  std::atomic<uint64_t> eventRead_{0};

  // Counters are written by whichever side owns the fact and read by the
  // observation drain, so they are relaxed atomics rather than plain fields.
  std::atomic<uint64_t> submittedSamples_{0};
  std::atomic<uint64_t> presentedSamples_{0};
  std::atomic<uint64_t> cancelledSamples_{0};
  std::atomic<uint64_t> overflowRejectedSamples_{0};
  std::atomic<uint64_t> overflowRejectedSubmissions_{0};
  std::atomic<uint64_t> starvedSilenceSamples_{0};
  std::atomic<uint64_t> idleSilenceSamples_{0};
  std::atomic<uint64_t> markCompletions_{0};
  std::atomic<uint64_t> markInvalidations_{0};
  std::atomic<uint64_t> markEventOverflows_{0};
  std::atomic<uint64_t> audioEndFrame_{0};
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_RENDER_TIMELINE_H_
