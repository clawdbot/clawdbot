import { describe, expect, it } from "vitest";
import { unregisterResolvedAgentDir } from "../../agents/agent-dir-registry.js";
import {
  readPersistedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveModelsTargetAgent } from "./shared.js";

describe("model inspection auth store ownership", () => {
  it("retains the configured owner when a read override selects the same custom directory", async () => {
    await withOpenClawTestState({ label: "models-custom-owner" }, async (state) => {
      const agentId = "helper";
      const agentDir = state.statePath("agents", agentId);
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { [agentId]: { agentDir } } },
      };
      openOpenClawAgentDatabase({ agentId, path: resolveAuthProfileDatabasePath(agentDir) });
      try {
        const target = resolveModelsTargetAgent(cfg, undefined, {
          kind: "read",
          agentDirOverride: agentDir,
        });
        const authState = { version: 1, lastGood: { anthropic: "anthropic:local" } };

        writePersistedAuthProfileStateRaw(authState, target.agentDir);

        expect(target).toEqual({ agentId, agentDir });
        expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual(authState);
      } finally {
        unregisterResolvedAgentDir({ agentId, agentDir });
      }
    });
  });

  it("preserves an unrelated override without assigning it the configured agent's ownership", async () => {
    await withOpenClawTestState({ label: "models-override-owner" }, async (state) => {
      const agentId = "helper";
      const agentDir = state.statePath("agents", agentId);
      const overrideDir = state.statePath("separate-auth");
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { [agentId]: { agentDir } } },
      };
      openOpenClawAgentDatabase({
        agentId: "separate-owner",
        path: resolveAuthProfileDatabasePath(overrideDir),
      });
      try {
        const target = resolveModelsTargetAgent(cfg, undefined, {
          kind: "read",
          agentDirOverride: overrideDir,
        });

        expect(target).toEqual({ agentId, agentDir: overrideDir });
        expect(() => writePersistedAuthProfileStateRaw({ version: 1 }, target.agentDir)).toThrow(
          /requested agent custom-/,
        );
      } finally {
        unregisterResolvedAgentDir({ agentId, agentDir });
      }
    });
  });
});
