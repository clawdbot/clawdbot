import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { terminalHandlers, TERMINAL_OPEN_DEADLINE_MS } from "./terminal.js";

const policyMocks = vi.hoisted(() => ({
  resolveNodeCommandAllowlist: vi.fn(() => new Set<string>()),
  isNodeCommandAllowed: vi.fn<() => { ok: true } | { ok: false; reason: string }>(() => ({
    ok: true,
  })),
  applyPluginNodeInvokePolicy: vi.fn<() => Promise<{ ok: false; message: string } | null>>(
    async () => null,
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: policyMocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: policyMocks.isNodeCommandAllowed,
}));

vi.mock("../node-invoke-plugin-policy.js", () => ({
  applyPluginNodeInvokePolicy: policyMocks.applyPluginNodeInvokePolicy,
}));

function makeOpts(
  params: unknown,
  terminalConfig: { enabled?: boolean } | undefined,
  terminalPolicyConfig?: OpenClawConfig,
  nodeRegistry: {
    get: (nodeId: string) => unknown;
    invoke?: (params: unknown) => Promise<unknown>;
  } = { get: () => undefined },
) {
  const sessions = {
    open: vi.fn(async (_request: unknown) => ({
      ok: true as const,
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
    })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    close: vi.fn(() => true),
    attach: vi.fn(() => ({
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      buffer: "replay",
      seq: 6,
    })),
    snapshot: vi.fn(() => "10%\r100%"),
    upload: vi.fn(async () => ({ path: "/tmp/upload/report.pdf", size: 4 })),
  };
  const runtimeConfig = { gateway: { terminal: terminalConfig } } as OpenClawConfig;
  const policy = createTerminalLaunchPolicy(runtimeConfig);
  if (terminalPolicyConfig) {
    policy.prepareConfig(terminalPolicyConfig, { restartPending: true });
  }
  const respond = vi.fn();
  const isConnectionActive = vi.fn(() => true);
  const isTerminalEnabled = vi.fn(() => policy.isEnabled());
  const resolveTerminalLaunchPolicy = vi.fn((agentId?: string) => policy.resolve(agentId));
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy,
    isTerminalEnabled,
    terminalSessions: sessions,
    nodeRegistry: { invoke: vi.fn(), ...nodeRegistry },
    isConnectionActive,
    logGateway: { info: vi.fn() },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0]["context"];
  const opts = {
    params: params as Record<string, unknown>,
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0];
  return {
    opts,
    sessions,
    respond,
    isConnectionActive,
    isTerminalEnabled,
    resolveTerminalLaunchPolicy,
  };
}

function installCatalog(provider: SessionCatalogProvider) {
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({ pluginId: "test", provider, source: "test" });
  setActivePluginRegistry(registry);
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  policyMocks.resolveNodeCommandAllowlist.mockReset();
  policyMocks.isNodeCommandAllowed.mockReset().mockReturnValue({ ok: true });
  policyMocks.applyPluginNodeInvokePolicy.mockReset().mockResolvedValue(null);
});

describe("terminal gateway policy", () => {
  it("returns the attach snapshot offset to capable clients", async () => {
    const { opts, respond } = makeOpts({ sessionId: "terminal-1" }, { enabled: true });
    opts.client!.connect.caps = [GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ];

    await expectDefined(terminalHandlers["terminal.attach"], "terminal.attach")(opts);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ buffer: "replay", seq: 6 }),
    );
  });

  it("keeps legacy protocol-4 attach replies within their closed schema", async () => {
    const { opts, respond } = makeOpts({ sessionId: "terminal-1" }, { enabled: true });

    await expectDefined(terminalHandlers["terminal.attach"], "terminal.attach")(opts);

    expect(respond).toHaveBeenCalledWith(true, {
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "replay",
    });
  });

  it("rejects catalog opens for missing providers", async () => {
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "missing", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );
    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("opens a provider-built local resume plan and returns its title", async () => {
    const openTerminal = vi.fn(async () => ({
      kind: "local" as const,
      argv: ["codex", "resume", "thread"],
      pathEnv: "/login-shell/bin:/usr/bin",
      title: "codex resume thread",
    }));
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({
        hostId: request.hostId,
        threadId: request.threadId,
        items: [],
      }),
      openTerminal,
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );
    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(openTerminal).toHaveBeenCalledWith({ hostId: "gateway:local", threadId: "thread" });
    expect(sessions.open).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: expect.any(String),
        args: ["-il", "-c", "'codex' 'resume' 'thread'"],
        env: expect.objectContaining({ PATH: "/login-shell/bin:/usr/bin" }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId: "terminal-1", title: "codex resume thread" }),
    );
  });

  it("rejects a catalog plan that finishes after the absolute open deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      installCatalog({
        id: "codex",
        label: "Codex",
        list: async () => [],
        read: async (request) => ({ ...request, items: [] }),
        openTerminal: async () => {
          vi.setSystemTime(TERMINAL_OPEN_DEADLINE_MS);
          return { kind: "local", argv: ["codex", "resume", "thread"] };
        },
      });
      const { opts, sessions, respond } = makeOpts(
        {
          cols: 80,
          rows: 24,
          catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
        },
        { enabled: true },
      );

      await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

      expect(sessions.open).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "terminal open timed out" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a catalog rejection after the absolute deadline to a timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      installCatalog({
        id: "codex",
        label: "Codex",
        list: async () => [],
        read: async (request) => ({ ...request, items: [] }),
        openTerminal: async () => {
          vi.setSystemTime(TERMINAL_OPEN_DEADLINE_MS);
          throw new Error("late catalog failure");
        },
      });
      const { opts, respond } = makeOpts(
        {
          cols: 80,
          rows: 24,
          catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
        },
        { enabled: true },
      );

      await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "terminal open timed out" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a terminal after the owning connection closes during catalog lookup", async () => {
    const plan = deferred<{ kind: "local"; argv: string[] }>();
    const openTerminal = vi.fn(() => plan.promise);
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal,
    });
    const { opts, sessions, respond, isConnectionActive } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledOnce());
    isConnectionActive.mockReturnValue(false);
    plan.resolve({ kind: "local", argv: ["codex", "resume", "thread"] });
    await opening;

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal connection closed" }),
    );
  });

  it("closes a terminal whose owning connection disappears during PTY creation", async () => {
    const created = deferred<{
      ok: true;
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
    }>();
    const { opts, sessions, respond, isConnectionActive } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
    );
    sessions.open.mockImplementationOnce(async () => await created.promise);

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await vi.waitFor(() => expect(sessions.open).toHaveBeenCalledOnce());
    isConnectionActive.mockReturnValue(false);
    created.resolve({
      ok: true,
      sessionId: "terminal-raced",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
    });
    await opening;

    expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-raced");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal connection closed" }),
    );
  });

  it("times out one terminal open with request-scoped cancellation", async () => {
    vi.useFakeTimers();
    try {
      const created = deferred<{
        ok: true;
        sessionId: string;
        agentId: string;
        shell: string;
        cwd: string;
      }>();
      let openSignal: AbortSignal | undefined;
      const { opts, sessions, respond } = makeOpts({ cols: 80, rows: 24 }, { enabled: true });
      sessions.open.mockImplementationOnce(async (request: unknown) => {
        openSignal = (request as { signal?: AbortSignal }).signal;
        return await created.promise;
      });

      const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
      await vi.waitFor(() => expect(openSignal).toBeDefined());
      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);
      await opening;

      expect(openSignal?.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "terminal open timed out" }),
      );
      created.resolve({
        ok: true,
        sessionId: "terminal-late",
        agentId: "main",
        shell: "/bin/zsh",
        cwd: "/work",
      });
      await vi.waitFor(() =>
        expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-late"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a terminal when disabled during catalog lookup", async () => {
    const plan = deferred<{ kind: "local"; argv: string[] }>();
    const openTerminal = vi.fn(() => plan.promise);
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal,
    });
    const { opts, sessions, respond, isTerminalEnabled } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledOnce());
    isTerminalEnabled.mockReturnValue(false);
    plan.resolve({ kind: "local", argv: ["codex", "resume", "thread"] });
    await opening;

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal is disabled" }),
    );
  });

  it("uses the refreshed launch plan after catalog lookup", async () => {
    const plan = deferred<{ kind: "local"; argv: string[] }>();
    const openTerminal = vi.fn(() => plan.promise);
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal,
    });
    const { opts, sessions, resolveTerminalLaunchPolicy } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledOnce());
    resolveTerminalLaunchPolicy.mockReturnValue({
      ok: true,
      plan: { agentId: "main", cwd: process.cwd(), shell: "/bin/refreshed", args: [] },
    });
    plan.resolve({ kind: "local", argv: ["codex", "resume", "thread"] });
    await opening;

    expect(sessions.open).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd(), shell: "/bin/refreshed" }),
    );
  });

  it("rejects a node plan when its owner node is disconnected", async () => {
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({
        hostId: request.hostId,
        threadId: request.threadId,
        items: [],
      }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command: "anthropic.claude.terminal.resume.v1",
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
    );
    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("rejects a node plan denied by the node command allowlist", async () => {
    const command = "anthropic.claude.terminal.resume.v1";
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    policyMocks.isNodeCommandAllowed.mockReturnValue({
      ok: false,
      reason: "command not allowlisted",
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      {
        get: () => ({ nodeId: "node-1", connId: "conn-node", commands: [command] }),
      },
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "command not allowlisted" }),
    );
  });

  it("opens a normally approved node relay after generic invoke policy", async () => {
    const command = "anthropic.claude.terminal.resume.v1";
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    const node = { nodeId: "node-1", connId: "conn-node", commands: [command] };
    const invoke = vi.fn((rawParams: unknown) => {
      const params = rawParams as { onInvokeId?: (id: string) => void };
      params.onInvokeId?.("invoke-1");
      return Promise.resolve({ ok: true });
    });
    const nodeRegistry = { get: () => node, invoke, sendInvokeInput: vi.fn() };
    const { opts, sessions } = makeOpts(
      {
        cols: 100,
        rows: 30,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      nodeRegistry,
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(policyMocks.resolveNodeCommandAllowlist).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ nodeId: "node-1", approvedCommands: [command] }),
    );
    expect(policyMocks.applyPluginNodeInvokePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSession: node,
        command,
        params: { threadId: "thread", cols: 100, rows: 30 },
      }),
    );
    expect(sessions.open).toHaveBeenCalledOnce();
    const openRequest = (
      sessions.open.mock.calls.at(0) as unknown as
        | [{ createBackend?: () => Promise<unknown> }]
        | undefined
    )?.at(0);
    await openRequest?.createBackend?.();
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-1", expectedConnId: "conn-node" }),
    );
  });

  it("rejects a replacement node connection that lacks the terminal command", async () => {
    const command = "anthropic.claude.terminal.resume.v1";
    const policy = deferred<null>();
    policyMocks.applyPluginNodeInvokePolicy.mockImplementationOnce(() => policy.promise);
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    let node = { nodeId: "node-1", connId: "conn-old", commands: [command] };
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      { get: () => node },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await vi.waitFor(() => expect(policyMocks.applyPluginNodeInvokePolicy).toHaveBeenCalledOnce());
    node = { nodeId: "node-1", connId: "conn-new", commands: [] };
    policy.resolve(null);
    await opening;

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal node command is not available" }),
    );
  });

  it("reports plugin invoke policy denial as unavailable", async () => {
    const command = "codex.terminal.resume.v1";
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    policyMocks.applyPluginNodeInvokePolicy.mockResolvedValue({
      ok: false,
      message: "terminal resume denied",
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      { get: () => ({ nodeId: "node-1", connId: "conn-node", commands: [command] }) },
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal resume denied" }),
    );
  });

  it("rejects reopening after an accepted disable while restart is pending", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      { gateway: { terminal: { enabled: false } } },
    );

    await expectDefined(
      terminalHandlers["terminal.open"],
      'terminalHandlers["terminal.open"] test invariant',
    )(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("rejects reopening after an accepted sandbox tightening", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    );

    await expectDefined(
      terminalHandlers["terminal.open"],
      'terminalHandlers["terminal.open"] test invariant',
    )(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("closes a live session and rejects input after disablement", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: false },
    );

    await expectDefined(
      terminalHandlers["terminal.input"],
      'terminalHandlers["terminal.input"] test invariant',
    )(opts);

    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });

  it("uploads a file through the owned terminal session", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", name: "report.pdf", contentBase64: "dGVzdA==" },
      { enabled: true },
    );

    await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

    expect(sessions.upload).toHaveBeenCalledWith("conn-1", "s1", {
      name: "report.pdf",
      contentBase64: "dGVzdA==",
    });
    expect(respond).toHaveBeenCalledWith(true, { path: "/tmp/upload/report.pdf", size: 4 });
  });

  it("rejects non-canonical base64 before staging", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", name: "report.pdf", contentBase64: "AB==" },
      { enabled: true },
    );

    await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

    expect(sessions.upload).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });

  it("binds paired-node uploads to the catalog terminal host", async () => {
    const command = "codex.terminal.resume.v1";
    const uploadCommand = "terminal.upload";
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    const node = {
      nodeId: "node-1",
      connId: "conn-node",
      commands: [command, uploadCommand],
    };
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({ path: "/tmp/node/report.pdf", size: 4 }),
    }));
    const { opts, sessions } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      { get: () => node, invoke },
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    const openRequest = sessions.open.mock.calls[0]?.[0] as
      | { stageUpload?: (file: { name: string; contentBase64: string }) => Promise<unknown> }
      | undefined;
    const result = await openRequest?.stageUpload?.({
      name: "report.pdf",
      contentBase64: "dGVzdA==",
    });

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      expectedConnId: "conn-node",
      command: uploadCommand,
      params: { name: "report.pdf", contentBase64: "dGVzdA==" },
      timeoutMs: 120_000,
    });
    expect(result).toEqual({ path: "/tmp/node/report.pdf", size: 4 });
  });

  it("sanitizes terminal snapshots before returning plain text", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1" }, { enabled: true });
    const finals = Array.from({ length: 0x7e - 0x40 + 1 }, (_, offset) =>
      String.fromCharCode(0x40 + offset),
    );
    const sequences = ["\u001B[", "\u009B"]
      .flatMap((introducer) => finals.map((finalByte) => introducer + finalByte))
      .join("");
    sessions.snapshot.mockReturnValue(`before${sequences}after`);

    await expectDefined(
      terminalHandlers["terminal.text"],
      'terminalHandlers["terminal.text"] test invariant',
    )(opts);

    expect(respond).toHaveBeenCalledWith(true, { text: "beforeafter" });
  });
});
