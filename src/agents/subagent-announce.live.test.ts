import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  type OpenClawConfig,
} from "../config/config.js";
import { callGateway as realCallGateway } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { dispatchGatewayMethodInProcess as realDispatchGatewayMethodInProcess } from "../gateway/server-plugins.js";
import { startGatewayServer, type GatewayServer } from "../gateway/server.js";
import { extractPayloadText } from "../gateway/test-helpers.agent-results.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { testing as subagentAnnounceDeliveryTesting } from "./subagent-announce-delivery.js";
import { testing as subagentAnnounceTesting } from "./subagent-announce.js";
import { resolveSubagentController, steerControlledSubagentRun } from "./subagent-control.js";
import { listSubagentRunsForRequester } from "./subagent-registry.js";

const LIVE = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_E2E);
const describeLive = LIVE ? describe : describe.skip;

type AgentPayload = {
  status?: string;
  result?: unknown;
};

type InProcessAgentDispatch =
  | { phase: "started"; resultText?: undefined }
  | { phase: "completed"; resultText: string };

const REQUEST_TIMEOUT_MS = 8 * 60_000;
const WAIT_TIMEOUT_MS = 8 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type LiveSubagentModelConfig = {
  modelKey: string;
  provider: "openai" | "google";
  requiredEnv: "OPENAI_API_KEY" | "GEMINI_API_KEY" | "GOOGLE_API_KEY";
};
type LiveSubagentModelProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

function resolveLiveSubagentModelConfig(): LiveSubagentModelConfig {
  const modelKey = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.5";
  if (modelKey.startsWith("google/")) {
    return {
      modelKey,
      provider: "google",
      requiredEnv: process.env.GEMINI_API_KEY?.trim() ? "GEMINI_API_KEY" : "GOOGLE_API_KEY",
    };
  }
  return { modelKey, provider: "openai", requiredEnv: "OPENAI_API_KEY" };
}

function requireLiveSubagentAuth(config: LiveSubagentModelConfig): void {
  expect(process.env[config.requiredEnv]?.trim(), config.requiredEnv).toBeTruthy();
}

function liveSubagentConfig(
  modelKey: string,
  workspace: string,
  port: number,
  token: string,
  options?: {
    queue?: NonNullable<OpenClawConfig["messages"]>["queue"];
    toolAllow?: string[];
  },
): OpenClawConfig {
  const providerConfig = resolveLiveSubagentModelConfig();
  const modelId = modelKey.replace(/^(openai|google)\//u, "");
  const providers: LiveSubagentModelProviders = {};
  if (providerConfig.provider === "google") {
    providers.google = {
      api: "google-generative-ai" as const,
      agentRuntime: { id: "openclaw" },
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: {
        source: "env" as const,
        provider: "default" as const,
        id: providerConfig.requiredEnv,
      },
      timeoutSeconds: 300,
      models: [
        {
          id: modelId,
          name: modelId,
          api: "google-generative-ai" as const,
          agentRuntime: { id: "openclaw" },
          input: ["text" as const],
          reasoning: true,
          contextWindow: 1_048_576,
          maxTokens: 8_192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  } else {
    providers.openai = {
      api: "openai-responses" as const,
      agentRuntime: { id: "openclaw" },
      apiKey: {
        source: "env" as const,
        provider: "default" as const,
        id: "OPENAI_API_KEY",
      },
      baseUrl: "https://api.openai.com/v1",
      timeoutSeconds: 300,
      models: [
        {
          id: modelId,
          name: modelId,
          api: "openai-responses" as const,
          agentRuntime: { id: "openclaw" },
          input: ["text" as const],
          reasoning: true,
          contextWindow: 1_047_576,
          maxTokens: 8_192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }
  return {
    gateway: {
      mode: "local",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    plugins: { enabled: false },
    tools: { allow: options?.toolAllow ?? ["sessions_spawn", "sessions_yield", "subagents"] },
    ...(options?.queue ? { messages: { queue: options.queue } } : {}),
    models: {
      providers,
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: modelKey },
        models: { [modelKey]: { agentRuntime: { id: "openclaw" }, params: { maxTokens: 1024 } } },
        sandbox: { mode: "off" },
        subagents: {
          allowAgents: ["*"],
          runTimeoutSeconds: 300,
          announceTimeoutMs: 300_000,
          archiveAfterMinutes: 60,
        },
      },
    },
  };
}

async function waitFor<T>(
  label: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  const started = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - started < timeoutMs) {
    lastValue = await fn();
    if (lastValue !== undefined) {
      return lastValue;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function summarizeSubagentRuns(runs: ReturnType<typeof listSubagentRunsForRequester>): string {
  return JSON.stringify(
    runs.map((run) => ({
      runId: run.runId,
      taskName: run.taskName,
      ended: typeof run.endedAt === "number",
      endedReason: run.endedReason,
      pauseReason: run.pauseReason,
      outcome: run.outcome?.status,
      outcomeError: run.outcome?.status === "error" ? run.outcome.error : undefined,
      delivery: run.delivery?.status,
      deliveryError: run.delivery?.lastError,
      suppressAnnounceReason: run.suppressAnnounceReason,
      resultText: run.completion?.resultText?.slice(0, 200),
    })),
  );
}

function summarizeAgentEvents(events: AgentEventPayload[], runId: string): string {
  return JSON.stringify(
    events
      .filter((event) => event.runId === runId)
      .slice(-20)
      .map((event) => ({
        stream: event.stream,
        phase: event.data.phase,
        name: event.data.name,
        toolCallId: event.data.toolCallId,
        isError: event.data.isError,
      })),
  );
}

function isBashToolEventName(value: unknown): boolean {
  return value === "bash" || value === "exec";
}

function createGatewayClient(params: {
  port: number;
  token: string;
  onEvent?: ConstructorParameters<typeof GatewayClient>[0]["onEvent"];
}): Promise<GatewayClient> {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${params.port}`,
      token: params.token,
      deviceIdentity: null,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin"],
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: params.onEvent,
      onHelloOk: () => resolve(client),
      onConnectError: reject,
    });
    client.start();
  });
}

describeLive("subagent announce live", () => {
  let state: OpenClawTestState | undefined;
  let server: GatewayServer | undefined;
  let client: GatewayClient | undefined;
  let stopAgentEventCapture: (() => void) | undefined;

  afterEach(async () => {
    stopAgentEventCapture?.();
    stopAgentEventCapture = undefined;
    subagentAnnounceTesting.setDepsForTest();
    subagentAnnounceDeliveryTesting.setDepsForTest();
    await client?.stopAndWait().catch(() => undefined);
    await server?.close({ reason: "subagent announce live test done" }).catch(() => undefined);
    await state?.cleanup().catch(() => undefined);
    clearRuntimeConfigSnapshot();
    clearCurrentPluginMetadataSnapshot();
    client = undefined;
    server = undefined;
    state = undefined;
  });

  it(
    "keeps issue 82913 busy-parent completion announce pending until transcript delivery",
    async () => {
      if (!isTruthyEnvValue(process.env.OPENCLAW_SUBAGENT_ISSUE_82913_REPRO)) {
        console.warn(
          "[issue-82913] skip: set OPENCLAW_SUBAGENT_ISSUE_82913_REPRO=1 to run this focused repro",
        );
        return;
      }
      const modelConfig = resolveLiveSubagentModelConfig();
      requireLiveSubagentAuth(modelConfig);

      const token = `subagent-82913-${randomUUID()}`;
      const port = 30_000 + Math.floor(Math.random() * 10_000);
      const modelKey = modelConfig.modelKey;
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const childToken = `ISSUE_82913_CHILD_${nonce}`;
      const parentToken = `ISSUE_82913_PARENT_SAW_${nonce}`;
      const sessionKey = `agent:main:issue-82913-${nonce.toLowerCase()}`;

      state = await createOpenClawTestState({
        label: "subagent-issue-82913-live",
        layout: "split",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
          OPENCLAW_PLUGINS_PATHS: undefined,
        },
      });
      await state.writeConfig(
        liveSubagentConfig(modelKey, state.workspaceDir, port, token, {
          queue: { mode: "collect", debounceMs: 2_500 },
          toolAllow: ["sessions_spawn", "bash"],
        }),
      );
      clearRuntimeConfigSnapshot();
      clearCurrentPluginMetadataSnapshot();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      client = await createGatewayClient({ port, token });

      let initialError: unknown;
      let parentObservedAt: number | undefined;
      let parentText: string | undefined;
      const initialRequest = client.request<AgentPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `issue-82913-${randomUUID()}`,
          deliver: false,
          timeout: 240,
          message: [
            "Run this exact OpenClaw busy-parent subagent scenario. Use tool calls, not prose.",
            `Use nonce ${nonce}.`,
            `Step 1: call sessions_spawn with exactly this JSON input: ${JSON.stringify({
              task: `Reply exactly ${childToken} and nothing else.`,
              taskName: "issue_82913_child",
              cleanup: "keep",
              context: "isolated",
              runTimeoutSeconds: 180,
            })}.`,
            'Step 2: after spawn returns status="accepted", immediately call the bash tool with command exactly: sleep 35; printf ISSUE_82913_PARENT_TOOL_DONE.',
            "Do not call sessions_yield at any point in this scenario.",
            `Step 3: after the child completion event is visible in your conversation, reply exactly ${parentToken}.`,
            `Do not reply with ${parentToken} before the child completion event is visible.`,
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      initialRequest
        .then((response) => {
          parentObservedAt = Date.now();
          parentText = extractPayloadText(response.result);
        })
        .catch((error: unknown) => {
          initialError = error;
        });

      const completedRunBeforeDelivery = await waitFor("issue 82913 child completion", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        return listSubagentRunsForRequester(sessionKey).find(
          (run) =>
            run.taskName === "issue_82913_child" &&
            run.completion?.resultText?.includes(childToken) === true &&
            run.outcome?.status === "ok",
        );
      });
      expect(completedRunBeforeDelivery.delivery?.announcedAt).toBeUndefined();
      expect(parentObservedAt).toBeUndefined();

      const parent = await initialRequest;
      parentObservedAt ??= Date.now();
      parentText ??= extractPayloadText(parent.result);
      expect(parentText).toContain(parentToken);

      const completedRun = await waitFor("issue 82913 delivered completion announce", () =>
        listSubagentRunsForRequester(sessionKey).find(
          (run) =>
            run.runId === completedRunBeforeDelivery.runId &&
            typeof run.delivery?.enqueuedAt === "number" &&
            typeof run.delivery?.deliveredAt === "number" &&
            typeof run.delivery?.announcedAt === "number",
        ),
      );
      const enqueuedAt = completedRun.delivery?.enqueuedAt ?? 0;
      const deliveredAt = completedRun.delivery?.deliveredAt ?? 0;
      const announcedAt = completedRun.delivery?.announcedAt ?? 0;
      const enqueuedToDeliveredMs = deliveredAt - enqueuedAt;
      const announcedToParentObservedMs = Math.abs(parentObservedAt - announcedAt);
      console.log(
        `[issue-82913] repro ${JSON.stringify({
          runId: completedRun.runId,
          childEndedAt: completedRun.endedAt,
          completionEnqueuedAt: enqueuedAt,
          completionDeliveredAt: deliveredAt,
          completionAnnouncedAt: announcedAt,
          parentObservedAt,
          enqueuedToDeliveredMs,
          announcedToParentObservedMs,
        })}`,
      );
      expect(completedRun.delivery?.announcedAt).toBe(deliveredAt);
      expect(enqueuedToDeliveredMs).toBeGreaterThan(10_000);
      expect(announcedToParentObservedMs).toBeLessThan(20_000);
    },
    10 * 60_000,
  );

  it(
    "lets a parent steer an active subagent and receives completion through in-process agent dispatch",
    async () => {
      const modelConfig = resolveLiveSubagentModelConfig();
      requireLiveSubagentAuth(modelConfig);

      const token = `subagent-live-${randomUUID()}`;
      const port = 30_000 + Math.floor(Math.random() * 10_000);
      const modelKey = modelConfig.modelKey;
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const childToken = `CHILD_STEERED_${nonce}`;
      const unsteeredToken = `UNSTEERED_${nonce}`;
      const parentToken = `PARENT_SAW_${childToken}`;
      const parentStartedToken = `PARENT_READY_${nonce}`;
      const steerToken = `STEER_${nonce}`;
      const steerMessage = [
        `${steerToken} has arrived.`,
        "Stop waiting and do not call any tools.",
        `Reply exactly ${childToken} and nothing else.`,
      ].join(" ");
      const childTask = [
        `Immediately call the bash tool with exactly this JSON input: ${JSON.stringify({
          command: `sleep 60; printf ${unsteeredToken}`,
          yieldMs: 120_000,
        })}.`,
        "Do not reply directly before that bash command finishes.",
        `Do not reply with ${childToken} before receiving ${steerToken}.`,
        `After receiving ${steerToken}, reply exactly ${childToken} and nothing else.`,
      ].join(" ");
      const sessionKey = `agent:main:live-subagent-${nonce.toLowerCase()}`;
      const inProcessAgentDispatches: InProcessAgentDispatch[] = [];
      const agentEvents: AgentEventPayload[] = [];
      stopAgentEventCapture = onAgentEvent((event) => {
        agentEvents.push(event);
      });

      const forbiddenAgentRpc: typeof realCallGateway = async (request) => {
        if (request.method === "agent") {
          throw new Error("subagent announce live test forbids gateway RPC method=agent");
        }
        return await realCallGateway(request);
      };
      const instrumentedDispatch: typeof realDispatchGatewayMethodInProcess = async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: Parameters<typeof realDispatchGatewayMethodInProcess>[2],
      ): Promise<T> => {
        if (method === "agent") {
          inProcessAgentDispatches.push({ phase: "started" });
        }
        const result = await realDispatchGatewayMethodInProcess<T>(method, params, options);
        if (method === "agent") {
          inProcessAgentDispatches.push({
            phase: "completed",
            resultText: extractPayloadText((result as AgentPayload).result),
          });
        }
        return result;
      };

      subagentAnnounceTesting.setDepsForTest({
        callGateway: forbiddenAgentRpc,
        dispatchGatewayMethodInProcess: instrumentedDispatch,
      });
      subagentAnnounceDeliveryTesting.setDepsForTest({
        callGateway: forbiddenAgentRpc,
        dispatchGatewayMethodInProcess: instrumentedDispatch,
        getRequesterSessionActivity: () => ({
          sessionId: "requester-session-local",
          isActive: false,
        }),
      });

      state = await createOpenClawTestState({
        label: "subagent-announce-live",
        layout: "split",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
          OPENCLAW_PLUGINS_PATHS: undefined,
        },
      });
      await state.writeConfig(
        liveSubagentConfig(modelKey, state.workspaceDir, port, token, {
          toolAllow: ["sessions_spawn", "bash"],
        }),
      );
      clearRuntimeConfigSnapshot();
      clearCurrentPluginMetadataSnapshot();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      client = await createGatewayClient({ port, token });

      let initialError: unknown;
      const initialRequest = client.request<AgentPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `live-subagent-${randomUUID()}`,
          deliver: false,
          timeout: 180,
          message: [
            "Run this exact OpenClaw subagent steering scenario. Use tool calls, not prose.",
            `Use nonce ${nonce}.`,
            `Step 1: call sessions_spawn with exactly this JSON input: ${JSON.stringify({
              task: childTask,
              taskName: "steered_child",
              cleanup: "keep",
              context: "isolated",
              runTimeoutSeconds: 300,
            })}.`,
            'Step 2: after spawn returns status="accepted", do not call the subagents tool; the test harness will steer the child.',
            `Step 3: reply exactly ${parentStartedToken}.`,
            `In a future continuation after the child completion event arrives, reply exactly ${parentToken}.`,
            `Do not reply with ${parentToken} before the child completion event is visible.`,
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      initialRequest.catch((error: unknown) => {
        initialError = error;
      });

      const listSteeredChildRuns = () =>
        listSubagentRunsForRequester(sessionKey).filter((run) => run.taskName === "steered_child");
      const spawnedRun = await waitFor("steered child spawn", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        return listSteeredChildRuns()[0];
      });
      expect(spawnedRun.taskName).toBe("steered_child");
      const initialResponse = await initialRequest;
      expect(extractPayloadText(initialResponse.result)).toContain(parentStartedToken);
      const runBeforeSteer = await waitFor("steered child bash tool start", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        const currentRun =
          listSteeredChildRuns().find((run) => run.runId === spawnedRun.runId) ?? spawnedRun;
        const sawBashStart = agentEvents.some(
          (event) =>
            event.runId === currentRun.runId &&
            event.stream === "tool" &&
            event.data.phase === "start" &&
            isBashToolEventName(event.data.name),
        );
        return sawBashStart ? currentRun : undefined;
      }).catch((error: unknown) => {
        throw new Error(
          `timed out waiting for child bash start; runs=${summarizeSubagentRuns(
            listSteeredChildRuns(),
          )}; events=${summarizeAgentEvents(agentEvents, spawnedRun.runId)}`,
          { cause: error },
        );
      });
      const runStateBeforeSteer = summarizeSubagentRuns(listSteeredChildRuns());
      expect(runBeforeSteer.endedAt, runStateBeforeSteer).toBeUndefined();
      expect(runBeforeSteer.pauseReason, runStateBeforeSteer).toBeUndefined();
      expect(runBeforeSteer.completion?.resultText, runStateBeforeSteer).toBeUndefined();
      console.log(`[subagent-steer] steering active child run; runs=${runStateBeforeSteer}`);

      const cfg = getRuntimeConfig();
      const steerResult = await steerControlledSubagentRun({
        cfg,
        controller: resolveSubagentController({ cfg, agentSessionKey: sessionKey }),
        entry: runBeforeSteer,
        message: steerMessage,
      });
      expect(
        steerResult.status,
        `steer result ${JSON.stringify(steerResult)}; runs=${summarizeSubagentRuns(
          listSteeredChildRuns(),
        )}`,
      ).toBe("accepted");

      const steeredRun = await waitFor("steered child completion", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        return listSteeredChildRuns().find(
          (run) =>
            run.completion?.resultText?.includes(childToken) === true &&
            run.outcome?.status === "ok",
        );
      }).catch((error: unknown) => {
        throw new Error(
          `timed out waiting for steered child completion after steer ${JSON.stringify(
            steerResult,
          )}; runs=${summarizeSubagentRuns(listSteeredChildRuns())}`,
          { cause: error },
        );
      });
      expect(steeredRun.endedReason).toBe("subagent-complete");
      expect(steeredRun.delivery?.lastError).toBeUndefined();
      expect(summarizeSubagentRuns(listSteeredChildRuns())).not.toContain(unsteeredToken);
      expect(summarizeAgentEvents(agentEvents, runBeforeSteer.runId)).not.toContain(unsteeredToken);

      await waitFor("in-process subagent completion agent dispatch start", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        return inProcessAgentDispatches.some((entry) => entry.phase === "started")
          ? true
          : undefined;
      });

      const completedDispatch = await waitFor(
        "in-process subagent completion agent dispatch",
        () => {
          if (initialError) {
            throw toLintErrorObject(initialError, "Non-Error thrown");
          }
          return inProcessAgentDispatches.find((entry) => entry.phase === "completed");
        },
      );
      expect(completedDispatch.resultText).toContain(parentToken);
      expect(
        inProcessAgentDispatches.some((entry) => {
          if (initialError) {
            throw toLintErrorObject(initialError, "Non-Error thrown");
          }
          return entry.phase === "started";
        }),
      ).toBe(true);
      expect(inProcessAgentDispatches.length).toBeGreaterThanOrEqual(1);
    },
    10 * 60_000,
  );

  it(
    "runs parallel isolated Gemini subagents with tool-heavy schemas",
    async () => {
      const modelConfig = resolveLiveSubagentModelConfig();
      if (!modelConfig.modelKey.startsWith("google/")) {
        console.warn(
          "[subagent-stress] skip: set OPENCLAW_LIVE_SUBAGENT_E2E_MODEL=google/gemini-3.1-pro-preview",
        );
        return;
      }
      requireLiveSubagentAuth(modelConfig);

      const token = `subagent-stress-${randomUUID()}`;
      const port = 30_000 + Math.floor(Math.random() * 10_000);
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const sessionKey = `agent:main:live-subagent-stress-${nonce.toLowerCase()}`;
      const childTokens = [1, 2, 3].map((index) => `GEMINI_STRESS_${nonce}_${index}`);
      const parentToken = `GEMINI_STRESS_PARENT_${nonce}`;

      state = await createOpenClawTestState({
        label: "subagent-gemini-stress-live",
        layout: "split",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
          OPENCLAW_PLUGINS_PATHS: undefined,
          OPENCLAW_DEBUG_MODEL_TRANSPORT: "1",
          OPENCLAW_DEBUG_MODEL_PAYLOAD: "tools",
          OPENCLAW_DEBUG_SSE: "events",
        },
      });
      await fs.writeFile(
        path.join(state.workspaceDir, "package.json"),
        `${JSON.stringify({ name: "openclaw-gemini-stress-live", private: true }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(state.workspaceDir, "AGENTS.md"),
        "OpenClaw live stress test workspace. Keep responses concise.\n",
        "utf8",
      );
      await state.writeConfig(
        liveSubagentConfig(modelConfig.modelKey, state.workspaceDir, port, token, {
          toolAllow: [
            "sessions_spawn",
            "sessions_yield",
            "subagents",
            "bash",
            "read",
            "web_search",
            "memory_search",
          ],
        }),
      );
      clearRuntimeConfigSnapshot();
      clearCurrentPluginMetadataSnapshot();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      client = await createGatewayClient({ port, token });

      let initialError: unknown;
      const initialRequest = client.request<AgentPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `live-subagent-stress-${randomUUID()}`,
          deliver: false,
          timeout: 420,
          message: [
            "Run this exact OpenClaw Gemini subagent stress scenario. Use tool calls, not prose.",
            `Use nonce ${nonce}.`,
            "Spawn all three children before waiting for any child result.",
            ...childTokens.map((childToken, index) => {
              const childNumber = index + 1;
              return `Call sessions_spawn for child ${childNumber} with exactly this JSON input: ${JSON.stringify(
                {
                  task: [
                    `You are stress child ${childNumber}.`,
                    "Use available tools for a tiny multi-tool check.",
                    "First read package.json if the read tool is available.",
                    "Then run a tiny shell command if the bash tool is available: printf openclaw.",
                    "If web_search or memory_search is available, use at most one small query.",
                    `After the tool work, reply exactly ${childToken}.`,
                  ].join(" "),
                  taskName: `gemini_stress_${childNumber}`,
                  cleanup: "keep",
                  context: "isolated",
                  runTimeoutSeconds: 300,
                },
              )}.`;
            }),
            `After the three spawn calls are accepted, call sessions_yield with message="waiting for ${childTokens.join(
              ",",
            )}" and wait for all child completion events.`,
            `Reply exactly ${parentToken} only after all three child tokens are visible.`,
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      initialRequest.catch((error: unknown) => {
        initialError = error;
      });

      const completedRuns = await waitFor("three Gemini stress child completions", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        const runs = listSubagentRunsForRequester(sessionKey).filter((run) =>
          run.taskName?.startsWith("gemini_stress_"),
        );
        const completed = childTokens.every((childToken) =>
          runs.some(
            (run) =>
              run.completion?.resultText?.includes(childToken) === true &&
              run.outcome?.status === "ok",
          ),
        );
        return completed ? runs : undefined;
      });

      expect(completedRuns).toHaveLength(3);
      for (const childToken of childTokens) {
        expect(completedRuns.some((run) => run.completion?.resultText?.includes(childToken))).toBe(
          true,
        );
      }

      const parent = await initialRequest;
      expect(extractPayloadText(parent.result)).toContain(parentToken);
    },
    12 * 60_000,
  );
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
