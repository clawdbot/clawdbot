// Assertions for Bun global install E2E validation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../fixtures/mock-openai-config.mjs";

const DEFAULT_TIMEOUT_KILL_GRACE_MS = 30_000;
const PARENT_TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

const usage = () => {
  console.error(
    "Usage: assertions.mjs <run-with-timeout|assert-bun-version|assert-image-providers|assert-openclaw-trusted|assert-release-versions|configure-runtime|assert-agent-turn> [...]",
  );
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

const processGroupAlive = (child) => {
  if (process.platform === "win32" || !child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const waitForProcessGroupExit = async (child, timeout) => {
  const deadlineAt = Date.now() + timeout;
  while (Date.now() < deadlineAt) {
    if (!processGroupAlive(child)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !processGroupAlive(child);
};

const resolveSignalExitCode = (signal) => {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGHUP":
      return 129;
    default:
      return 143;
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
  let parentSignal = null;
  let killTimer;
  let killDeadlineAt = 0;
  let forceKillIssued = false;
  const forceKill = () => {
    // The timer and post-close drain can race while a killed group is exiting.
    // Share the successful signal so neither path tries to kill it twice.
    if (!forceKillIssued) {
      signalChild(child, "SIGKILL");
      forceKillIssued = true;
    }
  };
  const scheduleForceKill = () => {
    killDeadlineAt = Date.now() + killGrace;
    killTimer ??= setTimeout(forceKill, killGrace);
    killTimer.unref();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalChild(child, "SIGTERM");
    scheduleForceKill();
  }, timeout);
  timeoutTimer.unref();

  const parentSignalHandlers = new Map(
    PARENT_TERMINATION_SIGNALS.map((signal) => [
      signal,
      () => {
        parentSignal ??= signal;
        signalChild(child, signal);
        scheduleForceKill();
      },
    ]),
  );
  for (const [signal, handler] of parentSignalHandlers) {
    process.on(signal, handler);
  }
  const cleanupParentSignalHandlers = () => {
    for (const [signal, handler] of parentSignalHandlers) {
      process.off(signal, handler);
    }
  };

  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const result = await new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ error: spawnError, signal, status }));
  });

  clearTimeout(timeoutTimer);
  cleanupParentSignalHandlers();
  if (timedOut || parentSignal) {
    const remainingGraceMs = Math.max(0, killDeadlineAt - Date.now());
    if (remainingGraceMs > 0) {
      await waitForProcessGroupExit(child, remainingGraceMs);
    }
    if (processGroupAlive(child)) {
      forceKill();
      if (!(await waitForProcessGroupExit(child, 100))) {
        throw new Error(`command process group remained active after SIGKILL: ${command}`);
      }
    }
    clearTimeout(killTimer);
  }
  if (parentSignal) {
    process.exit(resolveSignalExitCode(parentSignal));
  }
  if (timedOut) {
    console.error(`command timed out after ${timeout}ms: ${command}`);
    process.exit(1);
  }
  clearTimeout(killTimer);
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

if (mode === "assert-bun-version") {
  const [version] = args;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version ?? "");
  if (!match) {
    throw new Error(`invalid Bun version: ${version ?? "<missing>"}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 1 || (major === 1 && minor < 4)) {
    throw new Error(`Bun 1.4 or newer is required; found ${version}`);
  }
  process.exit(0);
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

if (mode === "assert-release-versions") {
  const [rootManifestPath, aiManifestPath] = args;
  if (!rootManifestPath || !aiManifestPath) {
    usage();
  }
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, "utf8"));
  const aiManifest = JSON.parse(fs.readFileSync(aiManifestPath, "utf8"));
  const rootVersion = rootManifest.version;
  const aiVersion = aiManifest.version;
  const rootAiVersion = rootManifest.dependencies?.["@openclaw/ai"];
  if (
    typeof rootVersion !== "string" ||
    typeof aiVersion !== "string" ||
    rootVersion !== aiVersion ||
    rootAiVersion !== aiVersion
  ) {
    throw new Error(
      `candidate version mismatch: openclaw=${String(rootVersion)}, dependency=${String(rootAiVersion)}, @openclaw/ai=${String(aiVersion)}`,
    );
  }
  process.stdout.write(aiVersion);
  process.exit(0);
}

if (mode === "assert-openclaw-trusted") {
  const [packageRoot, globalManifestPath, untrustedOutputPath] = args;
  if (!packageRoot || !globalManifestPath || !untrustedOutputPath) {
    usage();
  }
  const globalManifest = JSON.parse(fs.readFileSync(globalManifestPath, "utf8"));
  if (!globalManifest.trustedDependencies?.includes?.("openclaw")) {
    throw new Error("Bun global manifest does not trust OpenClaw lifecycle scripts");
  }
  const untrustedOutput = fs.readFileSync(untrustedOutputPath, "utf8");
  if (/(?:^|\s)(?:\.?[\\/])?node_modules[\\/]openclaw(?:\s|@|$)/imu.test(untrustedOutput)) {
    throw new Error(`OpenClaw lifecycle scripts remain blocked by Bun:\n${untrustedOutput}`);
  }
  const installGuardPath = path.join(packageRoot, "dist", "openclaw-install-guard");
  if (fs.existsSync(installGuardPath)) {
    throw new Error(`OpenClaw preinstall lifecycle did not remove ${installGuardPath}`);
  }
  process.exit(0);
}

if (mode === "configure-runtime") {
  const [configPath, mockPortValue, gatewayPortValue] = args;
  if (!configPath || !mockPortValue || !gatewayPortValue) {
    usage();
  }
  const mockPort = parseMockOpenAiPort(mockPortValue);
  const gatewayPort = parseMockOpenAiPort(gatewayPortValue, "Gateway port");
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token" },
    },
  };
  applyMockOpenAiModelConfig(config, { mockPort });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}

if (mode === "assert-agent-turn") {
  const [marker, outputPath, requestLogPath] = args;
  if (!marker || !outputPath || !requestLogPath) {
    usage();
  }
  assertAgentReplyContainsMarker(marker, outputPath);
  assertOpenAiRequestLogUsed(requestLogPath);
  process.exit(0);
}

usage();
