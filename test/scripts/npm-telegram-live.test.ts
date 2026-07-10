// Npm Telegram Live tests cover npm telegram live script behavior.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const PREPARE_PACKAGE_PATH = path.resolve(
  TEST_DIR,
  "../../scripts/e2e/lib/npm-telegram-live/prepare-package.mjs",
);
const tempRoots: string[] = [];

function mkTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-npm-telegram-live-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

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
    const installRunEnd = script.indexOf("# Mount only QA harness source");
    const installRun = script.slice(installRunStart, installRunEnd);

    expect(installRunStart).toBeGreaterThanOrEqual(0);
    expect(installRunEnd).toBeGreaterThan(installRunStart);
    expect(installRun).toContain(
      '-e OPENCLAW_E2E_NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"',
    );
    expect(installRun).toContain(
      '"$timeout_bin" --kill-after=30s "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit',
    );
    expect(installRun).toContain("elif command -v gtimeout >/dev/null 2>&1; then");
    expect(installRun).toContain('timeout_bin="gtimeout"');
    expect(installRun).toContain(
      'echo "timeout or gtimeout is required for OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$npm_install_timeout" >&2',
    );
    expect(installRun).toContain('"$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1');
    expect(installRun).toContain(
      '"$timeout_bin" "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit',
    );
    expect(installRun).toContain('npm install -g "$install_source" --no-fund --no-audit');
    expect(installRun).not.toContain(
      "running package install without OPENCLAW_E2E_NPM_INSTALL_TIMEOUT",
    );
    expect(installRun).toContain('"${package_mount_args[@]}"');
    expect(installRun).not.toContain('"${docker_env[@]}"');
    expect(installRun).toContain("run_logged docker_e2e_docker_run_cmd run --rm");
    expect(installRun).not.toContain("run_logged docker run --rm");
    expect(script).toContain("run_logged docker_e2e_run_with_harness");
    expect(script).toContain('docker_e2e_print_log "$run_log"');
    expect(script).not.toContain('cat "$run_log"');
    expect(script).toContain('"${docker_env[@]}"');
    expect(script).toContain(
      'if [ -z "$credential_role" ] && [ "$credential_source" = "convex" ]; then',
    );
    expect(script).toContain('credential_role="ci"');
    expect(script).toContain('credential_role="maintainer"');
  });

  it("bounds installed-package hot path OpenClaw commands", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const runtimeRunStart = script.indexOf("# Mount only QA harness source");
    const runtimeRun = script.slice(runtimeRunStart);

    expect(runtimeRunStart).toBeGreaterThanOrEqual(0);
    expect(script).toContain(
      '-e OPENCLAW_E2E_COMMAND_TIMEOUT="${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}"',
    );
    expect(runtimeRun).toContain("source scripts/lib/openclaw-e2e-instance.sh");
    expect(runtimeRun).toContain("openclaw_e2e_run_command openclaw --version");
    expect(runtimeRun).toContain("openclaw_e2e_run_command openclaw onboard");
    expect(runtimeRun).toContain(
      'OPENAI_API_KEY="$hotpath_openai_api_key" openclaw_e2e_run_command openclaw onboard',
    );
    expect(runtimeRun).not.toContain("export OPENAI_API_KEY=");
    expect(runtimeRun).toContain("openclaw_e2e_run_command openclaw channels add");
    expect(runtimeRun).toContain("openclaw_e2e_run_command openclaw doctor --fix");
    expect(runtimeRun).toContain("openclaw_e2e_run_command openclaw doctor --non-interactive");
    expect(runtimeRun).toContain('openclaw_e2e_print_log "$file"');
    expect(runtimeRun).not.toContain("sed -n '1,220p'");
    expect(runtimeRun).not.toMatch(/^\s*openclaw (onboard|channels add|doctor )/mu);
  });

  it("can install a resolved package tarball instead of a registry spec", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ");
    expect(script).toContain("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(script).toContain('-e OPENCLAW_QA_PACKAGE_SOURCE="$package_install_source"');
    expect(script).toContain('-e OPENCLAW_QA_PACKAGE_SOURCE_KIND="$package_source_kind"');
    expect(script).toContain("OPENCLAW_QA_PACKAGE_SOURCE_SHA");
    expect(script).toContain(
      'package_mount_args=(-v "$resolved_package_tgz:$package_install_source:ro")',
    );
    expect(script).toContain('validate_openclaw_package_spec "$PACKAGE_SPEC"');
    expect(script.indexOf('if [ -n "$resolved_package_tgz" ]; then')).toBeLessThan(
      script.indexOf('validate_openclaw_package_spec "$PACKAGE_SPEC"'),
    );
  });

  it("installs prepared root and companion tarballs through an exact local registry", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR");
    expect(script).toContain('package_source_kind="prepared-package-set"');
    expect(script).toContain('package_install_source="openclaw@$(read_package_version');
    expect(script).toContain('-v "$resolved_package_dir:/package-under-test:ro"');
    expect(script).toContain(
      '-v "$ROOT_DIR/scripts/e2e/lib/plugins/npm-registry-server.mjs:/tmp/openclaw-npm-registry-server.mjs:ro"',
    );
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_PACKAGE_SET");
    expect(script).toContain("node /tmp/openclaw-npm-registry-server.mjs");
    expect(script).toContain("OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org");
    expect(script).toContain('export NPM_CONFIG_REGISTRY="$registry_url"');
  });

  it("keeps live Docker artifacts isolated by default", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'RUN_ID="${OPENCLAW_NPM_TELEGRAM_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"',
    );
    expect(script).toContain(
      'OUTPUT_DIR="${OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-live/$RUN_ID}"',
    );
    expect(script).toContain(
      'OUTPUT_DIR_CONTAINER="/app/.artifacts/qa-e2e/npm-telegram-live-output"',
    );
    expect(script).toContain('-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER"');
    expect(script).not.toContain(
      'OUTPUT_DIR="${OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-live}"',
    );
  });

  it("uses unique direct-run output dirs by default", () => {
    const repoRoot = mkTempRoot();
    const firstDir = testing.resolvePackageTelegramOutputDir({}, repoRoot);
    const secondDir = testing.resolvePackageTelegramOutputDir({}, repoRoot);

    expect(path.dirname(firstDir)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstDir)).toMatch(/^npm-telegram-live-[a-z0-9]+-[a-f0-9]{8}$/u);
    expect(secondDir).not.toBe(firstDir);
    expect(
      testing.resolvePackageTelegramOutputDir(
        { OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: ".artifacts/custom" },
        repoRoot,
      ),
    ).toBe(".artifacts/custom");
  });

  it("keeps the installed OpenClaw command as the package SUT", async () => {
    const prefix = mkTempRoot();
    const command = path.join(prefix, "bin", "openclaw");
    mkdirSync(path.dirname(command), { recursive: true });
    writeFileSync(command, "#!/bin/sh\n");

    await expect(
      testing.resolveTrustedOpenClawCommand(command, {
        NPM_CONFIG_PREFIX: prefix,
      }),
    ).resolves.toEqual({
      executablePath: command,
      usePackagedPlugins: true,
    });
  });

  it("mounts configured output paths before entering the container", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const dockerEnvStart = script.indexOf("docker_env=(");
    const dockerEnvEnd = script.indexOf(")\n\nforward_env_if_set", dockerEnvStart);
    const dockerEnv = script.slice(dockerEnvStart, dockerEnvEnd);

    expect(script).toContain('*) OUTPUT_DIR_HOST="$ROOT_DIR/$OUTPUT_DIR" ;;');
    expect(script).toContain('mkdir -p "$OUTPUT_DIR_HOST"');
    expect(dockerEnv).toContain('-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER"');
    expect(dockerEnv).not.toContain('-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR"');
    expect(script).toContain('-v "$OUTPUT_DIR_HOST:$OUTPUT_DIR_CONTAINER"');
  });

  it("uses the container temp root for OpenClaw runtime scratch files", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const dockerEnvStart = script.indexOf("docker_env=(");
    const dockerEnvEnd = script.indexOf(")\n\nforward_env_if_set", dockerEnvStart);
    const dockerEnv = script.slice(dockerEnvStart, dockerEnvEnd);

    expect(dockerEnvStart).toBeGreaterThanOrEqual(0);
    expect(dockerEnvEnd).toBeGreaterThan(dockerEnvStart);
    expect(dockerEnv).toContain("-e TMPDIR=/tmp");
  });

  it("forwards repeated RTT controls to the package Telegram live lane", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_RTT_CHECKS");
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
    expect(script).toContain('-v "$ROOT_DIR/extensions/qa-lab:/app/extensions/qa-lab:ro"');
    expect(script).not.toContain('ln -sfnT /app/extensions "$openclaw_package_dir/extensions"');
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
      testing.resolveCredentialSource({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
        OPENCLAW_QA_CREDENTIAL_SOURCE: "env",
      }),
    ).toBe("convex");
    expect(
      testing.resolveCredentialRole({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
        OPENCLAW_QA_CREDENTIAL_ROLE: "maintainer",
      }),
    ).toBe("ci");
  });

  it("defaults package Telegram RTT for the normal package live lane", () => {
    expect(testing.resolveRttOptions({})).toEqual({
      rttCount: 20,
      rttTimeoutMs: undefined,
      maxRttFailures: 20,
      rttCheckIds: [],
    });
  });

  it("does not force default RTT onto focused non-RTT scenario runs", () => {
    expect(testing.resolveRttOptions({}, ["telegram-canary"])).toEqual({});
  });

  it("maps repeated RTT env onto package Telegram live options", () => {
    expect(
      testing.resolveRttOptions({
        OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: "7",
        OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS: "45000",
        OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES: "2",
        OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "telegram-mentioned-message-reply",
      }),
    ).toEqual({
      rttCount: 7,
      rttTimeoutMs: 45_000,
      maxRttFailures: 2,
      rttCheckIds: ["telegram-mentioned-message-reply"],
    });
  });

  it("rejects invalid repeated RTT env", () => {
    expect(() =>
      testing.resolveRttOptions({
        OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: "7samples",
      }),
    ).toThrow("invalid OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: 7samples");
  });

  it("gates package Telegram status on the summary artifact", async () => {
    const summaryPath = path.join(mkTempRoot(), "qa-evidence.json");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-05-01T00:00:00.000Z",
        entries: [{ result: { status: "fail" } }],
      }),
      "utf8",
    );

    await expect(
      testing.shouldFailPackageTelegramRun(
        { summaryPath },
        { OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES: "" },
      ),
    ).resolves.toBe(true);
  });

  it("does not read package Telegram summaries when failures are allowed", async () => {
    await expect(
      testing.shouldFailPackageTelegramRun(
        { summaryPath: path.join(mkTempRoot(), "missing-summary.json") },
        { OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES: "1" },
      ),
    ).resolves.toBe(false);
  });
});
