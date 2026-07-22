// Agents delete tests cover config removal, workspace-state cleanup, and binding updates.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveStorePath } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionEntries, replaceSessionEntry } from "../config/sessions/session-accessor.js";
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

const fsSafeMocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  isGatewayCredentialsRequiredError: vi.fn(),
  isGatewayTransportError: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
  isGatewayCredentialsRequiredError: gatewayMocks.isGatewayCredentialsRequiredError,
  isGatewayTransportError: gatewayMocks.isGatewayTransportError,
}));

vi.mock("../infra/fs-safe.js", () => ({
  movePathToTrash: fsSafeMocks.movePathToTrash,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: processMocks.runCommandWithTimeout,
}));

vi.mock("../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-state-store.js")>(
    "../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: workspaceStateMocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: workspaceStateMocks.prepareWorkspaceStateDeletion,
}));

import { agentsDeleteCommand } from "./agents.commands.delete.js";

const runtime = createTestRuntime();

function resolveFixtureStoreAgentId(cfg: OpenClawConfig, deletedAgentId: string): string {
  const storeConfig = cfg.session?.store;
  if (typeof storeConfig === "string" && !storeConfig.includes("{agentId}")) {
    return resolveDefaultAgentId(cfg);
  }
  return deletedAgentId;
}

function canonicalizeAgentEntriesForTest(cfg: OpenClawConfig): OpenClawConfig {
  const list = (cfg.agents as { list?: Array<Record<string, unknown>> } | undefined)?.list;
  if (!Array.isArray(list)) {
    return cfg;
  }
  const { list: _list, ...agents } = cfg.agents as NonNullable<OpenClawConfig["agents"]> & {
    list?: unknown;
  };
  return {
    ...cfg,
    agents: {
      ...agents,
      entries: Object.fromEntries(
        list.flatMap((entry) => {
          const id = typeof entry.id === "string" ? entry.id : "";
          if (!id) {
            return [];
          }
          const { id: _id, ...value } = entry;
          return [[id, value]];
        }),
      ),
    },
  };
}

async function arrangeAgentsDeleteTest(params: {
  stateDir: string;
  cfg: OpenClawConfig;
  deletedAgentId?: string;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
}) {
  const cfg = canonicalizeAgentEntriesForTest(params.cfg);
  const deletedAgentId = params.deletedAgentId ?? "ops";
  const storeAgentId = resolveFixtureStoreAgentId(cfg, deletedAgentId);
  const storePath = resolveStorePath(cfg.session?.store, { agentId: deletedAgentId });
  for (const [sessionKey, entry] of Object.entries(params.sessions)) {
    await replaceSessionEntry(
      { agentId: storeAgentId, sessionKey, storePath },
      entry as SessionEntry,
    );
  }
  await fs.mkdir(path.join(params.stateDir, `workspace-${deletedAgentId}`), { recursive: true });
  await fs.mkdir(path.join(params.stateDir, "agents", deletedAgentId, "agent"), {
    recursive: true,
  });

  configMocks.readConfigFileSnapshot.mockResolvedValue({
    ...baseConfigSnapshot,
    config: cfg,
    runtimeConfig: cfg,
    sourceConfig: cfg,
    resolved: cfg,
  });

  return storePath;
}

function expectSessionStore(
  storePath: string,
  sessions: Record<string, { sessionId: string; updatedAt: number }>,
  agentId = "ops",
) {
  expect(
    Object.fromEntries(
      listSessionEntries({ agentId, storePath }).map(({ entry, sessionKey }) => [
        sessionKey,
        entry,
      ]),
    ),
  ).toEqual(sessions);
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
    fsSafeMocks.movePathToTrash.mockClear();
    workspaceStateMocks.deleteWorkspaceState.mockClear();
    processMocks.runCommandWithTimeout.mockClear();
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockRejectedValue(
      Object.assign(new Error("closed"), { name: "GatewayTransportError" }),
    );
    gatewayMocks.isGatewayCredentialsRequiredError.mockReset();
    gatewayMocks.isGatewayCredentialsRequiredError.mockImplementation(
      (error: unknown) =>
        error instanceof Error && error.name === "GatewayCredentialsRequiredError",
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
        removed: [{ path: path.join(stateDir, "agents", "ops", "agent"), method: "trash" }],
        failed: [{ path: path.join(stateDir, "workspace-ops"), reason: "trash unavailable" }],
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
      expect(output?.removed).toEqual([
        { path: path.join(stateDir, "agents", "ops", "agent"), method: "trash" },
      ]);
      expect(output?.failed).toEqual([
        { path: path.join(stateDir, "workspace-ops"), reason: "trash unavailable" },
      ]);
      expect(output?.transport).toBe("gateway");
    });
  });

  it("warns about Gateway cleanup failures without failing committed deletion", async () => {
    await withStateDirEnv("openclaw-agents-delete-gateway-warning-", async ({ stateDir }) => {
      const workspace = path.join(stateDir, "workspace-ops");
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main" }, { id: "ops", workspace }] },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions: {} });
      gatewayMocks.callGateway.mockResolvedValue({
        ok: true,
        agentId: "ops",
        removedBindings: 0,
        removed: [],
        failed: [{ path: workspace, reason: "trash unavailable" }],
      });

      await agentsDeleteCommand({ id: "ops", force: true }, runtime);

      expect(runtime.log).toHaveBeenCalledWith("Deleted agent: ops");
      expect(runtime.error).toHaveBeenCalledWith(
        `Warning: path could not be moved to Trash: trash unavailable; remove it manually at ${workspace}`,
      );
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("falls back to local deletion when the optional Gateway probe needs credentials", async () => {
    await withStateDirEnv("openclaw-agents-delete-gateway-auth-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-shared") },
            { id: "ops", workspace: path.join(stateDir, "workspace-shared") },
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
      gatewayMocks.callGateway.mockRejectedValue(
        Object.assign(
          new Error("gateway agents.delete requires credentials before opening a websocket"),
          {
            name: "GatewayCredentialsRequiredError",
            method: "agents.delete",
            configPath: path.join(stateDir, "openclaw.json"),
          },
        ),
      );

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
      expect(configMocks.replaceConfigFile).toHaveBeenCalledOnce();
      const output = readJsonLogs()[0];
      expect(output?.agentId).toBe("ops");
      expect(output?.workspaceRetained).toBe(true);
      expect(output?.workspaceRetainedReason).toBe("shared");
      expect(output?.transport).toBeUndefined();
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
        agents: {
          defaults: undefined,
          entries: { main: { workspace: path.join(stateDir, "workspace-main") } },
        },
        bindings: undefined,
        tools: undefined,
      });
      expectSessionStore(storePath, {
        "agent:main:main": { sessionId: "sess-main", updatedAt: now + 3 },
      });
    });
  });

  it("deletes workspace state after local workspace removal", async () => {
    await withStateDirEnv("openclaw-agents-delete-workspace-state-", async ({ stateDir }) => {
      const opsWorkspace = path.join(stateDir, "workspace-ops");
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: opsWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "ops",
        sessions: {},
      });
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(workspaceStateMocks.deleteWorkspaceState).toHaveBeenCalledWith({
        workspaceDir: opsWorkspace,
      });
      const workspaceTrashOrder = fsSafeMocks.movePathToTrash.mock.invocationCallOrder[0];
      const stateDeleteOrder = workspaceStateMocks.deleteWorkspaceState.mock.invocationCallOrder[0];
      expect(workspaceTrashOrder).toBeLessThan(stateDeleteOrder ?? 0);
    });
  });

  it("finishes agent-directory cleanup when workspace state deletion fails", async () => {
    await withStateDirEnv("openclaw-agents-delete-state-failure-", async ({ stateDir }) => {
      const opsWorkspace = path.join(stateDir, "workspace-ops");
      const opsAgentDir = path.join(stateDir, "agents", "ops", "agent");
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: opsWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({ stateDir, cfg, deletedAgentId: "ops", sessions: {} });
      workspaceStateMocks.deleteWorkspaceState.mockImplementationOnce(() => {
        throw new Error("state database unavailable");
      });

      await expect(
        agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime),
      ).rejects.toThrow("state database unavailable");

      const trashedPaths = fsSafeMocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
      const expectedAgentDir = path.join(
        await fs.realpath(path.dirname(opsAgentDir)),
        path.basename(opsAgentDir),
      );
      expect(trashedPaths).toContain(expectedAgentDir);
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
      expectSessionStore(
        storePath,
        {
          main: { sessionId: "sess-main", updatedAt: now + 1 },
          "quietchat:direct:u1": { sessionId: "sess-main-direct", updatedAt: now + 2 },
        },
        "main",
      );
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
      const trashedPaths = fsSafeMocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
      expect(trashedPaths).not.toContain(sharedWorkspace);
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
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
      const trashedPaths = fsSafeMocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
      expect(trashedPaths).not.toContain(childWorkspace);
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
      const trashedPaths = fsSafeMocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
      expect(trashedPaths).not.toContain(sharedWorkspace);
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
        const trashedPaths = fsSafeMocks.movePathToTrash.mock.calls.map(
          ([targetPath]) => targetPath,
        );
        expect(trashedPaths).not.toContain(aliasWorkspace);
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

      const expectedOpsWorkspace = path.join(
        await fs.realpath(path.dirname(opsWorkspace)),
        path.basename(opsWorkspace),
      );

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(expectedOpsWorkspace, {
        allowedRoots: [path.dirname(expectedOpsWorkspace)],
      });
      expect(workspaceStateMocks.deleteWorkspaceState).toHaveBeenCalledWith({
        workspaceDir: opsWorkspace,
      });
      expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    });
  });

  it("retains workspace state when workspace trash fails", async () => {
    await withStateDirEnv("openclaw-agents-delete-trash-failure-", async ({ stateDir }) => {
      const opsWorkspace = path.join(stateDir, "workspace-ops");
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: opsWorkspace },
          ],
        },
      } satisfies OpenClawConfig;
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions: {} });
      fsSafeMocks.movePathToTrash.mockRejectedValueOnce(new Error("trash unavailable"));

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
    });
  });
});
