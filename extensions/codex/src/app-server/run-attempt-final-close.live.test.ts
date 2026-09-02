// Opt-in exact-head proof against the real Codex app-server binary. A clean
// final source reply must end through native turn/completed without OpenClaw
// injecting turn/interrupt into the rollout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import type { CodexModelListResponse } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createRuntimeDynamicTool,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE === "1";
const describeLive = LIVE ? describe : describe.skip;
const LIVE_MODEL = process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE_MODEL?.trim() || "gpt-5.6-sol";
const TRACE_DIR =
  process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE_TRACE_DIR?.trim() ||
  path.join(os.tmpdir(), "openclaw-codex-final-close-traces");

setupRunAttemptTestHooks();

describeLive("Codex final-source close real-binary proof", () => {
  it(
    "completes naturally without an interrupt or abort classification",
    { timeout: 300_000 },
    async () => {
      await withTempDir("openclaw-codex-final-close-", async (root) => {
        const workspace = path.join(root, "workspace");
        const agentDir = path.join(root, "agent");
        await fs.mkdir(workspace, { recursive: true });
        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        const client = await createIsolatedCodexAppServerClient({
          startOptions: runtime.start,
          agentDir,
          authProfileId: null,
          timeoutMs: 120_000,
        });
        const requestSpy = vi.spyOn(client, "request");
        const notifications: Array<{ at: number; method: string; status?: string }> = [];
        const detachNotifications = client.addNotificationHandler((notification) => {
          const record: { at: number; method: string; status?: string } = {
            at: Date.now(),
            method: notification.method,
          };
          if (notification.method === "turn/completed") {
            const params = notification.params;
            if (
              params &&
              typeof params === "object" &&
              "turn" in params &&
              params.turn &&
              typeof params.turn === "object" &&
              "status" in params.turn &&
              typeof params.turn.status === "string"
            ) {
              record.status = params.turn.status;
            }
          }
          notifications.push(record);
        });
        let closeHostCapabilities: (() => void) | undefined;
        try {
          const listed = await client.request<CodexModelListResponse>(
            "model/list",
            { limit: 100, cursor: null, includeHidden: false },
            { timeoutMs: 60_000 },
          );
          if (!listed.data.some((model) => model.model === LIVE_MODEL)) {
            throw new Error(`Codex model/list did not expose required proof model ${LIVE_MODEL}`);
          }

          const toolCalls: Array<{ at: number; args: unknown }> = [];
          const messageTool = createRuntimeDynamicTool("message");
          messageTool.parameters = {
            type: "object",
            properties: {
              action: { type: "string", enum: ["send"] },
              message: { type: "string" },
              final: { type: "boolean" },
            },
            required: ["action", "message", "final"],
            additionalProperties: false,
          };
          messageTool.execute = vi.fn(async (_toolCallId, args) => {
            toolCalls.push({ at: Date.now(), args });
            return {
              content: [{ type: "text" as const, text: "Message delivered." }],
              details: { ok: true, messageId: "proof-clean-close" },
            };
          });
          dynamicToolBuildState.openClawCodingToolsFactory = () => [messageTool];
          setCodexAppServerClientFactoryForTest(async () => client);

          const params = createParams(path.join(root, "session.jsonl"), workspace);
          params.sessionId = "codex-final-close-live";
          params.sessionKey = "agent:main:codex-final-close-live";
          params.runId = "run-codex-final-close-live";
          params.modelId = LIVE_MODEL;
          params.model = { ...params.model, id: LIVE_MODEL, name: LIVE_MODEL };
          params.disableTools = false;
          params.sourceReplyDeliveryMode = "message_tool_only";
          params.thinkLevel = "medium";
          params.timeoutMs = 180_000;
          params.prompt =
            "Call the message tool exactly once with action 'send', message " +
            "'CODEX_FINAL_CLOSE_LIVE_OK', and final true. After that tool returns, stop " +
            "immediately without calling another tool or producing more output.";
          setCodexTestModelSupportsTools(params, true);
          closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);

          const startedAt = Date.now();
          const result = await runCodexAppServerAttempt(params);
          const terminal = readAttemptTerminal(result);
          const rpc = requestSpy.mock.calls.map(([method]) => ({ method }));
          const completed = notifications.find((event) => event.method === "turn/completed");
          const receipt = {
            scenario: "clean-final-source-close",
            candidateHead: process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE_HEAD?.trim() || "unrecorded",
            model: LIVE_MODEL,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: new Date().toISOString(),
            rpc,
            notifications,
            toolCalls,
            terminal,
            finalSourceTargets: result.messagingToolSentTargets.filter(
              (target) => target.sourceReplyFinal === true,
            ),
          };
          await fs.mkdir(TRACE_DIR, { recursive: true });
          await fs.writeFile(
            path.join(TRACE_DIR, "clean-final-source-close.json"),
            `${JSON.stringify(receipt, null, 2)}\n`,
            "utf8",
          );

          expect(messageTool.execute).toHaveBeenCalledTimes(1);
          expect(receipt.finalSourceTargets).toHaveLength(1);
          expect(rpc.filter(({ method }) => method === "turn/interrupt")).toHaveLength(0);
          expect(completed).toMatchObject({ status: "completed" });
          expect(terminal).toMatchObject({ aborted: false, timedOut: false, promptError: null });
        } finally {
          closeHostCapabilities?.();
          detachNotifications();
          await client.closeAndWait();
        }
      });
    },
  );
});
