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
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch, type BrowserTestFetch } from "./test-support/fetch.js";

const state = getBrowserControlServerTestState();
const pwMocks = getPwMocks();
const realFetch: BrowserTestFetch = (input, init) => getBrowserTestFetch()(input, init);

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
      expect(pwMocks.selectOptionViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: expect.any(String),
          targetId: "abcd1234",
          ref: "5",
          values: ["a", "b"],
        }),
      );

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
        expect(pwMocks.fillFormViaPlaywright).toHaveBeenCalledWith(
          expect.objectContaining({
            cdpUrl: expect.any(String),
            targetId: "abcd1234",
            fields: [expected],
          }),
        );
      }

      const resize = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "resize",
        width: 800,
        height: 600,
      });
      expect(resize.ok).toBe(true);
      expect(pwMocks.resizeViewportViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: expect.any(String),
          targetId: "abcd1234",
          width: 800,
          height: 600,
        }),
      );

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
      expect(pwMocks.waitForViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: state.cdpBaseUrl,
          targetId: "abcd1234",
          timeMs: 5,
        }),
      );

      const evalRes = await postJson<{ ok: boolean; result?: string }>(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      });
      expect(evalRes.ok).toBe(true);
      expect(evalRes.result).toBe("ok");
      expect(pwMocks.evaluateViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: state.cdpBaseUrl,
          targetId: "abcd1234",
          fn: "() => 1",
          ref: undefined,
          signal: expect.any(AbortSignal),
        }),
      );
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
      expect(pwMocks.batchViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: expect.any(String),
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
        }),
      );
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
      expect(pwMocks.batchViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
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
        }),
      );
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
    expect(upload).toMatchObject({ ok: true });
    expect(pwMocks.armFileUploadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: expect.any(String),
        targetId: "abcd1234",
        // The server resolves paths (which adds a drive letter on Windows for `\\tmp\\...` style roots).
        paths: [path.resolve(DEFAULT_UPLOAD_DIR, "a.txt")],
        timeoutMs: 1234,
      }),
    );

    const uploadWithRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["b.txt"],
      ref: "e12",
    });
    expect(uploadWithRef).toMatchObject({ ok: true });

    const uploadWithInputRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["c.txt"],
      inputRef: "e99",
    });
    expect(uploadWithInputRef).toMatchObject({ ok: true });

    const uploadWithElement = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["d.txt"],
      element: "input[type=file]",
    });
    expect(uploadWithElement).toMatchObject({ ok: true });

    const dialog = await postJson(`${base}/hooks/dialog`, {
      accept: true,
      timeoutMs: 5678,
    });
    expect(dialog).toMatchObject({ ok: true });

    const waitDownload = await postJson(`${base}/wait/download`, {
      path: "report.pdf",
      timeoutMs: 1111,
    });
    expect(waitDownload).toMatchObject({ ok: true });

    const download = await postJson(`${base}/download`, {
      ref: "e12",
      path: "report.pdf",
    });
    expect(download).toMatchObject({ ok: true });

    const responseBody = await postJson(`${base}/response/body`, {
      url: "**/api/data",
      timeoutMs: 2222,
      maxChars: 10,
    });
    expect(responseBody).toMatchObject({ ok: true });

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
    expect(pwMocks.takeScreenshotViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        element: "body",
        type: "jpeg",
        timeoutMs: 3333,
      }),
    );
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
    expect(pwMocks.traceStopViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: expect.any(String),
        targetId: "abcd1234",
        path: expect.stringContaining("safe-trace.zip"),
      }),
    );
  });

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
    expect(pwMocks.waitForDownloadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: expect.any(String),
        targetId: "abcd1234",
        path: expect.stringContaining("safe-wait.pdf"),
      }),
    );
  });

  it("download accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; download?: { path?: string } }>(`${base}/download`, {
      ref: "e12",
      path: "safe-download.pdf",
    });
    expect(res.ok).toBe(true);
    expect(pwMocks.downloadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: expect.any(String),
        targetId: "abcd1234",
        ref: "e12",
        path: expect.stringContaining("safe-download.pdf"),
      }),
    );
  });
});
