import { describe, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { executeDeps } from "../../agents/cli-runner/execute-deps.js";
import { executePreparedCliRun } from "../../agents/cli-runner/execute.js";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  requireMockCall,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  makeTestSessionStorePath,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during CLI admission test");
}

describe("executeAgentTurn: CLI admission", () => {
  it.each(["revised", "revision-established"])(
    "rejects a %s parent lifecycle before queued CLI execution",
    async (kind) => {
      const sessionKey = "agent:main:cli-revision";
      const storePath = makeTestSessionStorePath();
      const entry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        ...(kind === "revised" ? { lifecycleRevision: "original" } : {}),
      };
      const binding = { sessionId: "native-session", authProfileId: "anthropic:cli" };
      await replaceSessionEntry(
        { sessionKey, storePath },
        { ...entry, cliSessionBindings: { "claude-cli": binding } },
      );
      const followupRun = createFollowupRun();
      followupRun.run.provider = "claude-cli";
      followupRun.run.model = "claude-sonnet-4-6";
      state.isCliProviderMock.mockReturnValue(true);
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run(
            "claude-cli",
            "claude-sonnet-4-6",
            initialFallbackAttemptOptions(params),
          ),
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          attempts: [],
        }),
      );
      state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
      const uninstall = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
        executeLocalTurn: async (_claim, runLocal) => {
          // Mutating the prepared object must not change the captured admission revision.
          entry.lifecycleRevision = "replacement";
          await replaceSessionEntry(
            { sessionKey, storePath },
            { ...entry, cliSessionBindings: { "claude-cli": binding } },
          );
          return await runLocal();
        },
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
      });
      try {
        const executeAgentTurn = await getExecuteAgentTurnForTest();
        const result = await executeAgentTurn({
          ...createMinimalRunAgentTurnParams({ followupRun }),
          sessionKey,
          storePath,
          activeSessionStore: { [sessionKey]: entry },
          getActiveSessionEntry: () => entry,
        });
        expect(result.kind).toBe("final");
        expect(state.runCliAgentMock).not.toHaveBeenCalled();
        expect(
          loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.["claude-cli"],
        ).toEqual(binding);
      } finally {
        uninstall();
      }
    },
  );

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
        await executePreparedCliRun(prepared, observedCliSessionId);
      } finally {
        executeDeps.invokeNodeClaudeCliRun = restoreNodeInvoke;
      }
      expect(nodeInvoke).toHaveBeenCalledOnce();
    } finally {
      restoreAdmission();
    }
  });
});
