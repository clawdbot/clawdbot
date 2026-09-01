#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { writeBuildStamp, writeRuntimePostBuildStamp } from "./lib/local-build-metadata.mts";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mts";

const archiveName = "repo-e2e-build.tar.gz";

/** Carry one completed build between exact-target E2E jobs, without dependency or build caches. */
export function transferRepoE2eArtifacts(
  operation: string,
  artifactDir: string,
  profile: string,
  repoRoot = process.cwd(),
) {
  if (operation !== "pack" && operation !== "restore") {
    throw new Error("Expected pack or restore");
  }
  if (profile !== "full" && profile !== "ciArtifacts") {
    throw new Error("Expected full or ciArtifacts build profile");
  }
  const root = path.resolve(repoRoot);
  const artifactRoot = path.resolve(artifactDir);
  const identity = {
    version: 1,
    targetSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    profile,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    privateQa: process.env.OPENCLAW_BUILD_PRIVATE_QA === "1",
  };
  if (!identity.privateQa) {
    throw new Error("Repo E2E artifacts require a private-QA build");
  }
  const archive = path.join(artifactRoot, archiveName);
  const manifest = path.join(artifactRoot, "repo-e2e-build.json");
  if (operation === "pack") {
    const outputs = [
      "dist",
      ...(fs.existsSync(path.join(root, "dist-runtime")) ? ["dist-runtime"] : []),
      ...fs.readdirSync(path.join(root, "packages")).flatMap((name) => {
        const output = `packages/${name}/dist`;
        return fs.existsSync(path.join(root, output)) ? [output] : [];
      }),
      ...listGeneratedExtensionAssetSources({ rootDir: root }),
    ];
    fs.mkdirSync(artifactRoot, { recursive: true });
    // Tar preserves hidden stamps, executable bits, and relative runtime-overlay links.
    execFileSync("tar", ["-czf", archive, "--null", "-T", "-"], {
      cwd: root,
      input: outputs.join("\0") + "\0",
    });
    fs.writeFileSync(manifest, JSON.stringify({ identity, sha256: digest(archive) }) + "\n");
    return;
  }
  const recorded = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (!isDeepStrictEqual(recorded.identity, identity)) {
    throw new Error("Repo E2E artifact identity differs from this target, profile, or runtime");
  }
  if (recorded.sha256 !== digest(archive)) {
    throw new Error("Repo E2E artifact archive digest mismatch");
  }
  execFileSync("tar", ["-xzf", archive], { cwd: root });
  // Checkout config mtimes are newer than the producer's stamps. Refresh only
  // local freshness metadata after exact identity verification, before readers start.
  writeBuildStamp({ cwd: root });
  writeRuntimePostBuildStamp({ cwd: root });
}

function digest(file: string) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let length; (length = fs.readSync(descriptor, buffer)) > 0;) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [operation, artifactDir, profile] = process.argv.slice(2);
  if (!operation || !artifactDir || !profile || process.argv.length !== 5) {
    throw new Error(
      "Usage: repo-e2e-artifacts.mts <pack|restore> <artifact-dir> <full|ciArtifacts>",
    );
  }
  transferRepoE2eArtifacts(operation, artifactDir, profile);
}
