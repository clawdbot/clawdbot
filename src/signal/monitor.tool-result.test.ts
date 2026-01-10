import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import {
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeE164 } from "../utils.js";
import { monitorSignalProvider } from "./monitor.js";

const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
let config: Record<string, unknown> = {};
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();

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
  sendMessageSignal: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readProviderAllowFromStore: (...args: unknown[]) =>
    readAllowFromStoreMock(...args),
  upsertProviderPairingRequest: (...args: unknown[]) =>
    upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
}));

const streamMock = vi.fn();
const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();

vi.mock("./client.js", () => ({
  streamSignalEvents: (...args: unknown[]) => streamMock(...args),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./daemon.js", () => ({
  spawnSignalDaemon: vi.fn(() => ({ stop: vi.fn() })),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  config = {
    messages: { responsePrefix: "PFX" },
    signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] },
  };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset();
  updateLastRouteMock.mockReset();
  streamMock.mockReset();
  signalCheckMock.mockReset().mockResolvedValue({});
  signalRpcRequestMock.mockReset().mockResolvedValue({});
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock
    .mockReset()
    .mockResolvedValue({ code: "PAIRCODE", created: true });
  resetSystemEventsForTest();
});

describe("monitorSignalProvider tool results", () => {
  it("sends tool summaries with responsePrefix", async () => {
    const abortController = new AbortController();
    replyMock.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][1]).toBe("PFX tool update");
    expect(sendMock.mock.calls[1][1]).toBe("PFX final reply");
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    config = {
      ...config,
      signal: { autoStart: false, dmPolicy: "pairing", allowFrom: [] },
    };
    const abortController = new AbortController();

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Your Signal number: +15550001111",
    );
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Pairing code: PAIRCODE",
    );
  });

  it("ignores reaction-only messages", async () => {
    const abortController = new AbortController();

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          reactionMessage: {
            emoji: "👍",
            targetAuthor: "+15550002222",
            targetSentTimestamp: 2,
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    const abortController = new AbortController();

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            reaction: {
              emoji: "👍",
              targetAuthor: "+15550002222",
              targetSentTimestamp: 2,
            },
            attachments: [{}],
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });

  it("enqueues system events for reaction notifications", async () => {
    config = {
      ...config,
      signal: {
        autoStart: false,
        dmPolicy: "open",
        allowFrom: ["*"],
        reactionNotifications: "all",
      },
    };
    const abortController = new AbortController();

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          reactionMessage: {
            emoji: "✅",
            targetAuthor: "+15550002222",
            targetSentTimestamp: 2,
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    const route = resolveAgentRoute({
      cfg: config as ClawdbotConfig,
      provider: "signal",
      accountId: "default",
      peer: { kind: "dm", id: normalizeE164("+15550001111") },
    });
    const events = peekSystemEvents(route.sessionKey);
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(
      true,
    );
  });

  it("notifies on own reactions when target includes uuid + phone", async () => {
    config = {
      ...config,
      signal: {
        autoStart: false,
        dmPolicy: "open",
        allowFrom: ["*"],
        account: "+15550002222",
        reactionNotifications: "own",
      },
    };
    const abortController = new AbortController();

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          reactionMessage: {
            emoji: "✅",
            targetAuthor: "+15550002222",
            targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
            targetSentTimestamp: 2,
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    const route = resolveAgentRoute({
      cfg: config as ClawdbotConfig,
      provider: "signal",
      accountId: "default",
      peer: { kind: "dm", id: normalizeE164("+15550001111") },
    });
    const events = peekSystemEvents(route.sessionKey);
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(
      true,
    );
  });

  it("processes messages when reaction metadata is present", async () => {
    const abortController = new AbortController();
    replyMock.mockResolvedValue({ text: "pong" });

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          reactionMessage: {
            emoji: "👍",
            targetAuthor: "+15550002222",
            targetSentTimestamp: 2,
          },
          dataMessage: {
            message: "ping",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(updateLastRouteMock).toHaveBeenCalled();
  });

  it("does not resend pairing code when a request is already pending", async () => {
    config = {
      ...config,
      signal: { autoStart: false, dmPolicy: "pairing", allowFrom: [] },
    };
    const abortController = new AbortController();
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          ...payload,
          envelope: { ...payload.envelope, timestamp: 2 },
        }),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("pairs uuid-only senders with a uuid allowlist entry", async () => {
    config = {
      ...config,
      signal: { autoStart: false, dmPolicy: "pairing", allowFrom: [] },
    };
    const abortController = new AbortController();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceUuid: uuid,
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "signal", id: `uuid:${uuid}` }),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe(`signal:${uuid}`);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      `Your Signal sender id: uuid:${uuid}`,
    );
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;

    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("stream dropped");
      }
      abortController.abort();
    });

    try {
      const monitorPromise = monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await monitorPromise;

      expect(streamMock).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
