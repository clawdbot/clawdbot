import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createNodeWorkerRepositoryPreparation } from "./node-worker-repository-preparation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("prepares and reuses an exact repository commit without a Gateway workspace", async () => {
  const root = await fs.realpath(tempDirs.make("node-repository-preparation-"));
  const origin = path.join(root, "origin");
  const home = path.join(root, "node-home");
  const gitConfig = path.join(root, "empty.gitconfig");
  await fs.mkdir(origin);
  await fs.writeFile(gitConfig, "");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 10_000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(origin, "init", "--quiet");
  const originalBranch = await git(origin, "symbolic-ref", "--short", "HEAD");
  await fs.writeFile(path.join(origin, "tracked.txt"), "pinned contents\n");
  await git(origin, "add", ".");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "pinned",
  );
  const commit = await git(origin, "rev-parse", "HEAD");
  await fs.writeFile(path.join(origin, "tracked.txt"), "later contents\n");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "--quiet",
    "-am",
    "later",
  );
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(home, "state", "node-host"),
    env: { PATH: process.env.PATH, HOME: home },
  });
  const identity = {
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    generation: 1,
  };
  const repository = createNodeWorkerRepositoryPreparation((command) =>
    runtime.exec({ ...identity, ...command, argv: [...command.argv] }),
  );
  const source = { origin: pathToFileURL(origin).href, commit };

  const prepared = await repository.prepareRepository(source);

  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") {
    throw new Error(prepared.reason);
  }
  const { remoteWorkspaceDir, manifestRef } = prepared.result;
  expect(prepared.seeded).toBe(false);
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
  expect(await fs.readFile(path.join(remoteWorkspaceDir, "tracked.txt"), "utf8")).toBe(
    "pinned contents\n",
  );
  await fs.writeFile(path.join(remoteWorkspaceDir, "session-only.txt"), "discard on replacement");

  const offlineOrigin = `${origin}-offline`;
  await fs.rename(origin, offlineOrigin);
  try {
    const reused = await repository.prepareRepository(source, manifestRef);

    expect(reused).toEqual({ ...prepared, seeded: true });
    expect((await fs.readdir(remoteWorkspaceDir)).toSorted()).toEqual([".git", "tracked.txt"]);
    expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
    expect(await repository.captureManifest(remoteWorkspaceDir, commit, manifestRef)).toBe(
      manifestRef,
    );
  } finally {
    await fs.rename(offlineOrigin, origin);
  }

  // A provider can retain an exact commit after a force push removes its advertised ref.
  await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(origin, "checkout", "--orphan", "replacement");
  await git(origin, "rm", "--cached", "tracked.txt");
  await fs.writeFile(path.join(origin, "tracked.txt"), "rewritten history\n");
  await git(origin, "add", ".");
  await git(
    origin,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "replace history",
  );
  await git(origin, "update-ref", "-d", `refs/heads/${originalBranch}`);
  const replacement = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "replacement-node"),
    env: { PATH: process.env.PATH, HOME: path.join(root, "replacement-home") },
  });
  const replacementCommands: string[][] = [];
  const restored = await createNodeWorkerRepositoryPreparation((command) => {
    replacementCommands.push([...command.argv]);
    return replacement.exec({ ...identity, ...command, argv: [...command.argv] });
  }).prepareRepository(source, manifestRef);
  expect(restored.kind).toBe("prepared");
  if (restored.kind !== "prepared") {
    throw new Error(restored.reason);
  }
  expect(restored.seeded).toBe(false);
  expect(await git(restored.result.remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(commit);
  expect(replacementCommands).toContainEqual(
    expect.arrayContaining(["fetch", "--no-tags", "origin", commit]),
  );
});
