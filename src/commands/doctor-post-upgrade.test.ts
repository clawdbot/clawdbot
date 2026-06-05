// Doctor post-upgrade tests cover upgrade sentinel handling, config/state repair, and plugin record migration.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";

async function makeFixtureRoot(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `doctor-post-upgrade-${prefix}-`));
}

describe("runPostUpgradeProbes — plugin.index_unavailable", () => {
  it("returns a structured finding when the installed plugin index is missing", async () => {
    const root = await makeFixtureRoot("index-missing");
    try {
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured finding when the installed plugin index is malformed", async () => {
    const root = await makeFixtureRoot("index-malformed");
    try {
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured finding when an installed plugin record is malformed", async () => {
    const root = await makeFixtureRoot("record-malformed");
    try {
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runPostUpgradeProbes — plugin.entry_unresolved", () => {
  it("reads the canonical SQLite plugin index by default", async () => {
    const root = await makeFixtureRoot("entry-sqlite");
    try {
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
              deferConfiguredChannelFullLoadUntilAfterListen: false,
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags an enabled plugin whose declared entry does not exist on disk", async () => {
    const root = await makeFixtureRoot("entry-unresolved");
    try {
      const pluginDir = path.join(root, "user-plugins", "ghost");
      await fs.mkdir(pluginDir, { recursive: true });
      // Plugin package.json declares ./dist/index.js but no dist/.
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "ghost",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "ghost" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "ghost",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ghost");
      expect(finding?.entry).toBe("./dist/index.js");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits no entry_unresolved findings when the entry resolves", async () => {
    const root = await makeFixtureRoot("entry-ok");
    try {
      const pluginDir = path.join(root, "user-plugins", "good");
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "dist", "index.js"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "good",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "good" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "good",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips package entry validation for non-package registry records", async () => {
    const root = await makeFixtureRoot("no-package-json-ref");
    try {
      const pluginDir = path.join(root, "dist", "extensions", "runtime-only");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, "index.js"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "runtime-only" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "runtime-only",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              origin: "bundled",
              enabled: true,
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("validates legacy package records without packageJson metadata", async () => {
    const root = await makeFixtureRoot("legacy-package-json-ref");
    try {
      const pluginDir = path.join(root, "user-plugins", "legacy-package");
      await fs.mkdir(path.join(pluginDir, "src"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "src", "index.ts"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "legacy-package",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "legacy-package" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "legacy-package",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("legacy-package");
      expect(finding?.message).toMatch(/compiled runtime output/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags an entry that escapes the plugin package directory", async () => {
    const root = await makeFixtureRoot("entry-escape");
    try {
      const pluginDir = path.join(root, "user-plugins", "escape");
      await fs.mkdir(pluginDir, { recursive: true });
      // Create a sibling file outside the plugin root that the entry resolves to.
      const outsideDir = path.join(root, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "leak.js"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "escape",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["../outside/leak.js"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "escape" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "escape",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("escape");
      expect(finding?.message).toMatch(/escapes plugin directory/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a TypeScript source entry that ships a compiled dist peer", async () => {
    const root = await makeFixtureRoot("ts-with-dist");
    try {
      const pluginDir = path.join(root, "user-plugins", "ts-dist");
      await fs.mkdir(path.join(pluginDir, "src"), { recursive: true });
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "src", "index.ts"), "export default {};", "utf-8");
      await fs.writeFile(path.join(pluginDir, "dist", "index.js"), "export default {};", "utf-8");
      // No explicit runtimeExtensions; the resolver should infer dist/index.js.
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "ts-dist",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "ts-dist" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "ts-dist",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags a TypeScript source-only entry with no compiled output", async () => {
    const root = await makeFixtureRoot("ts-source-only");
    try {
      const pluginDir = path.join(root, "user-plugins", "ts-only");
      await fs.mkdir(path.join(pluginDir, "src"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "src", "index.ts"), "export default {};", "utf-8");
      // Source exists, no dist peer — installed plugins must ship compiled JS.
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "ts-only",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "ts-only" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "ts-only",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-only");
      expect(finding?.message).toMatch(/compiled runtime output/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows TypeScript source-only entries for source checkout plugin records", async () => {
    const root = await makeFixtureRoot("ts-source-checkout");
    try {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      const pluginDir = path.join(root, "extensions", "ts-source");
      await fs.mkdir(path.join(pluginDir, "src"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "src", "index.ts"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "ts-source",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "ts-source" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "ts-source",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              origin: "bundled",
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags TypeScript source-only entries for packaged bundled plugin records", async () => {
    const root = await makeFixtureRoot("ts-packaged-bundled");
    try {
      const pluginDir = path.join(root, "dist", "extensions", "ts-packaged");
      await fs.mkdir(path.join(pluginDir, "src"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "src", "index.ts"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "ts-packaged",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "ts-packaged" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "ts-packaged",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              origin: "bundled",
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-packaged");
      expect(finding?.message).toMatch(/compiled runtime output/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("flags a runtimeExtensions length mismatch", async () => {
    const root = await makeFixtureRoot("runtime-len-mismatch");
    try {
      const pluginDir = path.join(root, "user-plugins", "len-mismatch");
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "dist", "a.js"), "export default {};", "utf-8");
      await fs.writeFile(path.join(pluginDir, "dist", "b.js"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "len-mismatch",
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./dist/a.js", "./dist/b.js"],
            runtimeExtensions: ["./dist/a.js"],
          },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "len-mismatch" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "len-mismatch",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("len-mismatch");
      expect(finding?.message).toMatch(/runtimeExtensions length/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not flag entry_unresolved when runtimeExtensions exists even if source entry is missing", async () => {
    const root = await makeFixtureRoot("runtime-extensions");
    try {
      const pluginDir = path.join(root, "user-plugins", "runtime-only");
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "dist", "index.js"), "export default {};", "utf-8");
      // Source entry (./src/index.ts) does NOT exist
      // But runtime entry (./dist/index.js) DOES exist
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "runtime-only",
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "runtime-only" }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "runtime-only",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runPostUpgradeProbes — plugin.manifest_drift", () => {
  it("flags a plugin whose manifest hash differs from installs.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-post-upgrade-manifest-drift-"));
    try {
      const pluginDir = path.join(root, "user-plugins", "drifted");
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "dist", "index.js"), "export default {};", "utf-8");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "drifted",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );

      const oldManifestRaw = JSON.stringify({ id: "drifted", version: 1 });
      const oldManifestHash = crypto.createHash("sha256").update(oldManifestRaw).digest("hex");
      // Write a NEW manifest after installs.json was snapshotted.
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "drifted", version: 2 }),
        "utf-8",
      );

      const installsPath = path.join(root, "plugins", "installs.json");
      await fs.mkdir(path.dirname(installsPath), { recursive: true });
      await fs.writeFile(
        installsPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              pluginId: "drifted",
              manifestPath: path.join(pluginDir, "openclaw.plugin.json"),
              manifestHash: oldManifestHash,
              rootDir: pluginDir,
              enabled: true,
              packageJson: { path: "package.json" },
            },
          ],
        }),
        "utf-8",
      );

      const report = await runPostUpgradeProbes({ installsPath });
      const finding = report.findings.find((f) => f.code === "plugin.manifest_drift");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("warn");
      expect(finding?.plugin).toBe("drifted");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
