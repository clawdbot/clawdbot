#ifndef OPENCLAW_MEDIA_SAMPLE_RING_H_
#define OPENCLAW_MEDIA_SAMPLE_RING_H_

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace openclaw::media {

// Single-producer/single-consumer PCM ring with a declared capacity and a
// declared overflow policy. Every realtime queue in this engine goes through
// this type so "how many samples can back up here, and what happens when they
// do" is answerable for each of them without reading the call sites.
enum class RingOverflowPolicy : uint8_t {
  // Keeps what is already queued and refuses the new samples. Correct where
  // ordering matters more than freshness (assistant playback).
  kRejectNewest = 0,
  // Prefers fresh samples: the producer asks for room and the consumer makes
  // it on its next read. The producer never moves the read cursor itself —
  // doing so would overwrite slots the consumer might be mid-copy, which
  // corrupts exactly the samples backpressure was supposed to protect.
  kDropOldest,
};

class SampleRing {
 public:
  SampleRing(size_t capacitySamples, RingOverflowPolicy policy)
      : capacity_(capacitySamples), policy_(policy), buffer_(capacitySamples, 0) {}

  size_t capacity() const { return capacity_; }
  size_t size() const {
    return static_cast<size_t>(write_.load(std::memory_order_acquire) -
                               read_.load(std::memory_order_acquire));
  }
  uint64_t droppedSamples() const { return dropped_.load(std::memory_order_relaxed); }
  uint64_t rejectedSamples() const { return rejected_.load(std::memory_order_relaxed); }

  // Producer side. Returns the number of samples accepted.
  size_t write(const int16_t* samples, size_t count) {
    if (count == 0) return 0;
    uint64_t write = write_.load(std::memory_order_relaxed);
    uint64_t read = read_.load(std::memory_order_acquire);
    const size_t free = capacity_ - static_cast<size_t>(write - read);
    if (count > free) {
      if (policy_ == RingOverflowPolicy::kRejectNewest) {
        rejected_.fetch_add(count, std::memory_order_relaxed);
        return 0;
      }
      // Ask the consumer to make room and refuse this write. The consumer
      // applies the request before its next read, so the following writes fit;
      // the read cursor stays under one owner throughout.
      pendingDrop_.fetch_add(count - free, std::memory_order_release);
      dropped_.fetch_add(count, std::memory_order_relaxed);
      return 0;
    }
    const size_t offset = static_cast<size_t>(write % capacity_);
    const size_t first = std::min(count, capacity_ - offset);
    std::memcpy(buffer_.data() + offset, samples, first * sizeof(int16_t));
    if (first < count) {
      std::memcpy(buffer_.data(), samples + first, (count - first) * sizeof(int16_t));
    }
    write_.store(write + count, std::memory_order_release);
    return count;
  }

  // Consumer side. Returns the number of samples read.
  size_t read(int16_t* out, size_t count) {
    uint64_t read = read_.load(std::memory_order_relaxed);
    // Apply any drop the producer asked for, on the side that owns the cursor.
    const uint64_t requested = pendingDrop_.exchange(0, std::memory_order_acquire);
    if (requested > 0) {
      const uint64_t queued = write_.load(std::memory_order_acquire) - read;
      read += std::min<uint64_t>(requested, queued);
      read_.store(read, std::memory_order_release);
    }
    const uint64_t write = write_.load(std::memory_order_acquire);
    const size_t available = static_cast<size_t>(write - read);
    const size_t take = std::min(count, available);
    if (take == 0) return 0;
    const size_t offset = static_cast<size_t>(read % capacity_);
    const size_t first = std::min(take, capacity_ - offset);
    std::memcpy(out, buffer_.data() + offset, first * sizeof(int16_t));
    if (first < take) {
      std::memcpy(out + first, buffer_.data(), (take - first) * sizeof(int16_t));
    }
    read_.store(read + take, std::memory_order_release);
    return take;
  }

  void clear() {
    read_.store(write_.load(std::memory_order_acquire), std::memory_order_release);
    // A drop the producer asked for applies to samples that are being discarded
    // here anyway. Left set, it would be charged to the first samples written
    // after the clear, throwing away fresh reference audio the canceller needs.
    pendingDrop_.store(0, std::memory_order_release);
  }

 private:
  const size_t capacity_;
  const RingOverflowPolicy policy_;
  std::vector<int16_t> buffer_;
  std::atomic<uint64_t> write_{0};
  std::atomic<uint64_t> read_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<uint64_t> pendingDrop_{0};
  std::atomic<uint64_t> rejected_{0};
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_SAMPLE_RING_H_
