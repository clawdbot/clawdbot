import type {
  PermissionRequest as SdkPermissionRequest,
  PermissionRequestResult as SdkPermissionRequestResult,
} from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  allowListPolicy,
  allowOncePolicy,
  composePolicies,
  createPermissionBridge,
  delegatingPolicy,
  rejectAllPolicy,
  REJECT_ALL_FEEDBACK,
  type CopilotPermissionContext,
  type CopilotPermissionPolicy,
} from "./permission-bridge.js";

function makeRequest(overrides: Partial<SdkPermissionRequest> = {}): SdkPermissionRequest {
  if (overrides.kind && overrides.kind !== "shell") {
    return {
      toolCallId: "call-1",
      ...overrides,
    } as SdkPermissionRequest;
  }
  return {
    canOfferSessionApproval: false,
    commands: [],
    fullCommandText: "echo test",
    hasWriteFileRedirection: false,
    intention: "test command",
    kind: "shell",
    possiblePaths: [],
    possibleUrls: [],
    toolCallId: "call-1",
    ...overrides,
  } as SdkPermissionRequest;
}

function makeCtx(overrides: Partial<CopilotPermissionContext> = {}): CopilotPermissionContext {
  return {
    request: makeRequest(),
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("rejectAllPolicy", () => {
  it("returns reject with the fail-closed feedback", async () => {
    const result = await rejectAllPolicy(makeCtx());
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });
});

describe("allowOncePolicy", () => {
  it("returns approve-once for every request kind", async () => {
    for (const kind of [
      "shell",
      "write",
      "mcp",
      "read",
      "url",
      "custom-tool",
      "memory",
      "hook",
    ] as const) {
      const result = await allowOncePolicy(makeCtx({ request: makeRequest({ kind }) }));
      expect(result).toEqual({ kind: "approve-once" });
    }
  });
});

describe("allowListPolicy", () => {
  it("approves listed kinds and rejects others with default feedback", async () => {
    const policy = allowListPolicy({ kinds: ["read"] });
    const approved = await policy(makeCtx({ request: makeRequest({ kind: "read" }) }));
    expect(approved).toEqual({ kind: "approve-once" });
    const rejected = await policy(makeCtx({ request: makeRequest({ kind: "shell" }) }));
    expect(rejected).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });

  it("uses custom rejectFeedback when provided", async () => {
    const policy = allowListPolicy({
      kinds: ["read"],
      rejectFeedback: "only reads allowed",
    });
    const result = await policy(makeCtx({ request: makeRequest({ kind: "write" }) }));
    expect(result).toEqual({ kind: "reject", feedback: "only reads allowed" });
  });

  it("supports multiple kinds in the allow-list", async () => {
    const policy = allowListPolicy({ kinds: ["read", "write"] });
    expect(await policy(makeCtx({ request: makeRequest({ kind: "read" }) }))).toEqual({
      kind: "approve-once",
    });
    expect(await policy(makeCtx({ request: makeRequest({ kind: "write" }) }))).toEqual({
      kind: "approve-once",
    });
    expect((await policy(makeCtx({ request: makeRequest({ kind: "mcp" }) })))?.kind).toBe("reject");
  });

  it("rejects all when given an empty allow-list", async () => {
    const policy = allowListPolicy({ kinds: [] });
    for (const kind of ["shell", "read", "write"] as const) {
      const result = await policy(makeCtx({ request: makeRequest({ kind }) }));
      expect(result?.kind).toBe("reject");
    }
  });
});

describe("delegatingPolicy", () => {
  it("forwards the request to the host callback and returns its decision", async () => {
    const onRequest = vi.fn<CopilotPermissionPolicy>().mockResolvedValue({
      kind: "approve-for-session",
    } satisfies SdkPermissionRequestResult);
    const policy = delegatingPolicy({ onRequest });
    const ctx = makeCtx({ sessionId: "sess-xyz", request: makeRequest({ kind: "write" }) });
    const result = await policy(ctx);
    expect(result).toEqual({ kind: "approve-for-session" });
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith(ctx);
  });

  it("returns the rejectAll default when host callback returns undefined", async () => {
    const onRequest = vi.fn<CopilotPermissionPolicy>().mockResolvedValue(undefined);
    const policy = delegatingPolicy({ onRequest });
    const result = await policy(makeCtx());
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });

  it("rejects with the error message when host callback throws", async () => {
    const onRequest = vi
      .fn<CopilotPermissionPolicy>()
      .mockRejectedValue(new Error("host policy boom"));
    const policy = delegatingPolicy({ onRequest });
    const result = await policy(makeCtx());
    expect(result?.kind).toBe("reject");
    expect((result as { feedback?: string }).feedback).toContain("host policy boom");
  });

  it("falls back to onError policy when host callback throws", async () => {
    const onError = vi.fn<CopilotPermissionPolicy>().mockResolvedValue({ kind: "approve-once" });
    const policy = delegatingPolicy({
      onRequest: () => {
        throw new Error("host policy boom");
      },
      onError,
    });
    const result = await policy(makeCtx());
    expect(result).toEqual({ kind: "approve-once" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("falls through to a hard-coded reject if onError also throws", async () => {
    const policy = delegatingPolicy({
      onRequest: () => {
        throw new Error("host boom");
      },
      onError: () => {
        throw new Error("fallback boom");
      },
    });
    const result = await policy(makeCtx());
    expect(result?.kind).toBe("reject");
    expect((result as { feedback?: string }).feedback).toContain("host boom");
  });

  it("formats non-Error throws via JSON.stringify", async () => {
    const policy = delegatingPolicy({
      onRequest: () => {
        throw { code: 42, msg: "weird" } as unknown as Error;
      },
    });
    const result = await policy(makeCtx());
    expect((result as { feedback?: string }).feedback).toContain('"code":42');
  });
});

describe("composePolicies", () => {
  it("returns the first non-undefined result and skips subsequent policies", async () => {
    const a: CopilotPermissionPolicy = () => undefined;
    const b: CopilotPermissionPolicy = () => ({ kind: "approve-once" });
    const c = vi.fn<CopilotPermissionPolicy>(() => ({
      kind: "reject",
      feedback: "should never run",
    }));
    const policy = composePolicies(a, b, c);
    const result = await policy(makeCtx());
    expect(result).toEqual({ kind: "approve-once" });
    expect(c).not.toHaveBeenCalled();
  });

  it("falls through to fail-closed reject when all policies return undefined", async () => {
    const policy = composePolicies(
      () => undefined,
      () => undefined,
    );
    const result = await policy(makeCtx());
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });

  it("short-circuits to reject if any policy throws (does not consult later policies)", async () => {
    const later = vi.fn<CopilotPermissionPolicy>(() => ({ kind: "approve-once" }));
    const policy = composePolicies(() => {
      throw new Error("nope");
    }, later);
    const result = await policy(makeCtx());
    expect(result?.kind).toBe("reject");
    expect((result as { feedback?: string }).feedback).toContain("nope");
    expect(later).not.toHaveBeenCalled();
  });
});

describe("createPermissionBridge", () => {
  it("adapts a policy to the SDK PermissionHandler shape", async () => {
    const handler = createPermissionBridge(allowOncePolicy);
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ kind: "approve-once" });
  });

  it("defaults to rejectAllPolicy when no policy is passed", async () => {
    const handler = createPermissionBridge();
    const result = await handler(makeRequest({ kind: "shell" }), { sessionId: "sess-1" });
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });

  it("forwards the SDK sessionId into the policy context", async () => {
    const policy = vi.fn<CopilotPermissionPolicy>(() => ({ kind: "approve-once" }));
    const handler = createPermissionBridge(policy);
    await handler(makeRequest({ kind: "read" }), { sessionId: "sess-xyz" });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy.mock.calls[0]?.[0]).toEqual({
      sessionId: "sess-xyz",
      request: { kind: "read", toolCallId: "call-1" },
    });
  });

  it("never throws when policy throws; returns reject with the error message instead", async () => {
    const handler = createPermissionBridge(() => {
      throw new Error("policy boom");
    });
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result?.kind).toBe("reject");
    expect((result as { feedback?: string }).feedback).toContain("policy boom");
  });

  it("never returns undefined: a policy returning undefined yields fail-closed reject", async () => {
    const handler = createPermissionBridge(() => undefined);
    const result = await handler(makeRequest(), { sessionId: "sess-1" });
    expect(result).toEqual({ kind: "reject", feedback: REJECT_ALL_FEEDBACK });
  });

  it("handles all SDK permission kinds without throwing", async () => {
    const handler = createPermissionBridge(allowOncePolicy);
    for (const kind of [
      "shell",
      "write",
      "mcp",
      "read",
      "url",
      "custom-tool",
      "memory",
      "hook",
    ] as const) {
      const result = await handler(makeRequest({ kind }), { sessionId: "sess-1" });
      expect(result).toEqual({ kind: "approve-once" });
    }
  });
});
