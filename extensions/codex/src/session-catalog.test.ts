// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { sessionBindingIdentity } from "./app-server/session-binding.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.test-helpers.js";
import {
  archiveLocalCodexSession,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  CODEX_SESSION_ARCHIVE_METHOD,
  CODEX_SESSION_CATALOG_METHOD,
  CODEX_SESSION_CONTINUE_METHOD,
  CODEX_SESSION_READ_METHOD,
  continueLocalCodexSession,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogNodeHostCommands,
  listCodexSessionCatalog,
  registerCodexSessionCatalogGateway,
  readCodexSessionTranscript,
  type CodexSessionCatalogControl,
} from "./session-catalog.js";

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

type CreateSessionEntryParams = Parameters<
  PluginRuntime["agent"]["session"]["createSessionEntry"]
>[0];
type CreateSessionEntryResult = Awaited<
  ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>
>;
type PatchSessionEntryParams = Parameters<
  PluginRuntime["agent"]["session"]["patchSessionEntry"]
>[0];
type SessionEntrySummary = ReturnType<
  PluginRuntime["agent"]["session"]["listSessionEntries"]
>[number];
type GatewayHandler = (options: GatewayRequestHandlerOptions) => void | Promise<void>;

const config = {} as OpenClawConfig;

function idleThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    name: "Continue native task",
    cwd: "/workspace/project",
    status: { type: "idle" },
    ...overrides,
  };
}

function createControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  const withPinnedConnection = vi.fn(
    async (run: (value: CodexSessionCatalogControl) => Promise<unknown>) => await run(control),
  ) as unknown as CodexSessionCatalogControl["withPinnedConnection"];
  const control = {
    assertEnabled: vi.fn(),
    connectionFingerprint: "catalog-connection",
    withPinnedConnection,
    listPage: vi.fn(async () => ({ sessions: [] })),
    listDescendantPage: vi.fn(async () => ({ data: [] })),
    listTurnPage: vi.fn(async () => ({ data: [] })),
    readThread: vi.fn(async (threadId: string) => idleThread({ id: threadId })),
    archiveThread: vi.fn(async () => undefined),
    ...overrides,
  } as CodexSessionCatalogControl;
  return control;
}

function createEligibleControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  return createControl({
    listPage: vi.fn(async () => ({
      sessions: [{ threadId: "thread-1", status: "idle", source: "cli", archived: false as const }],
    })),
    ...overrides,
  });
}

function adoptedEntry(params: { sourceThreadId: string; sessionId?: string }) {
  return {
    sessionId: params.sessionId ?? "openclaw-session-existing",
    updatedAt: 1,
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          modelLocked: true,
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

function supervisionSessionInputKey(threadId: string): string {
  return `harness:codex:supervision:${createHash("sha256").update(threadId).digest("hex")}`;
}

function supervisionSessionKey(threadId: string): string {
  return `agent:main:${supervisionSessionInputKey(threadId)}`;
}

async function seedSupervisionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  sessionId: string;
  sessionKey: string;
  sourceThreadId: string;
  pending?: boolean;
}): Promise<void> {
  const binding: CodexAppServerThreadBinding = {
    threadId: params.pending ? params.sourceThreadId : `${params.sourceThreadId}-branch`,
    connectionScope: "supervision",
    supervisionSourceThreadId: params.sourceThreadId,
    cwd: "/workspace/project",
    conversationSourceTransferComplete: true,
    preserveNativeModel: true,
    historyCoveredThrough: new Date().toISOString(),
    ...(params.pending
      ? {
          pendingSupervisionBranch: {
            sourceThreadId: params.sourceThreadId,
            connectionFingerprint: "catalog-connection",
          },
        }
      : { model: "gpt-5.4", modelProvider: "openai" }),
  };
  const stored = await params.bindingStore.mutate(
    sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config,
    }),
    { kind: "set", if: { kind: "absent" }, binding },
  );
  if (!stored) {
    throw new Error(`failed to seed supervision binding for ${params.sourceThreadId}`);
  }
}

function interruptedAdoptionEntry(params: { sourceThreadId: string; sessionId: string }) {
  return {
    sessionId: params.sessionId,
    sessionFile: `/tmp/${params.sessionId}.jsonl`,
    updatedAt: 1,
    initializationPending: true,
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          initializing: true,
          modelLocked: true,
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

function createRuntime(
  params: {
    entries?: SessionEntrySummary[];
    nodes?: Array<Record<string, unknown>>;
    invoke?: PluginRuntime["nodes"]["invoke"];
    failAfterCreate?: () => boolean;
  } = {},
) {
  const entries = params.entries ?? [];
  let sessionSequence = 0;
  const createSessionEntry = vi.fn(async (createParams: CreateSessionEntryParams) => {
    const inputKey = createParams.key ?? "created";
    const agentId = createParams.agentId ?? "main";
    const key = inputKey.startsWith("agent:") ? inputKey : `agent:${agentId}:${inputKey}`;
    const existing = entries.find((candidate) => candidate.sessionKey === key);
    let summary: SessionEntrySummary;
    if (existing) {
      const entry = existing.entry;
      const initialMatches =
        createParams.recoverMatchingInitialEntry === true &&
        entry.initializationPending === true &&
        entry.agentHarnessId === createParams.initialEntry.agentHarnessId &&
        entry.modelSelectionLocked === createParams.initialEntry.modelSelectionLocked &&
        JSON.stringify(entry.pluginExtensions) ===
          JSON.stringify(createParams.initialEntry.pluginExtensions);
      if (!initialMatches) {
        throw new Error(`Session "${key}" does not match its trusted recovery state.`);
      }
      summary = existing;
    } else {
      sessionSequence += 1;
      const sessionId = `openclaw-session-${sessionSequence}`;
      const entry = {
        sessionId,
        sessionFile: `/tmp/${sessionId}.jsonl`,
        ...createParams.initialEntry,
        ...(createParams.afterCreate ? { initializationPending: true as const } : {}),
      } as CreateSessionEntryResult["entry"];
      summary = { sessionKey: key, entry };
      entries.push(summary);
    }
    const entry = summary.entry;
    const sessionId = entry.sessionId;
    const result = { key, agentId, sessionId, entry };
    try {
      const finalPatch = await createParams.afterCreate?.(result);
      if (existing && !finalPatch) {
        throw new Error("session creation recovery requires a final patch");
      }
      if (finalPatch) {
        entry.pluginExtensions = structuredClone(finalPatch.pluginExtensions);
      }
      delete entry.initializationPending;
      if (params.failAfterCreate?.() === true) {
        throw new Error("session finalization failed after binding commit");
      }
      return result;
    } catch (error) {
      const index = entries.indexOf(summary);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      throw error;
    }
  });
  const patchSessionEntry = vi.fn(async (patchParams: PatchSessionEntryParams) => {
    const summary = entries.find((candidate) => candidate.sessionKey === patchParams.sessionKey);
    if (!summary) {
      return null;
    }
    const current = structuredClone(summary.entry);
    const patch = await patchParams.update(current, { existingEntry: structuredClone(current) });
    if (!patch) {
      return summary.entry;
    }
    const next = { ...summary.entry, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        Reflect.deleteProperty(next, key);
      }
    }
    summary.entry = next;
    return next;
  });
  const runtime = {
    nodes: {
      list: vi.fn(async () => ({ nodes: params.nodes ?? [] })),
      invoke: params.invoke ?? vi.fn(async () => ({})),
    },
    agent: {
      session: {
        createSessionEntry,
        listSessionEntries: vi.fn((listParams) => {
          const agentPrefix = listParams?.agentId ? `agent:${listParams.agentId}:` : undefined;
          return entries.filter(
            ({ sessionKey }) => !agentPrefix || sessionKey.startsWith(agentPrefix),
          );
        }),
        patchSessionEntry,
      },
    },
  } as unknown as PluginRuntime;
  return { runtime, entries, createSessionEntry, patchSessionEntry };
}

function archiveTestSession(params: {
  control: CodexSessionCatalogControl;
  bindingStore?: CodexAppServerBindingStore;
  runtime?: PluginRuntime;
  threadId?: string;
}) {
  return archiveLocalCodexSession({
    bindingStore: params.bindingStore ?? createCodexTestBindingStore(),
    config,
    control: params.control,
    runtime: params.runtime ?? createRuntime().runtime,
    threadId: params.threadId ?? "thread-1",
  });
}

function createGatewayApi(runtime: PluginRuntime) {
  const handlers = new Map<string, GatewayHandler>();
  const registerControlUiDescriptor = vi.fn();
  const registerGatewayMethod = vi.fn(
    (method: string, handler: GatewayHandler, _options?: { scope?: string }) => {
      handlers.set(method, handler);
    },
  );
  const api = {
    runtime,
    session: { controls: { registerControlUiDescriptor } },
    registerGatewayMethod,
  } as unknown as OpenClawPluginApi;
  return { api, handlers, registerControlUiDescriptor, registerGatewayMethod };
}

async function callGatewayHandler(
  handler: GatewayHandler | undefined,
  params: unknown,
  respond = vi.fn(),
) {
  if (!handler) {
    throw new Error("Gateway handler was not registered");
  }
  await handler({ params, respond } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

beforeEach(() => {
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

describe("Codex supervision catalog", () => {
  it("lists non-archived interactive threads without probing transcript previews", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        {
          id: "thread-title",
          name: "Match title",
          preview: "private transcript preview",
          cwd: "/workspace/one",
          status: { type: "idle" },
          source: "vscode",
        },
        {
          id: "thread-preview",
          name: "Other title",
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
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode"],
        cwd: "/workspace/one",
      },
      {
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

  it("omits noninteractive sources when App Server ignores the requested source kinds", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        idleThread({ id: "cli", source: "cli" }),
        idleThread({ id: "vscode", source: "vscode" }),
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

    expect(page.sessions.map((session) => session.threadId)).toEqual(["cli", "vscode"]);
    expect(page.sessions.map((session) => session.source)).toEqual(["cli", "vscode"]);
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
        config,
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      },
    );
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1])).not.toContain(
      "thread/fork",
    );
  });

  it("revokes catalog reads and writes when supervision is disabled live", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });
    pluginConfig = { supervision: { enabled: false } };

    expect(() => control.assertEnabled()).toThrow("Codex session supervision is disabled");
    await expect(control.listPage({})).rejects.toThrow("Codex session supervision is disabled");
    await expect(control.readThread("thread-1")).rejects.toThrow(
      "Codex session supervision is disabled",
    );
    await expect(control.archiveThread("thread-1")).rejects.toThrow(
      "Codex session supervision is disabled",
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  });

  it("revokes an in-flight catalog before requesting another native page", async () => {
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

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).rejects.toThrow(
      "Codex session supervision is disabled",
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
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
    });

    expect(result.hosts).toEqual([
      {
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        label: "Local Codex",
        kind: "gateway",
        connected: true,
        sessions: [{ threadId: "local", status: "idle", archived: false }],
      },
      {
        hostId: "node:devbox",
        label: "Dev Box",
        kind: "node",
        nodeId: "devbox",
        connected: true,
        sessions: [{ threadId: "remote", name: "Remote task", status: "idle", archived: false }],
      },
    ]);
    expect(control.listPage).toHaveBeenCalledWith(
      expect.not.objectContaining({ archived: expect.anything() }),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "devbox",
        command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        params: expect.not.objectContaining({ archived: expect.anything() }),
        timeoutMs: 65_000,
      }),
    );
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
        params: { cursor: "healthy-page-2", limit: 7, searchTerm: "match" },
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "broken",
        params: { cursor: "broken-page-2", limit: 7, searchTerm: "match" },
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
  ])("rejects $name at the Gateway boundary", async ({ params: requestParams, error }) => {
    const control = createControl();
    const { runtime } = createRuntime();
    const { api, handlers } = createGatewayApi(runtime);
    registerCodexSessionCatalogGateway({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });

    const respond = await callGatewayHandler(
      handlers.get(CODEX_SESSION_CATALOG_METHOD),
      requestParams,
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      { error },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(control.assertEnabled).not.toHaveBeenCalled();
    expect(control.listPage).not.toHaveBeenCalled();
    expect(runtime.nodes.list).not.toHaveBeenCalled();
  });

  it("enriches only the local source row with its adopted OpenClaw session", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "source-thread", status: "active", archived: false }],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: "source-thread", status: "idle", archived: false }],
      }),
    }));
    const { runtime, entries } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: adoptedEntry({
        sourceThreadId: "source-thread",
        sessionId,
      }),
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
    });

    const result = await listCodexSessionCatalog({
      bindingStore,
      config,
      runtime,
      control,
    });

    expect(result.hosts[0]?.sessions[0]).toMatchObject({
      threadId: "source-thread",
      openClawSessionKey: sessionKey,
    });
    expect(result.hosts[1]?.sessions[0]).toEqual({
      threadId: "source-thread",
      status: "idle",
      archived: false,
    });
  });

  it("does not expose an adopted marker while generic initialization remains pending", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "source-thread", status: "idle", archived: false }],
      })),
    });
    const { runtime, entries } = createRuntime();
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-pending";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "source-thread", sessionId }),
        initializationPending: true,
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
      pending: true,
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions[0]).not.toHaveProperty("openClawSessionKey");
  });

  it("ignores a public marker retarget and trusts the private source binding", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          { threadId: "source-thread", status: "idle", archived: false },
          { threadId: "forged-thread", status: "idle", archived: false },
        ],
      })),
    });
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-forged-marker";
    const { runtime, entries } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "forged-thread", sessionId }),
        },
      ],
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions).toEqual([
      {
        threadId: "source-thread",
        status: "idle",
        archived: false,
        openClawSessionKey: sessionKey,
      },
      { threadId: "forged-thread", status: "idle", archived: false },
    ]);
    expect(entries[0]?.entry.pluginExtensions).toMatchObject({
      codex: { supervision: { sourceThreadId: "forged-thread" } },
    });
  });

  it("requires both the Codex harness owner and model lock before adopting a session", async () => {
    const sources = [
      {
        threadId: "unlocked-thread",
        sessionId: "openclaw-session-unlocked",
        entryPatch: { modelSelectionLocked: false },
      },
      {
        threadId: "wrong-harness-thread",
        sessionId: "openclaw-session-wrong-harness",
        entryPatch: { agentHarnessId: "other-harness" },
      },
    ];
    const entries = sources.map(({ threadId, sessionId, entryPatch }) => ({
      sessionKey: supervisionSessionKey(threadId),
      entry: { ...adoptedEntry({ sourceThreadId: threadId, sessionId }), ...entryPatch },
    }));
    const { runtime, createSessionEntry } = createRuntime({ entries });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    for (const source of sources) {
      await seedSupervisionBinding({
        bindingStore,
        sessionId: source.sessionId,
        sessionKey: supervisionSessionKey(source.threadId),
        sourceThreadId: source.threadId,
      });
    }
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: sources.map(({ threadId }) => ({
          threadId,
          status: "idle",
          source: "cli",
          archived: false as const,
        })),
      })),
      readThread: vi.fn(async (threadId: string) => idleThread({ id: threadId, source: "cli" })),
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions).toHaveLength(sources.length);
    for (const source of sources) {
      const session = result.hosts[0]?.sessions.find(
        (candidate) => candidate.threadId === source.threadId,
      );
      expect(session).toBeDefined();
      expect(session).not.toHaveProperty("openClawSessionKey");
    }
    for (const source of sources) {
      await expect(
        continueLocalCodexSession({
          api,
          bindingStore,
          config,
          control,
          threadId: source.threadId,
        }),
      ).rejects.toThrow("does not match its trusted recovery state");
    }
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
  });
});

describe("Codex supervision actions", () => {
  it("creates one pending locked branch and reuses its source mapping", async () => {
    const sourceThread = idleThread({
      modelProvider: "openai",
      turns: [
        { id: "turn-completed", status: "completed", items: [] },
        { id: "turn-failed", status: "failed", items: [] },
        { id: "turn-active", status: "inProgress", items: [] },
      ],
    });
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({ readThread: vi.fn(async () => sourceThread) });

    const first = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    const second = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    expect(first).toEqual({
      sessionKey: expect.stringMatching(/^agent:main:harness:codex:supervision:[0-9a-f]{64}$/),
      disposition: "forked",
    });
    expect(second).toEqual({ sessionKey: first.sessionKey, disposition: "existing" });
    expect(control.withPinnedConnection).toHaveBeenCalledTimes(2);
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: config,
        key: supervisionSessionInputKey("thread-1"),
        label: "Continue native task",
        spawnedCwd: "/workspace/project",
        afterCreate: expect.any(Function),
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              supervision: {
                sourceThreadId: "thread-1",
                initializing: true,
                modelLocked: true,
              },
            },
          },
        },
      }),
    );
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith({
      thread: sourceThread,
      sessionFile: "/tmp/openclaw-session-1.jsonl",
      sessionId: "openclaw-session-1",
      sessionKey: first.sessionKey,
      agentId: "main",
      cwd: "/workspace/project",
      throughTurnId: "turn-failed",
      modelProvider: "openai",
      config,
    });
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: first.sessionKey,
          config,
        }),
      ),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      cwd: "/workspace/project",
      historyCoveredThrough: expect.any(String),
      conversationSourceTransferComplete: true,
      preserveNativeModel: true,
      pendingSupervisionBranch: {
        sourceThreadId: "thread-1",
        connectionFingerprint: "catalog-connection",
        lastTurnId: "turn-failed",
      },
    });
    expect(control.readThread).toHaveBeenCalledTimes(2);
    expect(control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(control.readThread).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("keeps adopted sessions discoverable when the configured default agent changes", async () => {
    const originalConfig = {
      agents: { list: [{ id: "alpha", default: true }, { id: "beta" }] },
    } as OpenClawConfig;
    const changedConfig = {
      agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
    } as OpenClawConfig;
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const created = await continueLocalCodexSession({
      api,
      bindingStore,
      config: originalConfig,
      control,
      threadId: "thread-1",
    });
    const reopened = await continueLocalCodexSession({
      api,
      bindingStore,
      config: changedConfig,
      control,
      threadId: "thread-1",
    });
    const catalog = await listCodexSessionCatalog({
      bindingStore,
      config: changedConfig,
      runtime,
      control,
    });

    expect(created.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
    expect(reopened).toEqual({ sessionKey: created.sessionKey, disposition: "existing" });
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ agentId: "alpha" }));
    expect(catalog.hosts[0]?.sessions[0]).toMatchObject({
      threadId: "thread-1",
      openClawSessionKey: created.sessionKey,
    });
  });

  it("does not expose or reuse an initializing session while history import is paused", async () => {
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockImplementationOnce(async () => {
      await importGate;
      return { importedMessages: 0, omittedMessages: 0 };
    });
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const firstContinue = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    await vi.waitFor(() => {
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    });

    const duringImport = await listCodexSessionCatalog({ bindingStore, config, runtime, control });
    expect(duringImport.hosts[0]?.sessions[0]).not.toHaveProperty("openClawSessionKey");
    expect(entries[0]?.entry.initializationPending).toBe(true);
    let secondSettled = false;
    const secondContinue = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    }).then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(createSessionEntry).toHaveBeenCalledOnce();

    releaseImport?.();
    const [first, second] = await Promise.all([firstContinue, secondContinue]);
    expect(second).toEqual(first);
    expect(entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
  });

  it("does not archive a source with an interrupted initializing branch", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const { runtime } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: interruptedAdoptionEntry({
            sourceThreadId: "thread-1",
            sessionId: "openclaw-session-initializing",
          }),
        },
      ],
    });
    const control = createEligibleControl();

    await expect(archiveTestSession({ control, runtime })).rejects.toThrow(
      "cannot be archived while its OpenClaw branch is initializing",
    );
    expect(control.readThread).not.toHaveBeenCalled();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("does not archive a source until its supervised branch materializes", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();
    const continued = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    await expect(archiveTestSession({ control, bindingStore, runtime })).rejects.toThrow(
      "cannot be archived until its OpenClaw branch starts",
    );
    expect(control.archiveThread).not.toHaveBeenCalled();

    const identity = sessionBindingIdentity({
      sessionId: "openclaw-session-1",
      sessionKey: continued.sessionKey,
      config,
    });
    const pending = (await bindingStore.read(identity))?.pendingSupervisionBranch;
    if (!pending) {
      throw new Error("expected a pending supervision branch");
    }
    await expect(
      bindingStore.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: pending,
        threadId: "thread-1-branch",
        patch: { model: "gpt-5.4", modelProvider: "openai" },
      }),
    ).resolves.toBe(true);

    await expect(archiveTestSession({ control, bindingStore, runtime })).resolves.toEqual({
      archived: true,
    });
    expect(control.archiveThread).toHaveBeenCalledOnce();
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("serializes archive behind an in-flight Continue and rejects the pending branch", async () => {
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockImplementationOnce(async () => {
      await importGate;
      return { importedMessages: 0, omittedMessages: 0 };
    });
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();
    const continuing = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    await vi.waitFor(() => {
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    });

    let archiveSettled = false;
    const archiving = archiveTestSession({ control, bindingStore, runtime }).then(
      (value) => {
        archiveSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        archiveSettled = true;
        return { ok: false as const, error };
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(archiveSettled).toBe(false);
    expect(control.archiveThread).not.toHaveBeenCalled();

    releaseImport?.();
    await expect(continuing).resolves.toMatchObject({ disposition: "forked" });
    const archiveResult = await archiving;
    expect(archiveResult.ok).toBe(false);
    if (archiveResult.ok) {
      throw new Error("archive unexpectedly succeeded");
    }
    expect(archiveResult.error).toBeInstanceOf(Error);
    expect((archiveResult.error as Error).message).toContain(
      "cannot be archived until its OpenClaw branch starts",
    );
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("recovers the same pending session after a restart before binding commit", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-before-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries, createSessionEntry } = createRuntime({
      entries: crashedRuntime.entries,
    });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "forked" });

    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        key: supervisionSessionInputKey("thread-1"),
        recoverMatchingInitialEntry: true,
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toMatchObject({
      sessionId,
      pluginExtensions: {
        codex: {
          supervision: { sourceThreadId: "thread-1", modelLocked: true },
        },
      },
    });
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: `/tmp/${sessionId}.jsonl`,
        sessionId,
        sessionKey,
      }),
    );
    await expect(
      bindingStore.read(sessionBindingIdentity({ sessionId, sessionKey, config })),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
  });

  it("recovers the same pending session after a restart following binding commit", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-after-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries, createSessionEntry } = createRuntime({
      entries: crashedRuntime.entries,
    });
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
    await inner.mutate(identity, {
      kind: "set",
      if: { kind: "absent" },
      binding: {
        threadId: "thread-1",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-1",
        cwd: "/workspace/project",
        historyCoveredThrough: new Date().toISOString(),
        conversationSourceTransferComplete: true,
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-1",
          connectionFingerprint: "catalog-connection",
        },
      },
    });
    const mutate = vi.fn(inner.mutate);
    const bindingStore: CodexAppServerBindingStore = { ...inner, mutate };

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "forked" });

    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.sessionId).toBe(sessionId);
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
    expect(entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(mutate).not.toHaveBeenCalled();
    await expect(bindingStore.read(identity)).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
  });

  it.each([
    "a different working directory",
    "a different terminal turn",
    "pending cleanup artifacts",
  ] as const)("rejects recovery against %s in a same-thread binding", async (invalidState) => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-invalid-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries } = createRuntime({ entries: crashedRuntime.entries });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
    const binding: CodexAppServerThreadBinding = {
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      cwd: "/workspace/project",
      historyCoveredThrough: new Date().toISOString(),
      conversationSourceTransferComplete: true,
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    };
    if (invalidState === "a different working directory") {
      binding.cwd = "/workspace/other";
    } else if (invalidState === "a different terminal turn") {
      binding.pendingSupervisionBranch = {
        sourceThreadId: "thread-1",
        lastTurnId: "turn-other",
      };
    } else {
      binding.pendingSupervisionBranch = {
        sourceThreadId: "thread-1",
        cleanupThreadIds: ["thread-orphan"],
      };
    }
    await bindingStore.mutate(identity, {
      kind: "set",
      if: { kind: "absent" },
      binding,
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).rejects.toThrow("OpenClaw session is already bound to Codex thread thread-1");
    expect(entries).toEqual([]);
  });

  it("does not infer a terminal boundary from completedAt without a terminal status", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({
          status: { type: "notLoaded" },
          turns: [{ id: "turn-unknown", completedAt: 123, items: [] }],
        }),
      ),
    });

    const result = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    expect(result.disposition).toBe("forked");
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ throughTurnId: null, modelProvider: undefined }),
    );
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: result.sessionKey,
          config,
        }),
      ),
    ).resolves.toMatchObject({
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
    const binding = await bindingStore.read(
      sessionBindingIdentity({
        sessionId: "openclaw-session-1",
        sessionKey: result.sessionKey,
        config,
      }),
    );
    expect(binding?.pendingSupervisionBranch).not.toHaveProperty("lastTurnId");
  });

  it("restores an archived mapped session without changing its locked generation metadata", async () => {
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-archived";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        archivedAt: 123,
        updatedAt: 99,
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "existing" });

    expect(patchSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        readConsistency: "latest",
        preserveActivity: true,
        update: expect.any(Function),
      }),
    );
    expect(entries[0]?.entry).toMatchObject({
      sessionId,
      updatedAt: 99,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      model: "gpt-5.4",
      modelProvider: "openai",
      pluginExtensions: {
        codex: { supervision: { sourceThreadId: "thread-1", modelLocked: true } },
      },
    });
    expect(entries[0]?.entry.archivedAt).toBeUndefined();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("opens a mapped active source without applying the unadopted idle gate", async () => {
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }),
      ),
    });
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      sessionKey,
      disposition: "existing",
    });
    expect(control.readThread).toHaveBeenCalledWith("thread-1", false);
    expect(patchSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it.each([
    { name: "mapped", mapped: true, includeTurns: false },
    { name: "unmapped", mapped: false, includeTurns: true },
  ])(
    "rejects a $name Continue when the fresh read returns a different thread",
    async ({ mapped, includeTurns }) => {
      const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
      const { api } = createGatewayApi(runtime);
      const bindingStore = createCodexTestBindingStore();
      if (mapped) {
        const sessionKey = supervisionSessionKey("thread-1");
        const sessionId = "openclaw-session-existing";
        entries.push({
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        });
        await seedSupervisionBinding({
          bindingStore,
          sessionId,
          sessionKey,
          sourceThreadId: "thread-1",
        });
      }
      const control = createEligibleControl({
        readThread: vi.fn(async () => idleThread({ id: "different-thread", source: "cli" })),
      });

      await expect(
        continueLocalCodexSession({
          api,
          bindingStore,
          config,
          control,
          threadId: "thread-1",
        }),
      ).rejects.toThrow("returned a different thread than requested");

      expect(control.readThread).toHaveBeenCalledWith("thread-1", includeTurns);
      expect(createSessionEntry).not.toHaveBeenCalled();
      expect(patchSessionEntry).not.toHaveBeenCalled();
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
    },
  );

  it("does not restore a mapped session when supervision is disabled during source revalidation", async () => {
    const { runtime, entries, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: { ...adoptedEntry({ sourceThreadId: "thread-1", sessionId }), archivedAt: 123 },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });
    let supervisionEnabled = true;
    let finishRead: ((thread: CodexThread) => void) | undefined;
    const readThread = vi.fn(
      async () =>
        await new Promise<CodexThread>((resolve) => {
          finishRead = resolve;
        }),
    );
    const control = createEligibleControl({
      assertEnabled: vi.fn(() => {
        if (!supervisionEnabled) {
          throw new Error("Codex session supervision is disabled");
        }
      }),
      readThread,
    });

    const continuing = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    await vi.waitFor(() => expect(readThread).toHaveBeenCalledOnce());
    supervisionEnabled = false;
    finishRead?.(idleThread());

    await expect(continuing).rejects.toThrow("Codex session supervision is disabled");
    expect(patchSessionEntry).not.toHaveBeenCalled();
    expect(entries[0]?.entry.archivedAt).toBe(123);
  });

  it("fails closed when a mapped session generation changes before restore", async () => {
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-stale";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        archivedAt: 123,
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });
    const control = createEligibleControl({
      readThread: vi.fn(async () => {
        const entry = entries[0]?.entry;
        if (!entry) {
          throw new Error("missing mapped session");
        }
        entry.sessionId = "openclaw-session-replacement";
        return idleThread();
      }),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("changed before it could be opened");
    expect(patchSessionEntry).toHaveBeenCalledOnce();
    expect(entries[0]?.entry.archivedAt).toBe(123);
    expect(entries[0]?.entry.modelSelectionLocked).toBe(true);
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("rolls back the session when its pending binding cannot be committed", async () => {
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    let rejectBinding = true;
    const mutate = vi.fn(async (...args: Parameters<CodexAppServerBindingStore["mutate"]>) => {
      if (rejectBinding && args[1].kind === "set") {
        rejectBinding = false;
        return false;
      }
      return await inner.mutate(...args);
    });
    const bindingStore: CodexAppServerBindingStore = { ...inner, mutate };
    const control = createEligibleControl();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("failed to bind OpenClaw session to Codex thread thread-1");
    expect(entries).toEqual([]);
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("clears a committed pending binding when session finalization fails", async () => {
    const { runtime } = createRuntime({ failAfterCreate: () => true });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("session finalization failed after binding commit");
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: supervisionSessionKey("thread-1"),
          config,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("preserves successor cleanup state when failed finalization loses its binding CAS", async () => {
    const { runtime } = createRuntime({ failAfterCreate: () => true });
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    const successorThreadId = "thread-successor-probe";
    let replaced = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...inner,
      mutate: async (identity, mutation) => {
        if (!replaced && mutation.kind === "clear") {
          const current = await inner.read(identity);
          const pending = current?.pendingSupervisionBranch;
          if (!pending) {
            throw new Error("missing pending supervision binding before cleanup");
          }
          replaced = true;
          const patched = await inner.mutate(identity, {
            kind: "patch-pending-supervision-branch",
            expected: pending,
            pending: { ...pending, cleanupThreadIds: [successorThreadId] },
          });
          if (!patched) {
            throw new Error("failed to install successor supervision cleanup state");
          }
        }
        return await inner.mutate(identity, mutation);
      },
    };
    const control = createEligibleControl();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("session finalization failed after binding commit");
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: supervisionSessionKey("thread-1"),
          config,
        }),
      ),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      pendingSupervisionBranch: {
        sourceThreadId: "thread-1",
        cleanupThreadIds: [successorThreadId],
      },
    });
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

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
    expect(listPage).toHaveBeenNthCalledWith(2, { cursor: "page-2", limit: 100 });
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
    ).rejects.toThrow("not a non-archived interactive CLI or VS Code session");
    await expect(archiveTestSession({ control })).rejects.toThrow(
      "not a non-archived interactive CLI or VS Code session",
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
    ).rejects.toThrow("not a non-archived interactive CLI or VS Code session");
    await expect(archiveTestSession({ control })).rejects.toThrow(
      "not a non-archived interactive CLI or VS Code session",
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
    let runtimeConfig = { agents: { defaults: { workspace: "/workspace/a" } } } as OpenClawConfig;
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

    await expect(archiveTestSession({ control })).resolves.toEqual({ archived: true });

    expect(pinnedConnectionMocks.getClient).toHaveBeenCalledOnce();
    const acquisition = pinnedConnectionMocks.getClient.mock.calls[0]?.[0];
    expect(acquisition).toMatchObject({
      startOptions: expect.objectContaining({ command: "codex-archive-a", homeScope: "user" }),
      config: { agents: { defaults: { workspace: "/workspace/a" } } },
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

  it("stops a pinned archive when supervision permission is revoked live", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    pinnedConnectionMocks.request.mockImplementation(async (request: { method: string }) => {
      if (request.method === "thread/list") {
        return { data: [idleThread({ source: "cli" })] };
      }
      if (request.method === "thread/read") {
        pluginConfig = { supervision: { enabled: false } };
        return { thread: idleThread() };
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(archiveTestSession({ control })).rejects.toThrow(
      "Codex session supervision is disabled",
    );
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/list",
      "thread/read",
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

  it("requires archive confirmation and rejects paired-node mutations at Gateway handlers", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api, handlers, registerControlUiDescriptor, registerGatewayMethod } =
      createGatewayApi(runtime);
    const control = createEligibleControl();
    registerCodexSessionCatalogGateway({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });

    expect(registerControlUiDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sessions", requiredScopes: ["operator.write"] }),
    );
    for (const method of [
      CODEX_SESSION_CATALOG_METHOD,
      CODEX_SESSION_READ_METHOD,
      CODEX_SESSION_CONTINUE_METHOD,
      CODEX_SESSION_ARCHIVE_METHOD,
    ]) {
      expect(registerGatewayMethod).toHaveBeenCalledWith(method, expect.any(Function), {
        scope: "operator.write",
      });
    }

    const archivedRespond = await callGatewayHandler(handlers.get(CODEX_SESSION_CATALOG_METHOD), {
      archived: true,
    });
    expect(archivedRespond).toHaveBeenCalledWith(
      false,
      { error: "unknown Codex session catalog parameter: archived" },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const unconfirmedArchive = await callGatewayHandler(
      handlers.get(CODEX_SESSION_ARCHIVE_METHOD),
      { hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId: "thread-1" },
    );
    expect(unconfirmedArchive).toHaveBeenCalledWith(
      false,
      {
        error:
          "confirmNoOtherRunner=true is required because Codex client and runner activity is process-local",
      },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(control.readThread).not.toHaveBeenCalled();

    const confirmedArchive = await callGatewayHandler(handlers.get(CODEX_SESSION_ARCHIVE_METHOD), {
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      threadId: "thread-1",
      confirmNoOtherRunner: true,
    });
    expect(confirmedArchive).toHaveBeenCalledWith(true, { archived: true });

    for (const method of [CODEX_SESSION_CONTINUE_METHOD, CODEX_SESSION_ARCHIVE_METHOD]) {
      const respond = await callGatewayHandler(handlers.get(method), {
        hostId: "node:devbox",
        threadId: "thread-remote",
        ...(method === CODEX_SESSION_ARCHIVE_METHOD ? { confirmNoOtherRunner: true } : {}),
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        { error: "paired-node Codex sessions are view-only" },
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(control.readThread).toHaveBeenCalledOnce();
    expect(control.archiveThread).toHaveBeenCalledOnce();
    expect(createSessionEntry).not.toHaveBeenCalled();
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
      params: { threadId: "thread-remote", cursor: "remote-turns-1", limit: 25 },
      timeoutMs: 65_000,
    });
  });
});
