// Gateway OpenAI-compatible route tests cover config reload and root-mounted behavior.
import { once } from "node:events";
import http, { type Server, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

vi.mock("../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: vi.fn(async () => ({
    payloads: [{ text: "image accepted" }],
    meta: { durationMs: 0 },
  })),
}));

const PNG_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const endpointCases = [
  {
    name: "chat completions",
    endpoint: "chatCompletions",
    path: "/v1/chat/completions",
    override: "openAiChatCompletionsEnabled",
  },
  {
    name: "responses",
    endpoint: "responses",
    path: "/v1/responses",
    override: "openResponsesEnabled",
  },
] as const;

describe("gateway OpenAI-compatible HTTP routes", () => {
  it("returns 404 when compat endpoints are disabled", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        for (const path of ["/v1/chat/completions", "/v1/responses"]) {
          const { res, getBody } = await sendRequest(server, {
            path,
            method: "POST",
            headers: { "content-type": "application/json" },
          });

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });

  it("returns 404 for disabled GET routes when the Control UI is root-mounted", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled-root-control-ui",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
      },
      run: async (server) => {
        for (const path of [
          "/v1",
          "/v1/",
          "/v1/models",
          "/v1/models/openclaw",
          "/v1/chat/completions",
          "/v1/responses",
          "/v1/embeddings",
        ]) {
          const { res, getBody } = await sendRequest(server, { path, method: "GET" });

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });

  it.each(endpointCases)(
    "hot reloads $name routes on the same server",
    async ({ endpoint, path }) => {
      await withGatewayServer({
        prefix: "openai-compat-hot-reload",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          openAiChatCompletionsEnabled: undefined,
          openResponsesEnabled: undefined,
        },
        run: async (server) => {
          for (const enabled of [false, true, false]) {
            const config: OpenClawConfig = {
              gateway: { http: { endpoints: { [endpoint]: { enabled } } } },
            };
            setRuntimeConfigSnapshot(config, config);

            for (const requestPath of [
              "/v1/models",
              "/v1/models/openclaw",
              "/v1/embeddings",
              ...endpointCases.map((entry) => entry.path),
            ]) {
              const { res, getBody } = await sendRequest(server, {
                path: requestPath,
                method: "GET",
                headers: { "x-openclaw-scopes": "operator.read" },
              });
              const isModels = requestPath.startsWith("/v1/models");
              const isEnabled =
                enabled && (isModels || requestPath === "/v1/embeddings" || requestPath === path);
              expect(res.statusCode, `${requestPath} with ${endpoint}=${enabled}`).toBe(
                isEnabled ? (isModels ? 200 : 405) : 404,
              );
              if (isEnabled && requestPath === "/v1/models") {
                expect(JSON.parse(getBody())).toMatchObject({
                  object: "list",
                  data: expect.arrayContaining([
                    expect.objectContaining({ id: "openclaw/default" }),
                  ]),
                });
              }
            }
          }
        },
      });
    },
  );

  it.each(
    endpointCases.flatMap(({ name, endpoint, path, override }) =>
      [true, false].map((enabled) => ({ name, endpoint, path, override, enabled })),
    ),
  )(
    "preserves the explicit $name=$enabled override over runtime config",
    async ({ endpoint, path, override, enabled }) => {
      await withGatewayServer({
        prefix: "openai-compat-explicit-override",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          [override]: enabled,
        },
        run: async (server) => {
          for (const configuredEnabled of [!enabled, enabled, !enabled]) {
            const config: OpenClawConfig = {
              gateway: { http: { endpoints: { [endpoint]: { enabled: configuredEnabled } } } },
            };
            setRuntimeConfigSnapshot(config, config);
            for (const requestPath of [path, "/v1/models", "/v1/embeddings"]) {
              const { res } = await sendRequest(server, {
                path: requestPath,
                method: "GET",
                headers: { "x-openclaw-scopes": "operator.read" },
              });
              expect(res.statusCode, `${requestPath} with config=${configuredEnabled}`).toBe(
                enabled ? (requestPath === "/v1/models" ? 200 : 405) : 404,
              );
            }
          }
        },
      });
    },
  );

  it.each(endpointCases)(
    "hot reloads $name image limits for real HTTP requests",
    async ({ endpoint, path, override }) => {
      vi.mocked(agentCommandFromGatewayIngress).mockClear();
      const body = JSON.stringify({
        model: "openclaw/main",
        ...(endpoint === "chatCompletions"
          ? {
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "image_url",
                      image_url: { url: `data:image/png;base64,${PNG_IMAGE_BASE64}` },
                    },
                  ],
                },
              ],
            }
          : {
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_image",
                      source: { type: "base64", media_type: "image/png", data: PNG_IMAGE_BASE64 },
                    },
                  ],
                },
              ],
            }),
      });
      await withGatewayServer({
        prefix: "openai-compat-image-limit-reload",
        resolvedAuth: AUTH_TOKEN,
        overrides: { [override]: true },
        run: async (server) => {
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          try {
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("Expected an HTTP listener address");
            }
            for (const maxBytes of [1, 1024, 1]) {
              const config: OpenClawConfig = {
                agents: { entries: { main: {} } },
                gateway: { http: { endpoints: { [endpoint]: { images: { maxBytes } } } } },
              };
              setRuntimeConfigSnapshot(config, config);
              const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
                method: "POST",
                headers: {
                  authorization: "Bearer test-token",
                  "content-type": "application/json",
                },
                body,
              });
              const responseBody = await response.text();
              expect(response.status, responseBody).toBe(maxBytes === 1 ? 400 : 200);
              if (maxBytes === 1024) {
                expect(responseBody).toContain("image accepted");
              }
            }
            expect(agentCommandFromGatewayIngress).toHaveBeenCalledTimes(1);
          } finally {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
      });
    },
  );
});

const IMAGE_BYTES = Buffer.from(PNG_IMAGE_BASE64, "base64");
const SOURCE_ORIGIN = "https://cdn.example.com";
const inputCases = [
  { name: "chat image", path: "/v1/chat/completions", kind: "image" },
  { name: "response image", path: "/v1/responses", kind: "image" },
  { name: "response file", path: "/v1/responses", kind: "file" },
] as const;

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a fixture HTTP listener");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestBody(input: { path: string; kind: "image" | "file" }, stream: boolean) {
  const urls = ["first", "second"].map((name) => `${SOURCE_ORIGIN}/${name}`);
  return {
    model: "openclaw/main",
    stream,
    ...(input.path === "/v1/chat/completions"
      ? {
          messages: [
            {
              role: "user",
              content: urls.map((url) => ({ type: "image_url", image_url: { url } })),
            },
          ],
        }
      : {
          input: [
            {
              type: "message",
              role: "user",
              content: urls.map((url) => ({
                type: input.kind === "image" ? "input_image" : "input_file",
                source: { type: "url", url },
              })),
            },
          ],
        }),
  };
}

describe("HTTP media preparation cancellation", () => {
  it.each(
    inputCases.flatMap(({ name, path, kind }) =>
      [false, true].flatMap((stream) =>
        (["complete", "before headers", "during body"] as const).map((phase) => ({
          name,
          path,
          kind,
          stream,
          phase,
        })),
      ),
    ),
  )("$name stream=$stream: $phase", async (testCase) => {
    const initialRoots = getActiveGatewayRootWorkCount();
    const firstStarted = createDeferredCore();
    const firstHeaders = createDeferredCore();
    const requestClosed = createDeferredCore();
    const requestedSources: string[] = [];
    const bytes = testCase.kind === "image" ? IMAGE_BYTES : Buffer.from("fixture file text");
    let firstResponse: ServerResponse | undefined;
    let firstCanceled = false;
    const upstream = http.createServer((req, res) => {
      requestedSources.push(req.url ?? "");
      res.setHeader("Content-Type", testCase.kind === "image" ? "image/png" : "text/plain");
      if (req.url !== "/first" || testCase.phase === "complete") {
        res.end(bytes);
        return;
      }
      firstResponse = res;
      res.once("close", () => {
        firstCanceled = !res.writableFinished;
      });
      if (testCase.phase === "during body") {
        res.write(bytes.subarray(0, 4));
      }
      firstStarted.resolve();
    });
    const upstreamOrigin = await listen(upstream);
    // Remap only the fixture origin; actual Undici owns request/body cancellation.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== SOURCE_ORIGIN) {
        throw new Error(`Unexpected fixture fetch: ${url.origin}`);
      }
      const response = await fetchWithRuntimeDispatcher(`${upstreamOrigin}${url.pathname}`, init);
      if (url.pathname === "/first") {
        firstHeaders.resolve();
      }
      return response;
    });
    vi.mocked(agentCommandFromGatewayIngress).mockClear();
    try {
      await withGatewayServer({
        prefix: "http-media-preparation",
        resolvedAuth: AUTH_TOKEN,
        overrides: { openAiChatCompletionsEnabled: true, openResponsesEnabled: true },
        run: async (server) => {
          const config: OpenClawConfig = {
            agents: { entries: { main: {} } },
            gateway: {
              http: {
                endpoints: {
                  chatCompletions: { images: { allowUrl: true } },
                  responses: { images: { allowUrl: true }, files: { allowUrl: true } },
                },
              },
            },
          };
          setRuntimeConfigSnapshot(config, config);
          server.on("request", (_req, res) => res.once("close", requestClosed.resolve));
          const origin = await listen(server);
          const client = http.request(`${origin}${testCase.path}`, {
            method: "POST",
            headers: { authorization: "Bearer test-token", "content-type": "application/json" },
          });
          client.on("error", () => {});
          const completed = testCase.phase === "complete" ? once(client, "response") : undefined;
          client.end(JSON.stringify(requestBody(testCase, testCase.stream)));
          try {
            if (completed) {
              const [response] = await completed;
              const chunks: Buffer[] = [];
              for await (const chunk of response) {
                chunks.push(Buffer.from(chunk));
              }
              expect(response.statusCode).toBe(200);
              expect(Buffer.concat(chunks).toString()).toContain("image accepted");
              expect(requestedSources).toEqual(["/first", "/second"]);
              expect(agentCommandFromGatewayIngress).toHaveBeenCalledTimes(1);
            } else {
              await firstStarted.promise;
              if (testCase.phase === "during body") {
                await firstHeaders.promise;
              }
              client.destroy();
              await requestClosed.promise;
              await vi.waitFor(() => expect(firstCanceled).toBe(true), { timeout: 1_000 });
              expect(requestedSources).toEqual(["/first"]);
              expect(agentCommandFromGatewayIngress).not.toHaveBeenCalled();
            }
          } finally {
            client.destroy();
            firstResponse?.destroy();
            await close(server);
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(initialRoots));
          }
        },
      });
    } finally {
      fetchSpy.mockRestore();
      await close(upstream);
    }
  });
});
