// Exercise Google Chat status-only requests through a real guarded HTTP transport.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const proofToken = "googlechat-transport-test-token";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  cloneResponse: false,
  rejectCancellation: false,
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
  signal: undefined as AbortSignal | undefined,
}));

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      fetchWithSsrFGuardMock(...args);
      const [params] = args;
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        url: params.url.replace("https://chat.googleapis.com", loopback.baseUrl),
        policy: { allowPrivateNetwork: true },
        ...(loopback.signal ? { signal: loopback.signal } : {}),
      });

      if (loopback.cloneResponse) {
        // Debug-proxy capture tees a response and can leave its clone reading.
        // Awaiting cancellation of the other branch would deadlock release.
        void guarded.response
          .clone()
          .arrayBuffer()
          .catch(() => undefined);
      }

      if (loopback.rejectCancellation && guarded.response.body) {
        vi.spyOn(guarded.response.body, "cancel").mockRejectedValueOnce(
          new Error("simulated response cancellation failure"),
        );
      }

      return {
        ...guarded,
        release: async () => {
          loopback.releases.push({
            bodyIsNull: guarded.response.body === null,
            bodyUsed: guarded.response.bodyUsed,
          });
          await guarded.release();
        },
      };
    },
  };
});

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn(async () => proofToken),
}));

let deleteGoogleChatMessage: typeof import("./api.js").deleteGoogleChatMessage;

const account = {
  accountId: "default",
  enabled: true,
  config: {},
  credentialSource: "env",
} as ResolvedGoogleChatAccount;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  // A stalled response is an active connection, which server.close() cannot close.
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await withinDeadline(closed);
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Google Chat transport proof timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe("deleteGoogleChatMessage real guarded transport", () => {
  beforeAll(async () => {
    ({ deleteGoogleChatMessage } = await import("./api.js"));
  });

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    loopback.baseUrl = "";
    loopback.cloneResponse = false;
    loopback.rejectCancellation = false;
    loopback.releases = [];
    loopback.signal = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels a streaming authenticated DELETE before releasing its real dispatcher", async () => {
    let socketClosed = false;
    let receivedAuthorization: string | undefined;
    let receivedPath: string | undefined;
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      receivedPath = request.url;
      request.socket.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{}");
    });

    loopback.baseUrl = await listen(server);
    try {
      await expect(
        withinDeadline(
          deleteGoogleChatMessage({ account, messageName: "spaces/AAA/messages/BBB" }),
        ),
      ).resolves.toBeUndefined();

      expect(receivedAuthorization).toBe(`Bearer ${proofToken}`);
      expect(receivedPath).toBe("/v1/spaces/AAA/messages/BBB");
      expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          auditContext: "googlechat.api.ok",
          init: expect.objectContaining({ method: "DELETE" }),
        }),
      );
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await closeServer(server);
    }
  });

  it("releases a captured streaming response without waiting for its tee branch", async () => {
    loopback.cloneResponse = true;
    let socketClosed = false;
    const server = createServer((request, response) => {
      request.socket.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{}");
    });

    loopback.baseUrl = await listen(server);
    try {
      await expect(
        withinDeadline(
          deleteGoogleChatMessage({ account, messageName: "spaces/AAA/messages/CAPTURED" }),
        ),
      ).resolves.toBeUndefined();
      expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
      await closeServer(server);
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await closeServer(server);
    }
  });

  it("releases a successful no-content response without cancelling a missing body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    loopback.baseUrl = await listen(server);
    try {
      await expect(
        withinDeadline(
          deleteGoogleChatMessage({ account, messageName: "spaces/AAA/messages/EMPTY" }),
        ),
      ).resolves.toBeUndefined();
      expect(loopback.releases).toEqual([{ bodyIsNull: true, bodyUsed: false }]);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves Google Chat errors without exposing the bearer token", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Chat permission denied" } }));
    });

    loopback.baseUrl = await listen(server);
    try {
      const outcome = await withinDeadline(
        deleteGoogleChatMessage({ account, messageName: "spaces/AAA/messages/FORBIDDEN" }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("Google Chat API 403");
      expect((outcome as Error).message).toContain("Chat permission denied");
      expect((outcome as Error).message).not.toContain(proofToken);
      expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
    } finally {
      await closeServer(server);
    }
  });

  it("still releases the real dispatcher when stream cancellation rejects", async () => {
    loopback.rejectCancellation = true;
    let socketClosed = false;
    const server = createServer((request, response) => {
      request.socket.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{}");
    });

    loopback.baseUrl = await listen(server);
    try {
      await expect(
        withinDeadline(
          deleteGoogleChatMessage({ account, messageName: "spaces/AAA/messages/CANCEL" }),
        ),
      ).resolves.toBeUndefined();
      expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: false }]);
      await closeServer(server);
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await closeServer(server);
    }
  });

  it("aborts an authenticated in-flight DELETE and closes the real socket", async () => {
    const controller = new AbortController();
    loopback.signal = controller.signal;
    let socketClosed = false;
    let receivedAuthorization: string | undefined;
    const server = createServer((request) => {
      receivedAuthorization = request.headers.authorization;
      request.socket.once("close", () => {
        socketClosed = true;
      });
      controller.abort(new Error("Google Chat transport proof aborted"));
    });

    loopback.baseUrl = await listen(server);
    try {
      const outcome = await withinDeadline(
        deleteGoogleChatMessage({ account, messageName: "spaces/AAA/messages/ABORT" }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/abort/i);
      expect((outcome as Error).message).not.toContain(proofToken);
      expect(receivedAuthorization).toBe(`Bearer ${proofToken}`);
      expect(loopback.releases).toEqual([]);
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await closeServer(server);
    }
  });
});
