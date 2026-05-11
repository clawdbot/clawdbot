import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface HandoffSnapshot {
  summary: string;
  activeSubagents: Array<{
    sessionId: string;
    role?: string;
    lastStatus?: string;
  }>;
}

/**
 * Builds the recovery briefing injected as the first user-side turn after a
 * model failover. The user role is used (not assistant) so the new model
 * treats the content as input rather than its own prior output.
 */
export function buildHierarchyReinforcementMessage(snapshot: HandoffSnapshot): AgentMessage {
  const subagentReport = snapshot.activeSubagents
    .map((s) => `- Subagent ${s.sessionId} (${s.role ?? "leaf"}): ${s.lastStatus ?? "running"}`)
    .join("\n");

  const content = [
    "[SYSTEM HANDOFF] The previous model is no longer active and a fallback model is now active.",
    "You are the new LEADER (Orchestrator). Do not perform tasks already delegated to subordinates.",
    "",
    "ACTIVE SUBORDINATE UNITS:",
    subagentReport || "None active.",
    "",
    "CURRENT STATE SUMMARY:",
    snapshot.summary,
    "",
    "INSTRUCTIONS:",
    "1. Review the state and subordinate reports.",
    "2. Provide strategic guidance and commands to subordinates.",
    "3. Do not repeat work already performed by subordinates.",
  ].join("\n");

  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}
