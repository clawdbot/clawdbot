import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export async function createSourcePluginDependenciesFixture(rootDir: string) {
  const root = await fs.realpath(rootDir);
  const importers = [
    { directory: ".", version: "1.0.0", field: "dependencies" },
    { directory: "extensions/plugin-a", version: "2.0.0", field: "devDependencies" },
    { directory: "extensions/plugin-b", version: "3.0.0", field: "dependencies" },
  ];
  const names = ["fixture-dependency", "@fixture/scoped"];
  const workspaceName = "@fixture/workspace";
  const workspaceDir = path.join(root, "packages", "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({ name: workspaceName, version: "4.0.0" }),
  );
  await fs.writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - extensions/*\n  - packages/*\n",
  );

  for (const { directory, version, field } of importers) {
    const importerDir = path.join(root, directory);
    await fs.mkdir(path.join(importerDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(importerDir, "package.json"),
      JSON.stringify({
        name: directory === "." ? "fixture-root" : path.basename(directory),
        [field]: {
          ...Object.fromEntries(names.map((name) => [name, version])),
          [workspaceName]: "workspace:*",
        },
      }),
    );
    for (const name of names) {
      const dependencyDir = path.join(importerDir, "node_modules", name);
      await fs.mkdir(dependencyDir, { recursive: true });
      await fs.writeFile(
        path.join(dependencyDir, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
    await fs.symlink(
      workspaceDir,
      path.join(importerDir, "node_modules", workspaceName),
      "junction",
    );
  }

  return {
    assertResolution() {
      // Fresh native Node processes avoid Vitest aliases and cached pre-cleanup resolution.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createRequire } from "node:module";
        import { lstatSync } from "node:fs";
        import path from "node:path";
        const resolved = ${JSON.stringify(importers)}.map(({ directory }) => {
          const importer = path.resolve(directory);
          const require = createRequire(path.join(importer, "src", "probe.cjs"));
          return { directory, versions: ${JSON.stringify([...names, workspaceName])}.map(name => require(name + "/package.json").version),
            workspaceLink: lstatSync(path.join(importer, "node_modules", ${JSON.stringify(workspaceName)}), { throwIfNoEntry: false })?.isSymbolicLink() ?? false };
        });
        console.log(JSON.stringify(resolved));
      `,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        importers.map(({ directory, version }) => ({
          directory,
          versions: [version, version, "4.0.0"],
          workspaceLink: true,
        })),
      );
    },
  };
}
