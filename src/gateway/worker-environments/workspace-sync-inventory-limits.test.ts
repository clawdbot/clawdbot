import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function gitWorkspace(name: string) {
  const root = tempDirs.make(`${name}-`);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
  await fs.writeFile(path.join(workspace, ".gitignore"), "");
  for (const args of [
    ["init", "--quiet"],
    ["add", ".gitignore"],
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@openclaw.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ],
  ]) {
    expect(
      await runCommandWithTimeout(["git", "-C", workspace, ...args], { timeoutMs: 10_000 }),
    ).toMatchObject({ code: 0 });
  }
  const baseCommit = (
    await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
      timeoutMs: 10_000,
    })
  ).stdout.trim();
  return { home, workspace, baseCommit };
}

it("rejects a full workspace above 4 GiB before hashing its files", async () => {
  const { home, workspace, baseCommit } = await gitWorkspace("openclaw-manifest-byte-budget");
  const oversizedPath = path.join(workspace, "oversized.bin");
  await fs.writeFile(oversizedPath, "");
  await fs.truncate(oversizedPath, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);

  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("eligible byte limit");
});

it("rejects prior manifests above the full-inventory entry limit", async () => {
  const { home, workspace, baseCommit } = await gitWorkspace("openclaw-manifest-entry-budget");
  const manifestRoot = path.join(home, ".openclaw-worker", "manifests");
  await fs.mkdir(manifestRoot, { recursive: true });
  const priorRaw = JSON.stringify({
    version: 1,
    baseCommit: null,
    entries: Array.from({ length: MAX_WORKSPACE_INVENTORY_ENTRIES + 1 }, () => null),
  });
  const priorDigest = createHash("sha256").update(priorRaw).digest("hex");
  await fs.writeFile(path.join(manifestRoot, `${priorDigest}.json`), priorRaw);

  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_MANIFEST_JS,
      workspace,
      baseCommit,
      "eligible",
      priorDigest,
    ],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("invalid prior workspace manifest");
});

it("budgets raw Git candidates separately from materialized eligible inventory", async () => {
  expect(MAX_WORKSPACE_GIT_CANDIDATES).toBe(4 * MAX_WORKSPACE_INVENTORY_ENTRIES);
  const { home, workspace, baseCommit } = await gitWorkspace("openclaw-raw-git-candidate-budget");
  const bin = path.join(home, "bin");
  const mockGit = path.join(bin, "git");
  await fs.mkdir(bin);
  await fs.writeFile(
    mockGit,
    `#!/usr/bin/env node
const count = Number(process.env.OPENCLAW_TEST_GIT_CANDIDATES);
process.stdout.write("missing\\0".repeat(count));
`,
    { mode: 0o755 },
  );
  const baseEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_INVENTORY_ENTRIES + 1),
  };

  const accepted = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
    { timeoutMs: 20_000, baseEnv },
  );
  expect(accepted.code, accepted.stderr).toBe(0);
  const manifestRef = accepted.stdout.trim();
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${manifestRef.slice(7)}.json`),
      "utf8",
    ),
  );
  expect(manifest.entries).toEqual([]);

  const rejected = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
    {
      timeoutMs: 20_000,
      baseEnv: {
        ...baseEnv,
        OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_GIT_CANDIDATES + 1),
      },
    },
  );
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("too many Git path candidates");
}, 30_000);
