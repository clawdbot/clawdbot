import { describe, expect, it } from "vitest";
import {
  resolveCodeModeContinuationInstruction,
  resolveCodeModeContinuationToolPolicy,
  resolveCodeModeTargetlessSideEffectEvidence,
  resolveEmptyResponseRetryInstruction,
  shouldLatchCodeModeReadOnlyForRun,
} from "./incomplete-turn.js";
import {
  consumeForceRestartSafeToolsForNextAttempt,
  createEmbeddedRunTerminalRetryState,
  resolveForceReadOnlyToolsForAttempt,
} from "./terminal-retry-state.js";

describe("settled Code Mode continuation policy", () => {
  it("uses normal tools after reads and read-only tools after mutations", () => {
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: true,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      }),
    ).toBe("normal");
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: true,
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: true },
      }),
    ).toBe("read-only");
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: true,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: false },
      }),
    ).toBe("normal");
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      }),
    ).toBeNull();
  });

  it("distinguishes targetless side effects from tracked file mutations", () => {
    expect(
      resolveCodeModeTargetlessSideEffectEvidence({
        codeModeEngaged: true,
        toolMetas: [
          { replaySafe: false, codeModeHadTargetlessSideEffects: false },
          { replaySafe: true },
        ],
      }),
    ).toBe(false);
    expect(
      resolveCodeModeTargetlessSideEffectEvidence({
        codeModeEngaged: true,
        toolMetas: [
          {
            toolName: "write",
            replaySafe: false,
            mutatingAction: true,
            fileTarget: { path: "result.txt" },
          },
        ],
      }),
    ).toBeNull();
    expect(
      resolveCodeModeTargetlessSideEffectEvidence({
        codeModeEngaged: true,
        toolMetas: [
          { codeModeHadTargetlessSideEffects: false },
          { codeModeHadTargetlessSideEffects: true },
        ],
      }),
    ).toBe(true);
    expect(
      resolveCodeModeTargetlessSideEffectEvidence({
        codeModeEngaged: true,
        toolMetas: [
          { replaySafe: false, codeModeHadTargetlessSideEffects: false },
          { replaySafe: false },
        ],
      }),
    ).toBeNull();
    expect(
      resolveCodeModeTargetlessSideEffectEvidence({
        codeModeEngaged: true,
        toolMetas: [
          {
            toolName: "write",
            replaySafe: false,
            mutatingAction: true,
            fileMutationExecutionStarted: true,
            fileTarget: { path: "result.txt" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      resolveCodeModeTargetlessSideEffectEvidence({
        codeModeEngaged: true,
        toolMetas: [
          {
            toolName: "apply_patch",
            replaySafe: false,
            mutatingAction: true,
            fileMutationExecutionStarted: true,
            fileTargets: [{ path: "a.ts" }, { path: "b.ts" }],
          },
        ],
      }),
    ).toBe(false);
  });

  it.each([
    {
      label: "proven file-only mutation",
      mutationVerificationRequired: true,
      targetlessSideEffectEvidence: false,
      expected: false,
    },
    {
      label: "unknown side-effect coverage",
      mutationVerificationRequired: true,
      targetlessSideEffectEvidence: null,
      expected: true,
    },
    {
      label: "observed targetless side effect",
      mutationVerificationRequired: true,
      targetlessSideEffectEvidence: true,
      expected: true,
    },
  ])("latches run-wide read-only policy for $label", (scenario) => {
    expect(shouldLatchCodeModeReadOnlyForRun(scenario)).toBe(scenario.expected);
  });

  it.each([
    {
      label: "pending file verification",
      mutationVerificationRequired: true,
      targetlessSideEffectEvidence: false,
      toolPolicy: "read-only" as const,
      expectedFragment: "stopped before verification",
    },
    {
      label: "completed and verified file mutation",
      mutationVerificationRequired: false,
      targetlessSideEffectEvidence: false,
      toolPolicy: "normal" as const,
      expectedFragment: "completed and verified file mutations",
    },
    {
      label: "targetless mutation",
      mutationVerificationRequired: false,
      targetlessSideEffectEvidence: true,
      toolPolicy: "read-only" as const,
      expectedFragment: "using only the available read-only tools",
    },
    {
      label: "read-only prior work",
      mutationVerificationRequired: false,
      targetlessSideEffectEvidence: null,
      toolPolicy: "normal" as const,
      expectedFragment: "previous Code Mode step was read-only",
    },
  ])("selects mutation-aware continuation text for $label", (scenario) => {
    expect(resolveCodeModeContinuationInstruction(scenario)).toContain(scenario.expectedFragment);
  });

  it("retries an empty stop after a proven side-effect-free Code Mode error", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "module imports are unavailable" },
        toolMetas: [
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: true,
          },
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: true,
          },
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      } as never,
    });

    expect(instruction).toContain("failed without side effects");
    expect(instruction).toContain("injected global tools");
  });

  it("retries a settled terminal toolUse after a proven side-effect-free Code Mode error", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        currentAttemptAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "text parse failed" },
        toolMetas: [
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: true,
          },
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      } as never,
    });

    expect(instruction).toContain("failed without side effects");
  });

  it("does not retry an empty stop after an unproven Code Mode error", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "nested call failed" },
        toolMetas: [{ toolName: "exec", isError: true, replaySafe: false }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      } as never,
    });

    expect(instruction).toBeNull();
  });

  it("does not reopen an exhausted side-effect-free Code Mode repair", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "corrected code still failed" },
        toolMetas: [
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: false,
          },
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      } as never,
    });

    expect(instruction).toBeNull();
  });

  it("keeps restart-safe restrictions latched across continuation attempts", () => {
    const state = createEmbeddedRunTerminalRetryState();
    state.forceRestartSafeToolsForNextAttempt = true;

    expect(consumeForceRestartSafeToolsForNextAttempt(state, false)).toBe(true);
    expect(consumeForceRestartSafeToolsForNextAttempt(state, false)).toBe(true);
    expect(consumeForceRestartSafeToolsForNextAttempt(state, true)).toBe(true);
  });

  it("keeps terminal verification restrictions latched at dispatch", () => {
    const state = createEmbeddedRunTerminalRetryState();
    state.forceReadOnlyToolsUntilVerification = true;

    expect(resolveForceReadOnlyToolsForAttempt(state, false)).toBe(true);
    expect(state.forceReadOnlyToolsUntilVerification).toBe(true);
    expect(resolveForceReadOnlyToolsForAttempt(state, false)).toBe(true);
    expect(resolveForceReadOnlyToolsForAttempt(state, true)).toBe(true);
  });

  it("keeps targetless side-effect restrictions latched across attempts", () => {
    const state = createEmbeddedRunTerminalRetryState();
    state.forceReadOnlyToolsForRun = true;

    expect(resolveForceReadOnlyToolsForAttempt(state, false)).toBe(true);
    expect(resolveForceReadOnlyToolsForAttempt(state, false)).toBe(true);
    expect(resolveForceReadOnlyToolsForAttempt(state, true)).toBe(true);
  });
});
