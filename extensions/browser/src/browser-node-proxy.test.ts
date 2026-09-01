// Browser tests cover independently bounded delegated node-proxy requests.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

type BrowserNodeRequest = {
  nodeId: string;
  command: string;
  timeoutMs: number;
  idempotencyKey: string;
  params: {
    method: string;
    path: string;
    timeoutMs: number;
    profile?: string;
    errorEnvelope: string;
    body?: unknown;
    upload?: unknown;
  };
};

type BrowserNodeResponse = {
  payload: { result: { ok: true; profile?: string } };
};

type BrowserGatewayCall = (
  method: string,
  options: { timeoutMs: number },
  request: BrowserNodeRequest,
  extra: { scopes: string[]; signal?: AbortSignal },
) => Promise<BrowserNodeResponse>;

const runtimeMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn<BrowserGatewayCall>(),
  persistBrowserProxyResultFiles: vi.fn<(result: unknown, files?: unknown) => Promise<unknown>>(),
  fetchBrowserJson: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

const uploadMocks = vi.hoisted(() => ({
  isBrowserProxyUploadRequest: vi.fn(
    (params: { method: string; path: string; body: unknown }) =>
      params.method === "POST" &&
      params.path === "/hooks/file-chooser" &&
      Array.isArray((params.body as { paths?: unknown } | undefined)?.paths) &&
      ((params.body as { paths: unknown[] }).paths.length ?? 0) > 0,
  ),
  prepareBrowserProxyUploadRequest: vi.fn(),
}));

vi.mock("./browser-tool.runtime.js", () => runtimeMocks);
vi.mock("./browser-proxy-upload.js", () => uploadMocks);

import { createBrowserNodeProxyRequest } from "./browser-node-proxy.js";
import { BrowserServiceError } from "./browser/client-fetch.js";

function createSessionProxy() {
  return createBrowserNodeProxyRequest({
    nodeTarget: {
      nodeId: "node-1",
      commands: ["browser.proxy", "browser.proxy.upload.v1"],
    },
    allowAutomaticHostFallback: false,
  });
}

function readGatewayCall(index = 0) {
  const call = runtimeMocks.callGatewayTool.mock.calls[index];
  if (!call) {
    throw new Error(`Expected Browser node invocation ${index}`);
  }
  const [method, gateway, node, extra] = call;
  return { method, gateway, node, extra };
}

beforeEach(() => {
  runtimeMocks.callGatewayTool.mockReset();
  runtimeMocks.callGatewayTool.mockResolvedValue({ payload: { result: { ok: true } } });
  runtimeMocks.persistBrowserProxyResultFiles
    .mockReset()
    .mockImplementation(async (result) => result);
  runtimeMocks.fetchBrowserJson.mockReset();
  uploadMocks.isBrowserProxyUploadRequest.mockClear();
  uploadMocks.prepareBrowserProxyUploadRequest
    .mockReset()
    .mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
});

describe("Browser node proxy nested watchdogs", () => {
  it.each([
    {
      code: "ACT_EVALUATE_DISABLED",
      expected: { code: "ACT_EVALUATE_DISABLED", unrecognizedCode: undefined },
    },
    {
      code: "ACT_FUTURE_CODE",
      expected: { code: undefined, unrecognizedCode: true },
    },
  ])("preserves the bounded action-code state for $code", async ({ code, expected }) => {
    runtimeMocks.callGatewayTool.mockResolvedValueOnce({
      payload: {
        error: {
          status: 403,
          body: { error: "evaluation disabled", code },
        },
      },
    } as unknown as BrowserNodeResponse);

    const error = await createSessionProxy()({ method: "POST", path: "/act" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BrowserServiceError);
    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "evaluation disabled",
      status: 403,
      ...expected,
    });
  });

  it("keeps a requested action inside separate node and Gateway watchdogs", async () => {
    const signal = new AbortController().signal;

    await createSessionProxy()({
      method: "GET",
      path: "/snapshot",
      profile: "work",
      timeoutMs: 7_777,
      signal,
    });

    const { method, gateway, node, extra } = readGatewayCall();
    expect(method).toBe("node.invoke");
    expect(node.nodeId).toBe("node-1");
    expect(node.command).toBe("browser.proxy");
    expect([node.params.timeoutMs, node.timeoutMs, gateway.timeoutMs]).toEqual([
      7_777, 12_777, 17_777,
    ]);
    expect(node.params.errorEnvelope).toBe("browser-v1");
    expect(extra).toEqual({ scopes: ["operator.admin"], signal });
    expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
  });

  it("binds the tool execution signal to node requests without their own signal", async () => {
    const signal = new AbortController().signal;
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1" },
      allowAutomaticHostFallback: false,
      signal,
    });

    await proxy({ method: "GET", path: "/snapshot" });

    expect(readGatewayCall().extra).toEqual({ scopes: ["operator.admin"], signal });
  });

  it("keeps an explicit request signal ahead of the bound tool execution signal", async () => {
    const toolSignal = new AbortController().signal;
    const requestSignal = new AbortController().signal;
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1" },
      allowAutomaticHostFallback: false,
      signal: toolSignal,
    });

    await proxy({ method: "GET", path: "/snapshot", signal: requestSignal });

    expect(readGatewayCall().extra).toEqual({
      scopes: ["operator.admin"],
      signal: requestSignal,
    });
  });

  it("keeps the bound tool execution signal when a node falls back to the host", async () => {
    const signal = new AbortController().signal;
    runtimeMocks.callGatewayTool.mockRejectedValueOnce(
      new Error("Browser control host is not reachable on 127.0.0.1:18791."),
    );
    runtimeMocks.fetchBrowserJson.mockResolvedValueOnce({ ok: true, source: "gateway-host" });
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1" },
      allowAutomaticHostFallback: true,
      signal,
    });

    await expect(proxy({ method: "GET", path: "/snapshot" })).resolves.toMatchObject({
      ok: true,
      source: "gateway-host",
    });

    expect(runtimeMocks.fetchBrowserJson).toHaveBeenCalledWith(
      "/snapshot",
      expect.objectContaining({ method: "GET", signal }),
    );
  });

  it.each(["unreachable", "upload-unsupported"] as const)(
    "does not switch browsers after a node action when the next request is %s",
    async (failure) => {
      const proxy = createBrowserNodeProxyRequest({
        nodeTarget: { nodeId: "node-1", commands: ["browser.proxy"] },
        allowAutomaticHostFallback: true,
      });
      await proxy({ method: "POST", path: "/navigate", profile: "work" });
      runtimeMocks.fetchBrowserJson.mockResolvedValue({ ok: true, profile: "wrong-host" });
      if (failure === "unreachable") {
        runtimeMocks.callGatewayTool.mockRejectedValueOnce(
          new Error("Browser control host is not reachable on 127.0.0.1:18791."),
        );
      }
      const request =
        failure === "unreachable"
          ? { method: "GET", path: "/snapshot", profile: "work" }
          : {
              method: "POST",
              path: "/hooks/file-chooser",
              profile: "work",
              body: { paths: ["/tmp/openclaw/uploads/report.txt"] },
            };

      await expect(proxy(request)).rejects.toThrow(
        failure === "unreachable"
          ? "Browser control host is not reachable"
          : "browser node does not support remote upload transfer",
      );
      expect(proxy.isHostFallbackActive()).toBe(false);
      expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
    },
  );

  it("names the selected node and host-status recovery for an invalid proxy envelope", async () => {
    runtimeMocks.callGatewayTool.mockResolvedValueOnce({
      payload: {},
    } as unknown as BrowserNodeResponse);
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1", label: "Studio Node" },
      allowAutomaticHostFallback: false,
    });

    await expect(proxy({ method: "GET", path: "/snapshot" })).rejects.toThrow(
      /Studio Node.*action=status.*target="host"/i,
    );
  });

  it("rejects node file transfer failures without activating host fallback", async () => {
    const transferError = new Error("browser proxy returned an invalid file envelope");
    runtimeMocks.callGatewayTool.mockResolvedValueOnce({
      payload: {
        result: { path: "/node/browser/screenshot.png" },
        files: [],
      },
    } as unknown as BrowserNodeResponse);
    runtimeMocks.persistBrowserProxyResultFiles.mockRejectedValueOnce(transferError);
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1", commands: ["browser.proxy"] },
      allowAutomaticHostFallback: true,
    });

    await expect(proxy({ method: "POST", path: "/screenshot" })).rejects.toBe(transferError);

    expect(runtimeMocks.callGatewayTool).toHaveBeenCalledOnce();
    expect(runtimeMocks.persistBrowserProxyResultFiles).toHaveBeenCalledWith(
      { path: "/node/browser/screenshot.png" },
      [],
    );
    expect(proxy.isHostFallbackActive()).toBe(false);
    expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
  });

  it("sends Gateway-owned upload bytes without node-facing source paths", async () => {
    const originalBody = {
      paths: ["/tmp/openclaw/uploads/report.txt"],
      ref: "e12",
    };
    const upload = {
      envelope: "browser-upload-v1",
      files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
    };
    uploadMocks.prepareBrowserProxyUploadRequest.mockResolvedValueOnce({
      body: { ref: "e12" },
      upload,
    });

    await createSessionProxy()({
      method: "POST",
      path: "/hooks/file-chooser",
      body: originalBody,
    });

    expect(readGatewayCall().node.params).toMatchObject({
      body: { ref: "e12" },
      upload,
    });
    expect(readGatewayCall().node.command).toBe("browser.proxy.upload.v1");
    expect(readGatewayCall().node.params.body).not.toHaveProperty("paths");
  });

  it("uses the original Gateway paths when an auto-selected old node lacks upload support", async () => {
    const originalBody = {
      paths: ["/tmp/openclaw/uploads/report.txt"],
      ref: "e12",
    };
    uploadMocks.prepareBrowserProxyUploadRequest.mockResolvedValueOnce({
      body: { ref: "e12" },
      upload: {
        envelope: "browser-upload-v1",
        files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
      },
    });
    runtimeMocks.fetchBrowserJson.mockResolvedValueOnce({ ok: true });
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1", commands: ["browser.proxy"] },
      allowAutomaticHostFallback: true,
    });

    await proxy({
      method: "POST",
      path: "/hooks/file-chooser",
      body: originalBody,
    });

    expect(runtimeMocks.fetchBrowserJson).toHaveBeenCalledWith(
      "/hooks/file-chooser",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(originalBody),
      }),
    );
    expect(runtimeMocks.callGatewayTool).not.toHaveBeenCalled();
    expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("rejects an explicit old node upload before node dispatch", async () => {
    uploadMocks.prepareBrowserProxyUploadRequest.mockResolvedValueOnce({
      body: { ref: "e12" },
      upload: {
        envelope: "browser-upload-v1",
        files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
      },
    });
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: { nodeId: "node-1", commands: ["browser.proxy"] },
      allowAutomaticHostFallback: false,
    });

    await expect(
      proxy({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e12" },
      }),
    ).rejects.toThrow("browser node does not support remote upload transfer");
    expect(runtimeMocks.callGatewayTool).not.toHaveBeenCalled();
    expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("explains when remote upload transfer is awaiting node command approval", async () => {
    const proxy = createBrowserNodeProxyRequest({
      nodeTarget: {
        nodeId: "node-1",
        commands: ["browser.proxy"],
        pendingDeclaredCommands: ["browser.proxy", "browser.proxy.upload.v1"],
      },
      allowAutomaticHostFallback: false,
    });

    await expect(
      proxy({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e12" },
      }),
    ).rejects.toThrow("remote upload transfer is pending approval");
    expect(runtimeMocks.callGatewayTool).not.toHaveBeenCalled();
    expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("keeps default action, node, and Gateway watchdogs strictly nested", async () => {
    await createSessionProxy()({ method: "GET", path: "/snapshot" });

    const { gateway, node } = readGatewayCall();
    expect([node.params.timeoutMs, node.timeoutMs, gateway.timeoutMs]).toEqual([
      20_000, 25_000, 30_000,
    ]);
  });

  it.each([
    Number.MAX_SAFE_INTEGER,
    MAX_TIMER_TIMEOUT_MS,
    MAX_TIMER_TIMEOUT_MS - 1,
    MAX_TIMER_TIMEOUT_MS - 4_999,
    MAX_TIMER_TIMEOUT_MS - 5_000,
    MAX_TIMER_TIMEOUT_MS - 9_999,
    MAX_TIMER_TIMEOUT_MS - 10_000,
    MAX_TIMER_TIMEOUT_MS - 10_001,
  ])("reserves both Node-safe watchdog windows for %i ms", async (timeoutMs) => {
    await createSessionProxy()({ method: "GET", path: "/snapshot", timeoutMs });

    const actionTimeoutMs = Math.min(timeoutMs, MAX_TIMER_TIMEOUT_MS - 10_000);
    const { gateway, node } = readGatewayCall();
    expect([node.params.timeoutMs, node.timeoutMs, gateway.timeoutMs]).toEqual([
      actionTimeoutMs,
      actionTimeoutMs + 5_000,
      actionTimeoutMs + 10_000,
    ]);
    expect(gateway.timeoutMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
  });

  it("finishes ten independently owned, concurrently blocked Browser sessions", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtimeMocks.callGatewayTool.mockImplementation(async (_method, _gateway, node) => {
      await barrier;
      return { payload: { result: { ok: true, profile: node.params.profile } } };
    });

    const sessions = Array.from({ length: 10 }, (_, index) => ({
      profile: `session-${index}`,
      timeoutMs: 7_777 + index,
      signal: new AbortController().signal,
      proxy: createSessionProxy(),
    }));
    const completed = new Set<string>();
    const pending = sessions.map(async ({ profile, timeoutMs, signal, proxy }) => {
      const result = await proxy({ method: "GET", path: "/snapshot", profile, timeoutMs, signal });
      completed.add(profile);
      return result;
    });

    try {
      await vi.waitFor(() => {
        expect(runtimeMocks.callGatewayTool).toHaveBeenCalledTimes(10);
      });
      expect(completed.size).toBe(0);
      expect(runtimeMocks.persistBrowserProxyResultFiles).not.toHaveBeenCalled();
      const invocationIds = new Set<string>();

      sessions.forEach(({ profile, timeoutMs, signal }, index) => {
        const { method, gateway, node, extra } = readGatewayCall(index);
        expect(method).toBe("node.invoke");
        expect(node.nodeId).toBe("node-1");
        expect(node.command).toBe("browser.proxy");
        expect(node.params.profile).toBe(profile);
        expect(node.params.errorEnvelope).toBe("browser-v1");
        expect([node.params.timeoutMs, node.timeoutMs, gateway.timeoutMs]).toEqual([
          timeoutMs,
          timeoutMs + 5_000,
          timeoutMs + 10_000,
        ]);
        expect(extra).toEqual({ scopes: ["operator.admin"], signal });
        invocationIds.add(node.idempotencyKey);
      });

      expect(invocationIds.size).toBe(10);
      expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
    } finally {
      release();
    }

    await expect(Promise.all(pending)).resolves.toEqual(
      sessions.map(({ profile }) => ({ ok: true, profile })),
    );
    expect(completed.size).toBe(10);
    expect(runtimeMocks.persistBrowserProxyResultFiles).toHaveBeenCalledTimes(10);
    expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
    expect(sessions.every(({ proxy }) => !proxy.isHostFallbackActive())).toBe(true);
  });

  it("keeps one session cancellation isolated from nine concurrent sessions", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtimeMocks.callGatewayTool.mockImplementation(
      (_method, _gateway, node, extra) =>
        new Promise<BrowserNodeResponse>((resolve, reject) => {
          const onAbort = () => {
            const reason = extra.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("Browser session cancelled"));
          };
          if (extra.signal?.aborted) {
            onAbort();
            return;
          }
          extra.signal?.addEventListener("abort", onAbort, { once: true });
          void barrier.then(() => {
            extra.signal?.removeEventListener("abort", onAbort);
            if (!extra.signal?.aborted) {
              resolve({ payload: { result: { ok: true, profile: node.params.profile } } });
            }
          });
        }),
    );

    const sessions = Array.from({ length: 10 }, (_, index) => ({
      profile: `session-${index}`,
      timeoutMs: 7_777 + index,
      controller: new AbortController(),
      proxy: createSessionProxy(),
    }));
    const pending = sessions.map(({ profile, timeoutMs, controller, proxy }) =>
      proxy({
        method: "GET",
        path: "/snapshot",
        profile,
        timeoutMs,
        signal: controller.signal,
      }),
    );
    const completion = Promise.allSettled(pending);
    const cancelledSession = sessions.at(3);
    const cancelledRun = pending.at(3);
    if (!cancelledSession || !cancelledRun) {
      release();
      throw new Error("Expected a dedicated cancellation session");
    }
    const abortError = new Error("session-3 cancelled");

    try {
      await vi.waitFor(() => {
        expect(runtimeMocks.callGatewayTool).toHaveBeenCalledTimes(10);
      });
      cancelledSession.controller.abort(abortError);
      await expect(cancelledRun).rejects.toBe(abortError);
      expect(runtimeMocks.persistBrowserProxyResultFiles).not.toHaveBeenCalled();
      expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
    } finally {
      release();
    }

    await expect(completion).resolves.toEqual(
      sessions.map(({ profile }, index) =>
        index === 3
          ? { status: "rejected", reason: abortError }
          : { status: "fulfilled", value: { ok: true, profile } },
      ),
    );
    expect(runtimeMocks.persistBrowserProxyResultFiles).toHaveBeenCalledTimes(9);
    expect(runtimeMocks.fetchBrowserJson).not.toHaveBeenCalled();
    expect(sessions.every(({ proxy }) => !proxy.isHostFallbackActive())).toBe(true);
  });
});
