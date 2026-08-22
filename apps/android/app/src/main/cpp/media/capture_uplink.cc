#include "media/capture_uplink.h"

#include <algorithm>
#include <cstring>

namespace openclaw::media {

CaptureUplinkQueue::CaptureUplinkQueue(size_t frameSamples, size_t capacityFrames)
    : frameSamples_(frameSamples),
      capacityFrames_(capacityFrames),
      samples_(frameSamples * capacityFrames, 0),
      slots_(capacityFrames),
      scratch_(frameSamples, 0) {}

bool CaptureUplinkQueue::offer(const CaptureEligibility& eligibility, uint64_t captureFrameIndex,
                               AudioDeviceClockEpoch epoch, const int16_t* frame) {
  const uint64_t write = write_.load(std::memory_order_relaxed);
  const uint64_t read = read_.load(std::memory_order_acquire);
  if (write - read >= capacityFrames_) {
    // Ask the consumer to retire the oldest frame and refuse this one. Moving
    // the read cursor here would overwrite a slot the control thread may be
    // copying out of, which corrupts captured speech instead of dropping it.
    pendingDrop_.fetch_add(1, std::memory_order_release);
    droppedQueueOverflow_.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  const size_t index = static_cast<size_t>(write % capacityFrames_);
  std::memcpy(samples_.data() + index * frameSamples_, frame, frameSamples_ * sizeof(int16_t));
  slots_[index] = Slot{eligibility, captureFrameIndex, epoch.value()};
  write_.store(write + 1, std::memory_order_release);
  if (eligibility.eligibleAtCapture) {
    eligibleFrames_.fetch_add(1, std::memory_order_relaxed);
  }
  return true;
}

bool CaptureUplinkQueue::next(CaptureUplinkEligibilityGeneration currentGeneration,
                              bool sendPermitted, Dequeued* out) {
  uint64_t read = read_.load(std::memory_order_relaxed);
  // Apply the producer's drop request on the side that owns the cursor.
  const uint64_t requested = pendingDrop_.exchange(0, std::memory_order_acquire);
  if (requested > 0) {
    const uint64_t queued = write_.load(std::memory_order_acquire) - read;
    read += std::min<uint64_t>(requested, queued);
    read_.store(read, std::memory_order_release);
  }
  if (read >= write_.load(std::memory_order_acquire)) return false;
  const size_t index = static_cast<size_t>(read % capacityFrames_);
  const Slot slot = slots_[index];
  std::memcpy(scratch_.data(), samples_.data() + index * frameSamples_,
              frameSamples_ * sizeof(int16_t));
  read_.store(read + 1, std::memory_order_release);

  out->captureFrameIndex = slot.captureFrameIndex;
  out->epoch = slot.epoch;
  out->samples = scratch_.data();
  out->sampleCount = frameSamples_;

  // Both gates, in the order they were decided. The capture-time decision is
  // immutable and is checked first, so no later permission can revive audio
  // that was protected when it was recorded.
  if (!slot.eligibility.eligibleAtCapture) {
    out->disposition = UplinkDisposition::kDroppedIneligibleAtCapture;
    droppedIneligibleAtCapture_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  if (slot.eligibility.generation != currentGeneration.value()) {
    out->disposition = UplinkDisposition::kDroppedEligibilityChanged;
    droppedEligibilityChanged_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  if (!sendPermitted) {
    out->disposition = UplinkDisposition::kDroppedSendGateClosed;
    droppedSendGateClosed_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  out->disposition = UplinkDisposition::kSent;
  sentFrames_.fetch_add(1, std::memory_order_relaxed);
  return true;
}

void CaptureUplinkQueue::reset() {
  read_.store(write_.load(std::memory_order_acquire), std::memory_order_release);
}

void CaptureUplinkQueue::recordCaptured() {
  capturedFrames_.fetch_add(1, std::memory_order_relaxed);
}

void CaptureUplinkQueue::recordProcessed() {
  processedFrames_.fetch_add(1, std::memory_order_relaxed);
}

CaptureUplinkStats CaptureUplinkQueue::stats() const {
  CaptureUplinkStats out;
  out.capturedFrames = capturedFrames_.load(std::memory_order_relaxed);
  out.processedFrames = processedFrames_.load(std::memory_order_relaxed);
  out.eligibleFrames = eligibleFrames_.load(std::memory_order_relaxed);
  out.droppedIneligibleAtCapture = droppedIneligibleAtCapture_.load(std::memory_order_relaxed);
  out.droppedEligibilityChanged = droppedEligibilityChanged_.load(std::memory_order_relaxed);
  out.droppedSendGateClosed = droppedSendGateClosed_.load(std::memory_order_relaxed);
  out.droppedQueueOverflow = droppedQueueOverflow_.load(std::memory_order_relaxed);
  out.sentFrames = sentFrames_.load(std::memory_order_relaxed);
  return out;
}

}  // namespace openclaw::media
