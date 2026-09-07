import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

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
}));

const workspaceStateMocks = vi.hoisted(() => ({
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
}));

const terminalMocks = vi.hoisted(() => ({
  isTerminalInteractive: vi.fn(() => true),
}));
const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await configMocks.readConfigFileSnapshot(),
    writeOptions: {},
  }),
  replaceConfigFile: configMocks.replaceConfigFile,
}));

vi.mock("../gateway/call.js", async () => ({
  ...(await vi.importActual<typeof import("../gateway/transport-error.js")>(
    "../gateway/transport-error.js",
  )),
  callGateway: gatewayMocks.callGateway,
  isGatewayCredentialsRequiredError: gatewayMocks.isGatewayCredentialsRequiredError,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
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

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: terminalMocks.isTerminalInteractive,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

import { agentsDeleteCommand } from "./agents.commands.delete.js";
import {
  createAgentsDeleteFixture,
  gatewayTransportError,
  readAgentDeleteJsonLogs,
} from "./agents.delete.test-helpers.js";

const runtime = createTestRuntime();

const arrangeAgentsDeleteTest = createAgentsDeleteFixture((cfg) => {
  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));
});
const readJsonLogs = () => readAgentDeleteJsonLogs(runtime.log.mock.calls);

function expectSessionStore(
  cfg: OpenClawConfig,
  sessions: Record<string, { sessionId: string; updatedAt: number }>,
  agentId = "ops",
) {
  const agentIds = new Set([
    agentId,
    ...Object.keys(sessions).flatMap((sessionKey) => {
      const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
      return parsedAgentId ? [parsedAgentId] : [];
    }),
  ]);
  expect(
    Object.fromEntries(
      [...agentIds].flatMap((storeAgentId) =>
        listSessionEntriesCore({
          agentId: storeAgentId,
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: storeAgentId }),
        }).map(({ entry, sessionKey }) => [sessionKey, entry]),
      ),
    ),
  ).toEqual(
    Object.fromEntries(
      Object.entries(sessions).map(([sessionKey, entry]) => [
        sessionKey,
        { ...entry, delivery: { kind: "none" } },
      ]),
    ),
  );
}

describe("agents delete workspace lifecycle", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.replaceConfigFile.mockReset();
    fsSafeMocks.movePathToTrash.mockClear();
    workspaceStateMocks.deleteWorkspaceState.mockClear();
    processMocks.runCommandWithTimeout.mockClear();
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockRejectedValue(gatewayTransportError("closed"));
    gatewayMocks.isGatewayCredentialsRequiredError.mockReset();
    gatewayMocks.isGatewayCredentialsRequiredError.mockImplementation(
      (error: unknown) =>
        error instanceof Error && error.name === "GatewayCredentialsRequiredError",
    );
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    terminalMocks.isTerminalInteractive.mockReset().mockReturnValue(true);
    wizardMocks.createClackPrompter.mockReset();
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

  it("refuses deleting the sole configured agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-main-alias-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true, workspace: path.join(stateDir, "workspace-ops") }],
        },
      };
      await arrangeAgentsDeleteTest({
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

      expect(runtime.error).not.toHaveBeenCalled();
      expect(readJsonLogs()).toEqual([
        {
          ok: false,
          error: {
            type: "cli_error",
            message: 'Agent "ops" is the only configured agent and cannot be deleted.',
          },
        },
      ]);
      expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
      expectSessionStore(cfg, {
        "agent:main:main": { sessionId: "sess-default-alias", updatedAt: now + 1 },
        "agent:ops:quietchat:direct:u1": { sessionId: "sess-ops-direct", updatedAt: now + 2 },
        "agent:main:quietchat:direct:u2": {
          sessionId: "sess-stale-main",
          updatedAt: now + 3,
        },
        global: { sessionId: "sess-global", updatedAt: now + 4 },
      });
    });
  });

  it("preserves canonical main-agent keys when deleting another agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-shared-store-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        session: { store: path.join(stateDir, "shared-sessions.sqlite") },
        agents: {
          list: [
            { id: "main", default: true, workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        sessions: {
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 1 },
          "agent:main:quietchat:direct:u1": {
            sessionId: "sess-main-direct",
            updatedAt: now + 2,
          },
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 3 },
          "agent:ops:quietchat:direct:u2": { sessionId: "sess-ops-direct", updatedAt: now + 4 },
        },
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expectSessionStore(
        cfg,
        {
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 1 },
          "agent:main:quietchat:direct:u1": {
            sessionId: "sess-main-direct",
            updatedAt: now + 2,
          },
        },
        "main",
      );
    });
  });

  it.each([
    ["another agent shares the same workspace", "", ""],
    ["another agent workspace overlaps a child path", "", "ops-child"],
    ["deleting a parent workspace that contains another agent workspace", "main-child", ""],
  ])("skips workspace removal when %s (#70890)", async (_relationship, mainPath, opsPath) => {
    await withStateDirEnv("openclaw-agents-delete-shared-workspace-", async ({ stateDir }) => {
      const sharedWorkspace = path.join(stateDir, "workspace-shared");
      const mainWorkspace = path.join(sharedWorkspace, mainPath);
      const opsWorkspace = path.join(sharedWorkspace, opsPath);
      await fs.mkdir(mainWorkspace, { recursive: true });
      await fs.mkdir(opsWorkspace, { recursive: true });

      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace },
            { id: "ops", workspace: opsWorkspace },
          ],
        },
      };
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

      const retainedWorkspaceStats = await fs.stat(opsWorkspace);
      expect(retainedWorkspaceStats.isDirectory()).toBe(true);
      const jsonOutput = readJsonLogs();
      expect(jsonOutput).toHaveLength(1);
      expect(jsonOutput[0]?.workspaceRetained).toBe(true);
      expect(jsonOutput[0]?.workspaceRetainedReason).toBe("shared");
      expect(jsonOutput[0]?.workspaceSharedWith).toEqual(["main"]);
      const trashedPaths = fsSafeMocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
      expect(trashedPaths).not.toContain(opsWorkspace);
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
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
      const opsAgentDir = path.join(stateDir, "agents", "ops", "agent");
      const opsSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
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
      expect(readJsonLogs()[0]).toMatchObject({
        removed: [
          { path: opsAgentDir, method: "trash" },
          { path: opsSessionsDir, method: "missing" },
        ],
        failed: [{ path: opsWorkspace, reason: "trash unavailable" }],
      });
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
    });
  });
});
