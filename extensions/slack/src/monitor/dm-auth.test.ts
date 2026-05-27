import { describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";

function makeCtx(dmPolicy: SlackMonitorContext["dmPolicy"]): SlackMonitorContext {
  return {
    allowNameMatching: false,
    dmEnabled: true,
    dmPolicy,
  } as SlackMonitorContext;
}

function makeParams(
  dmPolicy: SlackMonitorContext["dmPolicy"],
): Parameters<typeof authorizeSlackDirectMessage>[0] {
  return {
    ctx: makeCtx(dmPolicy),
    accountId: "workspace",
    senderId: "U123",
    allowFromLower: [],
    resolveSenderName: vi.fn(async () => ({ name: "Alice" })),
    sendPairingReply: vi.fn(),
    onDisabled: vi.fn(),
    onUnauthorized: vi.fn(),
    log: vi.fn(),
  };
}

describe("authorizeSlackDirectMessage", () => {
  it("allows open DM policy when effective allowFrom includes wildcard", async () => {
    const params = makeParams("open");
    params.allowFromLower = ["*"];
    params.resolveSenderName = vi.fn(async () => {
      throw new Error("users.info failed");
    });

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(true);

    expect(params.onUnauthorized).not.toHaveBeenCalled();
    expect(params.resolveSenderName).not.toHaveBeenCalled();
  });

  it("rejects open DM policy when effective allowFrom lacks wildcard", async () => {
    const params = makeParams("open");

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(false);

    expect(params.onUnauthorized).toHaveBeenCalledWith({
      allowMatchMeta: "matchKey=none matchSource=none",
      senderName: "Alice",
    });
  });

  it("keeps allowlist DM policy gated by allowFrom", async () => {
    const params = makeParams("allowlist");

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(false);

    expect(params.onUnauthorized).toHaveBeenCalledWith({
      allowMatchMeta: "matchKey=none matchSource=none",
      senderName: "Alice",
    });
  });
});
