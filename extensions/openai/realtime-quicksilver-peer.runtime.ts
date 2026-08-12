import {
  RealtimeWebRtcAudioPeer,
  type RealtimeWebRtcAudioPeerCallbacks,
  type RealtimeWebRtcAudioPeerContract,
} from "openclaw/plugin-sdk/realtime-voice";

export type OpenAIQuicksilverAudioPeerCallbacks = RealtimeWebRtcAudioPeerCallbacks;
export type OpenAIQuicksilverAudioPeerContract = RealtimeWebRtcAudioPeerContract;
export type OpenAIQuicksilverAudioPeer = RealtimeWebRtcAudioPeer;

type OpenAIQuicksilverAudioPeerCreateParams = Omit<
  Parameters<typeof RealtimeWebRtcAudioPeer.create>[0],
  "diagnosticLabel" | "loadDependencies"
>;

export const OpenAIQuicksilverAudioPeer = {
  create: (params: OpenAIQuicksilverAudioPeerCreateParams) =>
    RealtimeWebRtcAudioPeer.create({
      ...params,
      diagnosticLabel: "GPT-Live",
      loadDependencies: async () => {
        const [werift, libopus] = await Promise.all([import("werift"), import("libopus-wasm")]);
        return { werift, libopus };
      },
    }),
  convertRelayPcm: (pcm: Buffer) => RealtimeWebRtcAudioPeer.convertRelayPcm(pcm),
  convertQuicksilverPcm: (pcm: Int16Array) => RealtimeWebRtcAudioPeer.convertWebRtcPcm(pcm),
};
