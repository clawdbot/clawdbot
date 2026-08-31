import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { buildComfyConfig } from "./test-helpers.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

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
let failurePath: string | undefined;
let terminalFailure = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount += 1;
    receivedAuthHeaders.push(req.headers.authorization);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    req.resume();
    if (url.pathname === failurePath) {
      const credential = req.headers.authorization?.split(" ")[1];
      const detail = `proxy rejected ${credential} ${String(req.headers["x-proxy-auth"])}`;
      res.writeHead(terminalFailure ? 200 : 403, { "content-type": "application/json" });
      res.end(
        JSON.stringify(terminalFailure ? { status: "failed", error: detail } : { error: detail }),
      );
      return;
    }
    if (url.pathname === "/upload/image") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "input.png" }));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/prompt")) {
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
  failurePath = undefined;
  terminalFailure = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("comfy headers: real sockets, real SecretRef resolution (no mocks)", () => {
  it.each([
    ["upload", "/upload/image", false],
    ["submit", "/prompt", false],
    ["history", "/history/proof-1", false],
    ["download", "/view", false],
    ["cloud status", "/api/job/proof-1/status", true],
  ])("redacts reflected headers from %s errors", async (_label, endpoint, cloud) => {
    failurePath = endpoint;
    terminalFailure = cloud;
    const credential = "comfy-fixture-credential";
    const customHeader = "comfy-fixture-proxy-value";
    const cfg = buildComfyConfig({
      ...baseCapabilityConfig(),
      baseUrl,
      mode: cloud ? "cloud" : "local",
      apiKey: cloud ? "comfy-fixture-cloud-key" : undefined,
      allowPrivateNetwork: cloud,
      inputImageNodeId: "6",
      headers: { Authorization: `Basic ${credential}`, "X-Proxy-Auth": customHeader },
    });
    const result = await buildComfyImageGenerationProvider()
      .generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "redaction proof",
        cfg,
        ...(endpoint === "/upload/image"
          ? { inputImages: [{ buffer: TINY_PNG, mimeType: "image/png" }] }
          : {}),
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(inspect(result)).toContain("proxy rejected");
    expect(inspect(result)).not.toContain(credential);
    expect(inspect(result)).not.toContain(customHeader);
    expect(requestCount).toBeGreaterThan(0);
  });

  it.each(["video", "music"] as const)(
    "redacts reflected headers for %s generation",
    async (capability) => {
      failurePath = "/prompt";
      const credential = "comfy-fixture-sibling-secret";
      const request = {
        provider: "comfy",
        model: "workflow",
        prompt: "sibling redaction proof",
        cfg: buildComfyConfig({
          baseUrl,
          [capability]: baseCapabilityConfig(),
          headers: { Authorization: `Basic ${credential}` },
        }),
      };
      const result = await (
        capability === "video"
          ? buildComfyVideoGenerationProvider().generateVideo(request)
          : buildComfyMusicGenerationProvider().generateMusic(request)
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(inspect(result)).toContain("proxy rejected");
      expect(inspect(result)).not.toContain(credential);
    },
  );

  it("resolves an env-backed SecretRef Authorization header across all three real requests and completes generation", async () => {
    const expectedAuth = `Basic ${Buffer.from(`env:${Math.random().toString(36).slice(2)}`).toString("base64")}`;
    vi.stubEnv("COMFY_HEADER_PROOF_ENV", expectedAuth);
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
    expect(result.images[0]?.buffer).toEqual(TINY_PNG);
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
        },
      });

      expect(requestCount).toBe(3);
      expect(receivedAuthHeaders.every((header) => header === expectedAuth)).toBe(true);
      expect(result.images[0]?.buffer).toEqual(TINY_PNG);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stops before any real request when the SecretRef is unresolvable (fail-closed)", async () => {
    vi.stubEnv("COMFY_HEADER_PROOF_MISSING", undefined);
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
});
