import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { classifyEmbeddedPiRunResultForModelFallback } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerEventProjector,
  type CodexAppServerToolTelemetry,
} from "./event-projector.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-outcome-contract";
const TURN_ID = "turn-outcome-contract";
const tempDirs = new Set<string>();

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];
type ProjectedAttemptResult = ReturnType<CodexAppServerEventProjector["buildResult"]>;

async function createParams(): Promise<EmbeddedRunAttemptParams> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-outcome-contract-"));
  tempDirs.add(tempDir);
  const sessionFile = path.join(tempDir, "session.jsonl");
  SessionManager.open(sessionFile);
  return {
    prompt: OUTCOME_FALLBACK_RUNTIME_CONTRACT.prompt,
    sessionId: OUTCOME_FALLBACK_RUNTIME_CONTRACT.sessionId,
    sessionKey: OUTCOME_FALLBACK_RUNTIME_CONTRACT.sessionKey,
    sessionFile,
    workspaceDir: tempDir,
    runId: OUTCOME_FALLBACK_RUNTIME_CONTRACT.runId,
    provider: "codex",
    modelId: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
  } as EmbeddedRunAttemptParams;
}

async function createProjector(): Promise<CodexAppServerEventProjector> {
  return new CodexAppServerEventProjector(await createParams(), THREAD_ID, TURN_ID);
}

function buildToolTelemetry(
  overrides: Partial<CodexAppServerToolTelemetry> = {},
): CodexAppServerToolTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
    ...overrides,
  };
}

function forCurrentTurn(
  method: ProjectorNotification["method"],
  params: Record<string, unknown>,
): ProjectorNotification {
  return {
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, ...params },
  } as ProjectorNotification;
}

function classifyProjectedAttemptResult(result: ProjectedAttemptResult) {
  const finalAssistantText = result.assistantTexts.join("\n\n").trim();
  return classifyEmbeddedPiRunResultForModelFallback({
    provider: "codex",
    model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
    result: createContractRunResult({
      ...result,
      meta: {
        durationMs: 1,
        aborted: result.aborted,
        agentHarnessResultClassification: result.agentHarnessResultClassification,
        finalAssistantRawText: finalAssistantText || undefined,
        finalAssistantVisibleText: finalAssistantText || undefined,
      },
    }),
  });
}

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("Outcome/fallback runtime contract - Codex app-server adapter", () => {
  it("preserves an empty terminal turn for OpenClaw-owned fallback classification", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.promptError).toBeNull();
  });

  it("preserves exact NO_REPLY as assistant text instead of classifying in the adapter", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: "msg-1",
        delta: "NO_REPLY",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "NO_REPLY" }],
        },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "NO_REPLY" }]);
    expect(result.promptError).toBeNull();
  });

  it("preserves reasoning-only terminal turns for OpenClaw-owned fallback classification", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/reasoning/textDelta", {
        itemId: "reasoning-1",
        delta: OUTCOME_FALLBACK_RUNTIME_CONTRACT.reasoningOnlyText,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "reasoning", id: "reasoning-1" }],
        },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.promptError).toBeNull();
    expect(result.messagesSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Codex reasoning:\n${OUTCOME_FALLBACK_RUNTIME_CONTRACT.reasoningOnlyText}`,
            },
          ],
        }),
      ]),
    );
  });

  it("preserves planning-only terminal turns for OpenClaw-owned fallback classification", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/plan/delta", {
        itemId: "plan-1",
        delta: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [
            {
              type: "plan",
              id: "plan-1",
              text: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText,
            },
          ],
        },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.promptError).toBeNull();
    expect(result.messagesSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Codex plan:\n${OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText}`,
            },
          ],
        }),
      ]),
    );
  });

  it("preserves tool side-effect telemetry so fallback can stay disabled", async () => {
    const projector = await createProjector();

    const result = projector.buildResult(
      buildToolTelemetry({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["sent out of band"],
      }),
    );

    expect(result.assistantTexts).toEqual([]);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["sent out of band"]);
  });

  it.each([
    {
      name: "empty",
      classification: "empty",
      expectedCode: "empty_result",
      build: async () => {
        const projector = await createProjector();
        await projector.handleNotification(
          forCurrentTurn("turn/completed", {
            turn: { id: TURN_ID, status: "completed", items: [] },
          }),
        );
        return projector.buildResult(buildToolTelemetry());
      },
    },
    {
      name: "reasoning-only",
      classification: "reasoning-only",
      expectedCode: "reasoning_only_result",
      build: async () => {
        const projector = await createProjector();
        await projector.handleNotification(
          forCurrentTurn("item/reasoning/textDelta", {
            itemId: "reasoning-1",
            delta: OUTCOME_FALLBACK_RUNTIME_CONTRACT.reasoningOnlyText,
          }),
        );
        await projector.handleNotification(
          forCurrentTurn("turn/completed", {
            turn: {
              id: TURN_ID,
              status: "completed",
              items: [{ type: "reasoning", id: "reasoning-1" }],
            },
          }),
        );
        return projector.buildResult(buildToolTelemetry());
      },
    },
    {
      name: "planning-only",
      classification: "planning-only",
      expectedCode: "planning_only_result",
      build: async () => {
        const projector = await createProjector();
        await projector.handleNotification(
          forCurrentTurn("item/plan/delta", {
            itemId: "plan-1",
            delta: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText,
          }),
        );
        await projector.handleNotification(
          forCurrentTurn("turn/completed", {
            turn: {
              id: TURN_ID,
              status: "completed",
              items: [
                {
                  type: "plan",
                  id: "plan-1",
                  text: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText,
                },
              ],
            },
          }),
        );
        return projector.buildResult(buildToolTelemetry());
      },
    },
  ] as const)(
    "keeps $name terminal turns fallback-ready with adapter-produced classification",
    async ({ build, classification, expectedCode }) => {
      const result = await build();

      expect(result.agentHarnessResultClassification).toBe(classification);
      expect(classifyProjectedAttemptResult(result)).toMatchObject({
        reason: "format",
        code: expectedCode,
      });
    },
  );

  it("keeps exact NO_REPLY classified as an intentional silent terminal reply", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: "msg-1",
        delta: "NO_REPLY",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "NO_REPLY" }],
        },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(classifyProjectedAttemptResult(result)).toBeNull();
  });

  it("keeps tool side effects classified as non-fallback terminal outcomes", async () => {
    const projector = await createProjector();
    const result = projector.buildResult(
      buildToolTelemetry({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["sent out of band"],
      }),
    );

    expect(result.agentHarnessResultClassification).toBeUndefined();
    expect(classifyProjectedAttemptResult(result)).toBeNull();
  });
});
