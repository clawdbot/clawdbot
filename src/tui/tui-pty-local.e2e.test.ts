// Exercises the slower TUI local-mode PTY smoke path.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startPty, waitFor, type PtyRun } from "./tui-pty-test-support.js";

type MockModelServer = {
  baseUrl: string;
  requests: () => MockModelRequest[];
  stop: () => Promise<void>;
};

type MockModelRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

const activeRuns: PtyRun[] = [];
const LOCAL_STARTUP_TIMEOUT_MS = 20_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 120_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 150_000;

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

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startMockModelServer(replyText: string): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, { data: [{ id: "gpt-5.5", object: "model" }] });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonRequest(req);
        requests.push({ method: req.method, path: url.pathname, body });
        if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
          writeResponsesSse(res, replyText);
          return;
        }
        writeJson(res, 404, { error: "not found" });
        return;
      }
      writeJson(res, 404, { error: "not found" });
    })();
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
      enabled: false,
      slots: {
        memory: "none",
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "tui-pty-mock/gpt-5.5" },
        models: {
          "tui-pty-mock/gpt-5.5": { agentRuntime: { id: "openclaw" } },
        },
        skills: [],
        skipBootstrap: true,
      },
      list: [
        {
          id: "main",
          default: true,
          skills: [],
          model: { primary: "tui-pty-mock/gpt-5.5" },
        },
      ],
    },
    tools: {
      profile: "minimal",
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
  const config = buildLocalModeConfig({ workspaceDir, providerBaseUrl: mockModel.baseUrl });
  const tuiCliModuleUrl = pathToFileURL(path.join(process.cwd(), "src/cli/tui-cli.ts")).href;
  const script = [
    `import { Command } from "commander";`,
    `import { registerTuiCli } from ${JSON.stringify(tuiCliModuleUrl)};`,
    `const program = new Command();`,
    `program.exitOverride();`,
    `registerTuiCli(program);`,
    `program.parseAsync([process.execPath, "openclaw", "tui", "--local"], { from: "node" }).catch((error) => {`,
    `  console.error(error);`,
    `  process.exit(1);`,
    `});`,
  ].join("\n");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
    mkdir(xdgDataHome, { recursive: true }),
    mkdir(xdgCacheHome, { recursive: true }),
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"),
  ]);

  const run = startPty(process.execPath, ["--import", "tsx", "--eval", script], {
    activeRuns,
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
    exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
    outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
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
            new Error(
              `mock model server did not receive a request\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.run.output()}`,
            ),
        });
        const request = fixture.mockModel.requests()[0];
        expect(request?.path).toBe("/v1/responses");
        expect(request?.body.model).toBe("gpt-5.5");
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
