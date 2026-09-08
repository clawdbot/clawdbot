// Live Docker Stage tests cover live docker stage script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("live Docker state staging", () => {
  function linkFixtureNodeModules(root: string) {
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"));
  }

  function writeFixturePackageSpecParser(root: string) {
    const parserPath = path.join(root, "src", "infra", "npm-registry-spec.ts");
    mkdirSync(path.dirname(parserPath), { recursive: true });
    writeFileSync(
      parserPath,
      String.raw`
export function parseRegistryNpmSpec(spec: string) {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9][a-z0-9._-]*)?$/u.test(spec)
    ? { raw: spec }
    : null;
}
`,
    );
  }

  it.each([
    { geminiKey: "test-gemini-key", googleKey: "", expectedType: "gemini-api-key" },
    { geminiKey: "", googleKey: "test-google-key", expectedType: "vertex-ai" },
    { geminiKey: "", googleKey: "", expectedType: "oauth-personal" },
  ])("selects $expectedType from the supplied Gemini credentials", (testCase) => {
    const home = tempDirs.make("openclaw-live-stage-gemini-");
    const settingsPath = path.join(home, ".gemini", "settings.json");
    mkdirSync(path.dirname(settingsPath));
    writeFileSync(
      settingsPath,
      JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
        privacy: { usageStatisticsEnabled: false },
      }),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; openclaw_live_stage_gemini_auth', "bash", stageScriptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          GEMINI_API_KEY: testCase.geminiKey,
          GOOGLE_API_KEY: testCase.googleKey,
          GOOGLE_GENAI_USE_VERTEXAI: "",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.security.auth.selectedType).toBe(testCase.expectedType);
    expect(settings.security.auth.enforcedType).toBe(
      testCase.geminiKey || testCase.googleKey ? testCase.expectedType : undefined,
    );
    expect(settings.privacy).toEqual({ usageStatisticsEnabled: false });
    expect(readFileSync(settingsPath, "utf8")).not.toContain("test-gemini-key");
    expect(readFileSync(settingsPath, "utf8")).not.toContain("test-google-key");
  });

  it("installs missing CLI executables and refreshes pinned packages", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-");
    const binDir = path.join(root, "bin");
    mkdirSync(binDir);
    const npmPath = path.join(binDir, "npm");
    const timeoutPath = path.join(binDir, "timeout");
    writeFileSync(
      npmPath,
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$3" >> "$INSTALL_LOG"\nprintf "#!/usr/bin/env bash\\nprintf fixture-ok" > "$CLI_PATH"\nchmod +x "$CLI_PATH"\n',
    );
    chmodSync(npmPath, 0o755);
    writeFileSync(
      timeoutPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    );
    chmodSync(timeoutPath, 0o755);
    const installLog = path.join(root, "installs.log");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; "$CLI_PATH"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend@1.0.0 10',
        "test",
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CLI_PATH: path.join(binDir, "fixture"),
          INSTALL_LOG: installLog,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("fixture-ok");
    expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
      "@fixture/backend",
      "@fixture/backend@1.0.0",
    ]);
  });

  it("fails explicitly when a selected backend has no executable or install package", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$2" "" 10',
        "test",
        stageScriptPath,
        path.join(root, "missing-cli"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("CLI backend executable was not provisioned:");
  });

  it.each([
    {
      entrypoint: "scripts/test-live.mts",
      expected: "--import tsx scripts/test-live.mts -- target",
    },
    { entrypoint: "scripts/test-live.mjs", expected: "scripts/test-live.mjs -- target" },
  ])("runs the staged $entrypoint live runner", ({ entrypoint, expected }) => {
    const root = tempDirs.make("openclaw-live-stage-entrypoint-");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "calls");
    mkdirSync(path.join(root, path.dirname(entrypoint)), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(root, entrypoint), "");
    writeFileSync(
      path.join(binDir, "node"),
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$*" > "$CALLS_PATH"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_run_staged_script scripts/test-live -- target',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CALLS_PATH: callsPath },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8").trim()).toBe(expected);
  });

  it("refuses to replace a missing staged live runner", () => {
    const root = tempDirs.make("openclaw-live-stage-entrypoint-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set +e; cd "$1"; source "$2"; openclaw_live_run_staged_script scripts/test-live -- target',
        "test",
        root,
        stageScriptPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("staged OpenClaw script entrypoint not found");
  });

  it("installs validated Docker packages from the staged metadata export", () => {
    const root = tempDirs.make("openclaw-live-stage-packages-");
    const binDir = path.join(root, "bin");
    const installLog = path.join(root, "installs.log");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(binDir);
    linkFixtureNodeModules(root);
    writeFixturePackageSpecParser(root);
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      'export async function resolveCliBackendDockerPackages() { return ["@fixture/cli@1.2.3", "fixture-cli"]; }\n',
    );
    writeFileSync(
      path.join(binDir, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(binDir, "npm"),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_prepare_cli_backend_docker_packages "fixture-provider" "fixture-provider/model"',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_LOG: installLog,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
      "install -g @fixture/cli@1.2.3",
      "install -g fixture-cli",
    ]);
  });

  it("allows historical package setup omission only through its derived capability", () => {
    const root = tempDirs.make("openclaw-live-stage-packages-missing-");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    linkFixtureNodeModules(root);
    writeFixturePackageSpecParser(root);
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      "export const legacyMetadata = true;\n",
    );
    const command = [
      "-c",
      'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_prepare_cli_backend_docker_packages "" ""',
      "test",
      root,
      stageScriptPath,
    ];
    const rawControl = spawnSync("bash", command, {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1" },
    });
    expect(rawControl.status).not.toBe(0);
    expect(rawControl.stderr).toContain("does not export resolveCliBackendDockerPackages");

    const derivedCapability = spawnSync("bash", command, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE: "legacy",
      },
    });
    expect(derivedCapability.status, derivedCapability.stderr).toBe(0);
    expect(derivedCapability.stdout).toContain("preserving historical no-package-setup behavior");
  });

  it("lets staged metadata output flush through normal Node completion", () => {
    const source = readFileSync(stageScriptPath, "utf8");
    const moduleStart = source.indexOf("node --import tsx --input-type=module <<'NODE'");
    const moduleEnd = source.indexOf("\nNODE\n", moduleStart);
    expect(moduleStart).toBeGreaterThanOrEqual(0);
    expect(moduleEnd).toBeGreaterThan(moduleStart);
    const moduleSource = source.slice(moduleStart, moduleEnd);
    expect(moduleSource).not.toContain("process.exit(");
    expect(moduleSource.match(/process\.stdout\.write/gu)).toHaveLength(1);
  });

  it("rejects malformed staged package metadata before npm runs", () => {
    const root = tempDirs.make("openclaw-live-stage-packages-malformed-");
    const binDir = path.join(root, "bin");
    const installLog = path.join(root, "installs.log");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(binDir);
    linkFixtureNodeModules(root);
    writeFixturePackageSpecParser(root);
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      'export async function resolveCliBackendDockerPackages() { return ["--force"]; }\n',
    );
    writeFileSync(
      path.join(binDir, "npm"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_prepare_cli_backend_docker_packages "" ""',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_LOG: installLog,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid Docker CLI package");
    expect(() => readFileSync(installLog, "utf8")).toThrow();
  });

  it("defaults frozen-target omissions closed and rejects invalid identity", () => {
    const command = [
      "-c",
      'set -euo pipefail; source "$1"; openclaw_frozen_target_omissions_authorized',
      "test",
      stageScriptPath,
    ];
    const run = (env: Record<string, string>) =>
      spawnSync("bash", command, { encoding: "utf8", env: { ...process.env, ...env } });

    expect(run({}).status).toBe(1);
    const sameSha = run({
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
      OPENCLAW_SELECTED_SHA: "a".repeat(40),
      OPENCLAW_TOOLING_SHA: "a".repeat(40),
    });
    expect(sameSha.status).toBe(2);
    expect(sameSha.stderr).toContain("require distinct selected and tooling SHAs");

    const malformed = run({
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes",
      OPENCLAW_SELECTED_SHA: "a".repeat(40),
      OPENCLAW_TOOLING_SHA: "b".repeat(40),
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
  });

  it("falls back without frozen context but fails malformed authorization", () => {
    const command = [
      "-c",
      'set -euo pipefail; source "$1"; openclaw_resolve_frozen_target_file "$2" missing/path fallback',
      "test",
      stageScriptPath,
      repoRoot,
    ];
    const run = (env: Record<string, string>) =>
      spawnSync("bash", command, { encoding: "utf8", env: { ...process.env, ...env } });

    const absent = run({});
    expect(absent.status).toBe(0);
    expect(absent.stdout).toBe("fallback\n");

    const malformed = run({ OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes" });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
  });

  it("can omit a contract file absent from an authorized frozen target", () => {
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_resolve_frozen_target_file "$2" missing/path current-path ""',
        "test",
        stageScriptPath,
        repoRoot,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: selectedSha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("\n");
  });

  it("keeps a matching frozen-source capability under pipefail", () => {
    const root = tempDirs.make("openclaw-frozen-target-capability-");
    const sourcePath = path.join(root, "scripts/e2e/lib/plugins/assertions.mjs");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, `function assertPluginTgzRemoved()\n${"x\n".repeat(100_000)}`);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_frozen_target_source_contains "$2" scripts/e2e/lib/plugins/assertions.mjs "function assertPluginTgzRemoved()"',
        "test",
        stageScriptPath,
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_SELECTED_SHA: selectedSha,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("derives frozen harness capabilities only from an authorized selected source", () => {
    const root = tempDirs.make("openclaw-frozen-target-core-dialects-");
    mkdirSync(path.join(root, "src/agents"), { recursive: true });
    mkdirSync(path.join(root, "src/agents/embedded-agent-runner/run"), { recursive: true });
    mkdirSync(path.join(root, "src/commands"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "src/agents/code-mode-namespaces.ts"),
      'export const globals = ["ALL_TOOLS"];\n',
    );
    writeFileSync(
      path.join(root, "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts"),
      "import { extractInternalRuntimeContext } from '../../internal-runtime-context.js';\ntype Params = {\n  modelPrompt?: string;\n};\n",
    );
    writeFileSync(
      path.join(root, "src/commands/doctor-session-transcripts.ts"),
      'const backup = ".pre-doctor-branch-repair-";\n',
    );
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      "export const legacyMetadata = true;\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const resolveCoreDialects = [
      "-c",
      'set -euo pipefail; source "$1"; openclaw_resolve_frozen_core_harness_capabilities "$2"; openclaw_resolve_frozen_live_cli_backend_package_mode "$2"; printf "%s %s %s %s\\n" "$OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE" "$OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE" "$OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE" "$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE"',
      "test",
      stageScriptPath,
      root,
    ] as const;

    const strictResult = spawnSync("bash", resolveCoreDialects, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
      },
    });

    expect(strictResult.status, strictResult.stderr).toBe(0);
    expect(strictResult.stdout.trim()).toBe("sqlite current current producer-fragments");

    const result = spawnSync("bash", resolveCoreDialects, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
        OPENCLAW_SELECTED_SHA: selectedSha,
        OPENCLAW_TOOLING_SHA: "b".repeat(40),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("jsonl legacy legacy legacy-marked-prompt");
  });

  it.each([
    {
      name: "producer fragments",
      source:
        "type Params = {\n  fragments?: RuntimeContextFragment[];\n};\nconst fragments = params.fragments?.filter(Boolean);\n",
      expected: "producer-fragments",
    },
    {
      name: "mixed producer and marker extraction",
      source:
        "import { extractInternalRuntimeContext } from '../../internal-runtime-context.js';\ntype Params = {\n  fragments?: RuntimeContextFragment[];\n  modelPrompt?: string;\n};\nconst fragments = params.fragments?.filter(Boolean);\n",
      error: "unable to resolve frozen runtime-context input contract",
    },
    {
      name: "unknown shape",
      source: "export const runtimeContext = true;\n",
      error: "unable to resolve frozen runtime-context input contract",
    },
  ])("classifies $name from the selected source", ({ source, expected, error }) => {
    const root = tempDirs.make("openclaw-frozen-target-runtime-context-");
    const sourcePath = path.join(
      root,
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts",
    );
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_resolve_frozen_core_harness_capabilities "$2"; printf "%s\\n" "$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE"',
        "test",
        stageScriptPath,
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: selectedSha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
        },
      },
    );

    if (expected) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
      return;
    }
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(error);
  });

  it.each([
    "src/agents/subagent-announce.live.test.ts",
    "src/agents/subagents/announce/subagent-announce.live.test.ts",
  ])("resolves the staged announce test by unique basename: %s", (relativePath) => {
    const root = tempDirs.make("openclaw-live-stage-announce-");
    mkdirSync(path.join(root, path.dirname(relativePath)), { recursive: true });
    writeFileSync(path.join(root, relativePath), "");

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$2"; relative="$(openclaw_live_resolve_unique_staged_file "$1/src/agents" subagent-announce.live.test.ts)"; printf "src/agents/%s\\n" "$relative"',
        "test",
        root,
        stageScriptPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(relativePath);
  });

  it("rejects missing or ambiguous staged announce tests", () => {
    const root = tempDirs.make("openclaw-live-stage-announce-invalid-");
    const command = [
      "-c",
      'set -euo pipefail; source "$2"; openclaw_live_resolve_unique_staged_file "$1/src/agents" subagent-announce.live.test.ts',
      "test",
      root,
      stageScriptPath,
    ];

    const missing = spawnSync("bash", command, { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("no staged file matched");

    for (const directory of ["old", "current"]) {
      mkdirSync(path.join(root, "src", "agents", directory), { recursive: true });
      writeFileSync(
        path.join(root, "src", "agents", directory, "subagent-announce.live.test.ts"),
        "",
      );
    }
    const ambiguous = spawnSync("bash", command, { encoding: "utf8" });
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("multiple staged files matched");
  });

  it("keeps repo-local generated artifacts out of the source copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=.artifacts");
    expect(script).toContain('node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs"');
  });

  it("adds private SDK source exports only to the disposable source stage", () => {
    const root = tempDirs.make("openclaw-live-stage-sdk-");
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "plugin-sdk"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" } }),
    );
    writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["keyed-async-queue"]),
    );
    writeFileSync(path.join(root, "src", "plugin-sdk", "keyed-async-queue.ts"), "export {};\n");

    addStagedPrivatePluginSdkExports(root);

    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      "./plugin-sdk/core": "./dist/plugin-sdk/core.js",
      "./plugin-sdk/keyed-async-queue": {
        types: "./src/plugin-sdk/keyed-async-queue.ts",
        default: "./src/plugin-sdk/keyed-async-queue.ts",
      },
    });
  });

  it("keeps host-only generated registry state out of the container copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=workspace");
    expect(script).toContain("--exclude=sandboxes");
    expect(script).toContain("--exclude=plugins/installs.json");
    expect(script).toContain("--exclude=plugins/installs.json.migrated");
    expect(script).toContain(
      `db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run("plugins.installedIndex");`,
    );
    expect(script).toContain("PRAGMA secure_delete = ON");
    expect(script).toContain("VACUUM");
    expect(script).toContain("host-absolute paths");
  });
});
