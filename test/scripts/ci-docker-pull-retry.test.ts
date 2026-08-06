// Ci Docker Pull Retry tests cover ci docker pull retry script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("scripts/ci-docker-pull-retry.sh");
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

function runPullHelper(binDir: string) {
  return runPullHelperWithEnv(binDir, {});
}

function runPullHelperWithEnv(binDir: string, env: Record<string, string>) {
  return spawnSync("/bin/bash", [SCRIPT_PATH, "registry.example/openclaw:test"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DOCKER_PULL_ATTEMPTS: "1",
      OPENCLAW_DOCKER_PULL_RETRY_DELAY_SECONDS: "0",
      OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS: "42",
      ...env,
      PATH: binDir,
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("scripts/ci-docker-pull-retry.sh", () => {
  it("uses a kill-after grace period when timeout supports it", () => {
    const binDir = makeTempBin("openclaw-ci-docker-pull-gnu-");
    const timeoutArgsPath = path.join(binDir, "timeout-args.txt");
    const dockerArgsPath = path.join(binDir, "docker-args.txt");

    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
        `printf "%s\\n" "$*" >${JSON.stringify(timeoutArgsPath)}`,
        'while [ "$#" -gt 0 ] && [ "$1" != "docker" ]; do shift; done',
        'exec "$@"',
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(binDir, "docker"),
      ["#!/bin/sh", "set -eu", `printf "%s\\n" "$*" >${JSON.stringify(dockerArgsPath)}`, ""].join(
        "\n",
      ),
    );

    const result = runPullHelper(binDir);

    expect(result.status).toBe(0);
    expect(execFileSync("cat", [timeoutArgsPath], { encoding: "utf8" }).trim()).toBe(
      "--kill-after=30s 42s docker pull registry.example/openclaw:test",
    );
    expect(execFileSync("cat", [dockerArgsPath], { encoding: "utf8" }).trim()).toBe(
      "pull registry.example/openclaw:test",
    );
  });

  it("falls back to plain timeout when kill-after is unavailable", () => {
    const binDir = makeTempBin("openclaw-ci-docker-pull-plain-");
    const timeoutArgsPath = path.join(binDir, "timeout-args.txt");
    const dockerArgsPath = path.join(binDir, "docker-args.txt");

    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "--kill-after=1s" ]; then exit 1; fi',
        `printf "%s\\n" "$*" >${JSON.stringify(timeoutArgsPath)}`,
        'while [ "$#" -gt 0 ] && [ "$1" != "docker" ]; do shift; done',
        'exec "$@"',
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(binDir, "docker"),
      ["#!/bin/sh", "set -eu", `printf "%s\\n" "$*" >${JSON.stringify(dockerArgsPath)}`, ""].join(
        "\n",
      ),
    );

    const result = runPullHelper(binDir);

    expect(result.status).toBe(0);
    expect(execFileSync("cat", [timeoutArgsPath], { encoding: "utf8" }).trim()).toBe(
      "42s docker pull registry.example/openclaw:test",
    );
    expect(execFileSync("cat", [dockerArgsPath], { encoding: "utf8" }).trim()).toBe(
      "pull registry.example/openclaw:test",
    );
  });

  it("uses gtimeout when timeout is unavailable", () => {
    const binDir = makeTempBin("openclaw-ci-docker-pull-gtimeout-");
    const timeoutArgsPath = path.join(binDir, "gtimeout-args.txt");
    const dockerArgsPath = path.join(binDir, "docker-args.txt");

    writeExecutable(
      path.join(binDir, "gtimeout"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
        `printf "%s\\n" "gtimeout:$*" >${JSON.stringify(timeoutArgsPath)}`,
        'while [ "$#" -gt 0 ] && [ "$1" != "docker" ]; do shift; done',
        'exec "$@"',
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(binDir, "docker"),
      ["#!/bin/sh", "set -eu", `printf "%s\\n" "$*" >${JSON.stringify(dockerArgsPath)}`, ""].join(
        "\n",
      ),
    );

    const result = runPullHelper(binDir);

    expect(result.status).toBe(0);
    expect(execFileSync("cat", [timeoutArgsPath], { encoding: "utf8" }).trim()).toBe(
      "gtimeout:--kill-after=30s 42s docker pull registry.example/openclaw:test",
    );
    expect(execFileSync("cat", [dockerArgsPath], { encoding: "utf8" }).trim()).toBe(
      "pull registry.example/openclaw:test",
    );
  });

  it("fails fast when timeout and gtimeout are unavailable", () => {
    const binDir = makeTempBin("openclaw-ci-docker-pull-no-timeout-");
    const dockerArgsPath = path.join(binDir, "docker-args.txt");

    writeExecutable(
      path.join(binDir, "docker"),
      ["#!/bin/sh", "set -eu", `printf "%s\\n" "$*" >${JSON.stringify(dockerArgsPath)}`, ""].join(
        "\n",
      ),
    );

    const result = runPullHelper(binDir);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "timeout or gtimeout command not found; cannot bound Docker pull after 42s",
    );
    expect(existsSync(dockerArgsPath)).toBe(false);
  });

  it("returns the last pull failure status after retries are exhausted", () => {
    const binDir = makeTempBin("openclaw-ci-docker-pull-fail-");
    const dockerArgsPath = path.join(binDir, "docker-args.txt");

    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
        'while [ "$#" -gt 0 ] && [ "$1" != "docker" ]; do shift; done',
        'exec "$@"',
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(binDir, "docker"),
      [
        "#!/bin/sh",
        "set -eu",
        `printf "%s\\n" "$*" >>${JSON.stringify(dockerArgsPath)}`,
        "exit 42",
        "",
      ].join("\n"),
    );

    const result = runPullHelperWithEnv(binDir, { OPENCLAW_DOCKER_PULL_ATTEMPTS: "2" });

    expect(result.status).toBe(42);
    expect(result.stderr).toContain("Docker pull failed or timed out after 42s: status=42");
    expect(execFileSync("wc", ["-l", dockerArgsPath], { encoding: "utf8" }).trim()).toMatch(
      /^2\b/u,
    );
  });
});
