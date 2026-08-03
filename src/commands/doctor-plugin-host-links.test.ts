import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import {
  detectPluginRegistryHealthIssues,
  maybeRepairPluginRegistryState,
  pluginRegistryIssueToHealthFinding,
  pluginRegistryIssueToRepairEffect,
} from "./doctor-plugin-registry.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.mocked(note).mockReset();
});

function makeStateDir(): string {
  return tempDirs.make("openclaw-doctor-plugin-host-links-");
}

function createRegisteredExtensionPlugin(params: {
  stateDir: string;
  dependencyField?: "peerDependencies" | "dependencies";
  pluginId?: string;
  packageDir?: string;
  nestedPackageName?: string;
}) {
  const pluginId = params.pluginId ?? "email";
  const packageDir = params.packageDir ?? path.join(params.stateDir, "extensions", pluginId);
  const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
  fs.mkdirSync(staleHostDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: `@clawemail/${pluginId}`,
      version: "2026.7.1",
      [params.dependencyField ?? "peerDependencies"]: { openclaw: ">=2026.7.1" },
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), "export default {};\n");
  fs.writeFileSync(
    path.join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema: { type: "object" } }),
  );
  fs.writeFileSync(
    path.join(staleHostDir, "package.json"),
    JSON.stringify({
      name: params.nestedPackageName ?? "openclaw",
      version: "2026.7.1-beta.2",
    }),
  );
  return { packageDir, staleHostDir };
}

function createNpmInstallRecord(pluginId: string, packageDir: string): PluginInstallRecord {
  const packageName = `@clawemail/${pluginId}`;
  return {
    source: "npm",
    spec: `${packageName}@2026.7.1`,
    installPath: packageDir,
    version: "2026.7.1",
    resolvedName: packageName,
    resolvedVersion: "2026.7.1",
    resolvedSpec: `${packageName}@2026.7.1`,
  };
}

async function writeInstallRecords(
  stateDir: string,
  installRecords: Record<string, PluginInstallRecord>,
): Promise<void> {
  await writePersistedInstalledPluginIndexInstallRecords(installRecords, {
    stateDir,
    candidates: [],
  });
}

function createDoctorParams(stateDir: string, shouldRepair: boolean) {
  return {
    stateDir,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    },
    config: {},
    prompter: { shouldRepair },
  };
}

describe("doctor registered npm plugin host links", () => {
  it.each(["peerDependencies", "dependencies"] as const)(
    "repairs a stale copied host for a registered extensions-root %s plugin",
    async (dependencyField) => {
      const stateDir = makeStateDir();
      const { packageDir, staleHostDir } = createRegisteredExtensionPlugin({
        stateDir,
        dependencyField,
      });
      await writeInstallRecords(stateDir, {
        email: createNpmInstallRecord("email", packageDir),
      });

      await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

      expect(fs.lstatSync(staleHostDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(staleHostDir)).toBe(fs.realpathSync(process.cwd()));
      expect(vi.mocked(note).mock.calls.join("\n")).toContain("OpenClaw host peer link");
    },
  );

  it("reports a stale registered extensions-root host without changing it in read-only doctor", async () => {
    const stateDir = makeStateDir();
    const { packageDir, staleHostDir } = createRegisteredExtensionPlugin({ stateDir });
    await writeInstallRecords(stateDir, {
      email: createNpmInstallRecord("email", packageDir),
    });

    const params = createDoctorParams(stateDir, false);
    const issues = await detectPluginRegistryHealthIssues(params);
    await maybeRepairPluginRegistryState(params);

    const issue = expectDefined(
      issues.find((entry) => entry.kind === "registered-npm-openclaw-host-link"),
      "registered npm host-link issue",
    );
    expect(issue).toMatchObject({ packageDir, packageName: "email" });
    expect(pluginRegistryIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/plugin-registry",
      path: packageDir,
      target: "email",
    });
    expect(pluginRegistryIssueToRepairEffect(issue)).toEqual({
      kind: "package",
      action: "would-relink-registered-npm-openclaw-host",
      target: packageDir,
      dryRunSafe: false,
    });
    expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
    expect(vi.mocked(note).mock.calls.join("\n")).toContain("email");
  });

  it("does not repair a developer-controlled path install under the extensions root", async () => {
    const stateDir = makeStateDir();
    const { packageDir, staleHostDir } = createRegisteredExtensionPlugin({ stateDir });
    await writeInstallRecords(stateDir, {
      email: { source: "path", installPath: packageDir },
    });

    await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

    expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(staleHostDir, "package.json"), "utf8"))).toEqual({
      name: "openclaw",
      version: "2026.7.1-beta.2",
    });
  });

  it("does not repair an npm install recorded outside the operator-owned plugin roots", async () => {
    const stateDir = makeStateDir();
    const { packageDir, staleHostDir } = createRegisteredExtensionPlugin({
      stateDir,
      packageDir: path.join(stateDir, "external-owner", "email"),
    });
    await writeInstallRecords(stateDir, {
      email: createNpmInstallRecord("email", packageDir),
    });

    await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

    expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a registered extensions-root package symlink outside its owner root",
    async () => {
      const stateDir = makeStateDir();
      const outsideDir = path.join(stateDir, "external-owner", "email");
      const { staleHostDir } = createRegisteredExtensionPlugin({
        stateDir,
        packageDir: outsideDir,
      });
      const packageDir = path.join(stateDir, "extensions", "email");
      fs.mkdirSync(path.dirname(packageDir), { recursive: true });
      fs.symlinkSync(outsideDir, packageDir, "dir");
      await writeInstallRecords(stateDir, {
        email: createNpmInstallRecord("email", packageDir),
      });

      await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

      expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not mutate a developer-owned sibling through a registered in-root package alias",
    async () => {
      const stateDir = makeStateDir();
      const developerPackageDir = path.join(stateDir, "extensions", "local-project");
      const developerPlugin = createRegisteredExtensionPlugin({
        stateDir,
        packageDir: developerPackageDir,
      });
      const packageDir = path.join(stateDir, "extensions", "email");
      fs.symlinkSync(developerPackageDir, packageDir, "dir");
      await writeInstallRecords(stateDir, {
        email: createNpmInstallRecord("email", packageDir),
      });

      await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

      expect(fs.lstatSync(developerPlugin.staleHostDir).isDirectory()).toBe(true);
    },
  );

  it("does not delete an unrelated copied package while repairing a registered install", async () => {
    const stateDir = makeStateDir();
    const { packageDir, staleHostDir } = createRegisteredExtensionPlugin({
      stateDir,
      nestedPackageName: "not-openclaw",
    });
    await writeInstallRecords(stateDir, {
      email: createNpmInstallRecord("email", packageDir),
    });

    await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

    expect(JSON.parse(fs.readFileSync(path.join(staleHostDir, "package.json"), "utf8"))).toEqual({
      name: "not-openclaw",
      version: "2026.7.1-beta.2",
    });
  });

  it("reports a malformed registered package and still repairs its valid sibling", async () => {
    const stateDir = makeStateDir();
    const broken = createRegisteredExtensionPlugin({ stateDir, pluginId: "broken" });
    const email = createRegisteredExtensionPlugin({ stateDir });
    fs.writeFileSync(path.join(broken.packageDir, "package.json"), "{", "utf8");
    await writeInstallRecords(stateDir, {
      broken: createNpmInstallRecord("broken", broken.packageDir),
      email: createNpmInstallRecord("email", email.packageDir),
    });

    const issues = await detectPluginRegistryHealthIssues(createDoctorParams(stateDir, false));
    await maybeRepairPluginRegistryState(createDoctorParams(stateDir, true));

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "registered-npm-package-unreadable",
          packageDir: broken.packageDir,
        }),
        expect.objectContaining({
          kind: "registered-npm-openclaw-host-link",
          packageDir: email.packageDir,
        }),
      ]),
    );
    expect(fs.lstatSync(broken.staleHostDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(email.staleHostDir).isSymbolicLink()).toBe(true);
    expect(vi.mocked(note).mock.calls.join("\n")).toContain("Could not inspect registered npm");
  });
});
