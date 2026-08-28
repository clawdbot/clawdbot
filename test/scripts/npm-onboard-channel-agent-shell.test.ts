import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const runnerPath = "scripts/e2e/npm-onboard-channel-agent-docker.sh";
const version = "2026.8.1";
const sourceSha = "a".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Scenario = {
  consent?: boolean;
  registry?: boolean;
  corruptRegistry?: boolean;
  companion?: "missing" | "wrong-identity";
  channel?: "telegram" | "discord" | "slack";
  bundled?: boolean;
  sourcePlugin?: boolean;
  helpFailure?: "exit" | "timeout";
  failProbe?: number;
};

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function registryFixture(root: string, scenario: Scenario): NodeJS.ProcessEnv {
  const artifactDir = join(root, "registry-artifact");
  const staging = join(root, "staging");
  mkdirSync(join(staging, "package"), { recursive: true });
  mkdirSync(artifactDir);
  // Extra verified companions must not select source mode on their own.
  const packages = ["codex", "discord", "slack"]
    .filter((id) => scenario.companion !== "missing" || id !== scenario.channel)
    .map((id) => {
      const name = `@openclaw/${id}`;
      writeFileSync(
        join(staging, "package/package.json"),
        JSON.stringify({
          name:
            scenario.companion === "wrong-identity" && id === scenario.channel
              ? "@openclaw/other"
              : name,
          version,
        }),
      );
      const tarball = `${id}.tgz`;
      const tarballPath = join(artifactDir, tarball);
      execFileSync("tar", ["-czf", tarballPath, "-C", staging, "package"]);
      return { name, version, tarball, sha256: sha256(tarballPath) };
    });
  const manifest = join(artifactDir, "prepublish-plugin-registry.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: "openclaw.prepublish-plugin-registry/v1",
      schemaVersion: 1,
      candidateVersion: version,
      sourceSha,
      packages,
    }),
  );
  return {
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: artifactDir,
    OPENCLAW_DOCKER_E2E_SELECTED_SHA: sourceSha,
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: version,
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: sha256(manifest),
  };
}

function runScenario(scenario: Scenario = {}) {
  const root = tempDirs.make("openclaw-onboard-shell-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const packageRoot = join(root, "package");
  const eventsPath = join(root, "events.jsonl");
  const channel = scenario.channel ?? "telegram";
  const bundled = scenario.bundled ?? channel === "telegram";
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(packageRoot);
  writeFileSync(eventsPath, "");
  if (bundled) {
    mkdirSync(join(packageRoot, "dist/extensions", channel), { recursive: true });
  }
  const cli = join(bin, "openclaw");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.EVENTS, JSON.stringify(args) + "\\n");
const events = fs.readFileSync(env.EVENTS, "utf8").trim().split("\\n").map(JSON.parse);
const current = env.CONSENT === "1";
const help = args.includes("--help");
const fail = (message) => { console.error(message); process.exit(31); };
if (help) {
  console.log("OpenClaw ${version}\\nUsage: openclaw plugins install [options] <source>");
  if (current) console.log("  --accept-capabilities  Accept reviewed plugin capabilities");
  const probe = events.filter((event) => event.includes("--help")).length;
  if (probe === Number(env.FAIL_PROBE)) {
    if (env.HELP_FAILURE === "timeout") setInterval(() => {}, 1000);
    else process.exit(29);
  }
} else if (args[0] === "plugins") {
  if (!current) fail("legacy package must retain automatic setup");
  if (!args.includes("--accept-capabilities")) fail("capability consent missing");
  if (args[2] === "codex" || args[2].startsWith("npm:@openclaw/codex@")) {
    if (events.some((event) => event[0] === "onboard")) fail("runtime installed after onboard");
  } else {
    if (!events.some((event) => event[0] === "onboard")) fail("channel installed before onboard");
    installChannelDependency();
  }
} else if (args[0] === "onboard") {
  if (current && !events.some((event) => event[0] === "plugins" && !event.includes("--help"))) {
    fail("required runtime unavailable before onboarding");
  }
} else if (args[0] === "channels" && args[1] === "add" && env.BUNDLED === "0") {
  if (current && !fs.existsSync(dependencyPath())) fail("external channel needs consent first");
  if (!current) installChannelDependency();
}
function dependencyPath() {
  const dep = { telegram: "grammy", discord: "discord-api-types", slack: "@slack/bolt" }[env.OPENCLAW_NPM_ONBOARD_CHANNEL];
  return path.join(env.HOME, ".openclaw/node_modules", dep, "package.json");
}
function installChannelDependency() {
  const file = dependencyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}");
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "node"),
    `#!/bin/bash
if [ "$1" = scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs ]; then
  exec "$REAL_NODE" "$FIXTURE_CLI" assertion "\${@:2}"
fi
exec "$REAL_NODE" "$@"
`,
    { mode: 0o755 },
  );

  // Execute the actual container program. Only container /tmp paths are mapped
  // into this test's directory; the shared consent/timeout/registry helpers run unchanged.
  const runner = readFileSync(runnerPath, "utf8");
  const containerScript = runner.match(/<<'EOF'; then\n([\s\S]*?)\nEOF\n/u)?.[1];
  if (!containerScript) {
    throw new Error("npm onboarding container program not found");
  }
  const testState = `
openclaw_e2e_install_package() { mkdir -p "$HOME/.openclaw"; }
openclaw_e2e_package_root() { printf '%s' "$PACKAGE_ROOT"; }
openclaw_e2e_start_mock_openai() { :; }
openclaw_e2e_wait_mock_openai() { :; }
`;
  const registryEnv = scenario.registry ? registryFixture(root, scenario) : {};
  if (scenario.corruptRegistry) {
    registryEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256 = "0".repeat(64);
  }
  const commandPath = [bin, dirname(process.execPath), process.env.PATH]
    .filter(Boolean)
    .join(delimiter);
  const result = spawnSync("bash", ["-s"], {
    input: containerScript.replaceAll("/tmp/", `${root}/`),
    encoding: "utf8",
    timeout: 20_000,
    env: {
      HOME: home,
      OPENCLAW_HOME: home,
      PATH: commandPath,
      TMPDIR: root,
      REAL_NODE: process.execPath,
      FIXTURE_CLI: cli,
      PACKAGE_ROOT: packageRoot,
      EVENTS: eventsPath,
      CONSENT: scenario.consent === false ? "0" : "1",
      BUNDLED: bundled ? "1" : "0",
      HELP_FAILURE: scenario.helpFailure ?? "",
      FAIL_PROBE: scenario.helpFailure ? String(scenario.failProbe ?? 1) : "0",
      OPENCLAW_E2E_COMMAND_TIMEOUT: scenario.helpFailure === "timeout" ? "1s" : "5s",
      OPENCLAW_E2E_TIMEOUT_KILL_GRACE_MS: "10",
      OPENCLAW_NPM_ONBOARD_CHANNEL: channel,
      OPENCLAW_NPM_ONBOARD_USE_SOURCE_PLUGIN_PACKAGE: scenario.sourcePlugin ? "1" : "0",
      OPENCLAW_TEST_STATE_SCRIPT_B64: Buffer.from(testState).toString("base64"),
      ...registryEnv,
    },
  });
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const installs = events.filter((args) => args[0] === "plugins" && !args.includes("--help"));
  const logs = readdirSync(root)
    .filter((file) => file.startsWith("openclaw-") && file.endsWith(".log"))
    .map((file) => join(root, file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  expect(result.error, `${result.stdout}\n${result.stderr}\n${logs}`).toBeUndefined();
  return { result, events, installs, detail: `${result.stdout}\n${result.stderr}\n${logs}` };
}

describe("npm onboarding fixture consent", () => {
  it.each([false, true])("selects the reviewed Codex source with registry=%s", (registry) => {
    const { result, events, installs, detail } = runScenario({ registry });
    expect(result.status, detail).toBe(0);
    expect(installs).toEqual([
      registry
        ? ["plugins", "install", `npm:@openclaw/codex@${version}`, "--pin", "--accept-capabilities"]
        : ["plugins", "install", "codex", "--accept-capabilities"],
    ]);
    const onboard = events.find((args) => args[0] === "onboard");
    expect(onboard).toEqual([
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--mode",
      "local",
      "--auth-choice",
      "openai-api-key",
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "18789",
      "--gateway-bind",
      "loopback",
      "--skip-daemon",
      "--skip-ui",
      "--skip-skills",
      "--skip-health",
      "--json",
    ]);
    const stages = events.filter((args) => args[0] === "assertion").map((args) => args[1]);
    expect(stages).toEqual([
      "assert-onboard-state",
      "assert-channel-config",
      "assert-status-surfaces",
      "configure-mock-model",
      "assert-mock-model-config",
      "assert-agent-turn",
    ]);
    expect(events.indexOf(onboard!)).toBeLessThan(
      events.findIndex((args) => args[1] === "configure-mock-model"),
    );
  });

  it.each([
    { registry: false, channel: "telegram" as const },
    { registry: true, channel: "telegram" as const },
    { registry: false, channel: "discord" as const },
    { registry: true, channel: "slack" as const, sourcePlugin: true },
  ])("keeps same-version legacy setup automatic: $channel registry=$registry", (scenario) => {
    const { result, installs, detail } = runScenario({ ...scenario, consent: false });
    expect(result.status, detail).toBe(0);
    expect(installs).toEqual([]);
  });

  it.each([
    { channel: "telegram" as const, bundled: true, sourcePlugin: true },
    { channel: "discord" as const, bundled: true },
    { channel: "discord" as const },
    { channel: "slack" as const },
    { channel: "discord" as const, sourcePlugin: true },
    { channel: "slack" as const, sourcePlugin: true },
  ])("prepares only the selected external channel: %j", (scenario) => {
    const { result, installs, detail } = runScenario({ ...scenario, registry: true });
    expect(result.status, detail).toBe(0);
    expect(installs.slice(1)).toEqual(
      scenario.bundled
        ? []
        : [
            [
              "plugins",
              "install",
              ...(scenario.sourcePlugin
                ? [`npm:@openclaw/${scenario.channel}@${version}`, "--pin"]
                : [scenario.channel]),
              "--accept-capabilities",
            ],
          ],
    );
  });

  it.each([
    { channel: "discord" as const, consent: true },
    { channel: "discord" as const, consent: false },
    { channel: "slack" as const, consent: true },
    { channel: "slack" as const, consent: false },
  ])("rejects source fixtures without a verified registry: %j", (scenario) => {
    const { result, events, detail } = runScenario({ ...scenario, sourcePlugin: true });
    expect(result.status, detail).not.toBe(0);
    expect(detail).toContain(
      "source channel fixture requires OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR",
    );
    expect(events).toEqual([]);
  });

  it.each([
    { channel: "discord" as const, companion: "missing" as const },
    { channel: "slack" as const, companion: "missing" as const },
    { channel: "discord" as const, companion: "wrong-identity" as const },
    { channel: "slack" as const, companion: "wrong-identity" as const },
  ])("verifies the selected companion before any CLI call: %j", (scenario) => {
    const { result, events, detail } = runScenario({
      ...scenario,
      registry: true,
      sourcePlugin: true,
    });
    expect(result.status, detail).not.toBe(0);
    expect(detail).toContain(
      scenario.companion === "missing"
        ? "missing Docker-plan package"
        : "tarball identity mismatch",
    );
    expect(events).toEqual([]);
  });

  it.each(["exit", "timeout"] as const)("stops before mutation on help %s", (helpFailure) => {
    const { result, events, detail } = runScenario({ helpFailure });
    expect(result.status, detail).toBe(helpFailure === "timeout" ? 124 : 29);
    expect(events).toEqual([["plugins", "install", "--help"]]);
  });

  it.each([2, 3])("stops at the shared helper's failed probe %s", (failProbe) => {
    const { result, events, installs, detail } = runScenario({
      channel: "discord",
      helpFailure: "exit",
      failProbe,
    });
    expect(result.status, detail).toBe(29);
    expect(installs).toHaveLength(failProbe === 2 ? 0 : 1);
    expect(events.some((args) => args[0] === "channels" && args[1] === "add")).toBe(false);
  });

  it("rejects a mismatched registry artifact before any CLI call", () => {
    const { result, events, detail } = runScenario({ registry: true, corruptRegistry: true });
    expect(result.status, detail).not.toBe(0);
    expect(detail).toContain("manifest SHA-256 differs from the immutable tuple");
    expect(events).toEqual([]);
  });
});
