import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSqliteSessionTranscriptEventForTest,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

const ORPHAN_AGE_MS = 300_000;

type GatewayHook = (event: unknown, context: unknown) => Promise<void> | void;

let stateDir: string;
let stopGateway: (() => Promise<void>) | undefined;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dreaming-startup-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(async () => {
  await stopGateway?.();
  stopGateway = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
});

function createGateway(
  params: { agentIds?: string[]; failCronReconciliation?: boolean; sessionStore?: string } = {},
) {
  const agentIds = params.agentIds ?? ["main"];
  const config = {
    agents: {
      list: agentIds.map((id, index) => ({
        id,
        default: index === 0,
        workspace: path.join(stateDir, `workspace-${id}`),
      })),
    },
    plugins: {
      entries: {
        "memory-core": { config: { dreaming: { enabled: true, frequency: "0 2 * * *" } } },
      },
    },
    ...(params.sessionStore ? { session: { store: params.sessionStore } } : {}),
  } as OpenClawConfig;
  const onMock = vi.fn<OpenClawPluginApi["on"]>();
  const services: OpenClawPluginService[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cron = {
    list: vi.fn(async () => {
      if (params.failCronReconciliation) {
        throw new Error("cron startup failed");
      }
      return [];
    }),
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ removed: false })),
    removeStaleJobFamily: vi.fn(async () => 0),
  };
  const api = createTestPluginApi({
    config,
    pluginConfig: {},
    logger,
    on: onMock,
    registerService: (service: OpenClawPluginService) => services.push(service),
  });
  Object.assign(api.runtime, { config: { current: () => config } });
  registerShortTermPromotionDreaming(api);

  const service = services.find((entry) => entry.id === "memory-core-dreaming");
  if (!service) {
    throw new Error("memory-core-dreaming service missing");
  }
  const serviceContext = { config, stateDir, logger, getCron: () => cron };
  const startService = async () => {
    await service.start(serviceContext);
  };
  const start = async () => {
    await startService();
    const hook = onMock.mock.calls.find(([name]) => name === "gateway_start")?.[1] as
      | GatewayHook
      | undefined;
    if (!hook) {
      throw new Error("gateway_start hook missing");
    }
    await hook({ port: 0 }, { config, getCron: () => cron });
  };
  const stop = async () => {
    await service.stop?.(serviceContext);
  };
  stopGateway = stop;
  return { config, cron, logger, start, startService, stop };
}

async function seedSession(params: {
  agentId?: string;
  suffix: string;
  updatedAt: number;
  transcriptAt?: number;
  pluginOwnerId?: string;
  storePath?: string;
}) {
  const agentId = params.agentId ?? "main";
  const sessionKey = `agent:${agentId}:${params.suffix}`;
  const sessionId = `${agentId}-${params.suffix}`;
  await upsertSessionEntry({
    agentId,
    sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
    entry: {
      sessionId,
      updatedAt: params.updatedAt,
      ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
    },
  });
  if (params.transcriptAt !== undefined) {
    await appendSqliteSessionTranscriptEventForTest({
      agentId,
      sessionId,
      sessionKey,
      ...(params.storePath ? { storePath: params.storePath } : {}),
      event: {
        runId: `dreaming-narrative-${sessionId}`,
        timestamp: params.transcriptAt,
        type: "metadata",
      },
    });
  }
  return { agentId, sessionKey };
}

function hasSession(scope: { agentId: string; sessionKey: string }): boolean {
  return getSessionEntry(scope) !== undefined;
}

describe("dreaming gateway restart cleanup", () => {
  it("does not create agent storage on a fresh gateway startup", async () => {
    const gateway = createGateway({ agentIds: ["main", "researcher"] });

    await gateway.start();

    await expect(fs.access(path.join(stateDir, "agents"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims every stale dreaming phase without touching active, unrelated, or other-agent sessions", async () => {
    const now = Date.now();
    const stale = await Promise.all(
      ["light", "rem", "deep", "consolidation"].map((phase) =>
        seedSession({
          suffix: `dreaming-narrative-${phase}-interrupted`,
          ...(phase === "rem" ? {} : { pluginOwnerId: "memory-core" }),
          updatedAt: now - ORPHAN_AGE_MS - 1,
          transcriptAt: now - ORPHAN_AGE_MS - 1,
        }),
      ),
    );
    const activeWithTranscript = await seedSession({
      suffix: "dreaming-narrative-light-active",
      updatedAt: now,
      transcriptAt: now,
    });
    const activeBeforeTranscript = await seedSession({
      suffix: "dreaming-narrative-rem-starting",
      updatedAt: now,
    });
    const userSession = await seedSession({
      suffix: "telegram:group:dreaming-narrative-room",
      updatedAt: now - ORPHAN_AGE_MS - 1,
    });
    const foreignPluginSession = await seedSession({
      suffix: "dreaming-narrative-foreign",
      pluginOwnerId: "other-plugin",
      updatedAt: now - ORPHAN_AGE_MS - 1,
      transcriptAt: now - ORPHAN_AGE_MS - 1,
    });
    const otherAgent = await seedSession({
      agentId: "researcher",
      suffix: "dreaming-narrative-light-interrupted",
      updatedAt: now - ORPHAN_AGE_MS - 1,
      transcriptAt: now - ORPHAN_AGE_MS - 1,
    });
    const gateway = createGateway();

    await gateway.start();

    expect(stale.map(hasSession)).toEqual([false, false, false, false]);
    expect(hasSession(activeWithTranscript)).toBe(true);
    expect(hasSession(activeBeforeTranscript)).toBe(true);
    expect(hasSession(userSession)).toBe(true);
    expect(hasSession(foreignPluginSession)).toBe(true);
    expect(hasSession(otherAgent)).toBe(true);
  });

  it("rechecks fresh interrupted sessions once they age without deleting newly started work", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const interrupted = await seedSession({
      suffix: "dreaming-narrative-deep-interrupted",
      updatedAt: Date.now() - 1,
      transcriptAt: Date.now() - 1,
    });
    const gateway = createGateway();

    await gateway.start();
    expect(hasSession(interrupted)).toBe(true);

    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS - 1);
    const newlyStarted = await seedSession({
      suffix: "dreaming-narrative-light-just-started",
      updatedAt: Date.now(),
    });
    expect(hasSession(interrupted)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await gateway.stop();

    expect(hasSession(interrupted)).toBe(false);
    expect(hasSession(newlyStarted)).toBe(true);
  });

  it("does not reclaim post-startup runs when the deferred cleanup callback runs late", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const interruptedAtStartup = await seedSession({
      suffix: "dreaming-narrative-deep-interrupted",
      updatedAt: Date.now() - 1,
      transcriptAt: Date.now() - 1,
    });
    const gateway = createGateway();

    await gateway.start();
    const postStartupUpdatedAt = Date.now();
    const activeWithTranscript = await seedSession({
      suffix: "dreaming-narrative-light-still-running",
      updatedAt: postStartupUpdatedAt,
      transcriptAt: postStartupUpdatedAt,
    });
    const activeWithoutTranscript = await seedSession({
      suffix: "dreaming-narrative-rem-still-running",
      updatedAt: postStartupUpdatedAt,
    });

    // Wall-clock stalls can outlive agent.wait; that wait never cancels the agent run.
    vi.setSystemTime(Date.now() + ORPHAN_AGE_MS + 1);
    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS);
    await gateway.stop();

    expect(Date.now() - postStartupUpdatedAt).toBeGreaterThan(ORPHAN_AGE_MS);
    expect(hasSession(interruptedAtStartup)).toBe(false);
    expect(hasSession(activeWithTranscript)).toBe(true);
    expect(hasSession(activeWithoutTranscript)).toBe(true);
  });

  it("does not reclaim post-startup runs when cron startup reconciliation stalls", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const staleAtStartup = await seedSession({
      suffix: "dreaming-narrative-deep-interrupted",
      updatedAt: Date.now() - ORPHAN_AGE_MS - 1,
    });
    const postStartupSessions: Array<{ agentId: string; sessionKey: string }> = [];
    let postStartupUpdatedAt = 0;
    const gateway = createGateway();
    gateway.cron.list.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(1);
      postStartupUpdatedAt = Date.now();
      postStartupSessions.push(
        await seedSession({
          suffix: "dreaming-narrative-light-reconciliation-active",
          updatedAt: postStartupUpdatedAt,
          transcriptAt: postStartupUpdatedAt,
        }),
        await seedSession({
          suffix: "dreaming-narrative-rem-reconciliation-active",
          updatedAt: postStartupUpdatedAt,
        }),
      );
      vi.setSystemTime(postStartupUpdatedAt + ORPHAN_AGE_MS + 1);
      return [];
    });

    await gateway.start();

    expect(Date.now() - postStartupUpdatedAt).toBeGreaterThan(ORPHAN_AGE_MS);
    expect(hasSession(staleAtStartup)).toBe(false);
    expect(postStartupSessions.map(hasSession)).toEqual([true, true]);
  });

  it("cleans the independent SQLite stores of every configured dreaming agent", async () => {
    const now = Date.now();
    const stale = await Promise.all(
      ["main", "researcher"].map((agentId) =>
        seedSession({
          agentId,
          suffix: "dreaming-narrative-light-interrupted",
          pluginOwnerId: "memory-core",
          updatedAt: now - ORPHAN_AGE_MS - 1,
          transcriptAt: now - ORPHAN_AGE_MS - 1,
        }),
      ),
    );
    const gateway = createGateway({ agentIds: ["main", "researcher"] });

    await gateway.start();

    expect(stale.map(hasSession)).toEqual([false, false]);
  });

  it("preserves unconfigured agents sharing a configured agent's SQLite store", async () => {
    const storePath = path.join(stateDir, "shared.sqlite");
    const staleUpdatedAt = Date.now() - ORPHAN_AGE_MS - 1;
    const main = await seedSession({
      agentId: "main",
      suffix: "dreaming-narrative-main-interrupted",
      updatedAt: staleUpdatedAt,
      storePath,
    });
    const researcher = await seedSession({
      agentId: "researcher",
      suffix: "dreaming-narrative-researcher-interrupted",
      updatedAt: staleUpdatedAt,
      storePath,
    });
    const gateway = createGateway({ sessionStore: storePath });

    await gateway.start();

    expect(getSessionEntry({ ...main, storePath })).toBeUndefined();
    expect(getSessionEntry({ ...researcher, storePath })).toMatchObject({
      sessionId: "researcher-dreaming-narrative-researcher-interrupted",
    });
  });

  it("does not repeat restart cleanup when the dreaming service is replaced", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const interrupted = await seedSession({
      suffix: "dreaming-narrative-light-interrupted",
      updatedAt: Date.now() - 1,
      transcriptAt: Date.now() - 1,
    });
    const gateway = createGateway();

    await gateway.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const currentRun = await seedSession({
      suffix: "dreaming-narrative-rem-current",
      updatedAt: Date.now(),
      transcriptAt: Date.now(),
    });
    await gateway.stop();
    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS + 1);
    const successor = createGateway();
    await successor.startService();
    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS);
    await successor.stop();

    expect(hasSession(interrupted)).toBe(true);
    expect(hasSession(currentRun)).toBe(true);
  });

  it("cancels deferred orphan cleanup when the gateway stops", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const interrupted = await seedSession({
      suffix: "dreaming-narrative-light-interrupted",
      updatedAt: Date.now() - 1,
      transcriptAt: Date.now() - 1,
    });
    const gateway = createGateway();

    await gateway.start();
    await gateway.stop();
    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS);

    expect(hasSession(interrupted)).toBe(true);
  });

  it("still cleans interrupted dreaming sessions when cron startup reconciliation fails", async () => {
    const now = Date.now();
    const interrupted = await seedSession({
      suffix: "dreaming-narrative-light-interrupted",
      updatedAt: now - ORPHAN_AGE_MS - 1,
      transcriptAt: now - ORPHAN_AGE_MS - 1,
    });
    const gateway = createGateway({ failCronReconciliation: true });

    await gateway.start();

    expect(hasSession(interrupted)).toBe(false);
    expect(gateway.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("dreaming startup reconciliation failed"),
    );
  });
});
