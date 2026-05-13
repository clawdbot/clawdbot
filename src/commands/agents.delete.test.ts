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

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  isGatewayTransportError: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
  isGatewayTransportError: gatewayMocks.isGatewayTransportError,
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

function readJsonLogs(): Array<Record<string, unknown>> {
  return runtime.log.mock.calls
    .filter((call): call is [string, ...unknown[]] => {
      const arg = call[0];
      return typeof arg === "string" && arg.startsWith("{");
    })
    .map((call) => JSON.parse(call[0]) as Record<string, unknown>);
}

describe("agents delete command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.replaceConfigFile.mockReset();
    processMocks.runCommandWithTimeout.mockClear();
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockRejectedValue(
      Object.assign(new Error("closed"), { name: "GatewayTransportError" }),
    );
    gatewayMocks.isGatewayTransportError.mockReset();
    gatewayMocks.isGatewayTransportError.mockImplementation(
      (error: unknown) => error instanceof Error && error.name === "GatewayTransportError",
    );
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("routes deletion through the Gateway when reachable", async () => {
    await withStateDirEnv("openclaw-agents-delete-gateway-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      } satisfies OpenClawConfig;
      const sessions = {
        "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
        "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
      };
      const storePath = await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "ops",
        sessions,
      });
      gatewayMocks.callGateway.mockResolvedValue({
        ok: true,
        agentId: "ops",
        removedBindings: 0,
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
      const gatewayCall = gatewayMocks.callGateway.mock.calls[0]?.[0];
      expect(gatewayCall?.method).toBe("agents.delete");
      expect(gatewayCall?.params).toEqual({ agentId: "ops", deleteFiles: true });
      expect(gatewayCall?.requiredMethods).toEqual(["agents.delete"]);
      expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
      expectSessionStore(storePath, sessions);
      const output = readJsonLogs()[0];
      expect(output?.agentId).toBe("ops");
      expect(output?.removedBindings).toBe(0);
      expect(output?.transport).toBe("gateway");
    });
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
      expect(configMocks.replaceConfigFile).toHaveBeenCalledOnce();
      const replaceConfigFileCalls = configMocks.replaceConfigFile.mock.calls as unknown as Array<
        [{ nextConfig: OpenClawConfig }]
      >;
      expect(replaceConfigFileCalls[0]?.[0].nextConfig).toEqual({
        agents: { list: [{ id: "main", workspace: path.join(stateDir, "workspace-main") }] },
      });
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

  it("skips workspace removal when another agent shares the same workspace (#70890)", async () => {
    await withStateDirEnv("openclaw-agents-delete-shared-workspace-", async ({ stateDir }) => {
      const sharedWorkspace = path.join(stateDir, "workspace-shared");
      await fs.mkdir(sharedWorkspace, { recursive: true });

      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: sharedWorkspace },
            { id: "ops", workspace: sharedWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "ops",
        sessions: {
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      // Workspace should still exist — it was shared
      const retainedWorkspaceStats = await fs.stat(sharedWorkspace);
      expect(retainedWorkspaceStats.isDirectory()).toBe(true);

      // The JSON output should report why the workspace was retained.
      const jsonOutput = readJsonLogs();
      expect(jsonOutput).toHaveLength(1);
      expect(jsonOutput[0]?.workspaceRetained).toBe(true);
      expect(jsonOutput[0]?.workspaceRetainedReason).toBe("shared");
      expect(jsonOutput[0]?.workspaceSharedWith).toEqual(["main"]);
      expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalledWith(
        ["trash", sharedWorkspace],
        { timeoutMs: 5000 },
      );
    });
  });

  it("skips workspace removal when another agent workspace overlaps a child path (#70890)", async () => {
    await withStateDirEnv("openclaw-agents-delete-overlapping-workspace-", async ({ stateDir }) => {
      const sharedWorkspace = path.join(stateDir, "workspace-shared");
      const childWorkspace = path.join(sharedWorkspace, "ops-child");
      await fs.mkdir(childWorkspace, { recursive: true });

      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: sharedWorkspace },
            { id: "ops", workspace: childWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "ops",
        sessions: {
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      const output = readJsonLogs()[0];
      expect(output?.workspaceRetained).toBe(true);
      expect(output?.workspaceSharedWith).toEqual(["main"]);
      expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalledWith(
        ["trash", childWorkspace],
        { timeoutMs: 5000 },
      );
    });
  });

  it("skips workspace removal when deleting a parent workspace that contains another agent workspace (#70890)", async () => {
    await withStateDirEnv("openclaw-agents-delete-parent-workspace-", async ({ stateDir }) => {
      const sharedWorkspace = path.join(stateDir, "workspace-shared");
      const childWorkspace = path.join(sharedWorkspace, "main-child");
      await fs.mkdir(childWorkspace, { recursive: true });

      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: childWorkspace },
            { id: "ops", workspace: sharedWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "ops",
        sessions: {
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      const output = readJsonLogs()[0];
      expect(output?.workspaceRetained).toBe(true);
      expect(output?.workspaceSharedWith).toEqual(["main"]);
      expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalledWith(
        ["trash", sharedWorkspace],
        { timeoutMs: 5000 },
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "skips workspace removal when another agent reaches the same directory through a symlink (#70890)",
    async () => {
      await withStateDirEnv("openclaw-agents-delete-symlink-workspace-", async ({ stateDir }) => {
        const realWorkspace = path.join(stateDir, "workspace-real");
        const aliasWorkspace = path.join(stateDir, "workspace-alias");
        await fs.mkdir(realWorkspace, { recursive: true });
        await fs.symlink(realWorkspace, aliasWorkspace, "dir");

        const now = Date.now();
        const cfg: OpenClawConfig = {
          agents: {
            list: [
              { id: "main", workspace: realWorkspace },
              { id: "ops", workspace: aliasWorkspace },
            ],
          },
        } satisfies OpenClawConfig;
        await arrangeAgentsDeleteTest({
          stateDir,
          cfg,
          deletedAgentId: "ops",
          sessions: {
            "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
            "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
          },
        });

        await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

        const output = readJsonLogs()[0];
        expect(output?.workspaceRetained).toBe(true);
        expect(output?.workspaceSharedWith).toEqual(["main"]);
        expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalledWith(
          ["trash", aliasWorkspace],
          { timeoutMs: 5000 },
        );
      });
    },
  );

  it("trashes workspace when no other agent shares it", async () => {
    await withStateDirEnv("openclaw-agents-delete-unique-workspace-", async ({ stateDir }) => {
      const opsWorkspace = path.join(stateDir, "workspace-ops");
      const mainWorkspace = path.join(stateDir, "workspace-main");
      await fs.mkdir(opsWorkspace, { recursive: true });
      await fs.mkdir(mainWorkspace, { recursive: true });

      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace },
            { id: "ops", workspace: opsWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "ops",
        sessions: {
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      // trash command should have been called for the workspace
      expect(processMocks.runCommandWithTimeout).toHaveBeenCalledWith(["trash", opsWorkspace], {
        timeoutMs: 5000,
      });
    });
  });
});
