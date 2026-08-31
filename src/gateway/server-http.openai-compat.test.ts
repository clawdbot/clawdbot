// Gateway OpenAI-compatible route tests cover disabled and root-mounted behavior.
import { describe, expect, it } from "vitest";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

describe("gateway OpenAI-compatible disabled HTTP routes", () => {
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

  it.each([
    { name: "chat completions", enabled: { openAiChatCompletionsEnabled: true } },
    { name: "responses", enabled: { openResponsesEnabled: true } },
  ])("keeps $name model discovery ahead of a root-mounted Control UI", async ({ enabled }) => {
    await withGatewayServer({
      prefix: "openai-compat-enabled-root-control-ui",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        ...enabled,
      },
      run: async (server) => {
        const { res, getBody } = await sendRequest(server, {
          path: "/v1/models",
          method: "GET",
          headers: { "x-openclaw-scopes": "operator.read" },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toMatchObject({
          object: "list",
          data: expect.arrayContaining([expect.objectContaining({ id: "openclaw/default" })]),
        });
      },
    });
  });
});
