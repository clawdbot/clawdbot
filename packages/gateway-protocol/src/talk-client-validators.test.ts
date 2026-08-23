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

  it("rejects a tool-call acknowledgement with only an agent id", () => {
    expect(
      validateTalkClientToolCallResult({
        runId: "run-1",
        idempotencyKey: "talk-call-1",
        agentId: "main",
      }),
    ).toBe(false);
  });

  it("rejects a tool-call acknowledgement with only an agent session key", () => {
    expect(
      validateTalkClientToolCallResult({
        runId: "run-1",
        idempotencyKey: "talk-call-1",
        agentSessionKey: "agent:main:main",
      }),
    ).toBe(false);
  });
});
