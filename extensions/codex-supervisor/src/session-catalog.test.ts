import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_SESSION_CATALOG_METHOD,
  createCodexSessionCatalogNodeHostCommands,
  createCodexSessionCatalogNodeInvokePolicies,
  createCodexSessionCatalogSupervisor,
  listCodexSessionCatalog,
  parseCodexSessionCatalogResult,
  registerCodexSessionCatalogGateway,
} from "./session-catalog.js";
import { CodexSupervisor } from "./supervisor.js";
import type { CodexJsonRpcConnection, CodexSupervisorEndpoint } from "./types.js";

class CatalogConnection implements CodexJsonRpcConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  constructor(private readonly response: unknown) {}

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    return this.response;
  }

  notify(): void {}

  async close(): Promise<void> {}
}

const localEndpoint: CodexSupervisorEndpoint = {
  id: "local",
  label: "Local Codex",
  transport: "stdio-proxy",
};

function createRuntime(params: {
  nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];
  invoke?: PluginRuntime["nodes"]["invoke"];
}): PluginRuntime {
  return {
    nodes: {
      list: vi.fn(async () => ({ nodes: params.nodes })),
      invoke: params.invoke ?? vi.fn(async () => ({})),
    },
  } as unknown as PluginRuntime;
}

describe("Codex session catalog node command", () => {
  it("uses a dedicated local stdio endpoint when live control uses the daemon socket", () => {
    const supervisor = createCodexSessionCatalogSupervisor([
      { id: "live", transport: "websocket", url: "unix://" },
    ]);

    expect(supervisor.listEndpoints()).toEqual([
      { id: "local", label: "Local Codex", transport: "stdio-proxy" },
    ]);
  });

  it("registers a versioned, read-only command and default invoke policy", async () => {
    const connection = new CatalogConnection({
      data: [{ id: "thread-1", name: "One", status: { type: "notLoaded" } }],
      nextCursor: "next",
      backwardsCursor: null,
    });
    const supervisor = new CodexSupervisor([localEndpoint], async () => connection);
    const [command] = createCodexSessionCatalogNodeHostCommands(supervisor);

    expect(command).toMatchObject({
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      cap: "codex-app-server-threads",
      dangerous: false,
    });
    const result = await command.handle(
      JSON.stringify({ cursor: "cursor", limit: 25, archived: true, searchTerm: "One" }),
    );
    expect(JSON.parse(result)).toEqual({
      sessions: [{ threadId: "thread-1", name: "One", status: "notLoaded", archived: true }],
      nextCursor: "next",
    });
    expect(connection.calls[0]).toMatchObject({
      method: "thread/list",
      params: {
        cursor: "cursor",
        limit: 25,
        archived: true,
      },
    });
    expect(connection.calls[0]?.params).not.toHaveProperty("searchTerm");

    const [policy] = createCodexSessionCatalogNodeInvokePolicies();
    expect(policy).toMatchObject({
      commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
    });
  });

  it("rejects malformed or unbounded node parameters", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () => new CatalogConnection({ data: [] }),
    );
    const [command] = createCodexSessionCatalogNodeHostCommands(supervisor);

    await expect(command.handle("not-json")).rejects.toThrow("must be valid JSON");
    await expect(command.handle(JSON.stringify({ limit: 101 }))).rejects.toThrow(
      "limit must be an integer from 1 to 100",
    );
    await expect(command.handle(JSON.stringify({ extra: true }))).rejects.toThrow(
      "unknown Codex session catalog parameter",
    );
  });

  it("omits an oversized App Server cursor at the node boundary", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () => new CatalogConnection({ data: [], nextCursor: "x".repeat(4097) }),
    );
    const [command] = createCodexSessionCatalogNodeHostCommands(supervisor);

    await expect(command.handle("{}")).resolves.toBe(JSON.stringify({ sessions: [] }));
  });
});

describe("Codex session catalog aggregation", () => {
  it("groups local and paired-node sessions, applies per-host cursors, and keeps failures local", async () => {
    const local = new CatalogConnection({
      data: [
        {
          id: "local-thread",
          name: "Local task",
          preview: "must not leave the Gateway",
          cwd: "/local/workspace",
          status: { type: "idle" },
        },
      ],
      nextCursor: "local-next",
    });
    const supervisor = new CodexSupervisor([localEndpoint], async () => local);
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => {
      if (nodeId === "node-failed") {
        throw new Error("private app-server stderr and transcript fragment");
      }
      return {
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "remote-thread",
              name: "Remote task",
              preview: "must be stripped even from a compromised node",
              cwd: "/remote/workspace",
              status: "active",
              activeFlags: ["waitingOnApproval"],
              updatedAt: 40,
              archived: false,
              turns: [{ private: true }],
            },
            {
              threadId: "preview-only",
              name: "Remote other",
              preview: "task appears only in private preview text",
              status: "idle",
              archived: false,
            },
          ],
          nextCursor: "remote-next",
          codexHome: "/Users/private/.codex",
        }),
      };
    });
    const command = CODEX_APP_SERVER_THREADS_LIST_COMMAND;
    const runtime = createRuntime({
      nodes: [
        { nodeId: "node-a", displayName: "Dev Box", connected: true, commands: [command] },
        { nodeId: "node-offline", connected: false, commands: [command] },
        { nodeId: "node-failed", connected: true, commands: [command] },
        { nodeId: "node-unrelated", connected: true, commands: ["system.run"] },
      ],
      invoke,
    });

    await expect(
      listCodexSessionCatalog({
        runtime,
        supervisor,
        query: {
          search: "task",
          limitPerHost: 25,
          cursors: {
            "gateway:local": "local-cursor",
            "node:node-a": "remote-cursor",
            "node:unknown": "ignored-cursor",
          },
        },
      }),
    ).resolves.toEqual({
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Codex",
          kind: "gateway",
          connected: true,
          endpointId: "local",
          sessions: [
            {
              threadId: "local-thread",
              name: "Local task",
              cwd: "/local/workspace",
              status: "idle",
              archived: false,
            },
          ],
          nextCursor: "local-next",
        },
        {
          hostId: "node:node-a",
          label: "Dev Box",
          kind: "node",
          connected: true,
          nodeId: "node-a",
          sessions: [
            {
              threadId: "remote-thread",
              name: "Remote task",
              cwd: "/remote/workspace",
              status: "active",
              activeFlags: ["waitingOnApproval"],
              updatedAt: 40,
              archived: false,
            },
          ],
          nextCursor: "remote-next",
        },
        {
          hostId: "node:node-failed",
          label: "node-failed",
          kind: "node",
          connected: true,
          nodeId: "node-failed",
          sessions: [],
          error: {
            code: "NODE_INVOKE_FAILED",
            message: "The paired node could not return its Codex session catalog",
          },
        },
        {
          hostId: "node:node-offline",
          label: "node-offline",
          kind: "node",
          connected: false,
          nodeId: "node-offline",
          sessions: [],
          error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
        },
      ],
    });
    expect(local.calls[0]).toMatchObject({ params: { cursor: "local-cursor", limit: 25 } });
    expect(local.calls[0]?.params).not.toHaveProperty("searchTerm");
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-a",
      command,
      params: {
        cursor: "remote-cursor",
        limit: 25,
        archived: false,
        searchTerm: "task",
      },
      timeoutMs: 20_000,
    });
    expect(JSON.stringify(await listCodexSessionCatalog({ runtime, supervisor }))).not.toContain(
      "private",
    );
  });

  it("strictly bounds Gateway catalog queries", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () => new CatalogConnection({ data: [] }),
    );
    const runtime = createRuntime({ nodes: [] });

    await expect(
      listCodexSessionCatalog({
        runtime,
        supervisor,
        query: { search: "x".repeat(501) },
      }),
    ).rejects.toThrow("search must be at most 500 characters");
    await expect(
      listCodexSessionCatalog({
        runtime,
        supervisor,
        query: { cursors: { invalid: "cursor" } },
      }),
    ).rejects.toThrow("invalid Codex session catalog host id");
    await expect(
      listCodexSessionCatalog({
        runtime,
        supervisor,
        query: { hostIds: ["invalid"] },
      }),
    ).rejects.toThrow("invalid Codex session catalog host id");
  });

  it("queries only a selected Gateway host without enumerating paired nodes", async () => {
    const local = new CatalogConnection({ data: [] });
    const connector = vi.fn(async () => local);
    const supervisor = new CodexSupervisor([localEndpoint], connector);
    const runtime = createRuntime({
      nodes: [
        {
          nodeId: "node-a",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
    });

    const result = await listCodexSessionCatalog({
      runtime,
      supervisor,
      query: { hostIds: ["gateway:local"] },
    });

    expect(result.hosts.map((host) => host.hostId)).toEqual(["gateway:local"]);
    expect(connector).toHaveBeenCalledOnce();
    expect(runtime.nodes.list).not.toHaveBeenCalled();
    expect(runtime.nodes.invoke).not.toHaveBeenCalled();
  });

  it("keeps long configured Gateway endpoint ids page-addressable", async () => {
    const endpointId = "endpoint-".repeat(40);
    const connection = new CatalogConnection({
      data: [],
      nextCursor: "next-page",
    });
    const supervisor = new CodexSupervisor(
      [{ id: endpointId, label: "Long endpoint", transport: "stdio-proxy" }],
      async () => connection,
    );
    const runtime = createRuntime({ nodes: [] });

    const first = await listCodexSessionCatalog({ runtime, supervisor });
    const hostId = first.hosts[0]?.hostId;
    expect(hostId).toMatch(/^gateway:sha256:[0-9a-f]{64}$/);
    expect(hostId?.length).toBeLessThanOrEqual(256);

    const next = await listCodexSessionCatalog({
      runtime,
      supervisor,
      query: { hostIds: [hostId!], cursors: { [hostId!]: "next-page" } },
    });

    expect(next.hosts[0]).toMatchObject({ hostId, endpointId });
    expect(connection.calls.at(-1)?.params).toMatchObject({ cursor: "next-page" });
  });

  it("queries only a selected paired node without touching the local App Server", async () => {
    const connector = vi.fn(async () => {
      throw new Error("local connector must not run");
    });
    const supervisor = new CodexSupervisor([localEndpoint], connector);
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => ({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: `${nodeId}-thread`, status: "idle", archived: false }],
      }),
    }));
    const runtime = createRuntime({
      nodes: [
        {
          nodeId: "node-a",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
        {
          nodeId: "node-b",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });

    const result = await listCodexSessionCatalog({
      runtime,
      supervisor,
      query: { hostIds: ["node:node-a"] },
    });

    expect(result.hosts.map((host) => host.hostId)).toEqual(["node:node-a"]);
    expect(connector).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-a" }));
  });

  it("keeps the Gateway connected when its local Codex App Server is unavailable", async () => {
    const supervisor = new CodexSupervisor([localEndpoint], async () => {
      throw new Error("private local transport failure");
    });
    const runtime = createRuntime({ nodes: [] });

    const result = await listCodexSessionCatalog({
      runtime,
      supervisor,
      query: { hostIds: ["gateway:local"] },
    });

    expect(result.hosts).toEqual([
      {
        hostId: "gateway:local",
        label: "Local Codex",
        kind: "gateway",
        connected: true,
        endpointId: "local",
        sessions: [],
        error: {
          code: "APP_SERVER_UNAVAILABLE",
          message: "Codex app-server is unavailable on this host",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private local transport failure");
  });

  it("normalizes oversized Gateway-local App Server cursors at the source", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () => new CatalogConnection({ data: [], nextCursor: "x".repeat(4097) }),
    );
    const runtime = createRuntime({ nodes: [] });

    const result = await listCodexSessionCatalog({
      runtime,
      supervisor,
      query: { hostIds: ["gateway:local"] },
    });

    expect(result.hosts[0]).toEqual({
      hostId: "gateway:local",
      label: "Local Codex",
      kind: "gateway",
      connected: true,
      endpointId: "local",
      sessions: [],
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(4097));
  });

  it("keeps the local host healthy when an App Server title exceeds the wire bound", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () =>
        new CatalogConnection({
          data: [{ id: "long-title", name: "😀".repeat(251), status: { type: "idle" } }],
        }),
    );
    const runtime = createRuntime({ nodes: [] });

    const result = await listCodexSessionCatalog({
      runtime,
      supervisor,
      query: { hostIds: ["gateway:local"] },
    });

    expect(result.hosts[0]?.error).toBeUndefined();
    expect(result.hosts[0]?.sessions[0]?.name).toBe("😀".repeat(250));
  });

  it("reports malformed node payloads without exposing their contents", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () => new CatalogConnection({ data: [] }),
    );
    const runtime = createRuntime({
      nodes: [
        {
          nodeId: "malformed",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke: vi.fn(async () => ({
        payloadJSON: JSON.stringify({ sessions: null, private: "transcript fragment" }),
      })),
    });

    const result = await listCodexSessionCatalog({ runtime, supervisor });

    expect(result.hosts[1]).toEqual({
      hostId: "node:malformed",
      label: "malformed",
      kind: "node",
      connected: true,
      nodeId: "malformed",
      sessions: [],
      error: {
        code: "NODE_INVOKE_FAILED",
        message: "The paired node could not return its Codex session catalog",
      },
    });
    expect(JSON.stringify(result)).not.toContain("transcript fragment");
  });

  it("keeps the local catalog when the paired-node registry fails", async () => {
    const supervisor = new CodexSupervisor(
      [localEndpoint],
      async () => new CatalogConnection({ data: [] }),
    );
    const runtime = createRuntime({ nodes: [] });
    vi.mocked(runtime.nodes.list).mockRejectedValueOnce(new Error("private registry detail"));

    const result = await listCodexSessionCatalog({ runtime, supervisor });

    expect(result.hosts).toEqual([
      {
        hostId: "gateway:local",
        label: "Local Codex",
        kind: "gateway",
        connected: true,
        endpointId: "local",
        sessions: [],
      },
      {
        hostId: "node:registry",
        label: "Paired nodes",
        kind: "node",
        connected: false,
        sessions: [],
        error: { code: "NODE_LIST_FAILED", message: "Paired nodes could not be listed" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private registry detail");
  });
});

describe("Codex session catalog Gateway registration", () => {
  it("registers a write-scoped method and strips unknown response fields", () => {
    const registerControlUiDescriptor = vi.fn();
    const registerGatewayMethod = vi.fn();
    const runtime = createRuntime({ nodes: [] });
    const api = {
      runtime,
      session: { controls: { registerControlUiDescriptor } },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const supervisor = new CodexSupervisor([localEndpoint]);

    registerCodexSessionCatalogGateway({ api, supervisor });

    expect(registerControlUiDescriptor).toHaveBeenCalledWith({
      surface: "tab",
      id: "sessions",
      label: "Codex Sessions",
      description: "Codex sessions on this Gateway and paired nodes.",
      icon: "terminal",
      group: "control",
      requiredScopes: ["operator.write"],
    });
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      CODEX_SESSION_CATALOG_METHOD,
      expect.any(Function),
      { scope: "operator.write" },
    );

    expect(
      parseCodexSessionCatalogResult({
        hosts: [
          {
            hostId: "node:one",
            label: "One",
            kind: "node",
            connected: true,
            sessions: [
              {
                threadId: "thread-1",
                status: "idle",
                archived: false,
                preview: "private",
                turns: ["private"],
              },
            ],
            codexHome: "/private/.codex",
          },
        ],
      }),
    ).toEqual({
      hosts: [
        {
          hostId: "node:one",
          label: "One",
          kind: "node",
          connected: true,
          sessions: [{ threadId: "thread-1", status: "idle", archived: false }],
        },
      ],
    });

    for (const field of ["nextCursor", "backwardsCursor"] as const) {
      expect(() =>
        parseCodexSessionCatalogResult({
          hosts: [
            {
              hostId: "node:one",
              label: "One",
              kind: "node",
              connected: true,
              sessions: [],
              [field]: "x".repeat(4097),
            },
          ],
        }),
      ).toThrow(`invalid ${field === "nextCursor" ? "next" : "backwards"} cursor`);
    }
  });

  it("returns invalid-request errors for malformed Gateway parameters", async () => {
    const registerGatewayMethod = vi.fn();
    const api = {
      runtime: createRuntime({ nodes: [] }),
      session: { controls: { registerControlUiDescriptor: vi.fn() } },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    registerCodexSessionCatalogGateway({ api, supervisor: new CodexSupervisor([localEndpoint]) });
    const handler = registerGatewayMethod.mock.calls[0]?.[1] as (
      params: GatewayRequestHandlerOptions,
    ) => Promise<void>;
    const respond = vi.fn();

    await handler({
      params: { limitPerHost: 101 },
      respond,
    } as unknown as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledWith(
      false,
      { error: "limitPerHost must be an integer from 1 to 100" },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    respond.mockClear();
    await handler({
      params: { hostIds: [42] },
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(
      false,
      { error: "Codex session catalog host ids must be strings" },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
