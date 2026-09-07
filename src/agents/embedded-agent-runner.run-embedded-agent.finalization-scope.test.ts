// Exercises a child turn after its launching parent has closed, through the real
// run loop, harness selection, active-run registration, and transcript writer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let prepareSystemAgentRunAdmission: typeof import("./admitted-run-context.js").prepareSystemAgentRunAdmission;
let withPreparedEmbeddedRunToolAuthority: typeof import("./harness/tool-authority.runtime.js").withPreparedEmbeddedRunToolAuthority;
let withOwnedSessionTranscriptWrites: typeof import("../config/sessions/transcript-write-context.js").withOwnedSessionTranscriptWrites;
let getGatewayToolCallerIdentity: typeof import("./tools/gateway-caller-context.js").getGatewayToolCallerIdentity;
let setActiveEmbeddedRun: typeof import("./embedded-agent-runner/runs.js").setActiveEmbeddedRun;
let clearActiveEmbeddedRun: typeof import("./embedded-agent-runner/runs.js").clearActiveEmbeddedRun;
let createEmbeddedRunHandle: typeof import("./embedded-agent-runner/runs.test-support.js").createEmbeddedRunHandle;
let replaceSessionEntry: typeof import("../config/sessions/session-accessor.js").replaceSessionEntry;
let appendMessage: typeof import("../plugin-sdk/session-transcript-runtime.js").appendSessionTranscriptMessageByIdentity;
let readMessages: typeof import("../plugin-sdk/session-transcript-runtime.js").readVisibleSessionTranscriptMessageEntries;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: (params) => runAttempt(params) });
  // Keep the real harness boundary, including its temporary tool-authority scope.
  vi.doUnmock("./harness/selection.js");
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js"));
  ({ withPreparedEmbeddedRunToolAuthority } = await import("./harness/tool-authority.runtime.js"));
  ({ withOwnedSessionTranscriptWrites } =
    await import("../config/sessions/transcript-write-context.js"));
  ({ getGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js"));
  ({ setActiveEmbeddedRun, clearActiveEmbeddedRun } =
    await import("./embedded-agent-runner/runs.js"));
  ({ createEmbeddedRunHandle } = await import("./embedded-agent-runner/runs.test-support.js"));
  ({ replaceSessionEntry } = await import("../config/sessions/session-accessor.js"));
  ({
    appendSessionTranscriptMessageByIdentity: appendMessage,
    readVisibleSessionTranscriptMessageEntries: readMessages,
  } = await import("../plugin-sdk/session-transcript-runtime.js"));
});

afterEach(() => runAttempt.mockReset());

describe("nested settled-turn finalization ownership", () => {
  it.each(["answer", "unavailable", "closed"] as const)(
    "preserves child ownership when finalization is %s after the parent closes",
    async (finalization) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "nested-finalization-")),
      );
      const agentDir = path.join(root, "agents", "test", "agent");
      const workspaceDir = path.join(root, "workspace");
      await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(workspaceDir)]);
      const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
      const target = {
        agentId: "test",
        sessionId: "child-session",
        sessionKey: "agent:test:child",
        storePath: path.join(agentDir, "openclaw-agent.sqlite"),
      };
      const parentTarget = {
        ...target,
        sessionId: "parent-session",
        sessionKey: "agent:test:parent",
      };
      const childAdmission = prepareSystemAgentRunAdmission(
        config,
        "child-run",
        "test",
        "nested-finalization-test",
      );
      const parentAdmission = prepareSystemAgentRunAdmission(
        config,
        "parent-run",
        "test",
        "nested-finalization-parent",
      );
      const completedTool = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "write-once", name: "write", arguments: {} }],
      });
      const messages = [
        { role: "user" as const, content: "Write once and summarize.", timestamp: 1 },
        completedTool,
        {
          role: "toolResult" as const,
          toolCallId: "write-once",
          toolName: "write",
          content: [{ type: "text" as const, text: "written" }],
          isError: false,
          timestamp: 3,
        },
      ];
      let toolRuns = 0;
      let finalizerRuns = 0;
      runAttempt.mockImplementation(async (params: EmbeddedRunAttemptParams) => {
        const handle = createEmbeddedRunHandle({
          runId: params.runId,
          toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        });
        setActiveEmbeddedRun(
          params.sessionId,
          handle,
          params.sessionKey,
          params.sessionFile,
          params.agentId,
        );
        try {
          const sessionKey = params.sessionTarget?.sessionKey;
          if (!sessionKey) {
            throw new Error("The runner must prepare a transcript target before dispatch");
          }
          const appendTarget = { ...params.sessionTarget, sessionId: target.sessionId, sessionKey };
          expect(getGatewayToolCallerIdentity()?.operationalRunInstance).toBe(
            params.admittedRunContext.operationalRunInstance,
          );
          if (params.operation === "settled-tool-finalization") {
            finalizerRuns += 1;
            expect(params.disableTools).toBe(true);
            if (finalization === "closed") {
              childAdmission.close();
            }
            if (finalization !== "answer") {
              throw new Error("Synthetic summary provider unavailable");
            }
            const assistant = buildEmbeddedRunnerAssistant({
              content: [{ type: "text", text: "The write completed." }],
            });
            await appendMessage({
              ...appendTarget,
              message: assistant,
            });
            return makeEmbeddedRunnerAttempt({
              sessionIdUsed: params.sessionId,
              lastAssistant: assistant,
              currentAttemptCompletedAssistant: assistant,
              assistantTexts: ["The write completed."],
              assistantTranscriptOwned: true,
            });
          }
          toolRuns += 1;
          for (const message of messages) {
            await appendMessage({ ...appendTarget, message });
          }
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            messagesSnapshot: messages,
            lastAssistant: completedTool,
            currentAttemptCompletedAssistant: undefined,
            toolMetas: [{ toolName: "write", toolCallId: "write-once", replaySafe: false }],
            itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
            codeModeEngaged: true,
            settledTurnFinalizationContext: { source: "openclaw-transcript", messages },
          });
        } finally {
          clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
        }
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let child: ReturnType<typeof runEmbeddedAgent> | undefined;
      try {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const parentContext = await parentAdmission.admit("embedded");
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext: parentContext },
          {
            ...parentTarget,
            sessionFile: parentTarget.sessionKey,
            config,
            workspaceDir,
            runId: "parent-run",
            provider: "openai",
            modelId: "mock-1",
          },
          undefined,
          async () =>
            withOwnedSessionTranscriptWrites(
              {
                sessionTarget: parentTarget,
                assertCommitAllowed: () => {
                  throw new Error("The parent writer is closed");
                },
                withTranscriptWrite: async (write) => await write(),
              },
              async () => {
                // Admission happens independently, but the queued promise retains
                // the originating parent ALS scopes just like an in-process send.
                child = released.then(() =>
                  runEmbeddedAgent({
                    preparedRunAdmission: childAdmission,
                    ...target,
                    sessionTarget: target,
                    workspaceDir,
                    agentDir,
                    config,
                    prompt: "Write once and summarize.",
                    provider: "openai",
                    model: "mock-1",
                    agentHarnessRuntimeOverride: "openclaw",
                    runId: "child-run",
                    timeoutMs: 10_000,
                    enqueue: async (task) => await task(),
                  }),
                );
              },
            ),
        );
        parentAdmission.close();
        release();
        if (finalization === "closed") {
          await expect(child).rejects.toThrow("admitted run authority is no longer active");
          expect(toolRuns).toBe(1);
          expect(finalizerRuns).toBe(1);
          expect(await readMessages(target)).toHaveLength(messages.length);
          return;
        }
        const result = await child;
        const expected =
          finalization === "answer"
            ? "The write completed."
            : "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
        expect(result?.payloads).toEqual([expect.objectContaining({ text: expected })]);
        expect(toolRuns).toBe(1);
        expect(finalizerRuns).toBe(1);
        const transcript = await readMessages(target);
        expect(transcript).toHaveLength(messages.length + 1);
        expect(transcript.at(-1)?.message).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: expected }],
        });
      } finally {
        release();
        await child?.catch(() => undefined);
        parentAdmission.close();
        childAdmission.close();
        const { waitForSessionTranscriptIndexReconcile } =
          await import("../config/sessions/session-transcript-reconcile.js");
        const { closeOpenClawAgentDatabaseByPath } = await import("../state/openclaw-agent-db.js");
        const { closeAuthProfileReadPool } = await import("./auth-profiles/sqlite.js");
        try {
          await waitForSessionTranscriptIndexReconcile({ agentId: "test", path: target.storePath });
        } finally {
          closeAuthProfileReadPool({ kind: "database", databasePath: target.storePath });
          closeOpenClawAgentDatabaseByPath(target.storePath);
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});
