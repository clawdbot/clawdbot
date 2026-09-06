import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { captureHttpExchange, type CaptureEventRecord } from "openclaw/plugin-sdk/proxy-capture";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  url: "",
  release: async () => {},
  received: undefined as ((response: Response) => void) | undefined,
  captured: undefined as ((event: CaptureEventRecord) => void) | undefined,
}));

// Change only the destination to our owned server; keep the real guard,
// dispatcher, response reader, capture tee, and request cleanup.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...[params]: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        url: fixture.url,
        policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
        fetchImpl: async (input, init) => {
          const response = await fetchWithRuntimeDispatcher(input, init);
          const captured = fixture.captured;
          captureHttpExchange(
            { url: fixture.url, method: "GET", response },
            {
              enabled: true,
              required: false,
              dbPath: "unused-memory-sink",
              blobDir: "unused-memory-sink",
              certDir: "unused-memory-sink",
              sessionId: "googlechat-reader-test",
              sourceProcess: "test",
            },
            {
              getStore: () => ({
                upsertSession() {},
                endSession() {},
                recordEvent(event) {
                  if (event.kind === "response" || event.kind === "error") {
                    captured?.(event);
                  }
                },
              }),
              persistEventPayload: (_store, { data }) =>
                Buffer.isBuffer(data) ? { dataText: data.toString("utf8") } : {},
            },
          );
          return response;
        },
      });
      fixture.received?.(guarded.response);
      fixture.release = guarded.release;
      return guarded;
    },
  };
});

const { getGoogleAuthTransport, loadGoogleAuthRuntime } = await import("./google-auth.runtime.js");
const { verifyGoogleChatRequest } = await import("./auth.js");

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("Google Chat captured response cleanup", () => {
  it.each(["auth-overflow", "cert-error", "auth-complete"] as const)(
    "settles %s through the guarded transport before fixture cleanup",
    async (kind) => {
      const closed = createDeferred<void>();
      const captured = createDeferred<CaptureEventRecord>();
      const received = createDeferred<Response>();
      const sockets = new Map<Socket, Promise<void>>();
      const completeBody = '{"access_token":"fixture"}';
      let receivedResponse = false;
      fixture.received = (response) => {
        receivedResponse = true;
        received.resolve(response);
      };
      fixture.release = async () => {};
      fixture.captured = captured.resolve;
      const server = createServer((request, response) => {
        request.resume();
        request.socket.once("close", () => closed.resolve());
        response.writeHead(kind === "cert-error" ? 503 : 200, {
          "content-type": "application/json",
          connection: "close",
        });
        if (kind === "auth-complete") {
          response.end(completeBody);
        } else {
          response.write(kind === "auth-overflow" ? Buffer.alloc(1024 * 1024 + 1) : "unavailable");
        }
      });
      server.on("connection", (socket) => {
        sockets.set(
          socket,
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
          }),
        );
      });
      let operation: Promise<unknown> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { OAuth2Client } = await loadGoogleAuthRuntime();
      const verifyJwt = vi.spyOn(OAuth2Client.prototype, "verifySignedJwtWithCertsAsync");
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected owned TCP listener");
        }
        fixture.url = `http://127.0.0.1:${address.port}/response`;
        const transport = await getGoogleAuthTransport();
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Google Chat cleanup did not settle")), 1_000);
        });
        operation =
          kind === "cert-error"
            ? verifyGoogleChatRequest({
                bearer: "fixture",
                audienceType: "project-number",
                audience: "123",
              })
            : transport.request({ url: "https://oauth2.googleapis.com/token", retry: false });
        const observed = operation.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const outcome = await Promise.race([observed, deadline]);
        if (kind === "auth-overflow") {
          expect(outcome).toHaveProperty(
            "error.message",
            "Google auth response exceeds 1048576 bytes.",
          );
        } else if (kind === "cert-error") {
          expect(outcome).toEqual({
            value: { ok: false, reason: "Failed to fetch Chat certs (503)" },
          });
          expect(verifyJwt).not.toHaveBeenCalled();
        } else {
          expect(outcome).toMatchObject({ value: { data: { access_token: "fixture" } } });
        }
        await Promise.race([closed.promise, deadline]);
        const response = await Promise.race([received.promise, deadline]);
        expect(response.body?.locked).toBe(false);
        const event = await Promise.race([captured.promise, deadline]);
        expect(event.kind).toBe(kind === "auth-complete" ? "response" : "error");
        if (kind === "auth-complete") {
          expect(event.dataText).toBe(completeBody);
        }
      } finally {
        clearTimeout(timer);
        const stopped = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const socket of sockets.keys()) {
          socket.destroy();
        }
        await stopped;
        await Promise.all(sockets.values());
        await operation?.catch(() => undefined);
        await fixture.release();
        if (receivedResponse) {
          await captured.promise;
        }
        verifyJwt.mockRestore();
        fixture.captured = undefined;
        fixture.received = undefined;
      }
    },
  );
});
