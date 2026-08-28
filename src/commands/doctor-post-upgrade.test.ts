// Doctor post-upgrade tests cover upgrade sentinel handling, config/state repair, and plugin record migration.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";

async function makeFixtureRoot(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `doctor-post-upgrade-${prefix}-`));
}

async function withFixtureRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await makeFixtureRoot(prefix);
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writePluginFixture(
  root: string,
  params: {
    id: string;
    location?: string;
    packageJson?: unknown;
    packageJsonRaw?: string;
    files?: Record<string, string>;
    origin?: string;
    includePackageJsonRecord?: boolean;
    manifest?: Record<string, unknown> | false;
    manifestHash?: string;
  },
) {
  const pluginDir = path.join(root, params.location ?? "user-plugins", params.id);
  await fs.mkdir(pluginDir, { recursive: true });
  for (const [relativePath, contents] of Object.entries(params.files ?? {})) {
    const pathname = path.join(pluginDir, relativePath);
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, contents, "utf-8");
  }
  const hasPackageJson =
    Object.hasOwn(params, "packageJson") || params.packageJsonRaw !== undefined;
  if (hasPackageJson) {
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      params.packageJsonRaw ?? JSON.stringify(params.packageJson),
      "utf-8",
    );
  }
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (params.manifest !== false) {
    await fs.writeFile(manifestPath, JSON.stringify(params.manifest ?? { id: params.id }), "utf-8");
  }
  const installsPath = path.join(root, "plugins", "installs.json");
  await fs.mkdir(path.dirname(installsPath), { recursive: true });
  await fs.writeFile(
    installsPath,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          pluginId: params.id,
          rootDir: pluginDir,
          enabled: true,
          ...(params.origin ? { origin: params.origin } : {}),
          ...(hasPackageJson && params.includePackageJsonRecord !== false
            ? { packageJson: { path: "package.json" } }
            : {}),
          ...(params.manifest === false ? {} : { manifestPath }),
          ...(params.manifestHash ? { manifestHash: params.manifestHash } : {}),
        },
      ],
    }),
    "utf-8",
  );
  return { installsPath, pluginDir, manifestPath };
}

async function writeDeclaredPackageFixture(root: string, packageContents: string): Promise<string> {
  return (
    await writePluginFixture(root, {
      id: "broken",
      packageJsonRaw: packageContents,
      manifest: false,
    })
  ).installsPath;
}

describe("runPostUpgradeProbes — plugin.index_unavailable", () => {
  it("returns a structured finding when the installed plugin index is missing", async () => {
    await withFixtureRoot("index-missing", async (root) => {
      const report = await runPostUpgradeProbes({
        installsPath: path.join(root, "plugins", "installs.json"),
      });

      expect(report.probesRun).toContain("plugin.index_unavailable");
      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.index_unavailable",
        }),
      ]);
    });
  });

  it("returns a structured finding when the installed plugin index is malformed", async () => {
    await withFixtureRoot("index-malformed", async (root) => {
      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(installsPath, "{ not json", "utf-8");

      const report = await runPostUpgradeProbes({ installsPath });

      expect(report.probesRun).toContain("plugin.index_unavailable");
      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.index_unavailable",
        }),
      ]);
    });
  });

  it("returns a structured finding when an installed plugin record is malformed", async () => {
    await withFixtureRoot("record-malformed", async (root) => {
      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(installsPath, JSON.stringify({ plugins: [{}] }), "utf-8");

      const report = await runPostUpgradeProbes({ installsPath });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.index_unavailable",
        }),
      ]);
    });
  });
});

describe("runPostUpgradeProbes — plugin.entry_unresolved", () => {
  it("reports unreadable plugin packages as structured errors without losing JSON console diagnostics", async () => {
    const root = await makeFixtureRoot("entry-unreadable-json");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          plugins: [
            {
              pluginId: "broken",
              rootDir: path.join(root, "broken"),
              enabled: true,
              packageJson: { path: "missing-package.json" },
            },
          ],
        }),
        "utf-8",
      );
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });

      const report = await runPostUpgradeProbes({ installsPath });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "missing-package.json",
          message: expect.stringContaining("openclaw plugins registry --refresh"),
        }),
      ]);
      const line = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
      expect(JSON.parse(line)).toMatchObject({
        level: "warn",
        message: expect.stringContaining("could not read package.json for broken"),
      });
    } finally {
      stderrSpy.mockRestore();
      resetLogger();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports malformed declared plugin packages as entry resolution errors", async () => {
    const root = await makeFixtureRoot("entry-malformed-package");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      const installsPath = await writeDeclaredPackageFixture(root, "{ not json");
      const report = await runPostUpgradeProbes({ installsPath });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "package.json",
          message: expect.stringContaining("openclaw plugins registry --refresh"),
        }),
      ]);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "null", packageJson: null },
    { label: "array", packageJson: [] },
    { label: "string", packageJson: "not a package" },
  ])("rejects a $label declared package manifest", async ({ label, packageJson }) => {
    const root = await makeFixtureRoot(`entry-non-object-${label}`);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      const installsPath = await writeDeclaredPackageFixture(root, JSON.stringify(packageJson));
      const report = await runPostUpgradeProbes({ installsPath });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "package.json",
          message: expect.stringContaining("package.json must contain a JSON object"),
        }),
      ]);
    } finally {
      stderrSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "non-object metadata",
      openclaw: "invalid",
      reason: "package.json openclaw must be an object",
    },
    {
      label: "non-array entries",
      openclaw: { extensions: "./dist/index.js" },
      reason: "package.json openclaw.extensions must be an array",
    },
    {
      label: "blank entries",
      openclaw: { extensions: ["  "] },
      reason: "package.json openclaw.extensions[0] must be a non-empty string",
    },
    {
      label: "non-string entries",
      openclaw: { extensions: [42] },
      reason: "package.json openclaw.extensions[0] must be a non-empty string",
    },
  ])(
    "reports $label through the canonical package contract",
    async ({ label, openclaw, reason }) => {
      const root = await makeFixtureRoot(`entry-invalid-${label.replaceAll(" ", "-")}`);
      try {
        const installsPath = await writeDeclaredPackageFixture(
          root,
          JSON.stringify({ name: "broken", openclaw }),
        );
        const report = await runPostUpgradeProbes({ installsPath });

        expect(report.findings).toEqual([
          expect.objectContaining({
            level: "error",
            code: "plugin.entry_unresolved",
            plugin: "broken",
            entry: "package.json",
            message: expect.stringContaining(reason),
          }),
        ]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reads the canonical SQLite plugin index by default", async () => {
    await withFixtureRoot("entry-sqlite", async (root) => {
      const pluginDir = path.join(root, "user-plugins", "sqlite-ghost");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "sqlite-ghost",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      await fs.writeFile(manifestPath, JSON.stringify({ id: "sqlite-ghost" }), "utf-8");
      const index: InstalledPluginIndex = {
        version: 1,
        hostContractVersion: "test-host",
        compatRegistryVersion: "test-compat",
        migrationVersion: 1,
        policyHash: "test-policy",
        generatedAtMs: 1,
        installRecords: {},
        plugins: [
          {
            pluginId: "sqlite-ghost",
            manifestPath,
            manifestHash: "manifest-hash",
            rootDir: pluginDir,
            origin: "global",
            enabled: true,
            startup: {
              sidecar: false,
              memory: false,
              agentHarnesses: [],
            },
            compat: [],
            packageJson: { path: "package.json", hash: "package-hash" },
          },
        ],
        diagnostics: [],
      };
      await writePersistedInstalledPluginIndex(index, { stateDir: root });

      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.findings).not.toContainEqual(
        expect.objectContaining({ code: "plugin.index_unavailable" }),
      );
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.plugin).toBe("sqlite-ghost");
    });
  });

  it("flags an enabled plugin whose declared entry does not exist on disk", async () => {
    await withFixtureRoot("entry-unresolved", async (root) => {
      const { installsPath } = await writePluginFixture(root, {
        id: "ghost",
        packageJson: {
          name: "ghost",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ghost");
      expect(finding?.entry).toBe("./dist/index.js");
    });
  });

  it("emits no entry_unresolved findings when the entry resolves", async () => {
    await withFixtureRoot("entry-ok", async (root) => {
      const { installsPath } = await writePluginFixture(root, {
        id: "good",
        packageJson: {
          name: "good",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
        files: { "dist/index.js": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });

  it("skips package entry validation for non-package registry records", async () => {
    await withFixtureRoot("no-package-json-ref", async (root) => {
      const { installsPath } = await writePluginFixture(root, {
        id: "runtime-only",
        location: "dist/extensions",
        origin: "bundled",
        files: { "index.js": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings).toHaveLength(0);
    });
  });

  it("validates legacy package records without packageJson metadata", async () => {
    await withFixtureRoot("legacy-package-json-ref", async (root) => {
      const { installsPath } = await writePluginFixture(root, {
        id: "legacy-package",
        packageJson: {
          name: "legacy-package",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
        includePackageJsonRecord: false,
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("legacy-package");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });

  it("flags an entry that escapes the plugin package directory", async () => {
    await withFixtureRoot("entry-escape", async (root) => {
      // Create a sibling file outside the plugin root that the entry resolves to.
      const outsideDir = path.join(root, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "leak.js"), "export default {};", "utf-8");
      const { installsPath } = await writePluginFixture(root, {
        id: "escape",
        packageJson: {
          name: "escape",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["../outside/leak.js"] },
        },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("escape");
      expect(finding?.message).toMatch(/escapes plugin directory/);
    });
  });

  it("accepts a TypeScript source entry that ships a compiled dist peer", async () => {
    await withFixtureRoot("ts-with-dist", async (root) => {
      // No explicit runtimeExtensions; the resolver should infer dist/index.js.
      const { installsPath } = await writePluginFixture(root, {
        id: "ts-dist",
        packageJson: {
          name: "ts-dist",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: {
          "src/index.ts": "export default {};",
          "dist/index.js": "export default {};",
        },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });

  it("flags a TypeScript source-only entry with no compiled output", async () => {
    await withFixtureRoot("ts-source-only", async (root) => {
      // Source exists, no dist peer — installed plugins must ship compiled JS.
      const { installsPath } = await writePluginFixture(root, {
        id: "ts-only",
        packageJson: {
          name: "ts-only",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-only");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });

  it("allows TypeScript source-only entries for source checkout plugin records", async () => {
    await withFixtureRoot("ts-source-checkout", async (root) => {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      const { installsPath } = await writePluginFixture(root, {
        id: "ts-source",
        location: "extensions",
        origin: "bundled",
        packageJson: {
          name: "ts-source",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });

  it("flags TypeScript source-only entries for packaged bundled plugin records", async () => {
    await withFixtureRoot("ts-packaged-bundled", async (root) => {
      const { installsPath } = await writePluginFixture(root, {
        id: "ts-packaged",
        location: "dist/extensions",
        origin: "bundled",
        packageJson: {
          name: "ts-packaged",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-packaged");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });

  it("flags a runtimeExtensions length mismatch", async () => {
    await withFixtureRoot("runtime-len-mismatch", async (root) => {
      const { installsPath } = await writePluginFixture(root, {
        id: "len-mismatch",
        packageJson: {
          name: "len-mismatch",
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./dist/a.js", "./dist/b.js"],
            runtimeExtensions: ["./dist/a.js"],
          },
        },
        files: {
          "dist/a.js": "export default {};",
          "dist/b.js": "export default {};",
        },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("len-mismatch");
      expect(finding?.message).toMatch(/runtimeExtensions length/);
    });
  });

  it("does not flag entry_unresolved when runtimeExtensions exists even if source entry is missing", async () => {
    await withFixtureRoot("runtime-extensions", async (root) => {
      // Source entry (./src/index.ts) does NOT exist
      // But runtime entry (./dist/index.js) DOES exist
      const { installsPath } = await writePluginFixture(root, {
        id: "runtime-only",
        packageJson: {
          name: "runtime-only",
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: { "dist/index.js": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });
});

describe("runPostUpgradeProbes — plugin.manifest_drift", () => {
  it("flags a plugin whose manifest hash differs from installs.json", async () => {
    await withFixtureRoot("manifest-drift", async (root) => {
      const oldManifestRaw = JSON.stringify({ id: "drifted", version: 1 });
      const oldManifestHash = crypto.createHash("sha256").update(oldManifestRaw).digest("hex");
      // Write a NEW manifest after installs.json was snapshotted.
      const { installsPath } = await writePluginFixture(root, {
        id: "drifted",
        packageJson: {
          name: "drifted",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
        files: { "dist/index.js": "export default {};" },
        manifest: { id: "drifted", version: 2 },
        manifestHash: oldManifestHash,
      });

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.manifest_drift");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("warn");
      expect(finding?.plugin).toBe("drifted");
    });
  });
});
