import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { writeSecretStoreEntry } from "../src/secrets/store/secret-store.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it("opens New Agent through the real Gateway and runner using a protected provider key", async () => {
  const key = "synthetic-new-agent-provider-key";
  const rotatedKey = "synthetic-new-agent-rotated-key";
  let acceptedKey = key;
  const secretRef = { source: "store", provider: "default", id: "SETUP_TEST_KEY" };
  const requests: { authorization: string | undefined; body: unknown }[] = [];
  const provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      if (request.headers.authorization !== `Bearer ${acceptedKey}`) {
        response.writeHead(401).end();
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "OK",
        messageId: "msg_setup_probe",
        responseId: "resp_setup_probe",
      });
    });
  });
  let instance: OpenClawTestInstance | undefined;
  let client: GatewayClient | undefined;
  await runQaGatewayFixture(
    async () => {
      await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
      });
      const port = (provider.address() as AddressInfo).port;
      instance = await createOpenClawTestInstance({
        name: "system-agent-managed-auth",
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_SECRET_SENTINELS: "1",
          OPENAI_API_KEY: undefined,
          OPENAI_OAUTH_TOKEN: undefined,
          ANTHROPIC_API_KEY: undefined,
        },
        config: {
          plugins: { enabled: false },
          agents: { defaults: { model: "fixture/test-model" } },
          models: {
            providers: {
              fixture: {
                api: "openai-responses",
                baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: secretRef,
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "test-model",
                    name: "Fixture",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32000,
                    maxTokens: 1000,
                  },
                ],
              },
            },
          },
        },
      });
      writeSecretStoreEntry({
        scope: { kind: "team" },
        name: secretRef.id,
        value: key,
        kind: "secret",
        allowedHosts: ["127.0.0.1"],
        updatedBy: "test",
        database: { env: instance.env },
      });
      await instance.startGateway();
      client = await acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.TEST,
          mode: GATEWAY_CLIENT_MODES.TEST,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.statePath("test-device.sqlite"),
          }),
        },
        {
          timeoutMs: 10_000,
          timeoutMessage: "Setup client did not connect",
          closeMessage: "Setup client closed before connecting",
        },
      );

      // The UI's New Agent action starts this setup conversation. No runner,
      // credential resolver, config reader, or Gateway handler is replaced.
      const sessionId = randomUUID();
      const result = await client.request(
        "openclaw.chat",
        { sessionId, welcomeVariant: "new-agent" },
        { timeoutMs: 60_000 },
      );
      expect(result).toMatchObject({
        sessionId,
        action: "none",
        reply: expect.stringContaining("Let's hatch a new agent"),
      });
      expect(requests).toEqual([
        {
          authorization: `Bearer ${key}`,
          body: expect.objectContaining({ model: "test-model", stream: true }),
        },
      ]);

      const reply = await client.request(
        "openclaw.chat",
        { sessionId, message: "Please reply with OK and make no changes." },
        { timeoutMs: 60_000 },
      );
      expect(reply).toMatchObject({ sessionId, action: "none", reply: "OK" });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.authorization).toBe(`Bearer ${key}`);

      // Rotate through the real store/reload owner. A previously verified session
      // must not silently switch credentials; a fresh session must verify the new key.
      acceptedKey = rotatedKey;
      const rotation = await client.request("secrets.store.set", {
        name: secretRef.id,
        value: rotatedKey,
        kind: "secret",
        allowedHosts: ["127.0.0.1"],
      });
      expect(rotation).toMatchObject({ ok: true, reloaded: true });
      await expect(
        client.request("openclaw.chat", { sessionId, message: "Reply with OK again." }),
      ).rejects.toThrow("OpenClaw could not reach working inference");
      expect(requests).toHaveLength(2);
      const freshSessionId = randomUUID();
      const fresh = await client.request("openclaw.chat", {
        sessionId: freshSessionId,
        welcomeVariant: "new-agent",
      });
      expect(fresh).toMatchObject({
        sessionId: freshSessionId,
        action: "none",
        reply: expect.stringContaining("Let's hatch a new agent"),
      });
      expect(requests).toHaveLength(3);
      expect(requests[2]?.authorization).toBe(`Bearer ${rotatedKey}`);

      const configText = await fs.readFile(instance.configPath, "utf8");
      expect(JSON.parse(configText).models.providers.fixture.apiKey).toEqual(secretRef);
      const publicOutput = [
        configText,
        JSON.stringify([result, reply, rotation, fresh]),
        instance.logs(),
      ].join("\n");
      expect(publicOutput).not.toContain(key);
      expect(publicOutput).not.toContain(rotatedKey);
    },
    () => client?.stopAndWait(),
    () => instance?.cleanup(),
    async () => {
      provider.closeAllConnections();
      if (provider.listening) {
        await new Promise<void>((resolve, reject) => {
          provider.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
}, 180_000);
