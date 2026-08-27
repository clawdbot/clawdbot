import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { buildSessionsYieldAcknowledgmentPayload } from "./sessions-yield-acknowledgment.js";

describe("buildSessionsYieldAcknowledgmentPayload", () => {
  const baseParams = {
    yielded: true,
    yieldAcknowledgment: " Research started; results will follow. ",
    isInteractive: true,
    isSubagentSession: false,
    hasExplicitSilentReply: false,
    hasVisibleMessageDelivery: false,
  } as const;

  it("builds an explicit waiting status", () => {
    const payload = buildSessionsYieldAcknowledgmentPayload(baseParams);

    expect(payload).toEqual({
      text: "Research started; results will follow.",
    });
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([
    { label: "non-yielded turn", overrides: { yielded: false } },
    { label: "missing acknowledgment", overrides: { yieldAcknowledgment: undefined } },
    { label: "internal turn", overrides: { isInteractive: false } },
    { label: "heartbeat", overrides: { isHeartbeat: true } },
    { label: "silent turn", overrides: { silentExpected: true } },
    { label: "subagent session", overrides: { isSubagentSession: true } },
    { label: "explicit silent reply", overrides: { hasExplicitSilentReply: true } },
    { label: "visible message delivery", overrides: { hasVisibleMessageDelivery: true } },
  ])("suppresses the status for a $label", ({ overrides }) => {
    expect(
      buildSessionsYieldAcknowledgmentPayload({ ...baseParams, ...overrides }),
    ).toBeUndefined();
  });
});
