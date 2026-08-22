#ifndef OPENCLAW_MEDIA_MEDIA_TELEMETRY_H_
#define OPENCLAW_MEDIA_MEDIA_TELEMETRY_H_

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace openclaw::media {

// Transitions the engine records at the boundary that owns them. Sampled
// counters cannot answer "when did readiness change" — they can only say what
// was true at two unrelated moments — so every transition that a decision
// depends on is emitted here as its own event.
enum class MediaEventKind : uint16_t {
  kEngineStarted = 0,
  kEngineStopped,
  kDeviceEpochBegan,
  kDeviceEpochEnded,
  kReadinessChanged,
  kRouteChanged,
  kAcousticProcessorStarted,
  kAcousticProcessorReset,
  kAcousticProcessorFault,
  kRenderGenerationBegan,
  kRenderCleared,
  kCaptureEligibilityChanged,
  kReferenceTimelineUnderrun,
  kRenderQueueOverflow,
  kUplinkQueueOverflow,
  kStreamError,
  kFallbackEngaged,
  // A device callback was still inside the pipeline when teardown asked it to
  // leave. The state it owns is left untouched rather than mutated under it.
  kPipelineQuiesceTimeout,
};

// One event. `detailA`/`detailB` carry the domain-tagged values the reader
// needs (previous/next state, generation, reason code) rather than a formatted
// string, so no realtime path has to build text.
struct MediaEvent {
  MediaEventKind kind = MediaEventKind::kEngineStarted;
  uint32_t sequence = 0;
  int64_t monotonicNanos = 0;
  int64_t detailA = 0;
  int64_t detailB = 0;
};

// Bounded single-producer-per-thread event ring. Overflow is counted, not
// silently absorbed: a diagnostics surface that can lose events without saying
// so turns "no event" into an unusable observation.
class MediaTelemetry {
 public:
  void record(MediaEventKind kind, int64_t detailA, int64_t detailB, int64_t monotonicNanos);
  size_t drain(MediaEvent* out, size_t max);
  uint64_t droppedEvents() const { return dropped_.load(std::memory_order_relaxed); }
  uint64_t recordedEvents() const { return sequence_.load(std::memory_order_relaxed); }

 private:
  struct Slot {
    // Zero means "never written". A claimed slot only becomes readable once its
    // producer stamps it, so a drain racing a producer stops at the gap instead
    // of reporting an empty event as a real one.
    std::atomic<uint64_t> stamp{0};
    MediaEvent event;
  };

  static constexpr size_t kCapacity = 512;
  std::array<Slot, kCapacity> slots_{};
  std::atomic<uint64_t> write_{0};
  std::atomic<uint64_t> read_{0};
  std::atomic<uint64_t> sequence_{0};
  std::atomic<uint64_t> dropped_{0};
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_MEDIA_TELEMETRY_H_
