import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NormalizedEvent } from "../../types.js";

type RecordingEvent = Extract<NormalizedEvent, { type: "call.recording" }>;
type RecordingEventBase = Omit<
  RecordingEvent,
  "type" | "recordingSid" | "recordingUrl" | "status" | "durationSeconds" | "channels" | "errorCode"
>;

export function normalizeTwilioRecordingEvent(
  params: URLSearchParams,
  baseEvent: RecordingEventBase,
): RecordingEvent | null {
  const recordingSid = normalizeOptionalString(params.get("RecordingSid"));
  if (!recordingSid) {
    return null;
  }
  const rawStatus = normalizeOptionalString(params.get("RecordingStatus"));
  const status =
    rawStatus === "in-progress" || rawStatus === "completed" || rawStatus === "absent"
      ? rawStatus
      : "failed";
  const duration = Number.parseInt(params.get("RecordingDuration") ?? "", 10);
  const channels = Number.parseInt(params.get("RecordingChannels") ?? "", 10);
  return {
    ...baseEvent,
    type: "call.recording",
    recordingSid,
    recordingUrl: normalizeOptionalString(params.get("RecordingUrl")),
    status,
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : undefined,
    channels: Number.isFinite(channels) && channels > 0 ? channels : undefined,
    errorCode: normalizeOptionalString(params.get("ErrorCode")),
  };
}

export function buildTwilioRecordingRequestFields(params: {
  webhookUrl: string;
  callId: string;
  record?: boolean;
}): Record<string, string | string[]> {
  if (!params.record) {
    return {};
  }
  const callbackUrl = new URL(params.webhookUrl);
  callbackUrl.searchParams.set("callId", params.callId);
  callbackUrl.searchParams.set("type", "recording");
  return {
    Record: "true",
    RecordingChannels: "dual",
    RecordingTrack: "both",
    RecordingStatusCallback: callbackUrl.toString(),
    RecordingStatusCallbackEvent: ["completed", "absent"],
  };
}
