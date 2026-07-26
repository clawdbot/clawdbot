// QA Lab Codex auth product proof exercises doctor, SQLite, Gateway, and app-server together.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonlRequestTailer } from "../../../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mjs";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { connectGatewayStatusClient, postJson } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runCodexAuthDoctorMigrationProof } from "./codex-auth-product-proof.test-support.js";

const oauthAccess = "test-oauth-access";
const ACCOUNT_ID = "qa-codex-account";
const MODEL = "openai/gpt-5.6-luna";
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

type GatewayHistory = Record<string, unknown> & { messages?: unknown[] };

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

function waitForRequest(requestLog: AppServerRequestLog, method: string) {
  return vi.waitFor(
    () => {
      const request = requestLog.read().find((entry) => entry.method === method);
      if (!request) {
        throw new Error(`waiting for Codex app-server method ${method}`);
      }
      return request;
    },
    { interval: 25, timeout: REQUEST_TIMEOUT_MS },
  );
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

describe("Codex auth product proof", () => {
  it(
    "repairs mixed legacy auth into SQLite and sends the selected OAuth profile to app-server",
    { timeout: 180_000 },
    async () => {
      const appServerFixture = fileURLToPath(
        new URL("./codex-auth-app-server.fixture.mjs", import.meta.url),
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-auth-product-proof",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
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
});
