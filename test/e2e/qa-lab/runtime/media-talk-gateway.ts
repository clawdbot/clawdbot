import { randomUUID } from "node:crypto";
// QA Lab producer exercises WebChat media delivery and Talk run control through a real Gateway.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import { GatewayClient, type GatewayClientOptions } from "../../../../src/gateway/client.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../../src/utils/message-channel.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const FIXTURE_PLUGIN_ID = "qa-media-talk-runtime";
const FIXTURE_SPEECH_PROVIDER_ID = "qa-speech";
const FIXTURE_REALTIME_PROVIDER_ID = "qa-realtime";
const FIXTURE_WAV_BASE64 =
  "UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/media-talk-gateway.ts";

type ScenarioId = "webchat-auto-tts" | "active-talk-agent-run-status";

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
  scenarioId: ScenarioId;
};

type ProofResult = {
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

const SCENARIOS = {
  "webchat-auto-tts": {
    title: "WebChat auto TTS delivery",
    sourcePath: "qa/scenarios/media/webchat-auto-tts.yaml",
    docsRefs: ["docs/tools/tts.md", "docs/tools/media-overview.md"],
    codeRefs: [
      SOURCE_PATH,
      "packages/speech-core/src/tts.ts",
      "src/gateway/server-methods/chat.ts",
      "src/gateway/control-ui.ts",
    ],
  },
  "active-talk-agent-run-status": {
    title: "Active Talk agent-run control boundaries",
    sourcePath: "qa/scenarios/runtime/active-talk-agent-run-status.yaml",
    docsRefs: ["docs/nodes/talk.md", "docs/web/control-ui.md"],
    codeRefs: [
      SOURCE_PATH,
      "src/gateway/server-methods/talk-client.ts",
      "src/talk/agent-run-control.ts",
      "src/agents/embedded-agent-runner/runs.ts",
    ],
  },
} as const;

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenarioId = readValue("--scenario");
  if (!scenarioId || !(scenarioId in SCENARIOS)) {
    throw new Error(`--scenario must be one of: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
    scenarioId: scenarioId as ScenarioId,
  };
}

async function createFixturePlugin(root: string) {
  const pluginDir = path.join(root, FIXTURE_PLUGIN_ID);
  const speechCallsPath = path.join(root, "speech-calls.jsonl");
  const realtimeCallsPath = path.join(root, "realtime-calls.jsonl");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FIXTURE_PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `const fs = require("node:fs");

module.exports = {
  id: ${JSON.stringify(FIXTURE_PLUGIN_ID)},
  register(api) {
    api.registerSpeechProvider({
      id: ${JSON.stringify(FIXTURE_SPEECH_PROVIDER_ID)},
      label: "QA Speech",
      autoSelectOrder: 1,
      isConfigured: () => true,
      async synthesize(request) {
        fs.appendFileSync(process.env.OPENCLAW_QA_SPEECH_CALLS_PATH, JSON.stringify({ text: request.text, target: request.target }) + "\\n");
        return {
          audioBuffer: Buffer.from(${JSON.stringify(FIXTURE_WAV_BASE64)}, "base64"),
          fileExtension: ".wav",
          outputFormat: "wav",
          voiceCompatible: request.target === "voice-note",
        };
      },
    });
    api.registerRealtimeVoiceProvider({
      id: ${JSON.stringify(FIXTURE_REALTIME_PROVIDER_ID)},
      label: "QA Realtime",
      isConfigured: () => true,
      async createBrowserSession(request) {
        fs.appendFileSync(process.env.OPENCLAW_QA_REALTIME_CALLS_PATH, JSON.stringify({ tools: request.tools?.map((tool) => tool.name) ?? [] }) + "\\n");
        return {
          provider: ${JSON.stringify(FIXTURE_REALTIME_PROVIDER_ID)},
          transport: "provider-websocket",
          protocol: "google-live-bidi",
          clientSecret: "qa-browser-token",
          websocketUrl: "wss://qa.invalid/realtime",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24000,
          },
        };
      },
      createBridge() {
        throw new Error("QA browser Talk provider does not create server bridges");
      },
    });
  },
};
`,
    "utf8",
  );
  return { pluginDir, realtimeCallsPath, speechCallsPath };
}

function withFixturePlugin(config: OpenClawConfig, pluginDir: string): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), FIXTURE_PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [FIXTURE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

async function connectGatewayClient(params: {
  clientName: GatewayClientName;
  mode: GatewayClientMode;
  onEvent?: GatewayClientOptions["onEvent"];
  token: string;
  url: string;
}) {
  const gatewayUrl = new URL(params.url);
  gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
  let resolveHello: (() => void) | undefined;
  let rejectHello: ((error: Error) => void) | undefined;
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url: params.url,
    origin: gatewayUrl.origin,
    token: params.token,
    clientName: params.clientName,
    mode: params.mode,
    role: "operator",
    scopes: [
      "operator.read",
      "operator.write",
      "operator.admin",
      "operator.approvals",
      "operator.talk.secrets",
    ],
    platform: "qa",
    requestTimeoutMs: 30_000,
    onEvent: params.onEvent,
    onHelloOk: () => resolveHello?.(),
    onConnectError: (error) => rejectHello?.(error),
    onClose: (code, reason) => rejectHello?.(new Error(`Gateway closed ${code}: ${reason}`)),
  });
  client.start();
  const timer = setTimeout(() => rejectHello?.(new Error("Gateway connect timeout")), 20_000);
  try {
    await hello;
  } catch (error) {
    client.stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return client;
}

function collectRecords(value: unknown, records: Record<string, unknown>[] = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRecords(entry, records);
    }
    return records;
  }
  if (!value || typeof value !== "object") {
    return records;
  }
  const record = value as Record<string, unknown>;
  records.push(record);
  for (const entry of Object.values(record)) {
    collectRecords(entry, records);
  }
  return records;
}

function findAudioAttachmentSource(value: unknown): string | undefined {
  return collectRecords(value)
    .filter((record) => record.kind === "audio")
    .map((record) => record.url)
    .find((url): url is string => typeof url === "string" && url.length > 0);
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForChatFinal(
  events: Array<{ event: string; payload?: unknown }>,
  runId: string,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const finalEvent = events.find((event) => {
      if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
        return false;
      }
      const payload = event.payload as Record<string, unknown>;
      return payload.runId === runId && payload.state === "final";
    });
    if (finalEvent) {
      return finalEvent.payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for WebChat final event for run ${runId}`);
}

async function waitForWebchatAudio(params: {
  client: GatewayClient;
  events: Array<{ event: string; payload?: unknown }>;
  sessionKey: string;
}) {
  const deadline = Date.now() + 15_000;
  let history: unknown;
  while (Date.now() < deadline) {
    history = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 20,
    });
    const source = findAudioAttachmentSource(params.events) ?? findAudioAttachmentSource(history);
    if (source) {
      return { history, source };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { history, source: undefined };
}

async function runWebchatAutoTtsProof(options: ProducerOptions): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webchat-tts-"));
  const fixture = await createFixturePlugin(fixtureRoot);
  const mock = await startQaMockOpenAiServer();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let client: GatewayClient | undefined;
  const events: Array<{ event: string; payload?: unknown }> = [];
  try {
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: true,
      runtimeEnvPatch: {
        OPENCLAW_QA_SPEECH_CALLS_PATH: fixture.speechCallsPath,
        OPENCLAW_QA_REALTIME_CALLS_PATH: fixture.realtimeCallsPath,
      },
      mutateConfig: (config) => {
        const withPlugin = withFixturePlugin(config, fixture.pluginDir);
        return {
          ...withPlugin,
          messages: {
            ...withPlugin.messages,
            tts: {
              auto: "always",
              mode: "final",
              provider: FIXTURE_SPEECH_PROVIDER_ID,
              prefsPath: path.join(fixtureRoot, "tts-prefs.json"),
            },
          },
        };
      },
    });
    client = await connectGatewayClient({
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      onEvent: (event) => events.push(event),
      token: gateway.token,
      url: gateway.wsUrl,
    });
    const sessionKey = "agent:qa:main";
    const runId = randomUUID();
    await client.request("chat.send", {
      sessionKey,
      message: "block streaming qa check; answer with one short sentence",
      deliver: false,
      idempotencyKey: runId,
    });
    await waitForChatFinal(events, runId);
    const { history, source } = await waitForWebchatAudio({ client, events, sessionKey });
    if (!source) {
      const speechCalls = await readJsonLines(fixture.speechCallsPath);
      throw new Error(
        `WebChat history did not contain an audio attachment; speech=${JSON.stringify(speechCalls)}; gateway=${gateway.logs()}; history=${JSON.stringify(history)}`,
      );
    }
    const speechCalls = await readJsonLines(fixture.speechCallsPath);
    if (speechCalls.length !== 1) {
      throw new Error(`expected one final-tail TTS synthesis, received ${speechCalls.length}`);
    }
    const route = `${gateway.baseUrl}/__openclaw__/assistant-media`;
    const sourceParam = encodeURIComponent(source);
    const metadata = await fetch(`${route}?meta=1&source=${sourceParam}`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!metadata.ok) {
      throw new Error(`media metadata failed with ${metadata.status}: ${await metadata.text()}`);
    }
    const ticket = (await metadata.json()) as { available?: boolean; mediaTicket?: string };
    if (ticket.available !== true || !ticket.mediaTicket?.startsWith("v1.")) {
      throw new Error(`media metadata did not mint a scoped ticket: ${JSON.stringify(ticket)}`);
    }
    const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
    if (withoutTicket.status !== 401) {
      throw new Error(`media route without ticket returned ${withoutTicket.status}, expected 401`);
    }
    const ticketed = await fetch(
      `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(ticket.mediaTicket)}`,
    );
    const body = Buffer.from(await ticketed.arrayBuffer());
    if (!ticketed.ok || !ticketed.headers.get("content-type")?.includes("audio/wav")) {
      throw new Error(`ticketed media failed with ${ticketed.status}`);
    }
    if (!body.equals(Buffer.from(FIXTURE_WAV_BASE64, "base64"))) {
      throw new Error(`ticketed media returned unexpected bytes: ${body.toString("hex")}`);
    }
    return `real Gateway pid=${gateway.pid ?? "unknown"}; WebChat history contained trusted audio; syntheses=1; scoped ticket served ${body.length} bytes`;
  } finally {
    client?.stop();
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

function assertControlResult(
  value: unknown,
  expected: { mode: string; active?: boolean; queued?: boolean; aborted?: boolean },
) {
  if (!value || typeof value !== "object") {
    throw new Error(`Talk control returned non-object: ${JSON.stringify(value)}`);
  }
  const result = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (result[key] !== expectedValue) {
      throw new Error(`Talk ${expected.mode} returned ${JSON.stringify(result)}`);
    }
  }
  if (result.ok !== true) {
    throw new Error(`Talk ${expected.mode} failed: ${JSON.stringify(result)}`);
  }
}

async function waitForActiveTalkStatus(client: GatewayClient, sessionKey: string) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await client.request("talk.client.steer", {
        sessionKey,
        text: "status",
        mode: "status",
      });
      assertControlResult(status, { mode: "status", active: true });
      return status;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("timed out waiting for active Talk run");
}

async function waitForQueuedTalkSteer(client: GatewayClient, sessionKey: string) {
  const deadline = Date.now() + 20_000;
  let lastResult: unknown;
  while (Date.now() < deadline) {
    lastResult = await client.request("talk.client.steer", {
      sessionKey,
      text: "use the safer path",
      mode: "steer",
    });
    if (
      lastResult &&
      typeof lastResult === "object" &&
      (lastResult as Record<string, unknown>).queued === true
    ) {
      return lastResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for steerable Talk run: ${JSON.stringify(lastResult)}`);
}

async function runActiveTalkAgentRunProof(options: ProducerOptions): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-talk-"));
  const fixture = await createFixturePlugin(fixtureRoot);
  const mock = await startQaMockOpenAiServer({ finalOnlyMarkerPauseMs: 60_000 });
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let client: GatewayClient | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: true,
      runtimeEnvPatch: {
        OPENCLAW_QA_SPEECH_CALLS_PATH: fixture.speechCallsPath,
        OPENCLAW_QA_REALTIME_CALLS_PATH: fixture.realtimeCallsPath,
      },
      mutateConfig: (config) => {
        const withPlugin = withFixturePlugin(config, fixture.pluginDir);
        return {
          ...withPlugin,
          talk: {
            ...withPlugin.talk,
            realtime: {
              ...withPlugin.talk?.realtime,
              provider: FIXTURE_REALTIME_PROVIDER_ID,
              providers: {
                ...withPlugin.talk?.realtime?.providers,
                [FIXTURE_REALTIME_PROVIDER_ID]: {},
              },
            },
          },
        };
      },
    });
    client = await connectGatewayClient({
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      token: gateway.token,
      url: gateway.wsUrl,
    });
    const sessionKey = "agent:qa:main";
    const created = await client.request<Record<string, unknown>>("talk.client.create", {
      sessionKey,
      provider: FIXTURE_REALTIME_PROVIDER_ID,
    });
    if (created.provider !== FIXTURE_REALTIME_PROVIDER_ID) {
      throw new Error(`Talk client used unexpected provider: ${JSON.stringify(created)}`);
    }
    const providerCalls = await readJsonLines(fixture.realtimeCallsPath);
    const tools = providerCalls[0]?.tools;
    if (
      !Array.isArray(tools) ||
      !tools.includes("openclaw_agent_consult") ||
      !tools.includes("openclaw_agent_control")
    ) {
      throw new Error(
        `Talk provider did not receive consult/control tools: ${JSON.stringify(tools)}`,
      );
    }
    const consultRequest = client.request("talk.client.toolCall", {
      sessionKey,
      callId: `qa-talk-${randomUUID()}`,
      name: "openclaw_agent_consult",
      args: { question: "final-only marker streaming qa check: inspect the active run" },
    });
    const steer = await waitForQueuedTalkSteer(client, sessionKey);
    assertControlResult(steer, { mode: "steer", active: true, queued: true });
    await waitForActiveTalkStatus(client, sessionKey);
    const followup = await client.request("talk.client.steer", {
      sessionKey,
      text: "also verify migration cleanup",
      mode: "followup",
    });
    assertControlResult(followup, { mode: "followup", active: true, queued: true });
    const cancel = await client.request("talk.client.steer", {
      sessionKey,
      text: "cancel",
      mode: "cancel",
    });
    assertControlResult(cancel, { mode: "cancel", active: true, aborted: true });
    await consultRequest;
    return `real Gateway pid=${gateway.pid ?? "unknown"}; persistent WebChat connection created Talk session and completed status, steer, follow-up, cancel RPCs`;
  } finally {
    client?.stop();
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    const details =
      options.scenarioId === "webchat-auto-tts"
        ? await runWebchatAutoTtsProof(options)
        : await runActiveTalkAgentRunProof(options);
    return { details, durationMs: Math.max(1, Date.now() - startedAt), status: "pass" };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runMediaTalkGatewayProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const scenario = SCENARIOS[options.scenarioId];
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${options.scenarioId}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: options.scenarioId,
      title: scenario.title,
      sourcePath: scenario.sourcePath,
      docsRefs: scenario.docsRefs,
      codeRefs: scenario.codeRefs,
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runMediaTalkGatewayProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Media/Talk Gateway evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Media/Talk Gateway status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
