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
  it("updates last route with sender handle for direct messages", async () => {
    replyMock.mockResolvedValueOnce({ text: "ok" });
    const run = monitorIMessageProvider();
    await waitForSubscribe();

    notificationHandler?.({
      method: "message",
      params: {
        message: {
          id: 4,
          chat_id: 7,
          sender: "+15550004444",
          is_from_me: false,
          text: "hey",
          is_group: false,
        },
      },
    });

    await flush();
    closeResolve?.();
    await run;

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          channel: "imessage",
          to: "+15550004444",
        }),
      }),
    );
  });

  it("does not trigger unhandledRejection when aborting during shutdown", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "watch.subscribe") return Promise.resolve({ subscription: 1 });
      if (method === "watch.unsubscribe") return Promise.reject(new Error("imsg rpc closed"));
      return Promise.resolve({});
    });

    const abortController = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const run = monitorIMessageProvider({
        abortSignal: abortController.signal,
      });
      await waitForSubscribe();
      await flush();

      abortController.abort();
      await flush();

      closeResolve?.();
      await run;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(stopMock).toHaveBeenCalled();
  });
});
