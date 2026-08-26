import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  deleteAgentProvenanceForAgent,
  listAgentProvenance,
  readAgentProvenance,
  recordAgentProvenance,
} from "./agent-provenance.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

it("records, replaces, lists, and deletes agent creation provenance", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "empty", label: "agent-provenance" },
    async (state) => {
      recordAgentProvenance("Worker", { createdVia: "operator" }, { env: state.env, nowMs: 10 });
      expect(readAgentProvenance("worker", { env: state.env })).toEqual({
        agentId: "worker",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 10,
      });

      recordAgentProvenance(
        "worker",
        { createdVia: "agent", creatorAgentId: "Main" },
        { env: state.env, nowMs: 20 },
      );
      expect(listAgentProvenance({ env: state.env })).toEqual([
        {
          agentId: "worker",
          createdVia: "agent",
          creatorAgentId: "main",
          createdAtMs: 20,
        },
      ]);

      const database = openOpenClawStateDatabase({ env: state.env });
      deleteAgentProvenanceForAgent(database.db, "worker");
      expect(readAgentProvenance("worker", { env: state.env })).toBeUndefined();
    },
  );
});
