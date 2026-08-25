// Qa Lab tests cover scenario flow runner plugin behavior.
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import {
  readQaScenarioById,
  readQaScenarioPack,
  type QaScenarioExecution,
  type QaScenarioFlow,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

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
      normalizeLowercaseStringOrEmpty,
      formatErrorMessage: coerceErrorMessage,
      liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    },
  });
}

function readCurrentRunProviderPromptEvidenceFlow(trajectoryEvents: unknown[]): QaScenarioFlow {
  const scenario = readQaScenarioById("instruction-profile-artifact-followthrough-live");
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("instruction profile scenario has no actions");
  }
  const evidenceIndex = actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "providerPromptEvidence",
  );
  const assertionIndex = actions.findIndex(
    (action, index) =>
      index > evidenceIndex &&
      typeof action === "object" &&
      action !== null &&
      "assert" in action &&
      JSON.stringify(action).includes("current-run provider prompt evidence mismatch"),
  );
  if (evidenceIndex < 0 || assertionIndex < 0) {
    throw new Error("instruction profile scenario has no provider prompt evidence assertion");
  }
  const instructionContents = scenario.execution.config?.instructionContents;
  const instructionChars =
    typeof instructionContents === "string" ? instructionContents.trimEnd().length : 0;
  return {
    steps: [
      {
        name: "proves current-run provider prompt evidence",
        actions: [
          { set: "turn", value: { started: { runId: "current-run" } } },
          {
            set: "instructionProfileReport",
            value: {
              missing: false,
              truncated: false,
              rawChars: instructionChars,
              injectedChars: instructionChars,
            },
          },
          { set: "trajectoryEvents", value: trajectoryEvents },
          ...actions
            .slice(evidenceIndex, assertionIndex + 1)
            .filter(
              (action) =>
                !(
                  typeof action === "object" &&
                  action !== null &&
                  "call" in action &&
                  action.call === "fs.rm"
                ),
            ),
        ],
      },
    ],
  };
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
      failureMessage: "missing OpenClaw progress_card signal",
      currentSummary: {
        eventCursor: 9,
        successfulToolCallCounts: { progress_card: 1 },
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
      successfulToolCallCounts: { progress_card: 1 },
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
      normalizeLowercaseStringOrEmpty,
      runAgentPrompt: async () => ({ started: { runId: "current-run" }, waited: { status: "ok" } }),
    },
  });
  return { readOptions, result };
}

const planningEvidenceFixtures = readQaScenarioPack()
  .scenarios.filter(isPlanningEvidenceScenario)
  .map(createPlanningEvidenceFixture);

describe("scenario-flow-runner", () => {
  it("ignores stale provider prompt mismatches when the current run matches", async () => {
    const currentObservation = {
      egress: "responses-sdk",
      payloadVariant: "initial",
      promptSource: "input.developer",
      expectedChars: 4096,
      observedChars: 4096,
      matchesAssembledPrompt: true,
    };
    const result = await runLoadedScenarioFlow("instruction-profile-artifact-followthrough-live", {
      flow: readCurrentRunProviderPromptEvidenceFlow([
        {
          type: "provider.prompt.observed",
          runId: "stale-run",
          data: {
            ...currentObservation,
            promptSource: "missing",
            observedChars: 0,
            matchesAssembledPrompt: false,
          },
        },
        { type: "provider.prompt.observed", runId: "current-run", data: currentObservation },
      ]),
    });

    expect(result.status).toBe("pass");
  });

  it("excludes marker-bearing diagnostic trajectory context from bounded no-leak evidence", async () => {
    const marker = "INSTRUCTION-PROFILE-CONTEXT-MARKER-A6E29D4B";
    const trajectoryEvents = [
      {
        type: "context.compiled",
        runId: "current-run",
        data: { systemPrompt: `diagnostic support context ${marker}` },
      },
      {
        type: "provider.prompt.observed",
        runId: "current-run",
        data: {
          egress: "native-codex-websocket",
          payloadVariant: "initial",
          promptSource: "instructions",
          expectedChars: 4096,
          observedChars: 4096,
          matchesAssembledPrompt: true,
        },
      },
    ];

    expect(JSON.stringify(trajectoryEvents)).toContain(marker);
    const result = await runLoadedScenarioFlow("instruction-profile-artifact-followthrough-live", {
      flow: readCurrentRunProviderPromptEvidenceFlow(trajectoryEvents),
    });

    expect(result.status).toBe("pass");
  });

  it("keeps live goal followthrough inside the active-goal context limit", async () => {
    const state = createQaBusState();
    const artifactFile = "goal-continuance-live-00000000.txt";
    const artifactText = "Goal continuance advanced the concrete next step.";
    const conversation = "dm:goal-followthrough-live-00000000";

    const sessionListCalls: string[] = [];
    const result = await runLoadedScenarioFlow("goal-followthrough-live", {
      state,
      api: {
        env: {
          providerMode: "live-frontier",
          gateway: {
            workspaceDir: "/qa-goal",
            call: async (method: string) => {
              sessionListCalls.push(method);
              return {
                sessions: [
                  {
                    key: "agent:qa:main",
                    hasActiveRun: sessionListCalls.length === 1,
                    goal: { status: "active", objective: artifactFile },
                  },
                ],
              };
            },
          },
        },
        path: { join: (...parts: string[]) => parts.join("/") },
        fs: {
          readFile: async (file: string) => {
            const continued = state
              .getSnapshot()
              .messages.some(
                (message) => message.direction === "inbound" && message.text === "continue",
              );
            if (file === `/qa-goal/${artifactFile}` && continued) {
              return artifactText;
            }
            throw new Error("goal artifact has not been written");
          },
        },
        normalizeLowercaseStringOrEmpty,
      },
      onWaitForOutboundMessage: ({ waitCount, state: currentState }) => {
        const currentInbound = currentState
          .getSnapshot()
          .messages.findLast((message) => message.direction === "inbound");
        currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: conversation,
          replyToId: currentInbound?.id,
          text: waitCount === 1 ? "GOAL-CONTINUANCE-READY" : "GOAL-CONTINUANCE-DONE",
        });
      },
    });

    expect(result.status).toBe("pass");
    expect(sessionListCalls).toEqual(["sessions.list", "sessions.list", "sessions.list"]);
    const start = state
      .getSnapshot()
      .messages.find(
        (message) => message.direction === "inbound" && message.text.startsWith("/goal start "),
      );
    expect(start).toBeDefined();
    const objective = start?.text.slice("/goal start ".length) ?? "";
    expect(objective.length).toBeLessThanOrEqual(200);
    expect(objective).toContain("GOAL-CONTINUANCE-READY");
    expect(objective).toContain("GOAL-CONTINUANCE-DONE");
    expect(objective).toContain(artifactFile);
    expect(objective).toContain(artifactText);
    expect(
      state
        .getSnapshot()
        .messages.some((message) => message.direction === "inbound" && message.text === "continue"),
    ).toBe(true);
  });

  it("fails before continuation when the model prematurely completes a staged goal", async () => {
    const state = createQaBusState();
    const artifactFile = "goal-continuance-live-00000000.txt";
    const conversation = "dm:goal-followthrough-live-00000000";

    await expect(
      runLoadedScenarioFlow("goal-followthrough-live", {
        state,
        api: {
          env: {
            providerMode: "live-frontier",
            gateway: {
              workspaceDir: "/qa-goal",
              call: async () => ({
                sessions: [
                  {
                    key: "agent:qa:main",
                    hasActiveRun: false,
                    goal: { status: "complete", objective: artifactFile },
                  },
                ],
              }),
            },
          },
          path: { join: (...parts: string[]) => parts.join("/") },
          fs: {
            readFile: async () => {
              throw new Error("goal artifact has not been written");
            },
          },
        },
        onWaitForOutboundMessage: ({ state: currentState }) => {
          const currentInbound = currentState
            .getSnapshot()
            .messages.findLast((message) => message.direction === "inbound");
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: conversation,
            replyToId: currentInbound?.id,
            text: "GOAL-CONTINUANCE-READY",
          });
        },
      }),
    ).rejects.toThrow("goal closed before continue");
    expect(
      state
        .getSnapshot()
        .messages.some((message) => message.direction === "inbound" && message.text === "continue"),
    ).toBe(false);
  });

  it("rejects an artifact written after the ready preview but before the first goal turn settles", async () => {
    const state = createQaBusState();
    const artifactFile = "goal-continuance-live-00000000.txt";
    const conversation = "dm:goal-followthrough-live-00000000";
    let sessionListCalls = 0;

    await expect(
      runLoadedScenarioFlow("goal-followthrough-live", {
        state,
        api: {
          env: {
            providerMode: "live-frontier",
            gateway: {
              workspaceDir: "/qa-goal",
              call: async () => {
                sessionListCalls += 1;
                return {
                  sessions: [
                    {
                      key: "agent:qa:main",
                      hasActiveRun: sessionListCalls === 1,
                      goal: { status: "active", objective: artifactFile },
                    },
                  ],
                };
              },
            },
          },
          path: { join: (...parts: string[]) => parts.join("/") },
          fs: {
            readFile: async () => {
              if (sessionListCalls >= 2) {
                return "Goal continuance advanced the concrete next step.";
              }
              throw new Error("goal artifact has not been written");
            },
          },
        },
        onWaitForOutboundMessage: ({ state: currentState }) => {
          const currentInbound = currentState
            .getSnapshot()
            .messages.findLast((message) => message.direction === "inbound");
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: conversation,
            replyToId: currentInbound?.id,
            text: "GOAL-CONTINUANCE-READY",
          });
        },
      }),
    ).rejects.toThrow("goal created the second-step artifact before continue");

    expect(sessionListCalls).toBe(2);
    expect(
      state
        .getSnapshot()
        .messages.some((message) => message.direction === "inbound" && message.text === "continue"),
    ).toBe(false);
  });

  it.each(["runtime-first-hour-20-turn", "runtime-soak-100-turn"])(
    "fails %s when no requested outbound marker is delivered",
    async (scenarioId) => {
      await expect(runLoadedScenarioFlow(scenarioId)).rejects.toThrow("test condition was not met");
    },
  );

  it.each([
    { id: "runtime-first-hour-20-turn", prefix: "FIRST-HOUR-20", width: 2 },
    { id: "runtime-soak-100-turn", prefix: "SOAK-100", width: 3 },
  ])("fails $id when user turns are persisted more than once", async ({ id, prefix, width }) => {
    const state = createQaBusState();
    let turnCount = 0;
    await expect(
      runLoadedScenarioFlow(id, {
        state,
        api: {
          normalizeLowercaseStringOrEmpty,
          runAgentPrompt: async () => {
            turnCount += 1;
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "dm:qa-operator",
              text: `${prefix}-${String(turnCount).padStart(width, "0")}`,
            });
          },
          readSessionTranscriptSummary: async () => ({ userMessageCount: turnCount + 1 }),
        },
      }),
    ).rejects.toThrow("persisted user turns");
  });

  it.each([
    "control-ui-qa-channel-image-roundtrip",
    "control-ui-assistant-transcript-role-boundary",
  ])("opens the selected Control UI session from the gateway root for %s", async (scenarioId) => {
    const scenario = readQaScenarioById(scenarioId);
    const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions);
    if (!actions) {
      throw new Error(`scenario has no flow: ${scenarioId}`);
    }

    const sessionAction = actions.find(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "set" in action &&
        action.set === "uiSessionKey",
    );
    const urlAction = actions.find(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "set" in action &&
        action.set === "controlUiChatUrl",
    );
    const openAction = actions.find(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "call" in action &&
        action.call === "webOpenPage",
    );
    if (!sessionAction || !urlAction || !openAction) {
      throw new Error(`scenario has no Control UI session navigation: ${scenarioId}`);
    }

    const sessionKey = "agent:main:qa-channel:direct:control-ui-session";
    const gatewayToken = "qa token/+";
    const openedUrls: string[] = [];
    const result = await runLoadedScenarioFlow(scenarioId, {
      flow: {
        steps: [
          {
            name: "opens the selected chat session",
            actions: [sessionAction, urlAction, openAction],
          },
        ],
      },
      api: {
        env: {
          providerMode: "mock-openai",
          cfg: {
            agents: { list: [{ id: "main", default: true }] },
          },
          gateway: {
            baseUrl: "http://127.0.0.1:43124",
            token: gatewayToken,
          },
        },
        buildAgentSessionKey: () => sessionKey,
        webOpenPage: async ({ url }: { url: string }) => {
          openedUrls.push(url);
          return { pageId: "control-ui-session-page" };
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(openedUrls).toHaveLength(1);
    const openedUrl = openedUrls[0];
    if (!openedUrl) {
      throw new Error(`scenario did not open its Control UI session: ${scenarioId}`);
    }
    const chatUrl = new URL(openedUrl);
    expect(chatUrl.pathname).toBe("/");
    expect(chatUrl.searchParams.get("session")).toBe(sessionKey);
    expect(chatUrl.hash).toBe(`#token=${encodeURIComponent(gatewayToken)}`);
  });

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

  it("passes an imported QA skip error through to runScenario", async () => {
    const message = "known-harness-gap flow import skip";
    let receivedError: unknown;

    const result = await runScenarioFlow({
      api: {
        state: createQaBusState(),
        scenario: {
          id: "qa-skip-import",
          title: "qa-skip-import",
          sourcePath: "qa/scenarios/qa-skip-import.yaml",
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
          try {
            await steps[0]?.run();
          } catch (error) {
            receivedError = error;
          }
          return {
            name: "qa-skip-import",
            status: "skip" as const,
            steps: [{ name: "throws imported skip", status: "skip" as const, details: message }],
            details: message,
          };
        },
      },
      scenarioTitle: "qa-skip-import",
      flow: {
        steps: [
          {
            name: "throws imported skip",
            actions: [
              {
                call: "qaImport",
                args: ["./errors.js"],
                saveAs: "qaErrors",
              },
              {
                throw: {
                  expr: `new qaErrors.QaSuiteScenarioSkipError(${JSON.stringify(message)})`,
                },
              },
            ],
          },
        ],
      },
    });

    expect(receivedError).toBeInstanceOf(QaSuiteScenarioSkipError);
    expect(receivedError).toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message,
    });
    expect(result.status).toBe("skip");
    expect(result.details).toBe(message);
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
