// Qa Lab tests cover config-restart scenario ordering.
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

describe("QA config-restart scenario catalog", () => {
  it("uses config.apply and waits for its restart wake before restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const wakeStartIndex = flow.indexOf('"set":"wakeStartIndex"');
    const nextConfigIndex = flow.indexOf('"set":"nextConfig"');
    const restartRequestedIndex = flow.indexOf('"set":"restartRequestedAtMs"');
    const restartApplyIndex = flow.indexOf('"call":"applyConfig"');
    const applyResultIndex = flow.indexOf('"saveAs":"applyResult"', restartApplyIndex);
    const sentinelAssertIndex = flow.indexOf("applyResult.sentinel?.persisted");
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const wakeSinceIndex = flow.indexOf('"sinceIndex":{"ref":"wakeStartIndex"}', wakeWaitIndex);
    const lifecycleWaitIndex = flow.indexOf('"call":"waitForSessionRunAfter"', wakeWaitIndex);
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');
    const promptIndex = flow.indexOf('"call":"runAgentPrompt"');
    const cleanupApplyIndex = flow.lastIndexOf('"call":"applyConfig"');

    expect(wakeStartIndex).toBeGreaterThanOrEqual(0);
    expect(nextConfigIndex).toBeGreaterThan(wakeStartIndex);
    expect(restartRequestedIndex).toBeGreaterThan(nextConfigIndex);
    expect(restartApplyIndex).toBeGreaterThan(restartRequestedIndex);
    expect(applyResultIndex).toBeGreaterThan(restartApplyIndex);
    expect(sentinelAssertIndex).toBeGreaterThan(applyResultIndex);
    expect(flow).toContain("payload?.stats?.requiresRestart === true");
    expect(wakeWaitIndex).toBeGreaterThan(sentinelAssertIndex);
    expect(wakeSinceIndex).toBeGreaterThan(wakeWaitIndex);
    expect(lifecycleWaitIndex).toBeGreaterThan(wakeSinceIndex);
    expect(capabilityPollIndex).toBeGreaterThan(lifecycleWaitIndex);
    expect(promptIndex).toBeGreaterThan(capabilityPollIndex);
    expect(cleanupApplyIndex).toBeGreaterThan(promptIndex);
    expect(flow.match(/"call":"applyConfig"/g)).toHaveLength(2);
    expect(flow.match(/"call":"patchConfig"/g)).toHaveLength(1);
    expect(flow).not.toContain("restartGatewayWithConfigPatch");
    expect(flow).not.toContain("originalImageGenerationModelPrimary");
  });
});
