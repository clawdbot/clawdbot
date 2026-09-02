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

  it("allows bare user ids for workspace-install DMs", async () => {
    const params = makeParams("allowlist");
    params.ctx.installationIdentity = { kind: "workspace", teamId: "T11111111" };
    params.eventScope = { teamId: "T11111111", client: {} as never };
    params.allowFromLower = ["u123"];

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(true);

    expect(params.onUnauthorized).not.toHaveBeenCalled();
  });

  it("allows bare org user ids for Enterprise DMs", async () => {
    const params = makeParams("allowlist");
    params.ctx.installationIdentity = { kind: "enterprise", enterpriseId: "E11111111" };
    params.eventScope = { teamId: "T11111111", client: {} as never };
    params.senderId = "W01234567";
    params.allowFromLower = ["w01234567"];

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(true);

    expect(params.onUnauthorized).not.toHaveBeenCalled();
  });

  it("creates independent pairing requests for the same user in two Grid workspaces", async () => {
    const pendingCodes = new Map<string, string>();
    upsertChannelPairingRequestMock.mockImplementation(
      async ({ accountId, id }: { accountId: string; id: string }) => {
        const key = `${accountId}:${id}`;
        const existingCode = pendingCodes.get(key);
        if (existingCode) {
          return { code: existingCode, created: false };
        }
        const code = `CODE${pendingCodes.size + 1}`;
        pendingCodes.set(key, code);
        return { code, created: true };
      },
    );
    const first = makeParams("pairing");
    first.eventScope = { teamId: "T11111111", client: {} as never };
    const second = makeParams("pairing");
    second.eventScope = { teamId: "T22222222", client: {} as never };

    await expect(
      Promise.all([authorizeSlackDirectMessage(first), authorizeSlackDirectMessage(second)]),
    ).resolves.toEqual([false, false]);

    expect(upsertChannelPairingRequestMock).toHaveBeenNthCalledWith(1, {
      channel: "slack",
      id: "team:T11111111:user:U123",
      accountId: "workspace",
      meta: { name: "Alice", teamId: "T11111111", senderId: "U123" },
    });
    expect(upsertChannelPairingRequestMock).toHaveBeenNthCalledWith(2, {
      channel: "slack",
      id: "team:T22222222:user:U123",
      accountId: "workspace",
      meta: { name: "Alice", teamId: "T22222222", senderId: "U123" },
    });
    expect(first.sendPairingReply).toHaveBeenCalledTimes(1);
    expect(second.sendPairingReply).toHaveBeenCalledTimes(1);
    expect(pendingCodes.size).toBe(2);
  });
});
