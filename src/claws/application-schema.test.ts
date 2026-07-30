import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clawProfileExtensionPackages } from "./application-plan.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
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
  await mkdir(join(root, "workspace", "reference"), { recursive: true });
  await writeFile(join(root, "workspace", "reference", "policy.md"), "Policy\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/github-triage",
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
  id: "github",
  kind: "plugin",
  format: "claude",
  source: "clawhub",
  ref: "@acme/github",
  version: "2.0.1",
} as const;

describe("Claw application schema", () => {
  it("keeps version 2 packages portable and accepts descriptive resource roles", () => {
    const result = parseClawManifest({
      schemaVersion: 2,
      agent: { id: "market-analyst" },
      workspace: {
        files: [
          {
            source: "schemas/market.openapi.yml",
            path: "reference/market.openapi.yml",
            role: "schema",
          },
        ],
      },
      packages: [{ kind: "skill", source: "clawhub", ref: "@acme/market", version: "1.0.0" }],
    });

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        workspace: { files: [{ role: "schema" }] },
        packages: [{ kind: "skill" }],
      },
    });
  });

  it("rejects version 2 plugin packages and unknown resource roles", () => {
    const base = { schemaVersion: 2, agent: { id: "market-analyst" } };
    expect(
      parseClawManifest({
        ...base,
        packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/market", version: "1.0.0" }],
      }).ok,
    ).toBe(false);
    expect(
      parseClawManifest({
        ...base,
        workspace: {
          files: [{ source: "data.txt", path: "data.txt", role: "executable" }],
        },
      }).ok,
    ).toBe(false);
  });

  it("accepts strict version 2 extension assertions", () => {
    expect(
      parseClawOpenClawProfile({
        schemaVersion: 2,
        agent: { tools: { profile: "coding" } },
        extensions: [extension],
      }),
    ).toMatchObject({
      ok: true,
      profile: {
        schemaVersion: 2,
        extensions: [{ id: "github", format: "claude" }],
      },
    });
  });

  it("rejects duplicate extensions and unknown formats", () => {
    expect(
      parseClawOpenClawProfile({
        schemaVersion: 2,
        agent: {},
        extensions: [extension, extension],
      }).ok,
    ).toBe(false);
    expect(
      parseClawOpenClawProfile({
        schemaVersion: 2,
        agent: {},
        extensions: [{ ...extension, format: "future" }],
      }).ok,
    ).toBe(false);
  });

  it("requires Claw schema version 2 before using an OpenClaw version 2 profile", async () => {
    const root = tempDirs.make("openclaw-claw-application-profile-version-");
    await mkdir(join(root, "profiles"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/application",
        version: "1.0.0",
        openclaw: { claw: "CLAW.md" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "CLAW.md"),
      [
        "---",
        "schemaVersion: 1",
        "agent:",
        "  id: application",
        "metadata:",
        "  openclaw.config: profiles/openclaw.yml",
        "---",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 2\nagent: {}\nextensions: []\n",
      "utf8",
    );

    const result = await readClawManifestFile(root);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "openclaw_profile_version_mismatch" })],
    });
  });
});

describe("Claw application planning", () => {
  it("projects profile extensions onto canonical plugin package identities", () => {
    expect(
      clawProfileExtensionPackages({ schemaVersion: 2, agent: {}, extensions: [extension] }),
    ).toEqual([
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/github",
        version: "2.0.1",
      },
    ]);
    expect(clawProfileExtensionPackages({ schemaVersion: 1, agent: {} })).toEqual([]);
  });

  it("plans profile extensions and carries application resource roles", async () => {
    const { source, workspace } = await createPlanSource();
    const manifest = requireManifest({
      schemaVersion: 2,
      agent: { id: "github-triage" },
      workspace: {
        files: [
          {
            source: "workspace/reference/policy.md",
            path: "reference/policy.md",
            role: "reference",
          },
        ],
      },
    });
    const plan = await buildClawAddPlan({
      manifest,
      openClawProfile: { schemaVersion: 2, agent: {}, extensions: [extension] },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "github",
          detectedFormat: "claude",
          mapped: ["commands", "skills"],
          unavailable: ["agents"],
          adapterIdentity: "openclaw/test",
          requirements: [{ kind: "environment", mcpServer: "github", name: "GITHUB_TOKEN" }],
        }),
      },
    });

    expect(plan.extensions).toEqual([
      expect.objectContaining({
        id: "github",
        detectedFormat: "claude",
        mapped: ["commands", "skills"],
        unavailable: ["agents"],
        blocked: false,
      }),
    ]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        id: "plugin:@acme/github",
        blocked: false,
        details: expect.objectContaining({
          prerequisites: [{ kind: "environment", mcpServer: "github", name: "GITHUB_TOKEN" }],
          extension: expect.objectContaining({
            id: "github",
            detectedFormat: "claude",
            mapped: ["commands", "skills"],
          }),
        }),
      }),
    );
    expect(plan.readiness).toEqual({
      ready: false,
      requirements: [{ kind: "environment", mcpServer: "github", name: "GITHUB_TOKEN" }],
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "reference/policy.md",
        details: expect.objectContaining({ role: "reference" }),
      }),
    );
  });

  it("blocks an extension whose declared format differs from canonical detection", async () => {
    const { source, workspace } = await createPlanSource();
    const manifest = requireManifest({ schemaVersion: 2, agent: { id: "github-triage" } });
    const plan = await buildClawAddPlan({
      manifest,
      openClawProfile: {
        schemaVersion: 2,
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
          installId: "github",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
          adapterIdentity: "openclaw/test",
        }),
      },
    });

    expect(plan.extensions[0]?.blocked).toBe(true);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "extension_format_mismatch" }),
    );
  });

  it("blocks successful extension preflight without complete adapter provenance", async () => {
    const { source, workspace } = await createPlanSource();
    const manifest = requireManifest({ schemaVersion: 2, agent: { id: "github-triage" } });
    const plan = await buildClawAddPlan({
      manifest,
      openClawProfile: { schemaVersion: 2, agent: {}, extensions: [extension] },
      source,
      context: {
        workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"b".repeat(64)}`,
          installId: "github",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
        }),
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "extension_provenance_incomplete" }),
    );
    expect(plan.extensions[0]?.blocked).toBe(true);
  });
});
