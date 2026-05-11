import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDeprecatedInternalConfigApiViolations,
  collectRuntimeActionLoadConfigViolations,
} from "../../../scripts/lib/config-boundary-guard.mjs";

let tempRoots: string[] = [];

function makeRepoFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-config-boundary-"));
  tempRoots.push(repoRoot);
  for (const dir of ["src", "extensions", "packages", "test", "scripts"]) {
    mkdirSync(join(repoRoot, dir), { recursive: true });
  }
  return repoRoot;
}

function writeFixture(repoRoot: string, relPath: string, source: string): void {
  const filePath = join(repoRoot, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

describe("config boundary guard", () => {
  afterEach(() => {
    for (const repoRoot of tempRoots) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  it("flags deprecated runtime config calls in production plugin code", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.ts",
      "export function register(api) { return api.runtime.config.loadConfig(); }\n",
    );

    const violations = collectDeprecatedInternalConfigApiViolations({ repoRoot });
    expect(violations).toEqual([
      "extensions/telegram/src/index.ts:1 use runtime.config.current() or pass the already loaded config",
      "extensions/telegram/src/index.ts:1 use runtime.config.current(), getRuntimeConfig(), or passed config",
      "extensions/telegram/src/index.ts:1 use a passed cfg, context.getRuntimeConfig(), or getRuntimeConfig() at an explicit process boundary",
    ]);
  });

  it("flags loadConfig in runtime channel action helpers only", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/send.ts",
      "export async function send() { return loadConfig(); }\n",
    );
    writeFixture(
      repoRoot,
      "extensions/telegram/src/monitor/status.ts",
      "export async function monitor() { return loadConfig(); }\n",
    );
    writeFixture(
      repoRoot,
      "extensions/openai/src/send.ts",
      "export async function provider() { return loadConfig(); }\n",
    );

    expect(collectRuntimeActionLoadConfigViolations({ repoRoot })).toEqual([
      "extensions/telegram/src/send.ts:1: export async function send() { return loadConfig(); }",
    ]);
  });

  it("flags broad config-runtime barrel imports in production code", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.ts",
      [
        'import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";',
        'import { requireRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";',
        'type Loader = typeof import("openclaw/plugin-sdk/config-runtime").getRuntimeConfig;',
        "export type Config = OpenClawConfig;",
        "export const load: Loader = requireRuntimeConfig;",
      ].join("\n"),
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([
      "extensions/telegram/src/index.ts:1 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
      "extensions/telegram/src/index.ts:2 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
      "extensions/telegram/src/index.ts:3 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
    ]);
  });

  it("flags broad config-runtime test mocks outside compat guard fixtures", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.test.ts",
      'vi.mock("openclaw/plugin-sdk/config-runtime", () => ({}));',
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([
      "extensions/telegram/src/index.test.ts:1 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
    ]);
  });

  it("allows narrow config SDK subpaths in production code", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.ts",
      [
        'import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";',
        'import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";',
        'type Loader = typeof import("openclaw/plugin-sdk/runtime-config-snapshot").getRuntimeConfig;',
        'export const load = (cfg: OpenClawConfig) => requireRuntimeConfig(cfg, "telegram");',
      ].join("\n"),
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toStrictEqual([]);
  });
});
