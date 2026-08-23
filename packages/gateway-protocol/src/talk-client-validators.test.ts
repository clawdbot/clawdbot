import { describe, expect, it } from "vitest";
import { validateTalkClientToolCallResult } from "./index.js";

describe("talk client validators", () => {
  it("accepts current tool-call acknowledgements with a canonical agent target", () => {
    expect(
      validateTalkClientToolCallResult({
        runId: "run-1",
        idempotencyKey: "talk-call-1",
        agentId: "main",
        agentSessionKey: "agent:main:main",
      }),
    ).toBe(true);
  });

  it("keeps older protocol-v4 tool-call acknowledgements valid", () => {
    expect(
      validateTalkClientToolCallResult({
        runId: "run-1",
        idempotencyKey: "talk-call-1",
      }),
    ).toBe(true);
  });
});
