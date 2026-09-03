// Npm Telegram Live tests cover npm telegram live script behavior.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const PREPARE_PACKAGE_PATH = path.resolve(
  TEST_DIR,
  "../../scripts/e2e/lib/npm-telegram-live/prepare-package.mts",
);
const tempRoots: string[] = [];

function mkTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-npm-telegram-live-"));
  tempRoots.push(root);
  return root;
}

function runHotpathCandidate(consentSupported: boolean) {
  const root = mkTempRoot();
  const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
  const hotpath = script.slice(
    script.indexOf('if [ "${OPENCLAW_NPM_TELEGRAM_SKIP_HOTPATH:-0}" != "1" ]'),
    script.indexOf('\nexport OPENCLAW_NPM_TELEGRAM_SUT_COMMAND="$sut_command"'),
  );
  writeFileSync(
    path.join(root, "openclaw"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ARGV_LOG"; if [[ "$*" == "plugins install --help" && "$CONSENT_SUPPORTED" == "1" ]]; then printf '  --accept-capabilities  Accept reviewed plugin capabilities\\n'; fi
`,
    { mode: 0o755 },
  );
  execFileSync(
    "bash",
    [
      "-c",
      `set -Eeuo pipefail
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_run_command() { "$@"; }
runtime_home="$FIXTURE_ROOT/runtime"
mkdir -p "$runtime_home"
sut_command="$FIXTURE_ROOT/openclaw"
${hotpath}`,
    ],
    {
      cwd: path.resolve(TEST_DIR, "../.."),
      env: {
        ...process.env,
        ARGV_LOG: path.join(root, "argv.log"),
        CONSENT_SUPPORTED: consentSupported ? "1" : "0",
        FIXTURE_ROOT: root,
      },
    },
  );
  return readFileSync(path.join(root, "argv.log"), "utf8").trim().split("\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("package Telegram live Docker E2E", () => {
  it("forwards npm-specific credential aliases through the Docker boundary", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    for (const contract of [
      "OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE",
      "OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE",
      'docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")',
      'docker_env+=(-e OPENCLAW_QA_CREDENTIAL_ROLE="$credential_role")',
    ]) {
      expect(script).toContain(contract);
    }
  });

  it("installs the package candidate before forwarding runtime secrets", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const installRunStart = script.indexOf('echo "Running package Telegram live Docker E2E');
    const installRunEnd = script.indexOf("# Mount the trusted current-source QA harness");
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
    expect(installRun).toContain(
      'run_logged_print_heartbeat "npm-telegram-package-install" 60 docker_e2e_docker_run_cmd run --rm',
    );
    expect(installRun).not.toContain("run_logged_print_heartbeat docker run --rm");
    expect(script).toContain(
      'run_logged_print_heartbeat "npm-telegram-live-suite" 60 docker_e2e_run_with_harness',
    );
    expect(script).not.toContain('cat "$run_log"');
    expect(script).toContain('"${docker_env[@]}"');
    expect(script).toContain(
      'if [ -z "$credential_role" ] && [ "$credential_source" = "convex" ]; then',
    );
    expect(script).toContain('credential_role="ci"');
    expect(script).toContain('credential_role="maintainer"');
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
    const harnessCommand = path.join(mkTempRoot(), "bin", "openclaw");
    mkdirSync(path.dirname(command), { recursive: true });
    mkdirSync(path.dirname(harnessCommand), { recursive: true });
    writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(harnessCommand, "#!/bin/sh\n", { mode: 0o755 });

    await expect(
      testing.resolveTrustedOpenClawCommand(command, {
        NPM_CONFIG_PREFIX: prefix,
      }),
    ).resolves.toEqual({
      executablePath: command,
      usePackagedPlugins: true,
    });
    await expect(
      testing.resolveTrustedOpenClawCommand(harnessCommand, {
        NPM_CONFIG_PREFIX: prefix,
      }),
    ).rejects.toThrow("OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must resolve inside NPM_CONFIG_PREFIX.");
  });

  it("mounts the QA taxonomy and userbot skill without exposing the repository root", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain('-v "$ROOT_DIR/taxonomy.yaml:/app/taxonomy.yaml:ro"');
    expect(script).toContain('-v "$ROOT_DIR/.agents:/app/.agents:ro"');
    expect(script).not.toContain('-v "$ROOT_DIR:/app');
  });

  it("requires Convex leases instead of static Telegram credentials", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("Telegram package QA requires Convex credential mode.");
    expect(script).not.toContain("OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN");
    expect(script).not.toContain("OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN");
  });

  it("mounts configured output paths before entering the container", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const dockerEnvStart = script.indexOf("docker_env=(");
    const dockerEnvEnd = script.indexOf(")\n\nforward_env_if_set", dockerEnvStart);
    const dockerEnv = script.slice(dockerEnvStart, dockerEnvEnd);

    expect(script).toContain('*) OUTPUT_DIR_HOST="$ROOT_DIR/$OUTPUT_DIR" ;;');
    expect(script).toContain('mkdir -p "$OUTPUT_DIR_HOST"');
    expect(script).toContain(
      'printf \'schema=1\\nexit_code=%s\\nlive_output=job_log\\n\' "$rc" > "$OUTPUT_DIR_HOST/run-metadata.txt"',
    );
    expect(script).toContain("trap cleanup EXIT");
    expect(dockerEnv).toContain(
      '-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER_RELATIVE"',
    );
    expect(dockerEnv).not.toContain('-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER"');
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

  it("forwards destructive downgrade approval only through the explicit env list", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const dockerEnvStart = script.indexOf("docker_env=(");
    const dockerEnvEnd = script.indexOf(")\n\nforward_env_if_set", dockerEnvStart);
    const forwardingStart = script.indexOf("for key in \\", dockerEnvEnd);
    const forwardingEnd = script.indexOf("; do", forwardingStart);

    expect(script.slice(dockerEnvStart, dockerEnvEnd)).not.toContain(
      "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
    expect(script.slice(forwardingStart, forwardingEnd)).toContain(
      "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
  });

  it("isolates the trusted private QA harness from the installed package candidate", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    expect(script).toContain('cp "$ROOT_DIR/package.json" "$harness_package_json"');
    expect(script).toContain(
      'node --import tsx "$ROOT_DIR/scripts/e2e/lib/npm-telegram-live/prepare-package.mts" "$harness_package_json"',
    );
    expect(script).toContain('-v "$harness_package_json:/app/package.json:ro"');
    expect(script).toContain('-v "$ROOT_DIR/dist:/app/dist:ro"');
    expect(script).toContain('-v "$ROOT_DIR/node_modules:/trusted-harness/node_modules:ro"');
    expect(script).toContain('-v "$ROOT_DIR/packages:/app/packages:ro"');
    expect(script).toContain('-v "$ROOT_DIR/extensions:/app/extensions:ro"');
    expect(script).toContain('-v "$ROOT_DIR/taxonomy.yaml:/app/taxonomy.yaml:ro"');
    expect(script).toContain('-v "$ROOT_DIR/qa/scenarios:/app/qa/scenarios:ro"');
    expect(script).toContain("for dependency_dir in /trusted-harness/node_modules/*");
    expect(script).toContain("for workspace_dir in /app/packages/* /app/extensions/*");
    expect(script).toContain('link_harness_dependency "$workspace_dir" "$workspace_name"');
    expect(script).toContain("link_harness_dependency /app openclaw");
    expect(script).not.toContain('openclaw_package_dir="/npm-global/lib/node_modules/openclaw"');
    expect(script).not.toContain('cp "$openclaw_package_dir/package.json" /app/package.json');
    expect(script).not.toContain("/app/node_modules/openclaw/package.json");
    expect(script).not.toContain("link_installed_package_dependency");
  });

  it.each([false, true])(
    "runs the onboarding hotpath with candidate consent support=%s",
    (supported) => {
      const calls = runHotpathCandidate(supported);
      expect(calls.filter((call) => call.startsWith("plugins install @openclaw/codex"))).toEqual(
        supported ? ["plugins install @openclaw/codex --accept-capabilities"] : [],
      );
      expect(calls.some((call) => call.startsWith("onboard "))).toBe(true);
    },
  );

  it("adds private SDK exports only to the trusted harness manifest", () => {
    const root = mkTempRoot();
    const harnessManifestPath = path.join(root, "harness-package.json");
    const candidateManifestPath = path.join(root, "candidate-package.json");
    const existingGatewayExport = {
      types: "./existing/gateway-runtime.d.ts",
      default: "./existing/gateway-runtime.js",
    };
    writeFileSync(
      harnessManifestPath,
      `${JSON.stringify({
        name: "openclaw",
        exports: {
          "./kept": "./dist/kept.js",
          "./plugin-sdk/gateway-runtime": existingGatewayExport,
        },
      })}\n`,
    );
    writeFileSync(candidateManifestPath, '{"name":"candidate","exports":{}}\n');
    const candidateBefore = readFileSync(candidateManifestPath, "utf8");

    execFileSync(process.execPath, [PREPARE_PACKAGE_PATH, harnessManifestPath]);

    const prepared = JSON.parse(readFileSync(harnessManifestPath, "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(prepared.exports["./kept"]).toBe("./dist/kept.js");
    expect(prepared.exports["./plugin-sdk/gateway-runtime"]).toEqual(existingGatewayExport);
    expect(prepared.exports["./plugin-sdk/qa-runtime"]).toEqual({
      default: "./dist/plugin-sdk/qa-runtime.js",
    });
    expect(prepared.exports["./plugin-sdk/qa-lab"]).toEqual({
      default: "./dist/plugin-sdk/qa-lab.js",
    });
    for (const subpath of privateLocalOnlyPluginSdkEntrypoints) {
      expect(prepared.exports[`./plugin-sdk/${subpath}`]).toEqual({
        default: `./dist/plugin-sdk/${subpath}.js`,
      });
    }
    expect(readFileSync(candidateManifestPath, "utf8")).toBe(candidateBefore);
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
      scenarioId: "channel-canary",
      count: 20,
      timeoutMs: 30_000,
      maxFailures: 20,
    });
  });

  it("does not force default RTT onto focused non-RTT scenario runs", () => {
    expect(testing.resolveRttOptions({}, ["telegram-status-command"])).toBeUndefined();
  });

  it("maps repeated RTT env onto package Telegram live options", () => {
    expect(
      testing.resolveRttOptions({
        OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: "7",
        OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS: "45000",
        OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES: "2",
        OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "channel-canary",
      }),
    ).toEqual({
      scenarioId: "channel-canary",
      count: 7,
      timeoutMs: 45_000,
      maxFailures: 2,
    });
  });

  it("selects an explicit exact-marker RTT scenario without SCENARIOS duplication", () => {
    const env = {
      OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "telegram-reply-chain-exact-marker",
    };
    const seenScenarioIds: string[][] = [];
    const selection = testing.resolvePackageTelegramScenarios(env, (scenarioIds) => {
      seenScenarioIds.push([...scenarioIds]);
      return [...new Set(scenarioIds)];
    });

    expect(selection).toEqual({
      explicitRttScenarioId: "telegram-reply-chain-exact-marker",
      scenarioIds: ["telegram-reply-chain-exact-marker"],
      resolvedScenarioIds: ["telegram-reply-chain-exact-marker"],
    });
    expect(seenScenarioIds).toEqual([["telegram-reply-chain-exact-marker"]]);
    expect(testing.resolveRttOptions(env, selection.scenarioIds)).toMatchObject({
      scenarioId: "telegram-reply-chain-exact-marker",
    });
  });

  it("promotes the explicit RTT scenario while canonical selection deduplicates in order", () => {
    const selection = testing.resolvePackageTelegramScenarios(
      {
        OPENCLAW_NPM_TELEGRAM_SCENARIOS:
          "telegram-status-command,telegram-reply-chain-exact-marker,telegram-status-command",
        OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "telegram-reply-chain-exact-marker",
      },
      (scenarioIds) => [...new Set(scenarioIds)],
    );

    expect(selection.scenarioIds).toEqual([
      "telegram-reply-chain-exact-marker",
      "telegram-status-command",
      "telegram-status-command",
    ]);
    expect(selection.resolvedScenarioIds).toEqual([
      "telegram-reply-chain-exact-marker",
      "telegram-status-command",
    ]);
  });

  it("rejects multiple explicit RTT scenario ids", () => {
    expect(() =>
      testing.resolvePackageTelegramScenarioSelection({
        OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "channel-canary,telegram-reply-chain-exact-marker",
      }),
    ).toThrow("OPENCLAW_NPM_TELEGRAM_RTT_CHECKS accepts at most one scenario id; got 2");
  });

  it("rejects unknown explicit RTT scenario ids through canonical selection", () => {
    expect(() =>
      testing.resolvePackageTelegramScenarios(
        {
          OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "telegram-unknown-rtt-check",
        },
        (scenarioIds) => {
          throw new Error(`unknown QA scenario id(s): ${scenarioIds.join(", ")}`);
        },
      ),
    ).toThrow("unknown QA scenario id(s): telegram-unknown-rtt-check");
  });

  it("builds a generic suite probe for the Telegram RTT lane", () => {
    const probe = testing.createRoundTripProbe(testing.resolveRttOptions({}));

    expect(probe).toMatchObject({
      scenarioId: "channel-canary",
      count: 20,
      timeoutMs: 30_000,
      markerPrefix: "QA-TELEGRAM-RTT",
      textPrefix: "@openclaw Telegram RTT check. Reply exactly: ",
      chainReplies: true,
      input: {
        conversation: { id: "telegram-rtt-room", kind: "group" },
      },
    });
  });

  it.each([
    {
      name: "promotes the default canary before taxonomy-backed release selection",
      env: {},
      requested: [],
      resolved: ["telegram-status-command"],
      expected: ["channel-canary", "telegram-status-command"],
    },
    {
      name: "keeps focused non-RTT selections unchanged",
      env: {},
      requested: ["telegram-status-command"],
      resolved: ["telegram-status-command"],
      expected: ["telegram-status-command"],
    },
    {
      name: "promotes an explicitly requested RTT canary",
      env: { OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "channel-canary" },
      requested: ["telegram-status-command"],
      resolved: ["telegram-status-command"],
      expected: ["channel-canary", "telegram-status-command"],
    },
    {
      name: "does not duplicate an already selected RTT canary",
      env: {},
      requested: ["telegram-status-command", "channel-canary"],
      resolved: ["telegram-status-command", "channel-canary"],
      expected: ["channel-canary", "telegram-status-command"],
    },
  ])("$name", ({ env, requested, resolved, expected }) => {
    const options = testing.resolveRttOptions(env, requested);

    expect(testing.prioritizeRoundTripProbeScenario(resolved, options)).toEqual(expected);
  });

  it("rejects invalid repeated RTT env", () => {
    expect(() =>
      testing.resolveRttOptions({
        OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: "7samples",
      }),
    ).toThrow("invalid OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: 7samples");
  });

  it.each(["2026.6.33", "2026.7.1-beta.6", "2026.7.1", "2026.7.2-beta.2", "2026.7.2-beta.3"])(
    "projects current config for historical package %s",
    (packageVersion) => {
      const mutateConfig = testing.resolvePackageConfigMutation({
        OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION: packageVersion,
      });
      const config = {
        agents: {
          defaults: {
            workspace: "/tmp/qa",
            models: {
              "openai/gpt-5.6-luna": {
                alias: "qa",
                agentRuntime: { id: "openclaw" },
              },
            },
            modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
          },
          entries: {
            qa: {
              default: true,
              model: "mock-openai/qa",
            },
          },
        },
        memory: {
          backend: "builtin",
          citations: "off",
          qmd: { command: "qmd" },
          search: { enabled: false },
        },
        plugins: {
          enabled: true,
        },
      } as Parameters<NonNullable<typeof mutateConfig>>[0];

      expect(mutateConfig?.(config)).toEqual({
        agents: {
          defaults: {
            workspace: "/tmp/qa",
            models: {
              "openai/gpt-5.6-luna": {
                alias: "qa",
                agentRuntime: { id: "openclaw" },
              },
            },
          },
          list: [
            {
              default: true,
              id: "qa",
              model: "mock-openai/qa",
            },
          ],
        },
        memory: {
          backend: "builtin",
          citations: "off",
          qmd: { command: "qmd" },
        },
        plugins: config.plugins,
      });
      expect(config.agents).toHaveProperty("entries.qa");
      expect(config.memory).toHaveProperty("search.enabled", false);
    },
  );

  it.each([
    "2026.7.2-beta.4",
    "2026.7.2-beta.5",
    "2026.7.2",
    "main",
    "latest",
    "beta",
    "2026.7.2-beta.3-extra",
  ])("leaves current or nonexact package version %s unchanged", (packageVersion) => {
    expect(
      testing.resolvePackageConfigMutation({
        OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION: packageVersion,
      }),
    ).toBeUndefined();
  });

  it("preserves the frozen 2026.6.35 package projection", () => {
    const mutateConfig = testing.resolvePackageConfigMutation({
      OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION: "2026.6.35",
    });
    const config = {
      agents: {
        defaults: {
          mediaModels: {
            image: "mock-openai/image",
            audio: "mock-openai/audio",
          },
          modelPolicy: { allow: ["mock-openai/qa"] },
          workspace: "/tmp/qa",
        },
        entries: {
          qa: {
            default: true,
            model: "mock-openai/qa",
          },
        },
      },
      memory: {
        search: { enabled: false },
      },
      plugins: {
        enabled: true,
      },
    } as Parameters<NonNullable<typeof mutateConfig>>[0];

    expect(mutateConfig?.(config)).toEqual({
      agents: {
        defaults: {
          imageGenerationModel: "mock-openai/image",
          workspace: "/tmp/qa",
        },
        list: [
          {
            default: true,
            id: "qa",
            model: "mock-openai/qa",
          },
        ],
      },
      memory: { backend: "builtin" },
      plugins: {
        bundledDiscovery: "compat",
        enabled: true,
      },
    });
  });

  it.each(["fail", "skip", "skipped", "timeout"])(
    "fails package Telegram QA when a scenario has %s status",
    async (status) => {
      const summaryPath = path.join(mkTempRoot(), "qa-suite-summary.json");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          run: { status: "completed" },
          scenarios: [{ status }],
        }),
        "utf8",
      );

      await expect(
        testing.shouldFailPackageTelegramRun(
          { summaryPath },
          { OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES: "" },
        ),
      ).resolves.toBe(true);
    },
  );

  it("passes package Telegram QA when every scenario passes", async () => {
    const summaryPath = path.join(mkTempRoot(), "qa-suite-summary.json");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        run: { status: "completed" },
        scenarios: [{ status: "pass" }],
      }),
      "utf8",
    );

    await expect(
      testing.shouldFailPackageTelegramRun(
        { summaryPath },
        { OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES: "" },
      ),
    ).resolves.toBe(false);
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
