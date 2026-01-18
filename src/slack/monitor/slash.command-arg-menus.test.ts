import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerSlackMonitorSlashCommands } from "./slash.js";

const dispatchMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();
const resolveAgentRouteMock = vi.fn();

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithDispatcher: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../../routing/resolve-route.js", () => ({
  resolveAgentRoute: (...args: unknown[]) => resolveAgentRouteMock(...args),
}));

vi.mock("../../agents/identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/identity.js")>();
  return {
    ...actual,
    resolveEffectiveMessagesConfig: () => ({ responsePrefix: "" }),
  };
});

function encodeValue(parts: { command: string; arg: string; value: string; userId: string }) {
  return [
    "cmdarg",
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function createHarness() {
  const commands = new Map<string, (args: unknown) => Promise<void>>();
  const actions = new Map<string, (args: unknown) => Promise<void>>();

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: string, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
    action: (id: string, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, handler);
    },
  };

  const ctx = {
    cfg: { commands: { native: true } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: "T1",
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open",
    useAccessGroups: false,
    channelsConfig: undefined,
    slashCommand: { enabled: true, name: "clawd", ephemeral: true, sessionPrefix: "slack:slash" },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" }),
  } as unknown;

  const account = { accountId: "acct", config: { commands: { native: true } } } as unknown;

  return { commands, actions, postEphemeral, ctx, account };
}

beforeEach(() => {
  dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
});

describe("Slack native command argument menus", () => {
  it("shows a button menu when required args are omitted", async () => {
    const { commands, ctx, account } = createHarness();
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = commands.get("/usage");
    if (!handler) throw new Error("Missing /usage handler");

    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    await handler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: "C1",
        channel_name: "directmessage",
        text: "",
        trigger_id: "t1",
      },
      ack,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    expect(payload.blocks?.[0]?.type).toBe("section");
    expect(payload.blocks?.[1]?.type).toBe("actions");
  });

  it("dispatches the command when a menu button is clicked", async () => {
    const { actions, ctx, account } = createHarness();
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = actions.get("clawdbot_cmdarg");
    if (!handler) throw new Error("Missing arg-menu action handler");

    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      body: {
        user: { id: "U1", name: "Ada" },
        channel: { id: "C1", name: "directmessage" },
        trigger_id: "t1",
      },
      respond,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/usage tokens");
  });

  it("rejects menu clicks from other users", async () => {
    const { actions, ctx, account } = createHarness();
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = actions.get("clawdbot_cmdarg");
    if (!handler) throw new Error("Missing arg-menu action handler");

    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      body: {
        user: { id: "U2", name: "Eve" },
        channel: { id: "C1", name: "directmessage" },
        trigger_id: "t1",
      },
      respond,
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "That menu is for another user.",
      response_type: "ephemeral",
    });
  });

  it("falls back to postEphemeral with token when respond is unavailable", async () => {
    const { actions, postEphemeral, ctx, account } = createHarness();
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = actions.get("clawdbot_cmdarg");
    if (!handler) throw new Error("Missing arg-menu action handler");

    await handler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "garbage" },
      body: { user: { id: "U1" }, channel: { id: "C1" } },
    });

    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "bot-token",
        channel: "C1",
        user: "U1",
      }),
    );
  });

  it("treats malformed percent-encoding as an invalid button (no throw)", async () => {
    const { actions, postEphemeral, ctx, account } = createHarness();
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = actions.get("clawdbot_cmdarg");
    if (!handler) throw new Error("Missing arg-menu action handler");

    await handler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      body: { user: { id: "U1" }, channel: { id: "C1" } },
    });

    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "bot-token",
        channel: "C1",
        user: "U1",
        text: "Sorry, that button is no longer valid.",
      }),
    );
  });
});
