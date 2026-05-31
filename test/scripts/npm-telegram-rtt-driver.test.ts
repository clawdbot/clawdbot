import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

const DRIVER_SCRIPT = "scripts/e2e/npm-telegram-rtt-driver.mjs";

function runDriver(env: Record<string, string>) {
  return spawnSync(process.execPath, [DRIVER_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_QA_TELEGRAM_API_BASE_URL: "http://127.0.0.1:9",
      OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
      OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
      OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
      ...env,
    },
  });
}

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf8");
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const startedAt = Date.now();
  while (child.exitCode === null && Date.now() - startedAt < 1000) {
    await delay(25);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function startStalledJsonServer(portPath: string) {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import net from "node:net";',
        'import fs from "node:fs";',
        'const server = net.createServer((socket) => socket.write("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n"));',
        'server.listen(0, "127.0.0.1", () => {',
        "  const address = server.address();",
        "  fs.writeFileSync(process.env.PORT_FILE, String(address.port));",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    {
      env: { ...process.env, PORT_FILE: portPath },
      stdio: "pipe",
    },
  );
}

function startOversizedJsonServer(portPath: string) {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import net from "node:net";',
        'import fs from "node:fs";',
        "const server = net.createServer((socket) => {",
        '  const body = JSON.stringify({ ok: true, result: { id: 1, username: "sut" }, padding: "x".repeat(128) });',
        "  socket.end(`HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
        "});",
        'server.listen(0, "127.0.0.1", () => {',
        "  const address = server.address();",
        "  fs.writeFileSync(process.env.PORT_FILE, String(address.port));",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    {
      env: { ...process.env, PORT_FILE: portPath },
      stdio: "pipe",
    },
  );
}

type DriverCaseResult = {
  result: ReturnType<typeof spawnSync>;
  elapsedMs?: number;
};

async function runStalledTelegramBodyCase(): Promise<DriverCaseResult> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-rtt-driver-"));
  const portPath = path.join(root, "port.txt");
  const outputDir = path.join(root, "out");
  const server = startStalledJsonServer(portPath);

  try {
    const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [DRIVER_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_NPM_TELEGRAM_BOT_API_TIMEOUT_MS: "100",
        OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: outputDir,
        OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES: "1",
        OPENCLAW_QA_TELEGRAM_API_BASE_URL: `http://127.0.0.1:${port}`,
        OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: "1000",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: "1000",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
      },
      killSignal: "SIGKILL",
      timeout: 2500,
    });
    return { result, elapsedMs: Date.now() - startedAt };
  } finally {
    await stopChild(server);
    rmSync(root, { force: true, recursive: true });
  }
}

async function runOversizedTelegramBodyCase(): Promise<DriverCaseResult> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-rtt-driver-"));
  const portPath = path.join(root, "port.txt");
  const outputDir = path.join(root, "out");
  const server = startOversizedJsonServer(portPath);

  try {
    const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
    const result = spawnSync(process.execPath, [DRIVER_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_NPM_TELEGRAM_BOT_API_BODY_MAX_BYTES: "16",
        OPENCLAW_NPM_TELEGRAM_BOT_API_TIMEOUT_MS: "1000",
        OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: outputDir,
        OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES: "1",
        OPENCLAW_QA_TELEGRAM_API_BASE_URL: `http://127.0.0.1:${port}`,
        OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: "1000",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: "1000",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
      },
      killSignal: "SIGKILL",
      timeout: 2500,
    });
    return { result };
  } finally {
    await stopChild(server);
    rmSync(root, { force: true, recursive: true });
  }
}

describe("npm Telegram RTT driver", () => {
  let stalledBodyCase: DriverCaseResult;
  let oversizedBodyCase: DriverCaseResult;

  beforeAll(async () => {
    [stalledBodyCase, oversizedBodyCase] = await Promise.all([
      runStalledTelegramBodyCase(),
      runOversizedTelegramBodyCase(),
    ]);
  });

  it("rejects loose numeric env values instead of parsing prefixes", () => {
    for (const [name, value] of [
      ["OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS", "180000ms"],
      ["OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS", "1e3"],
      ["OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES", "20samples"],
      ["OPENCLAW_NPM_TELEGRAM_SAMPLE_TIMEOUT_MS", "30000ms"],
      ["OPENCLAW_NPM_TELEGRAM_BOT_API_TIMEOUT_MS", "100ms"],
      ["OPENCLAW_NPM_TELEGRAM_BOT_API_BODY_MAX_BYTES", "1mb"],
      ["OPENCLAW_NPM_TELEGRAM_MAX_FAILURES", "2failures"],
    ]) {
      const result = runDriver({ [name]: value });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`invalid ${name}: ${value}`);
    }
  });

  it("rejects zero where positive numeric env values are required", () => {
    const result = runDriver({ OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES: "0" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES: 0");
  });

  it("bounds stalled Telegram Bot API response bodies", async () => {
    const { result, elapsedMs } = stalledBodyCase;

    expect(result.error).toBeUndefined();
    expect(result.signal).not.toBe("SIGKILL");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/abort|timed out|terminated/iu);
    expect(elapsedMs).toBeLessThan(2500);
  });

  it("bounds oversized Telegram Bot API response bodies", async () => {
    const { result } = oversizedBodyCase;

    expect(result.error).toBeUndefined();
    expect(result.signal).not.toBe("SIGKILL");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Telegram Bot API getMe response body exceeded 16 bytes");
    expect(result.stderr).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });
});
