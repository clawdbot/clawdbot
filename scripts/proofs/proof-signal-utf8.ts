import { containerRpcRequest } from "../../extensions/signal/src/client-container.js";

async function run(body: Uint8Array): Promise<string> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  try {
    const out = await containerRpcRequest("version", undefined, {
      baseUrl: "http://localhost:8080",
    });
    return `accepted, parsed=${JSON.stringify(out)}`;
  } catch (error) {
    return `rejected (${(error as Error).message})`;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  const corrupted = Buffer.concat([
    Buffer.from('{"version":"1.'),
    Buffer.from([0xff]),
    Buffer.from('0"}'),
  ]);
  console.log(`corrupted response: ${await run(new Uint8Array(corrupted))}`);
  console.log(`valid response: ${await run(new TextEncoder().encode('{"version":"1.0"}'))}`);
}

void main();
