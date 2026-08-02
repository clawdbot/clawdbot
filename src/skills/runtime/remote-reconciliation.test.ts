import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeRegistry } from "../../gateway/node-registry.js";
import { mergeRemoteNodeSkillEntries, replaceRemoteNodeSkills } from "./remote-skills.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  setSkillsRemoteRegistry,
} from "./remote.js";

const TEST_PAIRING_GENERATION = "generation-test";

afterEach(() => {
  setSkillsRemoteRegistry(null);
  vi.restoreAllMocks();
});

describe("remote projection reconciliation", () => {
  it("rejects legacy-generation and connectionless node projections", () => {
    const legacyNodeId = `node-${randomUUID()}`;
    const missingConnectionNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const legacySkillName = `skill-${randomUUID()}`;
    const missingConnectionSkillName = `skill-${randomUUID()}`;
    const listCurrentConnectedSync = vi.fn(() => []);
    try {
      setSkillsRemoteRegistry({
        listCurrentConnectedSync,
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo({
        nodeId: legacyNodeId,
        connId: "conn-retired",
        displayName: "Legacy Mac",
        platform: "darwin",
        commands: ["system.run"],
      });
      replaceRemoteNodeSkills({
        nodeId: legacyNodeId,
        displayName: "Legacy Mac",
        skills: [
          {
            name: legacySkillName,
            description: "Legacy remote skill",
            content: `---\nname: ${legacySkillName}\ndescription: Legacy remote skill\n---\n`,
          },
        ],
      });
      recordRemoteNodeInfo({
        nodeId: missingConnectionNodeId,
        pairingGeneration: TEST_PAIRING_GENERATION,
        displayName: "Retired Mac",
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });
      recordRemoteNodeBins(missingConnectionNodeId, [bin], TEST_PAIRING_GENERATION);
      replaceRemoteNodeSkills({
        nodeId: missingConnectionNodeId,
        displayName: "Retired Mac",
        skills: [
          {
            name: missingConnectionSkillName,
            description: "Retired remote skill",
            content: `---\nname: ${missingConnectionSkillName}\ndescription: Retired remote skill\n---\n`,
          },
        ],
      });

      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
      expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
      expect(listCurrentConnectedSync).toHaveBeenCalled();
    } finally {
      removeRemoteNodeInfo(legacyNodeId);
      removeRemoteNodeInfo(missingConnectionNodeId);
    }
  });
});
