import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaModels, readOllamaModelShowInfo } from "./provider-models.js";
import { pullOllamaModel } from "./setup-pull.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";

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

async function expectReleaseWithoutWaitingForCapture(params: {
  body: string;
  status: number;
  run: () => Promise<unknown>;
}): Promise<void> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(params.body));
    },
  });
  const response = new Response(source, { status: params.status });
  const captureClone = response.clone();
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response,
    finalUrl: "http://127.0.0.1:11434/api/test",
    release,
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      params.run(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Ollama cleanup waited for a captured response clone"));
        }, 500);
      }),
    ]);
    expect(response.bodyUsed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await captureClone.body?.cancel().catch(() => undefined);
  }
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
      name: "model inspection error",
      body: "ollama unavailable",
      status: 503,
      run: async () => {
        await readOllamaModelShowInfo("http://127.0.0.1:11434", "gemma4:e2b").catch(
          () => undefined,
        );
      },
    },
    {
      name: "model discovery error",
      body: "ollama unavailable",
      status: 503,
      run: async () => {
        await fetchOllamaModels("http://127.0.0.1:11434");
      },
    },
    {
      name: "auth probe fallback",
      body: "ollama unavailable",
      status: 503,
      run: async () => {
        await checkOllamaCloudAuth("http://127.0.0.1:11434");
      },
    },
    {
      name: "pull response error",
      body: "ollama unavailable",
      status: 503,
      run: async () => {
        await pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", createPullPrompter());
      },
    },
    {
      name: "pull stream error",
      body: '{"error":"disk full"}\n',
      status: 200,
      run: async () => {
        await pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", createPullPrompter());
      },
    },
  ])("releases a $name while capture retains a response clone", async ({ body, run, status }) => {
    await expectReleaseWithoutWaitingForCapture({ body, run, status });
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
