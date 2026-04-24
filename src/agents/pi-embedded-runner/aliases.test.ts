import { describe, expect, it } from "vitest";
import { runEmbeddedAgent as runEmbeddedAgentFromNeutralBarrel } from "../embedded-runner.js";
import {
  abortEmbeddedAgentRun,
  abortEmbeddedPiRun,
  compactEmbeddedAgentSession,
  compactEmbeddedPiSession,
  runEmbeddedAgent,
  runEmbeddedPiAgent,
} from "../pi-embedded-runner.js";

describe("embedded runner compatibility aliases", () => {
  it("keeps neutral embedded-agent aliases bound to the PI compatibility exports", () => {
    expect(runEmbeddedAgent).toBe(runEmbeddedPiAgent);
    expect(runEmbeddedAgentFromNeutralBarrel).toBe(runEmbeddedPiAgent);
    expect(compactEmbeddedAgentSession).toBe(compactEmbeddedPiSession);
    expect(abortEmbeddedAgentRun).toBe(abortEmbeddedPiRun);
  });
});
