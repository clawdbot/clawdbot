import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/test-install-sh-docker.sh";
const SMOKE_RUNNER_PATH = "scripts/docker/install-sh-smoke/run.sh";
const BUN_GLOBAL_SMOKE_PATH = "scripts/e2e/bun-global-install-smoke.sh";
const INSTALL_SMOKE_WORKFLOW_PATH = ".github/workflows/install-smoke.yml";
const RELEASE_CHECKS_WORKFLOW_PATH = ".github/workflows/openclaw-release-checks.yml";

describe("test-install-sh-docker", () => {
  it("defaults local Apple Silicon smoke runs to native arm64 while keeping CI on amd64", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("resolve_default_smoke_platform");
    expect(script).toContain('printf "linux/amd64"');
    expect(script).toContain('[[ "$host_os" == "Darwin" && "$host_arch" == "arm64" ]]');
    expect(script).toContain('printf "linux/arm64"');
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
    expect(workflow).toContain("OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE: latest");
  });

  it("can reuse dist from the already-built root Docker smoke image", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('UPDATE_DIST_IMAGE="${OPENCLAW_INSTALL_SMOKE_UPDATE_DIST_IMAGE:-}"');
    expect(script).toContain("restore_local_dist_from_image");
    expect(script).toContain('docker cp "${container_id}:/app/dist" "$ROOT_DIR/dist"');
    expect(script).toContain('echo "==> Reuse local dist/ from Docker image: $image"');
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
    expect(script).toContain("quiet_npm pack --ignore-scripts");
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
    expect(script).toContain('timeout --foreground "${INSTALL_COMMAND_TIMEOUT}s"');
    expect(script).toContain("==> Still running");
    expect(script).toContain("print_install_audit");
    expect(script).toContain('install -g "$@"');
    expect(script).toContain("openclaw update --tag");
    expect(script).toContain("parseFirstJsonObject");
    expect(script).toContain("unterminated update JSON object");
  });

  it("covers plain npm global installs and npm-driven updates", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(script).toContain('SKIP_NPM_GLOBAL="${OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL:-0}"');
    expect(script).toContain('NPM_CACHE_DIR="${OPENCLAW_INSTALL_SMOKE_NPM_CACHE_DIR:-}"');
    expect(script).toContain("-e npm_config_cache=/npm-cache");
    expect(script).toContain('"${NPM_CACHE_DOCKER_ARGS[@]}"');
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
});

describe("bun global install smoke", () => {
  it("packs the current tree and verifies image-provider discovery through Bun", () => {
    const script = readFileSync(BUN_GLOBAL_SMOKE_PATH, "utf8");

    expect(script).toContain("npm pack --ignore-scripts --json --pack-destination");
    expect(script).toContain('"$bun_path" install -g "$PACKAGE_TGZ" --no-progress');
    expect(script).toContain("infer image providers --json");
    expect(script).toContain("image providers output is missing bundled provider");
    expect(script).toContain("OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE");
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
      "install-bun: ${{ needs.preflight.outputs.run_bun_global_install_smoke }}",
    );
    expect(workflow).toContain(
      "if: needs.preflight.outputs.run_bun_global_install_smoke == 'true'",
    );
    expect(workflow).toContain("Run Bun global install image-provider smoke");
    expect(workflow).toContain("bash scripts/e2e/bun-global-install-smoke.sh");
    expect(workflow).toContain(
      "OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE: openclaw-dockerfile-smoke:local",
    );
    expect(workflow).toContain("format('{0}-manual-{1}', github.workflow, github.run_id)");
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
    expect(workflow).toContain('OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL: "1"');
    expect(releaseChecks).toContain("install_smoke_release_checks:");
    expect(releaseChecks).toContain("uses: ./.github/workflows/install-smoke.yml");
    expect(releaseChecks).toContain("run_bun_global_install_smoke: true");
  });
});
