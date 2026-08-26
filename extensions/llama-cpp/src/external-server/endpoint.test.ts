import { describe, expect, it } from "vitest";
import { normalizeLlamaServerProviderConfig, resolveLlamaServerEndpoint } from "./endpoint.js";

describe("llama-server endpoint", () => {
  it.each([
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080", "http://127.0.0.1:8080/v1"],
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080", "http://127.0.0.1:8080/v1"],
    ["localhost:8010/v1", "http://localhost:8010", "http://localhost:8010/v1"],
    [
      "https://models.example.com/llama/v1",
      "https://models.example.com/llama",
      "https://models.example.com/llama/v1",
    ],
  ])("normalizes %s", (input, origin, inferenceBaseUrl) => {
    expect(resolveLlamaServerEndpoint(input)).toEqual({ origin, inferenceBaseUrl });
  });

  it("rejects embedded credentials", () => {
    const endpoint = new URL("http://localhost:8080/v1");
    endpoint.username = "user";
    endpoint.password = "secret";
    expect(() => resolveLlamaServerEndpoint(endpoint.toString())).toThrow(
      "must not contain credentials",
    );
  });

  it("rejects non-HTTP schemes", () => {
    expect(() => resolveLlamaServerEndpoint("ftp://localhost:8080/v1")).toThrow(
      "Unsupported llama-server protocol",
    );
  });

  it("normalizes provider transport and private-network request policy", () => {
    expect(
      normalizeLlamaServerProviderConfig({
        baseUrl: "http://localhost:8080/",
        api: "openai-responses",
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
      models: [],
      request: { allowPrivateNetwork: true },
    });
  });

  it("preserves explicitly configured local service compatibility", () => {
    expect(
      normalizeLlamaServerProviderConfig({
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        models: [],
        localService: {
          command: "/usr/local/bin/llama-server",
          healthUrl: "http://localhost:8080/health",
        },
      }),
    ).toMatchObject({
      localService: {
        command: "/usr/local/bin/llama-server",
        healthUrl: "http://localhost:8080/health",
      },
    });
  });
});
