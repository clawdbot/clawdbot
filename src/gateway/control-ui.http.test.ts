import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("handleControlUiHttpRequest", () => {
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
    return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      basePath: string;
      assistantName: string;
      assistantAvatar: string;
      assistantAgentId: string;
      localMediaPreviewRoots?: string[];
    };
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

  function runControlUiRequest(params: {
    url: string;
    method: "GET" | "HEAD" | "POST";
    rootPath: string;
    basePath?: string;
    rootKind?: "resolved" | "bundled";
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiHttpRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        root: { kind: params.rootKind ?? "resolved", path: params.rootPath },
      },
    );
    return { res, end, handled };
  }

  function runAvatarRequest(params: {
    url: string;
    method: "GET" | "HEAD";
    resolveAvatar: Parameters<typeof handleControlUiAvatarRequest>[2]["resolveAvatar"];
    basePath?: string;
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiAvatarRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        resolveAvatar: params.resolveAvatar,
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

  it("sets security headers for Control UI responses", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, setHeader } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        const csp = setHeader.mock.calls.find((call) => call[0] === "Content-Security-Policy")?.[1];
        expect(typeof csp).toBe("string");
        expect(String(csp)).toContain("frame-ancestors 'none'");
        expect(String(csp)).toContain("script-src 'self'");
        expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
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
      },
    });
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
        expect(JSON.parse(String(end.mock.calls[0]?.[0] ?? ""))).toEqual({ available: true });
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
    expect(JSON.parse(String(end.mock.calls[0]?.[0] ?? ""))).toEqual({
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
        expect(String(end.mock.calls[0]?.[0] ?? "")).toContain("Unauthorized");
      },
    });
  });

  it("rejects trusted-proxy assistant media requests from disallowed browser origins", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-proxy-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`,
          method: "GET",
          auth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          trustedProxies: ["10.0.0.1"],
          remoteAddress: "10.0.0.1",
          headers: {
            host: "gateway.example.com",
            origin: "https://evil.example",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toContain("Unauthorized");
      },
    });
  });

  it("rejects trusted-proxy assistant media file reads without operator.read scope", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-scope-file-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`,
          method: "GET",
          auth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          trustedProxies: ["10.0.0.1"],
          remoteAddress: "10.0.0.1",
          headers: {
            host: "gateway.example.com",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-openclaw-scopes": "operator.approvals",
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(String(end.mock.calls[0]?.[0] ?? ""))).toMatchObject({
          ok: false,
          error: {
            type: "forbidden",
            message: "missing scope: operator.read",
          },
        });
      },
    });
  });

  it("rejects trusted-proxy assistant media metadata requests with an empty scope set", async () => {
    await withAllowedAssistantMediaRoot({
      prefix: "ui-media-scope-meta-",
      fn: async (tmpRoot) => {
        const filePath = path.join(tmpRoot, "photo.png");
        await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
        const { res, handled, end } = await runAssistantMediaRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          method: "GET",
          auth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          trustedProxies: ["10.0.0.1"],
          remoteAddress: "10.0.0.1",
          headers: {
            host: "gateway.example.com",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-openclaw-scopes": "",
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(String(end.mock.calls[0]?.[0] ?? ""))).toMatchObject({
          ok: false,
          error: {
            type: "forbidden",
            message: "missing scope: operator.read",
          },
        });
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
        handleControlUiHttpRequest({ url: "/", method: "GET" } as IncomingMessage, res, {
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
        const handled = handleControlUiHttpRequest(
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
        expect(end).toHaveBeenCalledWith(html);
      },
    });
  });

  it("serves bootstrap config JSON", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "</script>.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantName).toBe("</script><script>alert(1)//");
        expect(parsed.assistantAvatar).toBe("/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
        expect(Array.isArray(parsed.localMediaPreviewRoots)).toBe(true);
      },
    });
  });

  it("serves bootstrap config JSON under basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
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
        expect(parsed.assistantAvatar).toBe("/openclaw/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
        expect(Array.isArray(parsed.localMediaPreviewRoots)).toBe(true);
      },
    });
  });

  it("serves local avatar bytes through hardened avatar handler", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-"));
    try {
      const avatarPath = path.join(tmp, "main.png");
      await fs.writeFile(avatarPath, "avatar-bytes\n");

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: avatarPath }),
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("avatar-bytes\n");
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

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: linkPath }),
      });

      expectNotFoundResponse({ handled, res, end });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
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
          const handled = handleControlUiHttpRequest(
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

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/linked.txt",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("inside-ok\n");
      },
    });
  });

  it("serves HEAD for in-root assets without writing a body", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/actual.txt",
          method: "HEAD",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(end.mock.calls[0]?.length ?? -1).toBe(0);
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

          const { res, end, handled } = runControlUiRequest({
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

          const { res, end, handled } = runControlUiRequest({
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

        const { res, end, handled } = runControlUiRequest({
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

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("console.log('hi');");
      },
    });
  });

  it("does not handle POST to root-mounted paths (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const webhookPath of ["/bluebubbles-webhook", "/custom-webhook", "/callback"]) {
          const { res } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
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
        const handled = handleControlUiHttpRequest(
          { url: "/bluebubbles-webhook", method: "POST" } as IncomingMessage,
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
          const { handled } = runControlUiRequest({
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
          const { handled } = runControlUiRequest({
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
        const { handled, end } = runControlUiRequest({
          url: "/webhook/bluebubbles",
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
          const { handled, end } = runControlUiRequest({
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
        const { res, end, handled } = runControlUiRequest({
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

        const { res, end, handled } = runControlUiRequest({
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
