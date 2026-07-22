// Agent mutation tests cover create/update/delete handlers, safe workspace file
// access, config preconditions, trash cleanup, and workspace-state handling.

import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentDeletionAuthorityRollbackError } from "../../agents/agent-lifecycle-registry.js";
import { FsSafeError } from "../../infra/fs-safe.js";
/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {} as Record<string, unknown>,
  listAgentEntries: vi.fn((_cfg?: unknown) => [] as Array<Record<string, unknown>>),
  findAgentEntryIndex: vi.fn((_list?: unknown, _agentId?: string) => -1),
  applyAgentConfig: vi.fn((_cfg: unknown, _opts: unknown) => ({})),
  pruneAgentConfig: vi.fn(() => ({ config: {}, removedBindings: 0 })),
  writeConfigFile: vi.fn(async (_nextConfig?: unknown) => {}),
  omitConfigMutationResult: false,
  ensureAgentWorkspace: vi.fn(
    async (params?: { dir?: string }): Promise<{ dir: string; identityPathCreated: boolean }> => ({
      dir: params?.dir
        ? params.dir.startsWith("/resolved/")
          ? params.dir
          : `/resolved${params.dir.startsWith("/") ? "" : "/"}${params.dir}`
        : "/resolved/workspace",
      identityPathCreated: false,
    }),
  ),
  isWorkspaceSetupCompleted: vi.fn(async () => false),
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
  withAgentExecApprovalsRemoved: vi.fn(
    async (_agentId: string, commit: () => Promise<unknown>) => await commit(),
  ),
  beginAgentDeletionCommit: vi.fn(),
  beginAgentDeletionRollback: vi.fn(),
  beginAgentDeletionFinish: vi.fn(),
  claimCompletedAgentDeletion: vi.fn(() => true),
  readAgentDeletionJournal: vi.fn(() => undefined as Record<string, unknown> | undefined),
  resolveOpenClawAgentSqlitePath: vi.fn(
    (params?: { path?: string }) => params?.path ?? "/agents/test-agent/openclaw-agent.sqlite",
  ),
  closeOpenClawAgentDatabaseByPath: vi.fn((_pathname?: string) => true),
  listOpenClawRegisteredAgentDatabases: vi.fn(() => [] as Array<Record<string, unknown>>),
  unregisterOpenClawAgentDatabase: vi.fn(),
  assertNoOpenClawAgentDatabaseLeases: vi.fn(),
  registerResolvedAgentDir: vi.fn(),
  resolveRegisteredAgentIdForDir: vi.fn((_pathname?: string) => undefined as string | undefined),
  isPathOwnedByAnotherRegisteredAgent: vi.fn(
    (_params: { agentId: string; pathname: string }) => false,
  ),
  normalizeAgentDirRegistryPath: vi.fn((pathname: string) => path.resolve(pathname)),
  unregisterResolvedAgentDir: vi.fn((_params: { agentId: string; agentDir: string }) => true),
  cronRemoveAgentJobsTransactional: vi.fn(
    async (_agentId: string, commit: () => Promise<unknown>) => await commit(),
  ),
  resolveAgentDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/agents/test-agent"),
  resolveAgentWorkspaceDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/workspace/test-agent"),
  resolveSessionTranscriptsDirForAgent: vi.fn((_agentId?: string) => "/transcripts/test-agent"),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [],
  })),
  movePathToTrash: vi.fn(async (_pathname?: string) => "/trashed"),
  fsAccess: vi.fn(async () => {}),
  fsMkdir: vi.fn(async () => undefined),
  fsAppendFile: vi.fn(async () => {}),
  fsReadFile: vi.fn(async () => ""),
  fsStat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsLstat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsRealpath: vi.fn(async (p: string) => p),
  fsReadlink: vi.fn(async () => ""),
  fsRm: vi.fn(async () => undefined),
  fsOpen: vi.fn(async () => ({}) as unknown),
  rootRead: vi.fn(async (_params?: unknown) => ({
    buffer: Buffer.from(""),
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  })),
  rootOpen: vi.fn(async (_params?: unknown) => ({
    handle: { close: vi.fn(async () => {}) },
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  })),
  rootStat: vi.fn(async (_params?: unknown) => ({
    isFile: true,
    isSymbolicLink: false,
    mtimeMs: 0,
    nlink: 1,
    size: 0,
  })),
  rootWrite: vi.fn(async (_params?: unknown) => {}),
}));

const RESERVED_SYSTEM_AGENT_IDS_FOR_TEST = ["openclaw", "crestodian"] as const; // reserved ids

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mocks.loadConfigReturn,
    writeConfigFile: mocks.writeConfigFile,
    replaceConfigFile: async (params: { nextConfig: unknown }) =>
      await mocks.writeConfigFile(params.nextConfig),
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: { sourceConfig: mocks.loadConfigReturn },
    }),
    mutateConfigFileWithRetry: async (params: {
      mutate: (draft: Record<string, unknown>, context: unknown) => unknown;
    }) => {
      const draft = structuredClone(mocks.loadConfigReturn);
      const result = await params.mutate(draft, {
        snapshot: { path: "/tmp/openclaw/config.json" },
        previousHash: "test-hash",
        attempt: 0,
      });
      await mocks.writeConfigFile(draft);
      return {
        path: "/tmp/openclaw/config.json",
        previousHash: "test-hash",
        persistedHash: "persisted-hash",
        snapshot: { path: "/tmp/openclaw/config.json" },
        nextConfig: draft,
        result: mocks.omitConfigMutationResult ? undefined : result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
    transformConfigFileWithRetry: async (params: {
      transform: (
        config: Record<string, unknown>,
        context: unknown,
      ) => Promise<{ nextConfig: Record<string, unknown>; result?: unknown }>;
    }) => {
      const transformed = await params.transform(structuredClone(mocks.loadConfigReturn), {
        snapshot: { path: "/tmp/openclaw/config.json" },
        previousHash: "test-hash",
        attempt: 0,
      });
      await mocks.writeConfigFile(transformed.nextConfig);
      mocks.loadConfigReturn = transformed.nextConfig;
      return {
        path: "/tmp/openclaw/config.json",
        previousHash: "test-hash",
        persistedHash: "persisted-hash",
        snapshot: { path: "/tmp/openclaw/config.json" },
        nextConfig: transformed.nextConfig,
        result: transformed.result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
    withConfigMutationExclusive: async (fn: (config: unknown) => Promise<unknown>) =>
      await fn(mocks.loadConfigReturn),
  };
});

vi.mock("../../commands/agents.config.js", () => ({
  applyAgentConfig: mocks.applyAgentConfig,
  findAgentEntryIndex: mocks.findAgentEntryIndex,
  listAgentEntries: mocks.listAgentEntries,
  pruneAgentConfig: mocks.pruneAgentConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  listAgentEntries: mocks.listAgentEntries,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentConfig: (cfg: unknown, agentId: string) =>
    getAgentList(cfg).find((entry) => entry.id === agentId),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/agent-dir-registry.js", () => ({
  isPathOwnedByAnotherRegisteredAgent: mocks.isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath: mocks.normalizeAgentDirRegistryPath,
  registerResolvedAgentDir: mocks.registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir: mocks.resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir: mocks.unregisterResolvedAgentDir,
}));

vi.mock("../../agents/agent-lifecycle-registry.js", () => ({
  AgentDeletionAuthorityRollbackError: class extends AggregateError {},
  AgentDeletionCommitUncertainError: class extends Error {
    constructor(cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause));
    }
  },
  beginAgentDeletion: (entry: Record<string, unknown>) => ({
    entry: Object.assign(entry, {
      databasePaths: entry.databasePaths ?? [],
      cleanupPaths: entry.cleanupPaths ?? [],
    }),
    commit: mocks.beginAgentDeletionCommit,
    fenceDatabasePaths: (paths: string[]) => {
      entry.databasePaths = [...new Set(paths)];
    },
    fenceCleanupPaths: (paths: unknown[]) => {
      entry.cleanupPaths = [...paths];
    },
    finish: mocks.beginAgentDeletionFinish,
    rollback: mocks.beginAgentDeletionRollback,
  }),
  claimCompletedAgentDeletion: mocks.claimCompletedAgentDeletion,
  isAgentDeletionBlocked: () => false,
}));

vi.mock("../../infra/exec-approvals.js", () => ({
  withAgentExecApprovalsRemoved: mocks.withAgentExecApprovalsRemoved,
}));

vi.mock("../../state/openclaw-agent-db.js", () => ({
  closeOpenClawAgentDatabaseByPath: mocks.closeOpenClawAgentDatabaseByPath,
  listOpenClawRegisteredAgentDatabases: mocks.listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath: mocks.resolveOpenClawAgentSqlitePath,
}));

vi.mock("../../state/agent-deletion-journal.js", () => ({
  readAgentDeletionJournal: mocks.readAgentDeletionJournal,
}));

vi.mock("../../state/openclaw-agent-db-registry.js", () => ({
  unregisterOpenClawAgentDatabase: mocks.unregisterOpenClawAgentDatabase,
}));

vi.mock("../../state/openclaw-agent-db-lease.js", () => ({
  assertNoOpenClawAgentDatabaseLeases: mocks.assertNoOpenClawAgentDatabaseLeases,
}));

vi.mock("../../agents/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/workspace.js")>(
    "../../agents/workspace.js",
  );
  return {
    ...actual,
    ensureAgentWorkspace: mocks.ensureAgentWorkspace,
    isWorkspaceSetupCompleted: mocks.isWorkspaceSetupCompleted,
  };
});

vi.mock("../../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/workspace-state-store.js")>(
    "../../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: mocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: mocks.prepareWorkspaceStateDeletion,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: mocks.resolveSessionTranscriptsDirForAgent,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: (p: string) => `/resolved${p.startsWith("/") ? "" : "/"}${p}`,
  };
});

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

vi.mock("../../infra/fs-safe.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/fs-safe.js")>("../../infra/fs-safe.js");
  return {
    ...actual,
    root: vi.fn(async (rootDir: string) => ({
      rootReal: rootDir,
      open: async (relativePath: string, options?: Record<string, unknown>) =>
        await mocks.rootOpen({ rootDir, relativePath, ...options }),
      stat: async (relativePath: string) => await mocks.rootStat({ rootDir, relativePath }),
      read: async (relativePath: string, options?: Record<string, unknown>) =>
        await mocks.rootRead({ rootDir, relativePath, ...options }),
      write: async (
        relativePath: string,
        data: string | Buffer,
        options?: Record<string, unknown>,
      ) =>
        await mocks.rootWrite({
          rootDir,
          relativePath,
          data,
          ...options,
        }),
    })),
  };
});

// Mock node:fs/promises – agents.ts uses `import fs from "node:fs/promises"`
// which resolves to the module namespace default, so we spread actual and
// override the methods we need, plus set `default` explicitly.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = {
    ...actual,
    access: mocks.fsAccess,
    mkdir: mocks.fsMkdir,
    appendFile: mocks.fsAppendFile,
    readFile: mocks.fsReadFile,
    stat: mocks.fsStat,
    lstat: mocks.fsLstat,
    realpath: mocks.fsRealpath,
    readlink: mocks.fsReadlink,
    rm: mocks.fsRm,
    open: mocks.fsOpen,
  };
  return { ...patched, default: patched };
});

/* ------------------------------------------------------------------ */
/* Import after mocks are set up                                      */
/* ------------------------------------------------------------------ */

const { testing: agentsTesting, agentsHandlers } = await import("./agents.js");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  agentsTesting.resetDepsForTests();
  mocks.omitConfigMutationResult = false;
  mocks.withAgentExecApprovalsRemoved
    .mockReset()
    .mockImplementation(async (_agentId: string, commit: () => Promise<unknown>) => await commit());
  mocks.beginAgentDeletionCommit.mockReset();
  mocks.beginAgentDeletionRollback.mockReset();
  mocks.beginAgentDeletionFinish.mockReset();
  mocks.readAgentDeletionJournal.mockReset().mockReturnValue(undefined);
  mocks.resolveOpenClawAgentSqlitePath
    .mockReset()
    .mockImplementation(
      (params?: { path?: string }) => params?.path ?? "/agents/test-agent/openclaw-agent.sqlite",
    );
  mocks.closeOpenClawAgentDatabaseByPath.mockReset().mockReturnValue(true);
  mocks.listOpenClawRegisteredAgentDatabases.mockReset().mockReturnValue([]);
  mocks.unregisterOpenClawAgentDatabase.mockReset();
  mocks.registerResolvedAgentDir.mockReset();
  mocks.resolveRegisteredAgentIdForDir
    .mockReset()
    .mockImplementation((pathname?: string) =>
      pathname === "/agents/test-agent" || pathname === "/journal/agent" ? "test-agent" : undefined,
    );
  mocks.isPathOwnedByAnotherRegisteredAgent.mockReset().mockReturnValue(false);
  mocks.normalizeAgentDirRegistryPath.mockReset().mockImplementation((pathname) => pathname);
  mocks.unregisterResolvedAgentDir.mockReset().mockReturnValue(true);
  mocks.cronRemoveAgentJobsTransactional
    .mockReset()
    .mockImplementation(async (_agentId: string, commit: () => Promise<unknown>) => await commit());
  mocks.loadConfigReturn = {};
  mocks.listAgentEntries.mockImplementation((cfg: unknown) => getAgentList(cfg));
  mocks.findAgentEntryIndex.mockImplementation((list: unknown, agentId?: string) =>
    (Array.isArray(list) ? (list as MockAgentEntry[]) : []).findIndex(
      (entry) => entry.id === agentId,
    ),
  );
  mocks.applyAgentConfig.mockImplementation((cfg: unknown, opts: unknown) =>
    mergeAgentConfig(cfg, opts),
  );
  mocks.resolveAgentWorkspaceDir.mockImplementation((cfg: unknown, agentId?: string) =>
    resolveMockWorkspaceDir(cfg, agentId),
  );
  mocks.rootOpen.mockResolvedValue({
    handle: { close: vi.fn(async () => {}) },
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  });
  mocks.rootRead.mockResolvedValue({
    buffer: Buffer.from(""),
    realPath: "/workspace/test-agent/AGENTS.md",
    stat: { size: 0, mtimeMs: 0 },
  });
  mocks.rootStat.mockImplementation(async (params?: unknown) => {
    const { rootDir, relativePath } = params as { rootDir: string; relativePath: string };
    const stat = await mocks.fsLstat(path.join(rootDir, relativePath));
    return {
      dev: stat?.dev,
      ino: stat?.ino,
      isFile: stat?.isFile?.() ?? true,
      isSymbolicLink: stat?.isSymbolicLink?.() ?? false,
      mtimeMs: stat?.mtimeMs ?? 0,
      nlink: stat?.nlink ?? 1,
      size: stat?.size ?? 0,
    };
  });
  mocks.rootWrite.mockResolvedValue(undefined);
});

function makeRootForTest(overrides?: {
  open?: (params: Record<string, unknown>) => Promise<unknown>;
  read?: (params: Record<string, unknown>) => Promise<unknown>;
  stat?: (params: Record<string, unknown>) => Promise<unknown>;
  write?: (params: Record<string, unknown>) => Promise<unknown>;
}) {
  return async (rootDir: string) =>
    ({
      rootReal: rootDir,
      open: async (relativePath: string, options?: Record<string, unknown>) =>
        await (overrides?.open ?? mocks.rootOpen)({ rootDir, relativePath, ...options }),
      stat: async (relativePath: string) =>
        await (overrides?.stat ?? mocks.rootStat)({ rootDir, relativePath }),
      read: async (relativePath: string, options?: Record<string, unknown>) =>
        await (overrides?.read ?? mocks.rootRead)({ rootDir, relativePath, ...options }),
      write: async (
        relativePath: string,
        data: string | Buffer,
        options?: Record<string, unknown>,
      ) =>
        await (overrides?.write ?? mocks.rootWrite)({
          rootDir,
          relativePath,
          data,
          ...options,
        }),
    }) as never;
}

function makeCall(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = expectDefined(agentsHandlers[method], "agentsHandlers[method] test invariant");
  const promise = handler({
    params,
    respond,
    context: {
      getRuntimeConfig: () => mocks.loadConfigReturn,
      cron: { removeAgentJobsTransactional: mocks.cronRemoveAgentJobsTransactional },
    } as never,
    req: { type: "req" as const, id: "1", method },
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond, promise };
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectRespondOk(respond: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  expect(mockCallArg(respond)).toBe(true);
  const payload = expectRecordFields(mockCallArg(respond, 0, 1), expected);
  expect(mockCallArg(respond, 0, 2)).toBeUndefined();
  return payload;
}

function expectRespondErrorContaining(respond: ReturnType<typeof vi.fn>, text: string) {
  expect(mockCallArg(respond)).toBe(false);
  expect(mockCallArg(respond, 0, 1)).toBeUndefined();
  const error = expectRecordFields(mockCallArg(respond, 0, 2), {});
  expectStringContaining(error.message, text);
  return error;
}

function firstRespondResult(respond: ReturnType<typeof vi.fn>): unknown {
  return mockCallArg(respond, 0, 1);
}

function expectStringContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).toContain(text);
}

function expectStringNotContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).not.toContain(text);
}
function createEnoentError() {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function createErrnoError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeFileStat(params?: {
  size?: number;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
  nlink?: number;
}): import("node:fs").Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: params?.size ?? 10,
    mtimeMs: params?.mtimeMs ?? 1234,
    dev: params?.dev ?? 1,
    ino: params?.ino ?? 1,
    nlink: params?.nlink ?? 1,
  } as unknown as import("node:fs").Stats;
}

type MockIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
};

type MockAgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  identity?: MockIdentity;
};

type MockConfig = {
  agents?: {
    list?: MockAgentEntry[];
  };
};

function getAgentList(cfg: unknown): MockAgentEntry[] {
  return ((cfg as MockConfig | undefined)?.agents?.list ?? []).map((entry) =>
    Object.assign({}, entry),
  );
}

function mergeAgentConfig(cfg: unknown, opts: unknown): MockConfig {
  const config = (cfg as MockConfig | undefined) ?? {};
  const params = (opts as {
    agentId?: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string | null;
    identity?: MockIdentity;
  }) ?? { agentId: "" };
  const list = getAgentList(config);
  const agentId = params.agentId ?? "";
  const index = list.findIndex((entry) => entry.id === agentId);
  const base = index >= 0 ? expectDefined(list[index], "existing agent entry") : { id: agentId };
  const nextEntry: MockAgentEntry = {
    ...base,
    ...(params.name ? { name: params.name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.identity ? { identity: { ...base.identity, ...params.identity } } : {}),
  };
  if (params.model === null) {
    delete nextEntry.model;
  }
  if (index >= 0) {
    list[index] = nextEntry;
  } else {
    list.push(nextEntry);
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      list,
    },
  };
}

function resolveMockWorkspaceDir(cfg: unknown, agentId?: string): string {
  const resolvedAgentId = agentId ?? "";
  return (
    getAgentList(cfg).find((entry) => entry.id === resolvedAgentId)?.workspace ??
    `/workspace/${resolvedAgentId}`
  );
}

function mockWorkspaceStateRead(params: {
  setupCompletedAt?: string;
  errorCode?: string;
  rawContent?: string;
}) {
  agentsTesting.setDepsForTests({
    isWorkspaceSetupCompleted: async () => {
      if (params.errorCode) {
        throw createErrnoError(params.errorCode);
      }
      if (typeof params.rawContent === "string") {
        throw new SyntaxError("Expected property name or '}' in JSON");
      }
      return (
        typeof params.setupCompletedAt === "string" && params.setupCompletedAt.trim().length > 0
      );
    },
  });
  mocks.isWorkspaceSetupCompleted.mockImplementation(async () => {
    if (params.errorCode) {
      throw createErrnoError(params.errorCode);
    }
    if (typeof params.rawContent === "string") {
      throw new SyntaxError("Expected property name or '}' in JSON");
    }
    return typeof params.setupCompletedAt === "string" && params.setupCompletedAt.trim().length > 0;
  });
}

async function listAgentFileNames(agentId = "main") {
  const { respond, promise } = makeCall("agents.files.list", { agentId });
  await promise;

  const result = firstRespondResult(respond);
  const files = (result as { files: Array<{ name: string }> }).files;
  return files.map((file) => file.name);
}

function expectNotFoundResponseAndNoWrite(respond: ReturnType<typeof vi.fn>) {
  expectRespondErrorContaining(respond, "not found");
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
}

async function expectUnsafeWorkspaceFile(method: "agents.files.get" | "agents.files.set") {
  const params =
    method === "agents.files.set"
      ? { agentId: "main", name: "AGENTS.md", content: "x" }
      : { agentId: "main", name: "AGENTS.md" };
  const { respond, promise } = makeCall(method, params);
  await promise;
  expectRespondErrorContaining(respond, "unsafe workspace file");
}

beforeEach(() => {
  mocks.fsReadFile.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsStat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsLstat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsRealpath.mockImplementation(async (p: string) => p);
  mocks.fsOpen.mockImplementation(
    async () =>
      ({
        stat: async () => makeFileStat(),
        readFile: async () => Buffer.from(""),
        truncate: async () => {},
        writeFile: async () => {},
        close: async () => {},
      }) as unknown,
  );
});

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("agents.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
  });

  it("creates a new agent successfully", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "Test Agent",
      workspace: "/home/user/agents/test",
    });
    await promise;

    expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      name: "Test Agent",
    });
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalled();
  });

  it("defaults an omitted workspace", async () => {
    const { respond, promise } = makeCall("agents.create", { name: "Test Agent" });

    await promise;

    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "test-agent");
    expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      workspace: "/resolved/workspace/test-agent",
    });
  });

  it("sets up the workspace before publishing agent config", async () => {
    const callOrder: string[] = [];
    mocks.ensureAgentWorkspace.mockImplementation(async () => {
      callOrder.push("ensureAgentWorkspace");
      return { dir: "/resolved/tmp/ws", identityPathCreated: false };
    });
    mocks.writeConfigFile.mockImplementation(async () => {
      callOrder.push("writeConfigFile");
    });

    const { promise } = makeCall("agents.create", {
      name: "Order Test",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(callOrder.indexOf("ensureAgentWorkspace")).toBeLessThan(
      callOrder.indexOf("writeConfigFile"),
    );
  });

  it("rejects creating an agent with reserved 'main' id", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "main",
      workspace: "/tmp/ws",
    });
    await promise;

    expectRespondErrorContaining(respond, "reserved");
  });

  it.each(RESERVED_SYSTEM_AGENT_IDS_FOR_TEST)(
    "rejects creating an agent with reserved system-agent id %s",
    async (name) => {
      const { respond, promise } = makeCall("agents.create", {
        name,
        workspace: "/tmp/ws",
      });
      await promise;

      expectRespondErrorContaining(respond, `"${name}" is reserved`);
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("rejects creating a duplicate agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(0);

    const { respond, promise } = makeCall("agents.create", {
      name: "Existing",
      workspace: "/tmp/ws",
    });
    await promise;

    expectRespondErrorContaining(respond, "already exists");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects invalid params (missing name)", async () => {
    const { respond, promise } = makeCall("agents.create", {
      workspace: "/tmp/ws",
    });
    await promise;

    expectRespondErrorContaining(respond, "invalid");
  });

  it("writes identity to both config and IDENTITY.md", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Plain Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {});
    expectRecordFields(configOptions.identity, { name: "Plain Agent" });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/resolved/tmp/ws",
      relativePath: "IDENTITY.md",
    });
    expectStringContaining(write.data, "- Name: Plain Agent");
  });

  it("writes emoji and avatar to both config and IDENTITY.md", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Fancy Agent",
      workspace: "/tmp/ws",
      emoji: "🤖",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {});
    expectRecordFields(configOptions.identity, {
      name: "Fancy Agent",
      emoji: "🤖",
      avatar: "https://example.com/avatar.png",
    });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/resolved/tmp/ws",
      relativePath: "IDENTITY.md",
    });
    expect(write.data).toBe(
      [
        "# IDENTITY.md - Agent Identity",
        "",
        "- Name: Fancy Agent",
        "- Emoji: 🤖",
        "- Avatar: https://example.com/avatar.png",
        "",
      ].join("\n"),
    );
  });

  it("does not publish config when IDENTITY.md write fails with FsSafeError", async () => {
    mocks.rootWrite.mockRejectedValueOnce(
      new FsSafeError("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.create", {
      name: "Unsafe Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expectRespondErrorContaining(respond, "unsafe workspace file");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(getAgentList(mocks.loadConfigReturn)).toEqual([]);
  });

  it("passes model to applyAgentConfig when provided", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "Model Agent",
      workspace: "/tmp/ws",
      model: "sonnet-4.6",
    });
    await promise;

    expectRespondOk(respond, { ok: true, model: "sonnet-4.6" });
    expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), { model: "sonnet-4.6" });
  });
});

describe("agents.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      agents: {
        list: [
          {
            id: "test-agent",
            workspace: "/workspace/test-agent",
            identity: {
              name: "Current Agent",
              theme: "steady",
              emoji: "🐢",
            },
          },
        ],
      },
    };
  });

  it("updates an existing agent successfully", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Updated Name",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.writeConfigFile).toHaveBeenCalled();
  });

  it("rejects updating a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const { respond, promise } = makeCall("agents.update", {
      agentId: "nonexistent",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("returns not found when a concurrent delete wins the update race", async () => {
    let findCallCount = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      findCallCount += 1;
      return findCallCount >= 2 ? -1 : 0;
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      model: "gpt-5.5",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("clears an existing model override", async () => {
    mocks.loadConfigReturn = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-luna" } },
        list: [
          {
            id: "test-agent",
            workspace: "/workspace/test-agent",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    };

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      model: null,
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), { model: null });
    const persisted = expectRecordFields(mockCallArg(mocks.writeConfigFile), {});
    const agents = expectRecordFields(persisted.agents, {});
    const [agent] = agents.list as MockAgentEntry[];
    expect(agent).not.toHaveProperty("model");
  });

  it("ensures workspace when workspace changes", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
  });

  it("does not ensure workspace when workspace is unchanged", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Just a rename",
    });
    await promise;

    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("writes merged identity to IDENTITY.md when only avatar changes", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {});
    expectRecordFields(configOptions.identity, {
      avatar: "https://example.com/avatar.png",
    });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/workspace/test-agent",
      relativePath: "IDENTITY.md",
    });
    expect(write.data).toBe(
      [
        "# IDENTITY.md - Agent Identity",
        "",
        "- Name: Current Agent",
        "- Theme: steady",
        "- Emoji: 🐢",
        "- Avatar: https://example.com/avatar.png",
        "",
      ].join("\n"),
    );
  });

  it("writes merged identity to IDENTITY.md when only emoji changes", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      emoji: "🦀",
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {});
    expectRecordFields(configOptions.identity, { emoji: "🦀" });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/workspace/test-agent",
      relativePath: "IDENTITY.md",
    });
    expect(write.data).toBe(
      [
        "# IDENTITY.md - Agent Identity",
        "",
        "- Name: Current Agent",
        "- Theme: steady",
        "- Emoji: 🦀",
        "",
      ].join("\n"),
    );
  });

  it("writes combined identity fields to both config and IDENTITY.md", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "New Name",
      emoji: "🤖",
      avatar: "https://example.com/new.png",
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
      name: "New Name",
    });
    expectRecordFields(configOptions.identity, {
      name: "New Name",
      emoji: "🤖",
      avatar: "https://example.com/new.png",
    });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/workspace/test-agent",
      relativePath: "IDENTITY.md",
    });
    expect(write.data).toBe(
      [
        "# IDENTITY.md - Agent Identity",
        "",
        "- Name: New Name",
        "- Theme: steady",
        "- Emoji: 🤖",
        "- Avatar: https://example.com/new.png",
        "",
      ].join("\n"),
    );
  });

  it("syncs existing identity into a new workspace even without identity params", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/new/workspace",
      identityPathCreated: true,
    });
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        read: async ({ rootDir, relativePath }) => {
          const filePath = `${String(rootDir)}/${String(relativePath)}`;
          if (filePath === "/workspace/test-agent/IDENTITY.md") {
            return {
              buffer: Buffer.from(
                [
                  "# IDENTITY.md - Agent Identity",
                  "",
                  "- **Name:** Current Agent",
                  "- **Creature:** Steady Turtle",
                  "- **Vibe:** Calm and methodical",
                  "- **Emoji:** 🐢",
                  "",
                  "## Role",
                  "",
                  "Protect the queue.",
                  "",
                ].join("\n"),
              ),
              realPath: filePath,
              stat: makeFileStat(),
            };
          }
          if (filePath === "/resolved/new/workspace/IDENTITY.md") {
            return {
              buffer: Buffer.from(
                [
                  "# IDENTITY.md - Agent Identity",
                  "",
                  "- **Name:** C-3PO (Clawd's Third Protocol Observer)",
                  "- **Creature:** Flustered Protocol Droid",
                  "",
                  "## Role",
                  "",
                  "Debug agent for `--dev` mode.",
                  "",
                ].join("\n"),
              ),
              realPath: filePath,
              stat: makeFileStat(),
            };
          }
          throw createEnoentError();
        },
      }),
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/resolved/new/workspace",
      relativePath: "IDENTITY.md",
    });
    expectStringContaining(write.data, "- **Creature:** Steady Turtle");
    expectStringContaining(write.data, "## Role");
    expectStringNotContaining(write.data, "Flustered Protocol Droid");
  });

  it("preserves an existing destination identity file when workspace changes", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/new/workspace",
      identityPathCreated: false,
    });
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        read: async ({ rootDir, relativePath }) => {
          const filePath = `${String(rootDir)}/${String(relativePath)}`;
          if (filePath === "/workspace/test-agent/IDENTITY.md") {
            return {
              buffer: Buffer.from(
                [
                  "# IDENTITY.md - Agent Identity",
                  "",
                  "- **Name:** Current Agent",
                  "- **Creature:** Old Turtle",
                  "",
                  "## Role",
                  "",
                  "Old workspace role.",
                  "",
                ].join("\n"),
              ),
              realPath: filePath,
              stat: makeFileStat(),
            };
          }
          if (filePath === "/resolved/new/workspace/IDENTITY.md") {
            return {
              buffer: Buffer.from(
                [
                  "# IDENTITY.md - Agent Identity",
                  "",
                  "- **Name:** Destination Agent",
                  "- **Creature:** Destination Fox",
                  "",
                  "## Role",
                  "",
                  "Destination workspace role.",
                  "",
                ].join("\n"),
              ),
              realPath: filePath,
              stat: makeFileStat(),
            };
          }
          throw createEnoentError();
        },
      }),
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
      rootDir: "/resolved/new/workspace",
      relativePath: "IDENTITY.md",
    });
    expectStringContaining(write.data, "- **Creature:** Destination Fox");
    expectStringContaining(write.data, "Destination workspace role.");
    expectStringNotContaining(write.data, "Old workspace role.");
  });

  it("does not persist config when IDENTITY.md write fails on update", async () => {
    mocks.rootWrite.mockRejectedValueOnce(
      new FsSafeError("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Bad Update",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expectRespondErrorContaining(respond, "unsafe workspace file");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("treats unsafe IDENTITY.md reads as invalid update requests", async () => {
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        read: async () => {
          throw new FsSafeError("invalid-path", "path is not a regular file under root");
        },
      }),
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/unsafe.png",
    });
    await promise;

    expectRespondErrorContaining(respond, 'unsafe workspace file "IDENTITY.md"');
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.rootWrite).not.toHaveBeenCalled();
  });

  it("uses non-blocking reads for IDENTITY.md during agents.update", async () => {
    const rootRead = vi.fn(async () => {
      throw new FsSafeError("not-found", "file not found");
    });
    agentsTesting.setDepsForTests({ root: makeRootForTest({ read: rootRead }) });

    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Updated NB",
    });
    await promise;

    expectRecordFields(mockCallArg(rootRead), {
      relativePath: "IDENTITY.md",
      nonBlockingRead: true,
    });
  });
});

describe("agents.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fsLstat.mockResolvedValue({
      isSymbolicLink: () => false,
    } as unknown as import("node:fs").Stats);
    mocks.fsRealpath.mockImplementation(async (pathname: string) => pathname);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "test-agent", workspace: "/workspace/test-agent" }] },
    };
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.pruneAgentConfig.mockReturnValue({ config: {}, removedBindings: 2 });
    mocks.movePathToTrash.mockReset().mockResolvedValue("/trashed");
  });

  it("removes only the deleted agent's authority before committing its roster removal", async () => {
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    const approvals = new Set(["test-agent", "other-agent"]);
    const events: string[] = [];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        events.push("cron");
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const existed = approvals.delete(agentId);
        events.push("approvals");
        try {
          return await commit();
        } catch (error) {
          if (existed) {
            approvals.add(agentId);
          }
          throw error;
        }
      },
    );
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      events.push("config");
    });
    mocks.beginAgentDeletionCommit.mockImplementationOnce(() => {
      events.push("lifecycle");
    });
    mocks.unregisterResolvedAgentDir.mockImplementationOnce(() => {
      events.push("directory");
      return true;
    });
    mocks.closeOpenClawAgentDatabaseByPath.mockImplementation(() => {
      events.push("database");
      return true;
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(cronJobs).toEqual([{ id: "other-job", agentId: "other-agent" }]);
    expect(approvals).toEqual(new Set(["other-agent"]));
    expect(mocks.cronRemoveAgentJobsTransactional).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
    );
    expect(mocks.withAgentExecApprovalsRemoved).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
    );
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/agents/test-agent/openclaw-agent.sqlite",
    });
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/agents/test-agent",
    });
    expect(events).toEqual(["database", "cron", "approvals", "config", "lifecycle", "directory"]);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("rolls cron back and keeps the roster when authority cleanup fails", async () => {
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(cronJobs).toEqual([
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ]);
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledOnce();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("keeps a recovered deletion journal fenced when retry cleanup fails", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
    });
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps a new deletion fenced when authority rollback fails", async () => {
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(
      new AgentDeletionAuthorityRollbackError(
        [new Error("config failed"), new Error("approval restore failed")],
        "approval rollback failed",
      ),
    );

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approval rollback failed");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps deletion fenced when config persistence succeeds before reporting failure", async () => {
    let configuredCheck = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      configuredCheck += 1;
      return configuredCheck < 4 ? 0 : -1;
    });
    mocks.writeConfigFile.mockImplementationOnce(async (nextConfig?: unknown) => {
      if (!nextConfig || typeof nextConfig !== "object") {
        throw new Error("expected config object");
      }
      mocks.loadConfigReturn = nextConfig as Record<string, unknown>;
      throw new Error("post-write refresh failed");
    });

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("post-write refresh failed");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("does not perform destructive cleanup without a config deletion result", async () => {
    mocks.omitConfigMutationResult = true;

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("config mutation did not return its target");
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledOnce();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
  });

  it("keeps authority removed when the committed config omits its mutation result", async () => {
    mocks.omitConfigMutationResult = true;
    let configuredCheck = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      configuredCheck += 1;
      return configuredCheck < 4 ? 0 : -1;
    });

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("config mutation did not return its target");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
  });

  it("resumes a journaled deletion while its directory is still owned by the deleted agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
    );
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/journal/agent",
    });
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/journal/workspace");
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/journal/agent");
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/journal/sessions");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("converges after partial cleanup and makes the agent id recreatable", async () => {
    const journal = {
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/agents/test-agent",
      workspaceDir: "/workspace/test-agent",
      sessionsDir: "/transcripts/test-agent",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    };
    const trashed = new Set<string>();
    let workspaceAttempts = 0;
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (trashed.has(String(pathname))) {
        throw createEnoentError();
      }
      return null as unknown as import("node:fs").Stats;
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === journal.workspaceDir && workspaceAttempts++ === 0) {
        throw new Error("workspace trash failed");
      }
      trashed.add(pathname ?? "");
      return "/trashed";
    });
    mocks.beginAgentDeletionFinish.mockImplementation(() => {
      journal.cleanupCompleted = true;
    });
    mocks.readAgentDeletionJournal.mockReturnValue(journal);

    const firstDelete = makeCall("agents.delete", { agentId: "test-agent" });
    await firstDelete.promise;

    expectRespondOk(firstDelete.respond, {
      failed: [{ path: journal.workspaceDir, reason: "workspace trash failed" }],
    });
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    const completedAgentDir = (
      journal as typeof journal & {
        cleanupPaths: Array<{ path: string; done: boolean }>;
      }
    ).cleanupPaths.find((entry) => entry.path === journal.agentDir);
    expect(completedAgentDir?.done).toBe(true);
    const agentDirMoveCount = mocks.movePathToTrash.mock.calls.filter(
      ([pathname]) => pathname === journal.agentDir,
    ).length;
    trashed.delete(journal.agentDir);
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    const blockedCreate = makeCall("agents.create", { name: "Test Agent" });
    await blockedCreate.promise;
    expectRespondErrorContaining(blockedCreate.respond, "still pending");

    const recovery = makeCall("agents.delete", { agentId: "test-agent" });
    await recovery.promise;

    expectRespondOk(recovery.respond, { failed: [] });
    expect(
      mocks.movePathToTrash.mock.calls.filter(([pathname]) => pathname === journal.agentDir),
    ).toHaveLength(agentDirMoveCount);
    expect(trashed.has(journal.agentDir)).toBe(false);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
    expect(journal.cleanupCompleted).toBe(true);
    const recreated = makeCall("agents.create", { name: "Test Agent" });
    await recreated.promise;
    expectRespondOk(recreated.respond, { ok: true, agentId: "test-agent" });
  });

  it("preserves a replacement whose identity differs from the journal", async () => {
    const workspaceDir = "/journal/workspace";
    const workspaceAlias = "/journal/workspace-alias";
    const journal = {
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir,
      sessionsDir: "/journal/sessions",
      databasePaths: [workspaceAlias],
      cleanupPaths: [
        {
          path: "/journal/agent",
          canonicalPath: "/journal/agent",
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: ["/journal/agent"],
          dev: 1,
          ino: 10,
          coversDescendants: true,
          done: true,
        },
        {
          path: workspaceDir,
          canonicalPath: workspaceDir,
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: [workspaceDir],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: "/journal/sessions",
          canonicalPath: "/journal/sessions",
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: ["/journal/sessions"],
          dev: 1,
          ino: 30,
          coversDescendants: true,
          done: true,
        },
      ],
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    };
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname === workspaceAlias ? workspaceDir : pathname,
    );
    mocks.fsLstat.mockImplementation(
      async (pathname: unknown) =>
        ({
          dev: 2,
          ino: pathname === workspaceDir ? 200 : 100,
          isFile: () => false,
          isSymbolicLink: () => false,
          nlink: 1,
        }) as unknown as import("node:fs").Stats,
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(workspaceDir);
    const replacementRecord = journal.cleanupPaths.find((entry) => entry.path === workspaceDir);
    expect(replacementRecord).toMatchObject({
      done: true,
      note: "cleanup path appeared after deletion preparation",
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("protects a pending ancestor when a done descendant is recreated", async () => {
    const workspaceDir = "/journal/workspace";
    const completedChild = `${workspaceDir}/cleaned`;
    const journal = {
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir,
      sessionsDir: "/journal/sessions",
      databasePaths: [],
      cleanupPaths: [
        {
          path: completedChild,
          canonicalPath: completedChild,
          parentPath: workspaceDir,
          kind: "target" as const,
          sourcePaths: [workspaceDir],
          dev: 1,
          ino: 10,
          coversDescendants: true,
          done: true,
        },
        {
          path: workspaceDir,
          canonicalPath: workspaceDir,
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: [workspaceDir],
          dev: 1,
          ino: 20,
          coversDescendants: true,
          done: false,
        },
      ],
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    };
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname !== completedChild && pathname !== workspaceDir) {
        throw createEnoentError();
      }
      return {
        dev: pathname === completedChild ? 2 : 1,
        ino: pathname === completedChild ? 100 : 20,
        isFile: () => false,
        isSymbolicLink: () => false,
        nlink: 1,
      } as unknown as import("node:fs").Stats;
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(completedChild);
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(workspaceDir);
    expect(journal.cleanupPaths.find((entry) => entry.path === workspaceDir)).toMatchObject({
      done: true,
      note: "completed cleanup path is occupied; replacement preserved",
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("extends a recovery cleanup snapshot with newly discovered database files", async () => {
    const relocatedDatabase = "/relocated/recovered.sqlite";
    const journal = {
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      databasePaths: [],
      cleanupPaths: [
        {
          path: "/journal/agent",
          canonicalPath: "/journal/agent",
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: ["/journal/agent"],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: "/journal/workspace",
          canonicalPath: "/journal/workspace",
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: ["/journal/workspace"],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: "/journal/sessions",
          canonicalPath: "/journal/sessions",
          parentPath: "/journal",
          kind: "target" as const,
          sourcePaths: ["/journal/sessions"],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
      ],
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    };
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.listOpenClawRegisteredAgentDatabases.mockReturnValue([
      { agentId: "test-agent", path: relocatedDatabase },
    ]);

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    for (const databasePath of [
      relocatedDatabase,
      `${relocatedDatabase}-wal`,
      `${relocatedDatabase}-shm`,
    ]) {
      expect(journal.cleanupPaths.some((entry) => entry.sourcePaths.includes(databasePath))).toBe(
        true,
      );
      expect(mocks.movePathToTrash).toHaveBeenCalledWith(databasePath);
    }
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("treats a source that disappears during Trash as successful cleanup", async () => {
    let workspaceLstatCalls = 0;
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname === "/workspace/test-agent" && workspaceLstatCalls++ > 1) {
        throw createEnoentError();
      }
      return null as unknown as import("node:fs").Stats;
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/workspace/test-agent") {
        throw createEnoentError();
      }
      return "/trashed";
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    const result = expectRespondOk(respond, { failed: [] });
    expect(result.removed).toEqual(
      expect.arrayContaining([{ path: "/workspace/test-agent", method: "missing" }]),
    );
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("canonicalizes overlapping journal paths and cleans descendants first", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal",
      sessionsDir: "/journal/agent/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([pathname]) => pathname);
    expect(trashedPaths).toHaveLength(new Set(trashedPaths).size);
    expect(trashedPaths.indexOf("/journal/agent/sessions")).toBeLessThan(
      trashedPaths.indexOf("/journal/agent"),
    );
    expect(trashedPaths.indexOf("/journal/agent")).toBeLessThan(trashedPaths.indexOf("/journal"));
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir: "/journal" });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("skips an overlapping workspace that covers an agent directory claimed by a survivor", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal",
      sessionsDir: "/deleted/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === "/journal/agent" ? "other-agent" : undefined,
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal");
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal/agent");
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/deleted/sessions");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not move a symlink ancestor when its canonical descendant fails", async () => {
    const agentLink = "/deep/journal/link";
    const agentTarget = "/target";
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: agentLink,
      workspaceDir: "/deep",
      sessionsDir: "/deep/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === agentLink ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.replace(agentLink, agentTarget),
    );
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname.replace(agentLink, agentTarget),
    );
    mocks.fsLstat.mockImplementation(
      async (pathname: unknown) =>
        ({
          isSymbolicLink: () => pathname === agentLink,
        }) as unknown as import("node:fs").Stats,
    );
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === agentTarget) {
        throw new Error("agent trash failed");
      }
      return "/trashed";
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, {
      failed: [{ path: agentTarget, reason: "agent trash failed" }],
    });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(agentLink);
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/deep");
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(agentTarget);
    expect(mocks.unregisterResolvedAgentDir).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("does not trash a replacement at a journaled symlink path", async () => {
    const workspaceLink = "/journal/workspace-link";
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: workspaceLink,
      sessionsDir: "/journal/sessions",
      cleanupPaths: [
        {
          path: "/canonical/workspace",
          canonicalPath: "/canonical/workspace",
          parentPath: "/canonical",
          kind: "target",
          sourcePaths: [workspaceLink],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: workspaceLink,
          canonicalPath: workspaceLink,
          parentPath: "/journal",
          kind: "symlink",
          sourcePaths: [workspaceLink],
          dev: null,
          ino: null,
          coversDescendants: false,
          done: false,
        },
        {
          path: "/journal/agent",
          canonicalPath: "/journal/agent",
          parentPath: "/journal",
          kind: "target",
          sourcePaths: ["/journal/agent"],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: "/journal/sessions",
          canonicalPath: "/journal/sessions",
          parentPath: "/journal",
          kind: "target",
          sourcePaths: ["/journal/sessions"],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
      ],
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(workspaceLink);
    const replacementRecord = expectDefined(
      mocks.readAgentDeletionJournal.mock.results[0]?.value?.cleanupPaths?.find(
        (entry: { path?: string }) => entry.path === workspaceLink,
      ),
      "replacement cleanup record",
    );
    expect(replacementRecord).toMatchObject({
      done: true,
      note: "cleanup path changed from symlink before deletion",
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("resolves a symlinked workspace and removes descendants before its target and link", async () => {
    const workspaceParent = "/tmp-root";
    const workspaceParentTarget = "/real-tmp/source-parent";
    const workspaceLink = `${workspaceParent}/workspace-link`;
    const canonicalWorkspaceLink = `${workspaceParentTarget}/workspace-link`;
    const workspaceTarget = "/real-tmp/workspace";
    const agentDir = `${workspaceLink}/agent`;
    const sessionsDir = `${workspaceLink}/transcripts`;
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir,
      workspaceDir: workspaceLink,
      sessionsDir,
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === agentDir ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.replace(workspaceLink, workspaceTarget),
    );
    mocks.fsRealpath.mockImplementation(async (pathname: string) => {
      if (pathname === workspaceParent) {
        return workspaceParentTarget;
      }
      return pathname.replace(workspaceLink, workspaceTarget);
    });
    mocks.fsLstat.mockImplementation(
      async (pathname: unknown) =>
        ({
          isSymbolicLink: () => pathname === workspaceLink || pathname === canonicalWorkspaceLink,
        }) as unknown as import("node:fs").Stats,
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { failed: [] });
    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([pathname]) => String(pathname));
    const targetIndex = trashedPaths.indexOf(workspaceTarget);
    expect(trashedPaths.indexOf(`${workspaceTarget}/agent`)).toBeLessThan(targetIndex);
    expect(trashedPaths.indexOf(`${workspaceTarget}/transcripts`)).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(trashedPaths.indexOf(canonicalWorkspaceLink));
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(workspaceTarget);
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(canonicalWorkspaceLink);
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(workspaceLink);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not commit deletion when a journaled path cannot be resolved", async () => {
    const resolutionError = Object.assign(new Error("workspace target is inaccessible"), {
      code: "EACCES",
    });
    mocks.fsRealpath.mockImplementation(async (pathname: string) => {
      if (pathname === "/workspace/test-agent") {
        throw resolutionError;
      }
      return pathname;
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await expect(promise).rejects.toBe(resolutionError);

    expect(respond).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("recovers against the persisted target when a workspace symlink is retargeted", async () => {
    const workspaceLink = "/tmp-root/workspace-link";
    const originalTarget = "/real-tmp/original-workspace";
    const retargetedWorkspace = "/real-tmp/replacement-workspace";
    const missingTranscriptTarget = `${originalTarget}/transcripts`;
    const journal = {
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: `${workspaceLink}/agent`,
      workspaceDir: workspaceLink,
      sessionsDir: `${workspaceLink}/transcripts`,
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    };
    const trashed = new Set<string>();
    let workspaceAttempts = 0;
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === journal.agentDir ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.replace(workspaceLink, originalTarget),
    );
    mocks.fsRealpath.mockImplementation(async (pathname: string) => {
      if (pathname === journal.sessionsDir) {
        throw createEnoentError();
      }
      return pathname.replace(workspaceLink, originalTarget);
    });
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (
        pathname === journal.sessionsDir ||
        pathname === missingTranscriptTarget ||
        trashed.has(String(pathname))
      ) {
        throw createEnoentError();
      }
      return {
        isSymbolicLink: () => pathname === workspaceLink,
      } as unknown as import("node:fs").Stats;
    });
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === originalTarget && workspaceAttempts++ === 0) {
        throw new Error("workspace trash failed");
      }
      trashed.add(pathname ?? "");
      return "/trashed";
    });

    const firstDelete = makeCall("agents.delete", { agentId: "test-agent" });
    await firstDelete.promise;

    expectRespondOk(firstDelete.respond, {
      failed: [{ path: originalTarget, reason: "workspace trash failed" }],
    });
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(journal).toHaveProperty("cleanupPaths");

    mocks.fsRealpath.mockClear();
    mocks.fsRealpath.mockImplementation(async (pathname: string) =>
      pathname.replace(workspaceLink, retargetedWorkspace),
    );
    const recovery = makeCall("agents.delete", { agentId: "test-agent" });
    await recovery.promise;

    expectRespondOk(recovery.respond, { failed: [] });
    expect(mocks.fsRealpath).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(retargetedWorkspace);
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith(`${retargetedWorkspace}/transcripts`);
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(originalTarget);
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(workspaceLink);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not follow a retargeted canonical ancestor during recovery", async () => {
    const canonicalRoot = "/canonical/deleted";
    const unrelatedRoot = "/unrelated/current";
    const workspaceDir = "/linked/workspace";
    const journal = {
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: `${workspaceDir}/agent`,
      workspaceDir,
      sessionsDir: `${workspaceDir}/transcripts`,
      cleanupPaths: [
        {
          path: `${canonicalRoot}/workspace/agent`,
          canonicalPath: `${canonicalRoot}/workspace/agent`,
          parentPath: `${canonicalRoot}/workspace`,
          kind: "target" as const,
          sourcePaths: [`${workspaceDir}/agent`],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: `${canonicalRoot}/workspace/transcripts`,
          canonicalPath: `${canonicalRoot}/workspace/transcripts`,
          parentPath: `${canonicalRoot}/workspace`,
          kind: "target" as const,
          sourcePaths: [`${workspaceDir}/transcripts`],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
        {
          path: `${canonicalRoot}/workspace`,
          canonicalPath: `${canonicalRoot}/workspace`,
          parentPath: canonicalRoot,
          kind: "target" as const,
          sourcePaths: [workspaceDir],
          dev: null,
          ino: null,
          coversDescendants: true,
          done: false,
        },
      ],
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    };
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue(journal);
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === journal.agentDir ? "test-agent" : undefined,
    );
    agentsTesting.setDepsForTests({
      root: (async (rootDir: string) => ({
        rootReal: rootDir.startsWith(canonicalRoot)
          ? rootDir.replace(canonicalRoot, unrelatedRoot)
          : rootDir,
        stat: async (relativePath: string) => await mocks.rootStat({ rootDir, relativePath }),
      })) as never,
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    const result = expectRespondOk(respond, {});
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "cleanup path parent changed before deletion" }),
      ]),
    );
    expect(
      mocks.movePathToTrash.mock.calls.some(([pathname]) =>
        String(pathname).startsWith(unrelatedRoot),
      ),
    ).toBe(false);
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("reclaims durable journal ownership after a process restart", async () => {
    const directoryOwners = new Map<string, string>();
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      directoryOwners.get(pathname ?? ""),
    );
    mocks.registerResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        directoryOwners.set(agentDir, agentId);
      },
    );
    mocks.unregisterResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        if (directoryOwners.get(agentDir) !== agentId) {
          return false;
        }
        return directoryOwners.delete(agentDir);
      },
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.registerResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/journal/agent",
    });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
    );
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/journal/agent");
    expect(directoryOwners.has("/journal/agent")).toBe(false);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("settles recovery without touching a journaled directory claimed by another agent", async () => {
    const directoryOwners = new Map([["/journal/agent", "other-agent"]]);
    const databaseRows = [
      { agentId: "test-agent", path: "/journal/agent/openclaw-agent.sqlite" },
      { agentId: "other-agent", path: "/journal/agent/openclaw-agent.sqlite" },
    ];
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      directoryOwners.get(pathname ?? ""),
    );
    mocks.isPathOwnedByAnotherRegisteredAgent.mockImplementation(
      ({ agentId, pathname }: { agentId: string; pathname: string }) =>
        (pathname === "/journal/agent" || pathname.startsWith("/journal/agent/")) &&
        directoryOwners.get("/journal/agent") !== agentId,
    );
    mocks.unregisterResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        if (directoryOwners.get(agentDir) !== agentId) {
          return false;
        }
        return directoryOwners.delete(agentDir);
      },
    );
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() => databaseRows);
    mocks.unregisterOpenClawAgentDatabase.mockImplementation(
      ({ agentId, path: databasePath }: { agentId: string; path: string }) => {
        const index = databaseRows.findIndex(
          (entry) => entry.agentId === agentId && entry.path === databasePath,
        );
        if (index >= 0) {
          databaseRows.splice(index, 1);
        }
      },
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.listOpenClawRegisteredAgentDatabases).toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalled();
    expect(mocks.assertNoOpenClawAgentDatabaseLeases).toHaveBeenCalledWith("test-agent");
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal/agent");
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/journal/agent/openclaw-agent.sqlite",
    });
    expect(databaseRows).toEqual([
      { agentId: "other-agent", path: "/journal/agent/openclaw-agent.sqlite" },
    ]);
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/journal/agent",
    });
    expect(directoryOwners.get("/journal/agent")).toBe("other-agent");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("revalidates database ownership after earlier filesystem cleanup", async () => {
    let claimed = false;
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() =>
      claimed ? [{ agentId: "other-agent", path: "/journal/agent/survivor.sqlite" }] : [],
    );
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/journal/agent/openclaw-agent.sqlite") {
        claimed = true;
      }
      return "/trashed";
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/journal/agent/openclaw-agent.sqlite");
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/journal/workspace");
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal/agent");
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal/agent/survivor.sqlite");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("cleans a relocated deleted-agent database while preserving a claimed agent directory", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === "/journal/agent" ? "other-agent" : undefined,
    );
    mocks.isPathOwnedByAnotherRegisteredAgent.mockImplementation(
      ({ pathname }: { agentId: string; pathname: string }) =>
        pathname === "/journal/agent" || pathname.startsWith("/journal/agent/"),
    );
    mocks.listOpenClawRegisteredAgentDatabases.mockReturnValue([
      { agentId: "other-agent", path: "/journal/agent/openclaw-agent.sqlite" },
      { agentId: "test-agent", path: "/relocated/deleted.sqlite" },
    ]);

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(1);
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/relocated/deleted.sqlite",
    );
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/relocated/deleted.sqlite",
    });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal/agent");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("protects every journaled path claimed as a surviving agent workspace", async () => {
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "other-agent", workspace: "/journal" }] },
    };
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("preserves a relocated database path registered to another agent", async () => {
    const databaseRows = [
      { agentId: "test-agent", path: "/linked/shared/agent.sqlite" },
      { agentId: "other-agent", path: "/real/shared/agent.sqlite" },
    ];
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname.startsWith("/linked/shared/")
        ? pathname.replace("/linked/shared/", "/real/shared/")
        : path.resolve(pathname),
    );
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() => databaseRows);
    mocks.unregisterOpenClawAgentDatabase.mockImplementation(
      ({ agentId, path: databasePath }: { agentId: string; path: string }) => {
        const index = databaseRows.findIndex(
          (entry) => entry.agentId === agentId && entry.path === databasePath,
        );
        if (index >= 0) {
          databaseRows.splice(index, 1);
        }
      },
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(1);
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalledWith(
      "/linked/shared/agent.sqlite",
    );
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/linked/shared/agent.sqlite");
    expect(databaseRows).toEqual([{ agentId: "other-agent", path: "/real/shared/agent.sqlite" }]);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("preserves a parent directory containing another agent's relocated database", async () => {
    mocks.listOpenClawRegisteredAgentDatabases.mockReturnValue([
      { agentId: "other-agent", path: "/agents/test-agent/survivor.sqlite" },
    ]);

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
    );
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/agents/test-agent");
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/agents/test-agent/openclaw-agent.sqlite");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("does not close a database whose companion file is registered to another agent", async () => {
    mocks.listOpenClawRegisteredAgentDatabases.mockReturnValue([
      { agentId: "test-agent", path: "/shared/deleted.sqlite" },
      { agentId: "other-agent", path: "/shared/deleted.sqlite-wal" },
    ]);

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalledWith(
      "/shared/deleted.sqlite",
    );
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/shared/deleted.sqlite-wal");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("drops stale deleted ownership when overlap intentionally skips directory cleanup", async () => {
    const directoryOwners = new Map([
      ["/journal/agent", "test-agent"],
      ["/journal/agent/current", "other-agent"],
    ]);
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      directoryOwners.get(pathname ?? ""),
    );
    mocks.isPathOwnedByAnotherRegisteredAgent.mockImplementation(
      ({ agentId, pathname }: { agentId: string; pathname: string }) =>
        pathname === "/journal/agent" && directoryOwners.get("/journal/agent/current") !== agentId,
    );
    mocks.unregisterResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) => {
        if (directoryOwners.get(agentDir) !== agentId) {
          return false;
        }
        return directoryOwners.delete(agentDir);
      },
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/journal/agent");
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
    );
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/journal/agent/openclaw-agent.sqlite",
    });
    expect(directoryOwners.has("/journal/agent")).toBe(false);
    expect(directoryOwners.get("/journal/agent/current")).toBe("other-agent");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("unregisters the captured canonical directory after trashing a symlink path", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/linked-agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: true,
    });
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      pathname === "/journal/linked-agent" ? "test-agent" : undefined,
    );
    mocks.normalizeAgentDirRegistryPath.mockImplementation((pathname: string) =>
      pathname === "/journal/linked-agent" ? "/canonical/agent" : pathname,
    );

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/canonical/agent",
    });
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("preserves the original keep-files intent while recovering deletion", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "delete-1",
      agentDir: "/journal/agent",
      workspaceDir: "/journal/workspace",
      sessionsDir: "/journal/sessions",
      createdAt: 1,
      cleanupCompleted: false,
      deleteFiles: false,
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("uses the new request intent when deleting a recreated roster entry", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      agentId: "test-agent",
      operationId: "old-delete",
      agentDir: "/old/agent",
      workspaceDir: "/old/workspace",
      sessionsDir: "/old/sessions",
      createdAt: 1,
      cleanupCompleted: true,
      deleteFiles: true,
    });

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledWith("test-agent", "old-delete");
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
  });

  it("releases cleaned directory ownership while a sibling Trash cleanup remains fenced", async () => {
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/workspace/test-agent") {
        throw new Error("trash unavailable");
      }
      return "/trashed";
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.beginAgentDeletionCommit).toHaveBeenCalledOnce();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/agents/test-agent",
    });
  });

  it("keeps directory ownership registered when that Trash cleanup fails", async () => {
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/agents/test-agent") {
        throw new Error("trash unavailable");
      }
      return "/trashed";
    });

    const { respond, promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.unregisterResolvedAgentDir).not.toHaveBeenCalled();
  });

  it("unregisters a closed database row after committing deletion", async () => {
    mocks.closeOpenClawAgentDatabaseByPath.mockReturnValueOnce(false);

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/agents/test-agent/openclaw-agent.sqlite",
    });
    expect(mocks.writeConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        mocks.unregisterOpenClawAgentDatabase.mock.invocationCallOrder[0],
        "database unregister call order",
      ),
    );
  });

  it("closes and archives every registered database path owned by the deleted agent", async () => {
    mocks.listOpenClawRegisteredAgentDatabases.mockReturnValue([
      { agentId: "test-agent", path: "/relocated/test-agent.sqlite" },
      { agentId: "other-agent", path: "/relocated/other-agent.sqlite" },
    ]);

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/relocated/test-agent.sqlite",
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalledWith(
      "/relocated/other-agent.sqlite",
    );
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/relocated/test-agent.sqlite");
    expect(mocks.unregisterOpenClawAgentDatabase).toHaveBeenCalledWith({
      agentId: "test-agent",
      path: "/relocated/test-agent.sqlite",
    });
  });

  it("retains relocated database ownership when its Trash archival fails", async () => {
    mocks.listOpenClawRegisteredAgentDatabases.mockReturnValue([
      { agentId: "test-agent", path: "/relocated/test-agent.sqlite" },
    ]);
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === "/relocated/test-agent.sqlite") {
        throw new Error("relocated trash failed");
      }
      return "/trashed";
    });

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });
    await promise;

    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("deletes an existing agent and trashes files by default", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    const result = expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      removedBindings: 2,
      failed: [],
    });
    expect(result.removed).toEqual(
      expect.arrayContaining([
        { path: "/workspace/test-agent", method: "trash" },
        { path: "/agents/test-agent", method: "trash" },
        { path: "/transcripts/test-agent", method: "trash" },
      ]),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalled();
    expect(mocks.movePathToTrash).toHaveBeenCalled();
  });

  it("deletes workspace state after removing the last owner's workspace", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/workspace/test-agent");
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({
      workspaceDir: "/workspace/test-agent",
    });
  });

  it("trashes a dangling workspace symlink before deleting its state", async () => {
    mocks.fsAccess.mockRejectedValueOnce(
      Object.assign(new Error("missing target"), { code: "ENOENT" }),
    );

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.movePathToTrash).toHaveBeenCalledWith("/workspace/test-agent");
    expect(mocks.deleteWorkspaceState).toHaveBeenCalled();
  });

  it("keeps workspace state when another agent still owns the workspace", async () => {
    mocks.pruneAgentConfig.mockReturnValue({
      config: { agents: { list: [{ id: "other", workspace: "/workspace/test-agent" }] } },
      removedBindings: 2,
    });

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expectRespondOk(respond, { ok: true });
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/workspace/test-agent");
  });

  it("reports trash failures without deleting the retained directory", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const workspaceDir = await actualFs.realpath(
      await actualFs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-delete-trash-failure-")),
    );
    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    mocks.movePathToTrash.mockImplementation(async (pathname?: string) => {
      if (pathname === workspaceDir) {
        throw Object.assign(new Error("trash destination missing"), { code: "ENOENT" });
      }
      return "/trashed";
    });

    try {
      const { respond, promise } = makeCall("agents.delete", {
        agentId: "test-agent",
      });
      await promise;

      expectRespondOk(respond, {
        failed: [{ path: workspaceDir, reason: "trash destination missing" }],
      });
      await expect(actualFs.stat(workspaceDir)).resolves.toBeDefined();
      expect(mocks.fsRm).not.toHaveBeenCalled();
      expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    } finally {
      await actualFs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reports an absent source without invoking the trash backend", async () => {
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname === "/workspace/test-agent") {
        throw createEnoentError();
      }
      return null as unknown as import("node:fs").Stats;
    });

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    const result = expectRespondOk(respond, { failed: [] });
    expect(result.removed).toEqual(
      expect.arrayContaining([{ path: "/workspace/test-agent", method: "missing" }]),
    );
    expect(mocks.movePathToTrash).not.toHaveBeenCalledWith("/workspace/test-agent");
    expect(mocks.deleteWorkspaceState).toHaveBeenCalled();
  });

  it("does not commit deletion when workspace presence cannot be checked", async () => {
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mocks.fsLstat.mockImplementation(async (pathname: unknown) => {
      if (pathname === "/workspace/test-agent") {
        throw permissionError;
      }
      return null as unknown as import("node:fs").Stats;
    });

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await expect(promise).rejects.toBe(permissionError);

    expect(respond).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
  });

  it("skips file deletion when deleteFiles is false", async () => {
    mocks.fsLstat.mockClear();
    mocks.movePathToTrash.mockClear();

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expectRespondOk(respond, { ok: true });
    // No filesystem cleanup should run.
    expect(mocks.fsLstat).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenClawAgentDatabase).not.toHaveBeenCalled();
  });

  it("rejects deleting the main agent", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "main",
    });
    await promise;

    expectRespondErrorContaining(respond, "cannot be deleted");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects deleting a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "ghost",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("returns not found when a concurrent delete wins the delete race", async () => {
    let findCallCount = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      findCallCount += 1;
      return findCallCount >= 2 ? -1 : 0;
    });

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("rejects invalid params (missing agentId)", async () => {
    const { respond, promise } = makeCall("agents.delete", {});
    await promise;

    expectRespondErrorContaining(respond, "invalid");
  });
});

describe("agents.files.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.isWorkspaceSetupCompleted.mockReset().mockResolvedValue(false);
    mocks.fsReadlink.mockReset().mockResolvedValue("");
  });

  it("includes BOOTSTRAP.md when setup has not completed", async () => {
    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("hides BOOTSTRAP.md when workspace setup is complete", async () => {
    mockWorkspaceStateRead({ setupCompletedAt: "2026-02-15T14:00:00.000Z" });

    const names = await listAgentFileNames();
    expect(names).not.toContain("BOOTSTRAP.md");
  });

  it("falls back to showing BOOTSTRAP.md when workspace state cannot be read", async () => {
    mockWorkspaceStateRead({ errorCode: "EACCES" });

    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("falls back to showing BOOTSTRAP.md when workspace state is malformed JSON", async () => {
    mockWorkspaceStateRead({ rawContent: "{" });

    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("reports unreadable workspace files as present in list responses", async () => {
    const rootOpen = vi.fn(async () => {
      throw createErrnoError("EACCES");
    });
    const rootStat = vi.fn(async ({ relativePath }: Record<string, unknown>) => {
      if (relativePath === "AGENTS.md") {
        return {
          isFile: true,
          isSymbolicLink: false,
          mtimeMs: 4567,
          nlink: 1,
          size: 17,
        };
      }
      throw createEnoentError();
    });
    agentsTesting.setDepsForTests({ root: makeRootForTest({ open: rootOpen, stat: rootStat }) });

    const { respond, promise } = makeCall("agents.files.list", { agentId: "main" });
    await promise;

    const result = firstRespondResult(respond);
    const files = (result as { files: Array<{ name: string; missing: boolean; size?: number }> })
      .files;
    const file = files.find((entry) => entry.name === "AGENTS.md");
    expectRecordFields(file, {
      name: "AGENTS.md",
      missing: false,
      size: 17,
    });
    expect(rootOpen).not.toHaveBeenCalled();
  });

  it("falls back to fixed-path lstat when safe stat is unavailable", async () => {
    const rootStat = vi.fn(async () => {
      throw createErrnoError("helper-unavailable");
    });
    agentsTesting.setDepsForTests({ root: makeRootForTest({ stat: rootStat }) });
    mocks.fsLstat.mockImplementation(async (filePath: unknown) => {
      if (filePath === "/workspace/main/AGENTS.md") {
        return makeFileStat({ size: 23, mtimeMs: 6789 });
      }
      throw createEnoentError();
    });

    const { respond, promise } = makeCall("agents.files.list", { agentId: "main" });
    await promise;

    const result = firstRespondResult(respond);
    const files = (result as { files: Array<{ name: string; missing: boolean; size?: number }> })
      .files;
    const file = files.find((entry) => entry.name === "AGENTS.md");
    expectRecordFields(file, {
      name: "AGENTS.md",
      missing: false,
      size: 23,
    });
    expect(rootStat).toHaveBeenCalled();
  });
});

describe("agents.files.get/set symlink safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      agents: {
        list: [{ id: "main", workspace: "/workspace/test-agent" }],
      },
    };
    mocks.fsMkdir.mockResolvedValue(undefined);
  });

  function mockWorkspaceEscapeSymlink() {
    const safeOpenError = new FsSafeError("invalid-path", "path escapes workspace root");
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        open: async () => {
          throw safeOpenError;
        },
        read: async () => {
          throw safeOpenError;
        },
      }),
    });
    mocks.rootWrite.mockRejectedValue(safeOpenError);
  }

  function mockInWorkspaceSymlinkAlias() {
    const safeOpenError = new FsSafeError("invalid-path", "path is not a regular file under root");
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        open: async () => {
          throw safeOpenError;
        },
        read: async () => {
          throw safeOpenError;
        },
      }),
    });
    mocks.rootWrite.mockRejectedValue(safeOpenError);
  }

  it.each([
    { method: "agents.files.get" as const, expectNoOpen: false },
    { method: "agents.files.set" as const, expectNoOpen: true },
  ])(
    "rejects $method when allowlisted file symlink escapes workspace",
    async ({ method, expectNoOpen }) => {
      mockWorkspaceEscapeSymlink();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["agents.files.get", "agents.files.set"] as const)(
    "rejects %s when allowlisted file is an in-workspace symlink alias",
    async (method) => {
      mockInWorkspaceSymlinkAlias();
      await expectUnsafeWorkspaceFile(method);
    },
  );

  function mockHardlinkedWorkspaceAlias() {
    const safeOpenError = new FsSafeError("invalid-path", "hardlinked path not allowed");
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        open: async () => {
          throw safeOpenError;
        },
        read: async () => {
          throw safeOpenError;
        },
      }),
    });
    mocks.rootWrite.mockRejectedValue(safeOpenError);
  }

  it.each([
    { method: "agents.files.get" as const, expectNoOpen: false },
    { method: "agents.files.set" as const, expectNoOpen: true },
  ])(
    "rejects $method when allowlisted file is a hardlinked alias",
    async ({ method, expectNoOpen }) => {
      mockHardlinkedWorkspaceAlias();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );

  it("uses non-blocking safe reads for agents.files.get", async () => {
    const rootRead = vi.fn(async () => ({
      buffer: Buffer.from("hello"),
      realPath: "/workspace/test-agent/AGENTS.md",
      stat: makeFileStat({ size: 5 }),
    }));
    agentsTesting.setDepsForTests({ root: makeRootForTest({ read: rootRead }) });

    const { respond, promise } = makeCall("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });
    await promise;

    expectRecordFields(mockCallArg(rootRead), {
      rootDir: "/workspace/test-agent",
      relativePath: "AGENTS.md",
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    const payload = expectRespondOk(respond, {});
    expectRecordFields(payload.file, {
      name: "AGENTS.md",
      content: "hello",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
