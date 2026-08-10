import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectsHandlers } from "./projects.js";

const execFileAsync = promisify(execFile);

async function initializeRepository(root: string): Promise<string> {
  const repo = path.join(root, "registered");
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), "registered\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

async function invokeProjectMethod(
  method: keyof typeof projectsHandlers,
  params: Record<string, unknown>,
  cfg = {},
) {
  let result: {
    ok: boolean;
    payload?: unknown;
    error?: { code?: string; message?: string };
  } | null = null;
  await projectsHandlers[method]!({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: { getRuntimeConfig: () => cfg as OpenClawConfig } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return result;
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
