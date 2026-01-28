import { vi } from "vitest";

import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "moltbot-config-" });
}

/**
 * Helper to test env var overrides. Saves/restores env vars and resets modules.
 */
export async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  }
}
