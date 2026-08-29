import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../../infra/diagnostic-events.js";
import type { Model } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../../../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../../../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import { Agent, type StreamFn } from "../../runtime/index.js";
import { setInternalBeforeToolBatch } from "../../runtime/internal-hooks.js";
import { createWriteTool } from "../../sessions/index.js";
import { TOOL_LOOP_WARNING_THRESHOLD } from "../../tool-loop-thresholds.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

const model: Model = {
  id: "write-churn-test-model",
  name: "Write Churn Test Model",
  api: "openai-responses",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticSessionStateForTest();
});

describe("embedded write-churn batch lifecycle", () => {
  it("emits the warning when a sequential batch reaches the mutation threshold", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-churn-batch-"));
    const sessionId = "write-churn-batch-session";
    const sessionKey = "agent:main:write-churn-batch";
    const runId = "write-churn-batch-run";
    const ctx = {
      agentId: "main",
      cwd: tmpDir,
      sessionId,
      sessionKey,
      runId,
      loopDetection: { enabled: true },
    };
    const writes = Array.from({ length: TOOL_LOOP_WARNING_THRESHOLD + 1 }, (_, index) => ({
      type: "toolCall" as const,
      id: `write-${index}`,
      name: "write",
      arguments: { path: "draft.md", content: `synthetic revision ${index}` },
    }));
    let turn = 0;
    const streamFn: StreamFn = (activeModel) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = turn++ === 0 ? writes : [{ type: "text" as const, text: "done" }];
        const stopReason = content.some((item) => item.type === "toolCall") ? "toolUse" : "stop";
        stream.push({
          type: "done",
          reason: stopReason,
          message: {
            role: "assistant",
            content,
            api: activeModel.api,
            provider: activeModel.provider,
            model: activeModel.id,
            usage,
            stopReason,
            timestamp: turn,
          },
        });
        stream.end();
      });
      return stream;
    };
    const writeTool = wrapToolWithBeforeToolCallHook(
      createWriteTool(tmpDir) as unknown as AnyAgentTool,
      ctx,
    );
    const agent = new Agent({
      initialState: { model, tools: [writeTool] },
      streamFn,
      toolExecution: "sequential",
    });
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission(ctx));
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const warnings: Array<{ detector?: string; count?: number }> = [];
    const thresholdTimeline: string[] = [];
    const stop = onDiagnosticEvent((event) => {
      if (event.type === "tool.loop" && event.level === "warning") {
        warnings.push(event);
      }
    });
    const stopInternal = onInternalDiagnosticEvent((event) => {
      if (event.type === "tool.loop" && event.level === "warning") {
        thresholdTimeline.push(`warning:${event.count}`);
      }
      if (event.type === "tool.execution.started" && event.toolCallId === "write-10") {
        thresholdTimeline.push(`started:${event.toolCallId}`);
      }
    });

    try {
      await agent.prompt("rewrite the draft in one sequential batch");

      expect(warnings).toEqual([
        expect.objectContaining({
          detector: "argument_churn",
          count: TOOL_LOOP_WARNING_THRESHOLD,
        }),
      ]);
      expect(thresholdTimeline).toEqual([
        `warning:${TOOL_LOOP_WARNING_THRESHOLD}`,
        "started:write-10",
      ]);
      await expect(fs.readFile(path.join(tmpDir, "draft.md"), "utf8")).resolves.toBe(
        `synthetic revision ${TOOL_LOOP_WARNING_THRESHOLD}`,
      );
    } finally {
      stop();
      stopInternal();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts churn liveness when a default-parallel batch reaches the mutation threshold", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-churn-parallel-"));
    const sessionId = "write-churn-parallel-session";
    const sessionKey = "agent:main:write-churn-parallel";
    const runId = "write-churn-parallel-run";
    const ctx = {
      agentId: "main",
      cwd: tmpDir,
      sessionId,
      sessionKey,
      runId,
      loopDetection: { enabled: true },
    };
    const writes = Array.from({ length: TOOL_LOOP_WARNING_THRESHOLD + 1 }, (_, index) => ({
      type: "toolCall" as const,
      id: `parallel-write-${index}`,
      name: "write",
      arguments: { path: "draft.md", content: `parallel revision ${index}` },
    }));
    let turn = 0;
    const streamFn: StreamFn = (activeModel) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = turn++ === 0 ? writes : [{ type: "text" as const, text: "done" }];
        const stopReason = content.some((item) => item.type === "toolCall") ? "toolUse" : "stop";
        stream.push({
          type: "done",
          reason: stopReason,
          message: {
            role: "assistant",
            content,
            api: activeModel.api,
            provider: activeModel.provider,
            model: activeModel.id,
            usage,
            stopReason,
            timestamp: turn,
          },
        });
        stream.end();
      });
      return stream;
    };
    const writeTool = wrapToolWithBeforeToolCallHook(
      createWriteTool(tmpDir) as unknown as AnyAgentTool,
      ctx,
    );
    const agent = new Agent({
      initialState: { model, tools: [writeTool] },
      streamFn,
    });
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission(ctx));
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const warnings: Array<{ detector?: string; count?: number }> = [];
    const stop = onDiagnosticEvent((event) => {
      if (event.type === "tool.loop" && event.level === "warning") {
        warnings.push(event);
      }
    });

    try {
      await agent.prompt("rewrite the draft in one default-parallel batch");

      expect(warnings).toEqual([
        expect.objectContaining({
          detector: "argument_churn",
          count: TOOL_LOOP_WARNING_THRESHOLD,
        }),
      ]);
      expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
        lastProgressReason: "tool_loop:argument_churn",
      });
    } finally {
      stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
