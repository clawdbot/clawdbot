import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clawProfileExtensionPackages } from "./application-plan.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest, parseClawOpenClawProfile } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireManifest(value: unknown): ClawManifest {
  const result = parseClawManifest(value);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.manifest;
}

async function createPlanSource(): Promise<{ source: ClawSourceIdentity; workspace: string }> {
  const root = tempDirs.make("openclaw-claw-application-plan-");
  await mkdir(join(root, "workspace", "schemas"), { recursive: true });
  await writeFile(join(root, "workspace", "schemas", "market.json"), "{}\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/market-analyst",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "CLAW.md"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    workspace: join(await realpath(root), "new-workspace"),
  };
}

const extension = {
  id: "market-data",
  kind: "plugin",
  format: "claude",
  source: "clawhub",
  ref: "@acme/market-data",
  version: "2.0.1",
} as const;

describe("Claw application schema v1", () => {
  it("accepts strict native extension assertions without a schema bump", () => {
    expect(
      parseClawOpenClawProfile({
        schemaVersion: 1,
        agent: { tools: { profile: "coding" } },
        extensions: [extension],
      }),
    ).toMatchObject({
      ok: true,
      profile: { schemaVersion: 1, extensions: [{ id: "market-data", format: "claude" }] },
    });
  });

  it("rejects duplicate extensions and unknown formats", () => {
    expect(
      parseClawOpenClawProfile({ schemaVersion: 1, agent: {}, extensions: [extension, extension] })
        .ok,
    ).toBe(false);
    expect(
      parseClawOpenClawProfile({
        schemaVersion: 1,
        agent: {},
        extensions: [{ ...extension, format: "future" }],
      }).ok,
    ).toBe(false);
  });
});

describe("Claw application planning v1", () => {
  it("projects profile extensions onto canonical plugin package identities", () => {
    expect(
      clawProfileExtensionPackages({ schemaVersion: 1, agent: {}, extensions: [extension] }),
    ).toEqual([
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/market-data",
        version: "2.0.1",
      },
    ]);
    expect(clawProfileExtensionPackages(undefined)).toEqual([]);
  });

  it("plans a canonical extension and an ordinary managed schema asset", async () => {
    const { source, workspace } = await createPlanSource();
    const manifest = requireManifest({
      schemaVersion: 1,
      agent: { id: "market-analyst" },
      workspace: {
        files: [{ source: "workspace/schemas/market.json", path: "schemas/market.json" }],
      },
    });
    const plan = await buildClawAddPlan({
      manifest,
      openClawProfile: { schemaVersion: 1, agent: {}, extensions: [extension] },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "market-data",
          detectedFormat: "claude",
          mapped: ["commands", "skills"],
          unavailable: ["agents"],
          adapterIdentity: "openclaw/test",
        }),
      },
    });

    expect(plan.extensions).toEqual([
      expect.objectContaining({
        id: "market-data",
        detectedFormat: "claude",
        mapped: ["commands", "skills"],
        unavailable: ["agents"],
        requirementState: "missing-installable",
        blocked: false,
      }),
    ]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        id: "plugin:@acme/market-data",
        blocked: false,
        details: expect.objectContaining({
          extension: expect.objectContaining({
            id: "market-data",
            adapterIdentity: "openclaw/test",
          }),
        }),
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "schemas/market.json" }),
    );
  });

  it("reports a reused extension with remaining local setup as setup-required", async () => {
    const { source, workspace } = await createPlanSource();
    const prerequisite = {
      kind: "plugin-setup" as const,
      plugin: "market-data",
      provider: "market-data",
      envVars: ["MARKET_DATA_TOKEN"],
      authMethods: [],
    };
    const plan = await buildClawAddPlan({
      manifest: requireManifest({ schemaVersion: 1, agent: { id: "market-analyst" } }),
      openClawProfile: { schemaVersion: 1, agent: {}, extensions: [extension] },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "reuse",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "market-data",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
          adapterIdentity: "openclaw/test",
          requirements: [prerequisite],
        }),
      },
    });

    expect(plan.extensions?.[0]).toMatchObject({
      requirementState: "setup-required",
      ownerAction: "reuse",
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        action: "reuse",
        details: expect.objectContaining({ requirementState: "setup-required" }),
      }),
    );
    expect(plan.readiness).toEqual({ ready: false, requirements: [prerequisite] });
  });

  it("blocks incomplete adapter provenance", async () => {
    const { source, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest({ schemaVersion: 1, agent: { id: "market-analyst" } }),
      openClawProfile: { schemaVersion: 1, agent: {}, extensions: [extension] },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "market-data",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
        }),
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "extension_provenance_incomplete" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "plugin:@acme/market-data", blocked: true }),
    );
  });

  it("blocks duplicate portable and profile package declarations", async () => {
    const { source, workspace } = await createPlanSource();
    const manifest = requireManifest({
      schemaVersion: 1,
      agent: { id: "market-analyst" },
      packages: [
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@acme/market-data",
          version: "2.0.1",
        },
      ],
    });
    const plan = await buildClawAddPlan({
      manifest,
      openClawProfile: { schemaVersion: 1, agent: {}, extensions: [extension] },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "market-data",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
          adapterIdentity: "openclaw/test",
        }),
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "extension_package_collision" }),
    );
    expect(plan.actions.filter((action) => action.id === "plugin:@acme/market-data")).toHaveLength(
      1,
    );
  });

  it("blocks a declared format that differs from canonical detection", async () => {
    const { source, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest({ schemaVersion: 1, agent: { id: "market-analyst" } }),
      openClawProfile: {
        schemaVersion: 1,
        agent: {},
        extensions: [{ ...extension, format: "codex" }],
      },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "market-data",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
          adapterIdentity: "openclaw/test",
        }),
      },
    });

    expect(plan.extensions?.[0]?.blocked).toBe(true);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "extension_format_mismatch",
        path: "$.profiles.openclaw.extensions[0].format",
      }),
    );
  });
});
