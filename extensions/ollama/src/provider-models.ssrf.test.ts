import { describe, expect, it } from "vitest";
import { buildOllamaBaseUrlSsrFPolicy } from "./provider-models.js";

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it("pins requests to the configured Ollama hostname for HTTP(S) URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      allowedHostnames: ["127.0.0.1"],
      hostnameAllowlist: ["127.0.0.1"],
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      allowedHostnames: ["ollama.example.com"],
      hostnameAllowlist: ["ollama.example.com"],
    });
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("not-a-url")).toBeUndefined();
  });
});
