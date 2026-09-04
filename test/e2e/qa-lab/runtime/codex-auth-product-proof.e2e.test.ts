// QA Lab Codex auth product proof exercises doctor, SQLite, Gateway, and app-server together.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonlRequestTailer } from "../../../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mts";
import { GatewayClient } from "../../../../src/gateway/client.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { connectGatewayStatusClient, postJson } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runCodexAuthDoctorMigrationProof } from "./codex-auth-product-proof.test-support.js";

const oauthAccess = "test-oauth-access";
const ACCOUNT_ID = "qa-codex-account";
const MODEL = "openai/gpt-5.6-luna";
const NATIVE_MODEL = "openai/gpt-future";
const MISSING_PROFILE_ID = "openai:missing";
const SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT =
  "The selected auth profile is unavailable in this agent's OpenClaw credential store. " +
  "Import or migrate that credential into the agent, select another configured profile, or run `openclaw configure`, then retry.";
const PRODUCT_OUTPUT = "QA_CODEX_AUTH_PRODUCT_PROOF_OK";
const REQUEST_TIMEOUT_MS = 60_000;

let instance: OpenClawTestInstance | undefined;

type AppServerLogEntry = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

type AppServerRequestLog = { read(): AppServerLogEntry[] };

type GatewayHistory = Record<string, unknown> & {
  messages?: unknown[];
  sessionInfo?: { lastRunError?: unknown };
};

type GatewayEvent = { event?: string; payload?: unknown };

function expectBoundedMissingProfileRecovery(
  value: unknown,
  options?: { allowSessionTruncation?: boolean },
) {
  const serialized = JSON.stringify(value);
  if (options?.allowSessionTruncation) {
    expect(typeof value).toBe("string");
    expect(SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT.startsWith(String(value))).toBe(true);
  } else {
    expect(serialized).toContain(SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT);
  }
  expect(serialized).not.toContain(MISSING_PROFILE_ID);
  expect(serialized).not.toContain("was not found");
  expect(serialized).not.toContain("Codex app-server auth profile");
  expect(serialized).not.toContain("/login codex");
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

function waitForRequest(requestLog: AppServerRequestLog, method: string) {
  return vi.waitFor(
    () => {
      const entries = requestLog.read();
      const request = entries.find((entry) => entry.method === method);
      if (!request) {
        const observedMethods = entries.flatMap((entry) =>
          typeof entry.method === "string" ? [entry.method] : [],
        );
        throw new Error(
          `waiting for Codex app-server method ${method}; observed ${observedMethods.join(", ") || "no methods"}`,
        );
      }
      return request;
    },
    { interval: 25, timeout: REQUEST_TIMEOUT_MS },
  );
}

function chatgptAccessToken(accountId: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
}

async function waitForAssistantHistory(testInstance: OpenClawTestInstance, expected: string) {
  const client = await connectGatewayStatusClient(testInstance);
  try {
    return await vi.waitFor(
      async () => {
        const result = await client.request<{
          sessions?: Array<{ key?: unknown }>;
        }>("sessions.list", { limit: 20 });
        const sessionKeys = (result.sessions ?? []).flatMap((session) =>
          typeof session.key === "string" ? [session.key] : [],
        );
        const histories = await Promise.allSettled(
          sessionKeys.map(async (sessionKey) => ({
            history: await client.request<GatewayHistory>(
              "chat.history",
              { agentId: "main", sessionKey, limit: 50 },
              { timeoutMs: 5_000 },
            ),
            sessionKey,
          })),
        );
        for (const entry of histories) {
          if (entry.status === "fulfilled") {
            const { history, sessionKey } = entry.value;
            const messages = Array.isArray(history.messages) ? history.messages : [];
            if (
              messages.some(
                (message) =>
                  message !== null &&
                  typeof message === "object" &&
                  (message as { role?: unknown }).role === "assistant" &&
                  JSON.stringify(message).includes(expected),
              )
            ) {
              return { history, sessionKey };
            }
          }
        }
        const failed = histories.filter((entry) => entry.status === "rejected").length;
        throw new Error(
          `waiting for assistant history text ${expected}; ${failed}/${sessionKeys.length} history reads failed`,
        );
      },
      { interval: 100, timeout: REQUEST_TIMEOUT_MS },
    );
  } finally {
    client.stop();
  }
}

async function connectGatewayEventClient(
  testInstance: OpenClawTestInstance,
  events: GatewayEvent[],
) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
        return;
      }
      resolve(client);
    };
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${testInstance.port}`,
      origin: `http://127.0.0.1:${testInstance.port}`,
      token: testInstance.gatewayToken,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      clientDisplayName: "Codex missing auth profile QA",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      platform: "qa",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: (event) => events.push(event),
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error(`Gateway client connection timed out:\n${testInstance.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

describe("Codex auth product proof", () => {
  it(
    "repairs mixed legacy auth into SQLite and sends the selected OAuth profile to app-server",
    { timeout: 180_000 },
    async () => {
      const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
        CODEX_APP_SERVER_VERSION: string;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      const appServerFixture = fileURLToPath(
        new URL("./codex-auth-app-server.fixture.mjs", import.meta.url),
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-auth-product-proof",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
        config: {
          plugins: {
            enabled: true,
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "yolo",
                    command: process.execPath,
                    args: [appServerFixture],
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                    turnCompletionIdleTimeoutMs: REQUEST_TIMEOUT_MS,
                  },
                },
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: MODEL, fallbacks: [] },
              models: { [MODEL]: { agentRuntime: { id: "codex" } } },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
              sandbox: { mode: "off" },
            },
          },
        },
      });

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      const canonicalStore = await runCodexAuthDoctorMigrationProof(instance, {
        accountId: ACCOUNT_ID,
        oauthAccess,
        shape: "mixed",
      });

      await instance.startGateway();
      const hook = await postJson(
        `http://127.0.0.1:${instance.port}/hooks/agent`,
        {
          message: `Reply with ${PRODUCT_OUTPUT}.`,
          name: "Codex auth product proof",
          deliver: false,
        },
        { Authorization: `Bearer ${instance.hookToken}` },
      );
      expect(hook.status, JSON.stringify(hook.json)).toBe(200);

      const loginRequest = await waitForRequest(appServerLog, "account/login/start");
      const loginParams = loginRequest.params as Record<string, unknown>;
      expect(loginParams.type).toBe("chatgptAuthTokens");
      expect(loginParams.accessToken === oauthAccess).toBe(true);
      expect(loginParams.chatgptAccountId).toBe(ACCOUNT_ID);
      expect(loginParams.chatgptPlanType).toBeNull();

      await waitForRequest(appServerLog, "turn/start");
      const turnEntries = appServerLog.read();
      const threadStartIndex = turnEntries.findIndex(
        (request) => request.method === "thread/start",
      );
      const turnStartIndex = turnEntries.findIndex((request) => request.method === "turn/start");
      expect(threadStartIndex).toBeGreaterThanOrEqual(0);
      expect(turnStartIndex).toBeGreaterThan(threadStartIndex);
      const completedTurn = await waitForAssistantHistory(instance, PRODUCT_OUTPUT);

      const beforeUsage = appServerLog.read().length;
      const status = await instance.cli(["status", "--usage", "--json", "--timeout", "60000"], {
        timeoutMs: 120_000,
      });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("qa-codex-account@example.com");

      const usageEntries = appServerLog.read().slice(beforeUsage);
      const usageLoginIndex = usageEntries.findIndex(
        (request) => request.method === "account/login/start",
      );
      const accountReadIndex = usageEntries.findIndex(
        (request) => request.method === "account/read",
      );
      expect(usageLoginIndex).toBeGreaterThanOrEqual(0);
      expect(accountReadIndex).toBeGreaterThan(usageLoginIndex);

      const usageLoginRequest = usageEntries[usageLoginIndex];
      const usageLoginParams = usageLoginRequest?.params as Record<string, unknown>;
      expect(usageLoginParams).toEqual({
        type: "chatgptAuthTokens",
        accessToken: oauthAccess,
        chatgptAccountId: ACCOUNT_ID,
        chatgptPlanType: null,
      });

      const accountReadRequest = usageEntries[accountReadIndex];
      expect(accountReadRequest?.params).toEqual({});
      const accountReadResponse = usageEntries.find(
        (entry) => entry.id === accountReadRequest?.id && entry.result !== undefined,
      );
      expect(accountReadResponse?.result).toEqual({
        account: {
          type: "chatgpt",
          email: "qa-codex-account@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      });

      console.log(
        `[qa-codex-auth-product-proof] ${JSON.stringify({
          selectedProfileId: canonicalStore?.order?.openai?.[0],
          canonicalStore: {
            profileIds: Object.keys(canonicalStore?.profiles ?? {}).toSorted(),
            order: canonicalStore?.order?.openai,
            legacyJsonRemoved: true,
          },
          gatewayTurn: {
            threadStartOrder: threadStartIndex,
            turnStartOrder: turnStartIndex,
            assistantOutput: PRODUCT_OUTPUT,
            historySessionKey: completedTurn.sessionKey,
            historySessionId: completedTurn.history.sessionId,
          },
          appServer: [
            {
              order: usageLoginIndex,
              method: usageLoginRequest?.method,
              params: {
                type: usageLoginParams.type,
                accessToken: "redacted",
                chatgptAccountId: usageLoginParams.chatgptAccountId,
                chatgptPlanType: usageLoginParams.chatgptPlanType,
              },
            },
            {
              order: accountReadIndex,
              method: accountReadRequest?.method,
              params: accountReadRequest?.params,
              result: accountReadResponse?.result,
            },
          ],
        })}`,
      );
    },
  );

  it(
    "returns bounded recovery when the configured profile is absent without calling app-server",
    { timeout: 180_000 },
    async () => {
      const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
        CODEX_APP_SERVER_VERSION: string;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      const appServerFixture = fileURLToPath(
        new URL("./codex-auth-app-server.fixture.mjs", import.meta.url),
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-missing-auth-profile",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
        config: {
          plugins: {
            enabled: true,
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "yolo",
                    command: process.execPath,
                    args: [appServerFixture],
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                    turnCompletionIdleTimeoutMs: REQUEST_TIMEOUT_MS,
                  },
                },
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: `${MODEL}@${MISSING_PROFILE_ID}`, fallbacks: [] },
              models: {
                [MODEL]: { agentRuntime: { id: "codex" } },
                [NATIVE_MODEL]: { agentRuntime: { id: "codex" } },
              },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
              sandbox: { mode: "off" },
            },
          },
        },
      });

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const appServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      await instance.state.writeAuthProfiles({
        version: 1,
        profiles: {
          [MISSING_PROFILE_ID]: {
            type: "token",
            provider: "openai",
            token: chatgptAccessToken(ACCOUNT_ID),
            accountId: ACCOUNT_ID,
          },
        },
      });

      await instance.startGateway();
      const sessionKey = "agent:main:qa-codex-missing-auth-profile";
      const events: GatewayEvent[] = [];
      const client = await connectGatewayEventClient(instance, events);
      let runId = "";
      let terminal: unknown;
      let failedHistory: GatewayHistory | undefined;
      try {
        const setup = await client.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: `Reply with ${PRODUCT_OUTPUT}.`,
          deliver: false,
          idempotencyKey: "qa-codex-profile-binding-setup",
        });
        expect(setup).toMatchObject({ runId: expect.any(String), status: "started" });
        const setupTerminal = await client.request(
          "agent.wait",
          { runId: setup.runId, timeoutMs: REQUEST_TIMEOUT_MS },
          { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
        );
        expect(
          setupTerminal,
          `${JSON.stringify(setupTerminal)}\n${JSON.stringify(appServerLog.read())}\n${instance.logs()}`,
        ).toMatchObject({ runId: setup.runId, status: "ok" });
        await expect(
          client.request("sessions.patch", { key: sessionKey, model: NATIVE_MODEL }),
        ).resolves.toMatchObject({ ok: true });

        await instance.state.writeAuthProfiles({ version: 1, profiles: {} });
        await fs.writeFile(requestLog, "", "utf8");
        events.length = 0;
        await client.request("sessions.messages.subscribe", { key: sessionKey });
        const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: "Prove missing selected auth profile recovery.",
          deliver: false,
          idempotencyKey: "qa-codex-missing-auth-profile",
        });
        expect(started).toMatchObject({ runId: expect.any(String), status: "started" });
        runId = started.runId ?? "";
        terminal = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: REQUEST_TIMEOUT_MS },
          { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
        );
        expect(terminal).toMatchObject({ runId, status: "error" });
        await vi.waitFor(
          () => {
            expect(
              events.find(
                (event) =>
                  event.event === "chat" &&
                  event.payload !== null &&
                  typeof event.payload === "object" &&
                  (event.payload as { runId?: unknown }).runId === runId &&
                  (event.payload as { state?: unknown }).state === "error",
              ),
            ).toBeDefined();
            expect(
              events.find(
                (event) =>
                  event.event === "agent" &&
                  event.payload !== null &&
                  typeof event.payload === "object" &&
                  (event.payload as { runId?: unknown }).runId === runId &&
                  (event.payload as { stream?: unknown }).stream === "lifecycle" &&
                  (event.payload as { data?: { phase?: unknown } }).data?.phase === "error",
              ),
            ).toBeDefined();
          },
          { interval: 20, timeout: 5_000 },
        );

        await vi.waitFor(
          async () => {
            const listed = await client.request<{
              sessions?: Array<{ key?: unknown; lastRunError?: unknown }>;
            }>("sessions.list", { limit: 20 });
            const session = listed.sessions?.find((entry) => entry.key === sessionKey);
            expect(session).toBeDefined();
            expectBoundedMissingProfileRecovery(session?.lastRunError, {
              allowSessionTruncation: true,
            });
          },
          { interval: 50, timeout: REQUEST_TIMEOUT_MS },
        );
        failedHistory = await client.request<GatewayHistory>(
          "chat.history",
          { agentId: "main", sessionKey, limit: 50 },
          { timeoutMs: 5_000 },
        );
      } finally {
        client.stop();
      }

      const failureAppServerLog = createJsonlRequestTailer<AppServerLogEntry>(requestLog);
      const finalEvent = events.find(
        (event) =>
          event.event === "chat" &&
          event.payload !== null &&
          typeof event.payload === "object" &&
          (event.payload as { runId?: unknown }).runId === runId &&
          (event.payload as { state?: unknown }).state === "error",
      );
      const lifecycleEvent = events.find(
        (event) =>
          event.event === "agent" &&
          event.payload !== null &&
          typeof event.payload === "object" &&
          (event.payload as { runId?: unknown }).runId === runId &&
          (event.payload as { stream?: unknown }).stream === "lifecycle" &&
          (event.payload as { data?: { phase?: unknown } }).data?.phase === "error",
      );
      expectBoundedMissingProfileRecovery(finalEvent?.payload);
      expectBoundedMissingProfileRecovery(lifecycleEvent?.payload);
      expectBoundedMissingProfileRecovery(terminal);
      expectBoundedMissingProfileRecovery(failedHistory?.sessionInfo?.lastRunError, {
        allowSessionTruncation: true,
      });
      expect(JSON.stringify(failedHistory)).not.toContain(MISSING_PROFILE_ID);
      expect(JSON.stringify(failedHistory)).not.toContain("Codex app-server auth profile");

      await waitForRequest(failureAppServerLog, "initialize");
      const failureMethods = failureAppServerLog
        .read()
        .flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : []));
      expect(failureMethods).toContain("initialize");
      expect(failureMethods).not.toContain("account/login/start");
      expect(failureMethods).not.toContain("thread/start");
      expect(failureMethods).not.toContain("thread/resume");
      expect(failureMethods).not.toContain("turn/start");

      console.log(
        `[qa-codex-missing-auth-profile] ${JSON.stringify({
          assistantOutput: SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT,
          historySessionKey: sessionKey,
          appServerInitialized: true,
          appServerOperationalRpcCount: failureMethods.filter(
            (method) => method !== "initialize" && method !== "initialized",
          ).length,
        })}`,
      );
    },
  );
});
