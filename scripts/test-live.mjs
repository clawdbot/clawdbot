import { spawnPnpmRunner } from "./pnpm-runner.mjs";

const forwardedArgs = [];
let quietOverride;

for (const arg of process.argv.slice(2)) {
  if (arg === "--") {
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

const env = {
  ...process.env,
  OPENCLAW_LIVE_TEST: process.env.OPENCLAW_LIVE_TEST || "1",
  OPENCLAW_LIVE_TEST_QUIET: quietOverride ?? process.env.OPENCLAW_LIVE_TEST_QUIET ?? "1",
};

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const heartbeatMs = parsePositiveInt(process.env.OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS, 20_000);
const startedAt = Date.now();
let lastOutputAt = startedAt;

const child = spawnPnpmRunner({
  stdio: ["inherit", "pipe", "pipe"],
  pnpmArgs: [
    "exec",
    "vitest",
    "run",
    "--config",
    "test/vitest/vitest.live.config.ts",
    ...forwardedArgs,
  ],
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
