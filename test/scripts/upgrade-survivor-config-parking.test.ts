import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const PUBLISHED_RUNNER_PATH = path.resolve("scripts/e2e/lib/upgrade-survivor/run.sh");
const SCRIPT_PATH = path.resolve("scripts/e2e/lib/upgrade-survivor/config-parking.mjs");
const SURVIVOR_SCRIPT_PATH = path.resolve("scripts/e2e/upgrade-survivor-docker.sh");
const E2E_INSTANCE_SCRIPT_PATH = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("upgrade survivor config parking", () => {
  it.each([
    { registry: false, installStatus: 0, stopStatus: 0, activeStatus: 3 },
    { registry: true, installStatus: 0, stopStatus: 0, activeStatus: 3 },
    { registry: false, installStatus: 23, stopStatus: 0, activeStatus: 3 },
    { registry: true, installStatus: 23, stopStatus: 0, activeStatus: 3 },
    { registry: false, installStatus: 0, stopStatus: 29, activeStatus: 0 },
    { registry: false, installStatus: 0, stopStatus: 0, activeStatus: 1 },
  ])(
    "isolates published auth setup and restores the migration specimen (registry=$registry, install=$installStatus, stop=$stopStatus, active=$activeStatus)",
    ({ registry, installStatus, stopStatus, activeStatus }) => {
      const root = tempDirs.make("openclaw-published-auth-parking-");
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const capturePath = path.join(root, "service-config.json");
      mkdirSync(stateDir);
      const auth = {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
      };
      const authoredConfig = `${JSON.stringify({
        gateway: { mode: "local", auth, reload: { mode: "hybrid" } },
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        plugins: {
          enabled: true,
          allow: ["codex", "discord", "whatsapp"],
          entries: { discord: { enabled: true }, whatsapp: { enabled: true } },
        },
        channels: { discord: { enabled: true }, whatsapp: { enabled: true } },
      })}\n`;
      writeFileSync(configPath, authoredConfig);
      const parkingWrapper = path.join(root, "parking.mjs");
      writeFileSync(
        parkingWrapper,
        `import fs from "node:fs";
import { spawnSync } from "node:child_process";
if (process.argv[2] === "restore") {
  fs.appendFileSync(process.env.PROBE_EVENTS, fs.existsSync(process.env.PROBE_LIVE) ? "restore-live\\n" : "restore-offline\\n");
}
const child = spawnSync(process.execPath, [${JSON.stringify(SCRIPT_PATH)}, ...process.argv.slice(2)], {stdio:"inherit"});
process.exit(child.status ?? 1);
`,
      );
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "systemctl"),
        `#!/usr/bin/env bash
  printf '%s\n' "$*" >>"$PROBE_EVENTS"
  case "$2" in
    stop)
      [ "$PROBE_STOP_STATUS" -eq 0 ] || exit "$PROBE_STOP_STATUS"
      [ "$PROBE_ACTIVE_STATUS" -eq 3 ] && rm -f "$PROBE_LIVE"
      exit 0 ;;
    is-active) exit "$PROBE_ACTIVE_STATUS" ;;
    *) exit 97 ;;
  esac
`,
        { mode: 0o755 },
      );
      const source = readFileSync(PUBLISHED_RUNNER_PATH, "utf8");
      const setup = source.slice(0, source.indexOf("phase storage-preflight"));
      const script = `${setup}
trap - EXIT ERR INT TERM
install_update_restart_systemctl_shim() { :; }

check_gateway_status() { :; }
openclaw_e2e_probe_tcp() { [ -f "$PROBE_LIVE" ]; }
assert_prepublish_fixture_idle() { :; }
assert_baseline_state() { :; }
run_update_restart_probe_gateway() {
  cp "$OPENCLAW_CONFIG_PATH" "$PROBE_CAPTURE"
  touch "$PROBE_INSTALLED" "$PROBE_LIVE"
  return "$PROBE_INSTALL_STATUS"
}
probe_status=0
prepare_update_restart_probe || probe_status=$?
exit "$probe_status"
`;
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.8.1",
          OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
          OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
          OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER: parkingWrapper,
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry ? path.join(root, "registry") : "",
          PROBE_CAPTURE: capturePath,
          PROBE_EVENTS: path.join(root, "events"),
          PROBE_LIVE: path.join(root, "live"),
          PROBE_STOP_STATUS: String(stopStatus),
          PROBE_ACTIVE_STATUS: String(activeStatus),
          PROBE_INSTALLED: path.join(root, "installed"),
          PROBE_INSTALL_STATUS: String(installStatus),
        },
      });
      const stopped = stopStatus === 0 && activeStatus === 3;
      expect(result.status, result.stdout + result.stderr).toBe(
        stopped ? installStatus : stopStatus || activeStatus,
      );
      expect(existsSync(path.join(root, "installed"))).toBe(true);
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
        plugins: { enabled: false },
        gateway: {
          port: 18789,
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          auth,
          reload: { mode: "off" },
        },
      });
      const snapshot = path.join(root, "runtime", "baseline-authored-openclaw.json");
      const events = readFileSync(path.join(root, "events"), "utf8");
      if (stopped) {
        expect(events).toContain("--user stop openclaw-gateway.service\n");
        expect(events).toContain("restore-offline\n");
        expect(events).not.toContain("restore-live");
        expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
        expect(existsSync(snapshot)).toBe(false);
      } else {
        expect(events).not.toContain("restore-");
        expect(readFileSync(snapshot, "utf8")).toBe(authoredConfig);
        expect(JSON.parse(readFileSync(configPath, "utf8")).plugins.enabled).toBe(false);
      }
    },
  );

  it.each([
    { startStatus: 0, readyStatus: 0, activeStatus: 3, mutation: "none" },
    { startStatus: 43, readyStatus: 0, activeStatus: 3, mutation: "none" },
    { startStatus: 0, readyStatus: 42, activeStatus: 3, mutation: "none" },
    { startStatus: 0, readyStatus: 0, activeStatus: 0, mutation: "none" },
    { startStatus: 0, readyStatus: 0, activeStatus: 1, mutation: "none" },
    { startStatus: 0, readyStatus: 0, activeStatus: 3, mutation: "unit" },
    { startStatus: 0, readyStatus: 0, activeStatus: 3, mutation: "env" },
  ])(
    "requires prepared service readiness before the final updater (start=$startStatus, ready=$readyStatus, active=$activeStatus, mutation=$mutation)",
    ({ startStatus, readyStatus, activeStatus, mutation }) => {
      const root = tempDirs.make("openclaw-repaired-service-start-");
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "systemctl"),
        `#!/usr/bin/env bash
[ "$*" != '--user is-active --quiet openclaw-gateway.service' ] || exit "$PROBE_ACTIVE_STATUS"
printf '%s\\n' "$*" >>"$PROBE_EVENTS"
[ "$*" = '--user start openclaw-gateway.service' ] || exit 97
printf 'synthetic start diagnostic\\n' >&2
[ "$PROBE_START_STATUS" -eq 0 ] || exit "$PROBE_START_STATUS"
printf '42\\n' >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
case "$PROBE_MUTATION" in
  unit) printf 'changed' >>"$HOME/.config/systemd/user/openclaw-gateway.service" ;;
  env) printf 'changed' >>"$OPENCLAW_STATE_DIR/gateway.systemd.env" ;;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(bin, "openclaw"), "#!/usr/bin/env bash\nexit 98\n", { mode: 0o755 });
      const redactor = path.join(root, "redactor.mjs");
      writeFileSync(
        redactor,
        `import { tsImport } from ${JSON.stringify(path.resolve("node_modules/tsx/dist/esm/api/index.mjs"))};
export const { redactSensitiveText } = await tsImport(${JSON.stringify(path.resolve("src/logging/redact.ts"))}, import.meta.url);
`,
      );
      const source = readFileSync(PUBLISHED_RUNNER_PATH, "utf8");
      const setup = source.slice(0, source.indexOf("phase storage-preflight"));
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${setup}
trap - EXIT ERR INT TERM
update_repair_required=0
mkdir -p "$HOME/.config/systemd/user" "$OPENCLAW_STATE_DIR"
printf 'original unit\\n' >"$HOME/.config/systemd/user/openclaw-gateway.service"
printf 'original env\\n' >"$OPENCLAW_STATE_DIR/gateway.systemd.env"
printf 'original dotenv\\n' >"$OPENCLAW_STATE_DIR/.env"
printf 'baseline timeline\\n' >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG"
: >"$PROBE_EVENTS"
openclaw_e2e_wait_gateway_ready() {
  printf 'readiness\\n' >>"$PROBE_EVENTS"
  return "$PROBE_READY_STATUS"
}
check_gateway_status() { printf 'authenticated\\n' >>"$PROBE_EVENTS"; }
# Only the independent updater boundary is substituted; preparation and phases are real.
update_candidate() { printf 'update\\n' >>"$PROBE_EVENTS"; }
assert_survival() { printf 'assert-survival\\n' >>"$PROBE_EVENTS"; }
probe_status=0
repair_fixture_plugin_consent || probe_status=$?
exit "$probe_status"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.8.1",
            OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
            OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
            OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
            OPENCLAW_CLAWHUB_URL: "",
            PROBE_EVENTS: path.join(root, "events"),
            OPENCLAW_E2E_REDACTOR_MODULE: redactor,
            PROBE_ACTIVE_STATUS: String(activeStatus),
            PROBE_MUTATION: mutation,
            PROBE_START_STATUS: String(startStatus),
            PROBE_READY_STATUS: String(readyStatus),
          },
        },
      );
      const expected =
        activeStatus === 3
          ? startStatus || (mutation !== "none" ? 1 : readyStatus)
          : activeStatus || 1;
      expect(result.status, result.stdout + result.stderr).toBe(expected);
      expect(
        readFileSync(path.join(root, "events"), "utf8").trimEnd().split("\n").filter(Boolean),
      ).toEqual(
        activeStatus !== 3
          ? []
          : startStatus || mutation !== "none"
            ? ["--user start openclaw-gateway.service"]
            : readyStatus
              ? ["--user start openclaw-gateway.service", "readiness"]
              : [
                  "--user start openclaw-gateway.service",
                  "readiness",
                  "authenticated",
                  "update",
                  "assert-survival",
                ],
      );
      if (activeStatus === 3) {
        expect(
          readFileSync(
            path.join(root, "artifacts", "systemctl-shim-gateway.log.before-start"),
            "utf8",
          ),
        ).toBe("baseline timeline\n");
      }
      if (startStatus) {
        expect(result.stderr).toContain("synthetic start diagnostic");
      }
      const phases = readFileSync(path.join(root, "artifacts", "phases.jsonl"), "utf8");
      if (expected) {
        expect(phases).not.toContain('"status":"passed"');
        expect(phases).not.toContain("recovery-update-restart");
      }
    },
  );

  it.each([false, true])(
    "preserves phase failure without disabling normal errexit (conditional=%s)",
    (conditional) => {
      const root = tempDirs.make("openclaw-survivor-phase-failure-");
      const source = readFileSync(PUBLISHED_RUNNER_PATH, "utf8");
      const setup = source.slice(0, source.indexOf("phase storage-preflight"));
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${setup}
trap - EXIT ERR INT TERM
handler() {
  ${conditional ? "return 47" : "bash -c 'exit 47'"}
  touch "$PROBE_SIDE_EFFECT"
}
${conditional ? 'probe_status=0; phase preparation handler || probe_status=$?; exit "$probe_status"' : "phase preparation handler"}
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.8.1",
            OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
            OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
            PROBE_SIDE_EFFECT: path.join(root, "side-effect"),
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(47);
      expect(existsSync(path.join(root, "side-effect"))).toBe(false);
      expect(readFileSync(path.join(root, "artifacts", "phases.jsonl"), "utf8")).not.toContain(
        '"status":"passed"',
      );
    },
  );

  it("parks legacy authored config behind a strict restart probe config", () => {
    const root = tempDirs.make("openclaw-restart-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig =
      '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-restart-probe", configPath, snapshotPath, "19876");
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      plugins: { enabled: false },
      gateway: {
        port: 19876,
        mode: "local",
        bind: "loopback",
        controlUi: { enabled: false },
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "GATEWAY_AUTH_TOKEN_REF",
          },
        },
        reload: { mode: "off" },
      },
    });
  });

  it("parks companion installs behind a plugin-disabled config and restores exact bytes", () => {
    const root = tempDirs.make("openclaw-companion-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig =
      '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-companion-install", configPath, snapshotPath);
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      plugins: { enabled: false },
    });

    writeFileSync(configPath, '{"plugins":{"allow":["discord"]}}\n');
    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status, restore.stderr).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it.each([
    { installStatus: 0, inspectStatus: 0 },
    { installStatus: 23, inspectStatus: 0 },
    { installStatus: 0, inspectStatus: 29 },
  ])(
    "parks companion inspection and restores authored bytes (install=$installStatus, inspect=$inspectStatus)",
    ({ installStatus, inspectStatus }) => {
      const root = tempDirs.make("openclaw-companion-install-failure-");
      const binDir = path.join(root, "bin");
      const configPath = path.join(root, "openclaw.json");
      const invocationPath = path.join(root, "openclaw-invocations");
      const runnerPath = path.join(root, "run-companion-install.sh");
      const authoredConfig =
        '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
      mkdirSync(binDir);
      writeFileSync(configPath, authoredConfig);
      const survivorScript = readFileSync(SURVIVOR_SCRIPT_PATH, "utf8");
      const functionStart = survivorScript.indexOf("install_companion_plugins() {");
      const functionEnd = survivorScript.indexOf(
        "\n}\n\nopenclaw_e2e_eval_test_state_from_b64",
        functionStart,
      );
      expect(functionStart).toBeGreaterThan(-1);
      expect(functionEnd).toBeGreaterThan(functionStart);
      const functionSource = survivorScript.slice(functionStart, functionEnd + 2);
      const e2eInstanceScript = readFileSync(E2E_INSTANCE_SCRIPT_PATH, "utf8");
      const fixtureCommandStart = e2eInstanceScript.indexOf(
        "openclaw_e2e_fixture_plugin_command() {",
      );
      const fixtureCommandEnd = e2eInstanceScript.indexOf(
        "\n}\nopenclaw_e2e_enable_openclaw_cli_timeout",
        fixtureCommandStart,
      );
      expect(fixtureCommandStart).toBeGreaterThan(-1);
      expect(fixtureCommandEnd).toBeGreaterThan(fixtureCommandStart);
      const fixtureCommandSource = e2eInstanceScript.slice(
        fixtureCommandStart,
        fixtureCommandEnd + 2,
      );
      writeFileSync(
        path.join(binDir, "openclaw"),
        `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$OPENCLAW_INVOCATION_PATH" ]; then
  count="$(cat "$OPENCLAW_INVOCATION_PATH")"
fi
count=$((count + 1))
printf '%s' "$count" >"$OPENCLAW_INVOCATION_PATH"
if [ "$count" -eq 2 ]; then
  exit "$PROBE_INSTALL_STATUS"
fi
`,
      );
      chmodSync(path.join(binDir, "openclaw"), 0o755);
      writeFileSync(
        path.join(binDir, "node"),
        `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  scripts/e2e/lib/upgrade-survivor/assertions.mjs)
    cp "$OPENCLAW_CONFIG_PATH" "$PROBE_INSPECT_CONFIG"
    "$PROBE_NODE" -e 'const config = require(process.env.OPENCLAW_CONFIG_PATH); if (config.channels || config.plugins?.enabled !== false) process.exit(37);'
    exit "$PROBE_INSPECT_STATUS" ;;
  unused) exit 0 ;;
  *) exec "$PROBE_NODE" "$@" ;;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(
        runnerPath,
        `#!/usr/bin/env bash
set -euo pipefail
${fixtureCommandSource}
${functionSource}
install_companion_plugins
`,
      );

      const result = spawnSync("bash", [runnerPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_INVOCATION_PATH: invocationPath,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
          OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER: SCRIPT_PATH,
          OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER: "unused",
          OPENCLAW_CLAWHUB_URL: "http://fixture.invalid",
          OPENCLAW_E2E_LAST_FIXTURE_PLUGIN_CAPABILITY_CONSENT_SUPPORTED: "1",
          PROBE_NODE: process.execPath,
          PROBE_INSPECT_CONFIG: path.join(root, "inspect-config.json"),
          PROBE_INSTALL_STATUS: String(installStatus),
          PROBE_INSPECT_STATUS: String(inspectStatus),
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          package_version: "2026.8.1",
        },
      });

      expect(result.status, result.stderr).toBe(installStatus || inspectStatus);
      if (!installStatus) {
        expect(JSON.parse(readFileSync(path.join(root, "inspect-config.json"), "utf8"))).toEqual({
          plugins: { enabled: false },
        });
      }
      expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
      expect(existsSync(path.join(root, "companion-install-authored.json"))).toBe(false);
    },
  );

  it("rejects malformed config without changing authored bytes", () => {
    const root = tempDirs.make("openclaw-invalid-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig = "[]\n";
    writeFileSync(configPath, authoredConfig);

    const park = run("park-restart-probe", configPath, snapshotPath, "19876");
    expect(park.status).toBe(1);
    expect(park.stderr).toContain("restart probe config must be an object");
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("keeps the snapshot when restore cannot replace the config path", () => {
    const root = tempDirs.make("openclaw-failed-config-restore-");
    const configPath = path.join(root, "config-directory");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    mkdirSync(configPath);
    writeFileSync(snapshotPath, '{"gateway":{"mode":"local"}}\n');

    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status).toBe(1);
    expect(existsSync(snapshotPath)).toBe(true);
  });
});
