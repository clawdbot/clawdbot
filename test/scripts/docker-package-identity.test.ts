import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ROOT_DIR = process.cwd();
const RUNNER_PATH = join(ROOT_DIR, "scripts/e2e/docker-package-install.sh");

type PackageIdentityOptions = {
  artifactVersion: string;
  bunCli?: string;
  bunManifest?: string;
  npmCli?: string;
  npmManifest?: string;
  pnpmCli?: string;
  pnpmManifest?: string;
};

function runPackageIdentity(options: PackageIdentityOptions) {
  const root = tempDirs.make("openclaw-docker-package-identity-");
  const binDir = join(root, "bin");
  const packageDir = join(root, "package");
  const packageTgz = join(root, "candidate.tgz");
  const identityPath = join(root, "identity.json");
  mkdirSync(binDir);
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: options.artifactVersion }),
  );
  const pack = spawnSync("tar", ["-czf", packageTgz, "-C", root, "package"], {
    encoding: "utf8",
  });
  expect(pack.status, pack.stderr).toBe(0);

  const dockerPath = join(binDir, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${1:-}"
shift || true
case "$command" in
  image|run|rm|logs)
    exit 0
    ;;
  exec)
    container="\${1:?missing container}"
    shift
    command_line="$*"
    if [[ "$command_line" == "test -f /tmp/openclaw-proof-ready" ]]; then
      exit 0
    fi
    if [[ "$command_line" == "cat /tmp/openclaw-package-root" ]]; then
      printf "/fake/pnpm/openclaw"
      exit 0
    fi
    if [[ "$command_line" == "cat /tmp/openclaw-version" ]]; then
      if [[ "$container" == *-npm-proof-* ]]; then
        printf "%s" "$FAKE_NPM_CLI"
      elif [[ "$container" == *-pnpm-proof-* ]]; then
        printf "%s" "$FAKE_PNPM_CLI"
      else
        exit 2
      fi
      exit 0
    fi
    if [[ "$command_line" == *"/tmp/openclaw-bun-proof.json"* ]]; then
      case "$command_line" in
        *installedPackageRoot*) printf "/fake/bun/openclaw" ;;
        *installedPackageVersion*) printf "%s" "$FAKE_BUN_MANIFEST" ;;
        *openclawVersion*) printf "%s" "$FAKE_BUN_CLI" ;;
        *openclawPath*) printf "/fake/bun/bin/openclaw" ;;
        *) exit 2 ;;
      esac
      exit 0
    fi
    if [[ "$command_line" == *"package.json"* ]]; then
      if [[ "$container" == *-npm-proof-* ]]; then
        printf "%s" "$FAKE_NPM_MANIFEST"
      elif [[ "$container" == *-pnpm-proof-* ]]; then
        printf "%s" "$FAKE_PNPM_MANIFEST"
      else
        exit 2
      fi
      exit 0
    fi
    exit 2
    ;;
  inspect)
    reference="\${!#}"
    printf '[{"Id":"sha256:fake","Image":"sha256:image","Name":"/%s","RepoDigests":[],"State":{"Status":"running"}}]\\n' "$reference"
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(dockerPath, 0o755);

  const result = spawnSync("/bin/bash", [RUNNER_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_BUN_CLI: options.bunCli ?? `OpenClaw ${options.artifactVersion}`,
      FAKE_BUN_MANIFEST: options.bunManifest ?? options.artifactVersion,
      FAKE_NPM_CLI: options.npmCli ?? `OpenClaw ${options.artifactVersion}`,
      FAKE_NPM_MANIFEST: options.npmManifest ?? options.artifactVersion,
      FAKE_PNPM_CLI: options.pnpmCli ?? `OpenClaw ${options.artifactVersion}`,
      FAKE_PNPM_MANIFEST: options.pnpmManifest ?? options.artifactVersion,
      OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
      OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH: identityPath,
      OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return {
    identity: result.status === 0 ? JSON.parse(readFileSync(identityPath, "utf8")) : undefined,
    result,
  };
}

describe.skipIf(process.platform === "win32")("Docker package identity report", () => {
  it("rejects installed manifests that do not match the package artifact", () => {
    const { result } = runPackageIdentity({
      artifactVersion: "1.2.3",
      bunCli: "OpenClaw 11.2.30",
      bunManifest: "11.2.30",
      npmCli: "OpenClaw 11.2.30",
      npmManifest: "11.2.30",
      pnpmCli: "OpenClaw 11.2.30",
      pnpmManifest: "11.2.30",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "[npm] installed manifest version '11.2.30' != artifact '1.2.3'",
    );
  });

  it("rejects a stale CLI version that only contains the artifact version as a substring", () => {
    const { result } = runPackageIdentity({
      artifactVersion: "1.2.3",
      npmCli: "OpenClaw 11.2.30 (wrong)",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[npm] CLI output parses to '11.2.30'");
  });

  it("rejects a pnpm manifest version that differs from the artifact", () => {
    const { result } = runPackageIdentity({
      artifactVersion: "1.2.3",
      pnpmManifest: "11.2.30",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "[pnpm] installed manifest version '11.2.30' != artifact '1.2.3'",
    );
  });

  it("rejects a pnpm CLI version that differs from the artifact", () => {
    const { result } = runPackageIdentity({
      artifactVersion: "1.2.3",
      pnpmCli: "OpenClaw 11.2.30 (wrong)",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[pnpm] CLI output parses to '11.2.30'");
  });

  it("rejects a Bun manifest version that differs from the artifact", () => {
    const { result } = runPackageIdentity({
      artifactVersion: "1.2.3",
      bunManifest: "11.2.30",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "[bun] installed manifest version '11.2.30' != artifact '1.2.3'",
    );
  });

  it("rejects a Bun CLI version that differs from the artifact", () => {
    const { result } = runPackageIdentity({
      artifactVersion: "1.2.3",
      bunCli: "OpenClaw 11.2.30 (wrong)",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[bun] CLI output parses to '11.2.30'");
  });

  it("emits complete manager-owned identity for an exact prerelease", () => {
    const version = "2026.6.21-beta.1+build.7";
    const { identity, result } = runPackageIdentity({ artifactVersion: version });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(identity).toEqual(
      expect.objectContaining({
        package: expect.objectContaining({ version }),
        containers: expect.arrayContaining([
          expect.objectContaining({
            role: "npm",
            details: expect.objectContaining({
              installedPackageVersion: version,
              parsedOpenclawVersion: version,
            }),
          }),
          expect.objectContaining({
            role: "pnpm",
            details: expect.objectContaining({
              installedPackageVersion: version,
              parsedOpenclawVersion: version,
            }),
          }),
          expect.objectContaining({
            role: "bun",
            details: expect.objectContaining({
              installedPackageRoot: "/fake/bun/openclaw",
              installedPackageVersion: version,
              parsedOpenclawVersion: version,
            }),
          }),
        ]),
      }),
    );
  });
});
