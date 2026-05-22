import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as spawnPty, type PtyExitEvent, type PtyHandle } from "@lydell/node-pty";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type KillablePtyHandle = PtyHandle & {
  kill?: (signal?: string) => void;
};

type PtyRun = {
  output: () => string;
  write: (data: string, opts?: { delay?: boolean }) => Promise<void>;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<string>;
  waitForExit: (timeoutMs?: number) => Promise<PtyExitEvent>;
  dispose: () => void;
};

type MockModelServer = {
  baseUrl: string;
  requests: () => Array<Record<string, unknown>>;
  stop: () => Promise<void>;
};

const activeRuns: PtyRun[] = [];
const LOCAL_STARTUP_TIMEOUT_MS = 20_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 35_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 60_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveIntegerEnv(name: string): number | null {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readPtyDimensionEnv(name: string, fallback: number): number {
  return readPositiveIntegerEnv(name) ?? fallback;
}

async function writePtyInput(
  pty: PtyHandle,
  data: string,
  opts: { delay?: boolean } = {},
): Promise<void> {
  const delayMs = readPositiveIntegerEnv("OPENCLAW_TUI_PTY_TYPE_DELAY_MS");
  if (!delayMs || opts.delay === false) {
    pty.write(data);
    return;
  }
  const chunkSize = readPositiveIntegerEnv("OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE") ?? 1;
  for (let idx = 0; idx < data.length; idx += chunkSize) {
    pty.write(data.slice(idx, idx + chunkSize));
    if (idx + chunkSize < data.length) {
      await sleep(delayMs);
    }
  }
}

function waitFor<T>(params: {
  timeoutMs: number;
  read: () => T | null;
  onTimeout: () => Error;
}): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let result: T | null;
      try {
        result = params.read();
      } catch (error) {
        reject(error);
        return;
      }
      if (result !== null) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= params.timeoutMs) {
        reject(params.onTimeout());
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function mirrorPtyOutput(data: string) {
  const mirrorPath = process.env.OPENCLAW_TUI_PTY_MIRROR_PATH;
  if (!mirrorPath) {
    return;
  }
  appendFileSync(mirrorPath, data, "utf8");
}

function startPty(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  let output = "";
  let exitEvent: PtyExitEvent | null = null;
  const pty = spawnPty(command, args, {
    name: "xterm-256color",
    cols: readPtyDimensionEnv("OPENCLAW_TUI_PTY_COLS", 100),
    rows: readPtyDimensionEnv("OPENCLAW_TUI_PTY_ROWS", 30),
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
      TERM: "xterm-256color",
    } as Record<string, string>,
  }) as KillablePtyHandle;

  pty.onData((data) => {
    output += data;
    mirrorPtyOutput(data);
  });
  pty.onExit((event) => {
    exitEvent = event;
  });

  const run: PtyRun = {
    output: () => output,
    write: async (data, writeOpts) => await writePtyInput(pty, data, writeOpts),
    waitForOutput: async (needle, timeoutMs = LOCAL_OUTPUT_TIMEOUT_MS) =>
      await waitFor({
        timeoutMs,
        read: () => {
          if (output.includes(needle)) {
            return output;
          }
          if (exitEvent) {
            throw new Error(
              `PTY exited before ${JSON.stringify(needle)}\nexit=${JSON.stringify(exitEvent)}\n${output}`,
            );
          }
          return null;
        },
        onTimeout: () => new Error(`timed out waiting for ${JSON.stringify(needle)}\n${output}`),
      }),
    waitForExit: async (timeoutMs = LOCAL_EXIT_TIMEOUT_MS) =>
      await waitFor({
        timeoutMs,
        read: () => exitEvent,
        onTimeout: () => new Error(`timed out waiting for PTY exit\n${output}`),
      }),
    dispose: () => {
      if (!exitEvent) {
        pty.kill?.("SIGTERM");
      }
    },
  };
  activeRuns.push(run);
  return run;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function writeResponsesSse(res: ServerResponse, text: string) {
  const id = "msg_tui_pty_local";
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "message", id, role: "assistant", content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_tui_pty_local",
        status: "completed",
        output: [
          {
            type: "message",
            id,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function startMockModelServer(replyText: string): Promise<MockModelServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      writeJson(res, 200, { data: [{ id: "gpt-5.5", object: "model" }] });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const raw = await readRequestBody(req);
      requests.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      writeResponsesSse(res, replyText);
      return;
    }
    writeJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function buildLocalModeConfig(params: { workspaceDir: string; providerBaseUrl: string }) {
  return {
    plugins: {
      allow: [],
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "tui-pty-mock/gpt-5.5" },
      },
      list: [
        {
          id: "main",
          default: true,
          model: { primary: "tui-pty-mock/gpt-5.5" },
        },
      ],
    },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": {
          baseUrl: `${params.providerBaseUrl}/v1`,
          apiKey: "test",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "tui-pty-local" },
    },
    discovery: { mdns: { mode: "off" } },
  } satisfies OpenClawConfig;
}

async function startLocalModeTui() {
  const replyText = "LOCAL_PTY_RESPONSE";
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-local-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const homeDir = path.join(tempDir, "home");
  const stateDir = path.join(tempDir, "state");
  const xdgConfigHome = path.join(tempDir, "xdg-config");
  const xdgDataHome = path.join(tempDir, "xdg-data");
  const xdgCacheHome = path.join(tempDir, "xdg-cache");
  const configPath = path.join(tempDir, "openclaw.json");
  const mockModel = await startMockModelServer(replyText);
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
    mkdir(xdgDataHome, { recursive: true }),
    mkdir(xdgCacheHome, { recursive: true }),
    writeFile(
      configPath,
      `${JSON.stringify(buildLocalModeConfig({ workspaceDir, providerBaseUrl: mockModel.baseUrl }), null, 2)}\n`,
      "utf8",
    ),
  ]);

  const run = startPty(process.execPath, ["scripts/run-node.mjs", "tui", "--local"], {
    cwd: process.cwd(),
    env: {
      HOME: homeDir,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      OPENCLAW_THEME: "dark",
      OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
      NO_COLOR: undefined,
    },
  });

  return {
    run,
    mockModel,
    cleanup: async () => {
      run.dispose();
      await mockModel.stop();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe("TUI PTY local mode", () => {
  afterEach(async () => {
    for (const run of activeRuns.splice(0)) {
      run.dispose();
    }
  });

  it(
    "drives the real local backend with a mocked model endpoint",
    async () => {
      const fixture = await startLocalModeTui();
      try {
        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("send the local PTY smoke response\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length > 0 ? true : null),
          onTimeout: () =>
            new Error(`mock model server did not receive a request\n${fixture.run.output()}`),
        });
        expect(fixture.mockModel.requests()[0]?.model).toBe("gpt-5.5");
        await fixture.run.waitForOutput("LOCAL_PTY_RESPONSE");

        await fixture.run.write("/exit\r", { delay: false });
        const exit = await fixture.run.waitForExit();
        expect(exit.exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );
});
