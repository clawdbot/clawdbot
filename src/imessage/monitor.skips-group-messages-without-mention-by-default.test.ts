import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorIMessageProvider } from "./monitor.js";

const requestMock = vi.fn();
const stopMock = vi.fn();
const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();

let config: Record<string, unknown> = {};
let notificationHandler: ((msg: { method: string; params?: unknown }) => void) | undefined;
let closeResolve: (() => void) | undefined;

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageIMessage: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/moltbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: vi.fn(async (opts: { onNotification?: typeof notificationHandler }) => {
    notificationHandler = opts.onNotification;
    return {
      request: (...args: unknown[]) => requestMock(...args),
      waitForClose: () =>
        new Promise<void>((resolve) => {
          closeResolve = resolve;
        }),
      stop: (...args: unknown[]) => stopMock(...args),
    };
  }),
}));

vi.mock("./probe.js", () => ({
  probeIMessage: vi.fn(async () => ({ ok: true })),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForSubscribe() {
  for (let i = 0; i < 5; i += 1) {
    if (requestMock.mock.calls.some((call) => call[0] === "watch.subscribe")) return;
    await flush();
  }
}

beforeEach(() => {
  config = {
    channels: {
      imessage: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: { "*": { requireMention: true } },
      },
    },
    session: { mainKey: "main" },
    messages: {
      groupChat: { mentionPatterns: ["@clawd"] },
    },
  };
  requestMock.mockReset().mockImplementation((method: string) => {
    if (method === "watch.subscribe") return Promise.resolve({ subscription: 1 });
    return Promise.resolve({});
  });
  stopMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ messageId: "ok" });
  replyMock.mockReset().mockResolvedValue({ text: "ok" });
  updateLastRouteMock.mockReset();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  notificationHandler = undefined;
  closeResolve = undefined;
});

describe("monitorIMessageProvider", () => {
  it("skips group messages without a mention by default", async () => {
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 1,
          chat_id: 99,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello group",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("allows group messages when imessage groups default disables mention gating", async () => {
    config = {
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 11,
          chat_id: 123,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello group",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).toHaveBeenCalled();
  });

  it("allows group messages when requireMention is true but no mentionPatterns exist", async () => {
    config = {
      ...config,
      messages: { groupChat: { mentionPatterns: [] } },
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 12,
          chat_id: 777,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello group",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).toHaveBeenCalled();
  });

  it("blocks group messages when imessage.groups is set without a wildcard", async () => {
    config = {
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          groups: { "99": { requireMention: false } },
        },
      },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 13,
          chat_id: 123,
          sender: "+15550001111",
          is_from_me: false,
          text: "@clawd hello",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("treats configured chat_id as a group session even when is_group is false", async () => {
    config = {
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "2": { requireMention: false } },
        },
      },
    };

    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 14,
          chat_id: 2,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello",
          is_group: false,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).toHaveBeenCalled();
    const ctx = replyMock.mock.calls[0]?.[0] as {
      ChatType?: string;
      SessionKey?: string;
    };
    expect(ctx.ChatType).toBe("group");
    expect(ctx.SessionKey).toBe("agent:main:imessage:group:2");
  });

  it("prefixes final replies with responsePrefix", async () => {
    config = {
      ...config,
      messages: { responsePrefix: "PFX" },
    };
    replyMock.mockResolvedValue({ text: "final reply" });
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 7,
          chat_id: 77,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello",
          is_group: false,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("defaults to dmPolicy=pairing behavior when allowFrom is empty", async () => {
    config = {
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          dmPolicy: "pairing",
          allowFrom: [],
          groups: { "*": { requireMention: true } },
        },
      },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 99,
          chat_id: 77,
          sender: "+15550001111",
          is_from_me: false,
          text: "hello",
          is_group: false,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Your iMessage sender id: +15550001111",
    );
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  });

  it("delivers group replies when mentioned", async () => {
    replyMock.mockResolvedValueOnce({ text: "yo" });
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 2,
          chat_id: 42,
          sender: "+15550002222",
          is_from_me: false,
          text: "@clawd ping",
          is_group: true,
          chat_name: "Lobster Squad",
          participants: ["+1555", "+1556"],
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).toHaveBeenCalledOnce();
    const ctx = replyMock.mock.calls[0]?.[0] as { Body?: string; ChatType?: string };
    expect(ctx.ChatType).toBe("group");
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(ctx.Body ?? "")).toContain("+15550002222:");
    expect(String(ctx.Body ?? "")).not.toContain("[from:");

    expect(sendMock).toHaveBeenCalledWith(
      "chat_id:42",
      "yo",
      expect.objectContaining({ client: expect.any(Object) }),
    );
  });

  it("honors group allowlist when groupPolicy is allowlist", async () => {
    config = {
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          groupPolicy: "allowlist",
          groupAllowFrom: ["chat_id:101"],
        },
      },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 3,
          chat_id: 202,
          sender: "+15550003333",
          is_from_me: false,
          text: "@clawd hi",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when groupPolicy is disabled", async () => {
    config = {
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels?.imessage,
          groupPolicy: "disabled",
        },
      },
    };
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 10,
          chat_id: 303,
          sender: "+15550003333",
          is_from_me: false,
          text: "@clawd hi",
          is_group: true,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("prefixes group message bodies with sender", async () => {
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 11,
          chat_id: 99,
          chat_name: "Test Group",
          sender: "+15550001111",
          is_from_me: false,
          text: "@clawd hi",
          is_group: true,
          created_at: "2026-01-17T00:00:00Z",
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).toHaveBeenCalled();
    const ctx = replyMock.mock.calls[0]?.[0];
    const body = ctx?.Body ?? "";
    expect(body).toContain("Test Group id:99");
    expect(body).toContain("+15550001111: @clawd hi");
  });

  it("includes reply context when imessage reply metadata is present", async () => {
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 12,
          chat_id: 55,
          sender: "+15550001111",
          is_from_me: false,
          text: "replying now",
          is_group: false,
          reply_to_id: 9001,
          reply_to_text: "original message",
          reply_to_sender: "+15559998888",
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(replyMock).toHaveBeenCalled();
    const ctx = replyMock.mock.calls[0]?.[0] as {
      Body?: string;
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
    };
    expect(ctx.ReplyToId).toBe("9001");
    expect(ctx.ReplyToBody).toBe("original message");
    expect(ctx.ReplyToSender).toBe("+15559998888");
    expect(String(ctx.Body ?? "")).toContain("[Replying to +15559998888 id:9001]");
    expect(String(ctx.Body ?? "")).toContain("original message");
  });
});
