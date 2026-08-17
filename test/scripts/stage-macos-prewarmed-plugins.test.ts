import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyPreparedMacOSPlugins,
  selectMacOSPrewarmedPlugins,
  type MacOSPrewarmedPlugin,
} from "../../scripts/stage-macos-prewarmed-plugins.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeExtension(params: {
  root: string;
  dirName: string;
  id: string;
  packageName: string;
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: string[];
  version?: string;
}): void {
  const extensionDir = path.join(params.root, "extensions", params.dirName);
  writeJson(path.join(extensionDir, "openclaw.plugin.json"), {
    id: params.id,
    ...(params.enabledByDefault === undefined ? {} : { enabledByDefault: params.enabledByDefault }),
    ...(params.enabledByDefaultOnPlatforms
      ? { enabledByDefaultOnPlatforms: params.enabledByDefaultOnPlatforms }
      : {}),
  });
  writeJson(path.join(extensionDir, "package.json"), {
    name: params.packageName,
    version: params.version ?? "2026.8.1",
    openclaw: { release: { publishToNpm: true } },
  });
}

describe("selectMacOSPrewarmedPlugins", () => {
  it("selects macOS defaults and the on-demand Codex runtime", () => {
    const root = tempDirs.make("openclaw-macos-prewarm-selection-");
    writeJson(path.join(root, "package.json"), {
      version: "2026.8.1",
      files: [
        "dist/",
        "!dist/extensions/always/**",
        "!dist/extensions/darwin/**",
        "!dist/extensions/off/**",
        "!dist/extensions/codex/**",
      ],
    });
    writeExtension({
      root,
      dirName: "always",
      id: "always",
      packageName: "@openclaw/always",
      enabledByDefault: true,
    });
    writeExtension({
      root,
      dirName: "darwin",
      id: "darwin",
      packageName: "@openclaw/darwin",
      enabledByDefaultOnPlatforms: ["darwin"],
    });
    writeExtension({
      root,
      dirName: "off",
      id: "off",
      packageName: "@openclaw/off",
      enabledByDefault: false,
    });
    writeExtension({
      root,
      dirName: "codex",
      id: "codex",
      packageName: "@openclaw/codex",
      enabledByDefault: false,
    });
    writeExtension({
      root,
      dirName: "core",
      id: "core",
      packageName: "@openclaw/core",
      enabledByDefault: true,
    });

    expect(selectMacOSPrewarmedPlugins(root).map((plugin) => plugin.id)).toEqual([
      "always",
      "codex",
      "darwin",
    ]);
  });

  it("selects the current checkout defaults plus on-demand Codex", () => {
    const selected = selectMacOSPrewarmedPlugins(process.cwd());

    expect(selected).toHaveLength(45);
    expect(selected.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        "acpx",
        "google-meet",
        "opencode",
        "teams-meetings",
        "zoom-meetings",
      ]),
    );
    expect(selected.some((plugin) => plugin.id === "codex")).toBe(true);
  });
});

describe("copyPreparedMacOSPlugins", () => {
  it("copies a prepared package with its nested dependency tree into bundled extensions", () => {
    const root = tempDirs.make("openclaw-macos-prewarm-copy-");
    const runtimeRoot = path.join(root, "runtime");
    const vendorNodeModulesDir = path.join(root, "vendor", "node_modules");
    const packageDir = path.join(vendorNodeModulesDir, "@openclaw", "demo");
    const plugin: MacOSPrewarmedPlugin = {
      dirName: "demo-source-dir",
      id: "demo",
      packageDir: path.join(root, "source", "demo-source-dir"),
      packageName: "@openclaw/demo",
      version: "2026.8.1",
    };
    fs.mkdirSync(path.join(runtimeRoot, "dist", "extensions", "node_modules", "openclaw"), {
      recursive: true,
    });
    writeJson(path.join(packageDir, "openclaw.plugin.json"), {
      id: "demo",
      enabledByDefault: true,
    });
    writeJson(path.join(packageDir, "package.json"), {
      name: "@openclaw/demo",
      version: "2026.8.1",
      peerDependencies: { openclaw: "*" },
      openclaw: { runtimeExtensions: ["./dist/index.js"] },
    });
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export default {};\n");
    writeJson(path.join(packageDir, "node_modules", "nested-dependency", "package.json"), {
      name: "nested-dependency",
      version: "1.0.0",
    });

    copyPreparedMacOSPlugins({ plugins: [plugin], runtimeRoot, vendorNodeModulesDir });

    const stagedDir = path.join(runtimeRoot, "dist", "extensions", "demo-source-dir");
    expect(fs.existsSync(path.join(stagedDir, "dist", "index.js"))).toBe(true);
    expect(
      fs.existsSync(path.join(stagedDir, "node_modules", "nested-dependency", "package.json")),
    ).toBe(true);
    expect(fs.realpathSync(path.join(stagedDir, "node_modules", "openclaw"))).toBe(
      fs.realpathSync(runtimeRoot),
    );
    expect(
      fs.existsSync(path.join(runtimeRoot, "dist", "extensions", "node_modules", "openclaw")),
    ).toBe(true);
  });
});
