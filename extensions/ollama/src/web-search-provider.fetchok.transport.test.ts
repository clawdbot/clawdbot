import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  status: 401,
  boundaryCredentialAtCap: false,
  authorization: undefined as string | undefined,
  socketClosed: undefined as Promise<void> | undefined,
  releases: [] as Array<{
    bodyIsNull: boolean;
    bodyUsed: boolean;
    socketClosedBeforeGuardRelease: boolean;
  }>,
}));

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("Ollama web search test server did not receive a request");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Ollama auth-failure response was not canceled before guarded release"));
        }, 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        policy: { allowPrivateNetwork: true },
        url: loopback.baseUrl,
      });
      return {
        ...guarded,
        release: async () => {
          let socketClosedBeforeGuardRelease = false;
          try {
            if (guarded.response.status === 401 || guarded.response.status === 403) {
              await waitForSocketClose(loopback.socketClosed);
              socketClosedBeforeGuardRelease = true;
            }
          } finally {
            loopback.releases.push({
              bodyIsNull: guarded.response.body === null,
              bodyUsed: guarded.response.bodyUsed,
              socketClosedBeforeGuardRelease,
            });
            await guarded.release();
          }
        },
      };
    },
  };
});

const { createOllamaWebSearchProvider } = await import("./web-search-provider.js");

const RESPONSE_BODY = '{"error":"unauthorized"}';

let server: Server;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((request, response) => {
    loopback.authorization = request.headers.authorization;
    loopback.socketClosed = new Promise<void>((resolve) => {
      request.socket.once("close", resolve);
    });
    const bearerCredential = loopback.authorization?.replace(/^\S+\s+/u, "") ?? "";
    const responseBody = (() => {
      if (loopback.status === 429) {
        if (loopback.boundaryCredentialAtCap) {
          const retainedPrefix = bearerCredential.slice(0, -5);
          const safeMarker = "bounded web-search diagnostic: ";
          return `${safeMarker}${"x".repeat(64_000 - safeMarker.length - retainedPrefix.length)}${bearerCredential} trailing text`;
        }
        return JSON.stringify({
          error: "rate limit exceeded",
          authorizationEcho: loopback.authorization,
          bearerEcho: bearerCredential,
        });
      }
      if (loopback.status === 200) {
        return JSON.stringify({
          results: [{ title: "Success", url: "https://example.com", content: "control" }],
        });
      }
      return RESPONSE_BODY;
    })();
    const completedResponse = loopback.status === 429 || loopback.status === 200;
    response.writeHead(loopback.status, {
      "content-length": String(
        completedResponse ? responseBody.length : responseBody.length + 1_024,
      ),
      "content-type": "application/json",
    });
    if (completedResponse) {
      response.end(responseBody);
    } else {
      response.write(responseBody);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  loopback.baseUrl = `http://127.0.0.1:${address.port}/api/web_search`;
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  loopback.status = 401;
  loopback.boundaryCredentialAtCap = false;
  loopback.authorization = undefined;
  loopback.socketClosed = undefined;
  loopback.releases = [];
});

describe("ollama web search guarded fetch", () => {
  it("cancels a stalled 401 body before guarded release", async () => {
    const tool = createOllamaWebSearchProvider().createTool({ config: {} } as never);
    if (!tool) {
      throw new Error("Expected Ollama web search tool");
    }

    await expect(tool.execute({ query: "latest openclaw release" })).rejects.toThrow(
      "ollama signin",
    );

    expect(loopback.releases.length).toBeGreaterThan(0);
    for (const release of loopback.releases) {
      expect(release).toEqual({
        bodyIsNull: false,
        bodyUsed: true,
        socketClosedBeforeGuardRelease: true,
      });
    }
  });

  it("cancels a stalled 403 body before guarded release", async () => {
    loopback.status = 403;
    const tool = createOllamaWebSearchProvider().createTool({ config: {} } as never);
    if (!tool) {
      throw new Error("Expected Ollama web search tool");
    }

    await expect(tool.execute({ query: "latest openclaw release" })).rejects.toThrow("unavailable");

    expect(loopback.releases.length).toBeGreaterThan(0);
    for (const release of loopback.releases) {
      expect(release).toEqual({
        bodyIsNull: false,
        bodyUsed: true,
        socketClosedBeforeGuardRelease: true,
      });
    }
  });

  it("redacts a reflected bearer credential from a real completed 429 response", async () => {
    loopback.status = 429;
    const bearerCredential = "web-search-transport-bearer-secret";
    const authorization = `Bearer ${bearerCredential}`;
    const tool = createOllamaWebSearchProvider().createTool({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              api: "ollama",
              models: [],
              apiKey: bearerCredential,
            },
          },
        },
      },
    } as never);
    if (!tool) {
      throw new Error("Expected Ollama web search tool");
    }

    const error = await tool
      .execute({ query: "latest openclaw release" })
      .catch((caught: unknown) => caught);
    if (!(error instanceof Error)) {
      throw new Error("expected Ollama web search error");
    }

    expect(loopback.authorization).toBe(authorization);
    expect(error.message).toContain("Ollama web search failed (429)");
    expect(error.message).toContain("rate limit exceeded");
    expect(error.message).not.toContain(authorization);
    expect(error.message).not.toContain(bearerCredential);
    expect(loopback.releases).toEqual([
      {
        bodyIsNull: false,
        bodyUsed: true,
        socketClosedBeforeGuardRelease: false,
      },
    ]);

    loopback.status = 200;
    const result = await tool.execute({ query: "latest openclaw release" });
    expect(result).toMatchObject({ provider: "ollama", count: 1 });
    console.info(
      "[ollama credential redaction proof] surface=web-search status=429 safe-marker-present=true authorization-secret-absent=true custom-secret-absent=true success-control=true",
    );
  });

  it("redacts a bearer prefix split by the 64,000-byte error cap", async () => {
    loopback.status = 429;
    loopback.boundaryCredentialAtCap = true;
    const bearerCredential = "web-search-boundary-credential-secret";
    const retainedPrefix = bearerCredential.slice(0, -5);
    const tool = createOllamaWebSearchProvider().createTool({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              api: "ollama",
              models: [],
              apiKey: bearerCredential,
            },
          },
        },
      },
    } as never);
    if (!tool) {
      throw new Error("Expected Ollama web search tool");
    }

    const error = await tool
      .execute({ query: "latest openclaw release" })
      .catch((caught: unknown) => caught);
    if (!(error instanceof Error)) {
      throw new Error("expected Ollama web search error");
    }

    expect(error.message).toContain("bounded web-search diagnostic");
    expect(error.message).not.toContain(retainedPrefix);
    expect(error.message).not.toContain(bearerCredential);
  });
});
