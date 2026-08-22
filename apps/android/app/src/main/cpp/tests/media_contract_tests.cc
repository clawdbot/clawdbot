// Media contract and historical-regression coverage for the realtime engine.
//
// Tests whose name starts with `Regression_` reproduce a failure shape that was
// physically observed on hardware during the prototype work that preceded this
// engine. They exist so the shape fails here instead of on a handset.

#include <algorithm>
#include <cmath>
#include <numeric>
#include <vector>

#include "media/capture_uplink.h"
#include "media/frame_adapter.h"
#include <atomic>
#include <chrono>
#include <thread>
#include "media/realtime_media_core.h"
#include "media/render_timeline.h"
#include "media/resample_lane.h"
#include "media/sample_ring.h"
#include "tests/test_harness.h"

namespace openclaw::media {
namespace {

std::vector<int16_t> ramp(int16_t start, size_t count) {
  std::vector<int16_t> out(count);
  for (size_t i = 0; i < count; ++i) out[i] = static_cast<int16_t>(start + static_cast<int16_t>(i));
  return out;
}

std::vector<int16_t> tone(size_t count, int rateHz, double freqHz, double amplitude) {
  std::vector<int16_t> out(count);
  for (size_t i = 0; i < count; ++i) {
    const double value =
        amplitude * 32767.0 * std::sin(2.0 * M_PI * freqHz * static_cast<double>(i) / rateHz);
    out[i] = static_cast<int16_t>(value);
  }
  return out;
}

EngineConfig speakerConfig(int wireHz = 24000, int deviceHz = 48000) {
  EngineConfig config;
  config.rates.wireInputHz = wireHz;
  config.rates.wireOutputHz = wireHz;
  config.rates.requestedDeviceInputHz = deviceHz;
  config.rates.requestedDeviceOutputHz = deviceHz;
  return config;
}

// Drives the engine the way the device layer does: one render callback and one
// capture callback per device buffer, with presentation trailing the write
// position by a fixed device buffer as real hardware does.
struct DeviceLoop {
  RealtimeMediaCore& core;
  size_t framesPerCallback;
  uint64_t written = 0;
  uint64_t presented = 0;
  uint64_t presentationLagFrames = 0;
  std::vector<int16_t> renderBuffer;
  std::vector<int16_t> captureBuffer;

  DeviceLoop(RealtimeMediaCore& core, size_t framesPerCallback, uint64_t lagFrames)
      : core(core),
        framesPerCallback(framesPerCallback),
        presentationLagFrames(lagFrames),
        renderBuffer(framesPerCallback, 0),
        captureBuffer(framesPerCallback, 0) {}

  void tick(const int16_t* captureInput = nullptr) {
    presented = written > presentationLagFrames ? written - presentationLagFrames : 0;
    core.onRenderCallback(renderBuffer.data(), framesPerCallback, presented);
    written += framesPerCallback;
    if (captureInput != nullptr) {
      std::copy(captureInput, captureInput + framesPerCallback, captureBuffer.begin());
    } else {
      std::fill(captureBuffer.begin(), captureBuffer.end(), 0);
    }
    core.onCaptureCallback(captureBuffer.data(), framesPerCallback);
  }

  void run(size_t ticks) {
    for (size_t i = 0; i < ticks; ++i) tick();
  }
};

size_t countUplink(RealtimeMediaCore& core) {
  size_t sent = 0;
  RealtimeMediaCore::UplinkFrame frame;
  while (core.nextUplinkFrame(&frame)) ++sent;
  return sent;
}

}  // namespace

// --- framing -----------------------------------------------------------------

OPENCLAW_TEST(FrameAdapter_SplitsArbitraryBurstsWithoutLosingSamples) {
  FrameAdapter adapter(480);
  std::vector<int16_t> collected;
  const std::vector<size_t> bursts = {1, 479, 480, 481, 960, 7, 1440, 13};
  int16_t next = 0;
  size_t submitted = 0;
  for (size_t burst : bursts) {
    const std::vector<int16_t> input = ramp(next, burst);
    next = static_cast<int16_t>(next + static_cast<int16_t>(burst));
    submitted += burst;
    adapter.push(input.data(), input.size(), [&](const int16_t* frame, size_t count) {
      EXPECT_EQ(count, 480u);
      collected.insert(collected.end(), frame, frame + count);
    });
  }
  EXPECT_EQ(collected.size(), (submitted / 480) * 480);
  EXPECT_EQ(adapter.pendingSamples(), submitted % 480);
  // Every emitted sample is the one that was submitted, in submission order.
  int16_t expected = 0;
  for (size_t i = 0; i < collected.size(); ++i) {
    EXPECT_EQ(collected[i], expected);
    expected = static_cast<int16_t>(expected + 1);
  }
}

OPENCLAW_TEST(FrameAdapter_ResetDropsThePartialFrame) {
  FrameAdapter adapter(480);
  const std::vector<int16_t> input = ramp(0, 200);
  adapter.push(input.data(), input.size(), [](const int16_t*, size_t) { EXPECT_TRUE(false); });
  EXPECT_EQ(adapter.pendingSamples(), 200u);
  adapter.reset();
  EXPECT_EQ(adapter.pendingSamples(), 0u);
  // A frame emitted after the reset must contain only post-reset samples.
  const std::vector<int16_t> next = ramp(1000, 480);
  adapter.push(next.data(), next.size(), [&](const int16_t* frame, size_t count) {
    EXPECT_EQ(count, 480u);
    EXPECT_EQ(frame[0], static_cast<int16_t>(1000));
  });
}

// --- conversion --------------------------------------------------------------

OPENCLAW_TEST(ResampleLane_UpsamplesToTheTargetFrameSizeAndStaysPhaseContinuous) {
  ResampleLane lane(24000, 48000);
  EXPECT_EQ(lane.sourceFrameSamples(), 240u);
  EXPECT_EQ(lane.targetFrameSamples(), 480u);
  const std::vector<int16_t> input = tone(240 * 8, 24000, 400.0, 0.5);
  std::vector<int16_t> output;
  for (size_t offset = 0; offset + 240 <= input.size(); offset += 240) {
    const int16_t* converted = lane.convert(input.data() + offset, 240);
    EXPECT_TRUE(converted != nullptr);
    output.insert(output.end(), converted, converted + 480);
  }
  EXPECT_EQ(output.size(), 480u * 8);
  // Phase continuity: a discontinuity at a frame seam shows up as a sample step
  // far larger than the largest step inside a frame.
  double maxInteriorStep = 0;
  double maxSeamStep = 0;
  for (size_t i = 1; i < output.size(); ++i) {
    const double step = std::fabs(static_cast<double>(output[i]) - output[i - 1]);
    if (i % 480 == 0) {
      maxSeamStep = std::max(maxSeamStep, step);
    } else {
      maxInteriorStep = std::max(maxInteriorStep, step);
    }
  }
  EXPECT_TRUE(maxSeamStep <= maxInteriorStep * 1.5);
}

OPENCLAW_TEST(ResampleLane_PassesThroughWhenRatesMatch) {
  ResampleLane lane(48000, 48000);
  EXPECT_TRUE(!lane.needsConversion());
  const std::vector<int16_t> input = ramp(5, 480);
  EXPECT_EQ(lane.convert(input.data(), 480), input.data());
}

OPENCLAW_TEST(ResampleLane_RejectsAFrameOfTheWrongLength) {
  ResampleLane lane(24000, 48000);
  const std::vector<int16_t> input = ramp(0, 100);
  EXPECT_TRUE(lane.convert(input.data(), 100) == nullptr);
}

// --- render timeline ---------------------------------------------------------

OPENCLAW_TEST(RenderTimeline_DeliversSubmittedAudioInOrder) {
  RenderTimeline timeline(RenderTimeline::Config{48000, 1000, 64});
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> audio = ramp(0, 480);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), audio.data(), audio.size()));
  std::vector<int16_t> out(480, -1);
  const RenderTimeline::PullResult result = timeline.pull(out.data(), out.size(), 0);
  EXPECT_EQ(result.audioSamples, 480u);
  EXPECT_EQ(result.silenceSamples, 0u);
  EXPECT_EQ(out[0], static_cast<int16_t>(0));
  EXPECT_EQ(out[479], static_cast<int16_t>(479));
}

OPENCLAW_TEST(Regression_RenderQueueIsBoundedAndReportsRejection) {
  // The prototype used an unbounded playback channel: a provider that streamed
  // faster than realtime could queue unbounded assistant audio in device
  // memory, and nothing reported it.
  RenderTimeline timeline(RenderTimeline::Config{48000, 100, 64});  // 4800 samples
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> audio(4000, 1);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), audio.data(), audio.size()));
  EXPECT_TRUE(!timeline.submitAudio(RenderContentGeneration(1), audio.data(), audio.size()));
  const RenderTimelineStats stats = timeline.stats();
  EXPECT_EQ(stats.overflowRejectedSubmissions, 1u);
  EXPECT_EQ(stats.overflowRejectedSamples, 4000u);
}

OPENCLAW_TEST(Regression_ClearedRenderAudioNeverResumes) {
  // Cancelled assistant audio came back after a barge-in because the queue was
  // only closed, not invalidated: whatever was already buffered kept playing.
  RenderTimeline timeline(RenderTimeline::Config{48000, 1000, 64});
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> first(480, 100);
  const std::vector<int16_t> second(480, 200);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), first.data(), first.size()));
  timeline.cancelThrough(RenderContentGeneration(1));
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(2), second.data(), second.size()));

  std::vector<int16_t> out(960, -1);
  const RenderTimeline::PullResult result = timeline.pull(out.data(), out.size(), 0);
  EXPECT_EQ(result.audioSamples, 480u);
  // The generation-2 audio is what plays; none of generation 1 survives.
  for (size_t i = 0; i < 480; ++i) EXPECT_EQ(out[i], static_cast<int16_t>(200));
  EXPECT_EQ(timeline.stats().cancelledSamples, 480u);
}

OPENCLAW_TEST(Regression_BarrierDoesNotCompleteBeforeThePresentedBoundary) {
  // A barrier used to complete when audio was accepted by the output buffer.
  // The Gateway then believed the assistant had finished speaking while the
  // speaker was still playing the audio in front of the barrier.
  RenderTimeline timeline(RenderTimeline::Config{48000, 1000, 64});
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> audio(960, 7);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), audio.data(), audio.size()));
  EXPECT_TRUE(timeline.submitMark(RenderContentGeneration(1), 42));

  std::vector<int16_t> out(960, 0);
  MarkEvent events[4];
  // The whole 960 samples are handed to the device, but nothing is presented.
  timeline.pull(out.data(), out.size(), 0);
  EXPECT_EQ(timeline.drainMarkEvents(events, 4), 0u);
  // Presentation still short of the barrier.
  timeline.pull(out.data(), out.size(), 959);
  EXPECT_EQ(timeline.drainMarkEvents(events, 4), 0u);
  // Presentation reaches it.
  timeline.pull(out.data(), out.size(), 960);
  EXPECT_EQ(timeline.drainMarkEvents(events, 4), 1u);
  EXPECT_EQ(static_cast<int>(events[0].outcome), static_cast<int>(MarkOutcome::kCompleted));
  EXPECT_EQ(events[0].markId, 42u);
}

OPENCLAW_TEST(Regression_BarrierOfACancelledGenerationIsNotCompletedByLaterAudio) {
  RenderTimeline timeline(RenderTimeline::Config{48000, 1000, 64});
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> first(480, 1);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), first.data(), first.size()));
  EXPECT_TRUE(timeline.submitMark(RenderContentGeneration(1), 7));
  timeline.cancelThrough(RenderContentGeneration(1));
  const std::vector<int16_t> second(480, 2);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(2), second.data(), second.size()));

  std::vector<int16_t> out(960, 0);
  timeline.pull(out.data(), out.size(), 0);
  timeline.pull(out.data(), out.size(), 10000);
  MarkEvent events[4];
  EXPECT_EQ(timeline.drainMarkEvents(events, 4), 1u);
  EXPECT_EQ(static_cast<int>(events[0].outcome), static_cast<int>(MarkOutcome::kCancelled));
}

OPENCLAW_TEST(Regression_BarrierDoesNotStrandAcrossStopOrEpochChange) {
  // A stranded barrier reads to the Gateway exactly like an assistant turn that
  // never finished, so both endings are reported rather than dropped.
  RenderTimeline timeline(RenderTimeline::Config{48000, 1000, 64});
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> audio(480, 3);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), audio.data(), audio.size()));
  EXPECT_TRUE(timeline.submitMark(RenderContentGeneration(1), 11));
  // The pull has to reach past the audio for the barrier to be stamped at all;
  // a barrier still queued behind unplayed audio is not yet pending.
  std::vector<int16_t> out(960, 0);
  timeline.pull(out.data(), out.size(), 0);

  MarkEvent events[4];
  timeline.beginEpoch(AudioDeviceClockEpoch(2));
  EXPECT_EQ(timeline.drainMarkEvents(events, 4), 1u);
  EXPECT_EQ(static_cast<int>(events[0].outcome), static_cast<int>(MarkOutcome::kInvalidatedByEpoch));

  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(2), audio.data(), audio.size()));
  EXPECT_TRUE(timeline.submitMark(RenderContentGeneration(2), 12));
  timeline.stopAndDrain();
  EXPECT_EQ(timeline.drainMarkEvents(events, 4), 1u);
  EXPECT_EQ(static_cast<int>(events[0].outcome), static_cast<int>(MarkOutcome::kInvalidatedByStop));
}

OPENCLAW_TEST(Regression_PostDrainSilenceIsNotCountedAsStarvation) {
  // Idle after a finished response was reported as media starvation, which made
  // a healthy engine look like it was underrunning constantly.
  RenderTimeline timeline(RenderTimeline::Config{48000, 1000, 64});
  timeline.beginEpoch(AudioDeviceClockEpoch(1));
  const std::vector<int16_t> audio(240, 5);
  EXPECT_TRUE(timeline.submitAudio(RenderContentGeneration(1), audio.data(), audio.size()));
  std::vector<int16_t> out(480, 0);
  const RenderTimeline::PullResult drained = timeline.pull(out.data(), out.size(), 0);
  EXPECT_EQ(drained.audioSamples, 240u);
  EXPECT_EQ(drained.silenceSamples, 240u);
  EXPECT_TRUE(!drained.contentPending);
  timeline.pull(out.data(), out.size(), 480);
  const RenderTimelineStats stats = timeline.stats();
  EXPECT_EQ(stats.starvedSilenceSamples, 0u);
  EXPECT_EQ(stats.idleSilenceSamples, 720u);
}

// --- capture eligibility -----------------------------------------------------

OPENCLAW_TEST(Regression_IneligibleCaptureIsNeverAuthorisedByALaterPermission) {
  // Capture taken while the assistant was audible was released later, once the
  // endpoint became eligible again, putting the assistant's own voice on the
  // uplink one turn late.
  CaptureUplinkQueue queue(240, 8);
  const std::vector<int16_t> frame(240, 9);
  queue.offer(CaptureEligibility{5, false}, 0, AudioDeviceClockEpoch(1), frame.data());
  CaptureUplinkQueue::Dequeued dequeued;
  EXPECT_TRUE(queue.next(CaptureUplinkEligibilityGeneration(5), true, &dequeued));
  EXPECT_EQ(static_cast<int>(dequeued.disposition),
            static_cast<int>(UplinkDisposition::kDroppedIneligibleAtCapture));
}

OPENCLAW_TEST(EligibleCaptureIsDroppedWhenTheSendGateHasClosed) {
  CaptureUplinkQueue queue(240, 8);
  const std::vector<int16_t> frame(240, 9);
  queue.offer(CaptureEligibility{5, true}, 0, AudioDeviceClockEpoch(1), frame.data());
  CaptureUplinkQueue::Dequeued dequeued;
  EXPECT_TRUE(queue.next(CaptureUplinkEligibilityGeneration(5), false, &dequeued));
  EXPECT_EQ(static_cast<int>(dequeued.disposition),
            static_cast<int>(UplinkDisposition::kDroppedSendGateClosed));
}

OPENCLAW_TEST(EligibleCaptureIsDroppedWhenTheEligibilityGenerationMoved) {
  CaptureUplinkQueue queue(240, 8);
  const std::vector<int16_t> frame(240, 9);
  queue.offer(CaptureEligibility{5, true}, 0, AudioDeviceClockEpoch(1), frame.data());
  CaptureUplinkQueue::Dequeued dequeued;
  EXPECT_TRUE(queue.next(CaptureUplinkEligibilityGeneration(6), true, &dequeued));
  EXPECT_EQ(static_cast<int>(dequeued.disposition),
            static_cast<int>(UplinkDisposition::kDroppedEligibilityChanged));
}

OPENCLAW_TEST(Regression_EligibilityIsPerFrameNotPerBurst) {
  // A whole device burst used to inherit one decision, so a burst that spanned
  // the moment playback ended released every frame in it, including the frames
  // recorded while the speaker was still audible.
  CaptureUplinkQueue queue(240, 8);
  const std::vector<int16_t> frame(240, 9);
  queue.offer(CaptureEligibility{5, false}, 0, AudioDeviceClockEpoch(1), frame.data());
  queue.offer(CaptureEligibility{5, false}, 1, AudioDeviceClockEpoch(1), frame.data());
  queue.offer(CaptureEligibility{5, true}, 2, AudioDeviceClockEpoch(1), frame.data());

  CaptureUplinkQueue::Dequeued dequeued;
  std::vector<UplinkDisposition> dispositions;
  while (queue.next(CaptureUplinkEligibilityGeneration(5), true, &dequeued)) {
    dispositions.push_back(dequeued.disposition);
  }
  EXPECT_EQ(dispositions.size(), 3u);
  EXPECT_EQ(static_cast<int>(dispositions[0]),
            static_cast<int>(UplinkDisposition::kDroppedIneligibleAtCapture));
  EXPECT_EQ(static_cast<int>(dispositions[1]),
            static_cast<int>(UplinkDisposition::kDroppedIneligibleAtCapture));
  EXPECT_EQ(static_cast<int>(dispositions[2]), static_cast<int>(UplinkDisposition::kSent));
}

OPENCLAW_TEST(UplinkQueueOverflowRetiresTheOldestFrameOnTheConsumerSide) {
  CaptureUplinkQueue queue(4, 2);
  const std::vector<int16_t> a(4, 1);
  const std::vector<int16_t> b(4, 2);
  const std::vector<int16_t> c(4, 3);
  EXPECT_TRUE(queue.offer(CaptureEligibility{1, true}, 0, AudioDeviceClockEpoch(1), a.data()));
  EXPECT_TRUE(queue.offer(CaptureEligibility{1, true}, 1, AudioDeviceClockEpoch(1), b.data()));
  // The full queue refuses the frame and asks the consumer for room, rather
  // than moving a cursor the consumer owns.
  EXPECT_TRUE(!queue.offer(CaptureEligibility{1, true}, 2, AudioDeviceClockEpoch(1), c.data()));
  EXPECT_EQ(queue.stats().droppedQueueOverflow, 1u);

  CaptureUplinkQueue::Dequeued dequeued;
  EXPECT_TRUE(queue.next(CaptureUplinkEligibilityGeneration(1), true, &dequeued));
  // Frame 0 is the one that went; the freshest queued frame survives.
  EXPECT_EQ(dequeued.captureFrameIndex, 1u);
  EXPECT_TRUE(!queue.next(CaptureUplinkEligibilityGeneration(1), true, &dequeued));
  EXPECT_TRUE(queue.offer(CaptureEligibility{1, true}, 3, AudioDeviceClockEpoch(1), c.data()));
}

// --- ring buffers ------------------------------------------------------------

OPENCLAW_TEST(SampleRingRejectNewestKeepsWhatIsQueued) {
  SampleRing ring(4, RingOverflowPolicy::kRejectNewest);
  const std::vector<int16_t> a = ramp(1, 4);
  const std::vector<int16_t> b = ramp(9, 2);
  EXPECT_EQ(ring.write(a.data(), a.size()), 4u);
  EXPECT_EQ(ring.write(b.data(), b.size()), 0u);
  EXPECT_EQ(ring.rejectedSamples(), 2u);
  std::vector<int16_t> out(4, 0);
  EXPECT_EQ(ring.read(out.data(), out.size()), 4u);
  EXPECT_EQ(out[0], static_cast<int16_t>(1));
}

OPENCLAW_TEST(SampleRingDropOldestRetiresOnTheConsumerSide) {
  // The producer asks for room; it never moves the read cursor itself. Doing
  // that would overwrite slots the consumer can be mid-copy in, which corrupts
  // exactly the samples backpressure was meant to protect.
  SampleRing ring(4, RingOverflowPolicy::kDropOldest);
  const std::vector<int16_t> a = ramp(1, 4);
  const std::vector<int16_t> b = ramp(9, 2);
  EXPECT_EQ(ring.write(a.data(), a.size()), 4u);
  EXPECT_EQ(ring.write(b.data(), b.size()), 0u);
  EXPECT_EQ(ring.droppedSamples(), 2u);

  // The next read applies the drop the producer asked for, so the oldest
  // samples are the ones that went.
  std::vector<int16_t> out(4, 0);
  EXPECT_EQ(ring.read(out.data(), out.size()), 2u);
  EXPECT_EQ(out[0], static_cast<int16_t>(3));
  EXPECT_EQ(out[1], static_cast<int16_t>(4));

  // Room now exists for the writes that follow.
  EXPECT_EQ(ring.write(b.data(), b.size()), 2u);
  EXPECT_EQ(ring.read(out.data(), out.size()), 2u);
  EXPECT_EQ(out[0], static_cast<int16_t>(9));
}

// --- engine ------------------------------------------------------------------

OPENCLAW_TEST(Regression_WireRateAndDeviceRateAreIndependent) {
  // A 24 kHz wire rate was treated as the device rate. On a Xiaomi 11T Pro the
  // resulting 24 kHz AudioRecord opened, ran, and produced only zero samples.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(24000, 48000), RouteEchoProfile::kBuiltInSpeaker));
  // The device negotiates something else entirely; that is a fact to convert
  // against, not a failure.
  core.beginDeviceEpoch(44100, 44100, 20, 40);
  const MediaSnapshot snapshot = core.snapshot();
  EXPECT_EQ(snapshot.rates.wireInputHz, 24000);
  EXPECT_EQ(snapshot.rates.deviceInputHz, 44100);
  EXPECT_EQ(snapshot.rates.apmCaptureHz, 48000);
  EXPECT_EQ(snapshot.measuredStreamDelayMs, 60);
  core.stop();
}

OPENCLAW_TEST(HeadsetRouteKeepsTheUplinkOpenWhileTheAssistantSpeaks) {
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kDeviceOwnedVoiceProcessing));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  DeviceLoop loop(core, 480, 480);
  // Two ticks: the first validates the device clock, the second is the first
  // capture frame taken under a verified clock.
  loop.run(3);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant = tone(24000, 24000, 300.0, 0.5);  // 1 s at wire rate
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  countUplink(core);
  loop.run(10);
  EXPECT_TRUE(core.snapshot().renderPresenting);
  EXPECT_GE(countUplink(core), 1u);
  core.stop();
}

OPENCLAW_TEST(BuiltInSpeakerClosesTheUplinkWhileTheAssistantIsPresenting) {
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  DeviceLoop loop(core, 480, 480);
  loop.run(3);
  countUplink(core);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant = tone(24000, 24000, 300.0, 0.5);
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  loop.run(10);
  EXPECT_TRUE(core.snapshot().renderPresenting);
  EXPECT_EQ(countUplink(core), 0u);

  // Once the device has presented everything, the uplink reopens.
  loop.run(120);
  EXPECT_TRUE(!core.snapshot().renderPresenting);
  countUplink(core);
  loop.run(5);
  EXPECT_GE(countUplink(core), 1u);
  core.stop();
}

OPENCLAW_TEST(Regression_ReadinessTransitionDoesNotAuthoriseTheFrameThatCausedIt) {
  // The capture frame whose own processing flips readiness stays under the
  // previous decision; the next frame is the first that may be sent.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kDeviceOwnedVoiceProcessing));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  EXPECT_EQ(static_cast<int>(core.snapshot().readiness),
            static_cast<int>(MediaReadiness::kDeviceSyncing));

  DeviceLoop loop(core, 480, 0);
  loop.tick();  // presented advances past zero, so the device clock is now valid
  EXPECT_EQ(static_cast<int>(core.snapshot().readiness),
            static_cast<int>(MediaReadiness::kDeviceSyncing));
  loop.tick();  // this frame is snapshotted under kDeviceSyncing, then flips it
  EXPECT_EQ(static_cast<int>(core.snapshot().readiness),
            static_cast<int>(MediaReadiness::kFullDuplexReady));
  EXPECT_EQ(countUplink(core), 0u);

  loop.tick();  // first frame captured under the new decision
  EXPECT_EQ(countUplink(core), 1u);
  core.stop();
}

OPENCLAW_TEST(Regression_ClearingAResponseDoesNotResetEchoAdaptation) {
  // A normal response boundary used to tear down the canceller, so every reply
  // began with the echo path un-located.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  const uint64_t lifetime = core.snapshot().acousticProcessorLifetime;
  EXPECT_GE(lifetime, 1u);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant(4800, 100);
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  core.clearRender();
  EXPECT_EQ(core.snapshot().acousticProcessorLifetime, lifetime);

  // A route change is an acoustic event, and that one does reset it.
  core.setRoute(RouteEchoProfile::kDeviceOwnedVoiceProcessing);
  core.setRoute(RouteEchoProfile::kBuiltInSpeaker);
  EXPECT_TRUE(core.snapshot().acousticProcessorLifetime > lifetime);
  core.stop();
}

OPENCLAW_TEST(RouteChangeAdvancesCaptureEligibilityGeneration) {
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  const uint64_t before = core.snapshot().captureEligibilityGeneration;
  core.setRoute(RouteEchoProfile::kDeviceOwnedVoiceProcessing);
  EXPECT_TRUE(core.snapshot().captureEligibilityGeneration > before);
  core.stop();
}

OPENCLAW_TEST(Regression_HardwareBackpressureDoesNotBlockControlIngress) {
  // Assistant audio used to be written straight into a blocking device write on
  // the path that also carried Gateway control traffic, so a slow speaker
  // stalled control ingress. Submission is now bounded and returns.
  RealtimeMediaCore core;
  EngineConfig config = speakerConfig();
  config.renderCapacityMs = 200;
  EXPECT_TRUE(core.start(config, RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant(24000, 50);  // 1 s of wire audio into a 200 ms queue

  // No device callback ever runs here: nothing drains the queue.
  const bool accepted = core.submitWireAudio(generation, assistant.data(), assistant.size());
  EXPECT_TRUE(!accepted);
  EXPECT_GE(core.snapshot().render.overflowRejectedSubmissions, 1u);
  core.stop();
}

OPENCLAW_TEST(Regression_DeviceEpochChangeInvalidatesBarriersAndResetsAdaptation) {
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  const uint64_t epoch = core.snapshot().deviceClockEpoch;
  const uint64_t lifetime = core.snapshot().acousticProcessorLifetime;

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant(2400, 10);
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  EXPECT_TRUE(core.submitMark(77));
  DeviceLoop loop(core, 480, 4800);
  loop.run(12);

  core.endDeviceEpoch();
  MarkEvent events[8];
  const size_t drained = core.drainMarkEvents(events, 8);
  EXPECT_GE(drained, 1u);
  bool sawInvalidation = false;
  for (size_t i = 0; i < drained; ++i) {
    if (events[i].markId != 77) continue;
    sawInvalidation = events[i].outcome == MarkOutcome::kInvalidatedByEpoch ||
                      events[i].outcome == MarkOutcome::kInvalidatedByStop;
  }
  EXPECT_TRUE(sawInvalidation);
  EXPECT_TRUE(core.snapshot().acousticProcessorLifetime > lifetime);

  core.beginDeviceEpoch(48000, 48000, 20, 20);
  EXPECT_TRUE(core.snapshot().deviceClockEpoch > epoch);
  core.stop();
}

OPENCLAW_TEST(Regression_AStreamRestartDoesNotTruncateTheReplyItInterrupted) {
  // Plugging in a headset mid-sentence restarts the device streams. The device
  // clock epoch and the render content generation are separate lifetimes, so
  // the reply the assistant has not finished has to survive the restart; only
  // the barriers stamped against the dying frame-position origin do not.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant(4800, 4000);  // 200 ms of wire audio
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  EXPECT_TRUE(core.submitMark(77));

  DeviceLoop before(core, 480, 4800);
  before.run(4);  // most of the reply is still queued

  core.endDeviceEpoch();
  EXPECT_TRUE(core.beginDeviceEpoch(48000, 48000, 20, 20));

  DeviceLoop after(core, 480, 4800);
  int64_t rendered = 0;
  for (size_t i = 0; i < 40; ++i) {
    after.tick();
    for (int16_t sample : after.renderBuffer) rendered += sample != 0 ? 1 : 0;
  }
  // The rest of the reply reached the new stream rather than being discarded.
  EXPECT_TRUE(rendered > 0);

  MarkEvent events[16];
  const size_t drained = core.drainMarkEvents(events, 16);
  bool completed = false;
  for (size_t i = 0; i < drained; ++i) {
    if (events[i].markId == 77) completed = events[i].outcome == MarkOutcome::kCompleted;
  }
  // The barrier rides behind that audio, so it completes on the new device
  // clock instead of resolving as cancelled with the reply cut short.
  EXPECT_TRUE(completed);
  core.stop();
}

OPENCLAW_TEST(Regression_ARestartOntoADifferentRateDiscardsWhatItCannotPlay) {
  // Queued samples are in the old stream's rate. Replaying them through a
  // stream that negotiated a different one would play the reply at the wrong
  // speed, so they are discarded — but every barrier behind them still
  // resolves, because a stranded barrier reads to the Gateway as a turn that
  // never finished.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant(4800, 4000);
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  EXPECT_TRUE(core.submitMark(78));

  DeviceLoop before(core, 480, 4800);
  before.run(4);

  core.endDeviceEpoch();
  EXPECT_TRUE(core.beginDeviceEpoch(16000, 16000, 20, 20));

  DeviceLoop after(core, 160, 1600);
  int64_t rendered = 0;
  for (size_t i = 0; i < 40; ++i) {
    after.tick();
    for (int16_t sample : after.renderBuffer) rendered += sample != 0 ? 1 : 0;
  }
  EXPECT_EQ(rendered, 0);

  MarkEvent events[16];
  const size_t drained = core.drainMarkEvents(events, 16);
  bool resolved = false;
  for (size_t i = 0; i < drained; ++i) {
    if (events[i].markId == 78) resolved = events[i].outcome != MarkOutcome::kCompleted;
  }
  EXPECT_TRUE(resolved);
  core.stop();
}

OPENCLAW_TEST(Regression_ABarrierNeverPrecedesAudioAlreadySubmitted) {
  // The provider emits a barrier after every audio delta, and a delta is rarely
  // a whole 10 ms frame. The tail must be in the timeline before the barrier,
  // or the barrier is acknowledged as played and the tail is dropped at the
  // next generation.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  // 250 wire samples at 24 kHz: one whole 240-sample frame and a 10-sample tail.
  const std::vector<int16_t> delta(250, 5000);
  EXPECT_TRUE(core.submitWireAudio(generation, delta.data(), delta.size()));
  EXPECT_TRUE(core.submitMark(55));

  // 250 wire samples at 24 kHz are 500 device samples at 48 kHz, and all of them
  // must be in the timeline ahead of the barrier. Without the flush only the
  // whole frame's 480 are, and the remaining 20 sit behind a barrier that has
  // already been acknowledged.
  EXPECT_EQ(core.snapshot().render.submittedSamples, 500u);
  core.stop();
}

OPENCLAW_TEST(Regression_ABarrierFlushKeepsTheTailWhenNoConversionIsNeeded) {
  // Device rate equal to the wire rate means no conversion, so the flush hands
  // the timeline the frame adapter's own storage. Clearing the adapter before
  // the copy would submit samples that are no longer there.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(24000, 24000), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(24000, 24000, 20, 20);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> delta(250, 9000);
  EXPECT_TRUE(core.submitWireAudio(generation, delta.data(), delta.size()));
  EXPECT_TRUE(core.submitMark(61));
  EXPECT_EQ(core.snapshot().render.submittedSamples, 250u);

  DeviceLoop loop(core, 240, 240);
  int64_t rendered = 0;
  for (int i = 0; i < 8; ++i) {
    loop.tick();
    for (int16_t sample : loop.renderBuffer) rendered += sample == 9000 ? 1 : 0;
  }
  // Every one of the 250 submitted samples reaches the device with its value
  // intact; a cleared adapter would have handed over zeros or stale memory.
  EXPECT_EQ(rendered, 250);
  core.stop();
}

OPENCLAW_TEST(Regression_ADeviceRateWithoutAWholeFrameIsRefused) {
  // Everything in this engine is sized in whole 10 ms frames. A rate that has
  // no whole frame — 22 050 Hz is 220.5 samples — would be framed at a slightly
  // wrong clock and drift the two timelines apart over a call, so the epoch is
  // refused and the caller degrades to half duplex instead.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  EXPECT_TRUE(!core.beginDeviceEpoch(22050, 48000, 20, 20));
  EXPECT_TRUE(!core.beginDeviceEpoch(48000, 22050, 20, 20));
  // The rates it can frame are still accepted.
  EXPECT_TRUE(core.beginDeviceEpoch(44100, 48000, 20, 20));
  core.stop();
}

OPENCLAW_TEST(Regression_ARouteChangeLeavesCaptureClosedUntilTheNewStreamRuns) {
  // The microphone preset belongs to the route, so the owner reopens the input
  // stream after `setRoute` returns. Publishing the route's steady-state
  // readiness here would let a capture callback on the *old* stream pass the
  // send gate during the swap.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  DeviceLoop loop(core, 480, 480);
  const std::vector<int16_t> speech(480, 2000);
  for (int i = 0; i < 20; ++i) loop.tick(speech.data());

  EXPECT_TRUE(core.setRoute(RouteEchoProfile::kDeviceOwnedVoiceProcessing));
  EXPECT_EQ(static_cast<int>(core.snapshot().readiness),
            static_cast<int>(MediaReadiness::kDeviceSyncing));
  EXPECT_TRUE(!core.snapshot().captureEligibleNow);

  // It reopens itself once the new stream is delivering frames.
  for (int i = 0; i < 5; ++i) loop.tick(speech.data());
  EXPECT_EQ(static_cast<int>(core.snapshot().readiness),
            static_cast<int>(MediaReadiness::kFullDuplexReady));
  core.stop();
}

OPENCLAW_TEST(Regression_ABargeInCancelsABarrierTheConsumerAlreadyReached) {
  // The barrier has left the span stream and is waiting on the device clock, so
  // the span-level generation check no longer covers it. Completing it would
  // tell the Gateway that cancelled audio played.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);

  const RenderContentGeneration generation = core.beginRenderGeneration();
  const std::vector<int16_t> assistant(2400, 4000);
  EXPECT_TRUE(core.submitWireAudio(generation, assistant.data(), assistant.size()));
  EXPECT_TRUE(core.submitMark(91));
  (void)generation;

  // Enough callbacks to reach the barrier, not enough for the device to have
  // presented the audio in front of it.
  DeviceLoop loop(core, 480, 4800);
  loop.run(11);

  core.clearRender();
  loop.run(2);

  MarkEvent events[16];
  const size_t drained = core.drainMarkEvents(events, 16);
  bool cancelled = false;
  for (size_t i = 0; i < drained; ++i) {
    if (events[i].markId == 91) cancelled = events[i].outcome == MarkOutcome::kCancelled;
  }
  EXPECT_TRUE(cancelled);
  core.stop();
}

OPENCLAW_TEST(Regression_ClearingTheReferenceRingForgetsItsPendingDrop) {
  // A drop the producer asked for belongs to samples the clear discards. Left
  // set, it is charged to the first reference samples written after a route
  // reset — throwing away exactly the audio the canceller needs to relearn.
  SampleRing ring(8, RingOverflowPolicy::kDropOldest);
  const std::vector<int16_t> block(8, 100);
  EXPECT_EQ(ring.write(block.data(), block.size()), 8u);
  // Full: this write is refused and asks the consumer to drop four.
  EXPECT_EQ(ring.write(block.data(), 4), 0u);

  ring.clear();
  const std::vector<int16_t> fresh(8, 7);
  EXPECT_EQ(ring.write(fresh.data(), fresh.size()), 8u);
  int16_t out[8] = {0};
  // All eight fresh samples survive; a carried-over drop would eat the first
  // four of them.
  EXPECT_EQ(ring.read(out, 8), 8u);
  EXPECT_EQ(out[0], 7);
}

OPENCLAW_TEST(Regression_AFrameLostToTheProcessorLeavesAGapInTheUplink) {
  // The frame index is claimed before anything can drop the frame, so a frame
  // lost on the way to the uplink shows up as a gap rather than letting the
  // next one arrive as if it followed the last one sent.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kDeviceOwnedVoiceProcessing));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  DeviceLoop loop(core, 480, 4800);
  const std::vector<int16_t> speech(480, 3000);
  for (int i = 0; i < 20; ++i) loop.tick(speech.data());

  RealtimeMediaCore::UplinkFrame frame;
  EXPECT_TRUE(core.nextUplinkFrame(&frame));
  const uint64_t first = frame.captureFrameIndex;
  EXPECT_TRUE(core.nextUplinkFrame(&frame));
  // Consecutive capture indices: nothing was lost between them.
  EXPECT_EQ(frame.captureFrameIndex, first + 1);
  EXPECT_TRUE(frame.contiguousWithPrevious);
  core.stop();
}

OPENCLAW_TEST(Regression_StopWaitsForCallbacksRunningOnAnotherThread) {
  // The single-threaded tests cannot see the window teardown exists to close.
  // Here a real callback thread runs while `stop()` is called from another, and
  // the owner's free gate has to be true only once that thread is out.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);

  std::atomic<bool> stopRequested{false};
  std::atomic<uint64_t> callbacks{0};
  std::thread audio([&] {
    std::vector<int16_t> render(480, 0);
    std::vector<int16_t> capture(480, 0);
    uint64_t written = 0;
    while (!stopRequested.load(std::memory_order_acquire)) {
      core.onRenderCallback(render.data(), render.size(), written);
      core.onCaptureCallback(capture.data(), capture.size());
      written += render.size();
      callbacks.fetch_add(1, std::memory_order_relaxed);
    }
  });

  while (callbacks.load(std::memory_order_relaxed) < 50) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  core.stop();
  // True only if no callback was inside when `stop` returned; the JNI owner
  // frees the engine on the strength of this.
  EXPECT_TRUE(core.pipelineQuiesced());

  stopRequested.store(true, std::memory_order_release);
  audio.join();
  EXPECT_TRUE(callbacks.load(std::memory_order_relaxed) >= 50);
}

OPENCLAW_TEST(Regression_StopReportsThatThePipelineIsSafeToFree) {
  // The JNI owner frees the engine only when this is true. A callback that
  // never left the pipeline would still be reading this memory.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  DeviceLoop loop(core, 480, 4800);
  loop.run(4);
  core.stop();
  EXPECT_TRUE(core.pipelineQuiesced());
}

OPENCLAW_TEST(Regression_ADiscardedHeldFrameBreaksUplinkContinuity) {
  // The consumer holds a frame the engine already counted as sent. Dropping it
  // without breaking continuity would present a hole in the user's speech to
  // the provider as one continuous utterance.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kDeviceOwnedVoiceProcessing));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  DeviceLoop loop(core, 480, 4800);
  const std::vector<int16_t> speech(480, 3000);
  for (int i = 0; i < 20; ++i) loop.tick(speech.data());

  RealtimeMediaCore::UplinkFrame frame;
  EXPECT_TRUE(core.nextUplinkFrame(&frame));
  EXPECT_TRUE(core.nextUplinkFrame(&frame));
  // Two frames in a row: the second follows the first.
  EXPECT_TRUE(frame.contiguousWithPrevious);

  core.breakUplinkContinuity();
  EXPECT_TRUE(core.nextUplinkFrame(&frame));
  EXPECT_TRUE(!frame.contiguousWithPrevious);
  core.stop();
}

OPENCLAW_TEST(TelemetrySinkCarriesKnownPositiveEvents) {
  // Absence is evidence only when the observation path can carry the event, so
  // the sink is proved live with an event the test causes on purpose before any
  // assertion relies on an event not appearing.
  RealtimeMediaCore core;
  EXPECT_TRUE(core.start(speakerConfig(), RouteEchoProfile::kBuiltInSpeaker));
  core.beginDeviceEpoch(48000, 48000, 20, 20);
  core.setRoute(RouteEchoProfile::kDeviceOwnedVoiceProcessing);
  MediaEvent events[64];
  const size_t drained = core.drainTelemetry(events, 64);
  EXPECT_GE(drained, 4u);
  bool sawStart = false;
  bool sawEpoch = false;
  bool sawRoute = false;
  for (size_t i = 0; i < drained; ++i) {
    sawStart = sawStart || events[i].kind == MediaEventKind::kEngineStarted;
    sawEpoch = sawEpoch || events[i].kind == MediaEventKind::kDeviceEpochBegan;
    sawRoute = sawRoute || events[i].kind == MediaEventKind::kRouteChanged;
  }
  EXPECT_TRUE(sawStart);
  EXPECT_TRUE(sawEpoch);
  EXPECT_TRUE(sawRoute);
  EXPECT_EQ(core.snapshot().telemetryDroppedEvents, 0u);
  core.stop();
}

}  // namespace openclaw::media
