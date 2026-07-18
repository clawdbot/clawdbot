import { randomUUID } from "node:crypto";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import type { TeamsMeetingsSession } from "./transports/types.js";

export function createTeamsMeetingsSession(params: {
  config: TeamsMeetingsConfig;
  resolved: {
    url: string;
    transport: TeamsMeetingsTransport;
    mode: TeamsMeetingsMode;
    agentId: string;
  };
  createdAt: string;
}): TeamsMeetingsSession {
  const { config, createdAt, resolved } = params;
  return {
    id: `teams_meeting_${randomUUID()}`,
    ...resolved,
    state: "active",
    createdAt,
    updatedAt: createdAt,
    participantIdentity:
      resolved.transport === "chrome-node"
        ? "Microsoft Teams guest in Chrome on a paired node"
        : "Microsoft Teams guest in the OpenClaw Chrome profile",
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
