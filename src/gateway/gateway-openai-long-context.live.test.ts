// Process-owned Gateway proof for first-class OpenAI Responses long-context compaction.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import {
  aggregateOpenAILongContextMetric,
  assertOpenAILongContextConfig,
  buildDenseContext,
  buildLongOutputPrompt,
  buildOpenAILongContextConfig,
  buildToolOutputFixture,
  observeOpenAICompactionState,
  readOpenAITransportReplayEvidence,
  readToolOutputEvidence,
  resolveOpenAILongContextLiveSettings,
  validateLongOutput,
  type LongOutputMarkers,
  type OpenAICompactionStateObservation,
  type OpenAILongContextAgentEvent,
  type OpenAILongContextProfile,
  type OpenAITransportReplayEvidence,
} from "../../test/helpers/openai-long-context-live.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const LIVE_ENABLED = isLiveTestEnabled();
const SETTINGS = resolveOpenAILongContextLiveSettings(process.env, LIVE_ENABLED);
const describeLive = SETTINGS.enabled ? describe : describe.skip;
const AGENT_ID = "long-context";
const SESSION_KEY = `agent:${AGENT_ID}:openai-long-context`;

type AgentMeta = {
  sessionId?: string;
  provider?: string;
  model?: string;
  contextTokens?: number;
  promptTokens?: number;
  compactionCount?: number;
  usage?: Usage;
  lastCallUsage?: Usage;
};

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type GatewayAgentResult = {
  meta?: {
    stopReason?: string;
    agentMeta?: AgentMeta;
  };
  payloads?: Array<{ text?: string }>;
};

type TurnResult = {
  text: string;
  events: OpenAILongContextAgentEvent[];
  elapsedMs: number;
  ttfaMs?: number;
  agentMeta: AgentMeta;
  stopReason?: string;
  transport: OpenAITransportReplayEvidence;
};

type SessionRow = {
  key?: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  effectiveFastMode?: boolean | "auto";
  effectiveFastModeSource?: string;
  agentRuntime?: { id?: string };
};

const instances: OpenClawTestInstance[] = [];
const clients: GatewayClient[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const client of clients.splice(0).toReversed()) {
    try {
      await client.stopAndWait({ timeoutMs: 2_000 });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const instance of instances.splice(0).toReversed()) {
    try {
      await instance.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "OpenAI long-context live cleanup failed");
  }
});

function requireSettings() {
  if (!SETTINGS.enabled) {
    throw new Error("OpenAI long-context live settings were not enabled");
  }
  return SETTINGS;
}

function asAgentEvent(event: EventFrame): OpenAILongContextAgentEvent | undefined {
  if (event.event !== "agent" || !event.payload || typeof event.payload !== "object") {
    return undefined;
  }
  const payload = event.payload as OpenAILongContextAgentEvent;
  return { ...payload, receivedAt: Date.now() };
}

function extractResultText(result: GatewayAgentResult): string {
  const payloadText = (result.payloads ?? [])
    .flatMap((payload) => (typeof payload.text === "string" ? [payload.text] : []))
    .join("\n")
    .trim();
  return payloadText || extractFirstTextBlock(result) || "";
}

function completedCompactionDuration(
  events: readonly OpenAILongContextAgentEvent[],
): number | undefined {
  let startedAt: number | undefined;
  let durationMs = 0;
  let count = 0;
  for (const event of events) {
    if (event.stream !== "compaction") {
      continue;
    }
    if (event.data?.phase === "start") {
      startedAt = event.ts ?? event.receivedAt;
      continue;
    }
    if (event.data?.phase === "end" && event.data?.completed === true && startedAt !== undefined) {
      durationMs += Math.max(0, (event.ts ?? event.receivedAt ?? startedAt) - startedAt);
      startedAt = undefined;
      count += 1;
    }
  }
  return count > 0 ? durationMs : undefined;
}

function emitMetric(params: {
  profile: OpenAILongContextProfile;
  phase: string;
  inputChars: number;
  result: TurnResult;
  compactionCount: number;
  restartLatencyMs?: number;
  markerStatus?: Record<string, boolean>;
}): void {
  if (!requireSettings().emitMetrics) {
    return;
  }
  const metric = aggregateOpenAILongContextMetric({
    profile: params.profile,
    phase: params.phase,
    inputChars: params.inputChars,
    elapsedMs: params.result.elapsedMs,
    ttfaMs: params.result.ttfaMs,
    agentMeta: params.result.agentMeta as Record<string, unknown>,
    serviceTier: params.result.transport.serviceTier,
    compactionCount: params.compactionCount,
    compactionDurationMs: completedCompactionDuration(params.result.events),
    restartLatencyMs: params.restartLatencyMs,
    markerStatus: params.markerStatus,
  });
  console.error(`[gateway-openai-long-context] ${JSON.stringify(metric)}`);
}

async function waitForTransportEvidence(params: {
  instance: OpenClawTestInstance;
  modelId: string;
  requestId: string;
}): Promise<OpenAITransportReplayEvidence> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  do {
    try {
      return readOpenAITransportReplayEvidence(
        params.instance.logs(),
        params.modelId,
        params.requestId,
      );
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function requestTurn(params: {
  client: GatewayClient;
  instance: OpenClawTestInstance;
  allEvents: OpenAILongContextAgentEvent[];
  profile: OpenAILongContextProfile;
  phase: string;
  message: string;
  sessionId: string;
  restartLatencyMs?: number;
  markers?: LongOutputMarkers;
}): Promise<TurnResult> {
  const eventOffset = params.allEvents.length;
  const startedAt = Date.now();
  const response = await params.client.request<{
    runId?: string;
    status?: string;
    result?: GatewayAgentResult;
  }>(
    "agent",
    {
      sessionKey: SESSION_KEY,
      idempotencyKey: `openai-long-context-${randomUUID()}`,
      message: params.message,
      deliver: false,
      thinking: "low",
      timeout: Math.ceil(params.profile.requestTimeoutMs / 1000),
    },
    { expectFinal: true, timeoutMs: params.profile.requestTimeoutMs + 30_000 },
  );
  if (response.status !== "ok" || !response.result) {
    throw new Error(`OpenAI long-context turn failed with status ${String(response.status)}`);
  }
  const elapsedMs = Date.now() - startedAt;
  const events = params.allEvents
    .slice(eventOffset)
    .filter((event) => !event.sessionKey || event.sessionKey === SESSION_KEY);
  const runId = response.runId ?? events.find((event) => event.runId)?.runId;
  if (!runId) {
    throw new Error(`OpenAI long-context ${params.phase} turn omitted its run id`);
  }
  const firstAssistant = events.find(
    (event) => event.stream === "assistant" && event.receivedAt !== undefined,
  );
  const ttfaMs = firstAssistant?.receivedAt
    ? Math.max(0, firstAssistant.receivedAt - startedAt)
    : undefined;
  const transport = await waitForTransportEvidence({
    instance: params.instance,
    modelId: params.profile.modelId,
    requestId: `${runId}:model:1`,
  });
  expect(transport.serviceTier).toBe("priority");
  expect(transport.contextManagement).toBe(true);
  const result: TurnResult = {
    text: extractResultText(response.result),
    events,
    elapsedMs,
    ...(ttfaMs !== undefined ? { ttfaMs } : {}),
    agentMeta: response.result.meta?.agentMeta ?? {},
    stopReason: response.result.meta?.stopReason,
    transport,
  };
  const state = observeOpenAICompactionState({
    agentId: AGENT_ID,
    sessionId: params.sessionId,
    sessionKey: SESSION_KEY,
    storePath: path.join(params.instance.state.agentDir(AGENT_ID), "openclaw-agent.sqlite"),
  });
  emitMetric({
    profile: params.profile,
    phase: params.phase,
    inputChars: params.message.length,
    result,
    compactionCount: state.activeCount,
    restartLatencyMs: params.restartLatencyMs,
    markerStatus: params.markers ? markerStatus(result.text, params.markers) : undefined,
  });
  return result;
}

async function readSessionRow(client: GatewayClient): Promise<SessionRow> {
  const result = await client.request<{ sessions?: SessionRow[] }>("sessions.list", {
    includeGlobal: true,
    limit: 100,
  });
  const row = result.sessions?.find((entry) => entry.key === SESSION_KEY);
  if (!row) {
    throw new Error(`sessions.list omitted ${SESSION_KEY}`);
  }
  return row;
}

async function assertSessionIdentity(
  client: GatewayClient,
  profile: OpenAILongContextProfile,
  sessionId: string,
): Promise<void> {
  const row = await readSessionRow(client);
  expect(row.sessionId).toBe(sessionId);
  expect(row.agentId).toBe(AGENT_ID);
  expect(row.modelProvider).toBe(profile.provider);
  expect(row.model).toBe(profile.modelId);
  expect(row.agentRuntime?.id).toBe(profile.runtime);
  expect(row.contextTokens).toBe(profile.contextTokens);
  expect(row.effectiveFastMode).toBe(true);
  expect(row.effectiveFastModeSource).toBe("config");
}

function markerStatus(text: string, markers: LongOutputMarkers): Record<string, boolean> {
  return {
    begin: text.includes(markers.begin),
    middle: text.includes(markers.middle),
    end: text.includes(markers.end),
  };
}

function expectAllMarkers(text: string, markers: LongOutputMarkers): void {
  expect(markerStatus(text, markers)).toEqual({ begin: true, middle: true, end: true });
}

function promptTokens(result: TurnResult): number | undefined {
  const direct = result.agentMeta.promptTokens;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const usage = result.agentMeta.lastCallUsage ?? result.agentMeta.usage;
  if (!usage) {
    return undefined;
  }
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return input + cacheRead + cacheWrite;
}

function assertReplayEgress(
  state: OpenAICompactionStateObservation,
  transport: OpenAITransportReplayEvidence,
): void {
  const latest = state.latest;
  if (!latest) {
    throw new Error("canonical state has no active OpenAI compaction replay item");
  }
  expect(transport.compactionItems).toBe(1);
  expect(transport.compactionPayloadHashes).toContain(latest.payloadHash);
  if (latest.idHash) {
    expect(transport.compactionIdHashes).toContain(latest.idHash);
  }
  const compactionIndex = transport.inputItemShape.indexOf("compaction");
  expect(compactionIndex).toBeGreaterThan(0);
  expect(transport.compactionInputIndexes).toEqual([compactionIndex]);
  expect(transport.inputItems).toBe(transport.inputItemShape.length);
  expect(
    transport.inputItemShape
      .slice(0, compactionIndex)
      .every((item) => /^message:(developer|system)$/u.test(item)),
  ).toBe(true);
  expect(transport.inputItemShape.at(-1)).toBe("message:user");
}

describeLive("Gateway OpenAI long-context compaction (live)", () => {
  it(
    "proves priority, server compaction replay, large I/O, metrics, markers, and restart continuity",
    async () => {
      const settings = requireSettings();
      const { profile } = settings;
      const instance = await createOpenClawTestInstance({
        name: `gateway-openai-long-context-${profile.name}`,
        env: {
          OPENAI_API_KEY: settings.apiKey,
          OPENAI_BASE_URL: undefined,
          OPENAI_API_BASE: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DEBUG_MODEL_PAYLOAD: "summary",
          OPENCLAW_LOG_LEVEL: "info",
        },
        startTimeoutMs: 120_000,
        stopTimeoutMs: 10_000,
      });
      instances.push(instance);
      const modelConfig = buildOpenAILongContextConfig({
        profile,
        workspace: instance.state.workspaceDir,
        agentId: AGENT_ID,
      });
      assertOpenAILongContextConfig(modelConfig, profile);
      const config: OpenClawConfig = {
        ...modelConfig,
        gateway: {
          mode: "local",
          port: instance.port,
          bind: "loopback",
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: false },
        },
      };
      assertOpenAILongContextConfig(config, profile);
      await instance.state.writeConfig(config);
      await instance.startGateway();

      const gatewayEvents: OpenAILongContextAgentEvent[] = [];
      const deviceIdentity = loadOrCreateDeviceIdentity({
        path: instance.state.path("operator-device.sqlite"),
      });
      let client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        deviceIdentity,
        requestTimeoutMs: profile.requestTimeoutMs + 30_000,
        timeoutMs: 60_000,
        clientDisplayName: "vitest-openai-long-context",
        onEvent: (event) => {
          const agentEvent = asAgentEvent(event as EventFrame);
          if (agentEvent) {
            gatewayEvents.push(agentEvent);
          }
        },
      });
      clients.push(client);

      const created = await client.request<{ key?: string; sessionId?: string }>(
        "sessions.create",
        {
          agentId: AGENT_ID,
          key: SESSION_KEY,
          model: profile.modelRef,
          thinkingLevel: "low",
          cwd: instance.state.workspaceDir,
        },
      );
      expect(created.key).toBe(SESSION_KEY);
      if (!created.sessionId) {
        throw new Error("sessions.create returned no durable session id");
      }
      const sessionId = created.sessionId;
      await assertSessionIdentity(client, profile, sessionId);

      const markers: LongOutputMarkers = {
        begin: `DURABLE-BEGIN-${randomUUID().toUpperCase()}`,
        middle: `DURABLE-MIDDLE-${randomUUID().toUpperCase()}`,
        end: `DURABLE-END-${randomUUID().toUpperCase()}`,
      };
      const seedMessage = [
        `Remember durable beginning marker ${markers.begin}.`,
        `Remember durable middle marker ${markers.middle}.`,
        `Remember durable end marker ${markers.end}.`,
        `Reply exactly ${markers.begin}|${markers.middle}|${markers.end}`,
      ].join("\n");
      const seeded = await requestTurn({
        client,
        instance,
        allEvents: gatewayEvents,
        profile,
        phase: "seed",
        message: seedMessage,
        sessionId,
        markers,
      });
      expectAllMarkers(seeded.text, markers);

      let peakPromptTokens = 0;
      let peakInputItems = 0;
      let compactionState: OpenAICompactionStateObservation | undefined;
      for (let turn = 1; turn <= profile.maxDenseTurns; turn += 1) {
        const denseMarker = `DENSE-${turn}-${randomUUID().toUpperCase()}`;
        const acknowledgement = `DENSE-${turn}-OK`;
        const message = `${buildDenseContext({ marker: denseMarker, chars: profile.denseTurnChars })}\nReply exactly ${acknowledgement}.`;
        const result = await requestTurn({
          client,
          instance,
          allEvents: gatewayEvents,
          profile,
          phase: `dense-${turn}`,
          message,
          sessionId,
        });
        expect(result.text).toContain(acknowledgement);
        peakPromptTokens = Math.max(peakPromptTokens, promptTokens(result) ?? 0);
        peakInputItems = Math.max(peakInputItems, result.transport.inputItems);
        const observed = observeOpenAICompactionState({
          agentId: AGENT_ID,
          sessionId,
          sessionKey: SESSION_KEY,
          storePath: path.join(instance.state.agentDir(AGENT_ID), "openclaw-agent.sqlite"),
        });
        if (observed.activeCount > 0) {
          compactionState = observed;
          break;
        }
      }
      if (!compactionState?.latest) {
        throw new Error(
          `OpenAI emitted no first-class compaction item after ${profile.maxDenseTurns} dense turns`,
        );
      }
      expect(compactionState.latest).toMatchObject({
        type: "openai-responses-compaction",
        provider: "openai",
        api: "openai-responses",
        model: profile.modelId,
      });
      if (profile.name === "full") {
        expect(peakPromptTokens).toBeGreaterThan(272_000);
      }

      const beforeReplay = compactionState;
      const recallPrompt =
        "Reply with the durable beginning, middle, and end markers in that order, separated by |, and nothing else.";
      const replayed = await requestTurn({
        client,
        instance,
        allEvents: gatewayEvents,
        profile,
        phase: "first-replay",
        message: recallPrompt,
        sessionId,
        markers,
      });
      assertReplayEgress(beforeReplay, replayed.transport);
      expectAllMarkers(replayed.text, markers);
      const replayPromptTokens = promptTokens(replayed);
      if (replayPromptTokens === undefined || peakPromptTokens === 0 || peakInputItems === 0) {
        throw new Error("provider prompt/context pressure was unavailable after compaction");
      }
      expect(replayed.transport.inputItems).toBeLessThan(peakInputItems);
      expect(replayed.transport.compactionInputIndexes.length).toBeGreaterThan(0);

      const history = await client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: SESSION_KEY,
        limit: 10,
      });
      expect(JSON.stringify(history)).not.toContain("providerReplay");

      if (settings.runLongOutput) {
        const outputMarkers: LongOutputMarkers = {
          begin: `OUTPUT-BEGIN-${randomUUID().toUpperCase()}`,
          middle: `OUTPUT-MIDDLE-${randomUUID().toUpperCase()}`,
          end: `OUTPUT-END-${randomUUID().toUpperCase()}`,
        };
        const outputPrompt = buildLongOutputPrompt(outputMarkers);
        const output = await requestTurn({
          client,
          instance,
          allEvents: gatewayEvents,
          profile,
          phase: "bounded-long-output",
          message: outputPrompt,
          sessionId,
          markers: outputMarkers,
        });
        const outputTokens =
          output.agentMeta.lastCallUsage?.output ?? output.agentMeta.usage?.output;
        if (outputTokens === undefined) {
          throw new Error("bounded long-output turn returned no provider output tokens");
        }
        validateLongOutput({
          text: output.text,
          markers: outputMarkers,
          outputTokens,
          stopReason: output.stopReason,
        });
      }

      if (settings.runToolOutput) {
        const toolPath = ".openclaw/tmp/openai-long-context-tool-output.txt";
        const toolMarker = `TOOL-OUTPUT-${randomUUID().toUpperCase()}`;
        const fixture = buildToolOutputFixture({
          marker: toolMarker,
          bytes: settings.toolOutputBytes,
        });
        const absoluteToolPath = path.join(instance.state.workspaceDir, toolPath);
        await fs.mkdir(path.dirname(absoluteToolPath), { recursive: true });
        await fs.writeFile(absoluteToolPath, fixture.content, "utf8");
        const toolPrompt = [
          `Call the read tool exactly once with path=${toolPath}.`,
          "Do not set offset or limit and do not use exec.",
          "The file's first line begins with a random marker followed by |BEGIN|000000.",
          "After the read result returns, reply with exactly that random marker and nothing else.",
        ].join("\n");
        const toolTurn = await requestTurn({
          client,
          instance,
          allEvents: gatewayEvents,
          profile,
          phase: "large-tool-output",
          message: toolPrompt,
          sessionId,
        });
        expect(toolTurn.text).toContain(toolMarker);
        const toolEvidence = readToolOutputEvidence({
          events: toolTurn.events,
          expectedPath: toolPath,
          expectedMarker: toolMarker,
          expectedBytes: fixture.bytes,
          fixtureHash: fixture.sha256,
        });
        expect(toolEvidence.originalBytes).toBe(settings.toolOutputBytes);
      }

      const recalled = await requestTurn({
        client,
        instance,
        allEvents: gatewayEvents,
        profile,
        phase: "marker-recall",
        message: recallPrompt,
        sessionId,
        markers,
      });
      expectAllMarkers(recalled.text, markers);

      const beforeRestart = observeOpenAICompactionState({
        agentId: AGENT_ID,
        sessionId,
        sessionKey: SESSION_KEY,
        storePath: path.join(instance.state.agentDir(AGENT_ID), "openclaw-agent.sqlite"),
      });
      expect(beforeRestart.activeCount).toBeGreaterThan(0);
      await client.stopAndWait({ timeoutMs: 5_000 });
      clients.splice(clients.indexOf(client), 1);
      const restartStartedAt = Date.now();
      await instance.stopGateway();
      await instance.startGateway();
      const restartLatencyMs = Date.now() - restartStartedAt;
      client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        deviceIdentity,
        requestTimeoutMs: profile.requestTimeoutMs + 30_000,
        timeoutMs: 60_000,
        clientDisplayName: "vitest-openai-long-context-restart",
        onEvent: (event) => {
          const agentEvent = asAgentEvent(event as EventFrame);
          if (agentEvent) {
            gatewayEvents.push(agentEvent);
          }
        },
      });
      clients.push(client);
      await assertSessionIdentity(client, profile, sessionId);
      const afterRestart = observeOpenAICompactionState({
        agentId: AGENT_ID,
        sessionId,
        sessionKey: SESSION_KEY,
        storePath: path.join(instance.state.agentDir(AGENT_ID), "openclaw-agent.sqlite"),
      });
      expect(afterRestart).toEqual(beforeRestart);

      const postRestart = await requestTurn({
        client,
        instance,
        allEvents: gatewayEvents,
        profile,
        phase: "post-restart",
        message: recallPrompt,
        sessionId,
        restartLatencyMs,
        markers,
      });
      assertReplayEgress(afterRestart, postRestart.transport);
      expectAllMarkers(postRestart.text, markers);
      expect(postRestart.agentMeta.provider).toBe("openai");
      expect(postRestart.agentMeta.model).toBe(profile.modelId);
    },
    SETTINGS.enabled ? SETTINGS.profile.suiteTimeoutMs : 60_000,
  );
});
