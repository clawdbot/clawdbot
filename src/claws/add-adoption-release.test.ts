// Rollback boundary for an adoption whose config commit never landed.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
} from "../agents/workspace-state-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { releaseUnclaimedClawAdoption } from "./add-adoption-release.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function ownedFile(workspace: string, path: string, content: string): PersistedClawWorkspaceFile {
  return {
    schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
    agentId: "worker",
    workspace,
    path,
    sourcePath: path,
    contentDigest: digest(content),
    status: "complete",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function installRecord(workspace: string, bootstrapContent?: string): PersistedClawInstall {
  return {
    schemaVersion: "openclaw.clawInstallRecord.v3",
    claw: {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: workspace,
      manifestPath: join(workspace, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:manifest",
      byteLength: 1,
    },
    manifestSchemaVersion: 1,
    planIntegrity: "sha256:plan",
    agentId: "worker",
    workspace,
    agentConfigDigest: "sha256:agent",
    agentOwnedPaths: [],
    agentOrigin: "adopted",
    status: "workspace_ready",
    addedAtMs: 1,
    updatedAtMs: 1,
    ...(bootstrapContent
      ? { bootstrap: { sourcePath: "BOOTSTRAP.md", contentDigest: digest(bootstrapContent) } }
      : {}),
  } as PersistedClawInstall;
}

function planWith(workspace: string, actions: ClawAddPlan["actions"]): ClawAddPlan {
  return { agent: { finalId: "worker", workspace }, actions } as unknown as ClawAddPlan;
}

describe("releaseUnclaimedClawAdoption", () => {
  it("keeps a declared file the attempt adopted instead of writing", async () => {
    const root = tempDirs.make("openclaw-claw-release-adopted-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const adopted = join(workspace, "SKILL.md");
    await writeFile(adopted, "operator content");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    const result = await releaseUnclaimedClawAdoption({
      plan: planWith(workspace, [
        {
          kind: "workspaceFile",
          id: "SKILL.md",
          action: "adopt",
          target: adopted,
          blocked: false,
        },
      ] as ClawAddPlan["actions"]),
      install: installRecord(workspace),
      workspaceFiles: [ownedFile(workspace, "SKILL.md", "operator content")],
      packages: [],
      bootstrapSeeded: false,
      options: { env },
    });

    expect(result).toEqual({ released: true, retained: [] });
    // The attempt claimed this file, it never wrote it; releasing the claim must not delete it.
    expect(existsSync(adopted)).toBe(true);
  });

  it("clears the seed marker with the bootstrap it rolls back", async () => {
    const root = tempDirs.make("openclaw-claw-release-bootstrap-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const bootstrap = join(workspace, "BOOTSTRAP.md");
    await writeFile(bootstrap, "seeded bootstrap");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    mergeWorkspaceSetupState(workspace, { bootstrapSeededAt: new Date(1).toISOString() }, 1, {
      env,
    });

    const result = await releaseUnclaimedClawAdoption({
      plan: planWith(workspace, [] as ClawAddPlan["actions"]),
      install: installRecord(workspace, "seeded bootstrap"),
      workspaceFiles: [],
      packages: [],
      bootstrapSeeded: true,
      options: { env, nowMs: 2 },
    });

    expect(result).toEqual({ released: true, retained: [] });
    expect(existsSync(bootstrap)).toBe(false);
    // A marker left behind makes the next seed read "already seeded, file gone" as consumed and
    // silently skip the retry's bootstrap.
    expect(readWorkspaceStateSnapshot(workspace, { env }).setup.bootstrapSeededAt).toBeUndefined();
  });
});
