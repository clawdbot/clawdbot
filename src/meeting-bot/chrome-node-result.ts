import type { MeetingAudioBackend } from "./audio-backend.js";

type MeetingChromeNodeStartResult<Health> = {
  launched?: boolean;
  bridgeId?: string;
  audioBackend?: MeetingAudioBackend;
  audioBridge?: { type?: string; outputGeneration?: boolean };
  browser?: Health;
};

/** Unwraps the node.invoke envelope while keeping result validation transport-generic. */
export function parseMeetingChromeNodeResult<Health>(
  raw: unknown,
  invalidMessage: string,
): MeetingChromeNodeStartResult<Health> {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error(invalidMessage);
  }
  return value as MeetingChromeNodeStartResult<Health>;
}
