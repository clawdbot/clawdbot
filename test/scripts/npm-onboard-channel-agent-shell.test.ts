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
  channel?: "telegram" | "discord" | "slack";
  bundled?: boolean;
  sourcePlugin?: boolean;
};

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function createPackageTarball(root: string, tarballPath: string, name: string): void {
  const staging = join(root, `staging-${name.replaceAll("/", "-").replaceAll("@", "")}`);
  mkdirSync(join(staging, "package"), { recursive: true });
  writeFileSync(join(staging, "package/package.json"), JSON.stringify({ name, version }));
  execFileSync("tar", ["-czf", tarballPath, "-C", staging, "package"]);
}

function registryFixture(root: string): NodeJS.ProcessEnv {
  const artifactDir = join(root, "registry-artifact");
  mkdirSync(artifactDir);
  const tarball = "codex.tgz";
  const tarballPath = join(artifactDir, tarball);
  createPackageTarball(root, tarballPath, "@openclaw/codex");
  const manifest = join(artifactDir, "prepublish-plugin-registry.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: "openclaw.prepublish-plugin-registry/v1",
      schemaVersion: 1,
      candidateVersion: version,
      sourceSha,
      packages: [{ name: "@openclaw/codex", version, tarball, sha256: sha256(tarballPath) }],
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
  if (scenario.sourcePlugin) {
    createPackageTarball(root, join(root, "openclaw-channel-plugin.tgz"), `@openclaw/${channel}`);
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
  const registryEnv = scenario.registry ? registryFixture(root) : {};
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
      OPENCLAW_E2E_COMMAND_TIMEOUT: "5s",
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
  return { result, events, installs, root, detail: `${result.stdout}\n${result.stderr}\n${logs}` };
}

function runOuterSourceScenario(registry: boolean) {
  const root = tempDirs.make("openclaw-onboard-outer-");
  const bin = join(root, "bin");
  const sourceRoot = join(root, "source");
  const packageTgz = join(root, "openclaw-package.tgz");
  const dockerArgsPath = join(root, "docker-args.txt");
  mkdirSync(bin);
  mkdirSync(join(sourceRoot, "extensions/discord"), { recursive: true });
  mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
  writeFileSync(packageTgz, "core package fixture");
  writeFileSync(
    join(sourceRoot, "extensions/discord/package.json"),
    JSON.stringify({ name: "@openclaw/discord", version }),
  );
  writeFileSync(
    join(sourceRoot, "scripts/plugin-npm-publish.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
stage="$OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR/staging"
mkdir -p "$stage/package"
cp "$2/package.json" "$stage/package/package.json"
tar -czf "$OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR/openclaw-discord-${version}.tgz" -C "$stage" package
rm -rf "$stage"
`,
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "run" ]; then
  printf '%s\\n' "$@" >"$DOCKER_ARGS_PATH"
  cat >/dev/null
fi
`,
    { mode: 0o755 },
  );

  const registryEnv = registry ? registryFixture(root) : {};
  const result = spawnSync("bash", [runnerPath], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
      DOCKER_ARGS_PATH: dockerArgsPath,
      DOCKER_COMMAND_TIMEOUT: "10s",
      OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
      OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
      OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
      OPENCLAW_NPM_ONBOARD_CHANNEL: "discord",
      OPENCLAW_NPM_ONBOARD_E2E_IMAGE: "openclaw-onboard-test-image",
      OPENCLAW_NPM_ONBOARD_HOST_BUILD: "0",
      OPENCLAW_NPM_ONBOARD_SOURCE_ROOT: sourceRoot,
      OPENCLAW_NPM_ONBOARD_USE_SOURCE_PLUGIN_PACKAGE: "1",
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
      ...registryEnv,
    },
  });
  const dockerArgs = readFileSync(dockerArgsPath, { encoding: "utf8", flag: "a+" })
    .split("\n")
    .filter(Boolean);
  return { dockerArgs, result };
}

describe("npm onboarding fixture consent", () => {
  it.each([false, true])("selects the reviewed Codex source with registry=%s", (registry) => {
    const { result, events, installs, detail } = runScenario({ registry });
    expect(result.status, detail).toBe(0);
    expect(installs, detail).toEqual([
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
    { registry: false, channel: "discord" as const, sourcePlugin: true },
    { registry: true, channel: "slack" as const },
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
    expect(installs.slice(1), detail).toEqual(
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

  it("propagates the source package through the outer Docker boundary without install overrides", () => {
    const { dockerArgs, result } = runOuterSourceScenario(true);

    expect(result.status, result.stderr).toBe(0);
    expect(dockerArgs).toContain("OPENCLAW_NPM_ONBOARD_USE_SOURCE_PLUGIN_PACKAGE=1");
    expect(dockerArgs.some((arg) => arg.endsWith(":/tmp/openclaw-channel-plugin.tgz:ro"))).toBe(
      true,
    );
    expect(dockerArgs.join("\n")).not.toContain("OPENCLAW_PLUGIN_INSTALL_OVERRIDES");
    expect(dockerArgs.join("\n")).not.toContain("OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES");
  });

  it("fails source package mode instead of falling back without the mounted registry", () => {
    const { result } = runOuterSourceScenario(false);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Source plugin package mode requires the mounted prerelease plugin registry.",
    );
  });
});
