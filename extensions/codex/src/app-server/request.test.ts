// Codex tests cover request plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  CodexAppServerStartSelectionChangedError: class extends Error {
    readonly code = "CODEX_APP_SERVER_START_SELECTION_CHANGED";
  },
  createIsolatedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
  isCodexAppServerStartSelectionChangedError: (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_START_SELECTION_CHANGED",
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
}));

const { readCodexAppServerUsage, requestCodexAppServerJson, withCodexAppServerJsonClient } =
  await import("./request.js");
const { listAllCodexAppServerModels } = await import("./models.js");

const expectDeadlineOptions = () =>
  expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.anything() });

describe("requestCodexAppServerJson sandbox guard", () => {
  beforeEach(() => {
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed before raw app-server bypass methods in sandboxed sessions", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed before raw app-server bypass methods when exec host=node is active", async () => {
    for (const method of ["command/exec", "process/spawn"]) {
      await expect(
        requestCodexAppServerJson({
          method,
          requestParams: { command: ["sh", "-lc", "id"] },
          config: { tools: { exec: { host: "node", node: "worker-1" } } },
          sessionKey: "node-session",
        }),
      ).rejects.toThrow(
        `Codex-native app-server method \`${method}\` is unavailable because OpenClaw exec host=node is active for this session.`,
      );
    }

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith("thread/list", { limit: 10 }, expectDeadlineOptions());
  });

  it.each([
    {
      method: "app/installed" as const,
      requestParams: { threadId: "thread-1", forceRefresh: false },
      response: { apps: [] },
    },
    {
      method: "app/read" as const,
      requestParams: { appIds: ["calendar-app"], includeTools: false },
      response: { apps: [] },
    },
    {
      method: "plugin/installed" as const,
      requestParams: { cwds: [] },
      response: { marketplaces: [], marketplaceLoadErrors: [] },
    },
    {
      method: "config/batchWrite" as const,
      requestParams: {
        edits: [
          {
            keyPath: 'apps."calendar".tools."create".approval_mode',
            value: null,
            mergeStrategy: "replace" as const,
          },
        ],
      },
      response: {
        status: "ok",
        version: "1",
        filePath: "/codex/config.toml",
        overriddenMetadata: null,
      },
    },
  ])(
    "allows the $method control-plane request under sandbox and node execution policies",
    async ({ method, requestParams, response }) => {
      const request = vi.fn(async () => response);
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

      for (const policy of [
        {
          config: { agents: { defaults: { sandbox: { mode: "all" as const } } } },
          sessionKey: "sandboxed-session",
        },
        {
          config: { tools: { exec: { host: "node" as const, node: "worker-1" } } },
          sessionKey: "node-session",
        },
      ]) {
        await expect(
          requestCodexAppServerJson({
            method,
            requestParams,
            ...policy,
          }),
        ).resolves.toEqual(response);
      }

      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, method, requestParams, expectDeadlineOptions());
      expect(request).toHaveBeenNthCalledWith(2, method, requestParams, expectDeadlineOptions());
    },
  );

  it.each([
    {
      description: "sandboxed",
      config: { agents: { defaults: { sandbox: { mode: "all" as const } } } },
      sessionKey: "sandboxed-session",
      reason: "OpenClaw sandboxing is active for this session",
    },
    {
      description: "node-hosted",
      config: { tools: { exec: { host: "node" as const, node: "worker-1" } } },
      sessionKey: "node-session",
      reason: "OpenClaw exec host=node is active for this session",
    },
  ])(
    "fails closed for unlisted app methods in $description sessions",
    async ({ config, sessionKey, reason }) => {
      await expect(
        requestCodexAppServerJson({
          method: "app/activate",
          requestParams: {},
          config,
          sessionKey,
        }),
      ).rejects.toThrow(
        `Codex-native app-server method \`app/activate\` is unavailable because ${reason}.`,
      );

      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    },
  );

  it("allows current native thread management methods in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    for (const method of ["thread/name/set", "thread/archive", "thread/unarchive"] as const) {
      await expect(
        requestCodexAppServerJson({
          method,
          requestParams:
            method === "thread/name/set"
              ? { threadId: "thread-1", name: "Shared thread" }
              : { threadId: "thread-1" },
          config: { agents: { defaults: { sandbox: { mode: "all" } } } },
          sessionKey: "sandboxed-session",
        }),
      ).resolves.toEqual({ ok: true });
    }

    expect(request).toHaveBeenCalledTimes(3);
  });

  it("fails closed for config-level exec host=node even without a session key", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed for MCP reload when config-level exec host=node is active", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "config/mcpServer/reload",
        requestParams: {},
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `config/mcpServer/reload` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods when exec host=node is active", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
        sessionKey: "node-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith("thread/list", { limit: 10 }, expectDeadlineOptions());
  });

  it("allows config value writes in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      keyPath: 'apps."google-calendar-app".tools',
      value: null,
      mergeStrategy: "replace",
    };

    await expect(
      requestCodexAppServerJson({
        method: "config/value/write",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith("config/value/write", params, expectDeadlineOptions());
  });

  it("allows config reads in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ config: { apps: { apps: {} } } }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = { includeLayers: false };

    await expect(
      requestCodexAppServerJson({
        method: "config/read",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ config: { apps: { apps: {} } } });

    expect(request).toHaveBeenCalledWith("config/read", params, expectDeadlineOptions());
  });

  it("allows sandbox-pinned thread starts in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ thread: { id: "thread-1" }, model: "gpt-5.5" }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ thread: { id: "thread-1" }, model: "gpt-5.5" });

    expect(request).toHaveBeenCalledWith("thread/start", params, expectDeadlineOptions());
  });

  it("retries a config-loading request with a fresh shared client", async () => {
    const firstRequest = vi.fn(async () => {
      throw new sharedClientMocks.CodexAppServerStartSelectionChangedError();
    });
    const secondRequest = vi.fn(async () => ({ thread: { id: "thread-2" } }));
    const firstClient = { request: firstRequest };
    const secondClient = { request: secondRequest };
    sharedClientMocks.getSharedCodexAppServerClient
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const params = { cwd: "/workspace" };

    await expect(
      requestCodexAppServerJson({ method: "thread/start", requestParams: params }),
    ).resolves.toEqual({ thread: { id: "thread-2" } });

    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledWith(
      firstClient,
    );
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      firstClient,
    );
    expect(secondRequest).toHaveBeenCalledWith("thread/start", params, expectDeadlineOptions());
  });

  it("abandons a pending acquisition without issuing a request after the deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ ok: true }));
    type TestClient = { request: typeof request };
    const client: TestClient = { request };
    let resolveAcquire: ((client: TestClient) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockImplementationOnce(
      () =>
        new Promise<TestClient>((resolve) => {
          resolveAcquire = resolve;
        }),
    );

    const result = requestCodexAppServerJson({
      method: "thread/list",
      requestParams: { limit: 10 },
      timeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow("codex app-server thread/list timed out");
    const acquireOptions = sharedClientMocks.getSharedCodexAppServerClient.mock.calls[0]?.[0] as
      | { abandonSignal?: AbortSignal; timeoutMs?: number }
      | undefined;

    expect(acquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(acquireOptions?.timeoutMs).toBeLessThanOrEqual(50);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(acquireOptions?.abandonSignal?.aborted).toBe(true);

    resolveAcquire?.(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("shares one deadline across a selection retry and suppresses a late request", async () => {
    vi.useFakeTimers();
    const firstRequest = vi.fn(
      (
        _method: string,
        _params: unknown,
        _options?: { signal?: AbortSignal; timeoutMs?: number },
      ) =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new sharedClientMocks.CodexAppServerStartSelectionChangedError()),
            40,
          );
        }),
    );
    const secondRequest = vi.fn(async () => ({ thread: { id: "thread-2" } }));
    const firstClient = { request: firstRequest };
    const secondClient = { request: secondRequest };
    let resolveRetryAcquire: ((client: typeof secondClient) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient
      .mockResolvedValueOnce(firstClient)
      .mockImplementationOnce(
        () =>
          new Promise<typeof secondClient>((resolve) => {
            resolveRetryAcquire = resolve;
          }),
      );

    const params = { cwd: "/workspace" };
    const result = requestCodexAppServerJson({
      method: "thread/start",
      requestParams: params,
      timeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow("codex app-server thread/start timed out");

    await vi.advanceTimersByTimeAsync(40);
    expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
    const firstAcquireOptions = sharedClientMocks.getSharedCodexAppServerClient.mock
      .calls[0]?.[0] as { abandonSignal?: AbortSignal; timeoutMs?: number } | undefined;
    const retryAcquireOptions = sharedClientMocks.getSharedCodexAppServerClient.mock
      .calls[1]?.[0] as { abandonSignal?: AbortSignal; timeoutMs?: number } | undefined;
    const firstRequestOptions = firstRequest.mock.calls[0]?.[2] as
      | { signal?: AbortSignal; timeoutMs?: number }
      | undefined;
    expect(firstAcquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(firstAcquireOptions?.timeoutMs).toBeLessThanOrEqual(50);
    expect(firstRequestOptions?.signal).toBe(firstAcquireOptions?.abandonSignal);
    expect(firstRequestOptions?.timeoutMs).toBeGreaterThan(0);
    expect(firstRequestOptions?.timeoutMs).toBeLessThanOrEqual(50);
    expect(retryAcquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(retryAcquireOptions?.timeoutMs).toBeLessThanOrEqual(10);
    expect(retryAcquireOptions?.abandonSignal).toBe(firstAcquireOptions?.abandonSignal);

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(firstAcquireOptions?.abandonSignal?.aborted).toBe(true);

    resolveRetryAcquire?.(secondClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it("does not resume or publish a control attachment after its passive preflight times out", async () => {
    const { codexControlRequest } = await import("../command-rpc.js");
    vi.useFakeTimers();
    let releasePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const request = vi.fn(async (_method: string) => ({ thread: { id: "thread-1" } }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const onResponse = vi.fn();

    const result = codexControlRequest(
      {},
      "thread/resume",
      { threadId: "thread-1" },
      {
        authProfileId: null,
        timeoutMs: 50,
        beforeRequest: async (send) => {
          await send({
            method: "thread/read",
            requestParams: { threadId: "thread-1", includeTurns: false },
          });
          await preflight;
        },
        onResponse,
      },
    );
    const settled = result.then(
      (value) => ({ status: "fulfilled", value }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: expect.stringContaining("timed out") }),
    });
    releasePreflight();
    await vi.advanceTimersByTimeAsync(0);

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
    expect(onResponse).not.toHaveBeenCalled();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
  });

  it("revokes scoped requests and mutation authority when their client lease ends", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const retained = await withCodexAppServerJsonClient({}, async (send, _client, scope) => {
      await send({ method: "thread/read", requestParams: { threadId: "thread-1" } });
      return { send, assertCurrent: scope.assertCurrent };
    });

    expect(retained.assertCurrent).toThrow();
    await expect(
      retained.send({ method: "thread/resume", requestParams: { threadId: "thread-1" } }),
    ).rejects.toThrow();
    await expect(listAllCodexAppServerModels({ request: retained.send })).rejects.toThrow(
      "codex app-server request timed out",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not request another model page after the shared deadline", async () => {
    vi.useFakeTimers();
    const page = createDeferred<{ data: never[]; nextCursor: string }>();
    const request = vi.fn(() => page.promise);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const result = withCodexAppServerJsonClient({ timeoutMs: 50 }, async (scopedRequest) =>
      listAllCodexAppServerModels({ request: scopedRequest }),
    );
    const rejection = expect(result).rejects.toThrow("codex app-server request timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    page.resolve({ data: [], nextCursor: "next-page" });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it("blocks thread starts with sandbox environments when exec host=node is active", async () => {
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "node", node: "worker-1" } },
        },
        sessionKey: "node-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `thread/start` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("shares one guarded isolated client across installed-plugin and account reads", async () => {
    const installed = { marketplaces: [], marketplaceLoadErrors: [] };
    const account = { account: { email: "codex-source@example.com" } };
    const request = vi.fn(async (method: string) =>
      method === "plugin/installed" ? installed : account,
    );
    const closeAndWait = vi.fn(async () => undefined);
    sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue({
      request,
      closeAndWait,
    });
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
      env: { CODEX_HOME: "/source/.codex", HOME: "/source" },
    };

    await expect(
      withCodexAppServerJsonClient(
        { timeoutMs: 5_000, startOptions, authProfileId: null, isolated: true },
        async (scopedRequest) => ({
          installed: await scopedRequest<typeof installed>({
            method: "plugin/installed",
            requestParams: { cwds: [] },
          }),
          account: await scopedRequest<typeof account>({
            method: "account/read",
            requestParams: { refreshToken: false },
          }),
        }),
      ),
    ).resolves.toEqual({ installed, account });

    expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ startOptions, authProfileId: null }),
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "plugin/installed",
      { cwds: [] },
      expectDeadlineOptions(),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "account/read",
      { refreshToken: false },
      expectDeadlineOptions(),
    );
    expect(closeAndWait).toHaveBeenCalledExactlyOnceWith({
      exitTimeoutMs: 2_000,
      forceKillDelayMs: 250,
    });
  });

  it("reads usage and account identity over one isolated client", async () => {
    const request = vi.fn(async (method: string) =>
      method === "account/rateLimits/read"
        ? { rateLimitsByLimitId: { codex: { limitId: "codex" } } }
        : { account: { email: "codex-account@example.com" } },
    );
    const closeAndWait = vi.fn(async () => undefined);
    sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue({
      request,
      closeAndWait,
    });

    await expect(
      readCodexAppServerUsage({
        timeoutMs: 3_500,
        authProfileId: "openai:test",
      }),
    ).resolves.toEqual({
      rateLimits: { rateLimitsByLimitId: { codex: { limitId: "codex" } } },
      accountEmail: "codex-account@example.com",
    });
    expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:test",
        timeoutMs: expect.any(Number),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "account/rateLimits/read",
      undefined,
      expectDeadlineOptions(),
    );
    expect(request).toHaveBeenNthCalledWith(2, "account/read", {}, expectDeadlineOptions());
    expect(closeAndWait).toHaveBeenCalledWith({ exitTimeoutMs: 300, forceKillDelayMs: 200 });
  });
});
