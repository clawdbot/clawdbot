import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, resolveStorePath, saveSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(async () => {}),
}));

const processMocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: processMocks.runCommandWithTimeout,
}));

import { agentsDeleteCommand } from "./agents.js";

const runtime = createTestRuntime();

async function arrangeAgentsDeleteTest(params: {
  stateDir: string;
  cfg: OpenClawConfig;
  deletedAgentId?: string;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
}) {
  const deletedAgentId = params.deletedAgentId ?? "ops";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: deletedAgentId });
  await saveSessionStore(storePath, params.sessions);
  await fs.mkdir(path.join(params.stateDir, `workspace-${deletedAgentId}`), { recursive: true });
  await fs.mkdir(path.join(params.stateDir, "agents", deletedAgentId, "agent"), {
    recursive: true,
  });

  configMocks.readConfigFileSnapshot.mockResolvedValue({
    ...baseConfigSnapshot,
    config: params.cfg,
    runtimeConfig: params.cfg,
    sourceConfig: params.cfg,
    resolved: params.cfg,
  });

  return storePath;
}

function expectSessionStore(
  storePath: string,
  sessions: Record<string, { sessionId: string; updatedAt: number }>,
) {
  expect(loadSessionStore(storePath, { skipCache: true })).toEqual(sessions);
}

describe("agents delete command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.replaceConfigFile.mockReset();
    processMocks.runCommandWithTimeout.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("purges deleted agent entries from the session store", async () => {
    await withStateDirEnv("openclaw-agents-delete-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      } satisfies OpenClawConfig;
      const storePath = await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        sessions: {
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
          "agent:ops:quietchat:direct:u1": { sessionId: "sess-ops-direct", updatedAt: now + 2 },
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 3 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          nextConfig: {
            agents: { list: [{ id: "main", workspace: path.join(stateDir, "workspace-main") }] },
          },
        }),
      );
      expectSessionStore(storePath, {
        "agent:main:main": { sessionId: "sess-main", updatedAt: now + 3 },
      });
    });
  });

  it("purges legacy main-alias entries owned by the deleted default agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-main-alias-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true, workspace: path.join(stateDir, "workspace-ops") }],
        },
      };
      const storePath = await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        sessions: {
          "agent:main:main": { sessionId: "sess-default-alias", updatedAt: now + 1 },
          "agent:ops:quietchat:direct:u1": { sessionId: "sess-ops-direct", updatedAt: now + 2 },
          "agent:main:quietchat:direct:u2": {
            sessionId: "sess-stale-main",
            updatedAt: now + 3,
          },
          global: { sessionId: "sess-global", updatedAt: now + 4 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expectSessionStore(storePath, {
        "agent:main:quietchat:direct:u2": {
          sessionId: "sess-stale-main",
          updatedAt: now + 3,
        },
        global: { sessionId: "sess-global", updatedAt: now + 4 },
      });
    });
  });

  it("preserves shared-store legacy default keys when deleting another agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-shared-store-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        session: { store: path.join(stateDir, "sessions.json") },
        agents: {
          list: [
            { id: "main", default: true, workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      const storePath = await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        sessions: {
          main: { sessionId: "sess-main", updatedAt: now + 1 },
          "quietchat:direct:u1": { sessionId: "sess-main-direct", updatedAt: now + 2 },
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 3 },
          "agent:ops:quietchat:direct:u2": { sessionId: "sess-ops-direct", updatedAt: now + 4 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expectSessionStore(storePath, {
        main: { sessionId: "sess-main", updatedAt: now + 1 },
        "quietchat:direct:u1": { sessionId: "sess-main-direct", updatedAt: now + 2 },
      });
    });
  });
});
