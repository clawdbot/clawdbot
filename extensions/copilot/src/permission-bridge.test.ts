// Copilot tests cover permission bridge plugin behavior.
import type { PermissionRequest as SdkPermissionRequest } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createPermissionBridge,
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

describe("createPermissionBridge", () => {
  it("adapts a policy to the SDK PermissionHandler shape", async () => {
    const handler = createPermissionBridge(() => ({ kind: "approve-once" }));
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
    const handler = createPermissionBridge(() => ({ kind: "approve-once" }));
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
