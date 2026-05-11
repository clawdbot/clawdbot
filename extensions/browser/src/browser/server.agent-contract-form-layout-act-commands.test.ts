import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOWNLOAD_DIR, DEFAULT_TRACE_DIR, DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  getBrowserControlServerTestState,
  getPwMocks,
  setBrowserControlServerSsrFPolicy,
  setBrowserControlServerTabUrl,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch, type BrowserTestFetch } from "./test-support/fetch.js";

const state = getBrowserControlServerTestState();
const pwMocks = getPwMocks();
const realFetch: BrowserTestFetch = (input, init) => getBrowserTestFetch()(input, init);

type GuardedCurrentTabRouteCase = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  mockName:
    | "cookiesGetViaPlaywright"
    | "pdfViaPlaywright"
    | "getConsoleMessagesViaPlaywright"
    | "getPageErrorsViaPlaywright"
    | "getNetworkRequestsViaPlaywright"
    | "responseBodyViaPlaywright"
    | "storageGetViaPlaywright"
    | "takeScreenshotViaPlaywright"
    | "traceStartViaPlaywright"
    | "traceStopViaPlaywright";
};

const guardedCurrentTabRouteCases: readonly GuardedCurrentTabRouteCase[] = [
  {
    method: "GET",
    path: "/console?targetId=abcd1234",
    mockName: "getConsoleMessagesViaPlaywright",
  },
  {
    method: "GET",
    path: "/errors?targetId=abcd1234",
    mockName: "getPageErrorsViaPlaywright",
  },
  {
    method: "GET",
    path: "/requests?targetId=abcd1234",
    mockName: "getNetworkRequestsViaPlaywright",
  },
  {
    method: "POST",
    path: "/pdf",
    body: { targetId: "abcd1234" },
    mockName: "pdfViaPlaywright",
  },
  {
    method: "POST",
    path: "/screenshot",
    body: { targetId: "abcd1234" },
    mockName: "takeScreenshotViaPlaywright",
  },
  {
    method: "POST",
    path: "/response/body",
    body: { targetId: "abcd1234", url: "**/api/data" },
    mockName: "responseBodyViaPlaywright",
  },
  {
    method: "GET",
    path: "/cookies?targetId=abcd1234",
    mockName: "cookiesGetViaPlaywright",
  },
  {
    method: "GET",
    path: "/storage/local?targetId=abcd1234",
    mockName: "storageGetViaPlaywright",
  },
  {
    method: "POST",
    path: "/trace/start",
    body: { targetId: "abcd1234" },
    mockName: "traceStartViaPlaywright",
  },
  {
    method: "POST",
    path: "/trace/stop",
    body: { targetId: "abcd1234" },
    mockName: "traceStopViaPlaywright",
  },
] as const;

async function withSymlinkPathEscape<T>(params: {
  rootDir: string;
  run: (relativePath: string) => Promise<T>;
}): Promise<T> {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-route-escape-"));
  const linkName = `escape-link-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const linkPath = path.join(params.rootDir, linkName);
  await fs.mkdir(params.rootDir, { recursive: true });
  await fs.symlink(outsideDir, linkPath);
  try {
    return await params.run(`${linkName}/pwned.zip`);
  } finally {
    await fs.unlink(linkPath).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  }
}

type MockWithCalls = { mock: { calls: unknown[][] } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireMockArg(mock: MockWithCalls, callIndex = 0, argIndex = 0) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], "mock call argument");
}

function expectBrowserCallFields(
  mock: MockWithCalls,
  expected: Record<string, unknown>,
  callIndex = 0,
) {
  const arg = requireMockArg(mock, callIndex);
  expect(typeof arg.cdpUrl).toBe("string");
  expectRecordFields(arg, "browser call argument", expected);
}

function expectOkResult(result: unknown) {
  expect(requireRecord(result, "response").ok).toBe(true);
}

describe("browser control server", () => {
  installAgentContractHooks();

  const slowTimeoutMs = process.platform === "win32" ? 40_000 : 20_000;

  it(
    "agent contract: form + layout act commands",
    async () => {
      const base = await startServerAndBase();

      const select = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "select",
        ref: "5",
        values: ["a", "b"],
      });
      expect(select.ok).toBe(true);
      expectBrowserCallFields(pwMocks.selectOptionViaPlaywright, {
        targetId: "abcd1234",
        ref: "5",
        values: ["a", "b"],
      });

      const fillCases: Array<{
        input: Record<string, unknown>;
        expected: Record<string, unknown>;
      }> = [
        {
          input: { ref: "6", type: "textbox", value: "hello" },
          expected: { ref: "6", type: "textbox", value: "hello" },
        },
        {
          input: { ref: "7", value: "world" },
          expected: { ref: "7", type: "text", value: "world" },
        },
        {
          input: { ref: "8", type: "   ", value: "trimmed-default" },
          expected: { ref: "8", type: "text", value: "trimmed-default" },
        },
      ];
      for (const { input, expected } of fillCases) {
        const fill = await postJson<{ ok: boolean }>(`${base}/act`, {
          kind: "fill",
          fields: [input],
        });
        expect(fill.ok).toBe(true);
        expectBrowserCallFields(
          pwMocks.fillFormViaPlaywright,
          {
            targetId: "abcd1234",
            fields: [expected],
          },
          pwMocks.fillFormViaPlaywright.mock.calls.length - 1,
        );
      }

      const resize = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "resize",
        width: 800,
        height: 600,
      });
      expect(resize.ok).toBe(true);
      expectBrowserCallFields(pwMocks.resizeViewportViaPlaywright, {
        targetId: "abcd1234",
        width: 800,
        height: 600,
      });

      const resizeZero = await postJson<{ error?: string; code?: string }>(`${base}/act`, {
        kind: "resize",
        width: 0,
        height: 600,
      });
      expect(resizeZero.code).toBe("ACT_INVALID_REQUEST");
      expect(resizeZero.error).toContain("resize requires positive width and height");
      expect(pwMocks.resizeViewportViaPlaywright).toHaveBeenCalledTimes(1);

      const resizeNegative = await postJson<{ error?: string; code?: string }>(`${base}/act`, {
        kind: "resize",
        width: -800,
        height: 600,
      });
      expect(resizeNegative.code).toBe("ACT_INVALID_REQUEST");
      expect(resizeNegative.error).toContain("resize requires positive width and height");
      expect(pwMocks.resizeViewportViaPlaywright).toHaveBeenCalledTimes(1);

      const wait = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "wait",
        timeMs: 5,
      });
      expect(wait.ok).toBe(true);
      expectBrowserCallFields(pwMocks.waitForViaPlaywright, {
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        timeMs: 5,
      });

      const evalRes = await postJson<{ ok: boolean; result?: string }>(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      });
      expect(evalRes.ok).toBe(true);
      expect(evalRes.result).toBe("ok");
      const evalCall = requireMockArg(pwMocks.evaluateViaPlaywright);
      expectRecordFields(evalCall, "evaluate call", {
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        fn: "() => 1",
        ref: undefined,
      });
      expect(evalCall.signal).toBeInstanceOf(AbortSignal);
    },
    slowTimeoutMs,
  );

  it(
    "normalizes batch actions and threads evaluateEnabled into the batch executor",
    async () => {
      const base = await startServerAndBase();

      const batchRes = await postJson<{ ok: boolean; results?: Array<{ ok: boolean }> }>(
        `${base}/act`,
        {
          kind: "batch",
          stopOnError: "false",
          actions: [
            { kind: "click", selector: "button.save", doubleClick: "true", delayMs: "25" },
            { kind: "wait", fn: " () => window.ready === true " },
          ],
        },
      );

      expect(batchRes.ok).toBe(true);
      expectBrowserCallFields(pwMocks.batchViaPlaywright, {
        targetId: "abcd1234",
        stopOnError: false,
        evaluateEnabled: true,
        actions: [
          {
            kind: "click",
            selector: "button.save",
            doubleClick: true,
            delayMs: 25,
          },
          {
            kind: "wait",
            fn: "() => window.ready === true",
          },
        ],
      });
    },
    slowTimeoutMs,
  );

  it(
    "preserves exact type text in batch normalization",
    async () => {
      const base = await startServerAndBase();

      const batchRes = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "batch",
        actions: [
          { kind: "type", selector: "input.name", text: "  padded  " },
          { kind: "type", selector: "input.clearable", text: "" },
        ],
      });

      expect(batchRes.ok).toBe(true);
      expectRecordFields(requireMockArg(pwMocks.batchViaPlaywright), "batch call", {
        actions: [
          {
            kind: "type",
            selector: "input.name",
            text: "  padded  ",
          },
          {
            kind: "type",
            selector: "input.clearable",
            text: "",
          },
        ],
      });
    },
    slowTimeoutMs,
  );

  it(
    "rejects malformed batch actions before dispatch",
    async () => {
      const base = await startServerAndBase();

      const batchRes = await postJson<{ error?: string; code?: string }>(`${base}/act`, {
        kind: "batch",
        actions: [{ kind: "click", ref: {} }],
      });

      expect(batchRes.error).toContain("click requires ref or selector");
      expect(batchRes.code).toBe("ACT_INVALID_REQUEST");
      expect(pwMocks.batchViaPlaywright).not.toHaveBeenCalled();
    },
    slowTimeoutMs,
  );

  it(
    "rejects batched action targetId overrides before dispatch",
    async () => {
      const base = await startServerAndBase();

      const batchRes = await postJson<{ error?: string; code?: string }>(`${base}/act`, {
        kind: "batch",
        actions: [{ kind: "click", ref: "5", targetId: "other-tab" }],
      });

      expect(batchRes.error).toContain("batched action targetId must match request targetId");
      expect(batchRes.code).toBe("ACT_TARGET_ID_MISMATCH");
      expect(pwMocks.batchViaPlaywright).not.toHaveBeenCalled();
    },
    slowTimeoutMs,
  );

  it(
    "rejects oversized batch delays before dispatch",
    async () => {
      const base = await startServerAndBase();

      const batchRes = await postJson<{ error?: string }>(`${base}/act`, {
        kind: "batch",
        actions: [{ kind: "click", selector: "button.save", delayMs: 5001 }],
      });

      expect(batchRes.error).toContain("click delayMs exceeds maximum of 5000ms");
      expect(pwMocks.batchViaPlaywright).not.toHaveBeenCalled();
    },
    slowTimeoutMs,
  );

  it(
    "rejects oversized top-level batches before dispatch",
    async () => {
      const base = await startServerAndBase();

      const batchRes = await postJson<{ error?: string }>(`${base}/act`, {
        kind: "batch",
        actions: Array.from({ length: 101 }, () => ({ kind: "press", key: "Enter" })),
      });

      expect(batchRes.error).toContain("batch exceeds maximum of 100 actions");
      expect(pwMocks.batchViaPlaywright).not.toHaveBeenCalled();
    },
    slowTimeoutMs,
  );

  it("agent contract: hooks + response + downloads + screenshot", async () => {
    const base = await startServerAndBase();

    const upload = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["a.txt"],
      timeoutMs: 1234,
    });
    expectOkResult(upload);
    expectBrowserCallFields(pwMocks.armFileUploadViaPlaywright, {
      targetId: "abcd1234",
      // The server resolves paths (which adds a drive letter on Windows for `\\tmp\\...` style roots).
      paths: [path.resolve(DEFAULT_UPLOAD_DIR, "a.txt")],
      timeoutMs: 1234,
    });

    const uploadWithRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["b.txt"],
      ref: "e12",
    });
    expectOkResult(uploadWithRef);

    const uploadWithInputRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["c.txt"],
      inputRef: "e99",
    });
    expectOkResult(uploadWithInputRef);

    const uploadWithElement = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["d.txt"],
      element: "input[type=file]",
    });
    expectOkResult(uploadWithElement);

    const dialog = await postJson(`${base}/hooks/dialog`, {
      accept: true,
      timeoutMs: 5678,
    });
    expectOkResult(dialog);

    const waitDownload = await postJson(`${base}/wait/download`, {
      path: "report.pdf",
      timeoutMs: 1111,
    });
    expectOkResult(waitDownload);

    const download = await postJson(`${base}/download`, {
      ref: "e12",
      path: "report.pdf",
    });
    expectOkResult(download);

    const responseBody = await postJson(`${base}/response/body`, {
      url: "**/api/data",
      timeoutMs: 2222,
      maxChars: 10,
    });
    expectOkResult(responseBody);

    const consoleRes = (await realFetch(`${base}/console?level=error`).then((r) => r.json())) as {
      ok: boolean;
      messages?: unknown[];
    };
    expect(consoleRes.ok).toBe(true);
    expect(Array.isArray(consoleRes.messages)).toBe(true);

    const pdf = await postJson<{ ok: boolean; path?: string }>(`${base}/pdf`, {});
    expect(pdf.ok).toBe(true);
    expect(typeof pdf.path).toBe("string");

    const shot = await postJson<{ ok: boolean; path?: string }>(`${base}/screenshot`, {
      element: "body",
      type: "jpeg",
      timeoutMs: 3333,
    });
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");
    expectRecordFields(requireMockArg(pwMocks.takeScreenshotViaPlaywright), "screenshot call", {
      element: "body",
      type: "jpeg",
      timeoutMs: 3333,
    });
  });

  it("blocks file chooser traversal / absolute paths outside uploads dir", async () => {
    const base = await startServerAndBase();

    const traversal = await postJson<{ error?: string }>(`${base}/hooks/file-chooser`, {
      paths: ["../../../../etc/passwd"],
    });
    expect(traversal.error).toContain("Invalid path");
    expect(pwMocks.armFileUploadViaPlaywright).not.toHaveBeenCalled();

    const absOutside = path.join(path.parse(DEFAULT_UPLOAD_DIR).root, "etc", "passwd");
    const abs = await postJson<{ error?: string }>(`${base}/hooks/file-chooser`, {
      paths: [absOutside],
    });
    expect(abs.error).toContain("Invalid path");
    expect(pwMocks.armFileUploadViaPlaywright).not.toHaveBeenCalled();
  });

  it("agent contract: stop endpoint", async () => {
    const base = await startServerAndBase();

    const stopped = (await realFetch(`${base}/stop`, {
      method: "POST",
    }).then((r) => r.json())) as { ok: boolean; stopped?: boolean };
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
  });

  it("trace stop rejects traversal path outside trace dir", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ error?: string }>(`${base}/trace/stop`, {
      path: "../../pwned.zip",
    });
    expect(res.error).toContain("Invalid path");
    expect(pwMocks.traceStopViaPlaywright).not.toHaveBeenCalled();
  });

  it("trace stop accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; path?: string }>(`${base}/trace/stop`, {
      path: "safe-trace.zip",
    });
    expect(res.ok).toBe(true);
    expect(res.path).toContain("safe-trace.zip");
    const traceCall = requireMockArg(pwMocks.traceStopViaPlaywright);
    expect(typeof traceCall.cdpUrl).toBe("string");
    expectRecordFields(traceCall, "trace stop call", {
      targetId: "abcd1234",
    });
    expect(String(traceCall.path)).toContain("safe-trace.zip");
  });

  it.each(guardedCurrentTabRouteCases)(
    "blocks $method $path on disallowed current tab URLs",
    async (routeCase) => {
      setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
      setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
      const base = await startServerAndBase();

      const res = await realFetch(`${base}${routeCase.path}`, {
        method: routeCase.method,
        headers: routeCase.body ? { "Content-Type": "application/json" } : undefined,
        body: routeCase.body ? JSON.stringify(routeCase.body) : undefined,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toEqual(expect.stringMatching(/(blocked|denied|not allowed|policy)/i));
      expect(pwMocks[routeCase.mockName]).not.toHaveBeenCalled();
    },
  );

  it("wait/download rejects traversal path outside downloads dir", async () => {
    const base = await startServerAndBase();
    const waitRes = await postJson<{ error?: string }>(`${base}/wait/download`, {
      path: "../../pwned.pdf",
    });
    expect(waitRes.error).toContain("Invalid path");
    expect(pwMocks.waitForDownloadViaPlaywright).not.toHaveBeenCalled();
  });

  it("download rejects traversal path outside downloads dir", async () => {
    const base = await startServerAndBase();
    const downloadRes = await postJson<{ error?: string }>(`${base}/download`, {
      ref: "e12",
      path: "../../pwned.pdf",
    });
    expect(downloadRes.error).toContain("Invalid path");
    expect(pwMocks.downloadViaPlaywright).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "trace stop rejects symlinked write path escape under trace dir",
    async () => {
      const base = await startServerAndBase();
      await withSymlinkPathEscape({
        rootDir: DEFAULT_TRACE_DIR,
        run: async (pathEscape) => {
          const res = await postJson<{ error?: string }>(`${base}/trace/stop`, {
            path: pathEscape,
          });
          expect(res.error).toContain("Invalid path");
          expect(pwMocks.traceStopViaPlaywright).not.toHaveBeenCalled();
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "wait/download rejects symlinked write path escape under downloads dir",
    async () => {
      const base = await startServerAndBase();
      await withSymlinkPathEscape({
        rootDir: DEFAULT_DOWNLOAD_DIR,
        run: async (pathEscape) => {
          const res = await postJson<{ error?: string }>(`${base}/wait/download`, {
            path: pathEscape,
          });
          expect(res.error).toContain("Invalid path");
          expect(pwMocks.waitForDownloadViaPlaywright).not.toHaveBeenCalled();
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "download rejects symlinked write path escape under downloads dir",
    async () => {
      const base = await startServerAndBase();
      await withSymlinkPathEscape({
        rootDir: DEFAULT_DOWNLOAD_DIR,
        run: async (pathEscape) => {
          const res = await postJson<{ error?: string }>(`${base}/download`, {
            ref: "e12",
            path: pathEscape,
          });
          expect(res.error).toContain("Invalid path");
          expect(pwMocks.downloadViaPlaywright).not.toHaveBeenCalled();
        },
      });
    },
  );

  it("wait/download accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; download?: { path?: string } }>(
      `${base}/wait/download`,
      {
        path: "safe-wait.pdf",
      },
    );
    expect(res.ok).toBe(true);
    const waitCall = requireMockArg(pwMocks.waitForDownloadViaPlaywright);
    expect(typeof waitCall.cdpUrl).toBe("string");
    expectRecordFields(waitCall, "wait download call", {
      targetId: "abcd1234",
    });
    expect(String(waitCall.path)).toContain("safe-wait.pdf");
  });

  it("download accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; download?: { path?: string } }>(`${base}/download`, {
      ref: "e12",
      path: "safe-download.pdf",
    });
    expect(res.ok).toBe(true);
    const downloadCall = requireMockArg(pwMocks.downloadViaPlaywright);
    expect(typeof downloadCall.cdpUrl).toBe("string");
    expectRecordFields(downloadCall, "download call", {
      targetId: "abcd1234",
      ref: "e12",
    });
    expect(String(downloadCall.path)).toContain("safe-download.pdf");
  });
});
