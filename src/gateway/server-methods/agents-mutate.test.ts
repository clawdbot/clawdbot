import { describe, expect, it, vi, beforeEach } from "vitest";
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
  ensureAgentWorkspace: vi.fn(
    async (params?: { dir?: string }): Promise<{ dir: string; identityPathCreated: boolean }> => ({
      dir: params?.dir
        ? `/resolved${params.dir.startsWith("/") ? "" : "/"}${params.dir}`
        : "/resolved/workspace",
      identityPathCreated: false,
    }),
  ),
  isWorkspaceSetupCompleted: vi.fn(async () => false),
  resolveAgentDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/agents/test-agent"),
  resolveAgentWorkspaceDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/workspace/test-agent"),
  resolveSessionTranscriptsDirForAgent: vi.fn((_agentId?: string) => "/transcripts/test-agent"),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [],
  })),
  movePathToTrash: vi.fn(async () => "/trashed"),
  fsAccess: vi.fn(async () => {}),
  fsMkdir: vi.fn(async () => undefined),
  fsAppendFile: vi.fn(async () => {}),
  fsReadFile: vi.fn(async () => ""),
  fsStat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsLstat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsRealpath: vi.fn(async (p: string) => p),
  fsReadlink: vi.fn(async () => ""),
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

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mocks.loadConfigReturn,
    writeConfigFile: mocks.writeConfigFile,
    replaceConfigFile: async (params: { nextConfig: unknown }) =>
      await mocks.writeConfigFile(params.nextConfig),
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
    open: mocks.fsOpen,
  };
  return { ...patched, default: patched };
});

/* ------------------------------------------------------------------ */
/* Import after mocks are set up                                      */
/* ------------------------------------------------------------------ */

const { __testing: agentsTesting, agentsHandlers } = await import("./agents.js");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  agentsTesting.resetDepsForTests();
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
  mocks.rootStat.mockResolvedValue({
    isFile: true,
    isSymbolicLink: false,
    mtimeMs: 0,
    nlink: 1,
    size: 0,
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
  const handler = agentsHandlers[method];
  const promise = handler({
    params,
    respond,
    context: { getRuntimeConfig: () => mocks.loadConfigReturn } as never,
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

function expectStringContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).toContain(text);
}

function expectStringNotContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).not.toContain(text);
}

function findMockCallArg(
  mock: ReturnType<typeof vi.fn>,
  predicate: (arg: Record<string, unknown>) => boolean,
  argIndex = 0,
) {
  const call = mock.mock.calls.find((candidate) => {
    const arg = candidate[argIndex];
    return typeof arg === "object" && arg !== null && predicate(arg as Record<string, unknown>);
  });
  if (!call) {
    throw new Error("Expected matching mock call");
  }
  return call[argIndex];
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
    model?: string;
    identity?: MockIdentity;
  }) ?? { agentId: "" };
  const list = getAgentList(config);
  const agentId = params.agentId ?? "";
  const index = list.findIndex((entry) => entry.id === agentId);
  const base = index >= 0 ? list[index] : { id: agentId };
  const nextEntry: MockAgentEntry = {
    ...base,
    ...(params.name ? { name: params.name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.identity ? { identity: { ...base.identity, ...params.identity } } : {}),
  };
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

  const [, result] = respond.mock.calls.at(0) ?? [];
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
    mocks.findAgentEntryIndex.mockReturnValue(-1);
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

  it("ensures workspace is set up before writing config", async () => {
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

  it("does not persist config when IDENTITY.md write fails with FsSafeError", async () => {
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
  });

  it("does not persist config when IDENTITY.md read fails", async () => {
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        read: async () => {
          throw createErrnoError("EACCES");
        },
      }),
    });
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/tmp/ws",
      identityPathCreated: false,
    });

    const { promise } = makeCall("agents.create", {
      name: "Unreadable Identity",
      workspace: "/tmp/ws",
    });

    await expect(promise).rejects.toHaveProperty("code", "EACCES");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.rootWrite).not.toHaveBeenCalled();
  });

  it("treats unsafe IDENTITY.md reads as invalid create requests", async () => {
    agentsTesting.setDepsForTests({
      root: makeRootForTest({
        read: async () => {
          throw new FsSafeError("invalid-path", "path is not a regular file under root");
        },
      }),
    });

    const { respond, promise } = makeCall("agents.create", {
      name: "Unsafe Identity Read",
      workspace: "/tmp/ws",
    });
    await promise;

    expectRespondErrorContaining(respond, 'unsafe workspace file "IDENTITY.md"');
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.rootWrite).not.toHaveBeenCalled();
  });

  it("uses non-blocking reads for IDENTITY.md during agents.create", async () => {
    const rootRead = vi.fn(async () => {
      throw new FsSafeError("not-found", "file not found");
    });
    agentsTesting.setDepsForTests({ root: makeRootForTest({ read: rootRead }) });

    const { promise } = makeCall("agents.create", {
      name: "NB Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expectRecordFields(mockCallArg(rootRead), {
      relativePath: "IDENTITY.md",
      nonBlockingRead: true,
    });
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
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.pruneAgentConfig.mockReturnValue({ config: {}, removedBindings: 2 });
  });

  it("deletes an existing agent and trashes files by default", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, agentId: "test-agent", removedBindings: 2 },
      undefined,
    );
    expect(mocks.writeConfigFile).toHaveBeenCalled();
    // moveToTrashBestEffort calls fs.access then movePathToTrash for each dir
    expect(mocks.movePathToTrash).toHaveBeenCalled();
  });

  it("skips file deletion when deleteFiles is false", async () => {
    mocks.fsAccess.mockClear();

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expectRespondOk(respond, { ok: true });
    // moveToTrashBestEffort should not be called at all
    expect(mocks.fsAccess).not.toHaveBeenCalled();
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

    const [, result] = respond.mock.calls.at(0) ?? [];
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

    const [, result] = respond.mock.calls.at(0) ?? [];
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
