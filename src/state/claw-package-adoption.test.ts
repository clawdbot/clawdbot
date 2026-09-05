import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "../claws/package-remove.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
} from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import { markClawPackageIndependentlyOwned } from "./claw-package-adoption.js";
import {
  acquireClawPackageLifecycleLease,
  withClawPackageLifecycleLease,
} from "./claw-package-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const packageIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function plan(agentId: string, workspace: string): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: `sha256:${agentId}`,
    claw: {
      kind: "package",
      name: `@acme/${agentId}`,
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/CLAW.md",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 100,
    },
    agent: {
      requestedId: agentId,
      finalId: agentId,
      workspace,
      config: { id: agentId, workspace },
    },
    summary: {
      totalActions: 0,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: 0,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: [],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

describe("Claw package independent adoption", () => {
  it("does not fail an ordinary install when Claw state is unavailable", () => {
    const path = join(tempDirs.make("claw-adoption-invalid-"), "state.sqlite");
    writeFileSync(path, "not sqlite");

    expect(
      markClawPackageIndependentlyOwned(
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@acme/audit",
          version: "1.0.0",
        },
        { path },
      ),
    ).toBe(0);
  });

  it("marks every shared plugin reference independently owned", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-adoption-") };
    for (const agentId of ["first", "second"]) {
      const current = plan(agentId, `/tmp/${agentId}`);
      persistClawInstallRecord(current, { env });
      for (const version of ["1.0.0", "2.0.0"]) {
        persistClawPackageRef(
          current,
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@acme/audit",
            version,
            integrity: packageIntegrity,
          },
          {
            env,
            nowMs: 10,
            relationship: "referenced",
            origin: "claw-introduced",
            independentOwner: false,
          },
        );
      }
    }

    const artifact = {
      kind: "plugin",
      source: "clawhub",
      ref: "@acme/audit",
      version: "1.0.0",
    } as const;
    expect(markClawPackageIndependentlyOwned(artifact, { env, nowMs: 42 })).toBe(2);
    expect(markClawPackageIndependentlyOwned(artifact, { env, nowMs: 99 })).toBe(0);
    const refs = readClawPackageRefs({ env }).toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.version.localeCompare(right.version),
    );
    expect(refs).toMatchObject([
      { version: "1.0.0", independentOwner: true, updatedAtMs: 42 },
      { version: "2.0.0", independentOwner: false, updatedAtMs: 10 },
      { version: "1.0.0", independentOwner: true, updatedAtMs: 42 },
      { version: "2.0.0", independentOwner: false, updatedAtMs: 10 },
    ]);
    expect(refs.every((ref) => ref.origin === "claw-introduced")).toBe(true);
  });

  it("scopes skill adoption to the owning agent workspace", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-adoption-") };
    for (const agentId of ["first", "second"]) {
      const current = plan(agentId, `/tmp/${agentId}`);
      persistClawInstallRecord(current, { env });
      persistClawPackageRef(
        current,
        {
          kind: "skill",
          source: "clawhub",
          ref: "triage",
          version: "1.0.0",
          integrity: packageIntegrity,
        },
        {
          env,
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
        },
      );
    }

    expect(
      markClawPackageIndependentlyOwned(
        {
          kind: "skill",
          source: "clawhub",
          ref: "triage",
          version: "1.0.0",
          workspace: "/tmp/first",
        },
        { env },
      ),
    ).toBe(1);
    expect(readClawPackageRefs({ env, agentId: "first" })).toMatchObject([
      { origin: "claw-introduced", independentOwner: true },
    ]);
    expect(readClawPackageRefs({ env, agentId: "second" })).toMatchObject([
      { origin: "claw-introduced", independentOwner: false },
    ]);
  });

  it("retains global plugins and releases their Claw references", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-adoption-race-") };
    const current = plan("worker", "/tmp/worker");
    const install = persistClawInstallRecord(current, { env });
    const ref = persistClawPackageRef(
      current,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/audit",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      {
        env,
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    );
    const decisions = await planClawPackageRemovals(install, [ref], { env });

    const results = await applyClawPackageRemovals(decisions, { env });

    expect(results).toMatchObject([{ action: "retained" }]);
    const directLease = acquireClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: "@acme/audit" },
      { env, required: true },
    );
    expect(directLease).not.toBeNull();
    directLease?.release();
  });

  it("serializes all skill mutations that share a workspace lockfile", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-skill-lease-") };
    const first = acquireClawPackageLifecycleLease(
      { kind: "skill", source: "clawhub", ref: "triage", workspace: "/tmp/worker" },
      { env, required: true },
    );
    expect(() =>
      acquireClawPackageLifecycleLease(
        { kind: "skill", source: "clawhub", ref: "summarize", workspace: "/tmp/worker" },
        { env, required: true },
      ),
    ).toThrow("being changed by another OpenClaw lifecycle");
    const otherWorkspace = acquireClawPackageLifecycleLease(
      { kind: "skill", source: "clawhub", ref: "triage", workspace: "/tmp/other" },
      { env, required: true },
    );
    expect(otherWorkspace).not.toBeNull();
    otherWorkspace?.release();
    first?.release();
  });

  it("leases a direct operation before the first Claw package reference exists", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-first-lease-") };
    const directLease = acquireClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: "@acme/audit" },
      { env },
    );
    expect(directLease).not.toBeNull();
    expect(() =>
      acquireClawPackageLifecycleLease(
        { kind: "plugin", source: "clawhub", ref: "@acme/audit" },
        { env },
      ),
    ).toThrow("being changed by another OpenClaw lifecycle");
    expect(() =>
      acquireClawPackageLifecycleLease(
        { kind: "plugin", source: "clawhub", ref: "@acme/audit" },
        { env, required: true },
      ),
    ).toThrow("being changed by another OpenClaw lifecycle");
    directLease?.release();
  });

  it("releases a package lease when process exit bypasses async cleanup", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-exit-lease-") };
    const artifact = { kind: "plugin", source: "clawhub", ref: "@acme/audit" } as const;
    const existingExitListeners = new Set(process.listeners("exit"));

    await expect(
      withClawPackageLifecycleLease(
        artifact,
        async () => {
          const exitCleanup = process
            .listeners("exit")
            .find((listener) => !existingExitListeners.has(listener));
          expect(exitCleanup).toBeTypeOf("function");
          exitCleanup?.(1);
          throw new Error("simulated process exit");
        },
        { env, required: true },
      ),
    ).rejects.toThrow("simulated process exit");

    expect(
      process.listeners("exit").filter((listener) => !existingExitListeners.has(listener)),
    ).toEqual([]);
    const nextLease = acquireClawPackageLifecycleLease(artifact, { env, required: true });
    expect(nextLease).not.toBeNull();
    nextLease?.release();
  });

  it("fails open only for optional direct leases when lifecycle state is unavailable", () => {
    const invalidDatabasePath = tempDirs.make("claw-invalid-db-path-");
    const artifact = { kind: "plugin", source: "clawhub", ref: "@acme/audit" } as const;
    expect(acquireClawPackageLifecycleLease(artifact, { path: invalidDatabasePath })).toBeNull();
    expect(() =>
      acquireClawPackageLifecycleLease(artifact, {
        path: invalidDatabasePath,
        required: true,
      }),
    ).toThrow();
  });
});
