/** Tests bounded transcript-flush probing before reusing CLI bindings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { YIELD_DIAGNOSTIC_TEXT } from "../embedded-agent-runner/run/incomplete-turn-resolution.js";
import { buildCliRunResult } from "./cli-run-settlement.js";

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/openclaw-workspace";

  beforeEach(() => {
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  it("returns false when no sessionId is provided", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed(undefined, "claude-cli")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true when the transcript has content on the first probe", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-fresh", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ sessionId: "sid-fresh", workspaceDir });
  });

  it("retries up to three times before giving up", async () => {
    const delay = vi.fn(async () => undefined);
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-cold", "claude-cli", workspaceDir)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(delay).toHaveBeenNthCalledWith(2, 150);
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    const delay = vi.fn(async () => undefined);
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 2;
    });
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-late", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    try {
      // Fake timers enforce the retry contract without introducing wall-clock
      // sleeps into this import-heavy agent test.
      const probe = vi.fn(async () => false);
      setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

      const settled = vi.fn();
      const errored = vi.fn();
      isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir).then(settled, errored);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(150);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBe(false);
      expect(errored).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns true without probing for non-claude-cli providers", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-codex", "codex-cli")).toBe(true);
    expect(await isCliBindingFlushed("sid-anthropic", "anthropic")).toBe(true);
    expect(await isCliBindingFlushed("sid-openai", "openai")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when provider is undefined", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-x", undefined)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when the caller owns continuity outside native transcripts", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-warm", "claude-cli", workspaceDir, {
        skipTranscriptProbe: true,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("still probes when transcript-probe skipping is disabled", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-probe", "claude-cli", workspaceDir, {
        skipTranscriptProbe: false,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("buildCliRunResult yield diagnostic", () => {
  const context = buildPreparedCliRunContext();
  const baseParams = {
    context,
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: true,
    preparedContextAgentMeta: {},
  };
  const baseOutput: CliOutput = { text: "" };

  function buildResultPayloads(output: CliOutput) {
    return buildCliRunResult({ ...baseParams, output }).payloads;
  }

  it("appends the diagnostic for a bare yielded output with no continuation evidence", () => {
    expect(buildResultPayloads({ ...baseOutput, yielded: true })).toEqual([
      { text: YIELD_DIAGNOSTIC_TEXT },
    ]);
  });

  it("appends the diagnostic after narrated assistant text when there is no continuation evidence", () => {
    // Regression: the narrated-text case is the one ClawSweeper flagged as untested —
    // a yield with visible narrated output but no continuation evidence must still get
    // the recovery warning appended after that text, not silently suppress it.
    expect(
      buildResultPayloads({ ...baseOutput, text: "I'll fix this now...", yielded: true }),
    ).toEqual([{ text: "I'll fix this now..." }, { text: YIELD_DIAGNOSTIC_TEXT }]);
  });

  it("does not append the diagnostic when the turn did not yield", () => {
    expect(buildResultPayloads({ ...baseOutput, text: "done" })).toEqual([{ text: "done" }]);
  });

  it("recognizes committed messaging delivery as continuation evidence", () => {
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        messagingToolSentTexts: ["done"],
      }),
    ).toBeUndefined();
  });

  it("recognizes an accepted subagent spawn as continuation evidence", () => {
    // Regression: this is the case ClawSweeper flagged — a yield right after a valid
    // spawn (no messaging tool involved at all) must not show the no-continuation
    // diagnostic, since the spawn's completion will resume the session later.
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        acceptedSessionSpawns: [{ runId: "run-1", childSessionKey: "agent:main:sub-1" }],
      }),
    ).toBeUndefined();
  });

  it("does not count an empty accepted-spawns array as continuation evidence", () => {
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        acceptedSessionSpawns: [],
      }),
    ).toEqual([{ text: YIELD_DIAGNOSTIC_TEXT }]);
  });

  it("recognizes a successful cron add as continuation evidence", () => {
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        successfulCronAdds: 1,
      }),
    ).toBeUndefined();
  });

  it("does not count a zero cron-add count as continuation evidence", () => {
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        successfulCronAdds: 0,
      }),
    ).toEqual([{ text: YIELD_DIAGNOSTIC_TEXT }]);
  });

  it("recognizes an async-started tool as continuation evidence", () => {
    // Regression: ClawSweeper flagged that a CLI yield right after an async-start (no
    // messaging/spawn/cron involved) still showed the no-continuation diagnostic.
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        hadAsyncStartedTool: true,
      }),
    ).toBeUndefined();
  });

  it("does not count hadAsyncStartedTool=false as continuation evidence", () => {
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        hadAsyncStartedTool: false,
      }),
    ).toEqual([{ text: YIELD_DIAGNOSTIC_TEXT }]);
  });

  it("recognizes a surfaced approval prompt as continuation evidence", () => {
    // Regression: ClawSweeper flagged that a CLI yield right after an approval-pending or
    // approval-unavailable tool result still showed the no-continuation diagnostic.
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        hadPendingApprovalTool: true,
      }),
    ).toBeUndefined();
  });

  it("does not count hadPendingApprovalTool=false as continuation evidence", () => {
    expect(
      buildResultPayloads({
        ...baseOutput,
        yielded: true,
        hadPendingApprovalTool: false,
      }),
    ).toEqual([{ text: YIELD_DIAGNOSTIC_TEXT }]);
  });
});
