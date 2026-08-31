import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/connect.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture() {
  const root = tempDirs.make("openclaw-connect-installer-");
  const installer = join(root, "install-cli.sh");
  const installArgs = join(root, "install-args");
  const helpArgs = join(root, "help-args");
  const connectArgs = join(root, "connect-args");
  const targetContent = join(root, "target-content");
  const targetCreatedBeforeHelp = join(root, "target-created-before-help");
  const targetMode = join(root, "target-mode");
  const targetPath = join(root, "target-path");
  writeFileSync(
    installer,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$FAKE_INSTALL_ARGS"
prefix=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$prefix" ]]
mkdir -p "$prefix/bin"
cat >"$prefix/bin/openclaw" <<'OPENCLAW'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -eq 2 && "$1" == "connect" && "$2" == "--help" ]]; then
  printf '%s\n' "$@" >"$FAKE_HELP_ARGS"
  target_files=("\${TMPDIR:-/tmp}"/openclaw-connect.*/join-target)
  if [[ -e "\${target_files[0]}" ]]; then
    : >"$FAKE_TARGET_CREATED_BEFORE_HELP"
  fi
  if [[ -n "\${FAKE_CONNECT_HELP:-}" ]]; then
    printf '%s\n' "$FAKE_CONNECT_HELP"
  else
    printf '%s\n' '  --target-file <path>' '  --service' '  --session-host'
  fi
  exit "\${FAKE_HELP_EXIT:-0}"
fi
printf '%s\n' "$@" >"$FAKE_CONNECT_ARGS"
target_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-file) target_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$target_file" ]]
printf '%s\n' "$target_file" >"$FAKE_TARGET_PATH"
if mode="$(stat -f '%Lp' "$target_file" 2>/dev/null)"; then
  printf '%s\n' "$mode" >"$FAKE_TARGET_MODE"
else
  stat -c '%a' "$target_file" >"$FAKE_TARGET_MODE"
fi
cat "$target_file" >"$FAKE_TARGET_CONTENT"
exit "\${FAKE_CLI_EXIT:-0}"
OPENCLAW
chmod 0755 "$prefix/bin/openclaw"
`,
  );
  chmodSync(installer, 0o755);
  return {
    root,
    installer,
    installArgs,
    helpArgs,
    connectArgs,
    targetContent,
    targetCreatedBeforeHelp,
    targetMode,
    targetPath,
  };
}

function runWrapper(
  fixture: ReturnType<typeof createFixture>,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync("/bin/bash", [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_INSTALL_CLI_URL: fixture.installer,
      FAKE_INSTALL_ARGS: fixture.installArgs,
      FAKE_HELP_ARGS: fixture.helpArgs,
      FAKE_CONNECT_ARGS: fixture.connectArgs,
      FAKE_TARGET_CONTENT: fixture.targetContent,
      FAKE_TARGET_CREATED_BEFORE_HELP: fixture.targetCreatedBeforeHelp,
      FAKE_TARGET_MODE: fixture.targetMode,
      FAKE_TARGET_PATH: fixture.targetPath,
      TMPDIR: fixture.root,
      ...env,
    },
  });
}

function readArgs(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n");
}

describe("scripts/connect.sh", () => {
  it("installs an exact version and hands the private target to a session-host service", () => {
    const fixture = createFixture();
    const prefix = join(fixture.root, "prefix");
    const target = "oc-pair://private-join-target";

    const result = runWrapper(
      fixture,
      ["--version", "2026.8.1", "--prefix", prefix, "--display-name", "Runner Node", target],
      { HOME: undefined },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readArgs(fixture.installArgs)).toEqual([
      "--version",
      "2026.8.1",
      "--prefix",
      prefix,
      "--no-onboard",
    ]);
    expect(readArgs(fixture.helpArgs)).toEqual(["connect", "--help"]);
    expect(existsSync(fixture.targetCreatedBeforeHelp)).toBe(false);
    const connectArgs = readArgs(fixture.connectArgs);
    const privateTargetPath = readFileSync(fixture.targetPath, "utf8").trim();
    expect(connectArgs).toEqual([
      "connect",
      "--target-file",
      privateTargetPath,
      "--service",
      "--session-host",
      "--display-name",
      "Runner Node",
    ]);
    expect(readFileSync(fixture.targetContent, "utf8")).toBe(`${target}\n`);
    expect(readFileSync(fixture.targetMode, "utf8").trim()).toBe("600");
    expect(readFileSync(fixture.installArgs, "utf8")).not.toContain(target);
    expect(readFileSync(fixture.connectArgs, "utf8")).not.toContain(target);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(target);
    expect(existsSync(privateTargetPath)).toBe(false);
    expect(existsSync(dirname(privateTargetPath))).toBe(false);
  });

  it.each([
    { name: "the help probe fails", env: { FAKE_HELP_EXIT: "2" } },
    {
      name: "help omits --target-file",
      env: { FAKE_CONNECT_HELP: "  --service\n  --session-host" },
    },
    {
      name: "help omits --service",
      env: { FAKE_CONNECT_HELP: "  --target-file <path>\n  --session-host" },
    },
    {
      name: "help omits --session-host",
      env: { FAKE_CONNECT_HELP: "  --target-file <path>\n  --service" },
    },
  ])("rejects an installed CLI when $name", ({ env }) => {
    const fixture = createFixture();
    const prefix = join(fixture.root, "prefix");
    const target = "oc-pair://private-join-target";

    const result = runWrapper(
      fixture,
      ["--version", "2026.7.1-2", "--prefix", prefix, target],
      env,
    );

    expect(result.status).toBe(1);
    expect(readArgs(fixture.installArgs)).toContain("2026.7.1-2");
    expect(readArgs(fixture.helpArgs)).toEqual(["connect", "--help"]);
    expect(result.stderr).toContain(
      "selected exact version 2026.7.1-2 does not support session-host onboarding",
    );
    expect(result.stderr).toContain("Choose a newer supporting exact version");
    expect(result.stderr.match(/ERROR:/gu)).toHaveLength(1);
    expect(existsSync(fixture.targetCreatedBeforeHelp)).toBe(false);
    expect(existsSync(fixture.connectArgs)).toBe(false);
    expect(existsSync(fixture.targetPath)).toBe(false);
    expect(existsSync(fixture.targetContent)).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(target);
  });

  it("respects OPENCLAW_PREFIX when --prefix is omitted", () => {
    const fixture = createFixture();
    const prefix = join(fixture.root, "env-prefix");

    const result = runWrapper(fixture, ["--version", "2026.8.1", "setup-code"], {
      OPENCLAW_PREFIX: prefix,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readArgs(fixture.installArgs)).toContain(prefix);
  });

  it("cleans the private target after an installed CLI failure", () => {
    const fixture = createFixture();
    const prefix = join(fixture.root, "prefix");

    const result = runWrapper(
      fixture,
      ["--version", "2026.8.1", "--prefix", prefix, "setup-code"],
      { FAKE_CLI_EXIT: "23" },
    );

    const privateTargetPath = readFileSync(fixture.targetPath, "utf8").trim();
    expect(result.status).toBe(23);
    expect(result.stderr).toContain(
      "OpenClaw could not connect or install the session-host service.",
    );
    expect(existsSync(privateTargetPath)).toBe(false);
    expect(existsSync(dirname(privateTargetPath))).toBe(false);
  });

  it("requires an explicit version", () => {
    const fixture = createFixture();

    const result = runWrapper(fixture, ["setup-code"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--version is required");
    expect(existsSync(fixture.installArgs)).toBe(false);
  });

  it.each([
    {
      name: "default prefix",
      args: ["--version", "2026.8.1", "setup-code"],
      message: "Cannot resolve the default install prefix",
    },
    {
      name: "tilde prefix",
      args: ["--version", "2026.8.1", "--prefix", "~/.openclaw", "setup-code"],
      message: "Cannot expand prefix '~/.openclaw'",
    },
  ])("fails cleanly without HOME for the $name", ({ args, message }) => {
    const fixture = createFixture();

    const result = runWrapper(fixture, args, {
      HOME: undefined,
      OPENCLAW_PREFIX: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr.match(/ERROR:/gu)).toHaveLength(1);
    expect(existsSync(fixture.installArgs)).toBe(false);
  });

  it.each(["latest", "next", "beta", "v2026.8.1", "2026.8", "2026.8.x", "^2026.8.1", "2026.8.*"])(
    "rejects non-exact version %s",
    (version) => {
      const fixture = createFixture();

      const result = runWrapper(fixture, ["--version", version, "setup-code"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("leading v, moving tags, ranges, and wildcards");
      expect(existsSync(fixture.installArgs)).toBe(false);
    },
  );
});
