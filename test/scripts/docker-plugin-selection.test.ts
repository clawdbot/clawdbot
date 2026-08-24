import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const selectorScript = path.join(repoRoot, "scripts/lib/docker-plugin-selection.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writePlugin(
  extensionsRoot: string,
  dirName: string,
  manifestId?: string,
  dependencies?: Record<string, string>,
  requiredPlatformPackages?: string[],
) {
  const pluginDir = path.join(extensionsRoot, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: dirName,
      ...(dependencies && { dependencies }),
      ...(requiredPlatformPackages && {
        openclaw: { install: { requiredPlatformPackages } },
      }),
    })}\n`,
  );
  if (manifestId) {
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: manifestId })}\n`,
    );
  }
}

function runSelector(
  extensionsRoot: string,
  selection: string,
  rootPackagePath?: string,
  requiredPlatformPackages = false,
) {
  const args = [selectorScript, extensionsRoot, selection];
  if (rootPackagePath) {
    args.push("--required-bundled", rootPackagePath);
  } else if (requiredPlatformPackages) {
    args.push("--required-platform-packages");
  }
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
  });
}

describe("Docker plugin selection", () => {
  it("includes required core-bundled dependencies without changing optional plugin selections", () => {
    const fixtureRoot = tempDirs.make("openclaw-docker-required-bundled-plugins-");
    const extensionsRoot = path.join(fixtureRoot, "extensions");
    const rootPackagePath = path.join(fixtureRoot, "package.json");
    fs.mkdirSync(extensionsRoot);
    fs.writeFileSync(
      rootPackagePath,
      `${JSON.stringify({ files: ["dist/", "!dist/extensions/optional-provider/**"] })}\n`,
    );
    writePlugin(extensionsRoot, "bundled-provider", "bundled", { "provider-sdk": "1.0.0" });
    writePlugin(extensionsRoot, "bundled-without-deps", "without-deps");
    writePlugin(extensionsRoot, "optional-provider", "optional", { "optional-sdk": "1.0.0" }, [
      "optional-native-linux-arm64",
      "optional-native-darwin-arm64",
      "optional-native-linux-arm64",
    ]);

    const required = runSelector(extensionsRoot, "", rootPackagePath);
    expect(required.status).toBe(0);
    expect(required.stderr).toBe("");
    expect(required.stdout).toBe("bundled-provider\n");

    const install = runSelector(extensionsRoot, "optional", rootPackagePath);
    expect(install.status).toBe(0);
    expect(install.stdout).toBe("bundled-provider\noptional-provider\n");

    const selected = runSelector(extensionsRoot, "optional");
    expect(selected.status).toBe(0);
    expect(selected.stdout).toBe("optional-provider\n");

    const platformPackages = runSelector(extensionsRoot, "optional", undefined, true);
    expect(platformPackages.status).toBe(0);
    expect(platformPackages.stdout).toBe(
      "optional-native-darwin-arm64\noptional-native-linux-arm64\n",
    );
    expect(runSelector(extensionsRoot, "", undefined, true).stdout).toBe("");
  });

  it("resolves manifest ids and source directory names deterministically", () => {
    const extensionsRoot = tempDirs.make("openclaw-docker-plugin-selection-");
    writePlugin(extensionsRoot, "source-only");
    writePlugin(extensionsRoot, "provider-source", "provider-id");

    const result = runSelector(
      extensionsRoot,
      "source-only,provider-id provider-source,provider-id",
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("provider-source\nsource-only\n");
  });

  it("fails closed for unknown, invalid, and ambiguous ids", () => {
    const extensionsRoot = tempDirs.make("openclaw-docker-plugin-selection-errors-");
    writePlugin(extensionsRoot, "shared");
    writePlugin(extensionsRoot, "other-source", "shared");

    for (const [selection, message] of [
      ["missing-plugin", "unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin"],
      ["../invalid", "invalid OPENCLAW_EXTENSIONS plugin id: ../invalid"],
      ["shared", "ambiguous OPENCLAW_EXTENSIONS plugin id: shared"],
    ] as const) {
      const result = runSelector(extensionsRoot, selection);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    }
  });
});
