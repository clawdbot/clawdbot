// Control UI HTTP tests cover static asset serving, bootstrap config, avatar and
// assistant media routes, pairing helpers, and session-generation metadata.
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizeAssistantIdentity } from "../../ui/src/lib/assistant-identity.ts";
import * as configIo from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import { resolveOpenedControlUiRepresentation } from "./control-ui-static.js";
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { setControlUiPluginAuthCookieForRequest } from "./http-auth-utils.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { makeMockHttpResponse } from "./test-http-response.js";

type PlaybackTranscodeResolution = Awaited<
  ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackTranscode"]>
>;
type PlaybackModeForSourceResolver = (
  ...args: Parameters<
    (typeof import("../media/playback-transcode.js"))["resolvePlaybackModeForSource"]
  >
) => ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackModeForSource"]>;
type FileHandleRead = (
  target: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

// Keeps bootstrap payload tests deterministic: the real resolver reports the
// git branch of this checkout, which varies across CI and dev machines.
const devInstallBranchMock = vi.hoisted(() => ({ branch: null as string | null }));
const runFfprobeMock = vi.hoisted(() => vi.fn(async () => "{}"));
const resolvePlaybackModeForSourceMock = vi.hoisted(() => vi.fn<PlaybackModeForSourceResolver>());
const resolvePlaybackTranscodeMock = vi.hoisted(() =>
  vi.fn(async (): Promise<PlaybackTranscodeResolution> => ({ kind: "passthrough" })),
);
vi.mock("../infra/dev-install-branch.js", () => ({
  resolveDevInstallGitBranch: async () => devInstallBranchMock.branch,
}));
vi.mock("../media/ffmpeg-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/ffmpeg-exec.js")>()),
  runFfprobe: runFfprobeMock,
}));
vi.mock("../media/playback-transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/playback-transcode.js")>();
  resolvePlaybackModeForSourceMock.mockImplementation(async ({ mimeType }) =>
    mimeType === "audio/x-caf" ? "transcode" : "native",
  );
  return {
    ...actual,
    resolvePlaybackModeForSource: resolvePlaybackModeForSourceMock,
    resolvePlaybackTranscode: resolvePlaybackTranscodeMock,
  };
});

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);

function createAuthRateLimiterSpy() {
  const check = vi.fn<AuthRateLimiter["check"]>(() => ({
    allowed: true,
    remaining: 10,
    retryAfterMs: 0,
  }));
  const recordFailure = vi.fn<AuthRateLimiter["recordFailure"]>(() => {});
  const recordFailureAndDelay = vi.fn<AuthRateLimiter["recordFailureAndDelay"]>(async () => {});
  const reset = vi.fn<AuthRateLimiter["reset"]>(() => {});
  return {
    check,
    recordFailure,
    recordFailureAndDelay,
    reset,
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  } satisfies AuthRateLimiter;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  runFfprobeMock.mockReset();
  runFfprobeMock.mockResolvedValue("{}");
  resolvePlaybackModeForSourceMock.mockReset();
  resolvePlaybackModeForSourceMock.mockImplementation(async ({ mimeType }) =>
    mimeType === "audio/x-caf" ? "transcode" : "native",
  );
  resolvePlaybackTranscodeMock.mockReset();
  resolvePlaybackTranscodeMock.mockResolvedValue({ kind: "passthrough" });
});

describe("handleControlUiHttpRequest", () => {
  function createAvatarConfig(workspace: string, avatar: string): OpenClawConfig {
    return {
      agents: {
        defaults: { workspace },
        list: [{ id: "main", workspace, identity: { avatar } }],
      },
    };
  }

  function growAvatarAfterPinnedOpen(avatarPath: string) {
    const fstatSync = fsSync.fstatSync;
    return vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) => {
      const stat = fstatSync(fd);
      fsSync.appendFileSync(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES));
      return stat;
    });
  }

  async function withControlUiRoot<T>(params: {
    indexHtml?: string;
    fn: (tmp: string) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      return await params.fn(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(responseBody(end)) as {
      basePath: string;
      assistantName: string;
      assistantAvatar: string;
      assistantAvatarSource?: string | null;
      assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
      assistantAvatarReason?: string | null;
      assistantAgentId?: string;
      devGitBranch?: string;
      environment?: { label: string; color: string };
      localMediaPreviewRoots?: string[];
      seamColor?: string;
      terminalEnabled: boolean;
      cliAgentsEnabled: boolean;
      automaticallyFetchFavicons: boolean;
      communityInvite: boolean;
      pluginFrameGrants?: ControlUiPluginFrameGrantAck[];
    };
  }

  function responseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return String(end.mock.calls[0]?.[0] ?? "");
  }

  function responseJson(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(responseBody(end)) as unknown;
  }

  function firstEndCallLength(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return end.mock.calls[0]?.length ?? -1;
  }

  function expectNotFoundResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(404);
    expect(params.end).toHaveBeenCalledWith("Not Found");
  }

  async function runControlUiRequest(params: {
    url: string;
    method: "GET" | "HEAD" | "POST";
    rootPath: string;
    basePath?: string;
    rootKind?: "resolved" | "bundled";
    retainedAssets?: ControlUiAssetRetention;
    headers?: IncomingMessage["headers"];
  }) {
    const { res, end, setHeader } = makeMockHttpResponse();
    const handled = await handleControlUiHttpRequest(
      { url: params.url, method: params.method, headers: params.headers ?? {} } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        root:
          params.rootKind === "bundled"
            ? {
                kind: "bundled",
                path: params.rootPath,
                ...(params.retainedAssets ? { retainedAssets: params.retainedAssets } : {}),
              }
            : { kind: "resolved", path: params.rootPath },
      },
    );
    return { res, end, setHeader, handled };
  }

  async function runBootstrapConfigRequest(params: {
    rootPath: string;
    basePath?: string;
    auth?: ResolvedGatewayAuth;
    headers?: IncomingMessage["headers"];
    config?: OpenClawConfig;
    rateLimiter?: AuthRateLimiter;
    remoteAddress?: string;
    trustedProxies?: string[];
  }) {
    const { res, end, setHeader } = makeMockHttpResponse();
    const url = params.basePath
      ? `${params.basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
      : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
    const handled = await handleControlUiHttpRequest(
      {
        url,
        method: "GET",
        headers: params.headers ?? {},
        socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
      } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        ...(params.auth ? { auth: params.auth } : {}),
        ...(params.config ? { config: params.config } : {}),
        ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
        ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
        root: { kind: "resolved", path: params.rootPath },
      },
    );
    return { res, end, setHeader, handled };
  }

  async function runAvatarRequest(params: {
    url: string;
    method: "GET" | "HEAD" | "POST";
    config: OpenClawConfig;
    basePath?: string;
    auth?: ResolvedGatewayAuth;
    headers?: IncomingMessage["headers"];
    trustedProxies?: string[];
    remoteAddress?: string;
  }) {
    const { res, end, setHeader } = makeMockHttpResponse();
    const handled = await handleControlUiAvatarRequest(
      {
        url: params.url,
        method: params.method,
        headers: params.headers ?? {},
        socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
      } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        ...(params.auth ? { auth: params.auth } : {}),
        ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
        config: params.config,
      },
    );
    return { res, end, setHeader, handled };
  }

  async function runAssistantMediaRequest(params: {
    url: string;
    method: "GET" | "HEAD";
    basePath?: string;
    auth?: ResolvedGatewayAuth;
    headers?: IncomingMessage["headers"];
    distinctHeaders?: IncomingMessage["headersDistinct"];
    trustedProxies?: string[];
    remoteAddress?: string;
  }) {
    const { res, end, setHeader } = makeMockHttpResponse();
    const handled = await handleControlUiAssistantMediaRequest(
      {
        url: params.url,
        method: params.method,
        headers: params.headers ?? {},
        headersDistinct:
          params.distinctHeaders ??
          Object.fromEntries(
            Object.entries(params.headers ?? {}).map(([name, value]) => [
              name,
              Array.isArray(value) ? value : [String(value)],
            ]),
          ),
        socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
      } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        ...(params.auth ? { auth: params.auth } : {}),
        ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
      },
    );
    return { res, end, setHeader, handled };
  }

  function createTrustedProxyAuth(): ResolvedGatewayAuth {
    return {
      mode: "trusted-proxy",
      allowTailscale: false,
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    };
  }

  function createTrustedProxyHeaders(
    extraHeaders: IncomingMessage["headers"] = {},
  ): IncomingMessage["headers"] {
    return {
      host: "gateway.example.com",
      "x-forwarded-user": "nick@example.com",
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-proto": "https",
      ...extraHeaders,
    };
  }

  async function runTrustedProxyAssistantMediaRequest(params: {
    filePath: string;
    meta?: boolean;
    headers?: IncomingMessage["headers"];
  }) {
    return await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?${params.meta ? "meta=1&" : ""}source=${encodeURIComponent(params.filePath)}`,
      method: "GET",
      auth: createTrustedProxyAuth(),
      trustedProxies: ["10.0.0.1"],
      remoteAddress: "10.0.0.1",
      headers: createTrustedProxyHeaders(params.headers),
    });
  }

  async function runTrustedProxyAvatarRequest(params: {
    agentId?: string;
    meta?: boolean;
    headers?: IncomingMessage["headers"];
    config?: OpenClawConfig;
  }) {
    return await runAvatarRequest({
      url: `/avatar/${params.agentId ?? "main"}${params.meta ? "?meta=1" : ""}`,
      method: "GET",
      auth: createTrustedProxyAuth(),
      trustedProxies: ["10.0.0.1"],
      remoteAddress: "10.0.0.1",
      headers: createTrustedProxyHeaders(params.headers),
      config: params.config ?? createAvatarConfig(os.tmpdir(), "https://example.com/avatar.png"),
    });
  }

  function expectMissingOperatorReadResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(403);
    expect(responseJson(params.end)).toEqual({
      ok: false,
      error: {
        type: "forbidden",
        message: "missing scope: operator.read",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        },
      },
    });
  }

  async function writeAssetFile(rootPath: string, filename: string, contents: string) {
    const assetsDir = path.join(rootPath, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    const filePath = path.join(assetsDir, filename);
    await fs.writeFile(filePath, contents);
    return { assetsDir, filePath };
  }

  async function createHardlinkedAssetFile(rootPath: string) {
    const { filePath } = await writeAssetFile(rootPath, "app.js", "console.log('hi');");
    const hardlinkPath = path.join(path.dirname(filePath), "app.hl.js");
    await fs.link(filePath, hardlinkPath);
    return hardlinkPath;
  }

  async function withAllowedAssistantMediaRoot<T>(params: {
    prefix: string;
    fn: (tmpRoot: string) => Promise<T>;
  }) {
    const tmpRoot = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), params.prefix));
    try {
      return await params.fn(tmpRoot);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  }

  async function forceFirstFileHandleShortRead(filePath: string, maxBytes: number) {
    const probe = await fs.open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandleRead };
    const originalRead = fileHandlePrototype.read;
    await probe.close();
    let constrained = false;
    return vi
      .spyOn(fileHandlePrototype, "read")
      .mockImplementation(async function (this: unknown, target, offset, length, position) {
        if (!constrained && position === 0 && length > maxBytes) {
          constrained = true;
          return await originalRead.call(this, target, offset, maxBytes, position);
        }
        return await originalRead.call(this, target, offset, length, position);
      });
  }

  async function withBasePathRootFixture<T>(params: {
    siblingDir: string;
    fn: (paths: { root: string; sibling: string }) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-root-"));
    try {
      const root = path.join(tmp, "ui");
      const sibling = path.join(tmp, params.siblingDir);
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(path.join(root, "index.html"), "<html>ok</html>\n");
      return await params.fn({ root, sibling });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  async function withPairedOperatorDeviceToken<T>(params: {
    issuerGeneration?: string;
    browserMetadata?: boolean;
    fn: (token: string) => Promise<T>;
  }) {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-device-token-"));
    try {
      return await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
        const deviceId = "control-ui-device";
        const requested = await requestDevicePairing({
          deviceId,
          publicKey: "test-public-key",
          role: "operator",
          scopes: ["operator.read"],
          ...(params.browserMetadata
            ? {
                clientId: "openclaw-control-ui",
                clientMode: "webchat",
              }
            : {}),
        });
        const approved = await approveDevicePairing(requested.request.requestId, {
          callerScopes: ["operator.read"],
        });
        expect(approved?.status).toBe("approved");
        let operatorToken =
          approved?.status === "approved" ? approved.device.tokens?.operator?.token : undefined;
        if (params.issuerGeneration) {
          const issued = await ensureDeviceToken({
            deviceId,
            role: "operator",
            scopes: ["operator.read"],
            issuer: {
              kind: "shared-gateway-auth",
              generation: params.issuerGeneration,
            },
          });
          operatorToken = issued?.token;
        }
        expect(typeof operatorToken).toBe("string");
        return await params.fn(operatorToken ?? "");
      });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }

  async function withScopedPairedOperatorDevice<T>(params: {
    scopes: string[];
    fn: (bearer: string) => Promise<T>;
  }) {
    const tempHome = testTempDirs.make("openclaw-ui-scoped-device-");
    return await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
      const deviceId = `control-ui-device-${randomUUID()}`;
      const requested = await requestDevicePairing({
        deviceId,
        publicKey: "test-public-key",
        role: "operator",
        scopes: params.scopes,
      });
      const approved = await approveDevicePairing(requested.request.requestId, {
        callerScopes: params.scopes,
      });
      expect(approved).toMatchObject({ status: "approved" });
      const operatorBearer =
        approved?.status === "approved" ? approved.device.tokens?.operator?.token : undefined;
      expect(typeof operatorBearer).toBe("string");
      return await params.fn(operatorBearer ?? "");
    });
  }

  it("sets security headers for Control UI responses", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, setHeader } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        const csp = setHeader.mock.calls.findLast(
          (call) => call[0] === "Content-Security-Policy",
        )?.[1];
        expect(typeof csp).toBe("string");
        expect(String(csp)).toContain("frame-ancestors 'none'");
        expect(String(csp)).toContain("frame-src 'self'");
        expect(String(csp)).toContain("script-src 'self'");
        expect(String(csp)).toContain(
          "connect-src 'self' ws: wss: data: https://api.openai.com https://tweakcn.com",
        );
        expect(String(csp)).not.toContain("https://*.tweakcn.com");
        expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
        expect(setHeader).toHaveBeenCalledWith(
          "Permissions-Policy",
          "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
        );
        expect(responseBody(end)).toContain('data-openclaw-terminal-enabled="true"');
      },
    });
  });

  it("marks terminal-enabled documents and allows the terminal WASM runtime", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, setHeader } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: { gateway: { terminal: { enabled: true } } },
          },
        );
        expect(handled).toBe(true);
        const csp = setHeader.mock.calls.findLast(
          (call) => call[0] === "Content-Security-Policy",
        )?.[1];
        expect(String(csp)).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(responseBody(end)).toContain('data-openclaw-terminal-enabled="true"');
      },
    });
  });

  it("uses effective terminal availability instead of raw restart-pending config", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, setHeader } = makeMockHttpResponse();
        await handleControlUiHttpRequest(
          { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: { gateway: { terminal: { enabled: true } } },
            terminalEnabled: false,
          },
        );
        const csp = setHeader.mock.calls.findLast(
          (call) => call[0] === "Content-Security-Policy",
        )?.[1];
        expect(String(csp)).not.toContain("'wasm-unsafe-eval'");
        expect(responseBody(end)).toContain('data-openclaw-terminal-enabled="false"');

        const bootstrap = makeMockHttpResponse();
        await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          bootstrap.res,
          {
            root: { kind: "resolved", path: tmp },
            config: { gateway: { terminal: { enabled: false } } },
            terminalEnabled: true,
          },
        );
        expect(parseBootstrapPayload(bootstrap.end).terminalEnabled).toBe(true);
      },
    });
  });

  it("serves assistant local media through the control ui media route", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res["setHeader"]).toHaveBeenCalledWith(
          "Content-Disposition",
          `inline; filename="photo.png"; filename*=UTF-8''photo.png`,
        );
      },
    });
  });

  it.each(["atomic replacement", "in-place rewrite"] as const)(
    "serves changed assistant media after a same-size %s preserves its modification time",
    async (mutation) => {
      await withAllowedAssistantMediaRoot({
        prefix: "ui-media-mutable-",
        fn: async (tmpRoot) => {
          const filePath = path.join(tmpRoot, "sample.bin");
          const original = Buffer.from("original media bytes");
          const replacement = Buffer.from("replaced media bytes");
          const modified = new Date("2025-01-01T00:00:00.000Z");
          await fs.writeFile(filePath, original);
          await fs.utimes(filePath, modified, modified);
          const url = `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`;
          const auth = { mode: "token", token: "test-token", allowTailscale: false } as const;
          const headers = { authorization: "Bearer test-token" };
          const initial = await runAssistantMediaRequest({ url, method: "HEAD", auth, headers });
          const etag = String(
            initial.setHeader.mock.calls.find(([name]) => name === "ETag")?.[1] ??
              '"cached-version"',
          );
          const lastModified = modified.toUTCString();
          const replacementPath =
            mutation === "atomic replacement" ? path.join(tmpRoot, "next.bin") : filePath;
          await fs.writeFile(replacementPath, replacement);
          await fs.utimes(replacementPath, modified, modified);
          if (replacementPath !== filePath) {
            await fs.rename(replacementPath, filePath);
          }
          const stat = await fs.stat(filePath);
          expect(stat.size).toBe(original.length);
          expect(stat.mtimeMs).toBe(modified.getTime());
          expect(await fs.readFile(filePath)).toEqual(replacement);

          for (const method of ["GET", "HEAD"] as const) {
            for (const condition of [
              { "if-none-match": etag },
              { "if-modified-since": lastModified },
              { range: "bytes=0-3", "if-range": etag },
              { range: "bytes=0-3", "if-range": lastModified },
            ]) {
              const current = await runAssistantMediaRequest({
                url,
                method,
                auth,
                headers: { ...headers, ...condition },
              });
              expect
                .soft(current.res.statusCode, `${method} ${JSON.stringify(condition)}`)
                .toBe(200);
              expect.soft(current.setHeader).not.toHaveBeenCalledWith("ETag", expect.anything());
              expect
                .soft(current.setHeader)
                .not.toHaveBeenCalledWith("Last-Modified", expect.anything());
            }
          }
          const ranged = await runAssistantMediaRequest({
            url,
            method: "GET",
            auth,
            headers: { ...headers, range: "bytes=0-3" },
          });
          expect(ranged.res.statusCode).toBe(206);
          expect(ranged.setHeader).toHaveBeenCalledWith(
            "Content-Range",
            `bytes 0-3/${replacement.length}`,
          );
          for (const method of ["GET", "HEAD"] as const) {
            const exists = await runAssistantMediaRequest({
              url,
              method,
              auth,
              headers: { ...headers, "if-none-match": "*", range: "bytes=0-3" },
            });
            expect(exists.res.statusCode).toBe(304);
            expect(exists.end).toHaveBeenCalledWith();
            expect(exists.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
          }
        },
      });
    },
  );

  it("returns 202 while assistant playback media is preparing", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "preparing" });
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-playback-preparing-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "voice.caf");
        await fs.writeFile(filePath, Buffer.from("caff-original"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?playback=1&source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);
        expect(responseJson(end)).toEqual({ status: "preparing" });
      },
    });
  });

  it("falls back to original assistant media when playback transcode fails", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "fallback" });
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-playback-fallback-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "voice.caf");
        await fs.writeFile(filePath, Buffer.from("caff-original"));
        const { res, handled, setHeader } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?playback=1&source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(setHeader).toHaveBeenCalledWith("Content-Type", "audio/x-caf");
        expect(resolvePlaybackTranscodeMock).toHaveBeenCalledWith(
          expect.objectContaining({ mimeType: "audio/x-caf", kind: "audio" }),
        );
      },
    });
  });

  it.each([
    { filename: "voice.ogg", disposition: "inline" },
    { filename: "clip.mp4", disposition: "inline" },
    { filename: "report.pdf", disposition: "attachment" },
    {
      filename: "invoice---123e4567-e89b-12d3-a456-426614174000.pdf",
      disposition: "attachment",
    },
    { filename: "archive.bin", disposition: "attachment" },
  ])("serves $filename with $disposition disposition", async ({ filename, disposition }) => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-disposition-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, filename);
        await fs.writeFile(filePath, Buffer.from("fixture"));
        const { res, handled } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res["setHeader"]).toHaveBeenCalledWith(
          "Content-Disposition",
          `${disposition}; filename="${filename}"; filename*=UTF-8''${filename}`,
        );
      },
    });
  });

  it("encodes Unicode and RFC 8187 delimiter characters in assistant media filenames", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-filename-",
      fn: async (tmpRoot) => {
        const filename = `测试 100% 'draft' (1).pdf`;
        const filePath = path.join(tmpRoot, filename);
        await fs.writeFile(filePath, Buffer.from("fixture"));
        const { res, handled } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res["setHeader"]).toHaveBeenCalledWith(
          "Content-Disposition",
          `attachment; filename="__ 100_ 'draft' (1).pdf"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20100%25%20%27draft%27%20%281%29.pdf`,
        );
      },
    });
  });

  it("sanitizes control characters in assistant media filenames", () => {
    expect(buildAssistantMediaContentDisposition("draft\r\nfinal.pdf", "application/pdf")).toBe(
      `attachment; filename="draft__final.pdf"; filename*=UTF-8''draft__final.pdf`,
    );
  });

  it("caps long assistant media filenames in content disposition", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-filename-long-",
      fn: async (tmpRoot) => {
        const filename = `${"a".repeat(210)}.pdf`;
        const filePath = path.join(tmpRoot, filename);
        await fs.writeFile(filePath, Buffer.from("fixture"));
        const { res, handled } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=t`,
          method: "GET",
          auth: { mode: "token", token: "t", allowTailscale: false },
        });
        const capped = `${"a".repeat(196)}.pdf`;

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res["setHeader"]).toHaveBeenCalledWith(
          "Content-Disposition",
          `attachment; filename="${capped}"; filename*=UTF-8''${capped}`,
        );
      },
    });
  });

  it("caps assistant media filenames without splitting surrogate pairs", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-filename-surrogate-",
      fn: async (tmpRoot) => {
        const filename = `${"a".repeat(195)}😀${"b".repeat(20)}.pdf`;
        const filePath = path.join(tmpRoot, filename);
        await fs.writeFile(filePath, Buffer.from("fixture"));
        const { res, handled } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=t`,
          method: "GET",
          auth: { mode: "token", token: "t", allowTailscale: false },
        });
        const cappedFallback = `${"a".repeat(195)}__.pdf`;
        const cappedExtended = `${"a".repeat(195)}%F0%9F%98%80.pdf`;

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res["setHeader"]).toHaveBeenCalledWith(
          "Content-Disposition",
          `attachment; filename="${cappedFallback}"; filename*=UTF-8''${cappedExtended}`,
        );
      },
    });
  });

  it("replaces ill-formed assistant media filename surrogates before encoding", () => {
    expect(buildAssistantMediaContentDisposition("draft\uD800.pdf", "application/pdf")).toBe(
      `attachment; filename="draft_.pdf"; filename*=UTF-8''draft%EF%BF%BD.pdf`,
    );
  });

  it("serves assistant media from canonical inbound media refs", async () => {
    const stateDir = resolveStateDir();
    const id = `report---${randomUUID()}.pdf`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("not-a-real-png"));

    try {
      const { res, handled } = await runAssistantMediaRequest({
        url: `/__openclaw__/assistant-media?source=${encodeURIComponent(`media://inbound/${id}`)}&token=test-token`,
        method: "GET",
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res["setHeader"]).toHaveBeenCalledWith(
        "Content-Disposition",
        `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
      );
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("reports assistant media metadata for canonical inbound media refs", async () => {
    const stateDir = resolveStateDir();
    const id = `ui-media-ref-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("not-a-real-png"));

    try {
      const { res, handled, end } = await runAssistantMediaRequest({
        url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(`media://inbound/${id}`)}&token=test-token`,
        method: "GET",
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const payload = responseJson(end) as {
        available?: boolean;
        mediaTicket?: string;
        mediaTicketExpiresAt?: string;
      };
      expect(payload.available).toBe(true);
      expect(payload.mediaTicket).toMatch(/^v1\./);
      expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("rejects assistant local media outside allowed preview roots", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-media-blocked-"));
    try {
      const filePath = path.join(tmp, "photo.png");
      await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
      const { res, handled, end } = await runAssistantMediaRequest({
        url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
        method: "GET",
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      });
      expectNotFoundResponse({ handled, res, end });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports assistant local media availability metadata", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-meta-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const payload = responseJson(end) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
        };
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);
        expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();
      },
    });
  });

  it("fully reads the assistant media metadata MIME prefix after a short read", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-meta-short-read-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.bin");
        await fs.writeFile(filePath, REAL_PNG);
        const readSpy = await forceFirstFileHandleShortRead(filePath, 1);

        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(responseJson(end)).toMatchObject({ available: true, mimeType: "image/png" });
        expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
    });
  });

  it("fully reads the served assistant media MIME prefix after a short read", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-serve-short-read-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.bin");
        await fs.writeFile(filePath, REAL_PNG);
        const readSpy = await forceFirstFileHandleShortRead(filePath, 1);

        const { res, handled, setHeader } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
        expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
    });
  });

  it("reports assistant audio size, type, and probed duration metadata", async () => {
    runFfprobeMock.mockResolvedValueOnce(JSON.stringify({ format: { duration: "2.345" } }));
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-audio-meta-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "voice.mp3");
        const contents = Buffer.from("ID3audio-fixture");
        await fs.writeFile(filePath, contents);
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(responseJson(end)).toMatchObject({
          available: true,
          mimeType: "audio/mpeg",
          playback: "native",
          sizeBytes: contents.byteLength,
          durationMs: 2345,
        });
        expect(runFfprobeMock).toHaveBeenCalledWith(expect.any(Array), {
          stdinFileDescriptor: expect.any(Number),
        });
      },
    });
  });

  it("marks exotic assistant media metadata for playback transcoding", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-transcode-meta-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "voice.caf");
        await fs.writeFile(filePath, Buffer.from("caff-original"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(responseJson(end)).toMatchObject({
          available: true,
          mimeType: "audio/x-caf",
          playback: "transcode",
        });
      },
    });
  });

  it("reports assistant media metadata when the process clock is outside the Date range", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    try {
      await withAllowedAssistantMediaRoot({
        prefix: "ui-media-bad-clock-",
        fn: async (tmpRoot) => {
          const filePath = path.join(tmpRoot, "photo.png");
          await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
          const { res, handled, end } = await runAssistantMediaRequest({
            url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
            method: "GET",
            auth: { mode: "token", token: "test-token", allowTailscale: false },
          });
          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          const payload = responseJson(end) as {
            available?: boolean;
            mediaTicket?: string;
            mediaTicketExpiresAt?: string;
          };
          expect(payload.available).toBe(true);
          expect(payload.mediaTicket).toBeUndefined();
          expect(payload.mediaTicketExpiresAt).toBeUndefined();
        },
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("serves assistant local media with a scoped media ticket after metadata auth", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-ticket-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const meta = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
          headers: {
            authorization: "Bearer test-token",
          },
        });
        const payload = responseJson(meta.end) as {
          mediaTicket?: string;
        };
        expect(meta.handled).toBe(true);
        expect(meta.res.statusCode).toBe(200);
        expect(payload.mediaTicket).toMatch(/^v1\./);

        const media = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(media.handled).toBe(true);
        expect(media.res.statusCode).toBe(200);

        const shortenedTicket = payload.mediaTicket?.slice(0, -1) ?? "";
        const rejected = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&mediaTicket=${encodeURIComponent(shortenedTicket)}`,
          method: "GET",
          auth: { mode: "token", token: "test-auth-token", allowTailscale: false },
        });
        expect(rejected.handled).toBe(true);
        expect(rejected.res.statusCode).toBe(401);
      },
    });
  });

  it("does not refresh assistant media tickets without operator auth", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-ticket-refresh-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const meta = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
          headers: {
            authorization: "Bearer test-token",
          },
        });
        const payload = responseJson(meta.end) as {
          mediaTicket?: string;
        };

        const refresh = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(refresh.handled).toBe(true);
        expect(refresh.res.statusCode).toBe(401);
        expect(responseBody(refresh.end)).toContain("Unauthorized");
      },
    });
  });

  it("rejects assistant local media with an invalid scoped media ticket", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-ticket-invalid-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&mediaTicket=v1.invalid.invalid`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(responseBody(end)).toContain("Unauthorized");
      },
    });
  });

  it("reports assistant local media availability failures with a reason", async () => {
    const { res, handled, end } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent("/Users/test/Documents/private.pdf")}&token=test-token`,
      method: "GET",
      auth: { mode: "token", token: "test-token", allowTailscale: false },
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(end)).toEqual({
      available: false,
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      retryable: false,
      canAllow: true,
    });
  });

  it("rejects assistant local media without a valid auth token when auth is enabled", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-auth-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`,
          method: "GET",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(responseBody(end)).toContain("Unauthorized");
      },
    });
  });

  it("accepts paired operator device tokens on assistant media requests", async () => {
    await withPairedOperatorDeviceToken({
      fn: async (operatorToken) => {
        await withAllowedAssistantMediaRoot({
          prefix: "ui-media-device-token-",
          fn: async (tmpRoot) => {
            const filePath = path.join(tmpRoot, "photo.png");
            await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
            const { res, handled } = await runAssistantMediaRequest({
              url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`,
              method: "GET",
              auth: { mode: "token", token: "shared-token", allowTailscale: false },
              headers: {
                authorization: `Bearer ${operatorToken}`,
              },
            });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
          },
        });
      },
    });
  });

  it("accepts shared-gateway issuer tagged device tokens on assistant media requests", async () => {
    const auth = {
      mode: "token",
      token: "shared-token",
      allowTailscale: false,
    } satisfies ResolvedGatewayAuth;
    const issuerGeneration = resolveSharedGatewaySessionGeneration(auth);
    expect(typeof issuerGeneration).toBe("string");
    await withPairedOperatorDeviceToken({
      issuerGeneration,
      browserMetadata: true,
      fn: async (operatorToken) => {
        await withAllowedAssistantMediaRoot({
          prefix: "ui-media-issued-device-token-",
          fn: async (tmpRoot) => {
            const filePath = path.join(tmpRoot, "photo.png");
            await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
            const { res, handled } = await runAssistantMediaRequest({
              url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`,
              method: "GET",
              auth,
              headers: {
                authorization: `Bearer ${operatorToken}`,
              },
            });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
          },
        });
      },
    });
  });

  it("accepts paired operator device tokens in assistant media query auth", async () => {
    await withPairedOperatorDeviceToken({
      fn: async (operatorToken) => {
        await withAllowedAssistantMediaRoot({
          prefix: "ui-media-device-token-query-",
          fn: async (tmpRoot) => {
            const filePath = path.join(tmpRoot, "photo.png");
            await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
            const { res, handled } = await runAssistantMediaRequest({
              url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=${encodeURIComponent(operatorToken)}`,
              method: "GET",
              auth: { mode: "token", token: "shared-token", allowTailscale: false },
            });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
          },
        });
      },
    });
  });

  it("rejects trusted-proxy assistant media requests from disallowed browser origins", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-proxy-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runTrustedProxyAssistantMediaRequest({
          filePath,
          headers: {
            origin: "https://evil.example",
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(responseBody(end)).toContain("Unauthorized");
      },
    });
  });

  it("rejects trusted-proxy assistant media file reads without operator.read scope", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-scope-file-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runTrustedProxyAssistantMediaRequest({
          filePath,
          headers: {
            "x-openclaw-scopes": "operator.approvals",
          },
        });
        expectMissingOperatorReadResponse({ handled, res, end });
      },
    });
  });

  it("rejects trusted-proxy assistant media metadata requests with an empty scope set", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-scope-meta-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runTrustedProxyAssistantMediaRequest({
          filePath,
          meta: true,
          headers: {
            "x-openclaw-scopes": "",
          },
        });
        expectMissingOperatorReadResponse({ handled, res, end });
      },
    });
  });

  it("includes CSP hash for inline scripts in index.html", async () => {
    const scriptContent = "(function(){ var x = 1; })();";
    const html = `<html><head><script>${scriptContent}</script></head><body></body></html>\n`;
    const expectedHash = createHash("sha256").update(scriptContent, "utf8").digest("base64");
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, setHeader } = makeMockHttpResponse();
        await handleControlUiHttpRequest(
          { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
          res,
          { root: { kind: "resolved", path: tmp } },
        );
        const cspCalls = setHeader.mock.calls.filter(
          (call) => call[0] === "Content-Security-Policy",
        );
        const lastCsp = String(cspCalls[cspCalls.length - 1]?.[1] ?? "");
        expect(lastCsp).toContain(`'sha256-${expectedHash}'`);
        expect(lastCsp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      },
    });
  });

  it("does not inject inline scripts into index.html", async () => {
    const html = "<html><head></head><body>Hello</body></html>\n";
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [
                  {
                    id: "main",
                    identity: { name: "</script><script>alert(1)//", avatar: "evil.png" },
                  },
                ],
              },
            },
          },
        );
        expect(handled).toBe(true);
        expect(end).toHaveBeenCalledWith(
          html.replace(
            "<html",
            '<html data-openclaw-control-ui-base-path="" data-openclaw-terminal-enabled="true"',
          ),
        );
      },
    });
  });

  it("exposes only the environment identity on public HTML while bootstrap stays authenticated", async () => {
    await withControlUiRoot({
      indexHtml: "<html><head></head><body>Hello</body></html>\n",
      fn: async (tmp) => {
        const config: OpenClawConfig = {
          gateway: { controlUi: { environment: { label: "edge & team", color: "amber" } } },
        };
        const auth = { mode: "token" as const, token: "test-token", allowTailscale: false };
        const documentResponse = makeMockHttpResponse();
        await handleControlUiHttpRequest(
          { url: "/", method: "GET", headers: {} } as IncomingMessage,
          documentResponse.res,
          { root: { kind: "resolved", path: tmp }, config, auth },
        );

        expect(documentResponse.res.statusCode).toBe(200);
        expect(responseBody(documentResponse.end)).toContain(
          'data-openclaw-environment="{&quot;label&quot;:&quot;edge &amp; team&quot;,&quot;color&quot;:&quot;amber&quot;}"',
        );

        const bootstrapResponse = await runBootstrapConfigRequest({ rootPath: tmp, config, auth });
        expect(bootstrapResponse.res.statusCode).toBe(401);
      },
    });
  });

  it("rewrites public asset hrefs in index.html when Control UI uses a configured base path (#94157)", async () => {
    const html =
      '<html><head><link rel="manifest" href="/manifest.webmanifest" /><link rel="icon" href="/favicon.svg" /></head><body></body></html>\n';
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          {
            url: "/openclaw/chat",
            method: "GET",
            headers: { host: "gateway.example.test" },
          } as IncomingMessage,
          res,
          {
            basePath: "/openclaw",
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        const body = String(end.mock.calls[0]?.[0] ?? "");
        expect(body).toContain('data-openclaw-control-ui-base-path="/openclaw"');
        expect(body).toContain('href="/openclaw/manifest.webmanifest"');
        expect(body).toContain('href="/openclaw/favicon.svg"');
        expect(body).not.toContain('href="/manifest.webmanifest"');
      },
    });
  });

  it.each([
    {
      name: "root-mounted focus routes",
      requestPath: "/focus/dashboard/roboclaw/session-ref",
      basePath: undefined,
      expectedResourceBasePath: "",
    },
    {
      name: "base-mounted focus routes",
      requestPath: "/openclaw/focus/desktop/control",
      basePath: "/openclaw",
      expectedResourceBasePath: "/openclaw",
    },
    {
      name: "root-mounted ordinary deep routes",
      requestPath: "/settings/approvals",
      basePath: undefined,
      expectedResourceBasePath: "",
    },
    {
      name: "root-mounted application namespace routes",
      requestPath: "/__openclaw__/new",
      basePath: undefined,
      expectedResourceBasePath: "",
    },
    {
      name: "base-mounted ordinary deep routes",
      requestPath: "/openclaw/settings/approvals",
      basePath: "/openclaw",
      expectedResourceBasePath: "/openclaw",
    },
  ])(
    "anchors Vite-relative asset references for $name",
    async ({ requestPath, basePath, expectedResourceBasePath }) => {
      const emittedAssets = [
        ["index.js", "index-js\n", "application/javascript; charset=utf-8"],
        ["runtime.js", "runtime-js\n", "application/javascript; charset=utf-8"],
        ["index.css", "index-css\n", "text/css; charset=utf-8"],
      ] as const;
      const publicAssets = [
        "favicon.svg",
        "favicon-32.png",
        "apple-touch-icon.png",
        "manifest.webmanifest",
      ];
      const html = `<html><head>${publicAssets
        .map((asset) => `<link href="./${asset}" />`)
        .join(
          "",
        )}<link rel="modulepreload" href="./assets/runtime.js" /><link rel="stylesheet" href="./assets/index.css" /></head><body><script type="module" src="./assets/index.js"></script></body></html>\n`;

      await withControlUiRoot({
        indexHtml: html,
        fn: async (tmp) => {
          await fs.mkdir(path.join(tmp, "assets"));
          for (const [asset, content] of emittedAssets) {
            await fs.writeFile(path.join(tmp, "assets", asset), content);
          }
          const { res, end } = makeMockHttpResponse();
          const handled = await handleControlUiHttpRequest(
            {
              url: requestPath,
              method: "GET",
              headers: { host: "gateway.example.test" },
            } as IncomingMessage,
            res,
            {
              ...(basePath ? { basePath } : {}),
              root: { kind: "resolved", path: tmp },
            },
          );

          expect(handled).toBe(true);
          const body = String(end.mock.calls[0]?.[0] ?? "");
          expect(body).toContain(
            `data-openclaw-control-ui-base-path="${expectedResourceBasePath}"`,
          );
          for (const asset of publicAssets) {
            expect(body).toContain(`href="${expectedResourceBasePath}/${asset}"`);
            expect(body).not.toContain(`href="./${asset}"`);
          }
          expect(body).toContain(`src="${expectedResourceBasePath}/assets/index.js"`);
          expect(body).toContain(`href="${expectedResourceBasePath}/assets/runtime.js"`);
          expect(body).toContain(`href="${expectedResourceBasePath}/assets/index.css"`);
          expect(body).not.toContain('="./assets/');
          expect(body).not.toContain(`${requestPath}/assets/`);

          const emittedAssetUrls = Array.from(
            body.matchAll(/(?:src|href)="([^" ]*\/assets\/[^" ]+)"/g),
          ).flatMap((match) => (match[1] ? [match[1]] : []));
          expect(new Set(emittedAssetUrls)).toEqual(
            new Set(emittedAssets.map(([asset]) => `${expectedResourceBasePath}/assets/${asset}`)),
          );
          for (const url of emittedAssetUrls) {
            const emittedAsset = emittedAssets.find(([asset]) => url.endsWith(`/${asset}`));
            expect(emittedAsset).toBeDefined();
            const [, content, contentType] = emittedAsset!;
            const response = await runControlUiRequest({
              url,
              method: "GET",
              rootPath: tmp,
              basePath,
            });
            expect(response.handled).toBe(true);
            expect(responseBody(response.end)).toBe(content);
            expect(response.setHeader).toHaveBeenCalledWith("Content-Type", contentType);
          }
        },
      });
    },
  );

  it("serves bootstrap config JSON", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [
                  {
                    id: "roboclaw",
                    default: true,
                    workspace: tmp,
                    identity: {
                      name: "</script><script>alert(1)//",
                      avatar: "</script>.png",
                    },
                  },
                ],
              },
              ui: { seamColor: "#1A2b3C" },
              gateway: {
                cliAgents: { enabled: true },
                controlUi: { environment: { label: "edge", color: "amber" } },
              },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantName).toBe("</script><script>alert(1)//");
        expect(parsed.assistantAvatar).toBe("A");
        expect(parsed.assistantAvatarStatus).toBe("none");
        expect(parsed.assistantAvatarReason).toBe("missing");
        expect(parsed.assistantAgentId).toBe("roboclaw");
        expect(parsed.seamColor).toBe("#1A2b3C");
        expect(parsed.environment).toEqual({ label: "edge", color: "amber" });
        expect(parsed.terminalEnabled).toBe(true);
        expect(parsed.cliAgentsEnabled).toBe(true);
        expect(parsed.automaticallyFetchFavicons).toBe(true);
        expect(parsed.communityInvite).toBe(true);
        expect(parsed.devGitBranch).toBeUndefined();
        expect(Array.isArray(parsed.localMediaPreviewRoots)).toBe(true);
      },
    });
  });

  it.each(["automaticallyFetchFavicons", "communityInvite"] as const)(
    "projects an explicit %s opt-out into bootstrap config",
    async (key) => {
      await withControlUiRoot({
        fn: async (tmp) => {
          const { res, end } = makeMockHttpResponse();
          const handled = await handleControlUiHttpRequest(
            { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: {
                gateway: { controlUi: { [key]: false } },
              },
            },
          );

          expect(handled).toBe(true);
          expect(parseBootstrapPayload(end)[key]).toBe(false);
        },
      });
    },
  );

  it("omits the assistant agent id without a config snapshot", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          { root: { kind: "resolved", path: tmp } },
        );

        expect(handled).toBe(true);
        expect(parseBootstrapPayload(end)).not.toHaveProperty("assistantAgentId");
      },
    });
  });

  it("includes the dev checkout branch in bootstrap config", async () => {
    devInstallBranchMock.branch = "feat/dev-branch-badge";
    try {
      await withControlUiRoot({
        fn: async (tmp) => {
          const { res, end } = makeMockHttpResponse();
          const handled = await handleControlUiHttpRequest(
            { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
            res,
            { root: { kind: "resolved", path: tmp }, config: {} },
          );
          expect(handled).toBe(true);
          expect(parseBootstrapPayload(end).devGitBranch).toBe("feat/dev-branch-badge");
        },
      });
    } finally {
      devInstallBranchMock.branch = null;
    }
  });

  it("routes a workspace-local assistant avatar separately from bootstrap config", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await fs.writeFile(path.join(tmp, "avatar.png"), REAL_PNG);
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", workspace: tmp, identity: { avatar: "avatar.png" } }],
              },
            },
          },
        );

        expect(handled).toBe(true);
        expect(parseBootstrapPayload(end)).toMatchObject({
          assistantAvatar: expect.stringMatching(/^\/avatar\/main\?v=[a-f0-9]+$/),
          assistantAvatarSource: "avatar.png",
          assistantAvatarStatus: "local",
        });
      },
    });
  });

  it.each(["", "/openclaw"])(
    "keeps a maximum-size local avatar out of bootstrap at %s",
    async (basePath) => {
      await withControlUiRoot({
        fn: async (tmp) => {
          const avatar = Buffer.concat([
            REAL_PNG,
            Buffer.alloc(AVATAR_MAX_BYTES - REAL_PNG.length),
          ]);
          await fs.writeFile(path.join(tmp, "avatar.png"), avatar);
          const config = createAvatarConfig(tmp, "avatar.png");
          const auth = { mode: "token" as const, token: "test-token", allowTailscale: false };
          const headers = { authorization: "Bearer test-token" };
          const request = { rootPath: tmp, basePath, auth, headers, config };
          const { res, end } = await runBootstrapConfigRequest(request);
          expect(res.statusCode).toBe(200);
          const parsed = parseBootstrapPayload(end);
          expect(responseBody(end).length).toBeLessThan(4096);
          expect(parsed.assistantAvatar).toMatch(
            new RegExp(`^${basePath}/avatar/main\\?v=[a-f0-9]+$`),
          );
          expect(normalizeAssistantIdentity({ avatar: parsed.assistantAvatar }).avatar).toBe(
            parsed.assistantAvatar,
          );
          const denied = await runAvatarRequest({
            url: parsed.assistantAvatar,
            method: "GET",
            basePath,
            config,
            auth,
          });
          expect(denied.res.statusCode).toBe(401);
          const image = await runAvatarRequest({
            url: parsed.assistantAvatar,
            method: "GET",
            basePath,
            config,
            auth,
            headers,
          });
          expect(image.res.statusCode).toBe(200);
          const imageBytes = image.end.mock.calls[0]?.[0];
          expect(Buffer.isBuffer(imageBytes)).toBe(true);
          expect(imageBytes?.length).toBeLessThan(4096);
          const unchanged = await runBootstrapConfigRequest(request);
          expect(parseBootstrapPayload(unchanged.end).assistantAvatar).toBe(parsed.assistantAvatar);
          const replacementPath = path.join(tmp, "replacement.png");
          const previousStat = await fs.stat(path.join(tmp, "avatar.png"));
          await fs.writeFile(replacementPath, avatar);
          await fs.utimes(replacementPath, previousStat.atime, previousStat.mtime);
          await fs.rename(replacementPath, path.join(tmp, "avatar.png"));
          const replaced = await runBootstrapConfigRequest(request);
          expect(parseBootstrapPayload(replaced.end).assistantAvatar).not.toBe(
            parsed.assistantAvatar,
          );
        },
      });
    },
  );

  it("keeps an exact-cap IDENTITY.md data URL out of bootstrap", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const dataUrl = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
        expect(dataUrl).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
        await fs.writeFile(path.join(tmp, "IDENTITY.md"), `- Avatar: ${dataUrl}\n`);
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: { agents: { defaults: { workspace: tmp } } },
          },
        );

        expect(handled).toBe(true);
        expect(parseBootstrapPayload(end)).toMatchObject({
          assistantAvatar: expect.stringMatching(/^\/avatar\/main\?v=[a-f0-9]+$/),
          assistantAvatarStatus: "data",
        });
      },
    });
  });

  it("rejects an over-cap IDENTITY.md data URL in bootstrap without truncating it", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const exact = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
        const oversized = `${exact}A`;
        expect(oversized).toHaveLength(AVATAR_MAX_DATA_URL_CHARS + 1);
        await fs.writeFile(path.join(tmp, "IDENTITY.md"), `- Avatar: ${oversized}\n- Emoji: 🦞\n`);
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: { agents: { defaults: { workspace: tmp } } },
          },
        );

        expect(handled).toBe(true);
        expect(parseBootstrapPayload(end)).toMatchObject({
          assistantAvatar: "🦞",
          assistantAvatarSource: null,
          assistantAvatarStatus: null,
          assistantAvatarReason: null,
        });
      },
    });
  });

  it("preserves a configured emoji over a lower-priority IDENTITY.md avatar", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await fs.writeFile(path.join(tmp, "identity.png"), REAL_PNG);
        await fs.writeFile(path.join(tmp, "IDENTITY.md"), "- Avatar: identity.png\n");
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", workspace: tmp, identity: { emoji: "🦞" } }],
              },
            },
          },
        );

        expect(handled).toBe(true);
        expect(parseBootstrapPayload(end)).toMatchObject({
          assistantAvatar: "🦞",
          assistantAvatarSource: null,
          assistantAvatarStatus: null,
          assistantAvatarReason: null,
        });
      },
    });
  });

  it("reports a hardlinked bootstrap avatar as unreadable", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await fs.writeFile(path.join(tmp, "original.png"), REAL_PNG);
        await fs.link(path.join(tmp, "original.png"), path.join(tmp, "avatar.png"));
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: createAvatarConfig(tmp, "avatar.png"),
          },
        );

        expect(handled).toBe(true);
        expect(parseBootstrapPayload(end)).toMatchObject({
          assistantAvatar: "A",
          assistantAvatarSource: "avatar.png",
          assistantAvatarStatus: "none",
          assistantAvatarReason: "unreadable",
        });
      },
    });
  });

  it.each(["GET", "HEAD"])(
    "does not read assistant avatar bytes for bootstrap %s",
    async (method) => {
      await withControlUiRoot({
        fn: async (tmp) => {
          await fs.writeFile(path.join(tmp, "avatar.png"), REAL_PNG);
          const readSync = vi.spyOn(fsSync, "readSync");
          try {
            const { res, end } = makeMockHttpResponse();
            const handled = await handleControlUiHttpRequest(
              { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method } as IncomingMessage,
              res,
              {
                root: { kind: "resolved", path: tmp },
                config: {
                  agents: {
                    defaults: { workspace: tmp },
                    list: [{ id: "main", workspace: tmp, identity: { avatar: "avatar.png" } }],
                  },
                },
              },
            );

            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            if (method === "HEAD") {
              expect(end).toHaveBeenCalledWith();
            }
            expect(readSync).not.toHaveBeenCalled();
          } finally {
            readSync.mockRestore();
          }
        },
      });
    },
  );
  it("rejects bootstrap config requests without a valid auth token when auth is enabled", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await fs.writeFile(path.join(tmp, "avatar.png"), "avatar-bytes\n");
        const { res, handled, end } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(responseBody(end)).toContain("Unauthorized");
      },
    });
  });

  it("serves bootstrap config JSON when auth is enabled and the token is valid", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const rateLimiter = createAuthRateLimiterSpy();
        await fs.writeFile(path.join(tmp, "avatar.png"), "avatar-bytes\n");
        const { res, handled, end, setHeader } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: { mode: "token", token: "test-token", allowTailscale: false },
          headers: {
            authorization: "Bearer test-token",
          },
          config: {
            agents: {
              defaults: { workspace: tmp },
              list: [{ id: "main", identity: { avatar: "avatar.png" } }],
            },
          },
          rateLimiter,
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(setHeader.mock.calls.some(([name]) => name === "Set-Cookie")).toBe(false);
        const parsed = parseBootstrapPayload(end);
        expect(parsed).toMatchObject({
          assistantAgentId: "main",
          assistantAvatar: expect.stringMatching(/^\/avatar\/main\?v=[a-f0-9]+$/),
          assistantAvatarStatus: "local",
        });
        expect(rateLimiter.reset).toHaveBeenCalledWith(
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
        );
        expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalled();
      },
    });
  });

  it("penalizes both credential scopes when a Control UI read token is invalid", async () => {
    const tempHome = testTempDirs.make("openclaw-ui-invalid-token-");
    await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
      await withControlUiRoot({
        fn: async (tmp) => {
          const rateLimiter = createAuthRateLimiterSpy();
          const { res, handled, end } = await runBootstrapConfigRequest({
            rootPath: tmp,
            auth: { mode: "token", token: "shared-token", allowTailscale: false },
            headers: { authorization: "Bearer invalid-token" },
            rateLimiter,
          });

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(401);
          expect(responseJson(end)).toEqual({
            error: { message: "Unauthorized", type: "unauthorized" },
          });
          expect(rateLimiter.recordFailureAndDelay).toHaveBeenNthCalledWith(
            1,
            "127.0.0.1",
            AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
          );
          expect(rateLimiter.recordFailureAndDelay).toHaveBeenNthCalledWith(
            2,
            "127.0.0.1",
            AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
          );
          expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledTimes(2);
        },
      });
    });
  });

  it("penalizes a trusted-proxy local password mismatch only as a shared secret", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const rateLimiter = createAuthRateLimiterSpy();
        const { res, handled, end } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            password: "local-password",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          trustedProxies: ["127.0.0.1"],
          headers: {
            host: "localhost",
            authorization: "Bearer wrong-password",
          },
          rateLimiter,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(responseJson(end)).toEqual({
          error: { message: "Unauthorized", type: "unauthorized" },
        });
        expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledTimes(1);
        expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledWith(
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
        );
        expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalledWith(
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
        );
      },
    });
  });

  it("rejects a rate-limited Control UI read when no valid device token is presented", async () => {
    const tempHome = testTempDirs.make("openclaw-ui-rate-limited-token-");
    await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
      await withControlUiRoot({
        fn: async (tmp) => {
          const rateLimiter = createAuthRateLimiterSpy();
          rateLimiter.check.mockImplementation((_ip, scope) =>
            scope === AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET
              ? { allowed: false, remaining: 0, retryAfterMs: 2_500 }
              : { allowed: true, remaining: 10, retryAfterMs: 0 },
          );
          const auth: ResolvedGatewayAuth = {
            mode: "token",
            token: "shared-token",
            allowTailscale: false,
          };
          const { res, handled, end, setHeader } = await runBootstrapConfigRequest({
            rootPath: tmp,
            auth,
            headers: { authorization: "Bearer invalid-token" },
            rateLimiter,
          });

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(429);
          expect(responseJson(end)).toEqual({
            error: {
              message: "Too many failed authentication attempts. Please try again later.",
              type: "rate_limited",
            },
          });
          expect(setHeader).toHaveBeenCalledWith("Retry-After", "3");
          expect(rateLimiter.check).toHaveBeenNthCalledWith(
            1,
            "127.0.0.1",
            AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
          );
          expect(rateLimiter.check).toHaveBeenNthCalledWith(
            2,
            "127.0.0.1",
            AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
          );
          expect(rateLimiter.reset).not.toHaveBeenCalled();
          expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledTimes(1);
          expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledWith(
            "127.0.0.1",
            AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
          );
          expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalledWith(
            "127.0.0.1",
            AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
          );
        },
      });
    });
  });

  it("records a shared mismatch when the device-token scope is locked", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const rateLimiter = createAuthRateLimiterSpy();
        rateLimiter.check.mockImplementation((_ip, scope) =>
          scope === AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN
            ? { allowed: false, remaining: 0, retryAfterMs: 2_500 }
            : { allowed: true, remaining: 10, retryAfterMs: 0 },
        );
        const { res, handled, end, setHeader } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: { mode: "token", token: "shared-token", allowTailscale: false },
          headers: { authorization: "Bearer invalid-token" },
          rateLimiter,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(429);
        expect(responseJson(end)).toEqual({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        });
        expect(setHeader).toHaveBeenCalledWith("Retry-After", "3");
        expect(rateLimiter.check).toHaveBeenNthCalledWith(
          1,
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
        );
        expect(rateLimiter.check).toHaveBeenNthCalledWith(
          2,
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
        );
        expect(rateLimiter.reset).not.toHaveBeenCalled();
        expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledTimes(1);
        expect(rateLimiter.recordFailureAndDelay).toHaveBeenCalledWith(
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
        );
        expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalledWith(
          "127.0.0.1",
          AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
        );
      },
    });
  });

  it("sets least-privilege route-bound cookies for multiple external plugin tabs", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const registry = createEmptyPluginRegistry();
        registry.controlUiDescriptors.push({
          pluginId: "demo-plugin",
          source: "demo-plugin",
          descriptor: {
            surface: "tab",
            id: "demo",
            label: "Demo",
            path: "/secure-hook",
          },
        });
        registry.controlUiDescriptors.push({
          pluginId: "other-plugin",
          source: "other-plugin",
          descriptor: {
            surface: "tab",
            id: "other",
            label: "Other",
            path: "/other-hook/panel",
            requiredScopes: ["operator.read"],
          },
        });
        registry.httpRoutes.push({
          pluginId: "demo-plugin",
          source: "demo-plugin",
          path: "/secure-hook",
          auth: "gateway",
          match: "prefix",
          handler: async () => true,
        });
        registry.httpRoutes.push({
          pluginId: "other-plugin",
          source: "other-plugin",
          path: "/other-hook",
          auth: "gateway",
          match: "prefix",
          handler: async () => true,
        });
        setActivePluginRegistry(registry);

        const { res, handled, setHeader } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: { mode: "token", token: "test-token", allowTailscale: false },
          headers: {
            authorization: "Bearer test-token",
          },
          config: {
            agents: { defaults: { workspace: tmp } },
          },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const setCookie = setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
        expect(Array.isArray(setCookie)).toBe(true);
        const cookies = Array.isArray(setCookie) ? setCookie : [];
        expect(cookies).toHaveLength(2);
        const cookieNames = cookies.map((cookie) => String(cookie).split("=", 1)[0] ?? "");
        expect(new Set(cookieNames).size).toBe(2);
        expect(
          cookieNames.every((name) =>
            /^__openclaw_plugin_tab_auth_[0-9a-f]{16}_[0-9a-f]{64}$/.test(name),
          ),
        ).toBe(true);
        expect(cookies.map(String)).toEqual([
          expect.stringContaining("Path=/secure-hook"),
          expect.stringContaining("Path=/other-hook"),
        ]);
        expect(cookies.every((cookie) => String(cookie).includes("HttpOnly"))).toBe(true);
        expect(cookies.every((cookie) => String(cookie).includes("Secure"))).toBe(true);
        expect(cookies.every((cookie) => String(cookie).includes("SameSite=None"))).toBe(true);
        const payloads = cookies.map((cookie) => {
          const encoded = String(cookie).match(new RegExp("=v1\\.([^.]+)\\."))?.[1];
          return JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
        });
        expect(payloads).toMatchObject([
          {
            pluginId: "demo-plugin",
            path: "/secure-hook",
            scopes: ["operator.read"],
          },
          {
            pluginId: "other-plugin",
            path: "/other-hook",
            scopes: ["operator.read"],
          },
        ]);
      },
    });
  });

  it("acknowledges only plugin frame grants issued by bootstrap", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const registry = createEmptyPluginRegistry();
        registry.controlUiDescriptors.push({
          pluginId: "demo-plugin",
          source: "demo-plugin",
          descriptor: {
            surface: "tab",
            id: "demo",
            label: "Demo",
            path: "/secure-hook/panel",
          },
        });
        registry.httpRoutes.push({
          pluginId: "demo-plugin",
          source: "demo-plugin",
          path: "/secure-hook",
          auth: "gateway",
          match: "prefix",
          handler: async () => true,
        });
        setActivePluginRegistry(registry);

        const { end } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: { mode: "token", token: "test-auth-token", allowTailscale: false },
          headers: { authorization: "Bearer test-auth-token" },
        });

        expect(parseBootstrapPayload(end).pluginFrameGrants).toEqual([
          {
            pluginId: "demo-plugin",
            path: "/secure-hook",
            match: "prefix",
          },
        ]);
      },
    });
  });

  it("issues read-only plugin frame grants for Tailscale-authenticated bootstrap", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiDescriptors.push({
      pluginId: "demo-plugin",
      source: "demo-plugin",
      descriptor: {
        surface: "tab",
        id: "demo",
        label: "Demo",
        path: "/secure-hook/panel",
        requiredScopes: ["operator.admin"],
      },
    });
    registry.httpRoutes.push({
      pluginId: "demo-plugin",
      source: "demo-plugin",
      path: "/secure-hook",
      auth: "gateway",
      match: "prefix",
      handler: async () => true,
    });
    setActivePluginRegistry(registry);
    const { res, setHeader } = makeMockHttpResponse();

    expect(
      setControlUiPluginAuthCookieForRequest(
        { headers: {} } as IncomingMessage,
        res,
        "tailscale",
        true,
        "test-generation",
      ),
    ).toEqual([
      {
        pluginId: "demo-plugin",
        path: "/secure-hook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    expect(setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.arrayContaining([expect.stringContaining("Path=/secure-hook")]),
    );
  });

  it("serves bootstrap config JSON when paired device-token auth is valid", async () => {
    await withPairedOperatorDeviceToken({
      fn: async (operatorToken) => {
        await withControlUiRoot({
          fn: async (tmp) => {
            const rateLimiter = createAuthRateLimiterSpy();
            const { res, handled, end } = await runBootstrapConfigRequest({
              rootPath: tmp,
              auth: { mode: "token", token: "shared-token", allowTailscale: false },
              headers: {
                authorization: `Bearer ${operatorToken}`,
              },
              rateLimiter,
            });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            const parsed = parseBootstrapPayload(end);
            expect(parsed.assistantAgentId).toBeUndefined();
            expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalled();
            expect(rateLimiter.reset).toHaveBeenCalledWith(
              "127.0.0.1",
              AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
            );
            expect(rateLimiter.reset).not.toHaveBeenCalledWith(
              "127.0.0.1",
              AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
            );
          },
        });
      },
    });
  });

  it("rejects paired device-token bootstrap when team roles cannot bind a durable person", async () => {
    await withPairedOperatorDeviceToken({
      fn: async (operatorToken) => {
        await withControlUiRoot({
          fn: async (tmp) => {
            vi.spyOn(configIo, "getRuntimeConfig").mockReturnValue({
              gateway: {
                roles: {
                  default: "guest",
                  definitions: {
                    guest: {
                      sessions: { others: "view" },
                      agents: ["guest"],
                      scopes: ["operator.read"],
                    },
                  },
                },
              },
            });
            const { res, handled } = await runBootstrapConfigRequest({
              rootPath: tmp,
              auth: { mode: "token", token: "shared-token", allowTailscale: false },
              headers: { authorization: `Bearer ${operatorToken}` },
            });

            expect(handled).toBe(true);
            expect(res.statusCode).toBe(401);
          },
        });
      },
    });
  });

  it("serves paired device-token bootstrap while the shared-secret scope is locked", async () => {
    await withPairedOperatorDeviceToken({
      fn: async (operatorToken) => {
        await withControlUiRoot({
          fn: async (tmp) => {
            const rateLimiter = createAuthRateLimiterSpy();
            rateLimiter.check.mockImplementation((_ip, scope) =>
              scope === AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET
                ? { allowed: false, remaining: 0, retryAfterMs: 2_500 }
                : { allowed: true, remaining: 10, retryAfterMs: 0 },
            );
            const { res, handled, end } = await runBootstrapConfigRequest({
              rootPath: tmp,
              auth: { mode: "token", token: "shared-token", allowTailscale: false },
              headers: { authorization: `Bearer ${operatorToken}` },
              rateLimiter,
            });

            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(parseBootstrapPayload(end).assistantAgentId).toBeUndefined();
            expect(rateLimiter.check).toHaveBeenNthCalledWith(
              1,
              "127.0.0.1",
              AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
            );
            expect(rateLimiter.check).toHaveBeenNthCalledWith(
              2,
              "127.0.0.1",
              AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
            );
            expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalled();
            expect(rateLimiter.reset).toHaveBeenCalledWith(
              "127.0.0.1",
              AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
            );
            expect(rateLimiter.reset).not.toHaveBeenCalledWith(
              "127.0.0.1",
              AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
            );
          },
        });
      },
    });
  });

  it("rejects unattributable proxy ingress before bootstrap device-token fallback", async () => {
    const rateLimiter = createAuthRateLimiter({
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });

    try {
      await withPairedOperatorDeviceToken({
        fn: async (operatorToken) => {
          await withControlUiRoot({
            fn: async (tmp) => {
              const sendBootstrap = async (token: string) =>
                await runBootstrapConfigRequest({
                  rootPath: tmp,
                  auth: { mode: "token", token: "shared", allowTailscale: false },
                  headers: {
                    authorization: `Bearer ${token}`,
                    forwarded: "for=203.0.113.10",
                  },
                  rateLimiter,
                });

              expect((await sendBootstrap(operatorToken)).res.statusCode).toBe(403);
              expect((await sendBootstrap("wrong-one")).res.statusCode).toBe(403);
            },
          });
        },
      });
    } finally {
      rateLimiter.dispose();
    }
  });

  it("selects higher-scope frame tabs using paired device-token scopes", async () => {
    await withScopedPairedOperatorDevice({
      scopes: ["operator.read", "operator.admin"],
      fn: async (operatorToken) => {
        await withControlUiRoot({
          fn: async (tmp) => {
            const registry = createEmptyPluginRegistry();
            registry.controlUiDescriptors.push({
              pluginId: "admin-plugin",
              source: "admin-plugin",
              descriptor: {
                surface: "tab",
                id: "admin",
                label: "Admin",
                path: "/admin-hook/panel",
                requiredScopes: ["operator.admin"],
              },
            });
            registry.httpRoutes.push({
              pluginId: "admin-plugin",
              source: "admin-plugin",
              path: "/admin-hook",
              auth: "gateway",
              match: "prefix",
              handler: async () => true,
            });
            setActivePluginRegistry(registry);

            const { end } = await runBootstrapConfigRequest({
              rootPath: tmp,
              auth: { mode: "token", token: "test-auth-token", allowTailscale: false },
              headers: { authorization: `Bearer ${operatorToken}` },
            });
            expect(parseBootstrapPayload(end).pluginFrameGrants).toEqual([
              {
                pluginId: "admin-plugin",
                path: "/admin-hook",
                match: "prefix",
              },
            ]);
          },
        });
      },
    });
  });

  it("serves bootstrap config JSON under basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, method: "GET" } as IncomingMessage,
          res,
          {
            basePath: "/openclaw",
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", identity: { name: "Ops", avatar: "ops.png" } }],
              },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("/openclaw");
        expect(parsed.assistantName).toBe("Ops");
        expect(parsed.assistantAvatar).toBe("A");
        expect(parsed.assistantAvatarStatus).toBe("none");
        expect(parsed.assistantAvatarReason).toBe("missing");
        expect(parsed.assistantAgentId).toBe("main");
        expect(Array.isArray(parsed.localMediaPreviewRoots)).toBe(true);
      },
    });
  });

  it("serves bootstrap config under the configured /__openclaw__ basePath (#66946)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          {
            url: "/__openclaw__/control-ui-config.json",
            method: "GET",
          } as IncomingMessage,
          res,
          {
            basePath: "/__openclaw__",
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", identity: { name: "Ops", avatar: "ops.png" } }],
              },
            },
          },
        );
        expect(handled).toBe(true);
        expect(res.statusCode).not.toBe(404);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("/__openclaw__");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  // Real reported scenario: the gateway has NO configured `gateway.controlUi.basePath`,
  // so the SPA is served at the default `/__openclaw__/` namespace. The browser opens
  // the default entry, `inferBasePathFromPathname("/__openclaw__/")` yields `/__openclaw__`,
  // and the loader fetches `/__openclaw__/control-ui-config.json`. Before this fix the
  // gateway only matched the bare `/control-ui-config.json` for an empty base path, so the
  // default-entry request 404ed (issue #66946). This case fails without the namespace alias.
  it("serves bootstrap config at the default /__openclaw__ entry with no configured basePath (#66946)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          {
            url: "/__openclaw__/control-ui-config.json",
            method: "GET",
          } as IncomingMessage,
          res,
          {
            // No basePath: simulates the default deployment from the issue report.
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", identity: { name: "Ops", avatar: "ops.png" } }],
              },
            },
          },
        );
        expect(handled).toBe(true);
        expect(res.statusCode).not.toBe(404);
        const parsed = parseBootstrapPayload(end);
        // Configured base path is empty, so the payload reports "" (the loader keeps
        // its own inferred base path; it does not read this field back for the fetch).
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("still serves bootstrap config at the bare /control-ui-config.json for compatibility (#66946)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, handled, end } = await runBootstrapConfigRequest({ rootPath: tmp });
        expect(handled).toBe(true);
        expect(res.statusCode).not.toBe(404);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantAgentId).toBeUndefined();
      },
    });
  });

  // Compatibility regression: current main and v2026.6.1 serve and document the
  // single-underscore `/__openclaw/control-ui-config.json` endpoint under an empty
  // base path. #66946 makes the config path base-path-relative; this case proves
  // the old documented endpoint still returns config (no upgrade 404 break).
  // Without the LEGACY_BOOTSTRAP_CONFIG_PATH alias this request 404s, so it is not
  // vacuous.
  it("still serves bootstrap config at the legacy /__openclaw/control-ui-config.json with no configured basePath (#66946)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          {
            url: "/__openclaw/control-ui-config.json",
            method: "GET",
          } as IncomingMessage,
          res,
          {
            // No basePath: matches the legacy default deployment that documented
            // and served the single-underscore endpoint.
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", identity: { name: "Ops", avatar: "ops.png" } }],
              },
            },
          },
        );
        expect(handled).toBe(true);
        expect(res.statusCode).not.toBe(404);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  // Compatibility regression for configured-base-path deployments: when a
  // `gateway.controlUi.basePath` is set (e.g. `/openclaw`), current main and
  // v2026.6.1 serve the bootstrap config at `${basePath}/__openclaw/control-ui-config.json`
  // (single underscore). #66946 moves the canonical path to
  // `${basePath}/control-ui-config.json`; this case proves the old configured-base-path
  // endpoint still returns config so older bundles and proxies that still request it
  // do not 404 after upgrade. Without the configured-base-path legacy alias this
  // request 404s, so the assertion is not vacuous.
  it("still serves bootstrap config at the legacy ${basePath}/__openclaw/control-ui-config.json under a configured basePath (#66946)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          {
            url: "/openclaw/__openclaw/control-ui-config.json",
            method: "GET",
          } as IncomingMessage,
          res,
          {
            basePath: "/openclaw",
            root: { kind: "resolved", path: tmp },
            config: {
              agents: {
                defaults: { workspace: tmp },
                list: [{ id: "main", identity: { name: "Ops", avatar: "ops.png" } }],
              },
            },
          },
        );
        expect(handled).toBe(true);
        expect(res.statusCode).not.toBe(404);
        const parsed = parseBootstrapPayload(end);
        // The configured base path is reported back so the loader resolves
        // base-path-relative URLs against it.
        expect(parsed.basePath).toBe("/openclaw");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("does not serve bootstrap config from the doubled /__openclaw__/__openclaw path (#66946)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, handled } = await runControlUiRequest({
          url: "/__openclaw__/__openclaw/control-ui-config.json",
          method: "GET",
          rootPath: tmp,
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("serves local avatar bytes through hardened avatar handler", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-http-");
    try {
      const avatarPath = path.join(tmp, "main.png");
      await fs.writeFile(avatarPath, "avatar-bytes\n");

      const { res, end, handled } = await runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        config: createAvatarConfig(tmp, "main.png"),
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(responseBody(end)).toBe("avatar-bytes\n");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "PNG", filename: "avatar.png", contentType: "image/png" },
    { name: "JPEG", filename: "avatar.jpg", contentType: "image/jpeg" },
    { name: "GIF", filename: "avatar.gif", contentType: "image/gif" },
    { name: "WebP", filename: "avatar.webp", contentType: "image/webp" },
    { name: "SVG", filename: "avatar.svg", contentType: "image/svg+xml" },
  ])(
    "preserves the pinned $name avatar byte length and metadata on HEAD",
    async ({ contentType, filename }) => {
      const tmp = testTempDirs.make("openclaw-avatar-head-metadata-");
      const body = Buffer.from(`avatar 東京 ${filename}\n`, "utf8");
      const read = vi.spyOn(fsSync, "read");
      const closeSync = vi.spyOn(fsSync, "closeSync");
      try {
        await fs.writeFile(path.join(tmp, filename), body);
        const config = createAvatarConfig(tmp, filename);
        const head = await runAvatarRequest({ url: "/avatar/main", method: "HEAD", config });

        expect(head.handled).toBe(true);
        expect(head.res.statusCode).toBe(200);
        expect(head.setHeader).toHaveBeenCalledWith("Content-Length", String(body.byteLength));
        expect(head.setHeader).toHaveBeenCalledWith("Content-Type", contentType);
        expect(head.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
        expect(head.end).toHaveBeenCalledWith();
        expect(read).not.toHaveBeenCalled();
        expect(closeSync).toHaveBeenCalledOnce();

        const get = await runAvatarRequest({ url: "/avatar/main", method: "GET", config });
        expect(get.res.statusCode).toBe(200);
        expect(get.end).toHaveBeenCalledWith(body);
        expect(get.setHeader).toHaveBeenCalledWith("Content-Type", contentType);
        expect(get.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
        expect(get.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
      } finally {
        read.mockRestore();
        closeSync.mockRestore();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each(["", "/openclaw"])(
    "preserves authenticated avatar HEAD length under the %s Control UI base path",
    async (basePath) => {
      const tmp = testTempDirs.make("openclaw-avatar-head-base-");
      const body = Buffer.from("authenticated avatar 東京", "utf8");
      try {
        await fs.writeFile(path.join(tmp, "main.png"), body);
        const response = await runAvatarRequest({
          url: `${basePath}/avatar/main`,
          method: "HEAD",
          config: createAvatarConfig(tmp, "main.png"),
          ...(basePath ? { basePath } : {}),
          auth: { mode: "token", token: "test-token", allowTailscale: false },
          headers: { authorization: "Bearer test-token" },
        });

        expect(response.handled).toBe(true);
        expect(response.res.statusCode).toBe(200);
        expect(response.setHeader).toHaveBeenCalledWith("Content-Length", String(body.byteLength));
        expect(response.end).toHaveBeenCalledWith();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it("does not expose avatar HEAD representation length before authentication", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-head-unauthorized-");
    try {
      await fs.writeFile(path.join(tmp, "main.png"), REAL_PNG);
      const response = await runAvatarRequest({
        url: "/avatar/main",
        method: "HEAD",
        config: createAvatarConfig(tmp, "main.png"),
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      });

      expect(response.handled).toBe(true);
      expect(response.res.statusCode).toBe(401);
      expect(response.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ["metadata", "/avatar/main?meta=1", "GET"],
    ["HEAD", "/avatar/main", "HEAD"],
  ] as const)(
    "validates %s avatar requests without reading bytes and closes the descriptor",
    async (_name, url, method) => {
      const tmp = testTempDirs.make("openclaw-avatar-no-read-");
      const read = vi.spyOn(fsSync, "read");
      const closeSync = vi.spyOn(fsSync, "closeSync");
      try {
        await fs.writeFile(path.join(tmp, "main.png"), REAL_PNG);
        const { res, handled } = await runAvatarRequest({
          url,
          method,
          config: createAvatarConfig(tmp, "main.png"),
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(read).not.toHaveBeenCalled();
        expect(closeSync).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
        closeSync.mockRestore();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it("rejects hardlinked avatar bytes and reports matching metadata", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-http-hardlink-");
    try {
      await fs.writeFile(path.join(tmp, "original.png"), REAL_PNG);
      await fs.link(path.join(tmp, "original.png"), path.join(tmp, "avatar.png"));
      const config = createAvatarConfig(tmp, "avatar.png");

      expectNotFoundResponse(
        await runAvatarRequest({ url: "/avatar/main", method: "GET", config }),
      );
      const meta = await runAvatarRequest({
        url: "/avatar/main?meta=1",
        method: "GET",
        config,
      });
      expect(meta.handled).toBe(true);
      expect(meta.res.statusCode).toBe(200);
      expect(responseJson(meta.end)).toEqual({
        avatarUrl: null,
        avatarSource: "avatar.png",
        avatarStatus: "none",
        avatarReason: "unreadable",
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("bounds an avatar route file that grows after its descriptor is pinned", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-http-growth-");
    const avatarPath = path.join(tmp, "avatar.png");
    try {
      await fs.writeFile(avatarPath, REAL_PNG);
      const fstatSync = growAvatarAfterPinnedOpen(avatarPath);
      try {
        expectNotFoundResponse(
          await runAvatarRequest({
            url: "/avatar/main",
            method: "GET",
            config: createAvatarConfig(tmp, "avatar.png"),
          }),
        );
      } finally {
        fstatSync.mockRestore();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects avatar symlink paths from resolver", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "outside-secret\n");
      const linkPath = path.join(tmp, "avatar-link.png");
      await fs.symlink(outsideFile, linkPath);

      const { res, end, handled } = await runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        config: createAvatarConfig(tmp, "avatar-link.png"),
      });

      expectNotFoundResponse({ handled, res, end });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("serves local avatar bytes when auth is enabled and the token is valid", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-auth-"));
    try {
      const avatarPath = path.join(tmp, "main.png");
      await fs.writeFile(avatarPath, "avatar-bytes\n");

      const { res, handled } = await runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        config: createAvatarConfig(tmp, "main.png"),
        auth: { mode: "token", token: "test-token", allowTailscale: false },
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves local avatar bytes when paired device-token auth is valid", async () => {
    await withPairedOperatorDeviceToken({
      fn: async (operatorToken) => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-device-token-"));
        try {
          const avatarPath = path.join(tmp, "main.png");
          await fs.writeFile(avatarPath, "avatar-bytes\n");

          const { res, handled, end } = await runAvatarRequest({
            url: "/avatar/main",
            method: "GET",
            config: createAvatarConfig(tmp, "main.png"),
            auth: { mode: "token", token: "shared-token", allowTailscale: false },
            headers: {
              authorization: `Bearer ${operatorToken}`,
            },
          });

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(responseBody(end)).toBe("avatar-bytes\n");
        } finally {
          await fs.rm(tmp, { recursive: true, force: true });
        }
      },
    });
  });

  it("returns avatar metadata when auth is enabled and the token is valid", async () => {
    const { res, end, handled } = await runAvatarRequest({
      url: "/avatar/main?meta=1",
      method: "GET",
      config: createAvatarConfig(os.tmpdir(), "https://example.com/avatar.png"),
      auth: { mode: "token", token: "test-token", allowTailscale: false },
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(end)).toEqual({
      avatarUrl: "https://example.com/avatar.png",
      avatarSource: "remote URL",
      avatarStatus: "remote",
      avatarReason: null,
    });
  });

  it("redacts unsafe avatar source values from metadata", async () => {
    const { res, end, handled } = await runAvatarRequest({
      url: "/avatar/main?meta=1",
      method: "GET",
      config: createAvatarConfig("/tmp/workspace", "/Users/test/private/avatar.png"),
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(end)).toEqual({
      avatarUrl: null,
      avatarSource: null,
      avatarStatus: "none",
      avatarReason: "outside_workspace",
    });
  });

  it("rejects avatar requests without a valid auth token when auth is enabled", async () => {
    const { res, handled, end } = await runAvatarRequest({
      url: "/avatar/main",
      method: "GET",
      config: createAvatarConfig(os.tmpdir(), "https://example.com/avatar.png"),
      auth: { mode: "token", token: "test-token", allowTailscale: false },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(responseBody(end)).toContain("Unauthorized");
  });

  it("rejects trusted-proxy avatar metadata requests without operator.read scope", async () => {
    const { res, handled, end } = await runTrustedProxyAvatarRequest({
      meta: true,
      headers: {
        "x-openclaw-scopes": "",
      },
    });

    expectMissingOperatorReadResponse({ handled, res, end });
  });

  it("rejects symlinked assets that resolve outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-outside-"));
        try {
          const outsideFile = path.join(outsideDir, "secret.txt");
          await fs.mkdir(assetsDir, { recursive: true });
          await fs.writeFile(outsideFile, "outside-secret\n");
          await fs.symlink(outsideFile, path.join(assetsDir, "leak.txt"));

          const { res, end } = makeMockHttpResponse();
          const handled = await handleControlUiHttpRequest(
            { url: "/assets/leak.txt", method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
            },
          );
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("allows symlinked assets that resolve inside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { assetsDir, filePath } = await writeAssetFile(tmp, "actual.txt", "inside-ok\n");
        await fs.symlink(filePath, path.join(assetsDir, "linked.txt"));

        const { res, end, handled } = await runControlUiRequest({
          url: "/assets/linked.txt",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(responseBody(end)).toBe("inside-ok\n");
      },
    });
  });

  it.each(["/", "/settings", "/assets/actual.txt"])(
    "serves a pinned small file in one asynchronous filesystem operation at %s",
    async (url) => {
      await withControlUiRoot({
        fn: async (tmp) => {
          await writeAssetFile(tmp, "actual.txt", "inside-ok\n");
          const requestScope = new AsyncLocalStorage<boolean>();
          let filesystemOperations = 0;
          const hook = createHook({
            init(_id, type) {
              if (type === "FSREQCALLBACK" && requestScope.getStore()) {
                filesystemOperations += 1;
              }
            },
          }).enable();
          try {
            const { res, end, handled } = await requestScope.run(true, () =>
              runControlUiRequest({ url, method: "GET", rootPath: tmp }),
            );
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(responseBody(end)).toContain(url.startsWith("/assets/") ? "inside-ok" : "<html");
            // Safe open already captured stat; a second queued metadata read adds
            // another event-loop wait before these bytes can reach the browser.
            expect(filesystemOperations).toBe(1);
          } finally {
            hook.disable();
          }
        },
      });
    },
  );

  it("bounds a static response by the size captured with its pinned descriptor", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { filePath } = await writeAssetFile(tmp, "actual.txt", "original");
        const fstat = fsSync.fstatSync;
        vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) => {
          const stat = fstat(fd);
          fsSync.appendFileSync(filePath, "-appended-after-open");
          return stat;
        });
        const { res, end } = await runControlUiRequest({
          url: "/assets/actual.txt",
          method: "GET",
          rootPath: tmp,
        });
        expect(res.statusCode).toBe(200);
        expect(responseBody(end)).toBe("original");
      },
    });
  });

  it("serves static assets without synchronous file reads", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");
        const readFileSync = vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
          throw new Error("readFileSync should not run on Control UI request path");
        });
        try {
          const { res, end, handled } = await runControlUiRequest({
            url: "/assets/actual.txt",
            method: "GET",
            rootPath: tmp,
          });

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(responseBody(end)).toBe("inside-ok\n");
        } finally {
          readFileSync.mockRestore();
        }
      },
    });
  });

  it("keeps JSON-Accept requests for explicit assets and plugin recovery routes", async () => {
    await withControlUiRoot({
      indexHtml: "<html><body>plugin-recovery</body></html>\n",
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

        const asset = await runControlUiRequest({
          url: "/assets/actual.txt",
          method: "GET",
          rootPath: tmp,
          headers: { accept: "application/json" },
        });
        expect(asset.handled).toBe(true);
        expect(asset.res.statusCode).toBe(200);
        expect(responseBody(asset.end)).toBe("inside-ok\n");

        const recovery = await runControlUiRequest({
          url: "/settings/plugins",
          method: "GET",
          rootPath: tmp,
          headers: { accept: "application/json" },
        });
        expect(recovery.handled).toBe(true);
        expect(recovery.res.statusCode).toBe(200);
        expect(responseBody(recovery.end)).toContain("plugin-recovery");
      },
    });
  });

  it("compresses bundled assets and caches them immutably", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const source = "console.log('compressed');\n".repeat(200);
        const { filePath } = await writeAssetFile(tmp, "app-AbCd1234.js", source);
        await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
        await fs.writeFile(`${filePath}.gz`, gzipSync(source));
        const closeSync = vi.spyOn(fsSync, "closeSync");

        try {
          const { res, end, setHeader, handled } = await runControlUiRequest({
            url: "/assets/app-AbCd1234.js",
            method: "GET",
            rootPath: tmp,
            rootKind: "bundled",
            headers: { "accept-encoding": "gzip;q=0.5, br, identity;q=0.1" },
          });

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(setHeader).toHaveBeenCalledWith(
            "Cache-Control",
            "public, max-age=31536000, immutable",
          );
          expect(setHeader).toHaveBeenCalledWith("Vary", "Accept-Encoding");
          expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "br");
          const compressed = end.mock.calls[0]?.[0];
          expect(Buffer.isBuffer(compressed)).toBe(true);
          expect(brotliDecompressSync(compressed as Buffer).toString()).toBe(source);
          expect(closeSync.mock.invocationCallOrder.at(-1)).toBeLessThan(
            end.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
          );
        } finally {
          closeSync.mockRestore();
        }
      },
    });
  });

  it("serves build-time gzip variants when they are preferred", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const source = "console.log('gzip');\n".repeat(200);
        const { filePath } = await writeAssetFile(tmp, "app-EfGh5678.js", source);
        await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
        await fs.writeFile(`${filePath}.gz`, gzipSync(source));

        const { end, setHeader } = await runControlUiRequest({
          url: "/assets/app-EfGh5678.js",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
          headers: { "accept-encoding": "br;q=0.5, gzip, identity;q=0.1" },
        });

        expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
        expect(gunzipSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
      },
    });
  });

  it("serves a missing bundled asset from an exact retained generation", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const retainedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-retained-"));
        try {
          const source = "console.log('retained');\n".repeat(200);
          const { filePath } = await writeAssetFile(retainedRoot, "panel-OldBuild.js", source);
          await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
          const retainedAssets = {
            prepare: vi.fn(async () => {}),
            resolveAsset: vi.fn(() => ({
              filePath,
              rootPath: retainedRoot,
              rootRealPath: fsSync.realpathSync(retainedRoot),
            })),
          } satisfies ControlUiAssetRetention;

          const { end, setHeader } = await runControlUiRequest({
            url: "/assets/panel-OldBuild.js",
            method: "GET",
            rootPath: tmp,
            rootKind: "bundled",
            retainedAssets,
            headers: { "accept-encoding": "br, identity;q=0" },
          });

          expect(retainedAssets.resolveAsset).toHaveBeenCalledWith("assets/panel-OldBuild.js");
          expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "br");
          expect(brotliDecompressSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
        } finally {
          await fs.rm(retainedRoot, { recursive: true, force: true });
        }
      },
    });
  });

  it("accepts RFC qvalue boundary forms", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const source = "console.log('valid-qvalue');\n".repeat(200);
        const { filePath } = await writeAssetFile(tmp, "app-QvAl5678.js", source);
        await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
        await fs.writeFile(`${filePath}.gz`, gzipSync(source));
        const cases = [
          { quality: "0", fallbackQuality: "0.5", expected: "gzip" },
          { quality: "0.", fallbackQuality: "0.5", expected: "gzip" },
          { quality: "0.000", fallbackQuality: "0.5", expected: "gzip" },
          { quality: "0.123", fallbackQuality: "0.1", expected: "br" },
          { quality: "0.999", fallbackQuality: "0.5", expected: "br" },
          { quality: "1", fallbackQuality: "0.5", expected: "br" },
          { quality: "1.", fallbackQuality: "0.5", expected: "br" },
          { quality: "1.000", fallbackQuality: "0.5", expected: "br" },
        ] as const;

        for (const testCase of cases) {
          const { end, setHeader } = await runControlUiRequest({
            url: "/assets/app-QvAl5678.js",
            method: "GET",
            rootPath: tmp,
            rootKind: "bundled",
            headers: {
              "accept-encoding": `br;q=${testCase.quality}, gzip;q=${testCase.fallbackQuality}, identity;q=0`,
            },
          });

          expect(setHeader).toHaveBeenCalledWith("Content-Encoding", testCase.expected);
          const compressed = end.mock.calls[0]?.[0] as Buffer;
          const decoded =
            testCase.expected === "br" ? brotliDecompressSync(compressed) : gunzipSync(compressed);
          expect(decoded.toString()).toBe(source);
        }
      },
    });
  });

  it("rejects malformed Accept-Encoding qvalues instead of parsing numeric prefixes", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const source = "console.log('strict-qvalue');\n".repeat(200);
        const { filePath } = await writeAssetFile(tmp, "app-QvAl1234.js", source);
        await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
        await fs.writeFile(`${filePath}.gz`, gzipSync(source));

        for (const malformedQuality of ["0.8junk", ".8", "0.1234", "1.001", "1e0"]) {
          const { end, setHeader } = await runControlUiRequest({
            url: "/assets/app-QvAl1234.js",
            method: "GET",
            rootPath: tmp,
            rootKind: "bundled",
            headers: {
              "accept-encoding": `br;q=${malformedQuality}, gzip;q=0.5, identity;q=0`,
            },
          });

          expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
          expect(gunzipSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
        }
      },
    });
  });

  it("falls through to an acceptable sidecar when the preferred variant is missing", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const source = "console.log('partial-build');\n".repeat(200);
        const { filePath } = await writeAssetFile(tmp, "app-IjKl9012.js", source);
        await fs.writeFile(`${filePath}.gz`, gzipSync(source));

        const { end, setHeader } = await runControlUiRequest({
          url: "/assets/app-IjKl9012.js",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
          headers: { "accept-encoding": "br, gzip;q=0.5, identity;q=0" },
        });

        expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
        expect(gunzipSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
      },
    });
  });

  it("closes the source descriptor when opening a sidecar fails", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { filePath } = await writeAssetFile(tmp, "app-MnOp3456.js", "source\n");
        const fd = fsSync.openSync(filePath, "r");
        const openError = Object.assign(new Error("descriptor limit"), { code: "EMFILE" });
        const closeSync = vi.spyOn(fsSync, "closeSync");

        try {
          expect(() =>
            resolveOpenedControlUiRepresentation({
              req: {
                headers: { "accept-encoding": "br, identity;q=0" },
              } as IncomingMessage,
              sourceFile: { path: filePath, fd, size: fsSync.fstatSync(fd).size },
              contentPath: filePath,
              precompressed: true,
              openPrecompressedFile: () => {
                throw openError;
              },
            }),
          ).toThrow(openError);
          expect(closeSync).toHaveBeenCalledWith(fd);
        } finally {
          const sourceWasClosed = closeSync.mock.calls.some(([closedFd]) => closedFd === fd);
          closeSync.mockRestore();
          if (!sourceWasClosed) {
            fsSync.closeSync(fd);
          }
        }
      },
    });
  });

  it("keeps configured-root assets identity encoded and revalidated", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const source = "console.log('configured');\n".repeat(100);
        await writeAssetFile(tmp, "app-settings.js", source);

        const { end, setHeader } = await runControlUiRequest({
          url: "/assets/app-settings.js",
          method: "GET",
          rootPath: tmp,
          headers: { "accept-encoding": "br;q=0, gzip;q=0.8" },
        });

        expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
        expect(setHeader).not.toHaveBeenCalledWith("Content-Encoding", expect.anything());
        expect(responseBody(end)).toBe(source);
      },
    });
  });

  it("serves theme fonts with the woff2 content type and a validator", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const fontsDir = path.join(tmp, "fonts");
        await fs.mkdir(fontsDir, { recursive: true });
        const fontPath = path.join(fontsDir, "lora-latin.woff2");
        await fs.writeFile(fontPath, Buffer.from("wOF2-mock-bytes"));
        const stat = await fs.stat(fontPath);

        const { res, end, setHeader, handled } = await runControlUiRequest({
          url: "/fonts/lora-latin.woff2",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(setHeader).toHaveBeenCalledWith("Content-Type", "font/woff2");
        expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
        expect(setHeader).toHaveBeenCalledWith(
          "Last-Modified",
          new Date(stat.mtimeMs).toUTCString(),
        );
        expect(responseBody(end)).toBe("wOF2-mock-bytes");
      },
    });
  });

  it("answers conditional revalidation with 304 instead of a re-download", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const fontsDir = path.join(tmp, "fonts");
        await fs.mkdir(fontsDir, { recursive: true });
        const fontPath = path.join(fontsDir, "lora-latin.woff2");
        await fs.writeFile(fontPath, Buffer.from("wOF2-mock-bytes"));
        const stat = await fs.stat(fontPath);

        const fresh = await runControlUiRequest({
          url: "/fonts/lora-latin.woff2",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
          headers: { "if-modified-since": new Date(stat.mtimeMs).toUTCString() },
        });
        expect(fresh.res.statusCode).toBe(304);
        expect(fresh.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
        expect(fresh.setHeader).toHaveBeenCalledWith(
          "Last-Modified",
          new Date(stat.mtimeMs).toUTCString(),
        );
        expect(firstEndCallLength(fresh.end)).toBe(0);

        const stale = await runControlUiRequest({
          url: "/fonts/lora-latin.woff2",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
          headers: { "if-modified-since": new Date(stat.mtimeMs - 5_000).toUTCString() },
        });
        expect(stale.res.statusCode).toBe(200);
        expect(responseBody(stale.end)).toBe("wOF2-mock-bytes");
      },
    });
  });

  it("clamps future filesystem mtimes so validators cannot postdate the response", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const fontsDir = path.join(tmp, "fonts");
        await fs.mkdir(fontsDir, { recursive: true });
        const fontPath = path.join(fontsDir, "lora-latin.woff2");
        await fs.writeFile(fontPath, Buffer.from("wOF2-mock-bytes"));
        const future = new Date(Date.now() + 60 * 60 * 1000);
        await fs.utimes(fontPath, future, future);

        const { res, setHeader } = await runControlUiRequest({
          url: "/fonts/lora-latin.woff2",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(res.statusCode).toBe(200);
        const lastModified = setHeader.mock.calls.find(([name]) => name === "Last-Modified")?.[1];
        expect(typeof lastModified).toBe("string");
        const emitted = Date.parse(lastModified as string);
        // A future validator would 304 later replacements; it must never
        // postdate the response, only trail it by clock/floor slack.
        expect(emitted).toBeLessThanOrEqual(Date.now());
        expect(emitted).toBeLessThan(future.getTime());
      },
    });
  });

  it("returns 404 for missing font files instead of the SPA index", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, handled } = await runControlUiRequest({
          url: "/fonts/missing.woff2",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("returns 406 when no available asset representation is acceptable", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "app-settings.js", "console.log('configured');\n");

        const { res, end } = await runControlUiRequest({
          url: "/assets/app-settings.js",
          method: "GET",
          rootPath: tmp,
          headers: { "accept-encoding": "br;q=0, gzip;q=0, identity;q=0" },
        });

        expect(res.statusCode).toBe(406);
        expect(responseBody(end)).toBe("Not Acceptable");
      },
    });
  });

  it("varies identity-only assets on Accept-Encoding", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "logo.png", "png-bytes");

        const { setHeader } = await runControlUiRequest({
          url: "/assets/logo.png",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(setHeader).toHaveBeenCalledWith("Vary", "Accept-Encoding");
      },
    });
  });

  it("does not expose precompressed sidecars as independent assets", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { filePath } = await writeAssetFile(tmp, "app-AbCd1234.js", "source\n");
        await fs.writeFile(`${filePath}.br`, brotliCompressSync("source\n"));

        const { res, end, handled } = await runControlUiRequest({
          url: "/assets/app-AbCd1234.js.br",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("preserves standalone compressed files in configured roots", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "data.gz", "configured-compressed-artifact\n");

        const { end, handled } = await runControlUiRequest({
          url: "/assets/data.gz",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(responseBody(end)).toBe("configured-compressed-artifact\n");
      },
    });
  });

  it.each([
    ["index", "/"],
    ["SPA fallback", "/chat"],
  ])("compresses %s HTML after closing its descriptor", async (_name, url) => {
    const html = `<html><body>${"hello ".repeat(200)}</body></html>\n`;
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end, setHeader } = makeMockHttpResponse();
        const closeSync = vi.spyOn(fsSync, "closeSync");
        try {
          await handleControlUiHttpRequest(
            {
              url,
              method: "GET",
              headers: { "accept-encoding": "gzip" },
            } as IncomingMessage,
            res,
            { root: { kind: "resolved", path: tmp } },
          );

          expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
          expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
          expect(gunzipSync(end.mock.calls[0]?.[0] as Buffer).toString()).toContain(
            '<html data-openclaw-control-ui-base-path="" data-openclaw-terminal-enabled="true">',
          );
          expect(closeSync.mock.invocationCallOrder.at(-1)).toBeLessThan(
            end.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
          );
        } finally {
          closeSync.mockRestore();
        }
      },
    });
  });

  it("returns 406 when every HTML representation is explicitly rejected", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        await handleControlUiHttpRequest(
          {
            url: "/",
            method: "GET",
            headers: { "accept-encoding": "*;q=0" },
          } as IncomingMessage,
          res,
          { root: { kind: "resolved", path: tmp } },
        );

        expect(res.statusCode).toBe(406);
        expect(responseBody(end)).toBe("Not Acceptable");
      },
    });
  });

  it("serves HEAD for in-root assets without writing a body", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

        const { res, end, handled } = await runControlUiRequest({
          url: "/assets/actual.txt",
          method: "HEAD",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(firstEndCallLength(end)).toBe(0);
      },
    });
  });

  it.each(["identity", "gzip", "br"] as const)(
    "preserves the selected %s static-asset Content-Length for HEAD",
    async (encoding) => {
      await withControlUiRoot({
        fn: async (tmp) => {
          const source = "console.log('static asset metadata');\n".repeat(12);
          const { filePath } = await writeAssetFile(tmp, "app-HeAd1234.js", source);
          await fs.writeFile(`${filePath}.gz`, gzipSync(source));
          await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
          const request = {
            url: "/assets/app-HeAd1234.js",
            rootPath: tmp,
            rootKind: "bundled" as const,
            headers: { "accept-encoding": encoding },
          };
          const get = await runControlUiRequest({ ...request, method: "GET" });
          const head = await runControlUiRequest({ ...request, method: "HEAD" });
          const body = get.end.mock.calls[0]?.[0];

          expect(Buffer.isBuffer(body)).toBe(true);
          expect(head.setHeader).toHaveBeenCalledWith("Content-Length", String(body.byteLength));
          expect(firstEndCallLength(head.end)).toBe(0);
          if (encoding === "identity") {
            expect(head.setHeader).not.toHaveBeenCalledWith("Content-Encoding", expect.anything());
          } else {
            expect(head.setHeader).toHaveBeenCalledWith("Content-Encoding", encoding);
          }
        },
      });
    },
  );

  it.each([
    {
      name: "root-mounted approval",
      basePath: undefined,
      url: "/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "configured-base-path approval",
      basePath: "/openclaw",
      url: "/openclaw/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "asset-like approval id",
      basePath: undefined,
      url: "/approve/plugin%3Arequest.json",
    },
    {
      name: "configured-base asset-like approval id",
      basePath: "/openclaw",
      url: "/openclaw/approve/plugin%3Arequest.js",
    },
    {
      name: "root-mounted focus path",
      basePath: undefined,
      url: "/focus/dashboard/roboclaw/session.json",
    },
    {
      name: "configured-base focus path",
      basePath: "/openclaw",
      url: "/openclaw/focus/desktop/control/session/agent%3Amain%3Amain",
    },
  ])("serves $name through the standalone document", async ({ basePath, url }) => {
    await withControlUiRoot({
      indexHtml: "<html><body>standalone-spa</body></html>\n",
      fn: async (tmp) => {
        for (const method of ["GET", "HEAD"] as const) {
          const { res, end, handled } = await runControlUiRequest({
            url,
            method,
            rootPath: tmp,
            basePath,
          });

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          if (method === "HEAD") {
            expect(firstEndCallLength(end)).toBe(0);
          } else {
            expect(responseBody(end)).toContain("standalone-spa");
            if (basePath) {
              expect(responseBody(end)).toContain('data-openclaw-control-ui-base-path="/openclaw"');
            }
          }
        }
      },
    });
  });

  it.each([
    {
      name: "root-mounted approval",
      basePath: undefined,
      url: "/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "configured-base-path approval",
      basePath: "/openclaw",
      url: "/openclaw/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "asset-like approval id",
      basePath: undefined,
      url: "/approve/plugin%3Arequest.json",
    },
    {
      name: "root-mounted focus path",
      basePath: undefined,
      url: "/focus/terminal",
    },
    {
      name: "configured-base focus path",
      basePath: "/openclaw",
      url: "/openclaw/focus/desktop",
    },
  ])("declines POST to $name at the UI module", async ({ basePath, url }) => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { handled, end } = await runControlUiRequest({
          url,
          method: "POST",
          rootPath: tmp,
          basePath,
        });

        // The UI module serves reads only. The gateway router decides whether a
        // write is reserved approval traffic or an unclaimed focus fallback.
        expect(handled).toBe(false);
        expect(end).not.toHaveBeenCalled();
      },
    });
  });

  it("rejects symlinked SPA fallback index.html outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-outside-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.symlink(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = await runControlUiRequest({
            url: "/app/route",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked index.html for non-package control-ui roots", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-hardlink-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside-hardlink</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.link(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = await runControlUiRequest({
            url: "/",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked asset files for custom/resolved roots (security boundary)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await createHardlinkedAssetFile(tmp);

        const { res, end, handled } = await runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(404);
        expect(end).toHaveBeenCalledWith("Not Found");
      },
    });
  });

  it("serves hardlinked asset files for bundled roots (pnpm global install)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await createHardlinkedAssetFile(tmp);

        const { res, end, handled } = await runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(responseBody(end)).toBe("console.log('hi');");
      },
    });
  });

  it("serves public root assets under the internal namespace when the SPA is routed there", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await fs.writeFile(path.join(tmp, "favicon.svg"), "<svg/>");
        await fs.writeFile(path.join(tmp, "manifest.webmanifest"), "{}");
        await fs.writeFile(path.join(tmp, "apple-touch-icon.png"), "png-bytes");
        await fs.writeFile(path.join(tmp, "sw.js"), "self.addEventListener('push', () => {});");

        for (const [url, expectedType] of [
          ["/__openclaw__/favicon.svg", "image/svg+xml"],
          ["/__openclaw__/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
          ["/__openclaw__/apple-touch-icon.png", "image/png"],
          ["/__openclaw__/sw.js", "application/javascript; charset=utf-8"],
        ] as const) {
          const { res, end, handled } = await runControlUiRequest({
            url,
            method: "GET",
            rootPath: tmp,
          });

          expect(handled, `expected ${url} to be handled`).toBe(true);
          expect(res.statusCode, `expected ${url} to be served`).toBe(200);
          expect(res["setHeader"]).toHaveBeenCalledWith("Content-Type", expectedType);
          expect(end, `expected ${url} to write a body`).toHaveBeenCalled();
        }
      },
    });
  });

  it("does not handle POST to root-mounted paths (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const webhookPath of ["/imessage-webhook", "/custom-webhook", "/callback"]) {
          const { res } = makeMockHttpResponse();
          const handled = await handleControlUiHttpRequest(
            { url: webhookPath, method: "POST" } as IncomingMessage,
            res,
            { root: { kind: "resolved", path: tmp } },
          );
          expect(handled, `POST to ${webhookPath} should pass through to plugin handlers`).toBe(
            false,
          );
        }
      },
    });
  });

  it("does not handle POST to paths outside basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: "/imessage-webhook", method: "POST" } as IncomingMessage,
          res,
          { basePath: "/openclaw", root: { kind: "resolved", path: tmp } },
        );
        expect(handled).toBe(false);
      },
    });
  });

  it("does not handle /api paths when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const apiPath of ["/api", "/api/sessions", "/api/channels/nostr"]) {
          const { handled } = await runControlUiRequest({
            url: apiPath,
            method: "GET",
            rootPath: tmp,
          });
          expect(handled, `expected ${apiPath} to not be handled`).toBe(false);
        }
      },
    });
  });

  it("does not handle /plugins paths when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const pluginPath of ["/plugins", "/plugins/diffs/view/abc/def"]) {
          const { handled } = await runControlUiRequest({
            url: pluginPath,
            method: "GET",
            rootPath: tmp,
          });
          expect(handled, `expected ${pluginPath} to not be handled`).toBe(false);
        }
      },
    });
  });

  it("falls through POST requests when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { handled, end } = await runControlUiRequest({
          url: "/webhook/imessage",
          method: "POST",
          rootPath: tmp,
        });
        expect(handled).toBe(false);
        expect(end).not.toHaveBeenCalled();
      },
    });
  });

  it("falls through POST requests under configured basePath (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const route of ["/openclaw", "/openclaw/", "/openclaw/some-page"]) {
          const { handled, end } = await runControlUiRequest({
            url: route,
            method: "POST",
            rootPath: tmp,
            basePath: "/openclaw",
          });
          expect(handled, `POST to ${route} should pass through to plugin handlers`).toBe(false);
          expect(end, `POST to ${route} should not write a response`).not.toHaveBeenCalled();
        }
      },
    });
  });

  it("rejects absolute-path escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "ui-secrets",
      fn: async ({ root, sibling }) => {
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const secretPathUrl = secretPath.split(path.sep).join("/");
        const absolutePathUrl = secretPathUrl.startsWith("/") ? secretPathUrl : `/${secretPathUrl}`;
        const { res, end, handled } = await runControlUiRequest({
          url: `/openclaw/${absolutePathUrl}`,
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("rejects symlink escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "outside",
      fn: async ({ root, sibling }) => {
        await fs.mkdir(path.join(root, "assets"), { recursive: true });
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const linkPath = path.join(root, "assets", "leak.txt");
        try {
          await fs.symlink(secretPath, linkPath, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") {
            return;
          }
          throw error;
        }

        const { res, end, handled } = await runControlUiRequest({
          url: "/openclaw/assets/leak.txt",
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
