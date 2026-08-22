#ifndef OPENCLAW_MEDIA_ANDROID_OBOE_DEVICE_IO_H_
#define OPENCLAW_MEDIA_ANDROID_OBOE_DEVICE_IO_H_

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include <oboe/Oboe.h>

#include "media/realtime_media_core.h"

namespace openclaw::media {

// Which microphone preset the input stream asks for.
//
// This is the second half of "one echo control owner": on a route where the
// software canceller owns echo, the least-preprocessed microphone Android will
// give us is the right input, because a device-side canceller in front of it
// changes the near-end signal without changing our far-end reference.
enum class InputPresetChoice : int32_t {
  // Communication preset: the platform's own voice pipeline processes the
  // microphone. Correct where the platform owns echo control.
  kVoiceCommunication = 0,
  // Recognition preset: conventionally no device echo control, gain control or
  // noise suppression. The default where the software canceller owns echo.
  kVoiceRecognition,
  // Unprocessed, where the device declares support for it.
  kUnprocessed,
};

struct DeviceStreamConfig {
  InputPresetChoice inputPreset = InputPresetChoice::kVoiceRecognition;
  // `AudioDeviceInfo.id` of the microphone the operator selected, or
  // `oboe::Unspecified`. A user who chose a USB or Bluetooth microphone keeps
  // that choice on this path exactly as they do on the fallback path.
  int32_t preferredInputDeviceId = oboe::kUnspecified;
};

struct DeviceStreamState {
  bool running = false;
  int inputSampleRateHz = 0;
  int outputSampleRateHz = 0;
  int inputLatencyMs = 0;
  int outputLatencyMs = 0;
  int inputBurstFrames = 0;
  int outputBurstFrames = 0;
  int32_t inputPreset = 0;
  int32_t performanceMode = 0;
  // What the platform actually routed the input to, which is not necessarily
  // what was requested.
  int32_t inputDeviceId = 0;
  std::string lastError;
};

// Owns the pair of Oboe streams and forwards their callbacks into the engine.
//
// Errors never reopen a stream from the callback thread: the fault is handed to
// the serialized control owner, which is also the only caller of `start`,
// `stop` and `restart`.
class OboeDeviceIo;

// The object Oboe holds, kept alive by Oboe's own `shared_ptr`.
//
// Oboe deprecates the raw-pointer callback setters precisely because a stream
// can deliver a callback — `onErrorAfterClose` in particular — after the owner
// believes it is finished. Detaching this shim makes such a callback a no-op
// instead of a call into freed memory, so lifetime stops depending on a
// momentary observation that no callback happened to be running.
class OboeCallbackShim : public oboe::AudioStreamDataCallback,
                         public oboe::AudioStreamErrorCallback {
 public:
  explicit OboeCallbackShim(OboeDeviceIo* owner) : owner_(owner) {}

  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData,
                                        int32_t numFrames);
  void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result result);

  // Stops dispatch and waits for callbacks already inside to leave. Returns
  // false if one never did, in which case the owner must not be freed.
  bool detachAndDrain();

  bool quiesced() const { return admitted_.load(std::memory_order_seq_cst) == 0; }

 private:
  std::atomic<OboeDeviceIo*> owner_;
  // Incremented before `owner_` is read, so a detach either sees this callback
  // and waits for it or is seen by it and turns it away. Counting inside the
  // owner would be too late: the load could be preempted between the two.
  std::atomic<int> admitted_{0};
};

class OboeDeviceIo {
 public:
  using ErrorHandler = std::function<void(int errorCode, bool isInput)>;

  OboeDeviceIo(RealtimeMediaCore& core, ErrorHandler onError);
  ~OboeDeviceIo();

  bool start(const DeviceStreamConfig& config);
  void stop();
  DeviceStreamState state() const;

  // True when no callback is between entering the shim and leaving it. The
  // owner that frees the engine must consult this as well as the core's own
  // gate: a callback is admitted at the shim before it reaches the core, so the
  // core can read zero while one is still on its way in.
  bool callbacksQuiesced() const { return shim_->quiesced(); }

  // Called only through the shim, which is what Oboe holds.
  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData,
                                        int32_t numFrames);
  void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result result);

 private:
  bool openOutput();
  bool openInput(const DeviceStreamConfig& config);
  // Takes the stream the callback was handed rather than reading the member,
  // which `start` and `stop` replace under a mutex a realtime thread must not
  // take.
  static uint64_t presentedFrames(oboe::AudioStream* output);
  // Waits for admitted callbacks to leave. Publishes the result rather than
  // blocking teardown forever on a device whose callback thread has stopped.
  bool awaitCallbackQuiescence();

  RealtimeMediaCore& core_;
  ErrorHandler onError_;
  std::shared_ptr<oboe::AudioStream> output_;
  std::shared_ptr<oboe::AudioStream> input_;
  // Identities of the streams currently owned, for callbacks that arrive
  // without the mutex. Compared, never dereferenced: `start` and `stop`
  // replace the owning pointers under the mutex, so a callback from a retired
  // stream matches neither and is ignored.
  std::atomic<oboe::AudioStream*> currentOutput_{nullptr};
  std::atomic<oboe::AudioStream*> currentInput_{nullptr};
  mutable std::mutex mutex_;
  DeviceStreamState state_;
  std::atomic<bool> running_{false};
  // Tracks whether the engine still holds an open device clock epoch. An
  // asynchronous error close clears `running_` before the control owner gets
  // there, so `running_` alone cannot decide whether the epoch still needs
  // ending — and an epoch that never ends takes its playback barriers with it.
  std::atomic<bool> epochOpen_{false};
  // Incremented as the very first thing a data callback does, before it looks
  // at `running_` or the stream identities. A callback descheduled between
  // those checks and the engine would otherwise be invisible to teardown, and
  // the engine it is about to touch could already be freed.
  // Co-owned with Oboe, and outlives this object if Oboe still holds a stream.
  std::shared_ptr<OboeCallbackShim> shim_;
};

}  // namespace openclaw::media

#endif  // OPENCLAW_MEDIA_ANDROID_OBOE_DEVICE_IO_H_
