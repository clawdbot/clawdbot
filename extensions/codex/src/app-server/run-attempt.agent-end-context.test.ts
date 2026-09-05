import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import {
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt agent-end context", () => {
  it.each(["completed", "aborted", "provider refusal"] as const)(
    "hands deep-turn context to agent-end without reviewing a refusal: %s",
    async (outcome) => {
      const source = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(tempDir, "agent-end-context.sqlite"),
      };
      const sessionFile = formatSqliteSessionFileMarker(source);
      await upsertSessionEntry({
        ...source,
        entry: { sessionFile, sessionId: source.sessionId, updatedAt: Date.now() },
      });
      const workspaceDir = path.join(tempDir, "agent-end-context-workspace");
      const harness = createStartedThreadHarness();
      const runAgentEndSideEffects = vi
        .spyOn(agentHarnessRuntime, "runAgentEndSideEffects")
        .mockImplementation(() => {});
      const params = createParams(sessionFile, workspaceDir);
      const abortController = new AbortController();
      params.abortSignal = abortController.signal;
      params.sessionTarget = source;
      params.messageChannel = "discord";
      params.memberRoleIds = ["maintainer-role"];
      setCodexTestModelSupportsTools(params, true);
      dynamicToolBuildState.openClawCodingToolsFactory = () => [
        createRuntimeDynamicTool("skill_workshop"),
      ];

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      for (let index = 0; index < 10; index++) {
        await harness.notify({
          method: "rawResponse/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            responseId: `response-${index}`,
          },
        });
      }
      if (outcome === "aborted") {
        abortController.abort("user cancelled");
      } else {
        const error =
          outcome === "provider refusal"
            ? { message: "Provider declined this request.", codexErrorInfo: "cyberPolicy" as const }
            : undefined;
        if (error) {
          await harness.notify({
            method: "error",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              error,
              willRetry: false,
            },
          });
        }
        await harness.notify({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: error ? "failed" : "completed",
              items: error ? [] : [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
              ...(error ? { error } : {}),
            },
          },
        });
      }
      const result = await run;

      const ctx = runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.ctx;
      expect(ctx?.foregroundPromptContext?.memberRoleIds).toEqual(["maintainer-role"]);
      expect(typeof ctx?.foregroundPromptContext?.agentDir).toBe("string");
      expect(ctx?.modelIterations).toBe(10);
      expect(ctx?.skillWorkshopAvailable).toBe(true);
      const reviewSource =
        runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.skillExperienceReviewSource;
      if (outcome === "provider refusal") {
        expect(result.terminal).toEqual({ kind: "ok" });
        expect(result.currentAttemptAssistant).toMatchObject({
          stopReason: "error",
          diagnostics: [
            { type: "provider_refusal", details: { provider: "openai", category: "cyber" } },
          ],
        });
        expect(reviewSource).toBeUndefined();
      } else {
        expect(reviewSource).toMatchObject(source);
      }
    },
  );
});
