// Slack tests cover dm auth plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";

const upsertChannelPairingRequestMock = vi.hoisted(() => vi.fn());

vi.mock("./conversation.runtime.js", () => ({
  upsertChannelPairingRequest: upsertChannelPairingRequestMock,
}));

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
  beforeEach(() => {
    upsertChannelPairingRequestMock.mockReset().mockResolvedValue({
      code: "ABCDEFGH",
      created: true,
    });
  });

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

  it("records the Enterprise workspace on pairing requests", async () => {
    const params = makeParams("pairing");
    params.eventScope = { teamId: "T_ENTERPRISE", client: {} as never };

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(false);

    expect(upsertChannelPairingRequestMock).toHaveBeenCalledWith({
      channel: "slack",
      id: "U123",
      accountId: "workspace",
      meta: { name: "Alice", teamId: "T_ENTERPRISE" },
    });
    expect(params.sendPairingReply).toHaveBeenCalledTimes(1);
  });
});
