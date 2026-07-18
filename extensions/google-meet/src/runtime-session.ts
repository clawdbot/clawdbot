import { randomUUID } from "node:crypto";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import type { GoogleMeetSession } from "./transports/types.js";

export function createGoogleMeetSession(params: {
  config: GoogleMeetConfig;
  resolved: {
    url: string;
    transport: GoogleMeetTransport;
    mode: GoogleMeetMode;
    agentId: string;
  };
  createdAt: string;
}): GoogleMeetSession {
  const { config, createdAt, resolved } = params;
  return {
    id: `meet_${randomUUID()}`,
    ...resolved,
    state: "active",
    createdAt,
    updatedAt: createdAt,
    participantIdentity:
      resolved.transport === "twilio"
        ? "Twilio phone participant"
        : resolved.transport === "chrome-node"
          ? "signed-in Google Chrome profile on a paired node"
          : "signed-in Google Chrome profile",
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
