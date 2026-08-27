import fs from "node:fs/promises";
// Real HTTP loopback proof for the Comfy headers SecretRef path (env and
// non-env), plus the isComfyCapabilityConfigured availability gate around
// it. Unlike image-generation-provider.test.ts, ssrf-runtime is NOT mocked
// here: fetchWithSsrFGuard makes real requests over a real socket to a real
// node:http server standing in for ComfyUI, so this proves the literal wire
// behavior rather than an intercepted call -- see
// packages/ai/src/transports/openai-responses-client.continuation.integration.test.ts
// for the established pattern this mirrors.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyConfig } from "./test-helpers.js";
import { isComfyCapabilityConfigured } from "./workflow-runtime.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function baseCapabilityConfig() {
  return {
    workflow: { "6": { inputs: { text: "" } }, "9": { inputs: {} } },
    promptNodeId: "6",
    outputNodeId: "9",
  };
}

let server: http.Server;
let baseUrl: string;
const receivedAuthHeaders: (string | undefined)[] = [];
let requestCount = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount += 1;
    receivedAuthHeaders.push(req.headers.authorization);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/prompt") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ prompt_id: "proof-1" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/proof-1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          "proof-1": {
            outputs: {
              "9": { images: [{ filename: "proof.png", subfolder: "", type: "output" }] },
            },
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  receivedAuthHeaders.length = 0;
  requestCount = 0;
});

describe("comfy headers: real sockets, real SecretRef resolution (no mocks)", () => {
  it("resolves an env-backed SecretRef Authorization header across all three real requests and completes generation", async () => {
    const expectedAuth = `Basic ${Buffer.from(`env:${Math.random().toString(36).slice(2)}`).toString("base64")}`;
    process.env.COMFY_HEADER_PROOF_ENV = expectedAuth;
    try {
      const provider = buildComfyImageGenerationProvider();
      const result = await provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig({
          mode: "local",
          baseUrl,
          ...baseCapabilityConfig(),
          headers: {
            Authorization: { source: "env", provider: "default", id: "COMFY_HEADER_PROOF_ENV" },
          },
        }),
      });

      expect(requestCount).toBe(3);
      expect(receivedAuthHeaders.every((header) => header === expectedAuth)).toBe(true);
      expect(result).toBeTruthy();
    } finally {
      delete process.env.COMFY_HEADER_PROOF_ENV;
    }
  });

  it("resolves a non-env (file-backed) SecretRef Authorization header across all three real requests", async () => {
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "comfy-header-secret-"));
    const tmpFile = join(tmpDir, "token.txt");
    const expectedAuth = `Basic ${Buffer.from(`file:${Math.random().toString(36).slice(2)}`).toString("base64")}`;
    await fs.writeFile(tmpFile, expectedAuth);
    await fs.chmod(tmpFile, 0o600);
    try {
      const provider = buildComfyImageGenerationProvider();
      const result = await provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: {
          ...buildComfyConfig({
            mode: "local",
            baseUrl,
            ...baseCapabilityConfig(),
            headers: {
              Authorization: { source: "file", provider: "comfyheaderfile", id: "value" },
            },
          }),
          secrets: {
            providers: {
              comfyheaderfile: { source: "file", path: tmpFile, mode: "singleValue" },
            },
          },
        } as never,
      });

      expect(requestCount).toBe(3);
      expect(receivedAuthHeaders.every((header) => header === expectedAuth)).toBe(true);
      expect(result).toBeTruthy();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stops before any real request when the SecretRef is unresolvable (fail-closed)", async () => {
    delete process.env.COMFY_HEADER_PROOF_MISSING;
    const provider = buildComfyImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig({
          mode: "local",
          baseUrl,
          ...baseCapabilityConfig(),
          headers: {
            Authorization: { source: "env", provider: "default", id: "COMFY_HEADER_PROOF_MISSING" },
          },
        }),
      }),
    ).rejects.toThrow(/unavailable secret/);
    expect(requestCount).toBe(0);
  });

  it("keeps the capability selectable for a real file-backed SecretRef, and hides it for a confirmed-missing env ref", async () => {
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "comfy-header-secret-veto-"));
    const tmpFile = join(tmpDir, "token.txt");
    await fs.writeFile(tmpFile, "Basic doesnt-matter-for-this-check");
    await fs.chmod(tmpFile, 0o600);
    try {
      const fileBackedCfg = {
        ...buildComfyConfig({
          ...baseCapabilityConfig(),
          headers: {
            Authorization: { source: "file", provider: "comfyheaderfile", id: "value" },
          },
        }),
        secrets: {
          providers: { comfyheaderfile: { source: "file", path: tmpFile, mode: "singleValue" } },
        },
      } as never;
      expect(isComfyCapabilityConfigured({ cfg: fileBackedCfg, capability: "image" })).toBe(true);

      delete process.env.COMFY_HEADER_PROOF_VETO_MISSING;
      const missingEnvCfg = buildComfyConfig({
        ...baseCapabilityConfig(),
        headers: {
          Authorization: {
            source: "env",
            provider: "default",
            id: "COMFY_HEADER_PROOF_VETO_MISSING",
          },
        },
      });
      expect(isComfyCapabilityConfigured({ cfg: missingEnvCfg, capability: "image" })).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
