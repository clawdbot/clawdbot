// Plugin install fixture helpers build generated bundle layouts for install tests.
import fs from "node:fs";
import path from "node:path";

type MakeTempDir = () => string;

type BundleFixtureFormat = "codex" | "claude" | "cursor";

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
    const manifestDir = path.join(
      pluginDir,
      params.bundleFormat === "codex"
        ? ".codex-plugin"
        : params.bundleFormat === "cursor"
          ? ".cursor-plugin"
          : ".claude-plugin",
    );
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, "plugin.json"),
      JSON.stringify({
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
    fs.writeFileSync(
      path.join(pluginDir, "skills", "SKILL.md"),
      "---\ndescription: fixture\n---\n",
      "utf-8",
    );
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
