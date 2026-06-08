// Shared heartbeat runner fixtures for infra tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";

// Heartbeat test utilities seed session stores and temporary heartbeat prompts
// while keeping plugin registry and environment state isolated per test.
type HeartbeatSessionSeed = {
  sessionId?: string;
  updatedAt?: number;
  lastChannel: string;
  lastProvider: string;
  lastTo: string;
  pendingFinalDelivery?: boolean;
  pendingFinalDeliveryText?: string;
  pendingFinalDeliveryCreatedAt?: number;
  pendingFinalDeliveryAttemptCount?: number;
  pendingFinalDeliveryLastError?: string | null;
  heartbeatTaskState?: Record<string, number>;
  agentHarnessId?: string;
  agentRuntimeOverride?: string;
  model?: string;
  modelProvider?: string;
};

type HeartbeatReplyFn = NonNullable<HeartbeatDeps["getReplyFromConfig"]>;
export type HeartbeatReplySpy = ReturnType<typeof vi.fn<HeartbeatReplyFn>>;

function createHeartbeatReplySpy(): HeartbeatReplySpy {
  const replySpy: HeartbeatReplySpy = vi.fn<HeartbeatReplyFn>();
  replySpy.mockResolvedValue({ text: "ok" });
  return replySpy;
}

/** Write a single heartbeat session entry into the SQLite-backed session store. */
export async function seedSessionStore(
  storePath: string,
  sessionKey: string,
  session: HeartbeatSessionSeed,
): Promise<void> {
  const existingStore = loadSessionStore(storePath, { skipCache: true });
  await saveSessionStore(
    storePath,
    {
      ...existingStore,
      [sessionKey]: {
        sessionId: session.sessionId ?? "sid",
        updatedAt: session.updatedAt ?? Date.now(),
        ...session,
      },
    },
    { skipMaintenance: true },
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
  await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "- Check status\n", "utf-8");
  const storePath = path.join(tmpDir, "sessions.json");
  const replySpy = createHeartbeatReplySpy();
  const previousEnv = new Map<string, string | undefined>();
  for (const envName of options?.unsetEnvVars ?? []) {
    previousEnv.set(envName, process.env[envName]);
    process.env[envName] = "";
  }
  try {
    return await fn({ tmpDir, storePath, replySpy });
  } finally {
    replySpy.mockReset();
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
