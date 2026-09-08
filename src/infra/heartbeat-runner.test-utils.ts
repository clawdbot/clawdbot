// Shared heartbeat runner fixtures for infra tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { CronService } from "../cron/service.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";

// Heartbeat test utilities seed session stores and temporary heartbeat prompts
// while keeping plugin registry and environment state isolated per test.
type HeartbeatSessionSeed = Partial<InternalSessionEntry> & {
  lastChannel: string;
  lastProvider: string;
  lastTo: string;
  deliveryContext?: DeliveryContext;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type HeartbeatReplyFn = NonNullable<HeartbeatDeps["getReplyFromConfig"]>;
export type HeartbeatReplySpy = ReturnType<typeof vi.fn<HeartbeatReplyFn>>;

function createHeartbeatReplySpy(): HeartbeatReplySpy {
  const replySpy: HeartbeatReplySpy = vi.fn<HeartbeatReplyFn>();
  replySpy.mockResolvedValue({ text: "ok" });
  return replySpy;
}

/** Set the invocation's execution receipt without replacing its admission state. */
export function setHeartbeatAgentTurnStatus(
  options: object | undefined,
  status: "ok" | "failed" | "superseded" | "cancelled",
) {
  const runState = resolveReplyOperationRunState(options);
  if (!runState) {
    throw new Error("Expected heartbeat reply operation run state");
  }
  runState.agentTurn = status === "superseded" ? "cancelled" : status;
  if (status === "superseded") {
    const operation = createReplyOperation({
      sessionKey: "heartbeat-test-superseded",
      sessionId: "heartbeat-test-superseded",
      turnKind: "heartbeat",
      resetTriggered: false,
    });
    operation.supersede();
    operation.complete();
    runState.agentTurnOwner = operation;
  }
}

/** Seed one system heartbeat monitor and its private scratch in the test state DB. */
export async function seedHeartbeatScratchForTest(params: {
  content: string | null;
  agentId?: string;
  storePath?: string;
}): Promise<string> {
  const agentId = params.agentId ?? "main";
  const storePath = params.storePath ?? resolveCronJobsStorePath();
  const noop = () => {};
  const cron = new CronService({
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: { debug: noop, info: noop, warn: noop, error: noop },
    enqueueSystemEvent: () => false,
    requestHeartbeat: noop,
    runIsolatedAgentJob: async () => ({ status: "skipped", error: "test" }),
  });
  const result = await cron.add(
    {
      declarationKey: `heartbeat:${agentId}`,
      displayName: `Heartbeat (${agentId})`,
      name: `heartbeat-${agentId}`,
      agentId,
      enabled: true,
      schedule: { kind: "every", everyMs: 30 * 60_000, anchorMs: 0 },
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    },
    { enabledExplicit: true, systemOwned: true },
  );
  const job = "job" in result ? result.job : result;
  writeCronJobScratch({ storePath, jobId: job.id, content: params.content });
  return job.id;
}

/** Write a single heartbeat session entry through the SQLite session accessor. */
export async function seedSessionStore(
  storePath: string,
  sessionKey: string,
  session: Partial<HeartbeatSessionSeed>,
): Promise<void> {
  const {
    deliveryContext,
    lastAccountId,
    lastChannel,
    lastProvider: _lastProvider,
    lastThreadId,
    lastTo,
    ...entry
  } = session;
  await replaceSessionEntry(
    { storePath, sessionKey },
    {
      sessionId: session.sessionId ?? "sid",
      updatedAt: session.updatedAt ?? Date.now(),
      ...entry,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: deliveryContext?.channel ?? lastChannel,
          to: deliveryContext?.to ?? lastTo,
          accountId: deliveryContext?.accountId ?? lastAccountId,
          threadId: deliveryContext?.threadId ?? lastThreadId,
        },
      }),
    },
  );
}

/** Read session entries through the SQLite session accessor as a keyed object. */
export function readSessionStoreForTest<T extends object = HeartbeatSessionSeed>(
  storePath: string,
): Record<string, T> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry as T]),
  );
}

/** Seed the configured main session and return its session key. */
export async function seedMainSessionStore(
  storePath: string,
  cfg: OpenClawConfig,
  session: HeartbeatSessionSeed,
): Promise<string> {
  const sessionKey = resolveMainSessionKey(cfg);
  await seedSessionStore(storePath, sessionKey, session);
  return sessionKey;
}

/** Run a heartbeat test inside a temporary prompt/session-store sandbox. */
export async function withTempHeartbeatSandbox<T>(
  fn: (ctx: { tmpDir: string; storePath: string; replySpy: HeartbeatReplySpy }) => Promise<T>,
  options?: {
    prefix?: string;
    unsetEnvVars?: string[];
  },
): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-hb-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const replySpy = createHeartbeatReplySpy();
  const previousEnv = new Map<string, string | undefined>();
  const envNames = new Set(["OPENCLAW_STATE_DIR", ...(options?.unsetEnvVars ?? [])]);
  for (const envName of envNames) {
    previousEnv.set(envName, process.env[envName]);
    process.env[envName] = envName === "OPENCLAW_STATE_DIR" ? path.join(tmpDir, "state") : "";
  }
  await seedHeartbeatScratchForTest({ content: "- Check status\n" });
  try {
    return await fn({ tmpDir, storePath, replySpy });
  } finally {
    replySpy.mockReset();
    closeOpenClawStateDatabaseForTest();
    for (const [envName, previousValue] of previousEnv.entries()) {
      if (previousValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousValue;
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** Run a Telegram heartbeat test with Telegram credentials removed. */
export async function withTempTelegramHeartbeatSandbox<T>(
  fn: (ctx: { tmpDir: string; storePath: string; replySpy: HeartbeatReplySpy }) => Promise<T>,
  options?: {
    prefix?: string;
  },
): Promise<T> {
  return withTempHeartbeatSandbox(fn, {
    prefix: options?.prefix,
    unsetEnvVars: ["TELEGRAM_BOT_TOKEN"],
  });
}

/** Install only the Telegram heartbeat plugin in the active test registry. */
export function setupTelegramHeartbeatPluginRuntimeForTests() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
    ]),
  );
}

export type HeartbeatReplyContext = Pick<
  MsgContext,
  "InternalTurnSource" | "SessionKey" | "MessageThreadId" | "Body"
>;

export const mockCallAt = (
  mock: { mock: { calls: Array<readonly unknown[]> } },
  index: number,
  label: string,
): readonly unknown[] => {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
};

export const getFirstReplyContext = (replySpy: ReturnType<typeof vi.fn>): HeartbeatReplyContext => {
  const [ctx] = mockCallAt(replySpy, 0, "heartbeat reply");
  if (!ctx || typeof ctx !== "object") {
    throw new Error("expected heartbeat reply context");
  }
  return ctx as HeartbeatReplyContext;
};
