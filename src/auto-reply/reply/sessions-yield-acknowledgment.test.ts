import { describe, expect, it } from "vitest";
import { buildSessionsYieldAcknowledgmentPayload } from "./sessions-yield-acknowledgment.js";

describe("buildSessionsYieldAcknowledgmentPayload", () => {
  const baseParams = {
    yielded: true,
    yieldAcknowledgment: " Research started; results will follow. ",
    isInteractive: true,
    isMessageToolOnly: false,
    isSubagentSession: false,
    hasExplicitSilentReply: false,
    hasVisibleMessageDelivery: false,
  } as const;

  it("builds an explicit waiting status", () => {
    expect(buildSessionsYieldAcknowledgmentPayload(baseParams)).toEqual({
      text: "Research started; results will follow.",
    });
  });

  it.each([
    { label: "non-yielded turn", overrides: { yielded: false } },
    { label: "missing acknowledgment", overrides: { yieldAcknowledgment: undefined } },
    { label: "internal turn", overrides: { isInteractive: false } },
    { label: "heartbeat", overrides: { isHeartbeat: true } },
    { label: "silent turn", overrides: { silentExpected: true } },
    { label: "message-tool-only turn", overrides: { isMessageToolOnly: true } },
    { label: "subagent session", overrides: { isSubagentSession: true } },
    { label: "explicit silent reply", overrides: { hasExplicitSilentReply: true } },
    { label: "visible message delivery", overrides: { hasVisibleMessageDelivery: true } },
  ])("suppresses the status for a $label", ({ overrides }) => {
    expect(
      buildSessionsYieldAcknowledgmentPayload({ ...baseParams, ...overrides }),
    ).toBeUndefined();
  });
});
