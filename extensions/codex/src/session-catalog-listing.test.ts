// Codex supervision tests cover passive listing and safe local session takeover.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tempDirs,
  createCodexSessionCatalogControl,
  listCodexSessionCatalog,
  registerCodexSessionCatalog,
  config,
  compatibilityOwnerConfig,
  normalizeCodexManifestConfig,
  idleThread,
  createControl,
  adoptedEntry,
  supervisionSessionKey,
  seedSupervisionBinding,
  createRuntime,
  createGatewayApi,
  fs,
  fsSync,
  os,
  path,
  resolveAgentDir,
  resolveSessionAgentIds,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
  resolveDefaultAgentDir,
  withEnvAsync,
  createCodexCatalogHomeResolver,
  createCodexTestBindingStore,
  buildCodexAppServerConnectionFingerprint,
  catalogError,
  parseCatalogPage,
  CODEX_LOCAL_SESSION_HOST_ID,
  createCodexSessionCatalogControlFactory,
  type CodexCatalogHome,
  type OpenClawConfig,
  originalPath,
} from "./session-catalog.test-helpers.js";

const commandRpcMocks = vi.hoisted(() => ({
  codexControlRequest: vi.fn(),
}));
const pinnedConnectionMocks = vi.hoisted(() => ({
  client: { connectionId: "pinned-catalog-client" },
  getClient: vi.fn(),
  releaseClient: vi.fn(),
  request: vi.fn(),
}));
const transcriptMirrorMocks = vi.hoisted(() => ({
  importCodexThreadHistoryToTranscript: vi.fn(async () => ({
    importedMessages: 0,
    omittedMessages: 0,
  })),
}));
const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
  userShellPaths: new Map<string, string>(),
}));

vi.mock("./command-rpc.js", () => ({
  codexControlRequest: commandRpcMocks.codexControlRequest,
}));
vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerClientJson: pinnedConnectionMocks.request,
}));
vi.mock("./app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: pinnedConnectionMocks.getClient,
  releaseLeasedSharedCodexAppServerClient: pinnedConnectionMocks.releaseClient,
}));
vi.mock("./app-server/transcript-mirror.js", () => ({
  importCodexThreadHistoryToTranscript: transcriptMirrorMocks.importCodexThreadHistoryToTranscript,
}));
vi.mock("./session-catalog-pty.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-catalog-pty.runtime.js")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
        strategy: "direct" | "fallback" | "prefer";
      },
    ) => {
      const env = options.env ?? process.env;
      const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
      const direct = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      if (direct && options.strategy !== "prefer") {
        return direct;
      }
      const shellPath = nodeHostMocks.userShellPaths.get(command);
      if (!shellPath) {
        return direct;
      }
      const shellExecutable = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: shellPath,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      return shellExecutable
        ? { executable: shellExecutable.executable, pathEnv: shellPath }
        : direct;
    },
  };
});

beforeEach(() => {
  nodeHostMocks.runNodePtyCommand.mockClear();
  nodeHostMocks.userShellPaths.clear();
  commandRpcMocks.codexControlRequest.mockReset();
  pinnedConnectionMocks.getClient.mockReset();
  pinnedConnectionMocks.getClient.mockResolvedValue(pinnedConnectionMocks.client);
  pinnedConnectionMocks.releaseClient.mockReset();
  pinnedConnectionMocks.request.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockResolvedValue({
    importedMessages: 0,
    omittedMessages: 0,
  });
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Codex session catalog errors", () => {
  it("preserves fallback names returned by paired nodes", () => {
    expect(
      parseCatalogPage({
        sessions: [
          {
            threadId: "thread-1",
            fallbackName: "Readable fallback",
            status: "idle",
            archived: false,
          },
        ],
      }),
    ).toEqual({
      sessions: [
        {
          threadId: "thread-1",
          fallbackName: "Readable fallback",
          status: "idle",
          archived: false,
        },
      ],
    });
  });

  it("keeps the underlying paired-node list failure", () => {
    expect(catalogError("NODE_LIST_FAILED", new Error("paired store is unreadable"))).toEqual({
      code: "NODE_LIST_FAILED",
      message: "Paired nodes could not be listed: paired store is unreadable",
    });
  });
});

describe("Codex supervision catalog", () => {
  it("lists non-archived interactive threads without probing transcript previews", async () => {
    const pluginConfig = await normalizeCodexManifestConfig({
      supervision: { enabled: true },
      appServer: { command: "codex-catalog" },
    });
    expect((pluginConfig.appServer as Record<string, unknown>).homeScope).toBeUndefined();
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        {
          id: "thread-title",
          name: "Match title",
          preview: "private\ntranscript preview",
          cwd: "/workspace/one",
          status: { type: "idle" },
          source: "vscode",
        },
        {
          id: "thread-preview",
          preview: "Match appears only in private preview text",
          status: { type: "idle" },
          source: "cli",
        },
      ],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(
      control.listPage({ limit: 25, searchTerm: "mAtCh", cwd: " /workspace/one " }),
    ).resolves.toEqual({
      sessions: [
        {
          threadId: "thread-title",
          name: "Match title",
          cwd: "/workspace/one",
          status: "idle",
          source: "vscode",
          archived: false,
        },
      ],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      "thread/list",
      {
        archived: false,
        limit: 25,
        modelProviders: [],
        sortKey: "updated_at",
        sortDirection: "desc",
        cwd: "/workspace/one",
      },
      {
        agentDir: resolveDefaultAgentDir(config),
        config,
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
        timeoutMs: expect.any(Number),
      },
    );
    expect(JSON.stringify(await control.listPage({ searchTerm: "mAtCh" }))).not.toContain(
      "private",
    );
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1])).not.toContain(
      "thread/resume",
    );
  });

  it("preserves the retained owner directory across normal cloned requests", async () => {
    const runtimeConfig = compatibilityOwnerConfig();
    const expectedAgentDir = resolveDefaultAgentDir(runtimeConfig);
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _pluginConfig: unknown,
        _method: string,
        _params: unknown,
        options: { agentDir?: string; config?: OpenClawConfig },
      ) => {
        if (!options.agentDir) {
          try {
            resolveSessionAgentIds({ config: options.config });
          } catch (error) {
            throw new Error((error as { code?: string }).code ?? String(error), { cause: error });
          }
        }
        return { data: [] };
      },
    );
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    });

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });
    const requestOptions = commandRpcMocks.codexControlRequest.mock.calls[0]?.[3];
    expect(requestOptions?.config).not.toBe(runtimeConfig);
    expect(requestOptions?.agentDir).toBe(expectedAgentDir);
  });

  it("uses the Gateway-selected owner directory for an explicit multi-agent catalog", async () => {
    const runtimeConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    } as OpenClawConfig;
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
    const control = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    }).forRequest("beta");

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });

    expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).toMatchObject({
      agentDir: resolveAgentDir(runtimeConfig, "beta"),
      config: { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } },
    });
  });

  it("discovers every existing Codex home while retaining the route owner directory", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-catalog-homes-")),
    );
    tempDirs.push(root);
    const alphaAgentDir = path.join(root, "agents", "alpha", "agent");
    const betaAgentDir = path.join(root, "agents", "beta", "agent");
    const processCodexHome = path.join(root, "process-codex-home");
    const alphaCodexHome = resolveCodexAppServerHomeDir(alphaAgentDir);
    const betaCodexHome = resolveCodexAppServerHomeDir(betaAgentDir);
    await Promise.all(
      [processCodexHome, alphaCodexHome, betaCodexHome].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    const runtimeConfig = {
      agents: {
        ownership: "explicit",
        list: [
          { id: "alpha", agentDir: alphaAgentDir },
          { id: "beta", agentDir: betaAgentDir },
        ],
      },
    } as OpenClawConfig;
    const env = { ...process.env, CODEX_HOME: processCodexHome };

    const control = createCodexSessionCatalogControlFactory({
      config: runtimeConfig,
      env,
      getRuntimeConfig: () => runtimeConfig,
      getPluginConfig: () => ({ supervision: { enabled: true } }),
    });
    const homes = control.homesForAgent("beta");

    expect(
      new Set(
        homes.map((home) =>
          resolveCodexAppServerLocalHomeDir(home.appServer.start, home.agentDir, env),
        ),
      ),
    ).toEqual(new Set([processCodexHome, alphaCodexHome, betaCodexHome]));
    expect(homes.map((home) => home.agentDir)).toEqual([betaAgentDir, betaAgentDir, betaAgentDir]);
    expect(homes[0]?.hostId).toBe(CODEX_LOCAL_SESSION_HOST_ID);
    expect(homes.slice(1).every((home) => home.hostId.startsWith("gateway:local:"))).toBe(true);
    expect(new Set(homes.map((home) => home.sourceHomeId)).size).toBe(3);
    expect(
      JSON.stringify(homes.map(({ hostId, sourceHomeId }) => ({ hostId, sourceHomeId }))),
    ).not.toContain(root);

    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
    pinnedConnectionMocks.request.mockResolvedValue({
      thread: idleThread({ id: "thread-source" }),
    });
    const alphaSource = homes.find(
      (home) =>
        resolveCodexAppServerLocalHomeDir(home.appServer.start, home.agentDir, env) ===
        alphaCodexHome,
    );
    expect(alphaSource).toBeDefined();

    const alphaFingerprint = buildCodexAppServerConnectionFingerprint(
      alphaSource!.appServer,
      alphaSource!.agentDir,
    );
    const boundControl = control.forUpstream("beta", alphaFingerprint);
    expect(boundControl).toBeDefined();
    expect(control.forUpstream("beta", "unknown-fingerprint")).toBeUndefined();
    await boundControl!.listPage({});
    await boundControl!.withPinnedConnection(
      async (pinned) => await pinned.readThread("thread-source", false),
    );

    expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).toMatchObject({
      agentDir: betaAgentDir,
      startOptions: { env: { CODEX_HOME: alphaCodexHome } },
    });
    expect(pinnedConnectionMocks.getClient).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: betaAgentDir,
        startOptions: expect.objectContaining({
          env: expect.objectContaining({ CODEX_HOME: alphaCodexHome }),
        }),
      }),
    );
  });

  it("refreshes Codex homes once for each hot-reloaded config generation", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-catalog-reload-")),
    );
    tempDirs.push(root);
    const alphaAgentDir = path.join(root, "agents", "alpha", "agent");
    const betaAgentDir = path.join(root, "agents", "beta", "agent");
    const processCodexHome = path.join(root, "process-codex-home");
    const alphaCodexHome = resolveCodexAppServerHomeDir(alphaAgentDir);
    const betaCodexHome = resolveCodexAppServerHomeDir(betaAgentDir);
    await Promise.all(
      [processCodexHome, alphaCodexHome, betaCodexHome].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    const configA = {
      agents: { ownership: "explicit", list: [{ id: "alpha", agentDir: alphaAgentDir }] },
    } as OpenClawConfig;
    const configB = {
      agents: {
        ownership: "explicit",
        list: [
          { id: "alpha", agentDir: alphaAgentDir },
          { id: "beta", agentDir: betaAgentDir },
        ],
      },
    } as OpenClawConfig;
    let runtimeConfig = configA;
    const existsSync = vi.spyOn(fsSync, "existsSync");
    try {
      const resolver = createCodexCatalogHomeResolver({
        config: configA,
        getRuntimeConfig: () => runtimeConfig,
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        env: { ...process.env, CODEX_HOME: processCodexHome },
      });
      const seedDiscoveryCount = existsSync.mock.calls.length;

      expect(resolver.forAgent("alpha")).not.toHaveLength(0);
      expect(resolver.forAgent("alpha")).not.toHaveLength(0);
      expect(existsSync).toHaveBeenCalledTimes(seedDiscoveryCount);

      runtimeConfig = configB;
      const betaHomes = resolver.forAgent("beta");
      expect(
        betaHomes.some(
          (home) =>
            resolveCodexAppServerLocalHomeDir(home.appServer.start, home.agentDir, process.env) ===
            betaCodexHome,
        ),
      ).toBe(true);
      const reloadedDiscoveryCount = existsSync.mock.calls.length;

      expect(resolver.forAgent("beta")).toEqual(betaHomes);
      expect(existsSync).toHaveBeenCalledTimes(reloadedDiscoveryCount);
    } finally {
      existsSync.mockRestore();
    }
  });

  it("exposes every local source as an actionable host for the selected owner", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-catalog-hosts-")),
    );
    tempDirs.push(root);
    const alphaAgentDir = path.join(root, "agents", "alpha", "agent");
    const betaAgentDir = path.join(root, "agents", "beta", "agent");
    const processCodexHome = path.join(root, "process-codex-home");
    await Promise.all(
      [
        processCodexHome,
        resolveCodexAppServerHomeDir(alphaAgentDir),
        resolveCodexAppServerHomeDir(betaAgentDir),
      ].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const runtimeConfig = {
      agents: {
        ownership: "explicit",
        list: [
          { id: "alpha", agentDir: alphaAgentDir },
          { id: "beta", agentDir: betaAgentDir },
        ],
      },
    } as OpenClawConfig;
    const { runtime } = createRuntime();
    const { api, getProvider } = createGatewayApi(runtime, runtimeConfig);
    const listPage = vi.fn(async (source?: { agentDir: string; sourceHomeId: string }) => ({
      sessions: [
        {
          threadId: `thread-${source?.sourceHomeId ?? "missing"}`,
          status: "idle",
          source: "cli",
          archived: false as const,
        },
      ],
    }));
    const forRequest = vi.fn((agentId: string, source?: CodexCatalogHome) =>
      createControl({ listPage: async () => await listPage(source) }),
    );
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: { forRequest },
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    });

    await withEnvAsync({ CODEX_HOME: processCodexHome }, async () => {
      const hosts = await getProvider()?.list({
        agentId: "beta",
        listNodes: async () => ({ nodes: [] }),
      });

      expect(hosts).toHaveLength(3);
      expect(hosts?.every((host) => host.hostId.startsWith("gateway:local"))).toBe(true);
      expect(
        hosts?.every(
          (host) =>
            host.sessions[0]?.sourceHomeId &&
            host.sessions[0]?.canContinue &&
            host.sessions[0]?.canArchive,
        ),
      ).toBe(true);
      expect(forRequest.mock.calls.every(([agentId]) => agentId === "beta")).toBe(true);
      expect(forRequest.mock.calls.every(([, source]) => source?.agentDir === betaAgentDir)).toBe(
        true,
      );
    });
  });

  it("does not project an adopted session onto another local home with the same thread id", async () => {
    const source = (sourceHomeId: string, hostId: string): CodexCatalogHome => ({
      sourceHomeId,
      hostId,
      label: sourceHomeId,
      agentDir: `/agents/${sourceHomeId}`,
      appServer: {} as CodexCatalogHome["appServer"],
      usesProcessHomeFallback: false,
    });
    const homeA = source("home-a", CODEX_LOCAL_SESSION_HOST_ID);
    const homeB = source("home-b", `${CODEX_LOCAL_SESSION_HOST_ID}:home-b`);
    const sessionKey = supervisionSessionKey("thread-1", homeA.sourceHomeId);
    const sessionId = "openclaw-session-home-a";
    const { runtime } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "thread-1", sourceHomeId: "home-a", sessionId }),
        },
      ],
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          { threadId: "thread-1", status: "idle", source: "cli", archived: false as const },
        ],
      })),
    });

    const result = await listCodexSessionCatalog({
      agentId: "main",
      bindingStore,
      config,
      runtime,
      control,
      localHomes: [homeA, homeB],
      listNodes: async () => ({ nodes: [] }),
    });
    const sessions = new Map(result.hosts.map((host) => [host.hostId, host.sessions[0]]));

    expect(sessions.get(homeA.hostId)).toMatchObject({ sessionKey, sourceHomeId: "home-a" });
    expect(sessions.get(homeB.hostId)).toMatchObject({ sourceHomeId: "home-b" });
    expect(sessions.get(homeB.hostId)).not.toHaveProperty("sessionKey");
  });

  it("uses a sanitized preview only when Codex has no thread name", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        {
          id: "thread-named",
          name: "Explicit title",
          preview: "must stay private",
          status: { type: "idle" },
          source: "cli",
        },
        {
          id: "thread-fallback",
          preview: "Investigate\nfailed Rosita run",
          status: { type: "idle" },
          source: "cli",
        },
      ],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 25 })).resolves.toEqual({
      sessions: [
        {
          threadId: "thread-named",
          name: "Explicit title",
          status: "idle",
          source: "cli",
          archived: false,
        },
        {
          threadId: "thread-fallback",
          fallbackName: "Investigate failed Rosita run",
          status: "idle",
          source: "cli",
          archived: false,
        },
      ],
    });
  });
});
