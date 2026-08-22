import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadBatchJsonlFile } from "./batch-upload.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import { postJson } from "./post-json.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";

const API_KEY = "memory/Start~OC_T24_13_UNIQUE_NEEDLE-memoryEnd";
const SHORT_API_KEY = "t7K4_x";
const UNIQUE_NEEDLE = "OC_T24_13_UNIQUE_NEEDLE";

type RequestRecord = {
  authorization: string | undefined;
  body: string;
  contentType: string | undefined;
  path: string;
};

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createMemoryRemoteServer(records: RequestRecord[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const path = request.url ?? "/";
      const authorization = request.headers.authorization;
      records.push({
        authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: request.headers["content-type"],
        path,
      });

      let status = 200;
      let body: string;
      if (path.includes("/quoted-error/") || path.endsWith("/quoted-error")) {
        status = 401;
        body = JSON.stringify({ Authorization: authorization });
      } else if (path.includes("/error/") || path.endsWith("/error")) {
        status = 401;
        body = `upstream echoed Authorization: ${authorization}`;
      } else if (path.endsWith("/benign")) {
        status = 400;
        body = "harmless diagnostic";
      } else if (path.endsWith("/embeddings/ok")) {
        body = '{"data":[{"embedding":[0.25,0.5]}]}';
      } else if (path.endsWith("/files")) {
        body = '{"id":"file_control"}';
      } else {
        status = 404;
        body = "not found";
      }
      response.writeHead(status, {
        connection: "close",
        "content-length": String(Buffer.byteLength(body)),
        "content-type": status === 200 ? "application/json" : "text/plain",
      });
      response.end(body);
    });
  });
}

describe.sequential("memory remote error redaction", () => {
  beforeEach(() => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redacts lower-case bearer credentials through the real remote embedding fetch path", async () => {
    const records: RequestRecord[] = [];
    const server = createMemoryRemoteServer(records);
    const baseUrl = await listenOnLoopback(server);
    const headers = {
      Authorization: `bearer ${API_KEY}`,
      "Content-Type": "application/json",
    };

    try {
      const error = await fetchRemoteEmbeddingVectors({
        url: `${baseUrl}/v1/embeddings/error`,
        headers,
        ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        body: { model: "proof", input: ["one"] },
        errorPrefix: "embedding fetch failed",
      }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("embedding fetch failed: 401");
      expect((error as Error).message).toContain("Authorization: bearer ");
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain(UNIQUE_NEEDLE);

      await expect(
        fetchRemoteEmbeddingVectors({
          url: `${baseUrl}/v1/embeddings/ok`,
          headers,
          ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
          body: { model: "proof", input: ["one"] },
          errorPrefix: "embedding fetch failed",
        }),
      ).resolves.toEqual([[0.25, 0.5]]);
      expect(records.map((record) => record.authorization)).toEqual([
        `bearer ${API_KEY}`,
        `bearer ${API_KEY}`,
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("redacts quoted short bearer credentials through the real JSON error path", async () => {
    const records: RequestRecord[] = [];
    const server = createMemoryRemoteServer(records);
    const baseUrl = await listenOnLoopback(server);
    const headers = {
      Authorization: `bearer ${SHORT_API_KEY}`,
      "Content-Type": "application/json",
    };

    try {
      const error = await fetchRemoteEmbeddingVectors({
        url: `${baseUrl}/v1/embeddings/quoted-error`,
        headers,
        ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        body: { model: "proof", input: ["one"] },
        errorPrefix: "embedding fetch failed",
      }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('{"Authorization":"***"}');
      expect((error as Error).message).not.toContain(SHORT_API_KEY);
      expect(records.map((record) => record.authorization)).toEqual([`bearer ${SHORT_API_KEY}`]);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves status metadata and harmless provider diagnostics", async () => {
    const records: RequestRecord[] = [];
    const server = createMemoryRemoteServer(records);
    const baseUrl = await listenOnLoopback(server);
    const request = (path: string) =>
      postJson({
        url: `${baseUrl}${path}`,
        headers: { Authorization: `Bearer ${API_KEY}` },
        ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        body: {},
        errorPrefix: "post failed",
        attachStatus: true,
        parse: (payload) => payload,
      });

    try {
      const secretError = await request("/v1/post/error").catch((cause: unknown) => cause);
      expect(secretError).toBeInstanceOf(Error);
      expect((secretError as { status?: unknown }).status).toBe(401);
      expect((secretError as Error).message).not.toContain(API_KEY);
      expect((secretError as Error).message).not.toContain(UNIQUE_NEEDLE);

      const benignError = await request("/v1/post/benign").catch((cause: unknown) => cause);
      expect(benignError).toBeInstanceOf(Error);
      expect((benignError as { status?: unknown }).status).toBe(400);
      expect((benignError as Error).message).toBe("post failed: 400 harmless diagnostic");
    } finally {
      await closeServer(server);
    }
  });

  it("redacts lower-case bearer credentials from batch errors without changing success", async () => {
    const records: RequestRecord[] = [];
    const server = createMemoryRemoteServer(records);
    const baseUrl = await listenOnLoopback(server);
    const client = (path: string) => ({
      baseUrl: `${baseUrl}${path}`,
      headers: { Authorization: `bearer ${API_KEY}` },
      ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
    });

    try {
      const error = await uploadBatchJsonlFile({
        client: client("/error"),
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("file upload failed: 401");
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain(UNIQUE_NEEDLE);

      const shortError = await uploadBatchJsonlFile({
        client: {
          baseUrl: `${baseUrl}/quoted-error`,
          headers: { Authorization: `bearer ${SHORT_API_KEY}` },
          ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
      }).catch((cause: unknown) => cause);
      expect(shortError).toBeInstanceOf(Error);
      expect((shortError as Error).message).toContain('{"Authorization":"***"}');
      expect((shortError as Error).message).not.toContain(SHORT_API_KEY);

      await expect(
        uploadBatchJsonlFile({
          client: client("/ok"),
          requests: [{ input: "one" }],
          errorPrefix: "file upload failed",
        }),
      ).resolves.toBe("file_control");
      const batchRecords = records.filter((record) => record.path.endsWith("/files"));
      expect(batchRecords[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/u);
      expect(batchRecords[0]?.body).toContain('name="purpose"');
      expect(batchRecords[0]?.body).toContain("batch");
      expect(batchRecords.map((record) => record.authorization)).toEqual([
        `bearer ${API_KEY}`,
        `bearer ${SHORT_API_KEY}`,
        `bearer ${API_KEY}`,
      ]);
    } finally {
      await closeServer(server);
    }
  });
});
