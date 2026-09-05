import { closeOpenClawAgentDatabases, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

openOpenClawAgentDatabase({
  agentId: process.argv[2] ?? "worker",
  path: process.argv[3] || undefined,
});
process.send?.("ready");
process.once("message", () => {
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabaseForTest();
  process.disconnect?.();
});
