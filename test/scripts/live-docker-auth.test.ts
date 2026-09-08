// Live Docker Auth tests cover live docker auth script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempBin(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function runDockerRunArgs(pathPrefix: string) {
  const script = [
    "source scripts/lib/live-docker-auth.sh",
    "unset OPENCLAW_LIVE_DOCKER_DISABLE_RESOURCE_LIMITS OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS",
    "unset OPENCLAW_LIVE_DOCKER_MEMORY OPENCLAW_DOCKER_E2E_MEMORY",
    "unset OPENCLAW_LIVE_DOCKER_CPUS OPENCLAW_DOCKER_E2E_CPUS",
    "unset OPENCLAW_LIVE_DOCKER_PIDS_LIMIT OPENCLAW_DOCKER_E2E_PIDS_LIMIT",
    "ARGS=()",
    "openclaw_live_init_docker_run_args ARGS 42s || exit $?",
    "printf '%s\\n' \"${ARGS[@]}\"",
  ].join("\n");

  return spawnSync("/bin/bash", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: pathPrefix,
    },
  });
}

function resolveDockerRunArgs(pathPrefix: string) {
  const result = runDockerRunArgs(pathPrefix);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trimEnd().split("\n");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("scripts/lib/live-docker-auth.sh", () => {
  it("reads positive integer env values before live Docker setup", () => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "source scripts/lib/live-docker-auth.sh",
          'fallback="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_SAMPLE_SECONDS 180)"',
          'leading_zero="$(OPENCLAW_LIVE_SAMPLE_SECONDS=008 openclaw_live_read_positive_int_env OPENCLAW_LIVE_SAMPLE_SECONDS 180)"',
          'printf "%s\\n%s\\n" "$fallback" "$leading_zero"',
        ].join("\n"),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const invalid = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "source scripts/lib/live-docker-auth.sh",
          "OPENCLAW_LIVE_SAMPLE_SECONDS=30s openclaw_live_read_positive_int_env OPENCLAW_LIVE_SAMPLE_SECONDS 180",
        ].join("\n"),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(["180", "008"]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("invalid OPENCLAW_LIVE_SAMPLE_SECONDS: 30s");
  });

  it("collects default and provider-filtered auth under Bash 3 nounset", () => {
    const homeDir = makeTempBin("openclaw-live-docker-auth-home-");
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/lib/live-docker-auth.sh",
          "unset OPENCLAW_DOCKER_AUTH_DIRS DOCKER_HOME_DIR",
          'openclaw_live_collect_auth_for_providers ","',
          "openclaw_live_finalize_auth_mounts",
          'printf "default-dirs=%s\\ndefault-files=%s\\ndefault-mounts=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "${#EXTERNAL_AUTH_MOUNTS[@]}"',
          'openclaw_live_collect_auth_for_providers "openai, gemini"',
          "openclaw_live_finalize_auth_mounts",
          'printf "filtered-dirs=%s\\nfiltered-files=%s\\nfiltered-mounts=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "${#EXTERNAL_AUTH_MOUNTS[@]}"',
          "OPENCLAW_DOCKER_AUTH_DIRS=none",
          "openclaw_live_collect_auth_for_providers openai",
          "openclaw_live_finalize_auth_mounts",
          'printf "none-dirs=%s\\nnone-files=%s\\nnone-mounts=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "${#EXTERNAL_AUTH_MOUNTS[@]}"',
        ].join("\n"),
      ],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HOME: homeDir } },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "default-dirs=.factory,.gemini,.minimax",
      "default-files=.codex/auth.json,.codex/config.toml,.claude.json,.claude/.credentials.json,.claude/settings.json,.claude/settings.local.json,.gemini/settings.json",
      "default-mounts=0",
      "filtered-dirs=.gemini",
      "filtered-files=.codex/auth.json,.codex/config.toml",
      "filtered-mounts=0",
      "none-dirs=",
      "none-files=",
      "none-mounts=0",
    ]);
  });

  it("prestages selected auth and preserves equivalent external mounts", () => {
    const homeDir = makeTempBin("openclaw-live-docker-auth-source-");
    const dockerHomeDir = makeTempBin("openclaw-live-docker-auth-target-");
    mkdirSync(path.join(homeDir, ".gemini"), { recursive: true });
    mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    writeFileSync(path.join(homeDir, ".gemini", "token"), "gemini-token\n", "utf8");
    writeFileSync(path.join(homeDir, ".codex", "auth.json"), "codex-token\n", "utf8");

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/lib/live-docker-auth.sh",
          "unset OPENCLAW_DOCKER_AUTH_DIRS",
          "DOCKER_AUTH_PRESTAGED=0",
          'openclaw_live_collect_auth_for_providers "openai,gemini"',
          "openclaw_live_finalize_auth_mounts",
          'printf "dirs=%s\\nfiles=%s\\nprestaged=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "$DOCKER_AUTH_PRESTAGED"',
          'printf "%s\\n" "${EXTERNAL_AUTH_MOUNTS[@]}"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DOCKER_HOME_DIR: dockerHomeDir, HOME: homeDir },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "dirs=.gemini",
      "files=.codex/auth.json,.codex/config.toml",
      "prestaged=1",
      "-v",
      `${homeDir}/.gemini:/host-auth/.gemini:ro`,
      "-v",
      `${homeDir}/.codex/auth.json:/host-auth-files/.codex/auth.json:ro`,
    ]);
    expect(readFileSync(path.join(dockerHomeDir, ".gemini", "token"), "utf8")).toBe(
      "gemini-token\n",
    );
    expect(readFileSync(path.join(dockerHomeDir, ".codex", "auth.json"), "utf8")).toBe(
      "codex-token\n",
    );
  });

  it("handles empty mounted auth lists under Bash 3 nounset", () => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/lib/live-docker-stage.sh",
          "OPENCLAW_DOCKER_AUTH_PRESTAGED=0",
          "OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED=",
          "OPENCLAW_DOCKER_AUTH_FILES_RESOLVED=",
          "openclaw_live_stage_mounted_auth",
          "printf mounted-auth-ok",
        ].join("\n"),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("mounted-auth-ok");
  });

  it("adds a kill-after grace period when timeout supports it", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-gnu-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    expect(resolveDockerRunArgs(binDir)).toEqual([
      "timeout",
      "--kill-after=30s",
      "42s",
      "docker",
      "run",
      "--init",
      "--memory",
      "8g",
      "--cpus",
      "16",
      "--pids-limit",
      "2048",
    ]);
  });

  it("caps default CPU limits to the runner capacity", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-cpus-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "source scripts/lib/live-docker-auth.sh",
          "ARGS=()",
          "OPENCLAW_LIVE_DOCKER_AVAILABLE_CPUS=8 openclaw_live_init_docker_run_args ARGS 42s",
          "printf '%s\\n' \"${ARGS[@]}\"",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: binDir,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "timeout",
      "--kill-after=30s",
      "42s",
      "docker",
      "run",
      "--init",
      "--memory",
      "8g",
      "--cpus",
      "8",
      "--pids-limit",
      "2048",
    ]);
  });

  it("falls back to plain timeout when kill-after is unavailable", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-plain-");
    writeExecutable(
      path.join(binDir, "timeout"),
      ["#!/bin/sh", 'if [ "$1" = "--kill-after=1s" ]; then', "  exit 1", "fi", "exit 0", ""].join(
        "\n",
      ),
    );

    expect(resolveDockerRunArgs(binDir)).toEqual([
      "timeout",
      "42s",
      "docker",
      "run",
      "--init",
      "--memory",
      "8g",
      "--cpus",
      "16",
      "--pids-limit",
      "2048",
    ]);
  });

  it("uses gtimeout when timeout is unavailable", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-gtimeout-");
    writeExecutable(
      path.join(binDir, "gtimeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    expect(resolveDockerRunArgs(binDir)).toEqual([
      "gtimeout",
      "--kill-after=30s",
      "42s",
      "docker",
      "run",
      "--init",
      "--memory",
      "8g",
      "--cpus",
      "16",
      "--pids-limit",
      "2048",
    ]);
  });

  it.each(["0", "1"])(
    "prepares bind ownership with resource limits disabled=%s under nounset",
    (disabled) => {
      const dir = makeTempBin("openclaw-live-bind-dir-");
      const result = spawnSync(
        "/bin/bash",
        [
          "-uc",
          [
            "source scripts/lib/live-docker-auth.sh",
            // Capture the real helper's argv without starting Docker or changing ownership.
            "docker() { printf '%s\\0' \"$@\"; }",
            'openclaw_live_chown_bind_dirs_for_container_user fixture-image 1000:1000 "$1"',
          ].join("\n"),
          "bind-dir-test",
          dir,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_LIVE_DOCKER_DISABLE_RESOURCE_LIMITS: disabled,
            OPENCLAW_LIVE_DOCKER_MEMORY: "8g",
            OPENCLAW_LIVE_DOCKER_CPUS: "16",
            OPENCLAW_LIVE_DOCKER_PIDS_LIMIT: "2048",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const args = result.stdout.split("\0").slice(0, -1);
      expect(args).toContain(`${dir}:/openclaw-bind-dir-0`);
      expect(args).toContain("OPENCLAW_BIND_DIR_USER=1000:1000");
      expect(args).toContain("fixture-image");
      expect(args).not.toContain("");
      expect(args.includes("--memory")).toBe(disabled === "0");
    },
  );

  it("allows live Docker resource limits to be disabled", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-no-limits-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "source scripts/lib/live-docker-auth.sh",
          "ARGS=()",
          "OPENCLAW_LIVE_DOCKER_DISABLE_RESOURCE_LIMITS=1 openclaw_live_init_docker_run_args ARGS 42s",
          "printf '%s\\n' \"${ARGS[@]}\"",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: binDir,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "timeout",
      "--kill-after=30s",
      "42s",
      "docker",
      "run",
      "--init",
    ]);
  });

  it("normalizes live Docker pids limits", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-pids-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "source scripts/lib/live-docker-auth.sh",
          "ARGS=()",
          "OPENCLAW_LIVE_DOCKER_PIDS_LIMIT=0008 openclaw_live_init_docker_run_args ARGS 42s",
          "printf '%s\\n' \"${ARGS[@]}\"",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: binDir,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toContain("8");
  });

  it.each([
    ["live", "OPENCLAW_LIVE_DOCKER_PIDS_LIMIT"],
    ["shared", "OPENCLAW_DOCKER_E2E_PIDS_LIMIT"],
  ])("rejects invalid %s Docker pids limits before live Docker setup", (_label, envName) => {
    const binDir = makeTempBin("openclaw-live-docker-auth-invalid-pids-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "source scripts/lib/live-docker-auth.sh",
          "ARGS=()",
          "openclaw_live_init_docker_run_args ARGS 42s",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_E2E_PIDS_LIMIT:
            envName === "OPENCLAW_DOCKER_E2E_PIDS_LIMIT" ? "many" : "",
          OPENCLAW_LIVE_DOCKER_PIDS_LIMIT:
            envName === "OPENCLAW_LIVE_DOCKER_PIDS_LIMIT" ? "many" : "",
          PATH: binDir,
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: many`);
    expect(result.stdout).toBe("");
  });

  it("fails fast when no timeout wrapper is available", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-no-timeout-");

    const result = runDockerRunArgs(binDir);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "timeout command not found; cannot bound live Docker run after 42s",
    );
  });
});
