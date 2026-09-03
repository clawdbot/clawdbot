import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { transferRepoE2eArtifacts } from "../../scripts/repo-e2e-artifacts.mts";
import { resolveBuildRequirement } from "../../scripts/run-node.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function fixture() {
  const root = fs.realpathSync(tempDirs.make("repo-e2e-artifacts-"));
  const artifact = path.join(root, "artifacts");
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  write("package.json", '{"name":"artifact-fixture"}\n');
  write("packages/demo/package.json", "{}\n");
  write(
    "extensions/demo/package.json",
    JSON.stringify({
      openclaw: {
        assetScripts: { build: "fixture-build", buildOutputs: ["assets/.bundle.hash"] },
        build: { staticAssets: [{ source: "assets/runtime.js", output: "assets/runtime.js" }] },
      },
    }),
  );
  write("extensions/demo/assets/.bundle.hash", "generated-hash\n");
  write("extensions/demo/assets/runtime.js", "generated-runtime\n");
  write(".gitignore", "dist\ndist-runtime\npackages/*/dist\nartifacts\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    execFileSync("git", args, { cwd: root });
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  write("dist/index.js", "#!/usr/bin/env node\nconsole.log('artifact');\n");
  fs.chmodSync(path.join(root, "dist/index.js"), 0o755);
  write("dist/private-qa.js", "private QA\n");
  write("dist/.buildstamp", JSON.stringify({ head }));
  write("dist/.runtime-postbuildstamp", JSON.stringify({ head }));
  write("packages/demo/dist/index.d.ts", "export declare const ready: true;\n");
  fs.mkdirSync(path.join(root, "dist-runtime"));
  fs.symlinkSync("../dist/index.js", path.join(root, "dist-runtime/index.js"));
  const oldStamp = new Date(Date.now() - 20_000);
  fs.utimesSync(path.join(root, "dist/.buildstamp"), oldStamp, oldStamp);
  fs.utimesSync(path.join(root, "dist/.runtime-postbuildstamp"), oldStamp, oldStamp);
  const configTime = new Date(Date.now() - 10_000);
  fs.utimesSync(path.join(root, "package.json"), configTime, configTime);
  return { root, artifact };
}

function requirement(root: string) {
  return resolveBuildRequirement({
    cwd: root,
    env: {},
    fs,
    spawnSync,
    distRoot: path.join(root, "dist"),
    distEntry: path.join(root, "dist/index.js"),
    buildStampPath: path.join(root, "dist/.buildstamp"),
    configFiles: [path.join(root, "package.json")],
    sourceRoots: [],
  });
}

describe("repo E2E artifact transfer", () => {
  beforeEach(() => vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["full", "ciArtifacts"])(
    "restores a complete %s build without rebuilding a newer checkout",
    (profile) => {
      const { root, artifact } = fixture();
      transferRepoE2eArtifacts("pack", artifact, profile, root);
      for (const output of [
        "dist",
        "dist-runtime",
        "packages/demo/dist",
        "extensions/demo/assets",
      ]) {
        fs.rmSync(path.join(root, output), { recursive: true });
      }
      // Reproduce a plain archive restore's false freshness miss before exercising the owner.
      execFileSync("tar", ["-xzf", path.join(artifact, "repo-e2e-build.tar.gz")], { cwd: root });
      expect(requirement(root)).toMatchObject({ shouldBuild: true, reason: "config_newer" });
      transferRepoE2eArtifacts("restore", artifact, profile, root);
      expect(requirement(root)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(fs.readlinkSync(path.join(root, "dist-runtime/index.js"))).toBe("../dist/index.js");
      expect(fs.statSync(path.join(root, "dist/index.js")).mode & 0o777).toBe(0o755);
      expect(fs.readFileSync(path.join(root, "dist/private-qa.js"), "utf8")).toBe("private QA\n");
      expect(fs.readFileSync(path.join(root, "packages/demo/dist/index.d.ts"), "utf8")).toContain(
        "ready",
      );
      expect(fs.readFileSync(path.join(root, "extensions/demo/assets/.bundle.hash"), "utf8")).toBe(
        "generated-hash\n",
      );
      expect(fs.readFileSync(path.join(root, "extensions/demo/assets/runtime.js"), "utf8")).toBe(
        "generated-runtime\n",
      );
      expect(
        fs.statSync(path.join(root, "dist/.runtime-postbuildstamp")).mtimeMs,
      ).toBeGreaterThanOrEqual(fs.statSync(path.join(root, "dist/.buildstamp")).mtimeMs);
    },
  );

  describe.sequential("identity validation", () => {
    let root: string;
    let artifact: string;
    let manifest: string;
    let originalManifest: string;

    beforeAll(() => {
      vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
      try {
        ({ root, artifact } = fixture());
        transferRepoE2eArtifacts("pack", artifact, "full", root);
        manifest = path.join(artifact, "repo-e2e-build.json");
        originalManifest = fs.readFileSync(manifest, "utf8");
        fs.rmSync(path.join(root, "dist"), { recursive: true });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(["targetSha", "profile", "node", "platform", "arch", "privateQa"])(
      "rejects mismatched %s before extraction",
      (field) => {
        // Each probe changes one field of the pristine identity while reusing the real archive.
        const recorded = JSON.parse(originalManifest);
        recorded.identity[field] = "mismatched";
        fs.writeFileSync(manifest, JSON.stringify(recorded));
        try {
          expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
          expect(() => transferRepoE2eArtifacts("restore", artifact, "full", root)).toThrow(
            "artifact identity differs",
          );
          expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
        } finally {
          fs.writeFileSync(manifest, originalManifest);
          fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
        }
      },
    );
  });

  it("rejects corrupt archives before extraction", () => {
    const { root, artifact } = fixture();
    transferRepoE2eArtifacts("pack", artifact, "full", root);
    fs.appendFileSync(path.join(artifact, "repo-e2e-build.tar.gz"), "corruption");
    fs.rmSync(path.join(root, "dist"), { recursive: true });
    expect(() => transferRepoE2eArtifacts("restore", artifact, "full", root)).toThrow(
      "archive digest mismatch",
    );
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });
});
