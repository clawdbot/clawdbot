// Real HTTP-server proof for LM Studio model-load error-body redaction.
//
// This test starts a local HTTP server that emulates LM Studio's discovery and
// load endpoints. The load endpoint returns a 502 whose body reflects the
// outbound Authorization header, which is the exact scenario that previously
// leaked credentials into operator-visible errors.
//
// Running this file proves that, after the fix, the reflected Bearer token is
// scrubbed from the thrown Error.message while safe diagnostics are preserved,
// and that bodies exceeding the 8 KiB cap are suppressed entirely.

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";

const secretToken = "sk-test-token-proof-abc123";
const shortApiKey = "sk-test";
const modelKey = "qwen3-8b-instruct";

let server: http.Server;
let serverUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/v1/models") && req.method !== "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [{ type: "llm", key: modelKey, loaded_instances: [] }],
        }),
      );
      return;
    }

    if (req.url?.startsWith("/api/v1/models/load")) {
      const authHeader = (req.headers.authorization as string) ?? "(no auth header)";
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`upstream proxy error: reflected ${authHeader}`);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr !== "object") {
    throw new Error("Proof HTTP server did not bind to a port");
  }
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe("proof: LM Studio error body credential redaction (real HTTP)", () => {
  it("redacts reflected Bearer token from upstream error response", async () => {
    const error = await ensureLmstudioModelLoaded({
      baseUrl: serverUrl,
      modelKey,
      apiKey: secretToken,
      timeoutMs: 10_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;

    expect(message).toMatch(/LM Studio model load failed \(502\)/);
    expect(message).toContain("upstream proxy error");
    expect(message).not.toContain(secretToken);
    console.log(`[proof] scene=reflected-bearer status=pass leaked=false`);
  });

  it("redacts short configured API keys that generic patterns may miss", async () => {
    const error = await ensureLmstudioModelLoaded({
      baseUrl: serverUrl,
      modelKey,
      apiKey: shortApiKey,
      timeoutMs: 10_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;

    expect(message).toMatch(/LM Studio model load failed \(502\)/);
    expect(message).not.toContain(shortApiKey);
    console.log(`[proof] scene=short-api-key status=pass leaked=false`);
  });

  it("suppresses truncated error bodies to avoid leaking credential fragments", async () => {
    const truncServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/v1/models") && req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ type: "llm", key: modelKey, loaded_instances: [] }] }));
        return;
      }
      if (req.url?.startsWith("/api/v1/models/load")) {
        const authHeader = (req.headers.authorization as string) ?? "";
        // Body exceeds the 8 KiB cap so the truncation-aware reader drops it.
        const body = `upstream proxy error: reflected ${authHeader}\n${"x".repeat(9 * 1024)}`;
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => {
      truncServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = truncServer.address();
    if (!addr || typeof addr !== "object") {
      throw new Error("Truncation proof server did not bind");
    }
    const truncUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const error = await ensureLmstudioModelLoaded({
        baseUrl: truncUrl,
        modelKey,
        apiKey: secretToken,
        timeoutMs: 10_000,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;

      expect(message).toMatch(/LM Studio model load failed \(502\)/);
      expect(message).not.toContain(secretToken);
      expect(message).not.toContain("upstream proxy error");
      console.log(`[proof] scene=truncated-body status=pass leaked=false`);
    } finally {
      truncServer.close();
    }
  });

  it("preserves non-sensitive diagnostic text in error bodies", async () => {
    const plainServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/v1/models") && req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [{ type: "llm", key: modelKey, loaded_instances: [] }],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/api/v1/models/load")) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("GPU out of memory");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => {
      plainServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = plainServer.address();
    if (!addr || typeof addr !== "object") {
      throw new Error("Diagnostic proof server did not bind");
    }
    const plainUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const error = await ensureLmstudioModelLoaded({
        baseUrl: plainUrl,
        modelKey,
        apiKey: secretToken,
        timeoutMs: 10_000,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;

      expect(message).toContain("GPU out of memory");
      expect(message).not.toContain(secretToken);
      console.log(`[proof] scene=preserve-diagnostics status=pass leaked=false`);
    } finally {
      plainServer.close();
    }
  });
});
