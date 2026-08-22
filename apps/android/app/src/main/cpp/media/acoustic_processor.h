#ifndef OPENCLAW_MEDIA_ACOUSTIC_PROCESSOR_H_
#define OPENCLAW_MEDIA_ACOUSTIC_PROCESSOR_H_

#include <cstdint>
#include <memory>
#include <string>

#include "media/media_lifetimes.h"

namespace openclaw::media {

// Who is responsible for keeping the assistant's own voice out of the uplink on
// the current route. Exactly one owner at a time: stacking the platform's voice
// pipeline underneath a software canceller gives the software canceller a
// far-end reference that no longer matches what the microphone hears.
//
// A platform effect reporting `enabled == true` is a capability bit, not a
// measurement. It never promotes a route to full duplex here.
enum class EchoControlOwner : uint8_t {
  kNone = 0,
  kPlatformVoiceCommunication,
  kSoftwareAcousticProcessor,
};

// Why the adaptive state was thrown away. Recorded at the boundary that owns
// the decision so nobody has to infer it later from three other counters.
enum class AcousticResetReason : uint8_t {
  kEngineStart = 0,
  kRouteChanged,
  kDeviceClockEpochChanged,
  kReferenceTimelineLost,
  kProcessorFault,
};

struct AcousticProcessorStats {
  bool active = false;
  uint64_t lifetime = 0;
  // Processor-lifetime domain: cleared with the adaptive state it describes.
  uint64_t renderFramesProcessed = 0;
  uint64_t captureFramesProcessed = 0;
  uint64_t referenceUnderrunFrames = 0;
  // Engine-total domain, deliberately: "how many times has this session had to
  // rebuild its canceller" is the question worth answering, and a count cleared
  // by the very event it counts could only ever read zero or one.
  uint64_t resets = 0;
  uint64_t faults = 0;
  // Upstream `AudioProcessingStats`. Absent values stay absent: an unset echo
  // metric means the processor has not measured one, which is different from
  // measuring zero.
  bool hasEchoReturnLoss = false;
  double echoReturnLossDb = 0;
  bool hasEchoReturnLossEnhancement = false;
  double echoReturnLossEnhancementDb = 0;
  bool hasDelayMs = false;
  int32_t delayMs = 0;
  bool hasResidualEchoLikelihood = false;
  double residualEchoLikelihood = 0;
};

// Owns one WebRTC `AudioProcessing` instance and the adaptive state inside it.
//
// The whole processor is driven from the capture callback: the render callback
// only copies what it handed the device into a reference ring, and the capture
// callback drains that ring into `ProcessReverseStream` immediately before the
// matching `ProcessStream`. That keeps upstream's required render-then-capture
// order without a lock on either realtime thread.
class AcousticProcessor {
 public:
  AcousticProcessor();
  ~AcousticProcessor();

  AcousticProcessor(const AcousticProcessor&) = delete;
  AcousticProcessor& operator=(const AcousticProcessor&) = delete;

  // `captureRateHz` and `renderRateHz` must be processor-native rates.
  bool start(int captureRateHz, int renderRateHz, AcousticResetReason reason);
  void stop();
  bool active() const;
  AcousticProcessorLifetime lifetime() const { return lifetime_; }

  // Discards the adaptive state and starts a new processor lifetime. A normal
  // assistant response boundary is not a reason to call this: the room did not
  // change between two sentences, and re-converging costs the first seconds of
  // the next response.
  void resetAdaptation(AcousticResetReason reason);

  // One 10 ms far-end frame at the render rate.
  void processRenderReference(const int16_t* frame);
  void recordReferenceUnderrun(size_t frames);

  // One 10 ms near-end frame at the capture rate, processed in place.
  // `streamDelayMs` seeds upstream's render delay buffer after a reset; the
  // internal estimator still owns the operating delay.
  bool processCapture(int16_t* frame, int streamDelayMs);

  // True once the processor has both directions flowing and has published a
  // delay estimate, which is upstream's own signal that the echo path has been
  // located rather than a timer someone picked.
  bool echoPathLocated() const;

  AcousticProcessorStats stats() const;
  const std::string& lastError() const { return lastError_; }

 private:
  void refreshStatsCache();

  // The upstream reference is held behind a pimpl so the engine's own headers
  // stay free of the WebRTC include tree; only this translation unit and the
  // synthetic-echo tests need it.
  struct Impl;
  std::unique_ptr<Impl> impl_;

  GenerationCounter<AcousticProcessorLifetime> lifetimeCounter_;
  AcousticProcessorLifetime lifetime_{0};
  std::string lastError_;
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_ACOUSTIC_PROCESSOR_H_
