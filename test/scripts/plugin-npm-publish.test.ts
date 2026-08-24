// Plugin NPM Publish tests cover publish wrapper argument safety.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function makePackage(version: string): { packageDir: string; path: string; root: string } {
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
  return { packageDir, path: `${binDir}${delimiter}${process.env.PATH ?? ""}`, root };
}

describe("plugin npm publish wrapper", () => {
  it("revalidates release tooling after preparation and immediately before npm publish", () => {
    const source = readFileSync(scriptPath, "utf8");
    const buildIndex = source.indexOf("build_package_runtime");
    const identityIndex = source.indexOf("\n  verify_release_tooling_identity", buildIndex);
    const publishIndex = source.indexOf(
      'run_with_manifest_overlay "${publish_cmd[@]}"',
      identityIndex,
    );

    expect(buildIndex).toBeGreaterThan(-1);
    expect(identityIndex).toBeGreaterThan(buildIndex);
    expect(publishIndex).toBeGreaterThan(identityIndex);
    expect(source.slice(identityIndex, publishIndex)).not.toContain("npm view");
  });

  it("revalidates release tooling immediately before every npm dist-tag mutation", () => {
    const source = readFileSync(scriptPath, "utf8");
    const distTagIndex = source.indexOf('npm dist-tag add "${package_name}@${package_version}"');
    const identityIndex = source.lastIndexOf("verify_release_tooling_identity", distTagIndex);

    expect(identityIndex).toBeGreaterThan(-1);
    expect(distTagIndex).toBeGreaterThan(identityIndex);
    expect(source.slice(identityIndex, distTagIndex)).not.toContain("npm view");
  });

  it("prints help before package or npm checks", () => {
    const result = runPluginPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--repo-root <dir>] [--dry-run|--pack|--pack-dry-run|--publish] <package-dir>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing mode before package checks", () => {
    const result = runPluginPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--repo-root <dir>] [--dry-run|--pack|--pack-dry-run|--publish] <package-dir>",
    );
  });

  it("runs trusted tooling against an explicit repository root", () => {
    const fixture = makePackage("2026.8.1-beta.1");
    const result = runPluginPublishWrapper(["--repo-root", fixture.root, "--dry-run", "plugin"], {
      PATH: fixture.path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Resolved repository root: ${fixture.root}`);
    expect(result.stdout).toContain(`Resolved package dir: ${fixture.packageDir}`);
    expect(result.stdout).toContain("Resolved package name: @openclaw/demo");
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
