import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runCodexAuthDoctorMigrationProof } from "./codex-auth-product-proof.test-support.js";

const PRIMARY_MODEL = "openai/gpt-5.4";
const FALLBACK_MODEL = "openai/gpt-5.4-mini";
const REPAIRED_MODEL_ID = "gpt-5.6-terra";
const REPAIRED_FALLBACK_MODEL = "openai/gpt-5.6-luna";
const LATER_TURN_TEXT = "QA_CODEX_LATER_TURN_OK";
type AppServerMessage = {
  method?: string;
  params?: { threadId?: string; model?: string; status?: { type?: string } };
};
let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
        .join("\n")
    : "";
}

describe("Gateway Codex failure recovery product proof", () => {
  it.each([
    {
      failureKind: "bio",
      firstStatus: "error",
      firstTurnStartCount: 1,
      totalTurnStartCount: 2,
      visibleReplies: [
        "The provider refused this request (category: bio). Revise the request and try again.",
        LATER_TURN_TEXT,
      ],
    },
    {
      failureKind: "cyber",
      firstStatus: "error",
      firstTurnStartCount: 1,
      totalTurnStartCount: 2,
      visibleReplies: [
        "The provider refused this request (category: cyber). Revise the request and try again.",
        LATER_TURN_TEXT,
      ],
    },
    {
      failureKind: "misalignment",
      firstStatus: "error",
      firstTurnStartCount: 1,
      totalTurnStartCount: 2,
      visibleReplies: [
        "The provider refused this request (category: misalignment). Revise the request and try again.",
        LATER_TURN_TEXT,
      ],
    },
    {
      failureKind: "retryable",
      firstStatus: "ok",
      firstTurnStartCount: 2,
      totalTurnStartCount: 3,
      visibleReplies: [LATER_TURN_TEXT, LATER_TURN_TEXT],
    },
  ])(
    "$failureKind preserves terminal or retry behavior and continues the same native thread",
    { timeout: 180_000 },
    async (scenario) => {
      const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
        CODEX_APP_SERVER_VERSION: string;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      const fixture = fileURLToPath(
        new URL("./codex-refusal-app-server.fixture.mjs", import.meta.url),
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-refusal-product-proof",
        env: {
          OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
          OPENCLAW_QA_CODEX_FAILURE_KIND: scenario.failureKind,
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
                    args: [fixture],
                    requestTimeoutMs: 60_000,
                  },
                },
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: PRIMARY_MODEL, fallbacks: [FALLBACK_MODEL] },
              models: {
                [PRIMARY_MODEL]: { agentRuntime: { id: "codex" } },
                [FALLBACK_MODEL]: { agentRuntime: { id: "codex" } },
              },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
              sandbox: { mode: "off" },
            },
          },
        },
      });
      const requestLog = instance.state.path("codex-refusal-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_REFUSAL_APP_SERVER_LOG = requestLog;
      await runCodexAuthDoctorMigrationProof(instance, {
        accountId: "qa-codex-refusal",
        oauthAccess: "synthetic-codex-refusal-oauth",
        shape: "oauth-only",
      });
      expect(JSON.parse(await fs.readFile(instance.configPath, "utf8"))).toMatchObject({
        agents: {
          defaults: {
            model: {
              primary: `openai/${REPAIRED_MODEL_ID}`,
              fallbacks: [REPAIRED_FALLBACK_MODEL],
            },
          },
        },
      });
      await instance.startGateway();
      const client = await connectGatewayStatusClient(instance);
      try {
        const sessionKey = `agent:main:codex-refusal-${randomUUID()}`;
        const send = async (message: string) => {
          const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
            sessionKey,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(started.status).toBe("started");
          const terminal = await client.request<{ status?: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
          return terminal.status;
        };

        const firstStatus = await send("Exercise the harmless synthetic protocol failure.");
        const firstEntries = (await fs.readFile(requestLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as AppServerMessage);
        const firstTurnStarts = firstEntries.filter((entry) => entry.method === "turn/start");
        expect(firstTurnStarts).toHaveLength(scenario.firstTurnStartCount);
        expect(firstStatus).toBe(scenario.firstStatus);
        expect(firstEntries.some((entry) => entry.method === "thread/compact/start")).toBe(false);
        expect(firstEntries).toContainEqual({
          method: "thread/status/changed",
          params: {
            threadId: firstTurnStarts[0]?.params?.threadId,
            status: { type: "systemError" },
          },
        });

        const laterStatus = await send("Complete this ordinary later turn.");
        const history = await client.request<{
          messages?: Array<{ role?: unknown; content?: unknown }>;
        }>("chat.history", { sessionKey, limit: 20 });
        const assistantTexts = (history.messages ?? [])
          .filter((message) => message.role === "assistant")
          .map((message) => messageText(message.content))
          .filter(Boolean);
        const allEntries = (await fs.readFile(requestLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as AppServerMessage);
        const allTurnStarts = allEntries.filter((entry) => entry.method === "turn/start");
        const proof = {
          failureKind: scenario.failureKind,
          configuredFallback: REPAIRED_FALLBACK_MODEL,
          firstTurnStartCount: firstTurnStarts.length,
          compactionRequestCount: firstEntries.filter(
            (entry) => entry.method === "thread/compact/start",
          ).length,
          firstStatus,
          visibleReplies: assistantTexts,
          laterStatus,
          totalTurnStartCount: allTurnStarts.length,
          threadStartCount: allEntries.filter((entry) => entry.method === "thread/start").length,
          nativeThreadIds: [...new Set(allTurnStarts.map((entry) => entry.params?.threadId))],
          selectedModels: [...new Set(allTurnStarts.map((entry) => entry.params?.model))],
        };
        console.log(`[gateway Codex failure recovery proof] ${JSON.stringify(proof)}`);
        expect(proof).toEqual({
          failureKind: scenario.failureKind,
          configuredFallback: REPAIRED_FALLBACK_MODEL,
          firstTurnStartCount: scenario.firstTurnStartCount,
          compactionRequestCount: 0,
          firstStatus: scenario.firstStatus,
          visibleReplies: scenario.visibleReplies,
          laterStatus: "ok",
          totalTurnStartCount: scenario.totalTurnStartCount,
          threadStartCount: 1,
          nativeThreadIds: [expect.any(String)],
          selectedModels: [REPAIRED_MODEL_ID],
        });
        expect(JSON.stringify(history)).not.toContain("biological risk");
        expect(JSON.stringify(history)).not.toContain("/new");
      } finally {
        client.stop();
      }
    },
  );
});
