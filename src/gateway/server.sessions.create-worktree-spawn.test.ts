import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { chatHandlers } from "./server-methods/chat.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);
const parentKey = "agent:main:dashboard:project-parent";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let repository: string;
let storePath: string;
let parent: SessionEntry;

type CreatedWorktreeSession = {
  key: string;
  entry: SessionEntry;
  worktree: { id: string; path: string };
};

async function createRepository(name: string): Promise<string> {
  const root = path.join(state.root, name);
  await fs.mkdir(path.join(root, ".openclaw"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), `${name}\n`);
  await fs.writeFile(
    path.join(root, ".openclaw", "worktree-setup.sh"),
    "#!/bin/sh\ntouch setup-marker.txt\n",
    { mode: 0o755 },
  );
  await execFileAsync("git", ["init", "-b", "main", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initialize fixture",
  ]);
  return await fs.realpath(root);
}

function spawnClient(admin = false) {
  return {
    connect: { scopes: [admin ? "operator.admin" : "operator.write"] },
    internal: {
      syntheticClient: true as const,
      sessionCreation: {
        via: "spawn" as const,
        actor: { type: "agent" as const, id: "main" },
        requesterSessionKey: parentKey,
        inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] },
      },
    },
  };
}

async function createChild(params: Record<string, unknown> = {}, admin = false) {
  return await directSessionReq<CreatedWorktreeSession>(
    "sessions.create",
    {
      agentId: "main",
      label: "Project child",
      parentSessionKey: parentKey,
      spawnDepth: 1,
      worktree: true,
      ...params,
    },
    { client: spawnClient(admin) as never },
  );
}

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "openclaw-spawn-repo-" });
  const defaultWorkspace = path.join(state.root, "non-git-workspace");
  await fs.mkdir(defaultWorkspace);
  repository = await createRepository("selected-project");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace: defaultWorkspace };
  ({ storePath } = await createSessionStoreDir());
  const created = await directSessionReq<CreatedWorktreeSession>(
    "sessions.create",
    { key: parentKey, agentId: "main", worktree: true, worktreeName: "parent", cwd: repository },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  parent = created.payload!.entry;
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  await state?.cleanup();
});

test("trusted same-agent worktree spawns inherit the parent's selected project", async () => {
  const created = await createChild();
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry.worktree?.repoRoot).toBe(repository);
  expect(created.payload?.entry.parentSessionId).toBe(parent.sessionId);
  expect(created.payload?.worktree.id).not.toBe(parent.worktree?.id);
  const childPath = created.payload!.worktree.path;
  expect(await fs.readFile(path.join(childPath, "README.md"), "utf8")).toBe("selected-project\n");
  await expect(fs.stat(path.join(childPath, "setup-marker.txt"))).rejects.toThrow();
});

test("trusted visible spawns retain the inherited repository for deferred first-turn preparation", async () => {
  vi.spyOn(chatHandlers, "chat.send").mockImplementation(async ({ respond }) => {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "initial turn unavailable"));
  });
  const key = "agent:main:dashboard:pending-project-child";
  const created = await createChild({ key, task: "Read README.md" });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const child = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(child?.pendingWorktree?.workspace).toBe(repository);
  expect(child?.parentSessionId).toBe(parent.sessionId);
  expect(child?.worktree).toBeUndefined();
});

test.each(["cwd", "project", "cross-agent"] as const)(
  "trusted worktree spawns preserve %s source selection",
  async (selection) => {
    const otherRepository = await createRepository("other-project");
    let params: Record<string, unknown>;
    if (selection === "project") {
      const project = await registerProjectRegistry({ path: otherRepository });
      params = { projectId: project.id };
    } else if (selection === "cross-agent") {
      testState.agentsConfig = {
        list: [
          { id: "main", default: true },
          { id: "other", workspace: otherRepository },
        ],
      };
      const config = await getGatewayConfigModule();
      config.clearRuntimeConfigSnapshot();
      config.clearConfigCache();
      params = { agentId: "other" };
    } else {
      params = { cwd: otherRepository };
    }
    const created = await createChild(params, selection === "cwd");
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry.worktree?.repoRoot).toBe(otherRepository);
  },
);

test("parent linkage does not authorize an operator's out-of-workspace source", async () => {
  const linked = await directSessionReq(
    "sessions.create",
    { agentId: "main", label: "Operator child", parentSessionKey: parentKey, worktree: true },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );
  expect(linked).toMatchObject({
    ok: false,
    error: { message: "agent workspace is not a git checkout" },
  });
  const explicit = await createChild({ cwd: repository });
  expect(explicit).toMatchObject({
    ok: false,
    error: { message: "missing scope: operator.admin" },
  });
});

test("trusted worktree spawns reject a stale parent registry binding", async () => {
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: parentKey, storePath },
    { ...parent, worktree: { ...parent.worktree!, id: "another-worktree" } },
  );
  await expect(createChild()).rejects.toThrow("Spawn parent managed worktree changed");
});

test("trusted worktree spawns roll back when the parent changes during preparation", async () => {
  const createWorktree = managedWorktrees.create.bind(managedWorktrees);
  vi.spyOn(managedWorktrees, "create").mockImplementation(async (params) => {
    const created = await createWorktree(params);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parentKey, storePath },
      { ...parent, sessionId: "replaced-parent" },
    );
    return created;
  });
  const key = "agent:main:dashboard:retired-parent-child";
  await expect(createChild({ key })).rejects.toThrow("Spawn parent managed worktree changed");
  expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
});
