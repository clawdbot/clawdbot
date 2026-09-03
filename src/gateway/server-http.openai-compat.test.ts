// Gateway OpenAI-compatible route tests cover config reload and root-mounted behavior.
import { describe, expect, it, vi } from "vitest";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
