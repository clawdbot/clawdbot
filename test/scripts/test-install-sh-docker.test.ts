// Test Install Sh Docker tests cover test install sh docker script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/test-install-sh-docker.sh";
const INSTALL_E2E_DOCKER_PATH = "scripts/test-install-sh-e2e-docker.sh";
const INSTALL_E2E_DOCKERFILE_PATH = "scripts/docker/install-sh-e2e/Dockerfile";
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const DOCKER_SETUP_PATH = "scripts/docker/setup.sh";
const HOST_TIMEOUT_PATH = "scripts/lib/host-timeout.sh";
const PODMAN_SETUP_PATH = "scripts/podman/setup.sh";
const PODMAN_QUADLET_TEMPLATE_PATH = "scripts/podman/openclaw.container.in";
const PODMAN_RUN_PATH = "scripts/run-openclaw-podman.sh";
const SMOKE_DOCKERFILE_PATH = "scripts/docker/install-sh-smoke/Dockerfile";
const SMOKE_RUNNER_PATH = "scripts/docker/install-sh-smoke/run.sh";
const NONROOT_DOCKERFILE_PATH = "scripts/docker/install-sh-nonroot/Dockerfile";
const NONROOT_RUNNER_PATH = "scripts/docker/install-sh-nonroot/run.sh";
const BUN_GLOBAL_SMOKE_PATH = "scripts/e2e/bun-global-install-smoke.sh";
const BUN_GLOBAL_ASSERTIONS_PATH = "scripts/e2e/lib/bun-global-install/assertions.mjs";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
const INSTALL_SMOKE_WORKFLOW_PATH = ".github/workflows/install-smoke-reusable.yml";
const INSTALL_SMOKE_WRAPPER_PATH = ".github/workflows/install-smoke.yml";
const RELEASE_CHECKS_WORKFLOW_PATH = ".github/workflows/openclaw-release-checks.yml";
const LIVE_E2E_WORKFLOW_PATH = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const tempDirs = createTempDirTracker();

afterEach(() => {
  tempDirs.cleanup();
});

class ScriptExit extends Error {
  constructor(readonly status: number) {
    super(`script exited ${String(status)}`);
  }
}

function extractNonrootNodePreflight(): string {
  const script = readFileSync(NONROOT_RUNNER_PATH, "utf8");
  const match = script.match(/node -e '\n([\s\S]*?)\n'\ncommand -v npm/u);
  if (!match) {
    throw new Error("non-root smoke Node preflight was not found");
  }
  return match[1];
}

function runNonrootNodePreflight(version: string, options: { sqlite?: boolean } = {}) {
  const stderr: string[] = [];
  try {
    runInNewContext(extractNonrootNodePreflight(), {
      process: {
        versions: { node: version },
        stderr: {
          write(message: string) {
            stderr.push(message);
          },
        },
        exit(status: number) {
          throw new ScriptExit(status);
        },
      },
      require(specifier: string) {
        if (specifier === "node:sqlite" && options.sqlite === false) {
          throw new Error("missing node:sqlite");
        }
        return {};
      },
    });
    return { status: 0, stderr: stderr.join("") };
  } catch (error) {
    if (error instanceof ScriptExit) {
      return { status: error.status, stderr: stderr.join("") };
    }
    throw error;
  }
}

function runDefaultSmokePlatform(env: Record<string, string>, hostArch: string): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const match = script.match(
    /(resolve_default_smoke_platform\(\) \{[\s\S]*?\n\})\n\nprint_pack_audit/u,
  );
  if (!match) {
    throw new Error("resolve_default_smoke_platform was not found");
  }
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${match[1]}\nuname() { if [[ "\${1:-}" == "-m" ]]; then printf "%s" "$FAKE_UNAME_ARCH"; else command uname "$@"; fi; }\nresolve_default_smoke_platform`,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: "/tmp",
        PATH: process.env.PATH ?? "",
        FAKE_UNAME_ARCH: hostArch,
        ...env,
      },
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

function extractInstallE2eAgentJsonParser(): string {
  const script = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
  const match = script.match(
    /node - <<'NODE' "\$out_json"\n([\s\S]*?)\nNODE\n\}\n\nRUN_AGENT_TURN_BG_PID/u,
  );
  if (!match) {
    throw new Error("install E2E agent JSON parser was not found");
  }
  return match[1];
}

function normalizeInstallE2eAgentOutput(output: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-install-e2e-agent-output-"));
  const outputPath = join(root, "agent.json");
  writeFileSync(outputPath, output, "utf8");
  try {
    const result = spawnSync(process.execPath, ["-", outputPath], {
      encoding: "utf8",
      input: extractInstallE2eAgentJsonParser(),
    });
    return {
      output: readFileSync(outputPath, "utf8"),
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function extractInstallSmokeUpdateJsonParser(): string {
  const script = readFileSync(SMOKE_RUNNER_PATH, "utf8");
  const match = script.match(
    /UPDATE_JSON="\$UPDATE_JSON" \\\n[\s\S]*?node - <<'NODE'\n([\s\S]*?)\nNODE\n\n  echo "==> Verify updated version"/u,
  );
  if (!match) {
    throw new Error("install smoke update JSON parser was not found");
  }
  return match[1];
}

function validateInstallSmokeUpdateJson(doctorStep?: Record<string, unknown>) {
  const updateUrl = "http://candidate.invalid/openclaw.tgz";
  const payload = {
    status: "ok",
    before: { version: "2026.7.0" },
    after: { version: "2026.7.1" },
    steps: [
      {
        name: "global update",
        exitCode: 0,
        command: `npm install ${updateUrl}`,
      },
      ...(doctorStep ? [doctorStep] : []),
    ],
  };
  return spawnSync(process.execPath, ["-"], {
    encoding: "utf8",
    input: extractInstallSmokeUpdateJsonParser(),
    env: {
      ...process.env,
      UPDATE_JSON: JSON.stringify(payload),
      UPDATE_EXPECT_VERSION: payload.after.version,
      UPDATE_BASELINE_VERSION: payload.before.version,
      UPDATE_TAG_URL: updateUrl,
    },
  });
}

function expectInstallDockerfileContract(
  dockerfilePath: string,
  runnerPath: string,
  entrypoint: string,
): string {
  const dockerfile = readFileSync(dockerfilePath, "utf8");

  expect(dockerfile).toContain("# syntax=docker/dockerfile:1.7");
  expect(dockerfile).toMatch(/^FROM \S+@sha256:[a-f0-9]{64}$/m);
  expect(dockerfile).toContain("apt-get");
  expect(dockerfile).toContain("bash");
  expect(dockerfile).toContain("ca-certificates");
  expect(dockerfile).toContain("curl");
  expect(dockerfile).toContain(
    "COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh",
  );
  expect(dockerfile).toContain(`COPY --chmod=755 ${runnerPath} ${entrypoint}`);
  expect(dockerfile).toContain(`ENTRYPOINT ["${entrypoint}"]`);
  return dockerfile;
}

async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function extractReadPackTarballFilename(): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const match = script.match(/(read_pack_tarball_filename\(\) \{[\s\S]*?\n\})\n\nSMOKE_IMAGE/u);
  if (!match) {
    throw new Error("read_pack_tarball_filename helper was not found");
  }
  return match[1];
}

function runReadPackTarballFilename(filename: string) {
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${extractReadPackTarballFilename()}
pack_json_file="$(mktemp)"
trap 'rm -f "$pack_json_file"' EXIT
printf '%s' "$PACK_JSON" >"$pack_json_file"
read_pack_tarball_filename "$pack_json_file"`,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: "/tmp",
        PACK_JSON: JSON.stringify([{ filename }]),
        PATH: process.env.PATH ?? "",
      },
    },
  );
}

function extractEnsureLocalUpdateDistImportClosure(): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const match = script.match(
    /(ensure_local_update_dist_import_closure\(\) \{[\s\S]*?\n\})\n\nread_candidate_version/u,
  );
  if (!match) {
    throw new Error("ensure_local_update_dist_import_closure helper was not found");
  }
  return match[1];
}

type RestorePathEscape = "packages" | "ai";

function runRestoreLocalDistFixture(
  options: { failAiSwap?: boolean; symlinkEscape?: RestorePathEscape } = {},
) {
  const fixtureRoot = tempDirs.make("openclaw-install-restore-root-");
  const imageRoot = tempDirs.make("openclaw-install-restore-image-");
  let externalSentinel = "";
  for (const [relativePath, contents] of [
    ["dist/root.txt", "old-root"],
    ["packages/ai/dist/ai.txt", "old-ai"],
    ["packages/ai/package.json", "{}"],
  ]) {
    const target = join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  for (const [relativePath, contents] of [
    ["app/dist/root.txt", "new-root"],
    ["app/node_modules/@openclaw/ai/dist/ai.txt", "new-ai"],
  ]) {
    const target = join(imageRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  if (options.symlinkEscape) {
    const escapeRoot = tempDirs.make("openclaw-install-restore-escape-");
    const externalAiRoot =
      options.symlinkEscape === "packages" ? join(escapeRoot, "packages", "ai") : escapeRoot;
    externalSentinel = join(externalAiRoot, "dist", "ai.txt");
    mkdirSync(path.dirname(externalSentinel), { recursive: true });
    writeFileSync(join(externalAiRoot, "package.json"), "{}");
    writeFileSync(externalSentinel, "external-ai");
    if (options.symlinkEscape === "packages") {
      rmSync(join(fixtureRoot, "packages"), { force: true, recursive: true });
      symlinkSync(join(escapeRoot, "packages"), join(fixtureRoot, "packages"), "dir");
    } else {
      rmSync(join(fixtureRoot, "packages", "ai"), { force: true, recursive: true });
      symlinkSync(externalAiRoot, join(fixtureRoot, "packages", "ai"), "dir");
    }
  }

  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
REPO_ROOT="$FIXTURE_REPO"
ROOT_DIR="$FIXTURE_ROOT"
IMAGE_ROOT="$FIXTURE_IMAGE"
docker_e2e_docker_cmd() {
  printf 'docker-call=%s\\n' "$1" >&2
  case "$1" in
    create)
      printf "fixture"
      ;;
    cp)
      local source="\${2#fixture:}"
      cp -R "$IMAGE_ROOT$source" "$3"
      ;;
    rm)
      ;;
    *)
      return 2
      ;;
  esac
}
mv() {
  if [[ "$FAIL_AI_SWAP" == "1" && "$1" == */ai-dist && "$2" == */packages/ai/dist ]]; then
    return 1
  fi
  command mv "$@"
}
source "$REPO_ROOT/${DOCKER_E2E_PACKAGE_HELPER_PATH}"
status=0
docker_e2e_restore_package_dist_from_image fixture-image || status=$?
printf 'status=%s\\n' "$status"
printf 'root=%s\\n' "$(cat "$ROOT_DIR/dist/root.txt")"
printf 'ai=%s\\n' "$(cat "$ROOT_DIR/packages/ai/dist/ai.txt")"
if [[ -n "$EXTERNAL_SENTINEL" ]]; then
  printf 'external=%s\\n' "$(cat "$EXTERNAL_SENTINEL")"
fi
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAIL_AI_SWAP: options.failAiSwap ? "1" : "0",
        EXTERNAL_SENTINEL: externalSentinel,
        FIXTURE_IMAGE: imageRoot,
        FIXTURE_REPO: process.cwd(),
        FIXTURE_ROOT: fixtureRoot,
      },
    },
  );
}

describe("test-install-sh-docker", () => {
  it("defaults ARM hosts to native arm64 while keeping x64 CI on amd64", () => {
    expect(runDefaultSmokePlatform({ CI: "true" }, "aarch64")).toBe("linux/arm64");
    expect(runDefaultSmokePlatform({ GITHUB_ACTIONS: "true" }, "x86_64")).toBe("linux/amd64");
    expect(runDefaultSmokePlatform({}, "arm64")).toBe("linux/arm64");
    expect(
      runDefaultSmokePlatform({ OPENCLAW_INSTALL_SMOKE_PLATFORM: "linux/s390x" }, "x86_64"),
    ).toBe("linux/s390x");
  });

  it("supports npm update package specs without a separate expected-version env", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'UPDATE_EXPECT_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_EXPECT_VERSION:-}"',
    );
    expect(script).toContain('if [[ -z "$UPDATE_EXPECT_VERSION" ]]; then');
    expect(script).toContain('UPDATE_EXPECT_VERSION="$packed_update_version"');
    expect(script).toContain(
      "packed update version ${packed_update_version} does not match expected ${UPDATE_EXPECT_VERSION}",
    );
  });

  it("uses npm latest as the update baseline and resolves it to the concrete packed version", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");
    const workflow = readFileSync(INSTALL_SMOKE_WORKFLOW_PATH, "utf8");

    expect(script).toContain(
      'UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE:-latest}"',
    );
    expect(script).toContain('quiet_npm pack "${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}"');
    expect(script).toContain('UPDATE_BASELINE_VERSION="$(');
    expect(runner).toContain(
      'UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_UPDATE_BASELINE:-latest}"',
    );
    expect(runner).toContain("resolve_update_baseline_version");
    expect(runner).toContain('quiet_npm view "${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}" version');
    expect(workflow).toContain(
      "OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE: ${{ inputs.update_baseline_version || 'latest' }}",
    );
  });

  it("keeps install-sh Dockerfiles wired to their runner contracts", () => {
    const e2eDockerfile = expectInstallDockerfileContract(
      INSTALL_E2E_DOCKERFILE_PATH,
      "install-sh-e2e/run.sh",
      "/usr/local/bin/openclaw-install-e2e",
    );
    const smokeDockerfile = expectInstallDockerfileContract(
      SMOKE_DOCKERFILE_PATH,
      "install-sh-smoke/run.sh",
      "/usr/local/bin/openclaw-install-smoke",
    );
    const nonrootDockerfile = expectInstallDockerfileContract(
      NONROOT_DOCKERFILE_PATH,
      "install-sh-nonroot/run.sh",
      "/usr/local/bin/openclaw-install-nonroot",
    );

    expect(e2eDockerfile).toContain("USER appuser");
    expect(smokeDockerfile).toContain(
      "COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh",
    );
    expect(nonrootDockerfile).toContain(
      "COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh",
    );
    expect(nonrootDockerfile).toContain("USER app");
    expect(nonrootDockerfile).toContain("WORKDIR /home/app");
    expect(nonrootDockerfile).toContain("NPM_CONFIG_UPDATE_NOTIFIER=false");
  });

  it("keeps shared install helpers parsing and verifying installed CLI versions", () => {
    const root = tempDirs.make("openclaw-install-helper-");
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "openclaw"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "${1:-}" in',
        "  --version)",
        "    printf 'OpenClaw v2026.6.21-beta.1\\r\\n'",
        "    ;;",
        "  --help)",
        "    printf 'usage\\n'",
        "    ;;",
        "  *)",
        "    exit 2",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/docker/install-sh-common/cli-verify.sh",
          "printf 'parsed=%s\\n' \"$(extract_openclaw_semver 'OpenClaw v2026.6.21-beta.1+build.7')\"",
          "verify_installed_cli openclaw 2026.6.21-beta.1",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("parsed=2026.6.21-beta.1+build.7");
    expect(result.stdout).toContain(
      "cli=openclaw installed=2026.6.21-beta.1 expected=2026.6.21-beta.1",
    );
    expect(result.stdout).toContain("==> Sanity: CLI runs");
  });

  it("can reuse dist from the already-built root Docker smoke image", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const packageHelper = readFileSync(DOCKER_E2E_PACKAGE_HELPER_PATH, "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(script).toContain('ROOT_DIR="${OPENCLAW_INSTALL_SMOKE_SOURCE_DIR:-$HARNESS_ROOT}"');
    expect(script).toContain('UPDATE_DIST_IMAGE="${OPENCLAW_INSTALL_SMOKE_UPDATE_DIST_IMAGE:-}"');
    expect(script).toContain("docker_e2e_restore_package_dist_from_image");
    expect(script).toContain('source "$HARNESS_ROOT/scripts/lib/docker-e2e-package.sh"');
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_INSTALL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"',
    );
    expect(packageHelper).toContain('container_id="$(docker_e2e_docker_cmd create "$image")"');
    expect(packageHelper).toContain(
      'docker_e2e_docker_cmd cp "${container_id}:/app/dist" "$temp_dir/dist"',
    );
    expect(packageHelper).toContain('"${container_id}:/app/node_modules/@openclaw/ai/dist"');
    expect(packageHelper).toContain('"$temp_dir/ai-dist"');
    expect(packageHelper).toContain('mv "$temp_dir/ai-dist" "$ai_dist_dir"');
    expect(packageHelper).toContain("cleanup_restore_package_dist() {");
    expect(packageHelper).toContain('mv "$restore_root/dist" "$backup_dir"');
    expect(packageHelper).toContain('mv "$temp_dir/dist" "$restore_root/dist"');
    expect(packageHelper).toContain('rm -rf "$restore_root/dist" >/dev/null 2>&1 || true');
    expect(packageHelper).toContain('mv "$backup_dir" "$restore_root/dist"');
    expect(packageHelper).toContain('docker_e2e_docker_cmd rm -f "$container_id"');
    expect(script).not.toContain('container_id="$(docker create "$image")"');
    expect(script).not.toContain('docker cp "${container_id}:/app/dist" "$ROOT_DIR/dist"');
    expect(packageHelper).toContain(
      'echo "==> Reuse package build artifacts from Docker image: $image"',
    );
    expect(script).toContain("ensure_local_update_dist_import_closure");
    expect(script).toContain(
      'node "$HARNESS_ROOT/scripts/check-package-dist-imports.mjs" "$ROOT_DIR"',
    );
    expect(script).toContain("WARN: reused Docker image dist failed import-closure check");
    expect(script).toContain("pnpm build");
    expect(script).not.toContain("pnpm ui:build");
    expect(script).toContain('-f "$HARNESS_ROOT/scripts/docker/install-sh-smoke/Dockerfile"');
    expect(script).toContain('-f "$HARNESS_ROOT/scripts/docker/install-sh-nonroot/Dockerfile"');
    expect(dockerfile).toContain("node scripts/check-package-dist-imports.mjs /app");
  });

  it("restores root and AI build trees from one image", () => {
    const result = runRestoreLocalDistFixture();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=0");
    expect(result.stdout).toContain("root=new-root");
    expect(result.stdout).toContain("ai=new-ai");
  });

  it("rolls both build trees back when the AI swap fails", () => {
    const result = runRestoreLocalDistFixture({ failAiSwap: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).toContain("root=old-root");
    expect(result.stdout).toContain("ai=old-ai");
  });

  it.each(["packages", "ai"] as const)(
    "rejects a symlinked %s path before restoring artifacts",
    (symlinkEscape) => {
      const result = runRestoreLocalDistFixture({ symlinkEscape });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("status=1");
      expect(result.stdout).toContain("root=old-root");
      expect(result.stdout).toContain("ai=external-ai");
      expect(result.stdout).toContain("external=external-ai");
      expect(result.stderr).not.toContain("docker-call=");
      expect(result.stderr).toContain("refusing package artifact restore through a symlinked");
    },
  );

  it("fails closed when exact image artifacts fail import closure", () => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -euo pipefail
HARNESS_ROOT=/trusted
ROOT_DIR=/candidate
UPDATE_SKIP_LOCAL_BUILD=1
node() {
  return 1
}
pnpm() {
  printf 'pnpm-called\\n'
}
${extractEnsureLocalUpdateDistImportClosure()}
status=0
ensure_local_update_dist_import_closure || status=$?
printf 'status=%s\\n' "$status"
`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).not.toContain("pnpm-called");
    expect(result.stderr).toContain("exact-image mode forbids a local rebuild");
  });

  it("bounds installer smoke container runs", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'INSTALL_SMOKE_DOCKER_RUN_TIMEOUT="${OPENCLAW_INSTALL_SMOKE_DOCKER_RUN_TIMEOUT:-2700s}"',
    );
    expect(script).toContain("run_install_smoke_container()");
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="$INSTALL_SMOKE_DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run "$@"',
    );
    expect(script.match(/run_install_smoke_container --rm -t/g)?.length).toBe(6);
    expect(script).not.toContain("docker run --rm -t \\");
  });

  it("rejects stale non-root smoke Node runtimes below the runtime floor", () => {
    const result = runNonrootNodePreflight("22.18.0");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported node 22.18.0");
  });

  it("rejects non-root smoke Node runtimes without node:sqlite", () => {
    const result = runNonrootNodePreflight("22.19.0", { sqlite: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported node 22.19.0: missing node:sqlite");
  });

  it("accepts non-root smoke Node runtimes that match the installer runtime floor", () => {
    expect(runNonrootNodePreflight("22.19.0").status).toBe(0);
    expect(runNonrootNodePreflight("24.16.0").status).toBe(0);
  });

  it("runs the root Dockerfile build with the CI heap limit", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain(
      'ARG OPENCLAW_DOCKER_BUILD_NODE_OPTIONS="--max-old-space-size=8192"',
    );
    expect(dockerfile).toContain('ARG OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=""');
    expect(dockerfile).toContain("ARG OPENCLAW_DOCKER_BUILD_SKIP_DTS=1");
    expect(dockerfile).toContain(
      'OPENCLAW_RUN_NODE_SKIP_DTS_BUILD="$OPENCLAW_DOCKER_BUILD_SKIP_DTS" OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB="$OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB" NODE_OPTIONS="$OPENCLAW_DOCKER_BUILD_NODE_OPTIONS" pnpm_config_verify_deps_before_run=false pnpm build:docker',
    );
  });

  it("exports the Playwright browser cache installed by the root Dockerfile", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright");
    expect(dockerfile).toContain('mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"');
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
  });

  it("passes the baked browser build arg through Docker setup", () => {
    const script = readFileSync(DOCKER_SETUP_PATH, "utf8");

    expect(script).toContain('export OPENCLAW_INSTALL_BROWSER="${OPENCLAW_INSTALL_BROWSER:-}"');
    expect(script).toContain("OPENCLAW_INSTALL_BROWSER \\");
    expect(script).toContain('--build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER}"');
  });

  it("bounds Docker setup image pulls", () => {
    const script = readFileSync(DOCKER_SETUP_PATH, "utf8");
    const timeoutHelper = readFileSync(HOST_TIMEOUT_PATH, "utf8");

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/host-timeout.sh"');
    expect(script).toContain('DOCKER_PULL_TIMEOUT="${OPENCLAW_DOCKER_SETUP_PULL_TIMEOUT:-600s}"');
    expect(script).toContain("run_docker_pull()");
    expect(script).toContain(
      'openclaw_host_timeout_cmd "$DOCKER_PULL_TIMEOUT" docker pull "$image"',
    );
    expect(timeoutHelper).toContain("elif command -v gtimeout >/dev/null 2>&1; then");
    expect(timeoutHelper).toContain('"$timeout_bin" --kill-after=30s "$timeout_value" "$@"');
    expect(script).toContain('run_docker_pull "$IMAGE_NAME"');
    expect(script).not.toContain('docker pull "$IMAGE_NAME"');
  });

  it("bounds Podman setup image pulls", () => {
    const script = readFileSync(PODMAN_SETUP_PATH, "utf8");

    expect(script).toContain('source "$REPO_PATH/scripts/lib/host-timeout.sh"');
    expect(script).toContain('PODMAN_PULL_TIMEOUT="${OPENCLAW_PODMAN_SETUP_PULL_TIMEOUT:-600s}"');
    expect(script).toContain("run_podman_pull()");
    expect(script).toContain(
      'openclaw_host_timeout_cmd "$PODMAN_PULL_TIMEOUT" podman pull "$image"',
    );
    expect(script).toContain('run_podman_pull "$OPENCLAW_IMAGE"');
    expect(script).not.toContain('podman pull "$OPENCLAW_IMAGE"');
  });

  it("bounds Podman setup image builds", () => {
    const script = readFileSync(PODMAN_SETUP_PATH, "utf8");

    expect(script).toContain(
      'PODMAN_BUILD_TIMEOUT="${OPENCLAW_PODMAN_SETUP_BUILD_TIMEOUT:-1800s}"',
    );
    expect(script).toContain("run_podman_build()");
    expect(script).toContain('openclaw_host_timeout_cmd "$PODMAN_BUILD_TIMEOUT" podman build "$@"');
    expect(script).toContain('run_podman_build -t "$OPENCLAW_IMAGE"');
    expect(script).not.toContain('podman build -t "$OPENCLAW_IMAGE"');
  });

  it("bounds detached Podman launches without timing out onboarding", () => {
    const script = readFileSync(PODMAN_RUN_PATH, "utf8");

    expect(script).toContain('PODMAN_RUN_TIMEOUT="${OPENCLAW_PODMAN_RUN_TIMEOUT:-600s}"');
    expect(script).toContain("OPENCLAW_PODMAN_RUN_TIMEOUT|OPENCLAW_PODMAN_GATEWAY_HOST_PORT");
    expect(script).toContain('source "$SCRIPT_DIR/lib/host-timeout.sh"');
    expect(script).toContain("run_podman_detached()");
    expect(script).toContain('openclaw_host_timeout_cmd "$PODMAN_RUN_TIMEOUT" podman run "$@"');
    expect(script).toContain('podman run --pull="$PODMAN_PULL" --rm -it \\');
    expect(script).toContain('run_podman_detached --pull="$PODMAN_PULL" -d --replace \\');
    expect(script).not.toContain('podman run --pull="$PODMAN_PULL" -d --replace \\');
  });

  it("passes image-scoped pip packages through Docker and Podman setup", () => {
    const dockerSetup = readFileSync(DOCKER_SETUP_PATH, "utf8");
    const podmanSetup = readFileSync(PODMAN_SETUP_PATH, "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain("ARG OPENCLAW_IMAGE_PIP_PACKAGES");
    expect(dockerfile).toContain(
      "python3 -m pip install --no-cache-dir --break-system-packages $OPENCLAW_IMAGE_PIP_PACKAGES",
    );
    expect(dockerSetup).toContain(
      'export OPENCLAW_IMAGE_PIP_PACKAGES="${OPENCLAW_IMAGE_PIP_PACKAGES:-}"',
    );
    expect(dockerSetup).toContain("OPENCLAW_IMAGE_PIP_PACKAGES \\");
    expect(dockerSetup).toContain(
      '--build-arg "OPENCLAW_IMAGE_PIP_PACKAGES=${OPENCLAW_IMAGE_PIP_PACKAGES}"',
    );
    expect(dockerSetup).not.toContain("OPENCLAW_DOCKER_PIP_PACKAGES");
    expect(podmanSetup).toContain('OPENCLAW_IMAGE_PIP_PACKAGES="${OPENCLAW_IMAGE_PIP_PACKAGES:-}"');
    expect(podmanSetup).toContain(
      'BUILD_ARGS+=(--build-arg "OPENCLAW_IMAGE_PIP_PACKAGES=${OPENCLAW_IMAGE_PIP_PACKAGES}")',
    );
    expect(podmanSetup).not.toContain("OPENCLAW_DOCKER_PIP_PACKAGES");
  });

  it("passes one source identity into local Docker and Podman builds", () => {
    const dockerSetup = readFileSync(DOCKER_SETUP_PATH, "utf8");
    const podmanSetup = readFileSync(PODMAN_SETUP_PATH, "utf8");

    for (const setupScript of [dockerSetup, podmanSetup]) {
      expect(setupScript).toContain("scripts/lib/build-metadata.sh");
      expect(setupScript).toContain("openclaw_resolve_git_commit");
      expect(setupScript).toContain("openclaw_resolve_build_timestamp");
      expect(setupScript).toContain("OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}");
      expect(setupScript).toContain("GIT_COMMIT=${BUILD_GIT_COMMIT}");
    }
  });

  it("keeps the Podman Quadlet template aligned with setup substitutions", () => {
    const setupScript = readFileSync(PODMAN_SETUP_PATH, "utf8");
    const template = readFileSync(PODMAN_QUADLET_TEMPLATE_PATH, "utf8");

    expect(setupScript).toContain(
      'QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"',
    );
    for (const placeholder of [
      "OPENCLAW_CONFIG_DIR",
      "OPENCLAW_WORKSPACE_DIR",
      "IMAGE_NAME",
      "CONTAINER_NAME",
    ]) {
      expect(setupScript).toContain(`{{${placeholder}}}`);
      expect(template).toContain(`{{${placeholder}}}`);
    }

    expect(template).toContain("UserNS=keep-id");
    expect(template).toContain("User=%U:%G");
    expect(template).toContain("Volume={{OPENCLAW_CONFIG_DIR}}:/home/node/.openclaw:Z");
    expect(template).toContain(
      "Volume={{OPENCLAW_WORKSPACE_DIR}}:/home/node/.openclaw/workspace:Z",
    );
    expect(template).toContain("EnvironmentFile={{OPENCLAW_CONFIG_DIR}}/.env");
    expect(template).toContain("PublishPort=127.0.0.1:18789:18789");
    expect(template).toContain("Exec=node dist/index.js gateway --bind lan --port 18789");
    expect(template).not.toContain("/home/admin");
  });

  it("allows repository branch history and release tags for secret-backed Docker release checks", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW_PATH, "utf8");

    expect(workflow).toContain('git rev-parse --verify "${INPUT_REF}^{commit}"');
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$selected_sha" refs/remotes/origin/main',
    );
    expect(workflow).toContain("repository-branch-history");
    expect(workflow).toContain("git tag --points-at \"$selected_sha\" | grep -Eq '^v'");
    expect(workflow).toContain(
      "git for-each-ref --format='%(refname:short)' --contains \"$selected_sha\" refs/remotes/origin",
    );
    expect(workflow).toContain("reachable from an OpenClaw branch or release tag");
  });

  it("prints package size audits for release smoke tarballs", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("print_pack_audit");
    expect(script).toContain("print_pack_delta_audit");
    expect(script).toContain("==> Pack audit");
    expect(script).toContain("==> Pack audit delta");
  });

  it("fails the update smoke when the candidate npm pack exceeds the release budget", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("assert_pack_unpacked_size_budget");
    expect(script).toContain('assert_pack_unpacked_size_budget "update" "$pack_json_file"');
    expect(script).toContain('from "./scripts/lib/npm-pack-budget.mjs"');
    expect(script).toContain("install smoke cannot verify pack budget");
  });

  it("keeps npm pack tarball filenames local before serving update artifacts", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("read_pack_tarball_filename()");
    expect(script).toContain('UPDATE_TGZ_FILE="$(basename "$package_tgz")"');
    expect(script).toContain('UPDATE_TGZ_FILE="$(read_pack_tarball_filename "$pack_json_file")"');
    expect(script).toContain(
      'BASELINE_TGZ_FILE="$(read_pack_tarball_filename "$baseline_pack_json_file")"',
    );
    expect(script).toContain("filename !== path.basename(filename)");
    expect(script).toContain("filename !== path.win32.basename(filename)");
    expect(script).toContain("npm pack reported unsafe tarball filename");
  });

  it("rejects path-like npm pack tarball filenames in update smoke metadata", () => {
    expect(runReadPackTarballFilename("openclaw-2026.6.17.tgz")).toMatchObject({
      status: 0,
      stdout: "openclaw-2026.6.17.tgz",
    });

    const unsafeFilenames = [
      "../openclaw.tgz",
      "nested/openclaw.tgz",
      "nested\\openclaw.tgz",
      "/tmp/openclaw.tgz",
      "C:\\temp\\openclaw.tgz",
      "openclaw.tar.gz",
    ];

    for (const filename of unsafeFilenames) {
      const result = runReadPackTarballFilename(filename);

      expect(result.status, filename).not.toBe(0);
      expect(result.stderr, filename).toContain("npm pack reported unsafe tarball filename");
    }
  });

  it("uses the package artifact helper for local update tarballs", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('node "$HARNESS_ROOT/scripts/package-openclaw-for-docker.mjs"');
    expect(script).toContain('--source-dir "$ROOT_DIR"');
    expect(script).toContain('--pack-json "$pack_json_file"');
    expect(script).toContain("--skip-build");
    expect(script).not.toContain("node --import tsx scripts/write-package-dist-inventory.ts");
    expect(script).not.toContain("quiet_npm pack --ignore-scripts --json");
    expect(script).toContain('node "$HARNESS_ROOT/scripts/check-openclaw-package-tarball.mjs"');
    expect(script).toContain("--require-bundled-workspace-deps");
  });

  it("runs candidate tarballs through the installer script instead of direct npm", () => {
    const wrapper = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(wrapper).toContain('-v "$ROOT_DIR/scripts/install.sh:/tmp/openclaw-install.sh:ro"');
    expect(runner).toContain("Run official installer one-liner for latest release tarball");
    expect(runner).toContain("run_installer_for_package_spec");
    expect(runner).toContain('bash -c "curl -fsSL \\"\\$1\\" | bash -s --');
    expect(runner).not.toContain('npm_install_global "install latest release tarball"');
  });

  it("uses public npm latest as the non-root installer expectation", () => {
    const wrapper = readFileSync(SCRIPT_PATH, "utf8");

    expect(wrapper).toContain(
      'public_latest_version="$(quiet_npm view "$PACKAGE_NAME" version 2>/dev/null || true)"',
    );
    expect(wrapper).toContain('LATEST_VERSION="$public_latest_version"');
    expect(wrapper).toContain('-e OPENCLAW_INSTALL_EXPECT_VERSION="$LATEST_VERSION"');
  });
});

describe("install-sh E2E runner", () => {
  it("normalizes Docker wrapper timing and toggle knobs before forwarding", () => {
    const wrapper = readFileSync(INSTALL_E2E_DOCKER_PATH, "utf8");

    expect(wrapper).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="$(\n  docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300\n)"',
    );
    expect(wrapper).toContain(
      'OPENAI_PROVIDER_TIMEOUT_SECONDS="$(\n  docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS"\n)"',
    );
    expect(wrapper).toContain(
      'AGENT_TURNS_PARALLEL="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL 1)"',
    );
    expect(wrapper).toContain(
      'AGENT_TOOL_SMOKE="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE 1)"',
    );
    expect(wrapper).toContain(
      'SESSION_SCAN_BYTES="$(\n  docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_SESSION_SCAN_BYTES 16777216\n)"',
    );
    expect(wrapper).toContain(
      'SESSION_LINE_BYTES="$(\n  docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_SESSION_LINE_BYTES 1048576\n)"',
    );
    expect(wrapper).toContain(
      'SESSION_SCAN_DEPTH="$(docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH 64)"',
    );
    expect(wrapper).toContain(
      'SESSION_SCAN_NODES="$(docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_SESSION_SCAN_NODES 100000)"',
    );
    expect(wrapper).toContain(
      '-e OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS="$OPENAI_PROVIDER_TIMEOUT_SECONDS"',
    );
    expect(wrapper).toContain(
      '-e OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS="$AGENT_TURN_TIMEOUT_SECONDS"',
    );
    expect(wrapper).toContain(
      '-e OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL="$AGENT_TURNS_PARALLEL"',
    );
    expect(wrapper).toContain('-e OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE="$AGENT_TOOL_SMOKE"');
    expect(wrapper).toContain('-e OPENCLAW_INSTALL_E2E_SESSION_SCAN_BYTES="$SESSION_SCAN_BYTES"');
    expect(wrapper).toContain('-e OPENCLAW_INSTALL_E2E_SESSION_LINE_BYTES="$SESSION_LINE_BYTES"');
    expect(wrapper).toContain('-e OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH="$SESSION_SCAN_DEPTH"');
    expect(wrapper).toContain('-e OPENCLAW_INSTALL_E2E_SESSION_SCAN_NODES="$SESSION_SCAN_NODES"');
    expect(wrapper).not.toContain(
      'OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS="${OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS:-}"',
    );
  });

  it.each([
    ["turn timeout", "OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS", "300s"],
    ["provider timeout", "OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS", "1e3"],
    ["parallel toggle", "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL", "2"],
    ["tool smoke toggle", "OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE", "false"],
    ["session scan bytes", "OPENCLAW_INSTALL_E2E_SESSION_SCAN_BYTES", "16mb"],
    ["session line bytes", "OPENCLAW_INSTALL_E2E_SESSION_LINE_BYTES", "1mb"],
    ["session scan depth", "OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH", "0"],
    ["session scan nodes", "OPENCLAW_INSTALL_E2E_SESSION_SCAN_NODES", "100k"],
  ])("rejects invalid install E2E Docker %s before image build", (_label, envName, value) => {
    const result = spawnSync("bash", [INSTALL_E2E_DOCKER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stdout).not.toContain("==> Build image:");
  });

  it("validates agent timing and toggle knobs before running provider setup", () => {
    const script = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(script).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="$(read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300)"',
    );
    expect(script).toContain(
      'AGENT_TURNS_PARALLEL="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL 1)"',
    );
    expect(script).toContain(
      'AGENT_TOOL_SMOKE="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE 1)"',
    );
    expect(script).toContain(
      'OPENAI_PROVIDER_TIMEOUT_SECONDS="$(read_positive_int_env OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS")"',
    );
    expect(script).toContain('timeout --kill-after=15s "${AGENT_TURN_TIMEOUT_SECONDS}s"');
    expect(script).toContain('\\"timeoutSeconds\\":${OPENAI_PROVIDER_TIMEOUT_SECONDS}');
  });

  it("normalizes agent JSON when structured lifecycle diagnostics follow the result", () => {
    const payload = {
      result: {
        payloads: [{ text: "LEFT=RED RIGHT=GREEN" }],
      },
      replayInvalid: true,
    };
    const result = normalizeInstallE2eAgentOutput(
      `${JSON.stringify(payload, null, 2)}\n[agent] ${JSON.stringify({ stopReason: "stop" })}\n`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.output)).toEqual(payload);
  });

  it.each([
    ["turn timeout", "OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS", "300s"],
    ["provider timeout", "OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS", "1e3"],
    ["parallel toggle", "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL", "2"],
    ["tool smoke toggle", "OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE", "false"],
  ])("rejects invalid install E2E %s before credential preflight", (_label, envName, value) => {
    const result = spawnSync("bash", [INSTALL_E2E_RUNNER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("OPENCLAW_E2E_MODELS=both requires");
  });
});

describe("install-sh smoke runner", () => {
  it("wraps long npm/update operations with heartbeat and install-size audits", () => {
    const script = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(script).toContain(
      'HEARTBEAT_INTERVAL="$(read_nonnegative_int_env OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL 60)"',
    );
    expect(script).toContain(
      'INSTALL_COMMAND_TIMEOUT="$(read_positive_int_env OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT 900)"',
    );
    expect(script).toContain('if [[ "$interval" == "0" ]]; then');
    expect(script).toContain("run_with_heartbeat");
    expect(script).toContain("npm_install_global");
    expect(script).toContain('timeout --kill-after=30s "${INSTALL_COMMAND_TIMEOUT}s"');
    expect(script).toContain("==> Still running");
    expect(script).toContain("print_install_audit");
    expect(script).toContain('install -g "$@"');
    expect(script).toContain("openclaw update --tag");
    expect(script).toContain("is_self_swapped_package_process_exit");
    expect(script).toContain("legacy updater process exited after self-swap");
    expect(script).toContain("parseFirstJsonObject");
    expect(script).toContain("unterminated update JSON object");
    expect(script).toContain("verify_candidate_ai_runtime");
    expect(script).toContain("openclaw infer image providers --json");
  });

  it.each([
    ["successful", { name: "openclaw doctor", exitCode: 0 }],
    [
      "recoverable advisory",
      {
        name: "openclaw doctor",
        exitCode: 86,
        advisory: { kind: "package-post-install-doctor", message: "repair deferred" },
      },
    ],
  ])("accepts a %s package post-install doctor result", (_label, doctorStep) => {
    const result = validateInstallSmokeUpdateJson(doctorStep);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["missing", undefined, "missing openclaw doctor step"],
    ["fatal", { name: "openclaw doctor", exitCode: 1 }, "openclaw doctor step failed"],
    ["untyped advisory", { name: "openclaw doctor", exitCode: 86 }, "openclaw doctor step failed"],
    [
      "wrong advisory kind",
      { name: "openclaw doctor", exitCode: 86, advisory: { kind: "other" } },
      "openclaw doctor step failed",
    ],
    [
      "wrong advisory exit",
      {
        name: "openclaw doctor",
        exitCode: 1,
        advisory: { kind: "package-post-install-doctor" },
      },
      "openclaw doctor step failed",
    ],
  ])("rejects a %s package post-install doctor result", (_label, doctorStep, error) => {
    const result = validateInstallSmokeUpdateJson(doctorStep);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it.each([
    ["command timeout", "OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT", "900s"],
    ["heartbeat interval", "OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL", "60s"],
  ])("rejects invalid install smoke %s before running npm", (_label, envName, value) => {
    const result = spawnSync("bash", [SMOKE_RUNNER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("unsupported OPENCLAW_INSTALL_SMOKE_MODE");
  });

  it("covers plain npm global installs and npm-driven updates", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(script).toContain('SKIP_NPM_GLOBAL="${OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL:-0}"');
    expect(script).toContain('NPM_CACHE_DIR="${OPENCLAW_INSTALL_SMOKE_NPM_CACHE_DIR:-}"');
    expect(script).toContain("-e npm_config_cache=/npm-cache");
    expect(script).toContain('${NPM_CACHE_DOCKER_ARGS[@]+"${NPM_CACHE_DOCKER_ARGS[@]}"}');
    expect(script).toContain("remove_owned_npm_cache");
    expect(script).toContain('sudo -n rm -rf "$NPM_CACHE_DIR"');
    expect(script).not.toMatch(
      /Run installer non-root test:[\s\S]*"\$\{NPM_CACHE_DOCKER_ARGS\[@\]\}"/,
    );
    expect(script).not.toMatch(
      /Run CLI installer non-root test[\s\S]*"\$\{NPM_CACHE_DOCKER_ARGS\[@\]\}"/,
    );
    expect(script).toContain("==> Run direct npm global smoke");
    expect(script).toContain("OPENCLAW_INSTALL_SMOKE_MODE=npm-global");
    expect(runner).toContain("run_npm_global_smoke");
    expect(runner).toContain("==> Direct npm global install candidate");
    expect(runner).toContain("==> Direct npm global update candidate");
  });

  it("forwards smoke-runner control knobs into Docker containers", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("SMOKE_RUNNER_ENV_ARGS=()");
    for (const envName of [
      "OPENCLAW_INSTALL_ALLOW_LEGACY_UPDATE_WARNING",
      "OPENCLAW_INSTALL_SELF_UPDATE_WARNING_FIXED_VERSION",
      "OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT",
      "OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL",
      "OPENCLAW_INSTALL_SMOKE_PREVIOUS",
      "OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS",
    ]) {
      expect(script).toContain(envName);
    }
    expect(script).toMatch(
      /Run installer smoke test[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
    expect(script).toMatch(
      /Run update smoke[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
    expect(script).toMatch(
      /Run direct npm global smoke[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
    expect(script).toMatch(
      /Run installer npm freshness smoke[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
  });
});

describe("bun global install smoke", () => {
  it("packs the current tree and verifies image-provider discovery through Bun", () => {
    const script = readFileSync(BUN_GLOBAL_SMOKE_PATH, "utf8");
    const assertions = readFileSync(BUN_GLOBAL_ASSERTIONS_PATH, "utf8");
    const packageHelper = readFileSync(DOCKER_E2E_PACKAGE_HELPER_PATH, "utf8");

    expect(script).toContain("node scripts/package-openclaw-for-docker.mjs");
    expect(script).toContain("--skip-build");
    expect(script).toContain("--output-name openclaw-current.tgz");
    expect(script).not.toContain("npm pack --ignore-scripts --json --pack-destination");
    expect(script).toContain('"$bun_path" install -g "$PACKAGE_TGZ" --no-progress');
    expect(script).toContain("infer image providers --json");
    expect(script).toContain("assert-image-providers");
    expect(assertions).toContain("image providers output is missing bundled provider");
    expect(script).toContain("OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE");
    expect(script).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"');
    expect(script).toContain("docker_e2e_restore_package_dist_from_image");
    expect(script).toContain(
      'COMMAND_TIMEOUT_MS="$(read_positive_int_env OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS 180000)"',
    );
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_BUN_GLOBAL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"',
    );
    expect(packageHelper).toContain('container_id="$(docker_e2e_docker_cmd create "$image")"');
    expect(packageHelper).toContain(
      'docker_e2e_docker_cmd cp "${container_id}:/app/dist" "$temp_dir/dist"',
    );
    expect(packageHelper).toContain('"${container_id}:/app/node_modules/@openclaw/ai/dist"');
    expect(packageHelper).toContain('"$temp_dir/ai-dist"');
    expect(packageHelper).toContain('mv "$temp_dir/ai-dist" "$ai_dist_dir"');
    expect(packageHelper).toContain("cleanup_restore_package_dist() {");
    expect(packageHelper).toContain('mv "$restore_root/dist" "$backup_dir"');
    expect(packageHelper).toContain('mv "$temp_dir/dist" "$restore_root/dist"');
    expect(packageHelper).toContain('mktemp -d "$restore_root/.package-dist.XXXXXX"');
    expect(packageHelper).toContain('rm -rf "$restore_root/dist" >/dev/null 2>&1 || true');
    expect(packageHelper).toContain('mv "$backup_dir" "$restore_root/dist"');
    expect(packageHelper).toContain('docker_e2e_docker_cmd rm -f "$container_id"');
    expect(script).not.toContain('container_id="$(docker create "$image")"');
    expect(script).not.toContain('docker cp "${container_id}:/app/dist" "$ROOT_DIR/dist"');
    expect(script).not.toContain('\n  rm -rf "$ROOT_DIR/dist"\n');
  });

  it("rejects invalid Bun global install command timeouts before Bun setup", () => {
    const result = spawnSync("bash", [BUN_GLOBAL_SMOKE_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS: "180000ms",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS: 180000ms");
    expect(result.stderr).not.toContain("Bun is required");
  });

  it("uses the canonical package builder for bundled workspace dependencies", () => {
    const script = readFileSync(BUN_GLOBAL_SMOKE_PATH, "utf8");

    expect(script).toContain('PACK_DIR="$(mktemp -d');
    expect(script).toContain("node scripts/package-openclaw-for-docker.mjs");
    expect(script).toContain('--output-dir "$PACK_DIR"');
    expect(script).toContain("--output-name openclaw-current.tgz");
  });

  it("resolves the matching candidate AI package without changing the public registry", () => {
    const script = readFileSync(BUN_GLOBAL_SMOKE_PATH, "utf8");

    expect(script).toContain("assert-release-versions");
    expect(script).toContain('"$BUN_INSTALL/install/global/package.json"');
    expect(script).toContain("package/node_modules/@openclaw/ai");
    expect(script).toContain("--strip-components=4");
    expect(script).toContain('npm pack --ignore-scripts --silent --pack-destination "$PACK_DIR"');
    expect(script).toContain('overrides: { "@openclaw/ai": `file:${aiPackageTarball}` }');
    expect(script).not.toContain("--registry");
    expect(script).not.toContain("@openclaw:registry");
  });

  it("requires root and AI candidate versions to match", () => {
    const tempDir = tempDirs.make("openclaw-bun-candidate-versions-");
    const rootManifestPath = join(tempDir, "openclaw.json");
    const aiManifestPath = join(tempDir, "ai.json");
    writeFileSync(
      rootManifestPath,
      JSON.stringify({
        name: "openclaw",
        version: "2026.6.17",
        dependencies: { "@openclaw/ai": "2026.6.17" },
      }),
    );
    writeFileSync(aiManifestPath, JSON.stringify({ name: "@openclaw/ai", version: "2026.6.17" }));

    const matching = spawnSync(
      process.execPath,
      [BUN_GLOBAL_ASSERTIONS_PATH, "assert-release-versions", rootManifestPath, aiManifestPath],
      { encoding: "utf8" },
    );
    expect(matching).toMatchObject({ status: 0, stdout: "2026.6.17" });

    writeFileSync(aiManifestPath, JSON.stringify({ name: "@openclaw/ai", version: "2026.6.18" }));
    const mismatched = spawnSync(
      process.execPath,
      [BUN_GLOBAL_ASSERTIONS_PATH, "assert-release-versions", rootManifestPath, aiManifestPath],
      { encoding: "utf8" },
    );
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain(
      "candidate version mismatch: openclaw=2026.6.17, dependency=2026.6.17, @openclaw/ai=2026.6.18",
    );
  });

  it.runIf(process.platform !== "win32")(
    "uses bundled AI bytes when a prebuilt tarball is provided",
    () => {
      const tempDir = tempDirs.make("openclaw-bun-prebuilt-");
      const packageDir = join(tempDir, "fixture", "package");
      const aiDir = join(packageDir, "node_modules", "@openclaw", "ai");
      const packageTgz = join(tempDir, "openclaw-prebuilt.tgz");
      const bunPath = join(tempDir, "bun");
      mkdirSync(aiDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.6.17",
          dependencies: { "@openclaw/ai": "2026.6.17" },
          bundleDependencies: ["@openclaw/ai"],
        }),
      );
      writeFileSync(
        join(aiDir, "package.json"),
        JSON.stringify({ name: "@openclaw/ai", version: "2026.6.17" }),
      );
      const packed = spawnSync(
        "tar",
        ["-czf", packageTgz, "-C", join(tempDir, "fixture"), "package"],
        {
          encoding: "utf8",
        },
      );
      expect(packed.status, packed.stderr).toBe(0);
      writeFileSync(
        bunPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "1.3.14"
  exit 0
fi
override="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.overrides["@openclaw/ai"])' "$BUN_INSTALL/install/global/package.json")"
case "\${override#file:}" in
  *.tgz) ;;
  *) exit 1 ;;
esac
test -f "\${override#file:}"
mkdir -p "$BUN_INSTALL/bin"
cat >"$BUN_INSTALL/bin/openclaw" <<'OPENCLAW'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "OpenClaw 2026.6.17"
else
  printf '[{"id":"google"},{"id":"openai"},{"id":"xai"}]\n'
fi
OPENCLAW
chmod +x "$BUN_INSTALL/bin/openclaw"
`,
      );
      chmodSync(bunPath, 0o755);

      const result = spawnSync("bash", [BUN_GLOBAL_SMOKE_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          BUN_BIN: bunPath,
          OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD: "0",
          OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ: packageTgz,
          OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS: "10000",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("bun-global-install-smoke: image providers OK (3 providers)");
    },
  );

  it.runIf(process.platform !== "win32" && existsSync("/usr/bin/time"))(
    "preserves Bun global timeout kill grace after the leader exits",
    () => {
      const tempDir = tempDirs.make("openclaw-bun-global-timeout-grace-");
      const readyPath = path.join(tempDir, "ready");
      const drainedPath = path.join(tempDir, "drained");
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync(process.argv[2], 'drained');",
        "    process.exit(0);",
        "  }, 50);",
        "});",
        "fs.writeFileSync(process.argv[1], 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const result = spawnSync(
        process.execPath,
        [
          BUN_GLOBAL_ASSERTIONS_PATH,
          "run-with-timeout",
          "500",
          "/usr/bin/time",
          process.execPath,
          "-e",
          childScript,
          readyPath,
          drainedPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "1000",
          },
          timeout: 5_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("command timed out after 500ms: /usr/bin/time");
      expect(readFileSync(readyPath, "utf8")).toBe("ready");
      expect(readFileSync(drainedPath, "utf8")).toBe("drained");
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans Bun global smoke descendants on parent signal",
    async () => {
      const tempDir = tempDirs.make("openclaw-bun-global-parent-signal-");
      const readyPath = path.join(tempDir, "ready");
      const descendantPidPath = path.join(tempDir, "descendant.pid");
      let descendantPid = 0;
      const descendantScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const childProcess = require('node:child_process');",
        "const fs = require('node:fs');",
        `childProcess.spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const runner = spawn(
        process.execPath,
        [
          BUN_GLOBAL_ASSERTIONS_PATH,
          "run-with-timeout",
          "60000",
          process.execPath,
          "-e",
          parentScript,
        ],
        {
          env: {
            ...process.env,
            OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "100",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const runnerExit = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          runner.once("exit", (status, signal) => resolve({ status, signal }));
        },
      );

      try {
        await waitForCondition(
          () => existsSync(readyPath) && existsSync(descendantPidPath),
          "Bun global smoke descendant readiness",
        );
        descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(runnerExit).resolves.toEqual({ status: 143, signal: null });
        await waitForCondition(
          () => !isProcessAlive(descendantPid),
          "Bun global smoke descendant cleanup",
        );
      } finally {
        if (runner.pid && isProcessAlive(runner.pid)) {
          process.kill(runner.pid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("gates workflow Bun install smoke to scheduled and release-check runs", () => {
    const workflow = readFileSync(INSTALL_SMOKE_WORKFLOW_PATH, "utf8");
    const wrapper = readFileSync(INSTALL_SMOKE_WRAPPER_PATH, "utf8");
    const releaseChecks = readFileSync(RELEASE_CHECKS_WORKFLOW_PATH, "utf8");

    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("branches: [main]");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(wrapper).toContain('cron: "17 3 * * *"');
    expect(wrapper).toContain("workflow_dispatch:");
    expect(wrapper).toContain("uses: ./.github/workflows/install-smoke-reusable.yml");
    expect(wrapper).toContain(
      "github.event_name == 'schedule' || inputs.run_bun_global_install_smoke",
    );
    expect(workflow).toContain("run_bun_global_install_smoke:");
    expect(workflow).toContain(
      "if: needs.preflight.outputs.run_full_install_smoke == 'true' && needs.preflight.outputs.run_bun_global_install_smoke == 'true'",
    );
    expect(workflow).toContain("bun_global_install_smoke:");
    expect(workflow).toContain("Setup Node environment for Bun smoke");
    expect(workflow).toContain('install-bun: "true"');
    expect(workflow).toContain('install-bun: "false"');
    expect(workflow).toContain("Run Bun global install image-provider smoke");
    expect(workflow).toContain("bash scripts/e2e/bun-global-install-smoke.sh");
    expect(workflow).toContain(
      "OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE: ${{ needs.root_dockerfile_image.outputs.image_ref }}",
    );
    expect(workflow).toContain("group: ${{ github.workflow }}-workflow-call-${{ github.run_id }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain(
      "github.event_name == 'workflow_call' || github.event_name == 'push'",
    );
    expect(workflow).not.toContain("github.event_name == 'pull_request'");
    expect(workflow).not.toContain("node scripts/ci-changed-scope.mjs");
    expect(workflow).toContain("OPENCLAW_CI_WORKFLOW_BUN_GLOBAL_INSTALL_SMOKE");
    expect(workflow).toContain('run_bun_global_install_smoke="$workflow_bun_global_install_smoke"');
    expect(workflow).not.toContain("OPENCLAW_CI_EVENT_NAME");
    expect(workflow).not.toContain('if [ "$event_name"');
    expect(workflow).toContain('echo "run_bun_global_install_smoke=$run_bun_global_install_smoke"');
    expect(workflow).toContain("run_fast_install_smoke=true");
    expect(workflow).toContain("run_full_install_smoke=true");
    expect(workflow).toContain("run_install_smoke=true");
    expect(workflow).toContain("install-smoke-fast:");
    expect(workflow).toContain("run_fast_install_smoke");
    expect(workflow).toContain("run_full_install_smoke");
    expect(workflow).toContain("timeout --kill-after=30s 45m docker buildx build");
    expect(workflow).not.toContain('docker pull "$IMAGE_REF"');
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toContain("--push");
    expect(workflow).not.toContain('timeout 300s docker pull "$IMAGE_REF"');
    expect(workflow.match(/timeout --kill-after=30s 20m docker run --rm/g)?.length).toBe(6);
    expect(workflow).not.toMatch(/(^|\n)\s+docker run --rm --entrypoint sh/u);
    expect(workflow).toContain("--progress=plain");
    expect(workflow).toContain("--load");
    expect(workflow).toContain("OPENCLAW_INSTALL_URL: file:///tmp/openclaw-install.sh");
    expect(workflow).toContain("OPENCLAW_INSTALL_CLI_URL: file:///tmp/openclaw-install-cli.sh");
    expect(workflow).toContain('OPENCLAW_INSTALL_SMOKE_SKIP_CLI: "0"');
    expect(workflow).toContain("Run Rocky Linux installer smoke");
    expect(workflow).toContain("Run Rocky Linux CLI installer smoke");
    expect(workflow).toContain("scripts/install-cli.sh:/tmp/install-cli.sh:ro");
    expect(workflow).toContain("bash /tmp/install-cli.sh --prefix /tmp/openclaw-cli");
    expect(workflow).toContain("rockylinux:9@sha256:");
    expect(workflow).toContain("pnpm-workspace.yaml");
    expect(workflow).toContain("workspace.patchedDependencies");
    expect(workflow).toContain('throw new Error(\\"missing patch for \\" + dep + \\": \\" + rel)');
    expect(workflow).not.toContain("throw new Error(`missing patch");
    expect(workflow).not.toContain("pkg.pnpm?.patchedDependencies");
    expect(workflow).not.toContain("--cache-from");
    expect(workflow).not.toContain("--cache-to");
    expect(workflow).not.toContain("type=gha");
    expect(workflow).toContain('OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL: "1"');
    expect(releaseChecks).toContain("install_smoke_release_checks:");
    expect(releaseChecks).toContain("uses: ./.github/workflows/install-smoke-reusable.yml");
    expect(releaseChecks).toContain("run_bun_global_install_smoke: true");
  });

  it("runs installer packaging from the trusted workflow revision against a nested candidate", () => {
    const workflow = parse(readFileSync(INSTALL_SMOKE_WORKFLOW_PATH, "utf8"));
    const steps = workflow.jobs.installer_smoke.steps as Array<{
      name?: string;
      uses?: string;
      with?: Record<string, unknown>;
      env?: Record<string, unknown>;
      run?: string;
    }>;
    const step = (name: string) => {
      const found = steps.find((entry) => entry.name === name);
      expect(found, name).toBeDefined();
      return found!;
    };

    expect(step("Checkout trusted installer harness").with).toMatchObject({
      repository: "${{ needs.preflight.outputs.workflow_repository }}",
      ref: "${{ needs.preflight.outputs.workflow_sha }}",
      "persist-credentials": false,
    });
    expect(step("Checkout candidate CLI").with).toMatchObject({
      ref: "${{ needs.preflight.outputs.target_sha }}",
      path: "candidate",
      "persist-credentials": false,
    });
    expect(step("Setup Node environment for installer smoke").uses).toBe(
      "./.github/actions/setup-node-env",
    );
    expect(step("Run installer docker tests").env).toMatchObject({
      OPENCLAW_INSTALL_SMOKE_SOURCE_DIR: "${{ github.workspace }}/candidate",
    });
    expect(step("Run installer docker tests").run).toBe("bash scripts/test-install-sh-docker.sh");
    expect(step("Build installer smoke image").run).toContain(
      "./scripts/docker/install-sh-smoke/Dockerfile",
    );
    expect(step("Build installer smoke image").run).not.toContain("candidate/scripts/docker");
    expect(step("Build installer non-root image").run).not.toContain("candidate/scripts/docker");
    expect(step("Run Rocky Linux installer smoke").run).toContain(
      "$PWD/candidate/scripts/install.sh",
    );
  });

  it("kills Bun global install smoke commands that ignore TERM after timeout", () => {
    const result = spawnSync(
      process.execPath,
      [
        BUN_GLOBAL_ASSERTIONS_PATH,
        "run-with-timeout",
        "50",
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "50",
        },
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`command timed out after 50ms: ${process.execPath}`);
  });
});
