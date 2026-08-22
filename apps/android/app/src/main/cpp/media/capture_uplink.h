#ifndef OPENCLAW_MEDIA_CAPTURE_UPLINK_H_
#define OPENCLAW_MEDIA_CAPTURE_UPLINK_H_

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "media/media_lifetimes.h"

namespace openclaw::media {

// Eligibility belongs to the captured range, not to the moment the range is
// sent. The snapshot is taken before the frame is processed, so a frame that
// itself causes NOT_READY -> READY stays under the old decision and the next
// frame is the first that can leave the endpoint.
struct CaptureEligibility {
  uint64_t generation = 0;
  bool eligibleAtCapture = false;
};

enum class UplinkDisposition : uint8_t {
  kSent = 0,
  // Refused by the capture-time decision. Recorded, never held for later.
  kDroppedIneligibleAtCapture,
  // The duplex decision changed between capture and send. The frame was judged
  // safe under assumptions that no longer hold, so it is dropped rather than
  // sent under a decision it was never measured against.
  kDroppedEligibilityChanged,
  // The send-time permission is closed right now.
  kDroppedSendGateClosed,
  // The bounded queue discarded it before the control thread got there.
  kDroppedQueueOverflow,
};

struct CaptureUplinkStats {
  uint64_t capturedFrames = 0;
  uint64_t processedFrames = 0;
  uint64_t eligibleFrames = 0;
  uint64_t droppedIneligibleAtCapture = 0;
  uint64_t droppedEligibilityChanged = 0;
  uint64_t droppedSendGateClosed = 0;
  uint64_t droppedQueueOverflow = 0;
  uint64_t sentFrames = 0;
};

// Bounded uplink queue of fixed-size wire frames, each carrying the immutable
// decision made about it at capture time.
//
// Overflow drops the oldest frame: the consumer is a realtime peer, and a
// second-old microphone frame has no value to turn detection. The drop is
// counted, because an uplink that silently thins out looks identical to a user
// who stopped talking.
class CaptureUplinkQueue {
 public:
  CaptureUplinkQueue(size_t frameSamples, size_t capacityFrames);

  // Producer (capture callback). Returns false when the queue was full: the
  // frame is refused and the consumer is asked to retire its oldest, so the
  // next frames fit. Freshness is preferred without the producer ever moving
  // the consumer's cursor.
  bool offer(const CaptureEligibility& eligibility, uint64_t captureFrameIndex,
             AudioDeviceClockEpoch epoch, const int16_t* samples);

  struct Dequeued {
    UplinkDisposition disposition = UplinkDisposition::kSent;
    uint64_t captureFrameIndex = 0;
    uint64_t epoch = 0;
    const int16_t* samples = nullptr;
    size_t sampleCount = 0;
  };

  // Consumer (control thread). Applies the send-time gate on top of the
  // immutable capture-time decision: a frame leaves only when both agree.
  // Returns false when the queue is empty. The returned pointer stays valid
  // until the next call to `next`.
  bool next(CaptureUplinkEligibilityGeneration currentGeneration, bool sendPermitted,
            Dequeued* out);

  void reset();
  CaptureUplinkStats stats() const;
  void recordCaptured();
  void recordProcessed();
  size_t frameSamples() const { return frameSamples_; }

 private:
  struct Slot {
    CaptureEligibility eligibility;
    uint64_t captureFrameIndex = 0;
    uint64_t epoch = 0;
  };

  const size_t frameSamples_;
  const size_t capacityFrames_;
  std::vector<int16_t> samples_;
  std::vector<Slot> slots_;
  std::vector<int16_t> scratch_;

  std::atomic<uint64_t> write_{0};
  std::atomic<uint64_t> read_{0};
  std::atomic<uint64_t> pendingDrop_{0};

  std::atomic<uint64_t> capturedFrames_{0};
  std::atomic<uint64_t> processedFrames_{0};
  std::atomic<uint64_t> eligibleFrames_{0};
  std::atomic<uint64_t> droppedIneligibleAtCapture_{0};
  std::atomic<uint64_t> droppedEligibilityChanged_{0};
  std::atomic<uint64_t> droppedSendGateClosed_{0};
  std::atomic<uint64_t> droppedQueueOverflow_{0};
  std::atomic<uint64_t> sentFrames_{0};
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_CAPTURE_UPLINK_H_
