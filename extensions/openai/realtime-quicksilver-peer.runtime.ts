// Lazy GPT-Live media runtime: werift peer plus WASM Opus framing and PCM conversion.
import { randomInt } from "node:crypto";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import {
  appendOpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";

const QUICKSILVER_SAMPLE_RATE = 48_000;
const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_CHANNELS = 2;
const OPUS_FRAME_SAMPLES = 960;
const OPUS_FRAME_DURATION_MS = 20;
const INBOUND_REORDER_DEPTH = 4;
// More than two seconds behind cannot be useful 20 ms reordering; fail instead of corrupting Opus state.
const INBOUND_MAX_LATE_PACKETS = 100;
const RTP_SEQUENCE_MODULUS = 0x1_0000;
const RTP_SEQUENCE_HALF_RANGE = RTP_SEQUENCE_MODULUS / 2;

type WeriftModule = typeof import("werift");
type LibopusModule = typeof import("libopus-wasm");
type WeriftPeerConnection = InstanceType<WeriftModule["RTCPeerConnection"]>;
type WeriftTransceiver = ReturnType<WeriftPeerConnection["addTransceiver"]>;
type WeriftRtpPacket = InstanceType<WeriftModule["RtpPacket"]>;
type WeriftTrack = Parameters<WeriftPeerConnection["onTrack"]["subscribe"]>[0] extends (
  track: infer T,
) => unknown
  ? T
  : never;
type LibopusEncoder = Awaited<ReturnType<LibopusModule["createEncoder"]>>;
type LibopusDecoder = Awaited<ReturnType<LibopusModule["createDecoder"]>>;
type InboundRtpState = {
  flushTimer?: ReturnType<typeof setTimeout>;
  nextSequence?: number;
  pendingPackets: Map<number, WeriftRtpPacket>;
};

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

function forwardSequenceDistance(expected: number, sequenceNumber: number): number {
  return (sequenceNumber - expected + RTP_SEQUENCE_MODULUS) & 0xffff;
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
  private activeInboundSsrc: number | undefined;
  private inboundRtpState: InboundRtpState = { pendingPackets: new Map() };
  private mediaTimer: ReturnType<typeof setInterval> | undefined;
  private pendingAudio: Buffer = Buffer.alloc(0);
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
    this.pendingAudio = appendOpenAIQuicksilverPendingAudio(this.pendingAudio, audio);
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
    this.resetInboundRtpState();
    this.state.encoder.free();
    this.state.decoder.free();
    void this.state.peer.close().catch(() => undefined);
  }

  private attachInboundTrack(track: WeriftTrack): void {
    if (track.kind !== "audio" || this.subscribedTracks.has(track.uuid)) {
      return;
    }
    this.subscribedTracks.add(track.uuid);
    track.onReceiveRtp.subscribe((packet) => this.handleInboundRtp(packet));
  }

  private handleInboundRtp(packet: WeriftRtpPacket): void {
    if (this.closed) {
      return;
    }
    try {
      this.state.callbacks.onRtpPacket?.();
      const sequenceNumber = packet.header.sequenceNumber;
      if (this.activeInboundSsrc === undefined) {
        this.activeInboundSsrc = packet.header.ssrc;
      } else if (packet.header.ssrc !== this.activeInboundSsrc) {
        throw new Error("GPT-Live WebRTC audio source changed unexpectedly");
      }
      const state = this.inboundRtpState;
      if (state.nextSequence === undefined) {
        state.nextSequence = (sequenceNumber + 1) & 0xffff;
        this.decodeInboundPacket(packet);
        return;
      }
      const distance = forwardSequenceDistance(state.nextSequence, sequenceNumber);
      if (distance >= RTP_SEQUENCE_HALF_RANGE) {
        const backwardDistance = forwardSequenceDistance(sequenceNumber, state.nextSequence);
        if (backwardDistance <= INBOUND_MAX_LATE_PACKETS) {
          return;
        }
        throw new Error("GPT-Live WebRTC RTP sequence changed unexpectedly");
      }
      if (state.pendingPackets.has(sequenceNumber)) {
        return;
      }
      if (distance === 0) {
        state.nextSequence = (state.nextSequence + 1) & 0xffff;
        this.decodeInboundPacket(packet);
        this.clearInboundFlushTimer(state);
        this.drainInboundPackets(state);
        return;
      }
      state.pendingPackets.set(sequenceNumber, packet);
      this.flushInboundReorderWindow(state);
      this.scheduleInboundFlush(state);
    } catch (error) {
      this.state.callbacks.onError(toError(error));
    }
  }

  private resetInboundRtpState(): void {
    this.clearInboundFlushTimer(this.inboundRtpState);
    this.inboundRtpState.nextSequence = undefined;
    this.inboundRtpState.pendingPackets.clear();
  }

  private flushInboundReorderWindow(state: InboundRtpState, force = false): void {
    const expected = state.nextSequence;
    if (expected === undefined || state.pendingPackets.size === 0) {
      return;
    }
    const pending = [...state.pendingPackets.keys()]
      .map((sequenceNumber) => ({
        sequenceNumber,
        distance: forwardSequenceDistance(expected, sequenceNumber),
      }))
      .filter(({ distance }) => distance < RTP_SEQUENCE_HALF_RANGE)
      .toSorted((left, right) => left.distance - right.distance);
    const nearest = pending[0];
    const farthest = pending.at(-1);
    if (!nearest || !farthest || (!force && farthest.distance < INBOUND_REORDER_DEPTH)) {
      return;
    }
    this.clearInboundFlushTimer(state);

    // Four 20 ms packets cover ordinary Internet reordering. The matching timer
    // flushes a short final tail; concealment is capped before a large discontinuity resync.
    const concealCount = Math.min(nearest.distance, INBOUND_REORDER_DEPTH);
    for (let index = 0; index < concealCount; index += 1) {
      state.nextSequence = ((state.nextSequence ?? 0) + 1) & 0xffff;
      this.decodeInboundPacketLoss();
    }
    if (nearest.distance > INBOUND_REORDER_DEPTH) {
      state.nextSequence = nearest.sequenceNumber;
    }
    this.drainInboundPackets(state);
  }

  private drainInboundPackets(state: InboundRtpState): void {
    while (state.nextSequence !== undefined) {
      const packet = state.pendingPackets.get(state.nextSequence);
      if (!packet) {
        break;
      }
      state.pendingPackets.delete(state.nextSequence);
      state.nextSequence = (state.nextSequence + 1) & 0xffff;
      this.decodeInboundPacket(packet);
    }
    if (state.pendingPackets.size === 0) {
      this.clearInboundFlushTimer(state);
    } else {
      this.scheduleInboundFlush(state);
    }
  }

  private scheduleInboundFlush(state: InboundRtpState): void {
    if (this.closed || state.flushTimer || state.pendingPackets.size === 0) {
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      if (this.closed) {
        return;
      }
      try {
        this.flushInboundReorderWindow(state, true);
      } catch (error) {
        this.state.callbacks.onError(toError(error));
      }
    }, INBOUND_REORDER_DEPTH * OPUS_FRAME_DURATION_MS);
    state.flushTimer.unref?.();
  }

  private clearInboundFlushTimer(state: InboundRtpState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
  }

  private decodeInboundPacket(packet: WeriftRtpPacket): void {
    const opusPacket = this.state.werift.dePacketizeRtpPackets("opus", [packet]).data;
    this.emitInboundPcm(this.state.decoder.decode(opusPacket, { maxFrameSize: 5_760 }));
  }

  private decodeInboundPacketLoss(): void {
    this.emitInboundPcm(this.state.decoder.decodePacketLoss(OPUS_FRAME_SAMPLES));
  }

  private emitInboundPcm(decoded: Int16Array): void {
    const relayPcm = convertQuicksilverPcmToRelayPcm(decoded);
    if (relayPcm.length > 0) {
      this.state.callbacks.onAudio(relayPcm);
    }
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
    const frame = Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    const queuedBytes = Math.min(this.pendingAudio.length, OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    if (queuedBytes > 0) {
      this.pendingAudio.copy(frame, 0, 0, queuedBytes);
      this.pendingAudio = this.pendingAudio.subarray(queuedBytes);
    }
    return frame;
  }
}
