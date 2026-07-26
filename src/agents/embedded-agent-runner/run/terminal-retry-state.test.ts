import { describe, expect, it } from "vitest";
import {
  hasExhaustedBeforeAgentFinalizeRevisions,
  MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
} from "./terminal-retry-state.js";

describe("before_agent_finalize retry state", () => {
  it("fails closed only after the configured revision budget is exhausted", () => {
    expect(
      hasExhaustedBeforeAgentFinalizeRevisions({
        revisionReason: "unfinished",
        revisionAttempts: MAX_BEFORE_AGENT_FINALIZE_REVISIONS - 1,
      }),
    ).toBe(false);
    expect(
      hasExhaustedBeforeAgentFinalizeRevisions({
        revisionReason: "unfinished",
        revisionAttempts: MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
      }),
    ).toBe(true);
  });

  it("does not treat an ordinary final answer as exhausted", () => {
    expect(
      hasExhaustedBeforeAgentFinalizeRevisions({
        revisionAttempts: MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
      }),
    ).toBe(false);
  });
});
