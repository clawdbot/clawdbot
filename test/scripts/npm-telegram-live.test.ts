import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const PREPARE_PACKAGE_PATH = path.resolve(
  TEST_DIR,
  "../../scripts/e2e/lib/npm-telegram-live/prepare-package.mjs",
);

describe("package Telegram live Docker E2E", () => {
  it("supports npm-specific Convex credential aliases", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE");
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")');
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_ROLE="$credential_role")');
  });

  it("defaults CI runs to Convex when broker credentials are present", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'if [ -n "${CI:-}" ] && [ -n "${OPENCLAW_QA_CONVEX_SITE_URL:-}" ]; then',
    );
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_CI");
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_MAINTAINER");
    expect(script).toContain('printf "convex"');
  });

  it("installs the package candidate before forwarding runtime secrets", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const installRunStart = script.indexOf('echo "Running package Telegram live Docker E2E');
    const installRunEnd = script.indexOf("# Mount only test harness/plugin QA sources");
    const installRun = script.slice(installRunStart, installRunEnd);

    expect(installRunStart).toBeGreaterThanOrEqual(0);
    expect(installRunEnd).toBeGreaterThan(installRunStart);
    expect(installRun).toContain('npm install -g "$install_source" --no-fund --no-audit');
    expect(installRun).toContain('"${package_mount_args[@]}"');
    expect(installRun).not.toContain('"${docker_env[@]}"');
    expect(script).toContain("run_logged docker_e2e_run_with_harness");
    expect(script).toContain('"${docker_env[@]}"');
    expect(script).toContain('if [ -z "$credential_role" ] && [ -n "${CI:-}" ]');
    expect(script).toContain('credential_role="ci"');
  });

  it("can install a resolved package tarball instead of a registry spec", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ");
    expect(script).toContain("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(script).toContain(
      'package_mount_args=(-v "$resolved_package_tgz:$package_install_source:ro")',
    );
    expect(script).toContain('validate_openclaw_package_spec "$PACKAGE_SPEC"');
    expect(script.indexOf('if [ -n "$resolved_package_tgz" ]; then')).toBeLessThan(
      script.indexOf('validate_openclaw_package_spec "$PACKAGE_SPEC"'),
    );
  });

  it("keeps private QA harness imports local while using the installed package dist", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const preparePackage = readFileSync(PREPARE_PACKAGE_PATH, "utf8");
    const gatewayRpcClient = readFileSync(
      path.resolve(TEST_DIR, "../../extensions/qa-lab/src/gateway-rpc-client.ts"),
      "utf8",
    );
    const qaRuntimeApi = readFileSync(
      path.resolve(TEST_DIR, "../../extensions/qa-lab/src/runtime-api.ts"),
      "utf8",
    );

    expect(script).toContain('ln -sfnT "$openclaw_package_dir/dist" /app/dist');
    expect(script).toContain('cp "$openclaw_package_dir/package.json" /app/package.json');
    expect(script).toContain('ln -sfnT /app/extensions "$openclaw_package_dir/extensions"');
    expect(script).toContain("node scripts/e2e/lib/npm-telegram-live/prepare-package.mjs");
    expect(script).toContain("/app/node_modules/openclaw/package.json");
    expect(preparePackage).toContain('pkg.exports["./plugin-sdk/gateway-runtime"]');
    expect(preparePackage).toContain('"./dist/plugin-sdk/gateway-runtime.js"');
    expect(gatewayRpcClient).toContain('from "openclaw/plugin-sdk/gateway-runtime"');
    expect(qaRuntimeApi).toContain('from "openclaw/plugin-sdk/gateway-runtime"');
  });

  it("exposes installed package dependencies to the mounted QA harness", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("link_installed_package_dependency()");
    expect(script).toContain(
      'local source="/npm-global/lib/node_modules/openclaw/node_modules/$name"',
    );
    expect(script).toContain('ln -sfn "$source" "$target"');
    expect(script).toContain('link_installed_package_dependency "$dependency"');
    expect(script).toContain("@modelcontextprotocol/sdk");
    expect(script).toContain("yaml");
    expect(script).toContain("zod");
  });

  it("lets npm-specific credential aliases override shared QA env", () => {
    expect(
      __testing.resolveCredentialSource({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
        OPENCLAW_QA_CREDENTIAL_SOURCE: "env",
      }),
    ).toBe("convex");
    expect(
      __testing.resolveCredentialRole({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
        OPENCLAW_QA_CREDENTIAL_ROLE: "maintainer",
      }),
    ).toBe("ci");
  });
});
