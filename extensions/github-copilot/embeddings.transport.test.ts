// Exercise discovery and embeddings over real sockets, including request
// cancellation and redaction without relying on fetch or SSRF mocks.
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DiagnosticsChannel } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotRuntimeAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveFirstGithubTokenMock,
}));

vi.mock("./runtime-auth.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotRuntimeAuth: resolveCopilotRuntimeAuthMock,
}));

import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";

type CopilotServer = {
  baseUrl: string;
  requests: Array<{ method: string | undefined; url: string | undefined }>;
};

const servers: Array<{ close: () => Promise<void> }> = [];

const DISCOVERY_MODELS_BODY = JSON.stringify({
  data: [{ id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] }],
});

async function startCopilotServer(handle: {
  models: { status: number; body: string } | ((response: ServerResponse) => void);
  embeddings?: { status: number; body: string } | ((response: ServerResponse) => void);
  observeRequest?: (request: IncomingMessage, body: string) => void;
}): Promise<CopilotServer> {
  const requests: CopilotServer["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // Drain the request body so keep-alive sockets close cleanly.
      const body = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      handle.observeRequest?.(req, body);
      requests.push({ method: req.method, url: req.url });
      const isEmbeddings = req.method === "POST" && req.url === "/embeddings";
      const route = isEmbeddings && handle.embeddings ? handle.embeddings : handle.models;
      if (typeof route === "function") {
        route(res);
        return;
      }
      res.writeHead(route.status, { "content-type": "application/json" });
      res.end(route.body);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  });

  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function pointTokenAt(baseUrl: string): void {
  resolveCopilotRuntimeAuthMock.mockResolvedValue({
    apiKey: "copilot_test_token_abc",
    source: "test",
    baseUrl,
  });
}

function defaultCreateOptions() {
  return {
    config: {} as Record<string, unknown>,
    agentDir: "/tmp/test-agent",
    model: "",
  };
}

// Points the global logging-config reader at an on-disk config with sensitive
// redaction turned off, so the test proves the error paths force masking rather
// than inheriting the operator's `logging.redactSensitive` preference.
function withRedactionDisabledConfig(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-redact-off-"));
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ logging: { redactSensitive: "off" } }));
  const previous = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  return () => {
    if (previous === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

describe("githubCopilotMemoryEmbeddingProviderAdapter real transport", () => {
  beforeEach(() => {
    resolveFirstGithubTokenMock.mockResolvedValue({
      githubToken: "gh_test_token_123",
      hasProfile: false,
    });
  });

  afterEach(async () => {
    const pending = servers.splice(0);
    await Promise.all(pending.map((server) => server.close()));
    resolveFirstGithubTokenMock.mockReset();
    resolveCopilotRuntimeAuthMock.mockReset();
  });

  it.each(["headers", "trickling body"])(
    "aborts model discovery with stalled %s within its operation deadline",
    async (phase) => {
      let bodyReceived = false;
      let connectionClosed = false;
      const server = await startCopilotServer({
        models: (response) => {
          const trickle =
            phase === "trickling body" ? setInterval(() => response.write(" "), 100) : undefined;
          // Finish successfully beyond the deadline so a missing timeout fails
          // the assertion without leaving a hanging request in the test process.
          const finish = setTimeout(() => response.end(DISCOVERY_MODELS_BODY), 15_000);
          response.on("close", () => {
            connectionClosed = true;
            clearInterval(trickle);
            clearTimeout(finish);
          });
        },
      });
      const bodyChannel = channel("undici:request:bodyChunkReceived");
      const onBody = (message: unknown) => {
        const { request } = message as DiagnosticsChannel.RequestBodyChunkReceivedMessage;
        if (String(request.origin) === server.baseUrl && request.path === "/models") {
          bodyReceived = true;
        }
      };
      bodyChannel.subscribe(onBody);
      const realSetTimeout = globalThis.setTimeout;
      // Scale long deadlines together, leaving Undici's retained sub-second
      // timer pump and the real body trickle untouched across later requests.
      const timeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) =>
          realSetTimeout(
            callback,
            delay !== undefined && delay >= 1_000 ? Math.ceil(delay / 10) : delay,
            ...args,
          ),
        );
      const startedAt = performance.now();

      try {
        await expect(
          githubCopilotMemoryEmbeddingProviderAdapter.create({
            ...defaultCreateOptions(),
            remote: { baseUrl: server.baseUrl, apiKey: "copilot-test-only" },
          }),
        ).rejects.toThrow("request timed out");

        expect(performance.now() - startedAt).toBeLessThan(1_500);
        expect(bodyReceived).toBe(phase === "trickling body");
        await vi.waitFor(() => expect(connectionClosed).toBe(true));
        expect(server.requests).toEqual([{ method: "GET", url: "/models" }]);
      } finally {
        bodyChannel.unsubscribe(onBody);
        timeoutSpy.mockRestore();
      }
    },
    20_000,
  );

  it("redacts credential-shaped text in model discovery errors over real transport", async () => {
    const server = await startCopilotServer({
      models: {
        status: 401,
        body: '{"error":{"message":"authentication failed"},"access_token":"ghu_AAAAUNIQUESECRETXXXX111122223333"}',
      },
    });
    pointTokenAt(server.baseUrl);

    let caught: Error | undefined;
    try {
      await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
    } catch (error) {
      caught = error as Error;
    }

    expect(server.requests).toEqual([{ method: "GET", url: "/models" }]);
    expect(caught?.message).toContain("GitHub Copilot model discovery HTTP 401");
    expect(caught?.message).toContain("authentication failed");
    expect(caught?.message).not.toContain("ghu_AAAAUNIQUESECRETXXXX111122223333");
    expect(caught?.message).not.toContain("UNIQUESECRET");
  });

  it("redacts credential-shaped text in embeddings errors over real transport", async () => {
    const server = await startCopilotServer({
      models: { status: 200, body: DISCOVERY_MODELS_BODY },
      embeddings: {
        status: 429,
        body: '{"error":{"message":"rate limit exceeded"},"access_token":"gho_BBBBUNIQUEEMBSECRETYYYY444455556666"}',
      },
    });
    pointTokenAt(server.baseUrl);

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    let caught: Error | undefined;
    try {
      await result.provider?.embed("hello", { inputType: "query" });
    } catch (error) {
      caught = error as Error;
    }

    expect(server.requests).toEqual([
      { method: "GET", url: "/models" },
      { method: "POST", url: "/embeddings" },
    ]);
    expect(caught?.message).toContain("GitHub Copilot embeddings HTTP 429");
    expect(caught?.message).toContain("rate limit exceeded");
    expect(caught?.message).not.toContain("gho_BBBBUNIQUEEMBSECRETYYYY444455556666");
    expect(caught?.message).not.toContain("UNIQUEEMBSECRET");
  });

  it("still redacts when logging.redactSensitive is off", async () => {
    const restoreConfig = withRedactionDisabledConfig();
    try {
      const server = await startCopilotServer({
        models: {
          status: 403,
          body: '{"error":{"message":"forbidden"},"access_token":"ghu_CCCCUNIQUEOFFSECRETZZZZ777788889999"}',
        },
      });
      pointTokenAt(server.baseUrl);

      let caught: Error | undefined;
      try {
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).toContain("GitHub Copilot model discovery HTTP 403");
      expect(caught?.message).toContain("forbidden");
      // Forced `tools` mode must mask the token even though on-disk config
      // disables general log redaction; a config-honoring call would leak it.
      expect(caught?.message).not.toContain("ghu_CCCCUNIQUEOFFSECRETZZZZ777788889999");
      expect(caught?.message).not.toContain("UNIQUEOFFSECRET");
    } finally {
      restoreConfig();
    }
  });

  it.each(["profile", "custom"])(
    "preserves %s authentication and embedding wire requests",
    async (auth) => {
      const observed: Array<{
        authorization: string | undefined;
        integration: unknown;
        custom: unknown;
        body: string;
      }> = [];
      const server = await startCopilotServer({
        models: { status: 200, body: DISCOVERY_MODELS_BODY },
        observeRequest: (request, body) => {
          observed.push({
            authorization: request.headers.authorization,
            integration: request.headers["copilot-integration-id"],
            custom: request.headers["x-proof"],
            body,
          });
        },
        embeddings: (response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data:
                server.requests.length === 2
                  ? [{ index: 0, embedding: [3, 4] }]
                  : [
                      { index: 1, embedding: [0, 2] },
                      { index: 0, embedding: [3, 0] },
                    ],
            }),
          );
        },
      });
      pointTokenAt(server.baseUrl);

      const result = await githubCopilotMemoryEmbeddingProviderAdapter.create({
        ...defaultCreateOptions(),
        remote: {
          ...(auth === "custom" ? { baseUrl: server.baseUrl, apiKey: "explicit-test-token" } : {}),
          headers: { Authorization: "replaced-test-token", "X-Proof": "forwarded" },
        },
      });
      expect(await result.provider?.embed("hello", { inputType: "query" })).toEqual([0.6, 0.8]);
      expect(await result.provider?.embedBatch(["first", { text: "second" }])).toEqual([
        [1, 0],
        [0, 1],
      ]);

      expect(server.requests).toEqual([
        { method: "GET", url: "/models" },
        { method: "POST", url: "/embeddings" },
        { method: "POST", url: "/embeddings" },
      ]);
      const authorization = `Bearer ${auth === "custom" ? "explicit-test-token" : "copilot_test_token_abc"}`;
      expect(observed).toEqual(
        [
          "",
          JSON.stringify({ model: "text-embedding-3-small", input: ["hello"] }),
          JSON.stringify({ model: "text-embedding-3-small", input: ["first", "second"] }),
        ].map((body) => ({
          authorization,
          integration: "copilot-developer-cli",
          custom: "forwarded",
          body,
        })),
      );
      expect(resolveFirstGithubTokenMock).toHaveBeenCalledTimes(auth === "custom" ? 0 : 1);
      expect(resolveCopilotRuntimeAuthMock).toHaveBeenCalledTimes(auth === "custom" ? 0 : 1);
    },
  );
});
