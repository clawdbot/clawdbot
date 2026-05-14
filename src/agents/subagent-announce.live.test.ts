import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { callGateway as realCallGateway } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { dispatchGatewayMethodInProcess as realDispatchGatewayMethodInProcess } from "../gateway/server-plugins.js";
import { startGatewayServer, type GatewayServer } from "../gateway/server.js";
import { extractPayloadText } from "../gateway/test-helpers.agent-results.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { __testing as subagentAnnounceDeliveryTesting } from "./subagent-announce-delivery.js";
import { __testing as subagentAnnounceTesting } from "./subagent-announce.js";
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openAiConfig(
  modelKey: string,
  workspace: string,
  port: number,
  token: string,
): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    plugins: { enabled: false },
    tools: {
      allow: ["sessions_spawn", "sessions_yield", "subagents"],
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          agentRuntime: { id: "pi" },
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          baseUrl: "https://api.openai.com/v1",
          timeoutSeconds: 300,
          models: [
            {
              id: modelKey.replace(/^openai\//u, ""),
              name: modelKey.replace(/^openai\//u, ""),
              api: "openai-responses",
              agentRuntime: { id: "pi" },
              input: ["text"],
              reasoning: true,
              contextWindow: 1_047_576,
              maxTokens: 8_192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: modelKey },
        models: { [modelKey]: { agentRuntime: { id: "pi" }, params: { maxTokens: 1024 } } },
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
): Promise<T> {
  const started = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - started < WAIT_TIMEOUT_MS) {
    lastValue = await fn();
    if (lastValue !== undefined) {
      return lastValue;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${label}`);
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

  afterEach(async () => {
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
    "lets a parent steer a subagent and receives completion through in-process agent dispatch",
    async () => {
      expect(process.env.OPENAI_API_KEY?.trim(), "OPENAI_API_KEY").toBeTruthy();

      const token = `subagent-live-${randomUUID()}`;
      const port = 30_000 + Math.floor(Math.random() * 10_000);
      const modelKey = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.5";
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const childToken = `CHILD_STEERED_${nonce}`;
      const parentToken = `PARENT_SAW_${childToken}`;
      const steerToken = `STEER_${nonce}`;
      const childTask = [
        `Immediately call sessions_yield with message="waiting for ${steerToken}".`,
        `After a steering message containing ${steerToken} arrives, reply exactly ${childToken}.`,
        `Do not reply with ${childToken} before receiving ${steerToken}.`,
      ].join(" ");
      const sessionKey = `agent:main:live-subagent-${nonce.toLowerCase()}`;
      const inProcessAgentDispatches: InProcessAgentDispatch[] = [];

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
      await state.writeConfig(openAiConfig(modelKey, state.workspaceDir, port, token));
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
            `Step 2: after spawn returns status="accepted", call subagents with exactly this JSON input: ${JSON.stringify(
              {
                action: "steer",
                target: "steered_child",
                message: steerToken,
              },
            )}.`,
            `Step 3: call sessions_yield with message="waiting for ${childToken}" and wait for the child completion event.`,
            `Step 4: after the completion event arrives, reply exactly ${parentToken}.`,
            "Do not reply with the parent token until the child completion event is visible.",
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      initialRequest.catch((error: unknown) => {
        initialError = error;
      });

      const steeredRun = await waitFor("steered child completion", () => {
        if (initialError) {
          throw initialError;
        }
        return listSubagentRunsForRequester(sessionKey).find(
          (run) =>
            run.taskName === "steered_child" &&
            run.frozenResultText?.includes(childToken) === true &&
            run.outcome?.status === "ok",
        );
      });
      expect(steeredRun.endedReason).toBe("subagent-complete");
      expect(steeredRun.lastAnnounceDeliveryError).toBeUndefined();

      await waitFor("in-process subagent completion agent dispatch start", () => {
        if (initialError) {
          throw initialError;
        }
        return inProcessAgentDispatches.some((entry) => entry.phase === "started")
          ? true
          : undefined;
      });

      const completedDispatch = inProcessAgentDispatches.find(
        (entry) => entry.phase === "completed",
      );
      if (completedDispatch) {
        expect(completedDispatch.resultText).toContain(childToken);
      }
      expect(
        inProcessAgentDispatches.some((entry) => {
          if (initialError) {
            throw initialError;
          }
          return entry.phase === "started";
        }),
      ).toBe(true);
      expect(inProcessAgentDispatches.length).toBeGreaterThanOrEqual(1);
    },
    10 * 60_000,
  );
});
