// Exercise Google Chat requests through a real guarded HTTP transport.
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
      if (!loopback.baseUrl || new URL(params.url).origin !== "https://chat.googleapis.com") {
        throw new Error("Unexpected request in Google Chat transport fixture");
      }
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

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getGoogleChatAccessToken: vi.fn(async () => proofToken),
}));

let deleteGoogleChatMessage: typeof import("./api.js").deleteGoogleChatMessage;
let sendGoogleChatMessage: typeof import("./api.js").sendGoogleChatMessage;

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

describe("Google Chat real guarded transport", () => {
  beforeAll(async () => {
    ({ deleteGoogleChatMessage, sendGoogleChatMessage } = await import("./api.js"));
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

  it("delivers task-list fallback at the default chunk limit through the SDK", async () => {
    const { withOpenClawTestState } = await import("openclaw/plugin-sdk/test-state");
    await withOpenClawTestState(
      { label: "googlechat-markdown-delivery", layout: "state-only" },
      async () => {
        const [
          { sendDurableMessageBatch },
          { createTestRegistry, withPluginRuntimeRegistryScope },
          { googlechatPlugin },
        ] = await Promise.all([
          import("openclaw/plugin-sdk/channel-outbound"),
          import("openclaw/plugin-sdk/channel-test-helpers"),
          import("../api.js"),
        ]);
        const requests: Array<{
          method: string | undefined;
          path: string | undefined;
          body: string;
        }> = [];
        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            requests.push({ method: request.method, path: request.url, body });
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ name: `spaces/AAA/messages/${requests.length}` }));
          });
        });

        try {
          loopback.baseUrl = await listen(server);
          const paragraph = "A".repeat(31_998);
          const result = await withPluginRuntimeRegistryScope(
            createTestRegistry([
              { pluginId: "googlechat", plugin: googlechatPlugin, source: "test" },
            ]),
            () =>
              sendDurableMessageBatch({
                cfg: {
                  channels: {
                    googlechat: {
                      serviceAccount: {
                        client_email: "transport@example.test",
                        private_key: "not-a-real-key",
                      },
                    },
                  },
                },
                channel: "googlechat",
                accountId: "default",
                to: "spaces/AAA",
                payloads: [{ text: `**${paragraph}**\n\n- [x] done` }],
              }),
          );
          expect(result).toMatchObject({
            status: "sent",
            deliveryIntent: { queuePolicy: "required" },
            receipt: {
              platformMessageIds: ["spaces/AAA/messages/1", "spaces/AAA/messages/2"],
            },
          });
          expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
            { method: "POST", path: "/v1/spaces/AAA/messages" },
            { method: "POST", path: "/v1/spaces/AAA/messages" },
          ]);
          const messages: Array<{ text: string }> = requests.map(({ body }) => JSON.parse(body));
          expect(messages).toEqual([{ text: `*${paragraph}*` }, { text: "\n\n[x] done" }]);
          expect(messages.every(({ text }) => Buffer.byteLength(text, "utf8") <= 32_000)).toBe(
            true,
          );
        } finally {
          await closeServer(server);
        }
      },
    );
  });

  it("rejects malformed UTF-8 JSON through the real guarded transport", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"name":"spaces/'),
      0xff,
      ...new TextEncoder().encode('AAA"}'),
    ]);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(body);
    });

    loopback.baseUrl = await listen(server);
    try {
      const outcome = await withinDeadline(
        sendGoogleChatMessage({ account, space: "spaces/AAA", text: "hello" }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/malformed JSON response/);
    } finally {
      await closeServer(server);
    }
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
    let receivedAuthorization: string | undefined;
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Chat permission denied" },
          reflectedHeader: `Authorization: ${receivedAuthorization}`,
        }),
      );
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
      expect(receivedAuthorization).toBe(`Bearer ${proofToken}`);
      expect((outcome as Error).message).toContain("Google Chat API 403");
      expect((outcome as Error).message).toContain("Chat permission denied");
      expect((outcome as Error).message).toContain("Authorization: Bearer");
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
