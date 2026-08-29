// Isolated-gateway two-turn parent-agent/model trace. A real in-process
// gateway plus mock OpenAI Responses provider runs two parent agent turns.
// Between them a keep-cleanup child reaches terminal on the live registry.
// The later model request is the assembled system prompt the parent sees.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const RUN_ID = "run-gw-prompt-recent";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-prompt-recent";
const PARENT_SESSION_KEY = "agent:main:main";

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSubagentRegistryForTests({ persist: false });
}

afterEach(resetGatewayState);

function excerptRecentlyCompleted(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const start = raw.indexOf("## Recently Completed Subagents");
  return start >= 0 ? raw.slice(start, start + 700) : null;
}

async function runParentAgentTurn(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  message: string,
): Promise<void> {
  const runId = randomUUID();
  const accepted = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey: PARENT_SESSION_KEY,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(accepted.status).toBe("accepted");
  const completed = await client.request<{ status?: string }>(
    "agent.wait",
    { runId: accepted.runId ?? runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(completed.status).toBe("ok");
}

describe("Recently Completed Subagents on a real parent-agent turn", () => {
  test("later parent model request includes the completed child", { timeout: 90_000 }, async () => {
    const env = captureEnv([...ENV_KEYS]);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-subagent-prompt-recent-"));
    const stateDir = path.join(home, ".openclaw");
    const workspace = path.join(home, "workspace");
    const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(bundledPluginsDir, { recursive: true }),
      fs.mkdir(stateDir, { recursive: true }),
    ]);
    for (const [key, value] of Object.entries({
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
    resetGatewayState();

    const requests: string[] = [];
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requests.push(Buffer.concat(chunks).toString("utf8"));
        const message = {
          type: "message",
          id: randomUUID(),
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          {
            type: "response.output_item.added",
            item: { ...message, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", item: message },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    });

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("mock provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "prompt-recent",
      );
      const token = `prompt-recent-${process.pid}`;
      const cfg = {
        agents: {
          defaults: {
            workspace,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
        },
        gateway: { auth: { mode: "token", token } },
        hooks: { enabled: false },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "coding" },
      } satisfies OpenClawConfig;

      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token,
        clientDisplayName: "vitest-subagent-prompt-recent",
      });

      const firstCursor = requests.length;
      await runParentAgentTurn(gateway.client, "first parent turn");
      const firstParentTurn = requests.slice(firstCursor).join("\n");
      expect(firstParentTurn).not.toContain("## Recently Completed Subagents");

      registerSubagentRun({
        runId: RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        requesterSessionKey: PARENT_SESSION_KEY,
        requesterDisplayKey: "main",
        task: "summarize the inbox",
        taskName: "summarize_inbox",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const endedAt = Date.now();
      emitAgentEvent({
        runId: RUN_ID,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt,
          terminalReply: { disposition: "visible", text: "done" },
        },
      });
      await expect
        .poll(
          () =>
            listSubagentRunsForRequester(PARENT_SESSION_KEY).find((row) => row.runId === RUN_ID)
              ?.execution.status,
        )
        .toBe("terminal");

      const laterCursor = requests.length;
      await runParentAgentTurn(gateway.client, "later parent turn");
      const laterParentTurn = requests.slice(laterCursor).join("\n");
      expect(laterParentTurn).toContain("## Recently Completed Subagents");
      expect(laterParentTurn).toContain(`run=${RUN_ID}`);
      expect(laterParentTurn).toContain(`session=${CHILD_SESSION_KEY}`);

      const assembledRecentPrompt = excerptRecentlyCompleted(laterParentTurn);
      const verdict = {
        surface: "isolated-gateway",
        path: "parent-agent-model-turn",
        firstParentTurn: { assembledPrompt: excerptRecentlyCompleted(firstParentTurn) },
        completion: { runId: RUN_ID, terminal: true },
        laterParentTurn: {
          hasRecentlyCompleted: assembledRecentPrompt !== null,
          runId: RUN_ID,
          assembledRecentPrompt,
        },
      };
      console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
      expect(verdict.laterParentTurn.hasRecentlyCompleted).toBe(true);
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close({ reason: "subagent prompt recent proof complete" });
      }
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      env.restore();
    }
  });
});
