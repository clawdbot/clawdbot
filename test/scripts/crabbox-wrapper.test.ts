import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
const fakeCrabboxBinDirs = new Map<string, string>();

function makeFakeCrabbox(helpText: string): string {
  const cached = fakeCrabboxBinDirs.get(helpText);
  if (cached) {
    return cached;
  }
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-crabbox-"));
  tempDirs.push(binDir);
  writeFakeCrabbox(binDir, helpText);
  fakeCrabboxBinDirs.set(helpText, binDir);
  return binDir;
}

function writeFakeCrabbox(binDir: string, helpText: string): string {
  mkdirSync(binDir, { recursive: true });
  const crabboxPath = path.join(binDir, "crabbox");
  const helperPath = path.join(binDir, "fake-crabbox-json.cjs");

  if (process.platform !== "win32") {
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  printf "%s\\n" "crabbox 0.15.0"',
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ] && [ "$2" = "--help" ]; then',
      `  printf "%s" ${shellSingleQuote(helpText)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "config" ] && [ "$2" = "show" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "--json" ]; then',
      '      status="${OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS:-0}"',
      '      if [ "$status" != "0" ]; then',
      '        printf "%s\\n" "config unavailable" >&2',
      '        exit "$status"',
      "      fi",
      '      if [ -n "${OPENCLAW_FAKE_CRABBOX_CONFIG_JSON+x}" ]; then',
      '        printf "%s" "$OPENCLAW_FAKE_CRABBOX_CONFIG_JSON"',
      "      else",
      '        printf "%s" "{\\"coordinator\\":\\"configured-broker\\",\\"brokerAuth\\":\\"configured\\"}"',
      "      fi",
      "      exit 0",
      "    fi",
      "  done",
      "fi",
      'for arg in "$@"; do',
      '  if [ "$arg" = "--artifact-glob" ] || [ "$arg" = "-artifact-glob" ]; then',
      "    mkdir -p .crabbox/runs/run_fake",
      '    printf "%s\\n" "fake artifact" > .crabbox/runs/run_fake/fake-artifacts.tgz',
      "  fi",
      "done",
      'script_path=""',
      'previous_arg=""',
      'for arg in "$@"; do',
      '  if [ "$previous_arg" = "--script" ] || [ "$previous_arg" = "-script" ]; then',
      '    script_path="$arg"',
      "    break",
      "  fi",
      '  previous_arg="$arg"',
      "done",
      'printf "%s\\0" "__OPENCLAW_FAKE_CRABBOX_V1__"',
      'printf "%s\\0" "$PWD"',
      'printf "%s\\0" "$#"',
      'for arg in "$@"; do',
      '  printf "%s\\0" "$arg"',
      "done",
      'if [ -n "$script_path" ] && [ -f "$script_path" ]; then',
      '  cat "$script_path"',
      "fi",
    ].join("\n");
    writeFileSync(crabboxPath, `${script}\n`, "utf8");
    chmodSync(crabboxPath, 0o755);
    return crabboxPath;
  }

  const helperScript = [
    "const args = process.argv.slice(2);",
    'if (args[0] === "config" && args[1] === "show" && args.includes("--json")) {',
    "  const status = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS || '0', 10);",
    "  if (status !== 0) {",
    "    process.stderr.write('config unavailable\\n');",
    "    process.exit(status);",
    "  }",
    '  process.stdout.write(process.env.OPENCLAW_FAKE_CRABBOX_CONFIG_JSON || \'{"coordinator":"configured-broker","brokerAuth":"configured"}\');',
    "  process.exit(0);",
    "}",
    "const scriptIndex = args.findIndex((arg) => arg === '--script' || arg === '-script');",
    "const scriptPath = scriptIndex >= 0 ? args[scriptIndex + 1] : '';",
    "const scriptContent = scriptPath ? require('node:fs').readFileSync(scriptPath, 'utf8') : '';",
    "if (args.includes('--artifact-glob') || args.includes('-artifact-glob')) {",
    "  require('node:fs').mkdirSync('.crabbox/runs/run_fake', { recursive: true });",
    "  require('node:fs').writeFileSync('.crabbox/runs/run_fake/fake-artifacts.tgz', 'fake artifact\\n');",
    "}",
    "console.log(JSON.stringify({ args, cwd: process.cwd(), scriptContent }));",
  ].join("\n");
  writeFileSync(helperPath, `${helperScript}\n`, "utf8");

  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    '  console.log("crabbox 0.15.0");',
    "  process.exit(0);",
    "}",
    'if (args[0] === "run" && args[1] === "--help") {',
    `  process.stdout.write(${JSON.stringify(helpText)});`,
    "  process.exit(0);",
    "}",
    `require(${JSON.stringify(helperPath)});`,
  ].join("\n");
  writeFileSync(crabboxPath, `${script}\n`, "utf8");
  writeFileSync(
    `${crabboxPath}.cmd`,
    `@echo off\r\n"${process.execPath}" "%~dp0crabbox" %*\r\n`,
    "utf8",
  );
  chmodSync(crabboxPath, 0o755);
  return crabboxPath;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeFakeGit(
  responses: Record<string, { status?: number; stdout?: string; stderr?: string }>,
): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-git-"));
  tempDirs.push(binDir);
  const gitPath = path.join(binDir, "git");
  if (process.platform !== "win32") {
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
      '  mkdir -p "$4"',
      "  exit 0",
      "fi",
      'if [ "$1" = "-C" ] && [ "$3" = "sparse-checkout" ] && [ "$4" = "disable" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "-C" ] && [ "$3" = "reset" ] && [ "$4" = "--mixed" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      "  exit 0",
      "fi",
      ...Object.entries(responses).flatMap(([key, response]) => {
        const args = key.split("\u0000");
        return [
          `if ${shellArgListCondition(args)}; then`,
          response.stdout ? `  printf "%s" ${shellSingleQuote(response.stdout)}` : "",
          response.stderr ? `  printf "%s" ${shellSingleQuote(response.stderr)} >&2` : "",
          `  exit ${response.status ?? 0}`,
          "fi",
        ].filter(Boolean);
      }),
      "exit 1",
    ].join("\n");
    writeFileSync(gitPath, `${script}\n`, "utf8");
    chmodSync(gitPath, 0o755);
    return binDir;
  }

  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const responses = new Map(Object.entries(JSON.parse(process.env.OPENCLAW_FAKE_GIT_RESPONSES || '{}')));",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'worktree' && args[1] === 'add') { fs.mkdirSync(args[3], { recursive: true }); process.exit(0); }",
    "if (args[0] === '-C' && args[2] === 'sparse-checkout' && args[3] === 'disable') { process.exit(0); }",
    "if (args[0] === '-C' && args[2] === 'reset' && args[3] === '--mixed') { process.exit(0); }",
    "if (args[0] === 'worktree' && args[1] === 'remove') { process.exit(0); }",
    "const key = args.join('\\u0000');",
    "const response = responses.get(key);",
    "if (!response) { process.exit(1); }",
    "if (response.stdout) process.stdout.write(response.stdout);",
    "if (response.stderr) process.stderr.write(response.stderr);",
    "process.exit(response.status ?? 0);",
  ].join("\n");
  writeFileSync(gitPath, `${script}\n`, "utf8");
  writeFileSync(`${gitPath}.cmd`, `@echo off\r\n"${process.execPath}" "%~dp0git" %*\r\n`, "utf8");
  chmodSync(gitPath, 0o755);
  return binDir;
}

function shellArgListCondition(args: string[]): string {
  const checks = [`[ "$#" -eq ${args.length} ]`];
  for (const [index, arg] of args.entries()) {
    checks.push(`[ "$${index + 1}" = ${shellSingleQuote(arg)} ]`);
  }
  return checks.join(" && ");
}

function runWrapper(
  helpText: string,
  args: string[],
  options: {
    configJson?: Record<string, unknown>;
    configStatus?: number;
    env?: Record<string, string>;
    extraPathEntries?: string[];
    gitResponses?: Record<string, { status?: number; stdout?: string; stderr?: string }>;
    input?: string;
  } = {},
) {
  const binDir = makeFakeCrabbox(helpText);
  const gitBinDir = options.gitResponses ? makeFakeGit(options.gitResponses) : "";
  return spawnSync(process.execPath, ["scripts/crabbox-wrapper.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      PATH: [...(options.extraPathEntries ?? []), binDir, gitBinDir, process.env.PATH ?? ""]
        .filter(Boolean)
        .join(path.delimiter),
      CRABBOX_PROVIDER: "",
      OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
      ...(options.configJson
        ? { OPENCLAW_FAKE_CRABBOX_CONFIG_JSON: JSON.stringify(options.configJson) }
        : {}),
      ...(options.configStatus
        ? { OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS: String(options.configStatus) }
        : {}),
      ...(options.env ?? {}),
      ...(options.gitResponses
        ? { OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(options.gitResponses) }
        : {}),
    },
    timeout: 10_000,
  });
}

function parseFakeCrabboxOutput(result: ReturnType<typeof runWrapper>): {
  args: string[];
  cwd: string;
  scriptContent?: string;
} {
  const marker = "__OPENCLAW_FAKE_CRABBOX_V1__\0";
  if (result.stdout.startsWith(marker)) {
    let offset = marker.length;
    const readField = () => {
      const end = result.stdout.indexOf("\0", offset);
      if (end < 0) {
        throw new Error("missing fake Crabbox output field terminator");
      }
      const value = result.stdout.slice(offset, end);
      offset = end + 1;
      return value;
    };
    const cwd = readField();
    const argCount = Number.parseInt(readField(), 10);
    const args = Array.from({ length: argCount }, () => readField());
    const scriptContent = result.stdout.slice(offset);
    return { args, cwd, scriptContent };
  }
  return JSON.parse(result.stdout.trim()) as {
    args: string[];
    cwd: string;
    scriptContent?: string;
  };
}

function normalizeShellLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function expectGroupedShellCommand(remoteCommand: string, command: string): void {
  expect(remoteCommand).toContain(`&& { ${command}`);
  if (process.platform !== "win32") {
    expect(remoteCommand).toContain(`${command}\n}`);
  }
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.concurrent("scripts/crabbox-wrapper", () => {
  const azureProviderHelp =
    "provider: hetzner, aws, azure, local-container, blacksmith-testbox, or cloudflare\n";
  const advertisedProviderAliasHelp = [
    "provider: hetzner, aws, gcp, local-container, blacksmith-testbox,",
    "  namespace-devbox, runpod, semaphore, cloudflare, railway, exe-dev, or ssh",
    "",
  ].join("\n");
  const advertisedProviderAliases = [
    "blacksmith",
    "cf",
    "container",
    "docker",
    "exe",
    "exedev",
    "google",
    "google-cloud",
    "local-docker",
    "namespace",
    "namespace-devboxes",
    "rail",
    "railwayapp",
    "run-pod",
    "runpodio",
    "sem",
    "static",
    "static-ssh",
  ];
  beforeAll(() => {
    runWrapper("provider: aws\n", ["--version"]);
  });

  it("accepts advertised canonical providers from Crabbox help", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("local-container");
  });

  it("only forces the short local-container Docker work root on Linux", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    const expectedMessage =
      "[crabbox] provider=docker using short host-visible work root for OpenClaw Docker tests";
    if (process.platform === "linux") {
      expect(result.stderr).toContain(expectedMessage);
    } else {
      expect(result.stderr).not.toContain(expectedMessage);
    }
  });

  it("defaults AWS macOS runs to on-demand capacity", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
      "--",
      "echo ok",
    ]);
  });

  it("prefers Azure for unqualified Windows runs", () => {
    const result = runWrapper(azureProviderHelp, [
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--",
      "corepack",
      "pnpm",
      "check:changed",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--provider",
      "azure",
      "--",
      "corepack",
      "pnpm",
      "check:changed",
    ]);
    expect(result.stderr).toContain("provider=azure");
  });

  it("keeps explicit provider env overrides for Windows runs", () => {
    const result = runWrapper(azureProviderHelp, ["run", "--target", "windows", "--", "echo ok"], {
      env: { CRABBOX_PROVIDER: "aws" },
    });

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--target",
      "windows",
      "--",
      "echo ok",
    ]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("keeps the AWS provider env for Windows runs when Azure is unavailable", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--target", "windows", "--", "echo ok"],
      { env: { CRABBOX_PROVIDER: "aws" } },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--target",
      "windows",
      "--",
      "echo ok",
    ]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("keeps existing Windows lease selections on the configured provider", () => {
    const result = runWrapper(
      azureProviderHelp,
      ["run", "--id", "cbx_existing", "--target", "windows", "--", "echo ok"],
      { env: { CRABBOX_PROVIDER: "aws" } },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--id",
      "cbx_existing",
      "--target",
      "windows",
      "--",
      "echo ok",
    ]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("prefers Azure for unqualified Windows warmups", () => {
    const result = runWrapper(azureProviderHelp, ["warmup", "--target", "windows"]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "warmup",
      "--target",
      "windows",
      "--provider",
      "azure",
    ]);
  });

  it("fails closed for AWS proof when broker auth is missing", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      { configJson: { coordinator: "", brokerAuth: "missing" } },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws requires a configured Crabbox broker");
    expect(result.stderr).toContain(
      "crabbox login --url https://crabbox.openclaw.ai --provider aws",
    );
  });

  it("allows explicit direct AWS debugging without broker auth", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      {
        configJson: { coordinator: "", brokerAuth: "missing" },
        env: { OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--",
      "echo ok",
    ]);
  });

  it("defaults AWS macOS warmups to on-demand capacity", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["warmup", "--provider", "aws", "--target", "macos"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "warmup",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
    ]);
  });

  it("does not override explicit AWS macOS market or lease selections", () => {
    const helpText = "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
    const explicitMarket = runWrapper(helpText, [
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    const existingLease = runWrapper(helpText, [
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--id",
      "cbx_existing",
      "--",
      "echo ok",
    ]);

    expect(explicitMarket.status).toBe(0);
    expect(parseFakeCrabboxOutput(explicitMarket).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    expect(existingLease.status).toBe(0);
    expect(parseFakeCrabboxOutput(existingLease).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--id",
      "cbx_existing",
      "--",
      "echo ok",
    ]);
  });

  it("bootstraps only Node for raw AWS macOS node commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "node", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("node-v${node_version}-darwin-${node_arch}.tar.gz");
    expect(remoteCommand).toContain("node --version >&2 || return 1");
    expect(remoteCommand).not.toContain("corepack enable");
    expect(remoteCommand).not.toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "node --version");
  });

  it("bootstraps Corepack for raw AWS macOS pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "pnpm", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(result.stderr).toContain(
      "bootstrapping a pinned user-local Node toolchain before the command",
    );
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("node-v${node_version}-darwin-${node_arch}.tar.gz");
    expect(remoteCommand).toContain("shasum -a 256 -c -");
    expect(remoteCommand).not.toContain("set -euo pipefail");
    expect(remoteCommand).toContain('return "$status"');
    expect(remoteCommand).toContain('if [ -z "${TMPDIR:-}" ]; then export TMPDIR="/tmp"; fi;');
    expect(remoteCommand).toContain('mkdir -p "$TMPDIR"');
    expect(remoteCommand).toContain("usable TMPDIR not found: $TMPDIR");
    expect(remoteCommand).toContain("node --version >&2 || return 1");
    expect(remoteCommand).toContain('export PNPM_HOME="${PNPM_HOME:-$tool_root/pnpm-home}"');
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "pnpm --version");
  });

  it("bootstraps Corepack for raw AWS macOS env-prefixed pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "/usr/bin/env", "pnpm", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "/usr/bin/env pnpm --version");
  });

  it("bootstraps Corepack for raw AWS macOS env option pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_env");
    expect(remoteCommand).not.toContain("export -f env openclaw_crabbox_env");
    expect(remoteCommand).not.toContain('env() { openclaw_crabbox_env "$@"; };');
    expect(remoteCommand).toContain("PATH=$PATH:${1#PATH=}");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -i PATH=/usr/bin:/bin pnpm --version",
    );
  });

  it("bootstraps Corepack for raw AWS macOS env options before ignore-environment", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "env",
        "-u",
        "FOO",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("-u|--unset|-C|--chdir)");
    expect(remoteCommand).toContain("-i|--ignore-environment)");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -u FOO -i PATH=/usr/bin:/bin pnpm --version",
    );
  });

  it("does not bootstrap absolute env ignore-environment commands it cannot preserve", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.args).not.toContain("--shell");
  });

  it("does not bootstrap env ignore-environment commands that bypass shell functions", () => {
    for (const prefix of ["command", "exec"]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        [
          "run",
          "--provider",
          "aws",
          "--target",
          "macos",
          "--",
          prefix,
          "env",
          "-i",
          "PATH=/usr/bin:/bin",
          "pnpm",
          "--version",
        ],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(output.args).not.toContain("--shell");
    }
  });

  it("bootstraps env commands behind command when they keep the inherited PATH", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "command",
        "env",
        "CI=1",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "command env CI=1 pnpm --version");
  });

  it("does not shadow unrelated env calls in AWS macOS shell commands", () => {
    const shellScript = "node --version; env -i PATH=/usr/bin:/bin printenv PATH";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_env");
    expect(remoteCommand).not.toContain('env() { openclaw_crabbox_env "$@"; };');
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("does not bootstrap env split-string commands after ignore-environment", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "env", "-i", "-S", "pnpm --version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.args).not.toContain("--shell");
  });

  it("bootstraps Corepack for raw AWS macOS env split-string pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "/usr/bin/env",
        "-S",
        "pnpm --version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand.indexOf("-S|--split-string|-S*|--split-string=*)")).toBeLessThan(
      remoteCommand.indexOf("-[!-]*i*)"),
    );
    expectGroupedShellCommand(remoteCommand, "/usr/bin/env -S 'pnpm --version'");
  });

  it("bootstraps Corepack for AWS macOS node changed-gate commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "node", "scripts/check-changed.mjs"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("node --version >&2");
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "node scripts/check-changed.mjs");
  });

  it("preserves shell commands when bootstrapping raw AWS macOS JavaScript commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", "pnpm check:changed"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, "pnpm check:changed");
  });

  it("bootstraps raw AWS macOS shell scripts that set up before JavaScript commands", () => {
    const shellScript = [
      "set -euo pipefail",
      'repo_tmp=$(node -e "console.log(require(\\"node:os\\").tmpdir())")',
      "pnpm --version",
    ].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript commands", () => {
    const shellScript = "/usr/bin/env CI=1 pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps AWS macOS script-stdin runs before the uploaded script body", () => {
    const script = ["set -euo pipefail", "node -v", "pnpm --version"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--script-stdin");
    expect(output.args).toContain("--script");
    expect(result.stderr).toContain(
      "bootstrapping a pinned user-local Node toolchain before the command",
    );
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain('if [ ! -d "$TMPDIR" ]; then mkdir -p "$TMPDIR"');
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain(`\n${script}`);
  });

  it("preserves AWS macOS script-stdin shebang payloads behind the bootstrap wrapper", () => {
    const script = ["#!/usr/bin/env node", "console.log(process.version);"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin", "--", "arg1"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--script-stdin");
    expect(output.args).toContain("--script");
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).not.toContain("corepack enable");
    expect(output.scriptContent).not.toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain("cat >\"$tmp_script\" <<'OPENCLAW_CRABBOX_SCRIPT_0'");
    expect(output.scriptContent).toContain(`\n${script}\nOPENCLAW_CRABBOX_SCRIPT_0\n`);
    expect(output.scriptContent).toContain('chmod 700 "$tmp_script" || exit $?');
    expect(output.scriptContent).toContain('"$tmp_script" "$@"');
    expect(output.args.at(-1)).toBe("arg1");
  });

  it("does not treat run option values as AWS macOS script-stdin flags", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--label",
        "--script-stdin",
        "--",
        "echo ok",
      ],
      { input: "node -v\n" },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).toContain("--label");
    expect(output.args).toContain("--script-stdin");
    expect(output.args).not.toContain("--script");
    expect(output.scriptContent).toBe("");
  });

  it("bootstraps raw AWS macOS shell scripts with setup inside command substitutions", () => {
    const shellScript = "version=$(cd repo && pnpm --version)";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with assignment-prefix command substitutions", () => {
    const shellScript = "TOOL_ROOT=$(pwd) pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with case branches inside command substitutions", () => {
    const shellScript = 'version=$(case "$pm" in pnpm) pnpm --version ;; esac)';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with grouped setup inside command substitutions", () => {
    const shellScript = 'echo "$( (echo setup); pnpm --version )"';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts after comments and setup commands", () => {
    const shellScript = ["# setup", "cd repo && pnpm --version"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts after escaped newlines", () => {
    const shellScript = "cd repo && \\\npnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with exec-prefixed JavaScript commands", () => {
    const shellScript = "set -e; exec pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with command-prefixed JavaScript commands", () => {
    const shellScript = "command pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with time-prefixed JavaScript commands", () => {
    const shellScript = "time -p node -e 'process.exit(0)'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with absolute time-prefixed JavaScript commands", () => {
    const shellScript = "/usr/bin/time -l pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript control conditions", () => {
    const shellScript = "if node -e 'process.exit(0)'; then echo ok; fi";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript control conditions", () => {
    const shellScript = "if CI=1 pnpm --version; then echo ok; fi";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript pipeline stages", () => {
    const shellScript = "echo '{}' | node -e 'process.stdin.resume()'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts after background setup commands", () => {
    const shellScript = "setup_task & pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript else branches", () => {
    const shellScript = "if test -d node_modules; then echo cached; else pnpm --version; fi";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript case branches", () => {
    const shellScript = 'case "$(uname -m)" in arm64|x64) pnpm --version ;; esac';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("does not bootstrap raw AWS macOS shell scripts for JavaScript-named case labels", () => {
    const shellScript = 'case "$packageManager" in pnpm) echo "$packageManager" ;; esac';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts that only mention JavaScript tools", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        'echo "node and pnpm are documented here"',
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for quoted JavaScript tool mentions", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        'echo "docs; pnpm --version"',
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for inline comment mentions", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "echo ok # $(pnpm --version)",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for reserved words in arguments", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "echo then pnpm --version && echo use-case",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for arithmetic expansion names", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "node=1; echo $((node + 1))",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for quoted assignment mentions", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        'MSG="use pnpm here" printf "%s\\n" "$MSG"',
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for command lookup checks", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", "command -v pnpm"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for timed command lookup checks", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "/usr/bin/time -l command -v pnpm",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("groups shell commands so fallbacks cannot mask AWS macOS bootstrap failures", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "pnpm check:changed || true",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, "pnpm check:changed || true");
  });

  it("does not bootstrap non-macOS AWS JavaScript commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "linux", "--", "pnpm", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "linux",
      "--",
      "pnpm",
      "--version",
    ]);
  });

  const itWithPosixLinkedWorktreeFixture = process.platform === "win32" ? it.skip : it;

  itWithPosixLinkedWorktreeFixture(
    "finds a Crabbox checkout next to the Git common dir in linked worktrees",
    () => {
      const fakeWorkspaceParent = mkdtempSync(path.join(tmpdir(), "openclaw-linked-worktree-"));
      tempDirs.push(fakeWorkspaceParent);
      const gitCommonDir = path.join(fakeWorkspaceParent, "openclaw", ".git");
      const crabboxBinDir = path.join(fakeWorkspaceParent, "crabbox", "bin");
      mkdirSync(gitCommonDir, { recursive: true });
      writeFakeCrabbox(crabboxBinDir, "provider: aws\n");
      const gitResponses = {
        ["rev-parse\u0000--git-common-dir"]: { stdout: `${gitCommonDir}\n` },
      };
      const gitBinDir = makeFakeGit(gitResponses);

      const result = spawnSync(
        process.execPath,
        ["scripts/crabbox-wrapper.mjs", "run", "--provider", "aws", "--", "echo ok"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
            OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(gitResponses),
            PATH: [gitBinDir, path.dirname(process.execPath)].join(path.delimiter),
          },
        },
      );

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("aws");
    },
  );

  it("accepts advertised providers from wrapped Crabbox help", () => {
    const result = runWrapper(
      [
        "provider: hetzner, aws, local-container, blacksmith-testbox,",
        "  docker, or cloudflare (default: aws)",
        "",
      ].join("\n"),
      ["run", "--provider", "docker", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("docker");
    expect(result.stderr).toContain(
      "providers=hetzner,aws,local-container,blacksmith-testbox,docker,cloudflare",
    );
  });

  if (process.platform === "win32") {
    it("preserves shell metacharacters through Windows Crabbox command shims", () => {
      const remoteCommand = "pnpm build && pnpm test | more < in.txt > out.txt %PATH%";
      const result = runWrapper("provider: aws\n", ["run", "--shell", "--", remoteCommand]);

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toEqual(["run", "--shell", "--", remoteCommand]);
    });
  }

  if (process.platform !== "win32") {
    it("keeps POSIX PATH lookup semantics for non-executable entries", () => {
      const staleBinDir = mkdtempSync(path.join(tmpdir(), "openclaw-stale-crabbox-"));
      tempDirs.push(staleBinDir);
      writeFileSync(path.join(staleBinDir, "crabbox"), "not executable\n", "utf8");
      const result = runWrapper("provider: aws\n", ["run", "--provider", "aws", "--", "echo ok"], {
        extraPathEntries: [staleBinDir],
      });

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("aws");
    });
  }

  it("falls back to normal sync decisions when git is missing from PATH", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      {
        gitResponses: {
          ["rev-parse\u0000--git-common-dir"]: { status: 1 },
          ["config\u0000--bool\u0000core.sparseCheckout"]: { status: 1 },
          ["sparse-checkout\u0000list"]: { status: 1 },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("aws");
  });

  it.each(advertisedProviderAliases)(
    "accepts Crabbox provider alias %s when its canonical provider is advertised",
    (alias) => {
      const result = runWrapper(advertisedProviderAliasHelp, [
        "run",
        "--provider",
        alias,
        "--",
        "echo ok",
      ]);

      expect(result.status, alias).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain(alias);
    },
  );

  it("accepts Crabbox provider aliases when upstream help omits Tensorlake", () => {
    const helpText = [
      "provider: hetzner, aws, gcp, local-container, blacksmith-testbox,",
      "  namespace-devbox, runpod, semaphore, cloudflare, railway, exe-dev, or ssh",
      "",
    ].join("\n");

    for (const provider of ["tensorlake", "tl", "tensorlake-sbx"]) {
      const result = runWrapper(helpText, ["run", "--provider", provider, "--", "echo ok"]);

      expect(result.status, provider).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain(provider);
    }
  });

  it("keeps unsupported provider selections rejected", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "bogus", "--", "echo ok"],
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary does not advertise provider bogus");
  });

  it("parses provider choices from the --provider flag help format", () => {
    const result = runWrapper(
      "Usage: crabbox run [options]\n  --provider hetzner|aws|local-container|blacksmith-testbox|cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "providers=hetzner,aws,local-container,blacksmith-testbox,cloudflare",
    );
  });

  it("uses a temporary full checkout for clean sparse Blacksmith syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).not.toContain("--no-sync");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout for clean sparse AWS syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("overlaying local HEAD as worktree changes from origin/main");
    expect(parseFakeCrabboxOutput(result).args.join(" ")).toContain(
      "if ! git status --short >/dev/null 2>&1; then rm -rf .git;",
    );
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when clean sparse AWS syncs reuse a lease", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "windows",
        "--id",
        "cbx_existing",
        "--",
        "corepack",
        "pnpm",
        "build",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("bootstraps Git metadata for sparse changed gates on remote raw syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(
      "git fetch -q --depth=1 origin abc123:refs/remotes/origin/main",
    );
    expect(remoteCommand).toContain("git reset --mixed --quiet refs/remotes/origin/main");
    expect(remoteCommand).toContain("git add -A");
    expect(remoteCommand).toContain("git diff --cached --quiet");
    expect(remoteCommand).toContain("commit -q --no-gpg-sign -m remote-changed-gate-tree");
    expect(remoteCommand).toMatch(/&& corepack pnpm check:changed$/u);
  });

  it("preserves macOS JS bootstrapping for sparse changed gates on remote raw syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "pnpm", "check:changed"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(
      "git fetch -q --depth=1 origin abc123:refs/remotes/origin/main",
    );
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, "pnpm check:changed");
  });

  it("preserves macOS JS and Git bootstraps for sparse shell changed gates with setup", () => {
    const shellScript = ["set -euo pipefail", "pnpm check:changed"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("preserves macOS JS and Git bootstraps for shell-wrapped sparse changed gates", () => {
    const shellScript = "bash -lc 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("preserves sparse changed-gate Git bootstrap for assignment-prefix command substitutions", () => {
    const shellScript = "TOOL_ROOT=$(pwd) pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for command-prefixed shell commands", () => {
    const shellScript = "command pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for bash -lc shell commands", () => {
    const shellScript =
      "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 bash -lc 'set -euo pipefail; pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(
      "git fetch -q --depth=1 origin abc123:refs/remotes/origin/main",
    );
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for shell option values before -c", () => {
    const shellScript = "bash -o pipefail -c 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for attached shell option values before -c", () => {
    const shellScript = "bash --rcfile=./ci.bashrc -c 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for grouped shell options before -c", () => {
    const shellScript = "bash -eo pipefail -c 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for absolute time-prefixed shell commands", () => {
    const shellScript = "/usr/bin/time -l pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for timeout-wrapped shell commands", () => {
    const shellScript =
      "/usr/bin/time -v timeout 1200s node scripts/check-changed.mjs --base origin/main --head HEAD";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(
      "git fetch -q --depth=1 origin abc123:refs/remotes/origin/main",
    );
    expect(remoteCommand).toContain(`&& ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for direct timeout-wrapped node commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--",
        "timeout",
        "1200s",
        "node",
        "scripts/check-changed.mjs",
        "--base",
        "origin/main",
        "--head",
        "HEAD",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& timeout 1200s node scripts\/check-changed\.mjs --base origin\/main --head HEAD$/u,
    );
  });

  it("preserves sparse changed-gate Git bootstrap for direct timeout-wrapped shell commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "timeout", "1200s", "bash", "-lc", "pnpm check:changed"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(/&& timeout 1200s bash -lc 'pnpm check:changed'$/u);
  });

  it("does not treat quoted sparse shell text as a changed gate", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        'cat <<EOF\npnpm check:changed\nEOF\necho "docs; pnpm check:changed"',
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("does not treat escaped heredoc bodies as changed gates", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        "cat <<\\EOF\npnpm check:changed\nEOF\necho done",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("does not treat nested heredoc bodies in substitutions as changed gates", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        'echo "$(cat <<EOF\npnpm check:changed\nEOF\n)"',
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("detects JavaScript commands after hyphenated heredoc delimiters", () => {
    const shellScript = "cat <<EOF-JSON\nnode is literal\nEOF-JSON\npnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts for unquoted heredoc command substitutions", () => {
    const shellScript = "cat <<EOF\n$(pnpm --version)\nEOF";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("keeps quoted heredoc command substitutions literal", () => {
    const shellScript = "cat <<'EOF'\n$(pnpm --version)\nEOF";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("preserves existing shell changed-gate commands after remote Git bootstrap", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", "env CI=1 pnpm check:changed"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(
      "git fetch -q --depth=1 origin abc123:refs/remotes/origin/main",
    );
    expect(remoteCommand).toMatch(/&& env CI=1 pnpm check:changed$/u);
  });

  it("does not inject the POSIX changed-gate bootstrap for Windows targets", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "windows",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
          ["merge-base\u0000origin/main\u0000HEAD"]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--shell");
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--",
      "corepack",
      "pnpm",
      "check:changed",
    ]);
  });

  it("uses a temporary full checkout when local-container syncs clean sparse worktrees", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when existing AWS leases sync clean sparse worktrees", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--id", "cbx_existing", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when clean sparse branches differ from the Blacksmith ref", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).not.toContain("--no-sync");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("keeps sparse dirty worktrees on the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: " M scripts/crabbox-wrapper.mjs\n" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toBe(repoRoot);
  });

  it("keeps local artifact paths rooted at the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "main",
        "--capture-stdout=.artifacts/stdout.log",
        "--capture-stderr",
        ".artifacts/stderr.log",
        "--download",
        "/tmp/proof=.artifacts/proof",
        "--",
        "echo ok",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(output.args).toContain(
      `--capture-stdout=${path.join(repoRoot, ".artifacts/stdout.log")}`,
    );
    expect(output.args).toContain(path.join(repoRoot, ".artifacts/stderr.log"));
    expect(output.args).toContain(`/tmp/proof=${path.join(repoRoot, ".artifacts/proof")}`);
  });

  it("preserves artifact-glob downloads from temporary sparse-sync checkouts", () => {
    const preservedDir = path.join(repoRoot, ".crabbox", "runs", "run_fake");
    rmSync(preservedDir, { recursive: true, force: true });

    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "main",
        "--artifact-glob",
        ".artifacts/proof/**",
        "--",
        "echo ok",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("preserved");
    expect(statSync(path.join(preservedDir, "fake-artifacts.tgz")).isFile()).toBe(true);
    rmSync(preservedDir, { recursive: true, force: true });
  });

  it("uses the temporary full checkout for sparse sync-only runs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--sync-only",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });
});
