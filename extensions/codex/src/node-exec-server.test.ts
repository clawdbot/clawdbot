/** Protects node policy, real pinned Codex stdio framing, and child cleanup. */
import { once } from "node:events";
import { access, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexNodeExecServerCommand,
  createCodexNodeExecServerInvokePolicy,
} from "./node-exec-server.js";

type JsonRpcRecord = Record<string, unknown>;
const CODEX_NODE_EXEC_SERVER_COMMAND = "codex.exec-server.stdio.v1";

function createManagedWorkspaceInvocation(cwd: string) {
  const placement = {
    cwd,
    environmentId: "paired-environment",
    sessionId: "paired-session",
    ownerEpoch: 1,
    sessionKey: "agent:main:paired-session",
  };
  const release = vi.fn();
  const acquireManagedWorkspace = vi.fn(
    (request: {
      workspaceDir: string;
      environmentId: string;
      sessionId: string;
      ownerEpoch: number;
      sessionKey: string;
    }) => {
      if (
        request.workspaceDir !== cwd ||
        request.environmentId !== placement.environmentId ||
        request.sessionId !== placement.sessionId ||
        request.ownerEpoch !== placement.ownerEpoch ||
        request.sessionKey !== placement.sessionKey
      ) {
        throw new Error("node placement does not own the requested workspace");
      }
      return { workspaceDir: cwd, release };
    },
  );
  const context = {
    sessionKey: placement.sessionKey,
    sendNodeEvent: async () => undefined,
    acquireManagedWorkspace,
    prepareExecAuthorization: () => () => {},
  } satisfies NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;
  return { placement, context, acquireManagedWorkspace, release };
}

function createNodeFrames() {
  const controller = new AbortController();
  let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
  let signalReady = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const outbound: JsonRpcRecord[] = [];
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: controller.signal,
    emitChunk: async () => undefined,
    onInput: () => undefined,
    frames: {
      send: async (message) => {
        outbound.push(JSON.parse(Buffer.from(message).toString("utf8")) as JsonRpcRecord);
      },
      onMessage: (listener) => {
        receive = listener;
        signalReady();
        return () => {
          if (receive === listener) {
            receive = undefined;
          }
        };
      },
    },
  };
  return {
    controller,
    io,
    outbound,
    ready,
    send: async (message: unknown) => {
      if (!receive) {
        throw new Error("Codex node command did not register a ready duplex receiver.");
      }
      await receive(Buffer.from(JSON.stringify(message)));
    },
    sendRaw: async (message: Uint8Array) => {
      if (!receive) {
        throw new Error("Codex node command did not register a ready duplex receiver.");
      }
      return await receive(message);
    },
  };
}

async function readNodeResponse(
  frames: ReturnType<typeof createNodeFrames>,
  id: number,
): Promise<JsonRpcRecord> {
  await vi.waitFor(() => expect(frames.outbound.some((message) => message.id === id)).toBe(true));
  const response = frames.outbound.find((message) => message.id === id);
  if (!response || response.error) {
    throw new Error(`Codex exec-server request ${id} failed: ${JSON.stringify(response?.error)}`);
  }
  return response.result as JsonRpcRecord;
}

async function readNodeProcessNotifications(
  frames: ReturnType<typeof createNodeFrames>,
  processId: string,
  count: number,
): Promise<JsonRpcRecord[]> {
  const matching = () =>
    frames.outbound.filter(
      (message) =>
        String(message.method).startsWith("process/") &&
        (message.params as { processId?: string }).processId === processId,
    );
  await vi.waitFor(() => expect(matching()).toHaveLength(count));
  return matching().toSorted(
    (left, right) => (left.params as { seq: number }).seq - (right.params as { seq: number }).seq,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Codex node exec-server", () => {
  it("uses admitted Full launch authority without asking for a human decision", async () => {
    const { placement } = createManagedWorkspaceInvocation(process.cwd());
    const request = vi.fn(async () => ({ decision: "deny" as const }));
    const invokeNode = vi.fn();
    const invokeNodeWithSessionFull = vi.fn(async () => ({ ok: true as const }));
    await expect(
      createCodexNodeExecServerInvokePolicy().handle({
        nodeId: "paired-node",
        command: CODEX_NODE_EXEC_SERVER_COMMAND,
        params: placement,
        config: {},
        risk: { level: "high", family: "codex.exec-server" },
        approvals: { request },
        invokeNode,
        invokeNodeWithSessionFull,
      }),
    ).resolves.toEqual({ ok: true });
    expect(request).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
    expect(invokeNodeWithSessionFull).toHaveBeenCalledOnce();
  });

  it("checks node-local authorization before starting the pinned process", async () => {
    const frames = createNodeFrames();
    const workspace = createManagedWorkspaceInvocation(process.cwd());
    const prepareExecAuthorization = vi.fn(() => {
      throw new Error("node-local execution denied");
    });
    const invocation = createCodexNodeExecServerCommand().handle(
      JSON.stringify({ placement: workspace.placement, authorization: "human-approved" }),
      frames.io,
      { ...workspace.context, prepareExecAuthorization },
    );
    void invocation.catch(() => {});
    try {
      await expect(Promise.race([frames.ready, invocation])).rejects.toThrow(
        "node-local execution denied",
      );
      expect(prepareExecAuthorization).toHaveBeenCalledOnce();
    } finally {
      frames.controller.abort(new Error("policy fixture closed"));
      await invocation.catch(() => {});
    }
  });

  it("rejects forged launch authorization at the public policy boundary", async () => {
    const { placement } = createManagedWorkspaceInvocation(process.cwd());
    const request = vi.fn();
    const invokeNode = vi.fn();
    const invokeNodeWithSessionFull = vi.fn();
    for (const params of [
      { ...placement, authorization: "session-full" },
      { placement, authorization: "human-approved" },
      { placement, authorization: "session-full" },
    ]) {
      await expect(
        createCodexNodeExecServerInvokePolicy().handle({
          nodeId: "paired-node",
          command: CODEX_NODE_EXEC_SERVER_COMMAND,
          params,
          config: {},
          risk: { level: "high", family: "codex.exec-server" },
          approvals: { request },
          invokeNode,
          invokeNodeWithSessionFull,
        }),
      ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_EXEC_WORKSPACE_INVALID" });
    }
    expect(request).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
    expect(invokeNodeWithSessionFull).not.toHaveBeenCalled();
  });

  it("revalidates local policy after awaited binary setup and fails closed without node support", async () => {
    const transport = await import("./app-server/transport-stdio.js");
    const spawn = vi.spyOn(transport, "createStdioTransport");
    const workspace = createManagedWorkspaceInvocation(process.cwd());
    const frames = createNodeFrames();
    const encoded = JSON.stringify({
      placement: workspace.placement,
      authorization: "session-full",
    });
    const assertCurrent = vi.fn(() => {
      throw new Error("node policy tightened");
    });
    try {
      await expect(
        createCodexNodeExecServerCommand().handle(encoded, frames.io, {
          ...workspace.context,
          prepareExecAuthorization: () => assertCurrent,
        }),
      ).rejects.toThrow("node policy tightened");
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      await expect(
        createCodexNodeExecServerCommand().handle(encoded, frames.io, {
          ...workspace.context,
          prepareExecAuthorization: undefined,
        }),
      ).rejects.toThrow("update the node");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  it.each([
    { host: "paired device", nodeId: "paired-node" },
    { host: "cloud worker", nodeId: "cloud-worker-node" },
  ])("requires critical scoped approval on a $host", async ({ nodeId }) => {
    const policy = createCodexNodeExecServerInvokePolicy();
    expect(policy.commands).toEqual([CODEX_NODE_EXEC_SERVER_COMMAND]);
    expect(policy.dangerous).toBe(true);
    expect(policy.standingApproval).toEqual({ kind: "placement", scope: "codex.exec-server" });
    expect(policy.defaultPlatforms).toBeUndefined();
    expect(policy.classifyRisk?.({ command: CODEX_NODE_EXEC_SERVER_COMMAND, params: {} })).toEqual({
      level: "high",
      family: "codex.exec-server",
    });

    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: { connected: true } }));
    const request = vi.fn();
    const { placement } = createManagedWorkspaceInvocation(
      path.join(process.cwd(), "long-session-workspace-".repeat(20)),
    );
    const context = {
      nodeId,
      command: CODEX_NODE_EXEC_SERVER_COMMAND,
      params: placement,
      config: {},
      risk: { level: "high", family: "codex.exec-server" },
      approvals: { request },
      invokeNode,
    } satisfies OpenClawPluginNodeInvokePolicyContext;

    for (const { decision, result } of [
      {
        decision: "deny",
        result: {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_DENIED",
          message:
            "Codex node execution was denied. Retry the action and choose Allow once or Allow always to continue.",
        },
      },
      {
        decision: null,
        result: {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_EXPIRED",
          message:
            "Codex node execution approval expired before a decision. Retry the action and approve the new request.",
        },
      },
    ] as const) {
      request.mockResolvedValueOnce({ decision });
      await expect(policy.handle(context)).resolves.toEqual(result);
      expect(invokeNode).not.toHaveBeenCalled();
    }
    await expect(policy.handle({ ...context, approvals: undefined })).resolves.toMatchObject({
      ok: false,
      code: "CODEX_NODE_EXEC_APPROVAL_REQUIRED",
    });
    expect(invokeNode).not.toHaveBeenCalled();

    await expect(
      policy.handle({ ...context, params: { cwd: process.cwd() } }),
    ).resolves.toMatchObject({
      ok: false,
      code: "CODEX_NODE_EXEC_WORKSPACE_INVALID",
    });
    expect(invokeNode).not.toHaveBeenCalled();

    request.mockResolvedValueOnce({ decision: "allow-always" });
    await expect(policy.handle(context)).resolves.toEqual({
      ok: true,
      payload: { connected: true },
    });
    expect(invokeNode).toHaveBeenCalledOnce();
    invokeNode.mockClear();

    const approvedPlacement = { ...placement };
    request.mockImplementationOnce(async () => {
      placement.cwd = path.parse(process.cwd()).root;
      return { decision: "allow-once" };
    });
    await expect(policy.handle(context)).resolves.toEqual({
      ok: true,
      payload: { connected: true },
    });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(invokeNode).toHaveBeenCalledWith({
      workspace: {
        workspaceDir: approvedPlacement.cwd,
        environmentId: approvedPlacement.environmentId,
        sessionId: approvedPlacement.sessionId,
        ownerEpoch: approvedPlacement.ownerEpoch,
        sessionKey: approvedPlacement.sessionKey,
      },
      params: { placement: approvedPlacement, authorization: "human-approved" },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Run Codex on this node placement",
        description: expect.stringContaining(`${nodeId}: ${approvedPlacement.cwd}`),
        severity: "critical",
        allowedDecisions: ["allow-once", "allow-always"],
      }),
    );
    // Gateway approval descriptions are bounded to 256 characters.
    expect(request.mock.lastCall?.[0].description.slice(0, 256)).toContain(
      "arbitrary processes and filesystem access across the node account, not only this workspace",
    );
    expect(request.mock.lastCall?.[0].description.slice(0, 256)).toContain(
      "Allow always applies only while this exact placement remains active",
    );
  });

  it("rejects unmanaged placement identities before launch and malformed or oversized frames", async () => {
    const command = createCodexNodeExecServerCommand();
    const frames = createNodeFrames();
    const workspace = createManagedWorkspaceInvocation(process.cwd());
    const encodedPlacement = JSON.stringify({
      placement: workspace.placement,
      authorization: "human-approved",
    });
    await expect(command.handle(encodedPlacement)).rejects.toThrow("requires duplex frames");
    await expect(
      command.handle(
        JSON.stringify({ ...workspace.placement, env: { TOKEN: "canary" } }),
        frames.io,
        workspace.context,
      ),
    ).rejects.toThrow("managed placement workspace");
    await expect(command.handle(encodedPlacement, frames.io)).rejects.toThrow(
      "active managed placement authority",
    );
    await expect(
      command.handle(encodedPlacement, frames.io, {
        ...workspace.context,
        sessionKey: "agent:main:different-session",
      }),
    ).rejects.toThrow("active managed placement authority");
    expect(workspace.acquireManagedWorkspace).not.toHaveBeenCalled();
    for (const replacement of [
      { cwd: path.parse(process.cwd()).root },
      { environmentId: "other-environment" },
      { sessionId: "other-session" },
      { ownerEpoch: 2 },
    ]) {
      await expect(
        command.handle(
          JSON.stringify({
            placement: { ...workspace.placement, ...replacement },
            authorization: "human-approved",
          }),
          frames.io,
          workspace.context,
        ),
      ).rejects.toThrow("node placement does not own the requested workspace");
    }
    expect(workspace.release).not.toHaveBeenCalled();

    const invocation = command.handle(encodedPlacement, frames.io, workspace.context);
    void invocation.catch(() => {});
    await Promise.race([frames.ready, invocation]);
    await expect(frames.sendRaw(Buffer.from('{"id":1}\n{"id":2}'))).rejects.toThrow(
      "exactly one message",
    );
    await expect(frames.sendRaw(Uint8Array.of(0xff, 0xfe))).rejects.toThrow("malformed UTF-8");
    await expect(frames.sendRaw(new Uint8Array(64 * 1024 * 1024 + 1))).rejects.toThrow("64 MiB");
    frames.controller.abort(new Error("malformed-frame fixture closed"));
    await expect(invocation).rejects.toThrow("malformed-frame fixture closed");
    expect(workspace.release).toHaveBeenCalledOnce();
  });

  it("relays the actual pinned Codex binary, isolates credentials, and removes its private home", async () => {
    vi.stubEnv("OPENAI_API_KEY", "node-provider-canary");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "node-cloud-canary");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/node-cloud-canary.json");
    vi.stubEnv("GITHUB_TOKEN", "node-forge-canary");
    vi.stubEnv("SSH_AUTH_SOCK", "/node-ssh-canary.sock");
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");

    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "codex-node-exec-contract-" },
      async ({ dir }) => {
        const cwd = await realpath(dir);
        const workspaceUri = pathToFileURL(cwd).href;
        const probePath = path.join(cwd, "probe.txt");
        const probeUri = pathToFileURL(probePath).href;
        const frames = createNodeFrames();
        const command = createCodexNodeExecServerCommand();
        const workspace = createManagedWorkspaceInvocation(cwd);
        const invocation = command.handle(
          JSON.stringify({ placement: workspace.placement, authorization: "human-approved" }),
          frames.io,
          workspace.context,
        );
        void invocation.catch(() => {});
        let isolatedHome: string | undefined;

        try {
          await Promise.race([frames.ready, invocation]);
          // Codex deliberately omits jsonrpc:"2.0" from every wire envelope.
          await frames.send({
            id: 1,
            method: "initialize",
            params: { clientName: "openclaw-node" },
          });
          expect(await readNodeResponse(frames, 1)).toMatchObject({
            sessionId: expect.any(String),
          });
          await frames.send({ method: "initialized", params: {} });

          await frames.send({ id: 2, method: "environment/info", params: {} });
          expect(await readNodeResponse(frames, 2)).toMatchObject({
            cwd: workspaceUri,
            capabilities: { networkProxyLaunch: true, sandboxedFileStreaming: true },
          });

          const dataBase64 = Buffer.from("node filesystem proof\n").toString("base64");
          await frames.send({
            id: 3,
            method: "fs/writeFile",
            params: { path: probeUri, dataBase64, sandbox: null },
          });
          expect(await readNodeResponse(frames, 3)).toEqual({});
          expect(await readFile(probePath, "utf8")).toBe("node filesystem proof\n");

          await frames.send({
            id: 4,
            method: "fs/canonicalize",
            params: { path: probeUri, sandbox: null },
          });
          expect(await readNodeResponse(frames, 4)).toEqual({ path: probeUri });
          await frames.send({
            id: 5,
            method: "fs/open",
            params: { handleId: "node-proof", path: probeUri, sandbox: null },
          });
          expect(await readNodeResponse(frames, 5)).toEqual({ handleId: "node-proof" });
          await frames.send({
            id: 6,
            method: "fs/readBlock",
            params: { handleId: "node-proof", offset: 0, len: 256 },
          });
          expect(await readNodeResponse(frames, 6)).toEqual({ chunk: dataBase64, eof: true });
          await frames.send({ id: 7, method: "fs/close", params: { handleId: "node-proof" } });
          expect(await readNodeResponse(frames, 7)).toEqual({});

          const script = [
            "process.stdin.once('data', input => {",
            "process.stdout.write(JSON.stringify({",
            "input: input.toString().trim(),",
            "ordinary: process.env.NODE_EXEC_ORDINARY ?? null,",
            "home: process.env.HOME ?? null,",
            "codexHome: process.env.CODEX_HOME ?? null,",
            "userProfile: process.env.USERPROFILE ?? null,",
            "provider: process.env.OPENAI_API_KEY ?? null,",
            "cloud: process.env.AWS_ACCESS_KEY_ID ?? null,",
            "cloudFile: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,",
            "forge: process.env.GITHUB_TOKEN ?? null,",
            "ssh: process.env.SSH_AUTH_SOCK ?? null,",
            "injection: process.env.NODE_OPTIONS ?? null",
            "}) + '\\n', () => process.exit(0))",
            "})",
          ].join("\n");
          await frames.send({
            id: 8,
            method: "process/start",
            params: {
              processId: "node-proof",
              argv: [process.execPath, "-e", script],
              cwd: workspaceUri,
              env: { NODE_EXEC_ORDINARY: "visible" },
              envPolicy: {
                inherit: "all",
                ignoreDefaultExcludes: true,
                exclude: [],
                set: {},
                includeOnly: [],
              },
              tty: false,
              pipeStdin: true,
              arg0: null,
            },
          });
          expect(await readNodeResponse(frames, 8)).toMatchObject({ processId: "node-proof" });
          await frames.send({
            id: 9,
            method: "process/write",
            params: {
              processId: "node-proof",
              chunk: Buffer.from("node carrier\n").toString("base64"),
              writeId: "node-proof-write",
            },
          });
          await readNodeResponse(frames, 9);
          const notifications = await readNodeProcessNotifications(frames, "node-proof", 3);
          expect(notifications.map((message) => message.method)).toEqual([
            "process/output",
            "process/exited",
            "process/closed",
          ]);
          const output = notifications[0]?.params as { chunk: string; seq: number };
          const observed = JSON.parse(Buffer.from(output.chunk, "base64").toString("utf8")) as {
            input: string;
            ordinary: string;
            home: string;
            codexHome: string;
            userProfile: string | null;
            provider: string | null;
            cloud: string | null;
            cloudFile: string | null;
            forge: string | null;
            ssh: string | null;
            injection: string | null;
          };
          expect(observed).toMatchObject({
            input: "node carrier",
            ordinary: "visible",
            provider: null,
            cloud: null,
            cloudFile: null,
            forge: null,
            ssh: null,
            injection: null,
          });
          expect(observed.codexHome).toBe(path.join(observed.home, ".codex"));
          expect(observed.home).not.toBe(process.env.HOME);
          if (process.platform === "win32") {
            expect(observed.userProfile).toBe(observed.home);
          }
          isolatedHome = observed.home;

          // A response spanning many pipe chunks must arrive as one intact frame.
          const chunkedUri = pathToFileURL(path.join(cwd, "chunked.txt")).href;
          const chunkedDataBase64 = Buffer.alloc(256 * 1024, 0x61).toString("base64");
          await frames.send({
            id: 10,
            method: "fs/writeFile",
            params: { path: chunkedUri, dataBase64: chunkedDataBase64, sandbox: null },
          });
          expect(await readNodeResponse(frames, 10)).toEqual({});
          await frames.send({
            id: 11,
            method: "fs/readFile",
            params: { path: chunkedUri, sandbox: null },
          });
          expect(await readNodeResponse(frames, 11)).toEqual({ dataBase64: chunkedDataBase64 });

          await frames.send({ id: 12, method: "environment/status", params: {} });
          expect(await readNodeResponse(frames, 12)).toEqual({ status: "ready" });
          await frames.send({
            id: 13,
            method: "fs/walk",
            params: {
              path: workspaceUri,
              options: {
                maxDepth: 2,
                maxDirectories: 10,
                maxEntries: 30,
                followDirectorySymlinks: false,
                pruneHiddenDirectories: false,
              },
              sandbox: null,
            },
          });
          expect(await readNodeResponse(frames, 13)).toMatchObject({
            entries: expect.arrayContaining([
              expect.objectContaining({ path: probeUri, kind: "file" }),
              expect.objectContaining({ path: chunkedUri, kind: "file" }),
            ]),
            errors: [],
            truncated: false,
          });
          await frames.send({
            id: 14,
            method: "capabilityRoots/discoverV1",
            params: { roots: [{ id: "workspace", path: workspaceUri, sandbox: null }] },
          });
          expect(await readNodeResponse(frames, 14)).toMatchObject({
            roots: [expect.objectContaining({ id: "workspace", path: workspaceUri })],
          });

          for (const control of [
            { id: 15, processId: "node-signal", method: "process/signal", result: {} },
            {
              id: 17,
              processId: "node-terminate",
              method: "process/terminate",
              result: { running: true },
            },
          ]) {
            await frames.send({
              id: control.id,
              method: "process/start",
              params: {
                processId: control.processId,
                argv: [process.execPath, "-e", "setInterval(() => {}, 60_000)"],
                cwd: workspaceUri,
                env: {},
                tty: false,
                pipeStdin: false,
                arg0: null,
              },
            });
            expect(await readNodeResponse(frames, control.id)).toMatchObject({
              processId: control.processId,
            });
            await frames.send({
              id: control.id + 1,
              method: control.method,
              params: {
                processId: control.processId,
                ...(control.method === "process/signal" ? { signal: "interrupt" } : {}),
              },
            });
            expect(await readNodeResponse(frames, control.id + 1)).toEqual(control.result);
            const controlNotifications = await readNodeProcessNotifications(
              frames,
              control.processId,
              2,
            );
            expect(controlNotifications.map((message) => message.method)).toEqual([
              "process/exited",
              "process/closed",
            ]);
          }

          const httpServer = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/plain" });
            response.write("alpha");
            setImmediate(() => response.end("beta"));
          });
          httpServer.listen(0, "127.0.0.1");
          try {
            await once(httpServer, "listening");
            const address = httpServer.address();
            if (!address || typeof address === "string") {
              throw new Error("Codex exec-server HTTP fixture did not bind a TCP port.");
            }
            await frames.send({
              id: 19,
              method: "http/request",
              params: {
                method: "GET",
                url: `http://127.0.0.1:${address.port}/`,
                headers: [],
                bodyBase64: null,
                timeoutMs: 3_000,
                redirectPolicy: "follow",
                requestId: "node-http-proof",
                streamResponse: true,
              },
            });
            expect(await readNodeResponse(frames, 19)).toMatchObject({
              status: 200,
              bodyBase64: "",
            });
            await vi.waitFor(() =>
              expect(
                frames.outbound.some(
                  (message) =>
                    message.method === "http/request/bodyDelta" &&
                    (message.params as { requestId?: string; done?: boolean }).requestId ===
                      "node-http-proof" &&
                    (message.params as { done?: boolean }).done === true,
                ),
              ).toBe(true),
            );
            const chunks = frames.outbound
              .filter(
                (message) =>
                  message.method === "http/request/bodyDelta" &&
                  (message.params as { requestId?: string }).requestId === "node-http-proof",
              )
              .map(
                (message) => message.params as { seq: number; deltaBase64: string; done: boolean },
              );
            expect(chunks.map((chunk) => chunk.seq)).toEqual(
              chunks.map((_chunk, index) => index + 1),
            );
            expect(
              Buffer.concat(
                chunks.map((chunk) => Buffer.from(chunk.deltaBase64, "base64")),
              ).toString("utf8"),
            ).toBe("alphabeta");
            expect(chunks.at(-1)?.done).toBe(true);
          } finally {
            await new Promise<void>((resolve, reject) => {
              httpServer.close((error) => (error ? reject(error) : resolve()));
            });
          }

          const policyScript = [
            "const net = require('node:net')",
            "const proxy = new URL(process.env.HTTP_PROXY)",
            "const socket = net.connect(Number(proxy.port), proxy.hostname, () => {",
            "socket.write('CONNECT 8.8.8.8:443 HTTP/1.1\\r\\nHost: 8.8.8.8:443\\r\\n\\r\\n')",
            "})",
            "socket.once('data', chunk => {",
            "const line = chunk.toString().split('\\r\\n')[0]",
            "process.stdout.write(line + '\\n', () => { socket.end(); process.exit(0) })",
            "})",
          ].join("\n");
          await frames.send({
            id: 20,
            method: "process/start",
            params: {
              processId: "node-policy",
              argv: [process.execPath, "-e", policyScript],
              cwd: workspaceUri,
              env: {},
              tty: false,
              pipeStdin: false,
              arg0: null,
              networkProxy: {
                proxy: {
                  enabled: true,
                  enableSocks5: false,
                  enableSocks5Udp: false,
                  allowUpstreamProxy: false,
                  dangerouslyAllowAllUnixSockets: false,
                  mode: "full",
                  domains: null,
                  unixSockets: null,
                  allowLocalBinding: false,
                },
                environmentId: "node-policy-environment",
                executionId: "node-policy-execution",
                policyDecisionTimeoutMs: 3_000,
              },
            },
          });
          expect(await readNodeResponse(frames, 20)).toMatchObject({ processId: "node-policy" });
          await vi.waitFor(() =>
            expect(
              frames.outbound.some((message) => message.method === "network/policyRequest"),
            ).toBe(true),
          );
          const policyRequest = frames.outbound.find(
            (message) => message.method === "network/policyRequest",
          );
          expect(policyRequest).toMatchObject({
            id: expect.any(Number),
            params: {
              processId: "node-policy",
              request: { protocol: "https_connect", host: "8.8.8.8", port: 443 },
            },
          });
          await frames.send({
            id: policyRequest?.id,
            result: { decision: { type: "deny", reason: "node-policy-proof" } },
          });
          await vi.waitFor(() =>
            expect(
              frames.outbound.some(
                (message) =>
                  message.method === "process/closed" &&
                  (message.params as { processId?: string }).processId === "node-policy",
              ),
            ).toBe(true),
          );
          expect(frames.outbound).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ method: "network/policyDecision" }),
              expect.objectContaining({
                method: "process/output",
                params: expect.objectContaining({
                  processId: "node-policy",
                  chunk: Buffer.from("HTTP/1.1 403 Forbidden\n").toString("base64"),
                }),
              }),
            ]),
          );
        } finally {
          frames.controller.abort(new Error("paired-device attempt completed"));
          await expect(invocation).rejects.toThrow("paired-device attempt completed");
          await command.onDisconnect?.();
          expect(workspace.release).toHaveBeenCalledOnce();
        }

        expect(isolatedHome).toEqual(expect.any(String));
        await expect(access(isolatedHome!)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});
