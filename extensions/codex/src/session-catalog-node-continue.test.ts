// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
import {
  transcriptMirrorMocks,
  nodeHostMocks,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CLI_SESSION_RESUME_COMMAND,
  CODEX_NODE_CONTINUE_COMMANDS,
  tempDirs,
  readCodexSessionTranscript,
  registerCodexSessionCatalog,
  config,
  idleThread,
  compatibilityOwnerConfig,
  createControl,
  createEligibleControl,
  createRuntime,
  createGatewayApi,
  fs,
  os,
  path,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerUserHomeDir,
  resolveDefaultAgentDir,
  createCodexTestBindingStore,
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_TERMINAL_START_COMMAND,
  createCodexSessionCatalogNodeHostCommands,
  CODEX_LOCAL_SESSION_HOST_ID,
  createCodexSessionCatalogNodeInvokePolicies,
  type OpenClawConfig,
  type PluginRuntime,
} from "./session-catalog.test-helpers.js";

describe("Codex supervision actions", () => {
  it("advertises creation from startup config before the live snapshot is available", () => {
    const startupConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": {} },
        },
      },
    } satisfies OpenClawConfig;
    const { runtime } = createRuntime();
    const { api, getProvider } = createGatewayApi(runtime, startupConfig);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createEligibleControl(),
      getRuntimeConfig: () => undefined,
    });

    expect(getProvider()?.resolveCreateSession?.({ agentId: "main" })).toEqual({
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
    });
  });

  it("marks paired-node rows continuable only with complete permitted capabilities", async () => {
    const sourceByNode = new Map([
      ["ready-cli", { status: "idle", source: "cli" }],
      ["ready-vscode", { status: "notLoaded", source: "vscode" }],
      ["ready-atlas", { status: "notLoaded", source: "atlas" }],
      ["missing-run", { status: "idle", source: "cli" }],
      ["active", { status: "active", source: "cli" }],
      ["noninteractive", { status: "idle", source: "exec" }],
    ]);
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => {
      const source = sourceByNode.get(nodeId);
      if (!source) {
        throw new Error("unexpected node");
      }
      return {
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: `thread-${nodeId}`,
              status: source.status,
              source: source.source,
              archived: false,
            },
          ],
        }),
      };
    });
    const { runtime } = createRuntime({
      nodes: [...sourceByNode.keys()].map((nodeId) => ({
        nodeId,
        displayName: nodeId,
        connected: true,
        commands: [...CODEX_NODE_CONTINUE_COMMANDS],
        invocableCommands:
          nodeId === "missing-run"
            ? CODEX_NODE_CONTINUE_COMMANDS.filter(
                (command) => command !== CODEX_CLI_SESSION_RESUME_COMMAND,
              )
            : [...CODEX_NODE_CONTINUE_COMMANDS],
      })),
      invoke,
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => config,
    });

    const hosts = await getProvider()?.list({
      hostIds: [...sourceByNode.keys()].map((id) => `node:${id}`),
    });
    const sessionByHost = new Map(hosts?.map((host) => [host.hostId, host.sessions[0]]) ?? []);
    expect(sessionByHost.get("node:ready-cli")).toMatchObject({
      canContinue: true,
      canArchive: false,
    });
    expect(sessionByHost.get("node:ready-vscode")).toMatchObject({
      canContinue: true,
      canArchive: false,
    });
    expect(sessionByHost.get("node:ready-atlas")).toMatchObject({
      canContinue: true,
      canArchive: false,
    });
    expect(sessionByHost.get("node:missing-run")).toMatchObject({ canContinue: false });
    expect(sessionByHost.get("node:active")).toMatchObject({ canContinue: false });
    expect(sessionByHost.get("node:noninteractive")).toMatchObject({ canContinue: false });
  });

  it("adopts a paired-node session with bounded history and an executable binding", async () => {
    const remoteThreadId = "123e4567-e89b-12d3-a456-426614174001";
    const sessionFamilyId = "123e4567-e89b-12d3-a456-426614174002";
    let runtimeConfig = compatibilityOwnerConfig("beta");
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command }) => {
      if (command === CODEX_APP_SERVER_THREADS_LIST_COMMAND) {
        return {
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId: remoteThreadId,
                sessionId: sessionFamilyId,
                name: "Remote task",
                cwd: "/remote/repo",
                status: "idle",
                source: "vscode",
                modelProvider: "openai",
                createdAt: 123,
                archived: false,
              },
            ],
          }),
        };
      }
      if (command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND) {
        return {
          payloadJSON: JSON.stringify({
            data: [
              {
                id: "turn-1",
                status: "completed",
                items: [{ id: "item-1", type: "agentMessage", text: "done" }],
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          displayName: "Devbox",
          connected: true,
          commands: [...CODEX_NODE_CONTINUE_COMMANDS],
          invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
        },
      ],
      invoke,
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => runtimeConfig,
    });
    const provider = getProvider();

    const first = await provider?.continueSession?.({
      agentId: "alpha",
      hostId: "node:devbox",
      threadId: remoteThreadId,
      clientScopes: ["operator.admin"],
    });
    const pendingList = await provider?.list({ agentId: "alpha", hostIds: ["node:devbox"] });
    expect(pendingList?.[0]?.sessions[0]?.sessionKey).toBeUndefined();
    await first?.afterConversationBound?.();
    const adopted = entries.find((entry) => entry.sessionKey === first?.sessionKey)?.entry;
    if (!adopted) {
      throw new Error("expected adopted session entry");
    }
    adopted.archivedAt = 123;
    adopted.archivedBy = { type: "human", id: "operator-1" };
    adopted.archiveReason = "manual";
    runtimeConfig = {
      agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
    } as OpenClawConfig;
    const second = await provider?.continueSession?.({
      agentId: "alpha",
      hostId: "node:devbox",
      threadId: remoteThreadId,
      clientScopes: ["operator.admin"],
    });
    await second?.afterConversationBound?.();

    expect(first?.sessionKey).toBe(second?.sessionKey);
    expect(first).toMatchObject({
      conversationBinding: {
        data: {
          kind: "codex-cli-node-session",
          version: 1,
          nodeId: "devbox",
          // Forks share a session family; resume must select the exact listed thread.
          sessionId: remoteThreadId,
          agentId: "alpha",
          cwd: "/remote/repo",
        },
      },
    });
    expect(second).toMatchObject({
      conversationBinding: { data: { agentId: "alpha" } },
    });
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Remote task",
        spawnedCwd: "/remote/repo",
        initialEntry: expect.objectContaining({
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              sessionCatalog: expect.objectContaining({
                sourceHostId: "node:devbox",
                sourceThreadId: remoteThreadId,
                nodeId: "devbox",
                initializing: true,
              }),
            },
          },
        }),
      }),
    );
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({
          id: remoteThreadId,
          turns: [expect.objectContaining({ id: "turn-1" })],
        }),
        throughTurnId: "turn-1",
        cwd: "/remote/repo",
      }),
    );
    // One finalize patch per continue; the restore rides afterConversationBound.
    expect(patchSessionEntry).toHaveBeenCalledTimes(2);
    const restored = entries.find((entry) => entry.sessionKey === second?.sessionKey)?.entry;
    expect(restored?.archivedAt).toBeUndefined();
    expect(restored?.archivedBy).toBeUndefined();
    expect(restored?.archiveReason).toBeUndefined();

    const listed = await provider?.list({ hostIds: ["node:devbox"] });
    expect(listed?.[0]?.sessions[0]).toMatchObject({
      threadId: remoteThreadId,
      sessionKey: first?.sessionKey,
    });
  });

  it("does not join concurrent paired-node continues across explicit agent owners", async () => {
    const runtimeConfig = {
      agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
    } as OpenClawConfig;
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command }) => {
      if (command === CODEX_APP_SERVER_THREADS_LIST_COMMAND) {
        return {
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId: "thread-remote",
                name: "Remote task",
                status: "idle",
                source: "cli",
                archived: false,
              },
            ],
          }),
        };
      }
      if (command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND) {
        return { payloadJSON: JSON.stringify({ data: [] }) };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { runtime, createSessionEntry } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [...CODEX_NODE_CONTINUE_COMMANDS],
          invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
        },
      ],
      invoke,
    });
    const { api, getProvider } = createGatewayApi(runtime, runtimeConfig);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => runtimeConfig,
    });
    const provider = getProvider();
    const continueSession = provider?.continueSession;
    if (!continueSession) {
      throw new Error("expected the Codex session catalog continue provider");
    }

    const [alpha, beta] = await Promise.all(
      ["alpha", "beta"].map((agentId) =>
        continueSession({
          agentId,
          hostId: "node:devbox",
          threadId: "thread-remote",
          clientScopes: ["operator.admin"],
        }),
      ),
    );

    expect(alpha?.sessionKey).toMatch(/^agent:alpha:harness:codex:node-session:/);
    expect(beta?.sessionKey).toMatch(/^agent:beta:harness:codex:node-session:/);
    expect(alpha?.sessionKey).not.toBe(beta?.sessionKey);
    expect(alpha).toMatchObject({ conversationBinding: { data: { agentId: "alpha" } } });
    expect(beta).toMatchObject({ conversationBinding: { data: { agentId: "beta" } } });
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        invoke.mock.calls.map(
          ([request]) => (request.params as { agentId?: string } | undefined)?.agentId,
        ),
      ),
    ).toEqual(new Set(["alpha", "beta"]));
  });

  it("rejects paired-node continue without the permitted run command", async () => {
    const { runtime, createSessionEntry } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [
            CODEX_APP_SERVER_THREADS_LIST_COMMAND,
            CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
          ],
          invocableCommands: [
            CODEX_APP_SERVER_THREADS_LIST_COMMAND,
            CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
          ],
        },
      ],
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => config,
    });

    await expect(
      getProvider()?.continueSession?.({
        hostId: "node:devbox",
        threadId: "thread-remote",
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("paired node does not permit Codex session continuation");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("rejects non-canonical paired-node host ids before adoption keying", async () => {
    const { runtime, createSessionEntry } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [...CODEX_NODE_CONTINUE_COMMANDS],
          invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
        },
      ],
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => config,
    });

    await expect(
      getProvider()?.continueSession?.({
        hostId: "node:devbox ",
        threadId: "thread-remote",
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("hostId is invalid");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("requires operator.admin before continuing a paired-node session", async () => {
    const { runtime, createSessionEntry } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [...CODEX_NODE_CONTINUE_COMMANDS],
          invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
        },
      ],
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => config,
    });

    await expect(
      getProvider()?.continueSession?.({
        hostId: "node:devbox",
        threadId: "thread-remote",
        clientScopes: ["operator.write"],
      }),
    ).rejects.toThrow("requires operator.admin");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("rejects a non-continuable paired-node session status", async () => {
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "thread-remote",
            status: "active",
            source: "cli",
            archived: false,
          },
        ],
      }),
    }));
    const { runtime, createSessionEntry } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [...CODEX_NODE_CONTINUE_COMMANDS],
          invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
        },
      ],
      invoke,
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => config,
    });

    await expect(
      getProvider()?.continueSession?.({
        hostId: "node:devbox",
        threadId: "thread-remote",
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("active on the paired node");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("builds local and paired-node terminal plans from verified catalog records", async () => {
    const threadId = "123e4567-e89b-12d3-a456-426614174000";
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-terminal-"));
    tempDirs.push(binDir);
    process.env.PATH = "";
    nodeHostMocks.userShellPaths.set("codex", binDir);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const executable = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    const control = createEligibleControl({
      requireEligibleThread: vi.fn(async () =>
        idleThread({
          id: threadId,
          status: { type: "active" },
          source: "cli",
          cwd: "/workspace/local",
        }),
      ),
      listPage: vi.fn(async () => ({
        sessions: [
          { threadId, status: "active", source: "cli", cwd: "/workspace/local", archived: false },
        ],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (request) => ({
      payloadJSON: JSON.stringify({
        sessions:
          // The node thread lookup must page without a title searchTerm; if a
          // regression ever sends one, this returns [] and the test fails.
          typeof (request.params as { searchTerm?: string } | undefined)?.searchTerm === "string"
            ? []
            : [
                {
                  threadId,
                  name: "Normal project title",
                  status: "active",
                  source: "vscode",
                  cwd: "/workspace/node",
                  archived: false,
                },
              ],
      }),
    }));
    const commands = [CODEX_APP_SERVER_THREADS_LIST_COMMAND, CODEX_TERMINAL_RESUME_COMMAND];
    const authorizedCommands = new Set(
      createCodexSessionCatalogNodeInvokePolicies().flatMap((policy) => policy.commands),
    );
    expect(authorizedCommands).toContain(CODEX_TERMINAL_RESUME_COMMAND);
    const policy = createCodexSessionCatalogNodeInvokePolicies()[0];
    if (!policy) {
      throw new Error("expected Codex node invoke policy");
    }
    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: "listed" }));
    expect(policy.handle({ command: CODEX_TERMINAL_RESUME_COMMAND, invokeNode } as never)).toEqual({
      ok: true,
    });
    for (const [terminal, admin, allowed] of [
      [undefined, true, true],
      [true, true, true],
      [false, true, false],
      [undefined, false, false],
    ] as const) {
      expect(
        await policy.handle({
          command: CODEX_TERMINAL_START_COMMAND,
          nodeId: "node",
          params: {},
          invokeNode,
          config: {
            gateway: {
              cliAgents: { enabled: true },
              ...(terminal === undefined ? {} : { terminal: { enabled: terminal } }),
            },
          },
          client: { scopes: admin ? ["operator.admin"] : [] },
        }),
      ).toMatchObject({ ok: allowed });
    }
    expect(invokeNode).not.toHaveBeenCalled();
    const node = {
      nodeId: "devbox",
      connected: true,
      commands,
      invocableCommands: commands.filter((command) => authorizedCommands.has(command)),
    };
    const { runtime } = createRuntime({ nodes: [node], invoke });
    const { api, getProvider } = createGatewayApi(runtime);
    let pluginConfig: unknown = { appServer: { homeScope: "agent" } };
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(getProvider()?.list({})).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostId: CODEX_LOCAL_SESSION_HOST_ID,
          sessions: [expect.objectContaining({ threadId, canOpenTerminal: false })],
        }),
        expect.objectContaining({
          hostId: "node:devbox",
          sessions: [expect.objectContaining({ threadId, canOpenTerminal: true })],
        }),
      ]),
    );
    await expect(
      getProvider()?.openTerminal?.({ hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId }),
    ).rejects.toThrow("Codex CLI is unavailable");
    await expect(
      getProvider()?.startTerminalSession?.({
        agentId: "main",
        cwd: "/workspace/new",
        initialMessage: "--help",
      }),
    ).rejects.toThrow("install Codex or add codex to PATH");
    await expect(
      getProvider()?.startTerminalSession?.({
        agentId: "main",
        cwd: "/workspace/node-new",
        nodeId: "devbox",
      }),
    ).resolves.toEqual({
      kind: "node",
      nodeId: "devbox",
      command: CODEX_TERMINAL_START_COMMAND,
      paramsJSON: JSON.stringify({ cwd: "/workspace/node-new" }),
      cwd: "/workspace/node-new",
      title: "codex",
    });

    await fs.writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") {
      await fs.chmod(executable, 0o755);
    }
    now += 60_001;
    await expect(getProvider()?.list({})).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostId: CODEX_LOCAL_SESSION_HOST_ID,
          sessions: [expect.objectContaining({ threadId, canOpenTerminal: true })],
        }),
        expect.objectContaining({
          hostId: "node:devbox",
          sessions: [expect.objectContaining({ threadId, canOpenTerminal: true })],
        }),
      ]),
    );
    await expect(
      getProvider()?.openTerminal?.({ hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId }),
    ).resolves.toMatchObject({
      kind: "local",
      argv: [executable, "resume", threadId],
      cwd: "/workspace/local",
      pathEnv: binDir,
      env: {
        CODEX_HOME: resolveCodexAppServerHomeDir(resolveDefaultAgentDir(config)),
      },
    });
    await expect(
      getProvider()?.startTerminalSession?.({
        agentId: "main",
        cwd: "/workspace/new",
        initialMessage: "Fix A&B and 100%",
      }),
    ).resolves.toEqual({
      kind: "local",
      argv: [executable, "--", "Fix A&B and 100%"],
      cwd: "/workspace/new",
      env: {
        CODEX_HOME: resolveCodexAppServerHomeDir(resolveDefaultAgentDir(config)),
      },
      pathEnv: binDir,
      title: "codex",
    });
    await expect(
      getProvider()?.startTerminalSession?.({
        agentId: "main",
        cwd: "/workspace/command-prompt",
        initialMessage: "resume",
      }),
    ).resolves.toMatchObject({ argv: [executable, "--", "resume"] });
    await expect(
      getProvider()?.startTerminalSession?.({ agentId: "main", cwd: "/workspace/blank" }),
    ).resolves.toMatchObject({ argv: [executable], cwd: "/workspace/blank" });
    const fresh = createCodexSessionCatalogNodeHostCommands(control, {
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => ({ agents: { ownership: "explicit", entries: { unrelated: {} } } }),
    }).find((command) => command.command === CODEX_TERMINAL_START_COMMAND)!;
    process.env.PATH = binDir;
    const io = { signal: new AbortController().signal, emitChunk: vi.fn(), onInput: vi.fn() };
    await fresh.handle(
      JSON.stringify({ cwd: binDir, initialMessage: "--help", cols: 100, rows: 30 }),
      io,
    );
    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      {
        file: executable,
        args: ["--", "--help"],
        cwd: binDir,
        requiredCwd: true,
        cols: 100,
        rows: 30,
      },
      io,
    );
    for (const field of ["agentId", "argv", "env", "executable"]) {
      await expect(
        fresh.handle(JSON.stringify({ cwd: binDir, cols: 80, rows: 24, [field]: "injected" }), io),
      ).rejects.toThrow("unknown terminal start parameter");
    }
    const hosts = [
      { nodeId: "ready", connected: true, invocableCommands: [CODEX_TERMINAL_START_COMMAND] },
      {
        nodeId: "resume-only",
        connected: true,
        invocableCommands: [CODEX_TERMINAL_RESUME_COMMAND],
      },
      { nodeId: "offline", connected: false, invocableCommands: [CODEX_TERMINAL_START_COMMAND] },
      {
        nodeId: "denied",
        connected: true,
        commands: [CODEX_TERMINAL_START_COMMAND],
        invocableCommands: [],
      },
    ];
    const localList = vi.spyOn(control, "listPage").mockRejectedValue(new Error("app-server down"));
    const localProgress = vi.fn();
    let rejectNodes!: (error: Error) => void;
    const pending = getProvider()!.list({
      onHost: localProgress,
      listNodes: () =>
        new Promise((_, reject) => {
          rejectNodes = reject;
        }),
    });
    await vi.waitFor(() =>
      expect(localProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: CODEX_LOCAL_SESSION_HOST_ID,
          connected: false,
          canStartTerminal: true,
        }),
      ),
    );
    rejectNodes(new Error("node registry down"));
    expect(await pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: CODEX_LOCAL_SESSION_HOST_ID, canStartTerminal: true }),
        expect.objectContaining({ hostId: "node:registry", canStartTerminal: false }),
      ]),
    );
    localList.mockRestore();
    invoke.mockClear();
    const onHost = vi.fn();
    const catalogHosts = await getProvider()?.list({
      onHost,
      agentId: "main",
      listNodes: async () => ({ nodes: hosts }),
    });
    const terminalHosts = catalogHosts?.filter((host) => host.canStartTerminal);
    expect(terminalHosts?.filter((host) => host.hostId.startsWith("node:"))).toEqual([
      expect.objectContaining({ hostId: "node:ready", label: "ready", sessions: [] }),
    ]);
    expect(onHost.mock.calls.map(([host]) => host)).toEqual(expect.arrayContaining(catalogHosts!));
    expect(invoke).not.toHaveBeenCalled();
    const userSource = terminalHosts?.find((host) => host.label === "Local Codex · user");
    expect(userSource).toBeDefined();
    await expect(
      getProvider()?.startTerminalSession?.({
        agentId: "main",
        hostId: userSource!.hostId,
        cwd: binDir,
      }),
    ).resolves.toMatchObject({
      env: { CODEX_HOME: resolveCodexAppServerUserHomeDir(process.env) },
      cwd: binDir,
    });
    pluginConfig = { appServer: { homeScope: "user" } };
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });
    await expect(
      getProvider()?.openTerminal?.({ hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId }),
    ).resolves.toMatchObject({
      env: { CODEX_HOME: resolveCodexAppServerUserHomeDir(process.env) },
    });
    await expect(
      getProvider()?.openTerminal?.({ hostId: "node:devbox", threadId }),
    ).resolves.toMatchObject({
      kind: "node",
      nodeId: "devbox",
      command: CODEX_TERMINAL_RESUME_COMMAND,
      cwd: "/workspace/node",
    });
    expect(invoke.mock.calls.at(-1)?.[0].params).not.toHaveProperty("searchTerm");

    node.invocableCommands = [CODEX_APP_SERVER_THREADS_LIST_COMMAND];
    await expect(getProvider()?.list({ hostIds: ["node:devbox"] })).resolves.toMatchObject([
      { sessions: [{ threadId, canOpenTerminal: false }] },
    ]);
    await expect(
      getProvider()?.openTerminal?.({ hostId: "node:devbox", threadId }),
    ).rejects.toThrow("paired-node Codex terminal is unavailable");
  });

  it("marks not-loaded local interactive sessions as actionable", async () => {
    const { runtime } = createRuntime();
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createEligibleControl({
        listPage: vi.fn(async () => ({
          sessions: [
            {
              threadId: "thread-1",
              fallbackName: "Readable fallback",
              status: "notLoaded",
              source: "cli",
              archived: false,
            },
          ],
        })),
      }),
      getRuntimeConfig: () => config,
    });

    await expect(getProvider()?.list({})).resolves.toMatchObject([
      {
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        sessions: [
          {
            threadId: "thread-1",
            name: "Readable fallback",
            canContinue: true,
            canArchive: true,
          },
        ],
      },
    ]);
  });

  it("reads local transcript turns one bounded App Server page at a time", async () => {
    const listTurnPage = vi.fn(async () => ({
      data: [
        {
          id: "turn-1",
          items: [
            { id: "item-1", type: "userMessage", text: "question" },
            { id: "item-2", type: "agentMessage", text: "full answer" },
          ],
        },
      ] as never,
      nextCursor: "turns-page-2",
    }));
    const control = createEligibleControl({ listTurnPage });

    await expect(
      readCodexSessionTranscript({
        runtime: createRuntime().runtime,
        control,
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        threadId: "thread-1",
        limit: 50,
      }),
    ).resolves.toEqual({
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      label: "Local Codex",
      threadId: "thread-1",
      items: [
        { id: "item-2", type: "agentMessage", text: "full answer" },
        { id: "item-1", type: "userMessage", text: "question" },
      ],
      nextCursor: "turns-page-2",
    });
    expect(listTurnPage).toHaveBeenCalledWith({
      threadId: "thread-1",
      limit: 50,
      sortDirection: "desc",
      itemsView: "full",
    });
    expect(control.readThread).not.toHaveBeenCalled();
  });

  it("delegates paired-node transcript pagination to the eligible node command", async () => {
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (request) => {
      if (request.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND) {
        return {
          payloadJSON: JSON.stringify({
            sessions: [
              { threadId: "thread-remote", status: "idle", source: "cli", archived: false },
            ],
          }),
        };
      }
      return {
        payloadJSON: JSON.stringify({
          data: [
            {
              id: "turn-remote",
              items: [{ id: "item-remote", type: "userMessage", text: "remote prompt" }],
            },
          ],
          nextCursor: "remote-turns-2",
        }),
      };
    });
    const { runtime } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          displayName: "Devbox",
          connected: true,
          commands: [
            CODEX_APP_SERVER_THREADS_LIST_COMMAND,
            CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
          ],
        },
      ],
      invoke,
    });

    await expect(
      readCodexSessionTranscript({
        runtime,
        control: createControl(),
        hostId: "node:devbox",
        threadId: "thread-remote",
        cursor: "remote-turns-1",
        limit: 25,
      }),
    ).resolves.toEqual({
      hostId: "node:devbox",
      label: "Devbox",
      threadId: "thread-remote",
      items: [{ id: "item-remote", type: "userMessage", text: "remote prompt" }],
      nextCursor: "remote-turns-2",
    });
    expect(invoke).toHaveBeenLastCalledWith({
      nodeId: "devbox",
      command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
      params: {
        agentId: "main",
        threadId: "thread-remote",
        cursor: "remote-turns-1",
        limit: 25,
      },
      timeoutMs: 65_000,
      scopes: ["operator.write"],
    });
  });
});
