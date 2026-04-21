import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/test-install-sh-docker.sh";
const SMOKE_RUNNER_PATH = "scripts/docker/install-sh-smoke/run.sh";

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
  });

  it("covers plain npm global installs and npm-driven updates", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(script).toContain('SKIP_NPM_GLOBAL="${OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL:-0}"');
    expect(script).toContain("==> Run direct npm global smoke");
    expect(script).toContain("OPENCLAW_INSTALL_SMOKE_MODE=npm-global");
    expect(runner).toContain("run_npm_global_smoke");
    expect(runner).toContain("==> Direct npm global install candidate");
    expect(runner).toContain("==> Direct npm global update candidate");
  });
});
