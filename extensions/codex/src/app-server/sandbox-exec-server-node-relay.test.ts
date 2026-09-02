import { once } from "node:events";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
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

const customLoggingPattern = vi.hoisted(() => ({ value: "" }));
vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>();
  return {
    ...actual,
    redactToolPayloadText: (text: string) => {
      const redacted = actual.redactToolPayloadText(text);
      return customLoggingPattern.value
        ? redacted.replaceAll(customLoggingPattern.value, "[redacted]")
        : redacted;
    },
  };
});

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

function encodeHttpBody(contentType: string, body: string) {
  return {
    headers: [{ name: "Content-Type", value: contentType }],
    bodyBase64: Buffer.from(body).toString("base64"),
  };
}

async function expectPairedNodeHttpCredentialRejection(params: {
  url?: string;
  headers?: Array<{ name: string; value: string }>;
  bodyBase64?: string;
}): Promise<void> {
  const transport = createNodeChannel();
  const sandbox = createNodeSandbox();
  const client = createClient();
  const onExecutionDisconnect = vi.fn<(error: Error) => void>();
  await ensureCodexSandboxExecServerEnvironment({
    client: client as never,
    sandbox,
    runtime: createNodeRuntime(async () => transport.channel),
    signal: new AbortController().signal,
    onExecutionDisconnect,
  });
  const socket = await openSocket(execServerUrlFromClient(client));
  let resolveForwarded: () => void = () => {};
  const forwarded = new Promise<void>((resolve) => {
    resolveForwarded = resolve;
  });
  transport.channel.send.mockImplementation(async () => resolveForwarded());
  const outcome = Promise.race([
    once(socket, "message").then(([message]) => ({
      kind: "rejected" as const,
      message: JSON.parse(Buffer.from(message as Buffer).toString()) as {
        id: number;
        error: { code: number; message: string };
      },
    })),
    forwarded.then(() => ({ kind: "forwarded" as const })),
  ]);

  socket.send(
    JSON.stringify({
      id: 13,
      method: "http/request",
      params: {
        method: "POST",
        url: "https://example.test",
        headers: [],
        ...params,
        requestId: "request-13",
      },
    }),
  );

  const result = await outcome;
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") {
    return;
  }
  expect(result.message.id).toBe(13);
  expect(result.message.error).toEqual({
    code: -32602,
    message: expect.stringMatching(/authenticated remote HTTP.*Gateway.*credential-free/i),
  });
  expect(JSON.stringify(result.message)).not.toContain("synthetic-canary");
  expect(transport.channel.send).not.toHaveBeenCalled();
  expect(onExecutionDisconnect).not.toHaveBeenCalled();
}

useIsolatedStateGuard();

afterEach(async () => {
  customLoggingPattern.value = "";
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
      maxOutstandingDeliveryBytes: MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES + 2 * 1024 * 1024,
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
            HTTPS_PROXY: ["https://user", "proxy-canary@proxy.example"].join(":"),
            SAFE_CANARY: "ordinary-env",
            URL: "https://x/e",
          },
          envPolicy: {
            inherit: "none",
            set: {
              OPENAI_API_KEY: "policy-secret-canary", // pragma: allowlist secret
              GITHUB_TOKEN: "policy-token-canary", // pragma: allowlist secret
              DATABASE_URL: ["postgres://user", "database-canary@db.example/app"].join(":"),
              SAFE_POLICY: "ordinary-policy",
              U: "https://x/p",
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
    const { params } = forwarded;
    expect(params.env).toEqual({ SAFE_CANARY: "ordinary-env", URL: "https://x/e" });
    expect(params.envPolicy.set).toEqual({ SAFE_POLICY: "ordinary-policy", U: "https://x/p" });
    expect(params.unknownFutureField).toEqual({ preserved: true });

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

  it.each([
    ["bearer authorization", [{ name: "Authorization", value: "Bearer synthetic-canary" }]],
    ["OAuth authorization", [{ name: "authorization", value: "OAuth synthetic-canary" }]],
    [
      "mixed-case proxy authorization",
      [{ name: "pRoXy-AuThOrIzAtIoN", value: "Bearer synthetic-canary" }],
    ],
    ["request cookie", [{ name: "Cookie", value: "session=synthetic-canary" }]],
    ["API key", [{ name: "X-Api-Key", value: "synthetic-canary" }]],
    ["Google API key", [{ name: "x-goog-api-key", value: "synthetic-canary" }]],
    ["Vault token", [{ name: "X-Vault-Token", value: "synthetic-canary" }]],
    ["Cloudflare JWT assertion", [{ name: "Cf-Access-Jwt-Assertion", value: "synthetic-canary" }]],
    ["request signature", [{ name: "X-Request-Signature", value: "synthetic-canary" }]],
    ["one-time passcode", [{ name: "X-Provider-Otp", value: "synthetic-canary" }]],
    ["plural credentials", [{ name: "X-Provider-Credentials", value: "synthetic-canary" }]],
    ["mixed-case auth token", [{ name: "X-AuTh-ToKeN", value: "synthetic-canary" }]],
    ["provider function key", [{ name: "x-functions-key", value: "synthetic-canary" }]],
    [
      "credential after repeated safe headers",
      [
        { name: "X-Trace", value: "first" },
        { name: "x-trace", value: "second" },
        { name: "aUtHoRiZaTiOn", value: "Bearer synthetic-canary" },
      ],
    ],
  ])(
    "rejects %s before forwarding any credential to the paired device",
    async (_label, headers) => await expectPairedNodeHttpCredentialRejection({ headers }),
  );

  it.each([
    [
      "URL Basic credentials",
      {
        url: (() => {
          const url = new URL("https://example.test/path");
          url.username = "user";
          url.password = "synthetic-canary";
          return url.toString();
        })(),
      },
    ],
    ["OAuth URL access token", { url: "https://example.test/path?access_token=synthetic-canary" }],
    ["session identity", { url: "https://example.test/path?sessionId=synthetic-canary" }],
    ["matrix session", { url: "https://x/p;jsessionid=synthetic-canary" }],
    ["matrix case", { url: "https://x/p;JSESSIONID=synthetic-canary" }],
    ["encoded matrix", { url: "https://x/p%3Bjsessionid%3Dsynthetic-canary" }],
    ["nested matrix", { url: "https://x/a;region=west/b;session_id=synthetic-canary" }],
    ["nested fragment MFA", { url: "https://x/#/callback?mfa_code=123456" }],
    ["direct access-token fragment", { url: "https://x/#access_token=synthetic-canary" }],
    ["direct ticket fragment", { url: "https://x/#ticket=synthetic-canary" }],
    ["encoded path MFA", { url: "https://x/callback%3Fmfa_code%3D123456" }],
    ["nested encoded MFA", { url: "https://x/callback%253Fmfa_code%253D123456" }],
    ["ticket query", { url: "https://x/?ticket=synthetic-canary" }],
    ["bearer query", { url: "https://x/?bearer=synthetic-canary" }],
    ["SAML assertion", { url: "https://example.test/path?SAMLResponse=synthetic-canary" }],
    ["OAuth device code", { url: "https://example.test/path?device_code=synthetic-canary" }],
    ["OAuth consumer key", { url: "https://x/?oauth_consumer_key=synthetic-canary" }],
    ["encoded token", { url: `https://x/?v=${["sk", "live", "x".repeat(30)].join("%255F")}` }],
    ["encoded nested credential", { url: "https://x/?u%255Bpassword%255D=synthetic-canary" }],
    [
      "OAuth form body",
      {
        headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }],
        bodyBase64: Buffer.from(
          "grant_type=authorization_code&client_secret=synthetic-canary",
        ).toString("base64"),
      },
    ],
    [
      "OAuth client assertion form body",
      encodeHttpBody("application/x-www-form-urlencoded", "client_assertion=synthetic-canary"),
    ],
    [
      "passphrase form body",
      encodeHttpBody("application/x-www-form-urlencoded", "passphrase=synthetic-canary"),
    ],
    ["pwd JSON body", encodeHttpBody("application/json", '{"pwd":"synthetic-canary"}')],
    ["OAuth PKCE JSON", encodeHttpBody("application/json", '{"code_verifier":"synthetic-canary"}')],
    [
      "duplicate escaped JSON",
      encodeHttpBody(
        "application/json",
        '{"client_se\\u0063ret":"synthetic-canary","client_secret":"safe"}',
      ),
    ],
    [
      "oversized JSON",
      encodeHttpBody("application/json", `{"safe":"${"x".repeat(1024 * 1024 + 1)}"}`),
    ],
    [
      "oversized body without a declared content type",
      { bodyBase64: Buffer.from("x".repeat(1024 * 1024 + 1)).toString("base64") },
    ],
    [
      "invalid JSON body",
      encodeHttpBody("application/json", '{"client_assertion":"synthetic-canary"'),
    ],
    [
      "unsupported XML body",
      encodeHttpBody("application/xml", "<credential>synthetic-canary</credential>"),
    ],
    [
      "unsupported multipart body",
      encodeHttpBody(
        "multipart/form-data; boundary=test",
        "--test\r\nsynthetic-canary\r\n--test--",
      ),
    ],
    ["unsupported opaque body", { bodyBase64: Buffer.from("synthetic-canary").toString("base64") }],
    [
      "XML disguised as plain text",
      encodeHttpBody("text/plain", "<credential>synthetic-canary</credential>"),
    ],
    ["invalid UTF-8 body", { bodyBase64: Buffer.from([0xff, 0xfe]).toString("base64") }],
    [
      "canonical Slack webhook URL",
      {
        url: new URL(
          ["services", `T${"1".repeat(10)}`, `B${"2".repeat(10)}`, "x".repeat(25)].join("%252F"),
          "https://hooks.slack.com/",
        ).toString(),
      },
    ],
    [
      "canonical Discord webhook URL",
      {
        url: new URL(
          ["api", "webhooks", "1".repeat(18), "x".repeat(68)].join("/"),
          "https://discord.com/",
        ).toString(),
      },
    ],
  ])(
    "rejects %s before forwarding any credential to the paired device",
    async (_label, params) => await expectPairedNodeHttpCredentialRejection(params),
  );

  it("honors operator-configured custom logging patterns in decoded values", async () => {
    customLoggingPattern.value = "tenant-pattern-canary";
    await expectPairedNodeHttpCredentialRejection({
      url: `https://example.test/?safe=${customLoggingPattern.value.replaceAll("-", "%252D")}`,
    });
    await expectPairedNodeHttpCredentialRejection(
      encodeHttpBody(
        "application/json",
        '{"safe":"tenant\\u002dpattern\\u002dcanary","safe":"ok"}',
      ),
    );
  });

  it.each([
    [
      "JSON nested routing",
      "application/json",
      JSON.stringify({ greeting: "hello", token_count: 2, status_code: 200 }),
      "https://x/stream;region=west#/callback?view=summary",
    ],
    ["ordinary plain text", "text/plain", "ordinary body", "https://x/c%3Fv%3Ds"],
    ["bracketed plain text", "text/plain", "[INFO] deployment completed", "https://x/"],
    ["large plain text", "text/plain", "x".repeat(1024 * 1024 + 1), "https://x/"],
  ])("forwards credential-free %s byte-for-byte", async (_label, contentType, body, url) => {
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
    const request = JSON.stringify({
      id: 14,
      method: "http/request",
      params: {
        method: "POST",
        url,
        headers: [
          { name: "X-Trace", value: "first" },
          { name: "x-trace", value: "second" },
          { name: "Content-Type", value: contentType },
        ],
        bodyBase64: Buffer.from(body).toString("base64"),
        redirectPolicy: "follow",
        requestId: "request-14",
        streamResponse: true,
      },
    });

    socket.send(request);

    await vi.waitFor(() => expect(transport.channel.send).toHaveBeenCalledOnce());
    expect(Buffer.from(transport.channel.send.mock.calls[0]![0]).toString()).toBe(request);
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
    const firstDisconnected = vi.fn<(error: Error) => void>();
    const secondDisconnected = vi.fn<(error: Error) => void>();
    const runtime = createNodeRuntime(openDuplex);
    const first = await ensureCodexSandboxExecServerEnvironment({
      client: firstClient as never,
      sandbox,
      runtime,
      signal: new AbortController().signal,
      onExecutionDisconnect: firstDisconnected,
    });
    const second = await ensureCodexSandboxExecServerEnvironment({
      client: secondClient as never,
      sandbox,
      runtime,
      signal: new AbortController().signal,
      onExecutionDisconnect: secondDisconnected,
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
    const firstSocketClosed = waitForSocketClose(firstSocket);
    await releaseCodexSandboxExecServerEnvironment(sandbox, first);
    expect(channels[0]!.channel.close).toHaveBeenCalledTimes(1);
    expect(channels[1]!.channel.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(firstSocket.readyState).toBe(firstSocket.CLOSED));
    await expect(firstSocketClosed).resolves.toEqual({ code: 1001 });
    expect(firstDisconnected).not.toHaveBeenCalled();
    expect(secondDisconnected).not.toHaveBeenCalled();
    secondSocket.send('{"id":3,"method":"environment/info"}');
    await vi.waitFor(() => expect(channels[1]!.channel.send).toHaveBeenCalledTimes(2));
    const secondReply = once(secondSocket, "message");
    await channels[1]!.receive(Buffer.from('{"id":3,"result":{"ok":true}}'));
    await expect(secondReply).resolves.toEqual([
      Buffer.from('{"id":3,"result":{"ok":true}}'),
      false,
    ]);
    const server = await sandboxExecServerRegistry.servers.get(sandbox.runtimeId);
    expect(server?.cleanupTasks.size).toBe(1);
    const secondSocketClosed = waitForSocketClose(secondSocket);
    await releaseCodexSandboxExecServerEnvironment(sandbox, second);
    expect(channels[1]!.channel.close).toHaveBeenCalledTimes(1);
    await expect(secondSocketClosed).resolves.toEqual({ code: 1001 });
    expect(server?.cleanupTasks.size).toBe(0);
    expect(firstDisconnected).not.toHaveBeenCalled();
    expect(secondDisconnected).not.toHaveBeenCalled();
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

  it("fails an unclaimed node channel immediately before its loopback socket connects", async () => {
    const transport = createNodeChannel();
    const sandbox = createNodeSandbox();
    const client = createClient();
    const attempt = new AbortController();
    let rejectRegistration: (error: Error) => void = () => {};
    const registration = new Promise<Record<string, never>>((_resolve, reject) => {
      rejectRegistration = reject;
    });
    client.request.mockImplementation(async () => await registration);
    const onExecutionDisconnect = vi.fn((error: Error) => {
      attempt.abort(error);
      rejectRegistration(error);
    });
    const environment = ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
      runtime: createNodeRuntime(async () => transport.channel),
      signal: attempt.signal,
      onExecutionDisconnect,
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    const fakeSecret = "sk-1234567890abcdef";

    transport.fail(new Error(`exec-server exited: OPENAI_API_KEY=${fakeSecret}`));

    await expect(environment).rejects.toThrow("exec-server exited");
    expect(onExecutionDisconnect).toHaveBeenCalledOnce();
    expect(onExecutionDisconnect.mock.calls[0]?.[0].message).not.toContain(fakeSecret);
    expect(transport.channel.close).toHaveBeenCalledTimes(1);
    expect(sandboxExecServerRegistry.servers.has(sandbox.runtimeId)).toBe(false);
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
