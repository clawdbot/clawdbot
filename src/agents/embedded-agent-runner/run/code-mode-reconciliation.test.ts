import { describe, expect, it, vi } from "vitest";
import { createNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { fakeTool, pluginToolWithExecute } from "../../code-mode.test-support.js";
import {
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { hashToolCall } from "../../tool-loop-detection.js";
import { jsonResult } from "../../tools/common.js";
import {
  advanceCodeModeRecovery,
  applyCodeModeRecoveryToolSurface,
  buildCodeModeRecoveryCandidate,
} from "./code-mode-reconciliation.js";
import { registerCodeModeRecoveryJournalEntry } from "./code-mode-recovery-journal.js";
import {
  createEmbeddedRunTerminalRetryState,
  type CodeModeRecoveryState,
} from "./terminal-retry-state.js";

function eligibleAttempt() {
  return makeEmbeddedRunnerAttempt({
    codeModeRecoveryCandidate: { blockedActionKeys: ["write:prior"] },
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
  });
}

function prepare(
  tool: ReturnType<typeof fakeTool>,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<InternalToolExecutionPreparer>>> {
  const preparer = getInternalToolExecutionPreparer(tool);
  if (!preparer) {
    throw new Error("Expected recovery preparer");
  }
  return preparer({ toolCallId: "call", args });
}

describe("Code Mode recovery", () => {
  it("allows recovery when every recorded nested call proves no effect", () => {
    const activity = createNestedToolActivity({
      runId: "run",
      scopeId: "scope",
      afterEntryId: null,
      startOrder: 0,
      parentToolCallId: "exec",
      toolCallId: "nested",
      toolName: "write",
      input: { value: "test" },
      result: jsonResult({}),
      isError: true,
      startedAt: 1,
      timestamp: 2,
    });
    registerCodeModeRecoveryJournalEntry(activity, {
      actionKey: hashToolCall("write", { value: "test" }),
      effectState: "failed_no_effect",
    });

    expect(
      buildCodeModeRecoveryCandidate({
        parentToolCallId: "exec",
        nestedToolActivities: [activity],
      }),
    ).toEqual({ blockedActionKeys: [] });
  });

  it("moves one quiescent candidate into read-only inspection", () => {
    const retryState = createEmbeddedRunTerminalRetryState();
    let prompt = "";
    expect(
      advanceCodeModeRecovery({
        attempt: eligibleAttempt(),
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: (value) => {
          prompt = value;
        },
      }),
    ).toBe(true);
    expect(retryState.codeModeRecovery).toEqual({
      kind: "inspect",
      phase: "read-required",
      blockedActionKeys: ["write:prior"],
    });
    expect(prompt).toContain("recovery_resume");
  });

  it.each([
    ["active tool", { itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 } }],
    ["async work", { toolMetas: [{ toolName: "exec", asyncStarted: true }] }],
    ["message delivery", { didSendViaMessagingTool: true }],
    ["child session", { acceptedSessionSpawns: [{ runId: "child" }] }],
    ["approval", { didSendDeterministicApprovalPrompt: true }],
    ["yield", { yieldDetected: true }],
    ["plugin-owned transport", {}, false],
  ])("rejects a candidate with %s", (_label, overrides, hostOwnsToolSurface = true) => {
    expect(
      advanceCodeModeRecovery({
        attempt: { ...eligibleAttempt(), ...overrides } as ReturnType<typeof eligibleAttempt>,
        hostOwnsToolSurface,
        retryState: createEmbeddedRunTerminalRetryState(),
        activateInternalPrompt: () => undefined,
      }),
    ).toBe(false);
  });

  it("ends on the inspection report when no recovery is requested", () => {
    const retryState = createEmbeddedRunTerminalRetryState();
    retryState.codeModeRecovery = {
      kind: "inspect",
      phase: "ready",
      blockedActionKeys: ["write:prior"],
    };
    const activateInternalPrompt = vi.fn();
    expect(
      advanceCodeModeRecovery({
        attempt: makeEmbeddedRunnerAttempt({
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          toolMetas: [{ toolName: "read", isError: false }],
        }),
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt,
      }),
    ).toBe(false);
    expect(retryState.codeModeRecovery).toEqual({ kind: "idle" });
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("requires a completed read before requesting bounded recovery", async () => {
    const state: Extract<CodeModeRecoveryState, { kind: "inspect" }> = {
      kind: "inspect",
      phase: "read-required",
      blockedActionKeys: ["write:prior"],
    };
    const read = pluginToolWithExecute("read", "Read", async () => jsonResult({ value: "ok" }));
    const tools = applyCodeModeRecoveryToolSurface({
      tools: [read, fakeTool("write", "Write")],
      state,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read", "recovery_resume"]);
    await expect(tools[1]?.execute("resume", {})).rejects.toThrow("Use read by itself");
    const prepared = await prepare(read, { path: "proof.txt" });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      await prepared.execute(() => undefined);
    }
    expect(state.phase).toBe("ready");
    await expect(tools[1]?.execute("resume", {})).resolves.toMatchObject({ terminate: true });
  });

  it("enters one normal-tool recovery after read and resume request", () => {
    const retryState = createEmbeddedRunTerminalRetryState();
    retryState.codeModeRecovery = {
      kind: "inspect",
      phase: "ready",
      blockedActionKeys: ["write:prior"],
    };
    expect(
      advanceCodeModeRecovery({
        attempt: makeEmbeddedRunnerAttempt({
          itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
          toolMetas: [
            { toolName: "read", isError: false },
            { toolName: "recovery_resume", isError: false, terminate: true },
          ],
        }),
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: () => undefined,
      }),
    ).toBe(true);
    expect(retryState.codeModeRecovery).toMatchObject({
      kind: "resume",
      mutationAttempt: "available",
    });
  });

  it("blocks exact unsafe replays without consuming the mutation budget", async () => {
    const args = { path: "proof.txt", content: "alpha=applied" };
    const state: Extract<CodeModeRecoveryState, { kind: "resume" }> = {
      kind: "resume",
      blockedActionKeys: new Set([hashToolCall("write", args)]),
      mutationAttempt: "available",
    };
    const write = applyCodeModeRecoveryToolSurface({
      tools: [fakeTool("write", "Write")],
      state,
    })[0]!;
    const blocked = await prepare(write, args);
    expect(blocked).toMatchObject({
      kind: "immediate",
      outcome: { kind: "result", isError: true },
    });
    expect(state.mutationAttempt).toBe("available");
  });

  it("allows reads after one mutation and blocks later mutation work", async () => {
    const firstExecute = vi.fn(async () => {
      throw new Error("first recovery mutation failed");
    });
    const state: Extract<CodeModeRecoveryState, { kind: "resume" }> = {
      kind: "resume",
      blockedActionKeys: new Set(),
      mutationAttempt: "available",
    };
    const [write, read, applyPatch] = applyCodeModeRecoveryToolSurface({
      tools: [
        pluginToolWithExecute("write", "Write", firstExecute),
        fakeTool("read", "Read"),
        fakeTool("apply_patch", "Patch"),
      ],
      state,
    });
    const first = await prepare(write!, { path: "proof.txt" });
    expect(first.kind).toBe("ready");
    expect(state.mutationAttempt).toBe("reserved");
    if (first.kind === "ready") {
      await expect(first.execute(() => undefined)).rejects.toThrow(
        "first recovery mutation failed",
      );
    }
    expect(state.mutationAttempt).toBe("consumed");
    expect((await prepare(read!, { path: "proof.txt" })).kind).toBe("ready");
    expect(await prepare(applyPatch!, { input: "later work" })).toMatchObject({
      kind: "immediate",
      outcome: { kind: "result", isError: true },
    });
    expect(firstExecute).toHaveBeenCalledOnce();
  });

  it("releases a reserved mutation when the prepared call does not start", async () => {
    const state: Extract<CodeModeRecoveryState, { kind: "resume" }> = {
      kind: "resume",
      blockedActionKeys: new Set(),
      mutationAttempt: "available",
    };
    const write = applyCodeModeRecoveryToolSurface({
      tools: [fakeTool("write", "Write")],
      state,
    })[0]!;
    const prepared = await prepare(write, { path: "proof.txt" });
    expect(prepared.kind).toBe("ready");
    expect(state.mutationAttempt).toBe("reserved");
    prepared.dispose();
    expect(state.mutationAttempt).toBe("available");
  });

  it.each([
    ["get_cursor_position", false],
    ["list_windows", true],
  ])(
    "keeps computer %s available around one input (observation error: %s)",
    async (action, fails) => {
      const unsafe = { action: "key", text: "ENTER" };
      const state: Extract<CodeModeRecoveryState, { kind: "resume" }> = {
        kind: "resume",
        blockedActionKeys: new Set([hashToolCall("computer", unsafe)]),
        mutationAttempt: "available",
      };
      const execute = vi.fn<Parameters<typeof pluginToolWithExecute>[2]>(async () =>
        jsonResult({}),
      );
      const computer = applyCodeModeRecoveryToolSurface({
        tools: [pluginToolWithExecute("computer", "Computer", execute)],
        state,
      })[0]!;
      const observe = async () => {
        const prepared = await prepare(computer, { action });
        expect(prepared.kind).toBe("ready");
        if (prepared.kind !== "ready") {
          throw new Error("Observation was blocked");
        }
        try {
          if (fails) {
            execute.mockRejectedValueOnce(new Error("observation unavailable"));
          }
          const result = prepared.execute(() => undefined);
          if (fails) {
            await expect(result).rejects.toThrow("observation unavailable");
          } else {
            await result;
          }
        } finally {
          prepared.dispose();
        }
      };
      await observe();
      expect(state.mutationAttempt).toBe("available");
      expect((await prepare(computer, unsafe)).kind).toBe("immediate");
      const input = await prepare(computer, { action: "key", text: "ESC" });
      expect(input.kind).toBe("ready");
      if (input.kind === "ready") {
        await input.execute(() => undefined);
        input.dispose();
      }
      expect(state.mutationAttempt).toBe("consumed");
      await observe();
      expect(state.mutationAttempt).toBe("consumed");
      expect((await prepare(computer, { action: "type", text: "later" })).kind).toBe("immediate");
      expect(execute.mock.calls.map(([, args]) => args)).toEqual([
        { action },
        { action: "key", text: "ESC" },
        { action },
      ]);
    },
  );
});
