import { randomUUID } from "node:crypto";
import type { MeetingPlatformRuntimeMetadata } from "./platform-adapter-contract.js";
import type { MeetingResolvedJoin, MeetingSessionRecord } from "./session-types.js";

export function createMeetingSession<
  TTransport extends string,
  TMode extends string,
  TToolPolicy extends string,
>(params: {
  platform: MeetingPlatformRuntimeMetadata;
  config: {
    realtime: {
      provider?: string;
      voiceProvider?: string;
      transcriptionProvider?: string;
      model?: string;
      toolPolicy: TToolPolicy;
    };
  };
  resolved: MeetingResolvedJoin<TTransport, TMode>;
  createdAt: string;
}): MeetingSessionRecord<
  TTransport,
  TMode,
  {
    enabled: boolean;
    strategy: string;
    provider: string | undefined;
    model: string | undefined;
    transcriptionProvider: string | undefined;
    toolPolicy: TToolPolicy;
  }
> {
  const { config, createdAt, platform, resolved } = params;
  return {
    id: `${platform.session.idPrefix}_${randomUUID()}`,
    ...resolved,
    state: "active",
    createdAt,
    updatedAt: createdAt,
    participantIdentity: platform.session.participantIdentity(resolved.transport),
    realtime: {
      enabled: resolved.mode === "agent" || resolved.mode === "bidi",
      strategy: resolved.mode === "bidi" ? "bidi" : "agent",
      provider:
        resolved.mode === "bidi"
          ? (config.realtime.voiceProvider ?? config.realtime.provider)
          : undefined,
      model: resolved.mode === "bidi" ? config.realtime.model : undefined,
      transcriptionProvider:
        resolved.mode === "agent"
          ? (config.realtime.transcriptionProvider ?? config.realtime.provider)
          : undefined,
      toolPolicy: config.realtime.toolPolicy,
    },
    notes: [],
  };
}
