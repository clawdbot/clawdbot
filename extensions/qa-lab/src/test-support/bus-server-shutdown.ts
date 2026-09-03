import assert from "node:assert/strict";
import { startQaBusServer } from "../bus-server.js";
import { createQaBusState } from "../bus-state.js";
import { startQaMockOpenAiServer } from "../providers/mock-openai/server.js";

const provider = process.argv[2] === "provider";
const server = provider
  ? await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 })
  : await startQaBusServer({ state: createQaBusState() });
try {
  const response = await fetch(
    `${server.baseUrl}${provider ? "/v1/responses" : "/v1/inbound/message"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(16 * 1024 * 1024 + 1) }),
    },
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Payload too large" });
} finally {
  await server.stop();
}
console.log("shutdown-complete");
