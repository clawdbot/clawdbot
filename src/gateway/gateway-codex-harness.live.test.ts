import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { GatewayClient } from "./client.js";
import {
  assertCronJobMatches,
  assertCronJobVisibleViaCli,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  runOpenClawCliJson,
  type CronListJob,
} from "./live-agent-probes.js";
import { renderCatFacePngBase64 } from "./live-image-probe.js";

const LIVE = isLiveTestEnabled();
const CODEX_HARNESS_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_HARNESS);
const CODEX_HARNESS_DEBUG = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_HARNESS_DEBUG);
const CODEX_HARNESS_IMAGE_PROBE = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE,
);
const CODEX_HARNESS_MCP_PROBE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE);
const describeLive = LIVE && CODEX_HARNESS_LIVE ? describe : describe.skip;
const describeDisabled = LIVE && !CODEX_HARNESS_LIVE ? describe : describe.skip;
const CODEX_HARNESS_TIMEOUT_MS = 420_000;
const DEFAULT_CODEX_MODEL = "codex/gpt-5.4";
const GATEWAY_CONNECT_TIMEOUT_MS = 60_000;

type EnvSnapshot = {
  agentRuntime?: string;
  configPath?: string;
  gatewayToken?: string;
  openaiApiKey?: string;
  skipBrowserControl?: string;
  skipCanvas?: string;
  skipChannels?: string;
  skipCron?: string;
  skipGmail?: string;
  stateDir?: string;
};

function logCodexLiveStep(step: string, details?: Record<string, unknown>): void {
  if (!CODEX_HARNESS_DEBUG) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-codex-live] ${step}${suffix}`);
}

function snapshotEnv(): EnvSnapshot {
  return {
    agentRuntime: process.env.OPENCLAW_AGENT_RUNTIME,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
    openaiApiKey: process.env.OPENAI_API_KEY,
    skipBrowserControl: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  restoreEnvVar("OPENCLAW_AGENT_RUNTIME", snapshot.agentRuntime);
  restoreEnvVar("OPENCLAW_CONFIG_PATH", snapshot.configPath);
  restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", snapshot.gatewayToken);
  restoreEnvVar("OPENAI_API_KEY", snapshot.openaiApiKey);
  restoreEnvVar("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", snapshot.skipBrowserControl);
  restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", snapshot.skipCanvas);
  restoreEnvVar("OPENCLAW_SKIP_CHANNELS", snapshot.skipChannels);
  restoreEnvVar("OPENCLAW_SKIP_CRON", snapshot.skipCron);
  restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", snapshot.skipGmail);
  restoreEnvVar("OPENCLAW_STATE_DIR", snapshot.stateDir);
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function getFreeGatewayPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) {
    throw new Error("failed to allocate gateway port");
  }
  return port;
}

async function ensurePairedTestGatewayClientIdentity(): Promise<DeviceIdentity> {
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const { approveDevicePairing, getPairedDevice, requestDevicePairing } =
    await import("../infra/device-pairing.js");
  const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
    await import("../utils/message-channel.js");
  const identity = loadOrCreateDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const requiredScopes = ["operator.admin"];
  const paired = await getPairedDevice(identity.deviceId);
  const pairedScopes = Array.isArray(paired?.approvedScopes)
    ? paired.approvedScopes
    : Array.isArray(paired?.scopes)
      ? paired.scopes
      : [];
  if (
    paired?.publicKey === publicKey &&
    requiredScopes.every((scope) => pairedScopes.includes(scope))
  ) {
    return identity;
  }
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    displayName: "vitest-codex-harness-live",
    platform: process.platform,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: requiredScopes,
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: requiredScopes,
  });
  if (approved?.status !== "approved") {
    throw new Error(`failed to pre-pair live test device: ${approved?.status ?? "missing"}`);
  }
  return identity;
}

async function connectTestGatewayClient(params: {
  deviceIdentity: DeviceIdentity;
  token: string;
  url: string;
}): Promise<GatewayClient> {
  const { GatewayClient } = await import("./client.js");
  const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
    await import("../utils/message-channel.js");
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    let client: GatewayClient | undefined;
    const connectTimeout = setTimeout(() => {
      finish({ error: new Error("gateway connect timeout") });
    }, GATEWAY_CONNECT_TIMEOUT_MS);
    connectTimeout.unref();

    function finish(result: { client?: GatewayClient; error?: Error }): void {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    }

    client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-codex-harness-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      connectChallengeTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      deviceIdentity: params.deviceIdentity,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: (code, reason) => {
        finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) });
      },
    });
    client.start();
  });
}

async function createLiveWorkspace(tempDir: string): Promise<string> {
  const workspace = path.join(tempDir, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add commentary when asked for an exact response.",
    ].join("\n"),
  );
  return workspace;
}

async function writeLiveGatewayConfig(params: {
  configPath: string;
  modelKey: string;
  port: number;
  token: string;
  workspace: string;
}): Promise<void> {
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      port: params.port,
      auth: { mode: "token", token: params.token },
    },
    plugins: { allow: ["codex"] },
    agents: {
      defaults: {
        workspace: params.workspace,
        embeddedHarness: { runtime: "codex", fallback: "none" },
        skipBootstrap: true,
        model: { primary: params.modelKey },
        models: { [params.modelKey]: {} },
        sandbox: { mode: "off" },
      },
    },
  };
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

async function requestAgentText(params: {
  client: GatewayClient;
  expectedToken: string;
  message: string;
  sessionKey: string;
}): Promise<string> {
  const { extractPayloadText } = await import("./test-helpers.agent-results.js");
  const payload = await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${randomUUID()}`,
      message: params.message,
      deliver: false,
      thinking: "low",
    },
    { expectFinal: true },
  );
  if (payload?.status !== "ok") {
    throw new Error(`agent status=${String(payload?.status)} payload=${JSON.stringify(payload)}`);
  }
  const text = extractPayloadText(payload.result);
  expect(text).toContain(params.expectedToken);
  return text;
}

async function requestCodexCommandText(params: {
  client: GatewayClient;
  command: string;
  expectedText: string;
  sessionKey: string;
}): Promise<string> {
  const { extractPayloadText } = await import("./test-helpers.agent-results.js");
  const payload = await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${randomUUID()}-codex-command`,
      message: params.command,
      deliver: false,
      thinking: "low",
    },
    { expectFinal: true },
  );
  if (payload?.status !== "ok") {
    throw new Error(
      `codex command ${params.command} failed: status=${String(payload?.status)} payload=${JSON.stringify(payload)}`,
    );
  }
  const text = extractPayloadText(payload.result);
  expect(text).toContain(params.expectedText);
  return text;
}

async function verifyCodexImageProbe(params: {
  client: GatewayClient;
  sessionKey: string;
}): Promise<void> {
  const runId = randomUUID();
  const payload = await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${runId}-image`,
      message:
        "Best match for the image: lobster, mouse, cat, horse. " +
        "Reply with one lowercase word only.",
      attachments: [
        {
          mimeType: "image/png",
          fileName: `codex-probe-${runId}.png`,
          content: renderCatFacePngBase64(),
        },
      ],
      deliver: false,
      thinking: "low",
    },
    { expectFinal: true },
  );
  if (payload?.status !== "ok") {
    throw new Error(`image probe failed: status=${String(payload?.status)}`);
  }
  const { extractPayloadText } = await import("./test-helpers.agent-results.js");
  assertLiveImageProbeReply(extractPayloadText(payload.result));
}

async function verifyCodexCronMcpProbe(params: {
  client: GatewayClient;
  env: NodeJS.ProcessEnv;
  port: number;
  sessionKey: string;
  token: string;
}): Promise<void> {
  const cronProbe = createLiveCronProbeSpec();
  let createdJob: CronListJob | undefined;
  let lastReply = "";

  for (let attempt = 0; attempt < 2 && !createdJob; attempt += 1) {
    const runId = randomUUID();
    const payload = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${runId}-mcp-${attempt}`,
        message: buildLiveCronProbeMessage({
          agent: "codex",
          argsJson: cronProbe.argsJson,
          attempt,
          exactReply: cronProbe.name,
        }),
        deliver: false,
        thinking: "low",
      },
      { expectFinal: true },
    );
    if (payload?.status !== "ok") {
      throw new Error(`cron mcp probe failed: status=${String(payload?.status)}`);
    }
    const { extractPayloadText } = await import("./test-helpers.agent-results.js");
    lastReply = extractPayloadText(payload.result).trim();
    createdJob = await assertCronJobVisibleViaCli({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: cronProbe.name,
      expectedMessage: cronProbe.message,
    });
  }

  if (!createdJob) {
    throw new Error(
      `cron cli verify could not find job ${cronProbe.name}: reply=${JSON.stringify(lastReply)}`,
    );
  }
  assertCronJobMatches({
    job: createdJob,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
    expectedSessionKey: params.sessionKey,
  });
  if (createdJob.id) {
    await runOpenClawCliJson(
      [
        "cron",
        "rm",
        createdJob.id,
        "--json",
        "--url",
        `ws://127.0.0.1:${params.port}`,
        "--token",
        params.token,
      ],
      params.env,
    );
  }
}

describeLive("gateway live (Codex harness)", () => {
  it(
    "runs gateway agent turns through the plugin-owned Codex app-server harness",
    async () => {
      const modelKey = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL ?? DEFAULT_CODEX_MODEL;
      const openaiKey = process.env.OPENAI_API_KEY?.trim();
      if (!openaiKey) {
        throw new Error("OPENAI_API_KEY is required for the Codex harness live test.");
      }
      const { clearRuntimeConfigSnapshot } = await import("../config/config.js");
      const { startGatewayServer } = await import("./server.js");

      const previousEnv = snapshotEnv();
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-codex-harness-"));
      const stateDir = path.join(tempDir, "state");
      const workspace = await createLiveWorkspace(tempDir);
      const configPath = path.join(tempDir, "openclaw.json");
      const token = `test-${randomUUID()}`;
      const port = await getFreeGatewayPort();

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_AGENT_RUNTIME = "codex";
      process.env.OPENCLAW_AGENT_HARNESS_FALLBACK = "none";
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_STATE_DIR = stateDir;

      await fs.mkdir(stateDir, { recursive: true });
      await writeLiveGatewayConfig({ configPath, modelKey, port, token, workspace });
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      logCodexLiveStep("config-written", { configPath, modelKey, port });

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      const client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        deviceIdentity,
      });
      logCodexLiveStep("client-connected");

      try {
        const sessionKey = "agent:dev:live-codex-harness";
        const firstNonce = randomBytes(3).toString("hex").toUpperCase();
        const firstToken = `CODEX-HARNESS-${firstNonce}`;
        const firstText = await requestAgentText({
          client,
          sessionKey,
          expectedToken: firstToken,
          message: `Reply with exactly ${firstToken} and nothing else.`,
        });
        logCodexLiveStep("first-turn", { firstText });

        const secondNonce = randomBytes(3).toString("hex").toUpperCase();
        const secondToken = `CODEX-HARNESS-RESUME-${secondNonce}`;
        const secondText = await requestAgentText({
          client,
          sessionKey,
          expectedToken: secondToken,
          message: `Reply with exactly ${secondToken} and nothing else. Do not repeat ${firstToken}.`,
        });
        logCodexLiveStep("second-turn", { secondText });

        const statusText = await requestCodexCommandText({
          client,
          sessionKey,
          command: "/codex status",
          expectedText: "Codex app-server:",
        });
        logCodexLiveStep("codex-status-command", { statusText });

        const modelsText = await requestCodexCommandText({
          client,
          sessionKey,
          command: "/codex models",
          expectedText: "Codex models:",
        });
        logCodexLiveStep("codex-models-command", { modelsText });

        if (CODEX_HARNESS_IMAGE_PROBE) {
          logCodexLiveStep("image-probe:start", { sessionKey });
          await verifyCodexImageProbe({ client, sessionKey });
          logCodexLiveStep("image-probe:done");
        }

        if (CODEX_HARNESS_MCP_PROBE) {
          logCodexLiveStep("cron-mcp-probe:start", { sessionKey });
          await verifyCodexCronMcpProbe({
            client,
            sessionKey,
            port,
            token,
            env: process.env,
          });
          logCodexLiveStep("cron-mcp-probe:done");
        }
      } finally {
        clearRuntimeConfigSnapshot();
        await client.stopAndWait();
        await server.close();
        restoreEnv(previousEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
    CODEX_HARNESS_TIMEOUT_MS,
  );
});

describeDisabled("gateway live (Codex harness disabled)", () => {
  it("is opt-in", () => {
    expect(CODEX_HARNESS_LIVE).toBe(false);
  });
});
