import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BedrockClient,
  GetInferenceProfileCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { loadBedrockControlPlaneSdk, runBedrockControlPlaneRequest } from "./control-plane.js";

const transportCases: Array<{
  operation: string;
  expectedPath: string;
  send: (client: BedrockClient, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
}> = [
  {
    operation: "Bedrock ListInferenceProfiles",
    expectedPath: "/inference-profiles?type=SYSTEM_DEFINED",
    send: (client, options) =>
      client.send(new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" }), options),
  },
  {
    operation: "Bedrock ListFoundationModels",
    expectedPath: "/foundation-models",
    send: (client, options) => client.send(new ListFoundationModelsCommand({}), options),
  },
  {
    operation: "Bedrock GetInferenceProfile",
    expectedPath: "/inference-profiles/test-profile",
    send: (client, options) =>
      client.send(
        new GetInferenceProfileCommand({ inferenceProfileIdentifier: "test-profile" }),
        options,
      ),
  },
];

describe("Bedrock control-plane transport", () => {
  it("uses the environment proxy for every control-plane command", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "");
    const sdk = await loadBedrockControlPlaneSdk();
    const client = await sdk.createClient("us-east-1");
    try {
      const requestHandler = client.config.requestHandler as {
        configProvider?: Promise<{ httpsAgent?: { constructor?: { name?: string } } }>;
      };
      const config = await requestHandler.configProvider;
      expect(config?.httpsAgent?.constructor?.name).toMatch(/Proxy/u);
      expect(sdk.createListFoundationModelsCommand()).toBeInstanceOf(ListFoundationModelsCommand);
      expect(
        sdk.createListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" }),
      ).toBeInstanceOf(ListInferenceProfilesCommand);
      expect(
        sdk.createGetInferenceProfileCommand({ inferenceProfileIdentifier: "test-profile" }),
      ).toBeInstanceOf(GetInferenceProfileCommand);
    } finally {
      client.destroy();
      vi.unstubAllEnvs();
    }
  });

  it("keeps NO_PROXY control-plane commands on the default direct agent", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "bedrock.us-east-1.amazonaws.com");
    const sdk = await loadBedrockControlPlaneSdk();
    const client = await sdk.createClient("us-east-1");
    try {
      const requestHandler = client.config.requestHandler as {
        configProvider?: Promise<{ httpsAgent?: { constructor?: { name?: string } } }>;
      };
      const config = await requestHandler.configProvider;
      expect(config?.httpsAgent?.constructor?.name).toBe("Agent");
    } finally {
      client.destroy();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      name: "China partition",
      region: "cn-north-1",
      noProxy: ".amazonaws.com.cn",
      endpointEnv: {},
    },
    {
      name: "FIPS endpoint",
      region: "us-east-1",
      noProxy: "bedrock-fips.us-east-1.amazonaws.com",
      endpointEnv: { AWS_USE_FIPS_ENDPOINT: "true" },
    },
    {
      name: "dual-stack endpoint",
      region: "us-east-1",
      noProxy: "bedrock.us-east-1.api.aws",
      endpointEnv: { AWS_USE_DUALSTACK_ENDPOINT: "true" },
    },
  ])("resolves the real $name before applying NO_PROXY", async (testCase) => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", testCase.noProxy);
    for (const [key, value] of Object.entries(testCase.endpointEnv)) {
      vi.stubEnv(key, value);
    }
    const sdk = await loadBedrockControlPlaneSdk();
    const client = await sdk.createClient(testCase.region);
    try {
      const requestHandler = client.config.requestHandler as {
        configProvider?: Promise<{ httpsAgent?: { constructor?: { name?: string } } }>;
      };
      const config = await requestHandler.configProvider;
      expect(config?.httpsAgent?.constructor?.name).toBe("Agent");
    } finally {
      client.destroy();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      name: "cleartext local endpoint",
      endpoint: "http://127.0.0.1:4566",
      proxyEnv: "HTTP_PROXY",
    },
    {
      name: "custom HTTPS endpoint",
      endpoint: "https://bedrock-proxy.example",
      proxyEnv: "HTTPS_PROXY",
    },
  ])("keeps the configured $name on the direct agent", async (testCase) => {
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK", testCase.endpoint);
    vi.stubEnv(testCase.proxyEnv, "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    const sdk = await loadBedrockControlPlaneSdk();
    const client = await sdk.createClient("us-east-1");
    try {
      const requestHandler = client.config.requestHandler as {
        configProvider?: Promise<{ httpsAgent?: { constructor?: { name?: string } } }>;
      };
      const config = await requestHandler.configProvider;
      expect(config?.httpsAgent?.constructor?.name).toBe("Agent");
    } finally {
      client.destroy();
      vi.unstubAllEnvs();
    }
  });

  it("does not send when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before send");
    controller.abort(reason);
    const send = vi.fn(async () => "unexpected");

    await expect(
      runBedrockControlPlaneRequest({
        operation: "Bedrock pre-aborted request",
        signal: controller.signal,
        send,
      }),
    ).rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a transport response that resolves after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const response = createDeferred<string>();
      const request = runBedrockControlPlaneRequest({
        operation: "Bedrock late response",
        send: () => response.promise,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      response.resolve("too late");

      await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(transportCases)(
    "aborts and closes the real Smithy socket for $operation",
    async (testCase) => {
      const requestStarted = createDeferred<{
        path: string | undefined;
        socketClosed: Promise<void>;
      }>();
      const server = createServer((request) => {
        requestStarted.resolve({
          path: request.url,
          socketClosed: new Promise<void>((resolve) => {
            request.socket.once("close", () => {
              resolve();
            });
          }),
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const client = new BedrockClient({
        region: "us-east-1",
        endpoint: `http://127.0.0.1:${address.port}`,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        maxAttempts: 1,
      });
      const controller = new AbortController();
      const reason = new Error("caller cancelled control-plane request");

      try {
        const response = runBedrockControlPlaneRequest({
          operation: testCase.operation,
          signal: controller.signal,
          send: (options) => testCase.send(client, options),
        });
        const request = await requestStarted.promise;
        expect(request.path).toBe(testCase.expectedPath);

        controller.abort(reason);

        await expect(response).rejects.toMatchObject({ name: "AbortError", cause: reason });
        await request.socketClosed;
      } finally {
        client.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
