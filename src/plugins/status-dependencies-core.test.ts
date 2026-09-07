import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostRootResolver from "../infra/openclaw-root.js";
import {
  buildPluginDependencyStatus,
  findMissingRequiredPluginDependencies,
  normalizePluginDependencySpecs,
} from "./status-dependencies-core.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

describe("findMissingRequiredPluginDependencies", () => {
  function createHostFixture(pluginName = "example-plugin") {
    const parent = createPluginRoot();
    const projectRoot = path.join(parent, "project");
    const rootDir = path.join(projectRoot, "node_modules", pluginName);
    const hostRoot = hostRootResolver.resolveOpenClawPackageRootSync({
      moduleUrl: import.meta.url,
    });
    if (!hostRoot) {
      throw new Error("Expected the running OpenClaw package root");
    }
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: pluginName }));
    return { parent, projectRoot, rootDir, hostRoot };
  }

  function linkHost(rootDir: string, hostRoot: string) {
    fs.mkdirSync(path.join(rootDir, "node_modules"), { recursive: true });
    fs.symlinkSync(hostRoot, path.join(rootDir, "node_modules", "openclaw"), "junction");
  }

  it.each([
    "canonical",
    "missing",
    "empty",
    "copy",
    "wrong-target",
    "linked-node-modules",
    "hoisted-host",
    "unknown-host",
  ] as const)("audits a required OpenClaw host with a %s layout", async (layout) => {
    const { parent, projectRoot, rootDir, hostRoot } = createHostFixture();
    if (layout === "canonical" || layout === "unknown-host") {
      linkHost(rootDir, hostRoot);
    } else if (layout === "copy") {
      writeDependency(rootDir, "openclaw");
    } else if (layout === "empty") {
      fs.mkdirSync(path.join(rootDir, "node_modules", "openclaw"), { recursive: true });
    } else if (layout === "wrong-target") {
      linkHost(rootDir, writeDependency(parent, "openclaw"));
    } else if (layout === "linked-node-modules") {
      const externalRoot = path.join(parent, "external");
      linkHost(externalRoot, hostRoot);
      fs.symlinkSync(
        path.join(externalRoot, "node_modules"),
        path.join(rootDir, "node_modules"),
        "junction",
      );
    } else if (layout === "hoisted-host") {
      linkHost(projectRoot, hostRoot);
    }
    if (layout === "unknown-host") {
      vi.spyOn(hostRootResolver, "resolveOpenClawPackageRootSync").mockReturnValue(null);
    }
    const params = {
      rootDir,
      dependencyRootDir: projectRoot,
      dependencies: { openclaw: "*" },
    };

    expect(await findMissingRequiredPluginDependencies(params)).toEqual(
      layout === "canonical" ? [] : ["openclaw"],
    );
    // A package manifest alone is sufficient for generic status, not for host identity.
    expect(buildPluginDependencyStatus(params).requiredInstalled).toBe(layout === "copy");
  });

  describe.each(["example-plugin", "@example/plugin"])("canonical host for %s", (pluginName) => {
    it.each(["nested", "hoisted", "inside-symlink", "missing", "ancestor", "outside-symlink"])(
      "keeps the ordinary %s dependency check bounded",
      async (layout) => {
        const { parent, projectRoot, rootDir, hostRoot } = createHostFixture(pluginName);
        linkHost(rootDir, hostRoot);
        if (layout === "nested") {
          writeDependency(rootDir, "required-runtime");
        } else if (layout === "hoisted") {
          writeDependency(projectRoot, "required-runtime");
        } else if (layout !== "missing") {
          const targetDir = writeDependency(
            layout === "inside-symlink" ? projectRoot : parent,
            "required-runtime",
          );
          if (layout.endsWith("symlink")) {
            fs.symlinkSync(
              targetDir,
              path.join(rootDir, "node_modules", "required-runtime"),
              "junction",
            );
          }
        }
        const missingRequired = await findMissingRequiredPluginDependencies({
          rootDir,
          dependencyRootDir: projectRoot,
          dependencies: { openclaw: "*", "required-runtime": "1.0.0" },
        });

        expect(missingRequired).toEqual(
          ["nested", "hoisted", "inside-symlink"].includes(layout) ? [] : ["required-runtime"],
        );
      },
    );
  });

  it("does not exempt a canonical host when the plugin is outside the project", async () => {
    const { rootDir, hostRoot } = createHostFixture();
    linkHost(rootDir, hostRoot);

    expect(
      await findMissingRequiredPluginDependencies({
        rootDir,
        dependencyRootDir: createPluginRoot(),
        dependencies: { openclaw: "*" },
      }),
    ).toEqual(["openclaw"]);
  });

  it("audits a canonical host through a project alias", async () => {
    const { parent, projectRoot, rootDir, hostRoot } = createHostFixture();
    linkHost(rootDir, hostRoot);
    const alias = path.join(parent, "alias");
    fs.symlinkSync(projectRoot, alias, "junction");

    expect(
      await findMissingRequiredPluginDependencies({
        rootDir: path.join(alias, "node_modules", "example-plugin"),
        dependencyRootDir: projectRoot,
        dependencies: { openclaw: "*" },
      }),
    ).toEqual([]);
  });

  it.each(["", " ", "missing"])("rejects an unavailable plugin root: %j", async (root) => {
    const projectRoot = createPluginRoot();
    expect(
      await findMissingRequiredPluginDependencies({
        rootDir: root === "missing" ? path.join(projectRoot, root) : root,
        dependencyRootDir: projectRoot,
        dependencies: { openclaw: "*" },
      }),
    ).toEqual(["openclaw"]);
  });

  it.each([undefined, {}, { openclaw: "*" }])(
    "does not audit an absent or optional-only host declaration: %j",
    async (dependencies) => {
      const rootDir = createPluginRoot();
      const resolver = vi
        .spyOn(hostRootResolver, "resolveOpenClawPackageRootSync")
        .mockImplementation(() => {
          throw new Error("No required host needs auditing");
        });

      expect(
        await findMissingRequiredPluginDependencies({
          rootDir,
          dependencyRootDir: rootDir,
          ...normalizePluginDependencySpecs({
            dependencies,
            optionalDependencies: { openclaw: "*" },
          }),
        }),
      ).toEqual([]);
      expect(resolver).not.toHaveBeenCalled();
    },
  );
});
