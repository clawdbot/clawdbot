import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPluginDependencyStatus,
  normalizePluginDependencySpecs,
} from "./status-dependencies-core.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function createPluginRoot() {
  return makeTrackedTempDir("openclaw-plugin-dependency-status", tempDirs);
}

function writeDependency(rootDir: string, name: string) {
  const packageDir = path.join(rootDir, "node_modules", name);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  return packageDir;
}

describe("buildPluginDependencyStatus", () => {
  it.each(["missing", "directory", "file"])(
    "rejects a required dependency with a %s package payload",
    (payload) => {
      const rootDir = createPluginRoot();
      const dependencyDir = path.join(rootDir, "node_modules", "required-runtime");
      if (payload === "directory") {
        fs.mkdirSync(dependencyDir, { recursive: true });
      } else if (payload === "file") {
        fs.mkdirSync(path.dirname(dependencyDir));
        fs.writeFileSync(dependencyDir, "not a package");
      }

      const status = buildPluginDependencyStatus({
        rootDir,
        dependencies: { "required-runtime": "1.0.0" },
      });

      expect(status.installed).toBe(false);
      expect(status.requiredInstalled).toBe(false);
      expect(status.missing).toEqual(["required-runtime"]);
      expect(status.dependencies[0]?.resolvedPath).toBeUndefined();
    },
  );

  it.each(["required-runtime", "@example/required-runtime"])(
    "accepts an installed dependency manifest for %s",
    (name) => {
      const rootDir = createPluginRoot();
      const packageDir = writeDependency(rootDir, name);

      const status = buildPluginDependencyStatus({ rootDir, dependencies: { [name]: "1.0.0" } });

      expect(status.installed).toBe(true);
      expect(status.missing).toEqual([]);
      expect(status.dependencies[0]?.resolvedPath).toBe(packageDir);
    },
  );

  it("continues past an empty local directory to a healthy hoisted dependency", () => {
    const rootDir = createPluginRoot();
    const pluginDir = path.join(rootDir, "node_modules", "example-plugin");
    fs.mkdirSync(path.join(pluginDir, "node_modules", "required-runtime"), { recursive: true });
    const hoistedDir = writeDependency(rootDir, "required-runtime");

    const status = buildPluginDependencyStatus({
      rootDir: pluginDir,
      dependencies: { "required-runtime": "1.0.0" },
    });

    expect(status.installed).toBe(true);
    expect(status.dependencies[0]?.resolvedPath).toBe(hoistedDir);
  });

  describe.each(["example-plugin", "@example/plugin"])("bounded project for %s", (pluginName) => {
    it.each(["nested", "hoisted", "ancestor", "outside-symlink", "inside-symlink"])(
      "checks %s dependencies without escaping the managed project",
      (layout) => {
        const parent = createPluginRoot();
        const projectRoot = path.join(parent, "project");
        const rootDir = path.join(projectRoot, "node_modules", pluginName);
        const dependencyDir = path.join(rootDir, "node_modules", "required-runtime");
        fs.mkdirSync(rootDir, { recursive: true });
        if (layout === "nested") {
          writeDependency(rootDir, "required-runtime");
        } else if (layout === "hoisted") {
          fs.mkdirSync(dependencyDir, { recursive: true });
          writeDependency(projectRoot, "required-runtime");
        } else {
          const targetRoot = layout === "inside-symlink" ? projectRoot : parent;
          const targetDir = writeDependency(targetRoot, "required-runtime");
          if (layout.endsWith("symlink")) {
            fs.mkdirSync(path.dirname(dependencyDir), { recursive: true });
            fs.symlinkSync(targetDir, dependencyDir, "junction");
          }
        }

        const status = buildPluginDependencyStatus({
          rootDir,
          dependencyRootDir: projectRoot,
          dependencies: { "required-runtime": "1.0.0" },
          optionalDependencies: { "optional-runtime": "1.0.0" },
        });

        const installed = layout !== "ancestor" && layout !== "outside-symlink";
        expect(status.requiredInstalled).toBe(installed);
        expect(status.missing).toEqual(installed ? [] : ["required-runtime"]);
        expect(status.missingOptional).toEqual(["optional-runtime"]);
      },
    );
  });

  it("preserves unbounded ancestor lookup for generic dependency status", () => {
    const parent = createPluginRoot();
    const rootDir = path.join(parent, "project", "node_modules", "example-plugin");
    const availableDir = writeDependency(parent, "required-runtime");
    fs.mkdirSync(rootDir, { recursive: true });

    const status = buildPluginDependencyStatus({
      rootDir,
      dependencies: { "required-runtime": "1.0.0" },
    });

    expect(status.requiredInstalled).toBe(true);
    expect(status.dependencies[0]?.resolvedPath).toBe(availableDir);
  });

  it("does not inspect a plugin outside the requested dependency root", () => {
    const rootDir = createPluginRoot();
    writeDependency(rootDir, "required-runtime");

    const status = buildPluginDependencyStatus({
      rootDir,
      dependencyRootDir: path.join(rootDir, "different-project"),
      dependencies: { "required-runtime": "1.0.0" },
    });

    expect(status.requiredInstalled).toBe(false);
    expect(status.missing).toEqual(["required-runtime"]);
  });

  it("accepts a project alias whose canonical dependency stays inside the project", () => {
    const parent = createPluginRoot();
    const projectRoot = path.join(parent, "project");
    const alias = path.join(parent, "alias");
    const rootDir = path.join(projectRoot, "node_modules", "example-plugin");
    fs.mkdirSync(rootDir, { recursive: true });
    const availableDir = writeDependency(projectRoot, "required-runtime");
    fs.symlinkSync(projectRoot, alias, "junction");

    const status = buildPluginDependencyStatus({
      rootDir: path.join(alias, "node_modules", "example-plugin"),
      dependencyRootDir: projectRoot,
      dependencies: { "required-runtime": "1.0.0" },
    });

    expect(status.requiredInstalled).toBe(true);
    expect(fs.realpathSync(status.dependencies[0]?.resolvedPath ?? "<unresolved>")).toBe(
      availableDir,
    );
  });

  it("keeps missing optional overrides out of required failures", () => {
    const status = buildPluginDependencyStatus({
      rootDir: createPluginRoot(),
      ...normalizePluginDependencySpecs({
        dependencies: { "optional-runtime": "1.0.0" },
        optionalDependencies: { "optional-runtime": "2.0.0" },
      }),
    });

    expect(status.installed).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.missingOptional).toEqual(["optional-runtime"]);
    expect(status.dependencies).toEqual([]);
    expect(status.optionalDependencies[0]?.spec).toBe("2.0.0");
  });
});
