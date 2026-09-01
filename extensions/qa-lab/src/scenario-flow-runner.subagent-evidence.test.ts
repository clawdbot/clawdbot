// QA Lab flow wiring must require the shared causal subagent evidence seam.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const cases = [
  ["subagent-handoff", "Delegated task: task\nResult: fabricated\nEvidence: child completed"],
  ["subagent-forked-context", "FORKED-CONTEXT-ALPHA"],
] as const;

describe("subagent scenario evidence wiring", () => {
  it.each(cases)("requires causal evidence for %s", async (scenarioId, text) => {
    await expect(runFlow(scenarioId, text, false)).rejects.toThrow(
      /children=0 tasks=0 completed=0 childText=absent evidence=invalid/u,
    );
    await expect(runFlow(scenarioId, text, true)).resolves.toMatchObject({
      status: "pass",
    });
  });
});

async function runFlow(scenarioId: (typeof cases)[number][0], text: string, causal: boolean) {
  const state = createQaBusState();
  return await runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      env: { providerMode: "live-frontier", gateway: { runtimeEnv: {} } },
      runAgentPrompt: async () => {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text,
        });
      },
      waitForAgentHistoryReply: async () => ({ text }),
      normalizeLowercaseStringOrEmpty,
      collectSubagentScenarioEvidence: async () => ({
        evidence: causal ? true : undefined,
        summary: causal
          ? "children=1 tasks=1 completed=1 childText=present evidence=valid"
          : "children=0 tasks=0 completed=0 childText=absent evidence=invalid",
      }),
    },
  });
}
