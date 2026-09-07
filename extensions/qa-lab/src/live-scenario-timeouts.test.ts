import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const completionParentSessionKey = "agent:qa:qa-channel:direct:alice";
const completionChildSessionKey = "agent:qa:subagent:completion-child";
const completionAttemptStartedAt = 1_000;
const completionChildEndedAt = completionAttemptStartedAt + 10;
const completionParentTranscriptCursor = 7;
const completionProofMarker = "ISSUE109025_COMPLETION_EXEC_OK:fixture-marker";
const completionSpawnToolCallId = "completion-spawn";
const completionYieldToolCallId = "completion-yield";
const completionExecToolCallId = "completion-exec";

type CompletionSuccessfulToolEvent = {
  name: string;
  timestamp: number;
  toolCallId: string;
};

type CompletionTaskFixture = {
  childSessionKey?: string;
  createdAt: number;
  deliveryStatus: "delivered" | "pending";
  endedAt?: number;
  label: string;
  requesterSessionKey: string;
  status: "running" | "succeeded";
};

type CompletionParentReplyFixture = {
  includeExecToolCall?: boolean;
  mirror?: "delivery" | "delivery-marker" | "gateway-injected" | "message-tool";
  phase?: "commentary" | "final_answer";
  providerIdentity?: boolean;
  role?: "assistant" | "toolResult";
  text: string;
};

type CompletionParentOutboundFixture = {
  accountId?: string;
  conversationId?: string;
  text?: string;
};

const deliveredCompletionTask: CompletionTaskFixture = {
  childSessionKey: completionChildSessionKey,
  createdAt: completionAttemptStartedAt + 1,
  deliveryStatus: "delivered",
  endedAt: completionChildEndedAt,
  label: "issue-109025-completion-child-00000000",
  requesterSessionKey: completionParentSessionKey,
  status: "succeeded",
};

function runCompletionPolicyFlow(
  params: {
    childFinalText?: string;
    delayedParentReplyHistoryReads?: number;
    parentExecCompletedAt?: number;
    parentExecCommand?: string;
    parentExecToolCallId?: string;
    parentOutbound?: CompletionParentOutboundFixture | null;
    parentReply?: CompletionParentReplyFixture | null;
    parentSpawnCompletedAt?: number;
    parentToolCalls?: Record<string, number>;
    parentYieldCompletedAt?: number;
    priorSuccessfulParentToolCalls?: Record<string, number>;
    priorParentOutbound?: CompletionParentOutboundFixture;
    priorRequesterInbound?: boolean;
    proofCompletionText?: string;
    proofModifiedAt?: number;
    successfulChildReads?: number;
    successfulParentToolEvents?: CompletionSuccessfulToolEvent[];
    successfulParentToolCalls?: Record<string, number>;
    taskLookupError?: Error;
    tasks?: CompletionTaskFixture[];
  } = {},
) {
  const state = createQaBusState();
  const gatewayCalls: Array<{ method: string; request: { sessionKey?: string } }> = [];
  const taskCommands: unknown[] = [];
  const transcriptSessionKeys: string[] = [];
  const transcriptReadOptions: unknown[] = [];
  const workspaceWrites: Array<{ content: string; filePath: string }> = [];
  let generatedUuidCount = 0;
  const parentToolCalls = params.parentToolCalls ?? {
    sessions_spawn: 1,
    sessions_yield: 1,
    exec: 1,
  };
  const successfulParentToolCalls = params.successfulParentToolCalls ?? parentToolCalls;
  const successfulParentToolEvents = params.successfulParentToolEvents ?? [
    {
      name: "sessions_spawn",
      timestamp: params.parentSpawnCompletedAt ?? completionAttemptStartedAt + 1,
      toolCallId: completionSpawnToolCallId,
    },
    {
      name: "sessions_yield",
      timestamp: params.parentYieldCompletedAt ?? completionChildEndedAt - 1,
      toolCallId: completionYieldToolCallId,
    },
    {
      name: "exec",
      timestamp: params.parentExecCompletedAt ?? completionChildEndedAt + 1,
      toolCallId: completionExecToolCallId,
    },
  ];
  const successfulChildReads = params.successfulChildReads ?? 4;
  const parentReply =
    params.parentReply === undefined
      ? { phase: "final_answer" as const, text: completionProofMarker }
      : params.parentReply;

  const result = runLoadedScenarioFlow("issue-109025-completion-policy-live", {
    state,
    onWaitForOutboundMessage: ({ state: currentState }) => {
      if (
        params.parentOutbound === null ||
        !parentReply ||
        parentReply.role === "toolResult" ||
        parentReply.phase === "commentary" ||
        parentReply.mirror ||
        parentReply.includeExecToolCall
      ) {
        return;
      }
      currentState.addOutboundMessage({
        accountId: params.parentOutbound?.accountId ?? "qa-channel",
        to: `dm:${params.parentOutbound?.conversationId ?? "issue-109025-completion"}`,
        text: params.parentOutbound?.text ?? parentReply.text,
      });
    },
    api: {
      Date: { now: () => completionAttemptStartedAt },
      env: {
        providerMode: "live-frontier",
        cfg: { session: {} },
        gateway: {
          workspaceDir: "/qa",
          call: async (method: string, request: { sessionKey?: string }) => {
            gatewayCalls.push({ method, request });
            if (method !== "chat.history" || request.sessionKey !== completionParentSessionKey) {
              throw new Error(`unexpected completion gateway call: ${method}`);
            }
            const inboundText =
              state
                .getSnapshot()
                .messages.findLast(
                  (message) =>
                    message.direction === "inbound" &&
                    message.conversation.id === "issue-109025-completion",
                )?.text ?? "";
            const commandTemplate = inboundText.match(/run this exact command: ([^\n]+)/u)?.[1];
            const childMarker = workspaceWrites.at(-1)?.content.trim();
            if (!commandTemplate || !childMarker) {
              throw new Error("completion fixture is missing its command or child marker");
            }
            const execToolCall = {
              type: "toolCall",
              id: params.parentExecToolCallId ?? completionExecToolCallId,
              name: "exec",
              arguments: {
                command:
                  params.parentExecCommand ??
                  commandTemplate.replace("__CHILD_COMPLETION_TOKEN__", childMarker),
              },
            };
            const parentReplyIsVisible =
              parentReply && gatewayCalls.length > (params.delayedParentReplyHistoryReads ?? 0);
            return {
              messages: [
                {
                  role: "assistant",
                  content: [execToolCall],
                },
                ...(parentReplyIsVisible
                  ? [
                      {
                        role: parentReply.role ?? "assistant",
                        ...(parentReply.phase ? { phase: parentReply.phase } : {}),
                        ...(parentReply.mirror === "delivery"
                          ? { model: "delivery-mirror", provider: "openclaw" }
                          : {}),
                        ...(parentReply.mirror === "delivery-marker"
                          ? { openclawDeliveryMirror: { kind: "channel-final" } }
                          : {}),
                        ...(parentReply.mirror === "gateway-injected"
                          ? { model: "gateway-injected", provider: "openclaw" }
                          : {}),
                        ...(parentReply.mirror === "message-tool"
                          ? { openclawMessageToolMirror: { toolName: "message" } }
                          : {}),
                        ...(parentReply.providerIdentity
                          ? {
                              __openclaw: { mirrorIdentity: "completion:assistant" },
                              model: "gpt-5.4",
                              provider: "openai",
                            }
                          : {}),
                        content: [
                          {
                            type: "text",
                            text: parentReply.text,
                            ...(parentReply.phase
                              ? {
                                  textSignature: JSON.stringify({
                                    v: 1,
                                    id: "completion-reply",
                                    phase: parentReply.phase,
                                  }),
                                }
                              : {}),
                          },
                          ...(parentReply.includeExecToolCall ? [execToolCall] : []),
                        ],
                      },
                    ]
                  : []),
              ],
            };
          },
        },
      },
      buildAgentSessionKey: () => completionParentSessionKey,
      path: { join: (...parts: string[]) => parts.join("/") },
      randomUUID: () => {
        const uuid = `00000000-0000-4000-8000-${String(generatedUuidCount).padStart(12, "0")}`;
        generatedUuidCount += 1;
        return uuid;
      },
      fs: {
        readFile: async () => {
          const childMarker = workspaceWrites.at(-1)?.content.trim() ?? "";
          const completionText =
            params.proofCompletionText === undefined ||
            params.proofCompletionText === "__DELIVERED_CHILD_TOKEN__"
              ? childMarker
              : params.proofCompletionText;
          return `${completionProofMarker}\n${completionText}\n`;
        },
        stat: async () => ({ mtimeMs: params.proofModifiedAt ?? completionChildEndedAt + 1 }),
        writeFile: async (filePath: string, content: string) => {
          workspaceWrites.push({ content, filePath });
        },
      },
      readGatewayLogs: () =>
        `${state
          .getSnapshot()
          .messages.map((message) => message.text)
          .join("\n")}\n${completionProofMarker}`,
      readSessionTranscriptSummary: async (
        _env: unknown,
        sessionKey: string,
        options?: { afterEventCursor?: number; allowEmpty?: boolean },
      ) => {
        transcriptSessionKeys.push(sessionKey);
        transcriptReadOptions.push(options);
        if (sessionKey === completionParentSessionKey) {
          if (options?.allowEmpty) {
            if (params.priorRequesterInbound) {
              state.addInboundMessage({
                accountId: "qa-channel",
                conversation: { id: "previous-requester", kind: "direct" },
                senderId: "previous-requester",
                senderName: "Previous requester",
                text: "old inbound turn",
              });
            }
            if (params.priorParentOutbound) {
              state.addOutboundMessage({
                accountId: params.priorParentOutbound.accountId ?? "qa-channel",
                to: `dm:${params.priorParentOutbound.conversationId ?? "issue-109025-completion"}`,
                text: params.priorParentOutbound.text ?? completionProofMarker,
              });
            }
            return {
              assistantToolCallCounts: params.priorSuccessfulParentToolCalls ?? {},
              eventCursor: completionParentTranscriptCursor,
              successfulToolCallCounts: params.priorSuccessfulParentToolCalls ?? {},
            };
          }
          return {
            assistantToolCallCounts: parentToolCalls,
            finalText: parentReply?.role !== "toolResult" ? (parentReply?.text ?? "") : "",
            successfulToolCallCounts:
              options?.afterEventCursor === completionParentTranscriptCursor
                ? successfulParentToolCalls
                : { ...params.priorSuccessfulParentToolCalls, ...successfulParentToolCalls },
            successfulToolCallEvents: successfulParentToolEvents,
          };
        }
        if (sessionKey === completionChildSessionKey) {
          const terminalFileContents = workspaceWrites.at(-1)?.content.trim();
          return {
            assistantToolCallCounts: { read: successfulChildReads },
            successfulToolCallCounts: { read: successfulChildReads },
            finalText:
              params.childFinalText ??
              (terminalFileContents?.startsWith("CHILD_DONE:")
                ? terminalFileContents
                : "CHILD_DONE"),
          };
        }
        throw new Error(`unexpected completion transcript session: ${sessionKey}`);
      },
      runQaCli: async (_env: unknown, command: unknown) => {
        taskCommands.push(command);
        if (params.taskLookupError) {
          throw params.taskLookupError;
        }
        return { tasks: params.tasks ?? [deliveredCompletionTask] };
      },
    },
  });

  return {
    gatewayCalls,
    result,
    state,
    taskCommands,
    transcriptReadOptions,
    transcriptSessionKeys,
    workspaceWrites,
  };
}

describe("live transport scenario timeouts", () => {
  it("uses the model-aware timeout for the Telegram compact tools reply", () => {
    const scenario = requireFlowScenario(readQaScenarioById("telegram-tools-compact-command"));
    const waitForReply = scenario.execution.flow?.steps
      .flatMap((step) => step.actions)
      .find(
        (action) => typeof action === "object" && action !== null && "waitForOutbound" in action,
      );

    expect(waitForReply).toMatchObject({
      waitForOutbound: {
        timeoutMs: { expr: "liveTurnTimeoutMs(env, 60000)" },
      },
    });
    expect(waitForReply).not.toHaveProperty("waitForOutbound.textIncludes");
  });

  it("reports the unexpected Telegram compact tools reply", async () => {
    await expect(
      runLoadedScenarioFlow("telegram-tools-compact-command", {
        onWaitForOutboundMessage: ({ state }) => {
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:telegram-command-room",
            text: "Couldn't load available tools right now. Try again in a moment.",
          });
        },
      }),
    ).rejects.toThrow(
      "tools reply missing expected text: Couldn't load available tools right now. Try again in a moment.",
    );
  });
});

describe("live subagent scenario timeouts", () => {
  it.each([
    {
      id: "issue-109025-completion-policy-live",
      savedEvidence: "expectedFinalMarker",
    },
    {
      id: "issue-109025-completion-policy-live",
      savedEvidence: "completedChild",
    },
    {
      id: "issue-109025-completion-policy-live",
      savedEvidence: "parentTranscript",
    },
    {
      id: "issue-109025-completion-policy-live",
      savedEvidence: "parentHistory",
    },
    {
      id: "issue-109025-sender-policy-live",
      savedEvidence: "childRow",
    },
  ])("uses the model-aware completion timeout for $id", ({ id, savedEvidence }) => {
    const scenario = requireFlowScenario(readQaScenarioById(id));
    const completionWait = scenario.execution.flow?.steps
      .flatMap((step) => step.actions)
      .find(
        (action) =>
          typeof action === "object" &&
          action !== null &&
          "call" in action &&
          action.call === "waitForCondition" &&
          "saveAs" in action &&
          action.saveAs === savedEvidence,
      );

    expect(scenario.execution.config?.requiredProviderMode).toBe("live-frontier");
    expect(scenario.execution.retryCount).toBe(0);
    expect(completionWait).toMatchObject({
      call: "waitForCondition",
      saveAs: savedEvidence,
      args: [expect.any(Object), { expr: "liveTurnTimeoutMs(env, 60000)" }, 250],
    });
  });

  it("checkpoints outbound-only history before waiting for the current requester delivery", () => {
    const scenario = requireFlowScenario(readQaScenarioById("issue-109025-completion-policy-live"));
    const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions) ?? [];
    const checkpoint = actions.find(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "set" in action &&
        action.set === "outboundStartIndex",
    );
    const deliveryWait = actions.find(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "call" in action &&
        action.call === "waitForOutboundMessage" &&
        "saveAs" in action &&
        action.saveAs === "parentOutbound",
    );

    expect(checkpoint).toMatchObject({
      value: {
        expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length",
      },
    });
    expect(deliveryWait).toMatchObject({
      args: [
        { ref: "state" },
        expect.any(Object),
        { expr: "liveTurnTimeoutMs(env, 60000)" },
        { sinceIndex: { ref: "outboundStartIndex" } },
      ],
    });
  });

  it("applies the GPT-5 live floor without extending the mock fallback", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          alternateModel: "openai/gpt-5.4",
        },
        60_000,
      ),
    ).toBe(360_000);
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna",
        },
        60_000,
      ),
    ).toBe(60_000);
  });

  it("rejects echoed completion text when no child was actually spawned", async () => {
    const { result, state } = runCompletionPolicyFlow({
      parentToolCalls: { sessions_yield: 1, exec: 1 },
      tasks: [],
    });

    await expect(result).rejects.toThrow("parent did not spawn a subagent");
    expect(state.getSnapshot().messages[0]?.text).toContain("CHILD_DONE");
  });

  it.each([
    { reason: "missing child task", tasks: [] },
    {
      reason: "stale child task",
      tasks: [{ ...deliveredCompletionTask, createdAt: completionAttemptStartedAt - 1 }],
    },
    {
      reason: "different child label",
      tasks: [{ ...deliveredCompletionTask, label: "another-child" }],
    },
    {
      reason: "different requester session",
      tasks: [{ ...deliveredCompletionTask, requesterSessionKey: "agent:qa:someone-else" }],
    },
    {
      reason: "unfinished child task",
      tasks: [{ ...deliveredCompletionTask, status: "running" as const }],
    },
    {
      reason: "undelivered child completion",
      tasks: [{ ...deliveredCompletionTask, deliveryStatus: "pending" as const }],
    },
    {
      reason: "missing child session identity",
      tasks: [{ ...deliveredCompletionTask, childSessionKey: undefined }],
    },
    {
      reason: "missing child completion timestamp",
      tasks: [{ ...deliveredCompletionTask, endedAt: undefined }],
    },
  ])("rejects a $reason despite matching Gateway completion text", async ({ tasks }) => {
    await expect(runCompletionPolicyFlow({ tasks }).result).rejects.toThrow(
      "test condition was not met",
    );
  });

  it.each<{
    failure: string;
    parentToolCalls: Record<string, number>;
    tool: string;
  }>([
    {
      tool: "sessions_spawn",
      parentToolCalls: { sessions_yield: 1, exec: 1 },
      failure: "parent did not spawn a subagent",
    },
    {
      tool: "sessions_yield",
      parentToolCalls: { sessions_spawn: 1, exec: 1 },
      failure: "parent did not yield before completion",
    },
    {
      tool: "exec",
      parentToolCalls: { sessions_spawn: 1, sessions_yield: 1 },
      failure: "parent did not execute the completion command",
    },
  ])(
    "rejects completion without a real parent $tool call",
    async ({ failure, parentToolCalls }) => {
      await expect(runCompletionPolicyFlow({ parentToolCalls }).result).rejects.toThrow(failure);
    },
  );

  it.each<{
    failure: string;
    successfulParentToolCalls: Record<string, number>;
    tool: string;
  }>([
    {
      tool: "sessions_spawn",
      successfulParentToolCalls: { sessions_yield: 1, exec: 1 },
      failure: "parent did not spawn a subagent",
    },
    {
      tool: "sessions_yield",
      successfulParentToolCalls: { sessions_spawn: 1, exec: 1 },
      failure: "parent did not yield before completion",
    },
    {
      tool: "exec",
      successfulParentToolCalls: { sessions_spawn: 1, sessions_yield: 1 },
      failure: "parent did not execute the completion command",
    },
  ])("rejects an attempted but unsuccessful parent $tool", async (fixture) => {
    await expect(runCompletionPolicyFlow(fixture).result).rejects.toThrow(fixture.failure);
  });

  it.each<{
    parentReply: CompletionParentReplyFixture | null;
    reason: string;
  }>([
    { reason: "no final requester reply", parentReply: null },
    {
      reason: "only the exec tool result",
      parentReply: { role: "toolResult", text: completionProofMarker },
    },
    {
      reason: "commentary instead of a final answer",
      parentReply: { phase: "commentary", text: completionProofMarker },
    },
    {
      reason: "commentary attached to another exec tool call",
      parentReply: {
        includeExecToolCall: true,
        phase: "commentary",
        text: completionProofMarker,
      },
    },
    {
      reason: "a final answer with the wrong marker",
      parentReply: { phase: "final_answer", text: `${completionProofMarker}-wrong` },
    },
    {
      reason: "a delivery-mirror bookkeeping row",
      parentReply: { mirror: "delivery", phase: "final_answer", text: completionProofMarker },
    },
    {
      reason: "a delivery-mirror marker without provider provenance",
      parentReply: {
        mirror: "delivery-marker",
        phase: "final_answer",
        text: completionProofMarker,
      },
    },
    {
      reason: "a gateway-injected bookkeeping row",
      parentReply: {
        mirror: "gateway-injected",
        phase: "final_answer",
        text: completionProofMarker,
      },
    },
    {
      reason: "a message-tool mirror",
      parentReply: { mirror: "message-tool", phase: "final_answer", text: completionProofMarker },
    },
  ])("rejects exec output with $reason", async ({ parentReply }) => {
    await expect(runCompletionPolicyFlow({ parentReply }).result).rejects.toThrow(
      "test condition was not met",
    );
  });

  it.each<{
    parentOutbound: CompletionParentOutboundFixture | null;
    reason: string;
  }>([
    { reason: "no outbound message", parentOutbound: null },
    {
      reason: "the wrong requester conversation",
      parentOutbound: { conversationId: "someone-else" },
    },
    {
      reason: "a different final marker",
      parentOutbound: { text: `${completionProofMarker}-wrong` },
    },
    {
      reason: "the wrong QA channel account",
      parentOutbound: { accountId: "another-account" },
    },
  ])("rejects a real final requester reply with $reason", async ({ parentOutbound }) => {
    await expect(runCompletionPolicyFlow({ parentOutbound }).result).rejects.toThrow(
      "waiting for outbound marker",
    );
  });

  it("does not reuse a matching outbound reply from before the current inbound turn", async () => {
    await expect(
      runCompletionPolicyFlow({ parentOutbound: null, priorParentOutbound: {} }).result,
    ).rejects.toThrow("waiting for outbound marker");
  });

  it("does not borrow successful tools from a previous requester turn", async () => {
    const { result } = runCompletionPolicyFlow({
      priorSuccessfulParentToolCalls: { sessions_yield: 1, exec: 1 },
      successfulParentToolCalls: { sessions_spawn: 1 },
    });

    await expect(result).rejects.toThrow("parent did not yield before completion");
  });

  it("rejects an exec proof written before the child actually completed", async () => {
    await expect(
      runCompletionPolicyFlow({ proofModifiedAt: completionChildEndedAt - 1 }).result,
    ).rejects.toThrow("completion command ran before the child finished");
  });

  it("rejects a parent that yielded only after the child had already completed", async () => {
    await expect(
      runCompletionPolicyFlow({ parentYieldCompletedAt: completionChildEndedAt + 1 }).result,
    ).rejects.toThrow("parent did not successfully yield before child completion");
  });

  it("rejects a yield result that predates the successful spawn", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentSpawnCompletedAt: completionChildEndedAt - 1,
        parentYieldCompletedAt: completionChildEndedAt - 2,
      }).result,
    ).rejects.toThrow("parent successful tool timeline was not chronological");
  });

  it("rejects an exec result that predates child completion", async () => {
    await expect(
      runCompletionPolicyFlow({ parentExecCompletedAt: completionChildEndedAt - 1 }).result,
    ).rejects.toThrow("parent successful tool timeline was not chronological");
  });

  it("rejects a missing authenticated successful yield timestamp", async () => {
    await expect(
      runCompletionPolicyFlow({
        successfulParentToolEvents: [
          {
            name: "sessions_spawn",
            timestamp: completionAttemptStartedAt + 1,
            toolCallId: completionSpawnToolCallId,
          },
          {
            name: "exec",
            timestamp: completionChildEndedAt + 1,
            toolCallId: completionExecToolCallId,
          },
        ],
      }).result,
    ).rejects.toThrow("parent successful tool timeline was incomplete");
  });

  it("rejects a non-finite authenticated successful yield timestamp", async () => {
    await expect(
      runCompletionPolicyFlow({ parentYieldCompletedAt: Number.NaN }).result,
    ).rejects.toThrow("parent successful tool timeline was incomplete");
  });

  it("rejects successful parent results persisted outside spawn-yield-exec order", async () => {
    await expect(
      runCompletionPolicyFlow({
        successfulParentToolEvents: [
          {
            name: "sessions_spawn",
            timestamp: completionAttemptStartedAt + 1,
            toolCallId: completionSpawnToolCallId,
          },
          {
            name: "exec",
            timestamp: completionChildEndedAt + 1,
            toolCallId: completionExecToolCallId,
          },
          {
            name: "sessions_yield",
            timestamp: completionChildEndedAt - 1,
            toolCallId: completionYieldToolCallId,
          },
        ],
      }).result,
    ).rejects.toThrow("parent successful tool timeline was incomplete");
  });

  it("rejects a visible exec tool call that does not match the successful result identity", async () => {
    await expect(
      runCompletionPolicyFlow({ parentExecToolCallId: "another-exec-call" }).result,
    ).rejects.toThrow("parent exec did not use the exact delivered-completion command");
  });

  it.each([
    { reason: "missing", proofCompletionText: "" },
    { reason: "guessed", proofCompletionText: "CHILD_DONE:guessed-before-delivery" },
  ])(
    "rejects premature parent exec when its proof contains a $reason completion token",
    async ({ proofCompletionText }) => {
      await expect(runCompletionPolicyFlow({ proofCompletionText }).result).rejects.toThrow(
        "completion proof did not contain the delivered child marker",
      );
    },
  );

  it("rejects inline filesystem discovery even when the exec proof forges the child marker", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentExecCommand: `node -e 'require("node:fs").readFileSync("guessed-chain")'`,
        proofCompletionText: "__DELIVERED_CHILD_TOKEN__",
      }).result,
    ).rejects.toThrow("parent exec did not use the exact delivered-completion command");
  });

  it.each(["read", "sessions_history"])(
    "rejects an alternate parent %s tool that could discover the child marker",
    async (tool) => {
      await expect(
        runCompletionPolicyFlow({
          successfulParentToolCalls: { sessions_spawn: 1, sessions_yield: 1, exec: 1, [tool]: 1 },
        }).result,
      ).rejects.toThrow("parent used an unexpected successful tool");
    },
  );

  it.each(["sessions_yield", "exec"])(
    "rejects repeated successful parent %s calls",
    async (tool) => {
      await expect(
        runCompletionPolicyFlow({
          successfulParentToolCalls: { sessions_spawn: 1, sessions_yield: 1, exec: 1, [tool]: 2 },
        }).result,
      ).rejects.toThrow(`parent did not call ${tool} exactly once`);
    },
  );

  it("surfaces task snapshot failures without converting them into retry timeouts", async () => {
    await expect(
      runCompletionPolicyFlow({ taskLookupError: new Error("durable task snapshot unavailable") })
        .result,
    ).rejects.toThrow("durable task snapshot unavailable");
  });

  it.each([
    {
      reason: "wrong child final reply",
      childFinalText: "CHILD_DONE but not the required exact reply",
      failure: "child did not finish with the exact completion reply",
    },
    {
      reason: "incomplete successful read chain",
      successfulChildReads: 3,
      failure: "child did not successfully read the complete chain",
    },
    {
      reason: "four repeated reads and a guessed completion marker",
      successfulChildReads: 4,
      childFinalText: "CHILD_DONE",
      failure: "child did not finish with the exact completion reply",
    },
    {
      reason: "completion marker guessed from the first chain filename",
      successfulChildReads: 4,
      childFinalText: "CHILD_DONE:00000000-0000-4000-8000-000000000001",
      failure: "child did not finish with the exact completion reply",
    },
  ])("rejects a delivered task with the $reason", async (fixture) => {
    await expect(runCompletionPolicyFlow(fixture).result).rejects.toThrow(fixture.failure);
  });

  it("accepts a current requester-owned delivered child with complete transcript proof", async () => {
    const {
      gatewayCalls,
      result,
      state,
      taskCommands,
      transcriptReadOptions,
      transcriptSessionKeys,
    } = runCompletionPolicyFlow();

    await expect(result).resolves.toMatchObject({ status: "pass" });
    expect(gatewayCalls).toEqual([
      {
        method: "chat.history",
        request: { sessionKey: completionParentSessionKey, limit: 100, maxChars: 131_072 },
      },
    ]);
    expect(taskCommands).toEqual([["tasks", "list", "--json", "--runtime", "subagent"]]);
    expect(transcriptSessionKeys).toEqual([
      completionParentSessionKey,
      completionParentSessionKey,
      completionChildSessionKey,
    ]);
    expect(transcriptReadOptions).toEqual([
      { allowEmpty: true },
      { afterEventCursor: completionParentTranscriptCursor },
      undefined,
    ]);
    expect(state.getSnapshot().messages[0]?.text).toContain("CHILD_DONE");
    expect(state.getSnapshot().messages[1]).toMatchObject({
      accountId: "qa-channel",
      conversation: { id: "issue-109025-completion", kind: "direct" },
      direction: "outbound",
      text: completionProofMarker,
    });
  });

  it("waits until the exact final requester reply is visible after the exec result", async () => {
    const { gatewayCalls, result } = runCompletionPolicyFlow({ delayedParentReplyHistoryReads: 2 });

    await expect(result).resolves.toMatchObject({ status: "pass" });
    expect(gatewayCalls).toHaveLength(3);
  });

  it("accepts a genuine OpenAI final reply with provider mirror-correlation metadata", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentReply: {
          phase: "final_answer",
          providerIdentity: true,
          text: completionProofMarker,
        },
      }).result,
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("delivers the current reply after mixed prior inbound and outbound history", async () => {
    await expect(
      runCompletionPolicyFlow({
        priorParentOutbound: { text: "prior requester reply" },
        priorRequesterInbound: true,
      }).result,
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("keeps each chain hop independent and its terminal answer outside the prompt", async () => {
    const { result, state, workspaceWrites } = runCompletionPolicyFlow();

    await expect(result).resolves.toMatchObject({ status: "pass" });
    expect(workspaceWrites).toHaveLength(4);

    const chainFileNames = workspaceWrites.map(({ filePath }) => filePath.split("/").at(-1));
    const chainUuids = chainFileNames.map(
      (fileName) =>
        fileName?.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
        )?.[0],
    );
    expect(chainUuids.every((uuid) => uuid !== undefined)).toBe(true);
    expect(new Set(chainUuids).size).toBe(4);
    expect(workspaceWrites.slice(0, -1).map(({ content }) => content.trim())).toEqual(
      chainFileNames.slice(1),
    );

    const terminalMarker = workspaceWrites.at(-1)?.content.trim();
    expect(terminalMarker).toMatch(/^CHILD_DONE:[0-9a-f-]+$/u);
    const inboundText = state.getSnapshot().messages[0]?.text ?? "";
    expect(inboundText).toContain(chainFileNames[0]);
    expect(inboundText).toContain("__CHILD_COMPLETION_TOKEN__");
    for (const chainFileName of chainFileNames.slice(1)) {
      expect(inboundText).not.toContain(chainFileName);
    }
    expect(inboundText).not.toContain(terminalMarker);
  });

  it("accepts an exec proof created in the same millisecond the child completed", async () => {
    await expect(
      runCompletionPolicyFlow({ proofModifiedAt: completionChildEndedAt }).result,
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("accepts authenticated spawn, yield, completion, and exec in the same millisecond", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentExecCompletedAt: completionChildEndedAt,
        parentSpawnCompletedAt: completionChildEndedAt,
        parentYieldCompletedAt: completionChildEndedAt,
        proofModifiedAt: completionChildEndedAt,
      }).result,
    ).resolves.toMatchObject({ status: "pass" });
  });
});
