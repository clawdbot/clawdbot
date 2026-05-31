import { spawnPnpmRunner } from "./pnpm-runner.mjs";

export function testLiveUsage() {
  return [
    "Usage: node scripts/test-live.mjs [options] [--] [vitest targets/args...]",
    "",
    "Runs live Vitest suites with OPENCLAW_LIVE_TEST=1.",
    "",
    "Options:",
    "  --codex-harness        Enable the live Codex harness.",
    "  --quiet, --quiet-live  Keep live test output quiet.",
    "  --no-quiet, --no-quiet-live",
    "                         Show live test output.",
    "  -h, --help             Show this help without starting live tests.",
  ].join("\n");
}

export function parseTestLiveArgs(argv) {
  const forwardedArgs = [];
  let quietOverride;
  let forceCodexHarness = false;
  let help = false;
  let passthrough = false;

  for (const arg of argv) {
    if (passthrough) {
      forwardedArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--codex-harness") {
      forceCodexHarness = true;
      continue;
    }
    if (arg === "--quiet" || arg === "--quiet-live") {
      quietOverride = "1";
      continue;
    }
    if (arg === "--no-quiet" || arg === "--no-quiet-live") {
      quietOverride = "0";
      continue;
    }
    forwardedArgs.push(arg);
  }
  return {
    forceCodexHarness,
    forwardedArgs,
    help,
    quietOverride,
  };
}

export function buildTestLiveEnv(args, baseEnv = process.env) {
  return {
    ...baseEnv,
    CI: baseEnv.CI || "1",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: baseEnv.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN || "false",
    pnpm_config_verify_deps_before_run: baseEnv.pnpm_config_verify_deps_before_run || "false",
    OPENCLAW_LIVE_TEST: baseEnv.OPENCLAW_LIVE_TEST || "1",
    OPENCLAW_LIVE_TEST_QUIET: args.quietOverride ?? baseEnv.OPENCLAW_LIVE_TEST_QUIET ?? "1",
    ...(args.forceCodexHarness ? { OPENCLAW_LIVE_CODEX_HARNESS: "1" } : {}),
  };
}

export function resolveTestLiveHeartbeatMs(baseEnv = process.env) {
  const value = baseEnv.OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS;
  if (value === undefined || value === "") {
    return 20_000;
  }
  const text = value.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: ${text}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: ${text}`);
  }
  return parsed;
}

export function buildTestLivePnpmArgs(args) {
  return [
    "exec",
    "vitest",
    "run",
    "--config",
    "test/vitest/vitest.live.config.ts",
    ...args.forwardedArgs,
  ];
}

export function main(argv = process.argv.slice(2), baseEnv = process.env) {
  const args = parseTestLiveArgs(argv);
  if (args.help) {
    console.log(testLiveUsage());
    process.exit(0);
  }

  const env = buildTestLiveEnv(args, baseEnv);
  const heartbeatMs = resolveTestLiveHeartbeatMs(baseEnv);
  const startedAt = Date.now();
  let lastOutputAt = startedAt;

  const child = spawnPnpmRunner({
    stdio: ["inherit", "pipe", "pipe"],
    pnpmArgs: buildTestLivePnpmArgs(args),
    env,
  });

  const noteOutput = () => {
    lastOutputAt = Date.now();
  };

  child.stdout?.on("data", (chunk) => {
    noteOutput();
    process.stdout.write(chunk);
  });

  child.stderr?.on("data", (chunk) => {
    noteOutput();
    process.stderr.write(chunk);
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (now - lastOutputAt < heartbeatMs) {
      return;
    }
    const elapsedSec = Math.max(1, Math.round((now - startedAt) / 1_000));
    const quietSec = Math.max(1, Math.round((now - lastOutputAt) / 1_000));
    process.stderr.write(
      `[test:live] still running (${elapsedSec}s elapsed, ${quietSec}s since last output)\n`,
    );
    lastOutputAt = now;
  }, heartbeatMs);
  heartbeat.unref?.();

  child.on("exit", (code, signal) => {
    clearInterval(heartbeat);
    if (signal) {
      process.stderr.write(`[test:live] vitest exited via signal=${signal}\n`);
      process.kill(process.pid, signal);
      return;
    }
    if ((code ?? 1) !== 0) {
      process.stderr.write(`[test:live] vitest exited code=${code ?? 1}\n`);
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    clearInterval(heartbeat);
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
