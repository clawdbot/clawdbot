// Live Docker Auth tests cover live docker auth script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      "--memory",
      "8g",
      "--cpus",
      "16",
      "--pids-limit",
      "2048",
    ]);
  });

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
