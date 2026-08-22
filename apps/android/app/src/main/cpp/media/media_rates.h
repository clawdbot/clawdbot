#ifndef OPENCLAW_MEDIA_MEDIA_RATES_H_
#define OPENCLAW_MEDIA_MEDIA_RATES_H_

#include <cstdint>

namespace openclaw::media {

// Four independent rates. A Xiaomi 11T Pro opened a 24 kHz AudioRecord that ran
// and produced only zero samples, so "requested" and "actual" are not the same
// fact either; the engine records both and converts explicitly rather than
// asserting equality anywhere.
struct MediaRates {
  // What the provider protocol carries, both directions.
  int wireInputHz = 24000;
  int wireOutputHz = 24000;
  // What the app asked the device for.
  int requestedDeviceInputHz = 48000;
  int requestedDeviceOutputHz = 48000;
  // What the device actually negotiated. Filled in after the streams open.
  int deviceInputHz = 0;
  int deviceOutputHz = 0;
  // What the acoustic processor runs at. Chosen from the negotiated device rate
  // so the common case needs no conversion in front of the processor.
  int apmCaptureHz = 48000;
  int apmRenderHz = 48000;
};

// The acoustic processor has native rates; feeding it anything else makes it
// resample internally, which is the framework resampling we are trying to keep
// explicit. Map a negotiated device rate onto the nearest native rate at or
// above it, which is what upstream's own band splitting expects.
constexpr int kApmNativeRates[] = {16000, 32000, 48000};

inline int chooseApmRate(int deviceRateHz) {
  if (deviceRateHz <= 16000) return 16000;
  if (deviceRateHz <= 32000) return 32000;
  return 48000;
}

// The processor's frame is 10 ms; upstream states this as
// `AudioProcessing::GetFrameSize(rate) == rate / 100`.
constexpr int kApmFrameMs = 10;

inline int apmFrameSamples(int rateHz) { return rateHz / 100; }

// A rate the engine can frame exactly. Everything here is expressed in whole
// 10 ms frames — the processor's frame, the adapter's frame, the resampler's
// input and output — so a rate with a fractional frame (22 050 Hz is 220.5
// samples) would be processed at a slightly wrong clock and drift the capture
// and render timelines apart over a call. Such a rate is refused rather than
// approximated; the engine then falls back to half duplex, which does not
// depend on the two timelines agreeing.
inline bool rateHasWholeFrame(int rateHz) { return rateHz > 0 && rateHz % 100 == 0; }

inline int64_t samplesToMillis(int64_t samples, int rateHz) {
  return rateHz > 0 ? (samples * 1000) / rateHz : 0;
}

inline int64_t millisToSamples(int64_t millis, int rateHz) { return (millis * rateHz) / 1000; }

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_MEDIA_RATES_H_
