// Lazy GPT-Live media runtime: werift peer plus WASM Opus framing and PCM conversion.
import { randomInt } from "node:crypto";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";

const QUICKSILVER_SAMPLE_RATE = 48_000;
const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_CHANNELS = 2;
const OPUS_FRAME_SAMPLES = 960;
const OPUS_FRAME_DURATION_MS = 20;
const RELAY_FRAME_SAMPLES = 480;
const RELAY_FRAME_BYTES = RELAY_FRAME_SAMPLES * 2;
const MAX_PENDING_RELAY_FRAMES = 250;

type WeriftModule = typeof import("werift");
type LibopusModule = typeof import("libopus-wasm");
type WeriftPeerConnection = InstanceType<WeriftModule["RTCPeerConnection"]>;
type WeriftTransceiver = ReturnType<WeriftPeerConnection["addTransceiver"]>;
type WeriftTrack = Parameters<WeriftPeerConnection["onTrack"]["subscribe"]>[0] extends (
  track: infer T,
) => unknown
  ? T
  : never;
type LibopusEncoder = Awaited<ReturnType<LibopusModule["createEncoder"]>>;
type LibopusDecoder = Awaited<ReturnType<LibopusModule["createDecoder"]>>;

export type OpenAIQuicksilverAudioPeerCallbacks = {
  onAudio: (audio: Buffer) => void;
  onError: (error: Error) => void;
  onRtpPacket?: () => void;
};

export type OpenAIQuicksilverAudioPeerContract = {
  createOffer(): Promise<string>;
  applyAnswer(answerSdp: string): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function pcmBufferToInt16(pcm: Buffer): Int16Array {
  const samples = new Int16Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2);
  }
  return samples;
}

function convertRelayPcmToQuicksilverPcm(pcm24kMono: Buffer): Int16Array {
  const mono48k = pcmBufferToInt16(
    resamplePcm(pcm24kMono, RELAY_SAMPLE_RATE, QUICKSILVER_SAMPLE_RATE),
  );
  const stereo48k = new Int16Array(mono48k.length * QUICKSILVER_CHANNELS);
  for (let index = 0; index < mono48k.length; index += 1) {
    const sample = mono48k[index] ?? 0;
    stereo48k[index * 2] = sample;
    stereo48k[index * 2 + 1] = sample;
  }
  return stereo48k;
}

function convertQuicksilverPcmToRelayPcm(pcm48kStereo: Int16Array): Buffer {
  const frameCount = Math.floor(pcm48kStereo.length / QUICKSILVER_CHANNELS);
  const mono48k = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const left = pcm48kStereo[frame * 2] ?? 0;
    const right = pcm48kStereo[frame * 2 + 1] ?? 0;
    mono48k.writeInt16LE(Math.round((left + right) / 2), frame * 2);
  }
  return resamplePcm(mono48k, QUICKSILVER_SAMPLE_RATE, RELAY_SAMPLE_RATE);
}

/** Pure-TypeScript WebRTC media peer with a WASM-only Opus codec. */
export class OpenAIQuicksilverAudioPeer implements OpenAIQuicksilverAudioPeerContract {
  static async create(params: {
    callbacks: OpenAIQuicksilverAudioPeerCallbacks;
    iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
    signal?: AbortSignal;
  }): Promise<OpenAIQuicksilverAudioPeer> {
    const [werift, libopus] = await Promise.all([import("werift"), import("libopus-wasm")]);
    params.signal?.throwIfAborted();
    const peer = new werift.RTCPeerConnection({
      codecs: {
        audio: [werift.useOPUS({ payloadType: 111 })],
        video: [],
      },
      ...(params.iceServers ? { iceServers: params.iceServers } : {}),
    });
    const transceiver = peer.addTransceiver("audio", { direction: "sendrecv" });
    let encoder: LibopusEncoder | undefined;
    let decoder: LibopusDecoder | undefined;
    let encoderFreed = false;
    let decoderFreed = false;
    let peerClosed = false;
    const cleanup = async () => {
      if (encoder && !encoderFreed) {
        encoderFreed = true;
        encoder.free();
      }
      if (decoder && !decoderFreed) {
        decoderFreed = true;
        decoder.free();
      }
      if (!peerClosed) {
        peerClosed = true;
        await peer.close().catch(() => undefined);
      }
    };
    const onAbort = () => void cleanup();
    params.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      encoder = await libopus.createEncoder({
        application: libopus.Application.Voip,
        channels: QUICKSILVER_CHANNELS,
        sampleRate: QUICKSILVER_SAMPLE_RATE,
        frameSize: OPUS_FRAME_SAMPLES,
      });
      params.signal?.throwIfAborted();
      decoder = await libopus.createDecoder({
        channels: QUICKSILVER_CHANNELS,
        sampleRate: QUICKSILVER_SAMPLE_RATE,
      });
      params.signal?.throwIfAborted();
      params.signal?.removeEventListener("abort", onAbort);
      return new OpenAIQuicksilverAudioPeer({
        callbacks: params.callbacks,
        decoder,
        encoder,
        peer,
        transceiver,
        werift,
      });
    } catch (error) {
      params.signal?.removeEventListener("abort", onAbort);
      await cleanup();
      throw error;
    }
  }

  static convertRelayPcm(pcm24kMono: Buffer): Int16Array {
    return convertRelayPcmToQuicksilverPcm(pcm24kMono);
  }

  static convertQuicksilverPcm(pcm48kStereo: Int16Array): Buffer {
    return convertQuicksilverPcmToRelayPcm(pcm48kStereo);
  }

  private connected = false;
  private closed = false;
  private mediaTimer: ReturnType<typeof setInterval> | undefined;
  private pendingAudio = Buffer.alloc(0);
  private sequenceNumber = randomInt(0x1_0000);
  private subscribedTracks = new Set<string>();
  private timestamp = randomInt(0x1_0000_0000);

  private constructor(
    private readonly state: {
      callbacks: OpenAIQuicksilverAudioPeerCallbacks;
      decoder: LibopusDecoder;
      encoder: LibopusEncoder;
      peer: WeriftPeerConnection;
      transceiver: WeriftTransceiver;
      werift: WeriftModule;
    },
  ) {
    state.peer.onTrack.subscribe((track) => this.attachInboundTrack(track));
    state.peer.connectionStateChange.subscribe((connectionState) => {
      if (this.closed) {
        return;
      }
      if (connectionState === "connected") {
        this.connected = true;
        this.startMediaPump();
      } else if (["failed", "disconnected", "closed"].includes(connectionState)) {
        this.connected = false;
        // werift-ice 0.2.2 exits consent polling after setting disconnected
        // (lib/ice/src/ice.js:289), so recovery requires an explicit ICE restart.
        this.state.callbacks.onError(
          new Error(`GPT-Live WebRTC media connection ${connectionState}`),
        );
      }
    });
  }

  async createOffer(): Promise<string> {
    const offer = await this.state.peer.createOffer();
    await this.state.peer.setLocalDescription(offer);
    const sdp = this.state.peer.localDescription?.sdp;
    if (!sdp?.trim()) {
      throw new Error("werift did not produce a GPT-Live SDP offer");
    }
    return sdp;
  }

  async applyAnswer(answerSdp: string): Promise<void> {
    await this.state.peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    // OpenAI answers may not declare SSRCs. Subscribe to the receiver's stable
    // default track directly instead of relying only on peer.ontrack demux.
    this.attachInboundTrack(this.state.transceiver.receiver.track);
  }

  sendAudio(audio: Buffer): void {
    if (this.closed || audio.length < 2) {
      return;
    }
    const evenAudio = audio.subarray(0, audio.length - (audio.length % 2));
    this.pendingAudio =
      this.pendingAudio.length > 0
        ? Buffer.concat([this.pendingAudio, evenAudio])
        : Buffer.from(evenAudio);
    const maxPendingBytes = RELAY_FRAME_BYTES * MAX_PENDING_RELAY_FRAMES;
    if (this.pendingAudio.length > maxPendingBytes) {
      // Keep the newest complete frames. Old microphone audio is less useful than bounded latency.
      this.pendingAudio = this.pendingAudio.subarray(this.pendingAudio.length - maxPendingBytes);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.mediaTimer) {
      clearInterval(this.mediaTimer);
      this.mediaTimer = undefined;
    }
    this.pendingAudio = Buffer.alloc(0);
    this.state.encoder.free();
    this.state.decoder.free();
    void this.state.peer.close().catch(() => undefined);
  }

  private attachInboundTrack(track: WeriftTrack): void {
    if (track.kind !== "audio" || this.subscribedTracks.has(track.uuid)) {
      return;
    }
    this.subscribedTracks.add(track.uuid);
    track.onReceiveRtp.subscribe((packet) => {
      if (this.closed) {
        return;
      }
      try {
        this.state.callbacks.onRtpPacket?.();
        const opusPacket = this.state.werift.dePacketizeRtpPackets("opus", [packet]).data;
        const decoded = this.state.decoder.decode(opusPacket, { maxFrameSize: 5_760 });
        const relayPcm = convertQuicksilverPcmToRelayPcm(decoded);
        if (relayPcm.length > 0) {
          this.state.callbacks.onAudio(relayPcm);
        }
      } catch (error) {
        this.state.callbacks.onError(toError(error));
      }
    });
  }

  private startMediaPump(): void {
    if (this.mediaTimer || this.closed) {
      return;
    }
    this.sendNextAudioFrame();
    this.mediaTimer = setInterval(() => this.sendNextAudioFrame(), OPUS_FRAME_DURATION_MS);
    this.mediaTimer.unref?.();
  }

  private sendNextAudioFrame(): void {
    if (!this.connected || this.closed) {
      return;
    }
    const frame = this.takeNextRelayFrame();
    try {
      const opusPacket = this.state.encoder.encode(convertRelayPcmToQuicksilverPcm(frame), {
        frameSize: OPUS_FRAME_SAMPLES,
      });
      const rtp = new this.state.werift.RtpPacket(
        new this.state.werift.RtpHeader({
          marker: false,
          payloadType: 111,
          sequenceNumber: this.sequenceNumber,
          timestamp: this.timestamp,
        }),
        Buffer.from(opusPacket),
      );
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0;
      // werift queues encrypted UDP synchronously before sendRtp yields
      // (rtpSender.js:538; transport/dtls.js:455), preserving per-tick order.
      void this.state.transceiver.sender.sendRtp(rtp).catch((error: unknown) => {
        this.state.callbacks.onError(toError(error));
      });
    } catch (error) {
      this.state.callbacks.onError(toError(error));
    }
  }

  private takeNextRelayFrame(): Buffer {
    // Relay ticks are framing boundaries: pad partial PCM now, or its tail survives
    // silence and is prepended to a later utterance as stale audio.
    const frame = Buffer.alloc(RELAY_FRAME_BYTES);
    const queuedBytes = Math.min(this.pendingAudio.length, RELAY_FRAME_BYTES);
    if (queuedBytes > 0) {
      this.pendingAudio.copy(frame, 0, 0, queuedBytes);
      this.pendingAudio = this.pendingAudio.subarray(queuedBytes);
    }
    return frame;
  }
}
