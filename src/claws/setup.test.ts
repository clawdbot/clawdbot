import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";
import { buildClawSetupPlan } from "./setup.js";
import { MAX_CLAW_SETUP_SEEDS } from "./source-limits.js";
import type { ClawManifestV2, ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function manifest(overrides: Partial<ClawManifestV2> = {}): ClawManifestV2 {
  const parsed = parseClawManifest({
    schemaVersion: 2,
    agent: { id: "executive-assistant" },
    setup: {
      inputs: [
        {
          id: "principal_name",
          label: "Your name",
          type: "string",
          required: true,
          maxLength: 120,
        },
        {
          id: "timezone",
          label: "Timezone",
          type: "string",
          format: "timezone",
          required: true,
        },
        {
          id: "priorities",
          label: "Priorities",
          type: "multiChoice",
          options: [
            { value: "focus", label: "Focus time" },
            { value: "follow_up", label: "Follow-up" },
          ],
          maxItems: 2,
        },
      ],
    },
    personalization: {
      seeds: [{ source: "setup/USER.md.tmpl", destination: "USER.md" }],
    },
    ...overrides,
  });
  if (!parsed.ok || parsed.manifest.schemaVersion !== 2) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  return parsed.manifest;
}

async function packageRoot(): Promise<string> {
  const root = tempDirs.make("openclaw-claw-setup-");
  await mkdir(join(root, "setup"));
  await writeFile(
    join(root, "setup", "USER.md.tmpl"),
    [
      "# User",
      "",
      "Name: {{ input.principal_name }}",
      "Timezone: {{ input.timezone }}",
      "Priorities:",
      "{{ input.priorities }}",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function source(root: string): ClawSourceIdentity {
  return {
    kind: "development",
    name: "local:executive-assistant",
    version: "0.0.0-development",
    packageRoot: root,
    manifestPath: join(root, "CLAW.md"),
    integrityKind: "development-snapshot",
    integrity: "sha256:test",
    byteLength: 0,
  };
}

describe("Claw setup schema version 2", () => {
  it("keeps version 1 strict and defaults optional version 2 groups", () => {
    expect(
      parseClawManifest({
        schemaVersion: 1,
        agent: { id: "legacy" },
        setup: { inputs: [] },
      }).ok,
    ).toBe(false);

    const parsed = parseClawManifest({ schemaVersion: 2, agent: { id: "personalized" } });
    expect(parsed).toMatchObject({
      ok: true,
      manifest: {
        schemaVersion: 2,
        setup: { inputs: [] },
        personalization: { seeds: [] },
      },
    });
  });

  it("bounds personalization seed count", () => {
    const parsed = parseClawManifest({
      schemaVersion: 2,
      agent: { id: "bounded-seeds" },
      personalization: {
        seeds: Array.from({ length: MAX_CLAW_SETUP_SEEDS + 1 }, (_, index) => ({
          source: `setup/seed-${index}.tmpl`,
          destination: `USER-${index}.md`,
        })),
      },
    });
    expect(parsed).toMatchObject({ ok: false });
  });

  it("rejects root BOOTSTRAP.md and cross-owned destination collisions", () => {
    const bootstrap = parseClawManifest({
      schemaVersion: 2,
      agent: { id: "bootstrap-owner" },
      workspace: { files: [{ source: "workspace/BOOTSTRAP.md", path: "BOOTSTRAP.md" }] },
    });
    expect(bootstrap).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ path: "$.workspace.files[0].path" })],
    });

    const bootstrapGroup = parseClawManifest({
      schemaVersion: 2,
      agent: { id: "bootstrap-group-owner" },
      workspace: {
        bootstrapFiles: { "BOOTSTRAP.md": { source: "workspace/BOOTSTRAP.md" } },
      },
    });
    expect(bootstrapGroup).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ path: "$.workspace.bootstrapFiles" })],
    });

    const collision = parseClawManifest({
      schemaVersion: 2,
      agent: { id: "collision" },
      workspace: { files: [{ source: "workspace/USER.md", path: "USER.md" }] },
      personalization: {
        seeds: [{ source: "setup/USER.md.tmpl", destination: "USER.md" }],
      },
    });
    expect(collision).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ path: "$.personalization.seeds[0].destination" })],
    });
  });

  it("rejects duplicate inputs and invalid defaults", () => {
    const parsed = parseClawManifest({
      schemaVersion: 2,
      agent: { id: "invalid-inputs" },
      setup: {
        inputs: [
          {
            id: "timezone",
            label: "Timezone",
            type: "string",
            format: "timezone",
            default: "not/a-zone",
          },
          { id: "timezone", label: "Again", type: "boolean" },
        ],
      },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.setup.inputs[0].default" }),
        expect.objectContaining({ path: "$.setup.inputs[1].id" }),
      ]),
    );
  });
});

describe("Claw setup templates and plans", () => {
  it("snapshots valid templates and rejects unused or unknown inputs", async () => {
    const root = await packageRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/executive-assistant",
        version: "1.0.0",
        openclaw: { claw: "openclaw.claw.json" },
      }),
      "utf8",
    );
    await writeFile(join(root, "openclaw.claw.json"), JSON.stringify(manifest()), "utf8");

    const read = await readClawManifestFile(root);
    expect(read).toMatchObject({
      ok: true,
      snapshot: {
        setupTemplates: [
          {
            sourcePath: "setup/USER.md.tmpl",
            inputIds: ["principal_name", "timezone", "priorities"],
            digest: expect.stringMatching(/^sha256:/),
          },
        ],
      },
    });

    await writeFile(join(root, "setup", "USER.md.tmpl"), "Name: {{ input.unknown }}\n", "utf8");
    const invalid = await readClawManifestFile(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "setup_template_unknown_input" })]),
    );
  });

  it("binds development integrity to exact setup template bytes", async () => {
    const root = await packageRoot();
    const manifestPath = join(root, "openclaw.claw.json");
    const templatePath = join(root, "setup", "USER.md.tmpl");
    await writeFile(manifestPath, JSON.stringify(manifest()), "utf8");

    const withoutBom = await readClawManifestFile(manifestPath);
    await writeFile(
      templatePath,
      "\uFEFF# User\n\nName: {{ input.principal_name }}\nTimezone: {{ input.timezone }}\nPriorities:\n{{ input.priorities }}\n",
      "utf8",
    );
    const withBom = await readClawManifestFile(manifestPath);

    expect(withoutBom.ok).toBe(true);
    expect(withBom.ok).toBe(true);
    if (!withoutBom.ok || !withBom.ok) {
      throw new Error("expected both byte variants to parse");
    }
    expect(withBom.source.integrity).not.toBe(withoutBom.source.integrity);
    expect(withBom.snapshot.setupTemplates[0]?.digest).not.toBe(
      withoutBom.snapshot.setupTemplates[0]?.digest,
    );
  });

  it("returns field diagnostics without exposing answer values", async () => {
    const root = await packageRoot();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source: source(root),
      context: { workspace: join(root, "workspace") },
      answers: { principal_name: "Gio", timezone: "invalid-zone" },
    });

    expect(plan.setup).toMatchObject({
      valid: false,
      providedInputIds: ["principal_name", "timezone"],
      missingOptionalInputIds: ["priorities"],
      diagnostics: [expect.objectContaining({ path: "$.answers.timezone" })],
      seeds: [{ destination: "USER.md", blocked: true }],
    });
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "setup_answer_invalid", path: "$.answers.timezone" }),
    );
    expect(JSON.stringify(plan.setup)).not.toContain("Gio");
  });

  it("renders deterministic Markdown-safe seed bytes and binds answers", async () => {
    const root = await packageRoot();
    const claw = manifest();
    const first = await buildClawSetupPlan({
      manifest: claw,
      packageRoot: root,
      answers: {
        principal_name: "Gio *admin*",
        timezone: "America/Los_Angeles",
        priorities: ["focus", "follow_up"],
      },
    });
    const repeated = await buildClawSetupPlan({
      manifest: claw,
      packageRoot: root,
      answers: {
        principal_name: "Gio *admin*",
        timezone: "America/Los_Angeles",
        priorities: ["focus", "follow_up"],
      },
    });
    const changed = await buildClawSetupPlan({
      manifest: claw,
      packageRoot: root,
      answers: {
        principal_name: "Omar",
        timezone: "America/Los_Angeles",
        priorities: ["focus"],
      },
    });

    expect(first.plan.valid).toBe(true);
    expect(first.materialization?.seeds[0]?.content.toString("utf8")).toContain("Gio \\*admin\\*");
    expect(first.materialization?.seeds[0]?.content.toString("utf8")).toContain(
      "- focus\n- follow\\_up",
    );
    expect(repeated.plan.answerDigest).toBe(first.plan.answerDigest);
    expect(repeated.plan.seeds[0]?.digest).toBe(first.plan.seeds[0]?.digest);
    expect(changed.plan.answerDigest).not.toBe(first.plan.answerDigest);
    expect(changed.plan.seeds[0]?.digest).not.toBe(first.plan.seeds[0]?.digest);
  });

  it("requires the validated setup materialization before version 2 mutation", async () => {
    const root = await packageRoot();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source: source(root),
      context: { workspace: join(root, "workspace") },
      answers: { principal_name: "Gio", timezone: "UTC" },
    });
    const seed = plan.actions.find((action) => action.sourceKind === "personalizationSeed");
    expect(plan.blockers).toEqual([]);
    expect(seed).toMatchObject({
      kind: "workspaceFile",
      id: "USER.md",
      blocked: false,
      digest: expect.stringMatching(/^sha256:/),
      details: { expectedState: "absent", ownershipAfterCreate: "user" },
    });

    const persistRecord = vi.fn();
    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        persistRecord,
      }),
    ).rejects.toMatchObject({
      code: "setup_materialization_required",
    });
    expect(persistRecord).not.toHaveBeenCalled();
  });
});
