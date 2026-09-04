// Qa Lab tests cover config-restart scenario ordering.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";

describe("QA config-restart scenario catalog", () => {
  it("waits for the restart wake before using restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const restartPatchIndex = flow.indexOf('"note":{"ref":"wakeMarker"}');
    const restartOwnedPathIndex = flow.indexOf('"gateway.controlUi.basePath"');
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');

    expect(restartPatchIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedPathIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedPathIndex).toBeLessThan(wakeWaitIndex);
    expect(wakeWaitIndex).toBeGreaterThan(restartPatchIndex);
    expect(capabilityPollIndex).toBeGreaterThan(wakeWaitIndex);
    expect(flow.indexOf('"call":"runAgentPrompt"')).toBeGreaterThan(capabilityPollIndex);
  });

  it.each([
    undefined,
    { enabled: false, allowedOrigins: ["https://qa.example"] },
    { enabled: true, basePath: "/dashboard" },
    { enabled: true, basePath: "/qa-capability-flip" },
  ])("restores the original Control UI config after a failed wake: %j", async (controlUi) => {
    const scenario = readQaScenarioById("config-restart-capability-flip");
    if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
      throw new Error("config restart scenario must be a flow");
    }
    const original = {
      gateway: controlUi ? { controlUi } : {},
      tools: { deny: ["browser"] },
      agents: { defaults: { mediaModels: { image: { primary: "openai/gpt-image-1" } } } },
    };
    let current = structuredClone(original);
    const wakeError = new Error("restart wake unavailable");
    const pending = runScenarioFlow({
      scenarioTitle: scenario.title,
      flow: scenario.execution.flow,
      api: {
        state: createQaBusState(),
        scenario,
        config: scenario.execution.config ?? {},
        env: {},
        randomUUID,
        ensureImageGenerationConfigured: vi.fn(),
        readConfigSnapshot: () => ({ config: structuredClone(current) }),
        createSession: vi.fn(),
        patchConfig: ({ patch }: { patch: Record<string, unknown> }) => {
          current = applyQaMergePatch(current, patch) as typeof original;
        },
        waitForGatewayHealthy: vi.fn(),
        waitForQaChannelReady: vi.fn(),
        readEffectiveTools: () => new Set(),
        liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
        waitForOutboundMessage: () => {
          expect(current.gateway.controlUi?.basePath).toEqual(expect.any(String));
          expect(current.gateway.controlUi?.basePath).not.toBe(controlUi?.basePath);
          throw wakeError;
        },
        runScenario: async (name, steps) => {
          for (const step of steps) {
            await step.run();
          }
          return { name, status: "pass", steps: [] };
        },
      },
    });

    await expect(pending).rejects.toBe(wakeError);
    expect(current).toEqual(original);
  });
});
