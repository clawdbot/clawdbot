import { describe, expect, it, vi } from "vitest";
import { withTestRunAdmission } from "../../agents/admitted-run-context.test-support.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { buildCliRunResult } from "../../agents/cli-runner/cli-run-settlement.js";
import { executeDeps } from "../../agents/cli-runner/execute-deps.js";
import { executePreparedCliRun } from "../../agents/cli-runner/execute.js";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  requireMockCall,
  expectMockCallArgFields,
  initialFallbackAttemptOptions,
  fallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  makeTestSessionStorePath,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during CLI admission test");
}

describe("executeAgentTurn: CLI admission", () => {
  it.each([
    "ordinary",
    "heartbeat",
    "preserved",
    "revised",
    "revision-established",
    "rejected",
    "rejected-clear",
  ])("settles the %s reply's native binding before releasing placement", async (kind) => {
    const sessionKey = "agent:main:cli-binding-settlement";
    const storePath = makeTestSessionStorePath();
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      ...(kind === "revised" ? { lifecycleRevision: "original" } : {}),
    };
    const rejected = kind === "rejected" || kind === "rejected-clear";
    const revisionChanged = kind === "revised" || kind === "revision-established";
    const binding = { sessionId: "admitted-native-session", authProfileId: "anthropic:cli" };
    const settledBinding = { ...binding, sessionId: "settled-native-session" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        cliSessionBindings: { "claude-cli": binding },
      },
    );
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";
    if (kind === "preserved") {
      followupRun.run.inputProvenance = {
        kind: "inter_session",
        sourceTool: "exec_approval_followup",
      };
    }
    state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const first = await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      );
      if (rejected) {
        expect(first).toMatchObject({
          classification: { code: "generic_external_run_failure" },
        });
        return {
          result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "format")),
          provider: "openai",
          model: "gpt-5.4",
          attempts: [{ provider: "claude-cli", model: "claude-sonnet-4-6", reason: "format" }],
        };
      }
      return {
        result: first,
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });
    const candidateResult = {
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: { sessionId: settledBinding.sessionId, cliSessionBinding: settledBinding },
      },
    };
    state.runCliAgentMock.mockResolvedValueOnce(
      rejected
        ? buildCliRunResult({
            context: buildPreparedCliRunContext(),
            output: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
            effectiveCliSessionId: settledBinding.sessionId,
            bindingFlushOk: kind !== "rejected-clear",
            usedHistoryPrompt: false,
            userTurnHandled: true,
            sessionBindingDisabled: false,
            preparedContextAgentMeta: {},
          })
        : candidateResult,
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback done" }],
      meta: {},
    });
    let observedBinding: unknown;
    const uninstall = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        if (revisionChanged) {
          // Mutating the prepared object must not change the captured admission revision.
          entry.lifecycleRevision = "replacement";
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              ...entry,
              cliSessionBindings: { "claude-cli": binding },
            },
          );
        }
        const result = await runLocal();
        observedBinding = loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.[
          "claude-cli"
        ];
        return result;
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });
    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        sessionKey,
        storePath,
        isHeartbeat: kind === "heartbeat",
        activeSessionStore: { [sessionKey]: entry },
        getActiveSessionEntry: () => entry,
      });
      if (revisionChanged) {
        expect(result.kind).toBe("final");
        expect(state.runCliAgentMock).not.toHaveBeenCalled();
        expect(
          loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.["claude-cli"],
        ).toEqual(binding);
        return;
      }
      expect(result.kind).toBe("success");
      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        cliSessionId: binding.sessionId,
        cliSessionBinding: binding,
      });
      expect(observedBinding).toEqual(
        kind === "rejected-clear"
          ? undefined
          : kind === "preserved" || rejected
            ? binding
            : settledBinding,
      );
    } finally {
      uninstall();
    }
  });

  it("carries the admitted session permission and placement into the CLI grant", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    let sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      permissionMode: "guarded",
      sessionRoot: "/workspace/old",
      execHost: "gateway",
      cliSessionBindings: {
        "claude-cli": { sessionId: "old-native-session", forceReuse: true },
      },
    };
    const admittedSessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 2,
      permissionMode: "read-only",
      sessionRoot: "/workspace/project",
      execHost: "node",
      execNode: "node-a",
      execCwd: "/workspace/project/task",
      cliSessionBindings: {
        "claude-cli": { sessionId: "new-native-session", forceReuse: true },
      },
    };
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";
    const restoreAdmission = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        sessionEntry = admittedSessionEntry;
        return await runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        getActiveSessionEntry: () => sessionEntry,
      });

      expect(result.kind).toBe("success");
      const run = requireMockCall(
        state.runCliAgentMock,
        0,
        "CLI run params",
      )[0] as RunCliAgentParams;
      expect(run.sessionEntry).toBe(admittedSessionEntry);
      expect(run.sessionEntry?.sessionRoot).toBe("/workspace/project");
      expect(run.cliSessionId).toBe("new-native-session");
      expect(run.cliSessionBinding).toMatchObject({
        sessionId: "new-native-session",
        forceReuse: true,
      });
      const observedCliSessionId = run.cliSessionBinding?.sessionId ?? run.cliSessionId;
      expect(observedCliSessionId).toBe("new-native-session");
      if (!observedCliSessionId) {
        throw new Error("expected admitted CLI session binding");
      }
      expect(
        buildCliMcpGrantContext({
          run,
          config: run.config ?? {},
          requireExplicitMessageTarget: false,
          agentId: "main",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-6",
        }).execSession,
      ).toMatchObject({
        permissionMode: "read-only",
        execHost: "node",
        execNode: "node-a",
      });

      const nodeInvoke = vi.fn<typeof executeDeps.invokeNodeClaudeCliRun>(async (request) => {
        expect(request.nodeId).toBe("node-a");
        expect(request.argv).toContain("new-native-session");
        expect(request.argv).not.toContain("old-native-session");
        return {
          ok: true,
          payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
        };
      });
      const restoreNodeInvoke = executeDeps.invokeNodeClaudeCliRun;
      const backend = {
        command: "claude",
        args: ["-p"],
        resumeArgs: ["--resume", "{sessionId}"],
        output: "text" as const,
        input: "stdin" as const,
        serialize: true,
      };
      const prepared = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: run.model,
        runId: run.runId,
        workspaceDir: run.workspaceDir,
        config: run.config,
        sessionEntry: run.sessionEntry,
        backend,
      });
      prepared.params = {
        ...run,
        admittedRunContext: prepared.params.admittedRunContext,
        skillsSnapshot: undefined,
      };
      prepared.cwd = run.cwd;
      prepared.reusableCliSession = { mode: "reuse", sessionId: observedCliSessionId };
      executeDeps.invokeNodeClaudeCliRun = nodeInvoke;
      try {
        await withTestRunAdmission(prepared.params, async (admittedRunContext) => {
          prepared.params.admittedRunContext = admittedRunContext;
          await executePreparedCliRun(prepared, observedCliSessionId);
        });
      } finally {
        executeDeps.invokeNodeClaudeCliRun = restoreNodeInvoke;
      }
      expect(nodeInvoke).toHaveBeenCalledOnce();
    } finally {
      restoreAdmission();
    }
  });
});
