// Npm Telegram Rtt Driver tests cover npm telegram rtt driver script behavior.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";

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

type AsyncDriverResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type TelegramUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: { id: number };
    from: { id: number; username: string };
    reply_to_message?: { message_id: number };
    text: string;
  };
};

function runDriverAsync(env: Record<string, string>, timeoutMs = 5000): Promise<AsyncDriverResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER_SCRIPT], {
      env: {
        ...process.env,
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
        ...env,
      },
      stdio: "pipe",
    });
    const stdout = createBoundedChildOutput();
    const stderr = createBoundedChildOutput();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve({
        status: null,
        signal: "SIGKILL",
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut: true,
      });
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut: false });
    });
  });
}

function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeTelegramJson(res: ServerResponse, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(200, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startTelegramApiServer(options: {
  canaryReplyToRequest: boolean;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const pendingUpdates: TelegramUpdate[] = [];
  let nextMessageId = 100;
  let nextUpdateId = 1;
  const chatId = -100123;
  const nowUnixSeconds = () => Math.floor(Date.now() / 1000);
  const pushSutUpdate = (params: { replyToMessageId?: number; text: string }) => {
    pendingUpdates.push({
      update_id: nextUpdateId++,
      message: {
        message_id: nextMessageId++,
        date: nowUnixSeconds(),
        chat: { id: chatId },
        from: { id: 222, username: "sut_bot" },
        ...(params.replyToMessageId === undefined
          ? {}
          : { reply_to_message: { message_id: params.replyToMessageId } }),
        text: params.text,
      },
    });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const match = req.url?.match(/^\/bot([^/]+)\/([^/?]+)/u);
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const [, token, method] = match;
      const body = await readRequestJson(req);

      if (method === "getMe") {
        writeTelegramJson(res, {
          ok: true,
          result:
            token === "sut-token"
              ? { id: 222, username: "sut_bot" }
              : { id: 111, username: "driver_bot" },
        });
        return;
      }

      if (method === "sendMessage") {
        const messageId = nextMessageId++;
        const text = String(body.text ?? "");
        if (token === "driver-token" && text.startsWith("/status@")) {
          pushSutUpdate({
            replyToMessageId: options.canaryReplyToRequest ? messageId : undefined,
            text: "status ok",
          });
        } else if (token === "driver-token" && text.includes("Reply with exactly ")) {
          const marker = text.match(/Reply with exactly ([^.]+)\./u)?.[1] ?? "OPENCLAW_E2E_OK_1";
          pushSutUpdate({ replyToMessageId: messageId, text: marker });
        }
        writeTelegramJson(res, {
          ok: true,
          result: {
            message_id: messageId,
            date: nowUnixSeconds(),
            chat: { id: chatId },
            text,
          },
        });
        return;
      }

      if (method === "getUpdates") {
        const offset = typeof body.offset === "number" ? body.offset : 0;
        const updates = pendingUpdates.filter((update) => update.update_id >= offset);
        if (updates.length === 0) {
          await delay(25);
        }
        writeTelegramJson(res, { ok: true, result: updates });
        return;
      }

      writeTelegramJson(res, { ok: false, description: `unexpected method ${method}` });
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake Telegram server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

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

  it("rejects empty scenario selections before live Telegram calls", () => {
    const result = runDriver({ OPENCLAW_NPM_TELEGRAM_SCENARIOS: "," });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_NPM_TELEGRAM_SCENARIOS must include at least one RTT scenario",
    );
  });

  it("rejects unknown scenario selections before live Telegram calls", () => {
    const result = runDriver({ OPENCLAW_NPM_TELEGRAM_SCENARIOS: "does-not-exist" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown OPENCLAW_NPM_TELEGRAM_SCENARIOS: does-not-exist");
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

  it("rejects unrelated SUT messages during the Telegram canary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-rtt-causal-"));
    const server = await startTelegramApiServer({ canaryReplyToRequest: false });

    try {
      const outputDir = path.join(root, "out");
      const result = await runDriverAsync({
        OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: outputDir,
        OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES: "1",
        OPENCLAW_QA_TELEGRAM_API_BASE_URL: server.baseUrl,
        OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: "250",
        OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: "250",
      });
      const summary = JSON.parse(
        readFileSync(path.join(outputDir, "telegram-qa-summary.json"), "utf8"),
      ) as {
        scenarios: Array<{ id: string; status: string; details?: string }>;
        status: string;
      };
      const canary = summary.scenarios.find((scenario) => scenario.id === "telegram-canary");

      expect(result.timedOut).toBe(false);
      expect(result.status).not.toBe(0);
      expect(summary.status).toBe("fail");
      expect(canary).toMatchObject({
        id: "telegram-canary",
        status: "fail",
      });
      expect(canary?.details).toContain("timed out");
    } finally {
      await server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts reply-threaded SUT messages during the Telegram canary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-rtt-causal-"));
    const server = await startTelegramApiServer({ canaryReplyToRequest: true });

    try {
      const outputDir = path.join(root, "out");
      const result = await runDriverAsync({
        OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: outputDir,
        OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES: "1",
        OPENCLAW_QA_TELEGRAM_API_BASE_URL: server.baseUrl,
        OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: "1000",
        OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: "1000",
      });
      const summary = JSON.parse(
        readFileSync(path.join(outputDir, "telegram-qa-summary.json"), "utf8"),
      ) as {
        scenarios: Array<{ id: string; status: string }>;
        status: string;
      };

      expect(result).toMatchObject({
        signal: null,
        status: 0,
        timedOut: false,
      });
      expect(summary.status).toBe("pass");
      expect(summary.scenarios).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "telegram-canary", status: "pass" }),
          expect.objectContaining({ id: "telegram-mentioned-message-reply", status: "pass" }),
        ]),
      );
    } finally {
      await server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
