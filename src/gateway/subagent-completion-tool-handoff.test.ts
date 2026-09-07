import { describe, expect, it } from "vitest";
import {
  cancelSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

const registration = {
  sourceSessionKey: "agent:main:subagent:child",
  sourceSessionId: "child-session",
  targetSessionKey: "agent:main:main",
  targetSessionId: "requester-session",
  idempotencyKey: "announce-1",
} as const;

function consume(handoffId: string | undefined, overrides: Record<string, unknown> = {}) {
  return consumeSubagentCompletionToolHandoff({
    handoffId,
    ...registration,
    provider: "openai",
    model: "glm-4.5",
    ...overrides,
  });
}

describe("subagent completion tool handoff", () => {
  it("consumes the exact capability once and binds it to the admitted route", () => {
    const handoffId = registerSubagentCompletionToolHandoff(registration);
    expect(consume(handoffId)).toEqual({
      kind: "subagent-completion",
      sourceSessionKey: registration.sourceSessionKey,
      sourceSessionId: registration.sourceSessionId,
      targetSessionKey: registration.targetSessionKey,
      targetSessionId: registration.targetSessionId,
      provider: "openai",
      model: "glm-4.5",
    });
    expect(consume(handoffId)).toBeUndefined();
  });

  it.each([
    ["source session", { sourceSessionKey: "agent:main:subagent:forged" }],
    ["source run", { sourceSessionId: "forged-child-session" }],
    ["target session", { targetSessionKey: "agent:main:other" }],
    ["target run", { targetSessionId: "replaced-requester-session" }],
    ["idempotency key", { idempotencyKey: "announce-forged" }],
  ])("rejects a mismatched %s without burning the valid capability", (_name, overrides) => {
    const handoffId = registerSubagentCompletionToolHandoff(registration);
    expect(consume(handoffId, overrides)).toBeUndefined();
    expect(consume(handoffId)).toBeDefined();
  });

  it("rejects missing and forged capability ids", () => {
    expect(consume(undefined)).toBeUndefined();
    expect(consume("forged")).toBeUndefined();
  });

  it("expires capabilities and removes cancelled capabilities", () => {
    const expiredId = registerSubagentCompletionToolHandoff({ ...registration, nowMs: 1_000 });
    expect(consume(expiredId, { nowMs: 301_001 })).toBeUndefined();

    const cancelledId = registerSubagentCompletionToolHandoff(registration);
    expect(cancelSubagentCompletionToolHandoff(cancelledId)).toBe(true);
    expect(consume(cancelledId)).toBeUndefined();
  });

  it("allows exactly one winner under concurrent consumption", async () => {
    const handoffId = registerSubagentCompletionToolHandoff(registration);
    const results = await Promise.all([
      Promise.resolve().then(() => consume(handoffId)),
      Promise.resolve().then(() => consume(handoffId)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
