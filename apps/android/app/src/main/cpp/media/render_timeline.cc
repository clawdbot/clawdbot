#include "media/render_timeline.h"

#include <algorithm>
#include <cstring>

namespace openclaw::media {
namespace {

constexpr uint64_t kRelaxedBump = 1;

void bump(std::atomic<uint64_t>& counter, uint64_t by = kRelaxedBump) {
  counter.fetch_add(by, std::memory_order_relaxed);
}

}  // namespace

RenderTimeline::RenderTimeline(const Config& config)
    : config_(config),
      capacitySamples_(static_cast<size_t>(
          static_cast<int64_t>(config.deviceRateHz) * config.capacityMs / 1000)) {
  ring_.assign(capacitySamples_, 0);
  spans_.assign(config_.maxSpans, Span{});
}

bool RenderTimeline::submitAudio(RenderContentGeneration generation, const int16_t* samples,
                                 size_t count) {
  if (count == 0) return true;
  const uint64_t write = writeSamples_.load(std::memory_order_relaxed);
  const uint64_t read = readSamples_.load(std::memory_order_acquire);
  if (write - read + count > capacitySamples_) {
    bump(overflowRejectedSamples_, count);
    bump(overflowRejectedSubmissions_);
    return false;
  }
  const uint64_t spanWrite = spanWrite_.load(std::memory_order_relaxed);
  if (spanWrite - spanRead_.load(std::memory_order_acquire) >= config_.maxSpans) {
    bump(overflowRejectedSamples_, count);
    bump(overflowRejectedSubmissions_);
    return false;
  }

  const size_t offset = static_cast<size_t>(write % capacitySamples_);
  const size_t firstChunk = std::min(count, capacitySamples_ - offset);
  std::memcpy(ring_.data() + offset, samples, firstChunk * sizeof(int16_t));
  if (firstChunk < count) {
    std::memcpy(ring_.data(), samples + firstChunk, (count - firstChunk) * sizeof(int16_t));
  }

  spans_[static_cast<size_t>(spanWrite % config_.maxSpans)] =
      Span{SpanKind::kAudio, generation.value(), write, static_cast<uint32_t>(count), 0};
  // Publish samples before the span that describes them.
  writeSamples_.store(write + count, std::memory_order_release);
  spanWrite_.store(spanWrite + 1, std::memory_order_release);
  bump(submittedSamples_, count);
  return true;
}

bool RenderTimeline::submitMark(RenderContentGeneration generation, uint64_t markId) {
  const uint64_t spanWrite = spanWrite_.load(std::memory_order_relaxed);
  if (spanWrite - spanRead_.load(std::memory_order_acquire) >= config_.maxSpans) {
    return false;
  }
  spans_[static_cast<size_t>(spanWrite % config_.maxSpans)] =
      Span{SpanKind::kMark, generation.value(),
           writeSamples_.load(std::memory_order_relaxed), 0, markId};
  spanWrite_.store(spanWrite + 1, std::memory_order_release);
  return true;
}

void RenderTimeline::cancelThrough(RenderContentGeneration generation) {
  uint64_t previous = cancelThrough_.load(std::memory_order_relaxed);
  while (previous < generation.value() &&
         !cancelThrough_.compare_exchange_weak(previous, generation.value(),
                                               std::memory_order_acq_rel,
                                               std::memory_order_relaxed)) {
  }
}

RenderTimeline::PullResult RenderTimeline::pull(int16_t* out, size_t count,
                                                uint64_t presentedFrames) {
  PullResult result;
  // Barrier outcomes are decided against the presentation position the device
  // reports for this callback, before anything in this buffer is played.
  const uint64_t epoch = epoch_.load(std::memory_order_acquire);
  const uint64_t cancelled = cancelThrough_.load(std::memory_order_acquire);
  for (auto& mark : pendingMarks_) {
    if (!mark.active) continue;
    if (mark.epoch != epoch) {
      mark.active = false;
      pushEvent(mark.markId, MarkOutcome::kInvalidatedByEpoch);
      bump(markInvalidations_);
      continue;
    }
    if (mark.generation <= cancelled) {
      // A barge-in after this barrier was reached but before the device
      // presented it. Completing it would tell the Gateway that cancelled
      // audio played, which is the one thing this queue exists to prevent.
      mark.active = false;
      pushEvent(mark.markId, MarkOutcome::kCancelled);
      bump(markInvalidations_);
      continue;
    }
    if (presentedFrames >= mark.targetPresentedFrames) {
      mark.active = false;
      pushEvent(mark.markId, MarkOutcome::kCompleted);
      bump(markCompletions_);
    }
  }
  presentedSamples_.store(presentedFrames, std::memory_order_relaxed);

  const uint64_t cancelThrough = cancelThrough_.load(std::memory_order_acquire);
  size_t produced = 0;
  while (produced < count) {
    const uint64_t spanRead = spanRead_.load(std::memory_order_relaxed);
    if (spanRead >= spanWrite_.load(std::memory_order_acquire)) break;
    Span& span = spans_[static_cast<size_t>(spanRead % config_.maxSpans)];

    if (span.generation <= cancelThrough) {
      if (span.kind == SpanKind::kMark) {
        pushEvent(span.markId, MarkOutcome::kCancelled);
        bump(markInvalidations_);
      } else {
        const size_t remaining = span.length - spanOffset_;
        readSamples_.store(span.begin + span.length, std::memory_order_release);
        bump(cancelledSamples_, remaining);
      }
      spanOffset_ = 0;
      spanRead_.store(spanRead + 1, std::memory_order_release);
      continue;
    }

    if (span.kind == SpanKind::kMark) {
      // The audio in front of the barrier has now been handed to the device;
      // the barrier resolves when the device presents that far.
      PendingMark* slot = nullptr;
      for (auto& mark : pendingMarks_) {
        if (!mark.active) {
          slot = &mark;
          break;
        }
      }
      if (slot == nullptr) {
        pushEvent(span.markId, MarkOutcome::kRejectedByOverflow);
        bump(markInvalidations_);
      } else {
        *slot = PendingMark{span.markId, deviceWrittenFrames_ + produced, epoch, span.generation, true};
      }
      spanRead_.store(spanRead + 1, std::memory_order_release);
      continue;
    }

    const size_t available = span.length - spanOffset_;
    const size_t take = std::min(available, count - produced);
    const size_t begin = static_cast<size_t>((span.begin + spanOffset_) % capacitySamples_);
    const size_t firstChunk = std::min(take, capacitySamples_ - begin);
    std::memcpy(out + produced, ring_.data() + begin, firstChunk * sizeof(int16_t));
    if (firstChunk < take) {
      std::memcpy(out + produced + firstChunk, ring_.data(), (take - firstChunk) * sizeof(int16_t));
    }
    produced += take;
    spanOffset_ += take;
    readSamples_.store(span.begin + spanOffset_, std::memory_order_release);
    if (spanOffset_ == span.length) {
      spanOffset_ = 0;
      spanRead_.store(spanRead + 1, std::memory_order_release);
    }
  }

  result.audioSamples = produced;
  result.silenceSamples = count - produced;
  result.contentPending =
      spanRead_.load(std::memory_order_relaxed) < spanWrite_.load(std::memory_order_acquire);
  if (result.silenceSamples > 0) {
    // A response that finished playing leaves an empty queue. Counting that as
    // starvation would turn every healthy conversation into a media incident.
    if (result.contentPending) {
      bump(starvedSilenceSamples_, result.silenceSamples);
    } else {
      bump(idleSilenceSamples_, result.silenceSamples);
    }
    std::memset(out + produced, 0, result.silenceSamples * sizeof(int16_t));
  }
  if (result.audioSamples > 0) {
    audioEndFrame_.store(deviceWrittenFrames_ + count, std::memory_order_release);
  }
  deviceWrittenFrames_ += count;
  return result;
}

void RenderTimeline::endEpoch() {
  // Only barriers already stamped against this stream are invalidated: their
  // target lives in a frame-position origin that is about to stop existing.
  // Audio and barriers still queued are content the assistant has not finished
  // saying, and a stream restart is not a reason to drop the rest of a reply.
  // `spanOffset_` is deliberately preserved for the same reason — rewinding it
  // would replay samples the read cursor has already released to the producer.
  retirePendingMarks(MarkOutcome::kInvalidatedByEpoch);
  deviceWrittenFrames_ = 0;
  audioEndFrame_.store(0, std::memory_order_release);
}

void RenderTimeline::beginEpoch(AudioDeviceClockEpoch epoch) {
  // Idempotent with `endEpoch`: a timeline carried across a restart has already
  // retired its in-flight barriers, and a freshly built one has none.
  endEpoch();
  epoch_.store(epoch.value(), std::memory_order_release);
}

void RenderTimeline::stopAndDrain() {
  retirePendingMarks(MarkOutcome::kInvalidatedByStop);
  // Barriers still queued behind audio the device will never play resolve here
  // rather than stranding: an unresolved barrier reads to the Gateway exactly
  // like an assistant turn that never finished.
  uint64_t spanRead = spanRead_.load(std::memory_order_relaxed);
  const uint64_t spanWrite = spanWrite_.load(std::memory_order_acquire);
  for (; spanRead < spanWrite; ++spanRead) {
    const Span& span = spans_[static_cast<size_t>(spanRead % config_.maxSpans)];
    if (span.kind != SpanKind::kMark) continue;
    pushEvent(span.markId, MarkOutcome::kInvalidatedByStop);
    bump(markInvalidations_);
  }
  spanRead_.store(spanWrite, std::memory_order_release);
  readSamples_.store(writeSamples_.load(std::memory_order_acquire), std::memory_order_release);
  spanOffset_ = 0;
  deviceWrittenFrames_ = 0;
  audioEndFrame_.store(0, std::memory_order_release);
}

uint64_t RenderTimeline::audioEndFrame() const {
  return audioEndFrame_.load(std::memory_order_acquire);
}

void RenderTimeline::retirePendingMarks(MarkOutcome outcome) {
  for (auto& mark : pendingMarks_) {
    if (!mark.active) continue;
    mark.active = false;
    pushEvent(mark.markId, outcome);
    bump(markInvalidations_);
  }
}

bool RenderTimeline::pushEvent(uint64_t markId, MarkOutcome outcome) {
  const uint64_t write = eventWrite_.load(std::memory_order_relaxed);
  if (write - eventRead_.load(std::memory_order_acquire) >= kMaxEvents) {
    bump(markEventOverflows_);
    return false;
  }
  events_[static_cast<size_t>(write % kMaxEvents)] = MarkEvent{markId, outcome};
  eventWrite_.store(write + 1, std::memory_order_release);
  return true;
}

size_t RenderTimeline::drainMarkEvents(MarkEvent* out, size_t max) {
  size_t written = 0;
  uint64_t read = eventRead_.load(std::memory_order_relaxed);
  const uint64_t write = eventWrite_.load(std::memory_order_acquire);
  while (read < write && written < max) {
    out[written++] = events_[static_cast<size_t>(read % kMaxEvents)];
    ++read;
  }
  eventRead_.store(read, std::memory_order_release);
  return written;
}

size_t RenderTimeline::queuedSamples() const {
  return static_cast<size_t>(writeSamples_.load(std::memory_order_acquire) -
                             readSamples_.load(std::memory_order_acquire));
}

RenderTimelineStats RenderTimeline::stats() const {
  RenderTimelineStats out;
  out.submittedSamples = submittedSamples_.load(std::memory_order_relaxed);
  out.presentedSamples = presentedSamples_.load(std::memory_order_relaxed);
  out.cancelledSamples = cancelledSamples_.load(std::memory_order_relaxed);
  out.overflowRejectedSamples = overflowRejectedSamples_.load(std::memory_order_relaxed);
  out.overflowRejectedSubmissions = overflowRejectedSubmissions_.load(std::memory_order_relaxed);
  out.starvedSilenceSamples = starvedSilenceSamples_.load(std::memory_order_relaxed);
  out.idleSilenceSamples = idleSilenceSamples_.load(std::memory_order_relaxed);
  out.markCompletions = markCompletions_.load(std::memory_order_relaxed);
  out.markInvalidations = markInvalidations_.load(std::memory_order_relaxed);
  out.markEventOverflows = markEventOverflows_.load(std::memory_order_relaxed);
  return out;
}

}  // namespace openclaw::media
