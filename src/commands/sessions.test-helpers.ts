// Session command test helpers create temporary homes, session stores, and runtime fixtures.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";

const sessionsConfigState = vi.hoisted<{ loadConfig: () => Record<string, unknown> }>(() => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "test:opus" },
        models: { "test:opus": {} },
        contextTokens: 32000,
      },
    },
  }),
}));

const defaultSessionsConfigLoader = sessionsConfigState.loadConfig;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => sessionsConfigState.loadConfig(),
  loadConfig: () => sessionsConfigState.loadConfig(),
}));

vi.mock("../infra/state-migrations.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/state-migrations.js")>(
    "../infra/state-migrations.js",
  )),
  autoMigrateLegacyState: vi.fn(async () => ({
    migrated: false,
    skipped: true,
    changes: [],
    warnings: [],
  })),
}));

export function mockSessionsConfig() {
  // The shared config mock is hoisted above so tests can keep their
  // existing setup call without paying `importActual` cost or nested-mock
  // warnings before importing `sessions.ts`.
}

export function setMockSessionsConfig(loader: () => Record<string, unknown>) {
  sessionsConfigState.loadConfig = loader;
}

export function resetMockSessionsConfig() {
  sessionsConfigState.loadConfig = defaultSessionsConfigLoader;
}

export function makeRuntime(params?: { throwOnError?: boolean }): {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const throwOnError = params?.throwOnError ?? false;
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => {
        errors.push(String(msg));
        if (throwOnError) {
          throw new Error(String(msg));
        }
      },
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    logs,
    errors,
  };
}

/** Seeds an isolated SQLite-backed session store and returns its legacy target path. */
export async function writeStore(
  data: Record<string, SessionEntry>,
  prefix = "sessions",
  options: { agentId?: string } = {},
): Promise<string> {
  const dirName = [prefix, Date.now(), randomUUID()].join("-");
  const storeDir = path.join(os.tmpdir(), dirName);
  fs.mkdirSync(storeDir, { recursive: true });
  const storePath = path.join(storeDir, "sessions.json");
  for (const [sessionKey, entry] of Object.entries(data)) {
    await replaceSessionEntry({ agentId: options.agentId ?? "main", sessionKey, storePath }, entry);
  }
  return storePath;
}

/** Removes the temporary SQLite session store created by writeStore. */
export function cleanupStore(store: string): void {
  fs.rmSync(path.dirname(store), { recursive: true, force: true });
}

/** Runs sessionsCommand with JSON output and parses the emitted payload. */
export async function runSessionsJson<T>(
  run: (
    opts: { json?: boolean; store?: string; active?: string; limit?: string | number },
    runtime: RuntimeEnv,
  ) => Promise<void>,
  store: string,
  options?: {
    active?: string;
    limit?: string | number;
  },
): Promise<T> {
  const { runtime, logs } = makeRuntime();
  try {
    await run(
      {
        store,
        json: true,
        active: options?.active,
        limit: options?.limit,
      },
      runtime,
    );
  } finally {
    cleanupStore(store);
  }
  return JSON.parse(logs[0] ?? "{}") as T;
}
