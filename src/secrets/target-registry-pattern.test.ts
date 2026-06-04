/** Tests secret target registry pattern compile/match/expand behavior. */
import { describe, expect, it } from "vitest";
import {
  expandPathTokens,
  matchPathTokens,
  materializePathTokens,
  parsePathPattern,
} from "./target-registry-pattern.js";

describe("target registry pattern helpers", () => {
  it("matches wildcard and array tokens with stable capture ordering", () => {
    const tokens = parsePathPattern("agents.list[].memorySearch.providers.*.apiKey");
    const match = matchPathTokens(
      ["agents", "list", "2", "memorySearch", "providers", "openai", "apiKey"],
      tokens,
    );

    expect(match).toEqual({
      captures: ["2", "openai"],
    });
    expect(
      matchPathTokens(
        ["agents", "list", "x", "memorySearch", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "02", "memorySearch", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "+2", "memorySearch", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "4294967294", "memorySearch", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
  });

  it("materializes sibling ref paths from wildcard and array captures", () => {
    const refTokens = parsePathPattern("agents.list[].memorySearch.providers.*.apiKeyRef");
    expect(materializePathTokens(refTokens, ["1", "anthropic"])).toEqual([
      "agents",
      "list",
      "1",
      "memorySearch",
      "providers",
      "anthropic",
      "apiKeyRef",
    ]);
    expect(materializePathTokens(refTokens, ["anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens, ["01", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens, ["+1", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens, ["4294967294", "anthropic"])).toBeNull();
  });

  it("matches two wildcard captures in five-segment header paths", () => {
    const tokens = parsePathPattern("models.providers.*.headers.*");
    const match = matchPathTokens(
      ["models", "providers", "openai", "headers", "x-api-key"],
      tokens,
    );
    expect(match).toEqual({
      captures: ["openai", "x-api-key"],
    });
  });

  it("expands wildcard and array patterns over config objects", () => {
    const root = {
      agents: {
        list: [
          { memorySearch: { remote: { apiKey: "a" } } },
          { memorySearch: { remote: { apiKey: "b" } } },
        ],
      },
      talk: {
        providers: {
          openai: { apiKey: "oa" }, // pragma: allowlist secret
          anthropic: { apiKey: "an" }, // pragma: allowlist secret
        },
      },
    };

    const arrayMatches = expandPathTokens(
      root,
      parsePathPattern("agents.list[].memorySearch.remote.apiKey"),
    );
    expect(
      arrayMatches.map((entry) => ({
        segments: entry.segments.join("."),
        captures: entry.captures,
        value: entry.value,
      })),
    ).toEqual([
      {
        segments: "agents.list.0.memorySearch.remote.apiKey",
        captures: ["0"],
        value: "a",
      },
      {
        segments: "agents.list.1.memorySearch.remote.apiKey",
        captures: ["1"],
        value: "b",
      },
    ]);

    const wildcardMatches = expandPathTokens(root, parsePathPattern("talk.providers.*.apiKey"));
    expect(
      wildcardMatches
        .map((entry) => ({
          segments: entry.segments.join("."),
          captures: entry.captures,
          value: entry.value,
        }))
        .toSorted((left, right) => left.segments.localeCompare(right.segments)),
    ).toEqual([
      {
        segments: "talk.providers.anthropic.apiKey",
        captures: ["anthropic"],
        value: "an",
      },
      {
        segments: "talk.providers.openai.apiKey",
        captures: ["openai"],
        value: "oa",
      },
    ]);
  });
});
