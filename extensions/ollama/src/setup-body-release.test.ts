import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullOllamaModel } from "./setup-pull.js";
import { checkOllamaCloudAuth } from "./setup.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(body, init),
    wasCanceled: () => canceled,
  };
}

function createPullPrompter(): WizardPrompter {
  return {
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
}

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("Ollama test server did not receive a request");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Ollama response socket was not closed"));
        }, 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe("Ollama setup response cleanup", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it.each([200, 503])("cancels the /api/me body for HTTP %s", async (status) => {
    const tracked = cancelTrackedResponse('{"status":"unused"}\n', { status });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: "https://ollama.com/api/me",
      release,
    });

    await checkOllamaCloudAuth("https://ollama.com");

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "non-OK /api/pull response",
      response: () => cancelTrackedResponse("ollama unavailable", { status: 503 }),
    },
    {
      name: "streamed /api/pull error",
      response: () => cancelTrackedResponse('{"error":"disk full"}\n', { status: 200 }),
    },
  ])("cancels a $name body before returning", async ({ response: createResponse }) => {
    const tracked = createResponse();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: "http://127.0.0.1:11434/api/pull",
      release,
    });

    await expect(
      pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", createPullPrompter()),
    ).resolves.toBe(false);

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "successful auth probe",
      path: "/api/me",
      status: 200,
      body: '{"status":"unused"}\n',
      run: async (baseUrl: string) => {
        await checkOllamaCloudAuth(baseUrl);
      },
    },
    {
      name: "failed auth probe",
      path: "/api/me",
      status: 503,
      body: "ollama unavailable",
      run: async (baseUrl: string) => {
        await checkOllamaCloudAuth(baseUrl);
      },
    },
    {
      name: "failed pull response",
      path: "/api/pull",
      status: 503,
      body: "ollama unavailable",
      run: async (baseUrl: string) => {
        await pullOllamaModel(baseUrl, "gemma4:e2b", createPullPrompter());
      },
    },
    {
      name: "streamed pull error",
      path: "/api/pull",
      status: 200,
      body: '{"error":"disk full"}\n',
      run: async (baseUrl: string) => {
        await pullOllamaModel(baseUrl, "gemma4:e2b", createPullPrompter());
      },
    },
  ])("closes the real socket after a $name", async ({ path, status, body, run }) => {
    const sockets = new Set<Socket>();
    let requestSocketClosed: Promise<void> | undefined;
    const server = createServer((request, response) => {
      if (request.url !== path) {
        response.writeHead(404);
        response.end();
        return;
      }
      requestSocketClosed = new Promise<void>((resolve) => {
        request.socket.once("close", () => resolve());
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.write(body);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    fetchWithSsrFGuardMock.mockImplementation(
      async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
        response: await globalThis.fetch(params.url, {
          ...params.init,
          ...(params.signal ? { signal: params.signal } : {}),
        }),
        finalUrl: params.url,
        release: async () => {},
      }),
    );

    const listening = once(server, "listening");
    try {
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Ollama test server did not expose a TCP address");
      }

      await run(`http://127.0.0.1:${address.port}`);
      await waitForSocketClose(requestSocketClosed);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });
});
