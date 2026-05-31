import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildTestLiveEnv,
  buildTestLivePnpmArgs,
  parseTestLiveArgs,
  resolveTestLiveHeartbeatMs,
} from "../../scripts/test-live.mjs";

describe("scripts/test-live", () => {
  it("parses wrapper flags before live test spawn", () => {
    const args = parseTestLiveArgs([
      "--codex-harness",
      "--no-quiet",
      "--",
      "src/gateway/gateway-codex-harness.live.test.ts",
      "--reporter=verbose",
    ]);

    expect(args).toEqual({
      forceCodexHarness: true,
      forwardedArgs: ["src/gateway/gateway-codex-harness.live.test.ts", "--reporter=verbose"],
      help: false,
      quietOverride: "0",
    });
    expect(buildTestLivePnpmArgs(args)).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "test/vitest/vitest.live.config.ts",
      "src/gateway/gateway-codex-harness.live.test.ts",
      "--reporter=verbose",
    ]);
  });

  it("preserves vitest flags after the passthrough separator", () => {
    const args = parseTestLiveArgs([
      "--quiet",
      "--",
      "--help",
      "--no-quiet",
      "--codex-harness",
    ]);

    expect(args).toEqual({
      forceCodexHarness: false,
      forwardedArgs: ["--help", "--no-quiet", "--codex-harness"],
      help: false,
      quietOverride: "1",
    });
  });

  it("builds live env without mutating caller env", () => {
    const env = buildTestLiveEnv(
      { forceCodexHarness: true, forwardedArgs: [], help: false, quietOverride: undefined },
      {},
    );

    expect(env).toMatchObject({
      CI: "1",
      OPENCLAW_LIVE_CODEX_HARNESS: "1",
      OPENCLAW_LIVE_TEST: "1",
      OPENCLAW_LIVE_TEST_QUIET: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      pnpm_config_verify_deps_before_run: "false",
    });
  });

  it("rejects loose heartbeat intervals instead of parsing prefixes", () => {
    expect(resolveTestLiveHeartbeatMs({})).toBe(20_000);
    expect(resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "2500" })).toBe(
      2500,
    );
    expect(() =>
      resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "1e3" }),
    ).toThrow("invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 1e3");
    expect(() =>
      resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "1000ms" }),
    ).toThrow("invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 1000ms");
    expect(() =>
      resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "0" }),
    ).toThrow("invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 0");
  });

  it("prints help without spawning live Vitest", () => {
    const result = spawnSync(process.execPath, ["scripts/test-live.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/test-live.mjs");
    expect(result.stdout).not.toContain("Scope:");
    expect(result.stdout).not.toContain("pnpm");
    expect(result.stdout).not.toContain("[test:live]");
  });
});
