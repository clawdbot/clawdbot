// Agents delete tests cover config removal, workspace-state cleanup, and binding updates.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAgentEntries,
  toAgentEntriesRecord,
  tryResolveSoleAgentId,
} from "../agents/agent-scope-config.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { loadCronStore, resolveCronJobsStorePath, saveCronStore } from "../cron/store.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { readExecApprovalsSnapshot, saveExecApprovals } from "../infra/exec-approvals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { readAgentProvenance, recordAgentProvenance } from "../state/agent-provenance.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  baseConfigSnapshot,
  createTestConfigSnapshot,
  createTestRuntime,
} from "./test-runtime-config-helpers.js";

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

const runtime = createTestRuntime();
const sharedAuthStore = {
  version: 1,
  profiles: {
    "test-provider:shared": { type: "api_key", provider: "test-provider", key: "test-shared-key" },
  },
};

function gatewayTransportError(kind: "closed" | "timeout", code?: number): GatewayTransportError {
  return new GatewayTransportError({
    kind,
    code,
    message: `gateway ${kind}`,
    connectionDetails: { url: "ws://127.0.0.1:1", urlSource: "test", message: "test gateway" },
  });
}

function resolveFixtureStoreAgentId(cfg: OpenClawConfig, deletedAgentId: string): string {
  const storeConfig = cfg.session?.store;
  if (typeof storeConfig === "string" && !storeConfig.includes("{agentId}")) {
    return (
      tryGetLegacyDefaultAgentId(cfg) ??
      listAgentEntries(cfg).find((entry) => entry.default === true)?.id ??
      tryResolveSoleAgentId(cfg) ??
      deletedAgentId
    );
  }
  return deletedAgentId;
}

async function arrangeAgentsDeleteTest(params: {
  stateDir: string;
  cfg: OpenClawConfig;
  deletedAgentId?: string;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
}) {
  const deletedAgentId = params.deletedAgentId ?? "ops";
  const authored = structuredClone(params.cfg);
  const roster = listAgentEntries(authored);
  if (!roster.some((entry) => entry.default === true)) {
    const existingDefault = roster.find((entry) => entry.id !== deletedAgentId);
    if (existingDefault) {
      existingDefault.default = true;
    } else {
      roster.unshift({ id: "main", default: true });
    }
  }
  const { list: _legacyList, ...agents } = authored.agents ?? {};
  const cfg: OpenClawConfig = {
    ...authored,
    agents: { ...agents, entries: toAgentEntriesRecord(roster) },
  };
  const storeAgentId = resolveFixtureStoreAgentId(cfg, deletedAgentId);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: deletedAgentId });
  for (const [sessionKey, entry] of Object.entries(params.sessions)) {
    const entryAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? storeAgentId;
    const entryStorePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: entryAgentId,
    });
    await replaceSessionEntry({ agentId: entryAgentId, sessionKey, storePath: entryStorePath }, {
      ...entry,
      delivery: { kind: "none" },
    } as SessionEntry);
  }
  await fs.mkdir(path.join(params.stateDir, `workspace-${deletedAgentId}`), { recursive: true });
  await fs.mkdir(path.join(params.stateDir, "agents", deletedAgentId, "agent"), {
    recursive: true,
  });

  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));

  return storePath;
}

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
    fsSafeMocks.movePathToTrash
      .mockReset()
      .mockImplementation(async (targetPath: string) => `${targetPath}.trashed`);
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

  it("requires --force when confirmation cannot use an interactive terminal", async () => {
    await withStateDirEnv("openclaw-agents-delete-non-tty-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true, workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, deletedAgentId: "ops", sessions: {} });
      terminalMocks.isTerminalInteractive.mockReturnValue(false);

      await agentsDeleteCommand({ id: "ops" }, runtime);

      expect(runtime.error).toHaveBeenCalledWith("Non-interactive session. Re-run with --force.");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(wizardMocks.createClackPrompter).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalled();
    });
  });

  it("refuses deleting main even when another agent is default", async () => {
    await withStateDirEnv("openclaw-agents-delete-gateway-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", default: true, workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      } satisfies OpenClawConfig;
      const sessions = {
        "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
        "agent:main:main": { sessionId: "sess-main", updatedAt: now + 2 },
      };
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "main",
        sessions,
      });
      writePersistedAuthProfileStoreRaw(sharedAuthStore, path.join(stateDir, "agents/main/agent"));
      await agentsDeleteCommand({ id: "main", force: true, json: true }, runtime);

      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(readJsonLogs()).toEqual([
        {
          ok: false,
          error: {
            type: "cli_error",
            message:
              'Agent "main" owns the legacy shared auth store and cannot be deleted. Run openclaw doctor --fix to migrate shared auth, then retry.',
          },
        },
      ]);
      expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
      expectSessionStore(cfg, sessions, "main");
      expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedAuthStore);
    });
  });

  it("deletes main normally after shared auth ownership moves to state SQLite", async () => {
    await withStateDirEnv("openclaw-agents-delete-relocated-auth-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", default: true, workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw(sharedAuthStore);
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        deletedAgentId: "main",
        sessions: {
          "agent:main:main": { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });
      saveExecApprovals({
        version: 1,
        agents: {
          "*": { security: "deny" },
          main: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/old" }] },
          ops: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/keep" }] },
        },
      });
      fsSafeMocks.movePathToTrash.mockImplementation(async (targetPath: string) => {
        const trashPath = `${targetPath}.trashed`;
        await fs.rename(targetPath, trashPath);
        return trashPath;
      });

      await agentsDeleteCommand({ id: "main", force: true, json: true }, runtime);

      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalledWith(1);
      expect(configMocks.replaceConfigFile).toHaveBeenCalledOnce();
      await expect(fs.access(path.join(stateDir, "agents/main/agent"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedAuthStore);
      expectSessionStore(cfg, {}, "main");
      expect(readExecApprovalsSnapshot().file.agents).toEqual({
        "*": { security: "deny" },
        ops: {
          security: "allowlist",
          allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
        },
      });
    });
  });

  it("rejects an unrepresentable id before targeting or deleting an agent", async () => {
    await withStateDirEnv("openclaw-agents-delete-invalid-id-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "second", default: true, workspace: path.join(stateDir, "workspace-second") },
          ],
        },
      };
      const sessions = {
        "agent:main:main": { sessionId: "sess-main", updatedAt: Date.now() },
      };
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      await arrangeAgentsDeleteTest({ stateDir, cfg, deletedAgentId: "main", sessions });

      await agentsDeleteCommand({ id: "агент✨", force: true }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalled();
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
      expectSessionStore(cfg, sessions, "main");
    });
  });

  it("refuses deleting the auth-inheritance owner until credentials are relocated", async () => {
    await withStateDirEnv("openclaw-agents-delete-auth-owner-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { authInheritance: { agentId: "ops" } },
          list: [{ id: "ops" }, { id: "research" }],
        },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, deletedAgentId: "ops", sessions: {} });

      await agentsDeleteCommand({ id: "ops", force: true }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        'Agent "ops" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.',
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalled();
    });
  });

  it("refuses deleting the retained inherited-auth owner", async () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
      "ops",
    );
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));

    await agentsDeleteCommand({ id: "ops", force: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      'Agent "ops" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
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
        purgeFailed: true,
      });

      await agentsDeleteCommand({ id: "ops", force: true }, runtime);

      expect(runtime.log).toHaveBeenCalledWith("Deleted agent: ops");
      expect(runtime.error).toHaveBeenCalledWith(
        `Warning: path could not be moved to Trash: trash unavailable; remove it manually at ${workspace}`,
      );
      expect(runtime.error).toHaveBeenCalledWith(
        'Warning: session-store purge failed for deleted agent "ops"; stale shared-store rows may remain.',
      );
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("includes purge failure in delegated JSON output", async () => {
    await withStateDirEnv("openclaw-agents-delete-gateway-purge-json-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main" }, { id: "ops" }] },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions: {} });
      gatewayMocks.callGateway.mockResolvedValue({
        ok: true,
        agentId: "ops",
        removedBindings: 0,
        removed: [],
        failed: [],
        purgeFailed: true,
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(readJsonLogs()[0]).toMatchObject({ purgeFailed: true, transport: "gateway" });
    });
  });

  it.each([
    { label: "request timeout after dispatch", error: gatewayTransportError("timeout") },
    { label: "established WebSocket close", error: gatewayTransportError("closed", 1006) },
    { label: "authentication rejection", error: new Error("unauthorized") },
    {
      label: "malformed transport failure",
      error: Object.assign(new Error("malformed transport failure"), {
        name: "GatewayTransportError",
        kind: "closed",
      }),
    },
  ])("surfaces $label without replaying deletion locally", async ({ error }) => {
    await withStateDirEnv("openclaw-agents-delete-ambiguous-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = { agents: { list: [{ id: "main" }, { id: "ops" }] } };
      const sessions = { "agent:ops:main": { sessionId: "sess-ops", updatedAt: Date.now() } };
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions });
      gatewayMocks.callGateway.mockRejectedValue(error);

      await expect(agentsDeleteCommand({ id: "ops", force: true }, runtime)).rejects.toBe(error);

      expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalled();
      expectSessionStore(cfg, sessions);
    });
  });

  it("falls back to local deletion when the optional Gateway probe needs credentials", async () => {
    await withStateDirEnv("openclaw-agents-delete-gateway-auth-", async ({ stateDir }) => {
      const now = Date.now();
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
          },
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-shared") },
            { id: "ops", workspace: path.join(stateDir, "workspace-shared") },
          ],
        },
        talk: { agentId: "ops", provider: "test-provider" },
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
      const storePath = resolveCronJobsStorePath();
      await saveCronStore(storePath, {
        version: 1,
        jobs: [
          makeCronJob({
            id: "credentials-job",
            name: "credentials-job",
            agentId: "ops",
            payload: { kind: "agentTurn", message: "keep until the Gateway owns cleanup" },
          }),
        ],
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
      expect(output).not.toHaveProperty("purgeFailed");
      expect(output?.cronCleanupSkipped).toBe(true);
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "credentials-job",
      ]);
      expect(runtime.error).toHaveBeenCalledWith(
        'Warning: cron cleanup was skipped for deleted agent "ops" because the Gateway could not be authenticated; scheduled jobs may remain.',
      );
      expect(output?.clearedOwnerRefs).toEqual([
        "agents.defaults.heartbeat.agentId",
        "agents.defaults.systemAgent.agentId",
        "talk.agentId",
      ]);
      const replaceConfigFileCalls = configMocks.replaceConfigFile.mock.calls as unknown as Array<
        [{ nextConfig: OpenClawConfig }]
      >;
      expect(replaceConfigFileCalls[0]?.[0].nextConfig.agents?.defaults?.heartbeat).toBeUndefined();
      expect(
        replaceConfigFileCalls[0]?.[0].nextConfig.agents?.defaults?.systemAgent,
      ).toBeUndefined();
      expect(replaceConfigFileCalls[0]?.[0].nextConfig.talk).toEqual({
        provider: "test-provider",
      });
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
      await arrangeAgentsDeleteTest({
        stateDir,
        cfg,
        sessions: {
          "agent:ops:main": { sessionId: "sess-ops-main", updatedAt: now + 1 },
          "agent:ops:quietchat:direct:u1": { sessionId: "sess-ops-direct", updatedAt: now + 2 },
          "agent:main:main": { sessionId: "sess-main", updatedAt: now + 3 },
        },
      });
      expect(readExecApprovalsSnapshot().exists).toBe(false);

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).toHaveBeenCalledOnce();
      const replaceConfigFileCalls = configMocks.replaceConfigFile.mock.calls as unknown as Array<
        [{ nextConfig: OpenClawConfig }]
      >;
      expect(replaceConfigFileCalls[0]?.[0].nextConfig).toEqual({
        agents: {
          defaults: undefined,
          entries: {
            main: { default: true, workspace: path.join(stateDir, "workspace-main") },
          },
        },
        bindings: undefined,
        tools: undefined,
      });
      expectSessionStore(cfg, {
        "agent:main:main": { sessionId: "sess-main", updatedAt: now + 3 },
      });
      expect(readExecApprovalsSnapshot().exists).toBe(false);
    });
  });

  it("removes only the deleted agent's cron jobs during offline deletion", async () => {
    await withStateDirEnv("openclaw-agents-delete-cron-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions: {} });
      const jobs = [
        makeCronJob({ id: "removed-job", name: "removed-job", agentId: "ops" }),
        makeCronJob({ id: "survivor-job", name: "survivor-job", agentId: "main" }),
        makeCronJob({
          id: "heartbeat-main",
          agentId: "main",
          declarationKey: "heartbeat:main",
          payload: { kind: "heartbeat" },
        }),
        makeCronJob({
          id: "memory-dreaming",
          declarationKey: "memory-core:memory-dreaming-promotion",
        }),
      ];
      const storePath = resolveCronJobsStorePath();
      await saveCronStore(storePath, { version: 1, jobs });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "survivor-job",
        "heartbeat-main",
        "memory-dreaming",
      ]);
    });
  });

  it("deregisters the agent database after offline deletion", async () => {
    await withStateDirEnv("openclaw-agents-delete-registry-", async ({ tempRoot, stateDir }) => {
      const mainAgentDir = path.join(tempRoot, "main-agent");
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            {
              id: "main",
              agentDir: mainAgentDir,
              workspace: path.join(stateDir, "workspace-main"),
            },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions: {} });
      const databasePath = path.join(stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite");
      const externalDatabaseDir = path.join(tempRoot, "external-databases");
      await fs.mkdir(externalDatabaseDir);
      await fs.mkdir(mainAgentDir);
      const externalDatabasePath = path.join(externalDatabaseDir, "ops.sqlite");
      const sharedDatabasePath = path.join(externalDatabaseDir, "shared.sqlite");
      const survivorOwnedDatabasePath = path.join(mainAgentDir, "ops.sqlite");
      const externalDatabasePaths = [
        externalDatabasePath,
        `${externalDatabasePath}-wal`,
        `${externalDatabasePath}-shm`,
        `${externalDatabasePath}-journal`,
      ];
      await Promise.all(
        [...externalDatabasePaths, sharedDatabasePath, survivorOwnedDatabasePath].map(
          (sqlitePath) => fs.writeFile(sqlitePath, ""),
        ),
      );
      const canonicalExternalDatabaseDir = await fs.realpath(externalDatabaseDir);
      const canonicalMainAgentDir = await fs.realpath(mainAgentDir);
      registerOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
      registerOpenClawAgentDatabase({ agentId: "ops", path: externalDatabasePath });
      registerOpenClawAgentDatabase({ agentId: "ops", path: sharedDatabasePath });
      registerOpenClawAgentDatabase({ agentId: "ops", path: survivorOwnedDatabasePath });
      registerOpenClawAgentDatabase({ agentId: "main", path: sharedDatabasePath });
      recordAgentProvenance("ops", { createdVia: "operator" });
      recordAgentProvenance("child", { createdVia: "agent", creatorAgentId: "ops" });
      expect(listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId)).toContain("ops");

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      for (const sqlitePath of externalDatabasePaths) {
        expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(
          path.join(canonicalExternalDatabaseDir, path.basename(sqlitePath)),
          { allowedRoots: [canonicalExternalDatabaseDir] },
        );
      }
      expect(readJsonLogs()[0]?.removed).toEqual(
        expect.arrayContaining(
          externalDatabasePaths.map((sqlitePath) => ({ path: sqlitePath, method: "trash" })),
        ),
      );
      expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalledWith(
        path.join(canonicalExternalDatabaseDir, path.basename(sharedDatabasePath)),
        expect.anything(),
      );
      expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalledWith(
        path.join(canonicalMainAgentDir, path.basename(survivorOwnedDatabasePath)),
        expect.anything(),
      );
      expect((await fs.stat(survivorOwnedDatabasePath)).isFile()).toBe(true);
      const registeredDatabases = listOpenClawRegisteredAgentDatabases();
      expect(registeredDatabases.map((entry) => entry.agentId)).not.toContain("ops");
      expect(registeredDatabases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: "main", path: sharedDatabasePath }),
        ]),
      );
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(true);
      expect(readAgentProvenance("ops")).toBeUndefined();
      expect(readAgentProvenance("child")).toMatchObject({ creatorAgentId: "ops" });
    });
  });

  it("resumes offline deletion after cleanup was interrupted", async () => {
    await withStateDirEnv("openclaw-agents-delete-recovery-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: path.join(stateDir, "workspace-main") },
            { id: "ops", workspace: path.join(stateDir, "workspace-ops") },
          ],
        },
      };
      await arrangeAgentsDeleteTest({ stateDir, cfg, sessions: {} });
      const databasePath = path.join(stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite");
      registerOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
      workspaceStateMocks.deleteWorkspaceState.mockImplementationOnce(() => {
        throw new Error("interrupted after filesystem cleanup");
      });

      await expect(
        agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime),
      ).rejects.toThrow("interrupted after filesystem cleanup");
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
      expect(listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId)).toContain("ops");

      const writeCalls = configMocks.replaceConfigFile.mock.calls as unknown as Array<
        [{ nextConfig?: OpenClawConfig }]
      >;
      const firstWrite = writeCalls[0]?.[0];
      const nextConfig = firstWrite?.nextConfig;
      expect(nextConfig).toBeDefined();
      configMocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: nextConfig,
        runtimeConfig: nextConfig,
        sourceConfig: nextConfig,
        resolved: nextConfig,
      });

      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

      expect(listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId)).not.toContain(
        "ops",
      );
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(true);
    });
  });
});
