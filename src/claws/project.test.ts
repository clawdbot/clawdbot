import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawProject } from "./project-build.js";
import { ClawProjectError, createClawProject, validateClawProject } from "./project.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeRichProject(root: string): Promise<void> {
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "profiles"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "demo-claw",
      version: "1.2.3",
      openclaw: { claw: "CLAW.md" },
    })}\n`,
  );
  await writeFile(
    join(root, "CLAW.md"),
    [
      "---",
      "schemaVersion: 1",
      "agent:",
      "  id: demo-claw",
      "workspace:",
      "  files:",
      "    - source: workspace/reference.md",
      "      path: reference.md",
      "---",
      "You are the demo Claw.",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "workspace", "reference.md"), "# Reference\n");
  await writeFile(join(root, "BOOTSTRAP.md"), "Interview the user before starting.\n");
  await writeFile(join(root, "profiles", "openclaw.yml"), "schemaVersion: 1\nagent: {}\n");
  await writeFile(join(root, "not-packed.txt"), "local scratch\n");
}

describe("Claw projects", () => {
  it("matches the cross-platform golden artifact digest", async () => {
    const output = join(tempDirs.make("openclaw-claw-golden-"), "golden.tgz");

    const result = await buildClawProject(
      join(process.cwd(), "test", "fixtures", "claws", "project-v1"),
      output,
    );

    expect(result.integrity).toBe(
      "sha256:f7377ae66679a8d1088ac2d259b8567d19f584dbc4357949d3d4e0cc09d05874",
    );
  });

  it("creates a minimal project that validates through the canonical reader", async () => {
    const root = join(tempDirs.make("openclaw-claw-create-"), "research-assistant");

    const created = await createClawProject(root);
    const validated = await validateClawProject(root);

    expect(created.packageJson).toEqual({
      name: "research-assistant",
      version: "0.1.0",
      openclaw: { claw: "CLAW.md" },
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.claw.manifest.agent.id).toBe("research-assistant");
      expect(validated.claw.clawMarkdownBody?.toString()).toContain("purpose-built OpenClaw agent");
    }
  });

  it("refuses occupied targets and package lifecycle scripts", async () => {
    const occupied = tempDirs.make("openclaw-claw-occupied-");
    await writeFile(join(occupied, "keep.txt"), "keep\n");
    await expect(createClawProject(occupied)).rejects.toMatchObject({
      code: "project_target_not_empty",
    } satisfies Partial<ClawProjectError>);

    const project = tempDirs.make("openclaw-claw-scripts-");
    await writeRichProject(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        name: "demo-claw",
        version: "1.2.3",
        scripts: { postinstall: "echo unsafe" },
        openclaw: { claw: "CLAW.md" },
      }),
    );
    const result = await validateClawProject(project);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain("project_scripts_forbidden");
    }
  });

  it("builds byte-identical artifacts containing only declared project inputs", async () => {
    const project = tempDirs.make("openclaw-claw-build-");
    const output = tempDirs.make("openclaw-claw-output-");
    await writeRichProject(project);
    const firstPath = join(output, "first.tgz");
    const secondPath = join(output, "second.tgz");

    const first = await buildClawProject(project, firstPath);
    const second = await buildClawProject(project, secondPath);
    const validation = await validateClawProject(join(project, "workspace", "reference.md"));
    const entries: string[] = [];
    await tar.t({ file: firstPath, onentry: (entry) => entries.push(entry.path) });

    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(first.integrity).toBe(second.integrity);
    expect(first.excludedPaths).toEqual(["not-packed.txt"]);
    expect(validation).toMatchObject({ ok: true, excludedPaths: ["not-packed.txt"] });
    expect(entries).toEqual([
      "package/BOOTSTRAP.md",
      "package/CLAW.md",
      "package/package.json",
      "package/profiles/openclaw.yml",
      "package/workspace/reference.md",
    ]);
    expect(entries).not.toContain("package/not-packed.txt");
  });

  it("rejects ambiguous nested project discovery", async () => {
    const outer = tempDirs.make("openclaw-claw-nested-");
    const inner = join(outer, "examples", "nested");
    await writeRichProject(outer);
    await writeRichProject(inner);

    const result = await validateClawProject(join(inner, "CLAW.md"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain("ambiguous_project_root");
    }
  });

  it("changes the artifact digest when a declared input changes", async () => {
    const project = tempDirs.make("openclaw-claw-build-change-");
    const output = tempDirs.make("openclaw-claw-output-change-");
    await writeRichProject(project);

    const first = await buildClawProject(project, join(output, "first.tgz"));
    await writeFile(join(project, "workspace", "reference.md"), "# Changed reference\n");
    const second = await buildClawProject(project, join(output, "second.tgz"));

    expect(first.integrity).not.toBe(second.integrity);
  });
});
