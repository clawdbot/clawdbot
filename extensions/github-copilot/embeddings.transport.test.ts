// Real-transport regression proof for GitHub Copilot embedding error redaction.
// Drives the production discovery + embeddings paths against a loopback HTTP
// server with NO ssrf-runtime or global fetch mocks, so redactSensitiveText is
// exercised end to end over real sockets rather than synthetic stubs.
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveFirstGithubTokenMock,
}));

vi.mock("./token.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

// Intentionally NOT mocked: openclaw/plugin-sdk/ssrf-runtime, global fetch, and
// openclaw/plugin-sdk/logging-core (redactSensitiveText is the unit under proof).
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
  models: { status: number; body: string };
  embeddings?: { status: number; body: string };
}): Promise<CopilotServer> {
  const requests: CopilotServer["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // Drain the request body so keep-alive sockets close cleanly.
      await new Promise<void>((resolve) => {
        req.resume();
        req.on("end", resolve);
      });
      requests.push({ method: req.method, url: req.url });
      const isEmbeddings = req.method === "POST" && req.url === "/embeddings";
      const route = isEmbeddings && handle.embeddings ? handle.embeddings : handle.models;
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
      }),
  });

  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function pointTokenAt(baseUrl: string): void {
  resolveCopilotApiTokenMock.mockResolvedValue({
    token: "copilot_test_token_abc",
    expiresAt: Date.now() + 3_600_000,
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
    resolveCopilotApiTokenMock.mockReset();
  });

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
      await result.provider?.embedQuery("hello");
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

  it("returns embedding vectors on a successful response over real transport", async () => {
    const server = await startCopilotServer({
      models: { status: 200, body: DISCOVERY_MODELS_BODY },
      embeddings: {
        status: 200,
        body: JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
      },
    });
    pointTokenAt(server.baseUrl);

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
    const vector = await result.provider?.embedQuery("hello");

    expect(server.requests).toEqual([
      { method: "GET", url: "/models" },
      { method: "POST", url: "/embeddings" },
    ]);
    expect(Array.isArray(vector)).toBe(true);
    expect(vector).toHaveLength(3);
    expect(vector?.every((value) => typeof value === "number")).toBe(true);
  });
});
