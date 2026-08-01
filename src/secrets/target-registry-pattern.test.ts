/** Tests secret target registry pattern compile/match/expand behavior. */
import { describe, expect, it } from "vitest";
import {
  compileTargetRegistryEntry,
  expandPathTokens,
  matchPathTokens,
  materializePathTokens,
} from "./target-registry-pattern.js";

function compilePattern(pathPattern: string, refPathPattern?: string) {
  return compileTargetRegistryEntry({
    id: "test.pattern",
    targetType: "test.pattern",
    configFile: "openclaw.json",
    pathPattern,
    ...(refPathPattern ? { refPathPattern } : {}),
    secretShape: refPathPattern ? "sibling_ref" : "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  });
}

describe("target registry pattern helpers", () => {
  it("matches wildcard and array tokens with stable capture ordering", () => {
    const tokens = compilePattern("agents.list[].memory.search.providers.*.apiKey").pathTokens;
    const match = matchPathTokens(
      ["agents", "list", "2", "memory", "search", "providers", "openai", "apiKey"],
      tokens,
    );

    expect(match).toEqual({
      captures: ["2", "openai"],
    });
    expect(
      matchPathTokens(
        ["agents", "list", "x", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "02", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "+2", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "4294967294", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
  });

  it("materializes sibling ref paths from wildcard and array captures", () => {
    const refTokens = compilePattern(
      "agents.list[].memory.search.providers.*.apiKey",
      "agents.list[].memory.search.providers.*.apiKeyRef",
    ).refPathTokens;
    expect(refTokens).toBeDefined();
    expect(materializePathTokens(refTokens ?? [], ["1", "anthropic"])).toEqual([
      "agents",
      "list",
      "1",
      "memory",
      "search",
      "providers",
      "anthropic",
      "apiKeyRef",
    ]);
    expect(materializePathTokens(refTokens ?? [], ["anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["01", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["+1", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["4294967294", "anthropic"])).toBeNull();
  });

  it("matches two wildcard captures in five-segment header paths", () => {
    const tokens = compilePattern("models.providers.*.headers.*").pathTokens;
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
        entries: {
          main: { memory: { search: { remote: { apiKey: "a" } } } },
          ops: { memory: { search: { remote: { apiKey: "b" } } } },
        },
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
      compilePattern("agents.entries.*.memory.search.remote.apiKey").pathTokens,
    );
    expect(
      arrayMatches.map((entry) => ({
        segments: entry.segments.join("."),
        captures: entry.captures,
        value: entry.value,
      })),
    ).toEqual([
      {
        segments: "agents.entries.main.memory.search.remote.apiKey",
        captures: ["main"],
        value: "a",
      },
      {
        segments: "agents.entries.ops.memory.search.remote.apiKey",
        captures: ["ops"],
        value: "b",
      },
    ]);

    const wildcardMatches = expandPathTokens(
      root,
      compilePattern("talk.providers.*.apiKey").pathTokens,
    );
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
