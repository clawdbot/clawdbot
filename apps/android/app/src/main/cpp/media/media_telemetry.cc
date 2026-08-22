#include "media/media_telemetry.h"

namespace openclaw::media {

void MediaTelemetry::record(MediaEventKind kind, int64_t detailA, int64_t detailB,
                            int64_t monotonicNanos) {
  // Both realtime callbacks and the control thread record here. A slot is
  // claimed with a bounded compare-exchange rather than a blind increment: a
  // blind increment past a full ring never recovers, which would turn a single
  // burst into permanent silence from the diagnostics surface.
  uint64_t write = write_.load(std::memory_order_relaxed);
  for (;;) {
    if (write - read_.load(std::memory_order_acquire) >= kCapacity) {
      dropped_.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    if (write_.compare_exchange_weak(write, write + 1, std::memory_order_acq_rel,
                                     std::memory_order_relaxed)) {
      break;
    }
  }
  const uint64_t sequence = sequence_.fetch_add(1, std::memory_order_relaxed) + 1;
  Slot& slot = slots_[static_cast<size_t>(write % kCapacity)];
  slot.event = MediaEvent{kind, static_cast<uint32_t>(sequence), monotonicNanos, detailA, detailB};
  // Publish last: the drain treats a stamp mismatch as "not written yet" and
  // stops, so a claimed-but-unfilled slot is never read as an event.
  slot.stamp.store(write + 1, std::memory_order_release);
}

size_t MediaTelemetry::drain(MediaEvent* out, size_t max) {
  size_t written = 0;
  uint64_t read = read_.load(std::memory_order_relaxed);
  const uint64_t write = write_.load(std::memory_order_acquire);
  while (read < write && written < max) {
    Slot& slot = slots_[static_cast<size_t>(read % kCapacity)];
    if (slot.stamp.load(std::memory_order_acquire) != read + 1) break;
    out[written++] = slot.event;
    ++read;
  }
  read_.store(read, std::memory_order_release);
  return written;
}

}  // namespace openclaw::media
