// Setup Pnpm Store Cache Ensure Node tests cover setup pnpm store cache ensure node script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ensureNodeScript = resolve(".github/actions/setup-pnpm-store-cache/ensure-node.sh");
let missingToolcacheCase: {
  status: number | null;
  stderr: string;
};

function writeFakeNode(binDir: string, version: string) {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  writeFileSync(
    nodePath,
    `#!/usr/bin/env bash
if [[ "$1" == "-p" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "$1" == "-v" ]]; then
  echo "v${version}"
  exit 0
fi
exit 0
`,
  );
  chmodSync(nodePath, 0o755);
  return nodePath;
}

function writeFakeCurl(binDir: string) {
  mkdirSync(binDir, { recursive: true });
  const curlPath = join(binDir, "curl");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OPENCLAW_FAKE_CURL_LOG"
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    http://* | https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "\${OPENCLAW_FAKE_CURL_FAIL_SUFFIX:-}" && "$url" == *"\${OPENCLAW_FAKE_CURL_FAIL_SUFFIX:-}" ]]; then
  if [[ -n "$output" ]]; then
    printf '%s' 'partial archive' > "$output"
  fi
  exit 28
fi
if [[ "$url" == */index.json ]]; then
  printf '%s\\n' '[{"version":"v24.15.0"}]'
elif [[ -n "$output" ]]; then
  : > "$output"
else
  printf '%s' 'archive'
fi
`,
  );
  chmodSync(curlPath, 0o755);
}

function runEnsureNode(root: string, requested: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const githubPath = join(root, "github-path");
  const pathOverride = extraEnv.PATH;
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -e",
        ...(pathOverride ? [`export PATH=${JSON.stringify(pathOverride)}`] : []),
        `source "${ensureNodeScript}"`,
        `openclaw_ensure_node "${requested}"`,
        "command -v node",
        "node -p 'process.versions.node'",
      ].join("; "),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_PATH: githubPath,
        ...extraEnv,
      },
    },
  );
  return result;
}

function runVersionMatch(actual: string, requested: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        `source "${ensureNodeScript}"`,
        `openclaw_node_version_matches "${actual}" "${requested}"`,
      ].join("; "),
    ],
    { encoding: "utf8", env: process.env },
  );
}

describe("setup-pnpm-store-cache ensure-node", () => {
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source "${ensureNodeScript}"`,
            `openclaw_find_toolcache_node "99.99.99"`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            RUNNER_TOOL_CACHE: join(root, "missing-toolcache"),
            AGENT_TOOLSDIRECTORY: join(root, "missing-agent-tools"),
            ACTIONS_RUNNER_TOOL_CACHE: join(root, "missing-actions-cache"),
            OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "missing-container-cache"),
          },
        },
      );
      missingToolcacheCase = {
        status: result.status,
        stderr: result.stderr,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a matching active node", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      const activeNode = writeFakeNode(activeBin, "24.15.0");
      const result = runEnsureNode(root, "24.15.0", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "missing-toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using active Node 24.15.0 at ${activeNode}`);
      expect(result.stdout.trim().endsWith("24.15.0")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs PATH from the toolcache when setup-node leaves an old node active", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const toolcacheBin = join(root, "toolcache", "node", "24.15.0", "x64", "bin");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.15.0");
      const result = runEnsureNode(root, "24.15.0", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 24.15.0 from ${toolcacheNode}`);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.15.0`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows toolcache paths for Git Bash before prepending PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "22.22.3");
      const toolcacheBin = join(root, "toolcache", "node", "24.15.0", "x64");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.15.0");
      const helperBin = join(root, "helpers");
      mkdirSync(helperBin, { recursive: true });
      const cygpath = join(helperBin, "cygpath");
      writeFileSync(
        cygpath,
        `#!/usr/bin/env bash
if [[ "$1" == "-u" ]]; then
  echo "${toolcacheBin}"
  exit 0
fi
if [[ "$1" == "-w" ]]; then
  echo "C:\\\\hostedtoolcache\\\\windows\\\\node\\\\24.15.0\\\\x64"
  exit 0
fi
exit 1
`,
      );
      chmodSync(cygpath, 0o755);
      const githubPath = join(root, "github-path");
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -e",
            `export PATH=${JSON.stringify(`${helperBin}:${activeBin}:${process.env.PATH ?? ""}`)}`,
            `export GITHUB_PATH=${JSON.stringify(githubPath)}`,
            `source "${ensureNodeScript}"`,
            `openclaw_prepend_node_bin "C:\\\\hostedtoolcache\\\\windows/node/24.15.0/x64"`,
            "command -v node",
            "node -p 'process.versions.node'",
            `cat "${githubPath}"`,
          ].join("; "),
        ],
        { encoding: "utf8", env: process.env },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.15.0`);
      expect(result.stdout).toContain("C:\\hostedtoolcache\\windows\\node\\24.15.0\\x64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs PATH from the container-mounted GitHub Actions toolcache", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const toolcacheBin = join(root, "__t", "node", "24.99.99", "x64", "bin");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.99.99");
      const result = runEnsureNode(root, "24.99.99", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "__t"),
        RUNNER_TOOL_CACHE: join(root, "hostedtoolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 24.99.99 from ${toolcacheNode}`);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.99.99`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts major wildcard requests when selecting a toolcache node", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const toolcacheBin = join(root, "toolcache", "node", "24.15.0", "x64", "bin");
      writeFakeNode(toolcacheBin, "24.15.0");
      const result = runEnsureNode(root, "24.x", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().endsWith("24.15.0")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the Node 22 wildcard at the supported minimum", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "22.18.0");
      const toolcacheBin = join(root, "toolcache", "node", "22.22.3", "x64", "bin");
      const toolcacheNode = writeFakeNode(toolcacheBin, "22.22.3");
      const result = runEnsureNode(root, "22.x", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 22.22.3 from ${toolcacheNode}`);
      expect(result.stdout.trim().endsWith("22.22.3")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Node 22 wildcard matches below the supported minimum", () => {
    expect(runVersionMatch("22.18.0", "22.x").status).toBe(1);
    expect(runVersionMatch("22.22.2", "22.x").status).toBe(1);
    expect(runVersionMatch("22.22.3", "22.x").status).toBe(0);
  });

  it("enforces patched Node 24 and 25 wildcard minimums", () => {
    expect(runVersionMatch("24.14.1", "24.x").status).toBe(1);
    expect(runVersionMatch("24.15.0", "24.x").status).toBe(0);
    expect(runVersionMatch("25.8.1", "25.x").status).toBe(1);
    expect(runVersionMatch("25.9.0", "25.x").status).toBe(0);
  });

  it("bounds every Node distribution request", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const helperBin = join(root, "bin");
      const curlLog = join(root, "curl.log");
      writeFakeCurl(helperBin);
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `export PATH=${JSON.stringify(`${helperBin}:${process.env.PATH ?? ""}`)}`,
            `export OPENCLAW_FAKE_CURL_LOG=${JSON.stringify(curlLog)}`,
            `source "${ensureNodeScript}"`,
            'openclaw_resolve_node_download_version "24.x"',
            "openclaw_prepend_node_bin() { :; }",
            'openclaw_node_download_platform() { printf "win-x64\\n"; }',
            "pwsh() { :; }",
            `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.15.0"`,
            'openclaw_node_download_platform() { printf "linux-x64\\n"; }',
            "tar() { :; }",
            `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.15.0"`,
          ].join("\n"),
        ],
        { encoding: "utf8", env: process.env },
      );

      expect(result.status, result.stderr).toBe(0);
      const curlCalls = readFileSync(curlLog, "utf8").trim().split("\n");
      expect(curlCalls).toHaveLength(3);
      for (const call of curlCalls) {
        expect(call).toContain(
          "-fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2",
        );
      }
      expect(curlCalls[0]).toContain("https://nodejs.org/dist/index.json");
      expect(curlCalls[1]).toContain("https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip");
      expect(curlCalls[2]).toContain(
        "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz",
      );
      expect(existsSync(join(root, "node-v24.15.0-linux-x64.tar.xz"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a partial POSIX archive after a timed-out download", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const helperBin = join(root, "bin");
      writeFakeCurl(helperBin);
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            `export PATH=${JSON.stringify(`${helperBin}:${process.env.PATH ?? ""}`)}`,
            `export OPENCLAW_FAKE_CURL_LOG=${JSON.stringify(join(root, "curl.log"))}`,
            `export OPENCLAW_FAKE_CURL_FAIL_SUFFIX=${JSON.stringify(".tar.xz")}`,
            `source "${ensureNodeScript}"`,
            "openclaw_prepend_node_bin() { :; }",
            'openclaw_node_download_platform() { printf "linux-x64\\n"; }',
            `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.15.0"`,
          ].join("\n"),
        ],
        { encoding: "utf8", env: process.env },
      );

      expect(result.status).toBe(1);
      expect(existsSync(join(root, "node-v24.15.0-linux-x64.tar.xz"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when no matching node is available", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const result = runEnsureNode(root, "99.99.99", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("::error::Expected Node '99.99.99'");
      expect(result.stdout).toContain("active node is '20.20.0'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles missing toolcache roots under nounset", () => {
    expect(missingToolcacheCase.status).toBe(1);
    expect(missingToolcacheCase.stderr).not.toContain("unbound variable");
  });
});
