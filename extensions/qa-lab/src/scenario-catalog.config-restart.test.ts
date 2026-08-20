// Qa Lab tests cover config-restart scenario ordering.
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

describe("QA config-restart scenario catalog", () => {
  it("waits for the restart wake before using restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const restartPatchIndex = flow.indexOf('"note":{"ref":"wakeMarker"}');
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');

    expect(restartPatchIndex).toBeGreaterThanOrEqual(0);
    expect(wakeWaitIndex).toBeGreaterThan(restartPatchIndex);
    expect(capabilityPollIndex).toBeGreaterThan(wakeWaitIndex);
    expect(flow.indexOf('"call":"runAgentPrompt"')).toBeGreaterThan(capabilityPollIndex);
  });
});
