// Exercises slower TUI PTY paths against real local and Gateway backends.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { sleep, startPty, waitFor, type PtyRun } from "./tui-pty-test-support.js";

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

const LOCAL_STARTUP_TIMEOUT_MS = 60_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 300_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 360_000;

function createIdempotentCleanup(cleanup: () => Promise<void>) {
  let cleanupPromise: Promise<void> | undefined;
  return () => (cleanupPromise ??= cleanup());
}

type CleanupRegistrar = (cleanup: () => Promise<void>) => void;

async function waitForOutputAfter(run: PtyRun, needle: string, offset: number) {
  await waitFor({
    timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    read: () => (run.output().slice(offset).includes(needle) ? true : null),
    onTimeout: () =>
      new Error(
        `timed out waiting for ${JSON.stringify(needle)} after offset ${offset}\n${run.output()}`,
      ),
  });
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

async function writeResponsesSse(res: ServerResponse, text: string, completionDelayMs = 0) {
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
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(events[0])}\n\n`);
  if (completionDelayMs > 0) {
    await sleep(completionDelayMs);
  }
  if (res.destroyed) {
    return;
  }
  const completionBody = `${events
    .slice(1)
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  res.end(completionBody);
}

function writeInvalidEditCallSse(res: ServerResponse, requestIndex: number) {
  const item = {
    type: "function_call",
    id: `fc_tui_validation_${requestIndex}`,
    call_id: `call_tui_validation_${requestIndex}`,
    name: "edit",
    arguments: "{}",
    status: "completed",
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_tui_validation_${requestIndex}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startMockModelServer(
  replyText: string,
  opts: {
    firstResponseDelayMs?: number;
    followupReplyText?: string;
    invalidEditLoop?: boolean;
  } = {},
): Promise<MockModelServer> {
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
        const requestIndex = requests.length;
        requests.push({ method: req.method, path: url.pathname, body });
        if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
          if (opts.invalidEditLoop) {
            writeInvalidEditCallSse(res, requestIndex);
            return;
          }
          await writeResponsesSse(
            res,
            requestIndex === 0 ? replyText : (opts.followupReplyText ?? replyText),
            requestIndex === 0 ? (opts.firstResponseDelayMs ?? 0) : 0,
          );
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
        // Aborted local runs can leave a provider keep-alive open. Force-close
        // test-owned connections so cleanup does not wait for idle expiry.
        server.closeAllConnections();
      });
    },
  };
}

function buildTuiCliScript(args: string[]) {
  const tuiCliModuleUrl = pathToFileURL(path.join(process.cwd(), "src/cli/tui-cli.ts")).href;
  return [
    `import { Command } from "commander";`,
    `import { registerTuiCli } from ${JSON.stringify(tuiCliModuleUrl)};`,
    `const program = new Command();`,
    `program.exitOverride();`,
    `registerTuiCli(program);`,
    `program.parseAsync([process.execPath, "openclaw", ...${JSON.stringify(args)}], { from: "node" }).catch((error) => {`,
    `  console.error(error);`,
    `  process.exit(1);`,
    `});`,
  ].join("\n");
}

function buildLocalModeConfig(params: {
  workspaceDir: string;
  providerBaseUrl: string;
  toolsProfile?: "minimal" | "coding";
}) {
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
      profile: params.toolsProfile ?? "minimal",
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

async function startLocalModeTui(
  registerCleanup: CleanupRegistrar,
  opts: { invalidEditLoop?: boolean } = {},
) {
  const replyText = "LOCAL_PTY_RESPONSE";
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-local-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const homeDir = path.join(tempDir, "home");
  const stateDir = path.join(tempDir, "state");
  const xdgConfigHome = path.join(tempDir, "xdg-config");
  const xdgDataHome = path.join(tempDir, "xdg-data");
  const xdgCacheHome = path.join(tempDir, "xdg-cache");
  const configPath = path.join(tempDir, "openclaw.json");
  const mockModel = await startMockModelServer(replyText, {
    invalidEditLoop: opts.invalidEditLoop,
  });
  const config = buildLocalModeConfig({
    workspaceDir,
    providerBaseUrl: mockModel.baseUrl,
    toolsProfile: opts.invalidEditLoop ? "coding" : "minimal",
  });
  const script = buildTuiCliScript(["tui", "--local"]);
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

  const cleanup = createIdempotentCleanup(async () => {
    run.dispose();
    await mockModel.stop();
    await rm(tempDir, { recursive: true, force: true });
  });
  registerCleanup(cleanup);
  return {
    kind: "local" as const,
    run,
    mockModel,
    cleanup,
  };
}

async function startGatewayModeTui(
  params: {
    queueMode: "followup" | "collect";
    firstReplyText?: string;
    firstResponseDelayMs?: number;
    queueDebounceMs?: number;
    invalidEditLoop?: boolean;
  },
  registerCleanup: CleanupRegistrar,
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-gateway-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const mockModel = await startMockModelServer(params.firstReplyText ?? "FIRST_RUN_ACTIVE", {
    firstResponseDelayMs: params.firstResponseDelayMs ?? 1_500,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
    invalidEditLoop: params.invalidEditLoop,
  });
  const config = {
    ...buildLocalModeConfig({
      workspaceDir,
      providerBaseUrl: mockModel.baseUrl,
      toolsProfile: params.invalidEditLoop ? "coding" : "minimal",
    }),
    messages: {
      queue: {
        mode: params.queueMode,
        debounceMs: params.queueDebounceMs ?? 25,
      },
    },
  } satisfies OpenClawConfig;
  const gateway = await createOpenClawTestInstance({
    name: `tui-pty-gateway-${params.queueMode}`,
    gatewayToken: "tui-pty-local",
    config,
    env: {
      OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
  });
  try {
    await mkdir(workspaceDir, { recursive: true });
    await gateway.startGateway();
    const script = buildTuiCliScript([
      "tui",
      "--url",
      gateway.url,
      "--token",
      gateway.gatewayToken,
      "--session",
      "agent:main:main",
    ]);
    const run = startPty(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...gateway.env,
        OPENCLAW_THEME: "dark",
        NO_COLOR: undefined,
      },
      exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
      outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    });
    const cleanup = createIdempotentCleanup(async () => {
      run.dispose();
      await gateway.cleanup();
      await mockModel.stop();
      await rm(tempDir, { recursive: true, force: true });
    });
    registerCleanup(cleanup);
    return {
      kind: "gateway" as const,
      run,
      gateway,
      mockModel,
      cleanup,
    };
  } catch (error) {
    await gateway.cleanup();
    await mockModel.stop();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

// Each case spawns a real Gateway/PTY stack. Keep them serial so constrained
// release runners do not turn host contention into test-level timeouts.
describe("TUI PTY real backends", () => {
  it(
    "drives the real local backend with a mocked model endpoint",
    async ({ onTestFinished }) => {
      const fixture = await startLocalModeTui(onTestFinished);
      try {
        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        for (const command of ["/status", "/compact", "/commands", "/context"]) {
          await fixture.run.write(`${command}\r`);
          await fixture.run.waitForOutput(
            `${command} is not available in local embedded mode; message not sent`,
          );
        }
        await fixture.run.write("/side\r");
        await fixture.run.waitForOutput("Usage: /btw [side question]");
        expect(fixture.mockModel.requests()).toHaveLength(0);

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

        // Text deltas arrive before the terminal lifecycle event. Wait for the
        // finished run to become idle so /new exercises session creation.
        const responseOffset = fixture.run.output().lastIndexOf("LOCAL_PTY_RESPONSE");
        await waitForOutputAfter(fixture.run, "| idle", responseOffset);

        await fixture.run.write("/new\r", { delay: false });
        await fixture.run.waitForOutput("new session: agent:main:tui-");
        await fixture.run.write("send after local new\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(`post-/new prompt did not reach the model\n${fixture.run.output()}`),
        });
        expect(JSON.stringify(fixture.mockModel.requests()[1]?.body)).toContain(
          "send after local new",
        );

        await fixture.run.write("/exit\r", { delay: false });
        const exit = await fixture.run.waitForExit();
        expect(exit.exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  for (const mode of ["gateway", "local"] as const) {
    it(
      `renders safe validation-loop abort diagnostics through the real ${mode} backend`,
      async ({ onTestFinished }) => {
        const fixture =
          mode === "gateway"
            ? await startGatewayModeTui(
                {
                  queueMode: "followup",
                  invalidEditLoop: true,
                },
                onTestFinished,
              )
            : await startLocalModeTui(onTestFinished, { invalidEditLoop: true });
        let eventProbe: GatewayChatClient | undefined;
        const probedEvents: Array<{ event: string; payload: unknown }> = [];
        try {
          if (fixture.kind === "gateway") {
            let probeConnected = false;
            eventProbe = new GatewayChatClient({
              url: fixture.gateway.url,
              token: fixture.gateway.gatewayToken,
              allowInsecureLocalOperatorUi: false,
            });
            eventProbe.onConnected = () => {
              probeConnected = true;
            };
            eventProbe.onEvent = ({ event, payload }) => {
              probedEvents.push({ event, payload });
            };
            eventProbe.start();
            await waitFor({
              timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
              read: () => (probeConnected ? true : null),
              onTimeout: () => new Error("Gateway event probe did not connect"),
            });
            await eventProbe.subscribeSessionEvents();
          }
          await fixture.run.waitForOutput(
            mode === "gateway" ? "gateway connected" : "local ready",
            LOCAL_STARTUP_TIMEOUT_MS,
          );
          await fixture.run.write("trigger malformed edit calls\r");
          await waitFor({
            timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
            read: () => (fixture.mockModel.requests().length >= 2 ? true : null),
            onTimeout: () =>
              new Error(`model did not repeat the malformed edit call\n${fixture.run.output()}`),
          });
          if (eventProbe) {
            await waitFor({
              timeoutMs: 30_000,
              read: () => {
                const observed = probedEvents.some((event) => {
                  if (event.event !== "session.tool" || !event.payload) {
                    return false;
                  }
                  const data = (event.payload as { data?: Record<string, unknown> }).data;
                  return typeof data?.toolErrorSummary === "string";
                });
                return observed ? true : null;
              },
              onTimeout: () =>
                new Error(
                  `Gateway did not project a safe tool diagnostic (${probedEvents.length})`,
                ),
            });
          }
          if (fixture.kind === "gateway") {
            await fixture.run.write("/stop\r", { delay: false });
          }
          await fixture.run.waitForOutput(
            "run aborted: edit tool validation failed:",
            LOCAL_OUTPUT_TIMEOUT_MS,
          );

          expect(fixture.mockModel.requests().length).toBeGreaterThan(0);
          expect(fixture.run.output()).not.toContain("Received arguments");

          await fixture.run.write("/exit\r", { delay: false });
          expect((await fixture.run.waitForExit()).exitCode).toBe(0);
        } finally {
          eventProbe?.stop();
          await fixture.cleanup();
        }
      },
      LOCAL_TEST_TIMEOUT_MS,
    );
  }

  it(
    "creates and adopts a fresh session through the real Gateway backend",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui(
        {
          queueMode: "followup",
          firstResponseDelayMs: 0,
        },
        onTestFinished,
      );
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("seed gateway session\r");
        await fixture.run.waitForOutput("FIRST_RUN_ACTIVE");

        const responseOffset = fixture.run.output().lastIndexOf("FIRST_RUN_ACTIVE");
        await waitForOutputAfter(fixture.run, "| idle", responseOffset);

        await fixture.run.write("/new\r", { delay: false });
        await fixture.run.waitForOutput("new session: agent:main:tui-");
        await fixture.run.write("send after gateway new\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `post-/new Gateway prompt did not reach the model\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        const freshRequest = JSON.stringify(fixture.mockModel.requests()[1]?.body);
        expect(freshRequest).toContain("send after gateway new");
        expect(freshRequest).not.toContain("seed gateway session");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "forwards an active-run prompt through the real Gateway followup queue",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui({ queueMode: "followup" }, onTestFinished);
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow first turn\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });

        await fixture.run.write("queued followup turn\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `queued prompt did not reach the model\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await fixture.run.waitForOutput("FOLLOWUP_RUN_COMPLETE");

        await fixture.run.write("turn after queued followup\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 3 ? true : null),
          onTimeout: () =>
            new Error(
              `TUI stayed blocked after queued followup\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        expect(JSON.stringify(fixture.mockModel.requests()[2]?.body)).toContain(
          "turn after queued followup",
        );

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "renders a non-deliverable direct reply failure through the real Gateway and TUI",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui(
        {
          queueMode: "followup",
          firstReplyText: "[[reply_to_current]]",
          firstResponseDelayMs: 0,
        },
        onTestFinished,
      );
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("non-deliverable first turn\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });

        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () =>
            fixture.run.output().includes("did not produce a visible reply") ? true : null,
          onTimeout: () =>
            new Error(
              `empty-reply fallback was not rendered\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        expect(fixture.mockModel.requests()).toHaveLength(1);
        expect(fixture.run.output()).not.toContain("[[reply_to_current]]");

        await fixture.run.write("turn after empty reply\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `TUI stayed blocked after empty-reply fallback\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await fixture.run.waitForOutput("FOLLOWUP_RUN_COMPLETE");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "cancels an admitted followup with Esc before it reaches the model",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui(
        {
          queueMode: "followup",
          firstResponseDelayMs: 1_500,
        },
        onTestFinished,
      );
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow turn to abort\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });
        await fixture.run.write("must never reach model\r");
        await sleep(150);
        await fixture.run.write("\u001b", { delay: false });
        await fixture.run.waitForOutput("aborted");
        await sleep(1_750);

        expect(fixture.mockModel.requests()).toHaveLength(1);
        expect(fixture.run.output()).not.toContain("FOLLOWUP_RUN_COMPLETE");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "collects two TUI-client prompts into one real Gateway followup turn",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui(
        {
          queueMode: "collect",
          firstResponseDelayMs: 1_500,
          queueDebounceMs: 250,
        },
        onTestFinished,
      );
      const queueClient = new GatewayChatClient({
        url: fixture.gateway.url,
        token: fixture.gateway.gatewayToken,
        allowInsecureLocalOperatorUi: false,
      });
      try {
        let queueClientConnected = false;
        queueClient.onConnected = () => {
          queueClientConnected = true;
        };
        queueClient.start();
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await waitFor({
          timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
          read: () => (queueClientConnected ? true : null),
          onTimeout: () => new Error("TUI Gateway client did not connect"),
        });
        await fixture.run.write("/queue collect debounce:250ms\r", { delay: false });
        await fixture.run.waitForOutput("Queue mode set to collect.");
        await fixture.run.write("slow collect parent\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });
        const alphaSend = queueClient.sendChat({
          sessionKey: "agent:main:main",
          message: "collect prompt alpha",
          runId: "collect-alpha",
        });
        await sleep(50);
        const betaSend = queueClient.sendChat({
          sessionKey: "agent:main:main",
          message: "collect prompt beta",
          runId: "collect-beta",
        });
        const sendResults = await Promise.all([alphaSend, betaSend]);
        expect(sendResults.map((result) => result.status)).toEqual(["started", "started"]);
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `collected prompt did not reach the model\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await sleep(500);

        const requests = fixture.mockModel.requests();
        expect(
          requests,
          `collect emitted ${requests.length} model requests\n${JSON.stringify(
            requests.map((request) => request.body.input),
            null,
            2,
          )}\n${fixture.gateway.logs()}`,
        ).toHaveLength(2);
        const collectedBody = JSON.stringify(fixture.mockModel.requests()[1]?.body);
        expect(collectedBody).toContain("collect prompt alpha");
        expect(collectedBody).toContain("collect prompt beta");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        queueClient.stop();
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );
});
