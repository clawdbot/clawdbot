import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

  it("matches the golden artifact digest under a restrictive umask", () => {
    const output = join(tempDirs.make("openclaw-claw-umask-"), "golden.tgz");
    const project = join(process.cwd(), "test", "fixtures", "claws", "project-v1");
    const script = [
      "process.umask(0o077);",
      'const { buildClawProject } = await import("./src/claws/project-build.ts");',
      `const result = await buildClawProject(${JSON.stringify(project)}, ${JSON.stringify(output)});`,
      "process.stdout.write(result.integrity);",
    ].join("\n");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_OPTIONS: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        timeout: 60_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
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

  it("keeps one concurrent creator's completed project", async () => {
    const root = join(tempDirs.make("openclaw-claw-create-race-"), "shared");
    await mkdir(root);

    const results = await Promise.allSettled([createClawProject(root), createClawProject(root)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(validateClawProject(root)).resolves.toMatchObject({ ok: true });
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

  it("rejects package.json as a managed workspace source", async () => {
    const project = tempDirs.make("openclaw-claw-package-source-");
    const output = join(tempDirs.make("openclaw-claw-package-source-output-"), "claw.tgz");
    await writeRichProject(project);
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace(
        "    - source: workspace/reference.md\n      path: reference.md",
        "    - source: package.json\n      path: metadata.json",
      ),
    );

    await expect(validateClawProject(project)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "project_invalid" })],
    });
    await expect(buildClawProject(project, output)).rejects.toMatchObject({
      code: "project_invalid",
    } satisfies Partial<ClawProjectError>);
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

  it("preserves the canonical metadata-selected OpenClaw profile path", async () => {
    const project = tempDirs.make("openclaw-claw-custom-profile-");
    const output = join(tempDirs.make("openclaw-claw-custom-profile-output-"), "claw.tgz");
    await writeRichProject(project);
    await rename(
      join(project, "profiles", "openclaw.yml"),
      join(project, "profiles", "custom.yaml"),
    );
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace(
        "agent:\n  id: demo-claw",
        "agent:\n  id: demo-claw\nmetadata:\n  openclaw.config: profiles/custom.yaml",
      ),
    );

    const validation = await validateClawProject(project);
    const result = await buildClawProject(project, output);
    const entries: string[] = [];
    await tar.t({ file: output, onentry: (entry) => entries.push(entry.path) });

    expect(validation).toMatchObject({ ok: true });
    if (validation.ok) {
      expect(validation.claw.snapshot.openClawProfile?.sourcePath).toBe("profiles/custom.yaml");
      expect(validation.excludedPaths).not.toContain("profiles/custom.yaml");
    }
    expect(result.files).toContain("profiles/custom.yaml");
    expect(entries).toContain("package/profiles/custom.yaml");
    expect(entries).not.toContain("package/profiles/openclaw.yml");
  });

  it("packages a leading-at workspace source as an ordinary file", async () => {
    const project = tempDirs.make("openclaw-claw-leading-at-");
    const output = join(tempDirs.make("openclaw-claw-leading-at-output-"), "claw.tgz");
    await writeRichProject(project);
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace("workspace/reference.md", '"@notes.md"'),
    );
    await writeFile(join(project, "@notes.md"), "# Notes\n");

    const result = await buildClawProject(project, output);
    const entries: string[] = [];
    await tar.t({ file: output, onentry: (entry) => entries.push(entry.path) });

    expect(result.files).toContain("@notes.md");
    expect(entries).toContain("package/@notes.md");
  });

  it("packages a valid source whose filename begins with two dots", async () => {
    const project = tempDirs.make("openclaw-claw-leading-dots-");
    const output = join(tempDirs.make("openclaw-claw-leading-dots-output-"), "claw.tgz");
    await writeRichProject(project);
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace("workspace/reference.md", "..notes.md"),
    );
    await writeFile(join(project, "..notes.md"), "# Notes\n");

    const result = await buildClawProject(project, output);
    const entries: string[] = [];
    await tar.t({ file: output, onentry: (entry) => entries.push(entry.path) });

    expect(result.files).toContain("..notes.md");
    expect(entries).toContain("package/..notes.md");
  });

  it("normalizes accepted backslash source separators in the built package", async () => {
    const project = tempDirs.make("openclaw-claw-backslash-source-");
    const output = join(tempDirs.make("openclaw-claw-backslash-source-output-"), "claw.tgz");
    await writeRichProject(project);
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace(
        "    - source: workspace/reference.md",
        String.raw`    - source: 'workspace\reference.md'`,
      ),
    );

    const validation = await validateClawProject(project);
    const result = await buildClawProject(project, output);
    const entries: string[] = [];
    await tar.t({ file: output, onentry: (entry) => entries.push(entry.path) });

    expect(validation).toMatchObject({ ok: true });
    expect(result.files).toContain("workspace/reference.md");
    expect(entries).toContain("package/workspace/reference.md");
  });

  it("preserves long workspace source paths deterministically", async () => {
    const project = tempDirs.make("openclaw-claw-long-path-");
    const output = tempDirs.make("openclaw-claw-long-path-output-");
    await writeRichProject(project);
    const longName = `${"a".repeat(140)}.md`;
    const longSource = `workspace/${longName}`;
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace("workspace/reference.md", longSource),
    );
    await writeFile(join(project, longSource), "# Long path\n");

    const firstPath = join(output, "first.tgz");
    const secondPath = join(output, "second.tgz");
    const first = await buildClawProject(project, firstPath);
    const second = await buildClawProject(project, secondPath);
    const entries: string[] = [];
    await tar.t({ file: firstPath, onentry: (entry) => entries.push(entry.path) });

    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(first.integrity).toBe(second.integrity);
    expect(first.files).toContain(longSource);
    expect(entries).toContain(`package/${longSource}`);
  });

  it.runIf(process.platform === "win32")(
    "does not report a differently cased selected file as excluded",
    async () => {
      const project = tempDirs.make("openclaw-claw-selected-case-");
      await writeRichProject(project);
      const temporaryManifest = join(project, "manifest.tmp");
      await rename(join(project, "CLAW.md"), temporaryManifest);
      await rename(temporaryManifest, join(project, "claw.md"));

      const result = await validateClawProject(project);

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.excludedPaths).not.toContain("claw.md");
      }
    },
  );

  it("dereferences only a confined CLAW.md symlink into the artifact", async () => {
    const project = tempDirs.make("openclaw-claw-manifest-link-");
    const output = join(tempDirs.make("openclaw-claw-manifest-link-output-"), "linked.tgz");
    const unpacked = tempDirs.make("openclaw-claw-manifest-link-unpacked-");
    await writeRichProject(project);
    await mkdir(join(project, "manifest"));
    await rename(join(project, "CLAW.md"), join(project, "manifest", "source.md"));
    await symlink("manifest/source.md", join(project, "CLAW.md"), "file");

    await expect(validateClawProject(project)).resolves.toMatchObject({ ok: true });
    await buildClawProject(project, output);
    await tar.x({ cwd: unpacked, file: output, strict: true });

    expect((await lstat(join(unpacked, "package", "CLAW.md"))).isFile()).toBe(true);
    expect(await readFile(join(unpacked, "package", "CLAW.md"), "utf8")).toContain(
      "You are the demo Claw.",
    );
  });

  it.each([".git/CLAW.md", "node_modules/example/CLAW.md"])(
    "rejects a CLAW.md symlink into excluded tree %s",
    async (targetPath) => {
      const project = tempDirs.make("openclaw-claw-manifest-excluded-link-");
      await writeRichProject(project);
      await mkdir(dirname(join(project, targetPath)), { recursive: true });
      await rename(join(project, "CLAW.md"), join(project, targetPath));
      await symlink(targetPath, join(project, "CLAW.md"), "file");

      await expect(validateClawProject(project)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "project_not_found" })],
      });
    },
  );

  it("rejects a CLAW.md symlink that escapes the project", async () => {
    const project = tempDirs.make("openclaw-claw-manifest-escape-");
    const outside = tempDirs.make("openclaw-claw-manifest-outside-");
    await writeRichProject(project);
    await rename(join(project, "CLAW.md"), join(outside, "CLAW.md"));
    await symlink(join(outside, "CLAW.md"), join(project, "CLAW.md"), "file");

    await expect(validateClawProject(project)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "project_not_found" })],
    });
  });

  it.each([
    ".git/config",
    "node_modules/example/secret.md",
    "workspace/.git/config",
    "workspace/node_modules/example/secret.md",
  ])("rejects an explicitly selected source from %s", async (sourcePath) => {
    const project = tempDirs.make("openclaw-claw-excluded-source-");
    const output = join(tempDirs.make("openclaw-claw-excluded-source-output-"), "claw.tgz");
    await writeRichProject(project);
    await mkdir(dirname(join(project, sourcePath)), { recursive: true });
    await writeFile(join(project, sourcePath), "sensitive local state\n");
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace("workspace/reference.md", sourcePath),
    );

    await expect(validateClawProject(project)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "project_excluded_source" })],
    });
    await expect(buildClawProject(project, output)).rejects.toMatchObject({
      code: "project_invalid",
    } satisfies Partial<ClawProjectError>);
  });

  it("rejects a custom profile selected from an excluded tree", async () => {
    const project = tempDirs.make("openclaw-claw-excluded-profile-");
    await writeRichProject(project);
    await rename(
      join(project, "profiles", "openclaw.yml"),
      join(project, "profiles", "unused.yml"),
    );
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(project, ".git", "profile.yaml"), "schemaVersion: 1\nagent: {}\n");
    const manifest = await readFile(join(project, "CLAW.md"), "utf8");
    await writeFile(
      join(project, "CLAW.md"),
      manifest.replace(
        "agent:\n  id: demo-claw",
        "agent:\n  id: demo-claw\nmetadata:\n  openclaw.config: .git/profile.yaml",
      ),
    );

    await expect(validateClawProject(project)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "project_excluded_source" })],
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a workspace source that portably collides with CLAW.md",
    async () => {
      const project = tempDirs.make("openclaw-claw-manifest-case-collision-");
      await writeRichProject(project);
      const manifest = await readFile(join(project, "CLAW.md"), "utf8");
      await writeFile(
        join(project, "CLAW.md"),
        manifest.replace("workspace/reference.md", "claw.md"),
      );
      await writeFile(join(project, "claw.md"), "# Conflicting source\n");

      await expect(validateClawProject(project)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "project_path_collision" })],
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a workspace source that portably collides with a custom profile",
    async () => {
      const project = tempDirs.make("openclaw-claw-profile-case-collision-");
      await writeRichProject(project);
      await rename(
        join(project, "profiles", "openclaw.yml"),
        join(project, "profiles", "custom.yaml"),
      );
      await writeFile(join(project, "profiles", "CUSTOM.yaml"), "schemaVersion: 1\nagent: {}\n");
      const manifest = await readFile(join(project, "CLAW.md"), "utf8");
      await writeFile(
        join(project, "CLAW.md"),
        manifest
          .replace(
            "agent:\n  id: demo-claw",
            "agent:\n  id: demo-claw\nmetadata:\n  openclaw.config: profiles/custom.yaml",
          )
          .replace("workspace/reference.md", "profiles/CUSTOM.yaml"),
      );

      await expect(validateClawProject(project)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "project_path_collision" })],
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects Unicode-normalization collisions between workspace sources",
    async () => {
      const project = tempDirs.make("openclaw-claw-unicode-collision-");
      await writeRichProject(project);
      const composed = "workspace/caf\u00e9.md";
      const decomposed = "workspace/cafe\u0301.md";
      const manifest = await readFile(join(project, "CLAW.md"), "utf8");
      await writeFile(
        join(project, "CLAW.md"),
        manifest.replace(
          "    - source: workspace/reference.md\n      path: reference.md",
          [
            `    - source: ${JSON.stringify(composed)}`,
            "      path: composed.md",
            `    - source: ${JSON.stringify(decomposed)}`,
            "      path: decomposed.md",
          ].join("\n"),
        ),
      );
      await writeFile(join(project, composed), "# Composed\n");
      await writeFile(join(project, decomposed), "# Decomposed\n");

      await expect(validateClawProject(project)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "project_path_collision" })],
      });
    },
  );

  it("preserves an existing build destination", async () => {
    const project = tempDirs.make("openclaw-claw-build-existing-");
    const output = join(tempDirs.make("openclaw-claw-output-existing-"), "existing.tgz");
    await writeRichProject(project);
    await writeFile(output, "keep this artifact\n");

    await expect(buildClawProject(project, output)).rejects.toMatchObject({
      code: "artifact_exists",
    } satisfies Partial<ClawProjectError>);
    expect(await readFile(output, "utf8")).toBe("keep this artifact\n");
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
