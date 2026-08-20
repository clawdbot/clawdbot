/**
 * Resolves command queue lane names for embedded-agent sessions and global work.
 */
import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations need a dedicated lane
  // to avoid deadlock without widening shared nested flows.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.CronNested;
  }
  return cleaned ? cleaned : CommandLane.Main;
}

/**
 * Keeps heartbeat execution serialized per session without occupying the
 * process-wide inbound lane while the embedded run is in progress.
 */
export function resolveEmbeddedRunGlobalLane(params: { isHeartbeat: boolean }) {
  return params.isHeartbeat ? CommandLane.CronNested : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
