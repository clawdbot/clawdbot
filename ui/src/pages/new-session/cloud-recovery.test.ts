import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCloudSessionRecovery,
  readCloudSessionRecovery,
  writeCloudSessionRecovery,
  writeCloudSessionRecoveryIfAvailable,
} from "./cloud-recovery.ts";

const recovery = {
  sessionKey: "agent:cloud:one",
  messageId: "message-1",
  message: "run remotely",
  profileId: "aws",
  agentId: "cloud",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
  phase: "dispatching" as const,
};

describe("cloud session recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips a gateway-scoped recovery record", () => {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(recovery);
    expect(readCloudSessionRecovery("ws://other.example", recovery.recoveryScope)).toBeNull();
    expect(readCloudSessionRecovery(recovery.gatewayUrl, "principal-b")).toBeNull();

    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });

  it("fails closed when storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
    });
    expect(writeCloudSessionRecovery(recovery)).toBe(false);
  });

  it("round-trips an attachment-only first turn", () => {
    const attachmentRecovery = {
      ...recovery,
      message: "",
      attachments: [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }],
    };
    expect(writeCloudSessionRecovery(attachmentRecovery)).toBe(true);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(
      attachmentRecovery,
    );
  });

  it("requires matching create parameters for a creating recovery", () => {
    const creating = {
      ...recovery,
      phase: "creating" as const,
      createParams: {
        key: recovery.sessionKey,
        agentId: "cloud",
        message: "" as const,
        thinkingLevel: "high",
        worktree: true as const,
      },
    };
    expect(writeCloudSessionRecovery(creating)).toBe(true);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(creating);

    sessionStorage.setItem(
      `openclaw.new-session.cloud-recovery.v1:${recovery.gatewayUrl}:${recovery.recoveryScope}`,
      JSON.stringify({ ...creating, createParams: { key: "agent:cloud:other" } }),
    );
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();

    sessionStorage.setItem(
      `openclaw.new-session.cloud-recovery.v1:${recovery.gatewayUrl}:${recovery.recoveryScope}`,
      JSON.stringify({
        ...creating,
        createParams: { ...creating.createParams, message: "run locally" },
      }),
    );
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });

  it("does not let stale cleanup erase a newer recovery record", () => {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, "agent:cloud:older");
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(recovery);

    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });

  it("only claims an unused or matching recovery slot", () => {
    expect(writeCloudSessionRecoveryIfAvailable(recovery)).toBe(true);
    expect(writeCloudSessionRecoveryIfAvailable({ ...recovery, message: "retry" })).toBe(true);
    expect(
      writeCloudSessionRecoveryIfAvailable({ ...recovery, sessionKey: "agent:cloud:newer" }),
    ).toBe(false);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toMatchObject({
      sessionKey: recovery.sessionKey,
      message: "retry",
    });
  });

  it("rejects malformed records", () => {
    sessionStorage.setItem(
      `openclaw.new-session.cloud-recovery.v1:${recovery.gatewayUrl}:${recovery.recoveryScope}`,
      JSON.stringify({ ...recovery, messageId: "" }),
    );
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });
});
