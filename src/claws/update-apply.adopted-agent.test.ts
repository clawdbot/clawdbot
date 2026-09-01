import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { clawUpdateFixtures } from "./update-apply.test-support.js";

afterEach(closeOpenClawStateDatabaseForTest);

const { source, manifest, install, addPlan, adoptedTargetAgentDigest, plan, consent } =
  clawUpdateFixtures();

describe("applyClawUpdatePlan adopted agent", () => {
  it("preserves an adopted agent default marker in config and provenance", async () => {
    const liveAgent = {
      id: "worker",
      name: "Worker",
      workspace: "/tmp/workspace-worker",
      default: true,
    };
    const currentDigest = `sha256:${createHash("sha256")
      .update(stableStringify(liveAgent))
      .digest("hex")}`;
    const adoptedInstall: PersistedClawInstall = {
      ...install,
      schemaVersion: "openclaw.clawInstallRecord.v3",
      agentOrigin: "adopted",
      agentConfigDigest: currentDigest,
    };
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
        desiredDigest: adoptedTargetAgentDigest,
      },
    ]);
    let config: OpenClawConfig = {
      agents: {
        entries: {
          WORKER: { name: liveAgent.name, workspace: liveAgent.workspace, default: true },
        },
      },
    };
    const persistInstall = vi.fn((targetPlan: ClawAddPlan) => {
      expect(targetPlan.agent.config.default).toBe(true);
      return adoptedInstall;
    });

    await applyClawUpdatePlan(
      updatePlan,
      { targetManifest: manifest, targetSource: source },
      {
        config,
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        buildAddPlan: vi.fn(async () => addPlan),
        readInstall: vi.fn(() => adoptedInstall),
        persistInstall,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: async () => undefined })),
        applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: async () => undefined })),
        applyCron: vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined })),
        applyPackage: vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined })),
      },
    );

    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker v2",
      workspace: "/tmp/workspace-worker",
      default: true,
    });
    expect(config.agents?.entries?.WORKER).toBeUndefined();
    expect(persistInstall).toHaveBeenCalledOnce();
  });
});
