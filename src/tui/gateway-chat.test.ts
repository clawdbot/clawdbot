import { afterEach, describe, expect, it, vi } from "vitest";
// Covers gateway-backed chat behavior used by the TUI backend.
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/index.js";

const { GatewayChatClient } = await import("./gateway-chat.js");
const { GatewayClientRequestError } = await import("../gateway/client.js");

describe("GatewayChatClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for gateway transport teardown on stop", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    let finishStop: (() => void) | undefined;
    const stopAndWait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    (client as unknown as { client: { stopAndWait: typeof stopAndWait } }).client.stopAndWait =
      stopAndWait;

    let stopped = false;
    const stopPromise = client.stop().then(() => {
      stopped = true;
    });

    expect(stopAndWait).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    finishStop?.();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("identifies the TUI and forwards one structured connect failure per failed socket", async () => {
    const constructedOptions: Array<Record<string, unknown>> = [];

    vi.resetModules();
    vi.doMock("../gateway/client.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../gateway/client.js")>();
      class CapturingGatewayClient {
        constructor(opts: Record<string, unknown>) {
          constructedOptions.push(opts);
        }
        start() {}
        stop() {}
        request() {
          throw new Error("unexpected request");
        }
      }
      return { ...actual, GatewayClient: CapturingGatewayClient };
    });

    try {
      const { GatewayChatClient: CapturingGatewayChatClient } = await import("./gateway-chat.js");
      const client = new CapturingGatewayChatClient({
        url: "wss://remote.example/rpc",
        deviceAuthScope: "wss://remote.example/rpc",
        token: "test-token",
        tlsFingerprint: "sha256:11:22:33:44",
        preauthHandshakeTimeoutMs: 30_000,
      });

      expect(constructedOptions).toHaveLength(1);
      expect(constructedOptions[0]).toMatchObject({
        clientName: "openclaw-tui",
        caps: ["agent-kind", "plugin-approvals", "task-suggestions", "tool-events"],
        mode: "ui",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
        preauthHandshakeTimeoutMs: 30_000,
        tlsFingerprint: "sha256:11:22:33:44",
        deviceAuthScope: "wss://remote.example/rpc",
      });
      expect(constructedOptions[0]).not.toHaveProperty("deviceIdentity");
      const onConnectError = vi.fn();
      const onDisconnected = vi.fn();
      client.onConnectError = onConnectError;
      client.onDisconnected = onDisconnected;
      const connectError = new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: "pair-1" },
      });
      const options = constructedOptions[0] as {
        onConnectError?: (error: Error) => void;
        onHelloOk?: (hello: unknown) => void;
        onClose?: (code: number, reason: string) => void;
      };

      options.onConnectError?.(connectError);
      options.onConnectError?.(new Error("duplicate failure for the same socket"));
      options.onClose?.(1008, "pairing required");

      expect(onConnectError).toHaveBeenCalledExactlyOnceWith(connectError);
      expect(connectError.message).toContain("Pairing request sent.");
      expect(connectError.message).toContain("Control UI (Settings -> Devices)");
      expect(connectError.message).toContain("openclaw devices approve --latest");
      expect(connectError.details).toEqual({ code: "PAIRING_REQUIRED", requestId: "pair-1" });
      expect(onDisconnected).not.toHaveBeenCalled();

      const retryError = new Error("retry failed");
      options.onConnectError?.(retryError);
      expect(onConnectError).toHaveBeenCalledOnce();
      options.onHelloOk?.({});
      options.onConnectError?.(retryError);
      expect(onConnectError).toHaveBeenNthCalledWith(2, retryError);

      options.onHelloOk?.({});
      onDisconnected.mockClear();
      client.onConnectError = (error) => {
        onConnectError(error);
        client.onConnectError = undefined;
      };
      (
        client as unknown as { notifyUnclosedConnectError: (error: Error) => void }
      ).notifyUnclosedConnectError(new Error("one-shot structured failure"));
      expect(onDisconnected).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../gateway/client.js");
      vi.resetModules();
    }
  });

  it("surfaces loopback block-mode start failures through disconnect handler", async () => {
    vi.useFakeTimers();
    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const proxyHandle = await startProxy({
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });
    const onDisconnected = vi.fn();
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    client.onDisconnected = onDisconnected;

    try {
      client.start();
      await vi.advanceTimersByTimeAsync(2);

      expect(onDisconnected).toHaveBeenCalledWith(
        "proxy: Gateway loopback control-plane connections are blocked by proxy.loopbackMode",
      );
    } finally {
      await stopProxy(proxyHandle);
    }
  });

  it("retries startup-unavailable chat history until the gateway finishes booting", async () => {
    vi.useFakeTimers();

    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "chat.history unavailable during gateway startup",
          details: { method: "chat.history" },
          retryable: true,
          retryAfterMs: 250,
        }),
      )
      .mockResolvedValueOnce({ messages: [] });

    (client as unknown as { client: { request: typeof request } }).client.request = request;

    const historyPromise = client.loadHistory({ sessionKey: "main", limit: 200 });
    await vi.advanceTimersByTimeAsync(250);

    await expect(historyPromise).resolves.toEqual({ messages: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("passes selected-agent global scope through chat methods", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi.fn().mockResolvedValue({ messages: [] });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await client.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "hello",
      runId: "run-global-work",
    });
    await client.loadHistory({ sessionKey: "global", agentId: "work", limit: 50 });
    await client.abortChat({ sessionKey: "global", agentId: "work", runId: "run-global-work" });

    expect(request).toHaveBeenNthCalledWith(1, "chat.send", {
      sessionKey: "global",
      agentId: "work",
      message: "hello",
      thinking: undefined,
      deliver: undefined,
      timeoutMs: undefined,
      idempotencyKey: "run-global-work",
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: "global",
      agentId: "work",
      limit: 50,
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "global",
      agentId: "work",
      runId: "run-global-work",
    });
  });

  it("preserves side runs for session-scoped TUI aborts", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await client.abortChat({ sessionKey: "main" });

    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "main",
      preserveSideRuns: true,
    });
  });

  it("retries session aborts without side-run preservation on older Gateways", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid chat.abort params: at root: unexpected property 'preserveSideRuns'",
        }),
      )
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["run-main"] });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(client.abortChat({ sessionKey: "main" })).resolves.toEqual({
      ok: true,
      aborted: true,
      runIds: ["run-main"],
    });
    expect(request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: "main",
      preserveSideRuns: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", { sessionKey: "main" });
  });

  it("retries session creation without disposition on older Gateways", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid sessions.create params: at root: unexpected property 'succeedsParent'",
        }),
      )
      .mockResolvedValueOnce({ ok: true, key: "agent:main:tui-next" });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(
      client.createSession({
        key: "tui-next",
        parentSessionKey: "agent:main:main",
        succeedsParent: true,
      }),
    ).resolves.toEqual({ ok: true, key: "agent:main:tui-next" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      key: "tui-next",
      parentSessionKey: "agent:main:main",
      succeedsParent: true,
      emitCommandHooks: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.create", {
      key: "tui-next",
      parentSessionKey: "agent:main:main",
      emitCommandHooks: true,
    });
  });

  it("retries parallel session creation without parent lifecycle on older Gateways", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid sessions.create params: at root: unexpected property 'succeedsParent'",
        }),
      )
      .mockResolvedValueOnce({ ok: true, key: "agent:main:tui-parallel" });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(
      client.createSession({
        key: "tui-parallel",
        agentId: "main",
        parentSessionKey: "agent:main:main",
        succeedsParent: false,
      }),
    ).resolves.toEqual({ ok: true, key: "agent:main:tui-parallel" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      key: "tui-parallel",
      agentId: "main",
      parentSessionKey: "agent:main:main",
      succeedsParent: false,
      emitCommandHooks: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.create", {
      key: "tui-parallel",
      agentId: "main",
    });
  });

  it("returns the actual chat send ack status from the gateway", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi.fn().mockResolvedValue({ runId: "run-gateway", status: "timeout" });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    const result = await client.sendChat({
      sessionKey: "main",
      message: "hello",
      runId: "run-local",
    });

    expect(result).toEqual({ runId: "run-gateway", status: "timeout" });
  });

  it("lists gateway commands through commands.list", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const command = {
      name: "tts",
      textAliases: ["/tts"],
      description: "Text to speech",
      source: "plugin",
      scope: "both",
      acceptsArgs: false,
    };
    const request = vi.fn().mockResolvedValue({ commands: [command] });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(
      client.listCommands({ agentId: "main", provider: "discord", scope: "text" }),
    ).resolves.toEqual([command]);
    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      provider: "discord",
      scope: "text",
    });
  });

  it("lists and resolves plugin approvals through the gateway", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const pending = [{ id: "plugin:skill-1" }];
    const request = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce({ ok: true });
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(client.listPluginApprovals()).resolves.toEqual(pending);
    await expect(client.resolvePluginApproval("plugin:skill-1", "allow-once")).resolves.toEqual({
      ok: true,
    });

    expect(request).toHaveBeenNthCalledWith(1, "plugin.approval.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "plugin.approval.resolve", {
      id: "plugin:skill-1",
      decision: "allow-once",
    });
  });

  it("lists profiles and serializes task suggestion acceptance modes", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const suggestion = {
      id: "task_1",
      title: "Remove stale adapter",
      prompt: "Delete the stale adapter.",
      tldr: "The adapter is unreachable.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
      agentId: "main",
      createdAt: 1_000,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ suggestions: [suggestion] })
      .mockResolvedValueOnce({ profiles: [{ id: "build", providerId: "crabbox" }] })
      .mockResolvedValueOnce({ taskId: "task_1", key: "agent:main:task" })
      .mockResolvedValueOnce({ taskId: "task_1", key: "agent:main:task" })
      .mockResolvedValueOnce({ taskId: "task_1", key: "agent:main:local" })
      .mockResolvedValueOnce({ taskId: "task_1", key: "agent:main:session" })
      .mockResolvedValueOnce({ taskId: "task_1", key: "agent:main:cloud" })
      .mockResolvedValueOnce({ taskId: "task_2", dismissed: true });
    client.hello = {
      features: {
        methods: [
          "environments.list",
          "taskSuggestions.list",
          "taskSuggestions.accept",
          "taskSuggestions.dismiss",
        ],
        capabilities: [GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES],
      },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(client.listTaskSuggestions()).resolves.toEqual([suggestion]);
    await expect(client.listCloudWorkerProfiles()).resolves.toEqual(["build"]);
    await expect(client.acceptTaskSuggestion("task_1")).resolves.toEqual({
      taskId: "task_1",
      key: "agent:main:task",
    });
    await client.acceptTaskSuggestion("task_1", "worktree");
    await client.acceptTaskSuggestion("task_1", "local");
    await client.acceptTaskSuggestion("task_1", "session");
    await client.acceptTaskSuggestion("task_1", "cloud", "build");
    await expect(client.dismissTaskSuggestion("task_2")).resolves.toEqual({
      taskId: "task_2",
      dismissed: true,
    });

    expect(request).toHaveBeenNthCalledWith(1, "taskSuggestions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "environments.list", {});
    expect(request).toHaveBeenNthCalledWith(3, "taskSuggestions.accept", { taskId: "task_1" });
    expect(request).toHaveBeenNthCalledWith(4, "taskSuggestions.accept", { taskId: "task_1" });
    expect(request).toHaveBeenNthCalledWith(5, "taskSuggestions.accept", {
      taskId: "task_1",
      mode: "local",
    });
    expect(request).toHaveBeenNthCalledWith(6, "taskSuggestions.accept", {
      taskId: "task_1",
      mode: "session",
    });
    expect(request).toHaveBeenNthCalledWith(7, "taskSuggestions.accept", {
      taskId: "task_1",
      mode: "cloud",
      cloudProfileId: "build",
    });
    expect(request).toHaveBeenNthCalledWith(8, "taskSuggestions.dismiss", { taskId: "task_2" });
  });

  it("derives task suggestion actions from negotiated methods and scopes", () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    client.hello = {
      features: {
        methods: ["taskSuggestions.accept", "taskSuggestions.dismiss"],
      },
      auth: { role: "operator", scopes: ["operator.write"] },
    } as never;

    expect(client.getTaskSuggestionActionCapabilities()).toEqual({
      canAccept: false,
      canAcceptModes: false,
      canDismiss: true,
    });

    client.hello = {
      features: {
        methods: ["taskSuggestions.accept", "taskSuggestions.dismiss"],
        capabilities: [GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES],
      },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    expect(client.getTaskSuggestionActionCapabilities()).toEqual({
      canAccept: true,
      canAcceptModes: true,
      canDismiss: true,
    });
  });

  it("skips task suggestion refreshes against older gateways", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi.fn();
    client.hello = { features: { methods: ["chat.history"] } } as never;
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(client.listTaskSuggestions()).resolves.toEqual([]);
    await expect(client.listCloudWorkerProfiles()).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps cloud profile discovery failures quiet", async () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    const request = vi.fn().mockRejectedValue(new Error("not available"));
    client.hello = { features: { methods: ["environments.list"] } } as never;
    (client as unknown as { client: { request: typeof request } }).client.request = request;

    await expect(client.listCloudWorkerProfiles()).resolves.toEqual([]);
  });
});
