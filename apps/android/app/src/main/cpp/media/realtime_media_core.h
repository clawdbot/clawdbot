#ifndef OPENCLAW_MEDIA_REALTIME_MEDIA_CORE_H_
#define OPENCLAW_MEDIA_REALTIME_MEDIA_CORE_H_

#include <memory>
#include <mutex>
#include <vector>

#include "media/acoustic_processor.h"
#include "media/capture_uplink.h"
#include "media/frame_adapter.h"
#include "media/media_lifetimes.h"
#include "media/media_rates.h"
#include "media/media_telemetry.h"
#include "media/render_timeline.h"
#include "media/resample_lane.h"
#include "media/sample_ring.h"

namespace openclaw::media {

// How the current acoustic route behaves, decided by the platform layer that
// can actually see the route and passed in as a fact.
//
// The distinction that matters is which output the assistant's voice leaves
// from, because that decides whether the microphone hears it. The shipped iOS
// client draws the same line: it suppresses the microphone during output only
// when the route contains the built-in speaker, and keeps barge-in on every
// other output.
enum class RouteEchoProfile : uint8_t {
  // Route not established yet. Treated as coupled, because guessing the
  // permissive answer here is what puts the assistant's voice on the uplink.
  kUnknown = 0,
  // Headset, wired or Bluetooth: the device's own voice pipeline owns echo
  // control and the acoustic coupling into the microphone is negligible.
  kDeviceOwnedVoiceProcessing,
  // Handset receiver. Held at the ear, so the same reasoning as a headset.
  kBuiltInEarpiece,
  // Loudspeaker. The assistant's voice reaches the microphone acoustically;
  // software echo control owns this route.
  kBuiltInSpeaker,
};

// Where the media pipeline is in bringing full duplex up. Every transition is
// emitted as its own telemetry event; none of these states is inferred from a
// timer or from a periodic counter sample.
enum class MediaReadiness : uint8_t {
  kStopped = 0,
  kStarting,
  // Streams are open but the device clock has not produced a usable
  // presentation position yet, so nothing that depends on media timing is safe.
  kDeviceSyncing,
  // Software echo control is running but has not located the echo path.
  kAecPriming,
  // Everything the engine can verify from current facts holds.
  kFullDuplexReady,
};

struct EngineConfig {
  MediaRates rates;
  int renderCapacityMs = 30000;
  int uplinkCapacityMs = 1500;
  int referenceCapacityMs = 400;
};

struct MediaSnapshot {
  MediaReadiness readiness = MediaReadiness::kStopped;
  RouteEchoProfile route = RouteEchoProfile::kUnknown;
  EchoControlOwner echoControlOwner = EchoControlOwner::kNone;
  bool renderPresenting = false;
  bool captureEligibleNow = false;
  MediaRates rates;
  uint64_t deviceClockEpoch = 0;
  uint64_t renderContentGeneration = 0;
  uint64_t captureEligibilityGeneration = 0;
  uint64_t acousticProcessorLifetime = 0;
  int measuredStreamDelayMs = -1;
  RenderTimelineStats render;
  CaptureUplinkStats capture;
  AcousticProcessorStats acoustic;
  uint64_t referenceRingDroppedSamples = 0;
  uint64_t telemetryDroppedEvents = 0;
  // Smoothed envelopes in thousandths, for the Talk waveform. The UI drew these
  // from the old in-manager playback path; the engine owns the buffers now, so
  // it owns the levels too rather than leaving the waveform to guess.
  int renderLevelMilli = 0;
  int captureLevelMilli = 0;
};

// The device-independent half of the Android realtime media engine.
//
// It owns the media clock, the render and capture timelines, framing,
// conversion, echo processing, capture eligibility and the five lifetimes. It
// knows nothing about Oboe, JNI, Gateway framing or any provider, which is what
// lets the whole contract be exercised on a host with synthetic audio.
class RealtimeMediaCore {
 public:
  RealtimeMediaCore();
  ~RealtimeMediaCore();

  RealtimeMediaCore(const RealtimeMediaCore&) = delete;
  RealtimeMediaCore& operator=(const RealtimeMediaCore&) = delete;

  // --- control thread ---

  bool start(const EngineConfig& config, RouteEchoProfile route);
  void stop();
  bool started() const;

  // Called once per device stream generation, after both streams report their
  // negotiated configuration. A negotiated rate that differs from the requested
  // one is a fact to convert against, not an error.
  // Returns false when the pipeline could not be brought up for this epoch —
  // most importantly when the route needs software echo control and the
  // processor would not start. The caller must not run streams in that state.
  bool beginDeviceEpoch(int deviceInputHz, int deviceOutputHz, int inputLatencyMs,
                        int outputLatencyMs);
  void endDeviceEpoch();

  // True when `stop()` proved no callback was left inside. An engine that
  // answers false must not be destroyed: the memory is still reachable from a
  // realtime thread that did not come back out.
  bool pipelineQuiesced() const { return pipelineQuiesced_.load(std::memory_order_acquire); }

  // Breaks uplink send-continuity, so the next frame is reported as following a
  // gap. The consumer calls this when it discards a frame the engine already
  // counted as sent.
  void breakUplinkContinuity();

  // A route change invalidates the echo path and the decision that was made
  // about the uplink under it; both lifetimes advance. Returns false when the
  // change could not be applied and the engine is still on the previous route,
  // which the caller must not mistake for success.
  bool setRoute(RouteEchoProfile route);

  // Starts a new assistant response's render content. Returns the generation
  // that its audio and barriers must be submitted under.
  RenderContentGeneration beginRenderGeneration();
  RenderContentGeneration currentRenderGeneration() const;

  // Wire-rate assistant PCM. Returns false when the bounded render queue
  // rejected it, which the caller must report rather than swallow.
  bool submitWireAudio(RenderContentGeneration generation, const int16_t* wireSamples,
                       size_t sampleCount);

  // Cancels everything the device has not reached. Already-presented audio
  // stays in the acoustic reference, because it was genuinely heard.
  void clearRender();

  // Queues a playback barrier behind the audio submitted so far.
  bool submitMark(uint64_t markId);

  // --- realtime device callbacks ---

  // Fills `out` with `frames` device-rate samples and copies the exact buffer
  // handed to the device into the acoustic reference.
  void onRenderCallback(int16_t* out, size_t frames, uint64_t presentedFrames);
  void onCaptureCallback(const int16_t* in, size_t frames);
  void onStreamError(int errorCode, bool isInput);

  // --- control-thread drains ---

  struct UplinkFrame {
    const int16_t* samples = nullptr;
    size_t sampleCount = 0;
    uint64_t captureFrameIndex = 0;
    // False when frames were dropped between this one and the previously
    // returned one. Callers that batch frames into one uplink payload must not
    // batch across a gap, or the provider receives a discontinuity presented as
    // continuous speech.
    bool contiguousWithPrevious = false;
  };
  // Applies the send-time gate and returns the next frame that may leave.
  // Frames refused by either gate are counted and skipped, never held.
  bool nextUplinkFrame(UplinkFrame* out);

  // Applies work the realtime callbacks are not allowed to do themselves:
  // rebuilding the acoustic processor allocates, so a callback only requests it
  // and the serialized control owner performs it here.
  void pumpControl();

  size_t drainMarkEvents(MarkEvent* out, size_t max);
  size_t drainTelemetry(MediaEvent* out, size_t max);
  MediaSnapshot snapshot() const;
  AudioDeviceClockEpoch currentDeviceEpoch() const {
    return AudioDeviceClockEpoch(deviceEpoch_.load(std::memory_order_acquire));
  }
  CaptureUplinkEligibilityGeneration currentEligibilityGeneration() const {
    return CaptureUplinkEligibilityGeneration(eligibilityGeneration_.load(std::memory_order_acquire));
  }

  // Test seam: the host tests drive the engine without a monotonic clock
  // source. Production installs the platform clock once at construction.
  void setClockSource(int64_t (*monotonicNanos)());

 private:
  struct RenderIngest;

  void recordEvent(MediaEventKind kind, int64_t detailA = 0, int64_t detailB = 0);
  void setReadiness(MediaReadiness next, int64_t detail);
  void advanceEligibility(int64_t reason);
  bool renderPresenting() const;
  bool captureEligibleNow() const;
  bool rebuildForEpoch();
  void feedReferenceFrame();
  void updateReadinessAfterCapture();
  // Returns false when the callback did not release the processor in time; the
  // caller must then leave it alone rather than free it underneath.
  bool quiesceAcousticProcessor();
  // Waits for both device callbacks to leave the pipeline. The caller has
  // already cleared `pipelineActive_`, so a callback that has not entered yet
  // turns itself away; this is only about one already inside. Returns false if
  // it never left, and then the caller must not touch what it owns.
  bool quiescePipeline();

  mutable std::mutex controlMutex_;
  EngineConfig config_;
  bool started_ = false;
  // Read by the capture callback on every frame, so it is an atomic rather than
  // control-owner state guarded by the mutex a realtime thread must not take.
  std::atomic<RouteEchoProfile> route_{RouteEchoProfile::kUnknown};
  std::atomic<EchoControlOwner> echoControlOwner_{EchoControlOwner::kNone};
  // The device streams are stopped across every pipeline rebuild. This flag is
  // the barrier that makes the rebuilt objects visible to the callbacks and
  // keeps a late callback from touching a half-built pipeline.
  std::atomic<bool> pipelineActive_{false};
  std::atomic<bool> acousticActive_{false};
  std::atomic<int> pendingAcousticReset_{-1};
  // The reference ring and its converter are owned by the capture callback.
  // Clearing them from the control thread would free and rewind state a
  // realtime thread is reading, so the control thread asks and the callback
  // does it.
  std::atomic<bool> pendingReferenceReset_{false};
  // Set by the capture callback for exactly as long as it is inside the
  // acoustic processor. The control owner clears `acousticActive_` first and
  // then waits for this to fall before it destroys or replaces the processor,
  // so a rebuild can never free memory a realtime callback is still reading.
  // Only the control side ever waits; the callback never blocks.
  std::atomic<bool> processorInUse_{false};
  // Device callbacks currently inside the pipeline. Announced before the
  // `pipelineActive_` check so a teardown either sees the callback and waits or
  // is seen by it and turns it away; the render and capture callbacks are
  // different threads, so this counts rather than flags.
  std::atomic<int> pipelineInUse_{0};
  // True while nothing is inside the pipeline and nothing can enter. The JNI
  // layer refuses to free an engine that never reached this, because a realtime
  // callback would be reading freed memory.
  std::atomic<bool> pipelineQuiesced_{true};
  std::atomic<MediaReadiness> readiness_{MediaReadiness::kStopped};

  GenerationCounter<AudioDeviceClockEpoch> epochCounter_;
  GenerationCounter<RenderContentGeneration> renderCounter_;
  GenerationCounter<CaptureUplinkEligibilityGeneration> eligibilityCounter_;
  std::atomic<uint64_t> deviceEpoch_{0};
  std::atomic<uint64_t> renderGeneration_{0};
  std::atomic<uint64_t> eligibilityGeneration_{0};

  // Render ingest lives on the control thread: framing and rate conversion of
  // provider audio must never happen inside a device callback.
  std::unique_ptr<FrameAdapter> renderWireFrames_;
  std::unique_ptr<ResampleLane> renderWireToDevice_;
  std::unique_ptr<RenderTimeline> renderTimeline_;

  // Capture chain, driven entirely from the capture callback.
  std::unique_ptr<FrameAdapter> captureDeviceFrames_;
  std::unique_ptr<ResampleLane> captureDeviceToApm_;
  std::unique_ptr<ResampleLane> captureApmToWire_;
  std::unique_ptr<CaptureUplinkQueue> uplink_;
  std::vector<int16_t> captureScratch_;

  // The far-end reference: exactly the buffer the render callback handed the
  // device, at the device output rate.
  std::unique_ptr<SampleRing> referenceRing_;
  std::unique_ptr<ResampleLane> referenceDeviceToApm_;
  std::vector<int16_t> referenceScratch_;

  AcousticProcessor acoustic_;
  MediaTelemetry telemetry_;
  // Outcomes emitted by a timeline that is about to be replaced. Without this
  // the invalidations a stream restart produces would be destroyed with the
  // timeline that recorded them, and the Gateway would wait forever for turns
  // that ended.
  std::vector<MarkEvent> carriedMarkEvents_;

  std::atomic<uint64_t> deviceWrittenFrames_{0};
  std::atomic<uint64_t> devicePresentedFrames_{0};
  std::atomic<uint64_t> captureFrameIndex_{0};
  uint64_t lastSentCaptureFrameIndex_ = 0;
  bool hasSentCaptureFrame_ = false;
  std::atomic<int> measuredStreamDelayMs_{-1};
  std::atomic<bool> deviceClockValid_{false};
  std::atomic<uint64_t> referenceUnderrunRun_{0};
  std::atomic<int> renderLevelMilli_{0};
  std::atomic<int> captureLevelMilli_{0};

  int64_t (*monotonicNanos_)() = nullptr;
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_REALTIME_MEDIA_CORE_H_
