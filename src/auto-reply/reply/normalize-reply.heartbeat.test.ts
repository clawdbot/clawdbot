import { expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { HEARTBEAT_TOKEN } from "../tokens.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";

it("preserves a host-approved heartbeat acknowledgment while retaining channel transforms", () => {
  const payload = setReplyPayloadMetadata({ text: HEARTBEAT_TOKEN }, { heartbeatReply: true });
  expect(normalizeReplyPayloadOutcome(payload)).toEqual({ kind: "deliver", payload });
  expect(normalizeReplyPayloadOutcome({ ...payload })).toEqual({
    kind: "suppress",
    reason: "heartbeat",
  });
  expect(normalizeReplyPayloadOutcome(payload, { transformReplyPayload: () => null })).toEqual({
    kind: "suppress",
    reason: "channel_transform",
  });
});
