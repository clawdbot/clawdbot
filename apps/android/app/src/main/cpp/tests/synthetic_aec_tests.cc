// Deterministic echo-cancellation regressions over synthetic signals.
//
// These are regression tests, not acoustic qualification. They run a known
// signal through a known linear echo path, so what they can prove is that the
// engine feeds the canceller a correctly aligned far-end reference and that the
// canceller acts on it. Nothing here says anything about a real room, a real
// loudspeaker, or a real handset; that measurement is a separate activity and
// has not been performed for this implementation.
//
// Every echo assertion is paired with a control run whose reference is wrong.
// Without that control, a test that "passes" would pass equally well if the
// engine had silently stopped feeding the reference at all.

#include <cmath>
#include <cstdio>
#include <vector>

#include "media/acoustic_processor.h"
#include "media/media_rates.h"
#include "tests/test_harness.h"

namespace openclaw::media {
namespace {

constexpr int kRateHz = 48000;
constexpr size_t kFrame = 480;

// Speech-like source: filtered noise under a syllabic on/off envelope. A pure
// tone fixture was tried first and measured almost no cancellation — the noise
// suppressor treats a stationary tone as noise and removes it identically in
// both arms, which hides whatever the canceller did. Real far-end audio is
// broadband and non-stationary, and the fixture has to be too or it measures
// the wrong stage of the chain.
class SpeechLikeSource {
 public:
  explicit SpeechLikeSource(uint32_t seed) : state_(seed) {}

  void fill(size_t frameIndex, int16_t* out, double amplitude) {
    const double seconds = static_cast<double>(frameIndex * kFrame) / kRateHz;
    const double gate = std::sin(2.0 * M_PI * syllableHz_ * seconds) > -0.3
                            ? 0.5 + 0.5 * std::sin(2.0 * M_PI * (syllableHz_ + 1.2) * seconds)
                            : 0.02;
    for (size_t i = 0; i < kFrame; ++i) {
      const double noise = nextNoise();
      lowpass_ = 0.72 * lowpass_ + 0.28 * noise;
      const double value = 0.6 * lowpass_ + 0.4 * noise;
      out[i] = static_cast<int16_t>(amplitude * gate * value * 20000.0);
    }
  }

 private:
  double nextNoise() {
    state_ = state_ * 1664525u + 1013904223u;
    return static_cast<double>(static_cast<int32_t>(state_ >> 1) - 536870912) / 536870912.0;
  }

  uint32_t state_;
  double lowpass_ = 0;
  double syllableHz_ = 2.5;
};

double energy(const int16_t* samples, size_t count) {
  double total = 0;
  for (size_t i = 0; i < count; ++i) {
    const double value = samples[i];
    total += value * value;
  }
  return total;
}

double toDb(double numerator, double denominator) {
  if (denominator <= 0) return 120.0;
  if (numerator <= 0) return 0.0;
  return 10.0 * std::log10(numerator / denominator);
}

// A single-tap acoustic path: the assistant's own output, delayed and
// attenuated, is what the microphone picks up.
class EchoPath {
 public:
  EchoPath(size_t delaySamples, double gain) : delayLine_(delaySamples, 0), gain_(gain) {}

  void process(const int16_t* farEnd, int16_t* echoOut, size_t count) {
    for (size_t i = 0; i < count; ++i) {
      delayLine_.push_back(farEnd[i]);
      const int16_t delayed = delayLine_.front();
      delayLine_.erase(delayLine_.begin());
      echoOut[i] = static_cast<int16_t>(gain_ * delayed);
    }
  }

  void setDelay(size_t delaySamples) { delayLine_.assign(delaySamples, 0); }

 private:
  std::vector<int16_t> delayLine_;
  double gain_;
};

struct EchoRun {
  double micEnergy = 0;
  double outputEnergy = 0;
  double nearEndEnergy = 0;
  double erleDb = 0;
  bool delayLocated = false;
  double reportedErleDb = 0;
  bool hasReportedErle = false;
};

// Runs `frames` of far-end audio through an echo path into the canceller and
// measures the last `measureFrames` frames, after convergence.
//
// `feedReference` is the whole point of the control arm: passing false runs the
// identical signal with a silent far-end reference, which is what the numbers
// look like when the reference plumbing is broken.
EchoRun runEcho(AcousticProcessor& processor, EchoPath& path, size_t frames, size_t measureFrames,
                bool feedReference, bool withNearEnd, int streamDelayMs,
                size_t delayChangeFrame = 0, size_t newDelaySamples = 0) {
  EchoRun run;
  // Both arms are seeded identically, so the only difference between a run with
  // the reference and its control is the reference itself.
  SpeechLikeSource farEndSource(0x5eed1234u);
  SpeechLikeSource nearEndSource(0x0a11ce00u);
  std::vector<int16_t> farEnd(kFrame);
  std::vector<int16_t> nearEnd(kFrame);
  std::vector<int16_t> echo(kFrame);
  std::vector<int16_t> mic(kFrame);
  std::vector<int16_t> reference(kFrame);
  for (size_t frameIndex = 0; frameIndex < frames; ++frameIndex) {
    if (delayChangeFrame != 0 && frameIndex == delayChangeFrame) path.setDelay(newDelaySamples);
    farEndSource.fill(frameIndex, farEnd.data(), 1.0);
    path.process(farEnd.data(), echo.data(), kFrame);
    if (withNearEnd) {
      nearEndSource.fill(frameIndex, nearEnd.data(), 0.35);
    } else {
      std::fill(nearEnd.begin(), nearEnd.end(), 0);
    }
    for (size_t i = 0; i < kFrame; ++i) {
      mic[i] = static_cast<int16_t>(echo[i] + nearEnd[i]);
    }
    // The processor rewrites its far-end input, so the reference is copied and
    // the echo path keeps using the original signal.
    if (feedReference) {
      reference = farEnd;
    } else {
      std::fill(reference.begin(), reference.end(), 0);
    }
    processor.processRenderReference(reference.data());
    const bool ok = processor.processCapture(mic.data(), streamDelayMs);
    EXPECT_TRUE(ok);
    if (frameIndex + measureFrames >= frames) {
      run.micEnergy += energy(echo.data(), kFrame);
      run.outputEnergy += energy(mic.data(), kFrame);
      if (withNearEnd) run.nearEndEnergy += energy(nearEnd.data(), kFrame);
    }
  }
  run.erleDb = toDb(run.micEnergy, run.outputEnergy);
  const AcousticProcessorStats stats = processor.stats();
  run.delayLocated = stats.hasDelayMs;
  run.hasReportedErle = stats.hasEchoReturnLossEnhancement;
  run.reportedErleDb = stats.echoReturnLossEnhancementDb;
  return run;
}

}  // namespace

OPENCLAW_TEST(SyntheticEcho_FixedDelayIsCancelledAndTheControlProvesTheReferenceMatters) {
  const size_t delaySamples = kRateHz * 60 / 1000;  // 60 ms
  AcousticProcessor cancelling;
  EXPECT_TRUE(cancelling.start(kRateHz, kRateHz, AcousticResetReason::kEngineStart));
  EchoPath cancellingPath(delaySamples, 0.5);
  const EchoRun withReference =
      runEcho(cancelling, cancellingPath, 600, 100, true, false, 60);

  AcousticProcessor control;
  EXPECT_TRUE(control.start(kRateHz, kRateHz, AcousticResetReason::kEngineStart));
  EchoPath controlPath(delaySamples, 0.5);
  const EchoRun withoutReference = runEcho(control, controlPath, 600, 100, false, false, 60);

  std::printf("    fixed-delay ERLE with reference: %.1f dB, control (silent reference): %.1f dB\n",
              withReference.erleDb, withoutReference.erleDb);
  std::printf("    processor-reported ERLE: %s%.1f dB, delay located: %s\n",
              withReference.hasReportedErle ? "" : "(absent) ", withReference.reportedErleDb,
              withReference.delayLocated ? "yes" : "no");

  EXPECT_TRUE(withReference.delayLocated);
  // Fixture-specific regression bound, not an acoustic pass mark: this signal
  // through this synthetic path measured well above it, and a drop back to the
  // control's level means the reference stopped reaching the canceller.
  EXPECT_GE(withReference.erleDb, 25.0);
  EXPECT_LE(withoutReference.erleDb, 8.0);
  EXPECT_TRUE(withReference.erleDb > withoutReference.erleDb + 15.0);
}

OPENCLAW_TEST(SyntheticEcho_ReconvergesAfterTheEchoDelayChanges) {
  AcousticProcessor processor;
  EXPECT_TRUE(processor.start(kRateHz, kRateHz, AcousticResetReason::kEngineStart));
  EchoPath path(kRateHz * 40 / 1000, 0.5);
  // The delay moves a third of the way in; the measurement window is entirely
  // after the change, so a canceller stuck on the old alignment fails here.
  const EchoRun run =
      runEcho(processor, path, 900, 100, true, false, 40, 300, kRateHz * 110 / 1000);
  std::printf("    changed-delay ERLE after reconvergence: %.1f dB\n", run.erleDb);
  EXPECT_GE(run.erleDb, 15.0);
}

OPENCLAW_TEST(SyntheticEcho_NearEndSurvivesDoubleTalk) {
  // Cancelling echo by suppressing everything would score perfectly on the echo
  // tests and destroy the product, so the double-talk arm measures what is left
  // of the near-end talker rather than what is left of the echo.
  AcousticProcessor processor;
  EXPECT_TRUE(processor.start(kRateHz, kRateHz, AcousticResetReason::kEngineStart));
  EchoPath path(kRateHz * 60 / 1000, 0.5);
  const EchoRun run = runEcho(processor, path, 600, 100, true, true, 60);

  const double retainedDb = toDb(run.outputEnergy, run.nearEndEnergy);
  std::printf("    double-talk near-end retained: %.1f dB relative to the clean near end\n",
              retainedDb);
  // The near-end talker must still be there. Measured at -11.4 dB on this
  // fixture: the suppressor does pull the level down during double talk, which
  // is expected, but a canceller that muted the capture outright would land
  // tens of dB below this bound.
  EXPECT_GE(retainedDb, -16.0);
}

OPENCLAW_TEST(SyntheticEcho_ResetStartsANewProcessorLifetime) {
  AcousticProcessor processor;
  EXPECT_TRUE(processor.start(kRateHz, kRateHz, AcousticResetReason::kEngineStart));
  EchoPath path(kRateHz * 60 / 1000, 0.5);
  runEcho(processor, path, 200, 50, true, false, 60);
  const AcousticProcessorStats before = processor.stats();
  EXPECT_GE(before.captureFramesProcessed, 200u);

  processor.resetAdaptation(AcousticResetReason::kRouteChanged);
  const AcousticProcessorStats after = processor.stats();
  EXPECT_TRUE(after.lifetime > before.lifetime);
  // The counters belong to the lifetime they describe, so they restart with it.
  EXPECT_EQ(after.captureFramesProcessed, 0u);
  EXPECT_EQ(after.resets, 1u);
}

OPENCLAW_TEST(SyntheticEcho_RunsWithoutAnExternalDelayEstimate) {
  // Upstream consumes the external delay only as the initial render-buffer
  // delay after a reset; the internal estimator owns the operating delay. This
  // arm proves the engine does not depend on supplying one.
  AcousticProcessor processor;
  EXPECT_TRUE(processor.start(kRateHz, kRateHz, AcousticResetReason::kEngineStart));
  EchoPath path(kRateHz * 60 / 1000, 0.5);
  const EchoRun run = runEcho(processor, path, 600, 100, true, false, -1);
  std::printf("    ERLE with no external delay supplied: %.1f dB\n", run.erleDb);
  EXPECT_GE(run.erleDb, 25.0);
}

}  // namespace openclaw::media
