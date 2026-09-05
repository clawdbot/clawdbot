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
