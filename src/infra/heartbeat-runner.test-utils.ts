import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";

type HeartbeatSessionSeed = {
  sessionId?: string;
  updatedAt?: number;
  lastChannel: string;
  lastProvider: string;
  lastTo: string;
};

type HeartbeatReplyFn = NonNullable<HeartbeatDeps["getReplyFromConfig"]>;
export type HeartbeatReplySpy = ReturnType<typeof vi.fn<HeartbeatReplyFn>>;

function createHeartbeatReplySpy(): HeartbeatReplySpy {
  const replySpy: HeartbeatReplySpy = vi.fn<HeartbeatReplyFn>();
  replySpy.mockResolvedValue({ text: "ok" });
  return replySpy;
}

export async function seedSessionStore(
  storePath: string,
  sessionKey: string,
  session: HeartbeatSessionSeed,
): Promise<void> {
  let existingStore: Record<string, unknown> = {};
  try {
    existingStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
  } catch {
    existingStore = {};
  }
  await fs.writeFile(
    storePath,
    JSON.stringify({
      ...existingStore,
      [sessionKey]: {
        sessionId: session.sessionId ?? "sid",
        updatedAt: session.updatedAt ?? Date.now(),
        ...session,
      },
    }),
  );
}

export async function seedMainSessionStore(
  storePath: string,
  cfg: OpenClawConfig,
  session: HeartbeatSessionSeed,
): Promise<string> {
  const sessionKey = resolveMainSessionKey(cfg);
  await seedSessionStore(storePath, sessionKey, session);
  return sessionKey;
}

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

export function setupTelegramHeartbeatPluginRuntimeForTests() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
    ]),
  );
}
