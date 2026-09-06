// Browser tests cover invoke browser plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  BROWSER_PROXY_MAX_FILE_BYTES,
  BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
} from "../browser-proxy-envelope.js";
import type { BrowserServerState } from "../browser/server-context.js";
import { toErrorObject } from "../infra/errors.js";

const BROWSER_PROXY_MAX_FILES = 256;
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const stagedReportUpload = {
  body: { paths: ["/tmp/openclaw/uploads/.proxy-upload-1/0/report.txt"] },
  directory: "/tmp/openclaw/uploads/.proxy-upload-1",
};

const controlServiceMocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  getBrowserControlState: vi.fn<() => BrowserServerState | null>(() => null),
  startBrowserControlServiceFromConfig: vi.fn<() => Promise<BrowserServerState | null>>(),
}));

const cdpMocks = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn(async () => ({ status: "closed" as const })),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: dispatcherMocks.dispatch,
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
  })),
  sourceConfig: null as Record<string, unknown> | null,
}));

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn((browser?: { defaultProfile?: string }) => ({
    enabled: true,
    defaultProfile: browser?.defaultProfile ?? "openclaw",
    profiles: {
      openclaw: {
        name: "openclaw",
        driver: "openclaw" as const,
        cdpUrl: "http://127.0.0.1:9222",
      },
      user: {
        name: "user",
        driver: "existing-session" as const,
        cdpUrl: "http://127.0.0.1:9333",
      },
    },
    remoteCdpTimeoutMs: 20_000,
    ssrfPolicy: undefined,
  })),
  resolveProfile: vi.fn(
    (resolved: { profiles?: Record<string, unknown> }, name: string) =>
      resolved.profiles?.[name] ?? null,
  ),
}));

const uploadMocks = vi.hoisted(() => ({
  stageBrowserProxyUploadRequest: vi.fn(),
  discardStagedBrowserProxyUpload: vi.fn(async () => {}),
  ensureBrowserProxyUploadCleanup: vi.fn(async () => {}),
}));

vi.mock("../sdk-config.js", () => ({
  getRuntimeConfig: configMocks.loadConfig,
  getRuntimeConfigSourceSnapshot: () => configMocks.sourceConfig,
  loadConfig: configMocks.loadConfig,
}));

vi.mock("../sdk-node-runtime.js", () => ({
  withTimeout: vi.fn(
    async (
      run: (signal: AbortSignal | undefined) => Promise<unknown>,
      timeoutMs?: number,
      label?: string,
    ) => {
      const resolved =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? Math.max(1, Math.floor(timeoutMs))
          : undefined;
      if (!resolved) {
        return await run(undefined);
      }
      const abortCtrl = new AbortController();
      const timeoutError = new Error(`${label ?? "request"} timed out`);
      const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
      try {
        return await Promise.race([
          run(abortCtrl.signal),
          new Promise<never>((_, reject) => {
            abortCtrl.signal.addEventListener(
              "abort",
              () =>
                reject(
                  toErrorObject(abortCtrl.signal.reason ?? timeoutError, "Non-Error rejection"),
                ),
              { once: true },
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  ),
}));

vi.mock("../sdk-setup-tools.js", () => ({
  detectMime: vi.fn(async () => "image/png"),
}));

vi.mock("../browser/cdp.helpers.js", () => ({
  closeTrackedCdpTarget: cdpMocks.closeTrackedCdpTarget,
  redactCdpUrl: vi.fn((url: string) => {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      const normalized = parsed.toString().replace(/\/$/, "");
      const token = parsed.searchParams.get("token");
      if (!token || token.length <= 8) {
        return normalized;
      }
      return normalized.replace(token, `${token.slice(0, 6)}…${token.slice(-4)}`);
    } catch {
      return url;
    }
  }),
}));

vi.mock("../browser/cdp-reachability-policy.js", () => ({
  resolveCdpControlPolicy: vi.fn(() => undefined),
}));

vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: browserConfigMocks.resolveBrowserConfig,
  resolveProfile: browserConfigMocks.resolveProfile,
}));

vi.mock("../browser-proxy-upload.js", () => uploadMocks);

vi.mock("../browser/request-policy.js", () => ({
  isPersistentBrowserProfileMutation: vi.fn((method: string, path: string) => {
    if (method === "POST" && (path === "/profiles/create" || path === "/reset-profile")) {
      return true;
    }
    return method === "DELETE" && /^\/profiles\/[^/]+$/.test(path);
  }),
  isBrowserHostLocalRoute: vi.fn((method: string, path: string) => {
    if (method === "POST" && path === "/profiles/import") {
      return true;
    }
    return method === "GET" && path === "/system-profiles";
  }),
  normalizeBrowserRequestPath: vi.fn((path: string) => path),
  resolveRequestedBrowserProfile: vi.fn(
    ({
      query,
      body,
      profile,
    }: {
      query?: Record<string, unknown>;
      body?: unknown;
      profile?: string;
    }) => {
      if (query && typeof query.profile === "string" && query.profile.trim()) {
        return query.profile.trim();
      }
      const bodyProfile =
        body && typeof body === "object" ? (body as { profile?: unknown }).profile : undefined;
      if (typeof bodyProfile === "string" && bodyProfile.trim()) {
        return bodyProfile.trim();
      }
      return typeof profile === "string" && profile.trim() ? profile.trim() : undefined;
    },
  ),
}));

vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: dispatcherMocks.createBrowserRouteDispatcher,
}));

vi.mock("../control-service.js", () => ({
  createBrowserControlContext: controlServiceMocks.createBrowserControlContext,
  getBrowserControlState: controlServiceMocks.getBrowserControlState,
  startBrowserControlServiceFromConfig: controlServiceMocks.startBrowserControlServiceFromConfig,
}));

let runBrowserProxyCommand: typeof import("./invoke-browser.js").runBrowserProxyCommand;
let browserState: BrowserServerState;

type BrowserDispatchRequest = {
  path?: string;
  query?: unknown;
  body?: unknown;
};

function firstBrowserDispatchRequest(): BrowserDispatchRequest {
  const [call] = dispatcherMocks.dispatch.mock.calls;
  if (!call) {
    throw new Error("expected browser dispatch call");
  }
  const [request] = call as [BrowserDispatchRequest, ...unknown[]];
  return request;
}

describe("runBrowserProxyCommand", () => {
  beforeEach(async () => {
    const { resolveBrowserConfig } =
      await vi.importActual<typeof import("../browser/config.js")>("../browser/config.js");
    browserState = {
      server: null,
      port: 18_791,
      resolved: resolveBrowserConfig(undefined),
      profiles: new Map(),
    };
    vi.useRealTimers();
    dispatcherMocks.dispatch.mockReset();
    dispatcherMocks.createBrowserRouteDispatcher.mockClear();
    controlServiceMocks.createBrowserControlContext.mockReset().mockReturnValue({ control: true });
    controlServiceMocks.getBrowserControlState.mockReset().mockReturnValue(null);
    controlServiceMocks.startBrowserControlServiceFromConfig
      .mockReset()
      .mockResolvedValue(browserState);
    configMocks.sourceConfig = null;
    configMocks.loadConfig.mockReset().mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReset().mockReturnValue({
      enabled: true,
      defaultProfile: "openclaw",
      profiles: {
        openclaw: {
          name: "openclaw",
          driver: "openclaw",
          cdpUrl: "http://127.0.0.1:9222",
        },
        user: {
          name: "user",
          driver: "existing-session",
          cdpUrl: "http://127.0.0.1:9333",
        },
      },
      remoteCdpTimeoutMs: 20_000,
      ssrfPolicy: undefined,
    });
    browserConfigMocks.resolveProfile.mockClear();
    cdpMocks.closeTrackedCdpTarget.mockReset().mockResolvedValue({ status: "closed" });
    uploadMocks.stageBrowserProxyUploadRequest
      .mockReset()
      .mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
    uploadMocks.discardStagedBrowserProxyUpload.mockReset().mockResolvedValue(undefined);
    uploadMocks.ensureBrowserProxyUploadCleanup.mockReset().mockResolvedValue(undefined);
    vi.resetModules();
    ({ runBrowserProxyCommand } = await import("./invoke-browser.js"));
  });

  it.each(["rejected", "disabled"] as const)("retries a %s browser startup", async (outcome) => {
    const message = outcome === "rejected" ? "browser startup failed" : "browser control disabled";
    if (outcome === "rejected") {
      controlServiceMocks.startBrowserControlServiceFromConfig.mockRejectedValueOnce(
        new Error(message),
      );
    } else {
      controlServiceMocks.startBrowserControlServiceFromConfig.mockResolvedValueOnce(null);
    }
    dispatcherMocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
    const request = JSON.stringify({ method: "GET", path: "/snapshot" });

    await expect(runBrowserProxyCommand(request)).rejects.toThrow(message);
    await expect(runBrowserProxyCommand(request)).resolves.toBe(
      JSON.stringify({ result: { ok: true } }),
    );

    expect(controlServiceMocks.startBrowserControlServiceFromConfig).toHaveBeenCalledTimes(2);
    expect(dispatcherMocks.dispatch).toHaveBeenCalledOnce();
  });

  it("closes a rotated node handle through durable native ownership", async () => {
    const ownership = {
      status: "durable",
      nativeTargetId: "NATIVE-7",
      profileFingerprint: "sha256:profile",
      browserInstanceFingerprint: "sha256:browser",
    } as const;

    const payload = JSON.parse(
      await runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
          profile: "user",
          body: { ownership },
          errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
        }),
      ),
    );

    expect(payload).toMatchObject({
      result: { status: "closed" },
      route: { status: "resolved", profile: "user", driver: "existing-session" },
    });
    expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "user",
        cdpUrl: "http://127.0.0.1:9333",
        nativeTargetId: "NATIVE-7",
        expectedProfileFingerprint: "sha256:profile",
        expectedBrowserInstanceFingerprint: "sha256:browser",
      }),
    );
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
    expect(uploadMocks.stageBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("shares a retried browser control startup across concurrent requests", async () => {
    let rejectFailedStartup!: (reason?: unknown) => void;
    const failedStartup = new Promise<BrowserServerState>((_resolve, reject) => {
      rejectFailedStartup = reject;
    });
    let resolveSuccessfulStartup!: (value: BrowserServerState) => void;
    const successfulStartup = new Promise<BrowserServerState>((resolve) => {
      resolveSuccessfulStartup = resolve;
    });
    controlServiceMocks.startBrowserControlServiceFromConfig
      .mockReturnValueOnce(failedStartup)
      .mockReturnValueOnce(successfulStartup);
    dispatcherMocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
    const request = JSON.stringify({ method: "GET", path: "/snapshot" });

    const failedRequests = Promise.allSettled([
      runBrowserProxyCommand(request),
      runBrowserProxyCommand(request),
    ]);
    expect(controlServiceMocks.startBrowserControlServiceFromConfig).toHaveBeenCalledOnce();
    rejectFailedStartup(new Error("browser startup failed"));

    await expect(failedRequests).resolves.toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();

    const retriedRequests = Promise.allSettled([
      runBrowserProxyCommand(request),
      runBrowserProxyCommand(request),
    ]);
    expect(controlServiceMocks.startBrowserControlServiceFromConfig).toHaveBeenCalledTimes(2);
    resolveSuccessfulStartup(browserState);

    await expect(retriedRequests).resolves.toEqual([
      { status: "fulfilled", value: JSON.stringify({ result: { ok: true } }) },
      { status: "fulfilled", value: JSON.stringify({ result: { ok: true } }) },
    ]);
    controlServiceMocks.getBrowserControlState.mockReturnValue(browserState);
    await expect(runBrowserProxyCommand(request)).resolves.toBe(
      JSON.stringify({ result: { ok: true } }),
    );
    expect(controlServiceMocks.startBrowserControlServiceFromConfig).toHaveBeenCalledTimes(2);
    expect(dispatcherMocks.dispatch).toHaveBeenCalledTimes(3);
  });

  it("stages upload envelopes before dispatch and retains successful copies", async () => {
    const upload = {
      envelope: "browser-upload-v1",
      files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
    };
    const staged = {
      body: { ref: "e12", paths: ["/tmp/openclaw/uploads/.proxy-upload-1/0/report.txt"] },
      directory: "/tmp/openclaw/uploads/.proxy-upload-1",
    };
    uploadMocks.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    dispatcherMocks.dispatch.mockResolvedValueOnce({ status: 200, body: { ok: true } });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: { ref: "e12" },
          upload,
        }),
        "browser.proxy.upload.v1",
      ),
    ).resolves.toBe(JSON.stringify({ result: { ok: true } }));

    expect(uploadMocks.stageBrowserProxyUploadRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { ref: "e12" },
      upload,
      signal: expect.any(AbortSignal),
    });
    expect(firstBrowserDispatchRequest().body).toEqual(staged.body);
    expect(uploadMocks.discardStagedBrowserProxyUpload).not.toHaveBeenCalled();
  });

  it("discards staged copies when the route rejects the upload", async () => {
    const staged = stagedReportUpload;
    uploadMocks.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    dispatcherMocks.dispatch.mockResolvedValueOnce({
      status: 400,
      body: { error: "upload rejected" },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: {},
          upload: {
            envelope: "browser-upload-v1",
            files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
          },
        }),
        "browser.proxy.upload.v1",
      ),
    ).rejects.toThrow("400: upload rejected");

    expect(uploadMocks.discardStagedBrowserProxyUpload).toHaveBeenCalledWith(staged);
  });

  it("retains staged copies when dispatch fails after Browser ownership is uncertain", async () => {
    const staged = stagedReportUpload;
    uploadMocks.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    dispatcherMocks.dispatch.mockRejectedValueOnce(new Error("dispatch failed"));

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: {},
          upload: {
            envelope: "browser-upload-v1",
            files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
          },
        }),
        "browser.proxy.upload.v1",
      ),
    ).rejects.toThrow("dispatch failed");

    expect(uploadMocks.discardStagedBrowserProxyUpload).not.toHaveBeenCalled();
  });

  it("retains staged copies when the timeout wins before dispatch settles", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const staged = stagedReportUpload;
    uploadMocks.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    dispatcherMocks.dispatch
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        status: 200,
        body: { running: true, cdpReady: true, cdpHttp: true },
      });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: {},
          upload: {
            envelope: "browser-upload-v1",
            files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
          },
          timeoutMs: 5,
        }),
        "browser.proxy.upload.v1",
      ),
    )
      .rejects.toThrow("browser proxy timed out")
      .finally(() => now.mockRestore());

    expect(uploadMocks.discardStagedBrowserProxyUpload).not.toHaveBeenCalled();
  });

  it("rejects upload envelopes sent through the legacy proxy command", async () => {
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: {},
          upload: {
            envelope: "browser-upload-v1",
            files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
          },
        }),
      ),
    ).rejects.toThrow("browser.proxy does not accept upload envelopes");
    expect(uploadMocks.stageBrowserProxyUploadRequest).not.toHaveBeenCalled();
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, 0, ""])(
    "rejects a %j upload envelope sent through the upload proxy command",
    async (upload) => {
      await expect(
        runBrowserProxyCommand(
          JSON.stringify({ method: "GET", path: "/snapshot", upload }),
          "browser.proxy.upload.v1",
        ),
      ).rejects.toThrow("browser.proxy.upload.v1 requires an upload envelope");
      expect(uploadMocks.stageBrowserProxyUploadRequest).not.toHaveBeenCalled();
      expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch after upload staging exhausts the proxy deadline", async () => {
    const staged = {
      body: { paths: ["/tmp/openclaw/uploads/.proxy-uploads/upload-1/0/report.txt"] },
      directory: "/tmp/openclaw/uploads/.proxy-uploads/upload-1",
    };
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    uploadMocks.stageBrowserProxyUploadRequest.mockImplementationOnce(async () => {
      nowMs += 10;
      return staged;
    });

    try {
      await expect(
        runBrowserProxyCommand(
          JSON.stringify({
            method: "POST",
            path: "/hooks/file-chooser",
            body: {},
            upload: {
              envelope: "browser-upload-v1",
              files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
            },
            timeoutMs: 5,
          }),
          "browser.proxy.upload.v1",
        ),
      ).rejects.toThrow("browser proxy timed out");
    } finally {
      nowSpy.mockRestore();
    }

    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
    expect(uploadMocks.discardStagedBrowserProxyUpload).toHaveBeenCalledWith(staged);
  });

  it("aborts upload staging when it reaches the proxy deadline", async () => {
    uploadMocks.stageBrowserProxyUploadRequest.mockImplementationOnce(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const reason = signal.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason)));
            },
            { once: true },
          );
        }),
    );

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: {},
          upload: {
            envelope: "browser-upload-v1",
            files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
          },
          timeoutMs: 5,
        }),
        "browser.proxy.upload.v1",
      ),
    ).rejects.toThrow("browser proxy timed out");

    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("serializes plural action downloads without reading nested page paths", async () => {
    const tempDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-browser-proxy-action-"));
    const firstPath = nodePath.join(tempDir, "first.txt");
    const secondPath = nodePath.join(tempDir, "second.txt");
    const nestedPagePath = nodePath.join(tempDir, "page-controlled.txt");
    const result = {
      ok: true,
      downloads: [
        { path: firstPath, suggestedFilename: "first.txt" },
        null,
        { path: 42 },
        { path: secondPath, suggestedFilename: "second.txt" },
        { path: firstPath, suggestedFilename: "first-copy.txt" },
      ],
      result: {
        path: nestedPagePath,
        downloads: [{ path: nestedPagePath }],
      },
    };

    try {
      await Promise.all([
        fs.writeFile(firstPath, "first browser download", "utf8"),
        fs.writeFile(secondPath, "second browser download", "utf8"),
        fs.writeFile(nestedPagePath, "must stay on the node", "utf8"),
      ]);
      dispatcherMocks.dispatch.mockResolvedValueOnce({ status: 200, body: result });

      const payload = JSON.parse(
        await runBrowserProxyCommand(JSON.stringify({ method: "POST", path: "/act" })),
      ) as {
        result: unknown;
        files?: Array<{ path: string; base64: string; mimeType?: string }>;
      };

      expect(payload.result).toEqual(result);
      expect(
        payload.files?.map((file) => ({
          path: file.path,
          contents: Buffer.from(file.base64, "base64").toString("utf8"),
          mimeType: file.mimeType,
        })),
      ).toEqual([
        { path: firstPath, contents: "first browser download", mimeType: "image/png" },
        { path: secondPath, contents: "second browser download", mimeType: "image/png" },
      ]);
      expect(payload.files?.some((file) => file.path === nestedPagePath)).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an aggregate above the proxy transport budget", async () => {
    const tempDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-browser-proxy-limit-"));
    const firstPath = nodePath.join(tempDir, "first.bin");
    const secondPath = nodePath.join(tempDir, "second.bin");
    try {
      await Promise.all([fs.writeFile(firstPath, ""), fs.writeFile(secondPath, "")]);
      await Promise.all([
        fs.truncate(firstPath, BROWSER_PROXY_MAX_FILE_BYTES),
        fs.truncate(
          secondPath,
          BROWSER_PROXY_MAX_TOTAL_FILE_BYTES - BROWSER_PROXY_MAX_FILE_BYTES + 1,
        ),
      ]);
      dispatcherMocks.dispatch.mockResolvedValueOnce({
        status: 200,
        body: { downloads: [{ path: firstPath }, { path: secondPath }] },
      });

      const error = await runBrowserProxyCommand(
        JSON.stringify({ method: "POST", path: "/act" }),
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `browser proxy file read failed for ${secondPath}: Error: browser proxy files exceed 16 MiB aggregate limit`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects too many unique files before reading them", async () => {
    dispatcherMocks.dispatch.mockResolvedValueOnce({
      status: 200,
      body: {
        downloads: Array.from({ length: BROWSER_PROXY_MAX_FILES + 1 }, (_, index) => ({
          path: `/missing/browser-download-${index}.bin`,
        })),
      },
    });

    await expect(
      runBrowserProxyCommand(JSON.stringify({ method: "POST", path: "/act" })),
    ).rejects.toThrow("browser proxy response exceeds 256 file limit");
  });

  it("rejects a result whose encoded node frame would exceed the transport limit", async () => {
    dispatcherMocks.dispatch.mockResolvedValueOnce({
      status: 200,
      body: { result: "\\".repeat(7 * 1024 * 1024) },
    });

    await expect(
      runBrowserProxyCommand(JSON.stringify({ method: "POST", path: "/act" })),
    ).rejects.toThrow("browser proxy payload exceeds 24 MiB encoded limit");
  });

  it("adds profile and browser status details on ws-backed timeouts", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: "http://127.0.0.1:18792",
        },
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "openclaw",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=openclaw; status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=http:\/\/127\.0\.0\.1:18792\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("includes chrome-mcp transport in timeout diagnostics when no CDP URL exists", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          transport: "chrome-mcp",
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: null,
        },
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "user",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=user; status\(running=true, cdpHttp=true, cdpReady=false, transport=chrome-mcp\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("redacts sensitive cdpUrl details in timeout diagnostics", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl:
            "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
        },
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "remote",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=https:\/\/example\.com\/chrome\?token=supers…7890\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it.each([
    { status: 500, body: { error: "tab not found" }, expected: "500: tab not found" },
    {
      status: 404,
      body: { error: 'tab not found: browser tab "abc"' },
      expected: "404: tab not found",
    },
    { status: 503, body: { error: "" }, expected: "HTTP 503" },
  ])("preserves legacy node errors without envelope opt-in: $expected", async (response) => {
    dispatcherMocks.dispatch.mockResolvedValue(response);

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/act",
          profile: "openclaw",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow(response.expected);
  });

  it("preserves only validated browser error metadata in the proxy envelope", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 409,
      body: {
        error: "headed mode needs a display",
        reason: "no_display_for_headed_profile",
        details: {
          profile: "openclaw",
          requestedHeadless: false,
          headlessSource: "config",
          displayPresent: false,
          remediation: "untrusted",
        },
        untrusted: "drop me",
      },
    });

    const result = JSON.parse(
      await runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/start",
          profile: "openclaw",
          errorEnvelope: "browser-v1",
        }),
      ),
    );

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          error: "headed mode needs a display",
          reason: "no_display_for_headed_profile",
          details: {
            profile: "openclaw",
            requestedHeadless: false,
            headlessSource: "config",
            displayPresent: false,
          },
        },
      },
      route: { status: "resolved", profile: "openclaw", driver: "openclaw" },
    });
  });

  it("rejects unauthorized query.profile when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          query: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("uses the browser source snapshot for proxy default-profile decisions", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: { defaultProfile: "openclaw" },
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["work"] } },
    });
    configMocks.sourceConfig = {
      browser: { defaultProfile: "work" },
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["work"] } },
    };
    browserConfigMocks.resolveBrowserConfig.mockImplementation(
      (browser?: { defaultProfile?: string }) => ({
        enabled: true,
        defaultProfile: browser?.defaultProfile ?? "openclaw",
        profiles: {
          openclaw: {
            name: "openclaw",
            driver: "openclaw" as const,
            cdpUrl: "http://127.0.0.1:9222",
          },
          user: {
            name: "user",
            driver: "existing-session" as const,
            cdpUrl: "http://127.0.0.1:9333",
          },
          work: {
            name: "work",
            driver: "openclaw" as const,
            cdpUrl: "http://127.0.0.1:9444",
          },
        },
        remoteCdpTimeoutMs: 20_000,
        ssrfPolicy: undefined,
      }),
    );
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        method: "GET",
        path: "/snapshot",
        timeoutMs: 50,
      }),
    );

    const request = firstBrowserDispatchRequest();
    expect(request.path).toBe("/snapshot");
  });

  it("rejects unauthorized body.profile when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/stop",
          body: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile creation when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/profiles/create",
          body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects host-local system profile listing on a browser node", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: [] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ method: "GET", path: "/system-profiles", timeoutMs: 50 }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot run host-local browser routes");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile deletion when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "DELETE",
          path: "/profiles/poc",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile reset when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/reset-profile",
          body: { profile: "openclaw", name: "openclaw" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes an allowlisted body profile into the dispatched query", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        method: "POST",
        path: "/stop",
        body: { profile: "openclaw" },
        timeoutMs: 50,
      }),
    );

    const request = firstBrowserDispatchRequest();
    expect(request.path).toBe("/stop");
    expect(request.query).toEqual({ profile: "openclaw" });
  });

  it("caps browser proxy command timeout before dispatch", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);

    try {
      await runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects persistent profile creation when allowProfiles is empty", async () => {
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/profiles/create",
          body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });
});
