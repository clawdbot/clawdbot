// Qa Lab tests cover config-restart scenario ordering.
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

describe("QA config-restart scenario catalog", () => {
  it("waits for the restart wake before using restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const restartPatchIndex = flow.indexOf('"note":{"ref":"wakeMarker"}');
    const restartOwnedPathIndex = flow.indexOf('"gateway.terminal.enabled"');
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');

    expect(restartPatchIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedPathIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedPathIndex).toBeLessThan(wakeWaitIndex);
    expect(wakeWaitIndex).toBeGreaterThan(restartPatchIndex);
    expect(capabilityPollIndex).toBeGreaterThan(wakeWaitIndex);
    expect(flow.indexOf('"call":"runAgentPrompt"')).toBeGreaterThan(capabilityPollIndex);
  });

  it("restores the complete terminal subtree, including its absence", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));

    expect(flow).toContain(
      '"expr":"original.config.gateway && Object.prototype.hasOwnProperty.call(original.config.gateway, \'terminal\') ? structuredClone(original.config.gateway.terminal) : undefined"',
    );
    expect(flow).toContain('"expr":"originalTerminal?.enabled === false ? true : false"');
    expect(flow).toContain(
      '"expr":"originalTerminal !== undefined && Object.prototype.hasOwnProperty.call(originalTerminal, \'enabled\')"',
    );
    expect(flow).toContain(
      '"terminal":{"expr":"originalTerminal === undefined ? null : (originalTerminalEnabledPresent ? originalTerminal : { ...originalTerminal, enabled: null })"}',
    );
    expect(flow.match(/"gateway\.terminal\.enabled"/g)).toHaveLength(1);
  });
});
