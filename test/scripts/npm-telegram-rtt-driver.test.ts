import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const DRIVER_SCRIPT = "scripts/e2e/npm-telegram-rtt-driver.mjs";

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

describe("npm Telegram RTT driver", () => {
  it("bounds stalled Telegram Bot API response bodies", async () => {
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

      expect(result.error).toBeUndefined();
      expect(result.signal).not.toBe("SIGKILL");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/abort|timed out|terminated/iu);
      expect(Date.now() - startedAt).toBeLessThan(2500);
    } finally {
      await stopChild(server);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
