import { randomUUID } from "node:crypto";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import type { ZoomMeetingsSession } from "./transports/types.js";

export function createZoomMeetingsSession(params: {
  config: ZoomMeetingsConfig;
  resolved: {
    url: string;
    transport: ZoomMeetingsTransport;
    mode: ZoomMeetingsMode;
    agentId: string;
  };
  createdAt: string;
}): ZoomMeetingsSession {
  const { config, createdAt, resolved } = params;
  return {
    id: `zoom_meeting_${randomUUID()}`,
    ...resolved,
    state: "active",
    createdAt,
    updatedAt: createdAt,
    participantIdentity:
      resolved.transport === "chrome-node"
        ? "Zoom guest in Chrome on a paired node"
        : "Zoom guest in the OpenClaw Chrome profile",
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
