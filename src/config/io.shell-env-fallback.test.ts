// Covers shell environment fallback handling in config IO.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

const shellEnvMocks = vi.hoisted(() => ({
  loadShellEnvFallback: vi.fn(),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 15_000),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  loadShellEnvFallback: shellEnvMocks.loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs: shellEnvMocks.resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback: shellEnvMocks.shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback: shellEnvMocks.shouldEnableShellEnvFallback,
}));

async function withConfig(run: (params: { home: string; configPath: string }) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shell-env-"));
  try {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ env: { shellEnv: { enabled: true } } }, null, 2),
    );
    await run({ home, configPath });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("config io shell env fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReturnValue(15_000);
    shellEnvMocks.shouldDeferShellEnvFallback.mockReturnValue(false);
    shellEnvMocks.shouldEnableShellEnvFallback.mockReturnValue(false);
  });

  it("can defer shell env fallback during config load", async () => {
    await withConfig(async ({ home, configPath }) => {
      const env = {} as NodeJS.ProcessEnv;
      const logger = { error: vi.fn(), warn: vi.fn() };
      const baseOptions = {
        configPath,
        env,
        homedir: () => home,
        logger,
        observe: false,
      };

      createConfigIO(baseOptions).loadConfig();
      expect(shellEnvMocks.loadShellEnvFallback).toHaveBeenCalledTimes(1);

      shellEnvMocks.loadShellEnvFallback.mockClear();
      createConfigIO({
        ...baseOptions,
        shellEnvFallback: "defer",
      }).loadConfig();
      expect(shellEnvMocks.loadShellEnvFallback).not.toHaveBeenCalled();
    });
  });

  it("honors deferred shell env fallback when the config file is missing", async () => {
    await withConfig(async ({ home, configPath }) => {
      await fs.rm(configPath);
      shellEnvMocks.shouldEnableShellEnvFallback.mockReturnValue(true);
      const env = {} as NodeJS.ProcessEnv;
      const logger = { error: vi.fn(), warn: vi.fn() };
      const baseOptions = {
        configPath,
        env,
        homedir: () => home,
        logger,
        observe: false,
      };

      createConfigIO({
        ...baseOptions,
        shellEnvFallback: "defer",
      }).loadConfig();
      expect(shellEnvMocks.loadShellEnvFallback).not.toHaveBeenCalled();

      createConfigIO(baseOptions).loadConfig();
      expect(shellEnvMocks.loadShellEnvFallback).toHaveBeenCalledTimes(1);
    });
  });
});
