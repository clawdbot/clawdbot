import { spawnSync } from "node:child_process";
import fs, { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFilePath);
const repoRoot = path.resolve(thisDir, "../../..");
const loadConfigPattern = /\b(?:getRuntimeConfig|config\.getRuntimeConfig)\s*\(/;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function readRepoFile(relativePath: string): string {
  const absolute = path.join(repoRoot, relativePath);
  return readFileSync(absolute, "utf8");
}

function listGitFiles(pathspecs: string[]): string[] | null {
  const result = spawnSync("git", ["ls-files", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(toPosix)
    .toSorted();
}

function listFindFiles(args: string[]): string[] | null {
  const result = spawnSync("find", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => path.relative(repoRoot, file))
    .map(toPosix)
    .toSorted();
}

function listCoreOutboundEntryFiles(): string[] {
  const externalFiles =
    listGitFiles(["src/channels/plugins/outbound/*.ts"]) ??
    listFindFiles([
      path.join(repoRoot, "src/channels/plugins/outbound"),
      "-maxdepth",
      "1",
      "-type",
      "f",
      "-name",
      "*.ts",
    ]);
  if (externalFiles) {
    return externalFiles
      .filter((file) => !file.endsWith(".test.ts"))
      .map(toPosix)
      .toSorted();
  }

  const outboundDir = path.join(repoRoot, "src/channels/plugins/outbound");
  return fs
    .readdirSync(outboundDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => toPosix(path.join("src/channels/plugins/outbound", name)))
    .toSorted();
}

function listExtensionFiles(): {
  adapterEntrypoints: string[];
  inlineChannelEntrypoints: string[];
} {
  const externalFiles =
    listGitFiles(["extensions/*/src/outbound.ts", "extensions/*/src/channel.ts"]) ??
    listFindFiles([
      path.join(repoRoot, "extensions"),
      "-path",
      "*/src/outbound.ts",
      "-o",
      "-path",
      "*/src/channel.ts",
    ]);
  if (externalFiles) {
    return partitionExtensionEntrypoints(externalFiles);
  }

  const extensionsRoot = path.join(repoRoot, "extensions");
  const adapterEntrypoints: string[] = [];
  const inlineChannelEntrypoints: string[] = [];

  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const srcDir = path.join(extensionsRoot, entry.name, "src");
    const outboundPath = path.join(srcDir, "outbound.ts");
    if (existsSync(outboundPath)) {
      adapterEntrypoints.push(toPosix(path.join("extensions", entry.name, "src/outbound.ts")));
    }

    const channelPath = path.join(srcDir, "channel.ts");
    if (!existsSync(channelPath)) {
      continue;
    }
    const source = readFileSync(channelPath, "utf8");
    if (/\boutbound\s*:\s*\{/.test(source)) {
      inlineChannelEntrypoints.push(toPosix(path.join("extensions", entry.name, "src/channel.ts")));
    }
  }

  return {
    adapterEntrypoints: adapterEntrypoints.toSorted(),
    inlineChannelEntrypoints: inlineChannelEntrypoints.toSorted(),
  };
}

function partitionExtensionEntrypoints(files: string[]): {
  adapterEntrypoints: string[];
  inlineChannelEntrypoints: string[];
} {
  const adapterEntrypoints: string[] = [];
  const inlineChannelEntrypoints: string[] = [];

  for (const file of files) {
    if (file.endsWith("/src/outbound.ts")) {
      adapterEntrypoints.push(file);
      continue;
    }
    if (!file.endsWith("/src/channel.ts")) {
      continue;
    }
    const source = readRepoFile(file);
    if (/\boutbound\s*:\s*\{/.test(source)) {
      inlineChannelEntrypoints.push(file);
    }
  }

  return {
    adapterEntrypoints: adapterEntrypoints.toSorted(),
    inlineChannelEntrypoints: inlineChannelEntrypoints.toSorted(),
  };
}

function listHighRiskRuntimeCfgFiles(): string[] {
  return [
    bundledPluginFile("telegram", "src/action-runtime.ts"),
    bundledPluginFile("discord", "src/monitor/reply-delivery.ts"),
    bundledPluginFile("discord", "src/monitor/thread-bindings.discord-api.ts"),
    bundledPluginFile("discord", "src/monitor/thread-bindings.manager.ts"),
  ];
}

function extractOutboundBlock(source: string, file: string): string {
  const outboundKeyIndex = source.indexOf("outbound:");
  expect(outboundKeyIndex, `${file} should define outbound:`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", outboundKeyIndex);
  expect(braceStart, `${file} should define outbound object`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let state: "code" | "single" | "double" | "template" | "lineComment" | "blockComment" = "code";
  for (let i = braceStart; i < source.length; i += 1) {
    const current = source[i];
    const next = source[i + 1];

    if (state === "lineComment") {
      if (current === "\n") {
        state = "code";
      }
      continue;
    }
    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state === "single") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      if (current === "'") {
        state = "code";
      }
      continue;
    }
    if (state === "double") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      if (current === '"') {
        state = "code";
      }
      continue;
    }
    if (state === "template") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      if (current === "`") {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "lineComment";
      i += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "blockComment";
      i += 1;
      continue;
    }
    if (current === "'") {
      state = "single";
      continue;
    }
    if (current === '"') {
      state = "double";
      continue;
    }
    if (current === "`") {
      state = "template";
      continue;
    }
    if (current === "{") {
      depth += 1;
      continue;
    }
    if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }

  throw new Error(`Unable to parse outbound block in ${file}`);
}

describe("outbound cfg-threading guard", () => {
  it("lists outbound entrypoints without scanning directories in-process", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const coreAdapterFiles = listCoreOutboundEntryFiles();
      const extensionFiles = listExtensionFiles();

      expect(coreAdapterFiles.length).toBeGreaterThan(0);
      expect(extensionFiles.adapterEntrypoints.length).toBeGreaterThan(0);
      expect(
        coreAdapterFiles.every((file) =>
          file.startsWith("src/channels/plugins/outbound/") && file.endsWith(".ts"),
        ),
      ).toBe(true);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it("keeps outbound adapter entrypoints free of getRuntimeConfig calls", () => {
    const coreAdapterFiles = listCoreOutboundEntryFiles();
    const extensionAdapterFiles = listExtensionFiles().adapterEntrypoints;
    const adapterFiles = [...coreAdapterFiles, ...extensionAdapterFiles];

    for (const file of adapterFiles) {
      const source = readRepoFile(file);
      expect(source, `${file} must not call getRuntimeConfig in outbound entrypoint`).not.toMatch(
        loadConfigPattern,
      );
    }
  });

  it("keeps inline channel outbound blocks free of getRuntimeConfig calls", () => {
    const inlineFiles = listExtensionFiles().inlineChannelEntrypoints;
    for (const file of inlineFiles) {
      const source = readRepoFile(file);
      const outboundBlock = extractOutboundBlock(source, file);
      expect(outboundBlock, `${file} outbound block must not call getRuntimeConfig`).not.toMatch(
        loadConfigPattern,
      );
    }
  });

  it("keeps high-risk runtime delivery paths free of getRuntimeConfig calls", () => {
    const runtimeFiles = listHighRiskRuntimeCfgFiles();
    for (const file of runtimeFiles) {
      const source = readRepoFile(file);
      expect(source, `${file} must not call getRuntimeConfig`).not.toMatch(loadConfigPattern);
    }
  });
});
