import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const sessionsConfigState = vi.hoisted(() => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
        contextTokens: 32000,
      },
    },
  }),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => sessionsConfigState.loadConfig(),
  loadConfig: () => sessionsConfigState.loadConfig(),
}));

export function mockSessionsConfig() {
  // The shared config mock is hoisted above so tests can keep their
  // existing setup call without paying `importActual` cost or nested-mock
  // warnings before importing `sessions.ts`.
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

export function writeStore(data: unknown, prefix = "sessions"): string {
  const fileName = `${[prefix, Date.now(), randomUUID()].join("-")}.json`;
  const file = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export async function runSessionsJson<T>(
  run: (
    opts: { json?: boolean; store?: string; active?: string },
    runtime: RuntimeEnv,
  ) => Promise<void>,
  store: string,
  options?: {
    active?: string;
  },
): Promise<T> {
  const { runtime, logs } = makeRuntime();
  try {
    await run(
      {
        store,
        json: true,
        active: options?.active,
      },
      runtime,
    );
  } finally {
    fs.rmSync(store, { force: true });
  }
  return JSON.parse(logs[0] ?? "{}") as T;
}
