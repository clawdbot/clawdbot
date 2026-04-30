import type { QueueMode } from "./types.js";

export type PiSteeringMode = "all" | "one-at-a-time";

export function isSteeringQueueMode(mode: QueueMode): boolean {
  return mode === "steer" || mode === "queue" || mode === "steer-backlog";
}

export function resolvePiSteeringModeForQueueMode(mode: QueueMode): PiSteeringMode {
  return mode === "queue" ? "one-at-a-time" : "all";
}
