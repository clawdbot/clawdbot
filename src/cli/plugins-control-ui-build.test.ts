import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginImportFixture,
  unresolvedPluginImportCases,
} from "./plugins-build-bundle.test-support.js";
import { buildPluginControlUi, writePluginBuildManifest } from "./plugins-control-ui-build.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-build-"));
  directories.push(directory);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "ui-build-fixture", type: "module" }),
  );
  await fs.symlink(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
  await fs.writeFile(
    path.join(directory, "index.ts"),
    'import "./style.css"; export const message = "first";',
  );
  await fs.writeFile(path.join(directory, "style.css"), ".fixture { color: var(--text); }");
  await fs.writeFile(path.join(directory, "lazy.js"), 'export const value = "literal dependency";');
  await fs.mkdir(path.join(directory, "localized"));
  await fs.writeFile(
    path.join(directory, "localized/value.js"),
    'export const value = "glob dependency";',
  );
  await fs.appendFile(
    path.join(directory, "index.ts"),
    '\nexport async function loadDependencies(name: string) { return [(await import("./lazy.js")).value, (await import("./localized/" + name + ".js")).value]; }\n',
  );
  return { rootDir: directory, source: "index.ts" };
}

describe("native plugin browser builds", () => {
  it("publishes complete immutable generations and detects stale source", async () => {
    const project = await fixture();
    const first = await buildPluginControlUi(project);
    await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
    expect(first.entry).toMatch(/^dist\/control-ui\/[a-f0-9]{64}\/index.js$/u);
    expect(first.styles).toHaveLength(1);
    expect(await buildPluginControlUi({ ...project, check: true })).toEqual(first);
    const built = await import(pathToFileURL(path.join(project.rootDir, first.entry)).href);
    expect(await built.loadDependencies("value")).toEqual([
      "literal dependency",
      "glob dependency",
    ]);
    const original = await fs.readFile(path.join(project.rootDir, first.entry), "utf8");
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'export const message = "second";',
    );
    await expect(buildPluginControlUi({ ...project, check: true })).rejects.toThrow(
      "missing or stale",
    );
    const next = await buildPluginControlUi(project);
    expect(next.entry).not.toBe(first.entry);
    expect(await fs.readFile(path.join(project.rootDir, first.entry), "utf8")).toBe(original);
    expect(
      JSON.parse(await fs.readFile(path.join(project.rootDir, "openclaw.plugin.json"), "utf8"))
        .controlUi,
    ).toEqual(first);
  });

  it("bundles browser-safe primitive SDK exports", async () => {
    const project = await fixture();
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'export { asDateTimestampMs, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";',
    );
    const artifact = await buildPluginControlUi(project);
    const built = await import(pathToFileURL(path.join(project.rootDir, artifact.entry)).href);
    expect(built.asDateTimestampMs(0)).toBe(0);
    expect(built.asDateTimestampMs("0")).toBeUndefined();
    expect(built.asDateTimestampMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(built.truncateUtf16Safe("A😀B", 2)).toBe("A");
  });

  it.each(unresolvedPluginImportCases)(
    "rejects unresolved $name without publishing a browser build",
    async (testCase) => {
      const {
        file,
        expected = "required dependency",
        diagnostic = "will not be bundled",
      } = testCase;
      const project = await fixture();
      const first = await buildPluginControlUi(project);
      await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
      const manifestPath = path.join(project.rootDir, "openclaw.plugin.json");
      const manifest = await fs.readFile(manifestPath, "utf8");
      const runOriginal = await createPluginImportFixture(
        path.join(project.rootDir, "runtime"),
        testCase,
      );
      expect(runOriginal()).toBe(expected);
      await fs.writeFile(
        path.join(project.rootDir, project.source),
        `export { loadDependency } from "./runtime/${file}";\n`,
      );
      await expect(buildPluginControlUi(project)).rejects.toThrow(diagnostic);
      expect(await fs.readFile(manifestPath, "utf8")).toBe(manifest);
      expect(await fs.readdir(path.join(project.rootDir, "dist/control-ui"))).toEqual([
        path.basename(path.dirname(first.entry)),
      ]);
    },
  );

  it("leaves the published build usable when browser compilation fails", async () => {
    const project = await fixture();
    const first = await buildPluginControlUi(project);
    await writePluginBuildManifest(project.rootDir, { id: "fixture", controlUi: first });
    const manifest = await fs.readFile(path.join(project.rootDir, "openclaw.plugin.json"), "utf8");
    await fs.writeFile(
      path.join(project.rootDir, project.source),
      'import fs from "node:fs"; export default fs;',
    );
    await expect(buildPluginControlUi(project)).rejects.toThrow();
    expect(await fs.readFile(path.join(project.rootDir, "openclaw.plugin.json"), "utf8")).toBe(
      manifest,
    );
    expect(await fs.readFile(path.join(project.rootDir, first.entry), "utf8")).toContain("first");
  });

  it("rejects source entries outside the authoring package", async () => {
    const project = await fixture();
    const outside = await fixture();
    await expect(
      buildPluginControlUi({ ...project, source: path.join(outside.rootDir, "index.ts") }),
    ).rejects.toThrow("inside the plugin");
  });
});
