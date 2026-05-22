import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDockerPluginKeepList,
  pruneDockerPluginDist,
} from "../../scripts/prune-docker-plugin-dist.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeDistPluginFile(repoRoot: string, root: "dist" | "dist-runtime", pluginId: string) {
  const pluginDir = path.join(repoRoot, root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), "{}\n", "utf8");
}

function writePluginSourcePackage(repoRoot: string, pluginId: string) {
  const pluginDir = path.join(repoRoot, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
  });
}

function writeNodePackage(
  repoRoot: string,
  packageName: string,
  packageJson: Record<string, unknown> = {},
) {
  const packageDir = path.join(repoRoot, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version: "0.0.0",
    ...packageJson,
  });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("pruneDockerPluginDist", () => {
  it("parses space and comma separated Docker plugin keep lists", () => {
    expect([...parseDockerPluginKeepList("diagnostics-otel feishu,discord")]).toEqual([
      "diagnostics-otel",
      "feishu",
      "discord",
    ]);
  });

  it("removes package-excluded plugin runtime artifacts unless Docker explicitly opts it in", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-dist-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/diagnostics-otel/**", "!dist/extensions/feishu/**"],
    });
    writePluginSourcePackage(repoRoot, "diagnostics-otel");
    writePluginSourcePackage(repoRoot, "feishu");
    writePluginSourcePackage(repoRoot, "telegram");
    writeDistPluginFile(repoRoot, "dist", "diagnostics-otel");
    writeDistPluginFile(repoRoot, "dist", "feishu");
    writeDistPluginFile(repoRoot, "dist-runtime", "feishu");
    writeDistPluginFile(repoRoot, "dist", "telegram");

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "diagnostics-otel" } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual([
      "extensions/feishu",
      "dist/extensions/feishu",
      "dist-runtime/extensions/feishu",
    ]);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "diagnostics-otel"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "telegram"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "diagnostics-otel"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist-runtime", "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "telegram"))).toBe(true);
  });

  it("honors custom bundled plugin source roots when pruning Docker runtime importers", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-source-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/acpx/**"],
    });
    const pluginDir = path.join(repoRoot, "plugins", "acpx");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJsonFile(path.join(pluginDir, "package.json"), {
      name: "@openclaw/acpx",
      version: "0.0.0",
    });

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: {
        OPENCLAW_BUNDLED_PLUGIN_DIR: "plugins",
      } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual(["plugins/acpx"]);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("removes node_modules dependency closure that only omitted Docker plugins need", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-node-modules-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/acpx/**", "!dist/extensions/codex/**"],
      dependencies: {
        zod: "0.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "acpx", "package.json"), {
      name: "@openclaw/acpx",
      version: "0.0.0",
      dependencies: {
        "@zed-industries/codex-acp": "0.0.0",
        zod: "0.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "codex", "package.json"), {
      name: "@openclaw/codex",
      version: "0.0.0",
      dependencies: {
        "@openai/codex": "0.0.0",
        zod: "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "@openclaw/acpx");
    writeNodePackage(repoRoot, "@openclaw/codex");
    writeNodePackage(repoRoot, "zod");
    writeNodePackage(repoRoot, "@openai/codex", {
      optionalDependencies: {
        "@openai/codex-linux-x64": "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "@openai/codex-linux-x64");
    writeNodePackage(repoRoot, "@zed-industries/codex-acp", {
      optionalDependencies: {
        "@zed-industries/codex-acp-linux-x64": "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "@zed-industries/codex-acp-linux-x64");

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "codex" } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual([
      "node_modules/@openclaw/acpx",
      "node_modules/@zed-industries/codex-acp",
      "node_modules/@zed-industries/codex-acp-linux-x64",
      "extensions/acpx",
    ]);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "zod"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@openai", "codex"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@openai", "codex-linux-x64"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@zed-industries"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "codex"))).toBe(true);
  });
});
