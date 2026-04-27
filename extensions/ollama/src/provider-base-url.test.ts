import { describe, expect, it } from "vitest";
import { readProviderBaseUrl } from "./provider-base-url.js";

describe("readProviderBaseUrl", () => {
  it("reads canonical baseUrl and trims whitespace", () => {
    expect(readProviderBaseUrl({ baseUrl: " http://host:11434/v1 ", models: [] })).toBe(
      "http://host:11434/v1",
    );
  });

  it("falls back to OpenAI SDK-style baseURL", () => {
    const provider = {
      baseURL: " http://remote-ollama:11434 ",
      models: [],
    } as unknown as Parameters<typeof readProviderBaseUrl>[0];

    expect(readProviderBaseUrl(provider)).toBe("http://remote-ollama:11434");
  });

  it("prefers canonical baseUrl over baseURL", () => {
    const provider = {
      baseUrl: "http://canonical:11434",
      baseURL: "http://alternate:11434",
      models: [],
    } as unknown as Parameters<typeof readProviderBaseUrl>[0];

    expect(readProviderBaseUrl(provider)).toBe("http://canonical:11434");
  });

  it("ignores inherited baseUrl aliases", () => {
    const provider = { models: [] } as unknown as Parameters<typeof readProviderBaseUrl>[0];
    Object.setPrototypeOf(provider, { baseUrl: "http://inherited:11434" });

    expect(readProviderBaseUrl(provider)).toBeUndefined();
  });

  it("returns undefined for empty or missing values", () => {
    expect(readProviderBaseUrl(undefined)).toBeUndefined();
    expect(
      readProviderBaseUrl({ models: [] } as unknown as Parameters<typeof readProviderBaseUrl>[0]),
    ).toBeUndefined();
    expect(readProviderBaseUrl({ baseUrl: " ", models: [] })).toBeUndefined();
  });
});
