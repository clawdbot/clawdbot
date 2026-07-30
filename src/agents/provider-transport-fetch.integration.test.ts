import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

describe("guarded model fetch integration", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
  });

  it("injects the real header only at local HTTP egress and redacts the resolved value", async () => {
    let receivedAuthorization: string | undefined;
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = {
        id: "integration-model",
        provider: "sentinel-integration",
        api: "openai-responses",
        baseUrl,
      } as unknown as Model<"openai-responses">;
      const secret = "integration-provider-secret";
      const sentinel = mintSecretSentinel(secret, { label: "model-auth:integration" });

      const response = await buildGuardedModelFetch(model)(`${baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sentinel}` },
        body: "{}",
      });
      await response.text();

      expect(receivedAuthorization).toBe(`Bearer ${secret}`);
      expect(redactSensitiveText(`upstream used ${secret}`, { mode: "off" })).toBe(
        "upstream used integr…cret",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("retries an Anthropic socket close before response headers", async () => {
    let requests = 0;
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      requests += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        if (requests === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = {
        id: "claude-opus-4-7",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl,
      } as unknown as Model<"anthropic-messages">;
      const body = JSON.stringify({ model: "claude-opus-4-7", stream: true });

      const response = await buildGuardedModelFetch(model)(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      await expect(response.text()).resolves.toContain('"type":"message_stop"');
      expect(requests).toBe(2);
      expect(bodies).toEqual([body, body]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
