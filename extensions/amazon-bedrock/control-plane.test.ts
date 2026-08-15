import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BedrockClient,
  GetInferenceProfileCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { runBedrockControlPlaneRequest } from "./control-plane.js";

const transportCases: Array<{
  operation: string;
  expectedPath: string;
  send: (client: BedrockClient, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
}> = [
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
