// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexSessionCatalogControl,
  continueLocalCodexSession,
  registerCodexSessionCatalog,
  config,
  compatibilityOwnerConfig,
  idleThread,
  createControl,
  createEligibleControl,
  createRuntime,
  archiveTestSession,
  createGatewayApi,
  resolveDefaultAgentDir,
  withEnvAsync,
  createCodexTestBindingStore,
  CODEX_LOCAL_SESSION_HOST_ID,
  type OpenClawConfig,
  originalPath,
  tempDirs,
  fs,
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

describe("Codex supervision actions", () => {
  it("walks the canonical non-archived catalog before continuing a known thread", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const listPage = vi.fn(async (params: { cursor?: string }) =>
      params.cursor
        ? {
            sessions: [
              {
                threadId: "thread-1",
                status: "idle",
                source: "vscode",
                archived: false as const,
              },
            ],
          }
        : {
            sessions: [
              {
                threadId: "other-thread",
                status: "idle",
                source: "cli",
                archived: false as const,
              },
            ],
            nextCursor: "page-2",
          },
    );
    const control = createControl({ listPage });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({ disposition: "forked" });
    expect(listPage).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(listPage).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
      limit: 100,
    });
  });

  it("rejects archived interactive thread ids that are absent from the canonical catalog", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createControl({
      listPage: vi.fn(async () => ({ sessions: [] })),
      readThread: vi.fn(async () => idleThread({ source: "cli" })),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("not a non-archived interactive Codex session");
    await expect(archiveTestSession({ control })).rejects.toThrow(
      "not a non-archived interactive Codex session",
    );
    expect(control.readThread).not.toHaveBeenCalled();
    expect(createSessionEntry).not.toHaveBeenCalled();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("rejects internal App Server thread ids even if a control returns them", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          {
            threadId: "thread-1",
            status: "idle",
            source: "appServer",
            archived: false,
          },
        ],
      })),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("not a non-archived interactive Codex session");
    await expect(archiveTestSession({ control })).rejects.toThrow(
      "not a non-archived interactive Codex session",
    );
    expect(control.readThread).not.toHaveBeenCalled();
  });

  it("fails closed when canonical catalog cursors cycle", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createControl({
      listPage: vi.fn(async () => ({ sessions: [], nextCursor: "cycle" })),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("eligibility could not be verified");
    expect(control.listPage).toHaveBeenCalledTimes(2);
    expect(control.readThread).not.toHaveBeenCalled();
  });

  it("rechecks status and rejects active local sessions before either mutation", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }),
      ),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("active in this App Server");
    await expect(archiveTestSession({ control, bindingStore, runtime })).rejects.toThrow(
      "active in this App Server",
    );
    expect(createSessionEntry).not.toHaveBeenCalled();
    expect(control.archiveThread).not.toHaveBeenCalled();
    expect(control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(control.readThread).toHaveBeenNthCalledWith(2, "thread-1", false);
  });

  it("archives an idle local thread only after the fresh status read", async () => {
    const control = createEligibleControl();
    const readThread = vi.mocked(control.readThread);
    const archiveThread = vi.mocked(control.archiveThread);

    await expect(archiveTestSession({ control })).resolves.toEqual({
      archived: true,
    });
    expect(control.readThread).toHaveBeenCalledWith("thread-1", false);
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(readThread.mock.invocationCallOrder[0]).toBeLessThan(
      archiveThread.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("pins one App Server connection while archive configuration changes live", async () => {
    let pluginConfig: unknown = {
      appServer: { command: "codex-archive-a" },
      supervision: { enabled: true },
    };
    const initialRuntimeConfig = compatibilityOwnerConfig();
    const expectedAgentDir = resolveDefaultAgentDir(initialRuntimeConfig);
    let runtimeConfig = initialRuntimeConfig;
    pinnedConnectionMocks.request.mockImplementation(
      async (request: { method: string; requestParams?: Record<string, unknown> }) => {
        if (
          request.method === "thread/list" &&
          request.requestParams?.ancestorThreadId === undefined
        ) {
          pluginConfig = {
            appServer: { command: "codex-archive-b", homeScope: "agent" },
            supervision: { enabled: true },
          };
          runtimeConfig = {
            agents: { defaults: { workspace: "/workspace/b" } },
          } as OpenClawConfig;
          return {
            data: [idleThread({ source: "cli" })],
          };
        }
        if (request.method === "thread/read") {
          return { thread: idleThread() };
        }
        if (request.method === "thread/list") {
          return { data: [] };
        }
        if (request.method === "thread/archive") {
          return {};
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    );
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => runtimeConfig,
    });

    await expect(archiveTestSession({ config: initialRuntimeConfig, control })).resolves.toEqual({
      archived: true,
    });

    expect(pinnedConnectionMocks.getClient).toHaveBeenCalledOnce();
    const acquisition = pinnedConnectionMocks.getClient.mock.calls[0]?.[0];
    expect(acquisition).toMatchObject({
      agentDir: expectedAgentDir,
      startOptions: expect.objectContaining({ command: "codex-archive-a", homeScope: "user" }),
      config: { agents: { list: [{ id: "alpha" }, { id: "beta" }] } },
    });
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/list",
      "thread/read",
      "thread/list",
      "thread/archive",
    ]);
    for (const [request] of pinnedConnectionMocks.request.mock.calls) {
      expect(request.client).toBe(pinnedConnectionMocks.client);
      expect(request.config).toBe(acquisition?.config);
    }
    expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledWith(pinnedConnectionMocks.client);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("finishes a pinned archive when supervision config changes", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    let listCalls = 0;
    pinnedConnectionMocks.request.mockImplementation(async (request: { method: string }) => {
      if (request.method === "thread/list") {
        listCalls += 1;
        return listCalls === 1 ? { data: [idleThread({ source: "cli" })] } : { data: [] };
      }
      if (request.method === "thread/read") {
        pluginConfig = { supervision: { enabled: false } };
        return { thread: idleThread() };
      }
      if (request.method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(archiveTestSession({ control })).resolves.toEqual({ archived: true });
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/list",
      "thread/read",
      "thread/list",
      "thread/archive",
    ]);
    expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledWith(pinnedConnectionMocks.client);
  });

  it("rejects archive while another OpenClaw session owns the native thread", async () => {
    const bindingStore = createCodexTestBindingStore();
    await bindingStore.mutate(
      { kind: "conversation", bindingId: "bound-chat" },
      {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/workspace/project" },
      },
    );
    const control = createEligibleControl();

    await expect(archiveTestSession({ bindingStore, control })).rejects.toThrow(
      "attached to an OpenClaw session",
    );
    expect(control.readThread).toHaveBeenCalledWith("thread-1", false);
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("rejects archive when a paginated spawned descendant has an OpenClaw owner", async () => {
    const bindingStore = createCodexTestBindingStore();
    await bindingStore.mutate(
      { kind: "conversation", bindingId: "descendant-chat" },
      {
        kind: "set",
        binding: { threadId: "owned-descendant", cwd: "/workspace/project" },
      },
    );
    const control = createEligibleControl({
      listDescendantPage: vi.fn(async (params) =>
        params.cursor === "descendants-2"
          ? { data: [idleThread({ id: "owned-descendant" })] }
          : {
              data: [idleThread({ id: "unowned-descendant" })],
              nextCursor: "descendants-2",
            },
      ),
    });

    await expect(archiveTestSession({ bindingStore, control })).rejects.toThrow(
      "spawned descendant is owned by an OpenClaw session",
    );
    expect(control.listDescendantPage).toHaveBeenNthCalledWith(1, {
      ancestorThreadId: "thread-1",
      archived: false,
      limit: 100,
      sortKey: "created_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    expect(control.listDescendantPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "descendants-2" }),
    );
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("rejects archive when a spawned descendant is active", async () => {
    const control = createEligibleControl({
      listDescendantPage: vi.fn(async () => ({ data: [{ id: "active-descendant" }] })),
      readThread: vi.fn(async (threadId: string) =>
        idleThread({
          id: threadId,
          status: threadId === "active-descendant" ? { type: "active" } : { type: "idle" },
        }),
      ),
    });

    await expect(archiveTestSession({ control })).rejects.toThrow(
      "Codex session is active in this App Server",
    );
    expect(control.readThread).toHaveBeenCalledWith("active-descendant", false);
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("fences ownership mutations while validating and archiving the native subtree", async () => {
    const bindingStore = createCodexTestBindingStore();
    const lateIdentity = { kind: "conversation" as const, bindingId: "late-descendant-owner" };
    let validationReached!: () => void;
    const validating = new Promise<void>((resolve) => {
      validationReached = resolve;
    });
    let releaseValidation!: () => void;
    const validationReleased = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const listDescendantPage = vi.fn(async () => {
      validationReached();
      await validationReleased;
      return { data: [{ id: "idle-descendant" }] };
    });
    const control = createEligibleControl({ listDescendantPage });

    const archiving = archiveTestSession({ bindingStore, control });
    await validating;
    await expect(
      bindingStore.mutate(lateIdentity, {
        kind: "set",
        binding: { threadId: "late-descendant", cwd: "/workspace/project" },
      }),
    ).rejects.toThrow("native archive is in progress");
    releaseValidation();
    await expect(archiving).resolves.toEqual({ archived: true });
    await expect(bindingStore.read(lateIdentity)).resolves.toBeUndefined();
    expect(control.readThread).toHaveBeenCalledWith("idle-descendant", false);
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it.each([
    {
      name: "a repeated cursor",
      response: { data: [], nextCursor: "cycle" },
      error: "repeated descendant-list cursor",
      calls: 2,
    },
    {
      name: "the ancestor as its own descendant",
      response: { data: [idleThread({ id: "thread-1" })] },
      error: "cyclic descendant thread list",
      calls: 1,
    },
    {
      name: "an invalid response",
      response: { data: null },
      error: "invalid descendant-list response",
      calls: 1,
    },
  ])(
    "fails closed when descendant enumeration returns $name",
    async ({ response, error, calls }) => {
      const control = createEligibleControl({
        listDescendantPage: vi.fn(async () => response as never),
      });

      await expect(archiveTestSession({ control })).rejects.toThrow(error);
      expect(control.listDescendantPage).toHaveBeenCalledTimes(calls);
      expect(control.archiveThread).not.toHaveBeenCalled();
    },
  );

  it("fails closed when descendant enumeration reaches its page cap", async () => {
    let page = 0;
    const control = createEligibleControl({
      listDescendantPage: vi.fn(async () => {
        page += 1;
        return {
          data: [idleThread({ id: `descendant-${page}` })],
          nextCursor: `descendants-${page}`,
        };
      }),
    });

    await expect(archiveTestSession({ control })).rejects.toThrow(
      "descendant enumeration exceeded its safety limit",
    );
    expect(control.listDescendantPage).toHaveBeenCalledTimes(100);
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("rejects an archive when the fresh read returns a different thread", async () => {
    const control = createEligibleControl({
      readThread: vi.fn(async () => idleThread({ id: "different-thread" })),
    });

    await expect(archiveTestSession({ control })).rejects.toThrow(
      "returned a different thread than requested",
    );
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("archives a not-loaded local thread after explicit runner confirmation", async () => {
    const control = createEligibleControl({
      readThread: vi.fn(async () => idleThread({ status: { type: "notLoaded" } })),
    });

    await expect(archiveTestSession({ control })).resolves.toEqual({
      archived: true,
    });
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("registers generic actions and keeps paired-node archive view-only", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api, getProvider, registerSessionCatalog } = createGatewayApi(runtime);
    const control = createEligibleControl();
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });
    expect(registerSessionCatalog).toHaveBeenCalledOnce();
    const provider = getProvider();
    expect(provider?.resolveCreateSession?.({ agentId: "main" })).toEqual({
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
    });
    await withEnvAsync({ CODEX_HOME: undefined }, async () => {
      await expect(
        provider?.continueSession?.({
          allowProcessHomeFallback: false,
          hostId: CODEX_LOCAL_SESSION_HOST_ID,
          threadId: "thread-1",
          clientScopes: ["operator.admin"],
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
      await expect(
        provider?.archive?.({
          allowProcessHomeFallback: false,
          hostId: CODEX_LOCAL_SESSION_HOST_ID,
          threadId: "thread-1",
          confirmNoOtherRunner: true,
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
      await expect(
        provider?.openTerminal?.({
          allowProcessHomeFallback: false,
          hostId: CODEX_LOCAL_SESSION_HOST_ID,
          threadId: "thread-1",
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
      await expect(
        provider?.startTerminalSession?.({
          allowProcessHomeFallback: false,
          agentId: "main",
          cwd: process.cwd(),
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
    });
    await expect(
      provider?.archive?.({
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        threadId: "thread-1",
        confirmNoOtherRunner: false,
      } as never),
    ).rejects.toThrow("requires confirmation");
    await expect(
      provider?.archive?.({
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        threadId: "thread-1",
        confirmNoOtherRunner: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      provider?.archive?.({
        allowProcessHomeFallback: false,
        hostId: "node:devbox",
        threadId: "thread-remote",
        confirmNoOtherRunner: true,
      }),
    ).rejects.toThrow("paired-node Codex sessions are view-only");
    await expect(
      provider?.continueSession?.({
        allowProcessHomeFallback: false,
        hostId: "node:devbox",
        threadId: "thread-remote",
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("paired node does not permit Codex session continuation");
    expect(control.readThread).toHaveBeenCalledOnce();
    expect(control.archiveThread).toHaveBeenCalledOnce();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });
});
