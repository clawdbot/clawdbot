import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ensureNodeScript = resolve(".github/actions/setup-pnpm-store-cache/ensure-node.sh");

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

function runEnsureNode(root: string, requested: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const githubPath = join(root, "github-path");
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -e",
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

describe("setup-pnpm-store-cache ensure-node", () => {
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
});
