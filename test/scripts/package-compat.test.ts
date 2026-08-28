import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const consent = "--accept-capabilities";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

function writeCandidate(
  root: string,
  options: { commands?: string[]; helpStatus?: number; hang?: boolean; exitCode?: number } = {},
  name = "candidate.cjs",
) {
  const entry = path.join(root, name);
  writeFileSync(
    entry,
    `
const fs = require('node:fs');
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + '\\n');
const supported = (options.commands ?? ['install', 'enable', 'update']).includes(args[1]);
if (args.includes('--help')) {
  console.log('OpenClaw 2026.8.1\\nOptions:');
  console.log(supported ? '  --accept-capabilities  Accept capabilities' : '  --force  Confirm source');
  if (options.hang) setInterval(() => {}, 1000);
  else process.exit(options.helpStatus ?? 0);
} else {
  const accepted = args.includes('--accept-capabilities');
  if (accepted && !supported) {
    console.error('unknown option --accept-capabilities');
    process.exit(2);
  }
  if (args[2]?.includes('invalid-metadata') || args[2] === 'missing-version') process.exit(41);
  const needsConsent = args[0] === 'plugins' && (args[1] === 'install' ||
    (args[1] === 'enable' && args[2] === 'claude-bundle-e2e') ||
    (args[1] === 'update' && args[2] === 'marketplace-shortcut' && !args.includes('--dry-run')));
  if (supported && needsConsent && !accepted) {
    console.error('requires capability consent');
    process.exit(42);
  }
  console.log('{}');
  process.exit(options.exitCode ?? 0);
}
`,
  );
  return entry;
}

function runShell(root: string, entry: string, script: string) {
  const result = spawnSync(BASH_BIN, ["-c", `set -euo pipefail\n${script}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: root,
      OPENCLAW_ENTRY: entry,
      OPENCLAW_PLUGINS_TMP_DIR: root,
      KITCHEN_SINK_TMP_DIR: root,
      ARGV_LOG: path.join(root, "argv.jsonl"),
      OPENCLAW_PLUGINS_E2E_CLAWHUB: "0",
      OPENCLAW_PLUGINS_CLI_TIMEOUT: "5s",
      OPENCLAW_TEST_STATE_SCRIPT_B64: Buffer.from(":").toString("base64"),
    },
  });
  const log = path.join(root, "argv.jsonl");
  const calls: string[][] = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { ...result, calls };
}

const fixtureCommand = `
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_fixture_plugin_command openclaw_e2e_maybe_timeout 5s node "$OPENCLAW_ENTRY" --
`.trim();

// Replace artifact construction and inventory assertions, not the CLI runner or scenario order.
const sweepFixtureLoader = `
source() {
  if [[ "$1" == scripts/e2e/lib/plugins/fixtures.sh ]]; then
    write_fixture_plugin() { mkdir -p "$1"; }
    write_demo_fixture_plugin() { write_fixture_plugin "$@"; }
    write_fixture_plugin_with_cli() { write_fixture_plugin "$@"; }
    write_fixture_plugin_with_vendored_dependency() { write_fixture_plugin "$@"; }
    write_claude_bundle_fixture() { write_fixture_plugin "$@"; }
    pack_fixture_plugin() { :; }
    pack_fixture_plugin_with_cli_registry_dependency() { :; }
    pack_fake_is_number_package() { :; }
    pack_fixture_plugin_with_invalid_extension_entry() { :; }
    start_npm_fixture_registry() { :; }
    record_fixture_plugin_trust() { :; }
    openclaw_plugins_cleanup_fixture_servers() { :; }
  else
    builtin source "$@"
  fi
}
node() {
  case "$1" in
    scripts/e2e/lib/plugins/assertions.mjs|scripts/e2e/lib/fixture.mjs) return 0 ;;
    *) command node "$@" ;;
  esac
}
git() { printf 'fixture-commit\\n'; }
source scripts/e2e/lib/plugins/sweep.sh
`;

const kitchenFixtureLoader = `
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
assert_kitchen_sink_cutover_preinstalled() { :; }
configure_kitchen_sink_runtime() { :; }
assert_kitchen_sink_installed() { :; }
assert_kitchen_sink_removed() { :; }
remove_kitchen_sink_channel_config() { :; }
node() {
  case "$1" in
    scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs) return 0 ;;
    *) command node "$@" ;;
  esac
}
KITCHEN_SINK_LABEL=fixture
KITCHEN_SINK_ID=fixture-id
KITCHEN_SINK_SPEC=fixture-spec
KITCHEN_SINK_PREINSTALL_SPEC=preinstall-spec
KITCHEN_SINK_SOURCE=npm
run_success_scenario
KITCHEN_SINK_SPEC=missing-version
run_failure_scenario
`;

describe("package fixture consent compatibility", () => {
  it.each([true, false])(
    "runs the plugin sweep with selective consent (supported=%s)",
    (supported) => {
      const root = tempDirs.make("openclaw-consent-sweep-");
      const entry = writeCandidate(root, { commands: supported ? undefined : [] });
      const result = runShell(root, entry, sweepFixtureLoader);
      expect(result.status, result.stderr).toBe(0);
      const mutations = result.calls.filter(
        (args) => args[0] === "plugins" && !args.includes("--help"),
      );
      const installs = mutations.filter((args) => args[1] === "install");
      expect(installs).toHaveLength(12);
      for (const args of mutations) {
        const positive =
          (args[1] === "install" && !args.some((arg) => arg.includes("invalid-metadata"))) ||
          args[1] === "enable" ||
          (args[1] === "update" &&
            args[2] === "marketplace-shortcut" &&
            !args.includes("--dry-run"));
        expect(args.includes(consent), args.join(" ")).toBe(supported && positive);
      }
      expect(mutations.filter((args) => args[1] === "update")).toHaveLength(5);
      expect(mutations.find((args) => args[1] === "enable")).toContain("claude-bundle-e2e");
    },
  );

  it.each([true, false])(
    "runs kitchen-sink success and registry failure (supported=%s)",
    (supported) => {
      const root = tempDirs.make("openclaw-consent-kitchen-");
      const result = runShell(
        root,
        writeCandidate(root, { commands: supported ? undefined : [] }),
        kitchenFixtureLoader,
      );
      expect(result.status, result.stderr).toBe(0);
      const installs = result.calls.filter(
        (args) => args[1] === "install" && !args.includes("--help"),
      );
      expect(installs.map((args) => args[2])).toEqual([
        "preinstall-spec",
        "fixture-spec",
        "missing-version",
      ]);
      expect(installs.map((args) => args.includes(consent))).toEqual([supported, supported, false]);
      expect(result.calls.find((args) => args[1] === "enable")).not.toContain(consent);
    },
  );

  it("probes each command and preserves literal argv", () => {
    const root = tempDirs.make("openclaw-consent-argv-");
    const entry = writeCandidate(root, { commands: ["install", "update"] });
    const result = runShell(
      root,
      entry,
      `${fixtureCommand} plugins install 'file:a b/$(literal)' --force ''
${fixtureCommand} plugins enable fixture
${fixtureCommand} plugins update fixture`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      ["plugins", "install", "--help"],
      ["plugins", "install", "file:a b/$(literal)", "--force", "", consent],
      ["plugins", "enable", "--help"],
      ["plugins", "enable", "fixture"],
      ["plugins", "update", "--help"],
      ["plugins", "update", "fixture", consent],
    ]);
  });

  it.each([true, false])(
    "consents to ClawHub install but not unchanged update (supported=%s)",
    (supported) => {
      const root = tempDirs.make("openclaw-consent-clawhub-");
      const result = runShell(
        root,
        writeCandidate(root, { commands: supported ? undefined : [] }),
        `
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_E2E_CLAWHUB=1
export OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB=1
source scripts/e2e/lib/plugins/sweep.sh
node() {
  case "$1" in
    scripts/e2e/lib/plugins/assertions.mjs) return 0 ;;
    *) command node "$@" ;;
  esac
}
run_plugins_clawhub_scenario
`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(
        result.calls
          .find((args) => args[1] === "install" && !args.includes("--help"))
          ?.includes(consent),
      ).toBe(supported);
      expect(result.calls.find((args) => args[1] === "update")).not.toContain(consent);
    },
  );

  it.each([
    ["  --accept-capabilities  Accept\n", consent],
    ["  \u001b[32m--accept-capabilities\u001b[0m  Accept\n", consent],
    ["  --accept-capabilities-extra  Other\n", ""],
    ["See --accept-capabilities in newer releases\n", ""],
    ["  --force  Confirm\n", ""],
  ])("reads only an advertised option from help %j", (help, expected) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/e2e/lib/package-compat.mjs", "fixture-consent"],
      { encoding: "utf8", input: help },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each([
    ["plugins", "error"],
    ["plugins", "timeout"],
    ["kitchen-sink", "error"],
    ["kitchen-sink", "timeout"],
  ])("%s logger fails before mutation on help %s", (suite, failure) => {
    const root = tempDirs.make("openclaw-consent-failure-");
    const entry = writeCandidate(root, failure === "error" ? { helpStatus: 47 } : { hang: true });
    const result = runShell(
      root,
      entry,
      suite === "plugins"
        ? `
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_CLI_TIMEOUT=1s
source scripts/e2e/lib/plugins/sweep.sh
run_plugins_fixture_logged failure plugins install fixture --force
`
        : `
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_CLI_TIMEOUT=1s
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
run_kitchen_sink_fixture_logged failure plugins install fixture --force
`,
    );
    expect(result.status, result.stderr).toBe(failure === "error" ? 47 : 124);
    expect(result.stdout + result.stderr).toContain("help probe failed");
    expect(result.calls).toEqual([["plugins", "install", "--help"]]);
  });

  it("returns the mutation exit status", () => {
    const root = tempDirs.make("openclaw-consent-exit-");
    const result = runShell(
      root,
      writeCandidate(root, { exitCode: 49 }),
      `${fixtureCommand} plugins install fixture`,
    );
    expect(result.status).toBe(49);
    expect(result.calls.at(-1)).toEqual(["plugins", "install", "fixture", consent]);
  });

  it("reprobes a replacement at the same executable path and version", () => {
    const root = tempDirs.make("openclaw-consent-replacement-");
    const entry = writeCandidate(root, { commands: [] });
    writeCandidate(root, {}, "replacement.cjs");
    const result = runShell(
      root,
      entry,
      `${fixtureCommand} plugins install fixture
cp "$HOME/replacement.cjs" "$OPENCLAW_ENTRY"
${fixtureCommand} plugins install fixture`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      ["plugins", "install", "--help"],
      ["plugins", "install", "fixture"],
      ["plugins", "install", "--help"],
      ["plugins", "install", "fixture", consent],
    ]);
  });

  it.each([
    ["2026.4.25", "1"],
    ["2026.4.26", "0"],
    ["2026.8.1", "0"],
  ])("preserves legacy version CLI %s", (version, output) => {
    const result = spawnSync(process.execPath, ["scripts/e2e/lib/package-compat.mjs", version], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(output);
  });
});
