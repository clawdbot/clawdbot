import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const script = readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8");
const setup = script
  .split("read -r -d '' LIVE_TEST_CMD <<'EOF' || true\n")[1]!
  .split('tmp_dir="$(mktemp -d)"')[0]!;

it.each([
  { existing: "claude", mode: "subscription", key: "unset" },
  { existing: "claude-real", mode: "api-key", key: "fixture-key" },
  { existing: undefined, mode: "subscription", key: "unset" },
])("prepares $mode Claude from $existing without the retired SDK", ({ existing, mode, key }) => {
  const home = createTempDir("openclaw-acp-claude-setup-");
  const bin = path.join(home, "bin");
  const prefix = path.join(home, "npm");
  const installedBin = path.join(prefix, "bin");
  const calls = path.join(home, "calls");
  const installs = path.join(home, "installs");
  const fixture = path.join(home, "claude-fixture");
  mkdirSync(bin);
  mkdirSync(installedBin, { recursive: true });
  const executable =
    '#!/bin/sh\nprintf "%s:%s\\n" "$*" "${ANTHROPIC_API_KEY-unset}" >> "$TEST_CALLS"\nprintf "9.1.0 (Claude Code)\\n"\n';
  writeFileSync(fixture, executable, { mode: 0o755 });
  if (existing) {
    writeFileSync(path.join(installedBin, existing), executable, { mode: 0o755 });
  }
  writeFileSync(
    path.join(bin, "npm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_INSTALLS"\ncp "$TEST_CLAUDE_FIXTURE" "$NPM_CONFIG_PREFIX/bin/claude"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "timeout"),
    '#!/bin/sh\ncase "$1" in --kill-after=*) shift;; esac\nshift\nexec "$@"\n',
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", setup], {
    cwd: home,
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NPM_CONFIG_PREFIX: prefix,
      OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR: path.resolve("scripts"),
      OPENCLAW_DOCKER_AUTH_PRESTAGED: "1",
      OPENCLAW_LIVE_ACP_BIND_AGENT: "claude",
      OPENCLAW_LIVE_ACP_BIND_CLAUDE_AUTH: mode,
      OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS: "180",
      ANTHROPIC_API_KEY: "ambient-fixture-key",
      OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY: "fixture-key",
      TEST_CALLS: calls,
      TEST_INSTALLS: installs,
      TEST_CLAUDE_FIXTURE: fixture,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("9.1.0 (Claude Code)");
  expect(readFileSync(calls, "utf8")).toBe(`--version:${key}\nauth status:${key}\n`);
  expect(readFileSync(path.join(installedBin, "claude-real"), "utf8")).toBe(executable);
  expect(existsSync(installs)).toBe(existing === undefined);
  if (!existing) {
    expect(readFileSync(installs, "utf8")).toBe("install -g @anthropic-ai/claude-code\n");
  }
});
