// Plugin NPM Publish tests cover publish wrapper argument safety.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "scripts/plugin-npm-publish.sh";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function runPluginPublishWrapper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makePackage(version: string): { packageDir: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-publish-test-"));
  tempDirs.push(root);
  const packageDir = join(root, "plugin");
  const binDir = join(root, "bin");
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@openclaw/demo", version }),
  );
  const npmPath = join(binDir, "npm");
  writeFileSync(npmPath, "#!/bin/sh\nexit 1\n");
  chmodSync(npmPath, 0o755);
  return { packageDir, path: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
}

describe("plugin npm publish wrapper", () => {
  it("prints help before package or npm checks", () => {
    const result = runPluginPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack|--pack-dry-run|--publish] <package-dir>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing mode before package checks", () => {
    const result = runPluginPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack|--pack-dry-run|--publish] <package-dir>",
    );
  });

  it("requires an explicit artifact directory for real pack mode", () => {
    const result = runPluginPublishWrapper(["--pack", "extensions/telegram"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--pack requires OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR");
  });

  it("rejects option-like package dirs before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "--wat"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm package-dir option: --wat");
  });

  it("rejects extra arguments before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "extensions/telegram", "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm publish argument: extra");
  });

  it("uses the extended-stable plan without latest or beta mirrors", () => {
    const fixture = makePackage("2026.7.33");
    const result = runPluginPublishWrapper(["--dry-run", fixture.packageDir], {
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
      PATH: fixture.path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Resolved publish tag: extended-stable");
    expect(result.stdout).toContain("Resolved mirror dist-tags: <none>");
    expect(result.stdout).toContain("npm publish --access public --tag extended-stable");
  });

  it("rejects extended-stable versions below patch 33", () => {
    const fixture = makePackage("2026.7.32");
    const result = runPluginPublishWrapper(["--dry-run", fixture.packageDir], {
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
      PATH: fixture.path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PATCH >= 33");
  });
});
