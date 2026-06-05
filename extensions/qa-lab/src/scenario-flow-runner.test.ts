// Qa Lab tests cover scenario flow runner plugin behavior.
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
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
    onWaitForOutboundMessage?: (params: {
      waitCount: number;
      state: ReturnType<typeof createQaBusState>;
    }) => void;
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const flow = scenario.execution.flow;
  if (!flow) {
    throw new Error(`scenario has no flow: ${scenarioId}`);
  }

  const state = createQaBusState();
  let waitCount = 0;
  const api = {
    env: {},
    state,
    scenario,
    config: scenario.execution.config ?? {},
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    waitForGatewayHealthy: async () => undefined,
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
  };

  return await runScenarioFlow({
    api,
    scenarioTitle: scenario.title,
    flow,
  });
}

describe("scenario-flow-runner", () => {
  it("supports qaImport inside flow expressions", async () => {
    const result = await runScenarioFlow({
      api: {
        state: createQaBusState(),
        scenario: {
          id: "qa-import",
          title: "qa-import",
          sourcePath: "qa/scenarios/qa-import.md",
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
          sourcePath: "qa/scenarios/qa-fixture-import.md",
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
                  expr: 'typeof plugin.createCodexPluginInstallGate === "function"',
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

  it("can hold a gated promise across later flow actions", async () => {
    const result = await runScenarioFlow({
      api: {
        state: createQaBusState(),
        scenario: {
          id: "qa-gated-promise",
          title: "qa-gated-promise",
          sourcePath: "qa/scenarios/qa-gated-promise.md",
          surface: "test",
          objective: "test",
          successCriteria: ["test"],
          execution: { kind: "flow" },
        },
        config: { expectedText: "QA_CODEX_PLUGIN_TURN_OK" },
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
            name: "qa-gated-promise",
            status: "pass" as const,
            steps: stepResults,
          };
        },
      },
      scenarioTitle: "qa-gated-promise",
      flow: {
        steps: [
          {
            name: "uses deferred promise wrapper",
            actions: [
              {
                set: "plugin",
                value: {
                  expr: 'await qaImport("./codex-plugin.fixture.js")',
                },
              },
              {
                set: "gate",
                value: {
                  expr: "plugin.createCodexPluginInstallGate()",
                },
              },
              {
                set: "turn",
                value: {
                  expr: "({ promise: gate.runFirstTurnAfterInstall({ inputTokens: 17, run: () => config.expectedText }) })",
                },
              },
              {
                assert: {
                  expr: 'JSON.stringify(gate.events) === JSON.stringify(["agent-turn:waiting-for-codex-plugin"])',
                },
              },
              { call: "gate.markInstalled" },
              {
                set: "completed",
                value: {
                  expr: "await turn.promise",
                },
              },
              {
                assert: {
                  expr: "completed.text === config.expectedText && completed.responseCount === 1 && completed.inputTokens === 17",
                },
              },
            ],
            detailsExpr: "completed.text",
          },
        ],
      },
    });

    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toBe("QA_CODEX_PLUGIN_TURN_OK");
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
});
