import { describe, expect, it, vi, beforeEach } from "vitest";
import { SafeOpenError } from "../../infra/fs-safe.js";
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
  writeFileWithinRoot: vi.fn(async () => {}),
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
    writeFileWithinRoot: mocks.writeFileWithinRoot,
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
  mocks.writeFileWithinRoot.mockResolvedValue(undefined);
});

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

  const [, result] = respond.mock.calls[0] ?? [];
  const files = (result as { files: Array<{ name: string }> }).files;
  return files.map((file) => file.name);
}

function expectNotFoundResponseAndNoWrite(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("not found") }),
  );
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
}

async function expectUnsafeWorkspaceFile(method: "agents.files.get" | "agents.files.set") {
  const params =
    method === "agents.files.set"
      ? { agentId: "main", name: "AGENTS.md", content: "x" }
      : { agentId: "main", name: "AGENTS.md" };
  const { respond, promise } = makeCall(method, params);
  await promise;
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
  );
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

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        agentId: "test-agent",
        name: "Test Agent",
      }),
      undefined,
    );
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

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("reserved") }),
    );
  });

  it("rejects creating a duplicate agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(0);

    const { respond, promise } = makeCall("agents.create", {
      name: "Existing",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("already exists") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects invalid params (missing name)", async () => {
    const { respond, promise } = makeCall("agents.create", {
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
  });

  it("writes identity to both config and IDENTITY.md", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Plain Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ name: "Plain Agent" }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/resolved/tmp/ws",
        relativePath: "IDENTITY.md",
        data: expect.stringContaining("- Name: Plain Agent"),
      }),
    );
  });

  it("writes emoji and avatar to both config and IDENTITY.md", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Fancy Agent",
      workspace: "/tmp/ws",
      emoji: "🤖",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({
          name: "Fancy Agent",
          emoji: "🤖",
          avatar: "https://example.com/avatar.png",
        }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/resolved/tmp/ws",
        relativePath: "IDENTITY.md",
        data: expect.stringMatching(/- Name: Fancy Agent[\s\S]*- Emoji: 🤖[\s\S]*- Avatar:/),
      }),
    );
  });

  it("does not persist config when IDENTITY.md write fails with SafeOpenError", async () => {
    mocks.writeFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.create", {
      name: "Unsafe Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not persist config when IDENTITY.md read fails", async () => {
    agentsTesting.setDepsForTests({
      readFileWithinRoot: async () => {
        throw createErrnoError("EACCES");
      },
    });
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/tmp/ws",
      identityPathCreated: false,
    });

    const { promise } = makeCall("agents.create", {
      name: "Unreadable Identity",
      workspace: "/tmp/ws",
    });

    await expect(promise).rejects.toMatchObject({ code: "EACCES" });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalled();
  });

  it("treats unsafe IDENTITY.md reads as invalid create requests", async () => {
    agentsTesting.setDepsForTests({
      readFileWithinRoot: async () => {
        throw new SafeOpenError("invalid-path", "path is not a regular file under root");
      },
    });

    const { respond, promise } = makeCall("agents.create", {
      name: "Unsafe Identity Read",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining('unsafe workspace file "IDENTITY.md"'),
      }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalled();
  });

  it("uses non-blocking reads for IDENTITY.md during agents.create", async () => {
    const readFileWithinRoot = vi.fn(async () => {
      throw new SafeOpenError("not-found", "file not found");
    });
    agentsTesting.setDepsForTests({ readFileWithinRoot });

    const { promise } = makeCall("agents.create", {
      name: "NB Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(readFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "IDENTITY.md",
        nonBlockingRead: true,
      }),
    );
  });

  it("passes model to applyAgentConfig when provided", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "Model Agent",
      workspace: "/tmp/ws",
      model: "sonnet-4.6",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, model: "sonnet-4.6" }),
      undefined,
    );
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "sonnet-4.6" }),
    );
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

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({
          avatar: "https://example.com/avatar.png",
        }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
        data: expect.stringMatching(
          /- Name: Current Agent[\s\S]*- Theme: steady[\s\S]*- Emoji: 🐢[\s\S]*- Avatar: https:\/\/example\.com\/avatar\.png/,
        ),
      }),
    );
  });

  it("writes merged identity to IDENTITY.md when only emoji changes", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      emoji: "🦀",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ emoji: "🦀" }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
        data: expect.stringMatching(
          /- Name: Current Agent[\s\S]*- Theme: steady[\s\S]*- Emoji: 🦀/,
        ),
      }),
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

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "New Name",
        identity: expect.objectContaining({
          name: "New Name",
          emoji: "🤖",
          avatar: "https://example.com/new.png",
        }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
        data: expect.stringMatching(
          /- Name: New Name[\s\S]*- Theme: steady[\s\S]*- Emoji: 🤖[\s\S]*- Avatar: https:\/\/example\.com\/new\.png/,
        ),
      }),
    );
  });

  it("syncs existing identity into a new workspace even without identity params", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/new/workspace",
      identityPathCreated: true,
    });
    agentsTesting.setDepsForTests({
      readFileWithinRoot: async ({ rootDir, relativePath }) => {
        const filePath = `${rootDir}/${relativePath}`;
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
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/resolved/new/workspace",
        relativePath: "IDENTITY.md",
        data: expect.stringContaining("- **Creature:** Steady Turtle"),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("## Role"),
      }),
    );
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("Flustered Protocol Droid"),
      }),
    );
  });

  it("preserves an existing destination identity file when workspace changes", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/new/workspace",
      identityPathCreated: false,
    });
    agentsTesting.setDepsForTests({
      readFileWithinRoot: async ({ rootDir, relativePath }) => {
        const filePath = `${rootDir}/${relativePath}`;
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
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/resolved/new/workspace",
        relativePath: "IDENTITY.md",
        data: expect.stringContaining("- **Creature:** Destination Fox"),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("Destination workspace role."),
      }),
    );
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("Old workspace role."),
      }),
    );
  });

  it("does not persist config when IDENTITY.md write fails on update", async () => {
    mocks.writeFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Bad Update",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("treats unsafe IDENTITY.md reads as invalid update requests", async () => {
    agentsTesting.setDepsForTests({
      readFileWithinRoot: async () => {
        throw new SafeOpenError("invalid-path", "path is not a regular file under root");
      },
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/unsafe.png",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining('unsafe workspace file "IDENTITY.md"'),
      }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalled();
  });

  it("uses non-blocking reads for IDENTITY.md during agents.update", async () => {
    const readFileWithinRoot = vi.fn(async () => {
      throw new SafeOpenError("not-found", "file not found");
    });
    agentsTesting.setDepsForTests({ readFileWithinRoot });

    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Updated NB",
    });
    await promise;

    expect(readFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "IDENTITY.md",
        nonBlockingRead: true,
      }),
    );
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

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    // moveToTrashBestEffort should not be called at all
    expect(mocks.fsAccess).not.toHaveBeenCalled();
  });

  it("rejects deleting the main agent", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "main",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("cannot be deleted") }),
    );
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

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
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
    const openFileWithinRoot = vi.fn(async () => {
      throw createErrnoError("EACCES");
    });
    agentsTesting.setDepsForTests({ openFileWithinRoot });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "/workspace/main/AGENTS.md") {
        return makeFileStat({ size: 17, mtimeMs: 4567 });
      }
      throw createEnoentError();
    });
    mocks.fsStat.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "/workspace/main/AGENTS.md") {
        return makeFileStat({ size: 17, mtimeMs: 4567 });
      }
      throw createEnoentError();
    });

    const { respond, promise } = makeCall("agents.files.list", { agentId: "main" });
    await promise;

    const [, result] = respond.mock.calls[0] ?? [];
    const files = (result as { files: Array<{ name: string; missing: boolean; size?: number }> })
      .files;
    expect(files).toContainEqual(
      expect.objectContaining({
        name: "AGENTS.md",
        missing: false,
        size: 17,
      }),
    );
    expect(openFileWithinRoot).not.toHaveBeenCalled();
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
    const safeOpenError = new SafeOpenError("invalid-path", "path escapes workspace root");
    agentsTesting.setDepsForTests({
      openFileWithinRoot: async () => {
        throw safeOpenError;
      },
      readFileWithinRoot: async () => {
        throw safeOpenError;
      },
    });
    mocks.writeFileWithinRoot.mockRejectedValue(safeOpenError);
  }

  function mockInWorkspaceSymlinkAlias() {
    const safeOpenError = new SafeOpenError(
      "invalid-path",
      "path is not a regular file under root",
    );
    agentsTesting.setDepsForTests({
      openFileWithinRoot: async () => {
        throw safeOpenError;
      },
      readFileWithinRoot: async () => {
        throw safeOpenError;
      },
    });
    mocks.writeFileWithinRoot.mockRejectedValue(safeOpenError);
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
    const safeOpenError = new SafeOpenError("invalid-path", "hardlinked path not allowed");
    agentsTesting.setDepsForTests({
      openFileWithinRoot: async () => {
        throw safeOpenError;
      },
      readFileWithinRoot: async () => {
        throw safeOpenError;
      },
    });
    mocks.writeFileWithinRoot.mockRejectedValue(safeOpenError);
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
    const readFileWithinRoot = vi.fn(async () => ({
      buffer: Buffer.from("hello"),
      realPath: "/workspace/test-agent/AGENTS.md",
      stat: makeFileStat({ size: 5 }),
    }));
    agentsTesting.setDepsForTests({ readFileWithinRoot });

    const { respond, promise } = makeCall("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });
    await promise;

    expect(readFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/workspace/test-agent",
        relativePath: "AGENTS.md",
        rejectHardlinks: true,
        nonBlockingRead: true,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: expect.objectContaining({
          name: "AGENTS.md",
          content: "hello",
        }),
      }),
      undefined,
    );
  });
});
