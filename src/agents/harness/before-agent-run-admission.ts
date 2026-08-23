/**
 * Run-scoped memo for the fail-closed before_agent_run gate.
 *
 * The memo is the logical run's own object: allocated once outside the attempt
 * retry loop and copied by reference into each dispatched attempt, so a
 * decision cannot outlive its run or be reached by a later run that reuses the
 * same runId. Harnesses pass it back to the gate helper and never inspect it.
 */

/** One run's recorded gate decision. Opaque to harnesses. */
export type AgentHarnessBeforeAgentRunAdmission = {
  decision?: { action: "proceed" } | { action: "blocked"; blockedBy: string; message: string };
};
