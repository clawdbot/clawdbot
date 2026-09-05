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

const PRIMARY_MODEL = "openai/gpt-5.6-luna";
const FALLBACK_MODEL = "openai/gpt-5.6-sol";
const REFUSAL_TEXT =
  "The provider refused this request (category: bio). Revise the request and try again.";
const LATER_TURN_TEXT = "QA_CODEX_LATER_TURN_OK";
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

describe("Gateway Codex refusal product proof", () => {
  it(
    "surfaces one refusal without retry, fallback, or compaction and keeps the next turn usable",
    { timeout: 180_000 },
    async () => {
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
                    turnCompletionIdleTimeoutMs: 60_000,
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

        const refusalStatus = await send("Trigger the synthetic refusal.");
        const firstEntries = (await fs.readFile(requestLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string });
        const firstTurnStarts = firstEntries.filter((entry) => entry.method === "turn/start");
        expect(firstTurnStarts).toHaveLength(1);
        expect(firstEntries.some((entry) => entry.method === "thread/compact/start")).toBe(false);

        const laterStatus = await send("Complete this ordinary later turn.");
        const history = await client.request<{
          messages?: Array<{ role?: unknown; content?: unknown }>;
        }>("chat.history", { sessionKey, limit: 20 });
        const assistantTexts = (history.messages ?? [])
          .filter((message) => message.role === "assistant")
          .map((message) => messageText(message.content));
        const allEntries = (await fs.readFile(requestLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string });
        const proof = {
          configuredFallback: FALLBACK_MODEL,
          firstTurnStartCount: firstTurnStarts.length,
          compactionRequestCount: firstEntries.filter(
            (entry) => entry.method === "thread/compact/start",
          ).length,
          refusalStatus,
          refusalDeliveryCount: assistantTexts.filter((text) => text === REFUSAL_TEXT).length,
          laterStatus,
          laterTurnDelivered: assistantTexts.includes(LATER_TURN_TEXT),
          totalTurnStartCount: allEntries.filter((entry) => entry.method === "turn/start").length,
        };
        console.log(`[gateway Codex refusal proof] ${JSON.stringify(proof)}`);
        expect(proof).toEqual({
          configuredFallback: FALLBACK_MODEL,
          firstTurnStartCount: 1,
          compactionRequestCount: 0,
          refusalStatus: "error",
          refusalDeliveryCount: 1,
          laterStatus: "ok",
          laterTurnDelivered: true,
          totalTurnStartCount: 2,
        });
        expect(JSON.stringify(history)).not.toContain("biological risk");
        expect(JSON.stringify(history)).not.toContain("/new");
      } finally {
        client.stop();
      }
    },
  );
});
