import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectsHandlers } from "./projects.js";

const execFileAsync = promisify(execFile);

async function initializeRepository(root: string): Promise<string> {
  const repo = path.join(root, "registered");
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/openclaw/openclaw.git",
  ]);
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

    for (const scope of ["operator.write", "operator.admin"]) {
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
    }
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
    const actor = { type: "human" as const, id: sourceProfile.id };
    const entries: Array<{
      key: string;
      updatedAt: number;
      projectId?: string;
      spawnedCwd?: string;
    }> = [
      { key: "agent:main:a", updatedAt: 500, projectId: project.id },
      { key: "agent:main:b", updatedAt: 500, projectId: project.id },
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
        },
      );
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:other" },
      {
        sessionId: "session-other",
        updatedAt: 1_000,
        createdActor: { type: "human", id: "profile-bob" },
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
      { kind: "folder", folder: "/work/scratch", displayName: "scratch" },
      ...Array.from({ length: 6 }, (_, index) => ({
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
