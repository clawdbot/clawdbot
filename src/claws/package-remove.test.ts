import { describe, expect, it, vi } from "vitest";
import { applyClawPackageRemovals, planClawPackageRemovals } from "./package-remove.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";

const install = {
  workspace: "/tmp/claw-workspace",
} as PersistedClawInstall;

function packageRef(overrides: Partial<PersistedClawPackageRef> = {}): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "@acme/worker",
    kind: "plugin",
    source: "clawhub",
    ref: "audit",
    version: "1.0.0",
    integrity: "sha256:audit",
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function packageRefStore(...initial: PersistedClawPackageRef[]) {
  let refs = initial;
  return {
    acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
    readPackageRefs: vi.fn(() => refs),
    readInstallRecords: vi.fn(() => []),
    claimPackageRef: vi.fn(
      (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => {
        const claimed = { ...ref, status };
        refs = refs.map((candidate) =>
          candidate.agentId === ref.agentId &&
          candidate.kind === ref.kind &&
          candidate.source === ref.source &&
          candidate.ref === ref.ref &&
          candidate.version === ref.version
            ? claimed
            : candidate,
        );
        return claimed;
      },
    ),
  };
}

describe("Claw package removal", () => {
  it("retains referenced plugins by default while releasing the Claw reference", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn(),
      },
    });

    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason: "Referenced resources are retained unless a cleanup mode selects them.",
      },
    ]);
  });

  it("removes an unused Claw-introduced reference through the canonical plugin lifecycle", async () => {
    const ref = packageRef();
    const store = packageRefStore(ref);
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        ...store,
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
          installedVersion: "1.0.0",
        }),
      },
      referencedCleanup: { mode: "remove-if-unused" },
    });

    expect(decisions).toMatchObject([{ action: "uninstall", pluginId: "audit" }]);
    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          ...store,
          uninstallPlugin,
          resolvePlugin: vi.fn().mockResolvedValue({
            status: "found",
            pluginId: "audit",
            record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
            installedVersion: "1.0.0",
          }),
        },
      }),
    ).resolves.toMatchObject([{ action: "uninstalled" }]);
    expect(uninstallPlugin).toHaveBeenCalledWith("audit", {
      force: true,
      invalidateRuntimeCache: false,
      clawManaged: true,
    });
  });

  it("rechecks plugin identity under the lifecycle lease before uninstalling", async () => {
    const ref = packageRef();
    const store = packageRefStore(ref);
    const uninstallPlugin = vi.fn();

    await expect(
      applyClawPackageRemovals(
        [
          {
            packageRef: ref,
            workspace: install.workspace,
            action: "uninstall",
            affectedClawAgentIds: [],
            pluginId: "audit",
          },
        ],
        {
          deps: {
            ...store,
            uninstallPlugin,
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "replacement",
              record: { source: "clawhub", integrity: "sha256:replacement" },
              installedVersion: "2.0.0",
            }),
          },
        },
      ),
    ).resolves.toMatchObject([
      {
        action: "error",
        reason: "Plugin audit@1.0.0 changed after removal planning.",
      },
    ]);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(store.claimPackageRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ ref: "audit" }),
      "complete",
      expect.anything(),
    );
  });

  it("leaves failed provenance when an error occurs after uninstall starts", async () => {
    const ref = packageRef();
    const store = packageRefStore(ref);
    const heartbeat = vi.fn(() => {
      throw new Error("lease lost");
    });

    await expect(
      applyClawPackageRemovals(
        [
          {
            packageRef: ref,
            workspace: install.workspace,
            action: "uninstall",
            affectedClawAgentIds: [],
            pluginId: "audit",
          },
        ],
        {
          deps: {
            ...store,
            acquirePackageLease: vi.fn(() => ({ heartbeat, release: vi.fn() })),
            uninstallPlugin: vi.fn().mockResolvedValue(undefined),
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "audit",
              record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
              installedVersion: "1.0.0",
            }),
          },
        },
      ),
    ).resolves.toMatchObject([{ action: "error", reason: "lease lost" }]);

    expect(store.claimPackageRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ ref: "audit" }),
      "failed",
      expect.anything(),
    );
  });

  it("requires an explicit override to remove a selected shared reference", async () => {
    const ref = packageRef();
    const other = packageRef({ agentId: "other" });
    const deps = {
      readPackageRefs: vi.fn().mockReturnValue([ref, other]),
      resolvePlugin: vi.fn().mockResolvedValue({
        status: "found",
        pluginId: "audit",
        record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
        installedVersion: "1.0.0",
      }),
    };
    const selected = ["plugin:audit@1.0.0"];

    await expect(
      planClawPackageRemovals(install, [ref], {
        deps,
        referencedCleanup: { mode: "remove-selected", selected },
      }),
    ).resolves.toMatchObject([
      { action: "retain", blocked: true, affectedClawAgentIds: ["other"] },
    ]);
    await expect(
      planClawPackageRemovals(install, [ref], {
        deps,
        referencedCleanup: { mode: "remove-selected", selected, allowConflicts: true },
      }),
    ).resolves.toMatchObject([
      {
        action: "uninstall",
        allowConflicts: true,
        affectedClawAgentIds: ["other"],
      },
    ]);
  });

  it.each([
    ["independently-owned", packageRef({ independentOwner: true })],
    ["pending", packageRef({ status: "pending" })],
    ["shared", packageRef()],
  ])("retains %s artifacts while releasing the Claw reference", async (scenario, ref) => {
    const other = packageRef({ agentId: "other" });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue(scenario === "shared" ? [ref, other] : [ref]),
        resolvePlugin: vi.fn(),
      },
    });
    expect(decisions).toMatchObject([{ action: "retain", reason: expect.any(String) }]);
  });

  it("does not inspect global plugin artifact state during removal planning", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn(),
      },
    });
    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason: "Referenced resources are retained unless a cleanup mode selects them.",
      },
    ]);
  });

  it("retains a same-version plugin whose installed integrity drifted", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub", integrity: "sha256:replacement" },
          installedVersion: "1.0.0",
        }),
      },
    });
    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason: "Referenced resources are retained unless a cleanup mode selects them.",
      },
    ]);
  });

  it("retains a plugin reinstalled directly after Claw provenance", async () => {
    const ref = packageRef({ updatedAtMs: 10 });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: {
            source: "clawhub",
            integrity: "sha256:audit",
            installedAt: new Date(20).toISOString(),
          },
          installedVersion: "1.0.0",
        }),
      },
    });

    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason: "Referenced resources are retained unless a cleanup mode selects them.",
      },
    ]);
  });

  it("treats equal skill refs in separate agent workspaces as separate artifacts", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage", relationship: "managed" });
    const other = packageRef({
      kind: "skill",
      ref: "triage",
      relationship: "managed",
      agentId: "other",
    });
    const skillPlan = {
      workspaceDir: install.workspace,
      slug: "triage",
      version: "1.0.0",
      installedAt: 1,
      targetDir: "/tmp/claw-workspace/skills/triage",
      skillFilePath: "SKILL.md",
      skillFileSha256: "abc",
    };
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        readInstallRecords: vi.fn().mockReturnValue([
          { ...install, agentId: "worker" },
          { ...install, agentId: "other", workspace: "/tmp/other-workspace" },
        ]),
        planSkill: vi.fn().mockResolvedValue({ ok: true, plan: skillPlan }),
      },
    });
    expect(decisions).toMatchObject([{ action: "uninstall", skillPlan }]);
  });

  it("retains a skill referenced by another Claw in the same workspace", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage", relationship: "managed" });
    const other = packageRef({
      kind: "skill",
      ref: "triage",
      relationship: "managed",
      agentId: "other",
    });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        readInstallRecords: vi.fn().mockReturnValue([
          { ...install, agentId: "worker" },
          { ...install, agentId: "other" },
        ]),
        planSkill: vi.fn(),
      },
    });

    expect(decisions).toMatchObject([
      { action: "retain", reason: "Another Claw still references this package." },
    ]);
  });

  it("retains an orphan skill when its workspace provenance is missing", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage", relationship: "managed" });
    const planSkill = vi.fn();
    const decisions = await planClawPackageRemovals({ ...install, workspace: "" }, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        planSkill,
      },
    });

    expect(decisions).toMatchObject([
      { action: "retain", reason: "Skill workspace provenance is missing." },
    ]);
    expect(planSkill).not.toHaveBeenCalled();
  });

  it("releases a global plugin reference while another Claw is also being removed", async () => {
    const ref = packageRef();
    const other = packageRef({ agentId: "other" });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        resolvePlugin: vi.fn(),
      },
    });
    let refs = [ref, other];
    const claimPackageRef = vi.fn((claimedRef: PersistedClawPackageRef) => {
      refs = refs.map((candidate) => ({
        ...candidate,
        status: "pending" as const,
      }));
      return { ...claimedRef, status: "pending" as const };
    });

    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
          readPackageRefs: vi.fn(() => refs),
          claimPackageRef,
        },
      }),
    ).resolves.toMatchObject([{ action: "retained" }]);
  });

  it("releases a reference whose independent ownership was derived from install time", async () => {
    const persisted = packageRef({ independentOwner: false });
    const derived = packageRef({ independentOwner: true });
    const store = packageRefStore(persisted);

    await expect(
      applyClawPackageRemovals(
        [
          {
            packageRef: derived,
            workspace: install.workspace,
            action: "retain",
            reason: "Package is independently owned outside this Claw.",
            affectedClawAgentIds: [],
          },
        ],
        { deps: store },
      ),
    ).resolves.toMatchObject([{ action: "retained" }]);
  });
});
