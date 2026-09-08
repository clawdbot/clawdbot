import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUTURE_FIXTURE_VERSION,
  LEGACY_UPDATE_COMPAT_CHUNKS,
  markFutureUpdateFixture,
  removeLegacyUpdateCompatChunks,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePackageFixture() {
  const root = tempDirs.make("openclaw-first-hop-package-");
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    version: "2026.8.1",
    dependencies: { "@openclaw/ai": "2026.8.1" },
  });
  writeJson(path.join(root, "dist", "build-info.json"), {
    version: "2026.8.1",
    commit: "a".repeat(40),
    builtAt: "2026-09-02T00:00:00.000Z",
    buildId: "old-build",
  });
  const inventory = [
    "dist/build-info.json",
    ...LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`),
    "dist/index.js",
  ];
  writeJson(path.join(root, "dist", "postinstall-inventory.json"), inventory);
  for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
    fs.writeFileSync(path.join(root, "dist", name), "export function resolveNodeRunner() {}\n");
  }
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("first-hop package fixtures", () => {
  it("removes only the declared legacy compatibility inputs", () => {
    const root = makePackageFixture();
    removeLegacyUpdateCompatChunks(root);

    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("export {};\n");
  });

  it("marks a distinct future package after the compatibility window closes", () => {
    const root = makePackageFixture();
    markFutureUpdateFixture(root);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
    );
    expect(packageJson.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(packageJson.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
    expect(buildInfo.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(buildInfo.buildId).toContain("future-fixture");
    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")(
    "carries the candidate registry into the first-hop Docker lane",
    () => {
      const root = fs.realpathSync(tempDirs.make("openclaw-first-hop-docker-"));
      const bin = path.join(root, "bin");
      const registry = path.join(root, "registry");
      const dockerArgs = path.join(root, "docker-args.json");
      const tarball = path.join(root, "candidate.tgz");
      fs.mkdirSync(bin);
      fs.cpSync(makePackageFixture(), path.join(root, "package"), { recursive: true });
      execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
      writeJson(path.join(registry, "prepublish-plugin-registry.json"), {
        candidateVersion: "2026.8.1",
        sourceSha: "a".repeat(40),
        packages: [],
      });
      fs.writeFileSync(
        path.join(bin, "docker"),
        `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] === "run") fs.writeFileSync(process.env.DOCKER_ARGS_FILE, JSON.stringify(process.argv.slice(3)));
`,
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["scripts/e2e/update-first-hop-compat-docker.sh"], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DOCKER_ARGS_FILE: dockerArgs,
          OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP: "1",
          OPENCLAW_UPDATE_FIRST_HOP_E2E_SKIP_BUILD: "1",
          OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ: tarball,
          OPENCLAW_UPDATE_FIRST_HOP_CANDIDATE_PACKAGE_TGZ: tarball,
          OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR: path.join(root, "artifacts"),
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
          OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "",
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const args: string[] = JSON.parse(fs.readFileSync(dockerArgs, "utf8"));
      expect(args[args.indexOf("--entrypoint") + 1]).toBe(
        "/opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh",
      );
      expect(args).toContain(`${registry}:/tmp/openclaw-prepublish-plugin-registry:ro`);
      expect(args).toContain(`${tarball}:/tmp/openclaw-update-first-hop-candidate.tgz:ro`);
      expect(args).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION=2026.8.1");
      expect(args).toContain("bash");
      expect(args).toContain("scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh");
    },
  );
});
