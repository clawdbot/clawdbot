import type {
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetModeInput,
  GoogleMeetTransport,
} from "./config.js";
import type { GoogleMeetSession } from "./transports/types.js";

export function resolveTransport(
  input: GoogleMeetTransport | undefined,
  config: GoogleMeetConfig,
): GoogleMeetTransport {
  return input ?? config.defaultTransport;
}

export function resolveMode(
  input: GoogleMeetModeInput | undefined,
  config: GoogleMeetConfig,
): GoogleMeetMode {
  return input === "realtime" ? "agent" : (input ?? config.defaultMode);
}

export function withSessionAgentConfig(
  config: GoogleMeetConfig,
  agentId: string,
): GoogleMeetConfig {
  return config.realtime.agentId === agentId
    ? config
    : { ...config, realtime: { ...config.realtime, agentId } };
}

export function isBrowserTransport(transport: GoogleMeetTransport): boolean {
  return transport === "chrome" || transport === "chrome-node";
}

export function noteSession(session: GoogleMeetSession, note: string): void {
  session.notes = [...session.notes.filter((item) => item !== note), note];
}
