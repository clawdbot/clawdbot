// Plugin install fixture helpers build generated bundle layouts for install tests.
import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "../../test-utils/temp-dir.js";
import type { PluginInstallArtifactConsentHandler } from "../install-types.js";
import { createColdPluginFixture } from "./cold-plugin-fixtures.js";

type MakeTempDir = () => string;

type BundleFixtureFormat = "agent" | "codex" | "claude" | "cursor";

type PluginArtifactInstallMockParams = {
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
};

export async function invokePluginArtifactInstallMock<
  TResult extends { ok: boolean; pluginId?: string; version?: string },
>(
  mock: unknown,
  params: PluginArtifactInstallMockParams,
  fixture?: { manifest?: Record<string, unknown> },
): Promise<TResult> {
  const result = await (mock as (params: PluginArtifactInstallMockParams) => Promise<TResult>)(
    params,
  );
  const reviewArtifact = params.onBeforePluginArtifactCommit;
  const pluginId = result.pluginId;
  if (
    !result.ok ||
    !pluginId ||
    !reviewArtifact ||
    params.dryRun ||
    (params.expectedPluginId && params.expectedPluginId !== pluginId)
  ) {
    return result;
  }
  return await withTempDir("openclaw-plugin-staged-", async (rootDir) => {
    const stagedArtifactDir = fs.realpathSync(rootDir);
    createColdPluginFixture({
      rootDir: stagedArtifactDir,
      pluginId,
      ...(result.version ? { packageVersion: result.version } : {}),
      ...(fixture?.manifest ? { manifest: fixture.manifest } : {}),
    });
    await reviewArtifact({
      pluginId,
      stagedArtifactDir,
      mode: params.mode ?? "install",
    });
    return result;
  });
}

export function createBundleInstallFixtureFactory(makeTempDir: MakeTempDir) {
  return function setupBundleInstallFixture(params: {
    bundleFormat: BundleFixtureFormat;
    name: string;
  }) {
    const caseDir = makeTempDir();
    const stateDir = path.join(caseDir, "state");
    const pluginDir = path.join(caseDir, "plugin-src");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
    const manifestRelativePath =
      params.bundleFormat === "agent"
        ? "plugin.json"
        : path.join(
            params.bundleFormat === "codex"
              ? ".codex-plugin"
              : params.bundleFormat === "cursor"
                ? ".cursor-plugin"
                : ".claude-plugin",
            "plugin.json",
          );
    fs.mkdirSync(path.dirname(path.join(pluginDir, manifestRelativePath)), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, manifestRelativePath),
      JSON.stringify({
        ...(params.bundleFormat === "agent"
          ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" }
          : {}),
        name: params.name,
        description: `${params.bundleFormat} bundle fixture`,
        ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
      }),
      "utf-8",
    );
    if (params.bundleFormat === "cursor") {
      fs.mkdirSync(path.join(pluginDir, ".cursor", "commands"), { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, ".cursor", "commands", "review.md"),
        "---\ndescription: fixture\n---\n",
        "utf-8",
      );
    }
    const skillDir = path.join(
      pluginDir,
      "skills",
      ...(params.bundleFormat === "agent" ? ["fixture"] : []),
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: fixture\n---\n", "utf-8");
    return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
  };
}

export function createDualFormatInstallFixtureFactory(makeTempDir: MakeTempDir) {
  return function setupDualFormatInstallFixture(params: { bundleFormat: "codex" | "claude" }) {
    const caseDir = makeTempDir();
    const stateDir = path.join(caseDir, "state");
    const pluginDir = path.join(caseDir, "plugin-src");
    fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
    const manifestDir = path.join(
      pluginDir,
      params.bundleFormat === "codex" ? ".codex-plugin" : ".claude-plugin",
    );
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/native-dual",
        version: "0.0.1",
        openclaw: { extensions: ["./dist/index.js"] },
        dependencies: { "left-pad": "1.3.0" },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "native-dual",
        configSchema: { type: "object", properties: {} },
        skills: ["skills"],
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export {};", "utf-8");
    fs.writeFileSync(
      path.join(pluginDir, "skills", "SKILL.md"),
      "---\ndescription: fixture\n---\n",
    );
    fs.writeFileSync(
      path.join(manifestDir, "plugin.json"),
      JSON.stringify({
        name: "Bundle Fallback",
        ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
      }),
      "utf-8",
    );
    return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
  };
}
