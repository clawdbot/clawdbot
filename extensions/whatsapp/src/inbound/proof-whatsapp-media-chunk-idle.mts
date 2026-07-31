/**
 * Real behavior proof: WhatsApp inbound media chunk-idle timeout + source destroy.
 *
 * Drives production `saveInboundMediaStreamWithIdleTimeout` against a local HTTP
 * server that accepts the connection, sends headers, then stalls the body —
 * the same Node Readable boundary Baileys media downloads expose.
 *
 * Covers:
 * - Negative control: stalled HTTP body without idle wrap stays pending
 * - Positive control: idle wrap times out, destroys Readable, server sees close
 * - Valid response: progressing HTTP body still saves
 */
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import http, { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) {
      passed++;
      console.log("  ok: %s", description);
    } else {
      failed++;
      console.log("  FAIL: %s", description);
    }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server failed to bind");
  }
  return addr.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function getReadable(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => resolve(res));
    req.on("error", reject);
  });
}

const head = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

console.log("node=%s", process.version);
console.log("head=%s", head);

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-idle-proof-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const { saveInboundMediaStreamWithIdleTimeout } = await import("./media-chunk-idle.js");
const { saveMediaStream } = await import("openclaw/plugin-sdk/media-store");

console.log("\n[case 1] negative control — stalled HTTP body without idle wrap");
{
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1048576" });
    res.flushHeaders();
  });
  const port = await listenLoopback(server);
  const stalled = await getReadable(`http://127.0.0.1:${port}/media`);
  const startedAt = Date.now();
  const hung = saveMediaStream(stalled, "image/jpeg", "inbound", 1024);
  const outcome = await Promise.race([
    hung.then(() => "resolved" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 300);
    }),
  ]);
  assert(
    "stalled HTTP Readable without idle wrap stays pending (>300ms)",
    () => outcome === "still-pending",
  );
  console.log(
    "  info: outcome=%s wait_ms=%d without_idle_wrap=true",
    outcome,
    Date.now() - startedAt,
  );
  stalled.destroy();
  hung.catch(() => undefined);
  await closeServer(server);
}

console.log("\n[case 2] positive control — stalled HTTP body with idle wrap");
{
  let serverSawClose = false;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1048576" });
    res.flushHeaders();
    const markClose = () => {
      serverSawClose = true;
    };
    req.on("close", markClose);
    res.on("close", markClose);
  });
  const port = await listenLoopback(server);
  const stalled = await getReadable(`http://127.0.0.1:${port}/media`);
  const startedAt = Date.now();
  const outcome = await saveInboundMediaStreamWithIdleTimeout(
    stalled,
    "image/jpeg",
    1024,
    undefined,
    80,
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const elapsedMs = Date.now() - startedAt;
  assert("timed out (not resolved)", () => !outcome.ok);
  if (!outcome.ok) {
    assert(
      "error is WhatsAppInboundMediaTimeoutError",
      () =>
        outcome.error instanceof Error && outcome.error.name === "WhatsAppInboundMediaTimeoutError",
    );
  }
  assert("timeout fires within 3s", () => elapsedMs < 3_000);
  assert("timeout fires after the idle budget", () => elapsedMs >= 60);
  assert("source Readable is destroyed after timeout", () => stalled.destroyed);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  assert("server observed client/connection close after destroy", () => serverSawClose);
  console.log(
    "  info: elapsed_ms=%d timed_out=%s destroyed=%s server_close=%s chunkTimeoutMs=80",
    elapsedMs,
    String(!outcome.ok),
    String(stalled.destroyed),
    String(serverSawClose),
  );
  await closeServer(server);
}

console.log("\n[case 3] valid response — progressing HTTP body");
{
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": String(jpeg.byteLength),
    });
    res.end(jpeg);
  });
  const port = await listenLoopback(server);
  const stream = await getReadable(`http://127.0.0.1:${port}/ok`);
  const result = await saveInboundMediaStreamWithIdleTimeout(
    stream,
    "image/jpeg",
    1024,
    undefined,
    500,
  );
  assert("saved media size matches input", () => result.size === jpeg.byteLength);
  assert("contentType preserved", () => result.contentType === "image/jpeg");
  console.log("  info: size=%d contentType=%s timed_out=false", result.size, result.contentType);
  await closeServer(server);
}

await fs.rm(stateDir, { recursive: true, force: true });

console.log("\n=== Summary ===");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
if (failed > 0) {
  process.exit(1);
}
