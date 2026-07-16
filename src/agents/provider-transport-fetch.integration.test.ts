import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

describe("guarded model fetch secret sentinel integration", () => {
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
});
