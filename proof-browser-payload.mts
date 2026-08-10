import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Real-browser proof for the negotiated request-frame payload guard in the
// Control UI Gateway browser client. Starts a real local Gateway, bundles the
// actual GatewayBrowserClient module for Chromium, then records that an
// oversized chat.send frame is rejected locally before socket.send while the
// connection stays usable.
import { build } from "esbuild";
import { chromium } from "playwright";
import { createOpenClawTestInstance } from "./test/helpers/openclaw-test-instance.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entrySource = `
import { GatewayBrowserClient } from ${JSON.stringify(path.join(scriptDir, "ui/src/api/gateway.ts"))};

(globalThis as unknown as { runProof: (wsUrl: string, token: string) => Promise<Record<string, unknown>> }).runProof =
  async (wsUrl, token) => {
    const results: Record<string, unknown> = {};
    let helloPolicy: unknown;
    let resolveHello: (hello: unknown) => void = () => undefined;
    const helloReady = new Promise<unknown>((resolve) => {
      resolveHello = resolve;
    });
    const client = new GatewayBrowserClient({
      url: wsUrl,
      token,
      onHello: (hello) => {
        helloPolicy = hello.policy;
        resolveHello(hello);
      },
    });
    const deadline = Date.now() + 20_000;
    client.start();
    while (!client.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!client.connected) {
      throw new Error("browser gateway client did not connect");
    }
    await Promise.race([
      helloReady,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("gateway hello did not arrive")), 20_000),
      ),
    ]);

    const normal = await client.request<{ pending?: unknown[] }>("node.pair.list", {});
    results.normalRequest = { ok: true, pendingCount: normal?.pending?.length ?? 0 };

    // 21 MiB of zeros base64-encodes to about 28 MiB, exceeding the 25 MiB
    // receiver cap the Gateway advertises in hello-ok.policy.maxPayload.
    const bigBase64 = "A".repeat(Math.ceil((21 * 1024 * 1024) / 3) * 4);
    let oversizedError = "";
    let sentWhileOversized = false;
    const socket = (client as unknown as { client: { socket?: { isOpen?: () => boolean } } }).client.socket;
    try {
      await client.request("chat.send", {
        messages: [{ attachments: [{ data: bigBase64 }] }],
      });
    } catch (error) {
      oversizedError = error instanceof Error ? error.message : String(error);
    }
    sentWhileOversized = Boolean(socket?.isOpen?.());
    results.oversizedRequest = { error: oversizedError, socketStillOpen: sentWhileOversized };

    const after = await client.request<{ pending?: unknown[] }>("node.pair.list", {});
    results.afterRejection = { ok: true, pendingCount: after?.pending?.length ?? 0 };
    results.helloPolicy = helloPolicy;
    client.stop();
    return results;
  };
`;

async function main() {
  const inst = await createOpenClawTestInstance({
    name: "canvas-a2ui-browser-payload-proof",
  });
  let tempDir = "";
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    await inst.startGateway();
    const gatewayUrl = inst.url;
    const token = inst.gatewayToken;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-browser-payload-proof-"));
    const entryPath = path.join(tempDir, "proof-entry.ts");
    await writeFile(entryPath, entrySource);
    await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: "browser",
      format: "esm",
      outfile: path.join(tempDir, "proof.js"),
      logLevel: "silent",
    });
    await writeFile(
      path.join(tempDir, "index.html"),
      '<!doctype html><meta charset="utf-8"><title>gateway payload proof</title><script type="module" src="./proof.js"></script>',
    );

    const port = await new Promise<number>((resolve, reject) => {
      const httpServer = createHttpServer(async (request, response) => {
        try {
          const urlPath = request.url === "/" ? "/index.html" : (request.url ?? "/index.html");
          const filePath = path.join(tempDir, path.basename(urlPath));
          const body = await readFile(filePath);
          response.writeHead(200, {
            "content-type": urlPath.endsWith(".js")
              ? "text/javascript"
              : "text/html; charset=utf-8",
          });
          response.end(body);
        } catch {
          response.writeHead(404);
          response.end("not found");
        }
      });
      httpServer.listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to bind proof http server"));
        }
      });
      server = httpServer;
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
      const results = (await page.evaluate(
        ([wsUrl, authToken]) =>
          (
            globalThis as unknown as {
              runProof: (u: string, t: string) => Promise<Record<string, unknown>>;
            }
          ).runProof(wsUrl, authToken),
        [gatewayUrl, token],
      )) as Record<string, unknown>;
      console.log(`gateway=${gatewayUrl}`);
      console.log(`token=<redacted>`);
      console.log(JSON.stringify({ ...results, pageErrors }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    if (server) {
      await new Promise((resolve) => {
        server?.close(resolve);
      });
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    await inst.cleanup();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
