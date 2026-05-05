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

  it("removes package-excluded plugin dist unless Docker explicitly opts it in", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-dist-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/diagnostics-otel/**", "!dist/extensions/feishu/**"],
    });
    writeDistPluginFile(repoRoot, "dist", "diagnostics-otel");
    writeDistPluginFile(repoRoot, "dist", "feishu");
    writeDistPluginFile(repoRoot, "dist-runtime", "feishu");
    writeDistPluginFile(repoRoot, "dist", "telegram");

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "diagnostics-otel" } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual(["dist/extensions/feishu", "dist-runtime/extensions/feishu"]);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "diagnostics-otel"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist-runtime", "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "telegram"))).toBe(true);
  });
});
