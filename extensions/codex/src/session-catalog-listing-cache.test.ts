// Codex supervision tests cover passive listing and safe local session takeover.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexSessionCatalogControl,
  config,
  idleThread,
  resolveDefaultAgentDir,
  requireCatalogEligibleThread,
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

describe("Codex supervision catalog", () => {
  it("memoizes cloned request options until runtime config identity changes", async () => {
    let runtimeConfig = { agents: { defaults: { workspace: "/workspace/a" } } } as OpenClawConfig;
    commandRpcMocks.codexControlRequest.mockResolvedValue({ thread: idleThread() });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    });
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");

    await control.readThread("thread-1");
    await control.readThread("thread-1");
    expect(cloneSpy).toHaveBeenCalledTimes(2);

    runtimeConfig = { agents: { defaults: { workspace: "/workspace/b" } } } as OpenClawConfig;
    await control.readThread("thread-1");
    expect(cloneSpy).toHaveBeenCalledTimes(4);
  });

  it("serves an expired page while one background refresh updates the next poll", async () => {
    let now = 1_000;
    let runtimeConfig = {} as OpenClawConfig;
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-stale", source: "cli" })],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
      now: () => now,
    });

    await control.listPage({ limit: 25 });
    await control.listPage({ limit: 25 });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();

    now += 31_999;
    await control.listPage({ limit: 25 });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();

    now += 2;
    let resolveRefresh!: (value: unknown) => void;
    let refreshSettled = false;
    const refresh = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    }).then((value) => {
      refreshSettled = true;
      return value;
    });
    commandRpcMocks.codexControlRequest.mockReturnValueOnce(refresh);
    const firstExpiredPoll = control.listPage({ limit: 25 });
    const overlappingExpiredPoll = control.listPage({ limit: 25 });

    await expect(Promise.all([firstExpiredPoll, overlappingExpiredPoll])).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "thread-stale" })],
      }),
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "thread-stale" })],
      }),
    ]);
    expect(refreshSettled).toBe(false);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

    resolveRefresh({ data: [idleThread({ id: "thread-refreshed", source: "cli" })] });
    await vi.waitFor(async () => {
      await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
        sessions: [expect.objectContaining({ threadId: "thread-refreshed" })],
      });
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

    runtimeConfig = { agents: {} } as OpenClawConfig;
    await control.listPage({ limit: 25 });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
  });

  it("serves the last real page after a refresh failure and retries the next poll", async () => {
    let now = 1_000;
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-stale", source: "cli" })],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => now,
    });
    const first = await control.listPage({ limit: 25 });

    now += 32_001;
    commandRpcMocks.codexControlRequest.mockRejectedValueOnce(new Error("app-server unavailable"));
    await expect(control.listPage({ limit: 25 })).resolves.toEqual(first);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-recovered", source: "cli" })],
    });
    await expect(control.listPage({ limit: 25 })).resolves.toEqual(first);
    await vi.waitFor(async () => {
      await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
        sessions: [expect.objectContaining({ threadId: "thread-recovered" })],
      });
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
  });

  it("evicts a cold failed page so the next caller retries immediately", async () => {
    commandRpcMocks.codexControlRequest.mockRejectedValueOnce(new Error("cold failure"));
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 25 })).rejects.toThrow("cold failure");
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-recovered", source: "cli" })],
    });
    await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "thread-recovered" })],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("propagates a forced refresh failure while preserving the stale retry state", async () => {
    let now = 1_000;
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-stale", source: "cli" })],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => now,
    });
    await control.listPage({ limit: 25 });

    commandRpcMocks.codexControlRequest.mockRejectedValueOnce(new Error("forced refresh failed"));
    await expect(control.listPage({ limit: 25, forceRefresh: true })).rejects.toThrow(
      "forced refresh failed",
    );

    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-recovered", source: "cli" })],
    });
    now += 1;
    await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "thread-stale" })],
    });
    await vi.waitFor(async () => {
      await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
        sessions: [expect.objectContaining({ threadId: "thread-recovered" })],
      });
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
  });

  it("serves stale data to a passive waiter overlapping a failed forced refresh", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-stale", source: "cli" })],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });
    const stale = await control.listPage({ limit: 25 });
    let rejectRefresh!: (error: Error) => void;
    commandRpcMocks.codexControlRequest.mockImplementationOnce(
      async () =>
        await new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );

    const forced = control.listPage({ limit: 25, forceRefresh: true });
    await vi.waitFor(() => expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2));
    const passive = control.listPage({ limit: 25 });
    const forcedResult = expect(forced).rejects.toThrow("forced refresh failed");
    rejectRefresh(new Error("forced refresh failed"));

    await forcedResult;
    await expect(passive).resolves.toEqual(stale);
  });

  it("does not expose a pending cold fill as stale after a forced refresh overtakes it", async () => {
    let resolveCold!: (value: unknown) => void;
    let resolveForced!: (value: unknown) => void;
    commandRpcMocks.codexControlRequest
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCold = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveForced = resolve;
        }),
      );
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    const cold = control.listPage({ limit: 25 });
    const forced = control.listPage({ limit: 25, forceRefresh: true });
    const passive = control.listPage({ limit: 25 });
    resolveForced({ data: [idleThread({ id: "thread-forced", source: "cli" })] });

    await expect(Promise.all([forced, passive])).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "thread-forced" })],
      }),
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "thread-forced" })],
      }),
    ]);

    resolveCold({ data: [idleThread({ id: "thread-cold", source: "cli" })] });
    await expect(cold).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "thread-cold" })],
    });
    await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "thread-forced" })],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("force-refreshes after a cached specific-thread miss", async () => {
    let includeThread = false;
    commandRpcMocks.codexControlRequest.mockImplementation(async () => ({
      data: includeThread ? [idleThread({ id: "thread-new", source: "cli" })] : [],
    }));
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });
    await control.listPage({ limit: 100 });
    includeThread = true;

    await expect(requireCatalogEligibleThread(control, "thread-new")).resolves.toMatchObject({
      threadId: "thread-new",
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("scans bounded native pages for complete title-only search results", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (_pluginConfig: unknown, _method: string, request: Record<string, unknown>) => {
        if (request.cursor === "page-3") {
          return {
            data: [idleThread({ id: "match-2", name: "MATCH two", source: "vscode" })],
          };
        }
        if (request.cursor === "page-2") {
          return {
            data: [
              idleThread({ id: "match-1", name: "Match one", source: "cli" }),
              idleThread({ id: "private-2", name: "Other", source: "cli" }),
            ],
            nextCursor: "page-3",
          };
        }
        return {
          data: [idleThread({ id: "private-1", name: "Unrelated", source: "cli" })],
          nextCursor: "page-2",
          backwardsCursor: "previous-page",
        };
      },
    );
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 2, searchTerm: "match" })).resolves.toEqual({
      sessions: [
        expect.objectContaining({ threadId: "match-1", name: "Match one" }),
        expect.objectContaining({ threadId: "match-2", name: "MATCH two" }),
      ],
      backwardsCursor: "previous-page",
    });
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ limit: 2 }),
      expect.objectContaining({ cursor: "page-2", limit: 2 }),
      expect.objectContaining({ cursor: "page-3", limit: 1 }),
    ]);
    for (const call of commandRpcMocks.codexControlRequest.mock.calls) {
      expect(call[2]).not.toHaveProperty("searchTerm");
    }
  });

  it("returns the last native cursor when a title search reaches its scan cap", async () => {
    let page = 0;
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      page += 1;
      return {
        data: [idleThread({ id: `private-${page}`, name: "Unrelated", source: "cli" })],
        nextCursor: `page-${page}`,
      };
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).resolves.toEqual({
      sessions: [],
      nextCursor: "page-20",
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(20);
  });

  it("fails closed when title-search cursors cycle", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ name: "Unrelated", source: "cli" })],
      nextCursor: "cycle",
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).rejects.toThrow(
      "repeated search cursor",
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("shares one timeout budget across title-search pages", async () => {
    let elapsedMs = 0;
    let page = 0;
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      page += 1;
      elapsedMs += 600;
      return {
        data: [idleThread({ id: `other-${page}`, name: "Unrelated", source: "cli" })],
        nextCursor: `page-${page}`,
      };
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({
        appServer: { requestTimeoutMs: 1_000 },
        supervision: { enabled: true },
      }),
      getRuntimeConfig: () => config,
      now: () => elapsedMs,
    });

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).rejects.toThrow(
      "catalog listing timed out",
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[3]?.timeoutMs),
    ).toEqual([1_000, 400]);
  });

  it("keeps a title-search cursor chain on its initial App Server configuration", async () => {
    let pluginConfig = {
      appServer: { command: "codex-initial" },
      supervision: { enabled: true },
    };
    commandRpcMocks.codexControlRequest
      .mockImplementationOnce(async () => {
        pluginConfig = {
          appServer: { command: "codex-reconfigured" },
          supervision: { enabled: true },
        };
        return {
          data: [idleThread({ id: "other", name: "Unrelated", source: "cli" })],
          nextCursor: "page-2",
        };
      })
      .mockResolvedValueOnce({
        data: [idleThread({ id: "match", name: "Match", source: "cli" })],
      });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 1, searchTerm: "match" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "match" })],
    });
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.map(
        (call) => (call[3]?.startOptions as { command?: string } | undefined)?.command,
      ),
    ).toEqual(["codex-initial", "codex-initial"]);
  });

  it("rejects an oversized direct catalog cursor before native I/O", async () => {
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ cursor: "x".repeat(4097) })).rejects.toThrow(
      "invalid Codex session catalog request cursor",
    );
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it.each(["nextCursor", "backwardsCursor"] as const)(
    "rejects an oversized native %s",
    async (cursorField) => {
      commandRpcMocks.codexControlRequest.mockResolvedValue({
        data: [],
        [cursorField]: "x".repeat(4097),
      });
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
      });

      await expect(control.listPage({})).rejects.toThrow(
        `invalid Codex session catalog ${cursorField === "nextCursor" ? "next" : "backwards"} response cursor`,
      );
    },
  );

  it("keeps every Codex interactive source while omitting other custom sources", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        idleThread({ id: "cli", source: "cli" }),
        idleThread({ id: "vscode", source: "vscode" }),
        idleThread({ id: "atlas", source: { custom: "atlas" } }),
        idleThread({ id: "chatgpt", source: { custom: "chatgpt" } }),
        idleThread({ id: "exec", source: "exec" }),
        idleThread({ id: "app-server", source: "appServer" }),
        idleThread({ id: "subagent", source: { subAgent: "review" } }),
        idleThread({ id: "custom", source: { custom: "integration" } }),
        idleThread({ id: "unknown", source: "unknown" }),
        idleThread({ id: "missing" }),
      ],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    const page = await control.listPage({});

    expect(page.sessions.map((session) => session.threadId)).toEqual([
      "cli",
      "vscode",
      "atlas",
      "chatgpt",
    ]);
    expect(page.sessions.map((session) => session.source)).toEqual([
      "cli",
      "vscode",
      "atlas",
      "chatgpt",
    ]);
  });

  it("keeps takeover forking out of the passive catalog control", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    const response = { thread: idleThread({ id: "thread-source" }) };
    commandRpcMocks.codexControlRequest.mockResolvedValue(response);
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.readThread("thread-source", true)).resolves.toBe(response.thread);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      "thread/read",
      { threadId: "thread-source", includeTurns: true },
      {
        agentDir: resolveDefaultAgentDir(config),
        config,
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      },
    );
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1])).not.toContain(
      "thread/fork",
    );
  });

  it("keeps catalog reads and writes available when supervision is disabled live", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    let runtimeConfig = {} as OpenClawConfig;
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => runtimeConfig,
    });

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });
    pluginConfig = { supervision: { enabled: false } };
    runtimeConfig = { plugins: {} } as OpenClawConfig;

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-flight catalog independent of supervision changes", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      pluginConfig = { supervision: { enabled: false } };
      return {
        data: [idleThread({ id: "other", name: "Unrelated", source: "cli" })],
        nextCursor: "page-2",
      };
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    commandRpcMocks.codexControlRequest.mockImplementationOnce(async () => {
      pluginConfig = { supervision: { enabled: false } };
      return { data: [] };
    });
    await expect(control.listPage({ limit: 10, searchTerm: "match" })).resolves.toEqual({
      sessions: [],
    });
  });
});
