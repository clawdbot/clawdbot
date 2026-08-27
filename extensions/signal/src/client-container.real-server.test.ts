// Real-behavior proof (real sockets, real undici fetch, real timers): a live HTTP
// endpoint that sends headers and then stalls or slow-drips its body must be bounded
// by the request deadline, not only by the per-chunk idle guard. This exercises the
// production containerRpcRequest -> containerRestRequest -> readSignalRestText path
// without mocking fetch, unlike the fake-timer unit tests.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containerRpcRequest } from "./client-container.js";

type StartedServer = { baseUrl: string; close: () => Promise<void> };

const running: StartedServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

async function startServer(handler: http.RequestListener): Promise<StartedServer> {
  const server = http.createServer(handler);
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const started: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  running.push(started);
  return started;
}

describe("signal REST real-server deadline", () => {
  it("aborts a slow-drip body that never idles, at the request deadline", async () => {
    // Drip a byte every 50ms: below the 300ms idle guard, so only the total request
    // deadline can stop it. This is the exact slow-drip case the fix bounds.
    let dripCount = 0;
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      const drip = setInterval(() => {
        try {
          dripCount += 1;
          res.write(" ");
        } catch {
          clearInterval(drip);
        }
      }, 50);
      res.on("close", () => clearInterval(drip));
    });

    const startedAt = Date.now();
    await expect(
      containerRpcRequest("version", undefined, { baseUrl: server.baseUrl, timeoutMs: 300 }),
    ).rejects.toThrow(/Signal REST request timed out|stalled/);
    const elapsedMs = Date.now() - startedAt;

    // Multiple chunks arrived below the idle threshold, yet the absolute deadline
    // still bounded the call. Without it, this response would continue indefinitely.
    expect(dripCount).toBeGreaterThan(1);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("aborts a response whose body stalls immediately after headers", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      // Never ends the body.
    });

    const startedAt = Date.now();
    await expect(
      containerRpcRequest("version", undefined, { baseUrl: server.baseUrl, timeoutMs: 300 }),
    ).rejects.toThrow(/Signal REST (request timed out|response body stalled)/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("returns the parsed body when it completes within the deadline", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ versions: ["v1"], build: 2 }));
    });

    const result = await containerRpcRequest<{ versions?: string[]; build?: number }>(
      "version",
      undefined,
      { baseUrl: server.baseUrl, timeoutMs: 1_000 },
    );
    expect(result).toEqual({ versions: ["v1"], build: 2 });
  });

  it.each([
    {
      stagedFilename: "report---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "report.jpg",
    },
    {
      stagedFilename: "quarter;final---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "quarter_final.jpg",
    },
    {
      stagedFilename: "first;middle;last---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "first_middle_last.jpg",
    },
    {
      stagedFilename: "quarter,final---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "quarter_final.jpg",
    },
    {
      stagedFilename: "first,middle,last---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "first_middle_last.jpg",
    },
    {
      stagedFilename: "hash#name---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "hash_name.jpg",
    },
    {
      stagedFilename: "mixed;comma,hash#name---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "mixed_comma_hash_name.jpg",
    },
    { stagedFilename: "quarter;final.jpg", expectedFilename: "quarter_final.jpg" },
    { stagedFilename: "quarter,final.jpg", expectedFilename: "quarter_final.jpg" },
    { stagedFilename: "hash#name.jpg", expectedFilename: "hash_name.jpg" },
    {
      stagedFilename: "quarter final---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
      expectedFilename: "quarter final.jpg",
    },
  ])(
    "posts the provider-safe original filename $expectedFilename",
    async ({ stagedFilename, expectedFilename }) => {
      let receivedPayload: unknown;
      const server = await startServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/v2/send") {
          res.writeHead(404);
          res.end();
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        req.on("end", () => {
          receivedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ timestamp: "1735689600000" }));
        });
      });

      const mediaDir = await mkdtemp(join(tmpdir(), "signal-real-filename-"));
      const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const stagedFile = join(mediaDir, stagedFilename);

      try {
        await writeFile(stagedFile, content);
        await expect(
          containerRpcRequest(
            "send",
            {
              account: "+14259798283",
              recipient: ["+15550001111"],
              message: "Photo",
              attachments: [stagedFile],
            },
            { baseUrl: server.baseUrl, timeoutMs: 1_000 },
          ),
        ).resolves.toEqual({ timestamp: 1735689600000 });

        expect(receivedPayload).toEqual({
          message: "Photo",
          number: "+14259798283",
          recipients: ["+15550001111"],
          base64_attachments: [
            `data:image/jpeg;filename=${expectedFilename};base64,${content.toString("base64")}`,
          ],
        });
        const attachment = (receivedPayload as { base64_attachments: [string] })
          .base64_attachments[0];
        const decoded = await (await fetch(attachment)).arrayBuffer();
        expect(Buffer.from(decoded)).toEqual(content);
      } finally {
        await rm(mediaDir, { recursive: true, force: true });
      }
    },
  );
});
