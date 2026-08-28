import { link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("CLAW.md prompt bodies", () => {
  it("preserves non-ASCII UTF-8 frontmatter values", async () => {
    const root = tempDirs.make("openclaw-claw-markdown-unicode-");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      manifestPath,
      "---\nschemaVersion: 1\nagent: { id: cafe, name: Café }\n---\nPortable soul\n",
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.agent.name).toBe("Café");
    }
  });

  it.each([
    ["nested", "SOUL.md/child"],
    ["case-folded nested", "soul.MD/child"],
    ["Unicode-normalized nested", "SOUL.md/cafe\u0301"],
  ])("rejects a body with a %s workspace collision", async (_label, destination) => {
    const root = tempDirs.make("openclaw-claw-markdown-soul-hierarchy-");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      manifestPath,
      [
        "---",
        "schemaVersion: 1",
        "agent: { id: triage }",
        "workspace:",
        "  files:",
        `    - { source: package.json, path: ${JSON.stringify(destination)} }`,
        "---",
        "Portable soul",
      ].join("\n"),
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "claw_body_soul_conflict" }),
    );
  });

  it("blocks a direct add plan when implicit SOUL.md owns an ancestor path", async () => {
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "triage" },
      workspace: { files: [{ source: "package.json", path: "SOUL.md/child" }] },
    });
    if (!parsed.ok) {
      throw new Error("expected fixture manifest to parse");
    }
    const root = tempDirs.make("openclaw-claw-markdown-soul-direct-plan-");
    await writeFile(join(root, "package.json"), "{}", "utf8");
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      clawMarkdownBody: Buffer.from("Portable soul"),
      source: {
        kind: "development",
        name: "local:triage",
        version: "0.0.0-development",
        packageRoot: root,
        manifestPath: join(root, "CLAW.md"),
        integrityKind: "development-snapshot",
        integrity: "sha256:fixture",
        byteLength: 1,
      },
      context: { workspace: join(root, "workspace") },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "claw_body_soul_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "SOUL.md", sourceKind: "clawMarkdownBody", blocked: true }),
    );
    expect(JSON.stringify(plan)).not.toContain("Portable soul");
  });

  it("rejects a hardlinked CLAW.md before planning", async () => {
    const root = tempDirs.make("openclaw-claw-markdown-hardlink-");
    const original = join(root, "original.md");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      original,
      "---\nschemaVersion: 1\nagent: { id: triage }\n---\nPortable soul\n",
      "utf8",
    );
    await link(original, manifestPath);

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "read_failed" }));
  });
});
