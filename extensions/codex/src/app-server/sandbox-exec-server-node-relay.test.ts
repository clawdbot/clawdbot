import { once } from "node:events";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import {
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

const MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;

type NodeChannel = Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>>;

function createNodeChannel() {
  let resolveClosed: (result: unknown) => void = () => {};
  let rejectClosed: (error: Error) => void = () => {};
  let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
  let channelClosed = false;
  const closed = new Promise<unknown>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const channel = {
    send: vi.fn<NodeChannel["send"]>(async () => {
      if (channelClosed) {
        throw new Error("execution channel closed");
      }
    }),
    onMessage: vi.fn<NodeChannel["onMessage"]>((listener) => {
      receive = listener;
      return () => {
        receive = undefined;
      };
    }),
    closed,
    close: vi.fn<NodeChannel["close"]>(() => {
      channelClosed = true;
      resolveClosed({ ok: true });
    }),
  } satisfies NodeChannel;
  return {
    channel,
    disconnect: () => resolveClosed({ ok: false, error: "device disconnected" }),
    fail: (error: Error) => rejectClosed(error),
    receive: async (message: Uint8Array) => await receive?.(message),
  };
}

function createNodeSandbox() {
  return {
    ...createSandboxContext({}),
    backendId: "node",
    backend: undefined,
    fsBridge: undefined,
    placementExecutionMode: "remote-exec" as const,
    placementNodeId: "paired-device-1",
    placementEnvironmentId: "environment-paired-device-1",
    placementSessionId: "session-paired-device-1",
    placementOwnerEpoch: 7,
    containerWorkdir: "/remote/managed-workspace",
  };
}

function createNodeRuntime(openDuplex: PluginRuntime["nodes"]["openDuplex"]): PluginRuntime {
  return { nodes: { openDuplex } } as PluginRuntime;
}

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

describe("Codex paired-device exec-server relay", () => {
  it("authorizes one bounded attempt-owned node channel before registering the local environment", async () => {
    const transport = createNodeChannel();
    const openDuplex = vi.fn<PluginRuntime["nodes"]["openDuplex"]>(async () => transport.channel);
    const sandbox = createNodeSandbox();
    const client = createClient();
    const attempt = new AbortController();

    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
      runtime: createNodeRuntime(openDuplex),
      signal: attempt.signal,
    });

    expect(environment).toEqual({
      environmentId: expect.stringMatching(/^openclaw-node-/),
      cwd: "/remote/managed-workspace",
    });
    expect(environment?.environmentId.length).toBeLessThanOrEqual(64);
    expect(openDuplex).toHaveBeenCalledWith({
      nodeId: "paired-device-1",
      command: "codex.exec-server.stdio.v1",
      params: {
        cwd: "/remote/managed-workspace",
        environmentId: "environment-paired-device-1",
        sessionId: "session-paired-device-1",
        ownerEpoch: 7,
        sessionKey: sandbox.sessionKey,
      },
      sessionKey: sandbox.sessionKey,
      timeoutMs: 0,
      maxMessageBytes: MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES,
      signal: attempt.signal,
    });
    expect(openDuplex.mock.invocationCallOrder[0]).toBeLessThan(
      client.request.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(execServerUrlFromClient(client)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/openclaw-/);
  });

  it.each([
    ["missing environment", { placementEnvironmentId: "" }],
    ["invalid session", { placementSessionId: " session " }],
    ["negative owner epoch", { placementOwnerEpoch: -1 }],
    ["zero owner epoch", { placementOwnerEpoch: 0 }],
    ["missing session key", { sessionKey: "" }],
  ])(
    "rejects a node workspace with %s before opening a channel",
    async (_label, invalidIdentity) => {
      const sandbox = { ...createNodeSandbox(), ...invalidIdentity };
      const client = createClient();
      const openDuplex = vi.fn<PluginRuntime["nodes"]["openDuplex"]>();

      await expect(
        ensureCodexSandboxExecServerEnvironment({
          client: client as never,
          sandbox,
          runtime: createNodeRuntime(openDuplex),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("exact placement workspace identity");

      expect(openDuplex).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("preserves versionless and reverse JSON-RPC while scrubbing both process environment maps", async () => {
    const transport = createNodeChannel();
    const sandbox = createNodeSandbox();
    const client = createClient();
    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
      runtime: createNodeRuntime(async () => transport.channel),
      signal: new AbortController().signal,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const initialize = '{"id":1,"method":"initialize","params":{"clientName":"codex"}}';
    socket.send(initialize);
    await vi.waitFor(() => expect(transport.channel.send).toHaveBeenCalledTimes(1));
    expect(Buffer.from(transport.channel.send.mock.calls[0]![0]).toString()).toBe(initialize);

    socket.send(
      JSON.stringify({
        id: 2,
        method: "process/start",
        params: {
          env: {
            OPENAI_API_KEY: "secret-canary", // pragma: allowlist secret
            GH_TOKEN: "token-canary", // pragma: allowlist secret
            SAFE_CANARY: "ordinary-env",
          },
          envPolicy: {
            inherit: "none",
            set: {
              OPENAI_API_KEY: "policy-secret-canary", // pragma: allowlist secret
              GITHUB_TOKEN: "policy-token-canary", // pragma: allowlist secret
              SAFE_POLICY: "ordinary-policy",
            },
          },
          unknownFutureField: { preserved: true },
        },
      }),
    );
    await vi.waitFor(() => expect(transport.channel.send).toHaveBeenCalledTimes(2));
    const forwarded = JSON.parse(
      Buffer.from(transport.channel.send.mock.calls[1]![0]).toString(),
    ) as { params: { env: unknown; envPolicy: { set: unknown }; unknownFutureField: unknown } };
    expect(forwarded.params.env).toEqual({ SAFE_CANARY: "ordinary-env" });
    expect(forwarded.params.envPolicy.set).toEqual({ SAFE_POLICY: "ordinary-policy" });
    expect(forwarded.params.unknownFutureField).toEqual({ preserved: true });

    const reverseRequest = JSON.stringify({
      id: 7,
      method: "network/policyRequest",
      params: {
        processId: "policy-proof",
        request: { protocol: "https_connect", host: "example.test", port: 443 },
      },
    });
    const received = once(socket, "message");
    await transport.receive(Buffer.from(reverseRequest));
    const [message] = await received;
    expect(Buffer.from(message as Buffer).toString()).toBe(reverseRequest);
    const reverseResponse = '{"id":7,"result":{"decision":{"type":"allow"}}}';
    socket.send(reverseResponse);
    await vi.waitFor(() => expect(transport.channel.send).toHaveBeenCalledTimes(3));
    expect(Buffer.from(transport.channel.send.mock.calls[2]![0]).toString()).toBe(reverseResponse);

    await releaseCodexSandboxExecServerEnvironment(sandbox, environment);
    expect(transport.channel.close).toHaveBeenCalledTimes(1);
  });

  it("rejects replay of a claimed channel and binds simultaneous leases to fresh exact channels", async () => {
    const channels = [createNodeChannel(), createNodeChannel()];
    let nextChannel = 0;
    const openDuplex = vi.fn<PluginRuntime["nodes"]["openDuplex"]>(
      async () => channels[nextChannel++]!.channel,
    );
    const sandbox = createNodeSandbox();
    const firstClient = createClient();
    const secondClient = createClient();
    const runtime = createNodeRuntime(openDuplex);
    const first = await ensureCodexSandboxExecServerEnvironment({
      client: firstClient as never,
      sandbox,
      runtime,
      signal: new AbortController().signal,
    });
    const second = await ensureCodexSandboxExecServerEnvironment({
      client: secondClient as never,
      sandbox,
      runtime,
      signal: new AbortController().signal,
    });
    expect(first?.environmentId).not.toBe(second?.environmentId);
    expect(firstClient.request).toHaveBeenCalledWith(
      "environment/add",
      expect.objectContaining({ environmentId: first?.environmentId }),
      expect.any(Object),
    );
    expect(secondClient.request).toHaveBeenCalledWith(
      "environment/add",
      expect.objectContaining({ environmentId: second?.environmentId }),
      expect.any(Object),
    );
    const firstSocket = await openSocket(execServerUrlFromClient(firstClient));
    const secondSocket = await openSocket(execServerUrlFromClient(secondClient));
    firstSocket.send('{"id":1,"method":"environment/info"}');
    secondSocket.send('{"id":2,"method":"environment/status"}');
    await vi.waitFor(() => {
      expect(channels[0]!.channel.send).toHaveBeenCalledTimes(1);
      expect(channels[1]!.channel.send).toHaveBeenCalledTimes(1);
    });

    const replay = await openSocket(execServerUrlFromClient(firstClient));
    await expect(waitForSocketClose(replay)).resolves.toEqual({ code: 1008 });
    await releaseCodexSandboxExecServerEnvironment(sandbox, first);
    expect(channels[0]!.channel.close).toHaveBeenCalledTimes(1);
    expect(channels[1]!.channel.close).not.toHaveBeenCalled();
    await releaseCodexSandboxExecServerEnvironment(sandbox, second);
    expect(channels[1]!.channel.close).toHaveBeenCalledTimes(1);
  });

  it("makes a node disconnect terminal and closes its transport exactly once", async () => {
    const transport = createNodeChannel();
    const sandbox = createNodeSandbox();
    const client = createClient();
    const onExecutionDisconnect = vi.fn<(error: Error) => void>();
    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
      runtime: createNodeRuntime(async () => transport.channel),
      signal: new AbortController().signal,
      onExecutionDisconnect,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const socketClosed = waitForSocketClose(socket);
    transport.disconnect();
    await expect(socketClosed).resolves.toEqual({ code: 1001 });
    expect(onExecutionDisconnect).toHaveBeenCalledOnce();
    expect(onExecutionDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("start a fresh attempt") }),
    );
    await expect(transport.channel.send(Buffer.from("{}"))).rejects.toThrow(
      "execution channel closed",
    );
    await releaseCodexSandboxExecServerEnvironment(sandbox, environment);
    expect(transport.channel.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces bounded node-command failures without exposing credentials", async () => {
    const transport = createNodeChannel();
    const sandbox = createNodeSandbox();
    const client = createClient();
    const onExecutionDisconnect = vi.fn<(error: Error) => void>();
    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
      runtime: createNodeRuntime(async () => transport.channel),
      signal: new AbortController().signal,
      onExecutionDisconnect,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const socketClosed = waitForSocketClose(socket);
    const fakeSecret = "sk-1234567890abcdef";

    transport.fail(
      new Error(`exec-server launch failed: OPENAI_API_KEY=${fakeSecret} ${"x".repeat(300)}`),
    );

    await expect(socketClosed).resolves.toEqual({ code: 1011 });
    expect(onExecutionDisconnect).toHaveBeenCalledOnce();
    const failure = onExecutionDisconnect.mock.calls[0]?.[0];
    expect(failure?.message).toContain("exec-server launch failed");
    expect(failure?.message).not.toContain(fakeSecret);
    expect(failure?.message.length).toBeLessThan(360);
    await releaseCodexSandboxExecServerEnvironment(sandbox, environment);
    expect(transport.channel.close).toHaveBeenCalledTimes(1);
  });

  it("rejects device frames above the upstream 64 MiB JSON-RPC ceiling", async () => {
    const transport = createNodeChannel();
    const sandbox = createNodeSandbox();
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
      runtime: createNodeRuntime(async () => transport.channel),
      signal: new AbortController().signal,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const socketClosed = waitForSocketClose(socket);
    await transport.receive(new Uint8Array(MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES + 1));
    await expect(socketClosed).resolves.toEqual({ code: 1009 });
    expect(transport.channel.close).toHaveBeenCalledTimes(1);
  });

  it("never registers an environment when paired-device authorization is denied", async () => {
    const sandbox = createNodeSandbox();
    const client = createClient();
    const openDuplex = vi.fn<PluginRuntime["nodes"]["openDuplex"]>(async () => {
      throw new Error("paired-device approval denied");
    });

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        runtime: createNodeRuntime(openDuplex),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("paired-device approval denied");
    expect(client.request).not.toHaveBeenCalled();
    expect(sandboxExecServerRegistry.servers.has(sandbox.runtimeId)).toBe(false);
  });
});
