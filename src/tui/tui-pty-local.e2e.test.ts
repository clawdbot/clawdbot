// Exercises slower TUI PTY paths against real local and Gateway backends.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, type TestFunction } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferred } from "../test-utils/deferred.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { sleep, startPty, waitFor, type PtyRun } from "./tui-pty-test-support.js";

type MockModelServer = {
  baseUrl: string;
  requests: (modelId?: string) => MockModelRequest[];
  releaseFirstResponse: (modelId: string) => void;
  stop: () => Promise<void>;
};

type MockModelBehavior = {
  replyText: string;
  holdFirstResponse?: boolean;
  followupReplyText?: string;
  invalidEditLoop?: boolean;
};

type MockModelRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

type GatewayScenario = MockModelBehavior & {
  agentId: string;
  modelId: string;
  toolsProfile: "minimal" | "coding";
};

const GATEWAY_SCENARIOS = {
  validation: {
    agentId: "tui-pty-validation",
    modelId: "tui-pty-validation",
    toolsProfile: "coding",
    replyText: "FIRST_RUN_ACTIVE",
    holdFirstResponse: false,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
    invalidEditLoop: true,
  },
  newSession: {
    agentId: "tui-pty-new-session",
    modelId: "tui-pty-new-session",
    toolsProfile: "minimal",
    replyText: "FIRST_RUN_ACTIVE",
    holdFirstResponse: false,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  },
  followup: {
    agentId: "tui-pty-followup",
    modelId: "tui-pty-followup",
    toolsProfile: "minimal",
    replyText: "FIRST_RUN_ACTIVE",
    holdFirstResponse: true,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  },
  emptyReply: {
    agentId: "tui-pty-empty-reply",
    modelId: "tui-pty-empty-reply",
    toolsProfile: "minimal",
    replyText: "[[reply_to_current]]",
    holdFirstResponse: false,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  },
  cancel: {
    agentId: "tui-pty-cancel",
    modelId: "tui-pty-cancel",
    toolsProfile: "minimal",
    replyText: "FIRST_RUN_ACTIVE",
    holdFirstResponse: true,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  },
  collect: {
    agentId: "tui-pty-collect",
    modelId: "tui-pty-collect",
    toolsProfile: "minimal",
    replyText: "FIRST_RUN_ACTIVE",
    holdFirstResponse: true,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  },
  reconnect: {
    agentId: "tui-pty-reconnect",
    modelId: "tui-pty-reconnect",
    toolsProfile: "minimal",
    replyText: "RECONNECTED_RUN_COMPLETE",
  },
} as const satisfies Record<string, GatewayScenario>;

type GatewayScenarioId = keyof typeof GATEWAY_SCENARIOS;

const LOCAL_STARTUP_TIMEOUT_MS = 60_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 120_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 150_000;
const SUBMISSION_SETTLE_MS = 150;
const SESSION_ROLLOVER_BUSY_MESSAGE = "abort the current run before /new";

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

async function createFreshSession(run: PtyRun, newSessionPrefix: string) {
  const deadline = Date.now() + LOCAL_STARTUP_TIMEOUT_MS;
  let attempts = 0;
  let outputOffset = run.output().length;
  while (Date.now() < deadline) {
    attempts += 1;
    await run.write("/new\r", { delay: false });
    const outcome = await waitFor({
      timeoutMs: Math.max(1, deadline - Date.now()),
      read: () => {
        const output = run.output();
        if (output.includes(newSessionPrefix, outputOffset)) {
          return "created";
        }
        return output.includes(SESSION_ROLLOVER_BUSY_MESSAGE, outputOffset) ? "busy" : null;
      },
      onTimeout: () =>
        new Error(`timed out creating a fresh session after ${attempts} attempts\n${run.output()}`),
    });
    if (outcome === "created") {
      return;
    }

    // Redraws can repeat an old rejection after this attempt's offset. Keep
    // watching that attempt through settle so an accepted /new is not retried.
    await sleep(SUBMISSION_SETTLE_MS);
    if (run.output().includes(newSessionPrefix, outputOffset)) {
      return;
    }
    outputOffset = run.output().length;
  }
  throw new Error(`timed out creating a fresh session after ${attempts} attempts\n${run.output()}`);
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

async function writeResponsesSse(
  res: ServerResponse,
  text: string,
  completionGate?: Promise<void>,
) {
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
  if (completionGate) {
    await completionGate;
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

async function startRoutedMockModelServer(
  behaviors: Readonly<Record<string, MockModelBehavior>>,
): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const requestsByModel = new Map<string, MockModelRequest[]>();
  const firstResponseGates = new Map(
    Object.entries(behaviors)
      .filter(([, behavior]) => behavior.holdFirstResponse)
      .map(([modelId]) => [modelId, createDeferred()] as const),
  );
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, {
          data: Object.keys(behaviors).map((id) => ({ id, object: "model" })),
        });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonRequest(req);
        if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
          const modelId = typeof body.model === "string" ? body.model : "";
          const behavior = behaviors[modelId];
          if (!behavior) {
            writeJson(res, 400, { error: `unknown mock model: ${modelId || "missing"}` });
            return;
          }
          const modelRequests = requestsByModel.get(modelId) ?? [];
          if (!requestsByModel.has(modelId)) {
            requestsByModel.set(modelId, modelRequests);
          }
          const requestIndex = modelRequests.length;
          const request = { method: req.method, path: url.pathname, body };
          requests.push(request);
          modelRequests.push(request);
          if (behavior.invalidEditLoop) {
            writeInvalidEditCallSse(res, requestIndex);
            return;
          }
          await writeResponsesSse(
            res,
            requestIndex === 0
              ? behavior.replyText
              : (behavior.followupReplyText ?? behavior.replyText),
            requestIndex === 0 ? firstResponseGates.get(modelId)?.promise : undefined,
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
    requests: (modelId) => (modelId ? (requestsByModel.get(modelId) ?? []) : requests),
    releaseFirstResponse: (modelId) => {
      firstResponseGates.get(modelId)?.resolve();
    },
    stop: async () => {
      // Never leave a held request owning the shared server during failure cleanup.
      for (const gate of firstResponseGates.values()) {
        gate.resolve();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Aborted local runs can leave a provider keep-alive open. Force-close
        // test-owned connections so cleanup does not wait for idle expiry.
        server.closeAllConnections();
      });
    },
  };
}

async function startMockModelServer(
  replyText: string,
  opts: Omit<MockModelBehavior, "replyText"> = {},
): Promise<MockModelServer> {
  return await startRoutedMockModelServer({
    "gpt-5.5": { replyText, ...opts },
  });
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

function buildLocalValidationTuiScript() {
  const agentEventsModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/infra/agent-events.ts"),
  ).href;
  const embeddedBackendModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/tui/embedded-backend.ts"),
  ).href;
  const tuiModuleUrl = pathToFileURL(path.join(process.cwd(), "src/tui/tui.ts")).href;
  // A PTY-side abort can race the validation retry into another provider turn.
  // Abort through the real local backend after its listener records the second
  // tool error; the Gateway case below still covers keyboard-driven aborts.
  return [
    `import { onAgentEvent } from ${JSON.stringify(agentEventsModuleUrl)};`,
    `import { EmbeddedTuiBackend } from ${JSON.stringify(embeddedBackendModuleUrl)};`,
    `import { runTui } from ${JSON.stringify(tuiModuleUrl)};`,
    `const backend = new EmbeddedTuiBackend();`,
    `const sessionKey = "agent:main:main";`,
    `let validationErrorCount = 0;`,
    `onAgentEvent((event) => {`,
    `  if (event.stream !== "tool" || event.data?.phase !== "result" || typeof event.data?.toolErrorSummary !== "string") return;`,
    `  validationErrorCount += 1;`,
    `  if (validationErrorCount !== 2) return;`,
    `  queueMicrotask(() => {`,
    `    void backend.abortChat({ sessionKey }).then((result) => {`,
    `      if (!result.aborted) {`,
    `        console.error("local validation test failed to abort its active run");`,
    `        process.exit(1);`,
    `      }`,
    `    }).catch((error) => {`,
    `      console.error(error);`,
    `      process.exit(1);`,
    `    });`,
    `  });`,
    `});`,
    `runTui({ local: true, backend, session: sessionKey, deliver: false, historyLimit: 200, forceProcessExitOnReturn: true }).catch((error) => {`,
    `  console.error(error);`,
    `  process.exit(1);`,
    `});`,
  ].join("\n");
}

function buildMockModelProvider(baseUrl: string, modelIds: string[]): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    apiKey: "test",
    api: "openai-responses",
    request: { allowPrivateNetwork: true },
    models: modelIds.map((id) => ({
      id,
      name: id,
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    })),
  };
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
      entries: {
        main: {
          default: true,
          skills: [],
          model: { primary: "tui-pty-mock/gpt-5.5" },
        },
      },
    },
    tools: {
      profile: params.toolsProfile ?? "minimal",
    },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": buildMockModelProvider(params.providerBaseUrl, ["gpt-5.5"]),
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
  opts: {
    invalidEditLoop?: boolean;
    holdFirstResponse?: boolean;
    followupReplyText?: string;
  } = {},
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
    holdFirstResponse: opts.holdFirstResponse,
    followupReplyText: opts.followupReplyText,
  });
  const config = buildLocalModeConfig({
    workspaceDir,
    providerBaseUrl: mockModel.baseUrl,
    toolsProfile: opts.invalidEditLoop ? "coding" : "minimal",
  });
  const script = opts.invalidEditLoop
    ? buildLocalValidationTuiScript()
    : buildTuiCliScript(["tui", "--local"]);
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
    await run.dispose();
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

type SharedGatewayFixture = {
  gateway: OpenClawTestInstance;
  controlClient: GatewayChatClient;
  mockModel: MockModelServer;
  cleanup: () => Promise<void>;
};

let sharedGatewayFixtureStartup: Promise<SharedGatewayFixture> | undefined;
let gatewaySessionSequence = 0;

function buildGatewayModeConfig(params: { tempDir: string; providerBaseUrl: string }) {
  const scenarios: GatewayScenario[] = Object.values(GATEWAY_SCENARIOS);
  const defaultScenario = GATEWAY_SCENARIOS.validation;
  const defaultModelRef = `tui-pty-mock/${defaultScenario.modelId}`;
  const modelRefs = scenarios.map((scenario) => `tui-pty-mock/${scenario.modelId}`);
  const base = buildLocalModeConfig({
    workspaceDir: path.join(params.tempDir, defaultScenario.agentId),
    providerBaseUrl: params.providerBaseUrl,
  });
  return {
    ...base,
    agents: {
      defaults: {
        workspace: path.join(params.tempDir, defaultScenario.agentId),
        model: { primary: defaultModelRef },
        models: Object.fromEntries(
          modelRefs.map((modelRef) => [modelRef, { agentRuntime: { id: "openclaw" } }]),
        ),
        skills: [],
        skipBootstrap: true,
      },
      entries: Object.fromEntries(
        scenarios.map((scenario, index) => [
          scenario.agentId,
          {
            ...(index === 0 ? { default: true } : {}),
            workspace: path.join(params.tempDir, scenario.agentId),
            skills: [],
            model: { primary: `tui-pty-mock/${scenario.modelId}` },
            tools: { profile: scenario.toolsProfile },
          },
        ]),
      ),
    },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": buildMockModelProvider(
          params.providerBaseUrl,
          scenarios.map((scenario) => scenario.modelId),
        ),
      },
    },
    messages: {
      queue: {
        mode: "followup",
      },
    },
  } satisfies OpenClawConfig;
}

async function startSharedGatewayFixture(): Promise<SharedGatewayFixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-gateway-"));
  let mockModel: MockModelServer | undefined;
  let gateway: OpenClawTestInstance | undefined;
  let controlClient: GatewayChatClient | undefined;
  try {
    const scenarios: GatewayScenario[] = Object.values(GATEWAY_SCENARIOS);
    await Promise.all(
      scenarios.map((scenario) => mkdir(path.join(tempDir, scenario.agentId), { recursive: true })),
    );
    mockModel = await startRoutedMockModelServer(
      Object.fromEntries(
        scenarios.map((scenario) => [
          scenario.modelId,
          {
            replyText: scenario.replyText,
            holdFirstResponse: scenario.holdFirstResponse,
            followupReplyText: scenario.followupReplyText,
            invalidEditLoop: scenario.invalidEditLoop,
          },
        ]),
      ),
    );
    gateway = await createOpenClawTestInstance({
      name: "tui-pty-shared-gateway",
      gatewayToken: "tui-pty-local",
      config: buildGatewayModeConfig({ tempDir, providerBaseUrl: mockModel.baseUrl }),
      env: {
        OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
    });
    await gateway.startGateway();

    let controlClientConnected = false;
    controlClient = new GatewayChatClient({
      url: gateway.url,
      token: gateway.gatewayToken,
      allowInsecureLocalOperatorUi: false,
    });
    controlClient.onConnected = () => {
      controlClientConnected = true;
    };
    controlClient.start();
    await waitFor({
      timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
      read: () => (controlClientConnected ? true : null),
      onTimeout: () => new Error("shared Gateway control client did not connect"),
    });

    const fixtureGateway = gateway;
    const fixtureMockModel = mockModel;
    const fixtureControlClient = controlClient;
    const cleanup = createIdempotentCleanup(async () => {
      await fixtureControlClient.stop();
      try {
        await fixtureGateway.cleanup();
      } finally {
        try {
          await fixtureMockModel.stop();
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    });
    return {
      gateway: fixtureGateway,
      controlClient: fixtureControlClient,
      mockModel: fixtureMockModel,
      cleanup,
    };
  } catch (error) {
    await controlClient?.stop();
    try {
      await gateway?.cleanup();
    } finally {
      try {
        await mockModel?.stop();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function requireSharedGatewayFixture(): Promise<SharedGatewayFixture> {
  if (!sharedGatewayFixtureStartup) {
    throw new Error("shared Gateway fixture startup was not initialized");
  }
  return await sharedGatewayFixtureStartup;
}

async function cleanupSharedGatewayFixture(
  startup: Promise<Pick<SharedGatewayFixture, "cleanup">> | undefined,
): Promise<void> {
  if (!startup) {
    return;
  }
  let fixture: Pick<SharedGatewayFixture, "cleanup">;
  try {
    fixture = await startup;
  } catch {
    // The setup hook already reports startup failures. Teardown only owns cleanup.
    return;
  }
  await fixture.cleanup();
}

async function startGatewayModeTui(
  scenarioId: GatewayScenarioId,
  registerCleanup: CleanupRegistrar,
) {
  const shared = await requireSharedGatewayFixture();
  const scenario = GATEWAY_SCENARIOS[scenarioId];
  const requestOffset = shared.mockModel.requests(scenario.modelId).length;
  const sessionKey = `agent:${scenario.agentId}:tui-pty-${++gatewaySessionSequence}`;
  const sessionKeys = new Set([sessionKey]);
  const script = buildTuiCliScript([
    "tui",
    "--url",
    shared.gateway.url,
    "--token",
    shared.gateway.gatewayToken,
    "--session",
    sessionKey,
  ]);
  const run = startPty(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...shared.gateway.env,
      OPENCLAW_THEME: "dark",
      NO_COLOR: undefined,
    },
    exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
    outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
  });
  const cleanup = createIdempotentCleanup(async () => {
    shared.mockModel.releaseFirstResponse(scenario.modelId);
    await run.dispose();
    for (const key of sessionKeys) {
      await shared.controlClient.abortChat({ sessionKey: key });
    }
  });
  registerCleanup(cleanup);
  return {
    kind: "gateway" as const,
    run,
    gateway: shared.gateway,
    mockModel: {
      requests: () => shared.mockModel.requests(scenario.modelId).slice(requestOffset),
      releaseFirstResponse: () => shared.mockModel.releaseFirstResponse(scenario.modelId),
    },
    agentId: scenario.agentId,
    sessionKey,
    trackSessionKey: (key: string) => sessionKeys.add(key),
    cleanup,
  };
}

// Gateway cases share one real server but keep isolated PTYs, models, and sessions.
// Keep them serial so constrained release runners avoid host contention.
describe("TUI PTY real backends", () => {
  it("owns late fixture startup without swallowing cleanup failures", async () => {
    await expect(
      cleanupSharedGatewayFixture(Promise.reject(new Error("setup failed"))),
    ).resolves.toBe(undefined);

    const cleanupError = new Error("cleanup failed");
    const fixture = {
      cleanup: async () => {
        throw cleanupError;
      },
    };
    await expect(cleanupSharedGatewayFixture(Promise.resolve(fixture))).rejects.toBe(cleanupError);
  });

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

        await createFreshSession(fixture.run, "new session: agent:main:tui-");
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

  it(
    "steers an active real local session in the same turn",
    async ({ onTestFinished }) => {
      const fixture = await startLocalModeTui(onTestFinished, {
        holdFirstResponse: true,
        followupReplyText: "LOCAL_STEER_COMPLETE",
      });
      try {
        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow local parent\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });

        const steerOffset = fixture.run.output().length;
        await fixture.run.write("steer the active local turn\r");
        await waitForOutputAfter(fixture.run, "steer the active local turn", steerOffset);
        await sleep(SUBMISSION_SETTLE_MS);
        fixture.mockModel.releaseFirstResponse("gpt-5.5");

        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `steered prompt did not reach the active local session\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.run.output()}`,
            ),
        });
        expect(JSON.stringify(fixture.mockModel.requests()[1]?.body)).toContain(
          "steer the active local turn",
        );
        await fixture.run.waitForOutput("LOCAL_STEER_COMPLETE");
        if (process.env.OPENCLAW_BEHAVIOR_EVIDENCE === "1") {
          console.info(
            "[behavior-evidence] local-steer",
            JSON.stringify({
              providerRequestCount: fixture.mockModel.requests().length,
              secondRequestHasDynamicPrompt: (
                JSON.stringify(fixture.mockModel.requests()[1]?.body) ?? ""
              ).includes("steer the active local turn"),
              renderedCompletion: fixture.run.output().includes("LOCAL_STEER_COMPLETE"),
              secondPromptEchoedBeforeRelease: true,
            }),
          );
        }

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  function registerValidationLoopTest(mode: "gateway" | "local") {
    it(
      `renders safe validation-loop abort diagnostics through the real ${mode} backend`,
      async ({ onTestFinished }) => {
        const fixture =
          mode === "gateway"
            ? await startGatewayModeTui("validation", onTestFinished)
            : await startLocalModeTui(onTestFinished, { invalidEditLoop: true });
        const expectedGatewaySessionKey =
          fixture.kind === "gateway" ? fixture.sessionKey : undefined;
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
                  const payload = event.payload as {
                    sessionKey?: unknown;
                    data?: Record<string, unknown>;
                  };
                  return (
                    payload.sessionKey === expectedGatewaySessionKey &&
                    typeof payload.data?.toolErrorSummary === "string"
                  );
                });
                return observed ? true : null;
              },
              onTimeout: () =>
                new Error(
                  `Gateway did not project a safe tool diagnostic (${probedEvents.length})`,
                ),
            });
          }
          if (mode === "gateway") {
            await fixture.run.write("\u001b", { delay: false });
          }
          await fixture.run.waitForOutput(
            "run aborted: edit tool validation failed:",
            LOCAL_OUTPUT_TIMEOUT_MS,
          );

          expect(fixture.mockModel.requests().length).toBeGreaterThanOrEqual(2);
          expect(fixture.run.output()).not.toContain("Received arguments");

          await fixture.run.write("/exit\r", { delay: false });
          expect((await fixture.run.waitForExit()).exitCode).toBe(0);
        } finally {
          await eventProbe?.stop();
          await fixture.cleanup();
        }
      },
      LOCAL_TEST_TIMEOUT_MS,
    );
  }

  registerValidationLoopTest("local");

  // Register every Gateway case inside the nested suite so targeted runs retain
  // the fixture's separate startup timeout.
  const gatewayTestRegistrations: Array<() => void> = [];
  function registerGatewayTest(name: string, run: TestFunction, timeoutMs: number) {
    gatewayTestRegistrations.push(() => {
      it(name, run, timeoutMs);
    });
  }

  registerGatewayTest(
    "preserves a disconnected draft across a real Gateway restart",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("reconnect", onTestFinished);
      let gatewayStopped = false;
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        const disconnectOffset = fixture.run.output().length;
        await fixture.gateway.stopGateway();
        gatewayStopped = true;
        await waitForOutputAfter(fixture.run, "gateway disconnected", disconnectOffset);

        await fixture.run.write("send preserved draft after restart\r");
        await fixture.run.waitForOutput("not connected to gateway — message not sent");
        expect(fixture.mockModel.requests()).toHaveLength(0);

        const reconnectOffset = fixture.run.output().length;
        await fixture.gateway.startGateway();
        gatewayStopped = false;
        await waitForOutputAfter(fixture.run, "gateway reconnected", reconnectOffset);
        await fixture.run.write("\r", { delay: false });
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(
              `preserved prompt did not reach the model after restart\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        expect(JSON.stringify(fixture.mockModel.requests()[0]?.body)).toContain(
          "send preserved draft after restart",
        );
        await fixture.run.waitForOutput("RECONNECTED_RUN_COMPLETE");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        if (gatewayStopped) {
          await fixture.gateway.startGateway();
        }
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  registerGatewayTest(
    "creates and adopts a fresh session through the real Gateway backend",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("newSession", onTestFinished);
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("seed gateway session\r");
        await fixture.run.waitForOutput("FIRST_RUN_ACTIVE");

        const newSessionPrefix = `new session: agent:${fixture.agentId}:tui-`;
        await createFreshSession(fixture.run, newSessionPrefix);
        const newSessionKey = fixture.run
          .output()
          .match(new RegExp(`new session: (agent:${fixture.agentId}:tui-[a-z0-9-]+)`))?.[1];
        expect(newSessionKey).toBeDefined();
        if (newSessionKey) {
          fixture.trackSessionKey(newSessionKey);
        }
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

  registerGatewayTest(
    "forwards an active-run prompt through the real Gateway followup queue",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("followup", onTestFinished);
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow first turn\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });

        const followupOffset = fixture.run.output().length;
        await fixture.run.write("queued followup turn\r");
        await waitForOutputAfter(fixture.run, "queued followup turn", followupOffset);
        // Keep the provider held while the echoed input crosses TUI submission.
        await sleep(SUBMISSION_SETTLE_MS);
        fixture.mockModel.releaseFirstResponse();
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
        const completedOffset = fixture.run.output().lastIndexOf("FOLLOWUP_RUN_COMPLETE");

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
        await waitForOutputAfter(fixture.run, "FOLLOWUP_RUN_COMPLETE", completedOffset);
        const finalResponseOffset = fixture.run.output().lastIndexOf("FOLLOWUP_RUN_COMPLETE");
        await waitForOutputAfter(fixture.run, "| idle", finalResponseOffset);

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  registerGatewayTest(
    "renders a non-deliverable direct reply failure through the real Gateway and TUI",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("emptyReply", onTestFinished);
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

  registerGatewayTest(
    "cancels an admitted followup with Esc before it reaches the model",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("cancel", onTestFinished);
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow turn to abort\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });
        const followupOffset = fixture.run.output().length;
        await fixture.run.write("must never reach model\r");
        await waitForOutputAfter(fixture.run, "must never reach model", followupOffset);
        await sleep(SUBMISSION_SETTLE_MS);
        await fixture.run.write("\u001b", { delay: false });
        await fixture.run.waitForOutput("aborted");
        fixture.mockModel.releaseFirstResponse();
        // Abort has cleared the queue; keep only a short window for a stray provider request.
        await sleep(250);

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

  registerGatewayTest(
    "collects two TUI-client prompts into one real Gateway followup turn",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("collect", onTestFinished);
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
          sessionKey: fixture.sessionKey,
          message: "collect prompt alpha",
        });
        await sleep(50);
        const betaSend = queueClient.sendChat({
          sessionKey: fixture.sessionKey,
          message: "collect prompt beta",
        });
        const sendResults = await Promise.all([alphaSend, betaSend]);
        expect(sendResults.map((result) => result.status)).toEqual(["started", "started"]);
        fixture.mockModel.releaseFirstResponse();
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `collected prompt did not reach the model\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await fixture.run.waitForOutput("FOLLOWUP_RUN_COMPLETE");
        const completedOffset = fixture.run.output().lastIndexOf("FOLLOWUP_RUN_COMPLETE");
        await waitForOutputAfter(fixture.run, "| idle", completedOffset);

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
        await queueClient.stop();
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  describe("with shared Gateway fixture", () => {
    beforeAll(async () => {
      const startup = startSharedGatewayFixture();
      sharedGatewayFixtureStartup = startup;
      await startup;
    }, LOCAL_TEST_TIMEOUT_MS);

    afterAll(async () => {
      const startup = sharedGatewayFixtureStartup;
      sharedGatewayFixtureStartup = undefined;
      await cleanupSharedGatewayFixture(startup);
    }, LOCAL_TEST_TIMEOUT_MS);

    for (const register of gatewayTestRegistrations) {
      register();
    }
    // Validation abort can terminalize the TUI before the embedded command lanes
    // finish unwinding. Keep it last so shared-Gateway teardown owns that tail.
    registerValidationLoopTest("gateway");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
