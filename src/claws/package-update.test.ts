import { describe, expect, it, vi } from "vitest";
import { digestClawPackageRef } from "./package-update-provenance.js";
import { applyClawPackageUpdate } from "./package-update.js";
import { installClawPackages } from "./packages.js";
import { CLAW_PACKAGE_REF_SCHEMA_VERSION, type PersistedClawPackageRef } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan, type ClawManifest } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

function ref(kind: "skill" | "plugin", name: string, version: string): PersistedClawPackageRef {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: "worker",
    clawName: "@acme/worker",
    kind,
    source: "clawhub",
    ref: name,
    version,
    integrity: `sha256:${name}-${version}`,
    status: "complete",
    relationship: kind === "skill" ? "managed" : "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 10,
    updatedAtMs: 10,
  };
}

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:new" },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: actions.filter((action) => action.action === "change").length,
      removed: actions.filter((action) => action.action === "remove").length,
      released: actions.filter((action) => action.action === "release").length,
      unchanged: 0,
      manual: 0,
      blocked: 0,
      capabilityChanges: 0,
      capabilityEscalations: 0,
    },
    actions,
    capabilityChanges: [],
    blockers: [],
    diagnostics: [],
  };
}

const manifest: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "worker" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [
    {
      kind: "skill",
      source: "clawhub",
      ref: "triage",
      version: "2.0.0",
    },
    {
      kind: "plugin",
      source: "clawhub",
      ref: "audit",
      version: "1.0.0",
    },
  ],
  mcpServers: {},
  cronJobs: [],
};

const addPlan: ClawAddPlan = {
  schemaVersion: "openclaw.clawAddPlan.v1",
  stability: CLAW_OUTPUT_STABILITY,
  dryRun: true,
  mutationAllowed: false,
  manifestSchemaVersion: 1,
  planIntegrity: "sha256:add-plan",
  claw: {
    kind: "package",
    name: "@acme/worker",
    version: "2.0.0",
    packageRoot: "/tmp/claw",
    manifestPath: "/tmp/claw/openclaw.claw.json",
    integrityKind: "artifact",
    integrity: "sha256:new",
    byteLength: 1,
  },
  agent: {
    requestedId: "worker",
    finalId: "worker",
    workspace: "/tmp/worker",
    config: { id: "worker", workspace: "/tmp/worker" },
  },
  summary: {
    totalActions: 2,
    agentActions: 0,
    workspaceActions: 0,
    packageActions: 2,
    mcpServerActions: 0,
    cronJobActions: 0,
    blockedActions: 0,
    capabilityEscalations: 0,
  },
  actions: manifest.packages.map((pkg) => ({
    kind: "package",
    id: `${pkg.kind}:${pkg.ref}`,
    action: "install",
    target: `clawhub:${pkg.ref}@${pkg.version}`,
    details: {
      ...pkg,
      integrity: `sha256:${pkg.ref}-${pkg.version}`,
      ownerAction: "install",
      ...(pkg.kind === "plugin" ? { installId: pkg.ref } : {}),
    },
    blocked: false,
  })),
  capabilityChanges: [],
  blockers: [],
  diagnostics: [],
  readiness: { ready: true, requirements: [] },
};

describe("applyClawPackageUpdate", () => {
  it("updates exact references but reports retained artifacts on rollback", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const legacy = ref("plugin", "legacy", "1.0.0");
    const installPackages = vi.fn(
      async (current: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        const details = current.actions[0]?.details as {
          kind: "skill" | "plugin";
          ref: string;
          version: string;
          integrity: string;
        };
        options?.onExternalMutation?.({ ...details, source: "clawhub" });
        return [ref(details.kind, details.ref, details.version)];
      },
    );
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "skill:triage",
          action: "change",
          target: "clawhub:triage@2.0.0",
          blocked: false,
          reason: "changed",
          currentDigest: digestClawPackageRef(oldSkill),
        },
        {
          kind: "package",
          id: "plugin:audit",
          action: "add",
          target: "clawhub:audit@1.0.0",
          blocked: false,
          reason: "added",
        },
        {
          kind: "package",
          id: "plugin:legacy",
          action: "release",
          target: "clawhub:legacy@1.0.0",
          blocked: false,
          reason: "removed",
          currentDigest: digestClawPackageRef(legacy),
        },
      ]),
      manifest,
      addPlan,
      {
        installPackages,
        readRefs: () => [oldSkill, legacy],
        replaceExpected,
      },
    );

    expect(execution.appliedIds).toEqual(["skill:triage", "plugin:audit", "plugin:legacy"]);
    expect(installPackages).toHaveBeenCalledTimes(2);
    expect(replaceExpected).toHaveBeenCalledWith(
      oldSkill,
      expect.objectContaining({ version: "2.0.0", status: "pending" }),
      expect.any(Object),
    );
    expect(replaceExpected).toHaveBeenCalledWith(legacy, undefined, expect.any(Object));

    await expect(execution.rollback()).rejects.toMatchObject({ partial: true });
    expect(replaceExpected).toHaveBeenCalledWith(undefined, legacy, expect.any(Object));
    expect(replaceExpected).toHaveBeenCalledWith(
      expect.objectContaining({ version: "2.0.0", status: "complete" }),
      oldSkill,
      expect.any(Object),
    );
  });

  it("reverses reference-only removal without uninstalling or reporting partial state", async () => {
    const legacy = ref("plugin", "legacy", "1.0.0");
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "plugin:legacy",
          action: "release",
          target: "clawhub:legacy@1.0.0",
          blocked: false,
          reason: "removed",
          currentDigest: digestClawPackageRef(legacy),
        },
      ]),
      { ...manifest, packages: [] },
      { ...addPlan, actions: [] },
      { readRefs: () => [legacy], replaceExpected },
    );

    await expect(execution.rollback()).resolves.toBeUndefined();
    expect(replaceExpected).toHaveBeenNthCalledWith(1, legacy, undefined, expect.any(Object));
    expect(replaceExpected).toHaveBeenNthCalledWith(2, undefined, legacy, expect.any(Object));
  });

  it("releases managed package provenance without uninstalling the artifact", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "skill:triage",
          action: "remove",
          target: "clawhub:triage@1.0.0",
          blocked: false,
          reason: "removed",
          currentDigest: digestClawPackageRef(oldSkill),
        },
      ]),
      { ...manifest, packages: [] },
      { ...addPlan, actions: [] },
      {
        readRefs: () => [oldSkill],
        replaceExpected,
      },
    );

    expect(replaceExpected).toHaveBeenCalledWith(oldSkill, undefined, expect.any(Object));
    await expect(execution.rollback()).resolves.toBeUndefined();
    expect(replaceExpected).toHaveBeenCalledWith(undefined, oldSkill, expect.any(Object));
  });

  it("does not replace a shared plugin pinned by another Claw", async () => {
    const installPackages = vi.fn();
    const otherOwner = { ...ref("plugin", "audit", "0.9.0"), agentId: "other" };
    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:audit",
            action: "add",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest,
        addPlan,
        {
          installPackages,
          readRefs: (options) => (options?.agentId ? [] : [otherOwner]),
        },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installPackages).not.toHaveBeenCalled();
  });

  it("rejects release when package provenance changed after planning", async () => {
    const planned = ref("plugin", "legacy", "1.0.0");
    const observed = { ...planned, independentOwner: true };
    const replaceExpected = vi.fn();

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:legacy",
            action: "release",
            target: "clawhub:legacy@1.0.0",
            blocked: false,
            reason: "released",
            currentDigest: digestClawPackageRef(planned),
          },
        ]),
        { ...manifest, packages: [] },
        { ...addPlan, actions: [] },
        { readRefs: () => [observed], replaceExpected },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(replaceExpected).not.toHaveBeenCalled();
  });

  it("allows only the expected prior version conflict for an owned plugin upgrade", async () => {
    const previous = ref("plugin", "audit", "0.9.0");
    const preflightPlugin = vi.fn(async () => ({
      ok: false as const,
      code: "plugin_version_conflict" as const,
      request: {} as never,
      installedVersion: "0.9.0",
      expectedVersion: "1.0.0",
    }));
    const installPackages = vi.fn(
      async (_plan: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        expect(options).toBeDefined();
        const preflight = await options!.deps?.preflightPlugin?.({
          clawhubPackage: "audit",
          rawSpec: "clawhub:audit@1.0.0",
          expectedVersion: "1.0.0",
        });
        expect(preflight).toMatchObject({ ok: true, action: "install" });
        return [ref("plugin", "audit", "1.0.0")];
      },
    );

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:audit",
            action: "change",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "owned upgrade",
          },
        ]),
        manifest,
        addPlan,
        {
          installPackages,
          readRefs: () => [previous],
          replaceExpected: vi.fn(),
          packageDeps: { preflightPlugin },
        },
      ),
    ).resolves.toMatchObject({ appliedIds: ["plugin:audit"] });
  });

  it("rejects an owned plugin upgrade when another owner appears before install", async () => {
    const previous = ref("plugin", "audit", "0.9.0");
    const other = { ...previous, agentId: "other" };
    const preflightPlugin = vi.fn(async () => ({
      ok: false as const,
      code: "plugin_version_conflict" as const,
      request: {} as never,
      installedVersion: "0.9.0",
      expectedVersion: "1.0.0",
    }));
    const installPackages = vi.fn(
      async (_plan: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        expect(options).toBeDefined();
        const preflight = await options!.deps?.preflightPlugin?.({
          clawhubPackage: "audit",
          rawSpec: "clawhub:audit@1.0.0",
          expectedVersion: "1.0.0",
        });
        if (!preflight?.ok) {
          throw new Error("plugin version conflict");
        }
        return [ref("plugin", "audit", "1.0.0")];
      },
    );
    let reads = 0;
    const readRefs = vi.fn((options?: { agentId?: string }) => {
      reads += 1;
      if (options?.agentId) {
        return [previous];
      }
      return reads >= 3 ? [previous, other] : [previous];
    });

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:audit",
            action: "change",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "owned upgrade",
          },
        ]),
        manifest,
        addPlan,
        {
          installPackages,
          readRefs,
          replaceExpected: vi.fn(),
          packageDeps: { preflightPlugin },
        },
      ),
    ).rejects.toMatchObject({ partial: false });
  });

  it("does not invoke an installer when package ownership changes after planning", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const installPackages = vi.fn();
    const replaceExpected = vi.fn(() => {
      throw new Error('Package reference "skill:triage" changed after planning.');
    });

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "skill:triage",
            action: "change",
            target: "clawhub:triage@2.0.0",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest,
        addPlan,
        { installPackages, readRefs: () => [oldSkill], replaceExpected },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installPackages).not.toHaveBeenCalled();
  });
});
