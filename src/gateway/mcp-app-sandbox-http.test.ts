import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createSandboxHostHttpServer } from "./mcp-app-sandbox-http.js";
import { makeMockHttpResponse } from "./test-http-response.js";

function request(url: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const { res, end, setHeader } = makeMockHttpResponse();
  const server = createSandboxHostHttpServer();
  server.emit("request", { url, method } as IncomingMessage, res);
  server.removeAllListeners();
  return { res, end, setHeader };
}

async function withSandboxHost(
  run: (origin: string) => Promise<void>,
  resolvePluginRegistry?: () => PluginRegistry,
): Promise<void> {
  const server = createSandboxHostHttpServer(undefined, resolvePluginRegistry);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function publicResourceRegistry(
  readPublicResource: (
    resourcePath: string,
  ) => Promise<{ body: Uint8Array; contentType: string } | undefined>,
) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "renderer",
    source: "fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  createPluginBoardWidgetContentKindRegistrar(registry)(record, {
    kind: "diagram",
    label: "Diagram",
    resources: {
      surface: "renderer",
      paths: ["/__openclaw__/renderer/app.js"],
      readPublicResource,
    },
    validateSource() {},
    composeDocument: () => "",
  });
  markPluginRegistryActive(registry);
  return registry;
}

describe("MCP App sandbox HTTP origin", () => {
  it("serves only explicitly public registered assets without Gateway credentials", async () => {
    const read = vi.fn(async () => ({
      body: Buffer.from("window.rendererReady=true"),
      contentType: "application/javascript",
    }));
    const registry = publicResourceRegistry(read);
    await withSandboxHost(
      async (origin) => {
        const url = `${origin}/__openclaw__/renderer/app.js`;
        const get = await fetch(url);
        const head = await fetch(url, { method: "HEAD" });
        expect(get.status).toBe(200);
        expect(await get.text()).toBe("window.rendererReady=true");
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
        expect(get.headers.get("set-cookie")).toBeNull();
        expect(read).toHaveBeenCalledWith("/__openclaw__/renderer/app.js");
        expect((await fetch(url, { method: "POST" })).status).toBe(404);
        for (const deniedPath of [
          "/",
          "/__openclaw__/renderer/private.js",
          "/__openclaw__/canvas/documents/private/index.html",
        ]) {
          expect((await fetch(`${origin}${deniedPath}`)).status).toBe(404);
        }
        expect(read).toHaveBeenCalledTimes(2);
      },
      () => registry,
    );
  });

  it("does not expose registered assets without the public-reader opt-in", async () => {
    const registry = publicResourceRegistry(async () => undefined);
    registry.boardWidgetContentKinds.get("diagram")!.definition.resources.readPublicResource =
      undefined;
    await withSandboxHost(
      async (origin) => {
        expect((await fetch(`${origin}/__openclaw__/renderer/app.js`)).status).toBe(404);
      },
      () => registry,
    );
  });

  it("rebuilds public routes when the same registry is reactivated", async () => {
    const registry = publicResourceRegistry(async () => ({
      body: Buffer.from("old renderer"),
      contentType: "application/javascript",
    }));
    await withSandboxHost(
      async (origin) => {
        const url = `${origin}/__openclaw__/renderer/app.js`;
        expect((await fetch(url)).status).toBe(200);
        markPluginRegistryRetired(registry);
        registry.boardWidgetContentKinds.clear();
        markPluginRegistryActive(registry);
        expect((await fetch(url)).status).toBe(404);
      },
      () => registry,
    );
  });

  it.each(["replacement", "retirement"] as const)(
    "rejects an awaited public asset after registry %s",
    async (change) => {
      const started = createDeferred();
      const result = createDeferred<{ body: Uint8Array; contentType: string }>();
      let registry = publicResourceRegistry(async () => {
        started.resolve();
        return await result.promise;
      });
      await withSandboxHost(
        async (origin) => {
          const response = fetch(`${origin}/__openclaw__/renderer/app.js`);
          await started.promise;
          if (change === "replacement") {
            registry = publicResourceRegistry(async () => undefined);
          } else {
            markPluginRegistryRetired(registry);
          }
          result.resolve({ body: Buffer.from("stale"), contentType: "application/javascript" });
          const denied = await response;
          expect(denied.status).toBe(404);
          expect(await denied.text()).not.toContain("stale");
        },
        () => registry,
      );
    },
  );

  it("serves only the proxy endpoint with metadata-derived CSP", () => {
    const result = request(
      buildMcpAppSandboxPath({
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      }),
    );

    expect(result.res.statusCode).toBe(200);
    const csp = result.setHeader.mock.calls.findLast(
      (call) => call[0] === "Content-Security-Policy",
    )?.[1];
    expect(String(csp)).toContain("connect-src https://api.example.com");
    expect(String(csp)).toContain("webrtc 'block'");
    expect(String(csp)).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(String(csp)).toContain("font-src 'self' https://cdn.example.com");
    expect(String(csp)).toContain("frame-ancestors");
    expect(String(csp)).toContain("frame-src 'none'");
    expect(result.setHeader).not.toHaveBeenCalledWith("X-Frame-Options", expect.anything());
    expect(result.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "cross-origin");
    expect(result.setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), clipboard-write=()",
    );
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("document.referrer"));
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("sandbox-proxy-ready"));
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("allow-scripts allow-forms"));
    expect(result.end).toHaveBeenCalledWith(
      expect.stringContaining("openclaw:widget-bridge-port-offer"),
    );
    expect(result.end).toHaveBeenCalledWith(
      expect.stringContaining("openclaw:widget-prompt-offer"),
    );
    const proxyHtml = String(result.end.mock.calls.at(-1)?.[0]);
    expect(proxyHtml).not.toContain("allow-popups");
    expect(proxyHtml).toContain("const guardedHtml = guardDocument(params.html)");
    expect(proxyHtml).toContain("nextInner.srcdoc = guardedHtml");
  });

  it("supports HEAD and rejects other paths, methods, and malformed policy", () => {
    const head = request(buildMcpAppSandboxPath(), "HEAD");
    expect(head.res.statusCode).toBe(200);
    expect(head.end).toHaveBeenCalledWith(undefined);

    expect(request("/", "GET").res.statusCode).toBe(404);
    expect(request(buildMcpAppSandboxPath(), "POST").res.statusCode).toBe(404);
    expect(request(`${buildMcpAppSandboxPath()}?csp=not-json`).res.statusCode).toBe(400);
    const jsonButNotCsp = Buffer.from("null", "utf8").toString("base64url");
    expect(request(`${buildMcpAppSandboxPath()}?csp=${jsonButNotCsp}`).res.statusCode).toBe(400);
    expect(request(`${buildMcpAppSandboxPath()}?csp=`).res.statusCode).toBe(400);
    expect(request("http://[", "GET").res.statusCode).toBe(400);
    const unsafeHeaderPolicy = Buffer.from(
      JSON.stringify({ connectDomains: ["https://api.\nexample.com"] }),
      "utf8",
    ).toString("base64url");
    expect(request(`${buildMcpAppSandboxPath()}?csp=${unsafeHeaderPolicy}`).res.statusCode).toBe(
      400,
    );
  });

  it("emits canonical ASCII origins for validated CSP domains", () => {
    const result = request(
      buildMcpAppSandboxPath({ connectDomains: ["https://b\u00fccher.example"] }),
    );

    expect(result.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("connect-src https://xn--bcher-kva.example"),
    );
  });

  it.each([
    {
      label: "sandbox HTML",
      path: buildMcpAppSandboxPath(),
      statusCode: 200,
    },
    {
      label: "missing path",
      path: "/missing",
      statusCode: 404,
    },
    {
      label: "malformed policy",
      path: `${buildMcpAppSandboxPath()}?csp=not-json`,
      statusCode: 400,
    },
  ])(
    "keeps GET and HEAD representation metadata aligned for $label",
    async ({ path, statusCode }) => {
      await withSandboxHost(async (origin) => {
        const get = await fetch(`${origin}${path}`);
        const head = await fetch(`${origin}${path}`, { method: "HEAD" });
        const getBody = await get.text();

        expect(get.status).toBe(statusCode);
        expect(head.status).toBe(statusCode);
        expect(getBody).not.toBe("");
        expect(await head.text()).toBe("");
        expect(get.headers.get("content-length")).toBe(String(Buffer.byteLength(getBody)));
        for (const header of [
          "content-type",
          "content-length",
          "cache-control",
          "content-security-policy",
          "permissions-policy",
          "cross-origin-resource-policy",
          "origin-agent-cluster",
          "referrer-policy",
          "x-content-type-options",
        ]) {
          expect(head.headers.get(header), header).toBe(get.headers.get(header));
        }
      });
    },
  );
});
