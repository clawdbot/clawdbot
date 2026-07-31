// Qa Lab tests cover deterministic web_search provider behavior.
import { describe, expect, it } from "vitest";
import { createQaLabWebSearchProvider as createQaLabWebSearchContractProvider } from "../web-search-contract-api.js";
import {
  createQaLabWebSearchProvider,
  QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY,
} from "./qa-web-search-provider.js";

describe("qa-lab web search provider", () => {
  it("exposes a credential-free QA-only provider", () => {
    const provider = createQaLabWebSearchProvider();

    expect(provider.id).toBe("qa-lab-search");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
    expect(provider.credentialPath).toBe("");
    expect(provider.getCredentialValue()).toBeUndefined();
    expect(createQaLabWebSearchContractProvider().createTool({})).toBeNull();
  });

  it("returns deterministic normalized web_search results", async () => {
    const provider = createQaLabWebSearchProvider();
    const tool = provider.createTool({});
    if (!tool) {
      throw new Error("expected QA Lab web search tool");
    }

    const result = await tool.execute({
      query: "OpenClaw runtime parity fixed query",
      count: 2,
    });

    expect(result).toMatchObject({
      query: "OpenClaw runtime parity fixed query",
      results: [
        {
          url: "https://docs.openclaw.ai/qa-lab/search-fixture/1",
          siteName: "docs.openclaw.ai",
        },
        {
          url: "https://docs.openclaw.ai/qa-lab/search-fixture/2",
          siteName: "docs.openclaw.ai",
        },
      ],
    });
    expect(JSON.stringify(result)).toContain("Deterministic QA Lab web_search result");
  });

  it("keeps malformed failure-path calls as tool failures", async () => {
    const provider = createQaLabWebSearchProvider();
    const tool = provider.createTool({});
    if (!tool) {
      throw new Error("expected QA Lab web search tool");
    }

    await expect(tool.execute({ __qaFailureMode: "denied-input" })).rejects.toThrow(/query/i);
  });

  it("keeps the QA failure sentinel as a deterministic tool failure", async () => {
    const provider = createQaLabWebSearchProvider();
    const tool = provider.createTool({});
    if (!tool) {
      throw new Error("expected QA Lab web search tool");
    }

    await expect(tool.execute({ query: QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY })).rejects.toThrow(
      /denied input sentinel/i,
    );
  });
});
