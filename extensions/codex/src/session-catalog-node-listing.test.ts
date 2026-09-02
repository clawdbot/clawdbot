// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
import {
  nodeHostMocks,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  tempDirs,
  listCodexSessionCatalog,
  registerCodexSessionCatalog,
  createCodexSessionCatalogNodeHostCommands,
  config,
  idleThread,
  createControl,
  createEligibleControl,
  createRuntime,
  createGatewayApi,
  fs,
  os,
  path,
  resolveAgentDir,
  resolveCodexAppServerHomeDir,
  createCodexTestBindingStore,
  listPairedNode,
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  type OpenClawConfig,
  type PluginRuntime,
} from "./session-catalog.test-helpers.js";

describe("Codex supervision catalog", () => {
  it("filters managed threads and backfills paired-node catalog pages", async () => {
    const listPage = vi.fn(async ({ cursor }: { cursor?: string; limit: number }) =>
      cursor
        ? {
            sessions: [{ threadId: "native-2", status: "idle", source: "cli", archived: false }],
          }
        : {
            sessions: [
              { threadId: "managed", status: "idle", source: "vscode", archived: false },
              { threadId: "native-1", status: "idle", source: "cli", archived: false },
            ],
            nextCursor: "page-2",
            backwardsCursor: "page-0",
          },
    );
    const control = createControl({ listPage });
    const bindingStore = Object.assign(createCodexTestBindingStore(), {
      managedThreads: {
        has: vi.fn(async () => false),
        mark: vi.fn(async () => undefined),
        snapshot: vi.fn(
          async () => new Map<string, ReadonlySet<string>>([["home-main", new Set(["managed"])]]),
        ),
      },
    });
    const command = createCodexSessionCatalogNodeHostCommands(
      {
        forRequest: () => control,
        homesForAgent: () => [{ sourceHomeId: "home-main" } as never],
        forUpstream: () => undefined,
      },
      undefined,
      bindingStore,
    ).find((candidate) => candidate.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND);
    if (!command) {
      throw new Error("Codex session catalog node command was not registered");
    }

    const result = await command.handle(JSON.stringify({ limit: 2, agentId: "main" }));
    expect(JSON.parse(result)).toEqual({
      sessions: [
        { threadId: "native-1", status: "idle", source: "cli", archived: false },
        { threadId: "native-2", status: "idle", source: "cli", archived: false },
      ],
      backwardsCursor: "page-0",
    });
    expect(bindingStore.managedThreads.snapshot).toHaveBeenCalledTimes(1);
    expect(listPage).toHaveBeenNthCalledWith(1, { limit: 2 });
    expect(listPage).toHaveBeenNthCalledWith(2, { cursor: "page-2", limit: 1 });
  });

  it("keeps paired-node catalogs non-archived and metadata-only", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "local", status: "idle", archived: false }],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "remote",
            name: "Remote task",
            status: "idle",
            archived: false,
            preview: "must be stripped",
            turns: [{ private: true }],
          },
        ],
      }),
    }));
    const { runtime } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          displayName: "Dev Box",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });

    const result = await listCodexSessionCatalog({
      bindingStore: createCodexTestBindingStore(),
      config,
      runtime,
      control,
      includeLocal: false,
    });

    expect(result.hosts).toEqual([
      {
        hostId: "node:devbox",
        label: "Dev Box",
        kind: "node",
        nodeId: "devbox",
        canContinueCodex: false,
        canOpenTerminalCodex: false,
        canStartTerminal: false,
        connected: true,
        sessions: [{ threadId: "remote", name: "Remote task", status: "idle", archived: false }],
      },
    ]);
    expect(control.listPage).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "devbox",
        command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        params: expect.objectContaining({ agentId: "main" }),
        timeoutMs: 65_000,
        scopes: ["operator.write"],
      }),
    );
    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("archived");
    expect(JSON.stringify(result)).not.toContain("private");

    const [nodeCommand] = createCodexSessionCatalogNodeHostCommands(control);
    expect(nodeCommand).toMatchObject({
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      dangerous: false,
    });
    if (!nodeCommand) {
      throw new Error("Codex session catalog node command was not registered");
    }
    await expect(nodeCommand.handle(JSON.stringify({ archived: true }))).rejects.toThrow(
      "unknown Codex session catalog parameter: archived",
    );

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: "archived", status: "idle", archived: true }],
      }),
    });
    await expect(
      listCodexSessionCatalog({
        bindingStore: createCodexTestBindingStore(),
        config,
        runtime,
        control,
        query: { hostIds: ["node:devbox"] },
      }),
    ).resolves.toEqual({
      hosts: [
        expect.objectContaining({
          hostId: "node:devbox",
          sessions: [],
          error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
        }),
      ],
    });
  });

  it("omits the Gateway's same-install node host from native discovery", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "local", status: "idle", archived: false }],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => ({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: `remote-${nodeId}`, status: "idle", archived: false }],
      }),
    }));
    const { runtime } = createRuntime({
      nodes: [
        {
          nodeId: "gateway-node",
          displayName: "Gateway node",
          gatewayLocal: true,
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        {
          nodeId: "remote-node",
          displayName: "Remote node",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });

    const result = await listCodexSessionCatalog({
      bindingStore: createCodexTestBindingStore(),
      config,
      runtime,
      control,
    });

    expect(result.hosts.map((host) => host.hostId)).toEqual([
      CODEX_LOCAL_SESSION_HOST_ID,
      "node:remote-node",
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "remote-node" }));
  });

  it("isolates federated host failures while preserving selected healthy hosts", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          {
            threadId: "local-match",
            name: "Match locally",
            status: "idle",
            source: "cli",
            archived: false,
          },
        ],
        nextCursor: "local-page-3",
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => {
      if (nodeId === "broken") {
        throw new Error("node transport failed");
      }
      return {
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "remote-match",
              name: "Remote match",
              status: "idle",
              source: "vscode",
              archived: false,
            },
            {
              threadId: "preview-only",
              name: "Other title",
              preview: "match appears only in private transcript text",
              status: "idle",
              source: "cli",
              archived: false,
            },
          ],
          nextCursor: "healthy-page-3",
        }),
      };
    });
    const { runtime } = createRuntime({
      nodes: [
        {
          nodeId: "healthy",
          displayName: "A healthy node",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        {
          nodeId: "broken",
          displayName: "B broken node",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        {
          nodeId: "offline",
          displayName: "C offline node",
          connected: false,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        {
          nodeId: "unsupported",
          connected: true,
          commands: ["other.command"],
        },
        {
          nodeId: "unselected",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });

    const result = await listCodexSessionCatalog({
      bindingStore: createCodexTestBindingStore(),
      config,
      runtime,
      control,
      query: {
        search: "match",
        limitPerHost: 7,
        hostIds: [
          CODEX_LOCAL_SESSION_HOST_ID,
          "node:healthy",
          "node:broken",
          "node:offline",
          "node:unsupported",
        ],
        cursors: {
          [CODEX_LOCAL_SESSION_HOST_ID]: "local-page-2",
          "node:healthy": "healthy-page-2",
          "node:broken": "broken-page-2",
        },
      },
    });

    expect(control.listPage).toHaveBeenCalledWith({
      cursor: "local-page-2",
      limit: 7,
      searchTerm: "match",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "healthy",
        params: { agentId: "main", cursor: "healthy-page-2", limit: 7, searchTerm: "match" },
        scopes: ["operator.write"],
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "broken",
        params: { agentId: "main", cursor: "broken-page-2", limit: 7, searchTerm: "match" },
        scopes: ["operator.write"],
      }),
    );
    expect(result.hosts).toEqual([
      expect.objectContaining({
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        connected: true,
        nextCursor: "local-page-3",
        sessions: [expect.objectContaining({ threadId: "local-match" })],
      }),
      expect.objectContaining({
        hostId: "node:healthy",
        connected: true,
        nextCursor: "healthy-page-3",
        sessions: [expect.objectContaining({ threadId: "remote-match" })],
      }),
      expect.objectContaining({
        hostId: "node:broken",
        connected: true,
        sessions: [],
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
      expect.objectContaining({
        hostId: "node:offline",
        connected: false,
        sessions: [],
        error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private transcript");
  });

  it("bounds how long a hung paired-node catalog can delay the caller", async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(
        async () => await new Promise<never>(() => {}),
      );
      const pending = listPairedNode({
        agentId: "main",
        runtime: { nodes: { invoke } } as unknown as PluginRuntime,
        node: {
          nodeId: "slow-node",
          displayName: "Slow node",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        query: { limitPerHost: 40 },
        adoptedSessions: new Map(),
        terminalCapabilities: { canStartTerminal: true, canOpenTerminalCodex: true },
      });

      await vi.advanceTimersByTimeAsync(8_000);

      await expect(pending).resolves.toMatchObject({
        hostId: "node:slow-node",
        connected: true,
        sessions: [],
        error: { code: "NODE_INVOKE_FAILED" },
      });
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 65_000 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a paired-node page that finishes after the fail-soft response", async () => {
    vi.useFakeTimers();
    try {
      let resolveInvoke!: (value: unknown) => void;
      const invokeResult = new Promise<unknown>((resolve) => {
        resolveInvoke = resolve;
      });
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => await invokeResult);
      const onHost = vi.fn();
      const pending = listPairedNode({
        agentId: "main",
        runtime: { nodes: { invoke } } as unknown as PluginRuntime,
        node: {
          nodeId: "slow-node",
          displayName: "Slow node",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        query: { limitPerHost: 40 },
        adoptedSessions: new Map(),
        terminalCapabilities: { canStartTerminal: true, canOpenTerminalCodex: true },
        onHost,
      });

      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toMatchObject({
        canStartTerminal: true,
        error: { code: "NODE_INVOKE_FAILED" },
      });
      expect(onHost).not.toHaveBeenCalled();

      resolveInvoke({
        payloadJSON: JSON.stringify({
          sessions: [{ threadId: "late-thread", status: "idle", archived: false }],
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(onHost).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "node:slow-node",
          canStartTerminal: true,
          canOpenTerminalCodex: true,
          sessions: [expect.objectContaining({ threadId: "late-thread" })],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves one bounded transcript page from the node host command", async () => {
    const listTurnPage = vi.fn(async () => ({
      data: [
        {
          id: "turn-1",
          items: [{ id: "item-1", type: "agentMessage", text: "bounded answer" }],
        },
      ] as never,
      nextCursor: "turns-page-2",
    }));
    const control = createEligibleControl({ listTurnPage });
    const command = createCodexSessionCatalogNodeHostCommands(control).find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    );
    if (!command) {
      throw new Error("Codex transcript node command was not registered");
    }

    await expect(
      command.handle(JSON.stringify({ threadId: "thread-1", cursor: "turns-page-1", limit: 25 })),
    ).resolves.toBe(
      JSON.stringify({
        data: [
          {
            id: "turn-1",
            items: [{ id: "item-1", type: "agentMessage", text: "bounded answer" }],
          },
        ],
        nextCursor: "turns-page-2",
      }),
    );
    expect(listTurnPage).toHaveBeenCalledWith({
      threadId: "thread-1",
      cursor: "turns-page-1",
      limit: 25,
      sortDirection: "desc",
      itemsView: "full",
    });
  });

  it("binds paired-node catalog commands to the invocation agent after config reload", async () => {
    let runtimeConfig = { agents: { list: [{ id: "main" }] } } as OpenClawConfig;
    const alphaListPage = vi.fn(async () => {
      throw new Error("alpha control must not serve beta");
    });
    const betaListPage = vi.fn(async () => ({
      sessions: [{ threadId: "thread-beta", status: "idle", source: "cli", archived: false }],
    }));
    const betaListTurnPage = vi.fn(async () => ({ data: [] }));
    const alphaControl = createControl({ listPage: alphaListPage });
    const betaControl = createControl({
      listPage: betaListPage,
      listTurnPage: betaListTurnPage,
    });
    const forRequest = vi.fn((agentId: string) =>
      agentId === "beta" ? betaControl : alphaControl,
    );
    const commands = createCodexSessionCatalogNodeHostCommands(
      { forRequest },
      {
        getPluginConfig: () => undefined,
        getRuntimeConfig: () => runtimeConfig,
      },
    );
    runtimeConfig = {
      agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
    } as OpenClawConfig;
    const listCommand = commands.find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND,
    );
    const transcriptCommand = commands.find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    );
    if (!listCommand || !transcriptCommand) {
      throw new Error("Codex node catalog commands were not registered");
    }

    expect(
      JSON.parse(await listCommand.handle(JSON.stringify({ agentId: "beta", limit: 25 }))),
    ).toEqual({
      sessions: [{ threadId: "thread-beta", status: "idle", source: "cli", archived: false }],
    });
    await expect(
      transcriptCommand.handle(
        JSON.stringify({ agentId: "beta", threadId: "thread-beta", limit: 25 }),
      ),
    ).resolves.toBe(JSON.stringify({ data: [] }));
    await expect(listCommand.handle(JSON.stringify({ limit: 25 }))).rejects.toThrow(
      "session agent resolution has no explicit owner",
    );

    expect(alphaListPage).not.toHaveBeenCalled();
  });

  it("rejects malformed terminal resume thread ids before spawning", async () => {
    const command = createCodexSessionCatalogNodeHostCommands(createEligibleControl()).find(
      (candidate) => candidate.command === CODEX_TERMINAL_RESUME_COMMAND,
    );
    if (!command || command.duplex !== true) {
      throw new Error("Codex terminal command was not registered as duplex");
    }
    await expect(
      command.handle(JSON.stringify({ threadId: "not-a-uuid", cols: 80, rows: 24 }), {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      }),
    ).rejects.toThrow("threadId must be a UUID");
  });

  it("resolves node terminal eligibility and cwd from the node-owned catalog record", async () => {
    const threadId = "123e4567-e89b-12d3-a456-426614174000";
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-node-terminal-"));
    tempDirs.push(binDir);
    const executable = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    if (process.platform === "win32") {
      await fs.writeFile(path.join(binDir, "codex"), "#!/bin/sh\n");
    }
    await fs.writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") {
      await fs.chmod(executable, 0o755);
    }
    process.env.PATH = binDir;
    const explicitConfig = {
      agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
    } as OpenClawConfig;
    const command = createCodexSessionCatalogNodeHostCommands(
      createEligibleControl({
        requireEligibleThread: vi.fn(async () =>
          idleThread({ id: threadId, source: { custom: "atlas" }, cwd: "/node/catalog/cwd" }),
        ),
      }),
      {
        getPluginConfig: () => ({ appServer: { homeScope: "agent" } }),
        getRuntimeConfig: () => explicitConfig,
      },
    ).find((candidate) => candidate.command === CODEX_TERMINAL_RESUME_COMMAND);
    if (!command || command.duplex !== true) {
      throw new Error("Codex terminal command was not registered as duplex");
    }

    await command.handle(
      JSON.stringify({ agentId: "beta", threadId, cwd: "/caller/cwd", cols: 80, rows: 24 }),
      {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      },
    );

    expect(command.dangerous).toBe(false);
    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        file: executable,
        cwd: "/node/catalog/cwd",
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(resolveAgentDir(explicitConfig, "beta")),
        },
      }),
      expect.any(Object),
    );
  });

  it("rejects an oversized transcript page before returning it over node.invoke", async () => {
    const control = createEligibleControl({
      listTurnPage: vi.fn(async () => ({
        data: [
          {
            id: "turn-1",
            items: [
              {
                id: "item-1",
                type: "commandExecution",
                aggregatedOutput: "x".repeat(20 * 1024 * 1024),
              },
            ],
          },
        ] as never,
      })),
    });
    const command = createCodexSessionCatalogNodeHostCommands(control).find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    );
    if (!command) {
      throw new Error("Codex transcript node command was not registered");
    }

    await expect(
      command.handle(JSON.stringify({ threadId: "thread-1", limit: 50 })),
    ).rejects.toThrow("Codex app-server transcript is unavailable");
  });

  it("caps aggregate host results at the public wire bound", async () => {
    const control = createControl();
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({ sessions: [] }),
    }));
    const { runtime } = createRuntime({
      nodes: Array.from({ length: 120 }, (_, index) => ({
        nodeId: `node-${index.toString().padStart(3, "0")}`,
        connected: true,
        commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
      })),
      invoke,
    });

    const result = await listCodexSessionCatalog({
      bindingStore: createCodexTestBindingStore(),
      config,
      runtime,
      control,
    });

    expect(result.hosts).toHaveLength(100);
    expect(result.hosts[0]?.hostId).toBe(CODEX_LOCAL_SESSION_HOST_ID);
    expect(invoke).toHaveBeenCalledTimes(99);
  });

  it.each(["nextCursor", "backwardsCursor"] as const)(
    "rejects an oversized Gateway-local %s before the public response",
    async (cursorField) => {
      const control = createControl({
        listPage: vi.fn(async () => ({
          sessions: [],
          [cursorField]: "x".repeat(4097),
        })),
      });
      const { runtime } = createRuntime();

      const result = await listCodexSessionCatalog({
        bindingStore: createCodexTestBindingStore(),
        config,
        runtime,
        control,
        query: { hostIds: [CODEX_LOCAL_SESSION_HOST_ID] },
      });

      expect(result).toEqual({
        hosts: [
          {
            hostId: CODEX_LOCAL_SESSION_HOST_ID,
            label: "Local Codex",
            kind: "gateway",
            connected: false,
            sessions: [],
            error: {
              code: "APP_SERVER_UNAVAILABLE",
              message: "Codex app-server is unavailable on this host",
            },
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("x".repeat(4097));
    },
  );

  it.each([
    {
      name: "out-of-range page limit",
      params: { limitPerHost: 101 },
      error: "limitPerHost must be an integer from 1 to 100",
    },
    {
      name: "non-string host id",
      params: { hostIds: [42] },
      error: "Codex session catalog host ids must be strings",
    },
    {
      name: "invalid host id",
      params: { hostIds: ["remote:devbox"] },
      error: "invalid Codex session catalog host id: remote:devbox",
    },
    {
      name: "oversized search",
      params: { search: "x".repeat(501) },
      error: "search must be at most 500 characters",
    },
    {
      name: "oversized cursor",
      params: { cursors: { [CODEX_LOCAL_SESSION_HOST_ID]: "x".repeat(4097) } },
      error: `invalid cursor for Codex session catalog host: ${CODEX_LOCAL_SESSION_HOST_ID}`,
    },
    {
      name: "too many hosts",
      params: {
        hostIds: Array.from({ length: 101 }, (_, index) => `node:host-${index}`),
      },
      error: "hostIds must contain at most 100 host ids",
    },
    {
      name: "too many cursors",
      params: {
        cursors: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`node:host-${index}`, `cursor-${index}`]),
        ),
      },
      error: "cursors may contain at most 100 hosts",
    },
  ])("rejects $name at the provider boundary", async ({ params: requestParams, error }) => {
    const control = createControl();
    const { runtime } = createRuntime();
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });
    await expect(getProvider()?.list(requestParams as never)).rejects.toThrow(error);
    expect(control.listPage).not.toHaveBeenCalled();
    expect(runtime.nodes.list).not.toHaveBeenCalled();
  });

  it("prefers the request node snapshot and retains the plugin runtime fallback", async () => {
    const control = createControl();
    const { runtime } = createRuntime();
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });
    const provider = getProvider();
    const requestListNodes = vi.fn(async () => ({ nodes: [] }));

    await expect(
      provider?.list({ hostIds: ["node:missing"], listNodes: requestListNodes }),
    ).resolves.toEqual([]);
    expect(requestListNodes).toHaveBeenCalledOnce();
    expect(runtime.nodes.list).not.toHaveBeenCalled();

    await expect(provider?.list({ hostIds: ["node:missing"] })).resolves.toEqual([]);
    expect(runtime.nodes.list).toHaveBeenCalledOnce();
  });
});
