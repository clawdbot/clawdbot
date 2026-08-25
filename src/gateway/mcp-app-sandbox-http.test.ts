import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { createSandboxHostHttpServer } from "./mcp-app-sandbox-http.js";
import { makeMockHttpResponse } from "./test-http-response.js";

function request(url: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const { res, end, setHeader } = makeMockHttpResponse();
  const server = createSandboxHostHttpServer();
  server.emit("request", { url, method } as IncomingMessage, res);
  server.removeAllListeners();
  return { res, end, setHeader };
}

async function withSandboxHost(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createSandboxHostHttpServer();
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

describe("MCP App sandbox HTTP origin", () => {
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
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("widgetBridgePortOffered"));
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
