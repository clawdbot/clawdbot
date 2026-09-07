import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// QA Lab producer exercises speech delivery and Talk run control through a real Gateway.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  QA_EVIDENCE_FILENAME,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
  type QaEvidenceSummaryJson,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { GatewayClient, type GatewayClientOptions } from "../../../../src/gateway/client.js";
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import type { DiagnosticStabilitySnapshot } from "../../../../src/logging/diagnostic-stability.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../../src/utils/message-channel.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const FIXTURE_PLUGIN_ID = "qa-media-talk-runtime";
const FIXTURE_SPEECH_PROVIDER_ID = "qa-speech";
const FIXTURE_REALTIME_PROVIDER_ID = "qa-realtime";
const FIXTURE_WAV_BASE64 =
  "UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/media-talk-gateway.ts";
const CODEX_TTS_MODEL_REF = "openai/gpt-5.6-luna";

type ScenarioId = keyof typeof SCENARIOS;

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
    run: runWebchatAutoTtsProof,
    sourcePath: "qa/scenarios/media/webchat-auto-tts.yaml",
    docsRefs: ["docs/tools/tts.md", "docs/tools/media-overview.md"],
    codeRefs: [
      SOURCE_PATH,
      "src/tts/runtime-api.ts",
      "src/gateway/managed-image-attachments.ts",
      "src/gateway/server-methods/artifacts.ts",
    ],
  },
  "codex-inbound-message-auto-tts": {
    title: "Codex inbound-audio message TTS delivery",
    run: runCodexInboundMessageAutoTtsProof,
    sourcePath: "qa/scenarios/media/codex-inbound-message-auto-tts.yaml",
    docsRefs: ["docs/tools/tts.md", "docs/channels/qa-channel.md"],
    codeRefs: [
      SOURCE_PATH,
      "src/agents/embedded-agent-runner/run/attempt-tool-run-context.ts",
      "extensions/codex/src/app-server/dynamic-tool-build.ts",
      "src/infra/outbound/message-action-tts.ts",
    ],
  },
  "active-talk-agent-run-status": {
    title: "Active Talk agent-run control boundaries",
    run: runActiveTalkAgentRunProof,
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

function findAudioAttachment(value: unknown) {
  return collectRecords(value).find(
    (record) =>
      (record.type === "audio" || record.kind === "audio") &&
      typeof record.url === "string" &&
      record.url.length > 0,
  );
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
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
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
    const attachment = findAudioAttachment(params.events) ?? findAudioAttachment(history);
    if (attachment) {
      return { attachment, history };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return { attachment: undefined, history };
}

async function runWebchatAutoTtsProof(options: ProducerOptions): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webchat-tts-"));
  const fixture = await createFixturePlugin(fixtureRoot);
  const mock = await startQaMockOpenAiServer();
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;
  let client: GatewayClient | undefined;
  const events: Array<{ event: string; payload?: unknown }> = [];
  try {
    gateway = await gatewayOwner.start({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: true,
      runtimeEnvPatch: {
        OPENCLAW_QA_SPEECH_CALLS_PATH: fixture.speechCallsPath,
        OPENCLAW_QA_REALTIME_CALLS_PATH: fixture.realtimeCallsPath,
        OPENCLAW_TTS_PREFS: path.join(fixtureRoot, "tts-prefs.json"),
      },
      mutateConfig: (config) => {
        const withPlugin = withFixturePlugin(config, fixture.pluginDir);
        return {
          ...withPlugin,
          tts: {
            ...withPlugin.tts,
            auto: "always",
            mode: "final",
            provider: FIXTURE_SPEECH_PROVIDER_ID,
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
    const { attachment, history } = await waitForWebchatAudio({ client, events, sessionKey });
    if (!attachment) {
      const speechCalls = await readJsonLines(fixture.speechCallsPath);
      throw new Error(
        `WebChat history did not contain an audio attachment; speech=${JSON.stringify(speechCalls)}; gateway=${gateway.logs()}; history=${JSON.stringify(history)}`,
      );
    }
    const speechCalls = await readJsonLines(fixture.speechCallsPath);
    if (speechCalls.length !== 1) {
      throw new Error(`expected one final-tail TTS synthesis, received ${speechCalls.length}`);
    }
    const artifactId = attachment.artifactId;
    const source = attachment.url;
    if (typeof artifactId !== "string" || typeof source !== "string") {
      throw new Error(`WebChat audio attachment was not managed: ${JSON.stringify(attachment)}`);
    }
    const download = await client.request<{ url?: string }>("artifacts.download", {
      sessionKey,
      artifactId,
    });
    if (!download.url?.includes("mediaTicket=")) {
      throw new Error(
        `artifact download did not mint a scoped ticket: ${JSON.stringify(download)}`,
      );
    }
    const sourceUrl = new URL(source, gateway.baseUrl);
    const withoutTicket = await fetch(sourceUrl);
    if (withoutTicket.status !== 401) {
      throw new Error(`media route without ticket returned ${withoutTicket.status}, expected 401`);
    }
    const ticketed = await fetch(new URL(download.url, gateway.baseUrl));
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
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
    await mock.stop();
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function runCodexInboundMessageAutoTtsProof(options: ProducerOptions): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-inbound-tts-"));
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const gatewayOwner = createQaGatewayChild();
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  let details = "";
  await runQaGatewayFixture(
    async () => {
      const fixture = await createFixturePlugin(fixtureRoot);
      bus = await startQaBusServer({ state });
      mock = await startQaMockOpenAiServer({ modelRefs: [CODEX_TTS_MODEL_REF] });
      const mockBaseUrl = mock.baseUrl;
      const providerBaseUrl = `${mockBaseUrl}/v1`;
      const gateway = await gatewayOwner.start({
        repoRoot: options.repoRoot,
        forcedRuntime: "codex",
        providerMode: "mock-openai",
        providerBaseUrl,
        primaryModel: CODEX_TTS_MODEL_REF,
        alternateModel: CODEX_TTS_MODEL_REF,
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_QA_SPEECH_CALLS_PATH: fixture.speechCallsPath,
          OPENCLAW_TTS_PREFS: path.join(fixtureRoot, "tts-prefs.json"),
        },
        mutateConfig: (config) => {
          const withPlugin = withFixturePlugin(config, fixture.pluginDir);
          return {
            ...withPlugin,
            messages: { ...withPlugin.messages, visibleReplies: "message_tool" },
            tools: {
              ...withPlugin.tools,
              alsoAllow: ["message"],
              // The ingress media fact must survive without an STT request.
              media: { audio: { enabled: false } },
            },
            tts: {
              auto: "inbound",
              mode: "final",
              provider: FIXTURE_SPEECH_PROVIDER_ID,
              // A broken fixture must never fall back to an external speech endpoint.
              providers: { openai: { baseUrl: providerBaseUrl } },
            },
          };
        },
      });
      await transport.waitReady({ gateway });
      const readRequests = async () => {
        const response = await fetch(`${mockBaseUrl}/debug/requests`);
        assert.equal(response.status, 200, "mock request evidence must remain available");
        return (await response.json()) as MockOpenAiRequestSnapshot[];
      };
      const conversation = { id: "codex-inbound-tts", kind: "direct" as const };
      const expectedText = "QA-MESSAGE-DELIVERY-OK";
      // The audit fixture authors both message text and additive presentation text.
      const expectedBody = `${expectedText}\n\n${expectedText}`;
      let previousRunId: string | undefined;
      for (const inboundAudio of [true, false]) {
        const beforeRequests = await readRequests();
        const requestCursor = beforeRequests.at(-1)?.cursor ?? 0;
        const sinceIndex = state
          .getSnapshot()
          .messages.filter((m) => m.direction === "outbound").length;
        const beforeSpeech = (await readJsonLines(fixture.speechCallsPath)).length;
        await transport.sendInbound({
          conversation,
          senderId: conversation.id,
          text: `message delivery decision send qa check: ${inboundAudio ? "audio" : "text"} turn`,
          ...(inboundAudio
            ? {
                attachments: [
                  {
                    id: "synthetic-voice-note",
                    kind: "audio" as const,
                    mimeType: "audio/wav",
                    fileName: "voice-note.wav",
                    contentBase64: FIXTURE_WAV_BASE64,
                  },
                ],
              }
            : {}),
        });
        const outbound = await transport.waitForOutbound({
          conversation,
          sinceIndex,
          textIncludes: expectedText,
          timeoutMs: 60_000,
        });
        // Wait for this admitted turn to finish before testing the next ingress.
        // Sending on message delivery alone could accidentally exercise steering.
        const session = await transport.waitForCondition(async () => {
          const result = (await gateway.call("sessions.list", { limit: 20 })) as SessionsListResult;
          const row = result.sessions.find((entry) => entry.lastChannel === transport.id);
          return row &&
            !row.hasActiveRun &&
            row.status === "done" &&
            row.lastRunId &&
            row.lastRunId !== previousRunId
            ? row
            : undefined;
        }, 60_000);
        assert.equal(session.agentRuntime?.id, "codex", "the real Codex runtime must own the turn");
        assert.equal(session.status, "done");
        assert.ok(session.lastRunId, "the completed turn must have an owner-recorded run ID");
        assert.notEqual(session.lastRunId, previousRunId, "each ingress must complete a fresh run");
        assert.ok(!session.lastRunError);
        assert.notEqual(session.abortedLastRun, true);
        previousRunId = session.lastRunId;
        const requests = (await readRequests()).filter((request) => request.cursor > requestCursor);
        const sends = requests.filter((request) => request.plannedToolName === "message");
        assert.equal(sends.length, 1, "one dynamic message tool must deliver the reply");
        const send = sends[0];
        assert.ok(send?.plannedToolCallId, "the mock must record the dynamic call identity");
        assert.equal(send.plannedToolArgs?.action, "send");
        assert.equal(send.plannedToolArgs?.final, true);
        assert.equal(send.plannedToolArgs?.voiceText, undefined, "speech must be automatic");
        assert.equal(send.plannedToolArgs?.asVoice, undefined, "speech must not be forced");
        // Final source delivery closes the native turn after its tool response;
        // it does not require another provider request carrying that result.
        const history = await gateway.call("chat.history", { sessionKey: session.key, limit: 20 });
        assert.ok(
          collectRecords(history).some(
            (record) =>
              record.role === "toolResult" &&
              record.toolCallId === send.plannedToolCallId &&
              record.toolName === "message" &&
              record.isError === false,
          ),
          "the Gateway must record the successful dynamic message tool result",
        );
        assert.equal(
          state.getSnapshot().messages.filter((message) => message.direction === "outbound")
            .length - sinceIndex,
          1,
          "the admitted turn must deliver exactly one visible reply",
        );
        assert.equal(outbound.text, expectedBody);
        const attachments = outbound.attachments ?? [];
        assert.equal(
          attachments.length,
          inboundAudio ? 1 : 0,
          `${inboundAudio ? "audio" : "text"} ingress must control automatic speech delivery`,
        );
        const speechCalls = await readJsonLines(fixture.speechCallsPath);
        assert.equal(speechCalls.length - beforeSpeech, inboundAudio ? 1 : 0);
        if (inboundAudio) {
          assert.equal(attachments[0]?.kind, "audio");
          assert.equal(attachments[0]?.mimeType, "audio/wav");
          assert.equal(attachments[0]?.contentBase64, FIXTURE_WAV_BASE64);
          assert.equal(speechCalls.at(-1)?.text, expectedText);
        }
      }
      details = `real Codex app-server and Gateway pid=${gateway.pid ?? "unknown"}; two final message tool replies; audio ingress synthesized and delivered exact WAV bytes; subsequent text ingress stayed text-only; syntheses=1`;
    },
    () => stopQaGatewayFixture(gatewayOwner),
    () => mock?.stop(),
    () => bus?.stop(),
    () => fs.rm(fixtureRoot, { force: true, recursive: true }),
  );
  return details;
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
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("timed out waiting for active Talk run");
}

async function waitForQueuedTalkSteer(client: GatewayClient, sessionKey: string) {
  const deadline = Date.now() + 20_000;
  let lastResult: unknown;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastResult = await client.request("talk.client.steer", {
        sessionKey,
        text: "use the safer path",
        mode: "steer",
      });
      lastError = undefined;
      if (
        lastResult &&
        typeof lastResult === "object" &&
        (lastResult as Record<string, unknown>).queued === true
      ) {
        return lastResult;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`timed out waiting for steerable Talk run: ${JSON.stringify(lastResult)}`);
}

async function runActiveTalkAgentRunProof(options: ProducerOptions): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-talk-"));
  const fixture = await createFixturePlugin(fixtureRoot);
  const mock = await startQaMockOpenAiServer({ finalOnlyMarkerPauseMs: 60_000 });
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;
  let client: GatewayClient | undefined;
  try {
    gateway = await gatewayOwner.start({
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
    const created = await client.request("talk.client.create", {
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
    // A failed control step can end the scenario before this long-lived request
    // is awaited; observe rejection immediately so cleanup cannot mask the cause.
    void consultRequest.catch(() => undefined);
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
    client.stop();
    client = undefined;
    const queuedDiagnostics = (await gateway.call("diagnostics.stability", {
      type: "message.queued",
      limit: 20,
    })) as DiagnosticStabilitySnapshot;
    const steeringQueueDepths = queuedDiagnostics.events
      .filter((event) => event.source === "embedded-agent-runner")
      .map((event) => event.queueDepth);
    if (JSON.stringify(steeringQueueDepths) !== JSON.stringify([1, 1])) {
      throw new Error(
        `active-run steering changed diagnostic backlog: ${JSON.stringify(queuedDiagnostics.events)}`,
      );
    }
    const stateDiagnostics = (await gateway.call("diagnostics.stability", {
      type: "session.state",
      limit: 20,
    })) as DiagnosticStabilitySnapshot;
    const finalState = stateDiagnostics.events.at(-1);
    if (finalState?.outcome !== "idle" || finalState.queueDepth !== 0) {
      throw new Error(
        `Talk run did not finish with empty diagnostic backlog: ${JSON.stringify(stateDiagnostics.events)}`,
      );
    }
    return `real Gateway pid=${gateway.pid ?? "unknown"}; persistent WebChat connection completed status, steer, follow-up, cancel RPCs; steeringQueueDepths=${steeringQueueDepths.join(",")}; finalState=${finalState.outcome}; finalQueueDepth=${finalState.queueDepth}`;
  } finally {
    client?.stop();
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
    await mock.stop();
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    const details = await SCENARIOS[options.scenarioId].run(options);
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
    primaryModel:
      options.scenarioId === "codex-inbound-message-auto-tts"
        ? CODEX_TTS_MODEL_REF
        : "mock-openai/gpt-5.6-luna",
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
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
