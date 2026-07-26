// Feishu tests cover monitor.startup plugin behavior.
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveStartupProbeTimeoutMs } from "./monitor-startup-timeout.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorFeishuProvider } from "./monitor.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const registerFeishuAiAgentMock = vi.hoisted(() => vi.fn());
const readCachedFeishuBotIdentityMock = vi.hoisted(() => vi.fn());
const writeCachedFeishuBotIdentityMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
  registerFeishuAiAgent: registerFeishuAiAgentMock,
}));

vi.mock("./bot-identity-cache.js", () => ({
  readCachedFeishuBotIdentity: readCachedFeishuBotIdentityMock,
  writeCachedFeishuBotIdentity: writeCachedFeishuBotIdentityMock,
}));

vi.mock("./client.js", async () => {
  const { createFeishuClientMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuClientMockModule();
});
vi.mock("./runtime.js", async () => {
  const { createFeishuRuntimeMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuRuntimeMockModule();
});

beforeAll(async () => {
  await import("./monitor.account.js");
});

beforeEach(() => {
  registerFeishuAiAgentMock.mockReset().mockResolvedValue({ ok: true });
  readCachedFeishuBotIdentityMock.mockReset().mockResolvedValue(null);
  writeCachedFeishuBotIdentityMock.mockReset().mockResolvedValue(undefined);
});

function buildMultiAccountWebsocketConfig(accountIds: string[]): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: Object.fromEntries(
          accountIds.map((accountId) => [
            accountId,
            {
              enabled: true,
              appId: `cli_${accountId}`,
              appSecret: `secret_${accountId}`, // pragma: allowlist secret
              connectionMode: "websocket",
            },
          ]),
        ),
      },
    },
  } as ClawdbotConfig;
}

async function waitForStartedAccount(started: string[], accountId: string) {
  await vi.waitFor(
    () => {
      expect(started).toContain(accountId);
    },
    { timeout: 10_000 },
  );
}

afterEach(() => {
  cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

describe("Feishu monitor startup preflight", () => {
  it("parses startup probe timeout env strictly", () => {
    expect(resolveStartupProbeTimeoutMs({})).toBe(30_000);
    expect(
      resolveStartupProbeTimeoutMs({ OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: "90000" }),
    ).toBe(90_000);

    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        resolveStartupProbeTimeoutMs({ OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: value }),
      ).toBe(30_000);
    }
  });

  it("starts account probes sequentially to avoid startup bursts", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    let releaseProbes: (() => void) | undefined;
    const probesReleased = new Promise<void>((resolve) => {
      releaseProbes = () => resolve();
    });
    if (!releaseProbes) {
      throw new Error("Expected probe release callback to be initialized");
    }
    const releaseStartedProbes = releaseProbes;
    probeFeishuMock.mockImplementation(async (account: { accountId: string; appId: string }) => {
      started.push(account.accountId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await probesReleased;
      inFlight -= 1;
      return { ok: true, appId: account.appId, botOpenId: `bot_${account.accountId}` };
    });

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta", "gamma"]),
      abortSignal: abortController.signal,
    });

    try {
      await waitForStartedAccount(started, "alpha");
      expect(started).toEqual(["alpha"]);
      expect(maxInFlight).toBe(1);
    } finally {
      releaseStartedProbes();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("does not refetch bot info after a failed sequential preflight", async () => {
    const started: string[] = [];
    let releaseBetaProbe: (() => void) | undefined;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });
    if (!releaseBetaProbe) {
      throw new Error("Expected beta probe release callback to be initialized");
    }
    const releaseStartedBetaProbe = releaseBetaProbe;

    probeFeishuMock.mockImplementation(async (account: { accountId: string; appId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return { ok: false };
      }
      await betaProbeReleased;
      return { ok: true, appId: account.appId, botOpenId: `bot_${account.accountId}` };
    });

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      abortSignal: abortController.signal,
    });

    try {
      await waitForStartedAccount(started, "beta");
      expect(started).toEqual(["alpha", "beta"]);
      expect(started.reduce((count, accountId) => count + (accountId === "alpha" ? 1 : 0), 0)).toBe(
        1,
      );
    } finally {
      releaseStartedBetaProbe();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("continues startup when probe layer reports timeout", async () => {
    const started: string[] = [];
    let releaseBetaProbe: (() => void) | undefined;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });
    if (!releaseBetaProbe) {
      throw new Error("Expected beta probe release callback to be initialized");
    }
    const releaseStartedBetaProbe = releaseBetaProbe;

    probeFeishuMock.mockImplementation((account: { accountId: string; appId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return Promise.resolve({ ok: false, error: "probe timed out after 10000ms" });
      }
      return betaProbeReleased.then(() => ({
        ok: true,
        appId: account.appId,
        botOpenId: `bot_${account.accountId}`,
      }));
    });

    const abortController = new AbortController();
    const runtime = createNonExitingRuntimeEnv();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      await waitForStartedAccount(started, "beta");
      expect(started).toEqual(["alpha", "beta"]);
      expect(runtime.error).toHaveBeenCalledWith(
        "feishu[alpha]: bot info probe timed out after 30000ms; continuing startup",
      );
    } finally {
      releaseStartedBetaProbe();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("returns standard bot identity without waiting for AI-agent registration", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      appId: "cli_alpha",
      botOpenId: "bot_alpha",
      botName: "Alpha",
    });
    registerFeishuAiAgentMock.mockReturnValue(new Promise(() => {}));

    await expect(
      fetchBotIdentityForMonitor({
        accountId: "alpha",
        appId: "cli_alpha",
        appSecret: "secret_alpha", // pragma: allowlist secret
      } as never),
    ).resolves.toEqual({ botOpenId: "bot_alpha", botName: "Alpha", source: "provider" });
    expect(writeCachedFeishuBotIdentityMock).toHaveBeenCalledWith({
      accountId: "alpha",
      appId: "cli_alpha",
      botOpenId: "bot_alpha",
      botName: "Alpha",
    });
  });

  it("keeps standard bot identity when AI-agent registration is unavailable", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      appId: "cli_alpha",
      botOpenId: "bot_alpha",
      botName: "Alpha",
    });
    registerFeishuAiAgentMock.mockResolvedValue({ ok: false, reason: "api-error" });
    const runtime = createNonExitingRuntimeEnv();

    await expect(
      fetchBotIdentityForMonitor(
        {
          accountId: "alpha",
          appId: "cli_alpha",
          appSecret: "secret_alpha", // pragma: allowlist secret
        } as never,
        { runtime },
      ),
    ).resolves.toEqual({ botOpenId: "bot_alpha", botName: "Alpha", source: "provider" });
    await vi.waitFor(() => {
      expect(runtime.log).toHaveBeenCalledWith(
        "feishu[alpha]: AI-agent registration unavailable (api-error); continuing with standard bot identity",
      );
    });
  });

  it("falls back to cached identity without treating it as a fresh provider result", async () => {
    probeFeishuMock.mockResolvedValue({ ok: false, error: "rate limited" });
    readCachedFeishuBotIdentityMock.mockResolvedValue({
      botOpenId: "bot_alpha",
      botName: "Alpha",
      fetchedAt: "2026-07-22T23:00:00.000Z",
    });
    const runtime = createNonExitingRuntimeEnv();

    await expect(
      fetchBotIdentityForMonitor(
        {
          accountId: "alpha",
          appId: "cli_alpha",
          appSecret: "rotated_secret_alpha", // pragma: allowlist secret
        } as never,
        { runtime },
      ),
    ).resolves.toEqual({ botOpenId: "bot_alpha", botName: "Alpha", source: "cache" });
    expect(writeCachedFeishuBotIdentityMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[alpha]: using cached provider-verified bot identity while the fresh probe is unavailable",
    );
  });

  it("rejects a provider result from another app before persistence", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      appId: "cli_old",
      botOpenId: "bot_old",
      botName: "Old",
    });
    readCachedFeishuBotIdentityMock.mockResolvedValue(null);
    const runtime = createNonExitingRuntimeEnv();

    await expect(
      fetchBotIdentityForMonitor(
        {
          accountId: "alpha",
          appId: "cli_alpha",
          appSecret: "secret_alpha", // pragma: allowlist secret
        } as never,
        { runtime },
      ),
    ).resolves.toEqual({});
    expect(writeCachedFeishuBotIdentityMock).not.toHaveBeenCalled();
    expect(registerFeishuAiAgentMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[alpha]: bot info probe returned identity for a different app; ignoring stale result",
    );
  });

  it("bypasses cached identity during background provider refresh", async () => {
    probeFeishuMock.mockResolvedValue({ ok: false, error: "rate limited" });

    await expect(
      fetchBotIdentityForMonitor(
        {
          accountId: "alpha",
          appId: "cli_alpha",
          appSecret: "secret_alpha", // pragma: allowlist secret
        } as never,
        { allowCachedFallback: false },
      ),
    ).resolves.toEqual({});
    expect(readCachedFeishuBotIdentityMock).not.toHaveBeenCalled();
  });

  it("keeps cache read and write failures best-effort", async () => {
    const runtime = createNonExitingRuntimeEnv();
    probeFeishuMock.mockResolvedValueOnce({
      ok: true,
      appId: "cli_alpha",
      botOpenId: "bot_alpha",
      botName: "Alpha",
    });
    writeCachedFeishuBotIdentityMock.mockRejectedValueOnce(new Error("state unavailable"));

    await expect(
      fetchBotIdentityForMonitor(
        {
          accountId: "alpha",
          appId: "cli_alpha",
          appSecret: "secret_alpha", // pragma: allowlist secret
        } as never,
        { runtime },
      ),
    ).resolves.toEqual({ botOpenId: "bot_alpha", botName: "Alpha", source: "provider" });

    probeFeishuMock.mockResolvedValueOnce({ ok: false, error: "rate limited" });
    readCachedFeishuBotIdentityMock.mockRejectedValueOnce(new Error("state unavailable"));
    await expect(
      fetchBotIdentityForMonitor(
        {
          accountId: "alpha",
          appId: "cli_alpha",
          appSecret: "secret_alpha", // pragma: allowlist secret
        } as never,
        { runtime },
      ),
    ).resolves.toEqual({});
  });

  it("starts a provider refresh while a cached identity keeps ingress available", async () => {
    probeFeishuMock.mockResolvedValue({ ok: false, error: "rate limited" });
    readCachedFeishuBotIdentityMock.mockResolvedValue({
      botOpenId: "bot_alpha",
      botName: "Alpha",
      fetchedAt: "2026-07-22T23:00:00.000Z",
    });
    const abortController = new AbortController();
    const runtime = createNonExitingRuntimeEnv();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha"]),
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      await vi.waitFor(() => {
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining(
            "feishu[alpha]: bot open_id loaded from cache; starting background provider refresh",
          ),
        );
      });
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("stops sequential preflight when aborted during probe", async () => {
    const started: string[] = [];
    probeFeishuMock.mockImplementation(
      (account: { accountId: string }, options: { abortSignal?: AbortSignal }) => {
        started.push(account.accountId);
        return new Promise((resolve) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "probe aborted" }),
            { once: true },
          );
        });
      },
    );

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      abortSignal: abortController.signal,
    });

    try {
      await waitForStartedAccount(started, "alpha");
      expect(started).toEqual(["alpha"]);

      abortController.abort();
      await monitorPromise;

      expect(started).toEqual(["alpha"]);
    } finally {
      abortController.abort();
    }
  });
});
