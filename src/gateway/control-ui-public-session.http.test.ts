import type { Server } from "node:http";
import { buildControlUiPublicSessionSharePath } from "@openclaw/session-url-contract/public-share";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  createTestGatewayServer,
  dispatchRequest,
} from "./server-http.test-harness.js";

const reader = vi.hoisted(() => vi.fn());
const shareActive = vi.hoisted(() => vi.fn());
const tokenResolver = vi.hoisted(() => vi.fn());
vi.mock("./control-ui-public-session-read.js", () => ({
  isPublicSessionShareActive: shareActive,
  readPublicSessionShare: reader,
}));
vi.mock("./control-ui-public-session-token.js", () => ({
  resolvePublicSessionShareToken: tokenResolver,
}));

const TEST_CONFIG: OpenClawConfig = {
  gateway: { publicOrigin: "https://gateway.example.test" },
};
const LOCATOR = {
  agentId: "demo",
  sessionKey: "agent:demo:topic:with space",
  sessionId: "séssion.123",
  shareId: "a".repeat(48),
};
const PUBLIC_SESSION = {
  title: "Launch notes",
  messages: [
    { role: "user" as const, content: "What changed?" },
    { role: "assistant" as const, content: "The public viewer is ready." },
  ],
  totalMessages: 2,
  truncated: false,
};

function createPublicGateway(basePath = "", config: OpenClawConfig = TEST_CONFIG): Server {
  return createTestGatewayServer({
    resolvedAuth: AUTH_TOKEN,
    overrides: {
      controlUiEnabled: true,
      controlUiBasePath: basePath,
      getRuntimeConfig: () => config,
    },
  });
}

function requestPath(params?: {
  basePath?: string;
  locator?: typeof LOCATOR;
  offset?: number;
}): string {
  const locator = params?.locator ?? LOCATOR;
  const token = `v1.${locator.shareId}AA`;
  const route = buildControlUiPublicSessionSharePath({
    token,
    ...(params?.basePath ? { basePath: params.basePath } : {}),
  });
  return params?.offset === undefined ? route : `${route}&offset=${params.offset}`;
}

async function send(
  server: Server,
  params?: {
    path?: string;
    method?: string;
    remoteAddress?: string;
    headers?: Record<string, string>;
  },
) {
  const response = createResponse();
  await dispatchRequest(
    server,
    createRequest({
      path: params?.path ?? requestPath(),
      method: params?.method,
      remoteAddress: params?.remoteAddress ?? "127.0.0.1",
      host: "127.0.0.1:18789",
      headers: params?.headers,
    }),
    response.res,
  );
  return response;
}

function responseHeader(
  response: ReturnType<typeof createResponse>,
  name: string,
): string | undefined {
  const call = response.setHeader.mock.calls.find(
    ([headerName]) => String(headerName).toLowerCase() === name.toLowerCase(),
  );
  return call ? String(call[1]) : undefined;
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  reader.mockReset().mockResolvedValue(PUBLIC_SESSION);
  shareActive.mockReset().mockReturnValue(true);
  tokenResolver.mockReset().mockImplementation((token: string) => {
    const shareId = token.slice(3, 51);
    return /^[a-f0-9]{48}$/u.test(shareId) ? { ...LOCATOR, shareId } : null;
  });
});

afterEach(() => {
  resetGatewayWorkAdmission();
});

describe("anonymous public session HTTP boundary", () => {
  it.each(["", "/control"])(
    "serves only published text and keeps private APIs authenticated (%s)",
    async (basePath) => {
      const server = createPublicGateway(basePath);
      const route = requestPath({ basePath });
      const response = await send(server, { path: route });
      expect(response.res.statusCode).toBe(200);
      expect(reader).toHaveBeenCalledWith(expect.any(Object), LOCATOR, { offset: 0 });
      const html = response.getBody();
      expect(html).toContain("Launch notes");
      expect(html).toContain("The public viewer is ready.");
      expect(html).not.toMatch(/agent:demo|séssion\.123|<script|openclaw-app/);
      expect(responseHeader(response, "Cache-Control")).toBe("no-store");
      expect(responseHeader(response, "Referrer-Policy")).toBe("no-referrer");
      expect(responseHeader(response, "Content-Security-Policy")).toContain("default-src 'none'");

      reader.mockClear();
      const head = await send(server, { path: route, method: "HEAD" });
      expect(head.res.statusCode).toBe(405);
      expect(responseHeader(head, "Allow")).toBe("GET");
      expect(responseHeader(head, "Content-Length")).toBe("0");
      expect(head.getBody()).toBe("");
      expect(reader).not.toHaveBeenCalled();

      const privateApi = await send(server, {
        path: `${basePath}/__openclaw__/assistant-media?source=missing.png`,
      });
      expect(privateApi.res.statusCode).toBe(401);
      reader.mockResolvedValueOnce({
        title: "Earlier notes",
        messages: [],
        truncated: false,
        olderOffset: 200,
      });
      const older = await send(server, { path: `${route}&offset=100` });
      const olderHtml = older.getBody();
      expect(older.res.statusCode).toBe(200);
      expect(reader).toHaveBeenLastCalledWith(expect.any(Object), LOCATOR, { offset: 100 });
      expect(olderHtml).toContain("&amp;offset=200");
      expect(olderHtml).toContain("Back to latest");
      expect(olderHtml).not.toContain('http-equiv="refresh"');
      const before = reader.mock.calls.length;
      for (const path of [
        "/share/session/demo/session-123?key=agent%3Ademo%3Atopic&share=" + "a".repeat(48),
        `${route}&token=v1.duplicate`,
        `${route}&draft=private`,
        `${route}&offset=-1`,
        `${route}&offset=0&offset=100`,
        route.replace("token=", "unknown="),
        `${basePath}/share/session/demo/session-123`,
      ]) {
        expect((await send(server, { path })).res.statusCode).toBe(404);
      }
      expect((await send(server, { path: route, method: "POST" })).res.statusCode).toBe(404);
      expect(reader.mock.calls.length).toBe(before);
      reader.mockResolvedValue(null);
      const revoked = await send(server, { path: route });
      expect(revoked.res.statusCode).toBe(404);
      expect(revoked.getBody()).toBe("This public session is unavailable.");
      expect(responseHeader(revoked, "Cache-Control")).toBe("no-store");
      reader.mockRejectedValue(new Error("private store location"));
      const unavailable = await send(server, { path: route });
      expect(unavailable.res.statusCode).toBe(503);
      expect(responseHeader(unavailable, "Retry-After")).toBe("1");
      expect(unavailable.getBody()).not.toContain("private store location");
    },
  );

  it("rejects transcript work after Gateway admission closes while generic previews stay cheap", async () => {
    const server = createPublicGateway();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    try {
      const transcript = await send(server);
      expect(transcript.res.statusCode).toBe(503);
      expect(transcript.getBody()).toContain("gateway_unavailable");
      expect(reader).not.toHaveBeenCalled();

      const preview = await send(server, { path: "/share/dashboard/example/private-name" });
      expect(preview.res.statusCode).toBe(200);
      expect(preview.getBody()).toContain("OpenClaw dashboard");
      expect(reader).not.toHaveBeenCalled();
    } finally {
      suspension?.release();
    }
  });

  it("uses trusted client attribution for fixed per-client request budgets", async () => {
    const server = createPublicGateway("", {
      gateway: {
        publicOrigin: "https://gateway.example.test",
        trustedProxies: ["10.0.0.1"],
      },
    });
    const fromProxy = (clientIp: string) =>
      send(server, {
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": clientIp, "x-forwarded-proto": "https" },
      });

    for (let request = 0; request < 20; request += 1) {
      expect((await fromProxy("203.0.113.10")).res.statusCode).toBe(200);
    }
    expect((await fromProxy("203.0.113.11")).res.statusCode).toBe(200);
    const limited = await fromProxy("203.0.113.10");
    expect(limited.res.statusCode).toBe(429);
    expect(Number(responseHeader(limited, "Retry-After"))).toBeGreaterThan(0);
    expect(reader).toHaveBeenCalledTimes(21);
  });

  it("rate-limits malformed opaque tokens before transcript work", async () => {
    const server = createPublicGateway();
    const invalidPath = buildControlUiPublicSessionSharePath({
      token: `v1.${"z".repeat(96)}`,
    });
    for (let request = 0; request < 20; request += 1) {
      expect((await send(server, { path: invalidPath })).res.statusCode).toBe(404);
    }
    const limited = await send(server, { path: invalidPath });
    expect(limited.res.statusCode).toBe(429);
    expect(Number(responseHeader(limited, "Retry-After"))).toBeGreaterThan(0);
    expect(tokenResolver).toHaveBeenCalledTimes(20);
    expect(reader).not.toHaveBeenCalled();
  });

  it("evicts old client buckets instead of locking out every new viewer", async () => {
    const server = createPublicGateway("", {
      gateway: {
        publicOrigin: "https://gateway.example.test",
        trustedProxies: ["10.0.0.1"],
      },
    });
    const invalidPath = buildControlUiPublicSessionSharePath({
      token: `v1.${"z".repeat(96)}`,
    });
    for (let request = 0; request <= 4_096; request += 1) {
      const response = await send(server, {
        path: invalidPath,
        remoteAddress: "10.0.0.1",
        headers: {
          "x-forwarded-for": `2001:db8::${request.toString(16)}`,
          "x-forwarded-proto": "https",
        },
      });
      expect(response.res.statusCode).toBe(404);
    }
    expect(tokenResolver).toHaveBeenCalledTimes(4_097);
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps bearer navigation relative without an explicit external origin", async () => {
    const response = await send(createPublicGateway("", {}));
    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).not.toContain('rel="canonical"');
    expect(response.getBody()).not.toContain('property="og:url"');
    expect(response.getBody()).toContain(`href="${requestPath()}">Refresh now</a>`);
  });

  it("rejects public bearer traffic over remote plaintext HTTP", async () => {
    const response = await send(
      createPublicGateway("", {
        gateway: { publicOrigin: "http://gateway.example.test" },
      }),
      { remoteAddress: "203.0.113.12" },
    );
    expect(response.res.statusCode).toBe(404);
    expect(tokenResolver).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects a direct remote plaintext request despite an HTTPS public origin", async () => {
    const response = await send(
      createPublicGateway("", {
        gateway: { publicOrigin: "https://gateway.example.test" },
      }),
      { remoteAddress: "203.0.113.13" },
    );
    expect(response.res.statusCode).toBe(404);
    expect(tokenResolver).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects trusted-proxy traffic whose external hop was plaintext", async () => {
    const response = await send(
      createPublicGateway("", {
        gateway: {
          publicOrigin: "https://gateway.example.test",
          trustedProxies: ["10.0.0.1"],
        },
      }),
      {
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.14", "x-forwarded-proto": "http" },
      },
    );
    expect(response.res.statusCode).toBe(404);
    expect(tokenResolver).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("rechecks revocation after coalesced work before writing the response", async () => {
    shareActive.mockReturnValue(false);
    const response = await send(createPublicGateway());
    expect(response.res.statusCode).toBe(404);
    expect(response.getBody()).toBe("This public session is unavailable.");
    expect(response.getBody()).not.toContain("The public viewer is ready.");
  });

  it("caps aggregate requests to one publication across clients", async () => {
    const server = createPublicGateway("", {
      gateway: {
        publicOrigin: "https://gateway.example.test",
        trustedProxies: ["10.0.0.1"],
      },
    });
    for (let request = 0; request < 120; request += 1) {
      const response = await send(server, {
        remoteAddress: "10.0.0.1",
        headers: {
          "x-forwarded-for": `2001:db8::${request.toString(16)}`,
          "x-forwarded-proto": "https",
        },
      });
      expect(response.res.statusCode).toBe(200);
    }
    const limited = await send(server, {
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "2001:db8::ffff", "x-forwarded-proto": "https" },
    });
    expect(limited.res.statusCode).toBe(429);
    expect(Number(responseHeader(limited, "Retry-After"))).toBeGreaterThan(0);
    expect(reader).toHaveBeenCalledTimes(120);
  });

  it("coalesces identical reads and caps unique concurrent reads per publication", async () => {
    const server = createPublicGateway();
    const resolvers: Array<(value: typeof PUBLIC_SESSION) => void> = [];
    reader.mockImplementation(
      () =>
        new Promise<typeof PUBLIC_SESSION>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const firstResponse = createResponse();
    const first = dispatchRequest(
      server,
      createRequest({
        path: requestPath(),
        host: "127.0.0.1:18789",
        remoteAddress: "127.0.0.1",
      }),
      firstResponse.res,
    );
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
    const secondResponse = createResponse();
    const second = dispatchRequest(
      server,
      createRequest({
        path: requestPath(),
        host: "127.0.0.1:18789",
        remoteAddress: "127.0.0.1",
      }),
      secondResponse.res,
    );
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(2));
    expect(reader).toHaveBeenCalledTimes(1);
    resolvers.shift()?.(PUBLIC_SESSION);
    await Promise.all([first, second]);
    expect(firstResponse.res.statusCode).toBe(200);
    expect(secondResponse.res.statusCode).toBe(200);

    const held: Array<Promise<void>> = [];
    for (const [index, offset] of [1, 2].entries()) {
      const response = createResponse();
      held.push(
        dispatchRequest(
          server,
          createRequest({
            path: requestPath({ offset }),
            host: "127.0.0.1:18789",
            remoteAddress: "127.0.0.1",
          }),
          response.res,
        ),
      );
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(index + 2));
    }
    const excess = await send(server, { path: requestPath({ offset: 3 }) });
    expect(excess.res.statusCode).toBe(503);
    expect(responseHeader(excess, "Retry-After")).toBe("1");
    expect(reader).toHaveBeenCalledTimes(3);
    for (const resolve of resolvers.splice(0)) {
      resolve(PUBLIC_SESSION);
    }
    await Promise.all(held);
  });

  it("caps unique concurrent reads across publications", async () => {
    const server = createPublicGateway();
    const resolvers: Array<(value: typeof PUBLIC_SESSION) => void> = [];
    reader.mockImplementation(
      () =>
        new Promise<typeof PUBLIC_SESSION>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const held: Array<Promise<void>> = [];
    for (let request = 0; request < 8; request += 1) {
      const shareId = request.toString(16).padStart(48, "0");
      const response = createResponse();
      held.push(
        dispatchRequest(
          server,
          createRequest({
            path: requestPath({ locator: { ...LOCATOR, shareId } }),
            host: "127.0.0.1:18789",
            remoteAddress: "127.0.0.1",
          }),
          response.res,
        ),
      );
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(request + 1));
    }
    const excess = await send(server, {
      path: requestPath({ locator: { ...LOCATOR, shareId: "f".repeat(48) } }),
    });
    expect(excess.res.statusCode).toBe(503);
    expect(reader).toHaveBeenCalledTimes(8);
    for (const resolve of resolvers) {
      resolve(PUBLIC_SESSION);
    }
    await Promise.all(held);
  });
});
