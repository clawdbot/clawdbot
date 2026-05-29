import type { SessionConfig } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type SdkUserInputRequest = Parameters<UserInputHandler>[0];
type SdkUserInputResponse = Awaited<ReturnType<UserInputHandler>>;

import {
  composeUserInputPolicies,
  createUserInputBridge,
  delegatingUserInputPolicy,
  denyAllUserInputPolicy,
  firstChoicePolicy,
  staticAnswerPolicy,
  DENY_ALL_ANSWER,
  type CopilotUserInputContext,
  type CopilotUserInputPolicy,
} from "./user-input-bridge.js";

function makeRequest(overrides: Partial<SdkUserInputRequest> = {}): SdkUserInputRequest {
  return {
    question: "what is your name?",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CopilotUserInputContext> = {}): CopilotUserInputContext {
  return {
    request: makeRequest(),
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("denyAllUserInputPolicy", () => {
  it("returns the fail-closed DENY_ALL_ANSWER as a freeform answer", async () => {
    const result = await denyAllUserInputPolicy(makeCtx());
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });
});

describe("firstChoicePolicy", () => {
  it("returns the first choice (wasFreeform: false) when choices are present", async () => {
    const result = await firstChoicePolicy(
      makeCtx({ request: makeRequest({ choices: ["yes", "no"] }) }),
    );
    expect(result).toEqual({ answer: "yes", wasFreeform: false });
  });

  it("falls back to DENY_ALL_ANSWER when choices are empty", async () => {
    const result = await firstChoicePolicy(makeCtx({ request: makeRequest({ choices: [] }) }));
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });

  it("falls back to DENY_ALL_ANSWER when choices are absent", async () => {
    const result = await firstChoicePolicy(makeCtx());
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });
});

describe("staticAnswerPolicy", () => {
  it("returns the configured answer for every request", async () => {
    const policy = staticAnswerPolicy({ answer: "Alice" });
    for (const question of ["a?", "b?", "c?"]) {
      const result = await policy(makeCtx({ request: makeRequest({ question }) }));
      expect(result).toEqual({ answer: "Alice", wasFreeform: true });
    }
  });

  it("respects wasFreeform=false override", async () => {
    const policy = staticAnswerPolicy({ answer: "yes", wasFreeform: false });
    const result = await policy(makeCtx());
    expect(result).toEqual({ answer: "yes", wasFreeform: false });
  });
});

describe("delegatingUserInputPolicy", () => {
  it("forwards the request and returns the host response", async () => {
    const onRequest = vi
      .fn<CopilotUserInputPolicy>()
      .mockResolvedValue({ answer: "Bob", wasFreeform: true } satisfies SdkUserInputResponse);
    const policy = delegatingUserInputPolicy({ onRequest });
    const ctx = makeCtx({ sessionId: "sess-xyz" });
    const result = await policy(ctx);
    expect(result).toEqual({ answer: "Bob", wasFreeform: true });
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith(ctx);
  });

  it("returns DENY_ALL_ANSWER when host callback returns undefined", async () => {
    const onRequest = vi.fn<CopilotUserInputPolicy>().mockResolvedValue(undefined);
    const policy = delegatingUserInputPolicy({ onRequest });
    const result = await policy(makeCtx());
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });

  it("converts thrown errors into a DENY_ALL_ANSWER with the error message appended", async () => {
    const policy = delegatingUserInputPolicy({
      onRequest: () => {
        throw new Error("prompt timeout");
      },
    });
    const result = await policy(makeCtx());
    expect(result).toBeDefined();
    expect(result!.wasFreeform).toBe(true);
    expect(result!.answer).toContain(DENY_ALL_ANSWER);
    expect(result!.answer).toContain("prompt timeout");
  });

  it("falls back to onError policy when onRequest throws", async () => {
    const onError = vi
      .fn<CopilotUserInputPolicy>()
      .mockResolvedValue({ answer: "fallback", wasFreeform: true });
    const policy = delegatingUserInputPolicy({
      onRequest: () => {
        throw new Error("host boom");
      },
      onError,
    });
    const result = await policy(makeCtx());
    expect(result).toEqual({ answer: "fallback", wasFreeform: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("falls through to error-message response when onError also throws", async () => {
    const policy = delegatingUserInputPolicy({
      onRequest: () => {
        throw new Error("host boom");
      },
      onError: () => {
        throw new Error("fallback boom");
      },
    });
    const result = await policy(makeCtx());
    expect(result).toBeDefined();
    expect(result!.answer).toContain("host boom");
  });

  it("formats non-Error throws via JSON.stringify", async () => {
    const policy = delegatingUserInputPolicy({
      onRequest: () => {
        throw { code: 7, msg: "weird" } as unknown as Error;
      },
    });
    const result = await policy(makeCtx());
    expect(result).toBeDefined();
    expect(result!.answer).toContain('"code":7');
  });
});

describe("composeUserInputPolicies", () => {
  it("returns the first non-undefined result and skips subsequent policies", async () => {
    const a: CopilotUserInputPolicy = () => undefined;
    const b: CopilotUserInputPolicy = () => ({ answer: "from-b", wasFreeform: true });
    const c = vi.fn<CopilotUserInputPolicy>(() => ({ answer: "from-c", wasFreeform: true }));
    const policy = composeUserInputPolicies(a, b, c);
    const result = await policy(makeCtx());
    expect(result).toEqual({ answer: "from-b", wasFreeform: true });
    expect(c).not.toHaveBeenCalled();
  });

  it("falls through to DENY_ALL_ANSWER when all policies return undefined", async () => {
    const policy = composeUserInputPolicies(
      () => undefined,
      () => undefined,
    );
    const result = await policy(makeCtx());
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });

  it("short-circuits to error-message response when any policy throws", async () => {
    const later = vi.fn<CopilotUserInputPolicy>(() => ({ answer: "later", wasFreeform: true }));
    const policy = composeUserInputPolicies(() => {
      throw new Error("compose boom");
    }, later);
    const result = await policy(makeCtx());
    expect(result).toBeDefined();
    expect(result!.answer).toContain("compose boom");
    expect(later).not.toHaveBeenCalled();
  });
});

describe("createUserInputBridge", () => {
  it("adapts a policy to the SDK UserInputHandler shape", async () => {
    const handler = createUserInputBridge(staticAnswerPolicy({ answer: "Alice" }));
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ answer: "Alice", wasFreeform: true });
  });

  it("defaults to denyAllUserInputPolicy when no policy is passed", async () => {
    const handler = createUserInputBridge();
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });

  it("forwards the SDK sessionId into the policy context", async () => {
    const policy = vi.fn<CopilotUserInputPolicy>(() => ({ answer: "x", wasFreeform: true }));
    const handler = createUserInputBridge(policy);
    await handler(makeRequest({ question: "q?", choices: ["a"] }), { sessionId: "sess-xyz" });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy.mock.calls[0]?.[0]).toEqual({
      sessionId: "sess-xyz",
      request: { question: "q?", choices: ["a"] },
    });
  });

  it("never throws when policy throws; returns DENY_ALL_ANSWER with the error message", async () => {
    const handler = createUserInputBridge(() => {
      throw new Error("policy boom");
    });
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result.answer).toContain(DENY_ALL_ANSWER);
    expect(result.answer).toContain("policy boom");
    expect(result.wasFreeform).toBe(true);
  });

  it("never returns undefined: a policy returning undefined yields fail-closed answer", async () => {
    const handler = createUserInputBridge(() => undefined);
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ answer: DENY_ALL_ANSWER, wasFreeform: true });
  });

  it("preserves wasFreeform=false from a policy that picked from choices", async () => {
    const handler = createUserInputBridge(firstChoicePolicy);
    const result = await handler(makeRequest({ choices: ["one", "two"], allowFreeform: false }), {
      sessionId: "sess-1",
    });
    expect(result).toEqual({ answer: "one", wasFreeform: false });
  });
});
