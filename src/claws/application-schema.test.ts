import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clawProfileExtensionPackages } from "./application-plan.js";
import { buildClawAddPlan, type ClawAddPlanContext } from "./lifecycle.js";
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
        agent: { tools: { profile: "coding", allow: ["read"] } },
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
  it("discloses model and delegation effects with nonblocking local availability notices", async () => {
    const { source, workspace } = await createPlanSource();
    const agent = {
      model: { primary: "acme/primary", fallbacks: ["acme/missing"] },
      subagents: { allowAgents: ["researcher", "writer"], delegationMode: "prefer" as const },
    };
    const params = {
      manifest: requireManifest({ schemaVersion: 1, agent: { id: "analyst" } }),
      openClawProfile: { schemaVersion: 1 as const, agent },
      source,
    };
    const context: ClawAddPlanContext = {
      workspace,
      existingAgentIds: ["researcher"],
      config: {
        models: {
          providers: {
            acme: {
              baseUrl: "https://models.example.test",
              models: [
                {
                  id: "primary",
                  name: "Primary",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    };
    const plan = await buildClawAddPlan({ ...params, context });
    expect(plan.agent.config).toMatchObject(agent);
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({ kind: "agent", effect: agent }),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.readiness).toEqual({ ready: true, requirements: [] });
    expect(plan.diagnostics).toMatchObject([
      {
        level: "warning",
        phase: "plan",
        code: "delegation_target_unresolved",
        path: "$.profiles.openclaw.agent.subagents.allowAgents[1]",
      },
      {
        level: "warning",
        phase: "plan",
        code: "model_not_in_catalog",
        path: "$.profiles.openclaw.agent.model.fallbacks[0]",
      },
    ]);
    const unavailable = await buildClawAddPlan({ ...params, context: { workspace } });
    expect(unavailable.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "model_not_in_catalog",
        path: "$.profiles.openclaw.agent.model.primary",
      }),
    );
    expect(unavailable.blockers).toEqual([]);
    expect(unavailable.planIntegrity).not.toBe(plan.planIntegrity);
  });

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

describe("parseClawOpenClawProfile model and delegation", () => {
  it.each([
    {
      model: { primary: "acme/model", fallbacks: ["acme/team/fallback"] },
      subagents: { allowAgents: ["researcher", "writer_2"], delegationMode: "prefer" },
    },
    {
      model: { primary: "acme/model", fallbacks: [] },
      subagents: { allowAgents: [], delegationMode: "suggest" },
    },
    { model: { primary: "acme/model" }, subagents: {} },
  ])("preserves declared selections: %j", (agent) => {
    expect(parseClawOpenClawProfile({ schemaVersion: 1, agent })).toMatchObject({
      ok: true,
      profile: { agent },
    });
  });

  it.each([
    { model: {} },
    { model: "acme/model" },
    { model: { primary: "model" } },
    { model: { primary: "/model" } },
    { model: { primary: "acme/" } },
    { model: { primary: "acme/has space" } },
    { model: { primary: "acme/model", fallbacks: [""] } },
    { model: { primary: "acme/model", fallbacks: ["invalid"] } },
    { model: { primary: "acme/model", extra: true } },
    { subagents: { delegationMode: "required" } },
    { subagents: { allowAgents: ["Invalid"] } },
    { subagents: { allowAgents: ["*"] } },
    { subagents: { allowAgents: [""] } },
    { subagents: { extra: true } },
  ])("rejects invalid profile selections: %j", (agent) => {
    expect(parseClawOpenClawProfile({ schemaVersion: 1, agent }).ok).toBe(false);
  });
});
