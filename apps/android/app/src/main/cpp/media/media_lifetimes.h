#ifndef OPENCLAW_MEDIA_MEDIA_LIFETIMES_H_
#define OPENCLAW_MEDIA_MEDIA_LIFETIMES_H_

#include <atomic>
#include <cstdint>

namespace openclaw::media {

// Five independent lifetimes. Collapsing any pair of them is the defect class
// this type exists to prevent: a response boundary that resets echo adaptation,
// a stream restart that revives cancelled assistant audio, a readiness change
// that retroactively authorises already-captured microphone audio. Each domain
// is advanced by exactly one owner, named below.
enum class LifetimeDomain : uint8_t {
  // Owns the adaptive state inside the acoustic processor. Advanced only when
  // that state stops describing the room (route change, reference loss).
  kAcousticProcessor = 0,
  // Owns one device stream's frame-position origin. Advanced on every open,
  // restart, or reconfiguration of a device stream.
  kAudioDeviceClockEpoch,
  // Owns which assistant PCM is still valid to play. Advanced on clear/cancel.
  kRenderContent,
  // Owns whether captured ranges may leave the endpoint. Advanced when the
  // duplex decision changes.
  kCaptureUplinkEligibility,
  // Owns provider conversational response identity. Advanced by the provider
  // turn, never by the media layer.
  kProviderTurn,
  kCount,
};

// A generation is only comparable inside its own domain. The domain tag makes a
// cross-domain comparison a compile error rather than a plausible-looking bug.
template <LifetimeDomain Domain>
class Generation {
 public:
  Generation() = default;
  explicit constexpr Generation(uint64_t value) : value_(value) {}

  constexpr uint64_t value() const { return value_; }
  constexpr bool operator==(const Generation& other) const { return value_ == other.value_; }
  constexpr bool operator!=(const Generation& other) const { return value_ != other.value_; }
  constexpr bool operator<=(const Generation& other) const { return value_ <= other.value_; }
  constexpr bool operator<(const Generation& other) const { return value_ < other.value_; }

 private:
  uint64_t value_ = 0;
};

using AcousticProcessorLifetime = Generation<LifetimeDomain::kAcousticProcessor>;
using AudioDeviceClockEpoch = Generation<LifetimeDomain::kAudioDeviceClockEpoch>;
using RenderContentGeneration = Generation<LifetimeDomain::kRenderContent>;
using CaptureUplinkEligibilityGeneration = Generation<LifetimeDomain::kCaptureUplinkEligibility>;
using ProviderTurnGeneration = Generation<LifetimeDomain::kProviderTurn>;

// Lock-free counter for one domain. Realtime callbacks read it; the control
// owner advances it.
template <typename GenerationType>
class GenerationCounter {
 public:
  GenerationType current() const { return GenerationType(value_.load(std::memory_order_acquire)); }

  GenerationType advance() {
    return GenerationType(value_.fetch_add(1, std::memory_order_acq_rel) + 1);
  }

 private:
  std::atomic<uint64_t> value_{1};
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_MEDIA_LIFETIMES_H_
