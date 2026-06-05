// Assertions for Bun global install E2E validation.
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_KILL_GRACE_MS = 30_000;

const usage = () => {
  console.error("Usage: assertions.mjs <run-with-timeout|assert-image-providers> [...]");
  process.exit(2);
};

const [mode, ...args] = process.argv.slice(2);

const parsePositiveNumber = (value, label) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
};

const signalChild = (child, signal) => {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
};

const runWithTimeout = async (timeout, command, commandArgs) => {
  const killGrace = parsePositiveNumber(
    process.env.OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS ??
      String(DEFAULT_TIMEOUT_KILL_GRACE_MS),
    "OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS",
  );
  const child = spawn(command, commandArgs, {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let killTimer;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalChild(child, "SIGTERM");
    killTimer = setTimeout(() => signalChild(child, "SIGKILL"), killGrace);
    killTimer.unref();
  }, timeout);
  timeoutTimer.unref();

  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const result = await new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ error: spawnError, signal, status }));
  });

  clearTimeout(timeoutTimer);
  clearTimeout(killTimer);
  if (timedOut) {
    console.error(`command timed out after ${timeout}ms: ${command}`);
    process.exit(1);
  }
  if (result.error) {
    console.error(`command failed: ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`command terminated: ${command}: ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
};

if (mode === "run-with-timeout") {
  const [timeoutMs, command, ...commandArgs] = args;
  if (!command) {
    usage();
  }
  let timeout;
  try {
    timeout = parsePositiveNumber(timeoutMs, "timeoutMs");
  } catch {
    usage();
  }
  await runWithTimeout(timeout, command, commandArgs);
}

if (mode === "assert-image-providers") {
  const raw = process.env.OPENCLAW_IMAGE_PROVIDERS_JSON ?? "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(raw);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`image providers output is not JSON: ${message}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("image providers output must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("image providers output is empty");
  }
  const ids = new Set(parsed.map((entry) => (typeof entry?.id === "string" ? entry.id : "")));
  for (const expected of ["google", "openai", "xai"]) {
    if (!ids.has(expected)) {
      throw new Error(`image providers output is missing bundled provider '${expected}'`);
    }
  }
  console.log(`bun-global-install-smoke: image providers OK (${parsed.length} providers)`);
  process.exit(0);
}

usage();
