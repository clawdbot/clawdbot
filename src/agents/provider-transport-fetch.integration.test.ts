import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  closeProviderTransportDispatcherPool,
  getProviderTransportDispatcherPool,
} from "./provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

describe("guarded model fetch integration", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeProviderTransportDispatcherPool();
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

  it("recovers from a pre-send Anthropic failure on the pooled dispatcher", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: ok\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const pool = getProviderTransportDispatcherPool();
      const acquire = pool.acquire.bind(pool);
      const reused: boolean[] = [];
      let injectPreSendFailure = true;
      vi.spyOn(pool, "acquire").mockImplementation((params) => {
        const lease = acquire(params);
        if (!lease) {
          return lease;
        }
        reused.push(lease.reused);
        if (!injectPreSendFailure) {
          return lease;
        }
        injectPreSendFailure = false;
        return {
          ...lease,
          dispatcher: lease.dispatcher.compose(() => (_options, _handler) => {
            throw Object.assign(new Error("injected pre-send socket failure"), {
              code: "UND_ERR_SOCKET",
            });
          }),
        };
      });

      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = {
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl,
      } as unknown as Model<"anthropic-messages">;
      const body = JSON.stringify({ model: model.id, stream: true });

      const response = await buildGuardedModelFetch(model)(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      await expect(response.text()).resolves.toBe("data: ok\n\n");
      expect(reused).toEqual([false, true]);
      expect(bodies).toEqual([body]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("does not retry an Anthropic POST received before the socket closes", async () => {
    let requests = 0;
    const bodies: string[] = [];
    const server = createServer((request) => {
      requests += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        request.socket.destroy();
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
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl,
      } as unknown as Model<"anthropic-messages">;
      const body = JSON.stringify({ model: "claude-sonnet-4-6", stream: true });

      await expect(
        buildGuardedModelFetch(model)(`${baseUrl}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      ).rejects.toThrow();

      expect(requests).toBe(1);
      expect(bodies).toEqual([body]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
