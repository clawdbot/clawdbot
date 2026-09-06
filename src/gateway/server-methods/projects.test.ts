import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, test, vi } from "vitest";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import {
  registerClonedProjectRegistry,
  registerProjectRegistry,
} from "../../projects/project-registry.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createProjectsHandlers } from "./projects.js";

const execFileAsync = promisify(execFile);
const listRegistryRecords = vi.fn(() => []);
const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
  checkoutRoot: checkoutPath,
  repoRoot: checkoutPath,
  originUrl: "",
  fingerprint: checkoutPath,
}));
const projectsHandlers = createProjectsHandlers({
  listRegistryRecords,
  resolveRepositoryIdentity,
} as never);

beforeEach(() => {
  listRegistryRecords.mockClear();
  resolveRepositoryIdentity.mockClear();
});

async function initializeRepository(
  root: string,
  name = "registered",
  originUrl = "https://github.com/openclaw/openclaw.git",
): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await execFileAsync("git", ["-C", repo, "remote", "add", "origin", originUrl]);
  await fs.writeFile(path.join(repo, "README.md"), "registered\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

async function invokeProjectMethod(
  method: keyof typeof projectsHandlers,
  params: Record<string, unknown>,
  cfg = {},
  scopes: string[] = ["operator.write"],
  profileId?: string,
) {
  const capture: {
    result: {
      ok: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string };
    } | null;
  } = { result: null };
  await projectsHandlers[method]!({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      capture.result = { ok, payload, error };
    },
    context: { getRuntimeConfig: () => cfg as OpenClawConfig } as never,
    client: {
      connect: { scopes },
      ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
    } as never,
    isWebchatConnect: () => false,
  });
  return capture.result;
}

test("projects.list merges synthesized workspaces with stored rows deterministically", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const repo = await initializeRepository(state.root);
    await registerProjectRegistry({ path: repo, name: "Beta" });
    const result = await invokeProjectMethod(
      "projects.list",
      {},
      {
        agents: {
          list: [{ id: "main", default: true, workspace: "/workspace/alpha" }],
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      payload: {
        projects: [
          { id: "workspace:main", displayName: "alpha", source: "workspace" },
          { id: "beta", displayName: "Beta", source: "registered" },
        ],
      },
    });
  } finally {
    await state.cleanup();
  }
});

test("projects.list exposes checkout details only at write scope", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const repo = await initializeRepository(state.root);
    await registerProjectRegistry({ path: repo, name: "Registered" });
    const cfg = {
      agents: {
        list: [{ id: "main", default: true, workspace: "/workspace/alpha" }],
      },
    };

    const readResult = await invokeProjectMethod("projects.list", {}, cfg, ["operator.read"]);
    if (!readResult) {
      throw new Error("projects.list did not respond");
    }
    const readProjects = (readResult.payload as { projects: Record<string, unknown>[] }).projects;
    expect(readProjects).toEqual([
      { id: "workspace:main", displayName: "alpha", source: "workspace", agentId: "main" },
      { id: "registered", displayName: "Registered", source: "registered" },
    ]);
    for (const project of readProjects) {
      expect(project).not.toHaveProperty("repoRoot");
      expect(project).not.toHaveProperty("originUrl");
    }
    expect(readResult.payload).not.toHaveProperty("observedProjects");
    expect(listRegistryRecords).not.toHaveBeenCalled();
    expect(resolveRepositoryIdentity).not.toHaveBeenCalled();

    const readOptIn = await invokeProjectMethod("projects.list", { includeObserved: true }, cfg, [
      "operator.read",
    ]);
    expect(readOptIn?.payload).not.toHaveProperty("observedProjects");
    expect(listRegistryRecords).not.toHaveBeenCalled();

    for (const scope of ["operator.write", "operator.admin"]) {
      const callsBeforeDefaultList = listRegistryRecords.mock.calls.length;
      const writeResult = await invokeProjectMethod("projects.list", {}, cfg, [scope]);
      expect(writeResult).toMatchObject({
        ok: true,
        payload: {
          projects: [
            { id: "workspace:main", repoRoot: "/workspace/alpha" },
            {
              id: "registered",
              repoRoot: repo,
              originUrl: "https://github.com/openclaw/openclaw.git",
            },
          ],
        },
      });
      expect(writeResult?.payload).not.toHaveProperty("observedProjects");
      expect(listRegistryRecords).toHaveBeenCalledTimes(callsBeforeDefaultList);

      const observedResult = await invokeProjectMethod(
        "projects.list",
        { includeObserved: true },
        cfg,
        [scope],
      );
      expect(observedResult).toMatchObject({
        ok: true,
        payload: { observedProjects: [] },
      });
    }
    expect(listRegistryRecords).toHaveBeenCalledTimes(2);
  } finally {
    await state.cleanup();
  }
});

test("project responses redact credentials and URL suffixes from registered origins", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const repo = await initializeRepository(state.root);
    await execFileAsync("git", [
      "-C",
      repo,
      "remote",
      "set-url",
      "origin",
      ["https://user", ":placeholder", "@host/private.git?visible=value#branch"].join(""),
    ]);

    const registered = await invokeProjectMethod(
      "projects.register",
      { path: repo, name: "Private" },
      {},
      ["operator.admin"],
    );
    expect(registered).toMatchObject({
      ok: true,
      payload: { originUrl: "https://host/private.git" },
    });

    const listed = await invokeProjectMethod("projects.list", {}, {}, ["operator.write"]);
    expect(listed).toMatchObject({
      ok: true,
      payload: {
        projects: expect.arrayContaining([
          expect.objectContaining({ id: "workspace:main" }),
          expect.objectContaining({ id: "private", originUrl: "https://host/private.git" }),
        ]),
      },
    });
  } finally {
    await state.cleanup();
  }
});

test("projects.remove returns INVALID_REQUEST for an unknown id", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    expect(await invokeProjectMethod("projects.remove", { id: "missing" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "unknown project id: missing" },
    });
  } finally {
    await state.cleanup();
  }
});

test("projects.list returns only the caller's deterministic resolved recents", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const repo = await initializeRepository(state.root);
    const project = await registerProjectRegistry({ path: repo, name: "Registered" });
    const sourceProfile = ensureProfileForEmail("source@example.test");
    const targetProfile = ensureProfileForEmail("target@example.test");
    const actor = { type: "human" as const, source: "profile" as const, id: sourceProfile.id };
    const repository = getSessionRepositoryWorkspaceStore().create({
      agentId: "main",
      sessionKey: "agent:main:cloud",
      url: "https://github.com/octocat/hello-world.git",
      assertCurrent: () => {},
    });
    const entries: Array<{
      key: string;
      updatedAt: number;
      projectId?: string;
      spawnedCwd?: string;
      repositoryWorkspaceId?: string;
    }> = [
      { key: "agent:main:a", updatedAt: 500, projectId: project.id },
      { key: "agent:main:b", updatedAt: 500, projectId: project.id },
      { key: "agent:main:cloud", updatedAt: 450, repositoryWorkspaceId: repository.workspaceId },
      { key: "agent:main:c", updatedAt: 400, projectId: "stale", spawnedCwd: "/work/scratch" },
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `agent:main:folder-${index}`,
        updatedAt: 300 - index,
        spawnedCwd: `/work/folder-${index}`,
      })),
    ];
    for (const entry of entries) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: entry.key },
        {
          sessionId: `session-${entry.key.split(":").at(-1)}`,
          updatedAt: entry.updatedAt,
          createdActor: actor,
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          ...(entry.spawnedCwd ? { spawnedCwd: entry.spawnedCwd } : {}),
          ...(entry.repositoryWorkspaceId
            ? { repositoryWorkspaceId: entry.repositoryWorkspaceId }
            : {}),
        },
      );
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:other" },
      {
        sessionId: "session-other",
        updatedAt: 1_000,
        createdActor: { type: "human", source: "profile", id: "profile-bob" },
        spawnedCwd: "/work/private-bob",
      },
    );
    const cfg = { agents: { list: [{ id: "main", default: true, workspace: "/workspace" }] } };
    linkEmail("source@example.test", targetProfile.id);
    const readResult = await invokeProjectMethod(
      "projects.list",
      {},
      cfg,
      ["operator.read"],
      targetProfile.id,
    );
    if (!readResult?.payload) {
      throw new Error("projects.list did not return recents");
    }
    expect((readResult.payload as { recents?: unknown[] }).recents).toEqual([
      { kind: "project", projectId: project.id, displayName: "Registered" },
    ]);
    const writeResult = await invokeProjectMethod(
      "projects.list",
      {},
      cfg,
      ["operator.write"],
      targetProfile.id,
    );
    expect((writeResult?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual([
      { kind: "project", projectId: project.id, displayName: "Registered" },
      { kind: "repository", url: repository.url, displayName: "hello-world" },
      { kind: "folder", folder: "/work/scratch", displayName: "scratch" },
      ...Array.from({ length: 5 }, (_, index) => ({
        kind: "folder",
        folder: `/work/folder-${index}`,
        displayName: `folder-${index}`,
      })),
    ]);
    const anonymous = await invokeProjectMethod("projects.list", {}, cfg, ["operator.read"]);
    expect(anonymous?.payload).not.toHaveProperty("recents");
  } finally {
    await state.cleanup();
  }
});

test("projects.add returns an existing project for the same canonical remote", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const repo = await initializeRepository(
      state.root,
      "existing",
      "git@github.com:OpenClaw/OpenClaw.git",
    );
    const existing = await registerProjectRegistry({ path: repo, name: "Existing" });

    expect(
      await invokeProjectMethod("projects.add", {
        gitUrl: "https://github.com/openclaw/openclaw.git",
      }),
    ).toEqual({ ok: true, payload: existing, error: undefined });
  } finally {
    await state.cleanup();
  }
});

test("projects.add returns a typed invalid-url failure", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    expect(
      await invokeProjectMethod("projects.add", { gitUrl: "file:///tmp/repo.git" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { code: "PROJECT_CLONE_FAILED", cause: "invalid_url" },
      },
    });
  } finally {
    await state.cleanup();
  }
});

test("projects.remove refuses to delete a cloned checkout referenced by a live worktree", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const originUrl = "https://github.com/acme/managed.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "managed",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Managed",
      originUrl,
    });
    insertRegistryWorktree(
      process.env,
      {
        id: "live-worktree",
        name: "live-worktree",
        repoFingerprint: fingerprint,
        repoRoot: repo,
        path: path.join(state.stateDir, "worktrees", fingerprint, "live-worktree"),
        branch: "openclaw/live-worktree",
        baseRef: "main",
        ownerKind: "session",
        ownerId: "agent:main:session",
        createdAt: 1,
        lastActiveAt: 1,
      },
      { provisionedPaths: [] },
    );

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("live-worktree") },
    });
    await expect(fs.stat(repo)).resolves.toBeDefined();
  } finally {
    await state.cleanup();
  }
});

test("projects.remove deletes an unreferenced Gateway-managed clone", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const originUrl = "https://github.com/acme/removable.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "removable",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Removable",
      originUrl,
    });

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }),
    ).toMatchObject({ ok: true, payload: { removed: true } });
    await expect(fs.stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await state.cleanup();
  }
});

test("projects.remove preserves a cloned checkout while a duplicate registry row remains", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const originUrl = "https://github.com/acme/shared-managed.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "shared-managed",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Shared managed",
      originUrl,
    });
    const now = Date.now();
    openOpenClawStateDatabase()
      .db.prepare(
        `INSERT INTO projects
          (id, display_name, repo_root, origin_url, source, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("shared-managed-copy", "Shared managed copy", repo, null, "registered", now, now);

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }),
    ).toMatchObject({ ok: true, payload: { removed: true } });
    await expect(fs.stat(repo)).resolves.toBeDefined();

    const listed = await invokeProjectMethod("projects.list", {}, {}, ["operator.write"]);
    const survivor = (
      listed?.payload as { projects?: Array<Record<string, unknown>> } | undefined
    )?.projects?.find((candidate) => candidate.id === "shared-managed-copy");
    expect(survivor).toMatchObject({
      id: "shared-managed-copy",
      repoRoot: repo,
      originUrl,
      source: "cloned",
    });

    expect(
      await invokeProjectMethod("projects.remove", {
        id: "shared-managed-copy",
        deleteCheckout: true,
      }),
    ).toMatchObject({ ok: true, payload: { removed: true } });
    await expect(fs.stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await state.cleanup();
  }
});

test("projects.remove refuses to delete a cloned checkout configured as an agent workspace", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const originUrl = "https://github.com/acme/workspace-project.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "workspace-project",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Workspace project",
      originUrl,
    });
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: repo }] },
    } as OpenClawConfig;

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }, cfg),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("agent workspace") },
    });
    await expect(fs.stat(repo)).resolves.toBeDefined();
  } finally {
    await state.cleanup();
  }
});

test("projects.remove refuses to delete a cloned checkout used by a live direct session", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const originUrl = "https://github.com/acme/session-project.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "session-project",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Session project",
      originUrl,
    });
    await upsertSessionEntryCore(
      { agentId: "main", env: state.env, sessionKey: "agent:main:project-session" },
      { sessionId: "project-session", spawnedCwd: repo, updatedAt: 1 },
    );
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: state.workspaceDir }] },
    } as OpenClawConfig;

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }, cfg),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("project-session") },
    });
  } finally {
    await state.cleanup();
  }
});

test.each([
  ["POSIX", "/Users/dev/projects/posix-project", "posix-project"],
  ["POSIX with a trailing separator", "/Users/dev/projects/posix-project/", "posix-project"],
  ["Windows", "C:\\Users\\dev\\projects\\windows-project", "windows-project"],
  [
    "Windows with a trailing separator",
    "C:\\Users\\dev\\projects\\windows-project\\",
    "windows-project",
  ],
  ["mixed separators", "C:\\Users/dev\\projects/mixed-project/", "mixed-project"],
] as const)("projects.list names folder recents from %s paths", async (_, folder, displayName) => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const profile = ensureProfileForEmail("windows-recents@example.test");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:windows" },
      {
        sessionId: "session-windows",
        updatedAt: 900,
        createdActor: { type: "human", source: "profile", id: profile.id },
        spawnedCwd: folder,
      },
    );
    const result = await invokeProjectMethod(
      "projects.list",
      {},
      { agents: { list: [{ id: "main", default: true, workspace: "/workspace" }] } },
      ["operator.write"],
      profile.id,
    );
    expect((result?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual([
      {
        kind: "folder",
        folder,
        displayName,
      },
    ]);
  } finally {
    await state.cleanup();
  }
});
