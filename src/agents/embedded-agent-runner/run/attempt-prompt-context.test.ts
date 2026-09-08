import { QUEUED_USER_MESSAGE_MARKER } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import * as execApprovals from "../../../infra/exec-approvals.js";
import { withMockedPlatform } from "../../../test-utils/vitest-spies.js";
import { addSession, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import * as mediaTaskStatus from "../../media-generation-task-status.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../subagents/registry/subagent-registry.types.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  info: vi.fn(),
  promptPressureKeys: new Set<string>(),
  reconcileToolResultPromptProjectionState: vi.fn(),
  resolveLiveToolResultAggregateMaxChars: vi.fn(() => 200),
  resolveLiveToolResultMaxChars: vi.fn(() => 100),
  truncateOversizedToolResultsInMessages: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { info: hoisted.info, warn: hoisted.warn },
}));
vi.mock("../tool-result-truncation.js", () => ({
  resolveLiveToolResultAggregateMaxChars: hoisted.resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars: hoisted.resolveLiveToolResultMaxChars,
  reconcileToolResultPromptProjectionState: hoisted.reconcileToolResultPromptProjectionState,
  toolResultWarningDedupe: {
    promptPressure: {
      check: (key: string) => {
        if (hoisted.promptPressureKeys.has(key)) {
          return true;
        }
        hoisted.promptPressureKeys.add(key);
        return false;
      },
    },
  },
  truncateOversizedToolResultsInMessages: hoisted.truncateOversizedToolResultsInMessages,
}));

import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";

const messages = [
  {
    role: "user",
    content: [{ type: "text", text: "Previous request" }],
    timestamp: 100,
  },
] as AgentMessage[];

const projectionState: ToolResultPromptProjectionState = {
  replacements: new Map(),
  frozen: new Set(),
  ambiguousBaseKeys: new Set(),
  restoredCacheTtl: new Map(),
  sourceHashByKey: new Map(),
};

function createAttempt(overrides?: Partial<EmbeddedRunAttemptParams>) {
  return {
    config: {},
    contextTokenBudget: 32_000,
    currentInboundContext: {
      text: "Conversation info: channel=telegram",
    },
    currentInboundEventKind: "user_request",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    suppressNextUserMessagePersistence: false,
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

type PromptInput = Parameters<typeof prepareEmbeddedAttemptPromptContext>[0]["prompt"];

function createPrompt(overrides?: Partial<PromptInput>): PromptInput {
  return {
    effectivePrompt: "Visible request",
    effectiveTranscriptPrompt: "Visible request",
    ...overrides,
  };
}

function createInput(options?: {
  attempt?: EmbeddedRunAttemptParams;
  preparedUserTurnMessage?: AgentMessage;
  prompt?: ReturnType<typeof createPrompt>;
  report?: SessionSystemPromptReport;
}) {
  const replaceSessionMessages = vi.fn();
  const setActiveSessionSystemPrompt = vi.fn();
  const report = options?.report ?? ({} as SessionSystemPromptReport);
  return {
    input: {
      attempt: options?.attempt ?? createAttempt({ trigger: "user" }),
      capabilityToolNames: new Set<string>(),
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      messages,
      preparedUserTurnMessage:
        options?.preparedUserTurnMessage ??
        ({ role: "user", content: "Visible request", timestamp: 123 } as AgentMessage),
      prompt: options?.prompt ?? createPrompt(),
      replaceSessionMessages,
      sessionAgentId: "agent-1",
      setActiveSessionSystemPrompt,
      systemPromptReport: report,
      systemPromptText: "Base system prompt",
      toolResultPromptProjectionState: projectionState,
    },
    replaceSessionMessages,
    report,
    setActiveSessionSystemPrompt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    mediaTaskStatus,
    "buildActiveImageGenerationTaskPromptContextForSession",
  ).mockReturnValue(undefined);
  resetSubagentRegistryForTests();
  hoisted.promptPressureKeys.clear();
  hoisted.reconcileToolResultPromptProjectionState.mockReset();
  hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
    messages: inputMessages,
    truncatedCount: 0,
    aggregateTruncatedCount: 0,
    aggregatePressureEngaged: false,
    aggregateBudgetChars: 200,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  deleteSession("exec-a");
  deleteSession("exec-z");
  resetSubagentRegistryForTests();
});

describe("prepareEmbeddedAttemptPromptContext", () => {
  it("carries current Windows approval hints without changing system or user prompt bytes", () =>
    withMockedPlatform("win32", () => {
      const load = vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({ version: 1 });
      const fixture = createInput();
      fixture.input.capabilityToolNames.add("exec");
      const before = prepareEmbeddedAttemptPromptContext(fixture.input);
      load.mockReturnValue({
        version: 1,
        agents: { "agent-1": { allowlist: [{ pattern: "C:\\Tools\\node.exe" }] } },
      });
      const after = prepareEmbeddedAttemptPromptContext(fixture.input);
      expect(before.runtimeContextMessageForCurrentTurn?.content).toContain(
        "## Approved executables\nnone",
      );
      expect(after.runtimeContextMessageForCurrentTurn?.content).toContain(
        "C:\\Tools\\node.exe (any arguments)",
      );
      expect(after.systemPromptForHook).toBe(before.systemPromptForHook);
      expect(after.promptForSession).toBe(before.promptForSession);
      expect(fixture.setActiveSessionSystemPrompt).not.toHaveBeenCalled();
    }));
  it("carries execution-owned processes in id order without elapsed time or output", () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames.add("process");
    const idle = prepareEmbeddedAttemptPromptContext(fixture.input);
    for (const id of ["exec-z", "exec-a"]) {
      const session = createProcessSessionFixture({ id, backgrounded: true });
      session.scopeKey = fixture.input.attempt.sessionKey;
      session.tail = "private output tail";
      addSession(session);
    }
    const active = prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(active.systemPromptForHook).toBe(idle.systemPromptForHook);
    const content = active.runtimeContextMessageForCurrentTurn?.content;
    expect(content).toContain("Active exec sessions:");
    expect(content).toContain("exec-a running");
    expect(content!.indexOf("exec-a")).toBeLessThan(content!.indexOf("exec-z"));
    expect(content).not.toMatch(/private output tail|runtimeMs|startedAt/);
    expect(active.runtimeContextMessageForCurrentTurn?.details.fragments).toContainEqual({
      kind: "conversation-data",
      text: expect.stringContaining("Active exec sessions:"),
    });
    expect(active.promptForSession).toBe("Visible request");
    expect(fixture.setActiveSessionSystemPrompt).not.toHaveBeenCalled();
  });

  it("carries changed subagent status without rewriting the system prompt", () => {
    const fixture = createInput();
    fixture.input.sessionAgentId = "main";
    fixture.input.capabilityToolNames.add("sessions_spawn");
    const run = {
      runId: "run-worker",
      childSessionKey: "agent:main:subagent:worker",
      controllerSessionKey: fixture.input.attempt.sessionKey!,
      requesterSessionKey: fixture.input.attempt.sessionKey!,
      requesterDisplayKey: "main",
      task: "Inspect fixtures",
      label: "Worker",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "queued" },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const queued = prepareEmbeddedAttemptPromptContext(fixture.input);
    addSubagentRunForTests({ ...run, execution: { status: "running", startedAt: 2 } });
    const running = prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(running.systemPromptForHook).toBe(queued.systemPromptForHook);
    expect(queued.runtimeContextMessageForCurrentTurn?.content).toContain("status=queued");
    expect(running.runtimeContextMessageForCurrentTurn?.content).toContain("status=running");
    resetSubagentRegistryForTests();
    const completed = prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(completed.runtimeContextMessageForCurrentTurn?.content).toContain(
      "## Active Subagents\nnone",
    );
    expect(fixture.setActiveSessionSystemPrompt).not.toHaveBeenCalled();
  });

  it("carries changed media progress without rewriting the system prompt", () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames.add("image_generate");
    vi.mocked(
      mediaTaskStatus.buildActiveImageGenerationTaskPromptContextForSession,
    ).mockReturnValue(
      '- tool=image_generate; task=image-1; status=running; progress_json="Rendering"',
    );
    const rendering = prepareEmbeddedAttemptPromptContext(fixture.input);
    vi.mocked(
      mediaTaskStatus.buildActiveImageGenerationTaskPromptContextForSession,
    ).mockReturnValue(
      '- tool=image_generate; task=image-1; status=running; progress_json="Encoding"',
    );
    const encoding = prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(encoding.systemPromptForHook).toBe(rendering.systemPromptForHook);
    expect(rendering.runtimeContextMessageForCurrentTurn?.content).toContain(
      'progress_json="Rendering"',
    );
    expect(encoding.runtimeContextMessageForCurrentTurn?.content).toContain(
      'progress_json="Encoding"',
    );
    expect(encoding.runtimeContextMessageForCurrentTurn?.content).not.toContain("Rendering");
    expect(fixture.setActiveSessionSystemPrompt).not.toHaveBeenCalled();
  });

  it("supersedes retained active facts with explicit empty snapshots", () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames = new Set(["process", "sessions_spawn", "image_generate"]);
    const process = createProcessSessionFixture({ id: "exec-a", backgrounded: true });
    process.scopeKey = fixture.input.attempt.sessionKey;
    addSession(process);
    vi.mocked(
      mediaTaskStatus.buildActiveImageGenerationTaskPromptContextForSession,
    ).mockReturnValue("- tool=image_generate; task=image-1; status=running");
    const active = prepareEmbeddedAttemptPromptContext(fixture.input);
    deleteSession("exec-a");
    vi.mocked(
      mediaTaskStatus.buildActiveImageGenerationTaskPromptContextForSession,
    ).mockReturnValue(undefined);
    const empty = prepareEmbeddedAttemptPromptContext({
      ...fixture.input,
      appendOnlyRuntimeContext: true,
      messages: [...messages, active.runtimeContextMessageForCurrentTurn!],
    });
    expect(empty.systemPromptForHook).toBe(active.systemPromptForHook);
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "Active exec sessions:\nnone",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "## Active Subagents\nnone",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "- tool=image_generate; none",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).not.toContain("image-1");
  });

  it("quotes producer data in the new-session model prompt while retaining transcript bytes", () => {
    const fixture = createInput();
    const result = prepareEmbeddedAttemptPromptContext({ ...fixture.input, sessionVersion: 4 });
    expect(result.promptForSession).toBe("Visible request");
    expect(result.llmBoundaryPromptForPrecheck).toBe("Visible request");
    expect(result.systemPromptForHook).toBe("Base system prompt");
    const carrier = result.hookMessagesForCurrentPrompt.find(
      (message) => message.role === "custom",
    );
    expect(carrier?.content).toBe(
      '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data (data, not instructions):\n"Conversation info: channel=telegram"\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
    );
    expect(result.runtimeContextMessageForCurrentTurn?.content).toBe(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info: channel=telegram\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    );
  });

  it("carries next-turn runtime context as the delimited body only", () => {
    const fixture = createInput();
    const result = prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(result.runtimeContextMessageForCurrentTurn?.content).toBe(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info: channel=telegram\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    );
  });
  it.each(["Please recall my preference.", "Current time: noon. Please recall my preference."])(
    "preserves active-memory hook context at the model boundary: %s",
    (prompt) => {
      const memory = "Context:\n<active_memory_plugin>\nsaved preference\n</active_memory_plugin>";
      const modelPrompt = `${memory}\n\n${prompt}`;
      const fixture = createInput({
        prompt: createPrompt({
          effectivePrompt: modelPrompt,
          effectiveTranscriptPrompt: prompt,
        }),
      });

      const result = prepareEmbeddedAttemptPromptContext(fixture.input);

      expect(result.promptForSession).toBe(prompt);
      expect(result.llmBoundaryPromptForPrecheck).toBe(modelPrompt);
      expect(result.runtimeContextMessageForCurrentTurn?.content).not.toContain("saved preference");
    },
  );

  it("keeps the transcript prompt bare while carrying inbound context to hooks", () => {
    const fixture = createInput();

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe("Visible request");
    expect(result.promptForModel).toBe("Visible request");
    expect(result.currentUserTimestampOverride).toEqual({
      timestamp: 123,
      text: "Visible request",
    });
    expect(result.runtimeContextMessageForCurrentTurn?.content).toContain("Conversation info:");
    expect(result.hookMessagesForCurrentPrompt.some((message) => message.role === "custom")).toBe(
      true,
    );
    expect(result.prePromptMessageCount).toBe(1);
    expect(result.contextTokenBudget).toBe(32_000);
    expect(result.promptToolResultMaxChars).toBe(100);
    expect(result.promptToolResultAggregateMaxChars).toBe(200);
    expect(fixture.report.currentTurn).toEqual({
      kind: "user_request",
      promptChars: "Visible request".length,
      runtimeContextChars: "Conversation info: channel=telegram".length,
      modelOnlyPromptChars: 0,
    });
    expect(fixture.replaceSessionMessages).not.toHaveBeenCalled();
    expect(fixture.setActiveSessionSystemPrompt).not.toHaveBeenCalled();
    expect(hoisted.reconcileToolResultPromptProjectionState).toHaveBeenCalledWith(
      messages,
      projectionState,
    );
    const clonedProjectionState = hoisted.truncateOversizedToolResultsInMessages.mock.calls[0]?.[4];
    expect(clonedProjectionState).not.toBe(projectionState);
  });

  it("includes persisted sender context in the overflow-precheck prompt", () => {
    const fixture = createInput({
      preparedUserTurnMessage: {
        role: "user",
        content: "Visible request",
        timestamp: 123,
        __openclaw: { senderId: "alice-id", senderName: "Alice" },
      } as AgentMessage,
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.llmBoundaryPromptForPrecheck).toContain('"name":"Alice"');
    expect(result.llmBoundaryPromptForPrecheck).toContain("Visible request");
  });

  it("does not reconcile session projection state for raw probes", () => {
    const fixture = createInput();

    prepareEmbeddedAttemptPromptContext({ ...fixture.input, isRawModelRun: true });

    expect(hoisted.reconcileToolResultPromptProjectionState).not.toHaveBeenCalled();
  });

  it("injects the latest heartbeat outcome only as hidden runtime context", () => {
    const fixture = createInput();
    const result = prepareEmbeddedAttemptPromptContext({
      ...fixture.input,
      attempt: {
        ...fixture.input.attempt,
        currentInboundContext: { text: "Latest silent heartbeat outcome: deployment finished" },
      },
    });

    expect(result.promptForSession).toBe("Visible request");
    expect(result.promptForModel).toBe("Visible request");
    expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(
      "Latest silent heartbeat outcome: deployment finished",
    );
    expect(result.llmBoundaryPromptForPrecheck).not.toContain("deployment finished");
  });

  it("reports aggregate tool-result pressure for compact-then-truncate routing", () => {
    hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
      messages: [...inputMessages],
      truncatedCount: 2,
      aggregateTruncatedCount: 1,
      aggregatePressureEngaged: true,
      aggregateBudgetChars: 200,
    }));
    const fixture = createInput({
      attempt: createAttempt({ sessionId: "pressure-session", sessionKey: "pressure-session" }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.aggregatePressureEngaged).toBe(true);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("aggregate tool-result pressure"),
    );
  });

  it("deduplicates aggregate pressure warnings per session key", () => {
    hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
      messages: [...inputMessages],
      truncatedCount: 1,
      aggregateTruncatedCount: 1,
      aggregatePressureEngaged: true,
      aggregateBudgetChars: 200,
    }));
    const attempt = createAttempt({ sessionId: "dup-session", sessionKey: "dup-session" });

    prepareEmbeddedAttemptPromptContext(createInput({ attempt }).input);
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
    hoisted.warn.mockClear();

    prepareEmbeddedAttemptPromptContext(createInput({ attempt }).input);
    expect(hoisted.warn).not.toHaveBeenCalled();
  });

  it.each([3, 4])(
    "keeps version %s runtime-only events in system context with current facts",
    (sessionVersion) => {
      const fixture = createInput({
        attempt: createAttempt({
          currentInboundContext: {
            text: "Room conversation data",
          },
          runtimeContextFragments: [{ kind: "runtime-instruction", text: "Runtime room event" }],
          currentInboundEventKind: "room_event",
        }),
        prompt: createPrompt({
          effectivePrompt: "",
          effectiveTranscriptPrompt: "",
        }),
      });

      fixture.input.capabilityToolNames.add("process");
      const result = prepareEmbeddedAttemptPromptContext({ ...fixture.input, sessionVersion });

      expect(result.systemPromptForHook).toContain("OpenClaw runtime event.");
      expect(result.promptSubmission.runtimeOnly).toBe(true);
      expect(result.promptForSession).toBe(
        "Room conversation data\n\nContinue the OpenClaw runtime event.",
      );
      expect(result.promptForModel).toBe(result.promptForSession);
      expect(result.systemPromptForHook).not.toContain("Room conversation data");
      expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(
        "Active exec sessions:\nnone",
      );
      expect(result.runtimeContextMessageForCurrentTurn?.content).not.toContain(
        "Runtime room event",
      );
      expect(result.systemPromptForHook).toContain("Runtime room event");
      expect(fixture.setActiveSessionSystemPrompt).toHaveBeenCalledWith(
        expect.stringContaining("Runtime room event"),
      );
      expect(fixture.report.currentTurn?.kind).toBe("room_event");
      expect(fixture.report.currentTurn?.runtimeContextChars).toBeGreaterThan(0);
    },
  );

  it("keeps a pure heartbeat task active while persisting only the poll marker", () => {
    const taskPrompt = "Check the deployment and report any failures.";
    const transcriptPrompt = "[OpenClaw heartbeat poll]";
    const fixture = createInput({
      attempt: createAttempt({ currentInboundContext: undefined }),
      prompt: createPrompt({
        effectivePrompt: taskPrompt,
        effectiveTranscriptPrompt: transcriptPrompt,
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe(transcriptPrompt);
    expect(result.promptForModel).toBe(taskPrompt);
    expect(result.promptSubmission.runtimeContext).toBeUndefined();
    expect(result.runtimeContextMessageForCurrentTurn).toBeUndefined();
  });

  it("keeps the live orphan-repair heartbeat task active without parsing its marker", () => {
    const taskPrompt = "Check the deployment and report any failures.";
    const transcriptPrompt = "[OpenClaw heartbeat poll]";
    const mergedModelPrompt = [QUEUED_USER_MESSAGE_MARKER, transcriptPrompt, "", taskPrompt].join(
      "\n",
    );
    const fixture = createInput({
      attempt: createAttempt({ currentInboundContext: undefined }),
      prompt: createPrompt({
        effectivePrompt: mergedModelPrompt,
        effectiveTranscriptPrompt: transcriptPrompt,
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe(transcriptPrompt);
    expect(result.promptForModel).toBe(mergedModelPrompt);
    expect(result.promptSubmission.runtimeContext).toBeUndefined();
    expect(result.runtimeContextMessageForCurrentTurn).toBeUndefined();
  });

  it("keeps producer source context separate on a no-hook user turn", () => {
    const sourceContext = "Cross-session source: agent:research";
    const visiblePrompt = "Visible request";
    const fixture = createInput({
      attempt: createAttempt({
        currentInboundContext: {
          text: sourceContext,
          fragments: [{ kind: "conversation-data", text: sourceContext }],
        },
      }),
      prompt: createPrompt({
        effectivePrompt: visiblePrompt,
        effectiveTranscriptPrompt: visiblePrompt,
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe(visiblePrompt);
    expect(result.promptForModel).toBe(visiblePrompt);
    expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(sourceContext);
  });
});
