import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { GatewayRequestContext } from "./shared-types.js";

const TALK_PTT_COMMANDS = new Set([
  "talk.ptt.start",
  "talk.ptt.stop",
  "talk.ptt.cancel",
  "talk.ptt.once",
]);
const talkPttEventSeqBySessionId = new Map<string, number>();

export function emitTalkPttNodeEvent(params: {
  context: Pick<GatewayRequestContext, "broadcast">;
  nodeId: string;
  command: string;
  payload: unknown;
}): void {
  if (!TALK_PTT_COMMANDS.has(params.command)) {
    return;
  }
  const payloadObj =
    typeof params.payload === "object" && params.payload !== null
      ? (params.payload as Record<string, unknown>)
      : {};
  const captureId = normalizeOptionalString(payloadObj.captureId) ?? randomUUID();
  const sessionId = `node:${params.nodeId}:talk:${captureId}`;
  const seq = (talkPttEventSeqBySessionId.get(sessionId) ?? 0) + 1;
  talkPttEventSeqBySessionId.set(sessionId, seq);
  pruneMapToMaxSize(talkPttEventSeqBySessionId, 2048);

  const type =
    params.command === "talk.ptt.start"
      ? "capture.started"
      : params.command === "talk.ptt.cancel"
        ? "capture.cancelled"
        : params.command === "talk.ptt.once"
          ? "capture.once"
          : "capture.stopped";
  const final = params.command !== "talk.ptt.start";
  const talkEvent = {
    id: `${sessionId}:${seq}`,
    type,
    sessionId,
    captureId,
    seq,
    timestamp: new Date().toISOString(),
    mode: "stt-tts",
    transport: "managed-room",
    brain: "agent-consult",
    final,
    payload: {
      nodeId: params.nodeId,
      command: params.command,
      status: normalizeOptionalString(payloadObj.status) ?? undefined,
      transcript: normalizeOptionalString(payloadObj.transcript) ?? undefined,
    },
  };
  params.context.broadcast(
    "talk.event",
    { nodeId: params.nodeId, command: params.command, talkEvent },
    { dropIfSlow: true },
  );
}
