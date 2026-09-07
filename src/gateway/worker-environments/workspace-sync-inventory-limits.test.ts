import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { workspaceStatIdentity } from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("drains remote manifest handles after a real file mutation without publishing or masking the error", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-remote-manifest-drain-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const auditPath = path.join(root, "audit.json");
  await Promise.all([fs.mkdir(workspace), fs.mkdir(home)]);
  const files = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`);
  await Promise.all(files.map((file) => fs.writeFile(path.join(workspace, file), "inside")));
  // Keep real descriptors and reads; gate their scheduling so mutation and
  // cleanup overlap deterministically, including a later close failure.
  const prelude = String.raw`{
    const io = require("node:fs");
    const workspace = ${JSON.stringify(workspace)};
    const opened = [];
    let releaseClosed;
    const firstClosed = new Promise((resolve) => { releaseClosed = resolve; });
    const originalOpen = io.promises.open.bind(io.promises);
    io.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!String(args[0]).startsWith(workspace + require("node:path").sep)) return handle;
      const identity = io.fstatSync(handle.fd);
      const record = { path: args[0], fd: handle.fd, identity, handle };
      opened.push(record);
      const first = opened.length === 1;
      const originalStat = handle.stat.bind(handle);
      const originalClose = handle.close.bind(handle);
      let stats = 0;
      handle.stat = async (...options) => {
        if (!first) await firstClosed;
        if (first && ++stats === 2) io.appendFileSync(record.path, "changed");
        return await originalStat(...options);
      };
      handle.close = async () => {
        await originalClose();
        if (first) {
          releaseClosed();
          throw new Error("later close failure");
        }
      };
      return handle;
    };
    process.once("beforeExit", () => {
      const handles = opened.map(({ path, fd, identity, handle }) => {
        let closed = false;
        try {
          const current = io.fstatSync(fd);
          closed = current.dev !== identity.dev || current.ino !== identity.ino;
        } catch (error) { closed = error.code === "EBADF"; }
        closed &&= handle.fd === -1;
        return { path, closed };
      });
      io.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify(handles));
    });
  }
  `;
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", prelude + REMOTE_WORKSPACE_MANIFEST_JS, workspace],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
  );
  expect(result.stderr).not.toContain("Unhandled 'error' event");
  const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as Array<{
    path: string;
    closed: boolean;
  }>;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("worker workspace file changed while it was being read");
  expect(result.stderr).not.toContain("later close failure");
  expect(result.stdout).toBe("");
  expect(audit).toHaveLength(4);
  expect(audit).toEqual(audit.map((entry) => ({ ...entry, closed: true })));
  expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
  expect(await fs.readFile(audit[0]!.path, "utf8")).toBe("insidechanged");
});

it.each([
  { growth: "before open", memo: false },
  { growth: "before open", memo: true },
  { growth: "during read", memo: false },
])("bounds remote file growth $growth with sibling memo=$memo", async ({ growth, memo }) => {
  const root = await fs.realpath(tempDirs.make("openclaw-remote-manifest-growth-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await Promise.all([fs.mkdir(workspace), fs.mkdir(home)]);
  const target = path.join(workspace, "first");
  const sibling = path.join(workspace, "other");
  const contents = Buffer.alloc(8, 65);
  await Promise.all([fs.writeFile(target, contents), fs.writeFile(sibling, contents)]);
  await fs.symlink("first", path.join(workspace, "link"));
  const cached = memo
    ? [
        [
          workspaceStatIdentity("worker", await fs.stat(sibling, { bigint: true })),
          createHash("sha256").update(contents).digest("hex"),
        ],
      ]
    : [];
  // Inventory sees 21 bytes including the symlink. Change real file bytes only
  // after that inventory, or keep growing during reads so EOF cannot enforce the cap.
  const prelude = String.raw`{
    const io = require("node:fs");
    const target = ${JSON.stringify(target)};
    const open = io.promises.open.bind(io.promises);
    io.promises.open = async (...args) => {
      if (args[0] === target && ${JSON.stringify(growth)} === "before open") {
        io.appendFileSync(target, "grow");
      }
      const handle = await open(...args);
      if (args[0] === target && ${JSON.stringify(growth)} === "during read") {
        let reads = 0;
        const read = handle.read.bind(handle);
        handle.read = async (...args) => {
          if (++reads <= 24) io.appendFileSync(target, "x");
          return await read(...args);
        };
        const stream = handle.createReadStream.bind(handle);
        handle.createReadStream = (options) => stream({ ...options, highWaterMark: 1 });
      }
      return handle;
    };
  }
  `;
  const script = REMOTE_WORKSPACE_MANIFEST_JS.replace(
    `const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES};`,
    "const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = 24;",
  );
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", prelude + script, workspace, "", "all", "memo-v1"],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home }, input: JSON.stringify(cached) },
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(
    growth === "before open" ? "eligible byte limit" : "file changed while it was being read",
  );
  expect(result.stdout).toBe("");
  expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
  if (growth === "during read") {
    expect((await fs.stat(target)).size).toBeLessThan(contents.length + 24);
  }
});

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
