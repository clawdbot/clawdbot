import { describe, expect, it } from "vitest";
import { resolveEmbeddedAttemptRetryParams } from "./attempt-dispatch-preparation.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./attempt-tool-construction-plan.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

describe("before-finalize revision attempt tool isolation", () => {
  it("keeps original tools, removes them for the accepted revision, and restores the next turn", () => {
    const runParams = {
      toolsAllow: ["read", "exec"],
      agentId: "matrix-agent",
      provider: "full-provider",
      model: "full-model",
      authProfileId: "full-auth-profile",
      harness: "embedded",
    } as never;
    const initialState = createEmbeddedRunTerminalRetryState();
    const original = resolveEmbeddedAttemptRetryParams({
      runParams,
      terminalRetryState: initialState,
    });
    expect(original).toBe(runParams);
    expect(
      resolveEmbeddedAttemptToolConstructionPlan({
        disableTools: original.disableTools,
        toolsAllow: original.toolsAllow,
      }).constructTools,
    ).toBe(true);

    initialState.disableToolsForBeforeFinalizeRevision = true;
    const revision = resolveEmbeddedAttemptRetryParams({
      runParams,
      terminalRetryState: initialState,
    });
    expect(revision.disableTools).toBe(true);
    expect(revision).toMatchObject({
      agentId: "matrix-agent",
      provider: "full-provider",
      model: "full-model",
      authProfileId: "full-auth-profile",
      harness: "embedded",
    });
    expect(
      resolveEmbeddedAttemptToolConstructionPlan({
        disableTools: revision.disableTools,
        toolsAllow: revision.toolsAllow,
      }).constructTools,
    ).toBe(false);

    const unrelatedTurn = resolveEmbeddedAttemptRetryParams({
      runParams,
      terminalRetryState: createEmbeddedRunTerminalRetryState(),
    });
    expect(unrelatedTurn.disableTools).not.toBe(true);
    expect(
      resolveEmbeddedAttemptToolConstructionPlan({
        disableTools: unrelatedTurn.disableTools,
        toolsAllow: unrelatedTurn.toolsAllow,
      }).constructTools,
    ).toBe(true);
  });
});
