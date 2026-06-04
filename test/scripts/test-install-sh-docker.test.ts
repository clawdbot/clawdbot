import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/test-install-sh-docker.sh";
const DOCKER_SETUP_PATH = "scripts/docker/setup.sh";
const PODMAN_SETUP_PATH = "scripts/podman/setup.sh";
const PODMAN_RUN_PATH = "scripts/run-openclaw-podman.sh";
const SMOKE_RUNNER_PATH = "scripts/docker/install-sh-smoke/run.sh";
const NONROOT_RUNNER_PATH = "scripts/docker/install-sh-nonroot/run.sh";
const BUN_GLOBAL_SMOKE_PATH = "scripts/e2e/bun-global-install-smoke.sh";
const BUN_GLOBAL_ASSERTIONS_PATH = "scripts/e2e/lib/bun-global-install/assertions.mjs";
const INSTALL_SMOKE_WORKFLOW_PATH = ".github/workflows/install-smoke.yml";
const RELEASE_CHECKS_WORKFLOW_PATH = ".github/workflows/openclaw-release-checks.yml";
const LIVE_E2E_WORKFLOW_PATH = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";

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

  it("can reuse dist from the already-built root Docker smoke image", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(script).toContain('UPDATE_DIST_IMAGE="${OPENCLAW_INSTALL_SMOKE_UPDATE_DIST_IMAGE:-}"');
    expect(script).toContain("restore_local_dist_from_image");
    expect(script).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_INSTALL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"',
    );
    expect(script).toContain('container_id="$(docker_e2e_docker_cmd create "$image")"');
    expect(script).toContain(
      'docker_e2e_docker_cmd cp "${container_id}:/app/dist" "$ROOT_DIR/dist"',
    );
    expect(script).toContain('docker_e2e_docker_cmd rm -f "$container_id"');
    expect(script).not.toContain('container_id="$(docker create "$image")"');
    expect(script).not.toContain('docker cp "${container_id}:/app/dist" "$ROOT_DIR/dist"');
    expect(script).toContain('echo "==> Reuse local dist/ from Docker image: $image"');
    expect(script).toContain("ensure_local_update_dist_import_closure");
    expect(script).toContain('node scripts/check-package-dist-imports.mjs "$ROOT_DIR"');
    expect(script).toContain("WARN: reused Docker image dist failed import-closure check");
    expect(script).toContain("pnpm build");
    expect(script).not.toContain("pnpm ui:build");
    expect(dockerfile).toContain("node scripts/check-package-dist-imports.mjs /app");
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
      "NODE_OPTIONS=--max-old-space-size=8192 pnpm_config_verify_deps_before_run=false pnpm build:docker",
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

    expect(script).toContain('DOCKER_PULL_TIMEOUT="${OPENCLAW_DOCKER_SETUP_PULL_TIMEOUT:-600s}"');
    expect(script).toContain("run_docker_pull()");
    expect(script).toContain("timeout --kill-after=1s 1s true");
    expect(script).toContain(
      'timeout --kill-after=30s "$DOCKER_PULL_TIMEOUT" docker pull "$image"',
    );
    expect(script).toContain('timeout "$DOCKER_PULL_TIMEOUT" docker pull "$image"');
    expect(script).toContain('run_docker_pull "$IMAGE_NAME"');
    expect(script).not.toContain('docker pull "$IMAGE_NAME"');
  });

  it("bounds Podman setup image pulls", () => {
    const script = readFileSync(PODMAN_SETUP_PATH, "utf8");

    expect(script).toContain('PODMAN_PULL_TIMEOUT="${OPENCLAW_PODMAN_SETUP_PULL_TIMEOUT:-600s}"');
    expect(script).toContain("run_podman_pull()");
    expect(script).toContain("timeout --kill-after=1s 1s true");
    expect(script).toContain(
      'timeout --kill-after=30s "$PODMAN_PULL_TIMEOUT" podman pull "$image"',
    );
    expect(script).toContain('timeout "$PODMAN_PULL_TIMEOUT" podman pull "$image"');
    expect(script).toContain('run_podman_pull "$OPENCLAW_IMAGE"');
    expect(script).not.toContain('podman pull "$OPENCLAW_IMAGE"');
  });

  it("bounds Podman setup image builds", () => {
    const script = readFileSync(PODMAN_SETUP_PATH, "utf8");

    expect(script).toContain(
      'PODMAN_BUILD_TIMEOUT="${OPENCLAW_PODMAN_SETUP_BUILD_TIMEOUT:-1800s}"',
    );
    expect(script).toContain("run_podman_build()");
    expect(script).toContain("timeout --kill-after=1s 1s true");
    expect(script).toContain('timeout --kill-after=30s "$PODMAN_BUILD_TIMEOUT" podman build "$@"');
    expect(script).toContain('timeout "$PODMAN_BUILD_TIMEOUT" podman build "$@"');
    expect(script).toContain('run_podman_build -t "$OPENCLAW_IMAGE"');
    expect(script).not.toContain('podman build -t "$OPENCLAW_IMAGE"');
  });

  it("bounds detached Podman launches without timing out onboarding", () => {
    const script = readFileSync(PODMAN_RUN_PATH, "utf8");

    expect(script).toContain('PODMAN_RUN_TIMEOUT="${OPENCLAW_PODMAN_RUN_TIMEOUT:-600s}"');
    expect(script).toContain("OPENCLAW_PODMAN_RUN_TIMEOUT|OPENCLAW_PODMAN_GATEWAY_HOST_PORT");
    expect(script).toContain("run_podman_detached()");
    expect(script).toContain("timeout --kill-after=1s 1s true");
    expect(script).toContain('timeout --kill-after=30s "$PODMAN_RUN_TIMEOUT" podman run "$@"');
    expect(script).toContain('timeout "$PODMAN_RUN_TIMEOUT" podman run "$@"');
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

  it("writes the package dist inventory before packing ignore-scripts tarballs", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("node --import tsx scripts/write-package-dist-inventory.ts");
    expect(script).toContain('node scripts/check-package-dist-imports.mjs "$ROOT_DIR"');
    expect(script).toContain("quiet_npm pack --ignore-scripts");
    expect(script).toContain("node scripts/check-openclaw-package-tarball.mjs");
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

describe("install-sh smoke runner", () => {
  it("wraps long npm/update operations with heartbeat and install-size audits", () => {
    const script = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(script).toContain(
      'HEARTBEAT_INTERVAL="${OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL:-60}"',
    );
    expect(script).toContain(
      'INSTALL_COMMAND_TIMEOUT="${OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT:-900}"',
    );
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

    expect(script).toContain("npm pack --ignore-scripts --json --pack-destination");
    expect(script).toContain('"$bun_path" install -g "$PACKAGE_TGZ" --no-progress');
    expect(script).toContain("infer image providers --json");
    expect(script).toContain("assert-image-providers");
    expect(assertions).toContain("image providers output is missing bundled provider");
    expect(script).toContain("OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE");
    expect(script).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_BUN_GLOBAL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"',
    );
    expect(script).toContain('container_id="$(docker_e2e_docker_cmd create "$image")"');
    expect(script).toContain(
      'docker_e2e_docker_cmd cp "${container_id}:/app/dist" "$ROOT_DIR/dist"',
    );
    expect(script).toContain('docker_e2e_docker_cmd rm -f "$container_id"');
    expect(script).not.toContain('container_id="$(docker create "$image")"');
    expect(script).not.toContain('docker cp "${container_id}:/app/dist" "$ROOT_DIR/dist"');
  });

  it("gates workflow Bun install smoke to scheduled and release-check runs", () => {
    const workflow = readFileSync(INSTALL_SMOKE_WORKFLOW_PATH, "utf8");
    const releaseChecks = readFileSync(RELEASE_CHECKS_WORKFLOW_PATH, "utf8");

    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("branches: [main]");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain('cron: "17 3 * * *"');
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
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' || github.event_name == 'workflow_call'",
    );
    expect(workflow).toContain(
      "format('{0}-{1}-{2}', github.workflow, github.event_name, github.run_id)",
    );
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name != 'workflow_call' }}");
    expect(workflow).not.toContain(
      "github.event_name == 'workflow_call' || github.event_name == 'push'",
    );
    expect(workflow).not.toContain("github.event_name == 'pull_request'");
    expect(workflow).not.toContain("node scripts/ci-changed-scope.mjs");
    expect(workflow).toContain("OPENCLAW_CI_WORKFLOW_BUN_GLOBAL_INSTALL_SMOKE");
    expect(workflow).toContain('if [ "$event_name" = "schedule" ]; then');
    expect(workflow).toContain('echo "run_bun_global_install_smoke=$run_bun_global_install_smoke"');
    expect(workflow).toContain("run_fast_install_smoke=true");
    expect(workflow).toContain("run_full_install_smoke=true");
    expect(workflow).toContain("run_install_smoke=true");
    expect(workflow).toContain("install-smoke-fast:");
    expect(workflow).toContain("run_fast_install_smoke");
    expect(workflow).toContain("run_full_install_smoke");
    expect(workflow).toContain("timeout --kill-after=30s 45m docker buildx build");
    expect(workflow).toContain('timeout --kill-after=30s 600s docker pull "$IMAGE_REF"');
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
    expect(releaseChecks).toContain("uses: ./.github/workflows/install-smoke.yml");
    expect(releaseChecks).toContain("run_bun_global_install_smoke: true");
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
