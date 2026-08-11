// Qa Channel tests cover gateway lifecycle behavior.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { startQaGatewayAccount } from "./gateway.js";
import { handleQaInbound } from "./inbound.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { ResolvedQaChannelAccount } from "./types.js";

vi.mock("./inbound.js", () => ({
  handleQaInbound: vi.fn(async () => undefined),
}));

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  const server = createServer((req, res) => {
    const response = handler({ url: req.url });
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("qa-channel gateway", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.mocked(handleQaInbound).mockReset().mockResolvedValue(undefined);
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("lets native commands bypass the ordered inbound queue", async () => {
    const controller = new AbortController();
    const message = {
      id: "msg-1",
      accountId: "default",
      direction: "inbound" as const,
      conversation: { id: "alice", kind: "direct" as const },
      senderId: "alice",
      text: "hello",
      timestamp: Date.now(),
      reactions: [],
    };
    const server = await startJsonServer(() => ({
      body: JSON.stringify({
        cursor: 3,
        events: [
          { cursor: 1, kind: "inbound-message", accountId: "default", message },
          {
            cursor: 2,
            kind: "inbound-message",
            accountId: "default",
            message: { ...message, id: "msg-2", text: "follow-up" },
          },
          {
            cursor: 3,
            kind: "inbound-message",
            accountId: "default",
            message: {
              ...message,
              id: "msg-3",
              text: "/stop",
              nativeCommand: { name: "stop" },
            },
          },
        ],
      }),
    }));
    stops.push(() => server.stop());
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.text === "hello") {
        await firstPending;
      }
      if (inbound.text === "/stop") {
        controller.abort();
      }
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };

    const gateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: controller.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    await vi.waitFor(() => {
      const handled = vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text);
      expect(handled).toContain("hello");
      expect(handled).toContain("/stop");
      expect(handled).not.toContain("follow-up");
    });
    releaseFirst?.();
    await gateway;
    const handled = vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text);
    expect(handled).toHaveLength(3);
    expect(handled).toContain("/stop");
    expect(handled.indexOf("hello")).toBeLessThan(handled.indexOf("follow-up"));
  });

  it("clears running status when polling fails", async () => {
    const server = await startJsonServer(() => ({
      statusCode: 500,
      body: JSON.stringify({ error: "qa bus unavailable" }),
    }));
    stops.push(() => server.stop());
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };
    const setStatus = vi.fn();

    await expect(
      startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: new AbortController().signal,
        account,
        cfg: {},
        setStatus,
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>),
    ).rejects.toThrow("qa bus unavailable");

    expect(setStatus.mock.calls.map(([status]) => status)).toEqual([
      {
        accountId: "default",
        baseUrl: server.baseUrl,
        configured: true,
        enabled: true,
        running: true,
        lifecycle: "starting",
      },
      {
        accountId: "default",
        connected: false,
        lifecycle: "recovering",
        lastError: "qa bus unavailable",
      },
      {
        accountId: "default",
        running: false,
        connected: false,
        lifecycle: "stopped",
      },
    ]);
  });

  it("publishes ready after the first successful poll", async () => {
    const controller = new AbortController();
    const server = await startJsonServer(() => ({
      body: JSON.stringify({ cursor: 0, events: [] }),
    }));
    stops.push(() => server.stop());
    const setStatus = vi.fn();

    const run = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: controller.signal,
      account: {
        accountId: "default",
        baseUrl: server.baseUrl,
        botDisplayName: "QA Bot",
        botUserId: "qa-bot",
        config: {},
        configured: true,
        enabled: true,
        pollTimeoutMs: 1,
      },
      cfg: {},
      setStatus,
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: expect.any(Number),
        lastError: null,
        terminalDisconnect: undefined,
      }),
    );
    controller.abort();
    await run;
  });

  it("stops the ordered inbound queue after the first dispatch failure", async () => {
    const controller = new AbortController();
    const message = {
      id: "msg-1",
      accountId: "default",
      direction: "inbound" as const,
      conversation: { id: "alice", kind: "direct" as const },
      senderId: "alice",
      text: "first",
      timestamp: Date.now(),
      reactions: [],
    };
    const server = await startJsonServer(() => ({
      body: JSON.stringify({
        cursor: 2,
        events: [
          { cursor: 1, kind: "inbound-message", accountId: "default", message },
          {
            cursor: 2,
            kind: "inbound-message",
            accountId: "default",
            message: { ...message, id: "msg-2", text: "second" },
          },
        ],
      }),
    }));
    stops.push(() => server.stop());
    vi.mocked(handleQaInbound).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("inbound failed");
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };

    await expect(
      startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: controller.signal,
        account,
        cfg: {},
        setStatus: vi.fn(),
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>),
    ).rejects.toThrow("inbound failed");
    expect(handleQaInbound).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only the contiguous prefix when dispatches finish out of order", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);
    const messages = [
      state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "first",
      }),
      state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "second",
      }),
      state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "/stop",
        nativeCommand: { name: "stop" },
      }),
    ];
    let pollCount = 0;
    bus.server.on("request", (request) => {
      if (request.url === "/v1/poll") {
        pollCount += 1;
      }
    });

    let rejectSecond = (_error: Error) => {};
    const secondAttempt = new Promise<void>((_resolve, reject) => {
      rejectSecond = reject;
    });
    let restarting = false;
    const recoveredMessageIds: string[] = [];
    const restartedController = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (!restarting && message.id === messages[1]?.id) {
        await secondAttempt;
      }
      if (restarting) {
        recoveredMessageIds.push(message.id);
        if (recoveredMessageIds.length === messages.length - 1) {
          restartedController.abort();
        }
      }
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: bus.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 10,
    };
    const firstGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: new AbortController().signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.id)).toEqual(
        expect.arrayContaining(messages.map((message) => message.id)),
      );
    });
    rejectSecond(new Error("inbound failed"));
    await expect(firstGateway).rejects.toThrow("inbound failed");
    expect(state.getAcknowledgedPollCursor("default")).toBe(1);

    restarting = true;
    const restartedGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: restartedController.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);
    try {
      await vi.waitFor(() => {
        expect(new Set(recoveredMessageIds)).toEqual(
          new Set(messages.slice(1).map((message) => message.id)),
        );
      });
    } finally {
      restartedController.abort();
      await restartedGateway.catch(() => undefined);
    }
  });

  it("records a final successful dispatch before the gateway stops", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);
    const message = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "stop after delivery",
    });
    const controller = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.id === message.id) {
        controller.abort();
      }
    });

    await startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: controller.signal,
      account: {
        accountId: "default",
        baseUrl: bus.baseUrl,
        botDisplayName: "QA Bot",
        botUserId: "qa-bot",
        config: {},
        configured: true,
        enabled: true,
        pollTimeoutMs: 10,
      },
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    expect(state.getAcknowledgedPollCursor("default")).toBe(1);
  });
});
