import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  authorize: vi.fn(
    async (_params: {
      req: IncomingMessage;
      res: ServerResponse;
    }): Promise<{ cfg: Record<string, never>; requestAuth: { ok: true } } | undefined> => ({
      cfg: {},
      requestAuth: { ok: true },
    }),
  ),
  beforeHook: vi.fn(async (args: { params: unknown; signal?: AbortSignal }) => ({
    blocked: false as const,
    params: args.params,
  })),
  handled: vi.fn(),
  execute: vi.fn(async (_toolCallId: string, _args: unknown, _signal?: AbortSignal) => ({
    ok: true,
  })),
}));

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeScopedGatewayHttpRequestOrReply: lifecycle.authorize,
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: () => ({
    agentId: "main",
    tools: [
      {
        name: "abort_probe",
        parameters: { type: "object", properties: {} },
        execute: lifecycle.execute,
      },
    ],
  }),
}));

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: lifecycle.beforeHook,
}));

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let server: ReturnType<typeof createServer> | undefined;
let serverPort = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleToolsInvokeHttpRequest(req, res, {
      auth: { mode: "none", allowTailscale: false },
    })
      .then(() => {
        lifecycle.handled();
      })
      .catch((error: unknown) => {
        if (!res.destroyed && !res.writableEnded) {
          res.statusCode = 500;
          res.end(String(error));
        }
      });
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      serverPort = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  const activeServer = server;
  if (!activeServer) {
    return;
  }
  activeServer.closeAllConnections();
  await new Promise<void>((resolve) => {
    activeServer.close(() => resolve());
  });
  server = undefined;
});

beforeEach(() => {
  lifecycle.authorize.mockReset();
  lifecycle.authorize.mockResolvedValue({ cfg: {}, requestAuth: { ok: true } });
  lifecycle.beforeHook.mockClear();
  lifecycle.handled.mockReset();
  lifecycle.execute.mockReset();
  lifecycle.execute.mockResolvedValue({ ok: true });
});

function invokeAbortProbe(signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${serverPort}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "abort_probe", args: {} }),
    signal,
  });
}

describe("POST /tools/invoke request cancellation", () => {
  it("never attaches a disconnect watcher to an unauthorized request", async () => {
    lifecycle.authorize.mockImplementationOnce(async ({ res }) => {
      res.statusCode = 401;
      res.end("unauthorized");
      return undefined;
    });

    const response = await invokeAbortProbe();

    expect(response.status).toBe(401);
    expect(lifecycle.execute).not.toHaveBeenCalled();
  });

  it("does not start a tool after the client disconnects during authorization", async () => {
    let reportAuthorizationStarted: ((req: IncomingMessage) => void) | undefined;
    let releaseAuthorization: (() => void) | undefined;
    const authorizationStarted = new Promise<IncomingMessage>((resolve) => {
      reportAuthorizationStarted = resolve;
    });
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });

    lifecycle.authorize.mockImplementationOnce(async ({ req }) => {
      reportAuthorizationStarted?.(req);
      await authorizationReleased;
      return { cfg: {}, requestAuth: { ok: true } };
    });

    const requestController = new AbortController();
    const response = invokeAbortProbe(requestController.signal);

    try {
      const serverRequest = await authorizationStarted;
      requestController.abort();
      await expect(response).rejects.toThrow();
      await expect.poll(() => serverRequest.socket.destroyed).toBe(true);

      releaseAuthorization?.();
      await expect.poll(() => lifecycle.handled.mock.calls.length).toBe(1);
      expect(lifecycle.execute).not.toHaveBeenCalled();
    } finally {
      releaseAuthorization?.();
      requestController.abort();
      await response.catch(() => undefined);
    }
  });

  it("revokes the tool signal after a successful request and releases its disconnect watcher", async () => {
    const response = await invokeAbortProbe();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, result: { ok: true } });
    expect(lifecycle.execute).toHaveBeenCalledTimes(1);

    const toolSignal = lifecycle.execute.mock.calls[0]?.[2];
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolSignal?.aborted).toBe(true);
    expect(lifecycle.beforeHook).toHaveBeenCalledWith(
      expect.objectContaining({ signal: toolSignal }),
    );
  });

  it("aborts the running tool when its HTTP client disconnects", async () => {
    let reportStarted: ((signal: AbortSignal | undefined) => void) | undefined;
    let releaseExecution: (() => void) | undefined;
    const executionStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportStarted = resolve;
    });

    lifecycle.execute.mockImplementation(async (_toolCallId, _args, signal) => {
      reportStarted?.(signal);
      await new Promise<void>((resolve) => {
        releaseExecution = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: true };
    });

    const requestController = new AbortController();
    const response = invokeAbortProbe(requestController.signal);

    try {
      const toolSignal = await executionStarted;
      expect(toolSignal).toBeInstanceOf(AbortSignal);

      requestController.abort();
      await expect(response).rejects.toThrow();
      await expect.poll(() => toolSignal?.aborted).toBe(true);
    } finally {
      requestController.abort();
      releaseExecution?.();
      await response.catch(() => undefined);
    }
  });

  it("does not start a tool after the client disconnects during its policy hook", async () => {
    let reportHookStarted: ((signal: AbortSignal | undefined) => void) | undefined;
    let releaseHook: (() => void) | undefined;
    const hookStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportHookStarted = resolve;
    });
    const hookReleased = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });

    lifecycle.beforeHook.mockImplementationOnce(async ({ params, signal }) => {
      reportHookStarted?.(signal);
      await hookReleased;
      return { blocked: false as const, params };
    });

    const requestController = new AbortController();
    const response = invokeAbortProbe(requestController.signal);

    try {
      const hookSignal = await hookStarted;
      expect(hookSignal).toBeInstanceOf(AbortSignal);

      requestController.abort();
      await expect(response).rejects.toThrow();
      await expect.poll(() => hookSignal?.aborted).toBe(true);

      releaseHook?.();
      await expect.poll(() => lifecycle.handled.mock.calls.length).toBe(1);
      expect(lifecycle.execute).not.toHaveBeenCalled();
    } finally {
      releaseHook?.();
      requestController.abort();
      await response.catch(() => undefined);
    }
  });

  it("releases its disconnect watcher when tool execution fails", async () => {
    lifecycle.execute.mockRejectedValueOnce(new Error("probe failed"));

    const response = await invokeAbortProbe();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { type: "tool_error", message: "tool execution failed" },
    });
  });
});
