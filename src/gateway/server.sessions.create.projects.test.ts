import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

async function initializeRepository(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

test("sessions.create starts directly in a synthesized workspace project", async () => {
  const root = tempDirs.make("openclaw-session-workspace-project-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();

  const created = await directSessionReq<{ entry?: { spawnedCwd?: string } }>(
    "sessions.create",
    { agentId: "main", projectId: "workspace:main" },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.spawnedCwd).toBe(workspace);
});

test("sessions.create starts directly in an outside registered project at write scope", async () => {
  const root = tempDirs.make("openclaw-session-direct-project-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });

  const created = await directSessionReq<{
    key?: string;
    entry?: { projectId?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", projectId: project.id },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.spawnedCwd).toBe(projectRoot);
  expect(created.payload?.entry?.projectId).toBe(project.id);
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: created.payload?.key ?? "",
      storePath,
    })?.projectId,
  ).toBe(project.id);
});

test("sessions.create provisions a managed worktree from a registered project at write scope", async () => {
  const root = tempDirs.make("openclaw-session-registered-project-");
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      entry?: { spawnedCwd?: string };
      worktree?: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", projectId: project.id, worktree: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );

    expect(created.ok).toBe(true);
    worktreeId = created.payload?.worktree?.id;
    expect(created.payload?.entry?.spawnedCwd).toBe(created.payload?.worktree?.path);
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
  }
});

test("sessions.create rejects projectId combined with raw placement params", async () => {
  for (const params of [
    { projectId: "workspace:main", cwd: "/tmp/repo" },
    { projectId: "workspace:main", execNode: "macbook" },
  ]) {
    const created = await directSessionReq("sessions.create", params);
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create projectId cannot be combined with cwd or execNode",
      },
    });
  }
});

test("sessions.create returns a typed error for an unknown project", async () => {
  const created = await directSessionReq("sessions.create", { projectId: "missing" });
  expect(created).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unknown project id: missing" },
  });
});

test("sessions.create reports a stale registered project as unavailable with repair guidance", async () => {
  const root = tempDirs.make("openclaw-session-stale-project-");
  const repo = await initializeRepository(root, "project");
  const project = await registerProjectRegistry({ path: repo });
  await fs.rm(repo, { recursive: true, force: true });

  const created = await directSessionReq("sessions.create", { projectId: project.id });
  expect(created.ok).toBe(false);
  expect(created.error?.code).toBe("UNAVAILABLE");
  expect(created.error?.message).toContain("re-register it or run openclaw doctor --fix");
});

test("sessions.create rejects an outside project for a sandboxed agent", async () => {
  const root = tempDirs.make("openclaw-session-sandbox-project-");
  const workspace = await initializeRepository(root, "workspace");
  const outside = await initializeRepository(root, "outside");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: outside });

  for (const worktree of [false, true]) {
    const created = await directSessionReq("sessions.create", {
      projectId: project.id,
      ...(worktree ? { worktree: true } : {}),
    });
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create project is outside the sandboxed agent workspace",
      },
    });
  }
});
