// Provides assertions for redacted snapshot tests.
import { expect } from "vitest";
import { restoreRedactedValues as restoreRedactedValues_orig } from "./redact-snapshot.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type ConfigUiHints = NonNullable<Parameters<typeof restoreRedactedValues_orig>[2]>;

/** Complete snapshot shape used by redaction tests. */
export type TestSnapshot<TConfig extends Record<string, unknown>> = ConfigFileSnapshot & {
  parsed: TConfig;
  sourceConfig: TConfig;
  resolved: TConfig;
  runtimeConfig: TConfig;
  config: TConfig;
};

export function makeSnapshot<TConfig extends Record<string, unknown>>(
  config: TConfig,
  raw?: string,
): TestSnapshot<TConfig> {
  return {
    path: "/home/user/.openclaw/config.json5",
    exists: true,
    raw: raw ?? JSON.stringify(config),
    parsed: config,
    sourceConfig: config as ConfigFileSnapshot["sourceConfig"],
    resolved: config as ConfigFileSnapshot["resolved"],
    valid: true,
    runtimeConfig: config as ConfigFileSnapshot["runtimeConfig"],
    config: config as ConfigFileSnapshot["config"],
    hash: "abc123",
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as unknown as TestSnapshot<TConfig>;
}

export function restoreRedactedValues<TOriginal>(
  incoming: unknown,
  original: TOriginal,
  hints?: ConfigUiHints,
): TOriginal {
  const result = restoreRedactedValues_orig(incoming, original, hints);
  expect(result.ok).toBe(true);
  return result.result as TOriginal;
}
