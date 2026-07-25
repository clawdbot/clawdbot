import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRaftAccount } from "./accounts.js";
import { startRaftGatewayAccount } from "./gateway.js";

class FakeBridge extends EventEmitter {
  kill = vi.fn(() => true);
}

const tempDirs = new Set<string>();

function makeTempDir(prefix: string): string {
  // openclaw-temp-dir: allow extension tests cannot import root test helpers
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function createContext(accountId = "default") {
  const status = {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => {
          id: string;
          timestamp: number;
          rawText: string;
          textForAgent: string;
          textForCommands: string;
        };
        resolveTurn: (input: {
          id: string;
          timestamp: number;
          rawText: string;
          textForAgent: string;
          textForCommands: string;
        }) => Promise<{
          delivery: {
            deliver: () => Promise<{ visibleReplySent: false }>;
          };
        }>;
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = await params.adapter.resolveTurn(input);
      await turn.delivery.deliver();
    },
  );
  const ctx = {
    cfg: {},
    accountId,
    account: {
      accountId,
      name: null,
      enabled: true,
      configured: true,
      profile: "openclaw",
    },
    runtime: {},
    abortSignal: new AbortController().signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getStatus: () => status,
    setStatus: (next: typeof status & Record<string, unknown>) => {
      Object.assign(status, next);
    },
    channelRuntime: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: `agent:main:raft:${accountId}`,
        })),
      },
      inbound: {
        run,
        buildContext: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw-agent.sqlite"),
        recordInboundSession: vi.fn(),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    },
  };
  return {
    ctx: ctx as unknown as ChannelGatewayContext<ResolvedRaftAccount>,
    controller: new AbortController(),
    run,
    wakeDedupe: createChannelReplayGuard<{ accountId: string; key: string }>({
      dedupe: { ttlMs: 0, memoryMaxSize: 10_000 },
      buildReplayKey: (event) => event.key,
      namespace: (event) => event.accountId,
    }),
  };
}

function createPersistentWakeDedupe(stateDir: string) {
  return createChannelReplayGuard<{ accountId: string; key: string }>({
    dedupe: {
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 1_000,
      pluginId: "raft",
      namespacePrefix: "raft-wake-dedupe",
      stateMaxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    },
    buildReplayKey: (event) => event.key,
    namespace: (event) => event.accountId,
  });
}

async function waitFor<T>(getValue: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = getValue();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("Timed out waiting for value.");
}

afterEach(() => {
  resetPluginStateStoreForTests();
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs.clear();
  vi.restoreAllMocks();
});

describe("Raft wake gateway", () => {
  it("keeps a disabled account quiescent until shutdown", async () => {
    const { ctx, controller, wakeDedupe } = createContext();
    Object.defineProperty(ctx, "abortSignal", { value: controller.signal });
    Object.defineProperty(ctx, "account", {
      value: {
        ...ctx.account,
        enabled: false,
      },
    });
    const spawnBridge = vi.fn(() => new FakeBridge());
    let settled = false;
    const start = startRaftGatewayAccount(ctx, { spawnBridge, wakeDedupe }).then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(settled).toBe(false);
    expect(spawnBridge).not.toHaveBeenCalled();

    controller.abort();
    await start;
  });

  it("accepts authenticated content-free wake hints and dedupes retry delivery ids", async () => {
    const { ctx, controller, run, wakeDedupe } = createContext();
    Object.defineProperty(ctx, "abortSignal", { value: controller.signal });
    Object.defineProperty(ctx, "account", {
      value: {
        ...ctx.account,
        profile: "main'; touch /tmp/pwn; echo '",
      },
    });
    const bridge = new FakeBridge();
    let endpoint: string | undefined;
    let token: string | undefined;
    const start = startRaftGatewayAccount(ctx, {
      spawnBridge: (params) => {
        endpoint = params.endpoint;
        token = params.token;
        return bridge;
      },
      wakeDedupe,
    });

    const wakeEndpoint = await waitFor(() => endpoint);
    const bridgeToken = await waitFor(() => token);
    await expect(fetch(wakeEndpoint.replace("/wake", "/health"))).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetch(wakeEndpoint, { method: "POST" })).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: { "x-raft-bridge-token": "x".repeat(bridgeToken.length) },
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: { "x-raft-bridge-token": "short" },
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
      }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({ metadata: { text: "not a wake hint" } }),
      }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({ eventId: "wake-1", timestamp: 1 }),
      }),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      fetch(wakeEndpoint.replace("/wake", "/activity/drain?max=50")),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(wakeEndpoint.replace("/wake", "/activity/drain?max=50"), {
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
      }),
    ).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      fetch(wakeEndpoint.replace("/wake", "/activity/drain?max=50"), {
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
      }).then((response) => response.json()),
    ).resolves.toEqual({
      dropped: 0,
      events: [],
      schema: "raft-activity-drain.v1",
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({ eventId: "wake-1", timestamp: 2 }),
      }),
    ).resolves.toMatchObject({ status: 202 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({
          metadata: {
            sequence: 1,
            source: "bridge",
          },
        }),
      }),
    ).resolves.toMatchObject({ status: 400 });
    expect(run).toHaveBeenCalledTimes(1);

    const input = run.mock.calls[0]?.[0].adapter.ingest({ kind: "wake" });
    expect(input?.textForAgent).toContain(
      `raft --profile 'main'"'"'; touch /tmp/pwn; echo '"'"'' message check`,
    );
    expect(input?.rawText).not.toContain("wake-1");

    controller.abort();
    await start;
    expect(bridge.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns the Raft bridge runtime session for accepted wakes", async () => {
    const { ctx, controller, wakeDedupe } = createContext();
    Object.defineProperty(ctx, "abortSignal", { value: controller.signal });
    const bridge = new FakeBridge();
    let endpoint: string | undefined;
    let token: string | undefined;
    const start = startRaftGatewayAccount(ctx, {
      spawnBridge: (params) => {
        endpoint = params.endpoint;
        token = params.token;
        return bridge;
      },
      wakeDedupe,
    });

    const wakeEndpoint = await waitFor(() => endpoint);
    const bridgeToken = await waitFor(() => token);
    try {
      const response = await fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({ eventId: "wake-runtime-session" }),
      });
      expect(response).toMatchObject({ status: 202 });
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
        ok: true,
        runtimeSession: expect.any(String),
      });
    } finally {
      controller.abort();
      await start;
    }
  });

  it("rejects oversized payloads before queueing a wake", async () => {
    const { ctx, controller, run, wakeDedupe } = createContext();
    Object.defineProperty(ctx, "abortSignal", { value: controller.signal });
    const bridge = new FakeBridge();
    let endpoint: string | undefined;
    let token: string | undefined;
    const start = startRaftGatewayAccount(ctx, {
      spawnBridge: (params) => {
        endpoint = params.endpoint;
        token = params.token;
        return bridge;
      },
      wakeDedupe,
    });

    const wakeEndpoint = await waitFor(() => endpoint);
    const bridgeToken = await waitFor(() => token);
    await expect(
      fetch(wakeEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({ event: "wake", padding: "x".repeat(17 * 1024) }),
      }),
    ).resolves.toMatchObject({ status: 413 });
    expect(run).not.toHaveBeenCalled();

    controller.abort();
    await start;
  });

  it("keeps a failed delivery eligible for a bridge retry", async () => {
    const { ctx, controller, run, wakeDedupe } = createContext();
    Object.defineProperty(ctx, "abortSignal", { value: controller.signal });
    const bridge = new FakeBridge();
    let endpoint: string | undefined;
    let token: string | undefined;
    const start = startRaftGatewayAccount(ctx, {
      spawnBridge: (params) => {
        endpoint = params.endpoint;
        token = params.token;
        return bridge;
      },
      wakeDedupe,
    });

    const wakeEndpoint = await waitFor(() => endpoint);
    const bridgeToken = await waitFor(() => token);
    try {
      run.mockRejectedValueOnce(new Error("inbound runtime unavailable"));
      const request = () => ({
        method: "POST",
        headers: {
          "x-raft-bridge-token": bridgeToken,
        },
        body: JSON.stringify({ eventId: "wake-retry" }),
      });
      await expect(fetch(wakeEndpoint, request())).resolves.toMatchObject({ status: 500 });
      await expect(fetch(wakeEndpoint, request())).resolves.toMatchObject({ status: 202 });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      await start;
    }
  });

  it("persists accepted wake dedupe across restarts without crossing accounts", async () => {
    const stateDir = makeTempDir("openclaw-raft-wake-dedupe-");
    try {
      const first = createContext();
      Object.defineProperty(first.ctx, "abortSignal", { value: first.controller.signal });
      const firstBridge = new FakeBridge();
      let firstEndpoint: string | undefined;
      let firstToken: string | undefined;
      const firstStart = startRaftGatewayAccount(first.ctx, {
        wakeDedupe: createPersistentWakeDedupe(stateDir),
        spawnBridge: (params) => {
          firstEndpoint = params.endpoint;
          firstToken = params.token;
          return firstBridge;
        },
      });
      try {
        const endpoint = await waitFor(() => firstEndpoint);
        const token = await waitFor(() => firstToken);
        await expect(
          fetch(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
            body: JSON.stringify({ eventId: "wake-persisted" }),
          }),
        ).resolves.toMatchObject({ status: 202 });
        expect(first.run).toHaveBeenCalledTimes(1);
      } finally {
        first.controller.abort();
        await firstStart;
      }

      const replay = createContext();
      Object.defineProperty(replay.ctx, "abortSignal", { value: replay.controller.signal });
      const replayBridge = new FakeBridge();
      let replayEndpoint: string | undefined;
      let replayToken: string | undefined;
      const replayStart = startRaftGatewayAccount(replay.ctx, {
        wakeDedupe: createPersistentWakeDedupe(stateDir),
        spawnBridge: (params) => {
          replayEndpoint = params.endpoint;
          replayToken = params.token;
          return replayBridge;
        },
      });
      try {
        const endpoint = await waitFor(() => replayEndpoint);
        const token = await waitFor(() => replayToken);
        await expect(
          fetch(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
            body: JSON.stringify({ eventId: "wake-persisted" }),
          }),
        ).resolves.toMatchObject({ status: 202 });
        expect(replay.run).not.toHaveBeenCalled();
      } finally {
        replay.controller.abort();
        await replayStart;
      }

      const otherAccount = createContext("other");
      Object.defineProperty(otherAccount.ctx, "abortSignal", {
        value: otherAccount.controller.signal,
      });
      const otherBridge = new FakeBridge();
      let otherEndpoint: string | undefined;
      let otherToken: string | undefined;
      const otherStart = startRaftGatewayAccount(otherAccount.ctx, {
        wakeDedupe: createPersistentWakeDedupe(stateDir),
        spawnBridge: (params) => {
          otherEndpoint = params.endpoint;
          otherToken = params.token;
          return otherBridge;
        },
      });
      try {
        const endpoint = await waitFor(() => otherEndpoint);
        const token = await waitFor(() => otherToken);
        await expect(
          fetch(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
            body: JSON.stringify({ eventId: "wake-persisted" }),
          }),
        ).resolves.toMatchObject({ status: 202 });
        expect(otherAccount.run).toHaveBeenCalledTimes(1);
      } finally {
        otherAccount.controller.abort();
        await otherStart;
      }
    } finally {
      resetPluginStateStoreForTests();
    }
  });
});
