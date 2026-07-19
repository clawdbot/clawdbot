// Control UI HTTP tests cover static asset serving, bootstrap config, avatar and
// assistant media routes, pairing helpers, and session-generation metadata.
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
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import type { ResolvedGatewayAuth } from "./auth.js";
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

// Keeps bootstrap payload tests deterministic: the real resolver reports the
// git branch of this checkout, which varies across CI and dev machines.
const devInstallBranchMock = vi.hoisted(() => ({ branch: null as string | null }));
vi.mock("../infra/dev-install-branch.js", () => ({
  resolveDevInstallGitBranch: async () => devInstallBranchMock.branch,
}));

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetPluginRuntimeStateForTest();
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
      assistantAgentId: string;
      devGitBranch?: string;
      localMediaPreviewRoots?: string[];
      chatMessageMaxWidth?: string;
      seamColor?: string;
      timeFormat?: "auto" | "12" | "24";
      terminalEnabled: boolean;
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
    headers?: IncomingMessage["headers"];
  }) {
    const { res, end, setHeader } = makeMockHttpResponse();
    const handled = await handleControlUiHttpRequest(
      { url: params.url, method: params.method, headers: params.headers ?? {} } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        root: { kind: params.rootKind ?? "resolved", path: params.rootPath },
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
        socket: { remoteAddress: "127.0.0.1" },
      } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        ...(params.auth ? { auth: params.auth } : {}),
        ...(params.config ? { config: params.config } : {}),
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
    const { res, end } = makeMockHttpResponse();
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
    return { res, end, handled };
  }

  async function runAssistantMediaRequest(params: {
    url: string;
    method: "GET" | "HEAD";
    basePath?: string;
    auth?: ResolvedGatewayAuth;
    headers?: IncomingMessage["headers"];
    trustedProxies?: string[];
    remoteAddress?: string;
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = await handleControlUiAssistantMediaRequest(
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
      },
    );
    return { res, end, handled };
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
          { url: "/", method: "GET" } as IncomingMessage,
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
        expect(responseBody(end)).toContain('data-openclaw-terminal-enabled="false"');
      },
    });
  });

  it("marks terminal-enabled documents and allows the terminal WASM runtime", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, setHeader } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
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
        await handleControlUiHttpRequest({ url: "/", method: "GET" } as IncomingMessage, res, {
          root: { kind: "resolved", path: tmp },
          config: { gateway: { terminal: { enabled: true } } },
          terminalEnabled: false,
        });
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
        await handleControlUiHttpRequest({ url: "/", method: "GET" } as IncomingMessage, res, {
          root: { kind: "resolved", path: tmp },
        });
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
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "evil.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        expect(end).toHaveBeenCalledWith(
          html.replace("<html", '<html data-openclaw-terminal-enabled="false"'),
        );
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
          { url: "/openclaw/chat", method: "GET" } as IncomingMessage,
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
              agents: { defaults: { workspace: tmp, timeFormat: "24" } },
              gateway: { controlUi: { chatMessageMaxWidth: "min(1280px, 82%)" } },
              ui: {
                seamColor: "#1A2b3C",
                assistant: { name: "</script><script>alert(1)//", avatar: "</script>.png" },
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
        expect(parsed.assistantAgentId).toBe("main");
        expect(parsed.chatMessageMaxWidth).toBe("min(1280px, 82%)");
        expect(parsed.seamColor).toBe("#1A2b3C");
        expect(parsed.timeFormat).toBe("24");
        expect(parsed.terminalEnabled).toBe(false);
        expect(parsed.devGitBranch).toBeUndefined();
        expect(Array.isArray(parsed.localMediaPreviewRoots)).toBe(true);
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

  it("inlines a workspace-local assistant avatar in bootstrap config (#97602)", async () => {
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
          assistantAvatar: REAL_PNG_DATA_URL,
          assistantAvatarSource: "avatar.png",
          assistantAvatarStatus: "local",
        });
      },
    });
  });

  it("round-trips a maximum-size local avatar through bootstrap and UI normalization", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const avatar = Buffer.alloc(AVATAR_MAX_BYTES);
        const expected = `data:image/svg+xml;base64,${avatar.toString("base64")}`;
        expect(expected).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
        await fs.writeFile(path.join(tmp, "avatar.svg"), avatar);
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: createAvatarConfig(tmp, "avatar.svg"),
          },
        );

        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.assistantAvatar).toBe(expected);
        expect(
          normalizeAssistantIdentity({
            agentId: parsed.assistantAgentId,
            name: parsed.assistantName,
            avatar: parsed.assistantAvatar,
            avatarSource: parsed.assistantAvatarSource,
            avatarStatus: parsed.assistantAvatarStatus,
            avatarReason: parsed.assistantAvatarReason,
          }).avatar,
        ).toBe(expected);
      },
    });
  });

  it("preserves an exact-cap IDENTITY.md data URL in bootstrap", async () => {
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
          assistantAvatar: dataUrl,
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

  it("bounds a bootstrap avatar that grows after its descriptor is pinned", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const avatarPath = path.join(tmp, "avatar.png");
        await fs.writeFile(avatarPath, REAL_PNG);
        const fstatSync = growAvatarAfterPinnedOpen(avatarPath);
        try {
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
        } finally {
          fstatSync.mockRestore();
        }
      },
    });
  });

  it("does not read assistant avatar bytes for bootstrap HEAD", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await fs.writeFile(path.join(tmp, "avatar.png"), REAL_PNG);
        const readSync = vi.spyOn(fsSync, "readSync");
        try {
          const { res, end } = makeMockHttpResponse();
          const handled = await handleControlUiHttpRequest(
            { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "HEAD" } as IncomingMessage,
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
          expect(end).toHaveBeenCalledWith();
          expect(readSync).not.toHaveBeenCalled();
        } finally {
          readSync.mockRestore();
        }
      },
    });
  });
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
        await fs.writeFile(path.join(tmp, "avatar.png"), "avatar-bytes\n");
        const { res, handled, end, setHeader } = await runBootstrapConfigRequest({
          rootPath: tmp,
          auth: { mode: "token", token: "test-token", allowTailscale: false },
          headers: {
            authorization: "Bearer test-token",
          },
          config: {
            agents: { defaults: { workspace: tmp } },
            ui: { assistant: { avatar: "avatar.png" } },
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(setHeader.mock.calls.some(([name]) => name === "Set-Cookie")).toBe(false);
        const parsed = parseBootstrapPayload(end);
        expect(parsed).toMatchObject({
          assistantAgentId: "main",
          assistantAvatar: `data:image/png;base64,${Buffer.from("avatar-bytes\n").toString("base64")}`,
          assistantAvatarStatus: "local",
        });
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
            const { res, handled, end } = await runBootstrapConfigRequest({
              rootPath: tmp,
              auth: { mode: "token", token: "shared-token", allowTailscale: false },
              headers: {
                authorization: `Bearer ${operatorToken}`,
              },
            });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            const parsed = parseBootstrapPayload(end);
            expect(parsed.assistantAgentId).toBe("main");
          },
        });
      },
    });
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
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
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
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
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
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
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
        expect(parsed.assistantAgentId).toBe("main");
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
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
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
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
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
              sourceFile: { path: filePath, fd },
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
            '<html data-openclaw-terminal-enabled="false">',
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

  it.each([
    {
      name: "root-mounted",
      basePath: undefined,
      url: "/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "configured-base-path",
      basePath: "/openclaw",
      url: "/openclaw/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "asset-like-id",
      basePath: undefined,
      url: "/approve/plugin%3Arequest.json",
    },
    {
      name: "configured-base-asset-like-id",
      basePath: "/openclaw",
      url: "/openclaw/approve/plugin%3Arequest.js",
    },
  ])("serves $name approval deep links through the SPA fallback", async ({ basePath, url }) => {
    await withControlUiRoot({
      indexHtml: "<html><body>approval-spa</body></html>\n",
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
            expect(responseBody(end)).toContain("approval-spa");
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
      name: "root-mounted",
      basePath: undefined,
      url: "/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "configured-base-path",
      basePath: "/openclaw",
      url: "/openclaw/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E",
    },
    {
      name: "asset-like-id",
      basePath: undefined,
      url: "/approve/plugin%3Arequest.json",
    },
  ])("declines POST to $name approval deep links at the UI module", async ({ basePath, url }) => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { handled, end } = await runControlUiRequest({
          url,
          method: "POST",
          rootPath: tmp,
          basePath,
        });

        // The UI module only serves reads; the gateway's approval-document
        // stage (server-http.ts) owns the terminal 404 for write methods, so
        // these requests never reach plugin HTTP handlers in production.
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
