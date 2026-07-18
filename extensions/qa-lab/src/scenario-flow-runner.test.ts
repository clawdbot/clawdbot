// Qa Lab tests cover scenario flow runner plugin behavior.
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  readQaScenarioById,
  readQaScenarioPack,
  type QaScenarioExecution,
  type QaScenarioFlow,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";

type QaFlowStep = {
  name: string;
  run: () => Promise<string | void>;
};

function formatTestTranscript(state: ReturnType<typeof createQaBusState>) {
  return state
    .getSnapshot()
    .messages.map((message) => `${message.direction}:${message.conversation.id}:${message.text}`)
    .join("\n");
}

async function runLoadedScenarioFlow(
  scenarioId: string,
  params: {
    flow?: QaScenarioFlow;
    api?: Record<string, unknown>;
    state?: ReturnType<typeof createQaBusState>;
    omitOutboundSequence?: boolean;
    onWaitForOutboundMessage?: (params: {
      waitCount: number;
      state: ReturnType<typeof createQaBusState>;
    }) => void;
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const loadedFlow = scenario.execution.flow;
  if (!loadedFlow) {
    throw new Error(`scenario has no flow: ${scenarioId}`);
  }

  const state = params.state ?? createQaBusState();
  let waitCount = 0;
  const transport = {
    state,
    reset: async () => {
      state.reset();
    },
    sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
      state.addInboundMessage(input),
    sendNativeCommand: async (
      input: Omit<Parameters<typeof state.addInboundMessage>[0], "nativeCommand" | "text"> & {
        command: string;
      },
    ) => {
      const { command, ...message } = input;
      state.addInboundMessage({
        ...message,
        text: `/${command}`,
        nativeCommand: { name: command },
      });
    },
    waitForNoOutbound: async () => undefined,
    waitForOutbound: async (input: {
      conversation?: { id: string; kind: string };
      textIncludes?: string;
      timeoutMs?: number;
    }) => {
      waitCount += 1;
      params.onWaitForOutboundMessage?.({ waitCount, state });
      const match = state
        .getSnapshot()
        .messages.find(
          (candidate) =>
            candidate.direction === "outbound" &&
            (!input.conversation || candidate.conversation.id === input.conversation.id) &&
            (!input.conversation || candidate.conversation.kind === input.conversation.kind) &&
            (!input.textIncludes || candidate.text.includes(input.textIncludes)),
        );
      if (match) {
        return match;
      }
      throw new Error(`timed out after ${input.timeoutMs}ms waiting for outbound marker`);
    },
    ...(params.omitOutboundSequence
      ? {}
      : {
          waitForOutboundSequence: async () => {
            throw new Error("outbound sequence not configured for this fixture");
          },
        }),
  };
  const api = {
    env: { providerMode: "mock-openai" },
    transport,
    state,
    scenario,
    config: scenario.execution.config ?? {},
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    waitForGatewayHealthy: async () => undefined,
    waitForTransportReady: async () => undefined,
    waitForQaChannelReady: async () => undefined,
    waitForNoOutbound: async () => undefined,
    sleep: async () => undefined,
    reset: async () => {
      state.reset();
    },
    resetBus: async () => {
      state.reset();
    },
    runAgentPrompt: async () => undefined,
    formatTransportTranscript: formatTestTranscript,
    waitForOutboundMessage: async (
      stateLocal: ReturnType<typeof createQaBusState>,
      predicate: (candidate: unknown) => boolean,
      timeoutMs: number,
      options?: { sinceIndex?: number },
    ) => {
      waitCount += 1;
      params.onWaitForOutboundMessage?.({ waitCount, state: stateLocal });
      const match = stateLocal
        .getSnapshot()
        .messages.slice(options?.sinceIndex ?? 0)
        .find((candidate) => predicate(candidate));
      if (match) {
        return match;
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for outbound marker`);
    },
    runScenario: async (_name: string, steps: QaFlowStep[]) => {
      const stepResults = [];
      for (const step of steps) {
        const details = await step.run();
        stepResults.push({
          name: step.name,
          status: "pass" as const,
          ...(details !== undefined ? { details } : {}),
        });
      }
      return {
        name: scenario.title,
        status: "pass" as const,
        steps: stepResults,
      };
    },
    ...params.api,
  };

  return await runScenarioFlow({
    api,
    scenarioTitle: scenario.title,
    flow: params.flow ?? loadedFlow,
  });
}

function readWebchatTranscriptWaitFlow() {
  const scenario = readQaScenarioById("webchat-direct-reply-routing");
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("webchat direct reply scenario has no actions");
  }
  const waitIndex = actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "saveAs" in action &&
      action.saveAs === "transcriptSummary",
  );
  if (waitIndex < 0) {
    throw new Error("webchat direct reply scenario has no transcript wait");
  }
  return {
    steps: [
      {
        name: "waits for the durable assistant transcript",
        actions: [
          { set: "sessionKey", value: "agent:qa:test-session" },
          ...actions.slice(waitIndex, waitIndex + 3),
        ],
      },
    ],
  } satisfies QaScenarioFlow;
}

async function runWebchatTranscriptWait(
  readSessionTranscriptSummary: () => Promise<{
    finalText: string;
    hasDirectReplySelfMessage: boolean;
  }>,
) {
  return await runLoadedScenarioFlow("webchat-direct-reply-routing", {
    flow: readWebchatTranscriptWaitFlow(),
    api: {
      readSessionTranscriptSummary,
      waitForCondition: async <T>(check: () => Promise<T | undefined>) => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const value = await check();
          if (value !== undefined) {
            return value;
          }
        }
        throw new Error("test condition was not met");
      },
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      formatErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
      liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    },
  });
}

const planningEvidenceCoverageIds = new Set(["runtime.no-meta-leak", "workspace.planning"]);

type PlanningEvidenceScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaScenarioExecution, { kind: "flow" }> & { flow?: QaScenarioFlow };
};

function isPlanningEvidenceScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is PlanningEvidenceScenario {
  return (
    scenario.execution.kind === "flow" &&
    [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])].some(
      (coverageId) => planningEvidenceCoverageIds.has(coverageId),
    )
  );
}

type PlanningEvidenceFixture = {
  currentSummary: Record<string, unknown>;
  failureMessage: string;
  outboundText: string;
  scenario: PlanningEvidenceScenario;
};

function readPlanningEvidenceFlow(scenario: PlanningEvidenceScenario): QaScenarioFlow {
  const step = scenario.execution.flow?.steps.find((candidate) =>
    candidate.actions.some(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "call" in action &&
        action.call === "runAgentPrompt",
    ),
  );
  if (!step) {
    throw new Error(`planning scenario has no agent turn: ${scenario.id}`);
  }
  const artifactIndex = step.actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "artifactPath",
  );
  const evidenceActions = artifactIndex >= 0 ? step.actions.slice(0, artifactIndex) : step.actions;
  return {
    steps: [
      {
        name: "proves current-attempt planning evidence",
        actions: [
          { set: "selected", value: { provider: "openai", model: "gpt-5.6-luna" } },
          ...evidenceActions,
        ],
      },
    ],
  };
}

function createPlanningEvidenceFixture(
  scenario: PlanningEvidenceScenario,
): PlanningEvidenceFixture {
  const config = scenario.execution.config ?? {};
  const artifactFile = typeof config.artifactFile === "string" ? config.artifactFile : undefined;
  const expectedReply = typeof config.expectedReply === "string" ? config.expectedReply : undefined;
  const internalMarker =
    typeof config.internalMarker === "string" ? config.internalMarker : undefined;

  if (scenario.execution.runtime === "codex" && expectedReply && internalMarker) {
    return {
      scenario,
      outboundText: expectedReply,
      failureMessage: "missing marked Codex internal plan/reasoning mirror evidence",
      currentSummary: {
        eventCursor: 9,
        assistantMirrors: [
          { identity: "current-turn:plan", text: `Codex plan:\n${internalMarker}` },
          { identity: "current-turn:assistant", text: expectedReply },
        ],
        successfulToolCallCounts: {},
      },
    };
  }
  if (scenario.execution.runtime === "codex" && artifactFile) {
    const outboundText = `Built ${artifactFile}`;
    return {
      scenario,
      outboundText,
      failureMessage: "missing Codex App Server plan signal",
      currentSummary: {
        eventCursor: 9,
        assistantMirrors: [
          { identity: "current-turn:plan", text: "Codex plan:\n- build the game" },
          { identity: "current-turn:assistant", text: outboundText },
        ],
        successfulToolCallCounts: {},
      },
    };
  }
  if (scenario.execution.runtime === "openclaw" && artifactFile) {
    return {
      scenario,
      outboundText: `Built ${artifactFile}`,
      failureMessage: "missing OpenClaw update_plan signal",
      currentSummary: {
        eventCursor: 9,
        successfulToolCallCounts: { update_plan: 1 },
      },
    };
  }
  throw new Error(`unsupported planning evidence metadata: ${scenario.id}`);
}

function runPlanningEvidenceFixture(
  fixture: PlanningEvidenceFixture,
  currentSummary = fixture.currentSummary,
) {
  const state = createQaBusState();
  const readOptions: unknown[] = [];
  const summaries = [
    {
      eventCursor: 7,
      assistantMirrors: [
        { identity: "old-turn:plan", text: "Codex plan:\nQA_INTERNAL_PLAN_DO_NOT_SEND" },
        { identity: "old-turn:assistant", text: fixture.outboundText },
      ],
      successfulToolCallCounts: { update_plan: 1 },
    },
    currentSummary,
  ];
  let readIndex = 0;
  const result = runLoadedScenarioFlow(fixture.scenario.id, {
    flow: readPlanningEvidenceFlow(fixture.scenario),
    state,
    onWaitForOutboundMessage: ({ state: currentState }) => {
      currentState.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text: fixture.outboundText,
      });
    },
    api: {
      env: {
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      },
      readSessionTranscriptSummary: async (...args: unknown[]) => {
        readOptions.push(args[2]);
        const summary = summaries[readIndex];
        readIndex += 1;
        if (!summary) {
          throw new Error("unexpected transcript summary read");
        }
        return summary;
      },
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      runAgentPrompt: async () => ({ started: { runId: "current-run" }, waited: { status: "ok" } }),
    },
  });
  return { readOptions, result };
}

const planningEvidenceFixtures = readQaScenarioPack()
  .scenarios.filter(isPlanningEvidenceScenario)
  .map(createPlanningEvidenceFixture);

describe("scenario-flow-runner", () => {
  it.each(planningEvidenceFixtures)(
    "accepts current-attempt planning evidence for $scenario.id",
    async (fixture) => {
      const { readOptions, result } = runPlanningEvidenceFixture(fixture);

      await expect(result).resolves.toMatchObject({ status: "pass" });
      expect(readOptions).toEqual([{ allowEmpty: true }, { afterEventCursor: 7 }]);
    },
  );

  it.each(planningEvidenceFixtures)(
    "rejects stale prior-attempt planning evidence for $scenario.id",
    async (fixture) => {
      const currentSummary = {
        eventCursor: 8,
        ...(fixture.scenario.execution.runtime === "codex"
          ? {
              assistantMirrors: [
                { identity: "current-turn:assistant", text: fixture.outboundText },
              ],
            }
          : {}),
        successfulToolCallCounts: {},
      };
      const { readOptions, result } = runPlanningEvidenceFixture(fixture, currentSummary);

      await expect(result).rejects.toThrow(fixture.failureMessage);
      expect(readOptions).toEqual([{ allowEmpty: true }, { afterEventCursor: 7 }]);
    },
  );

  it("runs the canonical reaction lifecycle with target-bound actions", async () => {
    const state = createQaBusState();
    const actionTargets: unknown[] = [];
    const result = await runLoadedScenarioFlow("reaction-edit-delete", {
      state,
      api: {
        handleQaAction: async (params: {
          action: "delete" | "edit" | "react";
          args: Record<string, unknown>;
        }) => {
          actionTargets.push(params.args.to);
          const messageId = String(params.args.messageId);
          if (params.action === "react") {
            return state.reactToMessage({
              messageId,
              emoji: String(params.args.emoji),
            });
          }
          if (params.action === "edit") {
            return state.editMessage({
              messageId,
              text: String(params.args.text),
            });
          }
          return state.deleteMessage({ messageId });
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(actionTargets).toEqual(["channel:qa-room", "channel:qa-room", "channel:qa-room"]);
  });

  it("fails when a flow calls a transport method the adapter does not implement", async () => {
    await expect(
      runLoadedScenarioFlow("channel-message-flows", {
        omitOutboundSequence: true,
      }),
    ).rejects.toThrow(
      'QA scenario "channel-message-flows" cannot run "waitForOutboundSequence": the active transport adapter does not implement this method.',
    );
  });

  it("supports qaImport inside flow expressions", async () => {
    const result = await runScenarioFlow({
      api: {
        state: createQaBusState(),
        scenario: {
          id: "qa-import",
          title: "qa-import",
          sourcePath: "qa/scenarios/qa-import.yaml",
          surface: "test",
          objective: "test",
          successCriteria: ["test"],
          execution: { kind: "flow" },
        },
        config: {},
        runScenario: async (
          _name: string,
          steps: Array<{ name: string; run: () => Promise<string | void> }>,
        ) => {
          const stepResults = [];
          for (const step of steps) {
            const details = await step.run();
            stepResults.push({
              name: step.name,
              status: "pass" as const,
              ...(details !== undefined ? { details } : {}),
            });
          }
          return {
            name: "qa-import",
            status: "pass" as const,
            steps: stepResults,
          };
        },
      },
      scenarioTitle: "qa-import",
      vars: { preparedValue: "ready" },
      flow: {
        steps: [
          {
            name: "uses qaImport",
            actions: [
              {
                set: "basename",
                value: {
                  expr: '(await qaImport("node:path")).basename("/tmp/skill/SKILL.md")',
                },
              },
              {
                assert: {
                  expr: 'basename === "SKILL.md"',
                },
              },
              { assert: 'preparedValue === "ready"' },
            ],
            detailsExpr: "basename",
          },
        ],
      },
    });

    expect(result).toEqual({
      name: "qa-import",
      status: "pass",
      steps: [
        {
          name: "uses qaImport",
          status: "pass",
          details: "SKILL.md",
        },
      ],
    });
  });

  it("loads bundled QA fixture modules through qaImport", async () => {
    const result = await runScenarioFlow({
      api: {
        state: createQaBusState(),
        scenario: {
          id: "qa-fixture-import",
          title: "qa-fixture-import",
          sourcePath: "qa/scenarios/qa-fixture-import.yaml",
          surface: "test",
          objective: "test",
          successCriteria: ["test"],
          execution: { kind: "flow" },
        },
        config: {},
        runScenario: async (
          _name: string,
          steps: Array<{ name: string; run: () => Promise<string | void> }>,
        ) => {
          const stepResults = [];
          for (const step of steps) {
            const details = await step.run();
            stepResults.push({
              name: step.name,
              status: "pass" as const,
              ...(details !== undefined ? { details } : {}),
            });
          }
          return {
            name: "qa-fixture-import",
            status: "pass" as const,
            steps: stepResults,
          };
        },
      },
      scenarioTitle: "qa-fixture-import",
      flow: {
        steps: [
          {
            name: "uses bundled fixture qaImport",
            actions: [
              {
                set: "plugin",
                value: {
                  expr: 'await qaImport("./codex-plugin.fixture.js")',
                },
              },
              {
                assert: {
                  expr: 'typeof plugin.evaluateCodexPluginLifecycle === "function"',
                },
              },
            ],
            detailsExpr: '"loaded"',
          },
        ],
      },
    });

    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toBe("loaded");
  });

  it.each([
    {
      scenarioId: "channel-chat-baseline",
      to: "channel:qa-room",
      text: "generic shared-channel reply without the required marker",
    },
    {
      scenarioId: "dm-chat-baseline",
      to: "dm:alice",
      text: "generic DM reply without the required marker",
    },
  ])("rejects unmarked outbound replies for $scenarioId", async ({ scenarioId, to, text }) => {
    await expect(
      runLoadedScenarioFlow(scenarioId, {
        onWaitForOutboundMessage: ({ state }) => {
          state.addOutboundMessage({
            accountId: "qa-channel",
            to,
            text,
          });
        },
      }),
    ).rejects.toThrow("waiting for outbound marker");
  });

  it("rejects reconnect follow-up replies that replay the first marker", async () => {
    await expect(
      runLoadedScenarioFlow("qa-channel-reconnect-dedupe", {
        onWaitForOutboundMessage: ({ waitCount, state }) => {
          if (waitCount === 1) {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "channel:qa-room",
              text: "RECONNECT-FIRST-OK",
            });
            return;
          }
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:qa-room",
            text: "RECONNECT-FIRST-OK",
          });
        },
      }),
    ).rejects.toThrow("waiting for outbound marker");
  });

  it("rejects reconnect follow-up turns with extra unmarked outbound replies", async () => {
    await expect(
      runLoadedScenarioFlow("qa-channel-reconnect-dedupe", {
        onWaitForOutboundMessage: ({ waitCount, state }) => {
          if (waitCount === 1) {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "channel:qa-room",
              text: "RECONNECT-FIRST-OK",
            });
            return;
          }
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:qa-room",
            text: "RECONNECT-SECOND-OK",
          });
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:qa-room",
            text: "unmarked duplicate delivery",
          });
        },
      }),
    ).rejects.toThrow("exactly one marked post-restart reply");
  });

  it("waits through transient transcript states until the webchat reply is durable", async () => {
    let readCount = 0;
    const missingFile = Object.assign(new Error("transcript not written yet"), { code: "ENOENT" });
    const summaries = [
      missingFile,
      { finalText: "", hasDirectReplySelfMessage: false },
      { finalText: "WEBCHAT-DIRECT-REPLY-OK", hasDirectReplySelfMessage: false },
    ];

    const result = await runWebchatTranscriptWait(async () => {
      const summary = summaries[readCount];
      readCount += 1;
      if (summary instanceof Error) {
        throw summary;
      }
      if (!summary) {
        throw new Error("unexpected transcript read");
      }
      return summary;
    });

    expect(result.status).toBe("pass");
    expect(readCount).toBe(3);
  });

  it("fails the webchat transcript wait immediately on deterministic read errors", async () => {
    let readCount = 0;
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });

    await expect(
      runWebchatTranscriptWait(async () => {
        readCount += 1;
        throw permissionError;
      }),
    ).rejects.toBe(permissionError);
    expect(readCount).toBe(1);
  });
});
