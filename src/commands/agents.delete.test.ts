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
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      } satisfies OpenClawConfig;
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "ops" });
      await saveSessionStore(storePath, {
        "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: 1 },
        "agent:ops:discord:direct:u1": { sessionId: "sess-ops-direct", updatedAt: 2 },
        "agent:main:main": { sessionId: "sess-main", updatedAt: 3 },
      });
      await fs.mkdir(path.join(stateDir, "workspace-ops"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "agents", "ops", "agent"), { recursive: true });

      configMocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: cfg,
        runtimeConfig: cfg,
        sourceConfig: cfg,
        resolved: cfg,
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
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
        "agent:main:main": { sessionId: "sess-main", updatedAt: 3 },
      });
    });
  });

  it("purges legacy main-alias entries owned by the deleted default agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-main-alias-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true, workspace: path.join(stateDir, "workspace-ops") }],
        },
      };
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "ops" });
      await saveSessionStore(storePath, {
        "agent:main:main": { sessionId: "sess-default-alias", updatedAt: 1 },
        "agent:ops:discord:direct:u1": { sessionId: "sess-ops-direct", updatedAt: 2 },
        "agent:main:discord:direct:u2": { sessionId: "sess-stale-main", updatedAt: 3 },
        global: { sessionId: "sess-global", updatedAt: 4 },
      });
      await fs.mkdir(path.join(stateDir, "workspace-ops"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "agents", "ops", "agent"), { recursive: true });

      configMocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: cfg,
        runtimeConfig: cfg,
        sourceConfig: cfg,
        resolved: cfg,
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
        "agent:main:discord:direct:u2": { sessionId: "sess-stale-main", updatedAt: 3 },
        global: { sessionId: "sess-global", updatedAt: 4 },
      });
    });
  });

  it("preserves shared-store legacy default keys when deleting another agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-shared-store-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        session: { store: path.join(stateDir, "sessions.json") },
        agents: {
          list: [
            { id: "main", default: true, workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "ops" });
      await saveSessionStore(storePath, {
        main: { sessionId: "sess-main", updatedAt: 1 },
        "discord:direct:u1": { sessionId: "sess-main-direct", updatedAt: 2 },
        "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: 3 },
        "agent:ops:discord:direct:u2": { sessionId: "sess-ops-direct", updatedAt: 4 },
      });
      await fs.mkdir(path.join(stateDir, "workspace-ops"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "agents", "ops", "agent"), { recursive: true });

      configMocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: cfg,
        runtimeConfig: cfg,
        sourceConfig: cfg,
        resolved: cfg,
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
        main: { sessionId: "sess-main", updatedAt: 1 },
        "discord:direct:u1": { sessionId: "sess-main-direct", updatedAt: 2 },
      });
    });
  });
});
