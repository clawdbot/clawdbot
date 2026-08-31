/** Verifies Docker packaging prunes plugin dist artifacts to the supported runtime surface. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDockerPluginKeepList,
  pruneDockerPluginDist,
} from "../../scripts/prune-docker-plugin-dist.mjs";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";

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
  importerDir = repoRoot,
) {
  const packageDir = path.join(importerDir, "node_modules", ...packageName.split("/"));
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
      peerDependencies: {
        vitest: "0.0.0",
      },
      peerDependenciesMeta: {
        vitest: { optional: true },
      },
    });
    writeNodePackage(repoRoot, "@zed-industries/codex-acp-linux-x64");
    writeNodePackage(repoRoot, "vitest", {
      dependencies: {
        vite: "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "vite", {
      dependencies: {
        postcss: "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "postcss");

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "codex" } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual([
      "node_modules/@openclaw/acpx",
      "node_modules/@zed-industries/codex-acp",
      "node_modules/@zed-industries/codex-acp-linux-x64",
      "node_modules/postcss",
      "node_modules/vite",
      "node_modules/vitest",
      "extensions/acpx",
    ]);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "zod"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@openai", "codex"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@openai", "codex-linux-x64"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@zed-industries"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "vitest"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "codex"))).toBe(true);
  });

  it("keeps root-hoisted transitives used through a kept plugin's nested dependency", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-workspace-importer-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/omitted-client/**"],
      dependencies: {
        "shared-client": "1.0.0",
      },
    });
    const keptPluginDir = path.join(repoRoot, "extensions", "kept-client");
    writeJsonFile(path.join(keptPluginDir, "package.json"), {
      name: "@openclaw/kept-client",
      version: "0.0.0",
      dependencies: {
        "shared-client": "2.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "omitted-client", "package.json"), {
      name: "@openclaw/omitted-client",
      version: "0.0.0",
      dependencies: {
        "kept-transitive": "1.0.0",
      },
    });

    writeNodePackage(repoRoot, "shared-client", { version: "1.0.0" });
    writeNodePackage(
      repoRoot,
      "shared-client",
      {
        version: "2.0.0",
        dependencies: { "kept-transitive": "1.0.0" },
      },
      keptPluginDir,
    );
    writeNodePackage(repoRoot, "kept-transitive", { version: "1.0.0" });
    fs.writeFileSync(
      path.join(keptPluginDir, "index.js"),
      'module.exports = require("shared-client");\n',
    );
    fs.writeFileSync(
      path.join(keptPluginDir, "node_modules", "shared-client", "index.js"),
      'module.exports = require("kept-transitive");\n',
    );
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "kept-transitive", "index.js"),
      "module.exports = {};\n",
    );

    const removed = pruneDockerPluginDist({ repoRoot, env: {} as NodeJS.ProcessEnv });

    expect(removed).toEqual(["extensions/omitted-client"]);
    const requireFromKeptPlugin = createRequire(path.join(keptPluginDir, "package.json"));
    expect(() => requireFromKeptPlugin("./index.js")).not.toThrow();
  });

  it("keeps transitive dependencies resolved through nested package versions", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-nested-dependencies-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/optional-client/**"],
      dependencies: {
        grammy: "1.45.1",
        "modern-client": "1.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "optional-client", "package.json"), {
      name: "@openclaw/optional-client",
      version: "0.0.0",
      dependencies: {
        "whatwg-url": "16.0.1",
      },
    });

    writeNodePackage(repoRoot, "grammy", {
      dependencies: { "node-fetch": "2.7.0" },
    });
    writeNodePackage(repoRoot, "modern-client", {
      dependencies: { "node-fetch": "3.3.2" },
    });
    writeNodePackage(repoRoot, "node-fetch", { version: "3.3.2" });
    writeNodePackage(repoRoot, "whatwg-url", {
      version: "16.0.1",
      dependencies: { tr46: "6.0.0" },
    });
    writeNodePackage(repoRoot, "tr46", { version: "0.0.3" });

    const grammyDir = path.join(repoRoot, "node_modules", "grammy");
    writeNodePackage(
      repoRoot,
      "node-fetch",
      {
        version: "2.7.0",
        dependencies: { "whatwg-url": "5.0.0" },
      },
      grammyDir,
    );
    writeNodePackage(
      repoRoot,
      "whatwg-url",
      {
        version: "5.0.0",
        dependencies: { tr46: "0.0.3" },
      },
      grammyDir,
    );
    writeNodePackage(
      repoRoot,
      "tr46",
      { version: "6.0.0" },
      path.join(repoRoot, "node_modules", "whatwg-url"),
    );
    fs.writeFileSync(path.join(grammyDir, "index.js"), 'module.exports = require("node-fetch");\n');
    fs.writeFileSync(
      path.join(grammyDir, "node_modules", "node-fetch", "index.js"),
      'module.exports = require("whatwg-url");\n',
    );
    fs.writeFileSync(
      path.join(grammyDir, "node_modules", "whatwg-url", "index.js"),
      'module.exports = require("tr46");\n',
    );
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "tr46", "index.js"),
      "module.exports = {};\n",
    );

    const removed = pruneDockerPluginDist({ repoRoot, env: {} as NodeJS.ProcessEnv });

    expect(removed).toEqual(["node_modules/whatwg-url", "extensions/optional-client"]);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "tr46"))).toBe(true);
    const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
    expect(() => requireFromRepo("grammy")).not.toThrow();
  });
});
